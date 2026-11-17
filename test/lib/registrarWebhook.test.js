const test = require("node:test");
const assert = require("node:assert/strict");

const Cobrador = require("../../model/Cobrador_model.js");
const asaas = require("../../lib/gateways/asaas.js");

// O AVISO DE PAGAMENTO PRECISA EXISTIR LÁ ANTES DA PRIMEIRA VENDA.
//
// *"eu entrei lá, e não tem o webhook"* (15/10/2026), olhando a tela de
// Webhooks do Asaas depois de configurar a chave.
//
// Ele estava certo, e o defeito era de MOMENTO: o registro só acontecia
// dentro da primeira matrícula com "gerar no gateway". Numa conta que ainda
// não vendeu pela vitrine, não havia o que ver — e quem acabou de colar a
// chave não tinha como saber se a integração estava de pé.
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. O E-MAIL VAI JUNTO. É obrigatório lá, e é para onde o Asaas avisa que a
//    entrega falhou. Sem ele a criação volta 400 — calada, porque isto é
//    melhor esforço.
// 2. O SEGREDO NASCE AQUI. Registrar o webhook com um token vazio é pôr uma
//    tranca sem chave numa porta pública.
// 3. NADA DAQUI ESTOURA. É caminho lateral de uma matrícula que já valeu.

const ORIGINAL = asaas.cobranca.garantirWebhook;

function rede(rotas) {
  const feitos = [];

  const buscar = async (url, opcoes = {}) => {
    const caminho = String(url).replace(/^https:\/\/[^/]+\/v3/, "");
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    feitos.push({ caminho, metodo: opcoes.method || "GET", corpo });

    const r = rotas[`${opcoes.method || "GET"} ${caminho}`] ?? rotas[caminho];
    if (r === undefined) throw new Error("rota não dublada: " + caminho);

    return { ok: (r.status || 200) < 400, status: r.status || 200, async json() { return r.corpo || {}; } };
  };

  return { buscar, feitos };
}

function monta({ credenciais = { tipo: "asaas", chave: "$aact_x", ambiente: "producao", segredo: "s3gr3d0" }, dono = { email: "dono@academia.com" }, buscar } = {}) {
  const marcados = [];

  const c = new Cobrador({
    api: {
      paymentGateway: {
        async paraRegistrarWebhook() {
          return credenciais;
        },
        async marcarWebhook(tipo, unidade) {
          marcados.push({ tipo, unidade });
        },
      },
      tenant: { async ownerId() { return dono ? "u1" : null; } },
      user: { async data() { return dono; } },
    },
  });

  // A rede entra por aqui: `garantirWebhook` aceita um `buscar` injetado, e é
  // assim que o resto da casa testa o Asaas sem sair da máquina. Quem chama é
  // o modelo, então a injeção tem de ser por fora.
  //
  // Sempre a partir do ORIGINAL guardado no carregamento: embrulhar o que já
  // estiver lá empilharia um `buscar` velho por cima do novo, e o segundo
  // teste responderia com a rede do primeiro.
  if (buscar) {
    asaas.cobranca.garantirWebhook = (args) => ORIGINAL({ ...args, buscar });
    test.after(() => { asaas.cobranca.garantirWebhook = ORIGINAL; });
  }

  return { c, marcados };
}

test("o registro manda o e-mail do dono — sem ele o Asaas recusa a criação", async () => {
  const r = rede({ "GET /webhooks": { corpo: { data: [] } }, "POST /webhooks": { corpo: { id: "w1" } } });
  const { c, marcados } = monta({ buscar: r.buscar });

  const saida = await c.registrarWebhook("asaas", "", "marlon");

  assert.equal(saida.ok, true);
  const criado = r.feitos.find((f) => f.metodo === "POST").corpo;
  assert.equal(criado.email, "dono@academia.com");
  assert.equal(criado.authToken, "s3gr3d0");
  assert.match(criado.url, /\/public\/gateway-webhook\/asaas\/marlon$/);
  // A data fica gravada: é ela que a tela mostra para dizer "está de pé".
  assert.deepEqual(marcados, [{ tipo: "asaas", unidade: "" }]);
});

test("a URL leva a UNIDADE quando a conta é de uma filial", async () => {
  const r = rede({ "GET /webhooks": { corpo: { data: [] } }, "POST /webhooks": { corpo: {} } });
  const { c } = monta({ buscar: r.buscar });

  await c.registrarWebhook("asaas", "6a7f8e18ac5f3b34bb4e4b01", "marlon");

  const criado = r.feitos.find((f) => f.metodo === "POST").corpo;
  assert.match(criado.url, /\/asaas\/marlon\/6a7f8e18ac5f3b34bb4e4b01$/);
});

const URL_NOSSA = "https://backend.vafit.app/public/gateway-webhook/asaas/marlon";
const TODOS = asaas.cobranca.EVENTOS;

test("registrar de novo não cria um segundo — a conta é compartilhada com outras integrações", async () => {
  // A conta dele tem quatro webhooks de outro sistema dentro. A idempotência é
  // por URL, e é ela que impede a lista de encher a cada boot.
  const r = rede({
    "GET /webhooks": {
      corpo: {
        data: [
          { id: "w_sprinthub", url: "https://sprinthub/x" },
          { id: "w1", url: URL_NOSSA, events: TODOS, enabled: true, interrupted: false },
        ],
      },
    },
  });
  const { c, marcados } = monta({ buscar: r.buscar });

  const saida = await c.registrarWebhook("asaas", "", "marlon");

  assert.equal(saida.ok, true);
  assert.equal(r.feitos.filter((f) => f.metodo !== "GET").length, 0, "nada a mudar, nada a escrever");
  assert.equal(marcados.length, 1, "já existir também é estar de pé");
});

