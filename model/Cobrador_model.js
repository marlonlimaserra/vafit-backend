const { ObjectId } = require("mongodb");

const gateways = require("../lib/gateways");
const dominio = require("../lib/domain.js");
const statusDeRecorrencia = require("../lib/statusDeRecorrencia.js");
const instanceContext = require("../lib/instance.js");

// O COBRADOR — quem fala com o gateway em nome de uma matrícula.
//
// *"se essa opção tiver marcada... já gera o cadastro dele no gateway e cria a
// recorrência direto lá, e salve os ids do nosso lado, pois o Asaas vai criar
// o pagamento lá e vai enviar ele via webhook"* (14/10/2026).
//
// ── POR QUE UM MODELO, e não quatro chamadas no controlador ──────────────
//
// Porque a sequência tem ORDEM e tem meio-termo. São quatro idas à rede —
// cliente, assinatura, webhook, fatura — e cada uma pode falhar sozinha
// deixando as anteriores de pé. O controlador que fizesse isso na mão teria
// quatro `if (!ok) return` a decidir, e decidiria diferente da próxima tela
// que precisasse cobrar.
//
// ── A REGRA QUE GOVERNA TUDO AQUI: A MATRÍCULA JÁ EXISTE ─────────────────
//
// Quando este código roda, o aluno está cadastrado e a recorrência está
// gravada. Nada daqui pode desfazer isso. Um erro do Asaas — chave trocada,
// CPF que ele recusa, API fora do ar — vira "a matrícula valeu, o pagamento
// sai pelo caminho de sempre", e não um 500 que faz a pessoa clicar de novo e
// virar dois alunos.
//
// Por isso nenhum método daqui ESTOURA. Todos devolvem `{ ok }`.
//
// ── E OS IDS FICAM DO NOSSO LADO ─────────────────────────────────────────
//
// `recurrences.gateway = { tipo, ambiente, cliente, assinatura, criadoEm }`.
// É o que deixa o aviso do webhook achar a recorrência, e o que deixa alguém
// abrir a tela do Asaas meses depois e saber de quem é aquela assinatura.
function Cobrador_model(app) {
  this.app = app;
}

// O endereço onde o gateway vem bater. A INSTÂNCIA vai no caminho porque o
// aviso chega sem sessão: é ela que diz em qual banco procurar a recorrência.
//
// Não é segredo (o segredo é o `authToken` do cabeçalho) — é endereçamento.
//
// ── E A UNIDADE, QUANDO A CONTA É DE UMA FILIAL ────────────────────────────
//
// Cada filial pode ter a conta de Asaas dela, e portanto o segredo dela. O
// aviso precisa dizer DE QUAL CONTA veio, senão conferimos o token contra a
// linha errada e recusamos um webhook legítimo.
//
// Repare que é a unidade DO GATEWAY, não a do aluno: uma filial que herdou o
// gateway da casa cobra pela conta da casa, e o aviso dela chega na URL da
// casa. Ver `PaymentGateway_model.ativo`.
//
// Sem a unidade, a URL é a de três segmentos de sempre — é o que mantém
// válidos os webhooks já registrados no Asaas antes desta mudança.
Cobrador_model.prototype.urlDoWebhook = function (instancia, tipo, unidade) {
  const base = `${dominio.apiBaseUrl()}/public/gateway-webhook/${tipo}/${instancia}`;
  return unidade ? `${base}/${unidade}` : base;
};

