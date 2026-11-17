const test = require("node:test");
const assert = require("node:assert/strict");

const gateways = require("../../lib/gateways");
const cartaoDoAluno = require("../../lib/cartaoDoAluno.js");
const { emitirAvulsa } = require("../../lib/faturaNoGateway.js");

// COBRAR UMA FATURA NUM CARTÃO — o botão "Cobrar" da linha.
//
// *"se for cartão ou qualquer forma, mostre um botão cobrar; aí aparece para
// escolher o cartão de crédito, pagar, ou colocar os dados do cartão na hora;
// e se for por na hora, mostre o checkbox 'salvar para futuros pagamentos'"*
// (19/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ────────────────────────────────────────────
//
// 1. O NÚMERO NÃO VIAJA À TOA. Dados tortos reprovam ANTES de qualquer rede —
//    inclusive antes de procurar o cliente no gateway.
// 2. A CAIXA MANDA. Desmarcada, o token não fica aqui: o cartão pagou esta
//    fatura e some da nossa vista.
// 3. O DINHEIRO NÃO SE PERDE POR CAUSA DO GUARDAR. Ele roda DEPOIS do débito,
//    e um tropeço dele não pode derrubar a fatura que já existe lá.
// 4. QUEM NÃO PODE TOKENIZAR não recebe um formulário que só sabe recusar.

const PESSOA = {
  _id: "6aac6f7fce88864c1d79e021",
  name: "Marlon",
  email: "m@x.com",
  phone: "21971685171",
  unit: "",
  customFields: { cpf: "15300000000", cep: "24220000", numero: "10" },
};

const CARTAO = {
  numero: "5162 3062 1937 8829",
  titular: "MARLON LIMA",
  mes: "5",
  ano: "2029",
  cvv: "318",
};

const COBRANCA = { _id: "c1", amount: 5000, dueDate: "2026-11-19", description: "Plano Fit" };

function monta({
  credenciais = { tipo: "asaas", unidade: "", chave: "$aact_x", ambiente: "producao", tokenizacao: true },
  guardados = {},
  tokenizar,
  guardarErro = null,
} = {}) {
  const feito = { tokenizados: [], guardados: [], avulsas: [], procurados: [] };

  const asaas = gateways.de("asaas");
  const original = {
    cliente: asaas.cobranca.cliente,
    tokenizarCartao: asaas.cobranca.tokenizarCartao,
    avulsa: asaas.cobranca.avulsa,
  };

  asaas.cobranca.cliente = async () => ({ ok: true, id: "cus_1" });
  asaas.cobranca.tokenizarCartao = async (args) => {
    feito.tokenizados.push(args);
    return tokenizar
      ? tokenizar(args)
      : { ok: true, cartao: { token: "tok_novo", bandeira: "MASTERCARD", fim: "8829" } };
  };
  asaas.cobranca.avulsa = async (args) => {
    feito.avulsas.push(args);
    return { ok: true, id: "pay_1", link: "https://asaas/i/1" };
  };

  const app = {
    api: {
      paymentGateway: { async ativo() { return credenciais; } },
      cartaoSalvo: {
        async paraCobrar(pessoa, filtro) {
          feito.procurados.push({ pessoa: String(pessoa), filtro });
          return guardados[filtro.id || "principal"] || null;
        },
        async guardar(pessoa, dados, quem) {
          if (guardarErro) throw new Error(guardarErro);
          feito.guardados.push({ pessoa, dados, quem });
          return { ok: true, id: "c9" };
        },
      },
    },
  };

  return { app, feito, restaurar: () => Object.assign(asaas.cobranca, original) };
}

// ── O CARTÃO GUARDADO ────────────────────────────────────────────────────

test("com um id, cobra NAQUELE cartão — e o trio vai junto", async () => {
  const { app, feito, restaurar } = monta({ guardados: { c2: { token: "tok_dois" } } });
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA, { cartao: "c2" });

    assert.equal(r.ok, true);
    assert.equal(r.noCartao, true);
    assert.equal(feito.avulsas[0].cartao, "tok_dois");
    // A unidade é a DA CONTA, e o tipo também: um token nasceu para um
    // cliente de uma conta, e procurar sem isso acharia o cartão errado.
    assert.deepEqual(feito.procurados[0].filtro, { tipo: "asaas", unidade: "", id: "c2" });
  } finally {
    restaurar();
  }
});

test("`true` continua querendo dizer 'o principal'", async () => {
  const { app, feito, restaurar } = monta({ guardados: { principal: { token: "tok_p" } } });
  try {
    await emitirAvulsa(app, PESSOA, COBRANCA, { cartao: true });
    assert.equal(feito.procurados[0].filtro.id, "");
    assert.equal(feito.avulsas[0].cartao, "tok_p");
  } finally {
    restaurar();
  }
});

test("cartão guardado que não existe RECUSA — não cai num boleto", async () => {
  // Quem pediu o débito não quer um link de pagamento no lugar: ele ficaria
  // esperando um dinheiro que ninguém mandou cobrar.
  const { app, feito, restaurar } = monta();
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA, { cartao: "c9" });
    assert.deepEqual(r, { ok: false, erro: "sem_cartao" });
    assert.equal(feito.avulsas.length, 0);
  } finally {
    restaurar();
  }
});

// ── O CARTÃO DIGITADO NA HORA ────────────────────────────────────────────

