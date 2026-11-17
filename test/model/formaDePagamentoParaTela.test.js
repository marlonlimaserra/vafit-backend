const test = require("node:test");
const assert = require("node:assert/strict");

const PaymentMethod = require("../../model/PaymentMethod_model.js");

// O CATÁLOGO DE FORMAS, PRONTO PARA A TELA.
//
// As sete originais guardam `name` vazio de propósito — o nome delas é a
// tradução, e gravá-lo congelaria o idioma de quem criou a conta. Quem lê a
// lista crua precisa saber dessa regra, e três telas já tinham a própria cópia
// de `nomeDaForma`.
//
// A vitrine pública foi a gota: ela carrega só a parte `vitrine` do dicionário,
// e não tem como escrever "Dinheiro" sozinha. Por isso o nome sai resolvido do
// modelo, e por isso ele tem teste.
function monta(formas) {
  const m = new PaymentMethod({});
  m.listActive = async () => formas;
  return m;
}

// O `t` do servidor devolve a PRÓPRIA CHAVE quando não acha — é o que faz texto
// faltando aparecer em vez de sumir. Aqui o dublê imita exatamente isso.
const t = (chave) => ({ "finance.method.pix": "Pix", "finance.method.cash": "Dinheiro" })[chave] || chave;

test("a forma do sistema sai com o nome TRADUZIDO", async () => {
  const r = await monta([{ key: "cash", name: "", system: true }]).paraTela(t);
  assert.deepEqual(r, [{ key: "cash", name: "Dinheiro" }]);
});

test("o nome PRÓPRIO vence a tradução", async () => {
  // Quem renomeou "Pix" para "Pix (chave CNPJ)" escolheu aquele nome; traduzir
  // por cima desfaria a escolha dele.
  const r = await monta([{ key: "pix", name: "Pix (chave CNPJ)", system: true }]).paraTela(t);
  assert.equal(r[0].name, "Pix (chave CNPJ)");
});

test("forma da casa sem tradução NÃO vira 'finance.method.cheque'", async () => {
  // Esta é a razão de `traduzida()` existir. Sem ela, a chave crua sairia num
  // cartão de venda — e o `t` do servidor devolve a chave de propósito.
  const r = await monta([{ key: "cheque", name: "", system: false }]).paraTela(t);
  assert.equal(r[0].name, "cheque");
});

test("só a chave e o nome atravessam — `order`, `active` e `system` ficam", async () => {
  // A vitrine é pública: o que não serve para desenhar não sai de casa.
  const r = await monta([{ key: "pix", name: "", active: 1, order: 0, system: true, _id: "x" }]).paraTela(t);
  assert.deepEqual(Object.keys(r[0]), ["key", "name"]);
});
