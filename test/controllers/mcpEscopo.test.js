const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const { fakeApp, call } = require("../helpers/harness.js");
const McpController = require("../../controllers/Mcp.js");
const tools = require("../../lib/mcpTools.js");

// O ESCOPO DA CONEXÃO, na porta MCP.
//
// *"no SprintHub a gente escolhe quais ferramentas vão estar disponíveis"*
// (08/11/2026).
//
// ── O QUE ESTES CASOS SEGURAM ───────────────────────────────────────────
//
// Duas perguntas que o sistema confundia numa só:
//
//   PERMISSÃO   *esta PESSOA pode?* — o papel dela. Já era conferida na
//               chamada, e continua sendo o TETO.
//
//   ESCOPO      *esta CONEXÃO deveria?* — a lista na chave de API. Não
//               existia: toda chave levava as 83.
//
// O caso que importa mais é o que prova que o escopo **não alarga**. No dia em
// que alguém puser `pessoa_excluir` na lista de uma chave de quem não tem
// `people.delete`, nada na tela quebra — a chave simplesmente passaria a
// apagar fichas, se esta suíte não estivesse aqui. Uma collection que concede
// poder é um segundo lugar de autorização, e dois lugares é onde o furo mora.
const TREINADOR = { _id: new ObjectId(), name: "Marlon" };

function monta({ permissoes = ["people.view"], escopoDaChave = null, nivel } = {}) {
  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify(req) {
          // `escopoDaChave` nulo é entrada pela SESSÃO do app: ali não há
          // chave, e portanto não há escopo — a conexão é a pessoa.
          if (escopoDaChave || nivel) {
            req._apiKey = { _id: "k1", ferramentas: escopoDaChave || [], nivel };
          }
          return TREINADOR;
        },
        has(user, permissao) {
          return permissoes.includes(permissao);
        },
      },
    },
    api: {
      apiKey: {
        ferramentasDa: (doc) => (Array.isArray(doc?.ferramentas) ? doc.ferramentas : []),
        nivelDe: (doc) => tools.nivelValido(doc?.nivel),
      },
      user: {
        async pageStudents() {
          return { rows: [] };
        },
      },
    },
  });

  McpController(app);
  return { app };
}

const rpc = (app, method, params) =>
  call(app, "post", "/mcp", { body: { jsonrpc: "2.0", id: 1, method, params } });

const nomes = (r) => r.body.result.tools.map((f) => f.name);
const saida = (r) => r.body.result.structuredContent;

// ── `tools/list` agora filtra ────────────────────────────────────────────

test("a listagem traz só o que a PERMISSÃO alcança", async () => {
  // Antes deste caso, uma recepcionista com `people.view` recebia as 83
  // ferramentas — 37 mil caracteres, ~9.400 tokens — incluindo o esquema
  // inteiro de `pessoa_excluir`, que ela descobriria não poder só tentando.
  const { app } = monta({ permissoes: ["people.view"] });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.ok(lista.includes("pessoa_buscar"));
  assert.ok(!lista.includes("pessoa_excluir"), "apagar ficha pede people.delete");
  assert.ok(!lista.includes("cobranca_criar"), "e dinheiro pede finance.manage");
});

test("sem chave, o escopo não existe: vale a permissão inteira", async () => {
  // A sessão do app é a conexão da PESSOA. Não há terceiro a quem estreitar.
  const { app } = monta({ permissoes: ["people.view", "people.delete"] });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.ok(lista.includes("pessoa_buscar"));
  assert.ok(lista.includes("pessoa_excluir"));
});

test("a chave ESTREITA a listagem", async () => {
  const { app } = monta({
    permissoes: ["people.view", "people.delete"],
    escopoDaChave: ["pessoa_buscar"],
  });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.deepEqual(lista, ["pessoa_buscar"]);
});

