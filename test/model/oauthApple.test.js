const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const OauthApple = require("../../model/OauthApple_model.js");

// ENTRAR COM A APPLE — o modelo (16/11/2026).
//
// O que estes casos guardam são as três coisas que só a Apple tem: o segredo
// assinado na hora com a chave .p8, a volta por formulário e o "Ocultar meu
// e-mail". Um erro em qualquer uma delas não aparece no nosso log como erro
// nosso: aparece como `invalid_client` da Apple, depois de a pessoa já ter
// aprovado.

const SERVICES_ID = "vafit.app.login";
const TIME = "DG447FV498";
const KEY_ID = "ABC123DEFG";

// Uma chave de verdade, gerada para o teste: o .p8 da Apple é exatamente isto,
// uma chave EC P-256 em PKCS8.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" });

const CHAVES = { ligado: true, clientId: SERVICES_ID, clientSecret: P8, teamId: TIME, keyId: KEY_ID };

const modelo = (app = {}) => new OauthApple(app);

const lerParte = (jwt, i) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString("utf8"));

function idToken(payload) {
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

function cargaBoa(extra = {}) {
  return {
    aud: SERVICES_ID,
    iss: "https://appleid.apple.com",
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "001234.abcdef.1234",
    email: "Bruna@Exemplo.com",
    email_verified: "true",
    ...extra,
  };
}

// ── O LINK DE IDA ─────────────────────────────────────────────────────────

test("a ida pede nome e e-mail, com a volta por FORMULÁRIO", () => {
  const url = new URL(modelo().urlDeAutorizacao(SERVICES_ID, "est-1"));

  assert.equal(url.origin + url.pathname, "https://appleid.apple.com/auth/authorize");
  assert.equal(url.searchParams.get("client_id"), SERVICES_ID);
  assert.equal(url.searchParams.get("state"), "est-1");
  assert.equal(url.searchParams.get("response_type"), "code");
  // Com escopo, a Apple EXIGE form_post — sem ele, ela recusa antes de mostrar
  // a tela de consentimento.
  assert.equal(url.searchParams.get("response_mode"), "form_post");
  assert.equal(url.searchParams.get("scope"), "name email");
});

test("o escopo vai com %20, e não com +", () => {
  // É assim que a Apple documenta; `URLSearchParams` escreveria `name+email`.
  const url = modelo().urlDeAutorizacao(SERVICES_ID, "est-1");

  assert.match(url, /scope=name%20email/);
  assert.ok(!url.includes("name+email"));
});

test("o retorno é o endereço FIXO cadastrado no portal da Apple", () => {
  const url = new URL(modelo().urlDeAutorizacao(SERVICES_ID, "est-1"));

  assert.equal(url.searchParams.get("redirect_uri"), OauthApple.CALLBACK);
  assert.match(OauthApple.CALLBACK, /^https:\/\/[^/]+\/auth\/apple\/callback$/);
});

// ── O SEGREDO ASSINADO NA HORA ────────────────────────────────────────────

test("o segredo é um JWT ES256 que a chave PÚBLICA confere", () => {
  const jwt = modelo().segredoDoCliente(CHAVES);
  const [cab, corpo, assinatura] = jwt.split(".");

  const ok = crypto.verify(
    "sha256",
    Buffer.from(`${cab}.${corpo}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(assinatura, "base64url")
  );
  assert.ok(ok, "a assinatura não confere com a chave pública");
});

test("a assinatura tem 64 bytes (r‖s), e não DER", () => {
  // O Node assina ECDSA em DER por padrão (70–72 bytes). A Apple recusa DER com
  // `invalid_client`, que não diz o porquê.
  const assinatura = modelo().segredoDoCliente(CHAVES).split(".")[2];

  assert.equal(Buffer.from(assinatura, "base64url").length, 64);
});

test("o segredo diz qual chave, qual time e qual Services ID", () => {
  const agora = Date.UTC(2026, 10, 16, 12, 0, 0);
  const jwt = modelo().segredoDoCliente(CHAVES, agora);

  assert.deepEqual(lerParte(jwt, 0), { alg: "ES256", kid: KEY_ID });
  const corpo = lerParte(jwt, 1);
  assert.equal(corpo.iss, TIME);
  assert.equal(corpo.sub, SERVICES_ID);
  assert.equal(corpo.aud, "https://appleid.apple.com");
  assert.equal(corpo.iat, agora / 1000);
  // Curto de propósito: ele é assinado a cada troca.
  assert.equal(corpo.exp - corpo.iat, 300);
});

test("a chave colada num campo de UMA linha ainda assina", () => {
  // Um <input> de linha única come as quebras do .p8; o Windows as troca por
  // \r\n. Os dois têm de funcionar, ou a central aceita a chave e o login cai.
  const umaLinha = P8.replace(/\n/g, " ");
  const doWindows = P8.replace(/\n/g, "\r\n");

  for (const chave of [umaLinha, doWindows]) {
    const jwt = modelo().segredoDoCliente({ ...CHAVES, clientSecret: chave });
    const [cab, corpo, assinatura] = jwt.split(".");
    assert.ok(
      crypto.verify("sha256", Buffer.from(`${cab}.${corpo}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(assinatura, "base64url"))
    );
  }
});

