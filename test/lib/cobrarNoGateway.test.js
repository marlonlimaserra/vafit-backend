const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const asaas = require("../../lib/gateways/asaas.js");
const Cobrador = require("../../model/Cobrador_model.js");
const Finance = require("../../model/Finance_model.js");

// COBRAR NO GATEWAY — a matrícula que já nasce com a fatura aberta.
//
// *"coloque uma opção aqui 'Gerar no gateway'; se essa opção tiver marcada, em
// vez de falar que a unidade vai entrar em contato, já gera o cadastro dele no
// gateway e cria a recorrência direto lá, e salve os ids do nosso lado, pois o
// Asaas vai criar o pagamento lá e vai enviar ele via webhook. Aí já abre os
// dados para o cliente pagar direto ali"* (14/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. A MATRÍCULA NÃO SE DESFAZ. Qualquer tropeço do gateway vira "pagamento
//    pelo caminho de sempre", nunca uma exceção — o aluno já está gravado.
// 2. A CADÊNCIA NÃO TEM PADRÃO. Uma cadência sem par lá recusa, porque cobrar
//    todo mês quem combinou trimestral só aparece na fatura do aluno.
// 3. O CLIENTE NÃO DUPLICA. O Asaas aceita dois cadastros com o mesmo CPF sem
//    reclamar.
// 4. O AVISO ACHA O DONO, e quita a cobrança certa.

// Um `fetch` de mentira que responde por caminho e ANOTA o que foi pedido.
function rede(rotas) {
  const feitos = [];

  const buscar = async (url, opcoes = {}) => {
    const caminho = String(url).replace(/^https:\/\/[^/]+\/v3/, "");
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    feitos.push({ caminho, metodo: opcoes.method || "GET", corpo });

    const r = rotas[`${opcoes.method || "GET"} ${caminho}`] ?? rotas[caminho];
    if (r === undefined) throw new Error("rota não dublada: " + caminho);

    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      async json() {
        return r.corpo || {};
      },
    };
  };

  return { buscar, feitos };
}

const CHAVE = { chave: "$aact_x", ambiente: "producao" };

// ── O CLIENTE ─────────────────────────────────────────────────────────────

test("o cliente é PROCURADO pelo CPF antes de ser criado", async () => {
  // Sem isto, a conta do Asaas enche de "Marlon Silva" repetidos — um por
  // plano assinado — e ele descobre pela tela deles, não pela nossa.
  const { buscar, feitos } = rede({
    "/customers?cpfCnpj=11144477735": { corpo: { data: [{ id: "cus_ja" }] } },
  });

  const r = await asaas.cobranca.cliente({
    ...CHAVE,
    pessoa: { documento: "111.444.777-35" },
    buscar,
  });

  assert.deepEqual(r, { ok: true, id: "cus_ja", novo: false });
  assert.equal(feitos.length, 1, "achou: não cria");
});

// ── SEM DOCUMENTO VÁLIDO, NENHUMA REQUISIÇÃO (16/11/2026) ─────────────────
//
// `?cpfCnpj=` vazio devolveria OUTRO cliente da conta, e a fatura nasceria no
// nome dele — com o aviso do Asaas indo para ele. O teste é que a rede NEM É
// TOCADA: o defeito não é "achou errado", é ter perguntado.
for (const [documento, erro] of [
  ["", "sem_documento"],
  [undefined, "sem_documento"],
  ["   ", "sem_documento"],
  ["123", "documento_invalido"],
  ["111.444.777-3", "documento_invalido"],
]) {
  test(`documento ${JSON.stringify(documento)}: recusa (${erro}) sem perguntar nada ao Asaas`, async () => {
    const { buscar, feitos } = rede({});
    const r = await asaas.cobranca.cliente({
      chave: "k",
      ambiente: "sandbox",
      pessoa: { id: "u1", nome: "Sem CPF", documento },
      buscar,
    });
    assert.deepEqual(r, { ok: false, erro });
    assert.equal(feitos.length, 0, "nenhuma busca de cliente pode sair sem documento");
  });
}

test("CNPJ (14 dígitos) também identifica — e é procurado", async () => {
  const { buscar, feitos } = rede({
    "/customers?cpfCnpj=11222333000181": { corpo: { data: [{ id: "cus_pj" }] } },
  });
  const r = await asaas.cobranca.cliente({
    chave: "k",
    ambiente: "sandbox",
    pessoa: { documento: "11.222.333/0001-81" },
    buscar,
  });
  assert.equal(r.id, "cus_pj");
  assert.equal(feitos.length, 1);
});

test("não achou, cria — e manda só os DÍGITOS do CPF e do telefone", async () => {
  // O Asaas recusa "(21) 99999-0000".
  const { buscar, feitos } = rede({
    "/customers?cpfCnpj=11144477735": { corpo: { data: [] } },
    "POST /customers": { corpo: { id: "cus_novo" } },
  });

  const r = await asaas.cobranca.cliente({
    ...CHAVE,
    pessoa: { id: "u1", nome: "Marlon", documento: "111.444.777-35", telefone: "(21) 99999-0000" },
    buscar,
  });

  assert.deepEqual(r, { ok: true, id: "cus_novo", novo: true });
  assert.equal(feitos[1].corpo.cpfCnpj, "11144477735");
  assert.equal(feitos[1].corpo.mobilePhone, "21999990000");
  // O nosso id do lado deles: é o que permite reconciliar sem depender do CPF.
  assert.equal(feitos[1].corpo.externalReference, "u1");
});

// ── A ASSINATURA ──────────────────────────────────────────────────────────

test("a assinatura leva centavos virados em reais, e o ciclo traduzido", async () => {
  const { buscar, feitos } = rede({ "POST /subscriptions": { corpo: { id: "sub_1" } } });

  const r = await asaas.cobranca.assinatura({
    ...CHAVE,
    cliente: "cus_1",
    plano: { name: "Plano Fit", amount: 15900, cadencia: "quarterly", formasDePagamento: [] },
    recorrencia: "rec1",
    buscar,
  });

  assert.deepEqual(r, { ok: true, id: "sub_1" });
  assert.equal(feitos[0].corpo.value, 159);
  assert.equal(feitos[0].corpo.cycle, "QUARTERLY");
  // O fio que amarra as duas pontas.
  assert.equal(feitos[0].corpo.externalReference, "rec1");
});

