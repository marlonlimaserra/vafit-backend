const test = require("node:test");
const assert = require("node:assert/strict");

const ApiKey = require("../../model/ApiKey_model.js");

// O NÍVEL COM QUE UMA CHAVE NASCE.
//
// *"meu medo é alguém apagar tudo de todo mundo... principalmente via mcp"*
// (14/11/2026).
//
// A tela de criar conexão já manda o nível, e começa em "escrever". Mas a chave
// também nasce por `POST /api-keys` cru, sem passar pela tela — e ali o padrão
// ANTIGO era "apagar" (o fail-open de `nivelValido`, que existe de propósito
// para a chave LEGADA sem o campo). Resultado: uma chave criada por fora da tela
// podia apagar tudo sem ninguém ter escolhido isso.
//
// Estes casos seguram que a chave NOVA nasce no degrau seguro, e que um nível
// dito de propósito continua valendo.

function montaModel() {
  let gravado = null;
  const app = {
    crypto: require("crypto"),
    mongodb: {
      async connectToServer() {
        return {
          collection() {
            return {
              async insertOne(doc) {
                gravado = doc;
                return { insertedId: "id-novo" };
              },
            };
          },
        };
      },
    },
  };
  return { model: new ApiKey(app), lido: () => gravado };
}

test("chave nova SEM nível dito nasce 'escrever', não 'apagar'", async () => {
  const { model, lido } = montaModel();
  await model.create("64b7c0000000000000000001", "Integração", undefined, undefined);
  assert.equal(lido().nivel, "escrever");
});

test("nível dito de propósito vence: 'apagar' continua 'apagar'", async () => {
  const { model, lido } = montaModel();
  await model.create("64b7c0000000000000000001", "Integração", undefined, "apagar");
  assert.equal(lido().nivel, "apagar");
});

test("'ler' dito também é respeitado", async () => {
  const { model, lido } = montaModel();
  await model.create("64b7c0000000000000000001", "Integração", undefined, "ler");
  assert.equal(lido().nivel, "ler");
});

test("nível lixo cai no padrão seguro 'escrever', nunca em 'apagar'", async () => {
  const { model, lido } = montaModel();
  await model.create("64b7c0000000000000000001", "Integração", undefined, "destruir-tudo");
  assert.equal(lido().nivel, "escrever");
});
