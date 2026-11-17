// O PAGAR.ME (Core API v5).
//
// ── UM HOST SÓ, E O PREFIXO DA CHAVE DECIDE O AMBIENTE ────────────────────
//
// Ao contrário do Asaas, aqui teste e produção atendem no MESMO endereço: o
// que separa os dois é o prefixo da chave — `sk_test_` é sandbox, `sk_` é
// dinheiro de verdade. (Documentação de autenticação da Core API v5,
// conferida em 10/10/2026.)
//
// Então o ambiente se lê da chave, sem chamada nenhuma. O que a chamada
// confere é outra coisa: se a chave VALE.
const BASE = "https://api.pagar.me/core/v5";
const TIMEOUT_MS = 12000;

// ── NÃO EXISTE UM "QUEM SOU EU" NA v5 ─────────────────────────────────────
//
// O Asaas tem `/myAccount` e devolve nome e e-mail do titular. Aqui não há
// equivalente, então a conferência é a leitura mais barata que existe: UM
// cliente. 200 prova a chave; 401 a reprova.
//
// O preço é a tela do Pagar.me não conseguir mostrar "a conta é esta". Ela
// mostra o ambiente e o fim da chave, e isso é o que há — inventar um nome
// seria pior que não ter.
const CONFERE = `${BASE}/customers?size=1`;

module.exports = {
  chave: "pagarme",
  nome: "Pagar.me",
  // ── O PAGAR.ME MORA DENTRO DA STONE ──────────────────────────────────
  //
  // *"no pagar.me eu acesso em https://conta.stone.com.br/home"* (14/10/2026).
  //
  // Aqui estava `id.pagar.me`, que é só o provedor de identidade: ele pede o
  // login e não diz para onde ir depois. Desde a compra pela Stone, o painel
  // vive na conta Stone, e é por lá que ELE entra — que é o único endereço
  // que importa nesta linha.
  //
  // E é atalho para a TELA DA CHAVE, não para a entrada: ele mandou o
  // endereço depois de chegar lá (*"o da stone seria aqui?"*, 14/10/2026).
  //
  // ── A ARMADILHA QUE ESSA TELA ARMA ───────────────────────────────────
  //
  // Ela mostra, em destaque e com botão de copiar, a CHAVE PÚBLICA (`pk_`) —
  // que serve só para tokenizar cartão no navegador e não autentica nada. A
  // secreta (`sk_`) tem de ser criada, e começa com a lista vazia. Quem olha
  // a tela depressa copia a errada; foi o que aconteceu na primeira vez.
  //
  // É o `formato` abaixo que segura isso: `pk_…` é recusado ANTES de chegar
  // ao Pagar.me, e antes de ser gravado.
  ondePegar: "https://conta.stone.com.br/chaves-de-autenticacao",
  formato: /^sk_(test_)?[A-Za-z0-9]{10,}$/,
  // A chave que a tela da Stone oferece PRIMEIRO, com botão de copiar. Não é
  // uma chave quebrada: é outra chave, com outra função. Dizer "confira se
  // copiou inteira" para quem colou uma `pk_` manda a pessoa copiar de novo
  // a mesma coisa errada — e ela copiará, porque copiou certo.
  tipoErrado: /^pk_/,

  async conferir(chave, buscar = fetch) {
    // Basic com a chave no lugar do USUÁRIO e a senha VAZIA — é assim que a
    // v5 pede, e os dois-pontos no fim não são enfeite: sem eles o base64 é
    // outro e a resposta é 401.
    const basic = Buffer.from(`${chave}:`).toString("base64");

    let res;
    try {
      res = await buscar(CONFERE, {
        headers: { Authorization: `Basic ${basic}`, "User-Agent": "VAFIT" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, erro: "fora_do_ar" };
    }

    if (res.status === 401 || res.status === 403) return { ok: false, erro: "chave_invalida" };
    if (!res.ok) return { ok: false, erro: "fora_do_ar" };

    return {
      ok: true,
      ambiente: String(chave).startsWith("sk_test_") ? "sandbox" : "producao",
      conta: { nome: "", email: "", documento: "" },
    };
  },
};
