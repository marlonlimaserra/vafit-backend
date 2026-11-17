const { ObjectId } = require("mongodb");
const { centavos } = require("./Service_model.js");
const tempo = require("../lib/tempo.js");
const statusDeCobranca = require("../lib/statusDeCobranca.js");
const statusDePagamento = require("../lib/statusDePagamento.js");
const situacaoNoGateway = require("../lib/situacaoNoGateway.js");
const instanceContext = require("../lib/instance.js");
const { parseDataUri } = require("../lib/imageDataUri.js");
const { porPagina } = require("../lib/tetoDaLista.js");
const { recorteDeIds } = require("../lib/recorteDeIds.js");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");

// O financeiro de cada pessoa.
//
//   charges         → o que ela DEVE: valor, vencimento, do que se trata
//   payments        → o que ela PAGOU: valor, data, forma, comprovante
//   payment_files   → os bytes do comprovante
//
// São duas coisas separadas de propósito, e essa é a decisão central do módulo.
// Um lançamento único de "pagou 120" não sabe responder duas perguntas que todo
// profissional faz: quem está devendo, e quanto entrou este mês. A cobrança
// responde a primeira e o pagamento a segunda.
//
// Isso também é o que permite o pagamento PARCIAL — quem paga 60 de 120 não
// quitou e não deixou de pagar — e o pagamento avulso, sem cobrança nenhuma:
// alguém que paga adiantado, ou uma venda que nunca virou cobrança.
//
// POR QUE NÃO um array de pagamentos dentro da cobrança, que leria melhor
// (15/08/2026 — a pergunta foi feita, e a resposta é esta):
//
//   • o pagamento AVULSO não teria onde morar, e precisaria de uma segunda
//     collection assim mesmo — pagamento em duas formas é pior que duas
//     collections;
//   • um pagamento que quita VÁRIAS cobranças ("paguei os três meses, R$ 750
//     no Pix") viraria três pedaços, e o comprovante, que é um arquivo só,
//     ficaria preso em um deles;
//   • "quanto entrou no mês" — o relatório mais pedido — é hoje uma consulta
//     direta em `payments`; com o array, viraria desmontar o array de todas as
//     cobranças e ainda somar com os avulsos.
//
// O preço de manter separado é UMA consulta a mais por pessoa (`paidByCharge`)
// para saber o que está quitado. Não cresce com o número de cobranças, e é o
// que garante que o "Quitada" da tela nunca discorde dos lançamentos: não há
// campo para discordar.
//
// TUDO em CENTAVOS, inteiro. `1.1 + 2.2` em ponto flutuante dá
// 3.3000000000000003, e dinheiro somado assim erra o centavo — que é
// exatamente o que ninguém perdoa num relatório financeiro.
function Finance_model(app) {
  this.app = app;
}

// Como o dinheiro entrou.
//
// A lista deixou de ser fixa: cada conta manda no próprio catálogo
// (PaymentMethod_model) — renomeia, desativa o que não usa, cria "Cheque". O que
// NÃO mudou é o motivo de existir um catálogo: `method` vira coluna de
// relatório, e com texto livre "pix", "PIX" e "Pix" seriam três formas
// diferentes.
//
// O que se guarda aqui é a CHAVE, e o formato dela é o que este arquivo cobra:
// minúsculas, números e hífen. Quem decide quais chaves existem é o catálogo; o
// que este teste de formato impede é uma frase inteira virar forma de pagamento
// por um pedido malformado.
const FORMATO_DA_FORMA = /^[a-z0-9][a-z0-9-]{0,29}$/;

// As sete originais, que toda conta ganha ao abrir o catálogo pela primeira vez.
const FORMAS = ["pix", "cash", "credit", "debit", "transfer", "billet", "other"];

// A cobrança está aberta, foi paga, ou foi cancelada.
//
// `paid` NÃO é gravado à mão: ele é consequência de os pagamentos cobrirem o
// valor. Um estado que se pode marcar sozinho acabaria discordando dos
// lançamentos logo ao lado.
const STATUS = ["open", "paid", "canceled"];

// O status do PAGAMENTO, que é outra coisa.
//
// O da cobrança é consequência (pagaram ou não); este é DECLARADO, porque só
// quem registrou sabe.
//
// A lista mudou de casa em 18/09/2026: ela estava aqui e, igual, no formulário
// da tela — e o segundo era o que se esqueceria, porque esquecê-lo não quebra
// nada, só deixa de oferecer o estado novo. Agora mora em
// `lib/statusDePagamento.js` e viaja na resposta, como a da cobrança.
const STATUS_PAGAMENTO = statusDePagamento.IDS;

function statusDoPagamento(pagamento) {
  return statusDePagamento.normalizar(pagamento?.status);
}

// O dinheiro entrou mesmo? É esta pergunta que o saldo faz — e quem responde é
// o catálogo (`entra`), não uma comparação com "paid" escrita aqui. Um estado
// novo que não seja receita passa a ser respeitado por todas as contas do
// sistema sem ninguém procurar os lugares.
function entrou(pagamento) {
  return statusDePagamento.entrou(pagamento);
}

const MAX_COMPROVANTE = 10 * 1024 * 1024;
const TIPOS_COMPROVANTE = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

Finance_model.prototype.charges = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("charges");
};

Finance_model.prototype.payments = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payments");
};

Finance_model.prototype.files = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("payment_files");
};

function dataOuHoje(valor) {
  const d = valor ? new Date(valor) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function limparCobranca(obj) {
  return {
    amount: centavos(obj.amount),
    dueDate: dataOuHoje(obj.dueDate),
    description: String(obj.description || "")
      .trim()
      .slice(0, 200),
    status: STATUS.includes(obj.status) ? obj.status : "open",
    note: String(obj.note || "")
      .trim()
      .slice(0, 2000),
    // ── A FORMA COMO ELA DEVE SER PAGA ────────────────────────────────
    //
    // *"mostre o select de método de pagamento aqui"* (18/10/2026). É uma
    // INTENÇÃO, não um fato: o fato mora no pagamento, que diz como o
    // dinheiro de verdade entrou.
    //
    // VAZIO é o padrão e quer dizer "todas": a fatura do gateway abre com
    // pix, boleto e cartão, e quem escolhe é quem paga. Escolher uma aqui é
    // o que faz o boleto sair só como boleto — ver `formaDeCobranca`.
    method: FORMATO_DA_FORMA.test(String(obj.method || "")) ? String(obj.method) : "",
  };
}

function limparPagamento(obj) {
  return {
    amount: centavos(obj.amount),
    date: dataOuHoje(obj.date),
    method: FORMATO_DA_FORMA.test(String(obj.method || "")) ? String(obj.method) : "other",
    // Status desconhecido vira `paid` em vez de recusar o lançamento: o valor
    // vem de uma lista fechada na tela, e um erro aqui é mais provável ser
    // versão velha do navegador que má-fé.
    status: STATUS_PAGAMENTO.includes(obj.status) ? obj.status : "paid",
    note: String(obj.note || "")
      .trim()
      .slice(0, 2000),
  };
}

// ── Cobranças ─────────────────────────────────────────────────────────────

Finance_model.prototype.listCharges = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.charges();

  // Por vencimento, do mais recente para o mais antigo: a pergunta usual é
  // "como está agora", e o que venceu ontem importa mais que o de março.
  return await col
    .find({ student: new ObjectId(studentId) })
    .sort({ dueDate: -1 })
    .toArray();
};

