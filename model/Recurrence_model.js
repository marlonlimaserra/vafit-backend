const { ObjectId } = require("mongodb");
const recorrencia = require("../lib/recorrencia.js");
const statusDeRecorrencia = require("../lib/statusDeRecorrencia.js");
const instanceContext = require("../lib/instance.js");

// AS RECORRÊNCIAS DE UMA PESSOA — a mensalidade, a anuidade, o pacote trimestral.
//
//   { student, description, amount, currency, cadencia, startsAt, endsAt, active }
//
// Pedido do Marlon: *"todo mês eu pago 800 reais pra minha personal. Mas na
// academia eu pago anual"*.
//
// ── A RECORRÊNCIA NÃO É UMA COBRANÇA. Ela é a REGRA ──────────────────────
//
// O que a pessoa deve continua sendo a cobrança, com o vencimento dela, o
// pagamento dela e o status dela. A recorrência só diz "de novo, todo mês" — e
// some da conta: ela não entra em nenhum total, porque uma regra infinita somaria
// dinheiro infinito.
//
// Isso é o que permite editar o combinado sem mexer no passado. Subir a
// mensalidade de 800 para 900 muda as PRÓXIMAS; as doze que já foram cobradas
// continuam valendo 800, que é o que de fato aconteceu.
//
// ── QUANDO A COBRANÇA NASCE ──────────────────────────────────────────────
//
// Na LEITURA da tela do dinheiro — a aba da pessoa e o Financeiro geral —, e não
// num agendador.
//
// Este servidor não tem agendador nenhum, e montar um para isto custaria o que
// ele não paga: eleição de líder entre os workers (senão dois geram a mesma
// mensalidade), varredura de todas as instâncias fora do contexto assíncrono que
// garante o isolamento (`lib/escopo.js`), e um processo a mais para vigiar. A
// geração preguiçosa não precisa de nada disso: ela roda DENTRO da requisição,
// já escopada no cliente certo, e só para quem está olhando.
//
// O que se abre mão: a cobrança não existe até alguém abrir o financeiro. Na
// prática quem abre o financeiro é justamente quem age sobre ela — e a leitura
// que a criaria é a mesma que a mostraria. Se um dia existir aviso automático de
// vencimento, aí sim entra um agendador, e ele chamará ESTE método.
//
// ── E A GERAÇÃO É IDEMPOTENTE POR ÍNDICE, não por `if` ───────────────────
//
// Cada cobrança gerada leva `recurrence` e `periodo` (o vencimento em ISO), com
// índice ÚNICO sobre o par. Duas abas abertas ao mesmo tempo disputam a mesma
// inserção e o banco recusa a segunda — a checagem antes é economia, não
// garantia. Um `if` sozinho perderia a corrida, e o estrago seria a pessoa
// cobrada duas vezes pelo mesmo mês.
function Recurrence_model(app) {
  this.app = app;
}

Recurrence_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("recurrences");
};

const centavos = (v) => Math.max(0, Math.round(Number(v) || 0));

// O dia puro, como o vencimento de toda cobrança deste sistema: meia-noite UTC.
// Sem isto, uma recorrência cadastrada às 21h em São Paulo começaria no dia
// seguinte.
function dia(valor, padrao = null) {
  const d = recorrencia.diaUTC(valor);
  return d || padrao;
}

