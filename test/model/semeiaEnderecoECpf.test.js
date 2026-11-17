const test = require("node:test");
const assert = require("node:assert/strict");

const CustomFieldGroup_model = require("../../model/CustomFieldGroup_model.js");
const CustomField_model = require("../../model/CustomField_model.js");

// A GAVETA "ENDEREÇO" E O CPF, SEMEADOS ANTES DE SEREM PRECISOS.
//
// *"quando a gente habilitar isso [o gateway], vamos precisar de endereço da
// pessoa, CPF... acho que é melhor, por padrão, já vir um grupo chamado
// endereços em todas as instâncias"* (14/10/2026).
//
// ── O QUE ESTE ARQUIVO PROTEGE ────────────────────────────────────────────
//
// 1. QUE APAGAR COLE. `semear()` roda a CADA BOOT. Se os campos fossem
//    guardados por alias, como os nativos, a academia que apagasse "Bairro"
//    o veria de volta na manhã seguinte — e "apagar" que não apaga é pior
//    que não deixar apagar. A marca de uma-vez-só é o NASCIMENTO DA GAVETA:
//    ela nasce uma vez na vida da instância, e os campos vêm com ela.
//
//    Nativo não tem esse problema porque nativo não se apaga (400
//    `customFieldIsNative`). Estes se apagam, e é de propósito.
//
// 2. QUE A CONTA VELHA TAMBÉM GANHE. A gaveta é nova; `principal` já existe
//    em todo cliente desde sempre. Semear "só se não houver nada" deixaria
//    de fora exatamente quem já usa o sistema — que são todos.
//
// 3. QUE O CPF NASÇA DESLIGADO. Ele é identidade, não endereço, e quem nunca
//    vai cobrar não precisa de um campo de CPF na ficha.

// Um dobro que guarda o que foi inserido, porque é isso que está sob teste:
// não "deu certo", e sim O QUE foi escrito.
function comBanco(jaExistem = []) {
  const escrito = [];
  const app = {
    mongodb: {
      async connectToServer() {
        return {
          collection() {
            return {
              async findOne(filtro) {
                return jaExistem.find((d) => d.key === filtro?.key) || null;
              },
              find() {
                return {
                  async toArray() {
                    return jaExistem;
                  },
                };
              },
              async insertOne(doc) {
                escrito.push(doc);
              },
              async insertMany(docs) {
                escrito.push(...docs);
              },
            };
          },
        };
      },
    },
  };
  return { app, escrito };
}

test("instância nova ganha as DUAS gavetas, e diz quais nasceram agora", async () => {
  const { app, escrito } = comBanco([]);
  const r = await new CustomFieldGroup_model(app).semear();

  assert.deepEqual(
    escrito.map((g) => g.key).sort(),
    ["endereco", "principal"]
  );
  assert.deepEqual(r.novos.sort(), ["endereco", "principal"]);
});

test("conta ANTIGA, que já tem `principal`, ganha só a gaveta nova", async () => {
  // É o caso de todo cliente que já usa o sistema. Semear "só se não houver
  // nada" deixaria de fora justamente quem importa.
  const { app, escrito } = comBanco([{ key: "principal" }]);
  const r = await new CustomFieldGroup_model(app).semear();

  assert.deepEqual(escrito.map((g) => g.key), ["endereco"]);
  assert.deepEqual(r.novos, ["endereco"]);
});

test("no segundo boot não nasce nada, e `novos` volta vazio", async () => {
  const { app, escrito } = comBanco([{ key: "principal" }, { key: "endereco" }]);
  const r = await new CustomFieldGroup_model(app).semear();

  assert.equal(escrito.length, 0);
  assert.deepEqual(r.novos, []);
});

test("a gaveta nasce sem `name` — o rótulo é do idioma de quem abre", async () => {
  const { app, escrito } = comBanco([{ key: "principal" }]);
  await new CustomFieldGroup_model(app).semear();

  const endereco = escrito[0];
  assert.equal(endereco.name, "");
  assert.equal(endereco.rotuloPadrao, "customFields.group.endereco");
});

test("com a gaveta nova, vêm os sete campos de endereço E o CPF", async () => {
  const { app, escrito } = comBanco([]);
  await new CustomField_model(app).semear({ gruposNovos: ["endereco"] });

  const porGrupo = (g) => escrito.filter((c) => c.grupo === g).map((c) => c.alias);

  assert.deepEqual(porGrupo("endereco").sort(), [
    "bairro",
    "cep",
    "cidade",
    "complemento",
    "estado",
    "logradouro",
    "numero",
  ]);
  // O CPF é identidade, e mora onde moram os dados da pessoa.
  assert.ok(porGrupo("principal").includes("cpf"));
});

test("os campos de endereço nascem LIGADOS e na ficha — foi a escolha dele", async () => {
  const { app, escrito } = comBanco([]);
  await new CustomField_model(app).semear({ gruposNovos: ["endereco"] });

  for (const c of escrito.filter((x) => x.grupo === "endereco")) {
    assert.equal(c.ativo, true, c.alias);
    assert.equal(c.noCadastro, true, c.alias);
  }
});

test("e o CPF nasce DESLIGADO — quem não cobra não precisa dele na ficha", async () => {
  const { app, escrito } = comBanco([]);
  await new CustomField_model(app).semear({ gruposNovos: ["endereco"] });

  const cpf = escrito.find((c) => c.alias === "cpf");
  assert.equal(cpf.ativo, false);
  assert.equal(cpf.noCadastro, false);
  // O tipo já existe no sistema, com máscara e dígito conferido — e tipo não
  // se troca depois de criado.
  assert.equal(cpf.tipo, "cpf");
});

test("nenhum deles é NATIVO — a casa pode renomear, desligar e APAGAR", async () => {
  const { app, escrito } = comBanco([]);
  await new CustomField_model(app).semear({ gruposNovos: ["endereco"] });

  for (const c of escrito.filter((x) => x.alias !== "goal" && x.alias !== "weight" && x.alias !== "height")) {
    assert.equal(c.nativo, false, c.alias);
  }
});

test("SEM gaveta nova, só os nativos entram — é isto que faz o apagar colar", async () => {
  // O boot de amanhã, numa instância que já tem tudo e apagou "Bairro".
  const { app, escrito } = comBanco([
    { alias: "goal" },
    { alias: "weight" },
    { alias: "height" },
    { alias: "cep" },
  ]);
  await new CustomField_model(app).semear({ gruposNovos: [] });

  assert.equal(escrito.length, 0);
});

test("chamar sem argumento nenhum não semeia cobrança — o padrão é o calado", async () => {
  const { app, escrito } = comBanco([]);
  await new CustomField_model(app).semear();

  assert.deepEqual(escrito.map((c) => c.alias).sort(), ["goal", "height", "weight"]);
});
