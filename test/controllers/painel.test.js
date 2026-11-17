const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const DashboardController = require("../../controllers/Dashboard.js");

// O PAINEL — a tela que abre quando alguém entra.
//
// *"agora precisa melhorar o dashboard, ta super desatualizado nem leva em
// consideração a unidade"* (20/10/2026).
//
// O que vale guardar aqui não é o desenho, é o que ele DECIDE antes de
// responder:
//
//   • a lente da unidade chegar a TODO bloco — era o pedido
//   • o bloco não existir quando a permissão ou o módulo diz que não
//   • a agenda, que não guarda unidade, ser recortada pela unidade da PESSOA
//   • cancelado não contar como compromisso do dia
const UNIDADE = "64b2c0f7e1a2b3c4d5e6f701";
const OUTRA = "64b2c0f7e1a2b3c4d5e6f702";

function monta({
  permissoes = ["people.view", "schedule.view", "finance.view"],
  escondidos = [],
  units = [],
  compromissos = [],
  naUnidade = null,
  // O que cada série devolve do banco. Vazio de propósito no padrão: é o caso
  // que prova o preenchimento de buracos.
  serieCadastros = [],
  serieEntradas = [],
  serieDinheiro = [],
  serieContas = [],
  cobrancas = [],
  entradas = [],
  cadastrados = { linhas: [], total: 0 },
} = {}) {
  const pedidos = {};

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can(req, res, permissao) {
          if (!permissoes.includes(permissao)) {
            res.status(403).send({ msg: "no" });
            return false;
          }
          return { _id: "u1", name: "Marlon", units };
        },
      },
    },
    api: {
      tenant: {
        async timezoneOfInstance() {
          return "America/Sao_Paulo";
        },
        async currencyOfInstance() {
          return { currency: "BRL" };
        },
      },
      modulo: {
        async menusEscondidos() {
          return escondidos;
        },
      },
      recurrence: {
        async gerar() {
          pedidos.gerou = true;
          return 0;
        },
      },
      user: {
        async hasPermission(user, permissao) {
          return permissoes.includes(permissao);
        },
        async professionalIds() {
          return ["u1", "u2"];
        },
        async studentsSummary(id, lente) {
          pedidos.resumo = lente;
          return { total: 10, active: 8, inactive: 2, withAccess: 4, newThisMonth: 1 };
        },
        async pageStudents(id, filtros) {
          pedidos.ultimos = filtros;
          return { rows: [{ _id: "p1", name: "Ana" }], total: 1 };
        },
        async idsNaUnidade(ids, lente) {
          pedidos.idsNaUnidade = lente;
          return naUnidade === null ? ids : naUnidade;
        },
        async serieDeCadastros(id, lente, janela) {
          pedidos.serieCadastros = { lente, janela };
          return serieCadastros;
        },
        async cadastradosEntre(id, lente, janela, limite) {
          pedidos.cadastrados = { lente, janela, limite };
          return cadastrados;
        },
        async namesByIds(ids) {
          return new Map((ids || []).map((id) => [String(id), "Ana " + String(id)]));
        },
      },
      appointment: {
        async between(ids, de, ate) {
          pedidos.agenda = { ids, de, ate };
          return compromissos;
        },
      },
      groupClass: {
        async listActive(unit) {
          pedidos.aulasDaUnidade = unit;
          return [{ _id: "a1", horarios: [{ inicio: 420 }, { inicio: 1080 }] }];
        },
        estadoAgora() {
          return { hoje: true, data: "2026-10-20" };
        },
      },
      groupClassCheckin: {
        async contagemDoDia() {
          return { "a1:420": 6, "a1:1080": 3 };
        },
      },
      checkin: {
        async resumoDoDia(de, ate, lente) {
          pedidos.porta = lente;
          return { entradas: 12, pessoas: 9 };
        },
        async seriePorDia(de, ate, lente, fuso) {
          pedidos.serieEntradas = { de, ate, lente, fuso };
          return serieEntradas;
        },
        async linhasDoDia(de, ate, lente, limite) {
          pedidos.linhasDaPorta = { de, ate, lente, limite };
          return { linhas: entradas, total: entradas.length };
        },
      },
      finance: {
        async carteira(filtros) {
          pedidos.carteira = filtros;
          return {
            resumo: { recebido: 100, aReceber: 50, atrasado: 20, quantasAtrasadas: 2 },
            total: 42,
            rows: cobrancas,
          };
        },
        async serieMensal(filtros) {
          pedidos.serieDinheiro = filtros;
          return serieDinheiro;
        },
      },
      payable: {
        async listar(filtros) {
          pedidos.payable = filtros;
          return { resumo: { aPagar: 30, atrasado: 10, quantasAtrasadas: 1 } };
        },
        async serieMensal(filtros) {
          pedidos.serieContas = filtros;
          return serieContas;
        },
      },
    },
  });

  DashboardController(app);
  return { app, pedidos };
}