test("chave com lista VAZIA leva todas — vazio é todas", async () => {
  // A convenção de `users.units` na ficha. Se vazio fosse "nenhuma", toda
  // chave criada antes deste deploy pararia de funcionar no mesmo instante,
  // sem ninguém entender por quê.
  const { app } = monta({
    permissoes: ["people.view", "people.delete"],
    escopoDaChave: [],
  });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.ok(lista.includes("pessoa_buscar"));
  assert.ok(lista.includes("pessoa_excluir"));
});

test("o escopo NÃO ALARGA: o que a permissão barra continua barrado", async () => {
  // O caso que justifica a suíte inteira. A chave pede explicitamente uma
  // ferramenta que a pessoa não alcança; a resposta é a mesma de quem não
  // pediu nada.
  const { app } = monta({
    permissoes: ["people.view"],
    escopoDaChave: ["pessoa_buscar", "pessoa_excluir"],
  });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.deepEqual(lista, ["pessoa_buscar"]);
});

// ── `tools/call` ─────────────────────────────────────────────────────────

test("chamar fora do escopo recusa, e diz que foi a CHAVE", async () => {
  // Separado de `sem_permissao` porque o conserto é outro: falta de permissão
  // se resolve com quem administra a conta, escopo se resolve na tela da
  // chave. Uma mensagem só mandaria metade das pessoas ao lugar errado.
  const { app } = monta({
    permissoes: ["people.view", "people.delete"],
    escopoDaChave: ["pessoa_buscar"],
  });

  const r = await rpc(app, "tools/call", { name: "pessoa_excluir", arguments: { id: "x" } });

  assert.equal(r.body.result.isError, true);
  assert.equal(saida(r).erro, "fora_do_escopo");
});

test("sem permissão continua dizendo que foi a PERMISSÃO, mesmo com a chave pedindo", async () => {
  const { app } = monta({
    permissoes: ["people.view"],
    escopoDaChave: ["pessoa_buscar", "pessoa_excluir"],
  });

  const r = await rpc(app, "tools/call", { name: "pessoa_excluir", arguments: { id: "x" } });

  assert.equal(r.body.result.isError, true);
  assert.equal(saida(r).erro, "sem_permissao");
});

test("dentro do escopo, executa", async () => {
  const { app } = monta({ permissoes: ["people.view"], escopoDaChave: ["pessoa_buscar"] });

  const r = await rpc(app, "tools/call", { name: "pessoa_buscar", arguments: { termo: "ana" } });

  assert.equal(r.body.result.isError, undefined);
  assert.equal(saida(r).ok, true);
});

// ── As anotações do MCP ──────────────────────────────────────────────────

test("toda ferramenta sai anotada, e as 18 destrutivas se declaram", async () => {
  const { app } = monta({ permissoes: ["people.view", "people.delete"] });
  const lista = (await rpc(app, "tools/list", {})).body.result.tools;

  const buscar = lista.find((f) => f.name === "pessoa_buscar");
  const excluir = lista.find((f) => f.name === "pessoa_excluir");

  assert.equal(buscar.annotations.readOnlyHint, true);
  assert.equal(buscar.annotations.destructiveHint, false);
  assert.equal(excluir.annotations.readOnlyHint, false);
  assert.equal(excluir.annotations.destructiveHint, true);

  // São campos do PRÓPRIO MCP, e é por isso que valem: um cliente de fora
  // (Claude Desktop e os outros) já sabe pedir confirmação antes de uma
  // destrutiva sem a gente combinar nada.
  assert.equal(tools.catalogo().filter((f) => f.destructiveHint).length, 18);
});

