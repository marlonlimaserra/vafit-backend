const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { varrer } = require("../../lib/varrerPasta.js");

// LER UMA PASTA COMO ÍNDICE SEM ENGOLIR O QUE NÃO É CÓDIGO.
//
// Este arquivo existe por um prejuízo, e a data importa: 10/10/2026, às 02:00,
// a API inteira fora do ar por seis minutos.
//
// O `tar` do macOS carrega os metadados de cada arquivo num IRMÃO com `._` na
// frente. Eles viajaram no deploy do gateway de pagamento, caíram em
// `lib/gateways/` e em `lib/i18n/locales/pt-BR/`, e o `readdirSync` os
// considerou código — `._asaas.js` termina em `.js`, `._gateways.json` termina
// em `.json`. O servidor subiu, tentou `JSON.parse` num arquivo binário e
// morreu em laço.
//
// Três pastas deste projeto são lidas assim, e nenhuma delas se defendia.

test("o irmão `._` do tar do macOS NÃO é código, por mais que termine em .js", () => {
  const nomes = ["asaas.js", "._asaas.js", "index.js", "._index.js"];

  assert.deepEqual(varrer(nomes, ".js"), ["asaas.js", "index.js"]);
});

test("e nem o `._` de um JSON de tradução — foi esse que derrubou o servidor", () => {
  assert.deepEqual(varrer(["._financeiro.json", "financeiro.json"], ".json"), ["financeiro.json"]);
});

test("a família inteira cai junto: .DS_Store, .swp do vim, o til do editor", () => {
  // Consertar só o `._` no `tar` resolveria AQUELE deploy. O `.DS_Store` de um
  // Finder aberto na pasta, o `.asaas.js.swp` de um vim que morreu e o
  // `asaas.js~` de um editor viriam depois, um de cada vez.
  const nomes = [".DS_Store", ".asaas.js.swp", "asaas.js~", "asaas.js"];

  assert.deepEqual(varrer(nomes, ".js"), ["asaas.js"]);
});

test("a ordem é alfabética, e não a do sistema de arquivos", () => {
  // Uma pasta lida como índice não pode mudar de comportamento conforme a
  // ordem em que o disco devolveu os nomes.
  assert.deepEqual(varrer(["z.js", "a.js", "m.js"], ".js"), ["a.js", "m.js", "z.js"]);
});

// ── E AS TRÊS PASTAS DE VERDADE USAM ISTO ────────────────────────────────
//
// Um `varrer` perfeito não serve de nada se alguém escrever a quarta pasta com
// `readdirSync` cru — e ela não vai parecer errada em revisão nenhuma: é
// idêntica às três que existiam antes de hoje.
test("nenhum `readdirSync` do servidor vira require ou JSON.parse sem passar por `varrer`", () => {
  const raiz = path.join(__dirname, "..", "..");
  const culpados = [];

  const olhar = (dir) => {
    for (const nome of fs.readdirSync(dir)) {
      if (nome === "node_modules" || nome === ".git" || nome === "test") continue;
      const cheio = path.join(dir, nome);
      if (fs.statSync(cheio).isDirectory()) {
        olhar(cheio);
        continue;
      }
      if (!nome.endsWith(".js")) continue;

      const fonte = fs.readFileSync(cheio, "utf8");
      if (!fonte.includes("readdirSync")) continue;
      // O `varrerPasta.js` é a própria regra, e o `check.js` só monta uma lista
      // de nomes para ler — não carrega nenhum deles como módulo.
      if (nome === "varrerPasta.js" || nome === "check.js") continue;
      if (!fonte.includes("varrer(")) culpados.push(path.relative(raiz, cheio));
    }
  };

  olhar(path.join(raiz, "lib"));
  olhar(path.join(raiz, "model"));
  olhar(path.join(raiz, "controllers"));

  assert.deepEqual(culpados, [], "use `varrer(fs.readdirSync(…), '.js')` — ver lib/varrerPasta.js");
});
