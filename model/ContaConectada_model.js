// AS CONTAS DE FORA QUE O CLIENTE LIGOU AO VAFIT.
//
// Hoje: Instagram. Amanhã: a Página do Facebook e o número do WhatsApp — por
// isso a collection tem `tipo` desde o primeiro dia, e não se chama
// `instagram_accounts`. Renomear collection em produção é migração; um campo a
// mais, não.
//
// ── POR QUE O TOKEN MORA AQUI, e não na central ─────────────────────────
//
// Ele é DO CLIENTE: é a conta dele, autorizada por ele, e só o sistema dele
// deve falar por ela. Na central, um defeito de escopo alcançaria as contas de
// todo mundo de uma vez. Aqui o `lib/escopo.js` já protege por construção.
//
// ── O token NUNCA volta para a tela ─────────────────────────────────────
//
// `paraTela` existe para isso, e é o único caminho que o controlador usa. Um
// token de 60 dias visível no navegador é a conta de Instagram de um cliente
// nas mãos de qualquer extensão instalada ali — e ele não expira quando a
// pessoa sai do sistema.
// `ObjectId` vem do driver, como nos outros modelos desta casa. Eu havia
// escrito `this.app.ObjectId`, que não existe — e o erro só aparecia ao
// clicar em desconectar, com "erro interno" na tela e um TypeError no log.
const { ObjectId } = require("mongodb");

const arquivos = require("../lib/arquivos.js");
const baixarImagem = require("../lib/baixarImagem.js");
const estadoDaConta = require("../lib/estadoDaConta.js");

const COLLECTION = "connected_accounts";

function ContaConectada_model(app) {
  this.app = app;
}

ContaConectada_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection(COLLECTION);
};

// O que a tela pode ver. Tudo menos o token — e o token nem sequer é lido do
// banco, para não passear pela memória de uma rota que não precisa dele.
ContaConectada_model.prototype.paraTela = function (doc) {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    tipo: doc.tipo,
    externalId: doc.externalId,
    usuario: doc.usuario || "",
    nome: doc.nome || "",
    // A foto NÃO sai daqui pronta: quem monta o endereço é o controlador, que
    // conhece a URL da API e o nome do cliente. O que o modelo diz é se
    // existe uma cópia nossa e de quando ela é — o `v=` que troca quando a
    // foto troca, já que o endereço em si nunca muda.
    fotoEm: doc.fotoArquivo?.em || null,
    // O selo. `nao_verificada` para toda conta que existia antes de
    // 15/10/2026: a primeira abertura da tela pergunta e ele some.
    estado: estadoDaConta.normalizar(doc.estado),
    estadoEm: doc.estadoEm || null,
    estadoDetalhe: doc.estadoDetalhe || "",
    escopos: doc.escopos || [],
    expiraEm: doc.expiraEm || null,
    assinada: doc.assinada === undefined ? null : Boolean(doc.assinada),
    instagramVinculado: doc.instagramVinculado || null,
    conectadaEm: doc.conectadaEm || null,
    conectadaPor: doc.conectadaPor || null,
  };
};

ContaConectada_model.prototype.lista = async function (tipo) {
  const col = await this.collection();
  const filtro = tipo ? { tipo: String(tipo) } : {};
  const docs = await col
    // Os BYTES da foto ficam de fora: numa casa com 200 Páginas, trazer a
    // imagem de cada uma para montar uma lista de nomes é megabytes de banco
    // atravessando a memória para nada. Quem os quer é a rota da imagem.
    .find(filtro, { projection: { token: 0, "fotoArquivo.data": 0 } })
    .sort({ conectadaEm: -1 })
    .toArray();
  return docs.map((d) => this.paraTela(d));
};

