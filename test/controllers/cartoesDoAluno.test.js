const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call, permiteTudo } = require("../helpers/harness.js");
const controlador = require("../../controllers/CartoesDoAluno.js");

// AS ROTAS DOS CARTÕES DE UM ALUNO — a aba "Cartões" do Financeiro dele.
//
// *"crie aqui, aba de cartão de crédito para colocar os cartões para pagar as
// faturas que a unidade gerar"* (16/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. O NÚMERO DO CARTÃO NÃO FICA. Ele atravessa para o gateway e não vai para
//    o banco nem para o histórico de ações — que é lido por gente, e
//    exportado.
// 2. A CONTA PRECISA PODER. Sem gateway, sem tokenização liberada ou sem CPF,
//    a recusa diz QUAL das três é — "não deu" mandaria procurar no escuro.
// 3. O CARTÃO NASCE NA CONTA QUE VAI COBRAR: a unidade gravada é a do
//    GATEWAY, não a do aluno.

const USUARIO = { _id: "u1", name: "Marlon", permissions: ["finance.manage"] };
const PESSOA = "6aac6f7fce88864c1d79e021";
const PARATY = "6bbc6f7fce88864c1d79e031";

function monta({
  negadas = [],
  pessoa = { _id: PESSOA, name: "Marlon Lima", email: "m@x.com", phone: "21971685171", unit: PARATY, customFields: { cpf: "15300000000", cep: "24220000", numero: "10" } },
  credenciais = { tipo: "asaas", unidade: "", chave: "$aact_x", ambiente: "producao", tokenizacao: true },
  tokenizar,
} = {}) {
  const feito = { guardados: [], clientes: [], tokenizados: [] };
  const { helpers, pedidas } = permiteTudo(USUARIO, negadas);

  // O gateway de verdade é trocado por um duble porque o que se testa aqui é
  // a ORDEM e as recusas do controlador — a conversa com o Asaas tem o teste
  // dela em `test/model/cartaoSalvo.test.js`.
  const gateways = require("../../lib/gateways");
  const asaas = gateways.de("asaas");
  const original = { cliente: asaas.cobranca.cliente, tokenizar: asaas.cobranca.tokenizarCartao };

  asaas.cobranca.cliente = async ({ pessoa: p }) => {
    feito.clientes.push(p);
    return { ok: true, id: "cus_1" };
  };
  asaas.cobranca.tokenizarCartao = async (args) => {
    feito.tokenizados.push(args);
    return tokenizar
      ? tokenizar(args)
      : { ok: true, cartao: { token: "tok_abc", bandeira: "MASTERCARD", fim: "8829" } };
  };

  const app = fakeApp({
    helpers,
    api: {
      user: {
        async collection() {
          return { async findOne() { return pessoa; } };
        },
      },
      paymentGateway: {
        async ativo() {
          return credenciais;
        },
      },
      cartaoSalvo: {
        async lista() {
          return [{ _id: "c1", fim: "8829", principal: true }];
        },
        async guardar(quem, dados) {
          feito.guardados.push({ quem, dados });
          return { ok: true, id: "c1" };
        },
        async principal() {
          return { ok: true };
        },
        async remover() {
          return { ok: true };
        },
      },
    },
  });

  controlador(app);
  return { app, feito, pedidas, restaurar: () => Object.assign(asaas.cobranca, original) };
}

test("a lista diz se dá para guardar, e traz o titular da ficha", async () => {
  const { app, restaurar } = monta();
  try {
    const r = await call(app, "get", `/people/${PESSOA}/cards`);

    assert.equal(r.body.gateway.pronto, true);
    assert.equal(r.body.gateway.nome, "Asaas");
    // O CPF mora em `customFields.cpf` — é campo semeado, e não coluna. A
    // tela não precisa saber disso.
    assert.equal(r.body.titular.documento, "15300000000");
    assert.equal(r.body.rows.length, 1);
  } finally {
    restaurar();
  }
});

