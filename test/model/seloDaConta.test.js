const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const OauthPagina = require("../../model/OauthPagina_model.js");
const OauthInstagram = require("../../model/OauthInstagram_model.js");
const estadoDaConta = require("../../lib/estadoDaConta.js");

// O SELO: A CONTA AINDA FALA COM A GENTE?
//
// *"coloque um 'badge' de status, que vai no backend e consulta se o token
// ainda está funcionando"* (15/10/2026).
//
// ── POR QUE ISTO PRECISA DE TESTE ─────────────────────────────────────────
//
// Porque o selo só vale se ele estiver CERTO. Um verde numa Página muda é
// pior que selo nenhum — ele promete que a mensagem chega. E um vermelho
// porque a rede piscou faz reconectar uma conta perfeita; o selo que erra uma
// vez deixa de ser lido, e aí não adianta mais nada.
//
// Os casos aqui são os quatro jeitos de uma integração da Meta morrer em
// silêncio, cada um com uma AÇÃO diferente do outro lado da tela.

const CHAVES = { ligado: true, clientId: "2155086338698151", clientSecret: "seg-redo" };
const CONTA = { externalId: "7788", token: "EAAB-pagina" };

// Um `facebookFetch` que responde na ordem combinada. A primeira ida é o
// perfil da Página; a segunda, a assinatura do webhook.
function pagina(respostas) {
  const idas = [];
  const m = new OauthPagina({
    crypto,
    facebookFetch: async (url, opcoes) => {
      idas.push({ url: String(url), opcoes });
      const r = respostas.shift();
      if (!r) throw new Error("o teste não preparou resposta para " + url);
      if (r.estoura) throw new Error(r.estoura);
      return {
        ok: r.ok !== false,
        status: r.status || 200,
        async json() {
          return r.corpo;
        },
        async text() {
          return JSON.stringify(r.corpo || {});
        },
      };
    },
  });
  return { m, idas };
}

const PERFIL_OK = {
  corpo: { id: "7788", name: "SuperGeeks Londrina", picture: { data: { url: "https://cdn/f.jpg" } } },
};
const ASSINADA = { corpo: { data: [{ id: CHAVES.clientId, subscribed_fields: ["messages"] }] } };

test("token bom e Página assinada: verde, e com a foto fresca de brinde", async () => {
  const { m, idas } = pagina([PERFIL_OK, ASSINADA]);

  const r = await m.conferir(CONTA, CHAVES);

  assert.equal(r.estado, "ok");
  assert.equal(r.assinada, true);
  // A MESMA ida traz a foto — é o que conserta as contas ligadas antes de
  // 15/10 sem ninguém precisar reconectar.
  assert.equal(r.foto, "https://cdn/f.jpg");
  assert.equal(r.nome, "SuperGeeks Londrina");

  // E o token nunca viaja sem a prova do segredo.
  assert.ok(new URL(idas[0].url).searchParams.get("appsecret_proof"));
});

test("token bom e Página NÃO assinada: 'muda' — tudo parece certo e nada chega", async () => {
  const { m } = pagina([PERFIL_OK, { corpo: { data: [] } }]);

  const r = await m.conferir(CONTA, CHAVES);

  // É o defeito mais confuso desta integração. Um selo verde aqui seria uma
  // promessa falsa; é por este caso que a conferência faz DUAS perguntas.
  assert.equal(r.estado, "muda");
  assert.equal(r.assinada, false);
});

test("assinada por OUTRO app não conta como assinada", async () => {
  const { m } = pagina([PERFIL_OK, { corpo: { data: [{ id: "999-outro-app" }] } }]);

  const r = await m.conferir(CONTA, CHAVES);

  // Contar linha em vez de conferir o id diria que a mensagem chega AQUI
  // porque ela chega em algum lugar.
  assert.equal(r.estado, "muda");
});

