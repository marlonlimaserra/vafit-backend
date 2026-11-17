const arquivos = require("../lib/arquivos.js");
const statusDeCobranca = require("../lib/statusDeCobranca.js");
const statusDePagamento = require("../lib/statusDePagamento.js");
const recorrencia = require("../lib/recorrencia.js");
const statusDeRecorrencia = require("../lib/statusDeRecorrencia.js");
const situacaoNoGateway = require("../lib/situacaoNoGateway.js");
const { documentoFinanceiro } = require("../lib/documentoFinanceiro.js");
const { registrarRotasDeDocumento } = require("../lib/rotasDeDocumento.js");
const { logoDaCasa } = require("../lib/logoDaCasa.js");
const lenteDeUnidade = require("../lib/lenteDeUnidade.js");
const { chargeLink } = require("../lib/emailTemplates.js");
const { enderecoDaInstancia } = require("../lib/enderecoDaInstancia.js");
const { dinheiro } = require("../lib/documentoBase.js");
const clientIp = require("../lib/clientIp.js");
const cartaoDoAluno = require("../lib/cartaoDoAluno.js");
// O fuso da conta, sem poder derrubar quem o pediu.
//
// A janela do mês é melhor COM ele; o relatório é obrigatório SEM ele. É a mesma
// hierarquia do `vestirComAConta`: o menos importante não pode custar o mais
// importante.
async function fusoDaConta(app) {
  try {
    return await app.api.tenant.timezoneOfInstance();
  } catch (erro) {
    return undefined;
  }
}

