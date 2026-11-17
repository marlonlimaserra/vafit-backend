const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const FinanceController = require("../../controllers/Finance.js");

// CANCELAR A ASSINATURA ENCERRA O QUE AINDA NÃO VENCEU.
//
// *"se cancelar, cancela no asaas?"* (19/10/2026) — não cancelava.
//
// A geração trabalha com 15 dias de antecedência, então quase sempre existe
// uma mensalidade já criada, com boleto vivo, para um mês que a pessoa não
// vai usar. Cancelar a regra parava de GERAR e deixava essa de pé: a pessoa
// cancelava e recebia cobrança assim mesmo.
//
// ── A LINHA QUE ESTE ARQUIVO DEFENDE ──────────────────────────────────────
//
// Só o que ainda NÃO VENCEU, e só o que não recebeu nada. O mês que já passou
// e não foi pago é dívida — cancelar a assinatura não a perdoa, e sumir com
// ela do "a receber" esconderia dinheiro que a casa tem a receber.
const USER = { _id: "u1", name: "Marlon" };
const ALUNO = "6a7f8e18ac5f3b34bb4e4723";
const REGRA = "6a7f8e18ac5f3b34bb4e4901";

const FUTURA = {
  _id: "6a7f8e18ac5f3b34bb4e4801",
  student: ALUNO,
  recurrence: REGRA,
  status: "open",
  amount: 2000,
  gateway: { pagamento: "pay_1" },
};

function monta({ futuras = [FUTURA], pagos = {}, noGateway, antes } = {}) {
  const apagadasLa = [];
  const atualizadas = [];
  const limpas = [];

  const app = fakeApp({
    ...permiteTudo(USER),
    api: {
      recurrence: {
        async data() {
          return antes || { _id: REGRA, student: ALUNO, status: "active", amount: 2000 };
        },
        async update() {
          return true;
        },
        async gerar() {
          return 0;
        },
      },
      finance: {
        async futurasDaRecorrencia() {
          return futuras;
        },
        async paidByCharge() {
          return pagos;
        },
        async updateCharge(id, corpo) {
          atualizadas.push({ id: String(id), corpo });
          return true;
        },
        async limparNoGateway(id) {
          limpas.push(String(id));
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
      membership: { async data() { return null; } },
      tenant: { async currencyFor(m) { return m; } },
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
        apagadasLa.push(pagamento);
        return noGateway ?? { ok: true, apagada: true };
      },
    },
  });

  FinanceController(app);
  return { app, apagadasLa, atualizadas, limpas, restaurar: () => (gateways.de = real) };
}

const cancelar = (app) =>
  call(app, "put", `/recurrences/${REGRA}`, { body: { status: "canceled" } });

test("cancelar a assinatura apaga a fatura do que ainda não venceu", async () => {
  const { app, apagadasLa, atualizadas, limpas, restaurar } = monta();
  try {
    const r = await cancelar(app);

    assert.equal(r.status, 200);
    assert.deepEqual(apagadasLa, ["pay_1"]);
    assert.deepEqual(limpas, [String(FUTURA._id)], "o link e o id não ficam para trás");
    assert.deepEqual(atualizadas, [{ id: String(FUTURA._id), corpo: { status: "canceled" } }]);
    assert.equal(r.body.encerradas, 1);
  } finally {
    restaurar();
  }
});

test("mensalidade ADIANTADA não é cancelada — ela tem dinheiro dentro", async () => {
  const { app, apagadasLa, atualizadas, restaurar } = monta({
    pagos: { [String(FUTURA._id)]: 2000 },
  });
  try {
    await cancelar(app);

    assert.deepEqual(apagadasLa, [], "nem fala com o gateway");
    assert.deepEqual(atualizadas, []);
  } finally {
    restaurar();
  }
});

test("se o gateway RECUSA uma, ela fica em pé e o laço segue", async () => {
  // Recusar uma fatura que não venceu quer dizer, na prática, que ela acabou
  // de ser paga. Cancelá-la aqui esconderia o recebimento.
  const { app, atualizadas, restaurar } = monta({
    noGateway: { ok: false, erro: "recusado", detalhe: "Cobrança já recebida" },
  });
  try {
    const r = await cancelar(app);

    assert.equal(r.status, 200, "o cancelamento da REGRA não falha por causa disso");
    assert.deepEqual(atualizadas, []);
  } finally {
    restaurar();
  }
});

test("editar SEM cancelar não encosta em mensalidade nenhuma", async () => {
  const { app, apagadasLa, atualizadas, restaurar } = monta();
  try {
    await call(app, "put", `/recurrences/${REGRA}`, { body: { description: "Plano Fit" } });

    assert.deepEqual(apagadasLa, []);
    assert.deepEqual(atualizadas, []);
  } finally {
    restaurar();
  }
});

test("cancelar o que JÁ estava cancelado não refaz o trabalho", async () => {
  const { app, apagadasLa, restaurar } = monta({
    antes: { _id: REGRA, student: ALUNO, status: "canceled", amount: 2000 },
  });
  try {
    await cancelar(app);
    assert.deepEqual(apagadasLa, []);
  } finally {
    restaurar();
  }
});

test("REATIVAR não apaga nada — o caminho de volta é só um status", async () => {
  const { app, apagadasLa, restaurar } = monta({
    antes: { _id: REGRA, student: ALUNO, status: "canceled", amount: 2000 },
  });
  try {
    await call(app, "put", `/recurrences/${REGRA}`, { body: { status: "active" } });
    assert.deepEqual(apagadasLa, []);
  } finally {
    restaurar();
  }
});
