const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Workout_model = require("../../model/Workout_model.js");

// O TREINO CONCLUÍDO, exercício a exercício (16/11/2026).
//
// *"o concluir treino ficou legal, mas queria concluir exercício por
// exercício"*. O que estes casos seguram:
//   • marcar o ÚLTIMO exercício conclui o treino — e diz isso UMA vez só;
//   • desmarcar um exercício tira o concluído;
//   • desfazer o concluído NÃO apaga as marcas dos exercícios;
//   • o documento da primeira versão (sem `completed`) conta como concluído.

// Uma collection de mentira que entende só o que o modelo usa.
function colecao(docs = []) {
  const igual = (a, b) => String(a) === String(b);
  const casa = (d, filtro) =>
    Object.entries(filtro).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof ObjectId)) {
        if ("$size" in v) return Array.isArray(d[k]) && d[k].length === v.$size;
        if ("$exists" in v) return (d[k] !== undefined) === v.$exists;
      }
      return igual(d[k], v);
    });

  return {
    docs,
    async updateOne(filtro, mudanca, opcoes = {}) {
      let d = docs.find((x) => casa(x, filtro));
      let inserido = false;
      if (!d) {
        if (!opcoes.upsert) return { matchedCount: 0 };
        d = { _id: new ObjectId(), ...filtro };
        docs.push(d);
        inserido = true;
        Object.assign(d, mudanca.$setOnInsert || {});
      }
      Object.assign(d, mudanca.$set || {});
      for (const k of Object.keys(mudanca.$unset || {})) delete d[k];
      for (const [k, v] of Object.entries(mudanca.$addToSet || {})) {
        d[k] = d[k] || [];
        if (!d[k].includes(v)) d[k].push(v);
      }
      for (const [k, v] of Object.entries(mudanca.$pull || {})) {
        d[k] = (d[k] || []).filter((x) => x !== v);
      }
      return { matchedCount: inserido ? 0 : 1 };
    },
    async deleteOne(filtro) {
      const i = docs.findIndex((x) => casa(x, filtro));
      if (i >= 0) docs.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
    async findOne(filtro) {
      return docs.find((x) => casa(x, filtro)) || null;
    },
    find(filtro) {
      return { toArray: async () => docs.filter((x) => casa(x, filtro)) };
    },
  };
}

const PESSOA = new ObjectId();
const TREINO = new ObjectId();
const HOJE = "2026-11-16";

function monta(docs) {
  const col = colecao(docs);
  const modelo = new Workout_model({});
  modelo.logsCollection = async () => col;
  return { modelo, col };
}

test("marcar exercícios um a um, e o ÚLTIMO conclui o treino — uma vez só", async () => {
  const { modelo } = monta();

  assert.deepEqual(await modelo.marcarExercicio(PESSOA, TREINO, HOJE, 0, true, 3), { completou: false });
  assert.deepEqual(await modelo.marcarExercicio(PESSOA, TREINO, HOJE, 2, true, 3), { completou: false });

  let resumo = (await modelo.feitosDaPessoa(PESSOA, HOJE))[String(TREINO)];
  assert.equal(resumo.today, false);
  assert.deepEqual(resumo.exercises, [0, 2]);
  assert.equal(resumo.count, 0);

  // O último: conclui.
  assert.deepEqual(await modelo.marcarExercicio(PESSOA, TREINO, HOJE, 1, true, 3), { completou: true });
  resumo = (await modelo.feitosDaPessoa(PESSOA, HOJE))[String(TREINO)];
  assert.equal(resumo.today, true);
  assert.equal(resumo.count, 1);

  // Marcar de novo um que já estava: não comemora outra vez.
  assert.deepEqual(await modelo.marcarExercicio(PESSOA, TREINO, HOJE, 1, true, 3), { completou: false });
});

test("desmarcar um exercício tira o concluído", async () => {
  const { modelo } = monta();
  for (const i of [0, 1]) await modelo.marcarExercicio(PESSOA, TREINO, HOJE, i, true, 2);

  await modelo.marcarExercicio(PESSOA, TREINO, HOJE, 1, false, 2);

  const resumo = (await modelo.feitosDaPessoa(PESSOA, HOJE))[String(TREINO)];
  assert.equal(resumo.today, false);
  assert.deepEqual(resumo.exercises, [0]);
});

test("desfazer o CONCLUÍDO não apaga as marcas dos exercícios", async () => {
  const { modelo, col } = monta();
  for (const i of [0, 1]) await modelo.marcarExercicio(PESSOA, TREINO, HOJE, i, true, 2);

  await modelo.desmarcarFeito(PESSOA, TREINO, HOJE);

  const resumo = (await modelo.feitosDaPessoa(PESSOA, HOJE))[String(TREINO)];
  assert.equal(resumo.today, false);
  assert.deepEqual(resumo.exercises, [0, 1]);
  assert.equal(col.docs.length, 1);
});

test("concluir pelo BOTÃO vale sem marcar exercício — e desfazer, sem marca nenhuma, apaga o dia", async () => {
  const { modelo, col } = monta();

  await modelo.marcarFeito(PESSOA, TREINO, HOJE, "app");
  assert.equal((await modelo.feitosDaPessoa(PESSOA, HOJE))[String(TREINO)].today, true);

  await modelo.desmarcarFeito(PESSOA, TREINO, HOJE);
  assert.equal(col.docs.length, 0);
});

test("o dia da primeira versão (sem `completed`) conta como concluído", async () => {
  const { modelo } = monta([{ _id: new ObjectId(), student: PESSOA, workout: TREINO, day: "2026-11-10" }]);

  const resumo = (await modelo.feitosDaPessoa(PESSOA, HOJE))[String(TREINO)];
  assert.equal(resumo.count, 1);
  assert.equal(resumo.last, "2026-11-10");
  assert.equal(resumo.today, false);
});