test("cadência sem par no Asaas RECUSA — nunca cai em mensal", async () => {
  // O padrão silencioso aqui cobraria a pessoa na frequência errada, e isso só
  // aparece na fatura dela.
  const { buscar, feitos } = rede({});

  const r = await asaas.cobranca.assinatura({
    ...CHAVE,
    cliente: "cus_1",
    plano: { amount: 100, cadencia: "decenal", formasDePagamento: [] },
    buscar,
  });

  assert.deepEqual(r, { ok: false, erro: "cadencia_sem_par" });
  assert.equal(feitos.length, 0, "recusa antes de bater na rede");
});

test("UMA forma vira aquela forma; VÁRIAS viram a fatura aberta", async () => {
  // "UNDEFINED" é o Asaas deixando o próprio aluno escolher na fatura. Fixar
  // uma forma quando o plano deixou três seria decidir por ele.
  const casos = [
    [["pix"], "PIX"],
    [["billet"], "BOLETO"],
    [["pix", "billet"], "UNDEFINED"],
    [[], "UNDEFINED"],
  ];

  for (const [formas, esperado] of casos) {
    const { buscar, feitos } = rede({ "POST /subscriptions": { corpo: { id: "s" } } });
    await asaas.cobranca.assinatura({
      ...CHAVE,
      cliente: "c",
      plano: { amount: 100, cadencia: "monthly", formasDePagamento: formas },
      buscar,
    });
    assert.equal(feitos[0].corpo.billingType, esperado, JSON.stringify(formas));
  }
});

test("plano só de dinheiro e transferência NÃO vira fatura", async () => {
  // O Asaas não emite nenhuma das duas — são formas de quem paga na recepção.
  // "UNDEFINED" aqui abriria uma fatura oferecendo pix numa casa que disse
  // aceitar só dinheiro.
  const { buscar, feitos } = rede({});

  const r = await asaas.cobranca.assinatura({
    ...CHAVE,
    cliente: "c",
    plano: { amount: 100, cadencia: "monthly", formasDePagamento: ["cash", "transfer"] },
    buscar,
  });

  assert.deepEqual(r, { ok: false, erro: "formas_nao_emitiveis" });
  assert.equal(feitos.length, 0);
});

// ── A PRIMEIRA FATURA ─────────────────────────────────────────────────────

test("a fatura que volta é a MAIS ANTIGA em aberto, em centavos", async () => {
  const { buscar } = rede({
    "/subscriptions/sub_1/payments": {
      corpo: {
        data: [
          { id: "pay_2", status: "PENDING", dueDate: "2026-11-14", value: 20, invoiceUrl: "u2" },
          { id: "pay_1", status: "PENDING", dueDate: "2026-10-14", value: 20, invoiceUrl: "u1" },
          { id: "pay_0", status: "RECEIVED", dueDate: "2026-09-14", value: 20, invoiceUrl: "u0" },
        ],
      },
    },
  });

  const r = await asaas.cobranca.primeiraFatura({ ...CHAVE, assinatura: "sub_1", buscar });

  assert.equal(r.fatura.id, "pay_1");
  assert.equal(r.fatura.valor, 2000);
  assert.equal(r.fatura.url, "u1");
});

test("lista vazia NÃO é erro — o Asaas cria a fatura logo DEPOIS da assinatura", async () => {
  // A matrícula existe, o webhook avisa, e o e-mail dele leva o link. Tratar
  // isso como falha faria a tela mentir sobre uma assinatura que está de pé.
  const { buscar } = rede({ "/subscriptions/s/payments": { corpo: { data: [] } } });

  assert.deepEqual(await asaas.cobranca.primeiraFatura({ ...CHAVE, assinatura: "s", buscar }), {
    ok: true,
    fatura: null,
  });
});

// ── O WEBHOOK ─────────────────────────────────────────────────────────────

test("o webhook é registrado por NÓS, e só uma vez por URL", async () => {
  // Pedir a um dono de academia que cole uma URL no painel do Asaas é pedir o
  // passo que não acontece — e sem ele o dinheiro cai lá e a cobrança fica
  // aberta aqui para sempre.
  const url = "https://backend.vafit.app/public/gateway-webhook/asaas/marlon";

  const jaTem = rede({ "/webhooks": { corpo: { data: [{ url }] } } });
  await asaas.cobranca.garantirWebhook({ ...CHAVE, url, segredo: "s", buscar: jaTem.buscar });
  assert.equal(jaTem.feitos.filter((f) => f.metodo === "POST").length, 0);

  const naoTem = rede({ "GET /webhooks": { corpo: { data: [] } }, "POST /webhooks": { corpo: {} } });
  await asaas.cobranca.garantirWebhook({ ...CHAVE, url, segredo: "s3gr3d0", buscar: naoTem.buscar });

  const criado = naoTem.feitos.find((f) => f.metodo === "POST").corpo;
  assert.equal(criado.authToken, "s3gr3d0");
  // Um aviso por vez: em paralelo, "criada" e "paga" da mesma fatura podem
  // chegar trocadas, e a segunda escrita desfaz a primeira.
  assert.equal(criado.sendType, "SEQUENTIALLY");
  // Retomar depois de uma sequência de falhas nossas, em vez de desligar e
  // ficar quieto — que é o pior estado possível aqui.
  assert.equal(criado.interrupted, false);
});

test("`ler` traduz o aviso para o nosso vocabulário", async () => {
  const pago = asaas.cobranca.ler({
    event: "PAYMENT_RECEIVED",
    payment: { id: "pay_1", subscription: "sub_1", dueDate: "2026-10-14", value: 159.9 },
  });

  assert.equal(pago.pago, true);
  assert.equal(pago.assinatura, "sub_1");
  assert.equal(pago.valor, 15990);

  // CONFIRMED é "o cartão autorizou"; RECEIVED é "caiu na conta". Do lado do
  // aluno os dois querem dizer "paguei".
  assert.equal(asaas.cobranca.ler({ event: "PAYMENT_CONFIRMED", payment: {} }).pago, true);
  assert.equal(asaas.cobranca.ler({ event: "PAYMENT_CREATED", payment: {} }).pago, false);
  assert.equal(asaas.cobranca.ler({ event: "PAYMENT_OVERDUE", payment: {} }).pago, false);
});

