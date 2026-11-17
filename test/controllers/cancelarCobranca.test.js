const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const FinanceController = require("../../controllers/Finance.js");

// CANCELAR UMA COBRANÇA QUE VIVE NO GATEWAY.
//
// *"o cancelar também cancela no asaas?"* (19/10/2026) — e não cancelava. A
// linha ficava riscada nesta tela e a fatura seguia viva lá: link válido,
// cobrança por e-mail, pix que abre. O aluno pagava algo que esta casa já
// tinha dado por encerrado, e o dinheiro entrava sem dono deste lado.
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. CANCELAR AQUI CANCELA LÁ. No Asaas não existe "cancelar": uma fatura
//    pendente se cancela APAGANDO, que é o mesmo comando de remover.
// 2. LÁ PRIMEIRO. Se o gateway recusar, nada muda aqui — cancelada aqui e
//    viva lá é o pior dos dois estados, porque ninguém mais olha para ela.
// 3. O RASTRO SOME JUNTO. Sem fatura, guardar o link e o id dela seria
//    oferecer um link para o 404 e um estorno para o que não existe.
const USER = { _id: "u1", name: "Marlon" };
const ALUNO = "6a7f8e18ac5f3b34bb4e4723";
const COBRANCA = "6a7f8e18ac5f3b34bb4e4801";

function monta({ cobranca, apagarNoGateway } = {}) {
  const noGateway = [];
  const gravados = [];
  const limpas = [];
  let atual = cobranca;

  const app = fakeApp({
    ...permiteTudo(USER),
    api: {
      finance: {
        async chargeData() {
          return atual;
        },
        async updateCharge(id, corpo) {
          gravados.push(corpo);
          atual = { ...atual, ...corpo };
          return true;
        },
        async limparNoGateway(id) {
          limpas.push(String(id));
          return true;
        },
        async marcarNoGateway() {
          return true;
        },
      },
      user: {
        async data() {
          return { _id: ALUNO, name: "Teste tester", unit: null, customFields: {} };
        },
      },
      paymentGateway: {
        async ativo() {
          return { tipo: "asaas", chave: "$aact_x", ambiente: "producao" };
        },
      },
      tenant: {
        async currencyFor(m) {
          return m;
        },
      },
      actionHistory: { diff: () => ({}) },
    },
  });

  const gateways = require("../../lib/gateways");
  const real = gateways.de;
  gateways.de = () => ({
    chave: "asaas",
    cobranca: {
      async cliente() {
        return { ok: true, id: "cus_1" };
      },
      async apagar({ pagamento }) {
        noGateway.push(pagamento);
        return apagarNoGateway ?? { ok: true, apagada: true };
      },
      async atualizar() {
        return { ok: true };
      },
    },
  });

  FinanceController(app);
  return { app, gravados, limpas, noGateway, restaurar: () => (gateways.de = real) };
}

const ABERTA = { _id: COBRANCA, student: ALUNO, amount: 15000, status: "open" };
const NA_FATURA = { ...ABERTA, gateway: { pagamento: "pay_1", url: "https://asaas/i/pay_1" } };

test("cancelar uma cobrança com fatura cancela a fatura também", async () => {
  const { app, gravados, noGateway, limpas, restaurar } = monta({ cobranca: NA_FATURA });
  try {
    const r = await call(app, "put", `/charges/${COBRANCA}`, { body: { status: "canceled" } });

    assert.equal(r.status, 200);
    assert.deepEqual(noGateway, ["pay_1"], "a fatura de lá foi cancelada");
    assert.equal(gravados[0].status, "canceled");
    assert.deepEqual(limpas, [COBRANCA], "e o link e o id dela não ficam para trás");
  } finally {
    restaurar();
  }
});

test("se o gateway RECUSA, a cobrança continua EM ABERTO aqui", async () => {
  // A recusa mais comum é a fatura já ter sido paga — e para essa o caminho
  // não é cancelar, é estornar. Marcar "cancelada" aqui esconderia da tela
  // uma cobrança que recebeu dinheiro.
  const { app, gravados, limpas, restaurar } = monta({
    cobranca: NA_FATURA,
    apagarNoGateway: { ok: false, erro: "recusado", detalhe: "Cobrança já recebida" },
  });
  try {
    const r = await call(app, "put", `/charges/${COBRANCA}`, { body: { status: "canceled" } });

    assert.equal(r.status, 400);
    assert.match(String(r.body.msg), /recebida/i, "o motivo vem do gateway, exato");
    assert.deepEqual(gravados, [], "nada foi gravado aqui");
    assert.deepEqual(limpas, []);
  } finally {
    restaurar();
  }
});

test("cobrança que nunca foi ao gateway cancela sem falar com ninguém", async () => {
  const { app, gravados, noGateway, restaurar } = monta({ cobranca: ABERTA });
  try {
    const r = await call(app, "put", `/charges/${COBRANCA}`, { body: { status: "canceled" } });

    assert.equal(r.status, 200);
    assert.deepEqual(noGateway, [], "não bate na rede à toa");
    assert.equal(gravados[0].status, "canceled");
  } finally {
    restaurar();
  }
});

test("cancelar o que JÁ estava cancelado não cancela de novo lá", async () => {
  // Uma seleção em lote repassa as canceladas junto. Apagar outra vez traria
  // uma recusa do gateway que ninguém causou.
  const { app, noGateway, restaurar } = monta({
    cobranca: { ...NA_FATURA, status: "canceled" },
  });
  try {
    await call(app, "put", `/charges/${COBRANCA}`, { body: { status: "canceled" } });

    assert.deepEqual(noGateway, []);
  } finally {
    restaurar();
  }
});

test("editar SEM cancelar não encosta na fatura", async () => {
  // O caminho de sempre: o PUT sincroniza a descrição, e não apaga nada.
  const { app, noGateway, limpas, restaurar } = monta({ cobranca: NA_FATURA });
  try {
    await call(app, "put", `/charges/${COBRANCA}`, { body: { description: "Mensalidade" } });

    assert.deepEqual(noGateway, []);
    assert.deepEqual(limpas, []);
  } finally {
    restaurar();
  }
});
