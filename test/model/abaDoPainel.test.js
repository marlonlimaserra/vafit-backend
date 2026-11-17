const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const AbaDoPainel = require("../../model/AbaDoPainel_model.js");

// AS ABAS COMPARTILHADAS DO PAINEL — quem as recebe, e o que é guardado.
//
// *"quem poderia ver aquela aba, quais departamentos etc…"* (24/10/2026).
//
// ── O QUE ESTES CASOS SEGURAM ───────────────────────────────────────────
//
// Três coisas que quebrariam caladas:
//
//   1. Uma aba endereçada a ninguém — desmarcar "todos" e não escolher nenhum
//      público deixaria um documento que não aparece para ser humano nenhum,
//      inclusive para quem acabou de criá-lo.
//
//   2. O público antigo sobrevivendo embaixo do "todos". Guardado em silêncio,
//      ele voltaria a valer no dia em que alguém desligasse o "todos".
//
//   3. O departamento saindo da conta de quem recebe. É a parte da consulta
//      que ninguém olha, e sem ela a aba do Financeiro chega para a casa toda.
function fake({ abas = [], departamentos = [] } = {}) {
  const feito = { consultas: [], inseridos: [], atualizacoes: [] };

  const colecoes = {
    dashboard_tabs: {
      find: (q) => {
        feito.consultas.push(q);
        const cadeia = {
          collation: () => cadeia,
          sort: () => cadeia,
          limit: () => cadeia,
          async toArray() {
            return abas;
          },
        };
        return cadeia;
      },
      async findOne(q) {
        return abas.find((a) => String(a._id) === String(q._id)) || null;
      },
      async insertOne(doc) {
        feito.inseridos.push(doc);
        return { insertedId: new ObjectId() };
      },
      async updateOne(q, u) {
        feito.atualizacoes.push({ q, u });
      },
      async deleteOne() {
        return { deletedCount: 1 };
      },
    },
    departments: {
      find: (q) => {
        feito.consultas.push(q);
        return { async toArray() { return departamentos; } };
      },
    },
  };

  const app = { mongodb: { async connectToServer() { return { collection: (n) => colecoes[n] }; } } };
  return { modelo: new AbaDoPainel(app), feito };
}

const id = () => new ObjectId();

test("público vazio vira `todos` — aba endereçada a ninguém não existe", async () => {
  const { modelo, feito } = fake();

  await modelo.insert({ nome: "Cobrança", publico: { todos: false } });

  assert.deepEqual(feito.inseridos[0].publico, {
    todos: true,
    papeis: [],
    departamentos: [],
    pessoas: [],
  });
});

test("`todos` APAGA as listas em vez de guardá-las escondidas", async () => {
  const { modelo, feito } = fake();
  const papel = id();

  await modelo.insert({ nome: "Visão", publico: { todos: true, papeis: [String(papel)] } });

  assert.equal(feito.inseridos[0].publico.todos, true);
  assert.deepEqual(feito.inseridos[0].publico.papeis, []);
});

test("as três listas se SOMAM, e são guardadas como ObjectId", async () => {
  const { modelo, feito } = fake();
  const papel = id();
  const depto = id();
  const pessoa = id();

  await modelo.insert({
    nome: "Cobrança",
    publico: {
      todos: false,
      papeis: [String(papel)],
      departamentos: [String(depto)],
      pessoas: [String(pessoa)],
    },
  });

  const p = feito.inseridos[0].publico;
  assert.equal(p.todos, false);
  assert.ok(p.papeis[0] instanceof ObjectId);
  assert.equal(String(p.papeis[0]), String(papel));
  assert.equal(String(p.departamentos[0]), String(depto));
  assert.equal(String(p.pessoas[0]), String(pessoa));
});

test("id inválido no público é descartado, não guardado como texto", async () => {
  const { modelo, feito } = fake();

  await modelo.insert({ nome: "X", publico: { todos: false, pessoas: ["nao-é-id", ""] } });

  // Sobrou nada → volta a ser de todos, que é a regra do primeiro caso.
  assert.equal(feito.inseridos[0].publico.todos, true);
});

// ── AS PEÇAS ─────────────────────────────────────────────────────────────
//
// O catálogo de números mora nos CLIENTES (o painel sabe desenhar cada um), e
// repetir a lista aqui criaria duas para manter. Então aqui se exige a FORMA —
// e o que importa é que lixo não entre.
test("a peça é validada por formato, e a repetida só entra uma vez", async () => {
  const { modelo, feito } = fake();

  await modelo.insert({
    nome: "X",
    pecas: ["dinheiro.atrasado", "dinheiro.atrasado", "agenda", "$where", "a.b.c", "   "],
  });

  assert.deepEqual(feito.inseridos[0].pecas, ["dinheiro.atrasado", "agenda"]);
});

test("aba sem nome é recusada", async () => {
  const { modelo } = fake();
  assert.deepEqual(await modelo.insert({ nome: "   " }), { erro: "sem_nome" });
});

// ── QUEM RECEBE ──────────────────────────────────────────────────────────
test("`daPessoa` pergunta os departamentos DELA e usa os ids na busca", async () => {
  const minhaFila = id();
  const { modelo, feito } = fake({ departamentos: [{ _id: minhaFila }] });

  const eu = { _id: id(), role: id() };
  await modelo.daPessoa(eu);

  const [consultaDepto, consultaAbas] = feito.consultas;

  // A pergunta aos departamentos é "de quais filas EU faço parte" — e só as
  // ligadas: uma fila desativada não endereça mais nada.
  assert.deepEqual(consultaDepto.membros, eu._id);
  assert.deepEqual(consultaDepto.ativo, { $ne: false });

  const ou = consultaAbas.$or;
  assert.deepEqual(ou[0], { "publico.todos": true });
  assert.deepEqual(ou[1], { "publico.papeis": eu.role });
  assert.deepEqual(ou[2], { "publico.pessoas": eu._id });
  assert.deepEqual(ou[3], { "publico.departamentos": { $in: [minhaFila] } });

  // E a desativada não chega a ninguém.
  assert.deepEqual(consultaAbas.ativo, { $ne: false });
});

test("sem fila nenhuma, o `$in` vazio não casa com nada — e não vira `todos`", async () => {
  const { modelo, feito } = fake({ departamentos: [] });

  await modelo.daPessoa({ _id: id(), role: id() });

  const consultaAbas = feito.consultas[1];
  assert.deepEqual(consultaAbas.$or[3], { "publico.departamentos": { $in: [] } });
});

test("a aba nova nasce no FIM da fila, não na frente", async () => {
  const { modelo, feito } = fake({ abas: [{ _id: id(), ordem: 7 }] });

  await modelo.insert({ nome: "Nova" });

  assert.equal(feito.inseridos[0].ordem, 8);
});