module.exports = function (app) {
  // O financeiro de cada pessoa.
  //
  // Cobranças e pagamentos são rotas separadas porque são coisas separadas: uma
  // é o que a pessoa deve, a outra é o que ela pagou. Juntá-las num lançamento
  // só impediria o pagamento parcial e o pagamento adiantado, que são os dois
  // casos que mais aparecem.

  async function pessoaDoProfissional(req, res, trainer) {
    const student = await app.api.user.dataStudent(trainer._id, req.params.personId);
    if (!student) {
      res.status(404).send({ msg: req.t("errors.personNotFound") });
      return false;
    }
    return student;
  }

  // Tudo do financeiro de uma pessoa numa resposta só.
  //
  // A tela mostra as três coisas juntas — o que deve, o que pagou e o saldo —
  // e três chamadas para desenhar uma aba fariam a tela piscar em três tempos.
  // ── O FINANCEIRO DE TODO MUNDO ──────────────────────────────────────────
  //
  // Tudo aqui era por pessoa, e isso responde à ficha de um aluno — não à
  // pergunta do fim do mês: "quanto tenho a receber?", "quem está atrasado?".
  // Com 217 pessoas, a resposta exigia abrir 217 fichas: o dado existia e era
  // inalcançável.
  //
  // ── OS NOMES VÊM JUNTO ────────────────────────────────────────────────
  //
  // A cobrança guarda o id da pessoa, e uma lista de ids não é um relatório.
  // Resolvidos numa consulta só — uma por linha seriam trezentas idas ao banco
  // para desenhar uma tela.
  app.get("/finance", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    // ── A MENSALIDADE NASCE AQUI, ANTES DE LER ──────────────────────────
    //
    // Não há agendador neste servidor, e montar um custaria eleição de líder
    // entre os workers e varredura de todas as instâncias fora do contexto que
    // garante o isolamento. A geração roda DENTRO da requisição, já escopada no
    // cliente certo — e esta é a tela que existe justamente para olhar o que há
    // a receber, então é aqui que a cobrança do mês precisa estar.
    //
    // Antes de `carteira`, e não depois: gerar depois faria a mensalidade
    // aparecer só na SEGUNDA vez que alguém abrisse a tela.
    //
    // `gerar` nunca estoura — ver o modelo. Uma recorrência com data estranha
    // não pode derrubar o relatório do mês.
    await app.api.recurrence.gerar({});

    const { rows, total, pagina, limite, resumo } = await app.api.finance.carteira({
      de: req.query.de,
      ate: req.query.ate,
      status: req.query.status,
      // ── A BUSCA E A ORDEM PASSARAM PARA O BANCO ───────────────────────
      //
      // Os dois moravam aqui: a busca era um `filter` em JavaScript sobre a
      // lista inteira e a ordenação acontecia no navegador. Os dois só funcionam
      // enquanto a lista inteira vem — e ela parou de vir.
      //
      // Buscar na página acharia "Ana" entre as vinte e cinco carregadas e diria
      // que não existe mais nenhuma; ordenar a página daria a ordem das vinte e
      // cinco, e não as vinte e cinco primeiras de trezentas.
      busca: req.query.q,
      // A LENTE DA UNIDADE, escolhida no alto da tela. Ela vale para os
      // cartões do topo também — números que não batem com a lista do lado
      // são piores que números ausentes.
      ...lenteDeUnidade.recorte(user, req.query.unit),
      // As marcadas na tela, para a folha impressa delas.
      ids: req.query.ids,
      ordem: req.query.sort,
      direcao: req.query.dir,
      pagina: req.query.page,
      limite: req.query.limit,
      // O FUSO DA CONTA, para a janela do mês bater com o calendário de quem
      // olha. Sem ele o fim do dia 30 seria 23:59 UTC — 20:59 em São Paulo —, e
      // a cobrança da noite do último dia ficaria fora do próprio mês.
      //
      // Num `try`, e o relatório sai de todo jeito: uma leitura de configuração
      // que falha não pode derrubar a tela que mostra o dinheiro do mês. Sem
      // fuso, `carteira` cai no padrão — que é o de quase toda conta deste
      // produto, e erra no máximo por três horas no último dia.
      fuso: await fusoDaConta(app),
      // ── UMA LISTA SÓ ──────────────────────────────────────────────────
      //
      // *"até hoje acho isso confuso... deixe só pagamento no sistema
      // inteiro"* (17/10/2026). As abas Cobranças e Pagamentos eram dois
      // substantivos para a mesma pergunta, e o mesmo rótulo "Pagamentos"
      // queria dizer coisas diferentes aqui e na ficha da pessoa.
      //
      // Agora é uma lista com filtro, e o avulso é uma linha dela: um
      // pagamento que nasceu pago, sem vencimento e sem falta.
      comAvulsos: true,
    });

    // As moedas da conta vão junto: os lançamentos antigos não têm a sua
    // gravada, e é a padrão que os interpreta.
    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      // O nome e o contato já vêm da junção do banco — eram resolvidos aqui
      // numa segunda consulta, o que deixou de fazer sentido quando a busca
      // por nome precisou acontecer ANTES do corte da página.
      rows,
      // O RESUMO é de TODA a janela, não da página nem do recorte — ver o
      // modelo. É a resposta a *"cada vez que eu troco de aba, os valores ali em
      // cima mudam"*.
      resumo,
      // Quantas linhas o recorte tem, para a tela saber quantas páginas existem.
      // Sem isto ela só saberia que a página veio cheia, que não é o mesmo.
      total,
      pagina,
      limite,
      currency: moedas.currency,
      currencies: moedas.currencies,
      status: statusDeCobranca.paraTela(req.t),
      // Os estados de um PAGAMENTO, pelo mesmo caminho: a lista vivia em dois
      // lugares — aqui e no formulário — e o segundo era o que se esqueceria.
      paymentStatus: statusDePagamento.paraTela(req.t),
    });
  });

  // ── O QUE ENTROU, de todo mundo ─────────────────────────────────────────
  //
  // *"eu cadastrei esse pagamento, mas não aparece aqui em financeiro"*.
  //
  // A rota de cima lista COBRANÇAS, e o pagamento dele era avulso — sem
  // cobrança do outro lado. Um pagamento avulso não tem como virar linha numa
  // lista de cobranças: ele não estava filtrado, ele não tinha onde aparecer.
  //
  // São duas perguntas diferentes e por isso são duas rotas: `/finance` é "o
  // que me devem", esta é "o que entrou". A janela desta é a DATA DO
  // PAGAMENTO — não o vencimento de coisa nenhuma.
  //
  // Sem `recurrence.gerar` aqui: gerar mensalidade é coisa de quem vai olhar o
  // que há a receber. Quem abre o caixa está olhando para trás.
  app.get("/finance/payments", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const { rows, total, pagina, limite, resumo } = await app.api.finance.recebimentos({
      de: req.query.de,
      ate: req.query.ate,
      // Os ESTADOS do pagamento — pago, pendente, reembolsado, cancelado. São
      // outros que os da cobrança, e é por isso que a aba tem filtro próprio.
      status: req.query.status,
      busca: req.query.q,
      ...lenteDeUnidade.recorte(user, req.query.unit),
      ordem: req.query.sort,
      direcao: req.query.dir,
      pagina: req.query.page,
      limite: req.query.limit,
      fuso: await fusoDaConta(app),
    });

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows,
      resumo,
      total,
      pagina,
      limite,
      currency: moedas.currency,
      currencies: moedas.currencies,
      // As FORMAS da conta, para a tela escrever "Pix" e não "pix". O nome é
      // do cliente quando ele o escreveu; vazio cai na tradução, que é o que a
      // tela já faz nas outras listas.
      methods: await app.api.paymentMethod.list(),
      paymentStatus: statusDePagamento.paraTela(req.t),
    });
  });

  // ── OS PARCELAMENTOS DE TODO MUNDO ──────────────────────────────────────
  //
  // *"crie a aba parcelamento pois o asaas pode criar parcelamento também"*
  // (17/10/2026).
  //
  // Um parcelamento não tem coleção: ele É o conjunto de cobranças que
  // compartilham um `installment`. A lista sai de agregá-las — ver o modelo.
  //
  // Sem janela de datas, como a de assinaturas: um carnê não acontece num
  // mês, ele atravessa vários. Filtrar por mês mostraria pedaços dele.
  app.get("/finance/installments", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const { rows, total, resumo } = await app.api.finance.parcelamentos(
      lenteDeUnidade.recorte(user, req.query.unit)
    );

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows,
      resumo,
      total,
      currency: moedas.currency,
      currencies: moedas.currencies,
    });
  });

  // ── AS RECORRÊNCIAS DE TODO MUNDO ───────────────────────────────────────
  //
  // A terceira aba. Ela é a única que não fala de um FATO: cobrança é dívida
  // que existe, pagamento é dinheiro que entrou, recorrência é uma REGRA que
  // vai criar cobranças no futuro.
  //
  // Sem janela de datas, e é de propósito — ver o modelo: uma regra não
  // acontece num dia, ela vale enquanto vale.
  app.get("/finance/recurrences", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const { rows, total, pagina, limite, resumo } = await app.api.recurrence.todas({
      busca: req.query.q,
      status: req.query.status,
      ...lenteDeUnidade.recorte(user, req.query.unit),
      pagina: req.query.page,
      limite: req.query.limit,
    });

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows,
      resumo,
      total,
      pagina,
      limite,
      currency: moedas.currency,
      currencies: moedas.currencies,
      recurrenceStatus: statusDeRecorrencia.paraTela(req.t),
      // As CADÊNCIAS já traduzidas: "monthly" não é o que se mostra a ninguém.
      cadencias: recorrencia.paraTela(req.t),
    });
  });

  app.get("/people/:personId/finance", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    // A mensalidade desta pessoa, antes de ler o que ela deve. Mesma razão da
    // carteira: sem agendador, quem materializa a cobrança é quem vem olhar.
    await app.api.recurrence.gerar({ student: student._id });

    // As moedas da conta vão junto: os lançamentos antigos não têm a sua
    // gravada, e é a padrão que os interpreta.
    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      currency: moedas.currency,
      currencies: moedas.currencies,
      charges: await app.api.finance.listCharges(student._id),
      // As REGRAS de recorrência, para a aba "Mensalidade". Vêm junto pelo mesmo
      // motivo do resto: a aba é da mesma tela, e uma chamada a mais faria a
      // ficha piscar em dois tempos.
      recurrences: await app.api.recurrence.listOfStudent(student._id),
      // O CATÁLOGO DE CADÊNCIAS, para o seletor não conhecer nenhuma delas.
      // Mesma escolha dos status: acrescentar "quadrimestral" é uma linha em
      // `lib/recorrencia.js`, e a tela ganha a opção sem mudar de linha.
      cadencias: recorrencia.paraTela(req.t),
      // Os ESTADOS de uma recorrência, pelo mesmo caminho das cadências e dos
      // status de cobrança: a tela desenha o seletor sem conhecer nenhum deles.
      recurrenceStatus: statusDeRecorrencia.paraTela(req.t),
      // E o que está acontecendo com a cobrança LÁ NO GATEWAY: autorizada,
      // em análise, recusada, estornando. Catálogo pelo mesmo caminho dos
      // outros — a tela pinta o que o servidor nomeia.
      gatewayStates: situacaoNoGateway.paraTela(req.t),
      // E os estados da COBRANÇA, para o seletor do formulário. Vêm com
      // `escolhivel` — "paga" está na lista para ser LIDA, nunca marcada à
      // mão: paga é consequência dos pagamentos cobrirem o valor.
      chargeStatus: statusDeCobranca.paraTela(req.t),
      paymentStatus: statusDePagamento.paraTela(req.t),
      payments: await app.api.finance.listPayments(student._id),
      // OS PARCELAMENTOS desta pessoa, para a aba. Vêm junto pelo mesmo
      // motivo do resto: é a mesma tela, e uma chamada a mais faria a ficha
      // piscar em dois tempos.
      installments: (await app.api.finance.parcelamentos({ personId: String(student._id) })).rows,
      // O NOME do gateway ativo para a unidade desta pessoa, quando há um. É
      // o que decide se a caixa "gerar o carnê no {{nome}}" existe — e a tela
      // nunca escreve "Asaas" por conta própria; ela repete o que o servidor
      // nomeia. Ver `lib/gateways/LEIA-ME.md`.
      gateway: await oGatewayDa(student),
      // ── ELA TEM CARTÃO GUARDADO? ────────────────────────────────────
      //
      // Só o SIM/NÃO, e é o bastante: é ele que decide se o menu da linha
      // oferece "cobrar no cartão". Mandar a lista aqui seria passear com os
      // cartões dela por uma resposta que fala de cobranças — e a aba
      // Cartão de crédito já os busca quando é aberta.
      temCartao: (await app.api.cartaoSalvo.lista(student._id)).length > 0,
      // Um saldo POR MOEDA: somar moedas diferentes daria um total que não
      // existe.
      balance: await app.api.finance.balanceOf(student._id, moedas.currency),
      paidByCharge: await app.api.finance.paidByCharge(student._id),
    });
  });

  // ── Recorrências: a mensalidade, a anuidade, o pacote trimestral ────────
  //
  // Quatro rotas e nenhuma delas gera nada: a geração mora na LEITURA do
  // financeiro (ver o modelo, e o comentário nas duas rotas acima). Aqui só se
  // cadastra a REGRA.
  //
  // ── TRÊS CHAVES, E NENHUMA DELAS É `finance.manage` ─────────────────────
  //
  // *"crie uma permissão que permite alterar o valor ou não ao criar
  // recorrência, e também permissão de criar recorrência ou deletar"*
  // (15/10/2026).
  //
  // Criar uma recorrência é assinar por quem paga: ela gera cobrança todo mês,
  // para sempre, sem ninguém olhar de novo. Dar baixa num recibo não é o mesmo
  // poder, e até hoje a chave era a mesma.
  //
  // Quem já tinha `finance.manage` herdou as três no primeiro boot depois do
  // deploy — ver `liberarRecorrenciaParaQuemJaPodia` em `Role_model`. Uma
  // chave nova nunca pode revogar em silêncio.

  // ── O VALOR É DE QUEM PODE DAR DESCONTO ─────────────────────────────────
  //
  // Sem `finance.recurrenceAmount`, o número que veio no formulário é
  // DESCARTADO. No cadastro vale o preço do plano; na edição vale o que já
  // estava, e trocar de plano reprecifica pelo novo.
  //
  // Isso tem de morar aqui, e não só na tela: um campo desabilitado é uma
  // sugestão: o navegador manda o que o F12 mandar. A recepção matricula no
  // cardápio; o desconto é de quem manda no preço.
  async function valorPermitido(req, res, trainer, body, antes = null) {
    if (app.helpers.ReqProtected.has(trainer, "finance.recurrenceAmount")) {
      return Number(body.amount);
    }

    const pedido = String(body.membership || "");
    const mesmoPlano = antes && pedido && String(antes.membership || "") === pedido;
    if (antes && (!pedido || mesmoPlano)) return antes.amount;

    const plano = pedido ? await app.api.membership.data(pedido) : null;
    if (!plano) {
      res.status(403).send({
        msg: req.t("errors.recurrenceAmountLocked"),
        permission: "finance.recurrenceAmount",
      });
      return false;
    }

    return plano.amount;
  }

  app.get("/people/:personId/recurrences", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    res.send({
      rows: await app.api.recurrence.listOfStudent(student._id),
      cadencias: recorrencia.paraTela(req.t),
      // Os ESTADOS de uma recorrência, pelo mesmo caminho das cadências e dos
      // status de cobrança: a tela desenha o seletor sem conhecer nenhum deles.
      recurrenceStatus: statusDeRecorrencia.paraTela(req.t),
    });
  });

  app.post("/people/:personId/recurrences", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.recurrence");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};
    const amount = await valorPermitido(req, res, trainer, body);
    if (amount === false) return;
    if (!Number(amount)) {
      return res.status(400).send({ msg: req.t("errors.requireAmount") });
    }

    const moeda = await app.api.tenant.currencyFor(body.currency);
    const id = await app.api.recurrence.insert(student._id, { ...body, amount }, trainer._id, moeda);

    // GERA JÁ, e isto é o que faz o cadastro parecer que funcionou.
    //
    // Sem esta linha, quem cadastra "todo mês desde julho" salva o formulário e
    // volta para uma aba de cobranças exatamente igual à de antes — a primeira
    // mensalidade só apareceria na próxima abertura da tela. A mesma chamada da
    // leitura, aqui, na escrita que a motivou.
    await app.api.recurrence.gerar({ student: student._id });

    app.insertUserActionHistory(req, trainer, "create_recurrence", {
      category: "finance",
      local: { target_type: "recurrences", target_id: id + "", person: student._id },
      extra: { person: student.name, personId: student._id + "", amount: Number(amount) },
    });

    res.status(201).send(await app.api.recurrence.data(id));
  });

  app.put("/recurrences/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.recurrence");
    if (trainer === false) return;

    const antes = await app.api.recurrence.data(req.params.id);
    if (!antes) return res.status(404).send({ msg: req.t("errors.recurrenceNotFound") });

    const body = req.body || {};
    // Só quando o formulário MANDOU valor: um PUT parcial que não fala de
    // dinheiro não pode carimbar um — é a lição do `updateCharge`.
    if (body.amount !== undefined) {
      const amount = await valorPermitido(req, res, trainer, body, antes);
      if (amount === false) return;
      body.amount = amount;
    }

    // ── CANCELAR A ASSINATURA ENCERRA O QUE AINDA NÃO VENCEU ────────
    //
    // *"se cancelar, cancela no asaas?"* (19/10/2026). Não cancelava: a regra
    // parava de gerar e a mensalidade do mês seguinte — que a geração cria
    // com 15 dias de antecedência — continuava de pé, com boleto vivo. A
    // pessoa cancelava e recebia cobrança assim mesmo.
    //
    // SÓ as que ainda não venceram, e só as que não receberam nada. O mês que
    // já passou e não foi pago é DÍVIDA: cancelar a assinatura não a perdoa, e
    // sumir com ela do "a receber" esconderia dinheiro que a casa tem a
    // receber. O mês pago, muito menos.
    //
    // Se o gateway recusar uma, ela fica como está e o laço segue. A recusa
    // de uma fatura que não venceu quer dizer, na prática, que ela ACABOU de
    // ser paga — e aí não cancelá-la é o certo, não o contrário.
    const parou =
      body.status !== undefined &&
      !statusDeRecorrencia.GERAM.includes(statusDeRecorrencia.normalizar(body.status)) &&
      statusDeRecorrencia.GERAM.includes(statusDeRecorrencia.normalizar(antes.status));

    let encerradas = 0;
    if (parou) encerradas = await encerrarMensalidadesFuturas(req.params.id, antes.student);

    await app.api.recurrence.update(req.params.id, body);
    // Editar pode ABRIR ocorrências novas — mudar o início para trás, tirar a
    // data de fim, reativar. Gerar aqui é o mesmo cuidado do cadastro.
    await app.api.recurrence.gerar({ student: antes.student });

    app.insertUserActionHistory(req, trainer, "update_recurrence", {
      category: "finance",
      local: { target_type: "recurrences", target_id: String(req.params.id) },
    });

    const depois = await app.api.recurrence.data(req.params.id);
    res.send(encerradas ? { ...depois, encerradas } : depois);
  });

  // Fecha as mensalidades desta regra que ainda não venceram: apaga a fatura
  // de cada uma no gateway e cancela a cobrança aqui. Devolve quantas.
  async function encerrarMensalidadesFuturas(regraId, studentId) {
    const futuras = await app.api.finance.futurasDaRecorrencia(regraId);
    if (!futuras.length) return 0;

    // Uma mensalidade adiantada tem dinheiro dentro. Ela não é futura para
    // efeito de cancelar: é um recebimento que precisa continuar explicado.
    const pagos = await app.api.finance.paidByCharge(studentId);

    let quantas = 0;
    for (const cobranca of futuras) {
      if ((pagos[String(cobranca._id)] || 0) > 0) continue;

      if (cobranca.gateway?.pagamento) {
        const feito = await apagarFaturaDe(cobranca);
        if (!feito.ok) continue;
        await app.api.finance.limparNoGateway(String(cobranca._id));
      }

      await app.api.finance.updateCharge(String(cobranca._id), { status: "canceled" });
      quantas++;
    }

    return quantas;
  }

  app.delete("/recurrences/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.recurrenceDelete");
    if (trainer === false) return;

    const alvo = await app.api.recurrence.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.recurrenceNotFound") });

    // As cobranças JÁ GERADAS ficam — elas têm pagamento e histórico. Ver o
    // modelo: apagar o combinado não pode apagar o caixa.
    await app.api.recurrence.remove(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_recurrence", {
      category: "finance",
      local: { target_type: "recurrences", target_id: String(req.params.id) },
    });

    res.send({ msg: req.t("ok.recurrenceRemoved") });
  });

  // ── Cobranças ───────────────────────────────────────────────────────────

  app.post("/people/:personId/charges", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};
    // A moeda escolhida no formulário, se estiver habilitada; senão a padrão.
    const moeda = await app.api.tenant.currencyFor(body.currency);
    const id = await app.api.finance.insertCharge(student._id, body, trainer._id, moeda);
    let criada = await app.api.finance.chargeData(id);

    // ── E NO GATEWAY, SE PEDIREM ──────────────────────────────────────
    //
    // *"não deveria ter o checkbox de 'gera no gateway'? e aí já gera lá,
    // traz o link, traz tudo"* (18/10/2026). Mesma regra do carnê: a
    // cobrança daqui já existe, e o gateway é o que faz a pessoa RECEBER o
    // link. Se ele recusar, ela continua de pé e o motivo sobe junto —
    // apagar o que acabou de ser digitado porque o Asaas estava fora do ar
    // seria perder o trabalho de quem lançou.
    let gatewayErro = "";
    if (body.noGateway) {
      const feito = await cobrarNoGateway(student, criada);
      if (feito.ok) {
        await app.api.finance.marcarNoGateway(id, { pagamento: feito.id, url: feito.link });
        criada = await app.api.finance.chargeData(id);
      } else {
        gatewayErro = feito.erro || "fora_do_ar";
      }
    }

    app.insertUserActionHistory(req, trainer, "create_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: id + "", person: student._id },
      extra: { person: student.name, personId: student._id + "", amount: criada?.amount },
    });

    // `gatewayErro` fora do documento, e só quando houve: ele não é um campo
    // da cobrança — é o que aconteceu nesta chamada. Gravá-lo faria uma
    // recusa de hoje descrever a cobrança para sempre.
    res.status(201).send(gatewayErro ? { ...criada, gatewayErro } : criada);
  });

  // ── GERAR NO GATEWAY UMA COBRANÇA QUE JÁ EXISTE ──────────────────────
  //
  // *"deveria aparecer opções de ver o link da cobrança, se for cartão, poder
  // cobrar o cartão etc."* (18/10/2026).
  //
  // Duas coisas pela mesma porta, porque para o gateway são a mesma: abrir a
  // fatura (pix, boleto, cartão — quem escolhe é quem paga) ou debitar o
  // CARTÃO GUARDADO da pessoa. O que muda é uma linha no corpo que vai para
  // lá, e separar em duas rotas duplicaria a conferência inteira.
  //
  // `finance.manage`, a mesma de criar: isto É criar a cobrança lá fora.
  app.post("/charges/:id/gateway", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const cobranca = await app.api.finance.chargeData(req.params.id);
    if (!cobranca) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    // O VÍNCULO, como em toda rota de cobrança: quem não acompanha a pessoa
    // não mexe no dinheiro dela.
    const student = await app.api.user.dataStudent(trainer._id, String(cobranca.student));
    if (!student) return res.status(404).send({ msg: req.t("errors.personNotFound") });

    // ── O QUE NÃO SE GERA DUAS VEZES ────────────────────────────────────
    //
    // Cobrança que já tem fatura lá: gerar de novo abriria uma SEGUNDA
    // cobrança do mesmo dinheiro, e o aluno receberia dois boletos. Para
    // trocar a forma é preciso cancelar a de lá primeiro — o que esta rota
    // não faz de propósito.
    if (cobranca.gateway?.pagamento) {
      return res.status(409).send({ msg: req.t("errors.chargeAlreadyAtGateway") });
    }

    // Cancelada ou já quitada aqui: não há o que cobrar.
    const pagos = await app.api.finance.paidByCharge(cobranca.student);
    const falta = Math.max(0, (cobranca.amount || 0) - (pagos[String(cobranca._id)] || 0));
    if (cobranca.status === "canceled" || falta <= 0) {
      return res.status(409).send({ msg: req.t("errors.chargeNotOpen") });
    }

    // ── TRÊS JEITOS DE COBRAR, UMA ROTA SÓ ──────────────────────────────
    //
    // *"se for cartão ou qualquer forma, mostre um botão cobrar; aí aparece
    // para escolher o cartão de crédito, pagar, ou colocar os dados do cartão
    // na hora"* (19/10/2026).
    //
    //   nada          → abre a fatura (pix, boleto, cartão — quem escolhe é
    //                   quem paga)
    //   cartao        → debita um cartão GUARDADO (`true` é o principal; um
    //                   id escolhe qual)
    //   cartaoNovo    → tokeniza o cartão digitado agora e debita nele
    //
    // Uma rota só porque para o gateway as três são a mesma coisa: criar uma
    // cobrança. O que muda é uma linha no corpo que vai para lá, e três
    // rotas duplicariam a conferência inteira — o vínculo, a fatura que já
    // existe, a cobrança cancelada.
    const corpo = req.body || {};
    const feito = await cobrarNoGateway(student, cobranca, {
      cartao: corpo.cartao === true ? true : String(corpo.cartao || ""),
      cartaoNovo: corpo.cartaoNovo || null,
      salvar: Boolean(corpo.salvar),
      // O IP de quem está digitando, e não o do servidor: é o que vai para a
      // análise de risco do gateway.
      ip: clientIp(req),
      porQuem: trainer._id,
    });
    if (!feito.ok) {
      // ── A RECUSA DIZ QUAL DAS COISAS FALTOU ───────────────────────────
      //
      // Quando o tropeço é DO CARTÃO (CPF torto, titular incompleto, a
      // operadora recusando), a frase é a mesma da aba Cartão de crédito —
      // ela diz o que fazer. "Não foi possível gerar a cobrança" mandaria
      // procurar no escuro, e quem está no balcão com o cliente na frente
      // não tem onde procurar.
      const doCartao = cartaoDoAluno.ERROS[feito.erro];
      if (doCartao && (corpo.cartaoNovo || corpo.cartao)) {
        const { status, corpo: resposta } = cartaoDoAluno.recusaDe(req.t, feito.erro, feito.detalhe);
        return res.status(status).send(resposta);
      }
      return res.status(400).send({ msg: req.t("errors.chargeGateway"), erro: feito.erro });
    }

    await app.api.finance.marcarNoGateway(cobranca._id, { pagamento: feito.id, url: feito.link });

    app.insertUserActionHistory(req, trainer, "charge_at_gateway", {
      category: "finance",
      local: { target_type: "charges", target_id: String(cobranca._id), person: student._id },
      extra: { person: student.name, personId: student._id + "", amount: cobranca.amount },
    });

    res.send({
      ok: true,
      link: feito.link || "",
      // Se foi no CARTÃO, quem pergunta é a tela: a frase que ela mostra é
      // outra ("cobrado no cartão" não é "link gerado"), e o dinheiro ainda
      // depende do webhook para virar pagamento aqui.
      noCartao: Boolean(feito.noCartao),
      charge: await app.api.finance.chargeData(cobranca._id),
    });
  });

  // ── ESTORNAR A FATURA ────────────────────────────────────────────────
  //
  // *"quando for cartão de crédito, reembolsar fatura"* (18/10/2026).
  //
  // Devolve o dinheiro LÁ. O que acontece AQUI não é decidido nesta rota: o
  // gateway manda `PAYMENT_REFUNDED` pelo webhook, e é ele que apaga o
  // pagamento e reabre a cobrança. Mexer nos dois lugares criaria dois
  // caminhos para o mesmo fato, e eles discordariam no primeiro estorno que
  // o banco recusasse depois de aceito.
  app.post("/charges/:id/estornar", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const cobranca = await app.api.finance.chargeData(req.params.id);
    if (!cobranca) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    const student = await app.api.user.dataStudent(trainer._id, String(cobranca.student));
    if (!student) return res.status(404).send({ msg: req.t("errors.personNotFound") });

    if (!cobranca.gateway?.pagamento) {
      return res.status(409).send({ msg: req.t("errors.chargeNotAtGateway") });
    }

    const conta = await contaDoGateway(app, student);
    if (!conta.ok) return res.status(400).send({ msg: req.t("errors.chargeGateway"), erro: conta.erro });
    if (!conta.gw.cobranca.estornar) {
      return res.status(400).send({ msg: req.t("errors.chargeGateway"), erro: "gateway_nao_estorna" });
    }

    const feito = await conta.gw.cobranca.estornar({
      chave: conta.credenciais.chave,
      ambiente: conta.credenciais.ambiente,
      pagamento: cobranca.gateway.pagamento,
    });
    if (!feito.ok) {
      return res
        .status(400)
        .send({ msg: feito.detalhe || req.t("errors.chargeRefund"), erro: feito.erro });
    }

    app.insertUserActionHistory(req, trainer, "refund_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: String(cobranca._id), person: student._id },
      extra: { person: student.name, personId: student._id + "", amount: cobranca.amount },
    });

    res.send({ ok: true });
  });

  // ── MANDAR O LINK POR E-MAIL ─────────────────────────────────────────
  //
  // *"botão de enviar pro e-mail"* (18/10/2026). O gateway manda o dele
  // quando a fatura nasce; este é o nosso, disparado quando alguém pede — o
  // aluno que apagou, o que diz que não chegou, o que pede a segunda via em
  // março.
  //
  // Sem link não há e-mail a mandar: uma mensagem com um botão que não leva a
  // lugar nenhum é pior que não mandar nada.
  app.post("/charges/:id/email", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const cobranca = await app.api.finance.chargeData(req.params.id);
    if (!cobranca) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    const student = await app.api.user.dataStudent(trainer._id, String(cobranca.student));
    if (!student) return res.status(404).send({ msg: req.t("errors.personNotFound") });

    if (!cobranca.gateway?.url) {
      return res.status(409).send({ msg: req.t("errors.chargeNoLink") });
    }
    if (!student.email) return res.status(409).send({ msg: req.t("errors.personNoEmail") });

    const casa = await app.api.tenant.dataOfInstance();

    // O vencimento no meio do dia, como nos outros e-mails: "2026-10-14" lido
    // como meia-noite UTC vira 13/10 em São Paulo, e o prazo andaria um dia
    // para trás no e-mail de cobrança — justo o número que ninguém pode errar.
    const dia = cobranca.dueDate
      ? new Date(`${String(cobranca.dueDate).slice(0, 10)}T12:00:00`).toLocaleDateString(
          req.language || "pt-BR",
          { timeZone: "UTC" }
        )
      : "";

    try {
      await app.helpers.mailer.send({
        to: student.email,
        ...chargeLink({
          lang: req.language,
          name: student.name,
          casa: casa?.name || "",
          valor: dinheiro(cobranca.amount, cobranca.currency),
          descricao: cobranca.description || "",
          vencimento: dia,
          url: cobranca.gateway.url,
          tema: casa?.theme,
        }),
      });
    } catch (erro) {
      console.error("[financeiro] e-mail do link falhou:", erro?.message || erro);
      return res.status(502).send({ msg: req.t("errors.chargeEmail") });
    }

    app.insertUserActionHistory(req, trainer, "email_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: String(cobranca._id), person: student._id },
      extra: { person: student.name, personId: student._id + "", email: student.email },
    });

    res.send({ ok: true, email: student.email });
  });

  // Leva para o gateway o que mudou aqui. Devolve `{ok:false}` com o motivo
  // em vez de estourar: a edição daqui já está gravada quando isto roda.
  async function atualizarNoGateway(student, cobranca, { comAForma = false } = {}) {
    if (!student) return { ok: false, erro: "sem_pessoa" };

    const credenciais = await app.api.paymentGateway.ativo(student.unit);
    if (!credenciais) return { ok: false, erro: "sem_gateway" };

    const gw = require("../lib/gateways").de(credenciais.tipo);
    if (!gw?.cobranca?.atualizar) return { ok: false, erro: "gateway_nao_cobra" };

    return await gw.cobranca.atualizar({
      chave: credenciais.chave,
      ambiente: credenciais.ambiente,
      pagamento: cobranca.gateway?.pagamento,
      cobranca: {
        valor: cobranca.amount,
        vencimento: cobranca.dueDate,
        descricao: cobranca.description || "",
        // A forma só vai quando ELA mudou — ver `cobranca.atualizar`.
        ...(comAForma ? { formasDePagamento: cobranca.method ? [cobranca.method] : [] } : {}),
      },
    });
  }

  // ── PARCELAR: UM VALOR EM N VEZES ────────────────────────────────────
  //
  // *"crie a aba parcelamento pois o asaas pode criar parcelamento também"*
  // (17/10/2026).
  //
  // `finance.manage` e não uma chave própria: parcelar é criar N cobranças
  // de uma vez, e criar cobrança já é desta chave. Assinatura tem chave
  // separada porque ela cobra PARA SEMPRE sem ninguém olhar de novo — um
  // carnê de doze vezes tem fim no dia em que nasce.
  app.post("/people/:personId/installments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};
    const moeda = await app.api.tenant.currencyFor(body.currency);

    const feito = await app.api.finance.parcelar(student._id, body, trainer._id, moeda);
    if (!feito.ok) return res.status(400).send({ msg: req.t("errors.installmentInvalid") });

    // ── E NO GATEWAY, SE PEDIREM ──────────────────────────────────────
    //
    // As parcelas já existem aqui; o gateway é o que faz a pessoa RECEBER o
    // carnê. Se ele falhar, o parcelamento continua de pé e a recusa vai
    // junto na resposta — apagar doze cobranças porque o Asaas estava fora
    // do ar seria perder o trabalho de quem acabou de lançar.
    let gateway = null;
    if (body.noGateway) {
      gateway = await cobrarParcelamentoNoGateway(req, student, feito, moeda);
      if (gateway?.ok) await app.api.finance.marcarParcelamentoNoGateway(feito.grupo, gateway);
    }

    app.insertUserActionHistory(req, trainer, "create_installment", {
      category: "finance",
      local: { target_type: "charges", target_id: feito.grupo, person: student._id },
      extra: {
        person: student.name,
        personId: student._id + "",
        parcelas: feito.parcelas,
        amount: feito.parcelas * feito.valorDaParcela,
      },
    });

    res.status(201).send({
      grupo: feito.grupo,
      parcelas: feito.parcelas,
      gateway: gateway ? { ok: gateway.ok, link: gateway.link || "", erro: gateway.erro || "" } : null,
    });
  });

  // ── CANCELAR E APAGAR O CARNÊ INTEIRO ─────────────────────────────────
  //
  // *"coloque a opção de cancelar e deletar parcelamento no asaas"*
  // (19/10/2026).
  //
  // As duas desfazem o carnê LÁ com uma chamada só (`DELETE /installments`),
  // e não parcela por parcela: doze pedidos podem parar no meio e deixar meio
  // carnê em pé, que é um estado que ninguém sabe ler depois.
  //
  // A diferença entre elas é só deste lado: CANCELAR deixa as parcelas aqui,
  // riscadas, e APAGAR some com elas. Cancelar é o que se faz quando o
  // combinado acabou e a história importa; apagar é para o que foi lançado
  // errado.
  //
  // E as duas param antes se o gateway recusar — ficar sem o carnê aqui e com
  // ele lá é o mesmo estrago de uma cobrança só.
  async function desfazerCarneNoGateway(parcelas) {
    const comFatura = parcelas.find((p) => p.gateway?.parcelamento);
    if (!comFatura) return { ok: true, nada: true };

    const student = await app.api.user.data(String(parcelas[0].student));
    const conta = student ? await contaDoGateway(app, student) : { ok: false, erro: "sem_pessoa" };
    if (!conta.ok || !conta.gw.cobranca.apagarParcelamento) {
      return { ok: false, erro: conta.erro || "gateway_nao_parcela" };
    }

    return conta.gw.cobranca.apagarParcelamento({
      chave: conta.credenciais.chave,
      ambiente: conta.credenciais.ambiente,
      parcelamento: comFatura.gateway.parcelamento,
    });
  }

  app.post("/installments/:grupo/cancelar", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const parcelas = await app.api.finance.parcelasDoGrupo(req.params.grupo);
    if (!parcelas.length) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    const feito = await desfazerCarneNoGateway(parcelas);
    if (!feito.ok) {
      return res
        .status(400)
        .send({ msg: feito.detalhe || req.t("errors.chargeGatewayCancel"), erro: feito.erro });
    }

    const quantas = await app.api.finance.cancelarParcelamento(req.params.grupo);

    app.insertUserActionHistory(req, trainer, "cancel_installment", {
      category: "finance",
      local: {
        target_type: "charges",
        target_id: String(req.params.grupo),
        person: parcelas[0].student,
      },
      extra: { parcelas: quantas },
    });

    res.send({ canceladas: quantas });
  });

  app.delete("/installments/:grupo", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const parcelas = await app.api.finance.parcelasDoGrupo(req.params.grupo);
    if (!parcelas.length) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    // ── O QUE RECEBEU DINHEIRO NÃO SE APAGA ─────────────────────────
    //
    // A mesma trava de uma cobrança só, aplicada ao conjunto: apagar o carnê
    // com a terceira parcela paga deixaria o valor no caixa sem dizer de que
    // era. Para desfazer, o caminho é apagar o RECEBIMENTO antes — ou
    // cancelar, que preserva a história.
    const pagos = await app.api.finance.paidByCharge(parcelas[0].student);
    const comDinheiro = parcelas.some(
      (p) => (pagos[String(p._id)] || 0) > 0 || p.status === "paid"
    );
    if (comDinheiro) return res.status(409).send({ msg: req.t("errors.chargeHasPayments") });

    const feito = await desfazerCarneNoGateway(parcelas);
    if (!feito.ok) {
      return res
        .status(400)
        .send({ msg: feito.detalhe || req.t("errors.chargeGatewayDelete"), erro: feito.erro });
    }

    const quantas = await app.api.finance.apagarParcelamento(req.params.grupo);

    app.insertUserActionHistory(req, trainer, "delete_installment", {
      category: "finance",
      local: {
        target_type: "charges",
        target_id: String(req.params.grupo),
        person: parcelas[0].student,
      },
      extra: { parcelas: quantas },
    });

    res.send({ msg: req.t("ok.chargeRemoved") });
  });

  // ── O GATEWAY DA UNIDADE DESTA PESSOA, para a tela ────────────────────
  //
  // O NOME (a tela nunca escreve "Asaas" por conta própria) e as FORMAS que
  // ele emite — é isto que decide se a caixa "gerar no {{nome}}" existe e o
  // que o seletor de forma pode oferecer numa cobrança que já virou fatura.
  //
  // NUNCA a chave: ela não atravessa para o navegador em hipótese nenhuma.
  async function oGatewayDa(student) {
    const credenciais = await app.api.paymentGateway.ativo(student.unit);
    if (!credenciais) return null;

    const ficha = require("../lib/gateways").catalogo().find((g) => g.chave === credenciais.tipo);
    return {
      tipo: credenciais.tipo,
      nome: ficha?.nome || credenciais.tipo,
      formas: ficha?.formas || [],
      // ── DÁ PARA COBRAR NUM CARTÃO DIGITADO NA HORA? ──────────────────
      //
      // Duas coisas, e as duas precisam ser verdade: o gateway sabe guardar
      // cartão, e a CONTA tem a função liberada (é pedido ao suporte deles,
      // não caixa que a gente marca). É o que decide se o diálogo do botão
      // Cobrar oferece "outro cartão" além dos guardados — oferecê-lo sem
      // isso seria um formulário que só sabe terminar em recusa.
      tokeniza: Boolean(ficha?.tokeniza && credenciais.tokenizacao),
      // E QUAL das nossas formas ele debita de um cartão. A tela usa para
      // saber em que linhas o botão cabe, em vez de conhecer "credit" por
      // dentro.
      formaDeCartao: ficha?.formaDeCartao || "",
    };
  }

  // Os dois ajudantes do gateway moram em `lib/faturaNoGateway.js` desde
  // 19/10/2026: a geração da assinatura também emite fatura, e ela roda fora
  // de qualquer rota. Aqui ficam só os nomes curtos, para os chamadores desta
  // casa continuarem lendo como sempre leram.
  const { contaDoGateway, contaECliente, emitirAvulsa } = require("../lib/faturaNoGateway.js");
  const cobrarNoGateway = (student, cobranca, opcoes) =>
    emitirAvulsa(app, student, cobranca, opcoes);

  // Manda o carnê para o gateway da unidade da pessoa. Devolve `{ok:false}`
  // com o motivo em vez de estourar: o parcelamento daqui já existe, e a
  // tela precisa poder dizer "criei aqui, lá não deu — e por quê".
  async function cobrarParcelamentoNoGateway(req, student, feito, moeda) {
    const conta = await contaECliente(app, student);
    if (!conta.ok) return conta;

    const { credenciais, gw } = conta;
    if (!gw.cobranca.parcelar) return { ok: false, erro: "gateway_nao_parcela" };

    const carne = await gw.cobranca.parcelar({
      chave: credenciais.chave,
      ambiente: credenciais.ambiente,
      cliente: conta.cliente,
      parcela: {
        parcelas: feito.parcelas,
        valorDaParcela: feito.valorDaParcela,
        primeiroVencimento: feito.primeira?.dueDate,
        descricao: feito.primeira?.description,
        grupo: feito.grupo,
        // A FORMA combinada no formulário. Vazio é "todas" — ver
        // `formaDeCobranca` no adaptador.
        formasDePagamento: feito.forma ? [feito.forma] : [],
      },
    });
    if (!carne.ok) return carne;

    // ── E CADA PARCELA DAQUI GANHA O ID DA FATURA DELA ─────────────────
    //
    // *"ele gera uma fatura para cada, aí vem via webhook"*. O POST devolveu
    // só a primeira; as outras nasceram lá. Buscar a lista agora e carimbar
    // é o que faz o webhook de cada uma achar a cobrança certa por
    // IDENTIDADE — sem isso, o primeiro aviso de cada parcela cairia num
    // palpite por vencimento.
    //
    // Falhar aqui NÃO desfaz nada: o carnê existe nos dois lados, e o
    // webhook ainda sabe se virar pelo grupo. É melhoria de precisão, não
    // condição de funcionamento.
    if (gw.cobranca.parcelasDoGrupo && carne.id) {
      const lista = await gw.cobranca.parcelasDoGrupo({
        chave: credenciais.chave,
        ambiente: credenciais.ambiente,
        grupo: carne.id,
      });
      if (lista.ok) await app.api.finance.casarParcelasComOGateway(feito.grupo, lista.faturas);
    }

    return carne;
  }

  // ── UM LANÇAMENTO, COM O QUE ELE PRECISA PARA SER EDITADO ─────────────
  //
  // Pedido do Marlon em 18/09/2026: *"esse modal é um modal que eu gostaria de
  // abrir de qualquer lugar, aí salve na url o id da cobrança e o id do
  // pagamento, assim se eu der f5 ou mandar para alguém, abre onde deveria"*.
  //
  // E é isso que obriga estas rotas a existirem. Enquanto o diálogo só abria a
  // partir de uma lista, a linha já estava na mão. Vindo de um LINK, não há
  // lista nenhuma: a tela tem o id e mais nada.
  //
  // ── A RESPOSTA É MAIOR QUE O DOCUMENTO, de propósito ─────────────────
  //
  // O editor não desenha só a cobrança: ele mostra o NOME de quem deve (no
  // título), os pagamentos que já entraram, e o catálogo de estados. Buscar
  // cada coisa por conta faria quatro idas ao servidor para abrir uma janela —
  // e a janela piscaria em quatro tempos.
  app.get("/charges/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const cobranca = await app.api.finance.chargeData(req.params.id);
    if (!cobranca) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    // O VÍNCULO, e não só a existência: `dataStudent` filtra pelo profissional.
    // Sem isto, um id adivinhado abriria a cobrança de quem não é seu — e um id
    // que vaza num link é justamente o que esta funcionalidade cria.
    const student = await app.api.user.dataStudent(trainer._id, cobranca.student);
    if (!student) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      charge: cobranca,
      student: { _id: String(student._id), name: student.name },
      payments: await app.api.finance.paymentsOfCharge(cobranca._id),
      currency: moedas.currency,
      // Os estados da cobrança, para o seletor: a janela abre de um LINK, e
      // ali não há ficha nenhuma de onde tirar o catálogo. O GATEWAY vem pelo
      // mesmo motivo — é ele que diz quais formas a fatura aceita.
      chargeStatus: statusDeCobranca.paraTela(req.t),
      gateway: await oGatewayDa(student),
      paymentStatus: statusDePagamento.paraTela(req.t),
    });
  });

  app.get("/payments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const pagamento = await app.api.finance.paymentData(req.params.id);
    if (!pagamento) return res.status(404).send({ msg: req.t("errors.paymentNotFound") });

    const student = await app.api.user.dataStudent(trainer._id, pagamento.student);
    if (!student) return res.status(404).send({ msg: req.t("errors.paymentNotFound") });

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      payment: pagamento,
      student: { _id: String(student._id), name: student.name },
      // As cobranças DA PESSOA, para o seletor "Referente a" — é o único jeito
      // de o campo funcionar quando a janela abre de um link.
      charges: await app.api.finance.listCharges(student._id),
      paidByCharge: await app.api.finance.paidByCharge(student._id),
      currency: moedas.currency,
      paymentStatus: statusDePagamento.paraTela(req.t),
    });
  });

  // Os pagamentos de uma cobrança, para o diálogo de edição mostrar de onde vem
  // o "Paga". `finance.view` e não `manage`: é leitura.
  app.get("/charges/:id/payments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const cobranca = await app.api.finance.chargeData(req.params.id);
    if (!cobranca) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    res.send({ rows: await app.api.finance.paymentsOfCharge(req.params.id) });
  });

  // ── APAGAR A FATURA NO GATEWAY ──────────────────────────────────────
  //
  // Serve a DOIS caminhos, e é a mesma operação nos dois: apagar a cobrança
  // (*"eu removi a cobrança mas não removeu no asaas"*) e CANCELÁ-LA
  // (*"o cancelar também cancela no asaas?"*, 19/10/2026 — não cancelava).
  //
  // No Asaas não existe "cancelar": uma fatura pendente se cancela apagando.
  // Para uma já paga ele recusa, e aí o caminho é o estorno — que é outro
  // botão, de propósito, porque devolver dinheiro não pode acontecer como
  // efeito colateral de um clique em "cancelar".
  async function apagarFaturaDe(cobranca) {
    const student = await app.api.user.data(String(cobranca.student));
    const conta = student ? await contaDoGateway(app, student) : { ok: false, erro: "sem_pessoa" };

    if (!conta.ok || !conta.gw.cobranca.apagar) {
      return { ok: false, erro: conta.erro || "gateway_nao_cobra" };
    }

    return conta.gw.cobranca.apagar({
      chave: conta.credenciais.chave,
      ambiente: conta.credenciais.ambiente,
      pagamento: cobranca.gateway.pagamento,
    });
  }

  app.put("/charges/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const antes = await app.api.finance.chargeData(req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.chargeNotFound") });
      return;
    }

    const corpo = req.body || {};
    if (corpo.currency) corpo.currency = await app.api.tenant.currencyFor(corpo.currency);

    // ── CANCELAR AQUI CANCELA LÁ ──────────────────────────────────────
    //
    // *"o cancelar também cancela no asaas?"* (19/10/2026). Não cancelava: a
    // linha ficava riscada nesta tela e a fatura seguia viva, com link válido
    // e cobrança por e-mail. O aluno pagava uma coisa que esta casa já tinha
    // dado por encerrada, e o dinheiro entrava sem dono deste lado.
    //
    // LÁ PRIMEIRO, e só então aqui — a mesma ordem de apagar, e pelo mesmo
    // motivo: cancelada aqui e viva lá é o pior dos dois estados, porque
    // ninguém mais vai olhar para ela.
    //
    // Se o gateway recusar (a mais comum: ela JÁ FOI PAGA), nada muda aqui, e
    // a recusa dele sobe com o motivo. Para uma cobrança paga o caminho não é
    // cancelar — é estornar.
    const cancelando = corpo.status === "canceled" && antes.status !== "canceled";

    if (cancelando && antes.gateway?.pagamento) {
      const feito = await apagarFaturaDe(antes);
      if (!feito.ok) {
        return res
          .status(400)
          .send({ msg: feito.detalhe || req.t("errors.chargeGatewayCancel"), erro: feito.erro });
      }
      // A fatura não existe mais: o link, o id e a situação dela aqui viraram
      // promessas falsas. Reabrir e gerar de novo cria uma fatura NOVA, que é
      // o certo — cancelada e recobrada são dois pedidos, não um.
      await app.api.finance.limparNoGateway(req.params.id);
    }

    await app.api.finance.updateCharge(req.params.id, corpo);
    let depois = await app.api.finance.chargeData(req.params.id);

    // ── E A MUDANÇA VAI PARA O GATEWAY ────────────────────────────────
    //
    // *"quando editei a descrição, não editou no Asaas"* (18/10/2026). E ele
    // está certo: o que o aluno lê é a fatura DELES. Trocar o texto só aqui
    // deixa a tela dizendo uma coisa e o boleto outra — e quem descobre é
    // quem recebe o boleto.
    //
    // Só quando a cobrança TEM fatura lá, e só quando mexeram no que ela
    // mostra: valor, vencimento, descrição ou forma. Um PUT a cada edição de
    // observação seria uma ida à rede por nada.
    //
    // Falhar aqui NÃO desfaz a edição: o que a pessoa digitou está gravado, e
    // a recusa sobe junto (`gatewayErro`) para a tela dizer o que ficou
    // diferente lá fora. Desfazer seria perder o trabalho dela por causa de
    // uma rede que caiu.
    let gatewayErro = "";
    const mexeuNaFatura = ["amount", "dueDate", "description", "method"].some(
      (campo) => corpo[campo] !== undefined
    );

    if (antes.gateway?.pagamento && mexeuNaFatura && !cancelando) {
      const dono = await app.api.user.data(String(antes.student));
      const feito = await atualizarNoGateway(dono, depois, {
        comAForma: corpo.method !== undefined,
      });

      if (feito.ok) {
        if (feito.link) {
          await app.api.finance.marcarNoGateway(req.params.id, { url: feito.link });
          depois = await app.api.finance.chargeData(req.params.id);
        }
      } else {
        gatewayErro = feito.detalhe || feito.erro || "fora_do_ar";
      }
    }

    app.insertUserActionHistory(req, trainer, "update_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: req.params.id + "", person: antes?.student },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(gatewayErro ? { ...depois, gatewayErro } : depois);
  });

  app.delete("/charges/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const alvo = await app.api.finance.chargeData(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.chargeNotFound") });
      return;
    }

    // ── O QUE RECEBEU DINHEIRO NÃO SE APAGA ───────────────────────────
    //
    // *"não permita remover cobrança se tiver pago ou recebido"*
    // (18/10/2026).
    //
    // Antes a cobrança sumia e os pagamentos dela viravam avulsos — o
    // dinheiro continuava no caixa, mas sem dizer do que era. O extrato
    // ficava com "R$ 150,00" solto e ninguém mais sabia explicar a linha seis
    // meses depois.
    //
    // Qualquer centavo recebido já tranca: pagamento parcial também é
    // dinheiro que entrou. Para desfazer, o caminho é apagar o RECEBIMENTO
    // primeiro (ou estornar, quando veio do gateway) — e aí a cobrança volta
    // a ser apagável.
    const pagos = await app.api.finance.paidByCharge(alvo.student);
    if ((pagos[String(alvo._id)] || 0) > 0 || alvo.status === "paid") {
      return res.status(409).send({ msg: req.t("errors.chargeHasPayments") });
    }

    // ── E A FATURA DE LÁ VAI JUNTO ────────────────────────────────────
    //
    // *"eu removi a cobrança mas não removeu no asaas"*. Enquanto ela existe
    // lá, o aluno continua recebendo — e podendo pagar — algo que esta casa
    // já esqueceu: o dinheiro entraria sem dono deste lado.
    //
    // LÁ PRIMEIRO, e só então aqui. Se o gateway recusar, a cobrança NÃO é
    // apagada: ficar sem ela aqui e com ela lá é exatamente o estrago que
    // este bloco existe para evitar.
    if (alvo.gateway?.pagamento) {
      const feito = await apagarFaturaDe(alvo);
      if (!feito.ok) {
        return res
          .status(400)
          .send({ msg: feito.detalhe || req.t("errors.chargeGatewayDelete"), erro: feito.erro });
      }
    }

    await app.api.finance.deleteCharge(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_charge", {
      category: "finance",
      local: { target_type: "charges", target_id: req.params.id + "", person: alvo?.student },
      extra: { amount: alvo.amount },
    });

    res.send({ msg: req.t("ok.chargeRemoved") });
  });

  // ── Pagamentos ──────────────────────────────────────────────────────────

  app.post("/people/:personId/payments", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const student = await pessoaDoProfissional(req, res, trainer);
    if (student === false) return;

    const body = req.body || {};

    // O comprovante é lido ANTES de gravar: um arquivo recusado tem de virar
    // 400 com o motivo certo, e não um pagamento gravado sem ele.
    let comprovante;
    if (body.receipt) {
      comprovante = app.api.finance.parseReceipt(body.receipt);
      if (!comprovante) {
        res.status(400).send({ msg: req.t("errors.invalidAttachment") });
        return;
      }
    }

    // ── A MOEDA DE UM PAGAMENTO COM COBRANÇA É A DA COBRANÇA ──────────────
    //
    // *"aqui nessa tela, temos moeda, já entendeu o problema né?"* — o dialog
    // abria em USD com o "Referente a" apontando para uma cobrança de R$ 25.
    //
    // O estrago não é cosmético: `paidByCharge` e `carteira` somam `amount` SEM
    // olhar moeda. Um pagamento de 25 USD quitaria uma cobrança de R$ 25 — a
    // conta fecharia na tela e o dinheiro recebido seria outro.
    //
    // ── Forçar, e não recusar ─────────────────────────────────────────────
    //
    // Recusar com 400 obrigaria a pessoa a descobrir sozinha qual moeda o campo
    // deveria ter. E não há ambiguidade a resolver: um pagamento QUE SE REFERE a
    // uma cobrança é, por definição, na moeda dela — quem recebe em outra moeda
    // está fazendo outro combinado, e aí lança um pagamento avulso.
    //
    // Pagamento SEM cobrança continua livre: a moeda vem do que foi pedido, com
    // a da conta como padrão (`currencyFor` só aceita as habilitadas).
    // A moeda pedida, validada contra o que a conta aceita receber. Se o
    // pagamento apontar para uma cobrança, `insertPayment` troca esta pela
    // moeda DELA — a regra vive lá, num lugar só, porque a edição passa pelo
    // mesmo problema e não passa por aqui.
    const moeda = await app.api.tenant.currencyFor(body.currency);

    const id = await app.api.finance.insertPayment(student._id, body, trainer._id, moeda);
    if (comprovante) await app.api.finance.saveReceipt(id, comprovante);

    const criado = await app.api.finance.paymentData(id);

    app.insertUserActionHistory(req, trainer, "create_payment", {
      category: "finance",
      local: { target_type: "payments", target_id: id + "", person: student._id },
      extra: {
        person: student.name,
        personId: student._id + "",
        amount: criado?.amount,
        method: criado?.method,
      },
    });

    res.status(201).send(criado);
  });

  app.put("/payments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const antes = await app.api.finance.paymentData(req.params.id);
    if (!antes) {
      res.status(404).send({ msg: req.t("errors.paymentNotFound") });
      return;
    }

    const body = req.body || {};

    let comprovante;
    if (body.receipt?.dataUri) {
      comprovante = app.api.finance.parseReceipt(body.receipt);
      if (!comprovante) {
        res.status(400).send({ msg: req.t("errors.invalidAttachment") });
        return;
      }
    }

    if (body.currency) body.currency = await app.api.tenant.currencyFor(body.currency);

    await app.api.finance.updatePayment(req.params.id, body);
    if (comprovante) await app.api.finance.saveReceipt(req.params.id, comprovante);

    const depois = await app.api.finance.paymentData(req.params.id);

    app.insertUserActionHistory(req, trainer, "update_payment", {
      category: "finance",
      local: { target_type: "payments", target_id: req.params.id + "", person: antes?.student },
      diff: app.api.actionHistory.diff(antes, depois),
    });

    res.send(depois);
  });

  app.delete("/payments/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const alvo = await app.api.finance.paymentData(req.params.id);
    if (!alvo) {
      res.status(404).send({ msg: req.t("errors.paymentNotFound") });
      return;
    }

    await app.api.finance.deletePayment(req.params.id);

    app.insertUserActionHistory(req, trainer, "delete_payment", {
      category: "finance",
      local: { target_type: "payments", target_id: req.params.id + "", person: alvo?.student },
      extra: { amount: alvo.amount },
    });

    res.send({ msg: req.t("ok.paymentRemoved") });
  });

  // ── Comprovante ─────────────────────────────────────────────────────────

  app.get("/payments/:id/receipt", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    const arquivo = await app.api.finance.receiptOf(req.params.id);
    if (!arquivo) {
      res.status(404).send({ msg: req.t("errors.noPhotoShort") });
      return;
    }

    // Imagem abre embutida; PDF baixa. `nosniff` fecha a outra metade: sem ele
    // o navegador adivinha o tipo pelo conteúdo e ignora o que declaramos.
    const embutido = arquivo.mime.startsWith("image/");
    const nome = String(arquivo.name || "comprovante").replace(/"/g, "");

    res.setHeader("Content-Type", arquivo.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${embutido ? "inline" : "attachment"}; filename="${nome}"`
    );
    res.setHeader("Cache-Control", "private, max-age=86400");

    // Os BYTES podem estar no R2 — ver lib/arquivos.js. Note que isto
    // acontece DEPOIS do 304: quando o navegador já tem a versão
    // cacheada, não há ida ao bucket nenhuma.
    const bytes = await arquivos.bytesDoDocumento(arquivo);
    if (!bytes) return res.status(404).send({ msg: req.t("errors.chargeNotFound") });

    res.send(bytes);
  });

  app.delete("/payments/:id/receipt", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    await app.api.finance.removeReceipt(req.params.id);
    res.send({ msg: req.t("ok.photoRemoved") });
  });

  // ── As formas de pagamento ────────────────────────────────────────────────
  //
  // Eram uma lista fixa no código. Continuam sendo um CATÁLOGO — a chave que fica
  // gravada no pagamento não muda —, mas quem manda no catálogo é cada conta:
  // renomear, desativar o que não usa, criar "Cheque" ou "Cartão da recepção" e
  // pôr na ordem em que se pergunta.
  //
  // Ler é `finance.view`: o seletor do formulário de pagamento precisa da lista.
  // Mexer é `finance.manage`.

  app.get("/payment-methods", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (trainer === false) return;

    // `?todas=1` traz também as desativadas — é a tela de configuração. O
    // formulário de pagamento pede só as ativas.
    const rows =
      req.query.todas === "1"
        ? await app.api.paymentMethod.list()
        : await app.api.paymentMethod.listActive();

    res.send({ rows });
  });

  app.post("/payment-methods", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const feito = await app.api.paymentMethod.insert(req.body || {});

    if (feito.erro === "name") {
      res.status(400).send({ msg: req.t("errors.requirePaymentMethodName") });
      return;
    }
    if (feito.erro === "duplicate") {
      res.status(409).send({ msg: req.t("errors.paymentMethodExists") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "create_payment_method", {
      category: "finance",
      local: { target_type: "payment_methods", target_id: String(feito.id) },
      extra: { name: req.body?.name },
    });

    res.status(201).send({ _id: feito.id });
  });

  // ANTES do `/:id`: registrada depois, esta rota nunca seria alcançada — o
  // Express casaria "order" como se fosse um id, e reordenar viraria uma
  // tentativa de editar a forma de pagamento chamada "order".
  app.put("/payment-methods/order", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const ok = await app.api.paymentMethod.reorder(req.body?.ids);
    if (!ok) {
      res.status(400).send({ msg: req.t("errors.invalidOrder") });
      return;
    }

    res.send({ msg: req.t("ok.paymentMethodSaved") });
  });

  app.put("/payment-methods/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const feito = await app.api.paymentMethod.update(req.params.id, req.body || {});

    if (feito?.erro === "name") {
      res.status(400).send({ msg: req.t("errors.requirePaymentMethodName") });
      return;
    }
    if (!feito) {
      res.status(404).send({ msg: req.t("errors.paymentMethodNotFound") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "update_payment_method", {
      category: "finance",
      local: { target_type: "payment_methods", target_id: String(req.params.id) },
      extra: { name: req.body?.name, active: req.body?.active },
    });

    res.send({ msg: req.t("ok.paymentMethodSaved") });
  });

  app.delete("/payment-methods/:id", async function (req, res) {
    const trainer = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (trainer === false) return;

    const feito = await app.api.paymentMethod.delete(req.params.id);

    // As duas recusas dizem o MOTIVO, porque nos dois casos existe uma saída e
    // ela é a mesma: desativar. Um "não foi possível" mandaria a pessoa tentar
    // de novo até desistir.
    if (feito?.erro === "system") {
      res.status(409).send({ msg: req.t("errors.paymentMethodSystem"), code: "system" });
      return;
    }
    if (feito?.erro === "inUse") {
      res.status(409).send({ msg: req.t("errors.paymentMethodInUse"), code: "in_use" });
      return;
    }
    if (!feito) {
      res.status(404).send({ msg: req.t("errors.paymentMethodNotFound") });
      return;
    }

    app.insertUserActionHistory(req, trainer, "delete_payment_method", {
      category: "finance",
      local: { target_type: "payment_methods", target_id: String(req.params.id) },
    });

    res.send({ msg: req.t("ok.paymentMethodRemoved") });
  });

  // ── O EXTRATO FINANCEIRO DE UMA PESSOA ────────────────────────────────
  //
  // As mesmas três rotas da avaliação e do plano alimentar (ver, baixar em PDF,
  // mandar por e-mail), pela mesma fábrica. Aqui fica só o que é do extrato:
  // quais lançamentos entram e como a folha se monta.
  //
  // Pedido do Marlon em 17/09/2026: *"pode exportar xlsx e pdf com a logo bonita
  // foto e dados do cliente"*. A PLANILHA sai na tela — ninguém abre planilha
  // para olhar, abre para somar. O papel, que é o que se entrega, vem daqui.
  //
  // ── `:id` É A PESSOA, e não um lançamento ───────────────────────────
  //
  // A fábrica monta `/finance/:id/documento`, e nas outras duas o `:id` é o
  // documento em si (uma coleta, um plano). Aqui não existe "um extrato" no
  // banco: ele é o recorte que alguém pediu. O dono do recorte é a PESSOA.
  //
  // ── E O RECORTE VIAJA NA QUERY ──────────────────────────────────────
  //
  // `?ids=a,b,c` são as cobranças marcadas na tela. Sem ele, o extrato é a vida
  // financeira inteira da pessoa — que é o que se quer ao entregar um
  // comprovante de quitação, e o que ninguém quer ao imprimir só o mês.
  //
  // Os TOTAIS são do que ficou na folha, e não o saldo da conta: três cobranças
  // marcadas com o "Cobrado" da conta inteira em cima seria um número que não
  // bate com nenhuma linha abaixo dele.
  function pedidas(req) {
    const bruto = String(req.query.ids || "").trim();
    if (!bruto) return null;

    const ids = bruto
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    return ids.length ? new Set(ids) : null;
  }

  registrarRotasDeDocumento(app, {
    base: "finance",
    prefixoDoArquivo: "extrato",
    chaveDoAssunto: "email.statement.subject",
    chaveDeOk: "ok.statementEmailed",
    acao: "email_statement",

    montar: async function (req, res) {
      const trainer = await app.helpers.ReqProtected.can(req, res, "finance.view");
      if (trainer === false) return null;

      // `dataStudent` já filtra pelo profissional: quem não acompanha a pessoa
      // recebe 404, e não o extrato dela.
      const student = await app.api.user.dataStudent(trainer._id, req.params.id);
      if (!student) {
        res.status(404).send({ msg: req.t("errors.personNotFound") });
        return null;
      }

      const [todasAsCobrancas, todosOsPagamentos, moedas, fuso, casa, catalogo] = await Promise.all([
        app.api.finance.listCharges(student._id),
        app.api.finance.listPayments(student._id),
        app.api.tenant.currencyOfInstance(),
        app.api.tenant.timezoneOfInstance(),
        app.api.tenant.dataOfInstance(),
        // COM as desativadas: um pagamento antigo em boleto continua tendo de
        // dizer "Boleto" depois de o boleto sair de uso.
        app.api.paymentMethod.list(),
      ]);

      const escolhidas = pedidas(req);

      const charges = escolhidas
        ? todasAsCobrancas.filter((c) => escolhidas.has(String(c._id)))
        : todasAsCobrancas;

      // Com recorte, só os pagamentos DAS cobranças escolhidas: um avulso no
      // meio de três cobranças marcadas seria dinheiro que a pessoa não pediu
      // para ver, somado num total que ela vai conferir.
      const payments = escolhidas
        ? todosOsPagamentos.filter((p) => p.charge && escolhidas.has(String(p.charge)))
        : todosOsPagamentos;

      const formas = {};
      for (const f of catalogo || []) if (f.name) formas[f.key] = f.name;

      // ── A FOTO DA PESSOA, embutida ──────────────────────────────────
      //
      // `data:` URI, e não a URL de `/avatars/:id`: aquela exige sessão, e um
      // `<img>` apontando para ela sai em branco no e-mail, no PDF e no
      // `expo-print`. Embutida, a folha funciona salva em disco, meses depois.
      //
      // Sem foto a folha sai sem ela — o desenho já prevê isso, e um quadrado
      // cinza no lugar seria pior do que nada.
      let bytesDaFoto = null;
      let mimeDaFoto = "image/jpeg";

      try {
        const avatar = await app.api.avatar.data(student._id);
        if (avatar) {
          // `bytesDoDocumento` já devolve Buffer, venha a foto do R2 ou do
          // campo `data` do banco — ele resolve as duas pontas da migração.
          const crus = await arquivos.bytesDoDocumento(avatar);
          // Um Buffer de zero bytes é VERDADEIRO em JavaScript: sem o teste de
          // tamanho sairia `data:image/jpeg;base64,` — um URI de sintaxe
          // perfeita e nenhuma imagem, que vira ícone quebrado sem erro nenhum.
          if (crus && crus.length) {
            bytesDaFoto = crus;
            mimeDaFoto = avatar.mime || mimeDaFoto;
          }
        }
      } catch (erro) {
        // Foto que não carrega não pode custar o extrato: o dinheiro é o
        // conteúdo, e o retrato é enfeite.
        console.warn("[documento:finance] foto:", erro.message);
      }

      const marca = await logoDaCasa(casa?.theme);
      const CID_LOGO = "logo-da-casa";
      const CID_FOTO = "foto-da-pessoa";

      const desenhar = (comFoto, comMarca) =>
        documentoFinanceiro({
          person: student,
          charges,
          payments,
          moeda: moedas.currency,
          formas,
          foto: comFoto,
          lang: trainer.lang || req.language,
          fuso,
          marca: comMarca,
        });

      // ── DUAS VERSÕES DA MESMA FOLHA ─────────────────────────────────
      //
      // O Gmail DESCARTA `<img src="data:…">`, e o Chromium que gera o PDF não
      // resolve `cid:` — ele não tem a mensagem MIME, só a página. Cada saída
      // recebe a versão que sabe ler, e as duas nascem do mesmo dado.
      const fotos = [];

      if (bytesDaFoto) {
        fotos.push({
          cid: CID_FOTO,
          filename: `foto.${(mimeDaFoto.split("/")[1] || "jpg")}`,
          content: bytesDaFoto,
          contentType: mimeDaFoto,
        });
      }

      if (marca) {
        const [cabecalho, base64] = marca.split(",");
        fotos.push({
          cid: CID_LOGO,
          filename: "logo.png",
          content: Buffer.from(base64 || "", "base64"),
          contentType: (cabecalho.match(/data:([^;]+)/) || [])[1] || "image/png",
        });
      }

      const embutida = bytesDaFoto
        ? `data:${mimeDaFoto};base64,${bytesDaFoto.toString("base64")}`
        : null;

      return {
        trainer,
        pessoa: student,
        html: desenhar(embutida, marca),
        htmlDeEmail: desenhar(
          bytesDaFoto ? `cid:${CID_FOTO}` : null,
          marca ? `cid:${CID_LOGO}` : null
        ),
        fotos,
        nome: student.name,
        data: new Date(),
      };
    },
  });
};