test("a unidade escolhida chega a TODO bloco — era o pedido", async () => {
  // Com um compromisso no dia: sem nenhum, a agenda nem chega a perguntar de
  // quem é a unidade — e o caso passaria sem ver o que veio ver.
  const { app, pedidos } = monta({ compromissos: [{ student: "p1", status: "scheduled" }] });

  const r = await call(app, "get", "/dashboard", { query: { unit: UNIDADE } });

  assert.equal(r.status, 200);
  assert.equal(r.body.unidade, UNIDADE);
  assert.equal(pedidos.resumo.unit, UNIDADE);
  assert.equal(pedidos.ultimos.unit, UNIDADE);
  assert.equal(pedidos.porta.unit, UNIDADE);
  assert.equal(pedidos.carteira.unit, UNIDADE);
  assert.equal(pedidos.payable.unit, UNIDADE);
  assert.equal(pedidos.aulasDaUnidade, UNIDADE);
  assert.equal(pedidos.idsNaUnidade.unit, UNIDADE);
});

test("sem unidade, ninguém recebe filtro — 'todas' continua sendo o estado comum", async () => {
  const { app, pedidos } = monta();

  await call(app, "get", "/dashboard", {});

  assert.equal(pedidos.resumo.unit, "");
  assert.equal(pedidos.carteira.unit, "");
  assert.equal(pedidos.aulasDaUnidade, "");
});

test("quem é restrito e pede unidade de fora recebe a cerca dele, não o pedido", async () => {
  const { app, pedidos } = monta({ units: [UNIDADE] });

  const r = await call(app, "get", "/dashboard", { query: { unit: OUTRA } });

  assert.equal(r.body.unidade, "");
  assert.deepEqual(pedidos.resumo.units, [UNIDADE]);
  // A grade de aula é de uma unidade por vez: sem escolha válida, a primeira
  // da cerca — nunca a casa inteira.
  assert.equal(pedidos.aulasDaUnidade, UNIDADE);
});

test("sem a permissão do dinheiro, os dois blocos de dinheiro não vêm", async () => {
  const { app, pedidos } = monta({ permissoes: ["people.view", "schedule.view"] });

  const r = await call(app, "get", "/dashboard", {});

  assert.equal(r.body.dinheiro, null);
  assert.equal(r.body.contas, null);
  assert.equal(pedidos.carteira, undefined);
  // E a mensalidade não é gerada por quem não pode ver o financeiro.
  assert.equal(pedidos.gerou, undefined);
  // O resto da tela continua de pé.
  assert.equal(r.body.pessoas.total, 10);
});

test("módulo não liberado esconde o bloco, mesmo com a permissão", async () => {
  const { app } = monta({ escondidos: ["/financeiro", "/agenda", "/people/tab/frequency"] });

  const r = await call(app, "get", "/dashboard", {});

  assert.equal(r.body.dinheiro, null);
  assert.equal(r.body.agenda, null);
  assert.equal(r.body.porta, null);
  // Contas a pagar não estava na lista: continua vindo.
  assert.ok(r.body.contas);
});

test("a agenda conta o dia, e cancelado não é compromisso de hoje", async () => {
  const { app } = monta({
    compromissos: [
      { student: "p1", status: "done" },
      { student: "p2", status: "missed" },
      { student: "p3", status: "scheduled" },
      { student: "p4", status: "canceled" },
    ],
  });

  const r = await call(app, "get", "/dashboard", {});

  assert.deepEqual(r.body.agenda, { total: 3, feitos: 1, faltas: 1, aFazer: 1 });
});