// ── A ORQUESTRAÇÃO ────────────────────────────────────────────────────────

const REC = new ObjectId("6aac6f7fce88864c1d79e021");

function cobrador({ credenciais, recorrencias = [], cobrancas = [], quitou = [], semRegistro = false } = {}) {
  const marcado = [];
  const webhooks = [];
  const reabertas = [];
  const editadas = [];
  const marcadas = [];
  const ajustadas = [];

  const app = {
    api: {
      paymentGateway: {
        async ativo() { return credenciais; },
        // `semRegistro` apaga estes dois para provar que a assinatura
        // sobrevive a um caminho lateral quebrado — foi assim que a conta
        // dele ficou sem webhook e ninguém soube.
        ...(semRegistro
          ? {}
          : {
              async paraRegistrarWebhook() {
                return credenciais && { ...credenciais, segredo: "s3gr3d0" };
              },
              async marcarWebhook(tipo, unidade) {
                webhooks.push({ tipo, unidade });
              },
            }),
      },
      tenant: { async ownerId() { return "u1"; } },
      user: { async data() { return { email: "dono@academia.com" }; } },
      recurrence: {
        async collection() {
          return {
            async findOne(filtro) {
              return (
                recorrencias.find((r) =>
                  filtro["gateway.assinatura"]
                    ? r.gateway?.assinatura === filtro["gateway.assinatura"]
                    : String(r._id) === String(filtro._id)
                ) || null
              );
            },
          };
        },
        async marcarNoGateway(id, dados) {
          marcado.push({ id: String(id), ...dados });
          return true;
        },
        async gerar() {
          return 0;
        },
        async update(id, obj) {
          editadas.push({ id, ...obj });
          return true;
        },
      },
      finance: {
        async charges() {
          // Um `findOne` que entende os dois caminhos: o da ASSINATURA (por
          // recorrência e período) e o do CARNÊ (por id da fatura, grupo,
          // número da parcela ou faixa de vencimento). Sem o segundo, o teste
          // do parcelamento passaria por não achar nada.
          const casa = (c, filtro) => {
            if (filtro["gateway.pagamento"] !== undefined)
              return c.gateway?.pagamento === filtro["gateway.pagamento"];
            if (filtro["gateway.parcelamento"] !== undefined) {
              if (c.gateway?.parcelamento !== filtro["gateway.parcelamento"]) return false;
              if (filtro.parcela !== undefined && c.parcela !== filtro.parcela) return false;
              if (filtro.status !== undefined && c.status !== filtro.status) return false;
              if (filtro.dueDate) {
                const d = new Date(c.dueDate).getTime();
                if (d < filtro.dueDate.$gte.getTime() || d > filtro.dueDate.$lte.getTime()) return false;
              }
              return true;
            }
            return (
              String(c.recurrence) === String(filtro.recurrence) &&
              (filtro.periodo === undefined || c.periodo === filtro.periodo) &&
              (filtro.status === undefined || c.status === filtro.status)
            );
          };

          return {
            async findOne(filtro, opcoes) {
              const achadas = cobrancas.filter((c) => casa(c, filtro));
              if (opcoes?.sort?.dueDate === 1) {
                achadas.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
              }
              return achadas[0] || null;
            },
          };
        },
        async quitarCobranca(id, opcoes) {
          quitou.push({ id, ...opcoes });
          return { ok: true };
        },
        async reabrirCobranca(id) {
          reabertas.push(id);
          return { ok: true, apagados: 1 };
        },
        async marcarNoGateway(id, dados) {
          marcadas.push({ id, ...dados });
          return true;
        },
        async ajustarDoGateway(id, dados) {
          ajustadas.push({ id, ...dados });
          return { ok: true, mexeu: true };
        },
      },
    },
  };

  return { c: new Cobrador(app), marcado, quitou, webhooks, reabertas, editadas, marcadas, ajustadas };
}

// ── A ORQUESTRAÇÃO INTEIRA, com o Asaas dublado ──────────────────────────
//
// `assinar` encadeia quatro idas à rede e o `asaas.js` só aceita um `buscar`
// injetado por chamada — que `assinar` não repassa, de propósito: ele não
// conhece a rede, conhece o gateway. Então aqui se dubla o GATEWAY.
//
// Faltava um caso assim, e a falta quase custou caro: ao mudar o registro do
// webhook para um método do modelo, nenhum teste reparou que a assinatura
// inteira passava a devolver "fora_do_ar" quando aquele método não existia.
function comAsaasDublado(partes) {
  const original = { ...asaas.cobranca };
  Object.assign(asaas.cobranca, partes);
  return () => Object.assign(asaas.cobranca, original);
}

test("o caminho feliz: cliente, assinatura, ids gravados, webhook e fatura", async () => {
  const restaura = comAsaasDublado({
    async cliente() { return { ok: true, id: "cus_1" }; },
    async assinatura() { return { ok: true, id: "sub_1" }; },
    async garantirWebhook() { return { ok: true }; },
    async primeiraFatura() { return { ok: true, fatura: { url: "https://asaas/i/1", valor: 15990 } }; },
  });

  try {
    const { c, marcado, webhooks } = cobrador({
      credenciais: { tipo: "asaas", chave: "$aact_x", ambiente: "producao", unidade: null, segredo: "s" },
    });

    const r = await c.assinar({
      instancia: "marlon",
      pessoa: { id: "p1", nome: "Ana", documento: "12345678909", email: "a@a.com" },
      plano: { name: "Plano Fit", amount: 15990, cadencia: "monthly" },
      recorrencia: REC,
      unidade: "",
    });

    assert.equal(r.ok, true);
    assert.equal(r.assinatura, "sub_1");
    assert.equal(r.pagamento.url, "https://asaas/i/1");
    // Os ids ANTES da fatura: é o que torna tudo recuperável se o processo
    // morrer no meio.
    assert.equal(marcado[0].assinatura, "sub_1");
    assert.deepEqual(webhooks, [{ tipo: "asaas", unidade: "" }]);
  } finally {
    restaura();
  }
});