test("token revogado (código 190) manda reconectar", async () => {
  const { m } = pagina([
    {
      ok: false,
      status: 400,
      corpo: { error: { code: 190, type: "OAuthException", message: "Error validating token" } },
    },
  ]);

  const r = await m.conferir(CONTA, CHAVES);

  assert.equal(r.estado, "expirada");
  assert.equal(r.detalhe, "Error validating token");
});

test("permissão retirada é outro caso, e outro conselho", async () => {
  const { m } = pagina([
    { ok: false, status: 403, corpo: { error: { code: 200, message: "sem pages_read_engagement" } } },
  ]);

  assert.equal((await m.conferir(CONTA, CHAVES)).estado, "sem_permissao");
});

test("a Meta fora do ar NÃO vira conta com problema", async () => {
  const { m } = pagina([{ estoura: "fetch failed" }]);

  const r = await m.conferir(CONTA, CHAVES);

  // Vermelho aqui faria reconectar uma conta perfeita por causa de um
  // segundo de rede — ver `lib/estadoDaConta.js`.
  assert.equal(r.estado, "fora_do_ar");
});

test("e um erro na SEGUNDA pergunta não desfaz o que a primeira provou", async () => {
  const { m } = pagina([PERFIL_OK, { ok: false, status: 500, corpo: {} }]);

  const r = await m.conferir(CONTA, CHAVES);

  assert.equal(r.estado, "ok");
  // `assinada` sai indefinida de propósito: o modelo não reescreve o que
  // sabia antes com um palpite.
  assert.equal(r.assinada, undefined);
});

test("conta sem token guardado não vai à rede — e já é 'expirada'", async () => {
  const { m, idas } = pagina([]);

  assert.equal((await m.conferir({ externalId: "7788" }, CHAVES)).estado, "expirada");
  assert.equal(idas.length, 0);
});

test("todo estado devolvido existe no catálogo", async () => {
  // O catálogo é o que a tela sabe desenhar. Um id fora dele chega como
  // pílula em branco — ou como nada.
  const { m } = pagina([PERFIL_OK, ASSINADA]);

  assert.ok(estadoDaConta.existe((await m.conferir(CONTA, CHAVES)).estado));
  for (const id of ["muda", "expirada", "sem_permissao", "fora_do_ar", "nao_verificada"]) {
    assert.ok(estadoDaConta.existe(id), id);
  }
});

// ── O INSTAGRAM ───────────────────────────────────────────────────────────

function instagram(respostas) {
  return new OauthInstagram({
    instagramFetch: async (url) => {
      const r = respostas.shift();
      if (!r) throw new Error("o teste não preparou resposta para " + url);
      return {
        ok: r.ok !== false,
        status: r.status || 200,
        async json() {
          return r.corpo;
        },
        async text() {
          return JSON.stringify(r.corpo || {});
        },
      };
    },
  });
}

test("no Instagram a pergunta é uma só, e a resposta traz @ e foto", async () => {
  const m = instagram([
    { corpo: { user_id: "9", username: "marlon.fit", profile_picture_url: "https://cdn/i.jpg" } },
  ]);

  const r = await m.conferir({ token: "IG-longo" });

  // Lá não existe assinar conta a conta: o webhook é do app. Então nunca há
  // "muda", e inventar esse estado aqui seria uma preocupação de outra rede.
  assert.equal(r.estado, "ok");
  assert.equal(r.assinada, undefined);
  assert.equal(r.usuario, "marlon.fit");
  assert.equal(r.foto, "https://cdn/i.jpg");
});

test("e um 400 do Instagram é o token, não a rede", async () => {
  const m = instagram([{ ok: false, status: 400, corpo: { error: { message: "expired" } } }]);

  assert.equal((await m.conferir({ token: "velho" })).estado, "expirada");
});

test("mas um 500 continua sendo o lado de lá", async () => {
  const m = instagram([{ ok: false, status: 500, corpo: {} }]);

  assert.equal((await m.conferir({ token: "bom" })).estado, "fora_do_ar");
});
