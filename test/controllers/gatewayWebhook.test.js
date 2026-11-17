const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const GatewayWebhook = require("../../controllers/GatewayWebhook.js");

// O AVISO DE PAGAMENTO QUE CHEGA DO GATEWAY.
//
//   POST /public/gateway-webhook/:tipo/:instancia
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. A PORTA É PÚBLICA. Sem conferência de segredo, qualquer um que descubra o
//    endereço manda `PAYMENT_RECEIVED` e marca a mensalidade de quem quiser
//    como paga — e a academia só descobre fechando o mês.
// 2. O SEGREDO É POR CLIENTE. Vazar o de uma academia não pode abrir a porta
//    da outra, porque a conta do gateway é de cada uma.
// 3. 200 QUER DIZER "NÃO MANDE DE NOVO". O Asaas reenvia o que não deu 2xx, e
//    com `sendType: SEQUENTIALLY` ele PARA A FILA daquela conta enquanto
//    insiste. Um aviso que não casa com nada aqui não vai melhorar na terceira
//    tentativa.
const SEGREDO = "a".repeat(48);

function monta({ credenciais = { segredo: SEGREDO }, instanciaExiste = true, aplicar } = {}) {
  const aplicados = [];
  const diario = [];

  const app = fakeApp({
    api: {
      center: { async byInstance() { return instanciaExiste ? { instance: "marlon" } : null; } },
      paymentGateway: { async credenciais() { return credenciais; } },
      cobrador: {
        async aplicarAviso(tipo, corpo) {
          aplicados.push({ tipo, corpo });
          if (aplicar) return aplicar();
          return { ok: true, feito: "quitada" };
        },
      },
      // O DIÁRIO (19/10/2026). Ele é o que responde "chegou? foi aceito?
      // casou com alguma cobrança?" quando o dinheiro não aparece na ficha.
      avisoDoGateway: {
        async registrar(dados) {
          diario.push(dados);
          return true;
        },
      },
    },
  });

  GatewayWebhook(app);
  return { app, aplicados, diario };
}

const AVISO = { event: "PAYMENT_RECEIVED", payment: { subscription: "sub_1" } };

const bate = (app, { token, tipo = "asaas" } = {}) =>
  call(app, "post", `/public/gateway-webhook/${tipo}/marlon`, {
    body: AVISO,
    headers: token === undefined ? {} : { "asaas-access-token": token },
  });

test("com o segredo certo, o aviso é aplicado", async () => {
  const { app, aplicados } = monta();

  const r = await bate(app, { token: SEGREDO });

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, feito: "quitada" });
  assert.equal(aplicados[0].tipo, "asaas");
});

test("SEM segredo não entra — e o cobrador nem é chamado", async () => {
  const { app, aplicados } = monta();

  const r = await bate(app);

  assert.equal(r.status, 401);
  assert.equal(aplicados.length, 0, "nada pode acontecer antes da conferência");
});

test("segredo errado do mesmo TAMANHO também não entra", async () => {
  // A comparação é de tempo fixo; este caso prova que ela de fato compara o
  // conteúdo, e não só o comprimento.
  const { app, aplicados } = monta();

  assert.equal((await bate(app, { token: "b".repeat(48) })).status, 401);
  assert.equal(aplicados.length, 0);
});

test("gateway desligado depois de o webhook ter sido registrado lá: 401, não 500", async () => {
  // Sem credencial não há o que conferir. Insistir não resolve, mas aqui o 401
  // é honesto: o endereço existe e aquele token não vale mais.
  const { app } = monta({ credenciais: null });
  assert.equal((await bate(app, { token: SEGREDO })).status, 401);
});

test("instância que não existe é 404, antes de qualquer consulta", async () => {
  const { app, aplicados } = monta({ instanciaExiste: false });

  assert.equal((await bate(app, { token: SEGREDO })).status, 404);
  assert.equal(aplicados.length, 0);
});

test("gateway que não sabe cobrar é 404 — o Pagar.me não tem webhook aqui", async () => {
  const { app } = monta();
  assert.equal((await bate(app, { token: SEGREDO, tipo: "pagarme" })).status, 404);
});