test("webhook que falha NÃO derruba a matrícula — ela já está gravada", async () => {
  const restaura = comAsaasDublado({
    async cliente() { return { ok: true, id: "cus_1" }; },
    async assinatura() { return { ok: true, id: "sub_1" }; },
    async garantirWebhook() { throw new Error("asaas fora do ar"); },
    async primeiraFatura() { return { ok: false }; },
  });

  try {
    const { c } = cobrador({
      credenciais: { tipo: "asaas", chave: "$aact_x", ambiente: "producao", unidade: null, segredo: "s" },
      semRegistro: true,
    });

    const r = await c.assinar({
      instancia: "marlon",
      pessoa: { id: "p1", nome: "Ana", documento: "12345678909", email: "a@a.com" },
      plano: { name: "Plano Fit", amount: 15990, cadencia: "monthly" },
      recorrencia: REC,
      unidade: "",
    });

    // Sem webhook o dinheiro ainda entra; o que não acontece é a baixa
    // automática. Derrubar a assinatura por isso seria trocar um problema
    // pequeno por um grande.
    assert.equal(r.ok, true);
    assert.equal(r.assinatura, "sub_1");
    assert.equal(r.pagamento, null);
  } finally {
    restaura();
  }
});

test("sem gateway ativo, recusa sem tocar em nada", async () => {
  const { c } = cobrador({ credenciais: null });
  assert.deepEqual(await c.assinar({ plano: {}, pessoa: {} }), { ok: false, erro: "sem_gateway" });
});

test("gateway que não sabe cobrar recusa — hoje é o caso do Pagar.me", async () => {
  const { c } = cobrador({ credenciais: { tipo: "pagarme", chave: "sk_x" } });
  const r = await c.assinar({ plano: {}, pessoa: {} });
  assert.equal(r.erro, "gateway_nao_cobra");
});

test("o aviso acha a recorrência pela ASSINATURA e quita a cobrança do período", async () => {
  const { c, quitou } = cobrador({
    recorrencias: [{ _id: REC, gateway: { assinatura: "sub_1" }, createdBy: "u1" }],
    cobrancas: [{ _id: "c1", recurrence: REC, periodo: "2026-10-14", status: "open" }],
  });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { subscription: "sub_1", dueDate: "2026-10-14", billingType: "PIX" },
  });

  assert.equal(r.feito, "quitada");
  assert.equal(quitou[0].id, "c1");
  // A forma do Asaas vira a chave do NOSSO catálogo de formas.
  assert.equal(quitou[0].method, "pix");
});

test("evento que não é pagamento é reconhecido e não mexe em nada", async () => {
  // 200 de propósito: o Asaas PARA A FILA inteira daquela conta enquanto
  // insiste num aviso que não deu 2xx.
  const { c, quitou } = cobrador({ recorrencias: [] });

  const r = await c.aplicarAviso("asaas", { event: "PAYMENT_CREATED", payment: {} });
  assert.deepEqual(r, { ok: true, feito: "ignorado", evento: "PAYMENT_CREATED" });
  assert.equal(quitou.length, 0);
});

test("aviso sem dono por aqui também é reconhecido — insistir não melhora", async () => {
  const { c } = cobrador({ recorrencias: [] });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { subscription: "sub_fantasma" },
  });

  assert.equal(r.feito, "sem_dono");
  assert.equal(r.ok, true);
});

test("vencimento que não casa cai na MAIS ANTIGA em aberto", async () => {
  // O dono mudou o vencimento pela tela do Asaas. Deixar o dinheiro sem baixa
  // seria o pior desfecho — a mais antiga em aberto é o que a pessoa pagou.
  const { c, quitou } = cobrador({
    recorrencias: [{ _id: REC, gateway: { assinatura: "sub_1" } }],
    cobrancas: [{ _id: "c9", recurrence: REC, periodo: "2026-10-14", status: "open" }],
  });

  await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { subscription: "sub_1", dueDate: "2026-12-25" },
  });

  assert.equal(quitou[0].id, "c9");
});

test("a URL do webhook leva a INSTÂNCIA — é ela que diz em qual banco procurar", async () => {
  const { c } = cobrador({});
  assert.match(c.urlDoWebhook("marlon", "asaas"), /\/public\/gateway-webhook\/asaas\/marlon$/);
});

// ── O QUE CHEGA DEPOIS DO "PAGO" ─────────────────────────────────────────
//
// *"faltou todos esses"* (15/10/2026), olhando as dezenas de eventos
// desmarcados na tela do Asaas.
//
// A resposta não foi marcar todos: com `sendType: SEQUENTIALLY` os avisos
// chegam um por vez, e assinar "boleto visualizado" põe o aviso de pagamento
// atrás dele na fila. Foram assinados os que MUDAM alguma coisa aqui — e
// estes casos seguram o que cada um faz.

const REGRA_NO_GATEWAY = {
  _id: REC,
  student: "aluno1",
  createdBy: "u1",
  gateway: { assinatura: "sub_1" },
};

test("estorno reabre a cobrança daquele vencimento", async () => {
  const { c, reabertas } = cobrador({
    recorrencias: [REGRA_NO_GATEWAY],
    cobrancas: [{ _id: "cob_1", recurrence: REC, periodo: "2026-10-05", status: "paid" }],
  });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_REFUNDED",
    payment: { subscription: "sub_1", dueDate: "2026-10-05", value: 159.9 },
  });

  assert.equal(r.feito, "reaberta");
  assert.deepEqual(reabertas, ["cob_1"]);
});

test("chargeback e dinheiro desfeito também desfazem a baixa", async () => {
  for (const evento of ["PAYMENT_CHARGEBACK_REQUESTED", "PAYMENT_RECEIVED_IN_CASH_UNDONE"]) {
    const { c, reabertas } = cobrador({
      recorrencias: [REGRA_NO_GATEWAY],
      cobrancas: [{ _id: "cob_1", recurrence: REC, periodo: "2026-10-05", status: "paid" }],
    });

    await c.aplicarAviso("asaas", {
      event: evento,
      payment: { subscription: "sub_1", dueDate: "2026-10-05" },
    });

    assert.deepEqual(reabertas, ["cob_1"], evento);
  }
});