test("a INVARIANTE de que `readOnlyHint` depende: quem escreve nunca pede só .view", async () => {
  // A anotação é derivada da permissão, e não de um campo a mais em cada uma
  // das 83 — duas declarações da mesma verdade discordam um dia, e a errada é
  // a que o modelo lê. O que sustenta a derivação é esta regra do catálogo.
  //
  // Se este caso ficar vermelho, a correção NÃO é afrouxar a lista de verbos:
  // é consertar a ferramenta, que está escrevendo com permissão de leitura.
  const ESCREVE =
    /_(criar|editar|excluir|remover|adicionar|apagar|tirar|registrar|enviar|inscrever|preencher|situacao|presenca|fechar)$/;

  const erradas = tools.FERRAMENTAS.filter(
    (f) => ESCREVE.test(f.nome) && String(f.permissao).endsWith(".view")
  ).map((f) => `${f.nome} -> ${f.permissao}`);

  assert.deepEqual(erradas, []);

  // E o outro lado: as que NÃO escrevem pedem `.view`, que é o que faz
  // `readOnlyHint` ser verdade e não chute.
  const soLeitura = tools.FERRAMENTAS.filter((f) => !ESCREVE.test(f.nome));
  assert.equal(soLeitura.length, 26);
  assert.deepEqual(
    soLeitura.filter((f) => !String(f.permissao).endsWith(".view")).map((f) => f.nome),
    []
  );
});

// ── A validação da lista guardada ────────────────────────────────────────

test("nome inventado não entra, repetido não duplica", async () => {
  // A lista vem da tela, e tela manda o que o navegador tiver. Um nome que não
  // existe entrando na chave seria uma linha morta que ninguém mais explica —
  // e, pior, que some do significado quando alguém renomear a ferramenta.
  assert.deepEqual(tools.ferramentasValidas(["pessoa_buscar", "voar"]), ["pessoa_buscar"]);
  assert.deepEqual(tools.ferramentasValidas(["pessoa_buscar", "pessoa_buscar"]), ["pessoa_buscar"]);
  assert.deepEqual(tools.ferramentasValidas("pessoa_buscar"), []);
  assert.deepEqual(tools.ferramentasValidas(null), []);
});

test("todas as 83 declaram grupo, e o grupo é um dos do catálogo", async () => {
  // O grupo é o que a tela usa para não desenhar 83 caixas soltas. Uma
  // ferramenta nova sem grupo não quebraria nada no servidor — ela sumiria da
  // tela, que é o jeito mais silencioso de uma ferramenta deixar de existir.
  const GRUPOS = new Set([
    "pessoas", "treinos", "dietas", "financeiro", "agenda", "avaliacoes",
    "unidades", "aulas", "planos", "auloes", "anamnese", "exames",
    "suplementos", "prescricoes", "conversas",
  ]);

  const semGrupo = tools.catalogo().filter((f) => !GRUPOS.has(f.grupo));
  assert.deepEqual(semGrupo.map((f) => f.nome), []);
  assert.equal(tools.catalogo().length, 83);
});

// ── O QUE UM CLIENTE DE FORA ENCONTRA ───────────────────────────────────
//
// *"queria fazer algo parecido… para poder fazer integração externa"*
// (08/11/2026).

test("GET e DELETE respondem 405, e não 404", async () => {
  // O transporte Streamable HTTP do MCP prevê que o cliente SONDE o GET para
  // abrir um fluxo de eventos. Este servidor não tem fluxo — mas 404 faz o
  // cliente ler "este endereço não existe" e desistir da conexão inteira,
  // inclusive do POST que funcionaria.
  //
  // 405 com `Allow: POST` diz a coisa certa: o endereço existe, o método é que
  // não. Foi o que o teste contra produção mostrou antes de isto existir.
  const { app } = monta();

  for (const metodo of ["get", "delete"]) {
    const r = await call(app, metodo, "/mcp");
    assert.equal(r.status, 405, metodo);
    assert.equal(r.headers?.Allow || r.headers?.allow, "POST");
  }
});

