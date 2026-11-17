const crypto = require("crypto");
const { ObjectId } = require("mongodb");

const gateways = require("../lib/gateways");

// O GATEWAY DE PAGAMENTO QUE A CASA LIGOU — Asaas, Pagar.me.
//
//   { tipo, chave, ambiente, conta, ativo, conectadoEm, conectadoPor }
//
// *"ele vai configurar a integração e só vai poder escolher por onde as
// faturas e assinaturas serão geradas"* (10/10/2026).
//
// ── POR QUE A CHAVE MORA NO BANCO DO CLIENTE ────────────────────────────
//
// Mesma razão do token de Instagram (`ContaConectada_model`): ela é DELE. É a
// conta de cobrança dele, com o CNPJ dele, e o dinheiro cai na conta dele. No
// banco central, um defeito de escopo alcançaria o Asaas de todo mundo de uma
// vez; aqui o `lib/escopo.js` já protege por construção.
//
// ── A CHAVE NÃO VOLTA PARA A TELA. NUNCA ────────────────────────────────
//
// `paraTela` é o único caminho que o controlador usa, e ele não tem como
// devolver a chave — ela nem é lida do banco nas rotas de leitura. Uma chave de
// gateway visível no navegador é a conta de cobrança da casa na mão de
// qualquer extensão instalada ali, e ela não expira quando a pessoa sai.
//
// Quem precisa dela de verdade é a camada que COBRA, e ela chama `ativo()` —
// o único método deste arquivo que lê o campo.
// ── E AGORA, UM POR UNIDADE ───────────────────────────────────────────────
//
// *"acho que cada filial terá que ter suas chaves de gateway de pagamento
// também"* (14/10/2026). Ele está certo pelo motivo mais concreto possível: a
// filial pode ter CNPJ próprio, e o dinheiro de quem treina em Paraty tem de
// cair na conta de Paraty.
//
// `unit` é o eixo novo. `null` é A CASA — o que existia até hoje, e o que
// continua valendo para quem só tem um lugar.
//
// ── A HERANÇA É O QUE FAZ ISSO NÃO QUEBRAR NADA ─────────────────────────
//
// Uma unidade SEM gateway próprio usa o da casa. Sem essa regra, o dia em que
// a primeira filial fosse cadastrada toda cobrança dela pararia — e ninguém
// ligaria uma coisa à outra. Ver `ativo()`.
//
// O caminho inverso não existe: a casa nunca herda de uma filial. Ela é a
// raiz, e "qual filial?" não teria resposta.
const COLLECTION = "payment_gateways";

// A unidade como ela é GRAVADA: um ObjectId, ou `null` para a casa.
//
// `null` explícito e não campo ausente: é o valor que o índice único parcial
// compara, e é o que deixa "a casa" ser uma linha como qualquer outra em vez
// de um caso especial em cada consulta.
function daUnidade(valor) {
  const id = String(valor || "");
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

function PaymentGateway_model(app) {
  this.app = app;
}

PaymentGateway_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection(COLLECTION);
};

// Os seis últimos caracteres. Não é para esconder — é para RECONHECER: "a
// chave que está aí é a que eu colei?". Com o Asaas há coisa melhor ao lado
// (o nome e o e-mail da conta); com o Pagar.me isto é o que há.
const fimDa = (chave) => String(chave || "").slice(-6);

PaymentGateway_model.prototype.paraTela = function (doc) {
  if (!doc) return null;
  return {
    tipo: doc.tipo,
    unidade: doc.unit ? String(doc.unit) : null,
    ambiente: doc.ambiente || "producao",
    ativo: Boolean(doc.ativo),
    conta: doc.conta || { nome: "", email: "", documento: "" },
    fim: doc.fim || "",
    conectadoEm: doc.conectadoEm || null,
    conectadoPor: doc.conectadoPor || null,
    // QUANDO o aviso de pagamento foi registrado lá. É o que responde, na
    // tela, a pergunta que ele fez olhando a lista de webhooks do Asaas:
    // *"eu entrei lá, e não tem o webhook"* (15/10/2026).
    webhookEm: doc.webhookEm || null,
    // A TOKENIZAÇÃO DE CARTÃO está liberada NESTA conta do gateway. Ver
    // `marcarTokenizacao`. Vai para a tela porque é o estado de uma caixa
    // que a pessoa marca — e porque ela é o que explica, no dia em que
    // guardar cartão falhar, por que falhou.
    tokenizacao: Boolean(doc.tokenizacao),
  };
};