test("sem a tokenização liberada, a tela recebe o MOTIVO — e não um 'não deu'", async () => {
  const { app, restaurar } = monta({
    credenciais: { tipo: "asaas", chave: "$aact_x", ambiente: "producao", tokenizacao: false },
  });
  try {
    const r = await call(app, "get", `/people/${PESSOA}/cards`);

    assert.equal(r.body.gateway.pronto, false);
    assert.equal(r.body.gateway.motivo, "sem_tokenizacao");
  } finally {
    restaurar();
  }
});

test("sem gateway ativo nenhum, idem", async () => {
  const { app, restaurar } = monta({ credenciais: null });
  try {
    const r = await call(app, "get", `/people/${PESSOA}/cards`);
    assert.equal(r.body.gateway.motivo, "sem_gateway");
  } finally {
    restaurar();
  }
});

test("guardar tokeniza no gateway e grava a UNIDADE DA CONTA, não a do aluno", async () => {
  // A pessoa é de Paraty, mas o gateway ativo é o da casa (`unidade: ""`): o
  // token vale na conta da casa, e é lá que ele tem de ser procurado depois.
  const { app, feito, restaurar } = monta();
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "MARLON L SERRA", mes: "5", ano: "2029", cvv: "318" },
    });

    assert.equal(r.status, 200);
    const gravado = feito.guardados[0].dados;
    assert.equal(gravado.token, "tok_abc");
    assert.equal(gravado.unidade, "");
    assert.equal(gravado.validade, "05/29");
  } finally {
    restaurar();
  }
});

test("o número do cartão NÃO vai para o histórico de ações", async () => {
  // O histórico é lido por gente e exportado. Lá ficam a bandeira e os quatro
  // últimos, que é o que identifica o cartão sem ser o cartão.
  const { app, restaurar } = monta();
  try {
    await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
    });

    const registro = app.registrados.find((x) => x.action === "save_card");
    const texto = JSON.stringify(registro);
    assert.equal(texto.includes("5162306219378829"), false);
    assert.equal(texto.includes("tok_abc"), false);
    assert.equal(registro.data.data.fim, "8829");
  } finally {
    restaurar();
  }
});

test("sem CPF na ficha e sem CPF no formulário, recusa ANTES da rede", async () => {
  // O Asaas exige o documento do titular. Dizer isto aqui evita a recusa
  // genérica depois de a pessoa ter digitado o cartão inteiro.
  const { app, feito, restaurar } = monta({
    pessoa: { _id: PESSOA, name: "Marlon", email: "", phone: "", unit: null, customFields: {} },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.code, "sem_documento");
    assert.deepEqual(feito.tokenizados, []);
  } finally {
    restaurar();
  }
});

test("dado de cartão faltando não vira ida à rede", async () => {
  const { app, feito, restaurar } = monta();
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029" },
    });

    assert.equal(r.body.code, "dados_incompletos");
    assert.deepEqual(feito.tokenizados, []);
  } finally {
    restaurar();
  }
});

test("a conta sem tokenização recusa o POST também — a tela é um palpite", async () => {
  const { app, feito, restaurar } = monta({
    credenciais: { tipo: "asaas", chave: "$aact_x", ambiente: "producao", tokenizacao: false },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
    });

    assert.equal(r.status, 409);
    assert.equal(r.body.code, "sem_tokenizacao");
    assert.deepEqual(feito.tokenizados, []);
  } finally {
    restaurar();
  }
});

test("a recusa do gateway chega COM a frase dele", async () => {
  const { app, restaurar } = monta({
    tokenizar: () => ({ ok: false, erro: "recusado", detalhe: "Cartão recusado pela operadora" }),
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
    });

    assert.equal(r.status, 400);
    assert.ok(r.body.msg.includes("Cartão recusado pela operadora"), r.body.msg);
  } finally {
    restaurar();
  }
});

