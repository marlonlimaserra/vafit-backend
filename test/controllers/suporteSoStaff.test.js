const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const SupportController = require("../../controllers/Support.js");

// A AJUDA É SÓ DE STAFF.
//
// *"meu medo é alguém conseguir acessar dados de outros clientes"* (14/11/2026).
//
// Os chamados de suporte são por INSTÂNCIA — um balcão por academia, não por
// pessoa. `meus(instance)` devolve TODOS os da casa. As rotas eram só `verify`
// ("estar logado"), então QUALQUER aluno autenticado listava os chamados da
// academia, lia os fios e baixava os anexos da conversa dela com o suporte. A
// tela mora no menu do profissional; faltava a trava no servidor.

function monta({ tipo = "trainer" } = {}) {
  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify() {
          return { _id: "u1", name: "Quem", type: tipo };
        },
      },
    },
    api: {
      support: {
        async naoLidos() {
          return 0;
        },
      },
    },
  });
  SupportController(app);
  return app;
}

const ROTAS = [
  ["get", "/me/support"],
  ["get", "/me/support/unread"],
  ["get", "/me/tickets/qualquer"],
  ["post", "/me/tickets"],
  ["post", "/me/tickets/qualquer/messages"],
  ["post", "/me/tickets/anexo"],
  ["get", "/me/tickets/anexo/qualquer"],
];

for (const [metodo, rota] of ROTAS) {
  test(`aluno é barrado em ${metodo.toUpperCase()} ${rota}`, async () => {
    const app = monta({ tipo: "student" });
    const r = await call(app, metodo, rota, { body: {} });
    assert.equal(r.status, 403, "aluno não pode tocar no suporte da casa");
  });
}

test("staff (profissional) NÃO é barrado — a trava é cirúrgica", async () => {
  const app = monta({ tipo: "trainer" });
  const r = await call(app, "get", "/me/support/unread");
  assert.notEqual(r.status, 403);
  assert.equal(r.body.unread, 0);
});
