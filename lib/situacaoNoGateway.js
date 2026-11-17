// A SITUAÇÃO DE UMA COBRANÇA NO GATEWAY — o que está acontecendo lá fora.
//
// *"PAYMENT_AUTHORIZED, PAYMENT_AWAITING_RISK_ANALYSIS,
// PAYMENT_REPROVED_BY_RISK_ANALYSIS, PAYMENT_UPDATED,
// PAYMENT_REFUND_IN_PROGRESS deveria tratar esses também"* (15/10/2026).
//
// ── POR QUE NÃO É UM STATUS DE COBRANÇA ──────────────────────────────────
//
// Nenhum destes é dinheiro na conta. "Autorizado" é o cartão reservando o
// valor, "em análise" é o Asaas decidindo se aceita, "reprovado" é a análise
// recusando. Se qualquer um deles mexesse em `status`, a regra desta casa
// desmoronava: aqui "paga" quer dizer que os PAGAMENTOS cobrem o valor, e
// nada mais. Foi a confusão que custou três desenhos na tela de cobrança.
//
// Então eles vivem ao lado, em `charges.gateway.situacao`, e respondem outra
// pergunta — a que a recepção faz olhando uma cobrança em aberto no dia
// seguinte ao aluno jurar que pagou: POR QUE ela ainda não baixou.
//
// ── E VEM DO SERVIDOR, como todo catálogo daqui ──────────────────────────
//
// *"coloque esse status em uma variável no backend, assim, se a gente
// adicionar um status novo, a chamada já traz"*. O `tom` é semântico e não
// uma classe de CSS: o app, o painel e o papel pintam o mesmo estado de
// jeitos diferentes.
const SITUACOES = [
  // O cartão reservou o valor e ele ainda precisa ser capturado. Dinheiro
  // prometido, não recebido.
  { id: "autorizado", rotulo: "finance.gatewayState.authorized", tom: "aviso" },
  { id: "em_analise", rotulo: "finance.gatewayState.underReview", tom: "aviso" },
  // Aprovado na análise: o pagamento vem logo atrás. Existe para APAGAR o
  // "em análise" — sem ele, uma cobrança aprovada ficaria para sempre com a
  // etiqueta de quem está sendo examinado.
  { id: "aprovado", rotulo: "finance.gatewayState.approved", tom: "ok" },
  { id: "recusado", rotulo: "finance.gatewayState.refused", tom: "perigo" },
  { id: "estornando", rotulo: "finance.gatewayState.refunding", tom: "aviso" },
];

const IDS = SITUACOES.map((s) => s.id);

function existe(id) {
  return IDS.includes(String(id || ""));
}

function paraTela(t) {
  return SITUACOES.map((s) => ({
    id: s.id,
    label: t ? t(s.rotulo) : s.rotulo,
    tom: s.tom,
  }));
}

module.exports = { SITUACOES, IDS, existe, paraTela };