test("o IP que vai para a análise de risco é o de quem digitou", async () => {
  const { app, feito, restaurar } = monta();
  try {
    await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
      headers: { "x-forwarded-for": "200.1.2.3, 10.0.0.1" },
    });

    assert.equal(feito.tokenizados[0].ip, "200.1.2.3");
  } finally {
    restaurar();
  }
});

test("quem só LÊ o financeiro vê a lista e não guarda cartão", async () => {
  const { app, feito, restaurar } = monta({ negadas: ["finance.manage"] });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
    });

    assert.equal(r.status, 403);
    assert.deepEqual(feito.guardados, []);
  } finally {
    restaurar();
  }
});

test("pessoa inventada não vira cartão", async () => {
  const { app, restaurar } = monta({ pessoa: null });
  try {
    const r = await call(app, "get", `/people/naoexiste/cards`);
    assert.equal(r.status, 404);
  } finally {
    restaurar();
  }
});

// ── O CPF QUE FOI PARAR NO CAMPO DO CEP ───────────────────────────────────
//
// *"o cpf, não ficou com máscara"* (17/10/2026). As duas telas nasceram com os
// campos do titular sem pontuação nenhuma, e sem ela um campo fica igual ao
// outro. Os onze dígitos de um CPF entraram no CEP e subiram; quem reprovou
// foi o Asaas.
//
// As máscaras consertam a digitação. A conferência mora AQUI porque os dois
// clientes mandam para a mesma porta — e porque uma requisição que já se sabe
// perdida leva um número de cartão junto. Uma viagem a menos do PAN é motivo
// suficiente sozinha.
test("CEP com cara de CPF não chega ao gateway", async () => {
  const { app, feito, restaurar } = monta({
    pessoa: { _id: PESSOA, name: "Marlon", email: "m@x.com", phone: "21971685171", unit: PARATY, customFields: { cpf: "15300000000", numero: "10" } },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: {
        numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318",
        cep: "15383436731", numeroEndereco: "812",
      },
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.code, "cep_invalido");
    assert.deepEqual(feito.tokenizados, []);
    assert.deepEqual(feito.clientes, []);
  } finally {
    restaurar();
  }
});

test("e CPF curto também não", async () => {
  const { app, feito, restaurar } = monta({
    pessoa: { _id: PESSOA, name: "Marlon", email: "m@x.com", phone: "21971685171", unit: PARATY, customFields: {} },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: {
        numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318",
        documento: "1538343", cep: "24220000", numeroEndereco: "812",
      },
    });

    assert.equal(r.body.code, "documento_invalido");
    assert.deepEqual(feito.tokenizados, []);
  } finally {
    restaurar();
  }
});

test("a pontuação da máscara passa — o que conta são os dígitos", async () => {
  // A tela manda "153.834.367-31" e "24220-000", porque é o que está escrito
  // nela. Exigir cru aqui faria a máscara quebrar o envio que ela existe para
  // arrumar.
  const { app, feito, restaurar } = monta({
    pessoa: { _id: PESSOA, name: "Marlon", email: "m@x.com", phone: "21971685171", unit: PARATY, customFields: {} },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: {
        numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318",
        documento: "153.834.367-31", cep: "24220-000", numeroEndereco: "812",
      },
    });

    assert.equal(r.status, 200);
    assert.equal(feito.tokenizados.length, 1);
  } finally {
    restaurar();
  }
});

test("código postal de fora passa inteiro — a regra é de dígito, não de país", async () => {
  // A máscara deixa sair o que tem letra ("SW1A 1AA"); recusar aqui tornaria
  // aquela porta de saída uma mentira.
  const { app, feito, restaurar } = monta({
    pessoa: { _id: PESSOA, name: "Marlon", email: "m@x.com", phone: "21971685171", unit: PARATY, customFields: { cpf: "15300000000", numero: "10" } },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: {
        numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318",
        cep: "SW1A 1AA", numeroEndereco: "812",
      },
    });

    assert.equal(r.status, 200);
    assert.equal(feito.tokenizados.length, 1);
  } finally {
    restaurar();
  }
});