// ── O QUE SE PODE GRAVAR ─────────────────────────────────────────────────
//
// Tabela de campo → limpeza, e não um objeto montado inteiro. É a lição que
// `updateCharge` custou caro: montar o documento completo a cada escrita
// transforma um PUT parcial em apagamento silencioso — cinco cobranças reais
// perderam valor e vencimento assim em 17/09/2026.
const CAMPOS = {
  description: (v) => String(v || "").trim().slice(0, 200),
  amount: (v) => centavos(v),
  cadencia: (v) => recorrencia.normalizar(v),
  startsAt: (v) => dia(v, new Date()),
  // `endsAt` VAZIO é "para sempre", e precisa ser gravável: tirar a data de fim
  // de uma recorrência que tinha uma é uma edição legítima. Por isso `null`
  // explícito em vez de "campo ausente".
  endsAt: (v) => (v ? dia(v) : null),
  // ── O ESTADO SUBSTITUIU O `active: true/false` ─────────────────────────
  //
  // O booleano respondia "gera ou não gera" e não tinha onde guardar POR QUE
  // parou. Um combinado que acabou tem história — a pessoa saiu, trocou de
  // plano, pediu pausa —, e uma regra parada sem explicação ao lado vira
  // conversa no WhatsApp meses depois.
  status: (v) => statusDeRecorrencia.normalizar(v),
  // O motivo é livre e OPCIONAL: obrigá-lo faria alguém digitar "." para
  // conseguir salvar, e um campo cheio de "." é pior que um campo vazio.
  canceledReason: (v) => String(v || "").trim().slice(0, 500),
  // ── DE QUAL PLANO ELA NASCEU ────────────────────────────────────────────
  //
  // Só a ORIGEM. O valor, a cadência e o nome vêm COPIADOS do plano na hora de
  // criar, e são estes campos aqui que valem daí em diante.
  //
  // Subir o "Black" de 159 para 179 passa a valer para quem entrar depois; quem
  // já assinou continua pagando o que combinou — que é como funciona em qualquer
  // academia. Reajustar quem está dentro é outra operação, deliberada, e nunca
  // um efeito colateral de editar o cardápio.
  membership: (v) => (ObjectId.isValid(v) ? new ObjectId(v) : null),
  // ── CADA MENSALIDADE NASCE TAMBÉM NO GATEWAY ──────────────────────────
  //
  // *"faltou o checkbox do criar no asaas também"* (19/10/2026).
  //
  // É uma propriedade da REGRA, e não de um clique: a assinatura gera uma
  // cobrança por mês, para sempre, e quem marcou isto uma vez não vai abrir a
  // ficha em todo dia 5 para pedir o boleto. A geração lê este campo e emite
  // a fatura de cada ocorrência nova — ver `gerar`.
  //
  // O que NÃO é: uma assinatura no gateway. Quem conta os meses continua
  // sendo esta regra; lá embaixo nascem faturas avulsas, uma por mês. Assim
  // cancelar aqui para de gerar, sem depender de desfazer nada lá.
  noGateway: (v) => Boolean(v),
  // ── A FORMA COMBINADA ─────────────────────────────────────────────────
  //
  // *"em parcelamento e assinatura, faltaram os métodos de pagamento igual em
  // fatura avulsa"* (19/10/2026). Ela é copiada para cada mensalidade que
  // nascer — ver `gerar` —, e daí decide o `billingType` da fatura.
  //
  // Vazio é "todas", e é o padrão: a fatura abre com pix, boleto e cartão, e
  // quem escolhe é quem paga. O formato é o mesmo que a cobrança cobra — a
  // CHAVE do catálogo, nunca uma frase.
  method: (v) => (/^[a-z0-9][a-z0-9-]{0,29}$/.test(String(v || "")) ? String(v) : ""),
};