// ── REGISTRAR O AVISO DE PAGAMENTO ────────────────────────────────────────
//
// *"eu entrei lá, e não tem o webhook"* (15/10/2026), olhando a tela de
// Webhooks do Asaas depois de configurar a chave.
//
// E ele estava certo: até aqui o registro só acontecia DENTRO da primeira
// matrícula com "gerar no gateway". Sem nenhuma, não havia o que ver — e quem
// acabou de colar a chave não tem como saber se a integração está de pé a não
// ser matriculando alguém de verdade.
//
// Agora o registro acontece quando se CONECTA e quando se ATIVA o gateway,
// que são os dois momentos em que a casa diz "é por aqui que eu cobro". Ele
// continua acontecendo na matrícula também: é idempotente por URL, e o
// caminho que cobra não pode depender de alguém ter passado pela tela.
//
// ── O E-MAIL ────────────────────────────────────────────────────────────
//
// O Asaas pede um e-mail no webhook: é para onde ELE avisa quando a entrega
// falha e a fila é interrompida. Mandar `undefined` é o jeito de a chamada
// voltar 400 e o registro nunca existir — calado, porque isto é melhor
// esforço. Vai o e-mail do dono da conta.
Cobrador_model.prototype.registrarWebhook = async function (tipo, unidade, instancia) {
  // O TRY ABRAÇA TUDO, inclusive a leitura das credenciais. Este é um caminho
  // lateral: ele roda no meio de uma matrícula que já valeu, e nada aqui pode
  // estourar para cima. Deixar a busca de fora era um `await` a um método que
  // um dia não existe derrubando a assinatura inteira.
  try {
    const credenciais = await this.app.api.paymentGateway.paraRegistrarWebhook(tipo, unidade);
    if (!credenciais) return { ok: false, erro: "nao_configurado" };

    const gateway = gateways.de(tipo);
    if (!gateway?.cobranca?.garantirWebhook) return { ok: false, erro: "gateway_nao_cobra" };

    const casa = instancia || instanceContext.current();

    const r = await gateway.cobranca.garantirWebhook({
      chave: credenciais.chave,
      ambiente: credenciais.ambiente,
      url: this.urlDoWebhook(casa, tipo, unidade ? String(unidade) : ""),
      segredo: credenciais.segredo,
      email: await this.emailDoDono(),
    });

    if (r.ok) await this.app.api.paymentGateway.marcarWebhook(tipo, unidade);
    return r;
  } catch (erro) {
    console.error("[cobrador] webhook falhou:", erro?.message || erro);
    return { ok: false, erro: "fora_do_ar" };
  }
};

// ── E TIRAR O AVISO DE LÁ QUANDO A CHAVE SAI ──────────────────────────────
//
// *"quando eu excluí a chave deveria excluir o webhook lá"* (15/10/2026).
//
// Chamado ANTES de apagar a linha, e a ordem é a coisa toda: é a chave que
// autentica a remoção. Depois de apagada, não há mais como falar com o
// gateway — o webhook ficaria lá para sempre, levando 401 a cada aviso até o
// Asaas interromper a fila da conta inteira.
//
// Como tudo neste modelo, não estoura: desligar um gateway não pode falhar
// porque a internet caiu. Quem chama recebe o `{ ok }` e decide o que dizer.
Cobrador_model.prototype.removerWebhook = async function (tipo, unidade, instancia) {
  try {
    const credenciais = await this.app.api.paymentGateway.paraRegistrarWebhook(tipo, unidade);
    if (!credenciais) return { ok: true, nada: true };

    const gateway = gateways.de(tipo);
    if (!gateway?.cobranca?.apagarWebhook) return { ok: true, nada: true };

    const casa = instancia || instanceContext.current();

    return await gateway.cobranca.apagarWebhook({
      chave: credenciais.chave,
      ambiente: credenciais.ambiente,
      url: this.urlDoWebhook(casa, tipo, unidade ? String(unidade) : ""),
    });
  } catch (erro) {
    console.error("[cobrador] remoção do webhook falhou:", erro?.message || erro);
    return { ok: false, erro: "fora_do_ar" };
  }
};

// Para onde o Asaas avisa que a entrega do webhook falhou. O dono da conta é
// quem pode fazer algo a respeito.
Cobrador_model.prototype.emailDoDono = async function () {
  try {
    const dono = await this.app.api.tenant.ownerId();
    const user = dono ? await this.app.api.user.data(dono) : null;
    return user?.email || "";
  } catch {
    return "";
  }
};

