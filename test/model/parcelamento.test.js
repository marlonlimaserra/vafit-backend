const test = require("node:test");
const assert = require("node:assert/strict");

const Finance_model = require("../../model/Finance_model.js");

// O PARCELAMENTO — um valor em N vezes.
//
// *"crie a aba parcelamento pois o asaas pode criar parcelamento também"*
// (17/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. A SOMA DAS PARCELAS É O TOTAL. Sempre, em qualquer divisão. É a única
//    coisa que não pode falhar aqui: um centavo a menos é o número que não
//    bate quando alguém fecha o mês, e ninguém desconfia de um carnê.
// 2. NÃO EXISTE COLEÇÃO DE PARCELAMENTO. Ele é o conjunto das cobranças que
//    compartilham um `installment` — um documento à parte poderia discordar
//    das parcelas que ele diz ter.
// 3. AS DATAS andam de mês em mês a partir do primeiro vencimento.
function fakeModel() {
  const inseridos = [];
  const model = new Finance_model({
    api: { counter: { proximo: async () => 1 } },
  });
  model.charges = async () => ({
    async insertMany(docs) {
      inseridos.push(...docs);
      return { insertedCount: docs.length };
    },
  });
  return { model, inseridos };
}

const PESSOA = "6aac6f7fce88864c1d79e021";

test("a soma das parcelas é EXATAMENTE o total", async () => {
  // R$ 100,00 em 3: 33,33 cada dá 99,99. O centavo que some é o tipo de erro
  // que não dá erro — só uma conta que não fecha no fim do mês.
  // Os valores vão em CENTAVOS: `centavos()` lê número como já convertido —
  // é o que o próprio sistema manda, e a tela converte antes.
  for (const [total, n] of [[10000, 3], [10000, 7], [49990, 12], [100, 3], [123457, 11]]) {
    const { model, inseridos } = fakeModel();
    await model.parcelar(PESSOA, { total, parcelas: n }, null, "BRL");

    const soma = inseridos.reduce((s, d) => s + d.amount, 0);
    assert.equal(soma, total, `${total} em ${n}x somou ${soma}`);
    assert.equal(inseridos.length, n);
  }
});

test("a sobra vai na PRIMEIRA, como todo carnê", async () => {
  // No fim, quem já esqueceu o combinado estranha a parcela diferente. No
  // começo, quem ainda está decidindo vê a diferença e aceita.
  const { model, inseridos } = fakeModel();
  await model.parcelar(PESSOA, { total: 10000, parcelas: 3 }, null, "BRL");

  assert.deepEqual(inseridos.map((d) => d.amount), [3334, 3333, 3333]);
});

test("divisão exata não inventa diferença", async () => {
  const { model, inseridos } = fakeModel();
  await model.parcelar(PESSOA, { total: 12000, parcelas: 4 }, null, "BRL");

  assert.deepEqual(inseridos.map((d) => d.amount), [3000, 3000, 3000, 3000]);
});

test("as parcelas andam de mês em mês, e sabem a própria posição", async () => {
  const { model, inseridos } = fakeModel();
  await model.parcelar(
    PESSOA,
    { total: 30000, parcelas: 3, primeiroVencimento: "2026-01-10", description: "Plano anual" },
    null,
    "BRL"
  );

  assert.deepEqual(inseridos.map((d) => d.dueDate.getMonth()), [0, 1, 2]);
  assert.deepEqual(inseridos.map((d) => d.parcela), [1, 2, 3]);
  assert.deepEqual(inseridos.map((d) => d.parcelas), [3, 3, 3]);
  // Todas no MESMO grupo: é ele que faz a aba listar um carnê e não três
  // cobranças soltas.
  assert.equal(new Set(inseridos.map((d) => String(d.installment))).size, 1);
  assert.deepEqual(inseridos.map((d) => d.description), ["Plano anual", "Plano anual", "Plano anual"]);
});

test("o valor mandado ao gateway é o da parcela SEM a sobra", async () => {
  // O Asaas aceita `totalValue` (e divide ele mesmo) ou `installmentValue`.
  // Mandando o valor da parcela, quem arredonda somos nós — uma vez só — e o
  // total de lá passa a ser o mesmo daqui. A primeira carrega a sobra aqui;
  // mandá-la faria o carnê de lá cobrar a mais.
  const { model } = fakeModel();
  const r = await model.parcelar(PESSOA, { total: 10000, parcelas: 3 }, null, "BRL");

  assert.equal(r.valorDaParcela, 3333);
  assert.equal(r.primeira.amount, 3334);
});

test("uma parcela só, ou nenhuma, não é parcelamento", async () => {
  // Parcelar em 1x é criar uma cobrança — e já existe tela para isso.
  const { model, inseridos } = fakeModel();

  assert.equal((await model.parcelar(PESSOA, { total: 10000, parcelas: 1 })).ok, false);
  assert.equal((await model.parcelar(PESSOA, { total: 10000, parcelas: 0 })).ok, false);
  assert.equal((await model.parcelar(PESSOA, { total: 0, parcelas: 3 })).ok, false);
  assert.deepEqual(inseridos, []);
});

test("quarenta e oito é o teto, e ele CORTA em vez de recusar", async () => {
  // Um dedo no zero vira 120 parcelas de R$ 2 — cento e vinte cobranças
  // criadas de uma vez, que alguém terá de apagar à mão. O teto é o que
  // impede o erro de digitação de virar trabalho.
  const { model, inseridos } = fakeModel();
  await model.parcelar(PESSOA, { total: 100000, parcelas: 120 }, null, "BRL");

  assert.equal(inseridos.length, 48);
});

test("nasce aberta, e sem vínculo nenhum de outra origem", async () => {
  // Uma parcela não vem de compromisso, aulão nem assinatura. Deixar o campo
  // de fora faria `origem` cair em "manual" — e aí o carnê se confunde com a
  // cobrança escrita à mão.
  const { model, inseridos } = fakeModel();
  await model.parcelar(PESSOA, { total: 10000, parcelas: 2 }, null, "BRL");

  for (const d of inseridos) {
    assert.equal(d.status, "open");
    assert.equal(d.recurrence, null);
    assert.equal(d.aulao, null);
    assert.equal(d.appointment, null);
  }
});