test("estorno sem a cobrança EXATA não reabre nada — palpite aqui é estrago", async () => {
  // A "mais antiga em aberto" existe para achar o que pagar. Num estorno ela
  // reabriria uma cobrança que ninguém pagou.
  const { c, reabertas } = cobrador({
    recorrencias: [REGRA_NO_GATEWAY],
    cobrancas: [{ _id: "cob_outra", recurrence: REC, periodo: "2026-11-05", status: "open" }],
  });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_REFUNDED",
    payment: { subscription: "sub_1", dueDate: "2026-10-05" },
  });

  assert.equal(r.feito, "sem_cobranca");
  assert.deepEqual(reabertas, []);
});

test("assinatura cancelada no gateway CANCELA a regra aqui", async () => {
  // Sem isto, a regra continuaria gerando mensalidade todo mês para quem não
  // tem mais assinatura nenhuma — e calada, porque do nosso lado nada mudou.
  const { c, editadas } = cobrador({ recorrencias: [REGRA_NO_GATEWAY] });

  const r = await c.aplicarAviso(
    "asaas",
    { event: "SUBSCRIPTION_DELETED", subscription: { id: "sub_1" } },
    { t: (k) => k }
  );

  assert.equal(r.feito, "encerrada");
  assert.equal(editadas[0].id, String(REC));
  assert.equal(editadas[0].status, "canceled");
  // O motivo fica na ficha: regra parada sem explicação vira conversa no
  // WhatsApp meses depois.
  assert.ok(editadas[0].canceledReason);
});

test("inativada vale o mesmo que apagada — as duas param de cobrar", async () => {
  const { c, editadas } = cobrador({ recorrencias: [REGRA_NO_GATEWAY] });

  await c.aplicarAviso("asaas", {
    event: "SUBSCRIPTION_INACTIVATED",
    subscription: { id: "sub_1" },
  });

  assert.equal(editadas[0].status, "canceled");
});

test("o evento de assinatura acha o dono mesmo sem `payment` dentro", async () => {
  // Os eventos de assinatura não trazem fatura: o documento deles é a própria
  // assinatura, e o id vem em `subscription.id`.
  const lido = asaas.cobranca.ler({
    event: "SUBSCRIPTION_DELETED",
    subscription: { id: "sub_9", externalReference: "r9" },
  });

  assert.equal(lido.assinatura, "sub_9");
  assert.equal(lido.recorrencia, "r9");
  assert.equal(lido.encerrada, true);
});

test("tudo que o `ler` sabe tratar está ASSINADO", async () => {
  // A ponta que importa: tratar um evento que nunca chega é código morto que
  // parece vivo.
  const eventos = asaas.cobranca.EVENTOS;

  for (const e of ["PAYMENT_RECEIVED", "PAYMENT_REFUNDED", "SUBSCRIPTION_DELETED"]) {
    assert.ok(eventos.includes(e), e);
  }

  // Nome repetido na lista escrita à mão vira 400 no registro — e o registro
  // é melhor esforço, então falharia calado.
  assert.equal(eventos.length, new Set(eventos).size);
});

test("o que NÃO é tratado chega, é reconhecido e não mexe em nada", async () => {
  // A lista inteira foi assinada a pedido dele (*"cadastrei de novo, e de novo
  // veio tudo desmarcado"*, 15/10/2026). O que torna isso seguro é este caso:
  // evento sem regra vira "ignorado" e responde 200 — nunca um palpite sobre
  // o que fazer com um "boleto visualizado".
  const { c, quitou, reabertas, editadas } = cobrador({ recorrencias: [REGRA_NO_GATEWAY] });

  for (const evento of asaas.cobranca.EVENTOS) {
    const lido = asaas.cobranca.ler({ event: evento, payment: {}, subscription: {} });
    if (lido.pago || lido.desfeito || lido.encerrada || lido.situacao || lido.atualizado) continue;

    const r = await c.aplicarAviso("asaas", { event: evento, payment: { subscription: "sub_1" } });
    assert.equal(r.feito, "ignorado", evento);
  }

  assert.deepEqual([quitou, reabertas, editadas], [[], [], []]);
});

// ── O QUE ACONTECE ANTES DE O DINHEIRO CAIR ──────────────────────────────
//
// *"PAYMENT_AUTHORIZED, PAYMENT_AWAITING_RISK_ANALYSIS,
// PAYMENT_REPROVED_BY_RISK_ANALYSIS, PAYMENT_UPDATED,
// PAYMENT_REFUND_IN_PROGRESS deveria tratar esses também"* (15/10/2026).
//
// Nenhum é dinheiro na conta. Eles viram a SITUAÇÃO NO GATEWAY da cobrança —
// a resposta para "por que isto ainda não baixou" — e é isso que estes casos
// seguram: que nenhum deles encoste em `status`.

const COM_COBRANCA = {
  recorrencias: [REGRA_NO_GATEWAY],
  cobrancas: [{ _id: "cob_1", recurrence: REC, periodo: "2026-10-05", status: "open" }],
};

test("autorizado, em análise e recusado viram SITUAÇÃO, e não pagamento", async () => {
  const esperado = {
    PAYMENT_AUTHORIZED: "autorizado",
    PAYMENT_AWAITING_RISK_ANALYSIS: "em_analise",
    PAYMENT_APPROVED_BY_RISK_ANALYSIS: "aprovado",
    PAYMENT_REPROVED_BY_RISK_ANALYSIS: "recusado",
    PAYMENT_REFUND_IN_PROGRESS: "estornando",
  };

  for (const [evento, situacao] of Object.entries(esperado)) {
    const { c, marcadas, quitou, reabertas } = cobrador(COM_COBRANCA);

    const r = await c.aplicarAviso("asaas", {
      event: evento,
      payment: { subscription: "sub_1", dueDate: "2026-10-05", id: "pay_1" },
    });

    assert.equal(r.feito, "situacao", evento);
    assert.equal(marcadas.at(-1).situacao, situacao, evento);
    // O cartão reservou o valor; ninguém recebeu nada. "Paga" aqui continua
    // querendo dizer que os PAGAMENTOS cobrem o valor.
    assert.deepEqual([quitou, reabertas], [[], []], evento);
  }
});