// A lista para a tela. A PROJEÇÃO tira a chave antes de ela sair do banco: não
// é só "não mandar", é não passear com o segredo pela memória de uma rota que
// não precisa dele.
PaymentGateway_model.prototype.lista = async function (unidade) {
  const col = await this.collection();
  const alvo = daUnidade(unidade);
  const docs = await col.find({ unit: alvo }, { projection: { chave: 0 } }).toArray();
  return gateways
    .catalogo()
    .map((g) => ({
      ...g,
      ligado: this.paraTela(docs.find((d) => d.tipo === g.chave)),
    }));
};

// ── GRAVAR ────────────────────────────────────────────────────────────────
//
// Um documento por tipo. Colar uma chave nova SUBSTITUI a anterior — trocar a
// chave do Asaas é uma operação comum (ela vaza, ela é revogada), e duas
// linhas do mesmo gateway deixariam a cobrança sair por uma e a conferência
// olhar a outra.
//
// `ativo` NÃO é gravado aqui. Ligar e escolher são duas decisões: configurar o
// Pagar.me não pode, sozinho, desligar o Asaas que já está cobrando.
PaymentGateway_model.prototype.salvar = async function (tipo, dados, userId, unidade) {
  const col = await this.collection();
  const chave = String(dados.chave || "");
  const alvo = daUnidade(unidade);

  // ── CHAVE DE OUTRA CONTA APAGA A DECLARAÇÃO DE TOKENIZAÇÃO ───────────
  //
  // Trocar a chave quase sempre é rotação: a mesma conta, chave nova. Aí a
  // liberação de tokenização continua valendo, e desmarcá-la pararia de
  // guardar cartão sem ninguém ter pedido.
  //
  // Mas quando o CPF/CNPJ do titular muda, é OUTRA conta do Asaas — e a
  // liberação era da anterior. Deixá-la marcada faria a tela afirmar uma
  // coisa sobre uma conta que nunca foi perguntada.
  //
  // A comparação exige os dois documentos: o Pagar.me não diz quem é o
  // titular, e "não sei" nunca pode virar "mudou".
  const antes = await col.findOne(
    { tipo: String(tipo), unit: alvo },
    { projection: { "conta.documento": 1 } }
  );
  const eraDe = String(antes?.conta?.documento || "");
  const agoraE = String(dados.conta?.documento || "");
  const trocouDeConta = Boolean(eraDe && agoraE && eraDe !== agoraE);

  await col.updateOne(
    { tipo: String(tipo), unit: alvo },
    {
      $set: {
        chave,
        fim: fimDa(chave),
        ambiente: dados.ambiente === "sandbox" ? "sandbox" : "producao",
        conta: {
          nome: String(dados.conta?.nome || "").slice(0, 120),
          email: String(dados.conta?.email || "").slice(0, 160),
          documento: String(dados.conta?.documento || "").slice(0, 20),
        },
        conectadoEm: new Date(),
        conectadoPor: userId ? String(userId) : null,
        ...(trocouDeConta ? { tokenizacao: false } : {}),
      },
      // Só na criação: reconfigurar o gateway que já é o ativo não pode
      // desligá-lo. `$setOnInsert` é o que separa "nasceu" de "foi atualizado"
      // num upsert — sem ele, trocar a chave derrubaria a escolha.
      //
      // `unit` entra aqui e não no `$set` porque ele é parte da IDENTIDADE da
      // linha: mudá-lo num update seria mover a chave de uma filial para
      // outra, que não é o que "colar a chave" quer dizer em lugar nenhum.
      $setOnInsert: { ativo: false, unit: alvo },
    },
    { upsert: true }
  );

  return this.paraTela(
    await col.findOne({ tipo: String(tipo), unit: alvo }, { projection: { chave: 0 } })
  );
};

