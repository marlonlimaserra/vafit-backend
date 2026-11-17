// O ASAAS.
//
// ── DOIS HOSTS, E A CHAVE DIZ QUAL ────────────────────────────────────────
//
// O Asaas tem dois sistemas separados, cada um no seu endereço, e uma chave
// vale num só. Não há nada DENTRO da chave que diga qual — testei a do Marlon
// em 10/10/2026: 401 no sandbox, 200 na produção.
//
// Por isso não existe seletor de ambiente na tela. Ver o LEIA-ME: perguntar
// seria aceitar que alguém marcasse "sandbox" numa chave de produção, e aí o
// primeiro boleto gerado para testar é um boleto de verdade, com o nome da
// casa, na mão de um aluno.
const BASES = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  producao: "https://api.asaas.com/v3",
};

const HOSTS = [
  // O sandbox vem PRIMEIRO de propósito. Se um dia os dois respondessem à
  // mesma chave, a leitura segura é "isto é teste" — e não "pode cobrar".
  { ambiente: "sandbox", base: BASES.sandbox },
  { ambiente: "producao", base: BASES.producao },
];

// O mesmo teto da Stripe (`lib/stripe.js`). Sem ele, um gateway lento segura a
// requisição até o navegador desistir, e a pessoa não sabe se salvou.
const TIMEOUT_MS = 12000;

// ── DAQUI PARA BAIXO, O ASAAS COBRA ──────────────────────────────────────
//
// *"se essa opção tiver marcada, em vez de falar que a unidade vai entrar em
// contato, já gera o cadastro dele no gateway e cria a recorrência direto lá,
// e salve os ids do nosso lado, pois o Asaas vai criar o pagamento lá e vai
// enviar ele via webhook. Aí já abre os dados para o cliente pagar direto
// ali"* (14/10/2026).
//
// Até hoje esta pasta só CONFERIA chave. Isto é a primeira vez que o produto
// movimenta dinheiro de um cliente pela conta dele.

