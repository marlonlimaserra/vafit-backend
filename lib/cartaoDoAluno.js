const gateways = require("./gateways");

// ── O CARTÃO DE CRÉDITO DE UM ALUNO: tokenizar, guardar, recusar ─────────
//
// Isto morava inteiro em `controllers/CartoesDoAluno.js`, que era o único
// lugar que criava token. Saiu de lá em 19/10/2026 porque nasceu um segundo:
//
//   *"se for cartão ou qualquer forma, mostre um botão cobrar; aí aparece
//   para escolher o cartão de crédito, pagar, ou colocar os dados do cartão
//   na hora"*.
//
// Cobrar com um cartão DIGITADO NA HORA tokeniza pelo mesmo caminho da aba
// Cartão de crédito — e copiar a função para o Financeiro seria manter duas
// conferências do CPF, duas listas de campos obrigatórios do titular e dois
// vocabulários de recusa. A segunda cópia envelheceria, como já aconteceu
// com os formulários de cobrança antes de virarem compartilhados.
//
// ── O QUE ATRAVESSA E O QUE FICA ────────────────────────────────────────
//
// O número e o CVV existem dentro de UMA chamada e morrem com ela: não são
// gravados, não vão para o histórico de ações e não entram em log nenhum —
// nem no de erro, que é onde esse tipo de coisa costuma vazar. O que sobra é
// o token do gateway, a bandeira, os quatro últimos e a validade.

// A pessoa como o gateway pede o titular. O CPF mora em `customFields` — é
// campo semeado, e não coluna. Ver `User_model`.
function titularDe(pessoa) {
  return {
    nome: pessoa?.name || "",
    email: pessoa?.email || "",
    documento: pessoa?.customFields?.cpf || pessoa?.customFields?.cnpj || "",
    telefone: pessoa?.phone || "",
    celular: pessoa?.customFields?.celular || pessoa?.phone || "",
    cep: pessoa?.customFields?.cep || "",
    numero: pessoa?.customFields?.numero || "",
    complemento: pessoa?.customFields?.complemento || "",
  };
}

// ── O ESTADO DO GATEWAY PARA ESTA PESSOA ─────────────────────────────────
//
// Três perguntas, e quem chama precisa das três para dizer a frase certa em
// vez de "não deu": existe gateway ativo? ele sabe guardar cartão? a conta
// tem a função liberada (a caixa de Configurações)?
async function situacao(app, pessoa) {
  const credenciais = await app.api.paymentGateway.ativo(pessoa?.unit ? String(pessoa.unit) : "");
  if (!credenciais) return { pronto: false, motivo: "sem_gateway" };

  const gateway = gateways.de(credenciais.tipo);
  if (!gateway?.cobranca?.tokenizarCartao) {
    return { pronto: false, motivo: "gateway_nao_cobra", nome: gateway?.nome || "" };
  }
  if (!credenciais.tokenizacao) {
    return { pronto: false, motivo: "sem_tokenizacao", nome: gateway.nome, credenciais, gateway };
  }

  return { pronto: true, nome: gateway.nome, credenciais, gateway };
}

// Os obrigatórios do `creditCardHolderInfo` (docs.asaas.com, tokenização).
// `complemento` e `celular` ficam de fora porque lá também são opcionais.
const OBRIGATORIOS = ["nome", "email", "telefone", "cep", "numero"];

const digitos = (v) => String(v || "").replace(/\D/g, "");
const temLetra = (v) => /[a-zA-Z]/.test(String(v || ""));

// ── CONFERIR, ANTES DE QUALQUER REDE ─────────────────────────────────────
//
// Separado de `tokenizar` de propósito, e a ordem importa: quem chama
// confere PRIMEIRO, pede o cliente ao gateway DEPOIS. Um CEP com cara de CPF
// reprovado aqui não deixa para trás um cadastro novo na conta do cliente —
// e, principalmente, não manda o número do cartão numa viagem que já se sabe
// perdida. Uma viagem a menos do PAN é motivo suficiente sozinha.
//
// Devolve `{ok:false, erro}` no nosso vocabulário, nunca o texto cru de lá.
function conferir(pessoa, corpo = {}) {
  const cartao = {
    numero: String(corpo.numero || "").replace(/\D/g, ""),
    titular: String(corpo.titular || "").trim(),
    mes: String(corpo.mes || "").trim(),
    ano: String(corpo.ano || "").trim(),
    cvv: String(corpo.cvv || "").trim(),
  };

  // O mínimo para nem tentar a rede. Não valido bandeira nem Luhn: quem sabe
  // dizer se o cartão existe é a operadora, e uma régua nossa a mais só
  // recusaria cartão bom de bandeira que ainda não conhecemos.
  if (!cartao.numero || !cartao.titular || !cartao.mes || !cartao.ano || !cartao.cvv) {
    return { ok: false, erro: "dados_incompletos" };
  }

  // O titular vem da ficha e pode ser completado pelo formulário: CEP e
  // número do endereço quase nunca estão no cadastro, e o Asaas os exige.
  const daFicha = titularDe(pessoa);
  const titular = {
    nome: String(corpo.titularNome || daFicha.nome || cartao.titular),
    email: String(corpo.email || daFicha.email || ""),
    documento: String(corpo.documento || daFicha.documento || ""),
    telefone: String(corpo.telefone || daFicha.telefone || ""),
    celular: String(corpo.celular || daFicha.celular || ""),
    cep: String(corpo.cep || daFicha.cep || ""),
    numero: String(corpo.numeroEndereco || daFicha.numero || ""),
    complemento: String(corpo.complemento || daFicha.complemento || ""),
  };

  // SEM CPF não há tokenização: o Asaas o exige no titular, e é também por
  // ele que o cliente é encontrado lá. Dizer isto aqui evita a recusa
  // genérica depois de a pessoa ter digitado o cartão inteiro.
  if (!titular.documento) return { ok: false, erro: "sem_documento" };
  if (OBRIGATORIOS.some((campo) => !String(titular[campo] || "").trim())) {
    return { ok: false, erro: "titular_incompleto" };
  }

  // ── CONFERIR O TAMANHO ANTES DE MANDAR O CARTÃO PARA LÁ ────────────────
  //
  // *"o cpf, não ficou com máscara"*: sem máscara, o campo do CEP aceitou os
  // onze dígitos de um CPF, e quem reprovou foi o Asaas. As telas mascaram,
  // mas a regra mora aqui porque os clientes todos mandam para o mesmo lugar
  // — e porque uma requisição que já se sabe perdida leva um número de cartão
  // junto. Menos uma viagem do PAN é motivo suficiente.
  //
  // Letra passa inteira: código postal de fora não tem oito dígitos.
  if (!temLetra(titular.documento) && ![11, 14].includes(digitos(titular.documento).length)) {
    return { ok: false, erro: "documento_invalido" };
  }
  if (titular.cep && !temLetra(titular.cep) && digitos(titular.cep).length !== 8) {
    return { ok: false, erro: "cep_invalido" };
  }

  return { ok: true, cartao, titular };
}