test("com a lente, sobra na agenda só quem é da unidade", async () => {
  const { app } = monta({
    compromissos: [
      { student: "p1", status: "scheduled" },
      { student: "p2", status: "scheduled" },
    ],
    naUnidade: ["p1"],
  });

  const r = await call(app, "get", "/dashboard", { query: { unit: UNIDADE } });

  assert.equal(r.body.agenda.total, 1);
});

test("as aulas de hoje somam horários e inscritos", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/dashboard", {});

  assert.deepEqual(r.body.aulas, { quantas: 1, horarios: 2, inscritos: 9 });
});

test("o dinheiro vem com a moeda da casa, e a janela é o mês", async () => {
  const { app, pedidos } = monta();

  const r = await call(app, "get", "/dashboard", {});

  assert.equal(r.body.dinheiro.moeda, "BRL");
  assert.equal(r.body.dinheiro.recebido, 100);
  assert.match(pedidos.carteira.de, /^\d{4}-\d{2}-01$/);
  assert.match(pedidos.carteira.ate, /^\d{4}-\d{2}-\d{2}$/);
  // A mensalidade do mês nasce aqui, como nasce no Financeiro — senão os dois
  // números da mesma pergunta divergiriam.
  assert.equal(pedidos.gerou, true);
});

test("sem people.view não há painel nenhum", async () => {
  const { app } = monta({ permissoes: [] });

  const r = await call(app, "get", "/dashboard", {});

  assert.equal(r.status, 403);
});

// ── AS SÉRIES DO GRÁFICO (22/10/2026) ──────────────────────────────────────
//
// *"cadê os gráficos?"*. Eu tinha dito duas vezes que não dava porque o VAFIT
// não guarda histórico — e estava errado: não há fotografia de agregado, mas
// toda linha tem data.
//
// O que vale travar aqui é o que não se vê olhando a tela:
//
//   • o eixo é montado pelo CALENDÁRIO, e não pelo que voltou do banco — mês
//     sem movimento tem de virar zero, não sumir
//   • a aritmética de mês atravessa a virada do ano
//   • permissão e módulo valem igual, e os três números que a história não
//     responde nunca aparecem
const SERIES = "/dashboard/series";

function rotulosDoMes(ate = new Date(), quantos = 12) {
  // A conta esperada, feita de outro jeito que a do controlador de propósito:
  // um teste que repete a implementação não testa nada.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  });
  const [ano, mes] = fmt.format(ate).split("-").map(Number);
  const saida = [];
  for (let i = quantos - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ano, mes - 1 - i, 1, 12));
    saida.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return saida;
}

test("o eixo mensal tem doze meses, termina no mês de hoje e atravessa o ano", async () => {
  const { app } = monta();
  const r = await call(app, "get", SERIES);

  const eixo = r.body.series["pessoas.total"].pontos.map((p) => p.r);
  assert.equal(eixo.length, 12);
  assert.deepEqual(eixo, rotulosDoMes());

  // Contíguos: nenhum buraco e nenhum mês repetido na virada do ano.
  const unicos = new Set(eixo);
  assert.equal(unicos.size, 12);
  for (const r of eixo) assert.match(r, /^\d{4}-(0[1-9]|1[0-2])$/);
});

test("mês sem movimento vira ZERO, e não some do gráfico", async () => {
  // É a razão de o eixo ser montado aqui. Entregue cru, um mês ausente faria o
  // gráfico ligar março a maio com uma reta — desenhando um abril que nunca
  // foi medido.
  const meses = rotulosDoMes();
  const { app } = monta({
    serieDinheiro: [{ r: meses[11], recebido: 5000, aReceber: 300, atrasado: 0 }],
  });

  const r = await call(app, "get", SERIES);
  const pontos = r.body.series["dinheiro.recebido"].pontos;

  assert.equal(pontos.length, 12);
  assert.equal(pontos[11].v, 5000);
  assert.deepEqual(
    pontos.slice(0, 11).map((p) => p.v),
    new Array(11).fill(0)
  );
});