Recurrence_model.prototype.insert = async function (studentId, obj, createdBy, currency) {
  const col = await this.collection();

  const doc = {
    student: new ObjectId(studentId),
    currency: currency || null,
    createdBy: createdBy ? new ObjectId(createdBy) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  for (const [campo, limpar] of Object.entries(CAMPOS)) doc[campo] = limpar(obj[campo]);
  carimbarCancelamento(doc, doc.status);

  const r = await col.insertOne(doc);
  return r.insertedId;
};

// QUANDO parou, e não só que parou.
//
// A data é carimbada pelo servidor e não vem do formulário: ela responde "desde
// quando esta pessoa deixou de ser cobrada", e é a única das três informações
// (estado, motivo, data) que ninguém lembraria de preencher à mão.
//
// Reativar LIMPA a data e o motivo. Uma regra ativa com "cancelada em 12/08 —
// mudou de plano" pendurada é a tela contando duas histórias ao mesmo tempo,
// que foi exatamente a confusão do "paga e cancelada" na cobrança.
function carimbarCancelamento(alvo, status) {
  if (status === undefined) return;

  if (statusDeRecorrencia.GERAM.includes(status)) {
    alvo.canceledAt = null;
    alvo.canceledReason = "";
  } else if (!alvo.canceledAt) {
    alvo.canceledAt = new Date();
  }
}

Recurrence_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const mudanca = { updatedAt: new Date() };
  for (const [campo, limpar] of Object.entries(CAMPOS)) {
    if (obj[campo] !== undefined) mudanca[campo] = limpar(obj[campo]);
  }

  // O carimbo só entra quando o ESTADO veio na chamada. Uma edição de valor não
  // pode mexer na data do cancelamento — é a mesma lição do `updateCharge`, que
  // reescrevia o documento inteiro e apagou cinco cobranças de verdade.
  if (mudanca.status !== undefined) {
    const antes = await col.findOne({ _id: new ObjectId(id) }, { projection: { canceledAt: 1 } });
    carimbarCancelamento(
      Object.assign(mudanca, { canceledAt: antes?.canceledAt || null }),
      mudanca.status
    );
  }

  const r = await col.updateOne({ _id: new ObjectId(id) }, { $set: mudanca });
  return r.matchedCount > 0;
};

// ── O VÍNCULO COM O GATEWAY ───────────────────────────────────────────────
//
// *"e salve os ids do nosso lado"* (14/10/2026).
//
// FORA de `CAMPOS` de propósito. Aquela tabela é o que um formulário pode
// gravar; isto não vem de formulário nenhum — vem da resposta do Asaas, e
// deixá-lo ali abriria "mande o id da assinatura de outra pessoa" como edição
// válida de uma recorrência.
//
// `criadoEm` responde a pergunta que se faz meses depois, olhando uma
// assinatura estranha na tela do Asaas: quando foi que isto nasceu, e por qual
// caminho.
Recurrence_model.prototype.marcarNoGateway = async function (id, dados) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    {
      $set: {
        gateway: {
          tipo: String(dados.tipo || ""),
          ambiente: dados.ambiente === "sandbox" ? "sandbox" : "producao",
          cliente: String(dados.cliente || ""),
          assinatura: String(dados.assinatura || ""),
          criadoEm: new Date(),
        },
        updatedAt: new Date(),
      },
    }
  );

  return r.matchedCount > 0;
};

Recurrence_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(id) })) || undefined;
};

Recurrence_model.prototype.listOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return [];
  const col = await this.collection();
  return col.find({ student: new ObjectId(studentId) }).sort({ createdAt: -1 }).toArray();
};