Finance_model.prototype.chargeData = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.charges();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// A MOEDA fica gravada em cada lançamento, e não só na conta.
//
// Sem isso, trocar a moeda da conta reescreveria o passado: uma cobrança de
// R$ 120 de agosto passaria a ser lida como US$ 120 em setembro, sem nada ter
// mudado no banco. O valor é um número — quem lhe dá sentido é a moeda em que
// ele foi combinado, e essa não muda depois.
Finance_model.prototype.insertCharge = async function (studentId, obj, createdBy, currency) {
  const col = await this.charges();

  const r = await col.insertOne({
    student: new ObjectId(studentId),
    // ── O NÚMERO QUE SE FALA ────────────────────────────────────────────
    //
    // "#12", e não o `_id` de 24 caracteres: *"para quando eu perguntar para
    // alguém 'qual a cobrança'"*. Sequencial e POR CONTA — ver
    // `model/Counter_model.js`.
    numero: await this.app.api.counter.proximo("charges"),
    currency: currency || null,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    // De onde ela nasceu: um compromisso, ou a mão de alguém. É o que impede
    // a mesma aula de virar duas cobranças.
    appointment: ObjectId.isValid(obj.appointment) ? new ObjectId(obj.appointment) : null,
    service: ObjectId.isValid(obj.service) ? new ObjectId(obj.service) : null,
    // O AULÃO, quando a cobrança nasceu de uma inscrição. Terceira origem, e
    // ela precisa estar AQUI e não passar pelo `limparCobranca`: aquele fecha o
    // documento numa lista de campos, e um `aulao` mandado por fora seria
    // descartado em silêncio — a cobrança existiria sem vínculo, e uma segunda
    // inscrição na mesma aula viraria uma segunda cobrança sem ninguém notar.
    aulao: ObjectId.isValid(obj.aulao) ? new ObjectId(obj.aulao) : null,
    // A RECORRÊNCIA e o PERÍODO, quarta origem. Pelo mesmo motivo do `aulao`
    // logo acima: `limparCobranca` fecha o documento numa lista de campos, e um
    // vínculo mandado por fora sairia descartado em silêncio — aqui isso
    // desligaria o índice único e a mensalidade de setembro nasceria de novo a
    // cada abertura da tela.
    recurrence: ObjectId.isValid(obj.recurrence) ? new ObjectId(obj.recurrence) : null,
    periodo: obj.periodo ? String(obj.periodo).slice(0, 10) : null,
    ...limparCobranca(obj),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

// ── O PARCELAMENTO: UM VALOR EM N VEZES ───────────────────────────────────
//
// *"crie a aba parcelamento pois o asaas pode criar parcelamento também"*
// (17/10/2026).
//
// ── NÃO É UMA COLEÇÃO NOVA, E ISSO É A DECISÃO ──────────────────────────
//
// Um parcelamento NÃO é uma regra que roda: ele nasce inteiro e acaba no
// mesmo instante. Doze parcelas são doze cobranças criadas de uma vez, e
// depois disso não há nada a executar — nada para pausar, nada para gerar
// amanhã.
//
// A assinatura é o contrário, e por isso ELA tem coleção, estado e um
// `gerar()` que roda a cada leitura da tela. Dar a mesma máquina ao
// parcelamento criaria um gerador que nunca gera.
//
// Então o parcelamento É o conjunto das parcelas: três campos na cobrança —
// `installment` (o id do grupo), `parcela` e `parcelas` — e a aba lista os
// grupos por agregação. Sem coleção nova, sem documento que pode discordar
// das cobranças que ele diz ter.
//
// ── A SOBRA DOS CENTAVOS VAI NA PRIMEIRA ────────────────────────────────
//
// R$ 100,00 em 3 dá 33,333... Arredondar cada parcela para 33,33 cobra
// R$ 99,99 — um centavo a menos que o combinado, e quem descobre é quem
// fecha o mês. A sobra inteira vai para a PRIMEIRA parcela (33,34 + 33,33 +
// 33,33), que é o que todo carnê faz: o cliente paga a diferença no começo,
// quando ainda está decidindo, e não no fim, quando já esqueceu.
Finance_model.prototype.parcelar = async function (studentId, obj, createdBy, currency) {
  const col = await this.charges();

  // O TETO corta; o PISO recusa. São erros diferentes: 120 é dedo no zero, e
  // cortar em 48 evita cento e vinte cobranças que alguém terá de apagar à
  // mão. Mas 1 não é engano de digitação — é "não quero parcelar", e subir
  // para 2 criaria em silêncio uma cobrança que ninguém pediu.
  const pedidas = parseInt(obj.parcelas, 10) || 0;
  const parcelas = Math.min(pedidas, 48);
  const total = centavos(obj.total);
  if (pedidas < 2 || total <= 0) return { ok: false, erro: "parcelamento_invalido" };

  const base = Math.floor(total / parcelas);
  const sobra = total - base * parcelas;

  const grupo = new ObjectId();
  const primeiro = dataOuHoje(obj.primeiroVencimento);
  const descricao = String(obj.description || "")
    .trim()
    .slice(0, 200);
  // A FORMA combinada, a mesma de uma cobrança avulsa — *"em parcelamento e
  // assinatura, faltaram os métodos de pagamento igual em fatura avulsa"*
  // (19/10/2026). Vazio é "todas", e é o padrão: o carnê abre com pix, boleto
  // e cartão, e quem escolhe é quem paga.
  const forma = FORMATO_DA_FORMA.test(String(obj.method || "")) ? String(obj.method) : "";

  const docs = [];
  for (let i = 0; i < parcelas; i++) {
    // De mês em mês a partir do primeiro vencimento. `setMonth` resolve o
    // 31 de janeiro + 1 mês virando 3 de março — e é o comportamento certo:
    // um carnê que vence dia 31 vence no fim do mês que tiver.
    const vence = new Date(primeiro);
    vence.setMonth(vence.getMonth() + i);

    docs.push({
      student: new ObjectId(studentId),
      numero: await this.app.api.counter.proximo("charges"),
      currency: currency || null,
      createdBy: createdBy ? new ObjectId(createdBy) : null,
      appointment: null,
      service: null,
      aulao: null,
      recurrence: null,
      periodo: null,
      // O GRUPO e a posição. É por eles que a aba monta a lista, e é o que
      // faz a linha dizer "3/12" em vez de repetir o mesmo nome doze vezes.
      installment: grupo,
      parcela: i + 1,
      parcelas,
      amount: base + (i === 0 ? sobra : 0),
      dueDate: vence,
      description: descricao,
      method: forma,
      status: "open",
      note: String(obj.note || "")
        .trim()
        .slice(0, 2000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  await col.insertMany(docs);

  return {
    ok: true,
    grupo: String(grupo),
    parcelas,
    // O valor da PARCELA que o gateway vai usar. É a segunda em diante — a
    // primeira carrega a sobra, e mandar ELA faria o total de lá passar do
    // combinado.
    valorDaParcela: base,
    // A forma sobe junto para quem vai falar com o gateway: é ela que decide
    // se o carnê sai só em boleto, só em pix, ou aberto nas três.
    forma,
    primeira: docs[0],
    ids: docs.map((d) => d._id).filter(Boolean),
  };
};

// Carimba o grupo do gateway em todas as parcelas de uma vez: o webhook de
// qualquer uma delas chega com o `installment` de lá, e é por ele que se acha
// a nossa.
// ── AS MENSALIDADES QUE AINDA NÃO VENCERAM ───────────────────────────────
//
// *"se cancelar, cancela no asaas?"* (19/10/2026). Quem cancela uma
// assinatura quer parar de cobrar — e a geração trabalha com 15 dias de
// antecedência, então quase sempre existe uma mensalidade já criada, com
// fatura viva, para um mês que a pessoa não vai usar.
//
// SÓ as que ainda não venceram. O mês que já passou e não foi pago é dívida:
// cancelar a assinatura não a perdoa, e sumir com ela aqui apagaria do
// "a receber" um dinheiro que a casa tem a receber de verdade.
Finance_model.prototype.futurasDaRecorrencia = async function (recurrenceId, hoje = new Date()) {
  if (!ObjectId.isValid(recurrenceId)) return [];
  const col = await this.charges();
  return col
    .find({
      recurrence: new ObjectId(String(recurrenceId)),
      status: "open",
      dueDate: { $gt: hoje },
    })
    .toArray();
};

// ── O CARNÊ INTEIRO: LER, CANCELAR, APAGAR ───────────────────────────────
//
// *"coloque a opção de cancelar e deletar parcelamento"* (19/10/2026).
//
// O parcelamento não tem documento próprio — ele É o conjunto das parcelas,
// agrupado por `installment`. Então as três operações são sobre o conjunto, e
// moram aqui para não virarem três laços escritos no controlador.
Finance_model.prototype.parcelasDoGrupo = async function (grupo) {
  if (!ObjectId.isValid(grupo)) return [];
  const col = await this.charges();
  return col
    .find({ installment: new ObjectId(String(grupo)) })
    .sort({ parcela: 1 })
    .toArray();
};

// Cancela as que ainda estão ABERTAS. As pagas ficam como estão: cancelar uma
// parcela que recebeu dinheiro esconderia o recebimento do extrato, e o
// dinheiro continuaria no caixa sem linha que o explique.
Finance_model.prototype.cancelarParcelamento = async function (grupo) {
  if (!ObjectId.isValid(grupo)) return 0;
  const col = await this.charges();
  const r = await col.updateMany(
    { installment: new ObjectId(String(grupo)), status: "open" },
    {
      $set: { status: "canceled", updatedAt: new Date() },
      // Sem fatura lá fora, os rastros dela aqui são promessas falsas — o
      // mesmo motivo de `limparNoGateway`, aplicado ao conjunto.
      $unset: { "gateway.pagamento": "", "gateway.url": "", "gateway.situacao": "" },
    },
  );
  return r.modifiedCount;
};

Finance_model.prototype.apagarParcelamento = async function (grupo) {
  if (!ObjectId.isValid(grupo)) return 0;
  const col = await this.charges();
  const r = await col.deleteMany({ installment: new ObjectId(String(grupo)) });
  return r.deletedCount;
};

Finance_model.prototype.marcarParcelamentoNoGateway = async function (grupo, dados) {
  const col = await this.charges();
  await col.updateMany(
    { installment: new ObjectId(String(grupo)) },
    { $set: { "gateway.parcelamento": String(dados.id || ""), updatedAt: new Date() } },
  );
};

// Carimba, em cada parcela daqui, o id da fatura dela lá.
//
// É o que faz o webhook de qualquer uma delas achar a cobrança certa por
// IDENTIDADE, e não por palpite de vencimento — que deixa de valer no
// instante em que alguém muda uma data pelo painel do Asaas.
//
// Casa pelo VENCIMENTO porque é o único campo que os dois lados têm em comum
// no momento da criação: as nossas acabaram de nascer com as mesmas datas que
// mandamos para lá. Depois desta passada, ninguém mais depende disso.
Finance_model.prototype.casarParcelasComOGateway = async function (grupo, faturas) {
  const col = await this.charges();
  const nossas = await col
    .find({ installment: new ObjectId(String(grupo)) })
    .sort({ parcela: 1 })
    .toArray();

  let casadas = 0;
  for (let i = 0; i < nossas.length; i++) {
    const fatura = faturas[i];
    if (!fatura?.id) continue;
    await col.updateOne(
      { _id: nossas[i]._id },
      {
        $set: {
          "gateway.pagamento": String(fatura.id),
          "gateway.url": fatura.link || "",
          updatedAt: new Date(),
        },
      },
    );
    casadas++;
  }
  return casadas;
};

// ── A LISTA DE PARCELAMENTOS, por agregação ─────────────────────────────
//
// Um grupo é um conjunto de cobranças que compartilham `installment`. O que
// a aba mostra sai de somá-las: quantas são, quanto é o total, quantas já
// foram pagas, quando vence a próxima.
//
// Contar as PAGAS exige olhar os pagamentos, como a carteira faz: uma
// parcela está paga quando o que entrou nela cobre o valor dela. `status`
// sozinho mentiria para quem deu baixa parcial.
Finance_model.prototype.parcelamentos = async function ({ personId, unit, units } = {}) {
  const col = await this.charges();
  const instancia = instanceContext.current();

  const donos = recorteDeIds(personId);

  const [saida] = await col
    .aggregate([
      { $match: { installment: { $ne: null }, ...(donos ? { student: { $in: donos } } : {}) } },
      {
        $lookup: {
          from: "payments",
          let: { cobranca: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$charge", "$$cobranca"] },
                ...(instancia ? { instance: instancia } : {}),
                ...statusDePagamento.filtroDeEntrada(),
              },
            },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ],
          as: "recebimentos",
        },
      },
      {
        $lookup: {
          from: "users",
          let: { pessoa: "$student" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", "$$pessoa"] },
                ...(instancia ? { instance: instancia } : {}),
              },
            },
            { $project: { name: 1, avatarAt: 1, unit: 1 } },
          ],
          as: "pessoa",
        },
      },
      {
        $addFields: {
          pago: { $ifNull: [{ $arrayElemAt: ["$recebimentos.total", 0] }, 0] },
          studentName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
          studentAvatarAt: { $ifNull: [{ $arrayElemAt: ["$pessoa.avatarAt", 0] }, null] },
          studentUnit: { $ifNull: [{ $arrayElemAt: ["$pessoa.unit", 0] }, null] },
        },
      },
      ...(ObjectId.isValid(unit)
        ? [{ $match: { studentUnit: new ObjectId(unit) } }]
        : lenteDeUnidade.filtroDeUnidades(units)
          ? [
              {
                $match: {
                  $or: [
                    { studentUnit: lenteDeUnidade.filtroDeUnidades(units).$or[0].unit },
                    { studentUnit: null },
                  ],
                },
              },
            ]
          : []),
      {
        $group: {
          _id: "$installment",
          student: { $first: "$student" },
          studentName: { $first: "$studentName" },
          studentAvatarAt: { $first: "$studentAvatarAt" },
          studentUnit: { $first: "$studentUnit" },
          description: { $first: "$description" },
          currency: { $first: "$currency" },
          parcelas: { $max: "$parcelas" },
          total: { $sum: { $ifNull: ["$amount", 0] } },
          recebido: { $sum: "$pago" },
          // QUITADAS, e não "com status pago": baixa parcial deixaria a
          // conta mentindo para mais.
          quitadas: {
            $sum: { $cond: [{ $gte: ["$pago", { $ifNull: ["$amount", 0] }] }, 1, 0] },
          },
          canceladas: { $sum: { $cond: [{ $eq: ["$status", "canceled"] }, 1, 0] } },
          primeiro: { $min: "$dueDate" },
          ultimo: { $max: "$dueDate" },
          // A PRÓXIMA a vencer entre as que ainda devem. Vazio quando acabou
          // de pagar — e aí a tela diz "quitado" em vez de uma data no
          // passado.
          proximo: {
            $min: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$status", "canceled"] },
                    { $lt: ["$pago", { $ifNull: ["$amount", 0] }] },
                  ],
                },
                "$dueDate",
                null,
              ],
            },
          },
          noGateway: { $first: "$gateway.parcelamento" },
        },
      },
      {
        $facet: {
          rows: [
            { $sort: { primeiro: -1, _id: 1 } },
            {
              $project: {
                _id: 0,
                id: { $toString: "$_id" },
                student: { $toString: "$student" },
                studentName: 1,
                studentAvatarAt: 1,
                studentUnit: { $toString: "$studentUnit" },
                description: 1,
                currency: 1,
                parcelas: 1,
                total: 1,
                recebido: 1,
                quitadas: 1,
                canceladas: 1,
                primeiro: 1,
                ultimo: 1,
                proximo: 1,
                noGateway: { $ifNull: ["$noGateway", ""] },
              },
            },
          ],
          resumo: [
            {
              $group: {
                _id: null,
                total: { $sum: "$total" },
                recebido: { $sum: "$recebido" },
                grupos: { $sum: 1 },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const resumo = saida?.resumo?.[0] || {};
  return {
    rows: saida?.rows || [],
    total: (saida?.rows || []).length,
    resumo: {
      total: resumo.total || 0,
      recebido: resumo.recebido || 0,
      aReceber: Math.max(0, (resumo.total || 0) - (resumo.recebido || 0)),
      grupos: resumo.grupos || 0,
    },
  };
};

// ── EDITAR É MUDAR O QUE VEIO, NÃO REESCREVER TUDO ────────────────────────
//
// `limparCobranca` monta o documento INTEIRO a partir do que recebe, com padrão
// para o que falta — que é o certo ao CRIAR e destrutivo ao editar. Um PUT com
// `{ status: "canceled" }` gravava `amount: 0`, `description: ""`, `note: ""` e
// o vencimento de HOJE.
//
// Passou despercebido porque o único chamador era o formulário, que manda todos
// os campos sempre. Na primeira chamada parcial — as ações em lote de
// 17/09/2026 — cinco cobranças de verdade perderam valor, descrição e
// vencimento. O relato foi uma pergunta: *"quando eu coloco reabrir, o que
// acontece?"*.
//
// Agora só entra no `$set` o campo que veio no corpo. O que a chamada não
// menciona, ela não toca.
const CAMPOS_DA_COBRANCA = {
  amount: (v) => centavos(v),
  dueDate: (v) => dataOuHoje(v),
  description: (v) =>
    String(v || "")
      .trim()
      .slice(0, 200),
  status: (v) => (STATUS.includes(v) ? v : "open"),
  note: (v) =>
    String(v || "")
      .trim()
      .slice(0, 2000),
  // Vazio é "todas as formas", e é um valor legítimo: quem limpa o campo
  // está dizendo "deixa o aluno escolher".
  method: (v) => (FORMATO_DA_FORMA.test(String(v || "")) ? String(v) : ""),
};

Finance_model.prototype.updateCharge = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.charges();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS_DA_COBRANCA)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }
  // A moeda só muda quando vem explícita e já validada pela rota: um corpo sem
  // ela não pode zerar a moeda de um lançamento antigo.
  if (obj.currency) mudanca.currency = obj.currency;

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });

  return r.matchedCount > 0;
};

Finance_model.prototype.deleteCharge = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.charges();

  // ── APAGAR UMA PARCELA DA ASSINATURA TEM DE FICAR APAGADO ──────────────
  //
  // *"tentei excluir o pagamento que pertence a assinatura, ele falou que
  // apagou mas continua"* (17/10/2026).
  //
  // E ele apagou mesmo — a mensagem não mentia. O que acontecia é que a
  // geração roda a cada LEITURA da tela do dinheiro (não há agendador aqui;
  // ver `Recurrence_model.gerar`), e ela decide o que falta comparando os
  // períodos que já existem. Apagado o de setembro, setembro voltava a
  // "faltar" — e nascia de novo antes de a tela terminar de carregar.
  //
  // Da cadeira de quem olha, o botão simplesmente não funciona. É o pior
  // tipo de defeito: a confirmação diz que deu certo.
  //
  // A LÁPIDE resolve: o período apagado fica anotado na regra, e a geração
  // passa a tratá-lo como já resolvido. Apagar volta a querer dizer apagar.
  //
  // Por que na REGRA e não um `deletedAt` na cobrança: um documento apagado
  // que continua no banco obriga TODA consulta de dinheiro a lembrar de
  // excluí-lo, e a primeira que esquecer mostra uma cobrança fantasma no
  // extrato de alguém. A lápide é um dado da regra, e só a geração a lê.
  const cobranca = await col.findOne(
    { _id: new ObjectId(id) },
    { projection: { recurrence: 1, periodo: 1 } },
  );
  if (cobranca?.recurrence && cobranca.periodo) {
    await this.app.api.recurrence.naoGerarMais(String(cobranca.recurrence), cobranca.periodo);
  }

  // Os pagamentos ligados a ela viram avulsos em vez de sumirem: o dinheiro
  // entrou de verdade, e apagar a cobrança não desfaz isso.
  const pagamentos = await this.payments();
  await pagamentos.updateMany({ charge: new ObjectId(id) }, { $set: { charge: null } });

  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

// A cobrança de um compromisso, se já existir.
//
// É o que torna a geração automática segura de repetir: remarcar ou salvar o
// mesmo compromisso de novo não cria uma segunda cobrança.
// ── A COBRANÇA DE CADA COMPROMISSO, JÁ COM "PAGO OU NÃO" ─────────────────
//
// *"depois aparece ali na frente se foi pago ou não"* (16/11/2026) — na lista
// de compromissos da agenda, ao lado de cada atendimento.
//
// Pago, falta e atrasada NÃO são calculados aqui à mão: vêm de
// `estagiosDaCobranca`, a definição única que a carteira e o gráfico usam. Uma
// terceira cópia da regra seria a agenda dizendo "pago" para a cobrança que o
// financeiro, na tela ao lado, chama de atrasada.
//
// Uma consulta para a lista inteira (não uma por linha), e só das cobranças
// ligadas aos compromissos pedidos. Devolve { idDoCompromisso: resumo }.
function situacaoDaCobranca(c) {
  if (c.status === "canceled") return "cancelada";
  if ((c.falta || 0) <= 0) return "paga";
  if (c.atrasada) return "atrasada";
  return "aberta";
}

Finance_model.prototype.cobrancasDosCompromissos = async function (appointmentIds, agora = new Date()) {
  const validos = [...new Set((appointmentIds || []).map(String))]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  if (!validos.length) return {};

  const col = await this.charges();
  const { juntarPagamentos, derivados, contas, atraso } = estagiosDaCobranca({
    instancia: instanceContext.current(),
    agora,
  });

  const docs = await col
    .aggregate([
      { $match: { appointment: { $in: validos } } },
      juntarPagamentos,
      derivados,
      contas,
      atraso,
      {
        $project: {
          appointment: 1,
          amount: 1,
          currency: 1,
          status: 1,
          dueDate: 1,
          pago: 1,
          falta: 1,
          atrasada: 1,
          "gateway.url": 1,
          "gateway.pagamento": 1,
        },
      },
    ])
    .toArray();

  const porCompromisso = {};
  for (const c of docs) {
    const chave = String(c.appointment);
    // Se houver mais de uma (não devia: `chargeOfAppointment` guarda isso), a
    // que vale é a que não foi cancelada.
    if (porCompromisso[chave] && c.status === "canceled") continue;
    porCompromisso[chave] = {
      _id: c._id,
      amount: c.amount || 0,
      currency: c.currency || "",
      pago: c.pago || 0,
      falta: c.falta || 0,
      dueDate: c.dueDate || null,
      situacao: situacaoDaCobranca(c),
      link: c.gateway?.url || "",
      noGateway: Boolean(c.gateway?.pagamento),
    };
  }
  return porCompromisso;
};

Finance_model.prototype.chargeOfAppointment = async function (appointmentId) {
  if (!ObjectId.isValid(appointmentId)) return undefined;
  const col = await this.charges();

  const doc = await col.findOne({ appointment: new ObjectId(appointmentId) });
  return doc || undefined;
};

// A cobrança de um AULÃO para uma pessoa.
//
// Mesmo papel da de compromisso: é o que impede a mesma inscrição de virar duas
// cobranças quando alguém sai e entra de novo. Por PESSOA e por aulão, porque o
// aulão tem muitos inscritos e cada um tem a sua.
Finance_model.prototype.chargeOfAulao = async function (aulaoId, studentId) {
  if (!ObjectId.isValid(aulaoId) || !ObjectId.isValid(studentId)) return undefined;
  const col = await this.charges();
  return (
    (await col.findOne({ aulao: new ObjectId(aulaoId), student: new ObjectId(studentId) })) ||
    undefined
  );
};

// ── Pagamentos ────────────────────────────────────────────────────────────

// ── O FINANCEIRO DE TODO MUNDO ────────────────────────────────────────────
//
// Tudo que existia aqui era POR PESSOA: `listCharges(studentId)`,
// `balanceOf(studentId)`. Funciona para a ficha de um aluno, e não responde a
// pergunta que se faz no fim do mês — "quanto tenho a receber?", "quem está
// atrasado?".
//
// Sem esta leitura a resposta exigia abrir as fichas uma por uma, e com 217
// pessoas ninguém faz isso: o dado existia e era inalcançável.
//
// ── POR QUE O ATRASO É CALCULADO, e não gravado ──────────────────────────
//
// "Atrasada" não é um status — é uma cobrança ABERTA cuja data já passou. Um
// status `late` gravado precisaria de alguém para virá-lo à meia-noite, e no
// dia em que esse alguém falhasse o relatório mentiria com confiança.
//
// A conta é feita na leitura, contra o instante de agora. Nunca envelhece.
const DIA_MS = 86400000;

// ── A JANELA É SOBRE O DIA, NÃO SOBRE O INSTANTE ──────────────────────────
//
// `de` e `ate` chegam como "AAAA-MM-DD" da tela. `new Date("2026-09-30")` é
// MEIA-NOITE UTC daquele dia — então `dueDate <= ate` excluía tudo que vencia
// naquele dia com qualquer hora.
//
// O defeito apareceu assim: três cobranças de um aulão do dia 30/09 às 09:00
// (12:00 UTC) não apareciam no Financeiro de setembro. O Marlon marcou duas como
// pagas e a tela continuou dizendo "recebido no mês R$ 0,00".
//
// E não era só do aulão: TODA cobrança com hora que vencesse no último dia da
// janela caía fora — as de compromisso inclusive, que herdam a hora do
// atendimento. Um relatório que perde o último dia de cada mês.
//
// ── O FUSO É O DA CONTA ───────────────────────────────────────────────────
//
// O fim do dia 30 em São Paulo é 01/10 às 03:00 UTC. Usar 23:59 UTC deixaria de
// fora a cobrança das 22h — de novo o mesmo tipo de erro, três horas menor.
//
// Quem resolve o fuso é o controlador, que tem acesso à conta; aqui só se aceita
// o instante pronto. `fim` é opcional para não quebrar quem já chamava com
// datas.
function inicioDoDia(valor, fuso) {
  if (valor instanceof Date) return valor;
  const m = String(valor || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(valor);
  return tempo.instante({ ano: +m[1], mes: +m[2], dia: +m[3], hora: 0, minuto: 0 }, fuso);
}

function fimDoDia(valor, fuso) {
  if (valor instanceof Date) return valor;
  const m = String(valor || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(valor);
  // 23:59 do dia, no fuso da conta. O `+ 59999` fecha o minuto: sem ele, uma
  // cobrança às 23:59:30 ficaria de fora.
  const d = tempo.instante({ ano: +m[1], mes: +m[2], dia: +m[3], hora: 23, minuto: 59 }, fuso);
  return new Date(d.getTime() + 59999);
}

// ── O QUE SE PODE ORDENAR, e por qual campo ─────────────────────────────
//
// A tela ordenava sozinha, no navegador, sobre a lista inteira. Com a página
// vindo do banco isso deixa de funcionar: ordenar quinze linhas dá a ordem das
// quinze, e não as quinze primeiras de trezentas. Ordenação e paginação são a
// mesma decisão, e as duas passaram para cá.
//
// `situacao` é um POSTO calculado, não um campo: a ordem é a da urgência de quem
// olha — o que venceu primeiro, o que ainda vai vencer depois, e o que já morreu
// (pago, cancelado) no fim. É a mesma ordem que a tela usava.
const ORDEM_DA_CARTEIRA = {
  // Ordenar por número é ordenar por ordem de criação, e com um valor que a
  // pessoa pode conferir — é o que ninguém consegue fazer por `createdAt`.
  numero: "numero",
  // Quanto ENTROU nesta linha. É a ordem da janela do "Recebido" do painel:
  // quem pagou mais primeiro.
  pago: "pago",
  person: "studentName",
  description: "description",
  dueDate: "dueDate",
  createdAt: "createdAt",
  amount: "amount",
  status: "situacao",
};

// A ordenação dos RECEBIMENTOS. Lista fechada pela mesma razão da de cima: o
// campo vai para dentro de um `$sort`, e aceitar o que vier é deixar a tela
// escolher por qual chave o banco trabalha.
const ORDEM_DOS_RECEBIMENTOS = {
  numero: "numero",
  // Quanto ENTROU nesta linha. É a ordem da janela do "Recebido" do painel:
  // quem pagou mais primeiro.
  pago: "pago",
  person: "studentName",
  description: "assunto",
  date: "date",
  amount: "amount",
  method: "method",
};

// Teto de página. 200 pelo mesmo motivo da lista de pessoas: acima disso a
// resposta cresce sem que ninguém leia, e um `limit=100000` na barra de endereço
// vira uma varredura da collection inteira.
const LIMITE_MAXIMO = 200;
const LIMITE_PADRAO = 25;

// ── OS AVULSOS, COMO LINHAS DA CARTEIRA ──────────────────────────────────
//
// Um pagamento AVULSO é um que nasceu pago: sem cobrança do outro lado, sem
// vencimento, sem falta. Ele entra na carteira como linha, e é isso que permite
// UMA lista — antes ele não tinha onde aparecer, e dinheiro que entrou e não
// está em lugar nenhum é o pior buraco de relatório que existe.
//
// Mora aqui fora pela mesma razão de `estagiosDaCobranca`: a série mensal do
// painel precisa do mesmo conjunto. Deixá-lo de fora da série faria o gráfico
// do "recebido" ser SEMPRE menor que o número em cima dele, numa conta que
// recebe avulso — e a diferença seria invisível até alguém somar à mão.
function uniaoDeAvulsos({ instancia, juntarPessoa, comAvulsos, de, ate, fuso }) {
  const janelaDoAvulso = {};
  if (de || ate) {
    janelaDoAvulso.date = {};
    if (de) janelaDoAvulso.date.$gte = inicioDoDia(de, fuso);
    if (ate) janelaDoAvulso.date.$lte = fimDoDia(ate, fuso);
  }

  // O estado do pagamento traduzido para a escala da cobrança, que é a da
  // coluna Situação. `pending` é dinheiro prometido — vira "aberto", com falta
  // igual ao valor. `refunded` e `canceled` não são receita, e o mais próximo
  // que a cobrança tem é "cancelado". O estado verdadeiro viaja ao lado, em
  // `avulsoStatus`, para a tela não chamar reembolso de cancelamento.
  //
  // `$ifNull` com "paid": pagamento anterior ao campo não o tem, e ausente
  // significa pago — ver `lib/statusDePagamento.js`.
  const estadoDoAvulso = { $ifNull: ["$status", "paid"] };

  const unirAvulsos = comAvulsos
    ? [
        {
          $unionWith: {
            coll: "payments",
            pipeline: [
              {
                $match: {
                  ...(instancia ? { instance: instancia } : {}),
                  // SEM cobrança do outro lado: é o que faz dele avulso.
                  $or: [{ charge: null }, { charge: { $exists: false } }],
                  ...janelaDoAvulso,
                },
              },
              juntarPessoa,
              {
                $addFields: {
                  avulso: true,
                  avulsoStatus: estadoDoAvulso,
                  // Sem número: o contador de cobranças não passa por aqui, e
                  // inventar um faria dois lançamentos diferentes com o mesmo.
                  numero: null,
                  description: { $ifNull: ["$note", ""] },
                  amount: { $ifNull: ["$amount", 0] },
                  dueDate: "$date",
                  status: {
                    $switch: {
                      branches: [
                        {
                          case: { $in: [estadoDoAvulso, ["refunded", "canceled"]] },
                          then: "canceled",
                        },
                        { case: { $eq: [estadoDoAvulso, "pending"] }, then: "open" },
                      ],
                      default: "paid",
                    },
                  },
                  pago: {
                    $cond: [
                      { $in: [estadoDoAvulso, ["refunded", "canceled", "pending"]] },
                      0,
                      { $ifNull: ["$amount", 0] },
                    ],
                  },
                  studentName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
                  studentEmail: { $ifNull: [{ $arrayElemAt: ["$pessoa.email", 0] }, ""] },
                  studentPhone: { $ifNull: [{ $arrayElemAt: ["$pessoa.phone", 0] }, ""] },
                  studentAvatarAt: { $ifNull: [{ $arrayElemAt: ["$pessoa.avatarAt", 0] }, null] },
                  studentUnit: { $ifNull: [{ $arrayElemAt: ["$pessoa.unit", 0] }, null] },
                },
              },
            ],
          },
        },
      ]
    : [];

  return unirAvulsos;
}

// ── OS ESTÁGIOS QUE DEFINEM UMA COBRANÇA ─────────────────────────────────
//
// Pago, falta, atrasada, a unidade de quem deve. Eles eram escritos à mão
// dentro de `carteira` — e quando o painel ganhou GRÁFICO (22/10/2026) passou a
// existir um segundo leitor da mesma verdade: a série dos últimos doze meses.
//
// Duas cópias desta pipeline é o defeito mais caro que este arquivo poderia ter.
// "Atrasada" não é um campo gravado — é `status open` E `falta > 0` E
// `dueDate < agora` —, e no dia em que uma das cópias ganhasse uma condição a
// mais, o cartão diria R$ 124.908 e o gráfico embaixo dele terminaria em outro
// número. Ninguém desconfia de um total; e dois totais que discordam na mesma
// tela destroem a confiança nos dois.
//
// Então a definição é UMA, e quem precisa dela pede por aqui.
//
// `agora` entra por parâmetro e não é lido aqui dentro: a série e a carteira
// têm de olhar para o MESMO instante, senão a última barra do gráfico pode
// nascer de um "agora" alguns milissegundos à frente do número do cartão — e é
// exatamente numa virada de vencimento que isso apareceria.
function estagiosDaCobranca({ instancia, agora }) {
  // ── AS DUAS JUNÇÕES ────────────────────────────────────────────────────
  //
  // O `instance` DENTRO da sub-pipeline é desempenho, não correção:
  // `lib/escopo.js` não alcança o interior de um `$lookup`, e a correção já
  // está garantida porque as duas casam por ObjectId, que é único global. Sem
  // ele, cada junção varreria os pagamentos e as pessoas de todos os clientes
  // para achar as de um.
  const juntarPagamentos = {
    $lookup: {
      from: "payments",
      let: { cobranca: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$charge", "$$cobranca"] },
            ...(instancia ? { instance: instancia } : {}),
            // Só o que ENTROU conta: pendente é promessa, reembolsado é
            // dinheiro que voltou, cancelado é lançamento que não devia
            // existir. `$nin` e não `status: "paid"` — ver `filtroDeEntrada`:
            // pagamento antigo não tem o campo, e o literal o deixaria de fora.
            ...statusDePagamento.filtroDeEntrada(),
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ],
      as: "recebimentos",
    },
  };

  const juntarPessoa = {
    $lookup: {
      from: "users",
      let: { pessoa: "$student" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$_id", "$$pessoa"] },
            ...(instancia ? { instance: instancia } : {}),
          },
        },
        // O documento da pessoa NÃO sai daqui inteiro: ela tem senha, sal e
        // ficha. Quatro campos, e é o que a tela e a planilha usam.
        //
        // `avatarAt` não é a FOTO — é o carimbo de quando ela mudou. A foto em
        // si vem por uma rota própria, com sessão, porque `<img src>` não manda
        // cabeçalho e voltaria 401. O que a lista precisa é só saber SE existe
        // uma, e qual versão, para não mostrar a antiga depois da troca.
        { $project: { name: 1, email: 1, phone: 1, avatarAt: 1, unit: 1 } },
      ],
      as: "pessoa",
    },
  };

  const derivados = {
    $addFields: {
      pago: { $ifNull: [{ $arrayElemAt: ["$recebimentos.total", 0] }, 0] },
      studentName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
      studentEmail: { $ifNull: [{ $arrayElemAt: ["$pessoa.email", 0] }, ""] },
      studentPhone: { $ifNull: [{ $arrayElemAt: ["$pessoa.phone", 0] }, ""] },
      studentAvatarAt: { $ifNull: [{ $arrayElemAt: ["$pessoa.avatarAt", 0] }, null] },
      // A UNIDADE de quem deve. Ela é da PESSOA, e não da cobrança: uma
      // cobrança não acontece num lugar, ela pertence a alguém que atende num.
      //
      // Guardá-la na cobrança criaria a pergunta "e quando o aluno muda de
      // unidade?" — e a resposta honesta seria "as cobranças antigas mentem".
      studentUnit: { $ifNull: [{ $arrayElemAt: ["$pessoa.unit", 0] }, null] },
    },
  };

  const contas = {
    $addFields: {
      falta: { $max: [0, { $subtract: [{ $ifNull: ["$amount", 0] }, "$pago"] }] },
      origem: {
        $switch: {
          branches: [
            // O avulso PRIMEIRO: ele não tem nenhum dos três vínculos, e sem
            // este ramo cairia no padrão "manual" — que é outra coisa (uma
            // cobrança escrita à mão, que tem vencimento).
            { case: { $ifNull: ["$avulso", false] }, then: "avulso" },
            { case: { $ifNull: ["$appointment", false] }, then: "appointment" },
            { case: { $ifNull: ["$aulao", false] }, then: "aulao" },
            { case: { $ifNull: ["$recurrence", false] }, then: "recurrence" },
          ],
          default: "manual",
        },
      },
    },
  };

  const atraso = {
    $addFields: {
      // ATRASADA é calculada, nunca gravada: é uma cobrança ABERTA cuja data
      // passou. Gravá-la exigiria alguém varrer o banco à meia-noite.
      atrasada: {
        $and: [
          { $eq: ["$status", "open"] },
          { $gt: ["$falta", 0] },
          { $ne: [{ $ifNull: ["$dueDate", null] }, null] },
          { $lt: ["$dueDate", agora] },
        ],
      },
      diasDeAtraso: {
        $cond: [
          {
            $and: [
              { $eq: ["$status", "open"] },
              { $ne: [{ $ifNull: ["$dueDate", null] }, null] },
              { $lt: ["$dueDate", agora] },
            ],
          },
          { $floor: { $divide: [{ $subtract: [agora, "$dueDate"] }, DIA_MS] } },
          0,
        ],
      },
    },
  };

  return { juntarPagamentos, juntarPessoa, derivados, contas, atraso };
}

// A CARTEIRA — a lista do Financeiro geral, uma PÁGINA por vez.
//
// ── Por que agregação, e não `find().sort().skip().limit()` ─────────────
//
// Porque quase nada do que esta tela mostra é campo da cobrança. `pago` é a soma
// dos pagamentos dela, `falta` é a diferença, `atrasada` é o relógio comparado
// com o vencimento, e o NOME da pessoa mora em outra collection. Ordenar ou
// filtrar por qualquer um deles exige que eles existam antes do `$sort` — daí os
// dois `$lookup` e o `$addFields`.
//
// ── UMA IDA AO BANCO, três respostas ────────────────────────────────────
//
// `$facet` separa o que cada uma enxerga, e a separação É a regra de negócio:
//
//   resumo   a JANELA INTEIRA, sem recorte nenhum — "como está o mês"
//   rows     a página, depois do recorte e da busca
//   total    quantas linhas o recorte tem, para a tela saber quantas páginas
//
// O resumo ignorar o recorte não é descuido: *"cada vez que eu troco de aba, os
// valores ali em cima mudam"*. A pergunta dos cartões é sobre o mês, não sobre a
// parte da lista que alguém resolveu ver.
// ── A SÉRIE MENSAL DO PAINEL (22/10/2026) ────────────────────────────────
//
// *"cadê os gráficos? veja a riqueza de detalhes que é no SprintHub"*.
//
// Os mesmos três números do cartão — recebido, a receber, atrasado — mês a mês.
// Ela não é um relatório novo: é a MESMA pipeline da carteira com um `$group`
// no lugar do `$facet`, e isso é a coisa mais importante deste bloco.
//
// ── O MÊS SAI DO VENCIMENTO, E TINHA DE SAIR ─────────────────────────────
//
// "Recebido em outubro" aqui quer dizer *o que entrou contra o que vencia em
// outubro*, e não *o dinheiro que caiu na conta em outubro*. É a definição que
// o cartão já usava (a janela da carteira é sobre `dueDate`), e trocá-la na
// série faria o último ponto do gráfico discordar do número desenhado em cima
// dele. Duas respostas para a mesma pergunta, a dez pixels de distância.
//
// ── O FUSO ENTRA AQUI, E NO PAYABLE NÃO ──────────────────────────────────
//
// `dueDate` de uma COBRANÇA é um instante de verdade: a do compromisso herda a
// hora do atendimento. Então o mês dela é o mês no fuso da casa, e sem o
// `timezone` a cobrança de 31/10 às 22h cairia em novembro.
//
// Em `Payable` é o contrário, e lá o comentário explica: a conta a pagar é
// gravada como meia-noite UTC do dia do calendário, e aplicar o fuso a ela
// EMPURRARIA tudo que vence no dia 1º para o mês anterior.
Finance_model.prototype.serieMensal = async function ({ de, ate, fuso, unit, units } = {}) {
  const charges = await this.charges();

  const agora = new Date();
  const instancia = instanceContext.current();
  const { juntarPagamentos, juntarPessoa, derivados, contas, atraso } = estagiosDaCobranca({
    instancia,
    agora,
  });

  const lente = ObjectId.isValid(unit) ? new ObjectId(String(unit)) : null;
  const cerca = lente ? null : lenteDeUnidade.filtroDeUnidades(units);
  const etapaDaCerca = cerca
    ? [{ $match: { $or: [{ studentUnit: cerca.$or[0].unit }, { studentUnit: null }] } }]
    : [];

  const linhas = await charges
    .aggregate(
      [
        { $match: { dueDate: { $gte: inicioDoDia(de, fuso), $lte: fimDoDia(ate, fuso) } } },
        juntarPagamentos,
        juntarPessoa,
        derivados,
        ...uniaoDeAvulsos({ instancia, juntarPessoa, comAvulsos: true, de, ate, fuso }),
        ...(lente ? [{ $match: { studentUnit: lente } }] : etapaDaCerca),
        contas,
        atraso,
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$dueDate", timezone: fuso } },
            recebido: { $sum: "$pago" },
            aReceber: { $sum: { $cond: [{ $eq: ["$status", "open"] }, "$falta", 0] } },
            atrasado: { $sum: { $cond: ["$atrasada", "$falta", 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  return linhas.map((l) => ({
    r: l._id,
    recebido: l.recebido || 0,
    aReceber: l.aReceber || 0,
    atrasado: l.atrasado || 0,
  }));
};

Finance_model.prototype.carteira = async function ({
  de,
  ate,
  status,
  busca,
  fuso,
  ordem,
  direcao,
  pagina,
  limite,
  // A unidade escolhida no alto da tela. Vazia é "todas".
  unit,
  // A cerca de unidades de quem pergunta (26/09/2026).
  units,
  // ── AS COBRANÇAS ESCOLHIDAS À MÃO ───────────────────────────────────────
  //
  // Uma lista de ids. Quando ela vem, é ELA que manda: a janela, o estado e a
  // busca continuam valendo (é o mesmo pipeline), mas o conjunto já está
  // decidido por quem marcou as caixas na tela.
  //
  // Existe para a FOLHA IMPRESSA das cobranças marcadas — ela abre por link,
  // sem a tela atrás, e precisa buscar de novo exatamente aquelas linhas.
  ids,
  // ── AS COBRANÇAS DE UMA PESSOA SÓ ───────────────────────────────────────
  //
  // O extrato da ficha. Recortar DEPOIS da busca (filtrando as linhas que
  // voltaram) daria certo na conta pequena e erraria calado na grande: o teto
  // da exportação é de cinco mil, e a pessoa de número cinco mil e um sairia
  // com o extrato vazio.
  personId,
  // Só de dentro do servidor — ver `lib/tetoDaLista.js`.
  exportando,
  // ── OS AVULSOS NA MESMA LISTA ──────────────────────────────────────────
  //
  // *"até hoje acho isso confuso... deixe só pagamento no sistema inteiro"*
  // (17/10/2026). A tela deixou de ter duas abas com dois substantivos; o
  // comentário logo acima de `recebimentos` explicava por que eram duas
  // consultas, e esta opção é a resposta à pergunta que ele fez depois.
  //
  // Um pagamento AVULSO é um pagamento que nasceu pago: sem cobrança do outro
  // lado, sem vencimento, sem falta. Ele entra aqui como linha, e é isso que
  // permite UMA lista — antes ele não tinha onde aparecer, e dinheiro que
  // entrou e não está em lugar nenhum é o pior buraco de relatório que existe.
  comAvulsos,
  // ── SÓ AS QUE RECEBERAM ALGUMA COISA (22/10/2026) ──────────────────────
  //
  // Para a janela que lista o que está POR TRÁS do "Recebido" do painel.
  //
  // `status: "paid"` não serve: ele quer dizer "falta zero", e uma cobrança de
  // R$ 500 com R$ 200 pagos entra no recebido do mês e NÃO é `paid`. Listar por
  // ele mostraria uma lista cuja soma é menor que o número no topo dela — a
  // pior espécie de relatório.
  //
  // A conta do painel é `$sum: "$pago"`; o conjunto dela é exatamente este.
  somentePagas,
} = {}) {
  const charges = await this.charges();

  const janela = {};
  // A janela é sobre o VENCIMENTO, não sobre quando a cobrança foi criada: o
  // relatório do mês é o do que vence no mês.
  if (de || ate) {
    janela.dueDate = {};
    // O DIA inteiro, e no fuso da conta — ver o cabeçalho de `inicioDoDia`.
    if (de) janela.dueDate.$gte = inicioDoDia(de, fuso);
    if (ate) janela.dueDate.$lte = fimDoDia(ate, fuso);
  }

  const agora = new Date();

  // Pago, falta, atrasada e a unidade de quem deve — a definição única, que a
  // série mensal do painel lê pelo mesmo caminho. Ver `estagiosDaCobranca`.
  const { juntarPagamentos, juntarPessoa, derivados, contas, atraso } = estagiosDaCobranca({
    instancia: instanceContext.current(),
    agora,
  });

  // O POSTO da situação, para ordenar por ela. Mesma escala que a tela usava.
  const posto = {
    $addFields: {
      situacao: {
        $switch: {
          branches: [
            { case: { $eq: ["$status", "canceled"] }, then: 4 },
            { case: { $eq: ["$falta", 0] }, then: 3 },
            { case: "$atrasada", then: 1 },
          ],
          default: 2,
        },
      },
    },
  };

  // ── O RECORTE: estados e busca ─────────────────────────────────────────
  //
  // Ele mora DENTRO do facet, e só nos ramos `rows` e `total`. O ramo do resumo
  // parte do mesmo ponto sem ele — é o que faz os três cartões continuarem
  // falando do mês inteiro.
  const recorte = [];

  // Os ids escolhidos entram ANTES dos outros recortes: é o corte mais estreito
  // que existe, e pô-lo primeiro poupa ao banco aplicar regex de busca em
  // milhares de linhas para depois jogar fora todas menos cinco.
  //
  // `recorteDeIds` decide o que é "sem recorte": parâmetro AUSENTE traz tudo,
  // parâmetro PRESENTE traz só o que casa — ainda que nada case. Aqui estava
  // `if (escolhidas.length)`, e com ele um `?ids=` de ids que o servidor não
  // reconhece devolvia a CARTEIRA INTEIRA na folha de quem pediu cinco linhas.
  const escolhidas = recorteDeIds(ids);
  if (escolhidas) recorte.push({ $match: { _id: { $in: escolhidas } } });

  // Pelo mesmo caminho dos ids marcados, e pelo mesmo motivo: um `personId`
  // que o servidor não entende tem de dar ZERO linha, e não a casa inteira.
  // Com `if (valido)`, um id malformado vindo da rota fazia o extrato de uma
  // pessoa sair com o dinheiro de todo mundo — e a folha parece certa.
  const donos = recorteDeIds(personId);
  if (donos) recorte.push({ $match: { student: { $in: donos } } });

  if (somentePagas) recorte.push({ $match: { pago: { $gt: 0 } } });

  const pedidos = statusDeCobranca.pedidos(status);
  if (pedidos.size) {
    const aceitos = [...pedidos].filter((x) => x !== "late");
    const ou = [];
    if (aceitos.length) ou.push({ status: { $in: aceitos } });
    // "late" não é status gravado: é o campo calculado acima.
    if (pedidos.has("late")) ou.push({ atrasada: true });
    recorte.push({ $match: { $or: ou } });
  }

  // A BUSCA passou para o banco, e tinha de passar.
  //
  // Ela era um `filter` em JavaScript sobre a lista inteira — o que só funciona
  // enquanto a lista inteira vem. Buscando na página, "Ana" acharia as Anas das
  // vinte e cinco linhas carregadas e diria que não existe mais nenhuma.
  const termo = String(busca || "").trim();
  if (termo) {
    const esc = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    recorte.push({
      $match: {
        $or: [
          { studentName: { $regex: esc, $options: "i" } },
          { description: { $regex: esc, $options: "i" } },
        ],
      },
    });
  }

  const campo = ORDEM_DA_CARTEIRA[ordem] || "dueDate";
  const sentido = direcao === "asc" ? 1 : -1;

  const limitePorPagina = porPagina(limite, {
    padrao: LIMITE_PADRAO,
    maximo: LIMITE_MAXIMO,
    exportando,
  });
  const paginaPedida = Math.max(Number(pagina) || 1, 1);

  const projecao = {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      // O número que se fala. Cobrança antiga não tem — ver a migração em
      // `database/schema.js`; depois dela, todas têm.
      numero: { $ifNull: ["$numero", null] },
      student: { $toString: "$student" },
      description: { $ifNull: ["$description", ""] },
      amount: { $ifNull: ["$amount", 0] },
      pago: 1,
      falta: 1,
      dueDate: 1,
      // QUANDO A COBRANÇA NASCEU, que é outra pergunta que o vencimento não
      // responde: "lancei isso quando?" separa o que se combinou em janeiro do
      // que se combinou ontem, mesmo os dois vencendo no mesmo dia.
      createdAt: { $ifNull: ["$createdAt", null] },
      status: 1,
      currency: { $ifNull: ["$currency", null] },
      origem: 1,
      atrasada: 1,
      diasDeAtraso: 1,
      studentName: 1,
      studentEmail: 1,
      studentPhone: 1,
      studentAvatarAt: 1,
      studentUnit: { $toString: "$studentUnit" },
      // A linha é um avulso? A tela desenha o vencimento e a falta de outro
      // jeito — num avulso eles não existem.
      avulso: { $ifNull: ["$avulso", false] },
      // E a posição no carnê, quando ela faz parte de um: é o que faz a
      // linha dizer "3/12" em vez de repetir o mesmo nome doze vezes.
      parcela: { $ifNull: ["$parcela", null] },
      parcelas: { $ifNull: ["$parcelas", null] },
      // DE QUAL ASSINATURA ela nasceu. A tela usa isto para a janela "as
      // cobranças desta assinatura" (*"bote um botão para ver as faturas da
      // assinatura"*, 19/10/2026): sem o vínculo, a aba de assinaturas não
      // teria como dizer QUAIS das cobranças ao lado são dela.
      recurrence: {
        $cond: [{ $ifNull: ["$recurrence", false] }, { $toString: "$recurrence" }, null],
      },
      // E o estado VERDADEIRO dele. Um reembolso vira `canceled` na coluna de
      // situação da cobrança porque é o estado mais próximo que existe lá, e
      // mostrar "Cancelado" para dinheiro que foi devolvido é uma conversa com
      // o cliente que ninguém quer ter.
      avulsoStatus: { $ifNull: ["$avulsoStatus", null] },
      // ── O QUE O GATEWAY SABE DESTA COBRANÇA ─────────────────────────
      //
      // `url` é o link da fatura, e só existe em quem foi gerada lá: é o que
      // se reenvia quando pedem a segunda via, sem abrir o painel deles.
      // `situacao` é o que está acontecendo com ela — autorizada, em
      // análise, estornando —, e a tela já sabia pintá-la na ficha.
      //
      // Strings vazias e não ausentes: o avulso vem do `$unionWith` e não
      // tem o campo, e um objeto que às vezes existe obrigaria cada leitor a
      // lembrar disso.
      gateway: {
        url: { $ifNull: ["$gateway.url", ""] },
        situacao: { $ifNull: ["$gateway.situacao", ""] },
        // O id da fatura lá. A tela não o mostra: ele responde "já foi
        // gerada?", que é o que decide se o menu oferece gerar — e gerar de
        // novo abriria um segundo boleto do mesmo dinheiro.
        pagamento: { $ifNull: ["$gateway.pagamento", ""] },
      },
    },
  };

  // ── OS AVULSOS, COMO LINHAS DESTA LISTA ────────────────────────────────
  //
  // `$unionWith` e não uma segunda consulta: paginar e ordenar DOIS resultados
  // no navegador não funciona — a página 2 de uma lista costurada de duas
  // fontes não é a página 2 de nada.
  //
  // Ele entra depois de `derivados`, onde o lado das cobranças já tem `pago` e
  // os campos da pessoa, e ANTES do `$facet`: é o que faz os cartões do topo e
  // a lista falarem do mesmo conjunto.
  //
  // A JANELA do avulso é a data DELE. Para a cobrança a janela é o vencimento;
  // o avulso não tem um, e a única data que ele tem é a do dinheiro entrando.
  // Gravá-la em `dueDate` é o que faz uma ordenação só servir aos dois.
  // Os avulsos como linhas desta lista. Ver `uniaoDeAvulsos` — a série mensal
  // do painel soma exatamente o mesmo conjunto.
  const unirAvulsos = uniaoDeAvulsos({
    instancia: instanceContext.current(),
    juntarPessoa,
    comAvulsos,
    de,
    ate,
    fuso,
  });

  // A unidade escolhida no alto da tela. Id inválido é ignorado — um id sujo
  // na URL não pode esvaziar o financeiro de ninguém.
  const lente = ObjectId.isValid(unit) ? new ObjectId(unit) : null;

  // A CERCA de quem só alcança algumas unidades (26/09/2026): ela vale quando
  // não há lente escolhida, e corta pela unidade da PESSOA da cobrança —
  // mesmo campo da lente. Ver `lib/lenteDeUnidade.js`.
  const cerca = lente ? null : lenteDeUnidade.filtroDeUnidades(units);
  const etapaDaCerca = cerca
    ? [{ $match: { $or: [{ studentUnit: cerca.$or[0].unit }, { studentUnit: null }] } }]
    : [];

  const [saida] = await charges
    .aggregate(
      [
        { $match: janela },
        juntarPagamentos,
        juntarPessoa,
        derivados,
        // Os avulsos entram aqui: o lado das cobranças já tem `pago` e os
        // campos da pessoa, e o que vem do `$unionWith` chega com os mesmos
        // nomes. Daqui para baixo o pipeline não sabe mais quem é quem — e é
        // exatamente isso que faz a lista ser UMA.
        ...unirAvulsos,
        // ── A LENTE DA UNIDADE ────────────────────────────────────────────
        //
        // *"o financeiro ainda puxa tudo"*. Ela entra DEPOIS da junção com a
        // pessoa, porque é ali que a unidade aparece — e ANTES do `$facet`,
        // que é o que faz os três cartões do topo (recebido, a receber,
        // atrasado) falarem da mesma unidade que a lista embaixo.
        //
        // Números que não batem com a lista que está do lado são piores que
        // números ausentes: ninguém desconfia de um total.
        ...(lente ? [{ $match: { studentUnit: lente } }] : etapaDaCerca),
        contas,
        atraso,
        posto,
        {
          $facet: {
            // A JANELA INTEIRA — sem recorte, sem busca, sem página.
            resumo: [
              {
                $group: {
                  _id: null,
                  recebido: { $sum: "$pago" },
                  aReceber: { $sum: { $cond: [{ $eq: ["$status", "open"] }, "$falta", 0] } },
                  atrasado: { $sum: { $cond: ["$atrasada", "$falta", 0] } },
                  quantasAtrasadas: { $sum: { $cond: ["$atrasada", 1, 0] } },
                  quantasAbertas: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
                  total: { $sum: 1 },
                },
              },
            ],
            rows: [
              ...recorte,
              // Vazio sempre no fim, nas duas direções — a mesma regra da lista
              // de pessoas. Ordenar por descrição para achar uma fileira de
              // linhas sem descrição no topo não ajuda ninguém.
              { $addFields: { __vazio: { $cond: [{ $in: [`$${campo}`, [null, ""]] }, 1, 0] } } },
              // `_id` no fim desempata: sem um critério estável, duas cobranças
              // com o mesmo vencimento podem trocar de lugar entre uma página e
              // outra — e aí uma delas some e outra aparece duas vezes.
              { $sort: { __vazio: 1, [campo]: sentido, _id: 1 } },
              { $skip: (paginaPedida - 1) * limitePorPagina },
              { $limit: limitePorPagina },
              projecao,
            ],
            total: [...recorte, { $count: "n" }],
          },
        },
      ],
      // Collation do banco em vez de `localeCompare` no navegador: é ela que faz
      // "Ávila" cair perto de "Avila", e não depois de "Zanetti".
      { collation: { locale: "pt", strength: 1 } },
    )
    .toArray();

  const resumo = saida?.resumo?.[0] || {};

  return {
    rows: saida?.rows || [],
    total: saida?.total?.[0]?.n || 0,
    pagina: paginaPedida,
    limite: limitePorPagina,
    resumo: {
      recebido: resumo.recebido || 0,
      aReceber: resumo.aReceber || 0,
      atrasado: resumo.atrasado || 0,
      quantasAtrasadas: resumo.quantasAtrasadas || 0,
      quantasAbertas: resumo.quantasAbertas || 0,
      total: resumo.total || 0,
    },
  };
};

// ── O RESUMO ──────────────────────────────────────────────────────────────
//
// Sobre TODAS as linhas da janela, e não sobre as filtradas: filtrar por
// "atrasadas" e ver o total a receber cair para o valor dos atrasados faria o
// número parecer um total da seleção. É a mesma decisão da carteira de
// assinaturas no painel.
function resumoDe(linhas) {
  const abertas = linhas.filter((l) => l.status === "open");

  return {
    // O que ENTROU: a soma do que foi pago, independente do status da cobrança
    // (uma cobrança cancelada depois de paga não desfaz o dinheiro).
    recebido: linhas.reduce((t, l) => t + l.pago, 0),
    // O que falta entrar das abertas.
    aReceber: abertas.reduce((t, l) => t + l.falta, 0),
    atrasado: linhas.filter((l) => l.atrasada).reduce((t, l) => t + l.falta, 0),
    quantasAtrasadas: linhas.filter((l) => l.atrasada).length,
    quantasAbertas: abertas.length,
    total: linhas.length,
  };
}

// ── OS RECEBIMENTOS, de todo mundo ────────────────────────────────────────
//
// *"eu cadastrei esse pagamento, mas não aparece aqui em financeiro"*.
//
// E não aparecia mesmo: a tela do Financeiro lista COBRANÇAS. O pagamento dele
// era avulso — R$ 75 de uma camisa, sem cobrança do outro lado —, e um
// pagamento sem cobrança não tem como virar linha numa lista de cobranças. Ele
// não estava escondido por filtro; ele não tinha onde aparecer.
//
// Dinheiro que entrou e não está em lugar nenhum é o pior tipo de buraco de
// relatório: não dá erro, não some da conta bancária, e só aparece quando
// alguém fecha o mês à mão e a soma não bate.
//
// ── POR QUE UMA CONSULTA PRÓPRIA, e não um remendo na carteira ──────────
//
// A carteira parte de `charges` e junta os pagamentos. Para incluir os avulsos
// ela teria de partir de dois lugares ao mesmo tempo — e cada coluna dela
// (vencimento, falta, situação) não quer dizer nada num pagamento avulso.
//
// São duas perguntas: "o que me devem" e "o que entrou". Esta responde a
// segunda, e por isso a janela dela é a DATA DO PAGAMENTO — não o vencimento
// de coisa nenhuma.
Finance_model.prototype.recebimentos = async function ({
  de,
  ate,
  status,
  busca,
  fuso,
  ordem,
  direcao,
  pagina,
  limite,
  unit,
  // A cerca de unidades de quem pergunta (26/09/2026).
  units,
  // Os recebimentos marcados na tela, para a planilha e a folha deles.
  ids,
  personId,
  exportando,
} = {}) {
  const col = await this.payments();
  const instancia = instanceContext.current();

  const janela = {};
  if (de || ate) {
    janela.date = {};
    if (de) janela.date.$gte = inicioDoDia(de, fuso);
    if (ate) janela.date.$lte = fimDoDia(ate, fuso);
  }

  const juntarPessoa = {
    $lookup: {
      from: "users",
      let: { pessoa: "$student" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$_id", "$$pessoa"] },
            ...(instancia ? { instance: instancia } : {}),
          },
        },
        { $project: { name: 1, email: 1, phone: 1, avatarAt: 1, unit: 1 } },
      ],
      as: "pessoa",
    },
  };

  // A COBRANÇA de onde ele veio, só para a descrição. O pagamento avulso não
  // tem nenhuma, e é exatamente por isso que ele existe nesta lista — a junção
  // devolve vazio e a linha continua inteira.
  const juntarCobranca = {
    $lookup: {
      from: "charges",
      let: { cobranca: "$charge" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$_id", "$$cobranca"] },
            ...(instancia ? { instance: instancia } : {}),
          },
        },
        { $project: { description: 1, numero: 1 } },
      ],
      as: "cobranca",
    },
  };

  const derivados = {
    $addFields: {
      studentName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
      studentEmail: { $ifNull: [{ $arrayElemAt: ["$pessoa.email", 0] }, ""] },
      studentPhone: { $ifNull: [{ $arrayElemAt: ["$pessoa.phone", 0] }, ""] },
      studentAvatarAt: { $ifNull: [{ $arrayElemAt: ["$pessoa.avatarAt", 0] }, null] },
      studentUnit: { $ifNull: [{ $arrayElemAt: ["$pessoa.unit", 0] }, null] },
      chargeDescription: { $ifNull: [{ $arrayElemAt: ["$cobranca.description", 0] }, ""] },
      chargeNumero: { $ifNull: [{ $arrayElemAt: ["$cobranca.numero", 0] }, null] },
      // O que a lista MOSTRA como descrição: a observação do pagamento quando
      // há uma, senão a da cobrança. Um avulso só tem a primeira ("Camisa"), e
      // sem esta escolha ele apareceria como linha sem assunto.
      assunto: {
        $cond: [
          { $gt: [{ $strLenCP: { $ifNull: ["$note", ""] } }, 0] },
          "$note",
          { $ifNull: [{ $arrayElemAt: ["$cobranca.description", 0] }, ""] },
        ],
      },
      avulso: { $eq: [{ $ifNull: ["$charge", null] }, null] },
    },
  };

  const recorte = [];

  // OS MARCADOS na tela. Primeiro, porque é o corte mais estreito que existe.
  const escolhidos = recorteDeIds(ids);
  if (escolhidos) recorte.push({ $match: { _id: { $in: escolhidos } } });

  // O caixa de UMA pessoa — o extrato da ficha.
  // Pelo mesmo caminho dos ids marcados, e pelo mesmo motivo: um `personId`
  // que o servidor não entende tem de dar ZERO linha, e não a casa inteira.
  // Com `if (valido)`, um id malformado vindo da rota fazia o extrato de uma
  // pessoa sair com o dinheiro de todo mundo — e a folha parece certa.
  const donos = recorteDeIds(personId);
  if (donos) recorte.push({ $match: { student: { $in: donos } } });

  // OS ESTADOS pedidos: pago, pendente, reembolsado, cancelado. Vazio é todos.
  //
  // Eles moram no RECORTE e não no `$match` de cima, junto do resumo: os
  // cartões falam da janela, e marcar "pendente" para conferir uma lista não
  // pode fazer o "recebido" do mês virar zero.
  const porEstado = statusDePagamento.filtroPedido(status);
  if (porEstado) recorte.push({ $match: porEstado });

  const termo = String(busca || "").trim();
  if (termo) {
    const esc = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    recorte.push({
      $match: {
        $or: [
          { studentName: { $regex: esc, $options: "i" } },
          { assunto: { $regex: esc, $options: "i" } },
        ],
      },
    });
  }

  const campo = ORDEM_DOS_RECEBIMENTOS[ordem] || "date";
  const sentido = direcao === "asc" ? 1 : -1;

  const limitePorPagina = porPagina(limite, {
    padrao: LIMITE_PADRAO,
    maximo: LIMITE_MAXIMO,
    exportando,
  });
  const paginaPedida = Math.max(Number(pagina) || 1, 1);

  const projecao = {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      numero: { $ifNull: ["$numero", null] },
      student: { $toString: "$student" },
      charge: { $cond: [{ $ifNull: ["$charge", false] }, { $toString: "$charge" }, null] },
      chargeNumero: 1,
      assunto: 1,
      avulso: 1,
      amount: { $ifNull: ["$amount", 0] },
      currency: { $ifNull: ["$currency", null] },
      method: { $ifNull: ["$method", "other"] },
      status: { $ifNull: ["$status", "paid"] },
      date: 1,
      note: { $ifNull: ["$note", ""] },
      studentName: 1,
      studentEmail: 1,
      studentPhone: 1,
      studentAvatarAt: 1,
      studentUnit: {
        $cond: [{ $ifNull: ["$studentUnit", false] }, { $toString: "$studentUnit" }, null],
      },
    },
  };

  // ── A LENTE DA UNIDADE ──────────────────────────────────────────────────
  //
  // *"os KPI parece que não respeita unidade: eu troco ali, a planilha muda
  // mas os KPI não"*.
  //
  // Ela estava no RECORTE, junto da busca e do estado — e ali o `$facet` já
  // calculou o resumo. Os cartões diziam sete lançamentos com uma linha na
  // lista embaixo.
  //
  // Agrupar a lente com busca e estado foi o meu erro, e eles não são a mesma
  // coisa. Busca e estado ESTREITAM a lista dentro do mesmo contexto: marcar
  // "pendente" para conferir não pode zerar o recebido do mês. A lente TROCA
  // o contexto — ela mora no alto do app e diz "agora estou olhando Niterói".
  // Todo número da tela tem de segui-la.
  //
  // Por isso ela entra aqui, antes do `$facet`, exatamente como na carteira:
  // números que não batem com a lista do lado são piores que números
  // ausentes, porque ninguém desconfia de um total.
  const lenteDaUnidade = ObjectId.isValid(unit) ? new ObjectId(String(unit)) : null;

  // A mesma cerca da carteira.
  const cercaDaUnidade = lenteDaUnidade ? null : lenteDeUnidade.filtroDeUnidades(units);
  const etapaDaCercaAqui = cercaDaUnidade
    ? [{ $match: { $or: [{ studentUnit: cercaDaUnidade.$or[0].unit }, { studentUnit: null }] } }]
    : [];

  const [saida] = await col
    .aggregate([
      { $match: janela },
      juntarPessoa,
      juntarCobranca,
      derivados,
      ...(lenteDaUnidade ? [{ $match: { studentUnit: lenteDaUnidade } }] : etapaDaCercaAqui),
      {
        $facet: {
          // ── OS CARTÕES DO TOPO ──────────────────────────────────────
          //
          // Um por ESTADO que é dinheiro em movimento, e não um só com tudo
          // somado: *"em pagamento, quero os kpi que falta"*.
          //
          //   recebido     entrou e ficou
          //   pendente     prometido, ainda não confirmado
          //   reembolsado  entrou e VOLTOU — duas movimentações, as duas reais
          //   cancelado    o lançamento não devia existir; nada se moveu
          //
          // O quarto entrou a pedido dele, depois de ver os três: *"faltou
          // cancelado"*. Eu o tinha deixado de fora com o argumento de que
          // somar o que nunca aconteceu seria apresentar dinheiro que não
          // houve — e o argumento dele é melhor: o cartão não é só soma, é
          // CONFERÊNCIA. Quem cancelou três lançamentos de R$ 25 por engano
          // quer ver os R$ 75 em algum lugar para saber que foram eles.
          //
          // O que o mantém honesto é a cor: ele nasce cinza, e não verde. As
          // contas do caixa continuam sendo `recebido` — e só ele.
          //
          // O resumo ignora a BUSCA e o ESTADO pedido, como o da carteira:
          // os cartões falam da janela, e marcar "pendente" para conferir uma
          // lista não pode fazer o recebido do mês virar zero.
          //
          // A LENTE não está nesta lista: ela já entrou antes do `$facet` —
          // ver o comentário lá em cima sobre por que ela não é da mesma
          // família que a busca e o estado.
          //
          // `$ifNull` porque lançamento antigo não tem o campo, e ausente
          // sempre significou pago — ver lib/statusDePagamento.js.
          resumo: [
            { $addFields: { estado: { $ifNull: ["$status", "paid"] } } },
            {
              $group: {
                _id: null,
                recebido: { $sum: { $cond: [{ $eq: ["$estado", "paid"] }, "$amount", 0] } },
                total: { $sum: { $cond: [{ $eq: ["$estado", "paid"] }, 1, 0] } },
                pendente: { $sum: { $cond: [{ $eq: ["$estado", "pending"] }, "$amount", 0] } },
                quantosPendentes: { $sum: { $cond: [{ $eq: ["$estado", "pending"] }, 1, 0] } },
                reembolsado: { $sum: { $cond: [{ $eq: ["$estado", "refunded"] }, "$amount", 0] } },
                quantosReembolsados: {
                  $sum: { $cond: [{ $eq: ["$estado", "refunded"] }, 1, 0] },
                },
                cancelado: { $sum: { $cond: [{ $eq: ["$estado", "canceled"] }, "$amount", 0] } },
                quantosCancelados: { $sum: { $cond: [{ $eq: ["$estado", "canceled"] }, 1, 0] } },
              },
            },
          ],
          rows: [
            ...recorte,
            { $sort: { [campo]: sentido, _id: 1 } },
            { $skip: (paginaPedida - 1) * limitePorPagina },
            { $limit: limitePorPagina },
            projecao,
          ],
          total: [...recorte, { $count: "n" }],
        },
      },
    ])
    .toArray();

  const resumo = saida?.resumo?.[0] || {};

  return {
    rows: saida?.rows || [],
    total: saida?.total?.[0]?.n || 0,
    pagina: paginaPedida,
    limite: limitePorPagina,
    resumo: {
      recebido: resumo.recebido || 0,
      total: resumo.total || 0,
      pendente: resumo.pendente || 0,
      quantosPendentes: resumo.quantosPendentes || 0,
      reembolsado: resumo.reembolsado || 0,
      quantosReembolsados: resumo.quantosReembolsados || 0,
      cancelado: resumo.cancelado || 0,
      quantosCancelados: resumo.quantosCancelados || 0,
    },
  };
};

