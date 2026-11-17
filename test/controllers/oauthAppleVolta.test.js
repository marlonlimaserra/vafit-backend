const test = require("node:test");
const assert = require("node:assert/strict");

const instanceContext = require("../../lib/instance.js");
const { fakeApp, call } = require("../helpers/harness.js");
const OauthController = require("../../controllers/Oauth.js");
const OauthApple = require("../../model/OauthApple_model.js");
const dominio = require("../../lib/domain.js");
const ESQUEMA = require("../../model/Oauth_model.js").ESQUEMA_APP;

// A VOLTA DA APPLE (16/11/2026) — a mesma regra das outras, por outra porta.
//
// A Apple devolve a pessoa com um FORMULÁRIO (`form_post`): `state`, `code` e
// `error` chegam no CORPO, não na URL. O que estes casos guardam é que a porta
// diferente não abriu um caminho novo — **nenhuma falha acaba em sessão** — e
// que o "Ocultar meu e-mail" ganha a mensagem certa.

const SERVICES_ID = "vafit.app.login";
const CHAVES = { ligado: true, clientId: SERVICES_ID, clientSecret: "p8", teamId: "DG447FV498", keyId: "K1" };

function idToken(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

function cargaBoa(extra = {}) {
  return {
    aud: SERVICES_ID,
    iss: "https://appleid.apple.com",
    exp: Math.floor(Date.now() / 1000) + 600,
    email: "bruna@exemplo.com",
    email_verified: "true",
    ...extra,
  };
}

function monta({ estado, carga, usuario, chaves = CHAVES } = {}) {
  const trocas = [];
  const sessoes = [];
  const buscas = [];
  const registros = [];

  const app = fakeApp({
    api: {
      oauthApple: {
        async chaves() {
          return chaves;
        },
        async consumirEstado(state) {
          if (!state || !estado || estado._gasto) return null;
          estado._gasto = true;
          return estado;
        },
        async trocarCodigo(code) {
          trocas.push(code);
          return { id_token: idToken(carga || cargaBoa()) };
        },
        // Os de verdade: a composição e a leitura do token são o que se afirma.
        pessoaDoIdToken: OauthApple.prototype.pessoaDoIdToken,
        pessoaDoCodigo: OauthApple.prototype.pessoaDoCodigo,
        enderecoDeVolta: OauthApple.prototype.enderecoDeVolta,
        urlDeVolta: OauthApple.prototype.urlDeVolta,
      },
      user: {
        async porEmailVerificado(email) {
          buscas.push({ email, instancia: instanceContext.current() });
          return usuario;
        },
        async motivoDoEmailVerificado() {
          return null;
        },
      },
      auth: {
        async registerToken(userId) {
          sessoes.push(String(userId));
          return "sessao-nova";
        },
      },
    },
  });

  app.insertUserActionHistory = (req, user, acao, dados) => {
    registros.push({ acao, via: dados?.extra?.via, instancia: instanceContext.current() });
  };

  OauthController(app);
  return { app, trocas, sessoes, buscas, registros };
}

// A Apple POSTA. A instância da requisição é "outra" de propósito: quem decide
// é o bilhete.
const volta = (app, body, query) =>
  call(app, "post", "/auth/apple/callback", { body, query, instance: "outra" });

test("sucesso: os dados vêm do CORPO e a sessão volta no fragmento", async () => {
  const { app, sessoes, trocas } = monta({
    estado: { instancia: "marlon", origem: null },
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.status, 302);
  assert.equal(r.redirect, `https://marlon.${dominio.BASE_DOMAIN}/#sessao=sessao-nova`);
  assert.deepEqual(trocas, ["cod-1"]);
  assert.deepEqual(sessoes, ["u1"]);
});

test("a volta da Apple é só POST — não existe GET nesse endereço", async () => {
  const { app } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  await assert.rejects(
    call(app, "get", "/auth/apple/callback", { query: { code: "cod-1", state: "est-1" } }),
    /rota não registrada/
  );
});

test("código e bilhete na URL, e não no corpo, não valem nada", async () => {
  // Se a rota lesse a query, um link montado por terceiros faria o papel do
  // formulário que só a Apple manda.
  const { app, sessoes, trocas } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  const r = await volta(app, {}, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /erroLogin=expirou/);
  assert.deepEqual(trocas, []);
  assert.deepEqual(sessoes, []);
});

test("o id_token do formulário é IGNORADO — só vale o da troca", async () => {
  // O do formulário passou pelo navegador; o da troca veio da Apple direto
  // para nós. Um id_token forjado no corpo não pode escolher quem entra.
  const { app, buscas } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  await volta(app, {
    code: "cod-1",
    state: "est-1",
    id_token: idToken(cargaBoa({ email: "chefe@exemplo.com" })),
  });

  assert.deepEqual(buscas, [{ email: "bruna@exemplo.com", instancia: "marlon" }]);
});

test("a sessão nasce na instância do BILHETE e o histórico diz 'apple'", async () => {
  const { app, registros } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  await volta(app, { code: "cod-1", state: "est-1" });

  assert.deepEqual(registros, [{ acao: "login", via: "apple", instancia: "marlon" }]);
});

test("no app, a volta vai pelo esquema próprio", async () => {
  const { app } = monta({ estado: { instancia: "marlon", destino: "app" }, usuario: { _id: "u1" } });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.redirect, `${ESQUEMA}://entrar?sessao=sessao-nova`);
});

test("quem cancelou na tela da Apple volta quieto", async () => {
  const { app, trocas } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  const r = await volta(app, { error: "user_cancelled_authorize", state: "est-1" });

  assert.match(r.redirect, /erroLogin=recusado/);
  assert.deepEqual(trocas, []);
});

test("'Ocultar meu e-mail' sem conta ganha a mensagem própria, e nenhuma sessão", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon" },
    carga: cargaBoa({ email: "x7k2@privaterelay.appleid.com", is_private_email: "true" }),
    usuario: undefined,
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.equal(r.redirect, `https://marlon.${dominio.BASE_DOMAIN}/#erroLogin=email_oculto`);
  assert.deepEqual(sessoes, []);
});

test("e-mail comum sem conta continua sendo 'sem conta'", async () => {
  const { app } = monta({ estado: { instancia: "marlon" }, usuario: undefined });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /erroLogin=sem_conta$/);
});

test("token para outro Services ID não vira sessão", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon" },
    carga: cargaBoa({ aud: "com.outro.app" }),
    usuario: { _id: "u1" },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /erroLogin=falhou/);
  assert.deepEqual(sessoes, []);
});

test("a mesma volta repetida não abre segunda sessão", async () => {
  const { app, sessoes } = monta({ estado: { instancia: "marlon" }, usuario: { _id: "u1" } });

  await volta(app, { code: "cod-1", state: "est-1" });
  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /erroLogin=expirou/);
  assert.deepEqual(sessoes, ["u1"]);
});

test("desligada na central entre a ida e a volta, não entra", async () => {
  const { app, sessoes } = monta({
    estado: { instancia: "marlon" },
    usuario: { _id: "u1" },
    chaves: { ...CHAVES, ligado: false },
  });

  const r = await volta(app, { code: "cod-1", state: "est-1" });

  assert.match(r.redirect, /erroLogin=desligado/);
  assert.deepEqual(sessoes, []);
});
