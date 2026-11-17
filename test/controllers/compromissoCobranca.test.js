const test = require("node:test");
const assert = require("node:assert/strict");

// O gateway é SUBSTITUÍDO antes de carregar o controller: este teste nunca pode
// falar com o Asaas — a chave da casa é de produção.
const emitidas = [];
let respostaDoGateway = { ok: true, id: "pay_123", link: "https://www.asaas.com/i/pay_123" };
require.cache[require.resolve("../../lib/faturaNoGateway.js")] = {
  exports: {
    async emitirAvulsa(app, student, cobranca, opcoes) {
      emitidas.push({ cobranca: String(cobranca._id), porQuem: String(opcoes?.porQuem) });
      if (respostaDoGateway instanceof Error) throw respostaDoGateway;
      return respostaDoGateway;
    },
  },
};

const { fakeApp, call } = require("../helpers/harness.js");
const AppointmentController = require("../../controllers/Appointment.js");
const { situacaoDaCobranca } = require("../../model/Finance_model.js");

// A COBRANÇA ESCOLHIDA NO COMPROMISSO.
//
// *"se eu escolher o serviço, poderia mostrar dois checkbox: gerar cobrança
// asaas se tiver disponível; se não tiver, aparece registrar cobrança — aí
// depois aparece ali na frente se foi pago ou não"* (16/11/2026).
//
// O que se trava:
//   - sem pedido, o de sempre (registrar) — o app e o assistente não conhecem
//     as caixinhas e não podem perder a cobrança que sempre nasceu;
//   - "nenhuma" não cobra; "registrar" não toca no gateway;
//   - "gateway" exige `finance.manage` e, recusado, NÃO desfaz nada;
//   - ao EDITAR, só cobra se pedirem, e nunca duas vezes;
//   - "pago ou não" só sai para quem vê o financeiro.

const EU = { _id: "t1", name: "Marlon" };
const PESSOA = { _id: "p1", name: "Rafael" };
const SERVICO = { _id: "s1", name: "Avaliação Física", price: 80, minutes: 60 };
const QUANDO = new Date("2026-11-18T11:00:00.000Z");

function monta({ permissoes = ["schedule.view", "schedule.manage", "finance.view", "finance.manage"], jaCobrado } = {}) {
  emitidas.length = 0;
  respostaDoGateway = { ok: true, id: "pay_123", link: "https://www.asaas.com/i/pay_123" };
  const cobrancas = [];
  const marcadas = [];
  let existente = jaCobrado || null;
  const trainer = { ...EU, permissions: permissoes };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, p) {
          if (!permissoes.includes(p)) {
            res.status(403).send({ permission: p });
            return false;
          }
          return trainer;
        },
        has(u, p) {
          return u.permissions.includes(p);
        },
      },
    },
    api: {
      user: {
        async hasPermission() {
          return false;
        },
        async dataStudent() {
          return PESSOA;
        },
        async briefByIds() {
          return {};
        },
        async fichasDaAgendaByIds() {
          return { p1: { _id: "p1", name: "Rafael" } };
        },
        async data() {
          return null;
        },
      },
      appointment: {
        async data(ids, id) {
          return { _id: id || "a1", trainer: "t1", student: "p1", date: QUANDO, service: "s1", minutes: 60 };
        },
        async insert() {
          return "a1";
        },
        async update() {
          return true;
        },
        async between() {
          return [{ _id: "a1", trainer: "t1", student: "p1", date: QUANDO }];
        },
      },
      service: {
        async data() {
          return SERVICO;
        },
      },
      finance: {
        async chargeOfAppointment() {
          return existente || undefined;
        },
        async insertCharge(studentId, obj) {
          cobrancas.push(obj);
          existente = { _id: "c1", ...obj };
          return "c1";
        },
        async marcarNoGateway(id, dados) {
          marcadas.push({ id: String(id), ...dados });
          existente = { ...existente, gateway: { pagamento: dados.pagamento, url: dados.url } };
        },
        async cobrancasDosCompromissos(ids) {
          if (!existente) return {};
          return {
            [String(ids[0])]: {
              _id: "c1",
              amount: 80,
              situacao: "aberta",
              link: existente.gateway?.url || "",
            },
          };
        },
      },
      tenant: {
        async currencyFor() {
          return "BRL";
        },
        async dataOfInstance() {
          return {};
        },
        async timezoneOfInstance() {
          return "America/Sao_Paulo";
        },
      },
      actionHistory: { diff: () => ({}) },
    },
  });

  AppointmentController(app);
  return { app, cobrancas, marcadas };
}

const marcar = (app, cobranca) =>
  call(app, "post", "/people/p1/appointments", {
    body: { date: QUANDO.toISOString(), service: "s1", ...(cobranca !== undefined ? { cobranca } : {}) },
  });

test("sem pedido, o de sempre: registra a cobrança, sem gateway", async () => {
  const { app, cobrancas } = monta();
  const r = await marcar(app);
  assert.equal(r.status, 201);
  assert.equal(cobrancas.length, 1);
  assert.equal(cobrancas[0].amount, 80);
  assert.equal(emitidas.length, 0);
});

test('"nenhuma" não cobra', async () => {
  const { app, cobrancas } = monta();
  const r = await marcar(app, "nenhuma");
  assert.equal(r.status, 201);
  assert.equal(cobrancas.length, 0);
  assert.equal(r.body.cobranca, undefined);
});

