const test = require("node:test");
const assert = require("node:assert/strict");

const { ObjectId } = require("mongodb");
const CartaoSalvo = require("../../model/CartaoSalvo_model.js");
const gateways = require("../../lib/gateways");

// O CARTÃO GUARDADO DE UM ALUNO.
//
// *"crie aqui, aba de cartão de crédito para colocar os cartões para pagar as
// faturas que a unidade gerar"* (16/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. O NÚMERO DO CARTÃO NÃO EXISTE DO NOSSO LADO. O que se guarda é o token
//    do gateway, e nem ele volta para a tela.
// 2. O TOKEN É DE UMA CONTA SÓ. Trocada a conta do gateway, o cartão não é
//    encontrado — em vez de ser tentado e recusado na frente do aluno.
// 3. NUNCA COM CARTÕES E SEM PRINCIPAL. É o estado em que a cobrança falha
//    sem nada na tela explicando.

const PESSOA = "6aac6f7fce88864c1d79e021";
const OUTRA = "6aac6f7fce88864c1d79e099";
const PARATY = "6bbc6f7fce88864c1d79e031";

function casa(doc, filtro) {
  return Object.entries(filtro).every(([k, v]) => {
    if (v === null) return doc[k] == null;
    if (v instanceof ObjectId) return String(doc[k]) === String(v);
    if (typeof v === "boolean") return Boolean(doc[k]) === v;
    return String(doc[k]) === String(v);
  });
}

