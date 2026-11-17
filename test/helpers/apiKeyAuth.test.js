const test = require("node:test");
const assert = require("node:assert/strict");

const ApiKeyAuth = require("../../helper/ApiKeyAuth.js");
const rateLimit = require("../../lib/rateLimit.js");
const mcpTools = require("../../lib/mcpTools.js");
const { translator } = require("../../lib/i18n");

const CHAVE = { _id: "k1", user: "u1", prefix: "abcd1234", name: "Integração" };

function monta({
  chave = CHAVE,
  usuario = { _id: "u1", active: 1 },
  permissions = ["people.view"],
  admin = false,
} = {}) {
  const registrados = [];
  const tocadas = [];

  const app = {
    api: {
      apiKey: {
        async verify(k) {
          return k === "gfn_abcd1234_valida" ? chave : undefined;
        },
        touch(id) {
          tocadas.push(id);
        },
        // Mesmas regras do model de verdade: `undefined` é "apagar" (legada) e
        // escopo vazio é todas. É o que o REST lê para estreitar a chave.
        nivelDe: (doc) => mcpTools.nivelValido(doc?.nivel),
        ferramentasDa: (doc) => (Array.isArray(doc?.ferramentas) ? doc.ferramentas : []),
      },
      apiCall: {
        record(d) {
          registrados.push(d);
        },
      },
      user: {
        async data() {
          return usuario;
        },
        async withRole(doc) {
          return { ...doc, permissions: [...permissions], admin };
        },
      },
    },
  };

  return { auth: new ApiKeyAuth(app), registrados, tocadas };
}

function resposta() {
  const r = { status: 200, body: undefined, headers: {} };
  const res = {
    status(c) {
      r.status = c;
      return res;
    },
    send(b) {
      r.body = b;
      return res;
    },
    setHeader(k, v) {
      r.headers[k] = v;
    },
  };
  return { r, res };
}

const req = (headers = {}, lang = "pt-BR", extra = {}) => ({
  headers,
  method: "GET",
  path: "/people",
  originalUrl: "/people",
  clientIp: "203.0.113.9",
  t: translator(lang),
  ...extra,
});

const BEARER = { authorization: "Bearer gfn_abcd1234_valida" };

test.beforeEach(() => rateLimit.reset());

test("lê a chave do Authorization: Bearer", () => {
  const { auth } = monta();
  assert.equal(auth.readKey(req({ authorization: "Bearer gfn_x" })), "gfn_x");
  assert.equal(auth.readKey(req({ authorization: "bearer gfn_x" })), "gfn_x", "case-insensitive");
});

test("lê a chave do X-API-Key", () => {
  // Duas formas aceitas para quem integra não ter de descobrir qual é.
  const { auth } = monta();
  assert.equal(auth.readKey(req({ "x-api-key": "gfn_x" })), "gfn_x");
});

test("sem chave, present() é falso — e é o que deixa o 401 de sessão acontecer", () => {
  const { auth } = monta();
  assert.equal(auth.present(req()), false);
  assert.equal(auth.present(req({ authorization: "Bearer gfn_x" })), true);
});

test("chave válida devolve o usuário com as permissões dele", async () => {
  const { auth, tocadas } = monta();
  const { res } = resposta();

  const user = await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res);
  assert.equal(user._id, "u1");
  assert.deepEqual(user.permissions, ["people.view"]);
  assert.deepEqual(tocadas, ["k1"], "o último uso tem de ser registrado");
});

test("chave inválida: 401 e a tentativa vai para o log", async () => {
  // É justamente o que o dono precisa ver: alguém usando chave que não vale.
  const { auth, registrados } = monta();
  const { r, res } = resposta();

  assert.equal(await auth.protect(req({ authorization: "Bearer gfn_errada" }), res), false);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "invalid_api_key");
  assert.equal(registrados.length, 1);
  assert.equal(registrados[0].status, 401);
  assert.equal(registrados[0].ip, "203.0.113.9");
});