// ── ESCOLHER POR ONDE COBRA ───────────────────────────────────────────────
//
// Um só. Desliga todos e liga este, nesta ordem — a inversa deixaria o banco
// com dois ativos por um instante, e o índice único parcial de
// `database/schema.js` recusaria a escrita.
//
// Quem não está configurado não pode ser escolhido: a tela já não oferece, e
// esta checagem é a que vale, porque a tela é um palpite sobre o que o
// servidor aceita.
PaymentGateway_model.prototype.ativar = async function (tipo, unidade) {
  const col = await this.collection();
  const alvo = daUnidade(unidade);

  const doc = await col.findOne({ tipo: String(tipo), unit: alvo }, { projection: { chave: 0 } });
  if (!doc) return { erro: "nao_configurado" };

  // O desligamento é ESCOPADO na mesma unidade: ativar o Asaas de Paraty não
  // pode desligar o da casa nem o de Niterói. Sem o filtro, configurar a
  // segunda filial derrubaria a cobrança da primeira — calado.
  await col.updateMany({ unit: alvo, ativo: true }, { $set: { ativo: false } });
  await col.updateOne({ tipo: String(tipo), unit: alvo }, { $set: { ativo: true } });
  return { ok: true };
};

// Nenhum ativo é um estado LEGÍTIMO, e não um erro: é a casa dizendo "por
// enquanto eu cobro na mão". Por isso desativar existe, e por isso `ativo()`
// devolver `null` não é falha.
PaymentGateway_model.prototype.desativar = async function (unidade) {
  const col = await this.collection();
  await col.updateMany({ unit: daUnidade(unidade), ativo: true }, { $set: { ativo: false } });
  return { ok: true };
};

// ── A TOKENIZAÇÃO DE CARTÃO DESTA CONTA ───────────────────────────────────
//
// *"coloque um checkbox, 'tokenização de cartão ativo' no asaas, pelo menos,
// eles precisam pedir para ativar, aí, se ativar, conseguimos tokerizar o
// cartão de crédito para pagar faturas"* (16/10/2026).
//
// É uma DECLARAÇÃO da casa, e não uma descoberta nossa — e isso é o incomum
// aqui, porque o ambiente, ao lado, é exatamente o contrário. A diferença é
// que o ambiente dá para perguntar ao Asaas (a chave responde 401 num host e
// 200 no outro) e isto não: não existe, na API dele, "a minha conta pode
// tokenizar?". Quem sabe é quem abriu o chamado no suporte.
//
// Por linha, e não por cliente: a liberação é da CONTA do Asaas, e a filial
// com CNPJ próprio tem a conta dela. Marcar na casa não pode liberar Paraty.
//
// Só marca o que EXISTE. Uma caixa marcada num gateway que não foi
// configurado criaria a linha sem chave nenhuma, e `ativo()` passaria a
// achar um gateway que não sabe cobrar.
PaymentGateway_model.prototype.marcarTokenizacao = async function (tipo, unidade, ativa) {
  const col = await this.collection();
  const alvo = daUnidade(unidade);

  const doc = await col.findOne({ tipo: String(tipo), unit: alvo }, { projection: { _id: 1 } });
  if (!doc) return { erro: "nao_configurado" };

  await col.updateOne(
    { tipo: String(tipo), unit: alvo },
    { $set: { tokenizacao: Boolean(ativa) } }
  );
  return { ok: true };
};