// ── APAGAR A REGRA NÃO APAGA O QUE JÁ FOI COBRADO ────────────────────────
//
// As cobranças geradas ficam. Elas têm pagamento, comprovante e histórico — são
// dinheiro que aconteceu, e a regra que as criou é só a explicação de por que
// nasceram. Apagar o passado junto com o combinado seria apagar o caixa.
//
// Quem quer só parar de gerar não apaga: desativa (`active: false`). O botão de
// apagar existe para o cadastro errado, feito e desfeito no mesmo minuto.
// ── AS RECORRÊNCIAS DE TODO MUNDO ─────────────────────────────────────────
//
// A terceira aba do Financeiro: *"adicione a de recorrência também"*.
//
// Ela responde "o que está combinado para se repetir" — e é a única das três
// que não fala de um FATO. Cobrança é uma dívida que existe; pagamento é
// dinheiro que entrou; recorrência é uma REGRA, que vai criar cobranças no
// futuro.
//
// ── POR QUE ELA NÃO TEM JANELA DE DATAS ────────────────────────────────
//
// As outras duas filtram por período porque cada linha acontece num dia. Uma
// regra não acontece: ela vale enquanto vale. Filtrá-la por "este mês"
// esconderia justamente a mensalidade que roda há dois anos — que é a que mais
// importa ver.
//
// Quem chama é que decide não mandar `de`/`ate`; aqui eles nem existem.
Recurrence_model.prototype.todas = async function ({
  busca,
  status,
  unit,
  pagina,
  limite,
} = {}) {
  const col = await this.collection();
  const instancia = instanceContext.current();

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
        { $project: { name: 1, avatarAt: 1, unit: 1 } },
      ],
      as: "pessoa",
    },
  };

  // ── O PLANO, só pelo NOME ───────────────────────────────────────────────
  //
  // A recorrência nascida de um plano não guarda mais o nome dele (ver
  // `escolherPlano` no formulário): guarda o vínculo. Sem esta junção, toda
  // mensalidade vendida pela vitrine apareceria nesta tabela como um travessão
  // na coluna "O quê".
  //
  // O `instance` entra à mão porque sub-pipeline de `$lookup` não passa pelo
  // escopo automático — a mesma razão da junção com as pessoas, logo acima.
  const juntarPlano = {
    $lookup: {
      from: "memberships",
      let: { plano: "$membership" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$_id", "$$plano"] },
            ...(instancia ? { instance: instancia } : {}),
          },
        },
        { $project: { name: 1 } },
      ],
      as: "plano",
    },
  };

  const derivados = {
    $addFields: {
      studentName: { $ifNull: [{ $arrayElemAt: ["$pessoa.name", 0] }, ""] },
      studentAvatarAt: { $ifNull: [{ $arrayElemAt: ["$pessoa.avatarAt", 0] }, null] },
      studentUnit: { $ifNull: [{ $arrayElemAt: ["$pessoa.unit", 0] }, null] },
      estado: { $ifNull: ["$status", statusDeRecorrencia.PADRAO] },
      // O texto digitado vence; na falta dele, o nome do plano. Calculado AQUI,
      // antes do recorte, e por isso procurar por "Plano Fit" também acha as
      // regras que nunca tiveram descrição nenhuma.
      description: {
        $let: {
          vars: { digitada: { $trim: { input: { $ifNull: ["$description", ""] } } } },
          in: {
            $cond: [
              { $ne: ["$$digitada", ""] },
              "$$digitada",
              { $ifNull: [{ $arrayElemAt: ["$plano.name", 0] }, ""] },
            ],
          },
        },
      },
    },
  };

  const recorte = [];

  const pedidos = String(status || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => statusDeRecorrencia.IDS.includes(x));
  if (pedidos.length) recorte.push({ $match: { estado: { $in: pedidos } } });

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

  const limitePorPagina = Math.min(Math.max(Number(limite) || 25, 1), 200);
  const paginaPedida = Math.max(Number(pagina) || 1, 1);

  const projecao = {
    $project: {
      _id: 0,
      id: { $toString: "$_id" },
      student: { $toString: "$student" },
      studentName: 1,
      studentAvatarAt: 1,
      studentUnit: {
        $cond: [{ $ifNull: ["$studentUnit", false] }, { $toString: "$studentUnit" }, null],
      },
      description: { $ifNull: ["$description", ""] },
      amount: { $ifNull: ["$amount", 0] },
      currency: { $ifNull: ["$currency", null] },
      cadencia: { $ifNull: ["$cadencia", "monthly"] },
      startsAt: 1,
      endsAt: 1,
      status: "$estado",
      canceledReason: { $ifNull: ["$canceledReason", ""] },
      noGateway: { $ifNull: ["$noGateway", false] },
      method: { $ifNull: ["$method", ""] },
    },
  };

  // ── A LENTE DA UNIDADE ──────────────────────────────────────────────────
  //
  // Antes do `$facet`, e não no recorte: o resumo desta aba é "qual é a minha
  // receita recorrente", e com a lente em Niterói ela tem de ser a de
  // Niterói. No recorte, o cartão somava a casa inteira ao lado de uma lista
  // de uma unidade — ver o comentário mais longo em `Finance_model`.
  const lenteDaUnidade = ObjectId.isValid(unit) ? new ObjectId(String(unit)) : null;

  const [saida] = await col
    .aggregate([
      juntarPessoa,
      juntarPlano,
      derivados,
      ...(lenteDaUnidade ? [{ $match: { studentUnit: lenteDaUnidade } }] : []),
      {
        $facet: {
          // O RESUMO é o que está ATIVO: quanto a casa espera receber por
          // ciclo, e de quanta gente. É a pergunta que a aba existe para
          // responder — "qual é a minha receita recorrente".
          //
          // Só as que GERAM entram: uma regra cancelada não é receita, e somá-la
          // faria a previsão crescer a cada cancelamento.
          resumo: [
            { $match: { estado: { $in: statusDeRecorrencia.GERAM } } },
            { $group: { _id: null, previsto: { $sum: "$amount" }, ativas: { $sum: 1 } } },
          ],
          rows: [
            ...recorte,
            { $sort: { studentName: 1, _id: 1 } },
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
    resumo: { previsto: resumo.previsto || 0, ativas: resumo.ativas || 0 },
  };
};

Recurrence_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(id) });
  return r.deletedCount > 0;
};