// ── ASSINAR ───────────────────────────────────────────────────────────────
//
// Devolve `{ ok: true, pagamento }` quando deu, e `{ ok: false, erro }` quando
// não — com `erro` no nosso vocabulário, nunca o texto cru do gateway.
//
// `pagamento` pode ser `null` com `ok: true`, e isso é um estado NORMAL: o
// Asaas cria a fatura logo depois da assinatura, e "logo depois" às vezes é
// depois da nossa resposta. A assinatura existe, o webhook avisa, e o e-mail
// dele leva o link. A tela trata esse caso.
Cobrador_model.prototype.assinar = async function ({
  instancia,
  pessoa,
  plano,
  recorrencia,
  // A unidade ONDE A PESSOA SE MATRICULOU. É por ela que se escolhe a conta
  // que vai cobrar: quem treina em Paraty paga na conta de Paraty, e o
  // dinheiro cai no CNPJ certo. Sem unidade (ou sem chave própria nela), é a
  // conta da casa — ver `paymentGateway.ativo`.
  unidade,
}) {
  const credenciais = await this.app.api.paymentGateway.ativo(unidade);
  if (!credenciais) return { ok: false, erro: "sem_gateway" };

  const gateway = gateways.de(credenciais.tipo);
  // Gateway configurado que não sabe cobrar — hoje, o Pagar.me. A tela não
  // deveria ter oferecido, e esta é a checagem que vale.
  if (!gateway?.cobranca) return { ok: false, erro: "gateway_nao_cobra" };

  const { chave, ambiente } = credenciais;

  try {
    const cliente = await gateway.cobranca.cliente({ chave, ambiente, pessoa });
    if (!cliente.ok) return { ok: false, erro: cliente.erro, detalhe: cliente.detalhe };

    // ── SE A PESSOA DEIXOU UM CARTÃO, A ASSINATURA COBRA NELE ──────────
    //
    // *"aba de cartão de crédito para colocar os cartões para pagar as
    // faturas que a unidade gerar"* (16/10/2026). É aqui que o cartão
    // guardado vira cobrança: com o token, o Asaas debita sozinho a cada
    // ciclo em vez de abrir uma fatura e esperar alguém pagar.
    //
    // Pelo TRIO (pessoa, tipo do gateway, unidade da conta): um token nasceu
    // para um cliente de uma conta, e tentá-lo em outra volta recusado na
    // frente do aluno. Não achar é o resultado certo — a fatura sai do jeito
    // de sempre, que é o que já acontecia ontem.
    const cartao = await this.app.api.cartaoSalvo?.paraCobrar?.(pessoa.id, {
      tipo: credenciais.tipo,
      unidade: credenciais.unidade || "",
    });

    const assinatura = await gateway.cobranca.assinatura({
      chave,
      ambiente,
      cliente: cliente.id,
      plano,
      recorrencia,
      cartao: cartao?.token || "",
    });
    if (!assinatura.ok) return { ok: false, erro: assinatura.erro, detalhe: assinatura.detalhe };

    // Os ids ANTES da fatura, e antes do webhook. Se o processo morrer da
    // próxima linha em diante, a assinatura já existe nos dois lados e o
    // vínculo está gravado — que é o que torna tudo recuperável. Gravar por
    // último deixaria uma assinatura cobrando lá sem dono aqui.
    await this.app.api.recurrence.marcarNoGateway(recorrencia, {
      tipo: credenciais.tipo,
      ambiente,
      cliente: cliente.id,
      assinatura: assinatura.id,
    });

    // Melhor esforço: sem webhook o dinheiro ainda entra, só não fecha a
    // cobrança sozinho. Derrubar a assinatura por causa disso seria trocar um
    // problema pequeno por um grande.
    //
    // `credenciais.unidade` e não `unidade`: o webhook tem de voltar para a
    // conta que EMITIU a cobrança, que pode ser a da casa mesmo quando a
    // pessoa se matriculou numa filial.
    await this.registrarWebhook(credenciais.tipo, credenciais.unidade || "", instancia);

    const fatura = await gateway.cobranca.primeiraFatura({
      chave,
      ambiente,
      assinatura: assinatura.id,
    });

    return { ok: true, assinatura: assinatura.id, pagamento: fatura.ok ? fatura.fatura : null };
  } catch (erro) {
    // A rede do gateway não é problema de quem acabou de se matricular.
    console.error("[cobrador] assinatura falhou:", erro?.message || erro);
    return { ok: false, erro: "fora_do_ar" };
  }
};

