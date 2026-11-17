const test = require("node:test");
const assert = require("node:assert/strict");

const Role_model = require("../../model/Role_model.js");
const permissions = require("../../lib/permissions.js");

// A renomeação dos papéis semeados.
//
// "Profissional" virou "Usuário" e "Pessoa" virou "Cliente" quando "profissional"
// deixou de ser um tipo de conta visível. O risco não é o nome: é que as contas
// apontam para o `_id` do papel. Semear um papel NOVO com o nome novo deixaria o
// antigo para trás com gente dentro, e a plataforma ficaria com dois papéis quase
// iguais sem ninguém saber qual vale.

// Mongo casa um valor solto contra um ARRAY pelo "contém" — é o que faz
// `{ permissions: "finance.manage" }` achar o papel que tem essa chave entre
// outras. Sem isto aqui, a migração das chaves novas passaria no teste sem
// encontrar papel nenhum.
function casa(doc, query) {
  return Object.entries(query).every(([k, v]) => {
    if (typeof v === "object" && v !== null && "$ne" in v) return doc[k] !== v.$ne;
    return Array.isArray(doc[k]) ? doc[k].includes(v) : doc[k] === v;
  });
}

// Uma collection de mentira com a superfície que o `ensureSystemRoles` usa.
function fakeCollection(docs = []) {
  const dados = docs.map((d, i) => ({ _id: d._id || `id${i}`, ...d }));

  return {
    dados,
    async findOne(query) {
      return dados.find((d) => casa(d, query)) || null;
    },
    async updateMany(query, update) {
      const alvos = dados.filter((d) => casa(d, query));

      for (const doc of alvos) {
        for (const [campo, valor] of Object.entries(update.$addToSet || {})) {
          const lista = doc[campo] || (doc[campo] = []);
          for (const item of valor.$each || [valor]) if (!lista.includes(item)) lista.push(item);
        }
        Object.assign(doc, update.$set || {});
      }

      return { modifiedCount: alvos.length };
    },
    async insertOne(doc) {
      dados.push({ _id: "novo" + dados.length, ...doc });
      return { insertedId: "novo" };
    },
    async updateOne(query, update) {
      const doc = await this.findOne(query);
      if (doc) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },
  };
}

function monta(docs) {
  const col = fakeCollection(docs);
  // A marca da migração das chaves de mensalidade mora em `configurations` —
  // é ela que faz a herança acontecer uma vez na vida de cada cliente.
  const configuracoes = fakeCollection();

  const roles = new Role_model({
    mongodb: {
      async connectToServer() {
        return { collection: (nome) => (nome === "configurations" ? configuracoes : col) };
      },
    },
  });

  roles.collection = async () => col;
  return { roles, col, configuracoes };
}

test.describe("ensureSystemRoles renomeia em vez de duplicar", () => {
  test("Profissional vira Usuário, MANTENDO o mesmo documento", async () => {
    const { roles, col } = monta([
      { _id: "r1", name: "Profissional", system: true, permissions: ["people.view"] },
    ]);

    await roles.ensureSystemRoles();

    const usuario = col.dados.find((d) => d.name === "Usuário");
    assert.equal(usuario?._id, "r1", "tinha de ser o MESMO documento — as contas apontam para o id");
    assert.equal(
      col.dados.filter((d) => d.name === "Profissional").length,
      0,
      "não pode sobrar o antigo"
    );
  });

  test("Pessoa vira Cliente", async () => {
    const { roles, col } = monta([{ _id: "r2", name: "Pessoa", system: true, permissions: [] }]);

    await roles.ensureSystemRoles();

    assert.equal(col.dados.find((d) => d.name === "Cliente")?._id, "r2");
  });

  test("as permissões que já estavam lá são preservadas", async () => {
    // Renomear não pode devolver o papel ao estado de fábrica: o admin pode ter
    // tirado ou acrescentado permissões, e elas são a razão de o papel existir.
    const { roles, col } = monta([
      {
        _id: "r1",
        name: "Profissional",
        system: true,
        permissions: ["people.view", "logs.view"],
      },
    ]);

    await roles.ensureSystemRoles();

    const usuario = col.dados.find((d) => d.name === "Usuário");
    assert.deepEqual(usuario.permissions, ["people.view", "logs.view"]);
  });

  test("rodar duas vezes não muda mais nada", async () => {
    // Roda em todo boot. Se não fosse idempotente, o segundo boot criaria
    // duplicatas.
    const { roles, col } = monta([
      { _id: "r1", name: "Profissional", system: true, permissions: [] },
      { _id: "r2", name: "Pessoa", system: true, permissions: [] },
    ]);

    await roles.ensureSystemRoles();
    const depoisDoPrimeiro = col.dados.length;
    await roles.ensureSystemRoles();

    assert.equal(col.dados.length, depoisDoPrimeiro);
    assert.equal(col.dados.filter((d) => d.name === "Usuário").length, 1);
    assert.equal(col.dados.filter((d) => d.name === "Cliente").length, 1);
  });

  test("um papel que a pessoa criou à mão com o nome novo não é atropelado", async () => {
    const { roles, col } = monta([
      { _id: "r1", name: "Profissional", system: true, permissions: ["people.view"] },
      { _id: "meu", name: "Usuário", system: false, permissions: ["logs.view"] },
    ]);

    await roles.ensureSystemRoles();

    const meu = col.dados.find((d) => d._id === "meu");
    assert.deepEqual(meu.permissions, ["logs.view"], "o papel de quem administra fica intacto");
    assert.equal(col.dados.find((d) => d._id === "r1").name, "Profissional", "o antigo não é tocado");
  });

  test("papel NÃO semeado com o nome antigo fica em paz", async () => {
    // `system: false` é papel que alguém criou. Renomeá-lo seria mexer no trabalho
    // de outra pessoa por causa de uma coincidência de nome.
    const { roles, col } = monta([{ _id: "x", name: "Pessoa", system: false, permissions: [] }]);

    await roles.ensureSystemRoles();

    assert.equal(col.dados.find((d) => d._id === "x").name, "Pessoa");
  });
});