// ── TOKENIZAR ────────────────────────────────────────────────────────────
//
// Recebe a CONTA já resolvida (credenciais, gateway, cliente): os dois
// chamadores já a têm na mão quando chegam aqui — um porque acabou de
// conferir a situação, o outro porque precisava dela para emitir a fatura —,
// e buscá-la de novo seria uma ida a mais ao banco e, pior, a chance de
// tokenizar numa conta e cobrar em outra. Token do Asaas vale para UM
// cliente de UMA conta.
//
// O `detalhe` cru do gateway sobe junto na recusa: "cartão recusado pela
// operadora" é uma frase que diz o que fazer.
async function tokenizar({ cartao, titular, ip = "", credenciais, gateway, cliente }) {
  const r = await gateway.cobranca.tokenizarCartao({
    chave: credenciais.chave,
    ambiente: credenciais.ambiente,
    cliente,
    cartao,
    titular,
    // O IP de quem está digitando, e não o do servidor: é o que vai para a
    // análise de risco deles.
    ip,
  });
  if (!r.ok) return r;

  return {
    ok: true,
    token: r.cartao.token,
    bandeira: r.cartao.bandeira,
    fim: r.cartao.fim,
    // O que a pessoa vai usar para reconhecer este cartão numa lista. Nada
    // aqui serve para cobrar — isso é o token, e ele é lido num lugar só.
    impresso: {
      titular: cartao.titular,
      validade: `${String(cartao.mes).padStart(2, "0")}/${cartao.ano.slice(-2)}`,
    },
  };
}

// Guardar o token para as próximas. A unidade é a DO GATEWAY, não a do
// aluno: uma filial que herdou a conta da casa cobra pela conta da casa, e é
// lá que o token vale. Ver `model/CartaoSalvo_model.js`.
function guardar(app, pessoa, { credenciais, cliente, token, bandeira, fim, impresso }, userId) {
  return app.api.cartaoSalvo.guardar(
    String(pessoa._id),
    {
      tipo: credenciais.tipo,
      unidade: credenciais.unidade || "",
      cliente,
      token,
      bandeira,
      fim,
      titular: impresso?.titular || "",
      validade: impresso?.validade || "",
    },
    userId
  );
}

// ── O VOCABULÁRIO DAS RECUSAS ────────────────────────────────────────────
//
// `erro` → [chave de tradução, status HTTP]. Mora aqui, e não em cada rota,
// porque as duas portas que tokenizam têm de recusar com a MESMA frase: o
// mesmo CPF torto não pode ser "CPF inválido" numa tela e "não foi possível"
// na outra.
const ERROS = {
  pessoa_invalida: ["cardNoPerson", 404],
  nao_encontrado: ["cardNotFound", 404],
  sem_gateway: ["cardNoGateway", 409],
  gateway_nao_cobra: ["cardNoGateway", 409],
  sem_tokenizacao: ["cardNoTokenization", 409],
  sem_cartao: ["cardNotFound", 404],
  sem_documento: ["cardNoDocument", 400],
  titular_incompleto: ["cardHolderIncomplete", 400],
  documento_invalido: ["cardBadDocument", 400],
  cep_invalido: ["cardBadZip", 400],
  dados_incompletos: ["cardIncomplete", 400],
  chave_invalida: ["gatewayBadKey", 400],
  fora_do_ar: ["gatewayUnreachable", 502],
};

// A recusa pronta para `res.send`. `detalhe` é o texto cru do gateway, e vai
// junto quando existe.
function recusaDe(t, erro, detalhe) {
  const [chave, status] = ERROS[erro] || ["cardRefused", 400];
  return { status, corpo: { msg: [t("errors." + chave), detalhe].filter(Boolean).join(" "), code: erro } };
}

module.exports = { titularDe, situacao, conferir, tokenizar, guardar, ERROS, recusaDe };