// ── O AVISO QUE CHEGA ─────────────────────────────────────────────────────
//
// Já autenticado e já dentro do contexto da instância — quem faz as duas
// coisas é o controlador, porque as duas são decisões de porta de entrada.
//
// Aqui só mora a pergunta "o que isto quer dizer para as nossas cobranças".
Cobrador_model.prototype.aplicarAviso = async function (tipo, corpo, { t } = {}) {
  const gateway = gateways.de(tipo);
  if (!gateway?.cobranca?.ler) return { ok: false, erro: "gateway_nao_cobra" };

  const aviso = gateway.cobranca.ler(corpo);

  // Só os que MUDAM alguma coisa deste lado. PAYMENT_CREATED e PAYMENT_OVERDUE
  // chegam, são reconhecidos (200, senão o Asaas reenvia para sempre) e não
  // fazem nada: a cobrança equivalente aqui já nasceu em aberto, e "vencida" é
  // uma conta de data que esta casa faz sozinha.
  if (!aviso.pago && !aviso.desfeito && !aviso.encerrada && !aviso.situacao && !aviso.atualizado) {
    return { ok: true, feito: "ignorado", evento: aviso.evento };
  }

  const regra = await this.recorrenciaDoAviso(aviso);

  // ── OU É PARCELA DE UM CARNÊ ──────────────────────────────────────────
  //
  // *"quando cria o parcelamento no asaas ele gera uma fatura para cada, aí
  // vem via webhook"* (17/10/2026).
  //
  // Um carnê não tem assinatura do outro lado: cada parcela é uma fatura
  // solta, amarrada às irmãs pelo `installment`. Sem este caminho, todo aviso
  // de parcela caía em "sem_dono" — o dinheiro entrava no Asaas e a cobrança
  // daqui ficava aberta para sempre, calada.
  const daParcela = regra ? null : await this.parcelaDoAviso(aviso, { palpite: aviso.pago });
  if (!regra && !daParcela) return { ok: true, feito: "sem_dono", evento: aviso.evento };

  // ── CANCELARAM A ASSINATURA LÁ ────────────────────────────────────────
  //
  // A regra daqui para de gerar. Sem isto ela continuaria criando mensalidade
  // todo mês para quem não tem mais assinatura nenhuma — e calada, porque do
  // nosso lado nada mudou.
  //
  // As cobranças JÁ GERADAS ficam: elas têm pagamento e história, e apagar o
  // passado junto com o combinado seria apagar o caixa. É a mesma regra do
  // botão de cancelar da tela.
  if (aviso.encerrada && regra) {
    await this.app.api.recurrence.update(String(regra._id), {
      status: statusDeRecorrencia.CANCELADA,
      canceledReason: motivoDoCancelamento(t),
    });
    return { ok: true, feito: "encerrada", evento: aviso.evento, recorrencia: String(regra._id) };
  }

  // O PALPITE — "a mais antiga em aberto" — existe para achar o que PAGAR, e
  // só serve a isso. Num estorno ele reabriria uma cobrança que ninguém
  // pagou; numa etiqueta de situação, carimbaria "recusado" na cobrança
  // errada. Fora do caminho do pagamento, ou é a cobrança exata ou é nenhuma.
  const cobranca = daParcela || (await this.cobrancaDoAviso(regra, aviso, { palpite: aviso.pago }));
  if (!cobranca) return { ok: true, feito: "sem_cobranca", evento: aviso.evento };

  // O ID DA FATURA FICA GRAVADO na primeira vez que um aviso dela nos
  // encontra. Daí em diante, todo aviso daquela fatura acha esta cobrança por
  // identidade — e não por vencimento, que deixa de casar no instante em que
  // alguém muda a data pelo painel do Asaas.
  if (aviso.pagamento && String(cobranca.gateway?.pagamento || "") !== aviso.pagamento) {
    await this.app.api.finance.marcarNoGateway(String(cobranca._id), {
      pagamento: aviso.pagamento,
    });
  }

  // ── O QUE ESTÁ ACONTECENDO LÁ FORA ────────────────────────────────────
  //
  // Autorizado, em análise, recusado, estornando. Nenhum é dinheiro na conta,
  // então nenhum encosta em `status`: a cobrança continua em aberto e ganha
  // ao lado a explicação de por que ainda não baixou.
  if (aviso.situacao) {
    await this.app.api.finance.marcarNoGateway(String(cobranca._id), {
      pagamento: aviso.pagamento,
      situacao: aviso.situacao,
    });
    return {
      ok: true,
      feito: "situacao",
      situacao: aviso.situacao,
      evento: aviso.evento,
      cobranca: String(cobranca._id),
    };
  }

  // Mexeram no vencimento ou no valor lá. O modelo recusa sozinho quando a
  // cobrança já tem dinheiro dentro — reescrever o valor de uma cobrança paga
  // transformaria uma quitação em pagamento parcial sem ninguém mexer nela.
  if (aviso.atualizado) {
    const r = await this.app.api.finance.ajustarDoGateway(String(cobranca._id), {
      vencimento: aviso.vencimento,
      valor: aviso.valor,
    });
    return {
      ok: true,
      feito: r?.mexeu ? "ajustada" : "sem_ajuste",
      evento: aviso.evento,
      cobranca: String(cobranca._id),
    };
  }

  // ── O DINHEIRO VOLTOU, OU NUNCA FOI ───────────────────────────────────
  //
  // Estorno, chargeback, "recebido em dinheiro" desfeito. `reabrirCobranca`
  // apaga o pagamento automático que o webhook criou e REFAZ a conta — se
  // ainda houver pagamento de gente cobrindo o valor, ela continua paga.
  if (aviso.desfeito) {
    const r = await this.app.api.finance.reabrirCobranca(String(cobranca._id));
    return {
      ok: true,
      feito: r?.manual ? "parciais_a_mao" : "reaberta",
      evento: aviso.evento,
      cobranca: String(cobranca._id),
    };
  }

  const r = await this.app.api.finance.quitarCobranca(String(cobranca._id), {
    // A forma com que o Asaas emite é sempre uma das três do catálogo; na
    // dúvida, "outra" — melhor que inventar uma chave que o relatório não
    // conhece.
    method: FORMAS[String(corpo?.payment?.billingType || "")] || "other",
    // Quem fica como autor da baixa: quem criou a assinatura. Num carnê não
    // há regra — a baixa fica sem autor, que é o honesto: foi o gateway.
    createdBy: regra?.createdBy || null,
  });

  return { ok: true, feito: r.erro === "ja_pago" ? "ja_estava_pago" : "quitada", cobranca: String(cobranca._id) };
};