// ── AS REGRAS ATIVAS DA CONTA, só o id ───────────────────────────────────
//
// É o que a rotina diária publica na fila: uma mensagem por recorrência, com o
// id dela e o da instância.
//
// Projeção mínima de propósito. Quem decide se há o que gerar é o consumidor,
// dentro do contexto do cliente — mandar o documento inteiro na mensagem faria a
// fila carregar uma cópia do valor e do vencimento que podem ter mudado entre
// publicar e consumir.
Recurrence_model.prototype.idsAtivos = async function () {
  const col = await this.collection();
  const docs = await col
    .find({ status: { $in: statusDeRecorrencia.GERAM } }, { projection: { _id: 1 } })
    .toArray();
  return docs.map((d) => String(d._id));
};

Recurrence_model.prototype.deleteAllOfStudent = async function (studentId) {
  if (!ObjectId.isValid(studentId)) return 0;
  const col = await this.collection();
  const r = await col.deleteMany({ student: new ObjectId(studentId) });
  return r.deletedCount;
};

// ── A GERAÇÃO ────────────────────────────────────────────────────────────
//
// `gerar({ student })` para a aba de uma pessoa; `gerar({})` para o Financeiro
// geral, que olha a conta inteira.
//
// Devolve quantas nasceram. Nunca estoura: ela é chamada no caminho de LEITURA
// de duas telas, e uma recorrência com data estranha não pode derrubar o
// financeiro de ninguém. Falha aqui vira linha de log — a próxima leitura tenta
// de novo, porque tudo aqui é idempotente.
// ── A LÁPIDE DE UM PERÍODO ────────────────────────────────────────────────
//
// *"tentei excluir o pagamento que pertence a assinatura, ele falou que apagou
// mas continua"* (17/10/2026).
//
// Apagar a mensalidade de setembro fazia setembro voltar a "faltar", e a
// próxima leitura da tela a criava de novo. Anotar o período aqui é o que faz
// a geração tratá-lo como resolvido — apagar volta a querer dizer apagar.
//
// `$addToSet` e não `$push`: apagar duas vezes a mesma etiqueta (duas abas,
// dois cliques) não pode encher a lista.
Recurrence_model.prototype.naoGerarMais = async function (id, periodo) {
  if (!ObjectId.isValid(id) || !periodo) return false;
  const col = await this.collection();
  const r = await col.updateOne(
    { _id: new ObjectId(id) },
    { $addToSet: { periodosApagados: String(periodo) }, $set: { updatedAt: new Date() } }
  );
  return r.modifiedCount > 0;
};

