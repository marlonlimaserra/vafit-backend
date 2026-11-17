const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const User_model = require("../../model/User_model.js");

// BLOQUEAR O ACESSO DERRUBA A SESSÃO ABERTA.
//
// *"meu medo é alguém... conseguir acessar dados"* (14/11/2026).
//
// Bloquear só impedia um login NOVO; quem já estava dentro seguia por até 30
// dias, porque a borda não olhava `appBloqueado` e o token não era apagado.
// A borda agora recusa (ver guards.test.js); aqui o que se segura é a outra
// ponta: bloquear apaga os tokens na hora, pelos DOIS caminhos (o botão de
// revogar e o estado na ficha). E que LIBERAR não mexe em token.

const PESSOA = new ObjectId();
const TRAINER = new ObjectId();

function monta({ matched = 1 } = {}) {
  const derrubados = [];
  const app = {
    crypto: require("crypto"),
    mongodb: {
      async connectToServer() {
        return {
          collection() {
            return {
              async updateOne() {
                return { matchedCount: matched, modifiedCount: matched };
              },
            };
          },
        };
      },
    },
    api: {
      link: {
        async exists() {
          return true;
        },
      },
      auth: {
        async deleteAllTokensByUser(id) {
          derrubados.push(String(id));
        },
      },
    },
  };
  return { model: new User_model(app), derrubados };
}

test("revokeStudentAccess apaga os tokens da pessoa", async () => {
  const { model, derrubados } = monta();
  await model.revokeStudentAccess(String(TRAINER), String(PESSOA));
  assert.deepEqual(derrubados, [String(PESSOA)]);
});

test("bloquear pela ficha (updateStudent) também apaga os tokens", async () => {
  const { model, derrubados } = monta();
  await model.updateStudent(String(TRAINER), String(PESSOA), { bloquearAcesso: true });
  assert.deepEqual(derrubados, [String(PESSOA)]);
});

test("LIBERAR (bloquearAcesso:false) NÃO apaga token nenhum", async () => {
  const { model, derrubados } = monta();
  await model.updateStudent(String(TRAINER), String(PESSOA), { bloquearAcesso: false });
  assert.deepEqual(derrubados, [], "liberar não pode derrubar quem acabou de voltar");
});

test("definir senha nova (que desbloqueia) não derruba token", async () => {
  const { model, derrubados } = monta();
  await model.updateStudent(String(TRAINER), String(PESSOA), { password: "novasenha1" });
  assert.deepEqual(derrubados, []);
});
