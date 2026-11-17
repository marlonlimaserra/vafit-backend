const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const AdminUserController = require("../../controllers/AdminUser.js");

// CONCEDER PODER EXIGE TER PODER.
//
// *"meu medo é alguém apagar tudo de todo mundo ou alguém conseguir acessar
// dados de outros clientes"* (14/11/2026).
//
// O caminho mais curto para "apagar tudo de todo mundo" não é apagar — é virar
// ADMIN e então poder tudo. As rotas de usuário eram guardadas só por
// `users.manage` ("gerenciar usuários") e aceitavam `admin:true` e `role` do
// corpo. Resultado: quem gerenciava usuários se promovia a admin sozinho — ou
// criava uma conta admin, ou trocava a senha de um admin existente e o tomava.
//
// A permissão que de fato REPRESENTA conceder poder é `roles.manage`. Estes
// casos seguram que ela é exigida para: criar/virar admin, atribuir um papel
// que gerencia permissões, e mexer numa conta que já é privilegiada. Admin
// passa em tudo porque já carrega `roles.manage`.

// `roles.manage` entre as permissões do ator decide se ele pode conceder poder.
function monta({ atorPode = ["users.manage"], target, roleGrants = {}, roleDefault = { _id: "r_padrao" } } = {}) {
  const gravado = { criados: [], mudancas: [], apagados: [] };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, chave) {
          if (!atorPode.includes(chave)) {
            res.status(403).send({ msg: "sem permissão", permission: chave });
            return false;
          }
          return { _id: "ator1", name: "Ator", permissions: atorPode };
        },
        has(user, permissao) {
          return Array.isArray(user?.permissions) && user.permissions.includes(permissao);
        },
      },
    },
    api: {
      role: {
        defaultName: "profissional",
        async data(id) {
          return id ? { _id: String(id), name: String(id) } : undefined;
        },
        async dataByName() {
          return roleDefault;
        },
        async grants(roleId, permissao) {
          return !!(roleGrants[String(roleId)] || []).includes(permissao);
        },
        async countActiveUsersWith() {
          return 5; // nunca é o último, para isolar a trava de escalada
        },
      },
      user: {
        async dataByEmail() {
          return undefined;
        },
        async hasPermission(doc, permissao) {
          return Array.isArray(doc?.permissions) && doc.permissions.includes(permissao);
        },
        async insertTrainer(obj) {
          gravado.criados.push(obj);
          return "novo1";
        },
        async updateAny(id, body) {
          gravado.mudancas.push({ id, body });
        },
        async deleteAny(id) {
          gravado.apagados.push(id);
        },
        async data(id) {
          return { _id: String(id), name: "Fulano", email: "f@x.com", type: "trainer" };
        },
        async withRole(doc) {
          return { ...doc, permissions: [] };
        },
      },
      userCategory: {
        async valida() {
          return true;
        },
      },
      link: {
        async countPeopleOf() {
          return 0;
        },
      },
      auth: {
        async deleteAllTokensByUser() {},
      },
      actionHistory: {
        diff() {
          return {};
        },
      },
    },
  });

  AdminUserController(app);
  return { app, gravado };
}

const CORPO_OK = { name: "Nova Conta", email: "nova@x.com", password: "segredo1" };

// ── POST /users ────────────────────────────────────────────────────────────

test("POST: users.manage SEM roles.manage NÃO cria conta admin", async () => {
  const { app, gravado } = monta({ atorPode: ["users.manage"] });
  const r = await call(app, "post", "/users", { body: { ...CORPO_OK, admin: true } });
  assert.equal(r.status, 403);
  assert.equal(r.body.permission, "roles.manage");
  assert.equal(gravado.criados.length, 0, "não pode ter inserido nada");
});

test("POST: users.manage SEM roles.manage NÃO atribui papel que gerencia permissões", async () => {
  const { app, gravado } = monta({
    atorPode: ["users.manage"],
    roleGrants: { r_poder: ["roles.manage"] },
  });
  const r = await call(app, "post", "/users", { body: { ...CORPO_OK, role: "r_poder" } });
  assert.equal(r.status, 403);
  assert.equal(gravado.criados.length, 0);
});

