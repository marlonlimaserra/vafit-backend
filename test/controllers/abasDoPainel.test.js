const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const Controller = require("../../controllers/AbaDoPainel.js");

// AS ABAS COMPARTILHADAS DO PAINEL.
//
// *"quem poderia ver aquela aba, quais departamentos etc…"* (24/10/2026).
//
// ── O QUE ESTES CASOS SEGURAM ───────────────────────────────────────────
//
// LER é a porta do painel (`people.view`); ESCREVER é administração da conta
// (`users.manage`), igual aos Departamentos que esta aba endereça. Trocar uma
// pela outra não quebra teste nenhum de tela — o painel continua abrindo —, e
// é exatamente o tipo de erro que só aparece quando alguém de fora monta a
// aba da casa inteira.
//
// E o que o painel RECEBE: a aba sem o público dela. Mandar a lista de quem
// mais vê aquela aba conta a uma recepcionista que existe uma tela endereçada
// a três diretores.
function monta({ permissoes = ["people.view", "users.manage"] } = {}) {
  const pedidas = [];
  const gravado = {};

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          pedidas.push(permissao);
          if (!permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon" };
        },
      },
    },
    api: {
      user: {
        async hasPermission(user, chave) {
          return permissoes.includes(chave);
        },
      },
      abaDoPainel: {
        async daPessoa(user) {
          gravado.para = user;
          return [
            {
              _id: "a1",
              nome: "Cobrança",
              pecas: ["dinheiro.atrasado"],
              publico: { todos: false, pessoas: ["diretor"] },
            },
          ];
        },
        async list() {
          return [
            {
              _id: "a1",
              nome: "Cobrança",
              pecas: ["dinheiro.atrasado"],
              ordem: 2,
              publico: { todos: false, papeis: ["p1"], departamentos: ["d1"], pessoas: [] },
            },
          ];
        },
        async data(id) {
          return String(id) === "sumiu" ? undefined : { _id: String(id), nome: "Cobrança" };
        },
        async insert(obj, extras) {
          gravado.criou = { obj, extras };
          return obj.__erro ? { erro: obj.__erro } : { id: "a1" };
        },
        async update(id) {
          return String(id) === "sumiu" ? { erro: "nao_encontrado" } : { id: "a1" };
        },
        async remove() {
          return true;
        },
        async reordenar(ids) {
          gravado.ordem = ids;
          return Array.isArray(ids) && ids.length ? { ok: true } : { ok: false };
        },
      },
    },
  });

  Controller(app);
  return { app, pedidas, gravado };
}

test("LER as minhas abas pede `people.view` — é a porta do painel", async () => {
  const { app, pedidas } = monta();
  await call(app, "get", "/dashboard/abas");
  assert.deepEqual(pedidas, ["people.view"]);
});

test("quem NÃO administra recebe a aba sem o público dela", async () => {
  const { app } = monta({ permissoes: ["people.view"] });
  const r = await call(app, "get", "/dashboard/abas");

  assert.deepEqual(r.body.rows, [{ id: "a1", nome: "Cobrança", pecas: ["dinheiro.atrasado"] }]);
  assert.equal("publico" in r.body.rows[0], false);
});

// Para quem administra ele vem junto: é quem vai editá-lo, e ele já estaria a
// uma chamada de distância em `/dashboard/abas/todas`. Esconder aqui só
// custaria uma segunda ida ao servidor ao abrir a janela.
test("quem administra recebe o público junto, para poder editar", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/dashboard/abas");

  assert.deepEqual(r.body.rows[0].publico, {
    todos: false,
    papeis: [],
    departamentos: [],
    pessoas: ["diretor"],
  });
});

test("o painel é avisado se pode gerenciar — para não desenhar um botão que falha", async () => {
  const comAdmin = monta();
  assert.equal((await call(comAdmin.app, "get", "/dashboard/abas")).body.podeGerenciar, true);

  const semAdmin = monta({ permissoes: ["people.view"] });
  assert.equal((await call(semAdmin.app, "get", "/dashboard/abas")).body.podeGerenciar, false);
});

test("a lista CHEIA, com o público, pede `users.manage`", async () => {
  const { app, pedidas } = monta({ permissoes: ["people.view"] });
  const r = await call(app, "get", "/dashboard/abas/todas");

  assert.deepEqual(pedidas, ["users.manage"]);
  assert.equal(r.status, 403);
});

test("a lista cheia devolve os ids como TEXTO — ObjectId vira `{}` no JSON", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/dashboard/abas/todas");

  assert.deepEqual(r.body.rows[0].publico, {
    todos: false,
    papeis: ["p1"],
    departamentos: ["d1"],
    pessoas: [],
  });
});

test("ESCREVER pede `users.manage`, não `people.view`", async () => {
  for (const [metodo, rota] of [
    ["post", "/dashboard/abas"],
    ["put", "/dashboard/abas/a1"],
    ["delete", "/dashboard/abas/a1"],
  ]) {
    const { app, pedidas } = monta({ permissoes: ["people.view"] });
    const r = await call(app, metodo, rota, { body: {} });
    assert.deepEqual(pedidas, ["users.manage"], metodo + " " + rota);
    assert.equal(r.status, 403, metodo + " " + rota);
  }
});

test("criar guarda QUEM criou", async () => {
  const { app, gravado } = monta();
  await call(app, "post", "/dashboard/abas", { body: { nome: "Cobrança" } });
  assert.equal(gravado.criou.extras.porQuem, "u1");
});

test("criar sem nome devolve 400 com a mensagem traduzida", async () => {
  const { app } = monta();
  const r = await call(app, "post", "/dashboard/abas", { body: { __erro: "sem_nome" } });

  assert.equal(r.status, 400);
  assert.match(r.body.msg, /nome/i);
  assert.equal(r.body.code, "sem_nome");
});

// `/ordem` está registrada ANTES de `/:id`. Com a ordem trocada, este pedido
// entraria na rota de UMA aba com `id = "ordem"` e nunca salvaria nada.
test("`/ordem` não cai na rota de uma aba só", async () => {
  const { app, gravado } = monta();
  const r = await call(app, "put", "/dashboard/abas/ordem", { body: { ids: ["a2", "a1"] } });

  assert.equal(r.status, 200);
  assert.deepEqual(gravado.ordem, ["a2", "a1"]);
});

test("apagar uma aba que não existe é 404, e não apaga em silêncio", async () => {
  const { app } = monta();
  const r = await call(app, "delete", "/dashboard/abas/sumiu");

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "nao_encontrado");
});

test("criar e apagar entram no log de auditoria", async () => {
  const { app } = monta();
  await call(app, "post", "/dashboard/abas", { body: { nome: "Cobrança" } });
  await call(app, "delete", "/dashboard/abas/a1");

  assert.deepEqual(
    app.registrados.map((r) => r.action),
    ["create_dashboard_tab", "delete_dashboard_tab"]
  );
});