Finance_model.prototype.listPayments = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.payments();

  return await col
    .find({ student: new ObjectId(studentId) })
    .sort({ date: -1 })
    .toArray();
};

// Os pagamentos de UMA cobrança.
//
// Existe porque o diálogo de editar mostra "Paga" e, sem a lista, isso é uma
// afirmação que a pessoa não tem como conferir: *"a cobrança tem pagamentos,
// certo? mais fácil exibir os pagamentos aqui nesse dialog"*.
//
// A ficha da pessoa já tinha os dados (ela carrega TODOS os pagamentos dela e
// separa por cobrança), mas a lista do financeiro é de gente diferente em cada
// linha — carregar o extrato inteiro de alguém para abrir uma cobrança seria
// pagar caro por três linhas.
Finance_model.prototype.paymentsOfCharge = async function (chargeId) {
  if (!ObjectId.isValid(chargeId)) return [];
  const col = await this.payments();

  return await col
    .find({ charge: new ObjectId(chargeId) })
    .sort({ date: -1 })
    .toArray();
};

Finance_model.prototype.paymentData = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.payments();

  const doc = await col.findOne({ _id: new ObjectId(id) });
  return doc || undefined;
};

// ── A MOEDA DE UM PAGAMENTO QUE APONTA PARA UMA COBRANÇA É A DELA ─────────
//
// Quitar uma cobrança de R$ 25 com um pagamento de US$ 25 não dá erro em lugar
// nenhum: a conta FECHA. `paidByCharge`, `balanceOf` e a carteira somam
// `amount` e comparam com o da cobrança — 2500 quita 2500, e ninguém pergunta
// de que moeda são.
//
// Está aqui, e não nas rotas, porque são DOIS caminhos (criar e editar) e o
// segundo é o pior: o pagamento já estava certo, a conta já fechou uma vez, e a
// troca de moeda numa edição desfaz isso sem deixar rastro na tela.
//
// Pagamento AVULSO — sem cobrança — continua com a moeda que foi pedida.
// Adiantamento em outra moeda é combinado legítimo; o que não existe é combinado
// de quitar em uma moeda uma dívida em outra.
Finance_model.prototype.moedaDaCobranca = async function (chargeId) {
  if (!ObjectId.isValid(chargeId)) return null;
  const doc = await (
    await this.charges()
  ).findOne({ _id: new ObjectId(chargeId) }, { projection: { currency: 1 } });
  return doc?.currency || null;
};

