const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const userModel = require("../../model/User_model.js");
const { fakeApp, call } = require("../helpers/harness.js");
const AuthController = require("../../controllers/Auth.js");

// CONTA BLOQUEADA NÃO É SENHA ERRADA (16/11/2026).
//
// *"tentei logar, ele está bloqueado, mas no app mostra que a senha está
// errada — deveria mostrar que o acesso foi bloqueado"*.
//
// O que se trava:
//   - com a senha CERTA, a recusa diz o porquê (bloqueado / desativado);
//   - com a senha ERRADA, a mensagem continua a genérica — ninguém descobre
//     por aqui quem tem conta nem quem está bloqueado;
//   - a dona da conta com a senha certa não conta como tentativa falha.

function monta(alteracoes = {}) {
  const users = new userModel({ crypto });
  const salt = users.generateSalt();
  const doc = {
    _id: "u1",
    name: "Marlon",
    email: "marlon@exemplo.test",
    salt,
    password: users.hashPassword("senha-boa", salt),
    active: 1,
    ...alteracoes,
  };
  users.collection = async () => ({
    findOne: async (q) => {
      if (q.email !== undefined) return q.email === doc.email ? doc : null;
      return null;
    },
  });
  return users;
}

test("bloqueado com a senha certa: o motivo é 'bloqueado'", async () => {
  const users = monta({ appBloqueado: true });
  assert.equal(await users.authenticate("marlon@exemplo.test", "senha-boa"), undefined);
  assert.equal(await users.recusaComSenhaCerta("marlon@exemplo.test", "senha-boa"), "bloqueado");
});

test("bloqueado com a senha ERRADA: nenhum motivo — a genérica continua", async () => {
  const users = monta({ appBloqueado: true });
  assert.equal(await users.recusaComSenhaCerta("marlon@exemplo.test", "chute"), null);
});

test("desativado com a senha certa: 'inativo'; bloqueio vence quando são os dois", async () => {
  assert.equal(await monta({ active: 0 }).recusaComSenhaCerta("marlon@exemplo.test", "senha-boa"), "inativo");
  assert.equal(
    await monta({ active: 0, appBloqueado: true }).recusaComSenhaCerta("marlon@exemplo.test", "senha-boa"),
    "bloqueado"
  );
});

test("conta boa, sem acesso concedido, ou e-mail que não existe: nada a dizer", async () => {
  assert.equal(await monta().recusaComSenhaCerta("marlon@exemplo.test", "senha-boa"), null);
  assert.equal(
    await monta({ password: undefined, salt: undefined }).recusaComSenhaCerta("marlon@exemplo.test", "x"),
    null
  );
  assert.equal(await monta().recusaComSenhaCerta("ninguem@exemplo.test", "senha-boa"), null);
});

test("pelo Google (e-mail já provado): bloqueado diz bloqueado", async () => {
  assert.equal(await monta({ appBloqueado: true }).motivoDoEmailVerificado("marlon@exemplo.test"), "bloqueado");
  assert.equal(await monta().motivoDoEmailVerificado("outro@exemplo.test"), null);
});

// ── A ROTA ──────────────────────────────────────────────────────────────────

function montaRota({ motivo = null } = {}) {
  const historico = [];
  const app = fakeApp({
    // O desafio (captcha) desligado: o que está em teste é a recusa.
    mongodb: { centralDb: async () => ({ collection: () => ({ findOne: async () => null }) }) },
    api: {
      user: {
        authenticate: async () => undefined,
        recusaComSenhaCerta: async () => motivo,
      },
      auth: { registerToken: async () => "tok" },
    },
  });
  app.insertUserActionHistory = (req, user, acao, dados) => historico.push({ acao, dados });
  AuthController(app);
  return { app, historico };
}

test("POST /auth bloqueado: 403 com a frase do bloqueio, não 'senha inválida'", async () => {
  const { app, historico } = montaRota({ motivo: "bloqueado" });
  const r = await call(app, "post", "/auth", { body: { email: "marlon@exemplo.test", password: "senha-boa" } });

  assert.equal(r.status, 403);
  assert.equal(r.body.code, "acesso_bloqueado");
  assert.equal(r.body.msg, "Seu acesso foi bloqueado. Para liberar, fale com quem te atende.");
  // Registrado como recusa, não como falha de senha.
  assert.deepEqual(historico.map((h) => h.acao), ["login_refused"]);
});

test("POST /auth desativado: 403 com a frase de conta desativada", async () => {
  const { app } = montaRota({ motivo: "inativo" });
  const r = await call(app, "post", "/auth", { body: { email: "marlon@exemplo.test", password: "senha-boa" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "conta_inativa");
});

test("POST /auth senha errada: o 401 genérico de sempre", async () => {
  const { app, historico } = montaRota({ motivo: null });
  const r = await call(app, "post", "/auth", { body: { email: "marlon@exemplo.test", password: "chute" } });
  assert.equal(r.status, 401);
  assert.equal(r.body.msg, "E-mail ou senha inválidos.");
  assert.deepEqual(historico.map((h) => h.acao), ["login_failed"]);
});
