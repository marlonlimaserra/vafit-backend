const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const MembershipController = require("../../controllers/Membership.js");

// A VITRINE PÚBLICA — a rota que o site do cliente embute num iframe.
//
// Ela é a única desta casa que responde sem sessão e para quem não é nosso
// usuário, e por isso o que ela NÃO manda importa tanto quanto o que manda.

const PLANOS = [
  {
    _id: "m1",
    name: "Black",
    tagline: "Treine em qualquer lugar",
    description: "Todas as unidades.",
    amount: 15990,
    currency: "BRL",
    cadencia: "monthly",
    fidelidadeMeses: 12,
    destaque: true,
    beneficios: ["b1", "b2", "b3", "b4", "b5", "b6"],
    corFundo: "#dc2626",
    corTexto: "#ffffff",
    botaoTexto: "Matricule-se",
    botaoIconeSvg: "<path/>",
    // Campos que NÃO podem sair daqui.
    createdBy: "u1",
    order: 0,
    rascunho: false,
  },
];

const BENEFICIOS = Array.from({ length: 6 }, (_, i) => ({
  _id: "b" + (i + 1),
  name: "Benefício " + (i + 1),
  active: true,
}));

function monta({ planos = PLANOS, beneficios = BENEFICIOS } = {}) {
  const app = fakeApp({
    api: {
      center: {
        async byHost() {
          return { instance: "marlon", active: true };
        },
      },
      membership: {
        async listActive() {
          return planos;
        },
      },
      membershipBenefit: {
        async listActive() {
          return beneficios;
        },
      },
      // A vitrine passou a oferecer a escolha da unidade, então ela pergunta
      // por elas também — ver os casos no fim do arquivo.
      unit: {
        async listActive() {
          return [];
        },
      },
      // O catálogo de formas da casa: a vitrine resolve as chaves do plano
      // em nomes, porque o nome é da casa ("Pix (chave CNPJ)").
      paymentMethod: {
        // `paraTela` e não `listActive`: o catálogo sai daqui com o nome já
        // resolvido no idioma do pedido — as sete formas originais guardam
        // `name` vazio e o nome delas é a tradução. Ver `PaymentMethod_model`.
        async paraTela() {
          return [{ key: "pix", name: "Pix" }];
        },
      },
      tenant: {
        async currencyOfInstance() {
          return { currency: "BRL" };
        },
      },
      membershipImage: {},
    },
    helpers: { ReqProtected: { async can() { return { _id: "u1" }; } } },
  });

  MembershipController(app);
  return app;
}

const pedir = () => call(monta(), "get", "/public/memberships", { query: { host: "x.vafit.app" } });

test("TODOS os benefícios ativos saem — não há corte", async () => {
  // *"parece que só aparece 3 benefícios, mesmo eu tendo colocado mais"*. Os
  // seis estavam no banco e seis saíam daqui; o que a tela mostrava era a
  // resposta guardada de um minuto antes. Este caso é o que prova de que lado
  // o defeito NÃO estava.
  const r = await pedir();

  assert.equal(r.body.beneficios.length, 6);
  assert.equal(r.body.planos[0].beneficios.length, 6);
});

test("a resposta é REVALIDADA, nunca servida velha", async () => {
  // Era `max-age=60`. Um minuto é pouco em teoria e é tudo na prática: o fluxo
  // é editar no painel e olhar a vitrine em seguida, e nessa janela ela mente.
  // Quem editou não desconfia do cache — desconfia do que acabou de salvar.
  const r = await pedir();

  assert.match(r.headers["cache-control"], /max-age=0/);
  assert.match(r.headers["cache-control"], /must-revalidate/);
});

test("o benefício que um plano marcou mas que saiu do ar não vaza", async () => {
  // Desativar uma linha tira ela da tabela E do cartão: deixá-la faria o
  // cartão prometer algo que a comparação nem lista.
  const app = monta({ beneficios: BENEFICIOS.slice(0, 2) });
  const r = await call(app, "get", "/public/memberships", { query: { host: "x.vafit.app" } });

  assert.deepEqual(r.body.planos[0].beneficios, ["b1", "b2"]);
});