test("o eixo diário tem catorze dias e termina HOJE", async () => {
  // Diário e não mensal porque o cartão da agenda e o da catraca são de HOJE:
  // um gráfico cujo último ponto não é o número desenhado em cima dele é a
  // única coisa que este painel não pode fazer.
  const { app } = monta();
  const r = await call(app, "get", SERIES);

  const eixo = r.body.series.porta.pontos.map((p) => p.r);
  assert.equal(eixo.length, 14);
  assert.equal(r.body.series.porta.grao, "dia");

  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
    new Date()
  );
  assert.equal(eixo[13], hoje);

  // E em ordem, um dia depois do outro.
  for (let i = 1; i < eixo.length; i++) {
    const anterior = new Date(eixo[i - 1] + "T12:00:00Z");
    const atual = new Date(eixo[i] + "T12:00:00Z");
    assert.equal(atual - anterior, 86400000);
  }
});

test("o que a história NÃO responde não ganha série", async () => {
  // "Ativo" e "com acesso ao app" são bandeiras de agora — nada no banco diz
  // quantos estavam ativos em março. "Aulas" sai da grade recorrente, não de
  // linhas gravadas. Um gráfico inventado é pior que gráfico nenhum.
  const { app } = monta();
  const r = await call(app, "get", SERIES);

  assert.equal(r.body.series["pessoas.active"], undefined);
  assert.equal(r.body.series["pessoas.withAccess"], undefined);
  assert.equal(r.body.series.aulas, undefined);
});

test("sem permissão de dinheiro, nenhuma série de dinheiro volta", async () => {
  const { app } = monta({ permissoes: ["people.view", "schedule.view"] });
  const r = await call(app, "get", SERIES);

  assert.equal(r.body.series["dinheiro.recebido"], undefined);
  assert.equal(r.body.series["contas.aPagar"], undefined);
  // E o que sobra continua de pé.
  assert.ok(r.body.series["pessoas.total"]);
});

test("módulo escondido tira a série junto com o cartão", async () => {
  const { app } = monta({ escondidos: ["/contas", "/people/tab/frequency"] });
  const r = await call(app, "get", SERIES);

  assert.equal(r.body.series["contas.aPagar"], undefined);
  assert.equal(r.body.series.porta, undefined);
  assert.ok(r.body.series["dinheiro.recebido"]);
});

test("sem a permissão de ver pessoas, a rota inteira é recusada", async () => {
  const { app } = monta({ permissoes: [] });
  const r = await call(app, "get", SERIES);

  assert.equal(r.status, 403);
});

test("a lente da unidade chega a TODA série", async () => {
  const { app, pedidos } = monta({ compromissos: [{ student: "p1", date: new Date(), status: "scheduled" }] });
  await call(app, "get", SERIES, { query: { unit: UNIDADE } });

  assert.equal(pedidos.serieCadastros.lente.unit, UNIDADE);
  assert.equal(pedidos.serieEntradas.lente.unit, UNIDADE);
  assert.equal(pedidos.serieDinheiro.unit, UNIDADE);
  assert.equal(pedidos.serieContas.unit, UNIDADE);
  // A agenda não guarda unidade: ela é recortada pela unidade da PESSOA.
  assert.equal(pedidos.idsNaUnidade.unit, UNIDADE);
});

test("compromisso cancelado não entra na barra do dia", async () => {
  const agora = new Date();
  const { app } = monta({
    compromissos: [
      { student: "p1", date: agora, status: "scheduled" },
      { student: "p2", date: agora, status: "done" },
      { student: "p3", date: agora, status: "canceled" },
    ],
  });

  const r = await call(app, "get", SERIES);
  const pontos = r.body.series.agenda.pontos;

  // Dois, e não três: cancelado não é compromisso do dia, é um que deixou de
  // existir. É a mesma regra do cartão.
  assert.equal(pontos[13].v, 2);
});

