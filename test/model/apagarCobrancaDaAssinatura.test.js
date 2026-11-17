const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const Finance_model = require("../../model/Finance_model.js");

// Apagar uma cobrança DA ASSINATURA avisa a regra. Sem esta chamada, a
// geração recria o período na próxima leitura da tela.
test("apagar uma parcela da assinatura deixa a lápide na regra", async () => {
  const lapides = [];
  const ID = new ObjectId();
  const REC = new ObjectId();

  const model = new Finance_model({
    api: { recurrence: { async naoGerarMais(id, periodo) { lapides.push({ id, periodo }); } } },
  });
  model.charges = async () => ({
    async findOne() { return { _id: ID, recurrence: REC, periodo: "2026-09-05" }; },
    async deleteOne() { return { deletedCount: 1 }; },
  });
  model.payments = async () => ({ async updateMany() { return {}; } });

  assert.equal(await model.deleteCharge(String(ID)), true);
  assert.deepEqual(lapides, [{ id: String(REC), periodo: "2026-09-05" }]);
});

test("cobrança avulsa não deixa lápide em regra nenhuma", async () => {
  const lapides = [];
  const ID = new ObjectId();
  const model = new Finance_model({
    api: { recurrence: { async naoGerarMais(...a) { lapides.push(a); } } },
  });
  model.charges = async () => ({
    async findOne() { return { _id: ID, recurrence: null, periodo: null }; },
    async deleteOne() { return { deletedCount: 1 }; },
  });
  model.payments = async () => ({ async updateMany() { return {}; } });

  await model.deleteCharge(String(ID));
  assert.deepEqual(lapides, []);
});