test("tipo inventado na URL não escolhe código nenhum", async () => {
  // É o que impede `GATEWAYS[req.params.tipo]` — um parâmetro da URL decidindo
  // o que roda.
  const { app } = monta();
  assert.equal((await bate(app, { token: SEGREDO, tipo: "constructor" })).status, 404);
});

test("aviso sem dono responde 200 — senão a fila do Asaas trava inteira", async () => {
  const { app } = monta({ aplicar: () => ({ ok: true, feito: "sem_dono" }) });

  const r = await bate(app, { token: SEGREDO });

  assert.equal(r.status, 200);
  assert.equal(r.body.feito, "sem_dono");
});

test("defeito NOSSO responde 500 — a reentrega é a segunda chance", async () => {
  // `quitarCobranca` é idempotente, então a segunda passada é segura.
  const { app } = monta({
    aplicar: () => {
      throw new Error("mongo caiu");
    },
  });

  assert.equal((await bate(app, { token: SEGREDO })).status, 500);
});

// ── O DIÁRIO DOS AVISOS (19/10/2026) ────────────────────────────────────
//
// *"crie uma aba chamada depuração, e coloque 'log asaas' para a gente poder
// ver o que chegou, se foi processado ou não"*.
//
// O webhook é a única parte desta integração que acontece sem ninguém
// olhando. Quando o dinheiro não aparece na ficha, as perguntas são três —
// chegou? foi aceito? casou com alguma cobrança? — e cada uma aponta para um
// conserto diferente.
test("o aviso aplicado vira linha no diário", async () => {
  const { app, diario } = monta();

  await bate(app, { token: SEGREDO });

  assert.equal(diario.length, 1);
  assert.equal(diario[0].estado, "aplicado");
  assert.equal(diario[0].feito, "quitada");
  assert.equal(diario[0].http, 200);
  // O CORPO inteiro, que é o que se lê para entender o que o Asaas mandou.
  assert.deepEqual(diario[0].corpo, AVISO);
});

test("o RECUSADO também vira linha — e é a mais importante", async () => {
  // "Chegou e foi recusado" e "não chegou" pedem consertos opostos, e do lado
  // de fora os dois são o mesmo silêncio.
  const { app, diario } = monta();

  await bate(app, { token: "b".repeat(48) });

  assert.equal(diario[0].estado, "recusado");
  assert.equal(diario[0].http, 401);
  assert.equal(diario[0].erro, "token_nao_confere");
});

test("gateway sem chave diz ISSO, e não 'token errado'", async () => {
  // São dois consertos: um é salvar a chave, o outro é salvar a chave DE
  // NOVO. Confundi-los manda procurar no lugar errado.
  const { app, diario } = monta({ credenciais: null });

  await bate(app, { token: SEGREDO });

  assert.equal(diario[0].estado, "recusado");
  assert.equal(diario[0].erro, "gateway_sem_chave");
});

test("aviso SEM DONO entra como ignorado, não como aplicado", async () => {
  // É o caso de que ninguém desconfia sozinho: o aviso chegou inteiro, o
  // token conferiu, e não havia cobrança nenhuma deste lado.
  const { app, diario } = monta({ aplicar: () => ({ ok: true, feito: "sem_cobranca" }) });

  await bate(app, { token: SEGREDO });

  assert.equal(diario[0].estado, "ignorado");
  assert.equal(diario[0].feito, "sem_cobranca");
});

test("defeito nosso entra como erro, com a mensagem", async () => {
  const { app, diario } = monta({
    aplicar: () => {
      throw new Error("mongo caiu");
    },
  });

  const r = await bate(app, { token: SEGREDO });

  assert.equal(r.status, 500);
  assert.equal(diario[0].estado, "erro");
  assert.match(diario[0].erro, /mongo caiu/);
});

test("o diário NUNCA derruba o aviso — nem quando ele não existe", async () => {
  // Isto roda no caminho que dá baixa em dinheiro. Um erro ao escrever o log
  // virando 500 faria o Asaas reenviar e PARAR A FILA daquela conta.
  const { app } = monta();
  app.api.avisoDoGateway = undefined;

  const r = await bate(app, { token: SEGREDO });

  assert.equal(r.status, 200);
});
