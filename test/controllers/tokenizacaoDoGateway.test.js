const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const controlador = require("../../controllers/PaymentGateway.js");

// A CAIXA DA TOKENIZAÇÃO DE CARTÃO — Configurações › Contas › Gateways.
//
// *"coloque um checkbox, 'tokenização de cartão ativo' no asaas, pelo menos,
// eles precisam pedir para ativar, aí, se ativar, conseguimos tokerizar o
// cartão de crédito para pagar faturas"* (16/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. A PERMISSÃO É A DO FINANCEIRO. A caixa decide se o cartão de um aluno
//    pode ficar guardado para ser cobrado de novo depois — quem só lê o
//    financeiro não marca isso.
// 2. GATEWAY QUE NÃO TOKENIZA RECUSA, mesmo que a tela mande. A tela é um
//    palpite sobre o que o servidor aceita.
// 3. O QUE CHEGA DO CORPO VIRA BOOLEANO. "false" como texto é verdadeiro em
//    JavaScript, e isso ligaria a caixa de quem a estava desligando.

const USUARIO = { _id: "u1", name: "Marlon", permissions: ["finance.manage"] };

function monta({ negadas = [], marcar } = {}) {
  const feito = { marcadas: [] };
  const { helpers, pedidas } = permiteTudo(USUARIO, negadas);

  const app = fakeApp({
    helpers,
    api: {
      paymentGateway: {
        async marcarTokenizacao(tipo, unidade, ativa) {
          feito.marcadas.push({ tipo, unidade, ativa });
          return marcar ? marcar() : { ok: true };
        },
        async lista(unidade) {
          return [{ chave: "asaas", nome: "Asaas", tokeniza: true, ligado: { unidade } }];
        },
      },
      cobrador: {
        async registrarWebhook() {
          return { ok: true };
        },
      },
    },
  });

  controlador(app);
  return { app, feito, pedidas };
}

test("marcar a caixa guarda a declaração e devolve a lista inteira", async () => {
  const { app, feito } = monta();

  const r = await call(app, "post", "/payment-gateways/asaas/tokenizacao", {
    body: { ativa: true },
  });

  assert.equal(r.status, 200);
  assert.deepEqual(feito.marcadas, [{ tipo: "asaas", unidade: "", ativa: true }]);
  // A lista volta junto para a tela não precisar de uma segunda ida só para
  // saber o que ela já sabe.
  assert.equal(r.body.rows.length, 1);
});

test("o que chega do corpo vira BOOLEANO — 'false' em texto não liga a caixa", async () => {
  const { app, feito } = monta();

  await call(app, "post", "/payment-gateways/asaas/tokenizacao", { body: { ativa: "false" } });

  assert.equal(feito.marcadas[0].ativa, false);
});

test("a declaração vai para a UNIDADE pedida — a conta da filial é outra", async () => {
  const { app, feito } = monta();

  await call(app, "post", "/payment-gateways/asaas/tokenizacao", {
    body: { ativa: true },
    query: { unidade: "6aac6f7fce88864c1d79e021" },
  });

  assert.equal(feito.marcadas[0].unidade, "6aac6f7fce88864c1d79e021");
});

test("gateway que NÃO sabe guardar cartão recusa, mesmo que a tela mande", async () => {
  // O Pagar.me tokeniza pelo navegador, com a chave pública: é outro
  // desenho. Deixar passar guardaria uma declaração que não significa nada.
  const { app, feito } = monta();

  const r = await call(app, "post", "/payment-gateways/pagarme/tokenizacao", {
    body: { ativa: true },
  });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "sem_tokenizacao");
  assert.deepEqual(feito.marcadas, []);
});

test("gateway inventado não vira rota — a lista é fechada", async () => {
  const { app } = monta();

  const r = await call(app, "post", "/payment-gateways/__proto__/tokenizacao", {
    body: { ativa: true },
  });

  assert.equal(r.status, 404);
});

test("gateway não configurado recusa: não há conta sobre a qual declarar", async () => {
  const { app } = monta({ marcar: () => ({ erro: "nao_configurado" }) });

  const r = await call(app, "post", "/payment-gateways/asaas/tokenizacao", {
    body: { ativa: true },
  });

  assert.equal(r.status, 409);
});

test("quem só LÊ o financeiro não marca a caixa", async () => {
  const { app, pedidas, feito } = monta({ negadas: ["finance.manage"] });

  const r = await call(app, "post", "/payment-gateways/asaas/tokenizacao", {
    body: { ativa: true },
  });

  assert.equal(r.status, 403);
  assert.ok(pedidas.includes("finance.manage"));
  assert.deepEqual(feito.marcadas, []);
});

test("e fica no log: quem marcou, quando, e em que unidade", async () => {
  // É a primeira pergunta no dia em que alguém perguntar por que havia
  // cartão de aluno guardado no gateway.
  const { app } = monta();

  await call(app, "post", "/payment-gateways/asaas/tokenizacao", { body: { ativa: true } });

  const registro = app.registrados.find((r) => r.action === "set_gateway_tokenization");
  assert.equal(registro.data.data.ativa, true);
  assert.equal(registro.data.local.target_id, "asaas");
});