test("o id da fatura fica gravado na primeira visita", async () => {
  // É o que mantém a conversa certa depois de alguém mudar o vencimento pelo
  // painel do Asaas: daí em diante nenhum `periodo` casa.
  const { c, marcadas } = cobrador(COM_COBRANCA);

  await c.aplicarAviso("asaas", {
    event: "PAYMENT_AUTHORIZED",
    payment: { subscription: "sub_1", dueDate: "2026-10-05", id: "pay_42" },
  });

  assert.equal(marcadas[0].pagamento, "pay_42");
});

test("mexeram no vencimento lá: a cobrança daqui acompanha", async () => {
  const { c, ajustadas } = cobrador(COM_COBRANCA);

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_UPDATED",
    payment: { subscription: "sub_1", dueDate: "2026-10-05", value: 180, id: "pay_1" },
  });

  assert.equal(r.feito, "ajustada");
  assert.equal(ajustadas[0].vencimento, "2026-10-05");
  assert.equal(ajustadas[0].valor, 18000);
});

test("situação sem cobrança CERTA não carimba nada — palpite aqui é etiqueta errada", async () => {
  // A "mais antiga em aberto" é um palpite bom para achar o que pagar. Para
  // uma etiqueta de recusa, ela marcaria a cobrança errada.
  const { c, marcadas } = cobrador({
    recorrencias: [REGRA_NO_GATEWAY],
    cobrancas: [{ _id: "cob_outra", recurrence: REC, periodo: "2026-12-05", status: "open" }],
  });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
    payment: { subscription: "sub_1", dueDate: "2026-10-05" },
  });

  assert.equal(r.feito, "sem_cobranca");
  assert.deepEqual(marcadas, []);
});

// ── E O MODELO DA COBRANÇA, do lado de dentro ────────────────────────────
//
// `marcarNoGateway` e `ajustarDoGateway` são os dois únicos lugares onde um
// aviso do gateway escreve numa cobrança. O que estes casos seguram é o
// limite deles: nenhum encosta em `status`, e nenhum reescreve cobrança que
// já tem dinheiro dentro.
test("a situação no gateway não encosta em `status`", async () => {
  const escritas = [];
  const model = new Finance({
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            async updateOne(filtro, mudanca) {
              escritas.push(mudanca.$set);
              return { matchedCount: 1 };
            },
          }),
        };
      },
    },
  });

  await model.marcarNoGateway(String(REC), { pagamento: "pay_1", situacao: "recusado" });

  assert.equal(escritas[0]["gateway.situacao"], "recusado");
  assert.equal(escritas[0]["gateway.pagamento"], "pay_1");
  assert.equal("status" in escritas[0], false);
});

test("situação fora do catálogo é descartada, e não gravada crua", async () => {
  // Um id que a tela não conhece viraria uma etiqueta sem texto. O catálogo é
  // a régua, aqui como em todo lugar.
  const escritas = [];
  const model = new Finance({
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            async updateOne(filtro, mudanca) {
              escritas.push(mudanca.$set);
              return { matchedCount: 1 };
            },
          }),
        };
      },
    },
  });

  await model.marcarNoGateway(String(REC), { situacao: "inventada" });
  assert.equal("gateway.situacao" in escritas[0], false);
});

test("cobrança COM pagamento não é reescrita pelo gateway", async () => {
  // Mudar o valor de uma cobrança que já tem dinheiro dentro transformaria
  // uma quitação em pagamento parcial sem ninguém mexer nela — é o estrago
  // que o `updateCharge` já causou uma vez, com cinco cobranças reais.
  const escritas = [];
  const model = new Finance({
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            async findOne() {
              return { _id: REC, student: "aluno1", amount: 15000 };
            },
            async updateOne(filtro, mudanca) {
              escritas.push(mudanca.$set);
              return { matchedCount: 1 };
            },
          }),
        };
      },
    },
  });
  model.paidByCharge = async () => ({ [String(REC)]: 15000 });

  const r = await model.ajustarDoGateway(String(REC), { vencimento: "2026-11-05", valor: 20000 });

  assert.deepEqual(r, { ok: true, mexeu: false, erro: "tem_pagamento" });
  assert.deepEqual(escritas, []);
});

test("em aberto e sem pagamento, o vencimento novo entra — e o `periodo` não", async () => {
  // `periodo` é a etiqueta que amarra a cobrança à ocorrência da recorrência.
  // Trocá-la faria a mensalidade daquele mês nascer de novo na leitura
  // seguinte.
  const escritas = [];
  const model = new Finance({
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            async findOne() {
              return { _id: REC, student: "aluno1", amount: 15000, periodo: "2026-10-05" };
            },
            async updateOne(filtro, mudanca) {
              escritas.push(mudanca.$set);
              return { matchedCount: 1 };
            },
          }),
        };
      },
    },
  });
  model.paidByCharge = async () => ({});

  const r = await model.ajustarDoGateway(String(REC), { vencimento: "2026-11-05", valor: 20000 });

  assert.equal(r.mexeu, true);
  assert.equal(escritas[0].dueDate.toISOString(), "2026-11-05T00:00:00.000Z");
  assert.equal(escritas[0].amount, 20000);
  assert.equal("periodo" in escritas[0], false);
});

// ── O CARNÊ: UMA FATURA POR PARCELA, UM WEBHOOK POR FATURA ───────────────
//
// *"quando cria o parcelamento no asaas ele gera uma fatura para cada aí vem
// via webhook"* (17/10/2026).
//
// Um carnê não tem assinatura do outro lado — cada parcela é uma fatura
// solta, amarrada às irmãs pelo `installment`. Antes deste caminho, TODO
// aviso de parcela caía em "sem_dono": o dinheiro entrava no Asaas e a
// cobrança daqui ficava aberta para sempre, calada. É o pior desfecho que
// existe num aviso, porque não dá erro em lugar nenhum.
const CARNE = "inst_abc";

const parcelas = () => [
  { _id: "p1", parcela: 1, parcelas: 3, status: "paid", dueDate: "2026-01-10", gateway: { parcelamento: CARNE, pagamento: "pay_1" } },
  { _id: "p2", parcela: 2, parcelas: 3, status: "open", dueDate: "2026-02-10", gateway: { parcelamento: CARNE, pagamento: "pay_2" } },
  { _id: "p3", parcela: 3, parcelas: 3, status: "open", dueDate: "2026-03-10", gateway: { parcelamento: CARNE } },
];