// As contas COM TOKEN, para a conferência do selo.
//
// Nome próprio e sem atalho: é o único caminho que tira o token do banco em
// lote, e ele tem de doer um pouco de escrever. Os bytes da foto ficam de
// fora; `fotoArquivo.em` fica, porque é ele que diz se a cópia envelheceu.
ContaConectada_model.prototype.paraConferir = async function (tipo) {
  const col = await this.collection();
  const filtro = tipo ? { tipo: String(tipo) } : {};
  return col.find(filtro, { projection: { "fotoArquivo.data": 0 } }).toArray();
};

// Id torto devolve `null` em vez de estourar: o que chega aqui vem da URL, e
// `new ObjectId("abc")` lança — virando 500 numa requisição que merece 404.
ContaConectada_model.prototype.porId = async function (id) {
  if (!ObjectId.isValid(String(id || ""))) return null;
  const col = await this.collection();
  const doc = await col.findOne({ _id: new ObjectId(String(id)) });
  return doc || null;
};

// ── Conectar de novo a MESMA conta substitui, não duplica ────────────────
//
// É o caminho comum: o token de 60 dias venceu, a pessoa clica em conectar
// outra vez. Sem esta chave, a lista encheria de linhas iguais e o webhook não
// saberia qual token usar — e escolheria o mais velho, que é o que não serve.
ContaConectada_model.prototype.guardar = async function (dados, user) {
  const col = await this.collection();
  const agora = new Date();

  const chave = { tipo: String(dados.tipo), externalId: String(dados.externalId) };

  await col.updateOne(
    chave,
    {
      $set: {
        ...chave,
        token: String(dados.token),
        expiraEm: dados.expiraEm || null,
        usuario: String(dados.usuario || ""),
        nome: String(dados.nome || ""),
        // A URL DA REDE, guardada só como ORIGEM — nunca é o que a tela usa.
        //
        // *"ao conectar o facebook quebrou a imagem"* (15/10/2026): o endereço
        // que o Graph devolve é do CDN da Meta e vem assinado com prazo. Ele
        // funciona na hora de conectar e vira quadrado quebrado dias depois,
        // sem nada ter acontecido aqui — que foi exatamente o print que ele
        // mandou, com as quatro Páginas sem foto.
        //
        // Fica no documento porque é dela que a cópia é refeita quando a foto
        // da Página muda. Quem a tela lê é `fotoArquivo`.
        fotoDeFora: String(dados.foto || ""),
        escopos: Array.isArray(dados.escopos) ? dados.escopos : [],
        // Só a Página tem isto. `assinada: false` quer dizer conta ligada que
        // NÃO recebe evento — e a tela precisa poder dizer isso, porque por
        // fora tudo parece certo.
        ...(dados.assinada === undefined ? {} : { assinada: Boolean(dados.assinada) }),
        ...(dados.instagramVinculado === undefined
          ? {}
          : { instagramVinculado: dados.instagramVinculado }),
        conectadaEm: agora,
        conectadaPor: user ? String(user.name || user.email || "") : null,
      },
    },
    { upsert: true }
  );

  const doc = await col.findOne(chave, { projection: { token: 0 } });

  // A foto depois do upsert, porque a chave do arquivo precisa do `_id` — e
  // best-effort: conta ligada sem foto é uma conta ligada; conta que não liga
  // porque o CDN da Meta demorou é um defeito nosso.
  await this.copiarFoto(doc, dados.foto);

  return col.findOne(chave, { projection: { token: 0, "fotoArquivo.data": 0 } });
};