test("o cartão digitado é tokenizado e debita a fatura", async () => {
  const { app, feito, restaurar } = monta();
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA, { cartaoNovo: CARTAO, ip: "1.2.3.4" });

    assert.equal(r.ok, true);
    assert.equal(r.noCartao, true);
    assert.equal(feito.avulsas[0].cartao, "tok_novo");
    // O IP de quem digitou vai para a análise de risco deles — o do servidor
    // seria sempre o mesmo, e não diz nada.
    assert.equal(feito.tokenizados[0].ip, "1.2.3.4");
    // E o cliente é o MESMO da fatura: token de um cliente não cobra noutro.
    assert.equal(feito.tokenizados[0].cliente, "cus_1");
  } finally {
    restaurar();
  }
});

test("sem a caixa marcada, o token NÃO fica guardado aqui", async () => {
  // *"se for por na hora, mostre o checkbox 'salvar para futuros
  // pagamentos'"*. Desmarcada quer dizer desmarcada: o cartão de quem pagou
  // uma vez no balcão não vira cobrança automática de amanhã.
  const { app, feito, restaurar } = monta();
  try {
    await emitirAvulsa(app, PESSOA, COBRANCA, { cartaoNovo: CARTAO });
    assert.deepEqual(feito.guardados, []);
  } finally {
    restaurar();
  }
});

test("com a caixa marcada, guarda o token — e só o que identifica o cartão", async () => {
  const { app, feito, restaurar } = monta();
  try {
    await emitirAvulsa(app, PESSOA, COBRANCA, { cartaoNovo: CARTAO, salvar: true, porQuem: "u1" });

    assert.equal(feito.guardados.length, 1);
    const { dados } = feito.guardados[0];
    assert.equal(dados.token, "tok_novo");
    assert.equal(dados.fim, "8829");
    assert.equal(dados.validade, "05/29");
    // O NÚMERO e o CVV não existem do nosso lado. Esta asserção é o que
    // pega o dia em que alguém "só acrescentar um campo para conferência".
    assert.equal(JSON.stringify(dados).includes("5162"), false);
    assert.equal(JSON.stringify(dados).includes("318"), false);
  } finally {
    restaurar();
  }
});

test("guardar que falha NÃO derruba a cobrança — o dinheiro já saiu", async () => {
  // Esta linha roda DEPOIS do débito. Estourar aqui perderia de vista a
  // fatura que já existe lá, e ela não some por causa do nosso erro.
  const { app, restaurar } = monta({ guardarErro: "banco fora" });
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA, { cartaoNovo: CARTAO, salvar: true });
    assert.equal(r.ok, true);
  } finally {
    restaurar();
  }
});

test("dados tortos reprovam ANTES de qualquer rede", async () => {
  // O CEP com onze dígitos é o caso real: sem isto, o número do cartão viaja
  // numa requisição que já se sabe perdida.
  const { app, feito, restaurar } = monta();
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA, {
      cartaoNovo: { ...CARTAO, cep: "15383436731", numeroEndereco: "812" },
    });

    assert.deepEqual(r, { ok: false, erro: "cep_invalido" });
    assert.deepEqual(feito.tokenizados, []);
    assert.deepEqual(feito.avulsas, []);
  } finally {
    restaurar();
  }
});

test("sem a tokenização liberada na conta, recusa com o motivo", async () => {
  // Ela é pedida ao suporte do gateway, não é caixa que a gente marca. Dizer
  // qual das coisas falta é o que separa "peça a liberação" de "tente de
  // novo".
  const { app, feito, restaurar } = monta({
    credenciais: { tipo: "asaas", unidade: "", chave: "$aact_x", ambiente: "producao", tokenizacao: false },
  });
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA, { cartaoNovo: CARTAO });
    assert.deepEqual(r, { ok: false, erro: "sem_tokenizacao" });
    assert.deepEqual(feito.tokenizados, []);
  } finally {
    restaurar();
  }
});

test("a recusa da operadora sobe com o DETALHE dela", async () => {
  const { app, restaurar } = monta({
    tokenizar: async () => ({ ok: false, erro: "recusado", detalhe: "Cartão recusado pela operadora" }),
  });
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA, { cartaoNovo: CARTAO });
    assert.equal(r.ok, false);
    assert.equal(r.detalhe, "Cartão recusado pela operadora");
  } finally {
    restaurar();
  }
});

// ── SEM CARTÃO NENHUM ────────────────────────────────────────────────────

test("sem cartão, a fatura abre como sempre", async () => {
  const { app, feito, restaurar } = monta();
  try {
    const r = await emitirAvulsa(app, PESSOA, COBRANCA);
    assert.equal(r.ok, true);
    assert.equal(r.noCartao, false);
    assert.equal(feito.avulsas[0].cartao, "");
    assert.deepEqual(feito.tokenizados, []);
  } finally {
    restaurar();
  }
});

// ── A CONFERÊNCIA, SOZINHA ───────────────────────────────────────────────

test("conferir completa o titular com a ficha e devolve a validade de dois dígitos", () => {
  const r = cartaoDoAluno.conferir(PESSOA, CARTAO);
  assert.equal(r.ok, true);
  assert.equal(r.titular.documento, "15300000000");
  assert.equal(r.titular.cep, "24220000");
  // O que o formulário manda vence o da ficha: quem paga pode não ser o aluno.
  const outro = cartaoDoAluno.conferir(PESSOA, { ...CARTAO, email: "pai@x.com" });
  assert.equal(outro.titular.email, "pai@x.com");
});
