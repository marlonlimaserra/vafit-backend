// A CONTA DE FORA AINDA FALA COM A GENTE? — o selo de cada linha.
//
// *"coloque um 'badge' de status, que vai no backend e consulta se o token
// ainda está funcionando"* (15/10/2026).
//
// ── POR QUE ISTO NÃO DÁ PARA SABER SEM PERGUNTAR ─────────────────────────
//
// Nada do nosso lado muda quando um token morre. A pessoa troca a senha do
// Facebook, tira o app nas configurações dela, perde o papel de administradora
// da Página — e aqui continua tudo igual, com a conta na lista e um nome
// bonito. O primeiro sintoma é uma mensagem que não chega, semanas depois, e
// ninguém liga uma coisa à outra.
//
// `expiraEm` não responde: o token da Página não expira por data (ver
// `OauthPagina_model`), e o do Instagram pode morrer bem antes dos 60 dias.
// A única resposta honesta é PERGUNTAR à Meta, e é o que o selo faz.
//
// ── OS ESTADOS, E POR QUE SÃO SEIS ───────────────────────────────────────
//
// `ok` e `expirada` seriam o óbvio. Os outros quatro existem porque as
// perguntas que eles respondem levam a AÇÕES DIFERENTES:
//
//   `muda` — o token vale e a Página não está assinada no webhook. Tudo
//   parece certo e nada chega; é o defeito mais confuso desta integração, e
//   quem o vê precisa reconectar, não investigar.
//
//   `sem_permissao` — o token vale, mas a permissão que usamos foi retirada.
//   Reconectar resolve; trocar de senha não.
//
//   `fora_do_ar` — a Meta não respondeu. NÃO é "conta com problema": dizer
//   vermelho porque a rede piscou faz a pessoa reconectar uma conta que está
//   perfeita — e o selo que erra uma vez deixa de ser lido.
//
//   `nao_verificada` — ainda não perguntamos. É o estado de toda conta
//   antiga, e some na primeira abertura da tela.
//
// O `tom` é semântico e não classe de CSS: o painel e o app pintam o mesmo
// estado de jeitos diferentes — a mesma regra dos outros catálogos daqui.
const ESTADOS = [
  { id: "ok", rotulo: "connectedAccounts.state.ok", tom: "ok" },
  { id: "muda", rotulo: "connectedAccounts.state.mute", tom: "aviso" },
  { id: "expirada", rotulo: "connectedAccounts.state.expired", tom: "perigo" },
  { id: "sem_permissao", rotulo: "connectedAccounts.state.noPermission", tom: "perigo" },
  { id: "fora_do_ar", rotulo: "connectedAccounts.state.unreachable", tom: "neutro" },
  { id: "nao_verificada", rotulo: "connectedAccounts.state.unchecked", tom: "neutro" },
];

const IDS = ESTADOS.map((e) => e.id);

function existe(id) {
  return IDS.includes(String(id || ""));
}

// O que chega na tela: id, rótulo traduzido e tom. Um estado desconhecido
// (banco de uma versão mais nova, catálogo encolhido) vira `nao_verificada` em
// vez de sumir — linha sem selo nenhum lê-se como "está tudo bem".
function normalizar(id) {
  return existe(id) ? String(id) : "nao_verificada";
}

function paraTela(t) {
  return ESTADOS.map((e) => ({
    id: e.id,
    label: t ? t(e.rotulo) : e.rotulo,
    tom: e.tom,
  }));
}

module.exports = { ESTADOS, IDS, existe, normalizar, paraTela };
