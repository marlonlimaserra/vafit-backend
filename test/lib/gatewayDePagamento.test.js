const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const gateways = require("../../lib/gateways");
const PaymentGateway = require("../../model/PaymentGateway_model.js");

// OS GATEWAYS DE PAGAMENTO — Asaas e Pagar.me.
//
// *"quero fazer um 'gateways de pagamento' e integrar asaas e pagar.me, aí ele
// vai configurar a integração e só vai poder escolher por onde as faturas e
// assinaturas serão geradas"* (10/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. O AMBIENTE É DESCOBERTO, nunca perguntado. Uma chave de produção marcada
//    como "sandbox" faria o primeiro boleto "de teste" ser um boleto de
//    verdade, com o nome da casa, na mão de um aluno.
// 2. A CHAVE NUNCA VOLTA PARA A TELA. Nem no que o modelo devolve, nem no que
//    ele pede ao banco.
// 3. "FORA DO AR" NÃO É "CHAVE INVÁLIDA". Confundir os dois manda a pessoa
//    trocar uma chave boa e procurar o problema onde ele não está.

const respondendo = (porUrl) => async (url) => {
  const r = porUrl(String(url));
  if (r instanceof Error) throw r;
  return {
    ok: (r.status || 200) < 400,
    status: r.status || 200,
    async json() {
      return r.corpo || {};
    },
  };
};

// ── O CATÁLOGO ────────────────────────────────────────────────────────────

test("a pasta é o índice — não há lista central para esquecer de atualizar", () => {
  const arquivos = fs
    .readdirSync(path.join(__dirname, "..", "..", "lib", "gateways"))
    .filter((n) => n.endsWith(".js") && n !== "index.js");

  assert.equal(gateways.GATEWAYS.length, arquivos.length);
  assert.deepEqual(gateways.catalogo().map((g) => g.chave).sort(), ["asaas", "pagarme"]);
});

test("o catálogo que vai para a tela não leva `conferir` nem `formato`", () => {
  // Um é função e não atravessa JSON; o outro é regra de servidor, e mandá-la
  // para o navegador convidaria a validar lá e confiar no resultado aqui.
  for (const g of gateways.catalogo()) {
    assert.deepEqual(Object.keys(g).sort(), [
      "chave",
      "formaDeCartao",
      "formas",
      "nome",
      "ondePegar",
      "tokeniza",
    ]);
  }
});

test("e leva as FORMAS que cada um emite — a tela recorta o seletor por elas", () => {
  // *"se tiver com asaas pendente, só pode ter pix, cartão de crédito, boleto
  // e qualquer forma"* (18/10/2026). Dinheiro e transferência existem no
  // catálogo da casa e NÃO existem no gateway: oferecê-los numa cobrança que
  // virou fatura seria prometer um boleto "em dinheiro".
  //
  // Vem do servidor, como todo catálogo daqui: a tela não pode aprender que
  // o Asaas emite três coisas, senão a terceira marca nasce errada.
  const porChave = Object.fromEntries(gateways.catalogo().map((g) => [g.chave, g.formas]));

  assert.deepEqual([...porChave.asaas].sort(), ["billet", "credit", "pix"]);
  // O Pagar.me ainda não emite nada por aqui — e isso é uma LISTA VAZIA, não
  // um campo ausente que sumiria no JSON.
  assert.deepEqual(porChave.pagarme, []);
});

test("mas leva `tokeniza` — é a tela sabendo de quem cabe perguntar por cartão", () => {
  // Sem isto a tela teria um `if` com o nome "asaas" dentro, e a terceira
  // marca nasceria com a caixa escondida. E `false` explícito, nunca
  // `undefined`: ausente some no JSON e vira "não sei" no meio de um `if`.
  const porChave = Object.fromEntries(gateways.catalogo().map((g) => [g.chave, g.tokeniza]));
  assert.deepEqual(porChave, { asaas: true, pagarme: false });
});

test("um tipo desconhecido devolve null, e não um objeto qualquer", () => {
  // É o que impede `GATEWAYS[req.params.tipo]` — um parâmetro da URL
  // escolhendo que código roda.
  assert.equal(gateways.de("constructor"), null);
  assert.equal(gateways.de("__proto__"), null);
  assert.equal(gateways.de(""), null);
});