// A FATURA DE UMA MENSALIDADE RECÉM-NASCIDA.
//
// Separada da geração porque ela é a parte que fala com o mundo lá fora: uma
// chamada de rede por ocorrência, que pode demorar e pode recusar. Engolir o
// erro aqui é deliberado — quem chama está no meio de um laço que não pode
// parar por causa de uma, e o estrago de uma fatura que não saiu é
// recuperável pelo menu da linha; o de uma mensalidade que não nasceu, não.
Recurrence_model.prototype.emitirFatura = async function (regra, chargeId) {
  try {
    const student = await this.app.api.user.data(String(regra.student));
    if (!student) return false;

    const cobranca = await this.app.api.finance.chargeData(String(chargeId));
    if (!cobranca) return false;

    const { emitirAvulsa } = require("../lib/faturaNoGateway.js");
    const feito = await emitirAvulsa(this.app, student, cobranca);
    if (!feito.ok) {
      console.warn("[recorrencia] a fatura da mensalidade não saiu: " + (feito.erro || "?"));
      return false;
    }

    await this.app.api.finance.marcarNoGateway(String(chargeId), {
      pagamento: feito.id,
      url: feito.link,
      situacao: feito.situacao,
    });
    return true;
  } catch (erro) {
    console.error("[recorrencia] falha ao emitir a fatura:", erro?.message || erro);
    return false;
  }
};