test("sem chave nenhuma: 401 com código próprio", async () => {
  const { auth } = monta();
  const { r, res } = resposta();

  assert.equal(await auth.protect(req(), res), false);
  assert.equal(r.body.code, "no_api_key");
});

test("os cabeçalhos de limite acompanham toda resposta autenticada", async () => {
  const { auth } = monta();
  const { r, res } = resposta();

  await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res);
  assert.equal(r.headers["X-RateLimit-Limit"], 60);
  assert.equal(r.headers["X-RateLimit-Remaining"], 59);
});

test("passando de 60 numa janela: 429, com Retry-After e registro", async () => {
  const { auth, registrados } = monta();
  const pedido = req({ authorization: "Bearer gfn_abcd1234_valida" });

  for (let i = 0; i < 60; i++) await auth.protect(pedido, resposta().res);

  const { r, res } = resposta();
  assert.equal(await auth.protect(pedido, res), false);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "rate_limited");
  assert.ok(r.headers["Retry-After"] >= 1);
  assert.equal(registrados.at(-1).status, 429);
  assert.equal(registrados.at(-1).prefix, "abcd1234", "o log tem de dizer QUAL chave estourou");
});

test("a mensagem de limite diz o número e o tempo de espera", async () => {
  const { auth } = monta();
  const pedido = req({ authorization: "Bearer gfn_abcd1234_valida" });
  for (let i = 0; i < 60; i++) await auth.protect(pedido, resposta().res);

  const { r, res } = resposta();
  await auth.protect(pedido, res);
  assert.match(r.body.msg, /60/);
  assert.ok(!/{{/.test(r.body.msg), "sobrou marca de interpolação");
});

test("as mensagens saem no idioma do pedido", async () => {
  const { auth } = monta();
  const { r, res } = resposta();

  await auth.protect(req({ authorization: "Bearer gfn_errada" }, "fr"), res);
  assert.match(r.body.msg, /Clé d’API invalide/);
});

test("chave de conta desativada não entra", async () => {
  // Desativar a conta tem de fechar TODAS as portas, não só o login.
  const { auth } = monta({ usuario: { _id: "u1", active: 0 } });
  const { r, res } = resposta();

  assert.equal(await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res), false);
  assert.equal(r.status, 401);
});

test("chave de conta com acesso BLOQUEADO não entra", async () => {
  // Bloquear fecha TODAS as portas, inclusive a da chave de API.
  const { auth } = monta({ usuario: { _id: "u1", active: 1, appBloqueado: true } });
  const { r, res } = resposta();

  assert.equal(await auth.protect(req(BEARER), res), false);
  assert.equal(r.status, 401);
});

test("chave de conta apagada não entra", async () => {
  const { auth } = monta({ usuario: null });
  const { r, res } = resposta();

  assert.equal(await auth.protect(req({ authorization: "Bearer gfn_abcd1234_valida" }), res), false);
  assert.equal(r.status, 401);
});

test("marca a requisição como vinda de chave", async () => {
  // É o que impede uma chave de criar outras chaves.
  const { auth } = monta();
  const pedido = req({ authorization: "Bearer gfn_abcd1234_valida" });

  await auth.protect(pedido, resposta().res);
  assert.equal(pedido._viaApiKey, true);
  assert.equal(pedido._apiKey._id, "k1");
});

// ── O ESCOPO E O NÍVEL DA CHAVE VALEM NO REST TAMBÉM (14/11/2026) ──────────
//
// *"meu medo é alguém apagar tudo de todo mundo... principalmente via mcp"*
// (14/11/2026).
//
// O `/mcp` já gateava ferramenta por ferramenta, mas a MESMA chave abre a API
// REST — e lá o escopo e o nível eram ignorados: `protect` devolvia o poder
// cheio. Uma chave "só leitura, 3 ferramentas" apagava pela porta REST o que o
// painel jurava que ela não tocava. Estes casos seguram que as duas portas
// valem o mesmo. O `/mcp` fica de fora de propósito: lá o gate é dele.

test("nível 'ler' no REST: GET passa, POST/PUT/DELETE batem em 403", async () => {
  const { auth, registrados } = monta({ chave: { ...CHAVE, nivel: "ler" } });

  const okGet = await auth.protect(req(BEARER, "pt-BR", { method: "GET" }), resposta().res);
  assert.equal(okGet._id, "u1", "ler não pode travar a leitura");

  for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
    const { r, res } = resposta();
    const saida = await auth.protect(req(BEARER, "pt-BR", { method: metodo }), res);
    assert.equal(saida, false, `${metodo} tinha de ser barrado`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "api_key_level");
  }
  assert.equal(registrados.at(-1).status, 403, "a recusa por nível entra no log");
});