// O motivo que fica na ficha, para quem abrir meses depois. Traduzido quando
// há com quê: este caminho vem de um webhook, e o `t` dele é o do idioma da
// instância — não o de um navegador que não existe.
function motivoDoCancelamento(t) {
  const chave = "finance.recurrenceCanceledAtGateway";
  const texto = t ? t(chave) : chave;
  return texto === chave ? "Assinatura cancelada no gateway." : texto;
}

// A forma do Asaas para a chave do nosso catálogo de `payment_methods`.
const FORMAS = {
  PIX: "pix",
  BOLETO: "billet",
  CREDIT_CARD: "credit",
  DEBIT_CARD: "debit",
  TRANSFER: "transfer",
};

// De qual recorrência é este aviso.
//
// DUAS chaves, nesta ordem, e a segunda existe porque a primeira pode faltar:
// o Asaas nem sempre copia o `externalReference` da assinatura para a fatura.
// O id da assinatura, esse, vem sempre.
Cobrador_model.prototype.recorrenciaDoAviso = async function (aviso) {
  const col = await this.app.api.recurrence.collection();

  if (aviso.assinatura) {
    const porAssinatura = await col.findOne({ "gateway.assinatura": aviso.assinatura });
    if (porAssinatura) return porAssinatura;
  }

  if (ObjectId.isValid(aviso.recorrencia)) {
    return col.findOne({ _id: new ObjectId(aviso.recorrencia) });
  }

  return null;
};