// Desligar APAGA a linha, com a chave dentro. Guardar a chave de um gateway
// que a casa desligou é guardar um segredo que ninguém mais vigia.
PaymentGateway_model.prototype.desligar = async function (tipo, unidade) {
  const col = await this.collection();
  const r = await col.deleteOne({ tipo: String(tipo), unit: daUnidade(unidade) });
  return { ok: r.deletedCount > 0 };
};

// Apagar a UNIDADE apaga as chaves dela. Guardar a credencial de uma filial
// que não existe mais é manter vivo um segredo que ninguém mais vigia — a
// mesma razão de `desligar` apagar a linha em vez de só marcá-la.
PaymentGateway_model.prototype.apagarDaUnidade = async function (unidade) {
  const alvo = daUnidade(unidade);
  if (!alvo) return 0;

  const col = await this.collection();

  // O aviso de pagamento da filial sai do gateway ANTES da chave sair daqui —
  // é ela que autentica a remoção. Um webhook órfão apontando para a URL
  // desta unidade levaria 401 em cada aviso até o Asaas interromper a fila da
  // conta, que é compartilhada. Ver o comentário em `apagarWebhook`.
  //
  // Melhor esforço: apagar a unidade não pode falhar porque a rede do gateway
  // caiu. O que sobra é um webhook morto, e ele se remove à mão.
  const linhas = await col.find({ unit: alvo }, { projection: { tipo: 1 } }).toArray();
  for (const doc of linhas) {
    await this.app?.api?.cobrador?.removerWebhook(doc.tipo, String(alvo));
  }

  const r = await col.deleteMany({ unit: alvo });
  return r.deletedCount || 0;
};

// ── O ÚNICO LUGAR QUE LÊ A CHAVE ──────────────────────────────────────────
//
// É por aqui que a camada de cobrança vai pedir "por onde eu cobro, e com que
// credencial". Está sozinho de propósito: um dia alguém vai procurar quem lê
// o segredo, e a resposta tem de caber num `grep`.
PaymentGateway_model.prototype.ativo = async function (unidade) {
  const col = await this.collection();
  const alvo = daUnidade(unidade);

  // ── A FILIAL PRIMEIRO, A CASA DEPOIS ───────────────────────────────────
  //
  // Esta herança é o que faz a mudança não quebrar nada. Hoje toda cobrança
  // sai pelo gateway da casa; cadastrar a primeira filial não pode, sozinho,
  // parar de cobrar quem treina nela — e pararia, se "sem gateway próprio"
  // quisesse dizer "sem gateway".
  //
  // Quem quiser que uma filial NÃO cobre por nenhum gateway desliga o da casa
  // ou cobra na mão, que é a decisão explícita. "Herdar" nunca surpreende
  // para menos: na pior hipótese sai pela conta principal, que é por onde já
  // saía ontem.
  const doc =
    (alvo && (await col.findOne({ unit: alvo, ativo: true }))) ||
    (await col.findOne({ unit: null, ativo: true }));

  if (!doc) return null;

  return {
    tipo: doc.tipo,
    // De QUEM é a conta que vai cobrar — a filial ou a casa. É o que o
    // webhook precisa saber para conferir o segredo certo, e não dá para
    // deduzir de `unidade`: a filial que herdou cobra pela conta da casa.
    unidade: doc.unit ? String(doc.unit) : null,
    chave: doc.chave,
    ambiente: doc.ambiente || "producao",
    // Quem for guardar o cartão de alguém pergunta aqui ANTES de pedir o
    // número. Tokenizar numa conta sem a função liberada devolve recusa do
    // Asaas no último passo — depois de a pessoa ter digitado os dezesseis
    // dígitos, que é o pior lugar para descobrir.
    tokenizacao: Boolean(doc.tokenizacao),
    segredo: await this.segredoDoWebhook(doc),
  };
};