test("webhook velho, com menos eventos, é ATUALIZADO no lugar", async () => {
  // A lista de eventos que esta casa trata cresce. Sem este caminho, o webhook
  // registrado ontem continuaria surdo para estorno e assinatura cancelada —
  // e nada na tela denunciaria.
  const r = rede({
    "GET /webhooks": {
      corpo: { data: [{ id: "w1", url: URL_NOSSA, events: ["PAYMENT_RECEIVED"], enabled: true }] },
    },
    "PUT /webhooks/w1": { corpo: { id: "w1" } },
  });
  const { c } = monta({ buscar: r.buscar });

  const saida = await c.registrarWebhook("asaas", "", "marlon");

  assert.equal(saida.ok, true);
  assert.equal(saida.atualizado, true);
  // E NÃO um segundo com a mesma URL: o Asaas mandaria cada aviso em dobro.
  assert.equal(r.feitos.filter((f) => f.metodo === "POST").length, 0);

  const enviado = r.feitos.find((f) => f.metodo === "PUT").corpo;
  assert.deepEqual(enviado.events, TODOS);
  assert.equal(enviado.authToken, "s3gr3d0");
});

test("fila INTERROMPIDA lá é religada daqui", async () => {
  // É o pior estado possível: o Asaas para de mandar e fica quieto. Salvar a
  // chave de novo passou a ser o botão de religar.
  const r = rede({
    "GET /webhooks": {
      corpo: { data: [{ id: "w1", url: URL_NOSSA, events: TODOS, enabled: true, interrupted: true }] },
    },
    "PUT /webhooks/w1": { corpo: { id: "w1" } },
  });
  const { c } = monta({ buscar: r.buscar });

  assert.equal((await c.registrarWebhook("asaas", "", "marlon")).ok, true);
  assert.equal(r.feitos.find((f) => f.metodo === "PUT").corpo.interrupted, false);
});

test("sem chave configurada, recusa sem bater na rede", async () => {
  const { c } = monta({ credenciais: null });
  assert.deepEqual(await c.registrarWebhook("asaas", "", "marlon"), {
    ok: false,
    erro: "nao_configurado",
  });
});

test("gateway que não sabe cobrar não tenta registrar nada", async () => {
  const { c } = monta();
  assert.deepEqual(await c.registrarWebhook("pagarme", "", "marlon"), {
    ok: false,
    erro: "gateway_nao_cobra",
  });
});

test("nada aqui estoura — nem quando o modelo nem existe", async () => {
  // Este caminho roda no meio de uma matrícula que já valeu. Uma exceção
  // subindo daqui desfaria, na tela, algo que já aconteceu no banco.
  const c = new Cobrador({ api: {} });
  assert.deepEqual(await c.registrarWebhook("asaas", "", "marlon"), {
    ok: false,
    erro: "fora_do_ar",
  });
});

test("conta sem dono legível ainda registra — o e-mail é um extra, não um bloqueio", async () => {
  const r = rede({ "GET /webhooks": { corpo: { data: [] } }, "POST /webhooks": { corpo: {} } });
  const { c } = monta({ dono: null, buscar: r.buscar });

  assert.equal((await c.registrarWebhook("asaas", "", "marlon")).ok, true);
});

// ── E SAIR DE LÁ QUANDO A CHAVE SAI DAQUI ────────────────────────────────
//
// *"quando eu excluí a chave deveria excluir o webhook lá"* (15/10/2026).
//
// Um webhook órfão não é lixo inofensivo: ele aponta para um endereço que
// agora recusa, leva 401 em cada aviso, e depois de uma sequência deles o
// Asaas PENALIZA a configuração e INTERROMPE a fila — a da conta inteira,
// com as outras integrações dentro.
test("desligar remove o NOSSO webhook, e só o nosso", async () => {
  const r = rede({
    "GET /webhooks": {
      corpo: {
        data: [
          { id: "w_outro", url: "https://sprinthub/x" },
          { id: "w1", url: URL_NOSSA },
        ],
      },
    },
    "DELETE /webhooks/w1": { corpo: { deleted: true } },
  });

  const original = asaas.cobranca.apagarWebhook;
  asaas.cobranca.apagarWebhook = (args) => original({ ...args, buscar: r.buscar });
  test.after(() => { asaas.cobranca.apagarWebhook = original; });

  const { c } = monta();
  const saida = await c.removerWebhook("asaas", "", "marlon");

  assert.equal(saida.ok, true);
  const apagou = r.feitos.filter((f) => f.metodo === "DELETE");
  assert.equal(apagou.length, 1);
  assert.equal(apagou[0].caminho, "/webhooks/w1");
});

test("sem webhook nosso lá, desligar não é erro", async () => {
  const r = rede({ "GET /webhooks": { corpo: { data: [{ id: "w_outro", url: "https://outro/x" }] } } });

  const original = asaas.cobranca.apagarWebhook;
  asaas.cobranca.apagarWebhook = (args) => original({ ...args, buscar: r.buscar });
  test.after(() => { asaas.cobranca.apagarWebhook = original; });

  const { c } = monta();
  assert.deepEqual(await c.removerWebhook("asaas", "", "marlon"), { ok: true, nada: true });
});

test("chave já apagada não vira erro no desligamento", async () => {
  // Desligar duas vezes, ou desligar algo que nunca existiu: nada a remover
  // lá, e nada que deva impedir a linha de sair daqui.
  const { c } = monta({ credenciais: null });
  assert.deepEqual(await c.removerWebhook("asaas", "", "marlon"), { ok: true, nada: true });
});
