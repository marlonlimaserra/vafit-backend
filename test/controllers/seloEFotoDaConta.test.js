const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const arquivos = require("../../lib/arquivos.js");
const controlador = require("../../controllers/ContasConectadas.js");

// AS ROTAS DO SELO E DA FOTO — Configurações › Contas › Facebook.
//
// *"ao conectar o facebook quebrou a imagem, salve a imagem e faça o upload e
// deixe o link fixo"* e *"coloque um 'badge' de status, que vai no backend e
// consulta se o token ainda está funcionando"* (15/10/2026).
//
// O que mora aqui e não no modelo: o ENDEREÇO que a tela recebe, a decisão de
// perguntar à Meta em outra chamada, e os cabeçalhos da imagem — que são o
// que faz a foto aparecer rápido sem ficar presa depois de trocada.

const USUARIO = { _id: "u1", name: "Marlon", permissions: ["integrations.view"] };

const CONTA = {
  _id: "c1",
  tipo: "facebook",
  externalId: "7788",
  nome: "SuperGeeks Londrina",
  estado: "nao_verificada",
  fotoEm: new Date("2026-10-15T12:00:00Z"),
};

function monta({ contas = [CONTA], paraConferir, conferir, chaves = { ligado: true, clientId: "a" } } = {}) {
  const feito = { marcados: [], copiadas: [], conferidas: [] };
  const { helpers } = permiteTudo(USUARIO);

  const app = fakeApp({
    helpers,
    api: {
      contaConectada: {
        async lista() {
          return contas;
        },
        async paraConferir() {
          return paraConferir === undefined ? [{ _id: "c1", externalId: "7788", token: "t" }] : paraConferir;
        },
        async marcarEstado(id, r) {
          feito.marcados.push({ id: String(id), estado: r.estado });
        },
        async copiarFoto(conta, url) {
          feito.copiadas.push({ id: String(conta._id), url });
          return true;
        },
        async foto(id) {
          return id === "c1"
            ? { chave: "marlon/contas/c1", mime: "image/webp", em: new Date("2026-10-15T12:00:00Z") }
            : null;
        },
      },
      oauthPagina: {
        async chaves() {
          return chaves;
        },
        async conferir(conta) {
          feito.conferidas.push(String(conta._id));
          return conferir ? conferir(conta) : { estado: "ok", assinada: true, foto: "https://cdn/f.jpg" };
        },
      },
      oauthInstagram: {
        async chaves() {
          return chaves;
        },
        async conferir() {
          return { estado: "ok" };
        },
      },
    },
  });

  controlador(app);
  return { app, feito };
}

// ── A LISTA ───────────────────────────────────────────────────────────────

test("a foto que a tela recebe é um endereço NOSSO, e fixo", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/contas-conectadas", { query: { tipo: "facebook" } });

  const foto = r.body.contas[0].foto;
  assert.ok(foto.includes("/public/conta-foto/marlon/c1"), foto);
  // O caminho é o id da conta e nunca muda. Quem muda quando a imagem muda é
  // o `?v=` — sem ele, a foto trocada ficaria presa no cache de um ano.
  assert.equal(new URL(foto).searchParams.get("v"), String(CONTA.fotoEm.getTime()));
});

test("conta sem cópia nossa vem com foto vazia, e não com um endereço que dá 404", async () => {
  const { app } = monta({ contas: [{ ...CONTA, fotoEm: null }] });

  const r = await call(app, "get", "/contas-conectadas", { query: { tipo: "facebook" } });

  assert.equal(r.body.contas[0].foto, "");
});

test("o catálogo do selo vai junto, traduzido", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/contas-conectadas", { query: { tipo: "facebook" } });

  // A tela não conhece estado nenhum: ela procura o id neste catálogo. Um
  // estado novo aqui aparece lá sem mexer numa linha de lá.
  const ok = r.body.estados.find((e) => e.id === "ok");
  assert.equal(ok.label, "Recebendo");
  assert.equal(ok.tom, "ok");
});

// ── A CONFERÊNCIA ─────────────────────────────────────────────────────────

test("verificar pergunta à Meta e GRAVA o que ela respondeu", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", "/contas-conectadas/verificar", { query: { tipo: "facebook" } });

  assert.deepEqual(feito.conferidas, ["c1"]);
  assert.deepEqual(feito.marcados, [{ id: "c1", estado: "ok" }]);
  // Gravado porque a próxima abertura da tela mostra o último resultado
  // conhecido ANTES de perguntar de novo.
  assert.ok(Array.isArray(r.body.contas));
});