test("só os campos do CARTÃO — o documento inteiro não sai", async () => {
  // Montado à mão, e não `...plano`: uma vitrine que devolve o documento
  // inteiro vaza o próximo campo que alguém acrescentar sem pensar nisto.
  const r = await pedir();
  const plano = r.body.planos[0];

  for (const proibido of ["createdBy", "order", "rascunho", "_id", "cover"]) {
    assert.ok(!(proibido in plano), `vazou ${proibido}`);
  }
  assert.equal(plano.id, "m1");
});

test("as cores e o botão vão junto, porque é deles que o cartão se pinta", async () => {
  const r = await pedir();
  const plano = r.body.planos[0];

  assert.equal(plano.corFundo, "#dc2626");
  assert.equal(plano.botaoTexto, "Matricule-se");
  // Mesmo SEM link: o cartão sem botão é um cartão incompleto, e quem ainda
  // não pôs o link vê o botão e entende o que falta.
  assert.equal(plano.botaoLink, "");
  assert.equal(plano.botaoIconeSvg, "<path/>");
});

test("host desconhecido é 404 seco, sem mensagem traduzida", async () => {
  // Aqui não há sessão nem idioma, e ninguém lê mensagem dentro de um iframe
  // no site de outra pessoa.
  const app = fakeApp({
    api: { center: { async byHost() { return null; } } },
    helpers: { ReqProtected: { async can() { return { _id: "u1" }; } } },
  });
  MembershipController(app);

  const r = await call(app, "get", "/public/memberships", { query: { host: "ninguem.com" } });
  assert.equal(r.status, 404);
});

// ── A VITRINE POR UNIDADE ───────────────────────────────────────────────
//
// *"também posso escolher em qual unidade o plano vai estar disponível... na
// vitrine pública teria que ter um jeito de eu escolher a unidade, pois cada
// unidade pode ter planos e preços diferentes"*.
//
// A regra que atravessa tudo: **plano sem unidade vale em TODAS**. É o que
// mantém no ar cada plano cadastrado antes desta mudança — nenhum deles pode
// sumir da vitrine porque alguém cadastrou uma unidade.
const UNIDADES = [
  { _id: "un1", name: "Centro", active: true },
  { _id: "un2", name: "Paraty", active: true },
];

function comUnidades({ planos, unidades = UNIDADES } = {}) {
  const app = fakeApp({
    api: {
      center: { async byHost() { return { instance: "marlon", active: true }; } },
      membership: { async listActive() { return planos; } },
      membershipBenefit: { async listActive() { return BENEFICIOS; } },
      unit: { async listActive() { return unidades; } },
      // O catálogo da casa: a vitrine resolve as chaves do plano em nomes.
      paymentMethod: { async paraTela() { return [{ key: "pix", name: "Pix" }, { key: "credit", name: "Cartão" }]; } },
      tenant: { async currencyOfInstance() { return { currency: "BRL" }; } },
    },
    helpers: { ReqProtected: { async can() { return { _id: "u1" }; } } },
  });

  MembershipController(app);
  return app;
}

const PLANO_CENTRO = { ...PLANOS[0], _id: "m1", name: "Centro 100", units: ["un1"] };
const PLANO_PARATY = { ...PLANOS[0], _id: "m2", name: "Paraty 70", units: ["un2"] };
const PLANO_TODAS = { ...PLANOS[0], _id: "m3", name: "Vale em todas", units: [] };

const pedirUnidade = (app, unidade) =>
  call(app, "get", "/public/memberships", { query: { host: "x.vafit.app", unidade } });

test("sem escolher unidade, a vitrine mostra tudo", async () => {
  const app = comUnidades({ planos: [PLANO_CENTRO, PLANO_PARATY, PLANO_TODAS] });
  const r = await pedirUnidade(app);

  assert.equal(r.body.planos.length, 3);
});

