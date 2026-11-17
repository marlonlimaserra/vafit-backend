const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const FinanceController = require("../../controllers/Finance.js");

// CANCELAR E APAGAR UM PARCELAMENTO INTEIRO.
//
// *"coloque o botão para ver as faturas do parcelamento, opção de cancelar e
// deletar parcelamento no asaas"* (19/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. UMA CHAMADA SÓ ao gateway (`DELETE /installments`), e não doze. Apagar
//    parcela a parcela pode parar no meio e deixar meio carnê em pé.
// 2. LÁ PRIMEIRO. Gateway recusou, nada muda aqui.
// 3. APAGAR TRANCA COM DINHEIRO DENTRO; cancelar não — cancelar preserva a
//    história, e é o caminho certo para um carnê que já recebeu.
const USER = { _id: "u1", name: "Marlon" };
const ALUNO = "6a7f8e18ac5f3b34bb4e4723";
const GRUPO = "6a7f8e18ac5f3b34bb4e4901";

const PARCELA = (n, extra = {}) => ({
  _id: `6a7f8e18ac5f3b34bb4e490${n}`,
  student: ALUNO,
  installment: GRUPO,
  parcela: n,
  parcelas: 2,
  amount: 5000,
  status: "open",
  gateway: { parcelamento: "ins_1" },
  ...extra,
});

function monta({ parcelas = [PARCELA(1), PARCELA(2)], pagos = {}, noGateway } = {}) {
  const chamadas = [];
  const canceladas = [];
  const apagadas = [];

  const app = fakeApp({
    ...permiteTudo(USER),
    api: {
      finance: {
        async parcelasDoGrupo() {
          return parcelas;
        },
        async paidByCharge() {
          return pagos;
        },
        async cancelarParcelamento(g) {
          canceladas.push(String(g));
          return parcelas.length;
        },
        async apagarParcelamento(g) {
          apagadas.push(String(g));
          return parcelas.length;
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
      async apagarParcelamento({ parcelamento }) {
        chamadas.push(parcelamento);
        return noGateway ?? { ok: true, apagada: true };
      },
    },
  });

  FinanceController(app);
  return { app, chamadas, canceladas, apagadas, restaurar: () => (gateways.de = real) };
}

test("cancelar desfaz o carnê no gateway com UMA chamada, e risca as parcelas", async () => {
  const { app, chamadas, canceladas, restaurar } = monta();
  try {
    const r = await call(app, "post", `/installments/${GRUPO}/cancelar`);

    assert.equal(r.status, 200);
    assert.deepEqual(chamadas, ["ins_1"], "uma só, pelo id do parcelamento");
    assert.deepEqual(canceladas, [GRUPO]);
  } finally {
    restaurar();
  }
});

test("se o gateway recusa, as parcelas continuam em aberto aqui", async () => {
  const { app, canceladas, restaurar } = monta({
    noGateway: { ok: false, erro: "recusado", detalhe: "Parcela já recebida" },
  });
  try {
    const r = await call(app, "post", `/installments/${GRUPO}/cancelar`);

    assert.equal(r.status, 400);
    assert.match(String(r.body.msg), /recebida/i);
    assert.deepEqual(canceladas, []);
  } finally {
    restaurar();
  }
});

test("apagar some com as parcelas, e apaga o carnê lá primeiro", async () => {
  const { app, chamadas, apagadas, restaurar } = monta();
  try {
    const r = await call(app, "delete", `/installments/${GRUPO}`);

    assert.equal(r.status, 200);
    assert.deepEqual(chamadas, ["ins_1"]);
    assert.deepEqual(apagadas, [GRUPO]);
  } finally {
    restaurar();
  }
});

test("com UMA parcela paga, apagar é recusado — e nem fala com o gateway", async () => {
  // O valor continuaria no caixa sem dizer de que era. O caminho é cancelar,
  // que preserva a história.
  const { app, chamadas, apagadas, restaurar } = monta({
    pagos: { "6a7f8e18ac5f3b34bb4e4901": 5000 },
  });
  try {
    const r = await call(app, "delete", `/installments/${GRUPO}`);

    assert.equal(r.status, 409);
    assert.deepEqual(chamadas, [], "a trava é daqui, e vem antes da rede");
    assert.deepEqual(apagadas, []);
  } finally {
    restaurar();
  }
});

test("mas CANCELAR um carnê que já recebeu continua valendo", async () => {
  const { app, canceladas, restaurar } = monta({
    pagos: { "6a7f8e18ac5f3b34bb4e4901": 5000 },
  });
  try {
    const r = await call(app, "post", `/installments/${GRUPO}/cancelar`);

    assert.equal(r.status, 200);
    assert.deepEqual(canceladas, [GRUPO]);
  } finally {
    restaurar();
  }
});

test("carnê que nunca foi ao gateway se desfaz sem falar com ninguém", async () => {
  const { app, chamadas, apagadas, restaurar } = monta({
    parcelas: [PARCELA(1, { gateway: null }), PARCELA(2, { gateway: null })],
  });
  try {
    const r = await call(app, "delete", `/installments/${GRUPO}`);

    assert.equal(r.status, 200);
    assert.deepEqual(chamadas, []);
    assert.deepEqual(apagadas, [GRUPO]);
  } finally {
    restaurar();
  }
});

test("grupo que não existe é 404, e não um sucesso vazio", async () => {
  const { app, restaurar } = monta({ parcelas: [] });
  try {
    const r = await call(app, "delete", `/installments/${GRUPO}`);
    assert.equal(r.status, 404);
  } finally {
    restaurar();
  }
});