test("e aproveita a ida para consertar a foto que falta", async () => {
  // É o que cura as contas ligadas antes de 15/10, quando o que se guardava
  // era a URL do CDN da Meta. Sem isto, só reconectar traria a imagem.
  const { app, feito } = monta({ paraConferir: [{ _id: "c1", externalId: "7788", token: "t" }] });

  await call(app, "post", "/contas-conectadas/verificar", { query: { tipo: "facebook" } });

  assert.deepEqual(feito.copiadas, [{ id: "c1", url: "https://cdn/f.jpg" }]);
});

test("mas não rebaixa a foto a cada verificação", async () => {
  // A URL do Graph vem assinada e MUDA a cada chamada, então comparar
  // endereços não diria nada. Quem decide é a IDADE da cópia.
  const { app, feito } = monta({
    paraConferir: [{ _id: "c1", externalId: "7788", token: "t", fotoArquivo: { em: new Date() } }],
  });

  await call(app, "post", "/contas-conectadas/verificar", { query: { tipo: "facebook" } });

  assert.deepEqual(feito.copiadas, []);
});

test("cópia velha de mais de um mês é refeita", async () => {
  const antiga = new Date(Date.now() - 40 * 86400000);
  const { app, feito } = monta({
    paraConferir: [{ _id: "c1", externalId: "7788", token: "t", fotoArquivo: { em: antiga } }],
  });

  await call(app, "post", "/contas-conectadas/verificar", { query: { tipo: "facebook" } });

  assert.equal(feito.copiadas.length, 1);
});

test("sem as chaves do app não se pergunta nada — e isso não é defeito de conta nenhuma", async () => {
  const { app, feito } = monta({ chaves: { ligado: false } });

  const r = await call(app, "post", "/contas-conectadas/verificar", { query: { tipo: "facebook" } });

  assert.deepEqual(feito.conferidas, []);
  assert.equal(r.status, 200, "a lista volta igual, e o selo segue cinza");
});

test("verificar pede VER, não MEXER — olhar não muda a integração", async () => {
  const { helpers, pedidas } = permiteTudo(USUARIO);
  const app = fakeApp({
    helpers,
    api: {
      contaConectada: { async lista() { return []; }, async paraConferir() { return []; } },
      oauthPagina: { async chaves() { return { ligado: true }; } },
      oauthInstagram: { async chaves() { return { ligado: true }; } },
    },
  });
  controlador(app);

  await call(app, "post", "/contas-conectadas/verificar", { query: { tipo: "facebook" } });

  assert.deepEqual(pedidas, ["integrations.view"]);
});

test("um `tipo` inventado cai no padrão, e não vira `app.api[algo]`", async () => {
  const { app, feito } = monta();

  await call(app, "post", "/contas-conectadas/verificar", {
    query: { tipo: "../../oauthGoogle" },
  });

  // Caminho fechado: ou facebook, ou instagram. O do Instagram não registra
  // nada na lista do Facebook.
  assert.deepEqual(feito.conferidas, []);
});

// ── OS BYTES ──────────────────────────────────────────────────────────────

test("a foto sai com o tipo certo e com cache longo", async () => {
  const original = arquivos.bytesDoDocumento;
  arquivos.bytesDoDocumento = async () => Buffer.from([1, 2, 3]);

  try {
    const { app } = monta();
    const r = await call(app, "get", "/public/conta-foto/marlon/c1");

    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/webp");
    assert.match(r.headers["cache-control"], /max-age=31536000/);
    // E NÃO `immutable`: o endereço é fixo e a imagem pode ser trocada
    // quando a Página muda de logo.
    assert.ok(!/immutable/.test(r.headers["cache-control"]));
  } finally {
    arquivos.bytesDoDocumento = original;
  }
});

test("e devolve 304 para quem já tem a versão que está lá", async () => {
  const original = arquivos.bytesDoDocumento;
  arquivos.bytesDoDocumento = async () => Buffer.from([1, 2, 3]);

  try {
    const { app } = monta();
    const primeira = await call(app, "get", "/public/conta-foto/marlon/c1");
    const segunda = await call(app, "get", "/public/conta-foto/marlon/c1", {
      headers: { "if-none-match": primeira.headers.etag },
    });

    assert.equal(segunda.status, 304);
  } finally {
    arquivos.bytesDoDocumento = original;
  }
});

test("conta sem foto é 404 seco, e não um 500", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/public/conta-foto/marlon/naoexiste");

  assert.equal(r.status, 404);
  assert.equal(r.body, undefined, "aqui não há quem leia mensagem traduzida");
});