test("escolhendo Paraty, só os planos de Paraty", async () => {
  const app = comUnidades({ planos: [PLANO_CENTRO, PLANO_PARATY, PLANO_TODAS] });
  const r = await pedirUnidade(app, "un2");

  assert.deepEqual(
    r.body.planos.map((p) => p.name).sort(),
    ["Paraty 70", "Vale em todas"]
  );
});

test("plano SEM unidade vale em todas — é o que mantém o cadastro antigo no ar", async () => {
  // Nenhum plano de hoje tem a lista preenchida. Se "sem unidade" quisesse
  // dizer "nenhuma", a vitrine de todo mundo esvaziaria no dia em que alguém
  // cadastrasse a primeira unidade.
  const app = comUnidades({ planos: [PLANO_TODAS] });

  assert.equal((await pedirUnidade(app, "un1")).body.planos.length, 1);
  assert.equal((await pedirUnidade(app, "un2")).body.planos.length, 1);
});

// ── O CARTÃO DA UNIDADE ─────────────────────────────────────────────────
//
// Até 14/10/2026 daqui saíam só `id` e `name`, e havia um teste chamado "nada
// de telefone nem endereço" guardando isso. Ele o desfez: *"mostre o card de
// cada unidade com a foto em cima, endereço, telefone, whatsapp"*.
//
// A regra antiga confundia DADO PESSOAL com VITRINE. O endereço e o telefone
// de uma academia são a placa na porta — ela paga para que apareçam no mapa e
// no Instagram. Esconder aqui não protegia ninguém; só obrigava quem escolhia
// entre duas filiais a sair da página para descobrir qual era a mais perto.
const COMPLETA = {
  _id: "un1",
  name: "Centro",
  active: true,
  photo: "f1",
  logradouro: "Rua X",
  numero: "100",
  bairro: "Centro",
  cidade: "Niterói",
  uf: "RJ",
  phone: "(21) 99999-0000",
  whatsapp: "5521999990000",
  email: "contato@academia.com",
  lat: -22.9,
  lng: -43.1,
};

test("a vitrine devolve as unidades para o cartão", async () => {
  const app = comUnidades({ planos: [PLANO_CENTRO, PLANO_PARATY] });
  const r = await pedirUnidade(app);

  assert.deepEqual(
    r.body.unidades.map((u) => [u.id, u.name]),
    [
      ["un1", "Centro"],
      ["un2", "Paraty"],
    ]
  );
});

test("unidade SEM plano nenhum não entra na escolha", async () => {
  // Uma opção que leva a uma página vazia é pior que opção nenhuma — e quem
  // abre a vitrine é um cliente em potencial, não alguém disposto a
  // investigar.
  const app = comUnidades({ planos: [PLANO_CENTRO] });
  const r = await pedirUnidade(app);

  assert.deepEqual(r.body.unidades.map((u) => u.id), ["un1"]);
});

test("o cartão leva foto, endereço, telefone e whatsapp", async () => {
  const app = comUnidades({ planos: [PLANO_TODAS], unidades: [COMPLETA] });
  const u = (await pedirUnidade(app)).body.unidades[0];

  assert.match(u.photoUrl, /\/public\/unit-image\/[^/]+\/f1$/);
  // Uma linha só, montada por `lib/cep.js` — três telas montando o mesmo
  // endereço dariam três formatos.
  assert.equal(u.endereco, "Rua X, 100 — Centro, Niterói/RJ");
  assert.equal(u.phone, "(21) 99999-0000");
  assert.equal(u.whatsapp, "5521999990000");
  assert.equal(u.lat, -22.9);
});

