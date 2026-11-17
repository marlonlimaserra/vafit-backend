// LER UMA PASTA COMO SE ELA FOSSE UM ÍNDICE — sem engolir o que não é código.
//
// ── O prejuízo que escreveu este arquivo (10/10/2026) ─────────────────────
//
// `lib/condicoes/`, `lib/gateways/` e `lib/i18n/locales/` não têm registro
// central: o que está na pasta existe. É uma boa decisão — some o array
// compartilhado onde dois programadores conflitam — e ela tem um preço que eu
// paguei em produção no dia em que escrevi o segundo deles.
//
// O `tar` do macOS carrega os metadados de cada arquivo num IRMÃO com `._` na
// frente: `._asaas.js`, `._gateways.json`. Eles viajaram no deploy, caíram nas
// pastas, e `readdirSync` os considerou código: `._asaas.js` termina em `.js`,
// `._gateways.json` termina em `.json`. O servidor subiu, tentou
// `JSON.parse` de um arquivo binário e morreu em laço —
// *"SyntaxError: Unexpected token ' ', \"    Ma\"... is not valid JSON"* —
// com a API inteira fora do ar por seis minutos.
//
// ── Por que o conserto é AQUI, e não no `tar` ─────────────────────────────
//
// Passar `COPYFILE_DISABLE=1` no empacotamento resolve ESTE deploy. Não
// resolve o próximo, feito de outra máquina, nem o `.DS_Store` que um Finder
// aberto na pasta cria, nem o `.asaas.js.swp` de um vim que morreu, nem o
// arquivo que um editor salva com til no fim.
//
// A regra que fecha a família inteira é: código é o que alguém escreveu com a
// intenção de ser código. Arquivo escondido (começa com `.`) e sobra de editor
// (termina com `~`) nunca são — e quem lê uma pasta como índice precisa dizer
// isso explicitamente, porque `readdirSync` entrega tudo.
const ESCONDIDO = /^\./;
const SOBRA_DE_EDITOR = /~$/;

// `nomes` é o que `fs.readdirSync` devolveu; `extensao` é ".js" ou ".json".
// A ordem é alfabética e estável, porque uma pasta lida como índice não pode
// mudar de comportamento conforme a ordem do sistema de arquivos.
function varrer(nomes, extensao) {
  return nomes
    .filter((n) => n.endsWith(extensao))
    .filter((n) => !ESCONDIDO.test(n) && !SOBRA_DE_EDITOR.test(n))
    .sort();
}

module.exports = { varrer };