Recurrence_model.prototype.gerar = async function ({
  student = null,
  // UMA regra só — é por onde o consumidor da fila entra. A mensagem carrega o
  // id da recorrência, e ele gera exatamente a dela.
  //
  // Repare que o consumidor NÃO decide nada: ele chama a mesma função que a
  // leitura da tela chama, com um filtro a mais. Um segundo caminho que
  // decidisse por conta própria divergiria do primeiro na primeira regra nova —
  // e divergiria calado, porque ninguém compara o que a fila gerou com o que a
  // tela geraria.
  recurrence = null,
  hoje = new Date(),
} = {}) {
  try {
    const col = await this.collection();

    // Pergunta ao CATÁLOGO, e não a um `!== "canceled"` escrito aqui: o dia em
    // que "pausada" entrar, ela para de gerar sem ninguém procurar os lugares.
    const filtro = { status: { $in: statusDeRecorrencia.GERAM } };
    if (student) {
      if (!ObjectId.isValid(student)) return 0;
      filtro.student = new ObjectId(student);
    }
    if (recurrence) {
      if (!ObjectId.isValid(recurrence)) return 0;
      filtro._id = new ObjectId(recurrence);
    }

    const regras = await col.find(filtro).toArray();
    if (!regras.length) return 0;

    const cobrancas = await this.app.api.finance.charges();

    // O QUE JÁ EXISTE, numa consulta só — e não uma por regra. Dez recorrências
    // numa conta fariam dez idas ao banco em toda abertura da tela do dinheiro.
    const geradas = await cobrancas
      .find(
        { recurrence: { $in: regras.map((r) => r._id) } },
        { projection: { recurrence: 1, periodo: 1 } }
      )
      .toArray();

    const porRegra = new Map();
    for (const c of geradas) {
      const chave = String(c.recurrence);
      if (!porRegra.has(chave)) porRegra.set(chave, new Set());
      porRegra.get(chave).add(String(c.periodo || ""));
    }

    // ── QUEM NOMEIA A COBRANÇA QUANDO A REGRA NÃO TEM NOME ────────────────
    //
    // O PLANO, pelo vínculo. Desde 15/10/2026 a recorrência criada a partir de
    // um plano nasce com a descrição vazia — *"descrição deveria ficar em
    // branco"* —, e sem isto a mensalidade apareceria no extrato como uma linha
    // sem assunto nenhum.
    //
    // O nome entra COPIADO na cobrança, e aqui isso é o certo: a cobrança é um
    // fato de um mês, e ela tem de continuar dizendo o que foi cobrado mesmo
    // depois de o plano ser renomeado ou apagado. A regra é que fica viva e
    // aponta para o plano; a cobrança é história.
    //
    // Uma consulta só, e só para as regras que precisam.
    const nomeDoPlano = new Map();
    const semNome = regras.filter((r) => !String(r.description || "").trim() && r.membership);
    if (semNome.length) {
      const planos = await (await this.app.api.membership.collection())
        .find({ _id: { $in: semNome.map((r) => r.membership) } }, { projection: { name: 1 } })
        .toArray();
      for (const p of planos) nomeDoPlano.set(String(p._id), String(p.name || ""));
    }

    let criadas = 0;

    for (const regra of regras) {
      // Valor zero não vira cobrança: seria uma linha de R$ 0,00 por mês, para
      // sempre, num cadastro que alguém deixou pela metade.
      if (!regra.amount) continue;

      // O QUE JÁ EXISTE **mais** o que foi apagado de propósito. Para a
      // geração os dois são a mesma coisa: período resolvido, não refazer.
      // Ver `naoGerarMais`.
      const resolvidos = new Set(porRegra.get(String(regra._id)) || []);
      for (const etiqueta of regra.periodosApagados || []) resolvidos.add(String(etiqueta));

      const faltando = recorrencia.pendentes({
        inicio: regra.startsAt,
        fim: regra.endsAt,
        cadencia: regra.cadencia,
        hoje,
        jaGeradas: resolvidos,
      });

      for (const ocorrencia of faltando) {
        try {
          const nascida = await cobrancas.insertOne({
            student: regra.student,
            currency: regra.currency || null,
            createdBy: regra.createdBy || null,
            appointment: null,
            service: null,
            aulao: null,
            // O VÍNCULO e a ETIQUETA: é o par que o índice único protege.
            recurrence: regra._id,
            periodo: ocorrencia.etiqueta,
            amount: regra.amount,
            dueDate: ocorrencia.data,
            description:
              String(regra.description || "").trim() ||
              nomeDoPlano.get(String(regra.membership)) ||
              "",
            // COPIADA, como o valor e a descrição: a cobrança é um fato do
            // mês, e trocar a forma na regra em março não pode reescrever o
            // que já foi combinado em janeiro.
            method: regra.method || "",
            status: "open",
            note: "",
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          criadas++;

          // ── E A FATURA DELA, QUANDO A REGRA PEDE ────────────────────
          //
          // *"faltou o checkbox do criar no asaas também"* (19/10/2026). A
          // mensalidade que nasce aqui é a mesma que o aluno precisa receber
          // para pagar — sem a fatura, alguém teria de abrir a ficha todo mês
          // e clicar "gerar", que é exatamente o trabalho que a assinatura
          // existe para não dar.
          //
          // DEPOIS do `criadas++`, e sem poder derrubar nada: a cobrança daqui
          // já existe e é o fato contábil. Gateway fora do ar não pode fazer a
          // mensalidade de outubro deixar de ser criada — ela ficaria sem
          // registro E sem boleto. Falhando, fica a cobrança, e o link se gera
          // pelo menu da linha.
          //
          // Com try PRÓPRIO, e não encostado no de fora: aquele relança o que
          // não é 11000, e um erro vindo da rede derrubaria o laço inteiro —
          // a mensalidade de novembro deixaria de nascer porque a de outubro
          // não conseguiu boleto.
          if (regra.noGateway) {
            try {
              await this.emitirFatura(regra, nascida.insertedId);
            } catch (falha) {
              console.error("[recorrencia] fatura da mensalidade:", falha?.message || falha);
            }
          }
        } catch (erro) {
          // 11000 é o índice único fazendo o trabalho dele: outra requisição
          // criou esta mesma mensalidade entre a nossa leitura e a nossa
          // escrita. Não é erro — é a corrida sendo resolvida do jeito certo.
          if (erro?.code !== 11000) throw erro;
        }
      }
    }

    return criadas;
  } catch (erro) {
    console.error("[recorrencia] geração falhou:", erro?.message || erro);
    return 0;
  }
};

module.exports = Recurrence_model;