test("o aviso de uma parcela acha a parcela CERTA pelo id da fatura", async () => {
  // É o caminho normal: logo depois de criar o carnê, cada parcela daqui foi
  // carimbada com o id da fatura dela lá.
  const { c, quitou } = cobrador({ recorrencias: [], cobrancas: parcelas() });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { installment: CARNE, id: "pay_2", dueDate: "2026-02-10", billingType: "PIX" },
  });

  assert.equal(r.feito, "quitada");
  assert.equal(quitou[0].id, "p2");
});

test("sem o id carimbado, o NÚMERO da parcela resolve", async () => {
  // Nem toda conta do Asaas manda `installmentNumber`, mas quando manda ele é
  // melhor que o vencimento: não muda se alguém mexer na data pelo painel.
  const { c, quitou } = cobrador({ recorrencias: [], cobrancas: parcelas() });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { installment: CARNE, id: "pay_novo", installmentNumber: 3, dueDate: "2026-09-09" },
  });

  assert.equal(quitou[0].id, "p3");
});

test("e sem o número, o VENCIMENTO dentro do grupo", async () => {
  const { c, quitou } = cobrador({ recorrencias: [], cobrancas: parcelas() });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { installment: CARNE, id: "pay_novo", dueDate: "2026-03-10" },
  });

  assert.equal(quitou[0].id, "p3");
});

test("nada casando, cai na mais antiga EM ABERTO do carnê", async () => {
  // Mesmo palpite da assinatura, e pelo mesmo motivo: deixar o dinheiro sem
  // baixa é pior que baixar a parcela vizinha. A primeira já está paga, então
  // a mais antiga aberta é a segunda.
  const { c, quitou } = cobrador({ recorrencias: [], cobrancas: parcelas() });

  await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { installment: CARNE, id: "pay_fantasma", dueDate: "2027-12-31" },
  });

  assert.equal(quitou[0].id, "p2");
});

test("estorno de parcela NÃO chuta — ou é a exata ou é nenhuma", async () => {
  // O palpite existe para achar o que PAGAR. Num estorno ele reabriria uma
  // parcela que ninguém pagou.
  const { c, reabertas } = cobrador({ recorrencias: [], cobrancas: parcelas() });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_REFUNDED",
    payment: { installment: CARNE, id: "pay_fantasma", dueDate: "2027-12-31" },
  });

  assert.equal(r.feito, "sem_dono");
  assert.deepEqual(reabertas, []);
});

test("aviso de carnê que não é nosso é reconhecido, e não insiste", async () => {
  const { c } = cobrador({ recorrencias: [], cobrancas: parcelas() });

  const r = await c.aplicarAviso("asaas", {
    event: "PAYMENT_RECEIVED",
    payment: { installment: "inst_de_outro_sistema", id: "pay_x" },
  });

  assert.equal(r.feito, "sem_dono");
  assert.equal(r.ok, true);
});

// ── UMA COBRANÇA SÓ, GERADA LÁ (18/10/2026) ───────────────────────────────
//
// *"não deveria ter o checkbox de 'gera no gateway'? e aí já gera lá, traz o
// link, traz tudo"*.
//
// O que estes casos seguram é o que não se vê olhando a tela: o VALOR que
// chega no boleto, e o fio que liga a fatura de lá à cobrança daqui.

test("a cobrança avulsa vai em REAIS, e com o id daqui amarrado", async () => {
  // Centavos mandados crus virariam uma cobrança de R$ 25.000,00 — e quem
  // descobre é o aluno, no boleto.
  const { buscar, feitos } = rede({
    "POST /payments": { corpo: { id: "pay_1", invoiceUrl: "https://asaas/i/pay_1" } },
  });

  const r = await asaas.cobranca.avulsa({
    ...CHAVE,
    cliente: "cus_1",
    cobranca: {
      id: "6710000000000000000000aa",
      valor: 25000,
      vencimento: "2026-11-05T00:00:00.000Z",
      descricao: "Mensalidade de novembro",
      formasDePagamento: [],
    },
    buscar,
  });

  assert.deepEqual(r, { ok: true, id: "pay_1", link: "https://asaas/i/pay_1", situacao: "" });

  const pedido = feitos[0];
  assert.equal(pedido.caminho, "/payments");
  assert.equal(pedido.corpo.value, 250);
  assert.equal(pedido.corpo.dueDate, "2026-11-05");
  // O fio: é por ele que se reconhece o dono mesmo que mexam na data lá.
  assert.equal(pedido.corpo.externalReference, "6710000000000000000000aa");
  // E NÃO é carnê: `installmentCount` aqui criaria doze faturas de uma vez.
  assert.equal(pedido.corpo.installmentCount, undefined);
  // Aberto de propósito: quem escolhe entre pix, boleto e cartão é quem paga.
  assert.equal(pedido.corpo.billingType, "UNDEFINED");
});

test("o gateway fora do ar NÃO estoura — devolve o motivo", async () => {
  // A cobrança daqui já existe quando esta chamada acontece. Uma exceção
  // apagaria a resposta inteira da tela, e quem lançou não saberia se gravou.
  const { buscar } = rede({ "POST /payments": { status: 500, corpo: {} } });

  const r = await asaas.cobranca.avulsa({
    ...CHAVE,
    cliente: "cus_1",
    cobranca: { id: "x", valor: 1000, vencimento: "2026-11-05", formasDePagamento: [] },
    buscar,
  });

  assert.equal(r.ok, false);
  assert.ok(r.erro, "o motivo vem no nosso vocabulário");
});

