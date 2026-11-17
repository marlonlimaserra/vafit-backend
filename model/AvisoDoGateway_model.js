// O DIÁRIO DOS AVISOS DO GATEWAY — o que chegou, e o que foi feito com ele.
//
// *"crie uma aba chamada depuração, e coloque 'log asaas' para a gente poder
// ver o que chegou, se foi processado ou não etc."* (19/10/2026).
//
// ── POR QUE ISTO PRECISOU EXISTIR ─────────────────────────────────────────
//
// O webhook é a única parte desta integração que acontece sem ninguém
// olhando: o Asaas bate numa porta pública, de madrugada, e a única pista do
// que houve era uma linha no `console` de um processo que reinicia. Quando o
// dinheiro não aparece na ficha, as perguntas são três e nenhuma tinha
// resposta — **chegou? foi aceito? casou com alguma cobrança?** —, e cada uma
// aponta para um conserto diferente:
//
//   não chegou        o webhook não está registrado, ou a fila está parada lá
//   chegou e recusado o segredo daqui não é o que está registrado lá
//   chegou e sem dono o aviso é de uma fatura que este banco não conhece
//
// Da terceira ninguém desconfia sozinho, e é a mais comum depois de uma
// migração ou de um gateway reconfigurado.
//
// ── O QUE NÃO ENTRA AQUI ──────────────────────────────────────────────────
//
// O `asaas-access-token` do cabeçalho, nunca. Ele é o segredo que autentica
// os avisos daquela conta: guardá-lo num log que uma tela mostra seria
// publicá-lo para todo mundo que abre Configurações. O que o diário diz é
// SE ele conferiu, que é a informação útil.
function AvisoDoGateway_model(app) {
  this.app = app;
}

// O corpo cru vale ouro na depuração e não pode crescer sem limite: um aviso
// do Asaas tem uns 2 KB, mas um dia um gateway novo manda 400. O corte é
// generoso e existe para haver um.
const LIMITE_DO_CORPO = 8 * 1024;

AvisoDoGateway_model.prototype.colecao = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("gateway_webhook_logs");
};

// NUNCA ESTOURA. Isto roda dentro do caminho que dá baixa em dinheiro: um
// erro ao gravar o diário não pode transformar um pagamento aplicado num 500
// — que faria o Asaas reenviar e, pior, PARAR A FILA daquela conta.
AvisoDoGateway_model.prototype.registrar = async function (dados = {}) {
  try {
    const corpo = JSON.stringify(dados.corpo ?? {});

    const col = await this.colecao();
    await col.insertOne({
      em: new Date(),
      tipo: String(dados.tipo || ""),
      unidade: dados.unidade ? String(dados.unidade) : null,
      // O EVENTO é a primeira coluna que alguém lê: `PAYMENT_RECEIVED`,
      // `PAYMENT_OVERDUE`. Vem do corpo, e é o que o Asaas chama de `event`.
      evento: String(dados.corpo?.event || ""),
      // A FATURA, que é por onde se procura: quem está depurando tem o id na
      // tela do Asaas e quer saber o que aconteceu com ele aqui.
      pagamento: String(dados.corpo?.payment?.id || ""),
      estado: String(dados.estado || ""),
      feito: String(dados.feito || ""),
      cobranca: dados.cobranca ? String(dados.cobranca) : null,
      erro: String(dados.erro || "").slice(0, 500),
      http: Number(dados.http) || 0,
      corpo: corpo.length > LIMITE_DO_CORPO ? corpo.slice(0, LIMITE_DO_CORPO) + "…" : corpo,
    });
    return true;
  } catch (erro) {
    console.error("[aviso-do-gateway] não consegui registrar:", erro?.message || erro);
    return false;
  }
};

const LIMITE_PADRAO = 20;

AvisoDoGateway_model.prototype.lista = async function ({
  pagina = 1,
  limite = LIMITE_PADRAO,
  estado = "",
  busca = "",
} = {}) {
  const col = await this.colecao();

  const filtro = {};
  if (estado) filtro.estado = String(estado);

  // A BUSCA é pelo que se tem na mão quando se vem depurar: o id da fatura
  // copiado da tela do Asaas, ou o nome do evento. Sem regex de usuário solto
  // no banco — o texto é escapado.
  const termo = String(busca || "").trim();
  if (termo) {
    const seguro = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filtro.$or = [
      { pagamento: { $regex: seguro, $options: "i" } },
      { evento: { $regex: seguro, $options: "i" } },
    ];
  }

  const porPagina = Math.min(Math.max(Number(limite) || LIMITE_PADRAO, 1), 100);
  const pular = Math.max((Number(pagina) || 1) - 1, 0) * porPagina;

  const [linhas, total] = await Promise.all([
    col.find(filtro).sort({ em: -1 }).skip(pular).limit(porPagina).toArray(),
    col.countDocuments(filtro),
  ]);

  return {
    rows: linhas.map((l) => ({
      id: String(l._id),
      em: l.em,
      tipo: l.tipo,
      unidade: l.unidade,
      evento: l.evento,
      pagamento: l.pagamento,
      estado: l.estado,
      feito: l.feito,
      cobranca: l.cobranca,
      erro: l.erro,
      http: l.http,
      corpo: l.corpo,
    })),
    total,
    pagina: Math.floor(pular / porPagina) + 1,
    limite: porPagina,
  };
};

// ── OS ESTADOS, num lugar só ──────────────────────────────────────────────
//
// A tela pinta cada um de uma cor e o filtro os oferece numa lista. Escritos
// aqui para os dois lados falarem o mesmo — e para um estado novo aparecer na
// tela sem ninguém mexer nela.
AvisoDoGateway_model.ESTADOS = [
  // Chegou, conferiu e mexeu em alguma coisa.
  { id: "aplicado", tom: "ok" },
  // Chegou e conferiu, mas o aviso não tem dono deste lado.
  { id: "ignorado", tom: "neutro" },
  // O token do cabeçalho não bate com o que está gravado aqui.
  { id: "recusado", tom: "perigo" },
  // Defeito NOSSO: o 500 que faz o Asaas reenviar.
  { id: "erro", tom: "perigo" },
];

AvisoDoGateway_model.prototype.estados = function (t) {
  return AvisoDoGateway_model.ESTADOS.map((e) => ({
    ...e,
    label: t(`gatewayLog.estado.${e.id}`),
  }));
};

module.exports = AvisoDoGateway_model;
