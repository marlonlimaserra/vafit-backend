const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const AppointmentController = require("../../controllers/Appointment.js");

// A ABA "COMPROMISSOS" DA AGENDA — `GET /appointments/lista`.
//
// *"quero ver em forma de lista nome foto dados do cliente etc... para eu não
// ter que ficar procurando no calendário"* (16/11/2026).
//
// O que se trava aqui não é o desenho da lista, é o que ela VAZA: a linha traz
// telefone e e-mail, e isso só pode sair para quem já enxerga pessoas. Uma conta
// que só marca horário (`schedule.view` sem `people.view`) não pode ganhar o
// contato de todo mundo por esta porta lateral.

const FICHA = {
  _id: "p1",
  name: "Rafael Tibúrcio",
  avatarAt: "2026-11-01T00:00:00.000Z",
  phone: "(31) 99622-1180",
  email: "rafael@exemplo.test",
  unit: "u-paraty",
  goal: "Ganho de massa",
  birthDate: "1979-03-02",
  sex: "male",
  active: true,
};

function monta({ permissoes = ["schedule.view", "people.view"], daEquipe = false } = {}) {
  const pedidas = [];
  const trainer = { _id: "t1", name: "Marlon", permissions: permissoes };

  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async can() {
          return trainer;
        },
        has(u, p) {
          return Array.isArray(u?.permissions) && u.permissions.includes(p);
        },
      },
    },
    api: {
      user: {
        async hasPermission(_u, p) {
          return p === "schedule.team" ? daEquipe : false;
        },
        async professionalIds() {
          return ["t1", "t2"];
        },
        async fichasDaAgendaByIds() {
          return { p1: FICHA };
        },
        async briefByIds() {
          return { t1: { name: "Marlon" } };
        },
      },
      appointment: {
        async between(ids, de, ate) {
          pedidas.push({ ids, de, ate });
          return [{ _id: "a1", trainer: "t1", student: "p1", date: new Date(de), minutes: 60 }];
        },
      },
    },
  });

  AppointmentController(app);
  return { app, pedidas };
}

const JANELA = { from: "2026-11-16T03:00:00.000Z", to: "2026-11-23T03:00:00.000Z" };

test("com `people.view`, a linha traz a ficha inteira — foto e contato", async () => {
  const { app } = monta();
  const r = await call(app, "get", "/appointments/lista", { query: JANELA });

  assert.equal(r.status, 200);
  assert.equal(r.body.contato, true);
  const p = r.body.rows[0].person;
  assert.equal(p.name, "Rafael Tibúrcio");
  assert.equal(p.phone, "(31) 99622-1180");
  assert.equal(p.email, "rafael@exemplo.test");
  assert.equal(p.goal, "Ganho de massa");
  assert.equal(p.avatarAt, FICHA.avatarAt);
  // E quem atende, como na grade.
  assert.equal(r.body.rows[0].professional.name, "Marlon");
});

test("SEM `people.view`, o contato não sai — só nome e foto, como na grade", async () => {
  const { app } = monta({ permissoes: ["schedule.view"] });
  const r = await call(app, "get", "/appointments/lista", { query: JANELA });

  assert.equal(r.status, 200);
  assert.equal(r.body.contato, false);
  const p = r.body.rows[0].person;
  assert.equal(p.name, "Rafael Tibúrcio");
  assert.equal(p.avatarAt, FICHA.avatarAt);
  for (const campo of ["phone", "email", "goal", "birthDate", "unit", "sex"]) {
    assert.equal(p[campo], undefined, `${campo} vazou para quem não vê pessoas`);
  }
});

test("sem `schedule.team`, só a própria agenda — o filtro da URL não passa por cima", async () => {
  const { app, pedidas } = monta({ daEquipe: false });
  await call(app, "get", "/appointments/lista", {
    query: { ...JANELA, professionals: "t2,t3" },
  });
  assert.deepEqual(pedidas[0].ids, ["t1"]);
});

test("com `schedule.team`, vale o filtro escolhido", async () => {
  const { app, pedidas } = monta({ daEquipe: true });
  await call(app, "get", "/appointments/lista", { query: { ...JANELA, professionals: "t2" } });
  assert.deepEqual(pedidas[0].ids, ["t2"]);
});

test("janela inválida ou invertida é 400, não uma consulta com data quebrada", async () => {
  const { app, pedidas } = monta();
  for (const query of [
    {},
    { from: "ontem", to: "amanhã" },
    { from: JANELA.to, to: JANELA.from },
  ]) {
    const r = await call(app, "get", "/appointments/lista", { query });
    assert.equal(r.status, 400, JSON.stringify(query));
  }
  assert.equal(pedidas.length, 0);
});

test("janela gigante é cortada em 93 dias — não vira a agenda inteira da casa", async () => {
  const { app, pedidas } = monta();
  await call(app, "get", "/appointments/lista", {
    query: { from: "2000-01-01T00:00:00.000Z", to: "2030-01-01T00:00:00.000Z" },
  });
  const dias = (new Date(pedidas[0].ate) - new Date(pedidas[0].de)) / 86400000;
  assert.equal(dias, 93);
});