Finance_model.prototype.insertPayment = async function (studentId, obj, createdBy, currency) {
  const col = await this.payments();
  const moeda = (await this.moedaDaCobranca(obj.charge)) || currency;

  const r = await col.insertOne({
    student: new ObjectId(studentId),
    // O número do RECIBO, na sequência própria dos pagamentos. Própria e não
    // compartilhada com a cobrança: são duas perguntas diferentes ("qual a
    // fatura?" e "qual o recebimento?"), e uma sequência só faria a fatura #12
    // conviver com o recibo #13 sem nenhuma relação entre os dois números.
    numero: await this.app.api.counter.proximo("payments"),
    currency: moeda || null,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    // A qual cobrança se refere, se a alguma: pagamento avulso é legítimo —
    // alguém que paga adiantado, ou uma venda que nunca virou cobrança.
    charge: ObjectId.isValid(obj.charge) ? new ObjectId(obj.charge) : null,

    // ── FOI UM BOTÃO QUE LANÇOU ISTO? ───────────────────────────────────
    //
    // `true` quando veio de um atalho do sistema — hoje só o "marcar como
    // pago" da lista de inscritos do aulão.
    //
    // Existe por causa do DESFAZER. Sem a marca, "marcar como não pago"
    // precisaria apagar todos os pagamentos da cobrança — e apagaria também o
    // parcial que alguém digitou à mão no financeiro, que é dado de gente e
    // não subproduto de um clique.
    //
    // AQUI e não no `limparPagamento`: aquele fecha o documento numa lista de
    // campos, e o que for mandado por fora dele é descartado em silêncio — foi
    // exatamente o que aconteceu com o `aulao` da cobrança.
    automatico: obj.automatico === true,
    ...limparPagamento(obj),
    receipt: obj.receipt || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return r.insertedId;
};

Finance_model.prototype.updatePayment = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.payments();

  const mudanca = { ...limparPagamento(obj), updatedAt: new Date() };
  if (ObjectId.isValid(obj.charge)) mudanca.charge = new ObjectId(obj.charge);
  else if (obj.charge === null || obj.charge === "") mudanca.charge = null;

  if (obj.currency) mudanca.currency = obj.currency;

  // A moeda segue a cobrança — ver `moedaDaCobranca`.
  //
  // Qual cobrança: a que a edição APONTA (`mudanca.charge`), ou, quando a edição
  // não fala de vínculo nenhum, a que o pagamento JÁ tem. Esse segundo caso é o
  // que uma chamada parcial — `{ currency: "USD" }` e nada mais — usaria para
  // passar por baixo da regra. `null` explícito é desvínculo pedido, e aí o
  // pagamento vira avulso e a moeda volta a ser escolha de quem lança.
  let alvo = mudanca.charge;
  if (alvo === undefined && obj.currency) {
    const atual = await col.findOne({ _id: new ObjectId(id) }, { projection: { charge: 1 } });
    alvo = atual?.charge;
  }

  const daCobranca = await this.moedaDaCobranca(alvo);
  if (daCobranca) mudanca.currency = daCobranca;

  // Tirar o comprovante no formulário tem de tirá-lo de verdade. Sem esta
  // linha, a tela mostrava o anexo removido e o servidor continuava com ele —
  // e os bytes ficavam no banco sem nada apontando para eles.
  if (obj.receipt === null) {
    await this.removeReceipt(id);
    mudanca.receipt = null;
  }

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  return r.matchedCount > 0;
};

Finance_model.prototype.deletePayment = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ payment: new ObjectId(id) });

  const col = await this.payments();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