// ── A CÓPIA DA FOTO ───────────────────────────────────────────────────────
//
// *"salve a imagem e faça o upload e deixe o link fixo"* (15/10/2026).
//
// A chave é o `_id` da conta: um arquivo por conta, para sempre. Reconectar a
// mesma Página cai no mesmo documento (ver a chave do upsert) e SOBRESCREVE a
// mesma chave — não há como sobrar lixo no balde, e por isso esta foto não
// precisa da coleta que as imagens de plano e de aulão têm.
//
// O endereço servido é fixo; o que muda quando a foto muda é o `?v=`, que sai
// de `fotoArquivo.em`.
ContaConectada_model.prototype.copiarFoto = async function (doc, url) {
  if (!doc?._id || !url) return false;

  try {
    const baixada = await baixarImagem.baixar(url);
    if (!baixada) return false;

    const col = await this.collection();
    const onde = await arquivos.ondeGuardar(
      arquivos.chaveDoCliente("contas", String(doc._id)),
      baixada.bytes,
      baixada.mime
    );

    // `ondeGuardar` devolve `{ chave }` ou `{ data }` na raiz; aqui tudo mora
    // dentro de `fotoArquivo`, para o documento da conta não ficar com campos
    // de arquivo soltos no meio do token e do nome.
    const set = { "fotoArquivo.mime": baixada.mime, "fotoArquivo.em": new Date() };
    const unset = {};
    for (const [campo, valor] of Object.entries(onde.set)) set[`fotoArquivo.${campo}`] = valor;
    for (const campo of Object.keys(onde.unset)) unset[`fotoArquivo.${campo}`] = "";

    await col.updateOne({ _id: doc._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    return true;
  } catch (erro) {
    console.warn("[contas] não consegui copiar a foto:", erro?.message);
    return false;
  }
};

// Os bytes da foto de uma conta, para a rota que a serve.
ContaConectada_model.prototype.foto = async function (id) {
  if (!ObjectId.isValid(String(id || ""))) return null;
  const col = await this.collection();
  const doc = await col.findOne(
    { _id: new ObjectId(String(id)) },
    { projection: { fotoArquivo: 1 } }
  );
  return doc?.fotoArquivo?.chave || doc?.fotoArquivo?.data ? doc.fotoArquivo : null;
};

// ── O SELO ────────────────────────────────────────────────────────────────
//
// Guardado no documento, e não calculado a cada abertura: a lista abre com o
// último resultado conhecido e a verificação vem depois, em outra chamada.
// Perguntar à Meta antes de desenhar faria a tela inteira esperar a rede da
// Meta — e quando ela está lenta é justamente quando a pessoa veio olhar.
ContaConectada_model.prototype.marcarEstado = async function (id, { estado, detalhe, assinada }) {
  if (!ObjectId.isValid(String(id || ""))) return null;

  const col = await this.collection();
  const set = {
    estado: estadoDaConta.normalizar(estado),
    estadoEm: new Date(),
    estadoDetalhe: String(detalhe || "").slice(0, 200),
  };
  // `assinada` só é reescrita quando a conferência conseguiu olhar: com a
  // Meta fora do ar, manter o que se sabia é melhor que dizer que a Página
  // ficou muda.
  if (assinada !== undefined) set.assinada = Boolean(assinada);

  await col.updateOne({ _id: new ObjectId(String(id)) }, { $set: set });
  return set;
};

ContaConectada_model.prototype.remover = async function (id) {
  if (!ObjectId.isValid(String(id || ""))) return { ok: false };
  const col = await this.collection();

  // A CHAVE ANTES do delete: depois dele não há como saber qual arquivo era, e
  // os bytes ficariam no balde para sempre.
  //
  // *"se eu remover a conta você remove a imagem que você subiu"*
  // (15/10/2026) — e é o pedido certo: a foto de uma Página que a casa
  // desligou não tem nenhuma razão para continuar existindo.
  const doc = await col.findOne(
    { _id: new ObjectId(String(id)) },
    { projection: { "fotoArquivo.chave": 1 } }
  );

  const r = await col.deleteOne({ _id: new ObjectId(String(id)) });
  if (doc?.fotoArquivo?.chave) await arquivos.apagar(doc.fotoArquivo.chave).catch(() => {});

  return { ok: r.deletedCount > 0 };
};

module.exports = ContaConectada_model;
module.exports.COLLECTION = COLLECTION;