// ── O ASAAS: DOIS HOSTS, E A CHAVE DIZ QUAL ───────────────────────────────

const asaas = gateways.de("asaas");
const CHAVE_ASAAS = "$aact_" + "Y".repeat(40) + "==";

test("o ambiente do Asaas é DESCOBERTO: 401 no sandbox, 200 na produção", async () => {
  const r = await asaas.conferir(
    CHAVE_ASAAS,
    respondendo((url) =>
      url.includes("sandbox")
        ? { status: 401 }
        : { corpo: { name: "Marlon", email: "m@x.com", cpfCnpj: "153" } }
    )
  );

  assert.equal(r.ok, true);
  assert.equal(r.ambiente, "producao");
  // E ele traz a conta: nome e e-mail identificam melhor que seis caracteres
  // de uma chave que ninguém decora.
  assert.deepEqual(r.conta, { nome: "Marlon", email: "m@x.com", documento: "153" });
});

test("e quando a chave é de teste, o ambiente é sandbox — sem ninguém marcar nada", async () => {
  const r = await asaas.conferir(
    CHAVE_ASAAS,
    respondendo((url) => (url.includes("sandbox") ? { corpo: { name: "Teste" } } : { status: 401 }))
  );

  assert.equal(r.ambiente, "sandbox");
});

test("o sandbox é testado PRIMEIRO — na dúvida, a leitura segura é 'isto é teste'", async () => {
  const vistos = [];
  await asaas.conferir(
    CHAVE_ASAAS,
    respondendo((url) => {
      vistos.push(url);
      return { corpo: { name: "Os dois respondem" } };
    })
  );

  assert.match(vistos[0], /api-sandbox\.asaas\.com/);
});

test("401 nos dois é chave inválida", async () => {
  const r = await asaas.conferir(CHAVE_ASAAS, respondendo(() => ({ status: 401 })));
  assert.deepEqual(r, { ok: false, erro: "chave_invalida" });
});

test("rede fora NÃO é chave inválida — dizer isso manda trocar uma chave boa", async () => {
  const r = await asaas.conferir(
    CHAVE_ASAAS,
    respondendo(() => new Error("getaddrinfo ENOTFOUND"))
  );
  assert.deepEqual(r, { ok: false, erro: "fora_do_ar" });
});

test("o formato recusa o que não é chave do Asaas, antes de bater na rede", () => {
  assert.ok(asaas.formato.test(CHAVE_ASAAS));
  assert.ok(!asaas.formato.test("minha senha"));
  assert.ok(!asaas.formato.test("$aact_"));
});

// ── O PAGAR.ME: UM HOST SÓ, E O PREFIXO DECIDE ────────────────────────────

const pagarme = gateways.de("pagarme");