// A conversa com o Asaas num lugar só.
//
// O `erro` nunca ESTOURA: quem chama está no meio de uma matrícula que já foi
// gravada, e uma exceção ali desfaria na tela o que existe no banco. Falhar
// aqui tem de virar "a matrícula valeu, o pagamento sai por outro caminho".
async function pedir(base, chave, caminho, { metodo = "GET", corpo, buscar = fetch } = {}) {
  let res;

  try {
    res = await buscar(base + caminho, {
      method: metodo,
      headers: {
        access_token: chave,
        "User-Agent": "VAFIT",
        ...(corpo ? { "Content-Type": "application/json" } : {}),
      },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, erro: "fora_do_ar" };
  }

  const dados = await res.json().catch(() => ({}));

  if (res.status === 401 || res.status === 403) return { ok: false, erro: "chave_invalida" };
  if (!res.ok) {
    // O Asaas devolve `errors: [{ code, description }]`. A descrição dele é em
    // português e costuma ser exata ("CPF/CNPJ inválido") — melhor do que
    // qualquer frase nossa, que teria de adivinhar o motivo.
    return { ok: false, erro: "recusado", detalhe: dados?.errors?.[0]?.description || "" };
  }

  return { ok: true, dados };
}

// AS CADÊNCIAS, do nosso catálogo para o deles.
//
// `lib/recorrencia.js` é quem manda — é de lá que sai o `cadencia` gravado na
// regra. Uma cadência nossa sem par aqui NÃO vira "mensal por padrão": cobrar
// alguém todo mês quando o combinado era trimestral é o tipo de erro que só
// aparece na fatura do aluno.
const CICLOS = {
  weekly: "WEEKLY",
  biweekly: "BIWEEKLY",
  monthly: "MONTHLY",
  bimonthly: "BIMONTHLY",
  quarterly: "QUARTERLY",
  semiannual: "SEMIANNUALLY",
  annual: "YEARLY",
};

// AS FORMAS, do nosso catálogo para o deles — e só as três que o Asaas emite.
const FORMAS = { pix: "PIX", billet: "BOLETO", credit: "CREDIT_CARD" };

// ── OS AVISOS QUE ASSINAMOS, E O QUE CADA UM FAZ ──────────────────────────
//
// *"faltou todos esses"* (15/10/2026), olhando a tela de eventos do Asaas com
// as dezenas de caixas desmarcadas.
//
// A lista não é "tudo que existe lá", e a razão é o `sendType: SEQUENTIALLY`:
// os avisos chegam UM POR VEZ, na ordem. Assinar "boleto visualizado" e
// "checkout visualizado" põe o aviso de pagamento ATRÁS deles na fila — uma
// conta movimentada atrasaria a baixa por causa de eventos que não mexem em
// nada aqui.
//
// Então a régua é: assinamos o que MUDA alguma coisa deste lado, mais os dois
// que contam a história de uma cobrança (criada, vencida). O resto fica de
// fora até ter o que fazer com ele.
//
// PAGAM: RECEIVED é "caiu na conta", CONFIRMED é "o cartão autorizou, cai no
// repasse". Do lado do aluno os dois querem dizer "paguei", e os dois fecham
// a cobrança aqui.
const PAGAM = ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"];

// DESFAZEM: o dinheiro voltou, ou nunca foi. Todos reabrem a cobrança —
// `reabrirCobranca` apaga o pagamento automático e refaz a conta.
//
// O estorno PARCIAL fica de fora de propósito: reabrir a cobrança inteira
// porque R$ 10 de R$ 150 voltaram faria a casa cobrar os R$ 150 de novo. Esse
// caso é ajuste à mão, e é raro o bastante para não valer um desenho torto.
const DESFAZEM = [
  "PAYMENT_REFUNDED",
  "PAYMENT_DELETED",
  "PAYMENT_RECEIVED_IN_CASH_UNDONE",
  "PAYMENT_CHARGEBACK_REQUESTED",
];

// ENCERRAM: cancelaram a assinatura lá. Sem isto a regra daqui continuaria
// gerando mensalidade todo mês para quem não tem mais assinatura nenhuma — e
// calada, porque nada no nosso lado mudou.
const ENCERRAM = ["SUBSCRIPTION_DELETED", "SUBSCRIPTION_INACTIVATED"];

// ── OS QUE CONTAM O QUE ESTÁ ACONTECENDO LÁ ──────────────────────────────
//
// *"PAYMENT_AUTHORIZED, PAYMENT_AWAITING_RISK_ANALYSIS,
// PAYMENT_REPROVED_BY_RISK_ANALYSIS, PAYMENT_UPDATED,
// PAYMENT_REFUND_IN_PROGRESS deveria tratar esses também"* (15/10/2026).
//
// Nenhum é dinheiro na conta, então nenhum mexe em `status` — eles viram a
// SITUAÇÃO NO GATEWAY da cobrança (ver `lib/situacaoNoGateway.js`), que é
// quem responde "por que isto ainda não baixou".
//
// O APPROVED entra junto mesmo sem ter sido pedido: ele é a outra metade da
// chave. Sem ele, a cobrança que passou pela análise ficaria para sempre
// marcada como "em análise".
const SITUACOES = {
  PAYMENT_AUTHORIZED: "autorizado",
  PAYMENT_AWAITING_RISK_ANALYSIS: "em_analise",
  PAYMENT_APPROVED_BY_RISK_ANALYSIS: "aprovado",
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: "recusado",
  PAYMENT_REFUND_IN_PROGRESS: "estornando",
};

// ── E O RESTO: OUVIDOS, E NADA MAIS ───────────────────────────────────────
//
// Eu assinei primeiro só o que a casa TRATA, e disse a razão: a fila é
// `SEQUENTIALLY`, então todo evento inútil entra na frente de um útil. A
// própria tela do Asaas diz isso em cima da lista ("quanto menos eventos,
// maior a eficiência do envio").
//
// Ele pediu duas vezes a lista inteira — *"faltou todos esses"*, *"cadastrei
// de novo, e de novo veio tudo desmarcado"* (15/10/2026). A conta é dele, o
// volume é dele, e a decisão é dele: ficam todos.
//
// O que torna isso seguro é o `ler`: evento que não cai em PAGAM, DESFAZEM
// ou ENCERRAM vira "ignorado" e responde 200. Nada aqui tenta adivinhar o
// que fazer com um "boleto visualizado" — ele é recebido, reconhecido e
// esquecido. O custo é fila, não comportamento.
//
// Quando algum deles virar regra, ele SOBE para uma das três listas de cima;
// estar aqui embaixo é a marca de "chega e não faz nada".
const OUVIDOS = [
  // Cartão: a captura recusada é informação do cartão, não da cobrança — o
  // aluno tenta de novo e o Asaas manda um evento novo.
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
  // A cobrança mexida lá: restauração e antecipação.
  "PAYMENT_RESTORED",
  "PAYMENT_ANTICIPATED",
  // Estorno em outras fases. O PARCIAL é ouvido e não tratado de propósito:
  // reabrir a cobrança inteira porque R$ 10 de R$ 150 voltaram faria a casa
  // cobrar os R$ 150 de novo.
  "PAYMENT_REFUND_DENIED",
  "PAYMENT_PARTIALLY_REFUNDED",
  // Chargeback depois do pedido — a baixa já foi desfeita no pedido.
  "PAYMENT_CHARGEBACK_DISPUTE",
  "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
  // Negativação e boleto.
  "PAYMENT_DUNNING_RECEIVED",
  "PAYMENT_DUNNING_REQUESTED",
  "PAYMENT_BANK_SLIP_CANCELLED",
  "PAYMENT_BANK_SLIP_VIEWED",
  "PAYMENT_CHECKOUT_VIEWED",
  // Split: a casa não divide recebimento hoje.
  "PAYMENT_SPLIT_CANCELLED",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK",
  "PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED",
  "PAYMENT_SPLIT_DONE",
  // Assinatura: criada e alterada são eco do que NÓS fizemos lá.
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_SPLIT_DISABLED",
  "SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK",
  "SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK_FINISHED",
];

// `Set` porque a lista é escrita à mão em quatro pedaços: um nome repetido
// aqui viraria um 400 do Asaas no registro, e o registro é melhor esforço —
// ou seja, falharia calado.
const EVENTOS = [
  ...new Set([
    // Os dois que só contam a história: a cobrança nasceu, a cobrança venceu.
    "PAYMENT_CREATED",
    "PAYMENT_OVERDUE",
    ...PAGAM,
    ...DESFAZEM,
    ...ENCERRAM,
    ...Object.keys(SITUACOES),
    // Mexeram no vencimento ou no valor lá. Tem tratamento próprio: não é um
    // estado, é uma mudança a copiar.
    "PAYMENT_UPDATED",
    ...OUVIDOS,
  ]),
];

// Qual forma mandar para o Asaas, a partir do que o plano permite.
//
// `UNDEFINED` é a escolha certa quando há mais de uma: ele faz o Asaas abrir
// uma fatura em que o PRÓPRIO ALUNO escolhe entre pix, boleto e cartão. Fixar
// uma forma aqui seria decidir por ele o que o plano deixou em aberto.
//
// Com uma só, manda aquela: uma fatura que oferece três jeitos de pagar quando
// a casa aceita um é uma promessa que o caixa dela não cumpre.
//
// "Dinheiro" e "transferência" não existem para o Asaas — são formas de quem
// paga na recepção. Um plano que aceita SÓ essas não tem o que gerar lá, e
// devolver "UNDEFINED" seria abrir uma fatura oferecendo pix e boleto numa
// casa que disse aceitar só dinheiro. Por isso o `null`, que vira recusa.
//
// Lista VAZIA é "todas as formas ativas" (ver `Membership_model`), e aí o
// aberto é exatamente o que se quer.
function formaDeCobranca(formasDoPlano) {
  if (!(formasDoPlano || []).length) return "UNDEFINED";

  const unicas = [...new Set(formasDoPlano.map((k) => FORMAS[k]).filter(Boolean))];
  if (!unicas.length) return null;

  return unicas.length === 1 ? unicas[0] : "UNDEFINED";
}

// O dia como o Asaas o escreve: YYYY-MM-DD, sem hora e sem fuso.
const diaISO = (d) => new Date(d).toISOString().slice(0, 10);

// Só dígitos: o Asaas recusa "(21) 99999-0000" e aceita "21999990000".
const soDigitos = (v) => String(v || "").replace(/\D/g, "");

// O ano com quatro dígitos. O cartão vem impresso com dois ("05/29") e o
// formulário aceita os dois jeitos; "29" mandado cru é um cartão que venceu
// no governo Washington Luís.
const anoCompleto = (v) => {
  const so = soDigitos(v);
  return so.length === 2 ? String(2000 + Number(so)) : so;
};

module.exports = {
  chave: "asaas",
  nome: "Asaas",
  ondePegar: "https://www.asaas.com/customerApiAccessToken/index",
  // Toda chave do Asaas começa assim. Serve para recusar um campo colado
  // torto ANTES de bater na rede — e para não mandar à toa, numa API de
  // terceiro, o que a pessoa colou por engano (uma senha, por exemplo).
  formato: /^\$aact_[A-Za-z0-9+/=_-]{20,}$/,

  // ── ESTE GATEWAY SABE GUARDAR CARTÃO ─────────────────────────────────
  //
  // *"coloque um checkbox, 'tokenização de cartão ativo' no asaas, pelo
  // menos, eles precisam pedir para ativar, aí, se ativar, conseguimos
  // tokerizar o cartão de crédito para pagar faturas"* (16/10/2026).
  //
  // `tokeniza` é CAPACIDADE, e não estado: diz que existe tokenização neste
  // gateway, logo que faz sentido perguntar à casa se a conta dela tem a
  // função liberada. Quem não tem a bandeira não ganha a caixa — o Pagar.me
  // tokeniza pelo lado do navegador, com a chave pública, e isso é outro
  // desenho (ver a recusa `gatewayWrongKeyType`).
  //
  // O ESTADO mora na linha do banco (`tokenizacao`), por gateway e por
  // unidade: são contas diferentes, e a filial pode ter pedido a liberação
  // sem a casa ter pedido.
  tokeniza: true,

  // ── O QUE ELE SABE EMITIR ────────────────────────────────────────────
  //
  // *"se tiver com asaas pendente, só pode ter pix, cartão de crédito,
  // boleto e qualquer forma"* (18/10/2026).
  //
  // As chaves são as NOSSAS (ver `FORMAS`, logo acima do `catalogo`), e é o
  // servidor que as diz: dinheiro, transferência e cheque existem no catálogo
  // da casa e NÃO existem aqui — são formas de quem paga na recepção.
  // Oferecê-las numa cobrança que já virou fatura seria prometer um boleto
  // "em dinheiro", que ninguém tem como emitir.
  //
  // Lista e não `true`: o Mercado Pago de amanhã emite outro conjunto, e a
  // tela não pode aprender o nome de nenhum deles.
  formas: Object.keys(FORMAS),

  // ── QUAL DAS NOSSAS FORMAS ELE DEBITA DE UM CARTÃO GUARDADO ──────────
  //
  // *"se for cartão ou qualquer forma, mostre um botão cobrar"* (19/10/2026).
  //
  // A tela precisa saber em QUE cobranças o botão cabe, e a resposta é do
  // gateway: escrever `"credit"` no painel seria a tela decidindo o que só
  // quem cobra sabe — e a terceira marca, que talvez chame isto de outra
  // coisa, nasceria com o botão no lugar errado.
  formaDeCartao: "credit",

  async conferir(chave, buscar = fetch) {
    let ultimo = null;

    for (const { ambiente, base } of HOSTS) {
      let res;
      try {
        res = await buscar(`${base}/myAccount`, {
          headers: { access_token: chave, "User-Agent": "VAFIT" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        // Rede fora, DNS, estouro de tempo: não é a chave que está errada, e
        // dizer "chave inválida" aqui mandaria a pessoa trocar uma chave boa.
        ultimo = { ok: false, erro: "fora_do_ar" };
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        ultimo = { ok: false, erro: "chave_invalida" };
        continue;
      }

      if (!res.ok) {
        ultimo = { ok: false, erro: "fora_do_ar" };
        continue;
      }

      const conta = await res.json().catch(() => ({}));
      return {
        ok: true,
        ambiente,
        // O que a tela mostra para a pessoa reconhecer a conta. É MUITO melhor
        // que os seis últimos caracteres da chave: ninguém decora uma chave,
        // todo mundo reconhece o próprio nome e o próprio e-mail.
        conta: {
          nome: conta.name || conta.company || "",
          email: conta.email || "",
          documento: conta.cpfCnpj || "",
        },
      };
    }

    return ultimo || { ok: false, erro: "chave_invalida" };
  },

  // ── A PARTE QUE COBRA ──────────────────────────────────────────────────
  //
  // `cobranca` é OPCIONAL no contrato desta pasta: um gateway sem ela existe,
  // confere chave e aparece na tela — só não oferece "gerar no gateway". É o
  // caso do Pagar.me hoje. Ver o LEIA-ME.
  cobranca: {
    // A lista exposta para quem precisa falar dela — hoje, os testes e um dia
    // uma tela que mostre o que a casa escuta.
    EVENTOS,

    // ── O CLIENTE: PROCURA ANTES DE CRIAR ────────────────────────────────
    //
    // O Asaas aceita dois cadastros com o mesmo CPF sem reclamar. Criar
    // direto encheria a conta do Marlon de "Marlon Silva" repetidos, um por
    // plano assinado — e ele descobriria pela tela do Asaas, não pela nossa.
    //
    // A busca por CPF é a fonte da verdade, e não um id guardado aqui: um id
    // nosso apontando para um cliente apagado lá do outro lado falharia na
    // hora de cobrar, que é o pior momento.
    async cliente({ chave, ambiente, pessoa, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;
      const cpfCnpj = soDigitos(pessoa.documento);

      // ── SEM CPF/CNPJ VÁLIDO, NEM PROCURA (16/11/2026) ───────────────────
      //
      // A busca abaixo é `?cpfCnpj=<documento>`. Com o documento VAZIO ela vira
      // `?cpfCnpj=` — e uma lista sem filtro (ou filtrada por "sem CPF") devolve
      // OUTRO cliente da conta, o primeiro da página. A fatura nasceria no nome
      // de outra pessoa, e o Asaas mandaria o aviso para ela: cobrança errada e
      // dado de um aluno chegando a outro.
      //
      // 11 dígitos é CPF, 14 é CNPJ. Qualquer outra coisa não identifica
      // ninguém — e procurar por ela é pedir um palpite.
      if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
        return { ok: false, erro: cpfCnpj ? "documento_invalido" : "sem_documento" };
      }

      const achado = await pedir(base, chave, `/customers?cpfCnpj=${cpfCnpj}`, { buscar });
      if (!achado.ok) return achado;

      const jaTem = achado.dados?.data?.[0]?.id;
      if (jaTem) return { ok: true, id: jaTem, novo: false };

      const criado = await pedir(base, chave, "/customers", {
        metodo: "POST",
        buscar,
        corpo: {
          name: pessoa.nome,
          cpfCnpj,
          email: pessoa.email || undefined,
          mobilePhone: soDigitos(pessoa.telefone) || undefined,
          // O nosso id do lado deles. Serve para o Marlon abrir um cliente no
          // Asaas e saber qual aluno é — e para nós, se um dia precisarmos
          // reconciliar as duas bases sem depender do CPF.
          externalReference: String(pessoa.id || ""),
        },
      });

      if (!criado.ok) return criado;
      return { ok: true, id: criado.dados?.id, novo: true };
    },

    // ── A ASSINATURA ─────────────────────────────────────────────────────
    //
    // Ela é a REGRA do lado deles, igual à nossa recorrência: o Asaas passa a
    // emitir uma fatura por ciclo sozinho. Não é a primeira cobrança — essa
    // ele cria em seguida, e é dela que sai o link que a pessoa abre.
    //
    // `externalReference` é o id da NOSSA recorrência. É o fio que amarra as
    // duas pontas, e o que deixa um aviso perdido do webhook ser reconciliado
    // à mão depois, olhando a tela do Asaas.
    async assinatura({ chave, ambiente, cliente, plano, recorrencia, cartao, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      const cycle = CICLOS[plano.cadencia];
      // Cadência nossa sem par lá: recusa. Ver a nota em CICLOS — o padrão
      // silencioso aqui cobraria a pessoa na frequência errada.
      if (!cycle) return { ok: false, erro: "cadencia_sem_par" };

      // ── COM CARTÃO GUARDADO, A ASSINATURA JÁ NASCE NO CARTÃO ─────────
      //
      // *"aba de cartão de crédito para colocar os cartões para pagar as
      // faturas que a unidade gerar"* (16/10/2026). O token manda no
      // `billingType`: não adianta guardar o cartão e abrir uma fatura
      // "escolha como pagar" — o Asaas só cobra sozinho o que nasce como
      // CREDIT_CARD com token.
      //
      // E o token é do cliente: ele foi criado PARA este `customer`, e usá-lo
      // em outro é recusa na hora. Por isso quem chama resolve o cliente
      // antes, pelo mesmo caminho de sempre (busca por CPF).
      const billingType = cartao ? "CREDIT_CARD" : formaDeCobranca(plano.formasDePagamento);
      // Plano que só aceita dinheiro e transferência: não há fatura a emitir.
      // Ver `formaDeCobranca`.
      if (!billingType) return { ok: false, erro: "formas_nao_emitiveis" };

      const r = await pedir(base, chave, "/subscriptions", {
        metodo: "POST",
        buscar,
        corpo: {
          customer: cliente,
          billingType,
          // O Asaas fala em REAIS, com ponto decimal; nós guardamos centavos.
          value: Math.round(plano.amount) / 100,
          // HOJE. A pessoa acabou de clicar em "quero este plano" e a tela vai
          // abrir o pagamento na sequência — um vencimento para a semana que
          // vem faria o pix não existir ainda na hora de pagar.
          nextDueDate: diaISO(plano.primeiroVencimento || new Date()),
          cycle,
          description: plano.name,
          externalReference: String(recorrencia || ""),
          ...(cartao ? { creditCardToken: cartao } : {}),
        },
      });

      if (!r.ok) return r;
      return { ok: true, id: r.dados?.id };
    },

    // ── MEXERAM NELA AQUI: LEVA PARA LÁ ─────────────────────────────────
    //
    // *"quando editei a descrição, não editou no Asaas"* (18/10/2026).
    //
    // E ele está certo: o que o aluno lê é a fatura DELES. Trocar a descrição
    // só aqui deixa a tela dizendo uma coisa e o boleto outra — e quem
    // descobre é quem recebe o boleto.
    //
    // `PUT /payments/{id}`, com o que mudou. O Asaas recusa mexer em fatura
    // já paga ou estornada, e a recusa dele vem com a frase exata; quem chama
    // mostra essa frase em vez de inventar uma.
    async atualizar({ chave, ambiente, pagamento, cobranca, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;
      if (!pagamento) return { ok: false, erro: "sem_fatura" };

      const corpo = {};
      if (cobranca.valor != null) corpo.value = Math.round(cobranca.valor) / 100;
      if (cobranca.vencimento) corpo.dueDate = diaISO(cobranca.vencimento);
      if (cobranca.descricao !== undefined) corpo.description = cobranca.descricao || "";

      // A FORMA só vai quando o chamador falou dela. Mandá-la sempre tentaria
      // trocar o tipo de uma fatura que não mudou de tipo — e o Asaas recusa
      // isso em alguns estados, fazendo a edição da descrição falhar junto.
      if (cobranca.formasDePagamento) {
        const billingType = formaDeCobranca(cobranca.formasDePagamento);
        if (!billingType) return { ok: false, erro: "formas_nao_emitiveis" };
        corpo.billingType = billingType;
      }

      if (!Object.keys(corpo).length) return { ok: true, id: pagamento, link: "" };

      const r = await pedir(base, chave, `/payments/${pagamento}`, { metodo: "PUT", buscar, corpo });
      if (!r.ok) return r;

      return { ok: true, id: r.dados?.id || pagamento, link: r.dados?.invoiceUrl || "" };
    },

    // ── APAGAR A FATURA LÁ ───────────────────────────────────────────────
    //
    // *"eu removi a cobrança mas não removeu no asaas"* (18/10/2026) — e
    // enquanto ela existe lá, o aluno continua recebendo e podendo pagar uma
    // cobrança que esta casa já esqueceu. O dinheiro entraria numa conta sem
    // dono do lado de cá.
    //
    // `DELETE /payments/{id}`. O Asaas RECUSA apagar fatura já paga, e isso é
    // o certo: dinheiro recebido não se apaga, se estorna. Quem chama trata a
    // recusa como motivo para NÃO apagar aqui também.
    async apagar({ chave, ambiente, pagamento, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;
      if (!pagamento) return { ok: false, erro: "sem_fatura" };

      const r = await pedir(base, chave, `/payments/${pagamento}`, { metodo: "DELETE", buscar });
      if (!r.ok) return r;

      return { ok: true, apagada: r.dados?.deleted !== false };
    },

    // ── O CARNÊ INTEIRO, DE UMA VEZ ──────────────────────────────────────
    //
    // *"coloque a opção de cancelar e deletar parcelamento no asaas"*
    // (19/10/2026).
    //
    // `DELETE /installments/{id}` apaga o parcelamento E as parcelas dele que
    // ainda não foram pagas. É uma chamada no lugar de doze, e — mais
    // importante — é atômica do lado deles: apagar parcela por parcela pode
    // parar no meio e deixar metade de um carnê em pé, que é um estado que
    // ninguém sabe ler depois.
    //
    // As parcelas JÁ PAGAS continuam lá, e é o certo: dinheiro recebido não
    // se apaga. É também por isso que isto não é "estornar" — quem quer o
    // dinheiro de volta usa o estorno, parcela por parcela, de propósito.
    async apagarParcelamento({ chave, ambiente, parcelamento, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;
      if (!parcelamento) return { ok: false, erro: "sem_carne" };

      const r = await pedir(base, chave, `/installments/${parcelamento}`, {
        metodo: "DELETE",
        buscar,
      });
      if (!r.ok) return r;

      return { ok: true, apagada: r.dados?.deleted !== false };
    },

    // ── DEVOLVER O DINHEIRO ──────────────────────────────────────────────
    //
    // *"quando for cartão de crédito, reembolsar fatura"* (18/10/2026).
    //
    // `POST /payments/{id}/refund`, sem valor: estorno INTEIRO. O parcial
    // existe lá e não está aqui de propósito — devolver metade de um cartão
    // é uma decisão que precisa de um campo, uma confirmação e um registro,
    // e meio botão escondido num menu não é lugar para isso.
    //
    // O que acontece DEPOIS não é com esta função: o Asaas manda
    // `PAYMENT_REFUNDED` pelo webhook, e é ele que reabre a cobrança aqui.
    // Reabrir na resposta criaria o segundo caminho para o mesmo fato, e os
    // dois discordariam no dia em que o estorno fosse recusado depois de
    // aceito.
    async estornar({ chave, ambiente, pagamento, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;
      if (!pagamento) return { ok: false, erro: "sem_fatura" };

      const r = await pedir(base, chave, `/payments/${pagamento}/refund`, {
        metodo: "POST",
        buscar,
        corpo: {},
      });
      if (!r.ok) return r;

      return { ok: true, situacao: r.dados?.status || "" };
    },

    // ── O PARCELAMENTO: UM VALOR EM N VEZES ──────────────────────────────
    //
    // *"crie a aba parcelamento pois o asaas pode criar parcelamento
    // também"* (17/10/2026).
    //
    // É um POST em `/payments` com `installmentCount` e `installmentValue`.
    // O Asaas devolve UMA cobrança (a primeira) e cria as outras sozinho,
    // todas amarradas por um `installment` — o id do grupo, que é o que
    // guardamos para reconhecer as parcelas quando o webhook chegar.
    //
    // ── POR QUE `installmentValue` E NÃO `totalValue` ────────────────────
    //
    // Os dois existem lá. Com `totalValue` o Asaas divide, e a divisão de
    // R$ 100,00 em 3 dá três parcelas de 33,33 — somando 99,99. O centavo
    // que falta vira uma diferença entre o que a tela daqui promete e o que
    // o boleto cobra, e quem descobre é quem fecha o mês.
    //
    // Mandando o VALOR DA PARCELA, quem arredonda somos nós, uma vez só, e a
    // sobra vai para a PRIMEIRA — ver `Finance_model.parcelar`. O total daqui
    // e o de lá passam a ser o mesmo número.
    //
    // Não é o mesmo que assinatura: assinatura cobra para sempre e se cancela
    // para parar; parcelamento tem fim no dia em que nasce.
    // ── UMA COBRANÇA SÓ, GERADA LÁ ──────────────────────────────────────
    //
    // *"não deveria ter o checkbox de 'gera no gateway'? e aí já gera lá,
    // traz o link, traz tudo"* (18/10/2026).
    //
    // É o MESMO POST `/payments` do parcelamento, sem `installmentCount`: uma
    // fatura, um vencimento, um link. Quem quiser o carnê usa `parcelar`; as
    // duas conversam com a mesma rota de lá porque para o Asaas um carnê é
    // uma cobrança que se repete.
    //
    // O `externalReference` leva o id da cobrança DAQUI. É o fio que permite
    // reconhecer o dono do dinheiro mesmo que alguém mexa na data pelo painel
    // deles — e o id da fatura volta no `id`, que é o que de fato casa o
    // webhook (ver `Cobrador_model.aplicarAviso`).
    async avulsa({ chave, ambiente, cliente, cobranca, cartao, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      // ── COM O CARTÃO GUARDADO, ELA JÁ NASCE COBRADA ──────────────────
      //
      // Mesma regra da assinatura: o token manda no `billingType`. Uma
      // fatura "escolha como pagar" com token junto não cobra nada — o Asaas
      // só debita sozinho o que nasce CREDIT_CARD.
      const billingType = cartao ? "CREDIT_CARD" : formaDeCobranca(cobranca.formasDePagamento);
      if (!billingType) return { ok: false, erro: "formas_nao_emitiveis" };

      const r = await pedir(base, chave, "/payments", {
        metodo: "POST",
        buscar,
        corpo: {
          customer: cliente,
          billingType,
          // O Asaas fala em REAIS, com ponto decimal; nós guardamos centavos.
          value: Math.round(cobranca.valor) / 100,
          dueDate: diaISO(cobranca.vencimento || new Date()),
          description: cobranca.descricao || "",
          externalReference: String(cobranca.id || ""),
          ...(cartao ? { creditCardToken: cartao } : {}),
        },
      });

      if (!r.ok) return r;

      return {
        ok: true,
        id: r.dados?.id || "",
        // O que ela virou lá: com cartão isto chega `CONFIRMED` na hora, e é
        // o que separa "mandei cobrar" de "o cartão passou".
        situacao: r.dados?.status || "",
        // A página do Asaas com pix, boleto e cartão — a mesma que ele manda
        // por e-mail. É ela que a tela guarda para quem quiser reenviar.
        link: r.dados?.invoiceUrl || "",
      };
    },

    async parcelar({ chave, ambiente, cliente, parcela, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      const billingType = formaDeCobranca(parcela.formasDePagamento);
      if (!billingType) return { ok: false, erro: "formas_nao_emitiveis" };

      const r = await pedir(base, chave, "/payments", {
        metodo: "POST",
        buscar,
        corpo: {
          customer: cliente,
          billingType,
          installmentCount: Number(parcela.parcelas),
          // O Asaas fala em REAIS, com ponto decimal; nós guardamos centavos.
          installmentValue: Math.round(parcela.valorDaParcela) / 100,
          dueDate: diaISO(parcela.primeiroVencimento || new Date()),
          description: parcela.descricao || "",
          externalReference: String(parcela.grupo || ""),
        },
      });

      if (!r.ok) return r;

      return {
        ok: true,
        // O GRUPO lá, que é o que amarra as parcelas umas às outras. É por
        // ele que se pede a lista delas, e é o que o webhook de cada parcela
        // traz de volta.
        id: r.dados?.installment || "",
        // E a primeira, para quem quiser mandar a pessoa pagar agora.
        primeira: r.dados?.id || "",
        link: r.dados?.invoiceUrl || "",
      };
    },

    // ── AS FATURAS DE UM CARNÊ, uma por parcela ──────────────────────────
    //
    // *"quando cria o parcelamento no asaas ele gera uma fatura para cada, aí
    // vem via webhook"* (17/10/2026). O POST devolve só a primeira; as outras
    // onze nascem lá e cada uma tem id próprio.
    //
    // Buscar a lista logo depois de criar é o que permite CARIMBAR cada
    // parcela daqui com o id da fatura dela. Sem isso, o primeiro webhook de
    // cada uma chegaria sem saber a qual das doze pertence, e o casamento
    // viraria palpite por vencimento — que deixa de valer no instante em que
    // alguém muda uma data pelo painel do Asaas.
    //
    // `limit=100`: o teto do parcelamento aqui é 48, e a página padrão deles
    // é 10 — sem isto, um carnê de doze voltaria pela metade.
    async parcelasDoGrupo({ chave, ambiente, grupo, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      const r = await pedir(base, chave, `/payments?installment=${encodeURIComponent(grupo)}&limit=100`, {
        buscar,
      });
      if (!r.ok) return r;

      // Pela data, e não pela ordem que vier: a resposta não promete ordem, e
      // uma lista fora de ordem carimbaria a parcela 3 com o id da 7.
      const faturas = [...(r.dados?.data || [])].sort((a, b) =>
        String(a.dueDate || "").localeCompare(String(b.dueDate || ""))
      );

      return { ok: true, faturas: faturas.map((f) => ({ id: f.id, vencimento: f.dueDate, link: f.invoiceUrl })) };
    },

    // ── A PRIMEIRA FATURA, para a pessoa pagar AGORA ─────────────────────
    //
    // *"aí já abre os dados para o cliente pagar direto ali"*.
    //
    // O `invoiceUrl` é a página do Asaas com pix, boleto e cartão — a mesma
    // que ele manda por e-mail. Mandamos a pessoa para LÁ em vez de desenhar
    // um QR aqui porque aquela página é responsabilidade de quem recebe o
    // dinheiro: ela atualiza sozinha quando o pagamento cai, e não há como a
    // nossa cópia de um código pix ficar desatualizada no bolso de alguém.
    //
    // Pode vir VAZIA: o Asaas cria a fatura logo depois da assinatura, e
    // "logo depois" não é "no mesmo instante". Por isso quem chama trata a
    // ausência como normal — a assinatura existe, o aviso chega pelo webhook,
    // e o e-mail do Asaas leva o link.
    async primeiraFatura({ chave, ambiente, assinatura, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      const r = await pedir(base, chave, `/subscriptions/${assinatura}/payments`, { buscar });
      if (!r.ok) return r;

      // A mais antiga em aberto: a lista vem com as futuras junto quando o
      // Asaas já adiantou alguma, e o que a pessoa paga agora é a primeira.
      const fatura = (r.dados?.data || [])
        .filter((p) => ["PENDING", "AWAITING_RISK_ANALYSIS", "OVERDUE"].includes(p.status))
        .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];

      if (!fatura) return { ok: true, fatura: null };

      return {
        ok: true,
        fatura: {
          id: fatura.id,
          url: fatura.invoiceUrl || "",
          vencimento: fatura.dueDate || "",
          valor: Math.round((Number(fatura.value) || 0) * 100),
        },
      };
    },

    // ── GUARDAR UM CARTÃO: O NÚMERO VAI, O TOKEN FICA ────────────────────
    //
    // *"crie aqui, aba de cartão de crédito para colocar os cartões para
    // pagar as faturas que a unidade gerar"* (16/10/2026).
    //
    // O que volta do Asaas é `{ creditCardNumber (os 4 últimos),
    // creditCardBrand, creditCardToken }`. É SÓ ISSO que o nosso banco vê —
    // o número completo, a validade e o CVV existem na memória desta função
    // e morrem com ela. Guardar cartão sem guardar cartão é o ponto inteiro
    // da tokenização; escrever o número em qualquer lugar nosso, inclusive
    // num log de erro, jogaria fora a única razão de isto existir.
    //
    // ── A CONTA PRECISA TER A FUNÇÃO LIBERADA ────────────────────────────
    //
    // O Asaas só tokeniza em conta onde o suporte dele ligou a função. É a
    // caixa de 16/10 em Configurações › Gateways — ver `tokeniza` lá em cima
    // e `tokenizacao` na linha do banco. Sem ela esta chamada volta
    // recusada, e a frase que o Asaas manda é melhor que qualquer nossa.
    //
    // ── O `remoteIp` NÃO É ENFEITE ───────────────────────────────────────
    //
    // Ele é obrigatório e vai para a análise de risco deles. Mandar o IP do
    // SERVIDOR em vez do de quem está digitando faria toda tokenização da
    // casa sair do mesmo endereço — que é exatamente o padrão que um
    // antifraude existe para marcar.
    async tokenizarCartao({ chave, ambiente, cliente, cartao, titular, ip, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      const r = await pedir(base, chave, "/creditCard/tokenize", {
        metodo: "POST",
        buscar,
        corpo: {
          customer: cliente,
          creditCard: {
            holderName: cartao.titular,
            number: soDigitos(cartao.numero),
            expiryMonth: String(cartao.mes || "").padStart(2, "0"),
            // Quatro dígitos: o Asaas aceita "29" e "2029", e "29" entendido
            // como ano 29 venceria o cartão em 1929.
            expiryYear: anoCompleto(cartao.ano),
            ccv: String(cartao.cvv || ""),
          },
          creditCardHolderInfo: {
            name: titular.nome,
            email: titular.email,
            cpfCnpj: soDigitos(titular.documento),
            postalCode: soDigitos(titular.cep),
            addressNumber: String(titular.numero || ""),
            addressComplement: titular.complemento || null,
            phone: soDigitos(titular.telefone) || undefined,
            // O celular é campo PRÓPRIO lá, e opcional. Mandar o fixo nos
            // dois era o que a primeira versão fazia — dado repetido no lugar
            // de dado ausente, que é pior para a análise de risco do que o
            // campo vazio.
            mobilePhone: soDigitos(titular.celular) || undefined,
          },
          remoteIp: ip || undefined,
        },
      });

      if (!r.ok) return r;

      return {
        ok: true,
        cartao: {
          token: r.dados?.creditCardToken || "",
          bandeira: r.dados?.creditCardBrand || "",
          // Os quatro últimos. É o que a tela mostra, e é o que a pessoa
          // reconhece — ninguém decora um token.
          fim: String(r.dados?.creditCardNumber || "").slice(-4),
        },
      };
    },

    // ── O WEBHOOK, REGISTRADO POR NÓS ────────────────────────────────────
    //
    // Ninguém cola URL nenhuma no painel do Asaas. Pedir isso a um dono de
    // academia é pedir o passo que não vai acontecer — e sem ele o dinheiro
    // cai lá e a cobrança fica aberta aqui para sempre.
    //
    // Idempotente pela URL: conferir antes de criar é o que permite chamar
    // isto a cada assinatura sem encher a conta dele de webhooks iguais.
    //
    // ── "JÁ EXISTE" NÃO É "ESTÁ CERTO" ───────────────────────────────────
    //
    // A primeira versão parava aqui: achou a URL, pronto. E isso congela o
    // webhook no dia em que ele nasceu — a lista de eventos que esta casa
    // trata CRESCE (estorno, chargeback, assinatura cancelada), e o que foi
    // registrado antes continuaria surdo para todos eles, sem nada na tela
    // denunciando.
    //
    // Então: existe com os eventos de hoje e no ar? Nada a fazer. Faltando
    // evento, desligado ou com a fila INTERROMPIDA? Atualiza no lugar. Criar
    // um segundo com a mesma URL faria o Asaas mandar cada aviso em dobro.
    async garantirWebhook({ chave, ambiente, url, segredo, email, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      const lista = await pedir(base, chave, "/webhooks", { buscar });
      if (!lista.ok) return lista;

      const corpo = {
        name: "VAFIT",
        url,
        // ── O E-MAIL E A VERSÃO NÃO SÃO ENFEITE ───────────────────────
        //
        // Os dois são campos que o Asaas cobra na criação, e mandá-los de
        // menos volta 400 — num caminho que é melhor esforço, ou seja,
        // calado. Foi o que deixou a conta dele sem webhook nenhum até
        // 15/10/2026: *"eu entrei lá, e não tem o webhook"*.
        //
        // O e-mail é para onde ELE avisa que a entrega falhou e a fila foi
        // interrompida — a pessoa que pode fazer algo a respeito.
        email: email || undefined,
        apiVersion: 3,
        enabled: true,
        // `interrupted: false` é o que faz o Asaas RETOMAR depois de uma
        // sequência de falhas nossas, em vez de desligar o webhook e ficar
        // quieto — que é o pior estado possível aqui.
        interrupted: false,
        authToken: segredo,
        // SEQUENTIALLY: um aviso por vez, na ordem. Com avisos em paralelo,
        // "criada" e "paga" da mesma fatura podem chegar trocados, e a
        // segunda escrita desfaz a primeira.
        sendType: "SEQUENTIALLY",
        events: EVENTOS,
      };

      const existente = (lista.dados?.data || []).find((w) => w.url === url);

      if (existente) {
        const faltando = EVENTOS.filter((e) => !(existente.events || []).includes(e));
        const parado = existente.enabled === false || existente.interrupted === true;
        if (!faltando.length && !parado) return { ok: true, ja: true };

        // O PUT reenvia o `authToken` que guardamos: se ele divergiu lá (ou
        // se o webhook foi mexido à mão), isto volta a casar os dois lados —
        // senão a conferência recusaria avisos legítimos.
        const r = await pedir(base, chave, `/webhooks/${existente.id}`, {
          metodo: "PUT",
          buscar,
          corpo,
        });
        return r.ok ? { ...r, atualizado: true, eventosNovos: faltando.length } : r;
      }

      return pedir(base, chave, "/webhooks", { metodo: "POST", buscar, corpo });
    },

    // ── E DESLIGAR A CHAVE TIRA O AVISO DE LÁ ────────────────────────────
    //
    // *"quando eu excluí a chave deveria excluir o webhook lá"* (15/10/2026).
    //
    // Sem isto fica um webhook ÓRFÃO apontando para um endereço que agora
    // recusa: a chave sumiu daqui, a conferência do token falha, e o Asaas
    // leva 401 em cada aviso. Depois de uma sequência deles ele PENALIZA a
    // configuração e INTERROMPE a fila — e essa fila é a mesma da conta
    // inteira. Um gateway desligado aqui passaria a atrapalhar as outras
    // integrações da conta lá.
    //
    // Pela URL, como todo o resto: o que é nosso é o que aponta para nós. Os
    // webhooks de outros sistemas na mesma conta não são tocados.
    async apagarWebhook({ chave, ambiente, url, buscar = fetch }) {
      const base = BASES[ambiente] || BASES.producao;

      const lista = await pedir(base, chave, "/webhooks", { buscar });
      if (!lista.ok) return lista;

      const nosso = (lista.dados?.data || []).find((w) => w.url === url);
      if (!nosso) return { ok: true, nada: true };

      return pedir(base, chave, `/webhooks/${nosso.id}`, { metodo: "DELETE", buscar });
    },

    // ── O AVISO QUE CHEGA, no nosso vocabulário ──────────────────────────
    //
    // Traduzir aqui e não no controlador é o que mantém o controlador sem uma
    // linha de Asaas dentro. O dia em que o Pagar.me souber cobrar, ele
    // escreve o `ler` dele e o resto não muda.
    ler(corpo) {
      const evento = String(corpo?.event || "");
      const p = corpo?.payment || {};
      // Os eventos de ASSINATURA não trazem `payment`: o documento deles é a
      // própria assinatura. Ler os dois aqui é o que deixa o modelo tratar
      // "cancelaram a assinatura lá" sem saber que existe um Asaas.
      const a = corpo?.subscription || {};

      return {
        evento,
        assinatura: p.subscription || a.id || "",
        // O id da NOSSA recorrência, se ele sobreviveu à viagem. É a segunda
        // via do vínculo, e não a primeira: o Asaas só copia o
        // `externalReference` da assinatura para a fatura em alguns fluxos.
        recorrencia: p.externalReference || a.externalReference || "",
        pagamento: p.id || "",
        // ── O PARCELAMENTO, quando a fatura é parcela de um ──────────────
        //
        // *"quando cria o parcelamento no asaas ele gera uma fatura para
        // cada, aí vem via webhook"* (17/10/2026). Cada parcela é uma fatura
        // DE VERDADE lá, com id próprio e webhook próprio — o que amarra as
        // doze é o campo `installment`, o grupo.
        //
        // `installmentNumber` diz QUAL delas é. Nem toda conta o manda, e por
        // isso ele é dica e não chave: quem decide é o id da fatura, gravado
        // no primeiro aviso que encontra a parcela daqui.
        parcelamento: p.installment || "",
        parcelaN: Number(p.installmentNumber) || 0,
        vencimento: p.dueDate || "",
        valor: Math.round((Number(p.value) || 0) * 100),
        url: p.invoiceUrl || "",
        pago: PAGAM.includes(evento),
        desfeito: DESFAZEM.includes(evento),
        encerrada: ENCERRAM.includes(evento),
        // A situação no gateway, no vocabulário da casa — nunca o nome do
        // evento do Asaas, que não significa nada para quem lê a tela.
        situacao: SITUACOES[evento] || "",
        // Mexeram na fatura lá: o vencimento e o valor que vieram no aviso
        // são os NOVOS.
        atualizado: evento === "PAYMENT_UPDATED",
      };
    },
  },
};