test("a série do dinheiro pede a MESMA janela de doze meses que o eixo", async () => {
  // Se o modelo recebesse uma janela diferente da que o eixo desenha, os meses
  // das pontas voltariam vazios sem ninguém notar — o gráfico simplesmente
  // começaria em zero.
  const { app, pedidos } = monta();
  const r = await call(app, "get", SERIES);

  const eixo = r.body.series["dinheiro.recebido"].pontos.map((p) => p.r);
  assert.equal(pedidos.serieDinheiro.de, `${eixo[0]}-01`);
  assert.ok(pedidos.serieDinheiro.ate.startsWith(eixo[11]));
});

// ── AS LINHAS POR TRÁS DE UM PONTO (22/10/2026) ───────────────────────────
//
// *"se clicar no gráfico tinha que abrir outro dialog com as faturas"*.
//
// O que vale travar:
//
//   • o CONJUNTO ser o mesmo que o número somou — "recebido" não é
//     `status=paid`, que deixaria de fora a cobrança paga pela metade
//   • o rótulo da URL virar janela de tempo, e rótulo torto ser RECUSADO
//     antes de virar `new Date` de qualquer coisa
//   • permissão e módulo valerem aqui também: a URL é outra porta para a
//     mesma informação
const LINHAS = "/dashboard/linhas";

const COBRANCA = {
  id: "c1",
  student: "p1",
  studentName: "Ana",
  description: "Mensalidade",
  amount: 9000,
  pago: 0,
  falta: 9000,
  dueDate: new Date("2026-10-10T12:00:00Z"),
  status: "open",
  atrasada: true,
};

test("'atrasado' lista o MESMO conjunto que o cartão soma", async () => {
  const { app, pedidos } = monta({ cobrancas: [COBRANCA] });

  const r = await call(app, "get", LINHAS, {
    query: { peca: "dinheiro.atrasado", r: "2026-10" },
  });

  // "late" não é estado gravado — é a cobrança aberta cuja data passou,
  // calculada na leitura. É o que o cartão soma.
  assert.equal(pedidos.carteira.status, "late");
  assert.equal(pedidos.carteira.de, "2026-10-01");
  assert.equal(pedidos.carteira.ate, "2026-10-31");
  assert.equal(r.body.total, 42);
  assert.deepEqual(r.body.linhas[0], {
    id: "c1",
    titulo: "Ana",
    subtitulo: "Mensalidade",
    valor: 9000,
    quando: COBRANCA.dueDate,
    estado: "late",
    para: "/people/p1",
  });
});

test("'recebido' pede as que RECEBERAM, não as quitadas", async () => {
  // `status: "paid"` quer dizer "falta zero". Uma cobrança de R$ 500 com
  // R$ 200 pagos entra no recebido do mês e não é `paid` — listar por ele
  // daria uma lista cuja soma é menor que o número no topo dela.
  const { app, pedidos } = monta({ cobrancas: [COBRANCA] });

  await call(app, "get", LINHAS, { query: { peca: "dinheiro.recebido", r: "2026-10" } });

  assert.equal(pedidos.carteira.somentePagas, true);
  assert.equal(pedidos.carteira.status, undefined);
  assert.equal(pedidos.carteira.ordem, "pago");
});

test("'a receber' pede as abertas", async () => {
  const { app, pedidos } = monta();

  await call(app, "get", LINHAS, { query: { peca: "dinheiro.aReceber", r: "2026-10" } });

  assert.equal(pedidos.carteira.status, "open");
});

test("a janela do mês vai até o ÚLTIMO dia dele — fevereiro inclusive", async () => {
  // Um "31" fixo deixaria fevereiro inteiro de fora; um "30" perderia o dia 31
  // de todo mês que o tem.
  const { app, pedidos } = monta();

  await call(app, "get", LINHAS, { query: { peca: "contas.aPagar", r: "2026-02" } });
  assert.equal(pedidos.payable.ate, "2026-02-28");

  await call(app, "get", LINHAS, { query: { peca: "contas.aPagar", r: "2024-02" } });
  assert.equal(pedidos.payable.ate, "2024-02-29"); // bissexto
});