// Qual cobrança NOSSA este pagamento quita.
//
// ── Por que não basta procurar pelo período ──────────────────────────────
//
// O par `(recurrence, periodo)` é a identidade de uma mensalidade aqui, e
// `periodo` é o vencimento em ISO — o mesmo dia que o Asaas chama de
// `dueDate`. No caminho feliz eles casam exatos.
//
// Só que a cobrança daquele mês pode AINDA NÃO EXISTIR: ela nasce de
// `gerar()`, que roda na leitura do financeiro e no tique diário. Um pagamento
// adiantado chega antes. Por isso geramos antes de desistir.
//
// E sobra o caso torto: o dono do Asaas mudou o vencimento de uma fatura pela
// tela deles, e aí nenhum período casa. Deixar o dinheiro sem baixa seria o
// pior desfecho — a mais antiga em aberto é o palpite certo, porque é
// exatamente a que a pessoa estava pagando.
// ── A PARCELA DE UM CARNÊ, pelo aviso dela ───────────────────────────────
//
// Quatro tentativas, da certeza ao palpite — e o palpite só vale para quem
// veio PAGAR, como no caminho da assinatura: num estorno ele reabriria a
// parcela errada.
//
// 1. O ID DA FATURA. Carimbado logo depois de criar o carnê (ver
//    `casarParcelasComOGateway`), então na prática é sempre este.
// 2. O NÚMERO da parcela, quando o Asaas o manda. Nem toda conta manda.
// 3. O VENCIMENTO, dentro do grupo. Deixa de casar se alguém mudar a data
//    pelo painel deles — por isso vem depois das duas de cima.
// 4. A mais antiga em aberto do grupo.
Cobrador_model.prototype.parcelaDoAviso = async function (aviso, { palpite = true } = {}) {
  if (!aviso.parcelamento) return null;

  const cobrancas = await this.app.api.finance.charges();

  if (aviso.pagamento) {
    const porId = await cobrancas.findOne({ "gateway.pagamento": aviso.pagamento });
    if (porId) return porId;
  }

  const grupo = { "gateway.parcelamento": String(aviso.parcelamento) };

  if (aviso.parcelaN) {
    const pelaPosicao = await cobrancas.findOne({ ...grupo, parcela: aviso.parcelaN });
    if (pelaPosicao) return pelaPosicao;
  }

  if (aviso.vencimento) {
    // O DIA inteiro: o vencimento vem "YYYY-MM-DD" e o nosso é um `Date`
    // com hora. Comparar por igualdade não casaria nunca.
    const inicio = new Date(`${aviso.vencimento}T00:00:00.000Z`);
    const fim = new Date(`${aviso.vencimento}T23:59:59.999Z`);
    if (!Number.isNaN(inicio.getTime())) {
      const pelaData = await cobrancas.findOne({ ...grupo, dueDate: { $gte: inicio, $lte: fim } });
      if (pelaData) return pelaData;
    }
  }

  if (!palpite) return null;

  return cobrancas.findOne({ ...grupo, status: "open" }, { sort: { dueDate: 1 } });
};

Cobrador_model.prototype.cobrancaDoAviso = async function (regra, aviso, { palpite = true } = {}) {
  const cobrancas = await this.app.api.finance.charges();

  // ── PRIMEIRO O ID DA FATURA ─────────────────────────────────────────────
  //
  // Esta é a única busca que não é um palpite: foi gravada na primeira vez
  // que um aviso desta fatura chegou. Ela é o que mantém a conversa certa
  // depois de alguém mudar o vencimento pelo painel do Asaas — a partir daí
  // nenhum `periodo` casa, e sem isto todo aviso seguinte cairia no chute.
  if (aviso.pagamento) {
    const porId = await cobrancas.findOne({ "gateway.pagamento": aviso.pagamento });
    if (porId) return porId;
  }

  const exata = aviso.vencimento
    ? await cobrancas.findOne({ recurrence: regra._id, periodo: aviso.vencimento })
    : null;
  if (exata) return exata;

  await this.app.api.recurrence.gerar({ recurrence: String(regra._id) });

  const depois = aviso.vencimento
    ? await cobrancas.findOne({ recurrence: regra._id, periodo: aviso.vencimento })
    : null;
  if (depois) return depois;

  // O palpite, e só para quem veio pagar. Ver `aplicarAviso`.
  if (!palpite) return null;

  return cobrancas.findOne({ recurrence: regra._id, status: "open" }, { sort: { dueDate: 1 } });
};

module.exports = Cobrador_model;
