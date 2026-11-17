const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const FinanceController = require("../../controllers/Finance.js");

// APAGAR UMA COBRANÇA — as duas travas que ela ganhou em 18/10/2026.
//
// *"eu removi a cobrança mas não removeu no asaas, e não permita remover
// cobrança se tiver pago ou recebido"*.
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. DINHEIRO RECEBIDO TRANCA. Antes a cobrança sumia e os pagamentos dela
//    viravam avulsos: o valor continuava no caixa sem dizer de que era, e o
//    extrato ficava com uma linha que ninguém explicaria meses depois.
// 2. A FATURA DE LÁ VAI JUNTO, e vai PRIMEIRO. Apagar só aqui deixa o aluno
//    recebendo — e podendo pagar — uma cobrança que esta casa já esqueceu.
// 3. SE O GATEWAY RECUSAR, NADA é apagado. Ficar sem ela aqui e com ela lá é
//    exatamente o estrago que a trava existe para evitar.
const USER = { _id: "u1", name: "Marlon" };
const ALUNO = "6a7f8e18ac5f3b34bb4e4723";
const COBRANCA = "6a7f8e18ac5f3b34bb4e4801";

function monta({ cobranca, pago = 0, apagarNoGateway, semGateway = false } = {}) {
  const apagadas = [];
  const noGateway = [];

  const app = fakeApp({
    ...permiteTudo(USER),
    api: {
      finance: {
        async chargeData() {
          return cobranca;
        },
        async paidByCharge() {
          return { [COBRANCA]: pago };
        },
        async deleteCharge(id) {
          apagadas.push(String(id));
          return true;
        },
      },
      user: {
        async data() {
          return { _id: ALUNO, name: "Teste tester", unit: null, customFields: {} };
        },
        async dataStudent() {
          return { _id: ALUNO, name: "Teste tester" };
        },
      },
      paymentGateway: {
        async ativo() {
          return semGateway ? null : { tipo: "asaas", chave: "$aact_x", ambiente: "producao" };
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL", currencies: ["BRL"] };
        },
      },
      recurrence: { async gerar() { return 0; } },
    },
  });

  // O gateway de mentira entra no lugar do módulo: o que interessa aqui é a
  // ORDEM das decisões do controlador, não o HTTP do Asaas — esse tem teste
  // próprio em `test/lib/cobrarNoGateway.test.js`.
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
    },
  });

  FinanceController(app);
  return { app, apagadas, noGateway, restaurar: () => (gateways.de = real) };
}

const ABERTA = { _id: COBRANCA, student: ALUNO, amount: 15000, status: "open" };
const NA_FATURA = { ...ABERTA, gateway: { pagamento: "pay_1" } };

test("cobrança com dinheiro recebido NÃO é apagada", async () => {
  const { app, apagadas, restaurar } = monta({ cobranca: ABERTA, pago: 15000 });
  try {
    const r = await call(app, "delete", `/charges/${COBRANCA}`);

    assert.equal(r.status, 409);
    assert.deepEqual(apagadas, [], "nem o lado de cá");
  } finally {
    restaurar();
  }
});

test("e o PARCIAL tranca igual — meio pagamento também é dinheiro que entrou", async () => {
  const { app, apagadas, restaurar } = monta({ cobranca: ABERTA, pago: 5000 });
  try {
    const r = await call(app, "delete", `/charges/${COBRANCA}`);

    assert.equal(r.status, 409);
    assert.deepEqual(apagadas, []);
  } finally {
    restaurar();
  }
});

test("sem nada recebido, apaga — e apaga a fatura do gateway junto", async () => {
  const { app, apagadas, noGateway, restaurar } = monta({ cobranca: NA_FATURA });
  try {
    const r = await call(app, "delete", `/charges/${COBRANCA}`);

    assert.equal(r.status, 200);
    assert.deepEqual(noGateway, ["pay_1"], "a fatura de lá foi apagada");
    assert.deepEqual(apagadas, [COBRANCA]);
  } finally {
    restaurar();
  }
});

test("se o gateway RECUSA, a cobrança continua aqui", async () => {
  // Ficar sem ela aqui e com ela lá é o pior dos dois mundos: o aluno recebe
  // uma cobrança que esta casa não sabe mais explicar.
  const { app, apagadas, restaurar } = monta({
    cobranca: NA_FATURA,
    apagarNoGateway: { ok: false, erro: "recusado", detalhe: "Cobrança já recebida" },
  });
  try {
    const r = await call(app, "delete", `/charges/${COBRANCA}`);

    assert.equal(r.status, 400);
    assert.match(String(r.body.msg), /recebida/i, "o motivo vem do gateway, exato");
    assert.deepEqual(apagadas, []);
  } finally {
    restaurar();
  }
});

test("cobrança que nunca foi ao gateway apaga sem falar com ninguém", async () => {
  const { app, apagadas, noGateway, restaurar } = monta({ cobranca: ABERTA });
  try {
    const r = await call(app, "delete", `/charges/${COBRANCA}`);

    assert.equal(r.status, 200);
    assert.deepEqual(noGateway, [], "não bate na rede à toa");
    assert.deepEqual(apagadas, [COBRANCA]);
  } finally {
    restaurar();
  }
});
