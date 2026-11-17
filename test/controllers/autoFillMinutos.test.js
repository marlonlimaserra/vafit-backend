const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const AutoFillController = require("../../controllers/AutoFill.js");
const AutoFill_model = require("../../model/AutoFill_model.js");
const fields = require("../../lib/autoFillFields.js");

// AS DURAÇÕES DO COMPROMISSO, NO AUTO PREENCHER.
//
// *"permita eu digitar o tempo, coloque essas durações na parte de
// configuração do auto preencher, para eu configurar os que eu uso, às vezes
// só uso 1"* (16/11/2026).
//
// O que se trava:
//   1. a validação é de NÚMERO: "5" (um caractere) vale, "6000" não;
//   2. as seis durações de antes entram UMA vez — e o que foi apagado não volta;
//   3. a lista sai em ordem de número, não de texto ("30" antes de "120").

const ID = "aaaaaaaaaaaaaaaaaaaaaaa1";

function montaRota() {
  const inseridos = [];
  let semeou = 0;
  const app = fakeApp({
    helpers: {
      ReqProtected: {
        async verify() {
          return { _id: ID };
        },
      },
    },
    api: {
      autoFill: {
        async insert(_id, field, value) {
          inseridos.push({ field, value });
          return { _id: "x", field, value };
        },
        async semear() {
          semeou++;
        },
        async list() {
          return [];
        },
        async listGrouped() {
          return {};
        },
      },
    },
  });
  AutoFillController(app);
  return { app, inseridos, semeou: () => semeou };
}

test("minutos valem como NÚMERO — inclusive o de um dígito", async () => {
  const { app, inseridos } = montaRota();
  for (const valor of ["50", " 75 ", "5"]) {
    const r = await call(app, "post", "/auto-fill", {
      body: { field: "appointment.minutes", value: valor },
    });
    assert.equal(r.status, 201, valor);
  }
  assert.deepEqual(
    inseridos.map((i) => i.value),
    ["50", "75", "5"]
  );
});

test("o que não é um atendimento é recusado com o motivo", async () => {
  const { app, inseridos } = montaRota();
  for (const valor of ["4", "601", "6000", "abc", "50 min", "", "1.5"]) {
    const r = await call(app, "post", "/auto-fill", {
      body: { field: "appointment.minutes", value: valor },
    });
    assert.equal(r.status, 400, valor);
    assert.match(r.body.msg, /de 5 a 600/);
  }
  assert.equal(inseridos.length, 0);
});

test("os campos de texto continuam com a regra de texto", async () => {
  const { app } = montaRota();
  const r = await call(app, "post", "/auto-fill", { body: { field: "appointment.title", value: "5" } });
  assert.equal(r.status, 400);
});

test("ler a lista semeia antes — o formulário e a configuração", async () => {
  const { app, semeou } = montaRota();
  await call(app, "get", "/auto-fill", { query: { field: "appointment.minutes" } });
  await call(app, "get", "/auto-fill");
  assert.equal(semeou(), 2);
});

// ── O MODELO ────────────────────────────────────────────────────────────────

function montaModelo({ conta }) {
  const marcados = [];
  const model = new AutoFill_model({
    api: {
      user: {
        async data() {
          return conta;
        },
        async marcarAutoFillSemeado(_id, chaves) {
          marcados.push(...chaves);
        },
      },
    },
  });
  const inseridos = [];
  model.insert = async (_id, field, value) => {
    inseridos.push({ field, value });
  };
  return { model, inseridos, marcados };
}

test("a primeira leitura semeia as seis durações de antes, e marca", async () => {
  const { model, inseridos, marcados } = montaModelo({ conta: { _id: ID } });
  await model.semear(ID);

  assert.deepEqual(
    inseridos.filter((i) => i.field === "appointment.minutes").map((i) => i.value),
    ["30", "45", "50", "60", "90", "120"]
  );
  assert.deepEqual(marcados, ["appointment.minutes"]);
});

test("já semeado, não semeia de novo — o 45 apagado não volta", async () => {
  const { model, inseridos } = montaModelo({
    conta: { _id: ID, autoFillSemeado: ["appointment.minutes"] },
  });
  await model.semear(ID);
  assert.equal(inseridos.length, 0);
});

test("a lista sai em ordem de NÚMERO", async () => {
  const model = new AutoFill_model({
    mongodb: {
      async connectToServer() {
        return {
          collection: () => ({
            find: () => ({
              sort: () => ({
                // A ordem que o banco dá: de texto.
                toArray: async () => [
                  { field: "appointment.minutes", value: "120" },
                  { field: "appointment.minutes", value: "30" },
                  { field: "appointment.minutes", value: "50" },
                  { field: "appointment.title", value: "Consulta" },
                  { field: "appointment.title", value: "Treino" },
                ],
              }),
            }),
          }),
        };
      },
    },
  });
  const rows = await model.list(ID);
  assert.deepEqual(
    rows.map((r) => r.value),
    ["30", "50", "120", "Consulta", "Treino"]
  );
});

test("o catálogo diz que o campo é numérico — a tela decide o desenho por isso", () => {
  const f = fields.localized((k) => k).find((x) => x.key === "appointment.minutes");
  assert.equal(f.numeric, true);
});
