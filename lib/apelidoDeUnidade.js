// O APELIDO DA UNIDADE — o pedaço dela que aparece no endereço da vitrine.
//
// *"quando eu clicar na unidade, mude a rota /vitrine/alias-unidade"* e
// *"coloque aqui, alias unidade"* (14/10/2026), apontando para o formulário de
// editar unidade.
//
// ── POR QUE NÃO O ID ──────────────────────────────────────────────────────
//
// `/vitrine?unidade=670f1a2b3c4d5e6f78901234` é o que havia, e serve para a
// máquina. Mas este link é feito para ser COLADO: no site da academia, no
// Instagram, num grupo de WhatsApp. `/vitrine/niteroi` se lê, se dita por
// telefone e diz para onde leva antes de abrir.
//
// ── POR QUE NÃO DERIVAR DO NOME NA HORA DE LER ────────────────────────────
//
// Porque o nome muda. "Niteroi" vira "Niterói — Icaraí" no dia em que abrir a
// segunda do bairro, e todo link impresso morreria calado: o visitante veria
// uma vitrine vazia, não um erro. O apelido é GUARDADO, nasce do nome e só
// muda quando alguém decide mudá-lo.
//
// ── POR QUE NÃO REUSAR `lib/alias.js` INTEIRO ─────────────────────────────
//
// Aquele é o código de AFILIADO, e carrega regras que não são destas: ele é
// único no MUNDO (índice na central, porque dois afiliados com o mesmo código
// mandariam dinheiro para a pessoa errada) e tem uma lista de reservados para
// não competir com as rotas da raiz (`gofitnow.fit/i/api`).
//
// O apelido da unidade é único DENTRO DA CASA e mora num beco só dele
// (`/vitrine/<x>`), onde não compete com nada. Reusar a lista de reservados
// recusaria uma academia chamada "Centro" por motivo nenhum.
//
// O que se reusa é o normalizador, que é a parte difícil: acento, espaço,
// hífen repetido, hífen na ponta.
const { normalizar: aPedacoDeUrl } = require("./alias.js");

const MAX = 40;

// Um apelido só de números seria indistinguível de um id, e um dia alguém
// escreve uma rota que aceita os dois.
const SO_NUMERO = /^\d+$/;

function normalizar(valor) {
  return aPedacoDeUrl(valor).slice(0, MAX);
}

// Devolve o apelido pronto, ou o MOTIVO da recusa — o controller traduz.
function conferir(valor) {
  const limpo = normalizar(valor);

  if (!limpo) return { erro: "vazio" };
  if (SO_NUMERO.test(limpo)) return { erro: "so_numero" };

  return { valor: limpo };
}

// A sugestão a partir do nome da unidade. Não devolve único: quem garante
// unicidade é o banco, e esta função só propõe.
function sugerir(nome) {
  return normalizar(nome);
}

// A tentativa seguinte quando o apelido está tomado: `centro` → `centro-2`.
//
// Sufixo numérico e não aleatório, pela mesma razão do alias de afiliado: um
// endereço é ditado por telefone, e `centro-a7f3` não se dita.
function proxima(base, tentativa) {
  const raiz = normalizar(base).slice(0, MAX - String(tentativa).length - 1);
  return `${raiz}-${tentativa}`;
}

module.exports = { normalizar, conferir, sugerir, proxima, MAX };