// ── O SEGREDO DO WEBHOOK ──────────────────────────────────────────────────
//
// O aviso de pagamento chega numa rota PÚBLICA — tem de ser, é o Asaas quem
// bate nela, de um IP que não controlamos. Sem segredo, qualquer um que
// descubra o endereço marca a mensalidade de qualquer aluno como paga, e o
// sistema acredita.
//
// Ele é POR CLIENTE porque a conta do Asaas é de cada um: vazar o da academia
// A não pode abrir a porta da academia B.
//
// NASCE TARDE, na primeira vez que alguém vai cobrar. Gerá-lo no `salvar`
// obrigaria toda linha já gravada a passar por uma migração — e este campo só
// serve a quem usa "gerar no gateway", que é um subconjunto de quem configurou
// a chave.
//
// `$setOnInsert` não serve aqui (o documento já existe), então é um update
// condicionado à AUSÊNCIA do campo: duas requisições simultâneas na primeira
// cobrança não podem gerar dois segredos, e a segunda tem de enxergar o
// primeiro.
PaymentGateway_model.prototype.segredoDoWebhook = async function (doc) {
  if (doc?.webhookSegredo) return doc.webhookSegredo;

  const col = await this.collection();
  const novo = crypto.randomBytes(24).toString("hex");

  // A unidade entra na chave: cada linha tem o segredo dela, e duas filiais
  // com o mesmo gateway não podem compartilhar — vazar o de uma abriria a
  // porta da outra.
  const chave = { tipo: doc.tipo, unit: doc.unit ?? null };

  await col.updateOne(
    { ...chave, webhookSegredo: { $in: [null, ""] } },
    { $set: { webhookSegredo: novo } }
  );

  // Relê: se outra requisição ganhou a corrida, o que vale é o dela — o
  // webhook lá no Asaas foi registrado com UM segredo só.
  const agora = await col.findOne(chave, { projection: { webhookSegredo: 1 } });
  return agora?.webhookSegredo || novo;
};

// ── O QUE O REGISTRO DO WEBHOOK PRECISA ───────────────────────────────────
//
// Como `credenciais`, e com uma diferença que importa: aqui o segredo é
// GERADO se ainda não existir. Quem registra o webhook é quem define o token
// que vai voltar no cabeçalho — ler um segredo vazio e mandá-lo para o Asaas
// deixaria a porta aberta com uma tranca sem chave.
PaymentGateway_model.prototype.paraRegistrarWebhook = async function (tipo, unidade) {
  const col = await this.collection();
  const doc = await col.findOne({ tipo: String(tipo), unit: daUnidade(unidade) });
  if (!doc) return null;

  return {
    tipo: doc.tipo,
    chave: doc.chave,
    ambiente: doc.ambiente || "producao",
    segredo: await this.segredoDoWebhook(doc),
  };
};

// O carimbo de "o aviso está registrado lá". Só a data: o endereço e os
// eventos são deduzíveis, e guardá-los aqui criaria uma segunda verdade para
// divergir da do Asaas.
PaymentGateway_model.prototype.marcarWebhook = async function (tipo, unidade) {
  const col = await this.collection();
  await col.updateOne(
    { tipo: String(tipo), unit: daUnidade(unidade) },
    { $set: { webhookEm: new Date() } }
  );
};

// Por tipo, COM a chave e o segredo. É o caminho do webhook: ele chega
// dizendo "sou o Asaas desta instância" e precisa das duas coisas para ser
// conferido antes de mexer em cobrança nenhuma.
//
// Fora de `paraTela` de propósito — quem chama isto não está servindo a uma
// tela, e misturar os dois faria o segredo viajar num `res.send` distraído.
PaymentGateway_model.prototype.credenciais = async function (tipo, unidade) {
  const col = await this.collection();
  const doc = await col.findOne({ tipo: String(tipo), unit: daUnidade(unidade) });
  if (!doc) return null;

  return {
    tipo: doc.tipo,
    chave: doc.chave,
    ambiente: doc.ambiente || "producao",
    ativo: Boolean(doc.ativo),
    segredo: doc.webhookSegredo || "",
  };
};

module.exports = PaymentGateway_model;
