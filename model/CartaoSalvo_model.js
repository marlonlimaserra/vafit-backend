const { ObjectId } = require("mongodb");

// O CARTÃO QUE O ALUNO DEIXOU GUARDADO — para as faturas que a casa gera.
//
// *"crie aqui, aba de cartão de crédito para colocar os cartões para pagar as
// faturas que a unidade gerar"* (16/10/2026).
//
// ── AQUI NÃO MORA CARTÃO NENHUM ──────────────────────────────────────────
//
// Mora um TOKEN do gateway, mais o que serve para a pessoa reconhecer qual
// cartão é: a bandeira, os quatro últimos dígitos, o nome impresso e a
// validade. O número completo e o CVV existem por alguns milissegundos dentro
// da requisição que fala com o Asaas, e morrem com ela — nunca são gravados,
// nunca vão para log.
//
// Essa é a razão inteira de a tokenização existir. Guardar o número aqui
// jogaria fora a proteção e traria junto a PCI-DSS, que é um regime que esta
// casa não tem como sustentar.
//
// ── O TOKEN É DA CONTA DO GATEWAY QUE O CRIOU ────────────────────────────
//
// Um `creditCardToken` do Asaas vale para UM `customer` de UMA conta. Se a
// casa trocar a chave por outra conta, ou se a unidade passar a ter gateway
// próprio, o token guardado aqui deixa de servir — e usá-lo volta recusado.
//
// Por isso cada cartão grava `tipo`, `unit` e `cliente`: é o endereço completo
// de onde ele vale. Quem vai cobrar pergunta por esse trio (`paraCobrar`), e
// um cartão de outra conta simplesmente não é encontrado — em vez de ser
// tentado e recusado na frente do aluno.
//
// `unit` é a unidade DO GATEWAY, não a do aluno: uma filial que herdou a
// conta da casa cobra pela conta da casa. Ver `PaymentGateway_model.ativo`.
const COLLECTION = "saved_cards";

const id = (valor) => (ObjectId.isValid(String(valor)) ? new ObjectId(String(valor)) : null);

function CartaoSalvo_model(app) {
  this.app = app;
}

CartaoSalvo_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection(COLLECTION);
};

// O que a tela recebe. O token NÃO está aqui, e nem o id do cliente no
// gateway: um é a credencial de cobrança, o outro é o endereço dela.
CartaoSalvo_model.prototype.paraTela = function (doc) {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    bandeira: doc.bandeira || "",
    fim: doc.fim || "",
    titular: doc.titular || "",
    validade: doc.validade || "",
    principal: Boolean(doc.principal),
    criadoEm: doc.criadoEm || null,
  };
};

// A lista de uma pessoa. A PROJEÇÃO tira o token antes de ele sair do banco:
// não é só "não mandar", é não passear com a credencial pela memória de uma
// rota que não precisa dela — a mesma decisão da chave do gateway.
CartaoSalvo_model.prototype.lista = async function (pessoa) {
  const alvo = id(pessoa);
  if (!alvo) return [];

  const col = await this.collection();
  const docs = await col
    .find({ user: alvo }, { projection: { token: 0, cliente: 0 } })
    .sort({ principal: -1, criadoEm: -1 })
    .toArray();

  return docs.map((d) => this.paraTela(d));
};

// ── GUARDAR ───────────────────────────────────────────────────────────────
//
// O PRIMEIRO cartão de uma pessoa já nasce principal. Sem isso, guardar um
// cartão e esperar que ele pague não funcionaria, e o motivo ("nenhum está
// marcado como principal") seria invisível na tela.
CartaoSalvo_model.prototype.guardar = async function (pessoa, dados, userId) {
  const alvo = id(pessoa);
  if (!alvo) return { erro: "pessoa_invalida" };

  const col = await this.collection();
  const quantos = await col.countDocuments({ user: alvo });

  // O MESMO cartão duas vezes não vira duas linhas. O Asaas devolve o mesmo
  // token para o mesmo cartão do mesmo cliente, e é por ele que se compara —
  // comparar pelos quatro últimos recusaria dois cartões diferentes que
  // terminam igual, que acontece.
  const jaTem = await col.findOne({ user: alvo, token: String(dados.token) });
  if (jaTem) {
    await col.updateOne({ _id: jaTem._id }, { $set: { atualizadoEm: new Date() } });
    return { ok: true, id: String(jaTem._id), repetido: true };
  }

  const doc = {
    user: alvo,
    tipo: String(dados.tipo || ""),
    unit: id(dados.unidade),
    cliente: String(dados.cliente || ""),
    token: String(dados.token || ""),
    bandeira: String(dados.bandeira || "").slice(0, 40),
    fim: String(dados.fim || "").slice(-4),
    titular: String(dados.titular || "").slice(0, 120),
    validade: String(dados.validade || "").slice(0, 7),
    principal: quantos === 0,
    criadoEm: new Date(),
    criadoPor: userId ? String(userId) : null,
  };

  const r = await col.insertOne(doc);
  return { ok: true, id: String(r.insertedId) };
};