test("o banco vazio nasce com os três papéis certos", async () => {
  const { roles, col } = monta([]);

  await roles.ensureSystemRoles();

  assert.deepEqual(
    col.dados.map((d) => d.name).sort(),
    ["Administrador", "Cliente", "Usuário"].sort()
  );
  assert.equal(
    col.dados.find((d) => d.name === "Administrador").permissions.length,
    permissions.ALL.length,
    "o Administrador nasce com tudo"
  );
  assert.deepEqual(col.dados.find((d) => d.name === "Cliente").permissions, []);
});

test("os nomes ficam no modelo, não escritos à mão em cada controller", () => {
  // Nome com acento repetido em dois lugares é erro de digitação esperando para
  // virar conta sem permissão.
  const roles = new Role_model({});
  assert.equal(roles.defaultName, "Usuário");
  assert.equal(roles.clientName, "Cliente");
  assert.equal(roles.adminName, "Administrador");
});

// ── A HERANÇA DAS CHAVES DE MENSALIDADE (15/10/2026) ─────────────────────
//
// `finance.recurrence`, `recurrenceDelete` e `recurrenceAmount` saíram de
// dentro de `finance.manage`. O perigo de toda chave nova é o mesmo: ela
// REVOGA em silêncio quem já fazia aquilo, e ninguém relaciona o botão que
// sumiu com um deploy.
test.describe("as chaves novas da mensalidade não tiram poder de ninguém", () => {
  const NOVAS = ["finance.recurrence", "finance.recurrenceDelete", "finance.recurrenceAmount"];

  test("quem tinha finance.manage herda as três", async () => {
    const { roles, col } = monta([
      { _id: "r9", name: "Recepção", permissions: ["finance.view", "finance.manage"] },
    ]);

    await roles.ensureSystemRoles();

    const recepcao = col.dados.find((d) => d._id === "r9");
    for (const chave of NOVAS) assert.ok(recepcao.permissions.includes(chave), chave);
  });

  test("quem NÃO tinha continua sem — a chave nova não distribui poder", async () => {
    const { roles, col } = monta([
      { _id: "r8", name: "Professor", permissions: ["workouts.view", "workouts.manage"] },
    ]);

    await roles.ensureSystemRoles();

    const professor = col.dados.find((d) => d._id === "r8");
    assert.deepEqual(professor.permissions, ["workouts.view", "workouts.manage"]);
  });

  test("o segundo boot NÃO ressuscita o que o admin tirou", async () => {
    // É a razão de existir a marca em `configurations`. Sem ela, desmarcar as
    // três na tela duraria até o próximo restart do servidor.
    const { roles, col } = monta([
      { _id: "r9", name: "Recepção", permissions: ["finance.view", "finance.manage"] },
    ]);

    await roles.ensureSystemRoles();

    const recepcao = col.dados.find((d) => d._id === "r9");
    recepcao.permissions = ["finance.view", "finance.manage"];

    await roles.ensureSystemRoles();

    assert.deepEqual(recepcao.permissions, ["finance.view", "finance.manage"]);
  });

  test("a marca é gravada uma vez só", async () => {
    const { roles, configuracoes } = monta([]);

    await roles.ensureSystemRoles();
    await roles.ensureSystemRoles();

    const marcas = configuracoes.dados.filter((d) => d.chave === "migracao_permissao_recorrencia");
    assert.equal(marcas.length, 1);
  });
});