// ── O NÍVEL: ler, escrever, apagar ──────────────────────────────────────
//
// *"seria possível poder escolher se a ferramenta pode apagar, editar ou
// apagar? … evitar que algum mcp externo apague o que não deveria"*
// (08/11/2026).
//
// Eixo diferente da lista de ferramentas: ela diz ONDE a conexão mexe, o nível
// diz O QUÃO FUNDO. Um agente de atendimento quer nove grupos e nenhum apagar
// — e expressar isso só com a lista obrigaria a caçar as 18 destrutivas no
// meio de 83 nomes e desmarcar uma a uma. Esquecer uma seria o resultado.

test("a escada cobre o catálogo inteiro, sem sobra nem repetição", async () => {
  // 26 + 39 + 18 = 83. Se um dia não fechar, é porque nasceu uma ferramenta
  // que não é nem leitura, nem escrita, nem apagar — e aí a classificação
  // precisa de gente, não de um `else`.
  const porNivel = (n) => tools.FERRAMENTAS.filter((f) => tools.nivelDe(f) === n).length;

  assert.equal(porNivel("ler"), 26);
  assert.equal(porNivel("escrever"), 39);
  assert.equal(porNivel("apagar"), 18);
  assert.equal(porNivel("ler") + porNivel("escrever") + porNivel("apagar"), 83);
});

test("nível `ler` não lista NADA que escreva", async () => {
  const { app } = monta({
    permissoes: ["people.view", "people.create", "people.edit", "people.delete"],
    nivel: "ler",
  });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.ok(lista.includes("pessoa_buscar"));
  assert.ok(!lista.includes("pessoa_criar"));
  assert.ok(!lista.includes("pessoa_excluir"));
});

test("nível `escrever` cria e edita, mas NUNCA apaga", async () => {
  // É o degrau que quase toda integração quer, e o motivo do pedido.
  const { app } = monta({
    permissoes: ["people.view", "people.create", "people.edit", "people.delete"],
    nivel: "escrever",
  });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.ok(lista.includes("pessoa_buscar"));
  assert.ok(lista.includes("pessoa_criar"));
  assert.ok(lista.includes("pessoa_editar"));
  assert.ok(!lista.includes("pessoa_excluir"), "apagar exige o degrau de cima");
});

test("chamar acima do nível recusa, e diz que foi o NÍVEL", async () => {
  // Mensagem própria porque o conserto é outro: este se resolve subindo o
  // nível da conexão, não acrescentando ferramenta à lista.
  const { app } = monta({
    permissoes: ["people.view", "people.delete"],
    nivel: "escrever",
  });

  const r = await rpc(app, "tools/call", { name: "pessoa_excluir", arguments: { id: "x" } });

  assert.equal(r.body.result.isError, true);
  assert.equal(saida(r).erro, "nivel_insuficiente");
});

test("o nível NÃO ALARGA: `apagar` sem permissão continua sem apagar", async () => {
  const { app } = monta({ permissoes: ["people.view"], nivel: "apagar" });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.ok(!lista.includes("pessoa_excluir"));
});

test("chave SEM o campo continua alcançando tudo", async () => {
  // Estreitar em silêncio uma credencial que já está numa integração rodando
  // derruba o sistema de alguém num deploy que ninguém ligaria à causa. O
  // padrão seguro vale para quem NASCE da tela nova.
  const { app } = monta({
    permissoes: ["people.view", "people.delete"],
    escopoDaChave: ["pessoa_buscar", "pessoa_excluir"],
  });
  const lista = nomes(await rpc(app, "tools/list", {}));

  assert.ok(lista.includes("pessoa_excluir"));
});

test("nível inventado cai em `apagar`, e não em nada", async () => {
  // Um valor estranho vindo do banco não pode virar "alcança zero": a
  // integração pararia sem erro nenhum que explicasse.
  assert.equal(tools.nivelValido("voar"), "apagar");
  assert.equal(tools.nivelValido(undefined), "apagar");
  assert.equal(tools.nivelValido("ler"), "ler");
});