function modelo({ docs = [] } = {}) {
  const chamadas = [];
  const guardados = docs.map((d) => ({ _id: new ObjectId(), ...d }));

  const col = {
    find(filtro, opcoes) {
      chamadas.push({ metodo: "find", filtro, opcoes });
      const achados = guardados.filter((d) => casa(d, filtro));
      return { sort: () => ({ async toArray() { return achados; } }) };
    },
    async findOne(filtro, opcoes) {
      chamadas.push({ metodo: "findOne", filtro, opcoes });
      return guardados.find((d) => casa(d, filtro)) || null;
    },
    async countDocuments(filtro) {
      return guardados.filter((d) => casa(d, filtro)).length;
    },
    async insertOne(doc) {
      chamadas.push({ metodo: "insertOne", doc });
      const _id = new ObjectId();
      guardados.push({ _id, ...doc });
      return { insertedId: _id };
    },
    async updateOne(filtro, mudanca) {
      chamadas.push({ metodo: "updateOne", filtro, mudanca });
      const alvo = guardados.find((d) => casa(d, filtro));
      if (alvo) Object.assign(alvo, mudanca.$set || {});
    },
    async updateMany(filtro, mudanca) {
      chamadas.push({ metodo: "updateMany", filtro, mudanca });
      for (const d of guardados.filter((x) => casa(x, filtro))) Object.assign(d, mudanca.$set || {});
    },
    async deleteOne(filtro) {
      chamadas.push({ metodo: "deleteOne", filtro });
      const i = guardados.findIndex((d) => casa(d, filtro));
      if (i >= 0) guardados.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
    async deleteMany(filtro) {
      chamadas.push({ metodo: "deleteMany", filtro });
      const fora = guardados.filter((d) => casa(d, filtro));
      for (const d of fora) guardados.splice(guardados.indexOf(d), 1);
      return { deletedCount: fora.length };
    },
  };

  const m = new CartaoSalvo({
    mongodb: { async connectToServer() { return { collection: () => col }; } },
  });
  return { m, chamadas, guardados };
}

test("o que se guarda é o TOKEN — o número do cartão não chega até aqui", async () => {
  const { m, guardados } = modelo();

  await m.guardar(PESSOA, {
    tipo: "asaas",
    cliente: "cus_1",
    token: "tok_abc",
    bandeira: "MASTERCARD",
    fim: "8829",
    titular: "MARLON L SERRA",
    validade: "05/29",
  });

  const gravado = guardados[0];
  assert.equal(gravado.token, "tok_abc");
  assert.equal(gravado.fim, "8829");
  // Nenhum campo com cara de número de cartão ou CVV. O teste é bobo de
  // propósito: ele existe para falhar no dia em que alguém "só guardar para
  // conferir depois".
  assert.deepEqual(
    Object.keys(gravado).filter((k) => /numero|number|cvv|ccv/i.test(k)),
    []
  );
});

test("e o token não volta para a tela, nem na lista", async () => {
  const { m, chamadas } = modelo({
    docs: [{ user: new ObjectId(PESSOA), token: "tok_abc", fim: "8829", principal: true }],
  });

  const linhas = await m.lista(PESSOA);

  assert.equal(linhas[0].token, undefined);
  assert.equal(linhas[0].fim, "8829");
  // E a projeção corta na ORIGEM: não é só "não mandar", é não passear com a
  // credencial pela memória de uma rota que não precisa dela.
  const find = chamadas.find((c) => c.metodo === "find");
  assert.equal(find.opcoes.projection.token, 0);
  assert.equal(find.opcoes.projection.cliente, 0);
});

test("o PRIMEIRO cartão já nasce principal", async () => {
  // Sem isto, guardar um cartão e esperar que ele pague não funcionaria — e o
  // motivo ("nenhum está marcado") seria invisível na tela.
  const { m, guardados } = modelo();

  await m.guardar(PESSOA, { token: "tok_1" });
  assert.equal(guardados[0].principal, true);

  await m.guardar(PESSOA, { token: "tok_2" });
  assert.equal(guardados[1].principal, false);
});

test("o mesmo cartão duas vezes não vira duas linhas", async () => {
  const { m, guardados } = modelo({
    docs: [{ user: new ObjectId(PESSOA), token: "tok_1", fim: "8829" }],
  });

  const r = await m.guardar(PESSOA, { token: "tok_1", fim: "8829" });

  assert.equal(r.repetido, true);
  assert.equal(guardados.length, 1);
});

test("escolher o principal desliga o anterior", async () => {
  const { m, guardados } = modelo({
    docs: [
      { user: new ObjectId(PESSOA), token: "tok_1", principal: true },
      { user: new ObjectId(PESSOA), token: "tok_2", principal: false },
    ],
  });

  await m.principal(PESSOA, String(guardados[1]._id));

  assert.equal(guardados[0].principal, false);
  assert.equal(guardados[1].principal, true);
});

test("o cartão de OUTRA pessoa não pode ser promovido pela minha rota", async () => {
  const { m, guardados } = modelo({
    docs: [{ user: new ObjectId(OUTRA), token: "tok_x", principal: false }],
  });

  assert.deepEqual(await m.principal(PESSOA, String(guardados[0]._id)), {
    erro: "nao_encontrado",
  });
  assert.equal(guardados[0].principal, false);
});

test("remover APAGA a linha com o token dentro", async () => {
  const { m, guardados } = modelo({
    docs: [{ user: new ObjectId(PESSOA), token: "tok_1", principal: true }],
  });

  await m.remover(PESSOA, String(guardados[0]._id));
  assert.equal(guardados.length, 0);
});

test("e remover o principal promove o que sobrou — nunca com cartões e sem principal", async () => {
  const { m, guardados } = modelo({
    docs: [
      { user: new ObjectId(PESSOA), token: "tok_1", principal: true, criadoEm: new Date(1) },
      { user: new ObjectId(PESSOA), token: "tok_2", principal: false, criadoEm: new Date(2) },
    ],
  });

  await m.remover(PESSOA, String(guardados[0]._id));

  assert.equal(guardados.length, 1);
  assert.equal(guardados[0].principal, true);
});

test("quem vai cobrar recebe o token do principal DAQUELA conta", async () => {
  const { m } = modelo({
    docs: [
      {
        user: new ObjectId(PESSOA),
        tipo: "asaas",
        unit: null,
        token: "tok_casa",
        cliente: "cus_1",
        principal: true,
      },
    ],
  });

  const achado = await m.paraCobrar(PESSOA, { tipo: "asaas", unidade: "" });
  assert.equal(achado.token, "tok_casa");
});

test("cartão de outra CONTA não é encontrado — recusa na fatura é pior que ausência", async () => {
  // Um token do Asaas vale para um cliente de uma conta. Se a filial passar a
  // ter gateway próprio, o token da casa não serve — e tentá-lo faria o aluno
  // ver "cartão recusado", que ele leria como problema do cartão dele.
  const { m } = modelo({
    docs: [
      { user: new ObjectId(PESSOA), tipo: "asaas", unit: null, token: "tok_casa", principal: true },
    ],
  });

  assert.equal(await m.paraCobrar(PESSOA, { tipo: "asaas", unidade: PARATY }), null);
  assert.equal(await m.paraCobrar(PESSOA, { tipo: "pagarme", unidade: "" }), null);
});

// ── ESCOLHER QUAL CARTÃO COBRA ───────────────────────────────────────────
//
// *"aí aparece para escolher o cartão de crédito"* (19/10/2026). Antes disso
// só o principal cobrava, e quem tinha dois não tinha como dizer qual.
test("com `id`, cobra NAQUELE cartão — e não no principal", async () => {
  const { m } = modelo({
    docs: [
      { user: new ObjectId(PESSOA), tipo: "asaas", unit: null, token: "tok_principal", principal: true },
      { user: new ObjectId(PESSOA), tipo: "asaas", unit: null, token: "tok_outro", principal: false },
    ],
  });

  const todos = await m.lista(PESSOA);
  const outro = todos.find((c) => !c.principal);

  const achado = await m.paraCobrar(PESSOA, { tipo: "asaas", unidade: "", id: outro._id });
  assert.equal(achado.token, "tok_outro");
});

test("o id de OUTRA pessoa não acha nada — o trio vale mesmo com id na mão", async () => {
  // O que chega do navegador nunca é o bastante para dizer qual token usar:
  // sem isto, um id copiado cobraria o cartão de quem não está na tela.
  const { m } = modelo({
    docs: [{ user: new ObjectId(OUTRA), tipo: "asaas", unit: null, token: "tok_dela", principal: true }],
  });

  const dela = (await m.lista(OUTRA))[0];
  assert.equal(await m.paraCobrar(PESSOA, { tipo: "asaas", unidade: "", id: dela._id }), null);
  // E id torto é ausência, não "qualquer um": sem isto ele cairia no
  // principal e cobraria um cartão que ninguém escolheu.
  assert.equal(await m.paraCobrar(PESSOA, { tipo: "asaas", unidade: "", id: "nao-e-id" }), null);
});

test("apagar a pessoa apaga os tokens dela", async () => {
  const { m, guardados } = modelo({
    docs: [
      { user: new ObjectId(PESSOA), token: "tok_1" },
      { user: new ObjectId(OUTRA), token: "tok_2" },
    ],
  });

  assert.equal(await m.apagarDaPessoa(PESSOA), 1);
  assert.equal(guardados.length, 1);
  // E sem pessoa não apaga NADA: um `deleteMany({user: null})` distraído
  // levaria junto os cartões de todo mundo.
  assert.equal(await m.apagarDaPessoa(""), 0);
});

// ── A TOKENIZAÇÃO NO ASAAS ────────────────────────────────────────────────

const asaas = gateways.de("asaas");

const respondendo = (porUrl) => async (url, opcoes) => {
  const r = porUrl(String(url), opcoes);
  if (r instanceof Error) throw r;
  return {
    ok: (r.status || 200) < 400,
    status: r.status || 200,
    async json() {
      return r.corpo || {};
    },
  };
};

test("tokenizar manda o cartão e devolve só token, bandeira e os quatro últimos", async () => {
  let enviado = null;

  const r = await asaas.cobranca.tokenizarCartao({
    chave: "$aact_x",
    ambiente: "producao",
    cliente: "cus_1",
    cartao: { numero: "5162 3062 1937 8829", titular: "MARLON SERRA", mes: "5", ano: "29", cvv: "318" },
    titular: { nome: "Marlon", email: "m@x.com", documento: "153.000.000-00", cep: "24220-000", numero: "10", telefone: "(21) 97168-5171" },
    ip: "200.1.2.3",
    buscar: respondendo((url, opcoes) => {
      enviado = JSON.parse(opcoes.body);
      return {
        corpo: {
          creditCardNumber: "8829",
          creditCardBrand: "MASTERCARD",
          creditCardToken: "tok_abc",
        },
      };
    }),
  });

  assert.deepEqual(r.cartao, { token: "tok_abc", bandeira: "MASTERCARD", fim: "8829" });

  // O que foi MANDADO: só dígitos, mês com dois e ano com QUATRO — "29"
  // entendido como ano 29 venceria o cartão em 1929.
  assert.equal(enviado.creditCard.number, "5162306219378829");
  assert.equal(enviado.creditCard.expiryMonth, "05");
  assert.equal(enviado.creditCard.expiryYear, "2029");
  assert.equal(enviado.creditCardHolderInfo.cpfCnpj, "15300000000");
  assert.equal(enviado.creditCardHolderInfo.postalCode, "24220000");
  // O IP de quem digitou, e não o do servidor: é o que vai para a análise de
  // risco deles, e um IP só para a casa inteira é o padrão que antifraude
  // existe para marcar.
  assert.equal(enviado.remoteIp, "200.1.2.3");
});

test("a recusa do Asaas volta com a frase DELE", async () => {
  const r = await asaas.cobranca.tokenizarCartao({
    chave: "$aact_x",
    ambiente: "producao",
    cliente: "cus_1",
    cartao: { numero: "1", titular: "X", mes: "1", ano: "2029", cvv: "1" },
    titular: {},
    buscar: respondendo(() => ({
      status: 400,
      corpo: { errors: [{ description: "Tokenização não habilitada para esta conta" }] },
    })),
  });

  assert.equal(r.ok, false);
  assert.equal(r.detalhe, "Tokenização não habilitada para esta conta");
});

test("com cartão guardado, a assinatura nasce NO CARTÃO", async () => {
  // Sem isto o token ficaria guardado sem nunca cobrar nada: o Asaas só
  // debita sozinho o que nasce como CREDIT_CARD com token.
  let enviado = null;

  await asaas.cobranca.assinatura({
    chave: "$aact_x",
    ambiente: "producao",
    cliente: "cus_1",
    plano: { cadencia: "monthly", amount: 2000, name: "Plano Fit", formasDePagamento: ["pix"] },
    recorrencia: "r1",
    cartao: "tok_abc",
    buscar: respondendo((url, opcoes) => {
      enviado = JSON.parse(opcoes.body);
      return { corpo: { id: "sub_1" } };
    }),
  });

  assert.equal(enviado.creditCardToken, "tok_abc");
  // O token MANDA no billingType: o plano só aceitava pix, e abrir uma fatura
  // "escolha como pagar" faria o cartão guardado não pagar nada.
  assert.equal(enviado.billingType, "CREDIT_CARD");
});

test("sem cartão, nada muda — a fatura sai como saía ontem", async () => {
  let enviado = null;

  await asaas.cobranca.assinatura({
    chave: "$aact_x",
    ambiente: "producao",
    cliente: "cus_1",
    plano: { cadencia: "monthly", amount: 2000, name: "Plano Fit", formasDePagamento: ["pix"] },
    recorrencia: "r1",
    buscar: respondendo((url, opcoes) => {
      enviado = JSON.parse(opcoes.body);
      return { corpo: { id: "sub_1" } };
    }),
  });

  assert.equal(enviado.creditCardToken, undefined);
  assert.equal(enviado.billingType, "PIX");
});

test("o titular viaja inteiro, e o celular no campo dele", async () => {
  // *"peça todos esses dados para cadastrar o cartão"* (17/10/2026): o
  // `creditCardHolderInfo` da tokenização pede nome, e-mail, CPF, telefone,
  // CEP e número — todos obrigatórios —, e aceita complemento e celular.
  let enviado = null;

  await asaas.cobranca.tokenizarCartao({
    chave: "$aact_x",
    ambiente: "producao",
    cliente: "cus_1",
    cartao: { numero: "5162306219378829", titular: "MARLON SERRA", mes: "5", ano: "29", cvv: "318" },
    titular: {
      nome: "Paulo Lima",
      email: "pai@x.com",
      documento: "987.654.321-00",
      telefone: "(21) 3456-7890",
      celular: "(21) 99999-8888",
      cep: "01310-100",
      numero: "812",
      complemento: "Apto 51",
    },
    ip: "200.1.2.3",
    buscar: respondendo((url, opcoes) => {
      enviado = JSON.parse(opcoes.body);
      return { corpo: { creditCardToken: "tok_abc", creditCardBrand: "VISA", creditCardNumber: "8829" } };
    }),
  });

  const info = enviado.creditCardHolderInfo;
  assert.equal(info.name, "Paulo Lima");
  assert.equal(info.email, "pai@x.com");
  assert.equal(info.cpfCnpj, "98765432100");
  assert.equal(info.postalCode, "01310100");
  assert.equal(info.addressNumber, "812");
  assert.equal(info.addressComplement, "Apto 51");
  // Dois campos, dois números. A primeira versão mandava o fixo nos dois —
  // dado repetido é pior para a análise de risco do que campo vazio.
  assert.equal(info.phone, "2134567890");
  assert.equal(info.mobilePhone, "21999998888");
});

test("sem celular, o campo some em vez de repetir o fixo", async () => {
  let enviado = null;

  await asaas.cobranca.tokenizarCartao({
    chave: "$aact_x",
    ambiente: "producao",
    cliente: "cus_1",
    cartao: { numero: "5162306219378829", titular: "X", mes: "5", ano: "29", cvv: "318" },
    titular: { nome: "Marlon", email: "m@x.com", documento: "15300000000", telefone: "2134567890", cep: "24220000", numero: "10" },
    buscar: respondendo((url, opcoes) => {
      enviado = JSON.parse(opcoes.body);
      return { corpo: { creditCardToken: "tok_abc" } };
    }),
  });

  assert.equal(enviado.creditCardHolderInfo.phone, "2134567890");
  assert.equal(enviado.creditCardHolderInfo.mobilePhone, undefined);
});