// ── AS FORMAS DE PAGAMENTO DO PLANO ─────────────────────────────────────
//
// *"aqui em plano faltou eu escolher as formas de pagamento"* (14/10/2026).
//
// O plano guarda as CHAVES; a vitrine devolve os NOMES. Resolver na tela
// pediria que ela conhecesse o catálogo da casa — e o nome é da casa: ela
// pode ter chamado o Pix de "Pix (chave CNPJ)".
test("o plano devolve as formas que ele aceita, já com o nome da casa", async () => {
  const app = comUnidades({
    planos: [{ ...PLANO_TODAS, formasDePagamento: ["pix"] }],
  });

  const r = await pedirUnidade(app);

  assert.deepEqual(r.body.planos[0].formasDePagamento, [{ key: "pix", name: "Pix" }]);
});

test("lista VAZIA quer dizer TODAS — e não nenhuma", async () => {
  // Nenhum plano cadastrado até hoje tem esta lista. "Nenhuma" esvaziaria a
  // vitrine inteira no deploy que criou o campo.
  const app = comUnidades({ planos: [{ ...PLANO_TODAS, formasDePagamento: [] }] });

  const r = await pedirUnidade(app);

  assert.deepEqual(
    r.body.planos[0].formasDePagamento.map((f) => f.key),
    ["pix", "credit"]
  );
});

test("forma que a casa DESLIGOU some do plano que a marcava", async () => {
  // O catálogo manda: desligar o boleto tira o boleto de todo plano, sem
  // precisar editar nenhum deles.
  const app = comUnidades({
    planos: [{ ...PLANO_TODAS, formasDePagamento: ["pix", "billet"] }],
  });

  const r = await pedirUnidade(app);

  assert.deepEqual(
    r.body.planos[0].formasDePagamento.map((f) => f.key),
    ["pix"]
  );
});

test("a unidade pode ser pedida pelo APELIDO — é o que vira `/vitrine/niteroi`", async () => {
  const app = comUnidades({
    planos: [PLANO_CENTRO, PLANO_PARATY],
    unidades: [
      { _id: "un1", name: "Centro", active: true, alias: "centro" },
      { _id: "un2", name: "Paraty", active: true, alias: "paraty" },
    ],
  });

  const r = await pedirUnidade(app, "paraty");

  assert.deepEqual(r.body.planos.map((p) => p.name), ["Paraty 70"]);
});

test("e pelo ID também — é o que está nos iframes já pendurados", async () => {
  // Trocar o endereço não pode apagar o link que alguém mandou por WhatsApp
  // semana passada. Os dois caminhos custam uma comparação.
  const app = comUnidades({
    planos: [PLANO_CENTRO, PLANO_PARATY],
    unidades: [
      { _id: "un1", name: "Centro", active: true, alias: "centro" },
      { _id: "un2", name: "Paraty", active: true, alias: "paraty" },
    ],
  });

  const r = await pedirUnidade(app, "un2");

  assert.deepEqual(r.body.planos.map((p) => p.name), ["Paraty 70"]);
});

test("o apelido sai no cartão, para a tela montar o link", async () => {
  const app = comUnidades({
    planos: [PLANO_TODAS],
    unidades: [{ ...COMPLETA, alias: "centro" }],
  });

  assert.equal((await pedirUnidade(app)).body.unidades[0].alias, "centro");
});

test("o E-MAIL continua fora — numa página pública ele é isca de robô", () => {
  // Quem quer falar usa o WhatsApp, que está logo ali no cartão.
  const app = comUnidades({ planos: [PLANO_TODAS], unidades: [COMPLETA] });

  return pedirUnidade(app).then((r) => {
    assert.equal(r.body.unidades[0].email, undefined);
  });
});

test("unidade sem foto nem endereço não inventa nada", async () => {
  // O cadastro mínimo é só o nome, e o cartão tem de aguentar isso sem
  // mostrar "undefined" nem um quadro de foto quebrado.
  const app = comUnidades({ planos: [PLANO_TODAS], unidades: [UNIDADES[0]] });
  const u = (await pedirUnidade(app)).body.unidades[0];

  assert.equal(u.photoUrl, null);
  assert.equal(u.endereco, "");
  assert.equal(u.phone, "");
});