test("no Pagar.me o ambiente sai do PREFIXO da chave, porque o host é o mesmo", async () => {
  const chamadas = [];
  const ouvindo = respondendo((url) => {
    chamadas.push(url);
    return { corpo: { data: [] } };
  });

  const teste = await pagarme.conferir("sk_test_" + "a".repeat(16), ouvindo);
  const vivo = await pagarme.conferir("sk_" + "a".repeat(16), ouvindo);

  assert.equal(teste.ambiente, "sandbox");
  assert.equal(vivo.ambiente, "producao");
  // O mesmo endereço nas duas: é a chave que muda de mundo, não a URL.
  assert.equal(chamadas[0], chamadas[1]);
  assert.match(chamadas[0], /^https:\/\/api\.pagar\.me\/core\/v5\//);
});

// ── A CHAVE PÚBLICA É A ARMADILHA DA TELA DA STONE ───────────────────────
//
// *"o da stone seria aqui? seria isso? pk_5xgRg9dIMh1QYolk"* (14/10/2026) —
// e não era. A tela de chaves da Stone mostra a PÚBLICA em destaque, com
// botão de copiar, enquanto a lista de secretas começa vazia. Quem lê
// depressa copia a errada, e copia CERTO: o problema não é o dedo, é a tela.
test("a chave pública do Pagar.me é recusada como OUTRO TIPO, não como chave torta", () => {
  assert.ok(pagarme.tipoErrado.test("pk_5xgRg9dIMh1QYolk"));
  // E não passa no formato, que é a segunda rede.
  assert.ok(!pagarme.formato.test("pk_5xgRg9dIMh1QYolk"));
});

test("e a secreta não cai nessa rede — senão nenhuma chave entraria", () => {
  assert.ok(!pagarme.tipoErrado.test("sk_" + "a".repeat(16)));
  assert.ok(!pagarme.tipoErrado.test("sk_test_" + "a".repeat(16)));
  assert.ok(pagarme.formato.test("sk_" + "a".repeat(16)));
});

test("o Asaas não declara tipo errado — lá só existe uma espécie de chave", () => {
  // Inventar uma rede que nunca pega nada é pior que não ter: ela convida a
  // mexer sem entender, e o dia em que o Asaas criar uma segunda chave
  // alguém vai achar que já estava tratado.
  assert.equal(asaas.tipoErrado, undefined);
});

test("o Basic leva a chave no USUÁRIO e a senha vazia — os dois-pontos não são enfeite", async () => {
  let cabecalhos = null;
  await pagarme.conferir("sk_test_abcdefghij123456", async (url, o) => {
    cabecalhos = o.headers;
    return { ok: true, status: 200, async json() { return {}; } };
  });

  const [, base64] = cabecalhos.Authorization.split(" ");
  assert.equal(Buffer.from(base64, "base64").toString(), "sk_test_abcdefghij123456:");
});

// ── O MODELO ──────────────────────────────────────────────────────────────

// `{ campo: null }` no Mongo casa com o documento que NÃO TEM o campo, e é
// disso que o produto depende: `unit: null` é "a casa", e as linhas gravadas
// antes de as filiais existirem não têm `unit` nenhum. Um dobro que comparasse
// `undefined === null` diria que elas não existem, e `ativo()` devolveria
// `null` com o gateway da casa configurado e ligado.
// E o ObjectId compara por VALOR, não por identidade: `new ObjectId(x)` nunca
// é `===` a outro, nem à string de 24 dígitos que o teste escreveu. Um dobro
// que usasse `===` diria que a filial não tem gateway e aprovaria uma herança
// que não é a que o produto faz.
function casa(doc, filtro) {
  return Object.entries(filtro).every(([k, v]) =>
    v === null ? doc[k] == null : String(doc[k]) === String(v)
  );
}

function modelo({ docs = [] } = {}) {
  const chamadas = [];
  const col = {
    find(filtro, opcoes) {
      chamadas.push({ metodo: "find", filtro, opcoes });
      return { async toArray() { return docs; } };
    },
    async findOne(filtro, opcoes) {
      chamadas.push({ metodo: "findOne", filtro, opcoes });
      // O falso OBEDECE ao filtro, por mais bobo que ele seja. Um que
      // devolvesse sempre o primeiro documento aprovaria um `ativo()` que
      // ignorasse `{ ativo: true }` — e aí a cobrança sairia pelo gateway
      // desligado.
      return docs.find((d) => casa(d, filtro)) || null;
    },
    async updateOne(filtro, mudanca, opcoes) {
      chamadas.push({ metodo: "updateOne", filtro, mudanca, opcoes });
    },
    async updateMany(filtro, mudanca) {
      chamadas.push({ metodo: "updateMany", filtro, mudanca });
    },
    async deleteOne(filtro) {
      chamadas.push({ metodo: "deleteOne", filtro });
      return { deletedCount: docs.some((d) => d.tipo === filtro.tipo) ? 1 : 0 };
    },
    async deleteMany(filtro) {
      chamadas.push({ metodo: "deleteMany", filtro });
      return { deletedCount: docs.filter((d) => casa(d, filtro)).length };
    },
  };

  const m = new PaymentGateway({
    mongodb: { async connectToServer() { return { collection: () => col }; } },
  });
  return { m, chamadas };
}

test("a lista traz os DOIS gateways, ligados ou não — senão a tela vazia não tem onde clicar", async () => {
  const { m } = modelo({ docs: [{ tipo: "asaas", ambiente: "producao", ativo: true, fim: "abc123" }] });

  const rows = await m.lista();

  assert.deepEqual(rows.map((r) => r.chave), ["asaas", "pagarme"]);
  assert.equal(rows[0].ligado.ativo, true);
  assert.equal(rows[1].ligado, null);
});

test("a chave não sai do banco nas rotas de leitura — a projeção a corta na origem", async () => {
  const { m, chamadas } = modelo({ docs: [] });
  await m.lista();

  const find = chamadas.find((c) => c.metodo === "find");
  assert.equal(find.opcoes.projection.chave, 0);
});

test("e `paraTela` não tem como devolvê-la nem se ela vier", async () => {
  const { m } = modelo();
  const visto = m.paraTela({ tipo: "asaas", chave: "$aact_segredo", fim: "egredo" });

  assert.equal(visto.chave, undefined);
  assert.equal(visto.fim, "egredo");
});

test("trocar a chave do gateway ATIVO não o desliga", async () => {
  // Ela vaza, ela é revogada, ela se troca. Se `salvar` escrevesse
  // `ativo: false`, trocar a chave pararia a cobrança da casa sem avisar.
  const { m, chamadas } = modelo({ docs: [{ tipo: "asaas", ativo: true }] });

  await m.salvar("asaas", { chave: "$aact_nova", ambiente: "producao", conta: {} }, "u1");

  const up = chamadas.find((c) => c.metodo === "updateOne");
  assert.equal(up.mudanca.$set.ativo, undefined);
  assert.equal(up.mudanca.$setOnInsert.ativo, false);
  assert.equal(up.opcoes.upsert, true);
});

test("o fim gravado são os seis últimos — é por ele que se reconhece a chave colada", async () => {
  const { m, chamadas } = modelo();
  await m.salvar("asaas", { chave: "$aact_qualquer_coisa_XYZ789", conta: {} }, "u1");

  // Pelo MÉTODO e não pela posição: `salvar` lê a linha antes de gravar (é
  // assim que ele sabe se a chave nova é de outra conta), e uma leitura a
  // mais no meio não pode derrubar um teste sobre o que foi escrito.
  const up = chamadas.find((c) => c.metodo === "updateOne");
  assert.equal(up.mudanca.$set.fim, "XYZ789");
});

test("escolher desliga os outros ANTES de ligar este", async () => {
  // A ordem inversa deixaria dois ativos por um instante, e o índice único
  // parcial de `database/schema.js` recusaria a escrita.
  const { m, chamadas } = modelo({ docs: [{ tipo: "pagarme" }] });

  const r = await m.ativar("pagarme");

  assert.deepEqual(r, { ok: true });
  const escritas = chamadas.filter((c) => c.metodo.startsWith("update"));
  assert.equal(escritas[0].metodo, "updateMany");
  assert.deepEqual(escritas[0].mudanca.$set, { ativo: false });
  assert.equal(escritas[1].mudanca.$set.ativo, true);
});

test("não dá para escolher um gateway que não foi configurado", async () => {
  const { m } = modelo({ docs: [] });
  assert.deepEqual(await m.ativar("asaas"), { erro: "nao_configurado" });
});

test("nenhum ativo é um estado legítimo — é a casa dizendo 'cobro na mão'", async () => {
  const { m } = modelo({ docs: [{ tipo: "asaas", ativo: false }] });

  await m.desativar();
  assert.equal(await m.ativo(), null);
});

test("`ativo()` é o único que lê a chave — e ele a lê inteira, porque quem cobra precisa dela", async () => {
  const { m, chamadas } = modelo({
    docs: [{ tipo: "asaas", ativo: true, chave: "$aact_segredo", ambiente: "producao" }],
  });

  const usar = await m.ativo();

  assert.equal(usar.chave, "$aact_segredo");
  // Sem projeção NA BUSCA DO ATIVO: aqui o segredo é o ponto. (Não é mais a
  // última chamada: `ativo()` passou a garantir o segredo do webhook, e isso
  // são mais duas idas ao banco — ver o teste seguinte.)
  const buscaDoAtivo = chamadas.find((c) => c.metodo === "findOne" && c.filtro.ativo === true);
  assert.equal(buscaDoAtivo.opcoes, undefined);
});

// ── O SEGREDO DO WEBHOOK ──────────────────────────────────────────────────
//
// O aviso de pagamento chega numa rota PÚBLICA, de um IP que não controlamos.
// Sem segredo, quem descobrir o endereço marca a mensalidade de qualquer aluno
// como paga. Ele nasce na primeira vez que alguém vai cobrar, e é POR CLIENTE:
// vazar o de uma academia não pode abrir a porta da outra.

test("`ativo()` cria o segredo do webhook na primeira vez", async () => {
  const { m, chamadas } = modelo({
    docs: [{ tipo: "asaas", ativo: true, chave: "$aact_x", ambiente: "producao" }],
  });

  const usar = await m.ativo();

  assert.match(usar.segredo, /^[0-9a-f]{48}$/);

  // A escrita é CONDICIONADA à ausência: duas cobranças ao mesmo tempo na
  // primeira vez não podem gerar dois segredos, porque o webhook lá no Asaas
  // foi registrado com um só.
  const gravou = chamadas.find((c) => c.metodo === "updateOne" && c.mudanca.$set?.webhookSegredo);
  assert.deepEqual(gravou.filtro.webhookSegredo, { $in: [null, ""] });
});

test("o segredo que já existe é REUSADO, e não trocado", async () => {
  // Trocá-lo a cada cobrança invalidaria o webhook registrado lá: todo aviso
  // seguinte chegaria com o token velho e seria recusado por nós.
  const { m, chamadas } = modelo({
    docs: [{ tipo: "asaas", ativo: true, chave: "$aact_x", webhookSegredo: "jaera" }],
  });

  assert.equal((await m.ativo()).segredo, "jaera");
  assert.equal(chamadas.filter((c) => c.metodo === "updateOne").length, 0);
});

test("`credenciais()` entrega chave e segredo — é o caminho do webhook, não o da tela", async () => {
  // Fora de `paraTela` de propósito: quem chama isto não está servindo tela
  // nenhuma, e misturar os dois faria o segredo viajar num `res.send`.
  const { m } = modelo({
    docs: [{ tipo: "asaas", ativo: true, chave: "$aact_x", webhookSegredo: "s3", ambiente: "sandbox" }],
  });

  const c = await m.credenciais("asaas");
  assert.equal(c.segredo, "s3");
  assert.equal(c.ambiente, "sandbox");
  assert.equal(await m.credenciais("pagarme"), null);
});

test("`paraTela` NÃO leva o segredo do webhook", async () => {
  // Ele vale tanto quanto a chave: com ele na mão, qualquer um fecha cobrança
  // de qualquer aluno daquela casa.
  const { m } = modelo({
    docs: [{ tipo: "asaas", ativo: true, chave: "$aact_x", webhookSegredo: "s3" }],
  });

  const linha = (await m.lista()).find((g) => g.chave === "asaas");
  assert.equal(JSON.stringify(linha).includes("s3"), false);
});

test("desligar APAGA a linha, com a chave dentro", async () => {
  // Guardar a credencial de um gateway que a casa desligou é manter vivo um
  // segredo que ninguém mais vigia.
  const { m, chamadas } = modelo({ docs: [{ tipo: "asaas" }] });

  assert.deepEqual(await m.desligar("asaas"), { ok: true });
  assert.equal(chamadas.at(-1).metodo, "deleteOne");
  assert.deepEqual(await m.desligar("pagarme"), { ok: false });
});

// ── UM GATEWAY POR FILIAL ─────────────────────────────────────────────────
//
// *"acho que cada filial terá que ter suas chaves de gateway de pagamento
// também"* (14/10/2026). A filial pode ter CNPJ próprio, e o dinheiro de quem
// treina em Paraty tem de cair na conta de Paraty.
//
// `unit: null` é A CASA — o que existia até hoje.
//
// Os ids são ObjectId de verdade: o modelo valida antes de consultar, e um
// "paraty" solto vira `null` — ou seja, a casa. O dobro guarda a STRING
// porque é assim que ele compara; o que importa no teste é que a linha certa
// seja encontrada.
const PARATY = "6aac6f7fce88864c1d79e021";
const NITEROI = "6aac6f7fce88864c1d79e022";

const CASA = { tipo: "asaas", ativo: true, chave: "$aact_casa", unit: null };
const FILIAL = (unit) => ({ tipo: "asaas", ativo: true, chave: "$aact_" + unit, unit });

test("a filial com chave própria cobra pela conta DELA", async () => {
  const { m } = modelo({ docs: [CASA, FILIAL(PARATY)] });

  assert.equal((await m.ativo(PARATY)).chave, "$aact_" + PARATY);
});

test("a filial SEM chave própria herda a da casa", async () => {
  // Esta é a regra que faz a mudança não quebrar nada. Sem ela, cadastrar a
  // primeira filial pararia a cobrança de quem treina nela — e ninguém ligaria
  // uma coisa à outra.
  const { m } = modelo({ docs: [CASA] });

  const usar = await m.ativo(NITEROI);
  assert.equal(usar.chave, "$aact_casa");
  // E a conta que cobra é a da CASA: é o que o webhook precisa saber para
  // conferir o segredo certo, e não dá para deduzir de "niteroi".
  assert.equal(usar.unidade, null);
});

test("a casa NUNCA herda de uma filial", async () => {
  // Ela é a raiz; "qual filial?" não teria resposta.
  const { m } = modelo({ docs: [FILIAL(PARATY)] });
  assert.equal(await m.ativo(), null);
});

test("linha antiga, sem o campo `unit`, continua sendo a da casa", async () => {
  // Toda linha gravada antes de 14/10/2026 é assim. No Mongo `{unit: null}`
  // casa com o documento que não tem o campo — se não casasse, a cobrança de
  // toda instalação existente pararia no deploy.
  const { m } = modelo({ docs: [{ tipo: "asaas", ativo: true, chave: "$aact_velha" }] });

  assert.equal((await m.ativo()).chave, "$aact_velha");
  assert.equal((await m.ativo(PARATY)).chave, "$aact_velha");
});

test("ativar na filial NÃO desliga o da casa", async () => {
  // Sem o escopo, configurar a segunda filial derrubaria a cobrança da
  // primeira — calado.
  const { m, chamadas } = modelo({ docs: [CASA, { tipo: "pagarme", unit: PARATY }] });

  await m.ativar("pagarme", PARATY);

  const desligou = chamadas.find((c) => c.metodo === "updateMany");
  assert.equal(String(desligou.filtro.unit), PARATY);
});

test("a lista de uma filial mostra só as chaves DELA", async () => {
  const { m, chamadas } = modelo({ docs: [] });

  await m.lista(PARATY);
  assert.equal(String(chamadas.at(-1).filtro.unit), PARATY);

  await m.lista();
  assert.equal(chamadas.at(-1).filtro.unit, null);
});

test("apagar a unidade apaga as chaves dela", async () => {
  // Guardar a credencial de cobrança de uma filial que não existe mais é
  // manter vivo um segredo que ninguém vigia.
  const { m, chamadas } = modelo({ docs: [] });

  await m.apagarDaUnidade(PARATY);
  assert.equal(chamadas.at(-1).metodo, "deleteMany");

  // E sem unidade não apaga NADA — um `deleteMany({unit: null})` distraído
  // levaria junto a conta da casa.
  chamadas.length = 0;
  assert.equal(await m.apagarDaUnidade(""), 0);
  assert.equal(chamadas.length, 0);
});

test("apagar a unidade tira o aviso de pagamento do gateway ANTES da chave", async () => {
  // *"quando eu excluí a chave deveria excluir o webhook lá"* (15/10/2026).
  // Vale para a filial inteira: a URL dela some, e um webhook apontando para
  // ela levaria 401 em cada aviso até o Asaas interromper a fila da CONTA.
  const { m, chamadas } = modelo({ docs: [{ tipo: "asaas", unit: PARATY }] });

  const removidos = [];
  m.app.api = {
    cobrador: {
      async removerWebhook(tipo, unidade) {
        // A ordem importa: a chave ainda tem de estar no banco aqui, porque é
        // ela que autentica a remoção lá.
        removidos.push({ tipo, unidade, aindaNoBanco: !chamadas.some((c) => c.metodo === "deleteMany") });
        return { ok: true };
      },
    },
  };

  await m.apagarDaUnidade(PARATY);

  assert.deepEqual(removidos, [{ tipo: "asaas", unidade: String(PARATY), aindaNoBanco: true }]);
});


// ── A TOKENIZAÇÃO DE CARTÃO ───────────────────────────────────────────────
//
// *"coloque um checkbox, 'tokenização de cartão ativo' no asaas, pelo menos,
// eles precisam pedir para ativar, aí, se ativar, conseguimos tokerizar o
// cartão de crédito para pagar faturas"* (16/10/2026).
//
// É a única coisa desta tela que a casa DECLARA em vez de o servidor
// descobrir — porque a API do Asaas não responde "a minha conta pode
// tokenizar?". O que estes testes seguram é que a declaração não se espalhe
// para onde ela não vale.

test("marcar a tokenização grava um booleano, e não o que vier", async () => {
  const { m, chamadas } = modelo({ docs: [{ tipo: "asaas", unit: null }] });

  assert.deepEqual(await m.marcarTokenizacao("asaas", "", "sim"), { ok: true });

  const up = chamadas.find((c) => c.metodo === "updateOne");
  assert.equal(up.mudanca.$set.tokenizacao, true);
});

test("e não marca gateway que não está configurado — isso criaria linha sem chave", async () => {
  // Um upsert aqui faria `ativo()` encontrar um gateway que não sabe cobrar.
  const { m, chamadas } = modelo({ docs: [] });

  assert.deepEqual(await m.marcarTokenizacao("asaas", "", true), { erro: "nao_configurado" });
  assert.equal(chamadas.some((c) => c.metodo === "updateOne"), false);
});

test("a declaração é POR UNIDADE: marcar na casa não libera a filial", async () => {
  // A liberação é da CONTA do Asaas, e a filial com CNPJ próprio tem a dela.
  const { m, chamadas } = modelo({ docs: [{ tipo: "asaas", unit: PARATY }] });

  await m.marcarTokenizacao("asaas", PARATY, true);

  const up = chamadas.find((c) => c.metodo === "updateOne");
  assert.equal(String(up.filtro.unit), String(PARATY));
});

test("`paraTela` leva a caixa como booleano — ausente é `false`, não `undefined`", () => {
  const { m } = modelo();

  assert.equal(m.paraTela({ tipo: "asaas" }).tokenizacao, false);
  assert.equal(m.paraTela({ tipo: "asaas", tokenizacao: true }).tokenizacao, true);
});

test("quem vai cobrar recebe a tokenização junto da chave", async () => {
  // Perguntar ANTES de pedir o número é o que evita a recusa do Asaas depois
  // de a pessoa ter digitado os dezesseis dígitos.
  const { m } = modelo({ docs: [{ tipo: "asaas", unit: null, ativo: true, tokenizacao: true }] });

  const cred = await m.ativo("");
  assert.equal(cred.tokenizacao, true);
});

test("trocar a chave DA MESMA conta mantém a liberação", async () => {
  // Rotação de chave é o caso comum (ela vaza, ela é revogada). Desmarcar
  // aqui pararia de guardar cartão sem ninguém ter pedido.
  const { m, chamadas } = modelo({
    docs: [{ tipo: "asaas", unit: null, conta: { documento: "153" }, tokenizacao: true }],
  });

  await m.salvar("asaas", { chave: "$aact_nova", conta: { documento: "153" } }, "u1");

  const up = chamadas.find((c) => c.metodo === "updateOne");
  assert.equal(up.mudanca.$set.tokenizacao, undefined);
});

test("mas a chave de OUTRA conta apaga a liberação — ela era da anterior", async () => {
  const { m, chamadas } = modelo({
    docs: [{ tipo: "asaas", unit: null, conta: { documento: "153" }, tokenizacao: true }],
  });

  await m.salvar("asaas", { chave: "$aact_outra", conta: { documento: "999" } }, "u1");

  const up = chamadas.find((c) => c.metodo === "updateOne");
  assert.equal(up.mudanca.$set.tokenizacao, false);
});

test("gateway que não diz o titular nunca cai nessa conta — 'não sei' não é 'mudou'", async () => {
  // O Pagar.me não tem um "quem sou eu". Com o documento vazio dos dois
  // lados, trocar a chave desmarcaria a caixa a cada salvamento.
  const { m, chamadas } = modelo({
    docs: [{ tipo: "pagarme", unit: null, conta: { documento: "" }, tokenizacao: true }],
  });

  await m.salvar("pagarme", { chave: "sk_nova", conta: {} }, "u1");

  const up = chamadas.find((c) => c.metodo === "updateOne");
  assert.equal(up.mudanca.$set.tokenizacao, undefined);
});