test('"registrar" registra e devolve a situação — sem tocar no gateway', async () => {
  const { app, cobrancas } = monta();
  const r = await marcar(app, "registrar");
  assert.equal(cobrancas.length, 1);
  assert.equal(emitidas.length, 0);
  assert.equal(r.body.cobranca.situacao, "aberta");
});

test('"gateway" registra E abre a fatura, com o link de volta', async () => {
  const { app, cobrancas, marcadas } = monta();
  const r = await marcar(app, "gateway");
  assert.equal(cobrancas.length, 1);
  assert.equal(emitidas.length, 1);
  assert.deepEqual(marcadas, [{ id: "c1", pagamento: "pay_123", url: "https://www.asaas.com/i/pay_123" }]);
  assert.equal(r.body.link, "https://www.asaas.com/i/pay_123");
  assert.equal(r.body.gatewayErro, undefined);
});

test('"gateway" sem `finance.manage`: registra, mas NÃO cobra lá fora', async () => {
  const { app, cobrancas } = monta({ permissoes: ["schedule.view", "schedule.manage"] });
  const r = await marcar(app, "gateway");
  assert.equal(r.status, 201);
  assert.equal(cobrancas.length, 1);
  assert.equal(emitidas.length, 0);
  assert.equal(r.body.gatewayErro, "sem_permissao");
});

test("gateway recusou: o compromisso e a cobrança ficam, e o motivo sobe", async () => {
  const { app, cobrancas, marcadas } = monta();
  respostaDoGateway = { ok: false, erro: "cpf_invalido" };
  const r = await marcar(app, "gateway");
  assert.equal(r.status, 201);
  assert.equal(cobrancas.length, 1);
  assert.equal(marcadas.length, 0);
  assert.equal(r.body.gatewayErro, "cpf_invalido");
});

test("gateway ESTOUROU: ainda 201 — senão a pessoa tentaria de novo e duplicaria", async () => {
  const { app } = monta();
  respostaDoGateway = new Error("ECONNRESET");
  const erros = [];
  const original = console.error;
  console.error = (...a) => erros.push(a.join(" "));
  try {
    const r = await marcar(app, "gateway");
    assert.equal(r.status, 201);
    assert.equal(r.body.gatewayErro, "fora_do_ar");
  } finally {
    console.error = original;
  }
});

test("editar SEM pedido não cobra — quem só mudou o horário não leva surpresa", async () => {
  const { app, cobrancas } = monta();
  await call(app, "put", "/appointments/a1", { body: { time: "09:00" } });
  assert.equal(cobrancas.length, 0);
});

test("editar pedindo registrar, sem cobrança ainda: registra", async () => {
  const { app, cobrancas } = monta();
  const r = await call(app, "put", "/appointments/a1", { body: { cobranca: "registrar" } });
  assert.equal(cobrancas.length, 1);
  assert.equal(r.body.cobranca.situacao, "aberta");
});

test("editar pedindo de novo, com cobrança já existente: não cria outra", async () => {
  const { app, cobrancas } = monta({
    jaCobrado: { _id: "c0", amount: 80, gateway: { pagamento: "pay_0" } },
  });
  await call(app, "put", "/appointments/a1", { body: { cobranca: "gateway" } });
  assert.equal(cobrancas.length, 0);
  assert.equal(emitidas.length, 0, "a fatura que já existe lá não é emitida de novo");
});

test("a lista traz a cobrança de cada compromisso para quem vê o financeiro", async () => {
  const { app } = monta({ jaCobrado: { _id: "c0", amount: 80 } });
  const r = await call(app, "get", "/appointments/lista", {
    query: { from: "2026-11-16T03:00:00Z", to: "2026-11-23T03:00:00Z" },
  });
  assert.equal(r.body.financeiro, true);
  assert.equal(r.body.rows[0].cobranca.situacao, "aberta");
});

test("sem `finance.view`, a lista não diz se foi pago", async () => {
  const { app } = monta({
    permissoes: ["schedule.view", "schedule.manage"],
    jaCobrado: { _id: "c0", amount: 80 },
  });
  const r = await call(app, "get", "/appointments/lista", {
    query: { from: "2026-11-16T03:00:00Z", to: "2026-11-23T03:00:00Z" },
  });
  assert.equal(r.body.financeiro, false);
  assert.equal(r.body.rows[0].cobranca, null);
});

test("a situação de UM compromisso, para o formulário aberto pelo calendário", async () => {
  const { app } = monta({ jaCobrado: { _id: "c0", amount: 80 } });
  const r = await call(app, "get", "/appointments/a1/cobranca");
  assert.equal(r.body.cobranca.situacao, "aberta");

  const semPermissao = monta({ permissoes: ["schedule.view"] });
  const r2 = await call(semPermissao.app, "get", "/appointments/a1/cobranca");
  assert.equal(r2.status, 403);
});

test("a situação: cancelada, paga, atrasada, aberta — nessa precedência", () => {
  assert.equal(situacaoDaCobranca({ status: "canceled", falta: 80 }), "cancelada");
  assert.equal(situacaoDaCobranca({ status: "canceled", falta: 0 }), "cancelada");
  assert.equal(situacaoDaCobranca({ status: "open", falta: 0 }), "paga");
  assert.equal(situacaoDaCobranca({ status: "open", falta: 30, atrasada: true }), "atrasada");
  assert.equal(situacaoDaCobranca({ status: "open", falta: 80, atrasada: false }), "aberta");
});