test("com cartão guardado, a cobrança nasce CREDIT_CARD e com o token", async () => {
  // *"se for cartão, poder cobrar o cartão"* (18/10/2026). Fatura aberta com
  // token junto não cobra nada: o Asaas só debita sozinho o que nasce
  // CREDIT_CARD. É a mesma regra da assinatura.
  const { buscar, feitos } = rede({
    "POST /payments": { corpo: { id: "pay_2", status: "CONFIRMED" } },
  });

  const r = await asaas.cobranca.avulsa({
    ...CHAVE,
    cliente: "cus_1",
    cartao: "tok_abc",
    cobranca: { id: "c1", valor: 15000, vencimento: "2026-11-05", formasDePagamento: [] },
    buscar,
  });

  assert.equal(r.ok, true);
  assert.equal(feitos[0].corpo.billingType, "CREDIT_CARD");
  assert.equal(feitos[0].corpo.creditCardToken, "tok_abc");
  // E o que ela virou lá volta, para a tela separar "mandei cobrar" de "o
  // cartão passou".
  assert.equal(r.situacao, "CONFIRMED");
});

// ── O QUE MUDA AQUI TEM DE MUDAR LÁ (18/10/2026) ─────────────────────────
//
// *"quando editei a descrição, não editou no Asaas"*. O que o aluno lê é a
// fatura DELES: trocar o texto só aqui deixa a tela e o boleto dizendo coisas
// diferentes.

test("a edição vai num PUT, em reais, e sem mexer no que não foi pedido", async () => {
  const { buscar, feitos } = rede({
    "PUT /payments/pay_1": { corpo: { id: "pay_1", invoiceUrl: "https://asaas/i/pay_1" } },
  });

  const r = await asaas.cobranca.atualizar({
    ...CHAVE,
    pagamento: "pay_1",
    cobranca: { valor: 19900, vencimento: "2026-12-01", descricao: "Mensalidade de dezembro" },
    buscar,
  });

  assert.equal(r.ok, true);
  assert.equal(feitos[0].metodo, "PUT");
  assert.equal(feitos[0].corpo.value, 199);
  assert.equal(feitos[0].corpo.dueDate, "2026-12-01");
  assert.equal(feitos[0].corpo.description, "Mensalidade de dezembro");
  // A FORMA não vai quando ninguém falou dela: mandá-la sempre tentaria
  // trocar o tipo de uma fatura que não mudou de tipo, e o Asaas recusa isso
  // em alguns estados — derrubando junto a edição da descrição.
  assert.equal(feitos[0].corpo.billingType, undefined);
});

test("com a forma escolhida, ela vai junto", async () => {
  const { buscar, feitos } = rede({ "PUT /payments/pay_1": { corpo: { id: "pay_1" } } });

  await asaas.cobranca.atualizar({
    ...CHAVE,
    pagamento: "pay_1",
    cobranca: { descricao: "x", formasDePagamento: ["pix"] },
    buscar,
  });

  assert.equal(feitos[0].corpo.billingType, "PIX");
});

test("sem fatura não há o que atualizar — e isso não é erro de rede", async () => {
  const { buscar, feitos } = rede({});

  const r = await asaas.cobranca.atualizar({ ...CHAVE, pagamento: "", cobranca: {}, buscar });

  assert.deepEqual(r, { ok: false, erro: "sem_fatura" });
  assert.equal(feitos.length, 0, "não bate na rede à toa");
});

test("o estorno é um POST no refund, e devolve o estado de lá", async () => {
  // *"quando for cartão de crédito, reembolsar fatura"*. O que acontece AQUI
  // vem pelo webhook (`PAYMENT_REFUNDED`) — esta função só pede.
  const { buscar, feitos } = rede({
    "POST /payments/pay_1/refund": { corpo: { status: "REFUNDED" } },
  });

  const r = await asaas.cobranca.estornar({ ...CHAVE, pagamento: "pay_1", buscar });

  assert.deepEqual(r, { ok: true, situacao: "REFUNDED" });
  assert.equal(feitos[0].caminho, "/payments/pay_1/refund");
});

test("apagar a fatura é um DELETE no pagamento", async () => {
  // *"eu removi a cobrança mas não removeu no asaas"* (18/10/2026). Enquanto
  // ela vive lá, o aluno pode pagar algo que esta casa já esqueceu.
  const { buscar, feitos } = rede({ "DELETE /payments/pay_1": { corpo: { deleted: true } } });

  const r = await asaas.cobranca.apagar({ ...CHAVE, pagamento: "pay_1", buscar });

  assert.deepEqual(r, { ok: true, apagada: true });
  assert.equal(feitos[0].metodo, "DELETE");
  assert.equal(feitos[0].caminho, "/payments/pay_1");
});

test("fatura já paga NÃO se apaga — e o motivo é o deles, exato", async () => {
  // Dinheiro recebido não se apaga, se estorna. A frase do Asaas é melhor que
  // qualquer uma que eu inventasse aqui.
  const { buscar } = rede({
    "DELETE /payments/pay_1": {
      status: 400,
      corpo: { errors: [{ description: "Não é possível excluir uma cobrança já recebida" }] },
    },
  });

  const r = await asaas.cobranca.apagar({ ...CHAVE, pagamento: "pay_1", buscar });

  assert.equal(r.ok, false);
  assert.match(r.detalhe, /já recebida/i);
});

// ── APAGAR O CARNÊ INTEIRO (19/10/2026) ──────────────────────────────────
//
// *"coloque a opção de cancelar e deletar parcelamento no asaas"*.
//
// `DELETE /installments/{id}` desfaz o parcelamento E as parcelas pendentes
// numa chamada só. Apagar parcela a parcela pode parar no meio e deixar meio
// carnê em pé — um estado que ninguém sabe ler depois.
test("apagar o parcelamento bate em /installments/{id} com DELETE", async () => {
  const { buscar, feitos } = rede({
    "DELETE /installments/ins_1": { corpo: { deleted: true } },
  });

  const r = await asaas.cobranca.apagarParcelamento({
    ...CHAVE,
    parcelamento: "ins_1",
    buscar,
  });

  assert.equal(r.ok, true);
  assert.equal(r.apagada, true);
  assert.deepEqual(feitos[0], { caminho: "/installments/ins_1", metodo: "DELETE", corpo: null });
});

test("sem o id do carnê, nem sai da máquina", async () => {
  const { buscar, feitos } = rede({});

  const r = await asaas.cobranca.apagarParcelamento({ ...CHAVE, parcelamento: "", buscar });

  assert.equal(r.ok, false);
  assert.equal(r.erro, "sem_carne");
  assert.equal(feitos.length, 0, "não gasta uma ida à rede para descobrir o óbvio");
});