test("POST: quem TEM roles.manage cria admin normalmente", async () => {
  const { app, gravado } = monta({ atorPode: ["users.manage", "roles.manage"] });
  const r = await call(app, "post", "/users", { body: { ...CORPO_OK, admin: true } });
  assert.notEqual(r.status, 403);
  assert.equal(gravado.criados.length, 1);
  assert.equal(gravado.criados[0].admin, true);
});

test("POST: um profissional comum (sem admin, papel sem poder) passa com users.manage só", async () => {
  // A trava é cirúrgica: não pode atrapalhar o uso normal da tela.
  const { app, gravado } = monta({ atorPode: ["users.manage"] });
  const r = await call(app, "post", "/users", { body: { ...CORPO_OK } });
  assert.notEqual(r.status, 403);
  assert.equal(gravado.criados.length, 1);
  assert.equal(gravado.criados[0].admin, false);
});

// ── PUT /users/:id ───────────────────────────────────────────────────────────

test("PUT: users.manage SEM roles.manage NÃO se promove a admin", async () => {
  const { app, gravado } = monta({ atorPode: ["users.manage"] });
  const r = await call(app, "put", "/users/ator1", {
    params: { id: "ator1" },
    body: { admin: true },
  });
  assert.equal(r.status, 403);
  assert.equal(gravado.mudancas.length, 0, "nada pode ter sido salvo");
});

test("PUT: users.manage SEM roles.manage NÃO mexe numa conta JÁ admin (tomar por senha)", async () => {
  // Trocar a senha de um admin é tomá-lo. Mesmo só mandando senha, barra.
  const { app, gravado } = monta({ atorPode: ["users.manage"] });
  app.api.user.data = async (id) => ({ _id: String(id), name: "Chefe", type: "trainer", admin: true, permissions: [] });
  const r = await call(app, "put", "/users/chefe", {
    params: { id: "chefe" },
    body: { password: "roubada1" },
  });
  assert.equal(r.status, 403);
  assert.equal(gravado.mudancas.length, 0);
});

test("PUT: users.manage SEM roles.manage NÃO atribui papel que gerencia permissões", async () => {
  const { app, gravado } = monta({
    atorPode: ["users.manage"],
    roleGrants: { r_poder: ["roles.manage"] },
  });
  const r = await call(app, "put", "/users/alvo", {
    params: { id: "alvo" },
    body: { role: "r_poder" },
  });
  assert.equal(r.status, 403);
  assert.equal(gravado.mudancas.length, 0);
});

test("PUT: quem TEM roles.manage promove a admin normalmente", async () => {
  const { app, gravado } = monta({ atorPode: ["users.manage", "roles.manage"] });
  const r = await call(app, "put", "/users/alvo", {
    params: { id: "alvo" },
    body: { admin: true },
  });
  assert.notEqual(r.status, 403);
  assert.equal(gravado.mudancas.length, 1);
});

test("PUT: edição comum de conta comum passa com users.manage só", async () => {
  const { app, gravado } = monta({ atorPode: ["users.manage"] });
  const r = await call(app, "put", "/users/alvo", {
    params: { id: "alvo" },
    body: { name: "Nome Novo" },
  });
  assert.notEqual(r.status, 403);
  assert.equal(gravado.mudancas.length, 1);
});

// ── DELETE /users/:id ────────────────────────────────────────────────────────

test("DELETE: users.manage SEM roles.manage NÃO apaga uma conta admin", async () => {
  const { app } = monta({ atorPode: ["users.manage"] });
  app.api.user.data = async (id) => ({ _id: String(id), name: "Chefe", type: "trainer", admin: true, permissions: [] });
  const r = await call(app, "delete", "/users/chefe", { params: { id: "chefe" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.permission, "roles.manage");
});