test("rótulo torto é RECUSADO — o endereço é editável", async () => {
  const { app } = monta();

  for (const r of ["", "qualquer coisa", "2026", "2026-13", "2026-10-99x", "../../etc"]) {
    const resp = await call(app, "get", LINHAS, { query: { peca: "dinheiro.atrasado", r } });
    assert.equal(resp.status, 400, `aceitou "${r}"`);
  }
});

test("peça desconhecida é recusada", async () => {
  const { app } = monta();

  const r = await call(app, "get", LINHAS, { query: { peca: "inventada", r: "2026-10" } });
  assert.equal(r.status, 400);
});

test("'pessoas.total' NÃO tem lista — o número é cumulativo", async () => {
  // A lista por trás do total em março seria a casa inteira, que é a tela de
  // Pessoas. Listar "quem entrou em março" aqui responderia a pergunta do
  // cartão ao lado com o título deste.
  const { app } = monta();

  const r = await call(app, "get", LINHAS, { query: { peca: "pessoas.total", r: "2026-10" } });
  assert.equal(r.status, 400);
});

test("sem permissão de dinheiro, a lista de cobranças é recusada", async () => {
  // A URL é outra porta para a mesma informação: sem esta trava, quem não vê
  // o financeiro na tela leria as cobranças digitando o endereço.
  const { app } = monta({ permissoes: ["people.view", "schedule.view"] });

  const r = await call(app, "get", LINHAS, { query: { peca: "dinheiro.atrasado", r: "2026-10" } });
  assert.equal(r.status, 403);
});

test("módulo escondido tranca a lista junto com o cartão", async () => {
  const { app } = monta({ escondidos: ["/contas"] });

  const r = await call(app, "get", LINHAS, { query: { peca: "contas.aPagar", r: "2026-10" } });
  assert.equal(r.status, 403);
});

test("a agenda do dia: cancelado fora, e a unidade é a da PESSOA", async () => {
  const dia = new Date("2026-10-20T13:00:00Z");
  const { app, pedidos } = monta({
    compromissos: [
      { _id: "a1", student: "p1", date: dia, status: "scheduled" },
      { _id: "a2", student: "p2", date: dia, status: "canceled" },
    ],
  });

  const r = await call(app, "get", LINHAS, {
    query: { peca: "agenda", r: "2026-10-20", unit: UNIDADE },
  });

  assert.equal(r.body.total, 1);
  assert.equal(r.body.linhas[0].titulo, "Ana p1");
  assert.equal(r.body.linhas[0].para, "/people/p1");
  assert.equal(pedidos.idsNaUnidade.unit, UNIDADE);
});

test("a catraca do dia traz quem passou, e a lente vai junto", async () => {
  const { app, pedidos } = monta({
    entradas: [{ id: "e1", pessoa: "p9", nome: "Bia", em: new Date("2026-10-20T10:12:00Z") }],
  });

  const r = await call(app, "get", LINHAS, {
    query: { peca: "porta", r: "2026-10-20", unit: UNIDADE },
  });

  assert.equal(r.body.linhas[0].titulo, "Bia");
  assert.equal(r.body.linhas[0].hora, true);
  assert.equal(pedidos.linhasDaPorta.lente.unit, UNIDADE);
});

test("'novos no mês' lista quem entrou, com a mesma cerca", async () => {
  const { app, pedidos } = monta({
    cadastrados: {
      total: 3,
      linhas: [{ id: "p3", nome: "Caio", email: "c@x.com", em: new Date("2026-10-05T10:00:00Z") }],
    },
  });

  const r = await call(app, "get", LINHAS, {
    query: { peca: "pessoas.newThisMonth", r: "2026-10", unit: UNIDADE },
  });

  assert.equal(r.body.total, 3);
  assert.equal(r.body.linhas[0].titulo, "Caio");
  assert.equal(r.body.linhas[0].para, "/people/p3");
  assert.equal(pedidos.cadastrados.lente.unit, UNIDADE);
});

test("a lista tem teto de 50, e o total diz quantas são de verdade", async () => {
  const { app, pedidos } = monta();

  await call(app, "get", LINHAS, { query: { peca: "dinheiro.atrasado", r: "2026-10" } });

  assert.equal(pedidos.carteira.limite, 50);
});