// ── ESCOLHER O PRINCIPAL ──────────────────────────────────────────────────
//
// Um só por pessoa. Desliga todos e liga este, nesta ordem — a inversa
// deixaria dois principais por um instante, e o de cima é o que cobra.
CartaoSalvo_model.prototype.principal = async function (pessoa, cartao) {
  const alvo = id(pessoa);
  const qual = id(cartao);
  if (!alvo || !qual) return { erro: "nao_encontrado" };

  const col = await this.collection();
  const doc = await col.findOne({ _id: qual, user: alvo }, { projection: { _id: 1 } });
  if (!doc) return { erro: "nao_encontrado" };

  await col.updateMany({ user: alvo, principal: true }, { $set: { principal: false } });
  await col.updateOne({ _id: qual }, { $set: { principal: true } });
  return { ok: true };
};

// ── REMOVER ───────────────────────────────────────────────────────────────
//
// Apaga a linha com o token dentro: guardar a credencial de um cartão que a
// pessoa mandou tirar é guardar um segredo que ninguém mais vigia.
//
// E se o removido era o principal, o mais recente dos que sobraram assume.
// Deixar a pessoa COM cartões e SEM principal é o estado que faz a cobrança
// falhar sem nada na tela explicando.
CartaoSalvo_model.prototype.remover = async function (pessoa, cartao) {
  const alvo = id(pessoa);
  const qual = id(cartao);
  if (!alvo || !qual) return { erro: "nao_encontrado" };

  const col = await this.collection();
  const doc = await col.findOne({ _id: qual, user: alvo });
  if (!doc) return { erro: "nao_encontrado" };

  await col.deleteOne({ _id: qual });

  if (doc.principal) {
    const proximo = await col.findOne({ user: alvo }, { sort: { criadoEm: -1 } });
    if (proximo) await col.updateOne({ _id: proximo._id }, { $set: { principal: true } });
  }

  return { ok: true };
};

// Apagar a PESSOA apaga os tokens dela. Um token vivo de alguém que não existe
// mais é um segredo sem dono — mesma razão de `remover` apagar a linha.
CartaoSalvo_model.prototype.apagarDaPessoa = async function (pessoa) {
  const alvo = id(pessoa);
  if (!alvo) return 0;

  const col = await this.collection();
  const r = await col.deleteMany({ user: alvo });
  return r.deletedCount || 0;
};

// ── O ÚNICO LUGAR QUE LÊ O TOKEN ──────────────────────────────────────────
//
// Como `PaymentGateway.ativo` para a chave: está sozinho de propósito. Um dia
// alguém vai procurar quem lê a credencial do cartão, e a resposta tem de
// caber num `grep`.
//
// O trio (pessoa, tipo, unidade) é o que garante que o token tentado é o da
// conta que vai cobrar. Cartão de outra conta não é encontrado — e não ser
// encontrado é melhor que ser recusado, porque a recusa chega depois, na
// fatura, e parece problema do cartão da pessoa.
//
// `id` ESCOLHE UM DELES, e sem ele vale o principal. Os dois passam pelo
// mesmo trio: um cartão de outra pessoa, ou de outra conta, não é encontrado
// nem quando o id vem certo — o que chega do navegador nunca é o bastante
// para dizer qual token usar.
CartaoSalvo_model.prototype.paraCobrar = async function (pessoa, { tipo, unidade, id: qual } = {}) {
  const alvo = id(pessoa);
  if (!alvo) return null;

  const escolhido = qual ? id(qual) : null;
  if (qual && !escolhido) return null;

  const col = await this.collection();
  const doc = await col.findOne({
    user: alvo,
    ...(escolhido ? { _id: escolhido } : { principal: true }),
    tipo: String(tipo || ""),
    unit: id(unidade),
  });

  if (!doc) return null;
  return { id: String(doc._id), token: doc.token, cliente: doc.cliente, fim: doc.fim };
};

module.exports = CartaoSalvo_model;