test("nível 'escrever' no REST: cria e edita, mas DELETE é 403", async () => {
  const { auth } = monta({ chave: { ...CHAVE, nivel: "escrever" } });

  for (const metodo of ["GET", "POST", "PUT", "PATCH"]) {
    const saida = await auth.protect(req(BEARER, "pt-BR", { method: metodo }), resposta().res);
    assert.equal(saida._id, "u1", `${metodo} devia passar em escrever`);
  }

  const { r, res } = resposta();
  assert.equal(await auth.protect(req(BEARER, "pt-BR", { method: "DELETE" }), res), false);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "api_key_level");
});

test("nível 'apagar' e chave legada (sem o campo) não restringem método nenhum", async () => {
  // A legada precisa continuar exatamente como era, ou um deploy derruba a
  // integração de alguém sem ninguém ligar à causa.
  for (const chave of [{ ...CHAVE, nivel: "apagar" }, { ...CHAVE }]) {
    const { auth } = monta({ chave });
    const saida = await auth.protect(req(BEARER, "pt-BR", { method: "DELETE" }), resposta().res);
    assert.equal(saida._id, "u1", "apagar/legada pode apagar pelo REST");
  }
});

test("escopo da chave estreita as permissões no REST (e zera admin)", async () => {
  // A chave carrega só as permissões das ferramentas escolhidas. `pessoa_buscar`
  // é `people.view` — as outras caem, mesmo que a PESSOA as tenha, mesmo admin.
  const { auth } = monta({
    chave: { ...CHAVE, ferramentas: ["pessoa_buscar"], nivel: "apagar" },
    permissions: ["people.view", "finance.manage", "people.delete"],
    admin: true,
  });

  const user = await auth.protect(req(BEARER, "pt-BR", { method: "GET" }), resposta().res);
  assert.deepEqual(user.permissions, ["people.view"], "só o que a ferramenta no escopo concede");
  assert.equal(user.admin, false, "escopo explícito não herda o atalho de admin");
});

test("escopo vazio (chave legada) mantém TODAS as permissões", async () => {
  const { auth } = monta({
    chave: { ...CHAVE },
    permissions: ["people.view", "finance.manage"],
    admin: true,
  });

  const user = await auth.protect(req(BEARER, "pt-BR", { method: "GET" }), resposta().res);
  assert.deepEqual(user.permissions, ["people.view", "finance.manage"]);
  assert.equal(user.admin, true, "sem escopo, a chave é a pessoa inteira");
});

test("o /mcp fica de fora: ele gateia sozinho, então recebe a pessoa inteira", async () => {
  // Mesmo uma chave nível 'ler' num POST /mcp tem de PASSAR por aqui — o
  // controller do MCP é quem decide ferramenta por ferramenta. Gatear o método
  // aqui mataria o /mcp inteiro, que é POST.
  const { auth } = monta({
    chave: { ...CHAVE, nivel: "ler", ferramentas: ["pessoa_buscar"] },
    permissions: ["people.view", "finance.manage"],
    admin: true,
  });

  const user = await auth.protect(
    req(BEARER, "pt-BR", { method: "POST", path: "/mcp", originalUrl: "/mcp?instance=marlon" }),
    resposta().res
  );
  assert.equal(user._id, "u1", "o /mcp não pode ser barrado pelo gate do REST");
  assert.deepEqual(user.permissions, ["people.view", "finance.manage"], "nem estreitado — o gate é do /mcp");
  assert.equal(user.admin, true);
});
