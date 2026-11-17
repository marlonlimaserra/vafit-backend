const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const FinanceController = require("../../controllers/Finance.js");

// AS CHAVES DA MENSALIDADE (15/10/2026).
//
// *"crie uma permissão que permite alterar o valor ou não ao criar
// recorrência, e também permissão de criar recorrência ou deletar"*.
//
// As três nasceram de dentro de `finance.manage`, e a mais fina é a do VALOR:
// a recepção matricula no plano do cardápio, e só quem manda no preço dá
// desconto. O que estes casos seguram é que a regra vive no SERVIDOR — campo
// desabilitado na tela é sugestão, e o navegador manda o que o F12 mandar.
const USER = { _id: "u1", name: "Marlon" };
const ALUNO = "6a7f8e18ac5f3b34bb4e4723";
const PLANO = "6a7f8e18ac5f3b34bb4e4a01";

function monta({ negadas = [], regra = null } = {}) {
  const permissao = permiteTudo(USER, negadas);
  const criadas = [];
  const editadas = [];
  const apagadas = [];

  const app = fakeApp({
    ...permissao,
    api: {
      user: {
        async dataStudent() {
          return { _id: ALUNO, name: "Ana" };
        },
      },
      membership: {
        async data(id) {
          return String(id) === PLANO ? { _id: PLANO, name: "Plano Fit", amount: 15000 } : null;
        },
      },
      tenant: {
        async currencyFor(m) {
          return m || "BRL";
        },
      },
      finance: {},
      recurrence: {
        async insert(aluno, obj) {
          criadas.push(obj);
          return "r1";
        },
        async update(id, obj) {
          editadas.push({ id, obj });
          return true;
        },
        async remove(id) {
          apagadas.push(id);
          return true;
        },
        async data() {
          return regra;
        },
        async gerar() {
          return 0;
        },
      },
    },
  });

  FinanceController(app);
  return { app, criadas, editadas, apagadas, pedidas: permissao.pedidas };
}

const criar = (app, corpo) =>
  call(app, "post", `/people/${ALUNO}/recurrences`, { body: corpo });

test("criar pede finance.recurrence, e não a chave genérica do financeiro", async () => {
  const { app, pedidas } = monta();

  await criar(app, { amount: 8000, cadencia: "monthly" });
  assert.equal(pedidas.at(-1), "finance.recurrence");
});

test("apagar pede a chave PRÓPRIA — não é o mesmo poder que criar", async () => {
  const { app, pedidas } = monta({ regra: { _id: "r1", student: ALUNO } });

  await call(app, "delete", "/recurrences/r1");
  assert.equal(pedidas.at(-1), "finance.recurrenceDelete");
});

test("sem finance.recurrence, criar é 403", async () => {
  const { app, criadas } = monta({ negadas: ["finance.recurrence"] });

  const r = await criar(app, { amount: 8000 });
  assert.equal(r.status, 403);
  assert.deepEqual(criadas, []);
});

test("sem a chave do VALOR, o preço vem do plano — não do formulário", async () => {
  // O desconto de 150 para 10 é exatamente o que a permissão existe para
  // impedir, e ele chega por requisição, não pela tela.
  const { app, criadas } = monta({ negadas: ["finance.recurrenceAmount"] });

  const r = await criar(app, { amount: 1000, membership: PLANO });

  assert.equal(r.status, 201);
  assert.equal(criadas[0].amount, 15000);
});

test("sem a chave do VALOR e sem plano, a casa recusa em vez de inventar preço", async () => {
  const { app, criadas } = monta({ negadas: ["finance.recurrenceAmount"] });

  const r = await criar(app, { amount: 1000 });

  assert.equal(r.status, 403);
  assert.equal(r.body.permission, "finance.recurrenceAmount");
  assert.deepEqual(criadas, []);
});

test("com a chave do VALOR, o que veio no formulário vale", async () => {
  const { app, criadas } = monta();

  await criar(app, { amount: 1000, membership: PLANO });
  assert.equal(criadas[0].amount, 1000);
});

test("editar sem a chave do VALOR não reprecifica o que já estava combinado", async () => {
  // Mexer na data de fim de uma mensalidade com desconto antigo não pode
  // devolvê-la ao preço de tabela pelas costas de quem edita.
  const { app, editadas } = monta({
    negadas: ["finance.recurrenceAmount"],
    regra: { _id: "r1", student: ALUNO, amount: 9900, membership: PLANO },
  });

  await call(app, "put", "/recurrences/r1", { body: { amount: 100, endsAt: "2027-01-01" } });
  assert.equal(editadas[0].obj.amount, 9900);
});

test("editar trocando de plano, sem a chave, passa a valer o preço do plano novo", async () => {
  const { app, editadas } = monta({
    negadas: ["finance.recurrenceAmount"],
    regra: { _id: "r1", student: ALUNO, amount: 9900, membership: "6a7f8e18ac5f3b34bb4e4a99" },
  });

  await call(app, "put", "/recurrences/r1", { body: { amount: 100, membership: PLANO } });
  assert.equal(editadas[0].obj.amount, 15000);
});

test("um PUT que não fala de dinheiro não carimba valor nenhum", async () => {
  // A lição do `updateCharge`: montar o documento inteiro a cada escrita
  // transforma edição parcial em apagamento silencioso.
  const { app, editadas } = monta({
    negadas: ["finance.recurrenceAmount"],
    regra: { _id: "r1", student: ALUNO, amount: 9900, membership: PLANO },
  });

  await call(app, "put", "/recurrences/r1", { body: { endsAt: "2027-01-01" } });
  assert.equal("amount" in editadas[0].obj, false);
});
