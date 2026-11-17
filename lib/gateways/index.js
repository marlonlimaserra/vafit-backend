const fs = require("node:fs");
const path = require("node:path");
const { varrer } = require("../varrerPasta.js");

// OS GATEWAYS DE PAGAMENTO QUE A CASA PODE LIGAR.
//
// *"quero fazer um 'gateways de pagamento' e integrar asaas e pagar.me, aí ele
// vai configurar a integração e só vai poder escolher por onde as faturas e
// assinaturas serão geradas"* (10/10/2026).
//
// ── UM ARQUIVO POR GATEWAY, SEM REGISTRO CENTRAL ──────────────────────────
//
// Mesma decisão de `lib/condicoes/`, e pela mesma razão: uma lista central faz
// toda adição mexer nas mesmas linhas, e o conflito cai no pior lugar — no meio
// de um array, onde um `>>>>>>>` passa na revisão.
//
// Acrescentar o Mercado Pago é criar um arquivo aqui. Não há índice para
// editar: este `readdirSync` é o índice.
const PASTA = __dirname;

// ── O QUE CADA ARQUIVO PRECISA EXPORTAR ───────────────────────────────────
//
//   chave      o id, minúsculo, que vai para o banco e para a URL
//   nome       como a empresa se escreve ("Pagar.me", com o ponto)
//   ondePegar  o endereço da tela onde a pessoa copia a chave dela
//   formato    o que a chave tem de parecer, para recusar antes da rede
//   conferir(chave, buscar) → { ok, ambiente, conta } | { ok: false, erro }
//
// `conferir` é o coração: é ele que diz se a chave serve e — isto é o que
// importa — em QUE AMBIENTE ela vale. Ver o LEIA-ME.
//
// OPCIONAIS, e por isso fora desta lista: `cobranca` (quem sabe gerar fatura)
// e `tokeniza` (quem sabe guardar cartão). Um gateway sem elas existe,
// confere chave e aparece na tela — só não oferece aquilo.
const CAMPOS = ["chave", "nome", "ondePegar", "formato", "conferir"];

const GATEWAYS = varrer(fs.readdirSync(PASTA), ".js")
  .filter((n) => n !== "index.js")
  .map((n) => require(path.join(PASTA, n)))
  .sort((a, b) => a.nome.localeCompare(b.nome));

for (const g of GATEWAYS) {
  for (const campo of CAMPOS) {
    if (g?.[campo] === undefined) {
      throw new Error(`gateway sem "${campo}": ${g?.chave || "?"} (lib/gateways)`);
    }
  }
}

// O catálogo que vai para a tela. SEM o `conferir` e sem o `formato`: um é
// função (não atravessa JSON) e o outro é regra de servidor — mandá-lo para o
// navegador convidaria a validar lá e confiar no resultado aqui.
//
// E leva `tokeniza`, que é CAPACIDADE do gateway e não segredo de ninguém: a
// tela precisa dele para saber se cabe perguntar "a sua conta tem tokenização
// de cartão liberada?". Sem ele, a tela teria de conhecer o nome "asaas" por
// dentro — e a terceira marca nasceria com a caixa escondida.
//
// `Boolean` e não o valor cru: ausente tem de chegar lá como `false`, e não
// como `undefined`, que some no JSON e vira "não sei" no meio de um `if`.
function catalogo() {
  return GATEWAYS.map((g) => ({
    chave: g.chave,
    nome: g.nome,
    ondePegar: g.ondePegar,
    tokeniza: Boolean(g.tokeniza),
    // As formas que ELE emite, nas chaves do nosso catálogo. Vazio quer dizer
    // "não emite nada" — um gateway que só guarda cartão, por exemplo.
    formas: Array.isArray(g.formas) ? g.formas : [],
    // E QUAL delas é o cartão que se debita na hora. A tela usa isto para
    // saber onde cabe o botão "Cobrar" — sem ela, teria de conhecer a chave
    // "credit" por dentro.
    formaDeCartao: g.formaDeCartao || "",
  }));
}

// Lista FECHADA: o que chega da URL nunca vira índice de objeto direto. Um
// `GATEWAYS[req.params.tipo]` deixaria um parâmetro escolher que código roda.
function de(chave) {
  return GATEWAYS.find((g) => g.chave === String(chave || "")) || null;
}

module.exports = { catalogo, de, GATEWAYS };