test("pemDaChave remonta o PEM em linhas de 64", () => {
  const pem = OauthApple.pemDaChave(P8.replace(/\n/g, ""));

  assert.match(pem, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.match(pem, /\n-----END PRIVATE KEY-----\n$/);
  const miolo = pem.split("\n").slice(1, -2);
  assert.ok(miolo.every((l) => l.length <= 64));
  assert.equal(OauthApple.pemDaChave("   "), "");
});

// ── A TROCA DO CÓDIGO ─────────────────────────────────────────────────────

test("a troca manda o segredo assinado, o código e o mesmo retorno da ida", async () => {
  let pedido;
  const m = modelo({
    async appleFetch(url, opcoes) {
      pedido = { url, corpo: new URLSearchParams(opcoes.body) };
      return { ok: true, json: async () => ({ id_token: "t" }) };
    },
  });

  const r = await m.trocarCodigo("cod-1", CHAVES);

  assert.deepEqual(r, { id_token: "t" });
  assert.equal(pedido.url, "https://appleid.apple.com/auth/token");
  assert.equal(pedido.corpo.get("client_id"), SERVICES_ID);
  assert.equal(pedido.corpo.get("code"), "cod-1");
  assert.equal(pedido.corpo.get("grant_type"), "authorization_code");
  // O `redirect_uri` da troca tem de ser IDÊNTICO ao da ida, ou a Apple recusa.
  assert.equal(pedido.corpo.get("redirect_uri"), OauthApple.CALLBACK);
  assert.equal(pedido.corpo.get("client_secret").split(".").length, 3);
});

test("recusa da Apple vira erro com o MOTIVO dela", async () => {
  const m = modelo({
    async appleFetch() {
      return { ok: false, status: 400, text: async () => '{"error":"invalid_client"}' };
    },
  });

  await assert.rejects(m.trocarCodigo("cod-1", CHAVES), /token 400: .*invalid_client/);
});

// ── QUEM ENTROU ───────────────────────────────────────────────────────────

test("o e-mail sai minúsculo, e o comum não é oculto", () => {
  const r = modelo().pessoaDoIdToken(idToken(cargaBoa()), SERVICES_ID);

  assert.deepEqual(r, { email: "bruna@exemplo.com", nome: "", oculto: false });
});

test("'Ocultar meu e-mail' é marcado como oculto", () => {
  const r = modelo().pessoaDoIdToken(
    idToken(cargaBoa({ email: "x7k2@privaterelay.appleid.com", is_private_email: "true" })),
    SERVICES_ID
  );

  assert.equal(r.oculto, true);
  assert.equal(r.email, "x7k2@privaterelay.appleid.com");
});

test("o endereço de repasse é oculto mesmo sem a marca", () => {
  // A marca é o que a Apple promete mandar; o domínio é o que ela de fato usa.
  const r = modelo().pessoaDoIdToken(idToken(cargaBoa({ email: "a@privaterelay.appleid.com" })), SERVICES_ID);

  assert.equal(r.oculto, true);
});

test("token para OUTRO Services ID é recusado", () => {
  const r = modelo().pessoaDoIdToken(idToken(cargaBoa({ aud: "com.outro.app" })), SERVICES_ID);

  assert.deepEqual(r, { erro: "aud_de_outro_app" });
});

test("token de outro emissor é recusado", () => {
  const r = modelo().pessoaDoIdToken(idToken(cargaBoa({ iss: "https://accounts.google.com" })), SERVICES_ID);

  assert.deepEqual(r, { erro: "emissor_desconhecido" });
});

test("token vencido é recusado", () => {
  const r = modelo().pessoaDoIdToken(idToken(cargaBoa({ exp: Math.floor(Date.now() / 1000) - 5 })), SERVICES_ID);

  assert.deepEqual(r, { erro: "id_token_vencido" });
});

test("e-mail não verificado é recusado — o booleano e a string valem", () => {
  const m = modelo();

  assert.deepEqual(m.pessoaDoIdToken(idToken(cargaBoa({ email_verified: "false" })), SERVICES_ID), {
    erro: "email_nao_verificado",
  });
  assert.equal(m.pessoaDoIdToken(idToken(cargaBoa({ email_verified: true })), SERVICES_ID).email, "bruna@exemplo.com");
});

test("token sem e-mail, ou ilegível, é recusado", () => {
  const m = modelo();

  assert.deepEqual(m.pessoaDoIdToken(idToken(cargaBoa({ email: "" })), SERVICES_ID), { erro: "sem_email" });
  assert.deepEqual(m.pessoaDoIdToken("lixo", SERVICES_ID), { erro: "id_token_malformado" });
  assert.deepEqual(m.pessoaDoIdToken("a.%%%.b", SERVICES_ID), { erro: "id_token_ilegivel" });
});

// ── AS CHAVES NA CENTRAL ──────────────────────────────────────────────────

function comChaves(docs) {
  return modelo({
    mongodb: {
      async centralDb() {
        return {
          collection: () => ({
            find: (filtro) => ({
              toArray: async () => docs.filter((d) => filtro.key.$in.includes(d.key)),
            }),
          }),
        };
      },
    },
  });
}

const COMPLETAS = [
  { key: "oauth.apple.enabled", value: true },
  { key: "oauth.apple.clientId", value: SERVICES_ID },
  { key: "oauth.apple.clientSecret", value: P8 },
  { key: "oauth.apple.teamId", value: TIME },
  { key: "oauth.apple.keyId", value: KEY_ID },
];

test("com tudo na central, liga e entrega o time e o id da chave", async () => {
  const c = await comChaves(COMPLETAS).chaves();

  assert.equal(c.ligado, true);
  assert.equal(c.clientId, SERVICES_ID);
  assert.equal(c.teamId, TIME);
  assert.equal(c.keyId, KEY_ID);
});

test("sem o time ou sem o id da chave, NÃO liga", async () => {
  // Ligada sem eles, a pessoa aprovaria na Apple e a troca falharia na volta —
  // o pior momento para descobrir que faltava um campo.
  for (const faltando of ["oauth.apple.teamId", "oauth.apple.keyId"]) {
    const c = await comChaves(COMPLETAS.filter((d) => d.key !== faltando)).chaves();
    assert.equal(c.ligado, false, `ligou sem ${faltando}`);
  }
});

test("os extras não vazam para os outros provedores", () => {
  // `CHAVES_EXTRAS` mora no protótipo da Apple. No da base, um campo a mais
  // faria o Google exigir um time que ele não tem — e nunca mais ligar.
  const OauthGoogle = require("../../model/OauthGoogle_model.js");
  assert.equal(new OauthGoogle({}).CHAVES_EXTRAS, undefined);
  assert.deepEqual(modelo().nomesDasChaves().slice(-2), ["oauth.apple.teamId", "oauth.apple.keyId"]);
});