// ── O TITULAR INTEIRO ─────────────────────────────────────────────────────
//
// *"peça todos esses dados para cadastrar o cartão"* (17/10/2026), com a
// página da tokenização do Asaas aberta ao lado. Todos os campos do
// `creditCardHolderInfo` são obrigatórios lá, menos complemento e celular.
test("o titular do formulário MANDA sobre o da ficha", async () => {
  // Quem paga pode não ser o aluno — pai que paga a academia do filho é o
  // caso comum. Deixar a ficha vencer mandaria para a análise de risco o
  // e-mail e o telefone de quem não é dono do cartão.
  const { app, feito, restaurar } = monta();
  try {
    await call(app, "post", `/people/${PESSOA}/cards`, {
      body: {
        numero: "5162306219378829", titular: "PAI DO MARLON", mes: "5", ano: "2029", cvv: "318",
        titularNome: "Paulo Lima", email: "pai@x.com", documento: "98765432100",
        telefone: "(21) 3456-7890", celular: "(21) 99999-8888",
        cep: "01310-100", numeroEndereco: "812", complemento: "Apto 51",
      },
    });

    const { titular } = feito.tokenizados[0];
    assert.equal(titular.nome, "Paulo Lima");
    assert.equal(titular.email, "pai@x.com");
    assert.equal(titular.documento, "98765432100");
    assert.equal(titular.telefone, "(21) 3456-7890");
    assert.equal(titular.complemento, "Apto 51");
    // E o cliente no gateway nasce com o titular, não com o aluno: o token
    // vale para UM cliente, e é esse que a assinatura vai cobrar.
    assert.equal(feito.clientes[0].nome, "Paulo Lima");
  } finally {
    restaurar();
  }
});

test("o celular é campo próprio, e não cópia do fixo", async () => {
  // Mandar o fixo nos dois era o que a primeira versão fazia. Dado repetido
  // é pior para a análise de risco do que campo vazio — e `mobilePhone` é
  // opcional lá justamente por isso.
  const { app, feito, restaurar } = monta();
  try {
    await call(app, "post", `/people/${PESSOA}/cards`, {
      body: {
        numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318",
        telefone: "2134567890", celular: "21999998888",
      },
    });

    const { titular } = feito.tokenizados[0];
    assert.equal(titular.telefone, "2134567890");
    assert.equal(titular.celular, "21999998888");
  } finally {
    restaurar();
  }
});

test("sem telefone do titular, recusa ANTES da rede", async () => {
  // `phone` é obrigatório no `creditCardHolderInfo`. Antes isso só aparecia
  // na recusa do Asaas, genérica, depois do cartão inteiro digitado.
  const { app, feito, restaurar } = monta({
    pessoa: { _id: PESSOA, name: "Marlon", email: "m@x.com", phone: "", unit: PARATY, customFields: { cpf: "15300000000", cep: "24220000", numero: "10" } },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.code, "titular_incompleto");
    assert.deepEqual(feito.tokenizados, []);
  } finally {
    restaurar();
  }
});

test("complemento e celular vazios NÃO travam — são opcionais lá", async () => {
  const { app, feito, restaurar } = monta({
    pessoa: { _id: PESSOA, name: "Marlon", email: "m@x.com", phone: "21971685171", unit: PARATY, customFields: { cpf: "15300000000", cep: "24220000", numero: "10" } },
  });
  try {
    const r = await call(app, "post", `/people/${PESSOA}/cards`, {
      body: { numero: "5162306219378829", titular: "X", mes: "5", ano: "2029", cvv: "318" },
    });

    assert.equal(r.status, 200);
    assert.equal(feito.tokenizados.length, 1);
  } finally {
    restaurar();
  }
});