// ── Comprovante ───────────────────────────────────────────────────────────

Finance_model.prototype.parseReceipt = function (arquivo) {
  if (!arquivo || !arquivo.dataUri) return undefined;

  const lido = parseDataUri(arquivo.dataUri, {
    maxBytes: MAX_COMPROVANTE,
    mimes: TIPOS_COMPROVANTE,
  });
  if (!lido) return undefined;

  // Só o nome, sem caminho, e sem caracteres de controle: ele volta para a
  // tela e vira o nome do download.
  const nome = String(arquivo.name || "")
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 120);

  return {
    mime: lido.mime,
    buffer: lido.buffer,
    ficha: {
      name: nome || "comprovante",
      mime: lido.mime,
      size: lido.buffer.length,
      // Imagem abre na tela; PDF baixa. É a mesma regra dos anexos da conversa.
      kind: lido.mime.startsWith("image/") ? "image" : "file",
    },
  };
};

Finance_model.prototype.saveReceipt = async function (paymentId, anexo) {
  const arquivos = await this.files();

  await arquivos.updateOne(
    { payment: new ObjectId(paymentId) },
    {
      $set: {
        payment: new ObjectId(paymentId),
        mime: anexo.mime,
        name: anexo.ficha.name,
        size: anexo.ficha.size,
        data: anexo.buffer,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  const col = await this.payments();
  await col.updateOne({ _id: new ObjectId(paymentId) }, { $set: { receipt: anexo.ficha } });
};

Finance_model.prototype.receiptOf = async function (paymentId) {
  if (!ObjectId.isValid(paymentId)) return undefined;
  const arquivos = await this.files();

  const doc = await arquivos.findOne({ payment: new ObjectId(paymentId) });
  return doc || undefined;
};

Finance_model.prototype.removeReceipt = async function (paymentId) {
  if (!ObjectId.isValid(paymentId)) return false;

  const arquivos = await this.files();
  await arquivos.deleteMany({ payment: new ObjectId(paymentId) });

  const col = await this.payments();
  await col.updateOne({ _id: new ObjectId(paymentId) }, { $set: { receipt: null } });
  return true;
};

// ── O resumo ──────────────────────────────────────────────────────────────
//
// Quanto foi cobrado, quanto entrou, e o que falta — UM POR MOEDA.
//
// Não é um número só porque não pode ser: R$ 100 + US$ 100 não é 200 de coisa
// nenhuma, e um total somando os dois seria um número que não existe em lugar
// nenhum do mundo. O mapa também é o que um contador espera ver.
//
// Calculado na LEITURA e não guardado: um saldo gravado discorda dos
// lançamentos assim que alguém corrige um valor, e ninguém descobre qual dos
// dois está certo.
Finance_model.prototype.balanceOf = async function (studentId, moedaPadrao) {
  const cobrancas = await this.listCharges(studentId);
  const pagamentos = await this.listPayments(studentId);

  const porMoeda = {};
  const linha = (moeda) => {
    const chave = moeda || moedaPadrao || "BRL";
    if (!porMoeda[chave]) porMoeda[chave] = { charged: 0, paid: 0, balance: 0 };
    return porMoeda[chave];
  };

  for (const c of cobrancas) {
    // Cobrança cancelada não conta como dívida: ela existe só como registro.
    if (c.status === "canceled") continue;
    linha(c.currency).charged += c.amount || 0;
  }

  // Só o que ENTROU conta como pago. Um pagamento pendente é uma promessa, e um
  // reembolsado é dinheiro que voltou — somar os dois faria a tela dizer que a
  // pessoa está quite quando ela não está.
  for (const p of pagamentos) {
    if (!entrou(p)) continue;
    linha(p.currency).paid += p.amount || 0;
  }

  for (const chave of Object.keys(porMoeda)) {
    porMoeda[chave].balance = porMoeda[chave].charged - porMoeda[chave].paid;
  }

  return porMoeda;
};

// Quanto já foi pago de CADA cobrança. Um objeto id → centavos, para a tela
// marcar o que está quitado sem uma consulta por linha.
Finance_model.prototype.paidByCharge = async function (studentId) {
  const pagamentos = await this.listPayments(studentId);

  const soma = {};
  for (const p of pagamentos) {
    if (!p.charge) continue;
    // Mesma regra do saldo: promessa e reembolso não quitam cobrança. Sem isto,
    // um pagamento pendente marcaria a cobrança como paga e ela sumiria da lista
    // de quem ainda deve.
    if (!entrou(p)) continue;
    const chave = String(p.charge);
    soma[chave] = (soma[chave] || 0) + (p.amount || 0);
  }

  return soma;
};

// ── Cascata ───────────────────────────────────────────────────────────────

Finance_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;

  const pagamentos = await this.payments();
  const doAluno = await pagamentos
    .find({ student: new ObjectId(studentId) }, { projection: { _id: 1 } })
    .toArray();

  if (doAluno.length) {
    const arquivos = await this.files();
    await arquivos.deleteMany({ payment: { $in: doAluno.map((p) => p._id) } });
  }

  await pagamentos.deleteMany({ student: new ObjectId(studentId) });

  const cobrancas = await this.charges();
  const r = await cobrancas.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount || 0;
};

module.exports = Finance_model;
module.exports.FORMAS = FORMAS;
module.exports.STATUS = STATUS;
module.exports.situacaoDaCobranca = situacaoDaCobranca;

// ── AS COBRANÇAS DE UM AULÃO, POR PESSOA ──────────────────────────────────
//
// Para a lista de inscritos: quem já pagou, quem falta, e quanto.
//
// ── "Pago" é uma SOMA, e não o campo `status` ─────────────────────────────
//
// É a mesma regra do `carteira`, e ela não pode ser reinventada aqui: pagamento
// PARCIAL existe — alguém paga metade hoje e metade no dia da aula —, e só
// pagamento com `status: "paid"` quita. Promessa e reembolso não.
//
// Duas consultas para a lista inteira, e não duas por pessoa: trinta inscritos
// dariam sessenta idas ao banco para desenhar uma tela.
Finance_model.prototype.cobrancasDeAulao = async function (aulaoId) {
  if (!ObjectId.isValid(aulaoId)) return {};

  const col = await this.charges();
  const cobrancas = await col.find({ aulao: new ObjectId(aulaoId) }).toArray();
  if (!cobrancas.length) return {};

  const pagamentos = await this.payments();
  const somas = await pagamentos
    .aggregate([
      {
        $match: {
          charge: { $in: cobrancas.map((c) => c._id) },
          ...statusDePagamento.filtroDeEntrada(),
        },
      },
      {
        $group: {
          _id: "$charge",
          total: { $sum: "$amount" },
          // ── COM QUE FORMA ENTROU ────────────────────────────────────────
          //
          // *"quando clicar em 'pagar' abre um menuzinho pra escolher o meio de
          // pagamento, e aí aparece ali pago (cartão)"* (23/09/2026). Para a
          // etiqueta dizer "Pago · Pix", a lista precisa saber a forma — e ela
          // vivia só nos pagamentos, que esta consulta somava e descartava.
          //
          // `$addToSet` e não `$last`: uma cobrança pode ter sido quitada em
          // duas vezes, metade em dinheiro e metade no cartão. Mostrar a última
          // seria dizer "pago no cartão" sobre algo que entrou pelos dois. Com
          // o conjunto, quem desenha decide — e só nomeia a forma quando há UMA.
          formas: { $addToSet: { $ifNull: ["$method", "other"] } },
        },
      },
    ])
    .toArray();

  const pagoPor = Object.fromEntries(somas.map((x) => [String(x._id), x.total]));
  const formasPor = Object.fromEntries(somas.map((x) => [String(x._id), x.formas || []]));

  const porPessoa = {};
  for (const c of cobrancas) {
    const pago = pagoPor[String(c._id)] || 0;
    const formas = formasPor[String(c._id)] || [];

    porPessoa[String(c.student)] = {
      id: String(c._id),
      amount: c.amount || 0,
      pago,
      falta: Math.max(0, (c.amount || 0) - pago),
      status: c.status,
      currency: c.currency || null,
      // A forma, só quando é UMA. Com duas, a tela diz "pago" e cala a forma —
      // ver o comentário do `$addToSet` acima.
      forma: formas.length === 1 ? formas[0] : null,
    };
  }

  return porPessoa;
};

// ── QUITAR uma cobrança de uma vez ────────────────────────────────────────
//
// "marcar como pago" na lista de inscritos. No app isto sempre foram DOIS
// passos — lançar o pagamento e depois fechar a cobrança —, e ninguém faz os
// dois trinta vezes depois de um aulão.
//
// ── Os dois passos, e por que os dois ─────────────────────────────────────
//
// O PAGAMENTO é o dinheiro: sem ele o relatório diria que entrou zero.
// O STATUS é a cobrança: sem ele ela continua "aberta" com nada faltando, e
// aparece na lista de quem deve com R$ 0,00 — pior que errado, é confuso.
//
// ── O QUE ESTÁ ACONTECENDO COM ELA LÁ FORA ───────────────────────────────
//
// *"PAYMENT_AUTHORIZED, PAYMENT_AWAITING_RISK_ANALYSIS... deveria tratar
// esses também"* (15/10/2026).
//
// `gateway: { pagamento, situacao, em }`, e NENHUM deles encosta em `status`:
// aqui "paga" quer dizer que os pagamentos cobrem o valor, e cartão
// autorizado não é dinheiro na conta. Ver `lib/situacaoNoGateway.js`.
//
// O `pagamento` é o id da fatura lá, e ele é o maior ganho escondido deste
// método: gravado uma vez, todo aviso seguinte daquela fatura encontra ESTA
// cobrança por identidade, em vez de por vencimento — que é um palpite que
// erra assim que alguém muda a data no painel do Asaas.
//
// Fora de `limparCobranca` de propósito, como o `gateway` da recorrência:
// isto não vem de formulário nenhum, vem da resposta do gateway.
Finance_model.prototype.marcarNoGateway = async function (chargeId, dados = {}) {
  if (!ObjectId.isValid(chargeId)) return false;

  const mudanca = { "gateway.em": new Date(), updatedAt: new Date() };
  if (dados.pagamento) mudanca["gateway.pagamento"] = String(dados.pagamento);
  // O LINK da fatura — a página do gateway com pix, boleto e cartão. É o que
  // a pessoa de fato usa, e guardá-lo é o que deixa reenviá-lo amanhã sem ir
  // ao painel deles procurar. Só na criação: o webhook não o manda, e um
  // `$set` com vazio apagaria o que já está gravado.
  if (dados.url) mudanca["gateway.url"] = String(dados.url);
  if (situacaoNoGateway.existe(dados.situacao))
    mudanca["gateway.situacao"] = String(dados.situacao);

  const col = await this.charges();
  const r = await col.updateOne({ _id: new ObjectId(chargeId) }, { $set: mudanca });
  return r.matchedCount > 0;
};

// ── A FATURA DE LÁ DEIXOU DE EXISTIR ─────────────────────────────────────
//
// Cancelar a cobrança APAGA a fatura no gateway (ver o PUT em
// `controllers/Finance.js`), e a partir daí os rastros dela aqui são
// promessas falsas: o link abriria um 404, o menu ofereceria estornar o que
// não existe, e gerar de novo seria recusado com 409 por causa de um id
// morto.
//
// Some com os três de uma vez. O que fica é a cobrança cancelada, que pode
// ser reaberta e gerada outra vez — aí com uma fatura nova, que é o certo:
// cobrança cancelada e recobrada são dois pedidos, não um.
Finance_model.prototype.limparNoGateway = async function (chargeId) {
  if (!ObjectId.isValid(chargeId)) return false;

  const col = await this.charges();
  const r = await col.updateOne(
    { _id: new ObjectId(chargeId) },
    {
      $unset: { "gateway.pagamento": "", "gateway.url": "", "gateway.situacao": "" },
      $set: { updatedAt: new Date() },
    },
  );
  return r.matchedCount > 0;
};

// ── MEXERAM NO VENCIMENTO OU NO VALOR LÁ ─────────────────────────────────
//
// Copia a mudança para cá, e SÓ quando a cobrança ainda não tem dinheiro
// dentro. Uma cobrança com pagamento é história: reescrever o valor dela
// faria uma quitação virar pagamento parcial (ou sobra) sem ninguém mexer em
// nada, que é o estrago que o `updateCharge` já causou uma vez.
//
// O `periodo` NÃO muda. Ele é a etiqueta que amarra a cobrança à ocorrência
// da recorrência, e é por ela que a geração sabe que aquele mês já nasceu —
// trocá-la faria a mensalidade de outubro nascer de novo no dia seguinte.
Finance_model.prototype.ajustarDoGateway = async function (chargeId, { vencimento, valor } = {}) {
  if (!ObjectId.isValid(chargeId)) return { ok: false, erro: "nao_achei" };

  const col = await this.charges();
  const cobranca = await col.findOne({ _id: new ObjectId(chargeId) });
  if (!cobranca) return { ok: false, erro: "nao_achei" };

  const pagos = await this.paidByCharge(cobranca.student);
  if ((pagos[String(cobranca._id)] || 0) > 0)
    return { ok: true, mexeu: false, erro: "tem_pagamento" };

  const mudanca = {};
  const dia = vencimento ? new Date(`${String(vencimento).slice(0, 10)}T00:00:00.000Z`) : null;
  if (dia && !Number.isNaN(dia.getTime())) mudanca.dueDate = dia;
  // Valor zero não vem do gateway por engano — mas se vier, é ruído, e
  // zerar uma cobrança é o tipo de estrago que ninguém procura.
  if (Number(valor) > 0) mudanca.amount = Math.round(Number(valor));

  if (!Object.keys(mudanca).length) return { ok: true, mexeu: false };

  mudanca.updatedAt = new Date();
  await col.updateOne({ _id: cobranca._id }, { $set: mudanca });
  return { ok: true, mexeu: true };
};

// ── IDEMPOTENTE ──────────────────────────────────────────────────────────
//
// Clicar duas vezes não lança dois pagamentos. `falta <= 0` devolve `ja_pago`
// sem escrever nada — e isso não é zelo abstrato: dois cliques num botão de
// "pago" é o gesto mais natural que existe quando a rede demora.
Finance_model.prototype.quitarCobranca = async function (chargeId, { method, createdBy } = {}) {
  if (!ObjectId.isValid(chargeId)) return { ok: false, erro: "nao_achei" };

  const col = await this.charges();
  const cobranca = await col.findOne({ _id: new ObjectId(chargeId) });
  if (!cobranca) return { ok: false, erro: "nao_achei" };

  const pagos = await this.paidByCharge(cobranca.student);
  const falta = Math.max(0, (cobranca.amount || 0) - (pagos[String(cobranca._id)] || 0));

  if (falta <= 0) {
    // Já estava quitada no dinheiro. O status é fechado de todo jeito: pode ter
    // ficado "aberto" por um pagamento lançado à mão na tela do financeiro.
    if (cobranca.status === "open") {
      await col.updateOne(
        { _id: cobranca._id },
        { $set: { status: "paid", updatedAt: new Date() } },
      );
    }
    return { ok: true, erro: "ja_pago", falta: 0 };
  }

  const pagamento = await this.insertPayment(
    cobranca.student,
    {
      // O que FALTA, e não o valor cheio: quem pagou metade antes não pode
      // aparecer tendo pago uma vez e meia.
      amount: falta,
      date: new Date(),
      method,
      status: "paid",
      charge: String(cobranca._id),
      // A marca do desfazer — ver `insertPayment`.
      automatico: true,
    },
    createdBy,
    cobranca.currency,
  );

  await col.updateOne({ _id: cobranca._id }, { $set: { status: "paid", updatedAt: new Date() } });

  return { ok: true, pagamento: String(pagamento), valor: falta };
};

// ── DESFAZER O "MARCAR COMO PAGO" ─────────────────────────────────────────
//
// O mesmo botão, apertado de novo. E o cuidado inteiro está em O QUE ele apaga.
//
// ── A primeira versão dizia que desfez e não desfazia ────────────────────
//
// Ela apagava só os pagamentos com `automatico: true` — a marca que o botão
// põe. Correto no papel, e errado na mão do Marlon: os pagamentos lançados
// ANTES de a marca existir (algumas horas, no mesmo dia) não a têm, então o
// botão anunciava "marcar como não pago", apagava zero, e a linha continuava
// paga. *"ele fala marco como não pago, mas continua pago."*
//
// Botão que promete e não cumpre é defeito, não sutileza.
//
// ── A regra, em duas camadas ─────────────────────────────────────────────
//
//   1. apaga os `automatico` — o que este botão criou, sem dúvida nenhuma;
//   2. se não havia nenhum E a cobrança está quitada por UM pagamento só que
//      a cobre inteira, apaga esse também.
//
// A segunda camada é o que resolve o caso do Marlon e o da instância de
// demonstração. Ela é segura porque "um pagamento só, do valor exato" não tem
// ambiguidade: desfazê-lo é exatamente o que se pediu, e ele é um lançamento
// visível que se refaz com um clique.
//
// ── O QUE ELA NUNCA APAGA ────────────────────────────────────────────────
//
// PARCIAIS. Dois ou mais pagamentos na mesma cobrança são história que alguém
// digitou — metade em dinheiro no dia da aula, metade no Pix depois — e
// escolher qual apagar seria adivinhar. Nesse caso devolve `manual: true` e
// não toca em nada; a tela diz para desfazer no financeiro da pessoa, onde a
// escolha é de quem olha os lançamentos.
//
// ── E o status é RECALCULADO, não chutado ────────────────────────────────
//
// Depois de apagar, a conta é feita de novo: se ainda falta, a cobrança volta
// a "open"; se o que sobrou já a cobre, continua "paid".
Finance_model.prototype.reabrirCobranca = async function (chargeId) {
  if (!ObjectId.isValid(chargeId)) return { ok: false, erro: "nao_achei" };

  const col = await this.charges();
  const cobranca = await col.findOne({ _id: new ObjectId(chargeId) });
  if (!cobranca) return { ok: false, erro: "nao_achei" };

  const pagamentos = await this.payments();

  // Camada 1: o que este botão criou.
  let apagados = (await pagamentos.deleteMany({ charge: cobranca._id, automatico: true }))
    .deletedCount;

  // Camada 2: um pagamento só, cobrindo a cobrança inteira.
  if (apagados === 0) {
    const doCharge = await pagamentos
      .find({ charge: cobranca._id, ...statusDePagamento.filtroDeEntrada() })
      .toArray();

    if (doCharge.length === 1 && (doCharge[0].amount || 0) >= (cobranca.amount || 0)) {
      await pagamentos.deleteOne({ _id: doCharge[0]._id });
      apagados = 1;
    } else if (doCharge.length > 1) {
      // Parciais: não escolho por ninguém. A tela explica onde desfazer.
      return { ok: true, apagados: 0, manual: true, falta: 0 };
    }
  }

  // A conta depois da remoção, pela mesma regra do resto: só pagamento com
  // `status: "paid"` quita.
  const somas = await pagamentos
    .aggregate([
      { $match: { charge: cobranca._id, ...statusDePagamento.filtroDeEntrada() } },
      { $group: { _id: "$charge", total: { $sum: "$amount" } } },
    ])
    .toArray();

  const pago = somas[0]?.total || 0;
  const falta = Math.max(0, (cobranca.amount || 0) - pago);

  await col.updateOne(
    { _id: cobranca._id },
    { $set: { status: falta > 0 ? "open" : "paid", updatedAt: new Date() } },
  );

  return { ok: true, apagados, falta };
};
