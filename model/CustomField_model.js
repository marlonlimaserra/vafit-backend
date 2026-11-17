const { ObjectId } = require("mongodb");
const tipos = require("../lib/tiposDeCampo.js");

// OS CAMPOS CUSTOMIZADOS — as perguntas que a casa inventa.
//
// *"na parte de configuração do sistema, crie 'Campos customizados', vai ser
// tipo isso aqui, com os tipos"* (01/10/2026).
//
// O produto decide os campos que TODA academia precisa: nome, telefone, peso,
// objetivo. O que ele não sabe é que esta clínica precisa do convênio, aquele
// box precisa do tamanho da camiseta, e a nutricionista precisa saber se a
// pessoa já fez cirurgia bariátrica. Hoje isso vira observação — texto solto
// que não filtra, não soma e não entra em relatório nenhum.
//
// ── O QUE MORA AQUI É A DEFINIÇÃO, NÃO O VALOR ─────────────────────────
//
// Esta coleção guarda a PERGUNTA ("Convênio", do tipo Seletor, com cinco
// opções). A RESPOSTA de cada pessoa mora na ficha dela, num objeto
// `customFields` com o alias por chave — perto do resto do cadastro, que é
// onde ela é lida.
//
// A alternativa seria uma coleção de valores (campo, pessoa, valor). Ela
// resolve bem "quem respondeu X" e cobra uma junção em toda abertura de ficha,
// que é a leitura que acontece o tempo todo. Com o valor na ficha, abrir uma
// pessoa continua sendo um `findOne`.
//
// ── `alias`: A CHAVE, E ELA NÃO MUDA ───────────────────────────────────
//
// É por ele que o valor é guardado (`customFields.convenio`), e é o nome que
// aparece numa integração ou numa exportação. Por isso ele é gerado do nome na
// CRIAÇÃO e congela depois: renomear o alias deixaria as respostas de todo
// mundo órfãs, apontando para uma chave que ninguém mais procura.
//
// O NOME continua editável — é o rótulo, e corrigir "Convenio" para "Convênio"
// não pode custar os dados de duzentas pessoas.
function CustomField_model(app) {
  this.app = app;
}

CustomField_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("custom_fields");
};

// ── O ALIAS SAI DO NOME ─────────────────────────────────────────────────
//
// Sem acento, sem espaço, sem maiúscula: ele vira chave de objeto no banco e
// nome de coluna numa planilha, e os dois lugares castigam acento.
//
// Começa com letra à força. Um alias que começasse com número ("3x-semana")
// seria legal no Mongo e ilegal em quase todo lugar que consome a exportação.
function aliasDe(texto) {
  const limpo = String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  if (!limpo) return "";
  return /^[a-z]/.test(limpo) ? limpo : "campo_" + limpo;
}

// ── OS ALIASES QUE O PRODUTO JÁ USA ─────────────────────────────────────
//
// Um campo customizado chamado "Nome" geraria `name`, e a partir daí haveria
// duas verdades sobre o nome da pessoa — a do cadastro e a do campo inventado.
// Os valores moram num objeto à parte (`customFields`), então colidir não
// quebra nada tecnicamente; o que quebra é a cabeça de quem exporta a planilha
// e vê duas colunas "name".
const RESERVADOS = [
  "id",
  "_id",
  "name",
  "firstname",
  "lastname",
  "email",
  "phone",
  "whatsapp",
  "birthdate",
  "sex",
  "goal",
  "weight",
  "height",
  "unit",
  "notes",
  "active",
  "type",
  "password",
  "createdat",
  "updatedat",
];

// ── OS CAMPOS NATIVOS ───────────────────────────────────────────────────
//
// *"coloca esses 3 como customizado padrão já"* (01/10/2026), apontando para
// Objetivo, Peso e Altura na ficha.
//
// Eles JÁ EXISTEM no documento da pessoa e já são lidos por meio produto — o
// peso e a altura entram no IMC, na avaliação física e na evolução. Transformá-los
// em campos customizados de verdade significaria mover os valores de duzentas
// fichas para dentro de `customFields` e reescrever todo mundo que os lê.
//
// Então eles entram no catálogo como NATIVOS: a casa manda na pergunta (nome,
// ordem, obrigatório, mostrar no cadastro, desligar) e o VALOR continua na
// coluna de sempre. É a mesma ideia do CRM da referência, onde "Nome" e
// "E-mail" aparecem na lista de campos com o tipo e o apelido travados.
//
// ── O QUE MUDA PARA UM NATIVO ──────────────────────────────────────────
//
//   • não se apaga (apagar não tiraria o campo da ficha, só a linha daqui)
//   • alias e tipo travados, como em qualquer campo já criado
//   • o valor mora em `<alias>` no topo do documento, e não em
//     `customFields.<alias>`
//
// ── O NOME SAI DA TRADUÇÃO ATÉ ALGUÉM RENOMEAR ────────────────────────
//
// Gravar "Objetivo" em português numa conta em inglês seria errar o idioma de
// quem nunca pediu nada. Então o nativo nasce SEM nome e com `rotuloPadrao`
// (uma chave de tradução); quem lê resolve. No instante em que a casa renomeia,
// `name` passa a existir e vence — porque aí a escolha é dela.
const NATIVOS = [
  { alias: "goal", tipo: "texto", rotuloPadrao: "customFields.native.goal", ordem: 10 },
  { alias: "weight", tipo: "numero", rotuloPadrao: "customFields.native.weight", ordem: 20 },
  { alias: "height", tipo: "numero", rotuloPadrao: "customFields.native.height", ordem: 30 },
];

// ── OS CAMPOS QUE A COBRANÇA VAI PEDIR ──────────────────────────────────
//
// *"quando a gente habilitar isso [o gateway], vamos precisar de endereço da
// pessoa, CPF... acho que é melhor, por padrão, já vir um grupo chamado
// endereços em todas as instâncias"* (14/10/2026).
//
// Semeados ANTES de existir cobrança, e de propósito: o endereço é o dado que
// a recepção junta uma pessoa por vez, ao longo de meses. Pedi-lo no dia em
// que o gateway for ligado é descobrir que ninguém tem.
//
// Eles NÃO são nativos: o valor mora em `customFields.<alias>` como o de
// qualquer campo criado pela casa, e por isso podem ser renomeados,
// reordenados, desligados e apagados. Nativo é só o que tem coluna própria
// porque alguma conta lê de lá — endereço não tem.
//
// ── O CPF É IDENTIDADE, NÃO ENDEREÇO, e nasce DESLIGADO ────────────────
//
// Fica no `principal`, onde moram os dados da pessoa, e com `ativo: false`:
// está no catálogo para a casa ligar num clique quando for cobrar, e fora da
// ficha de quem nunca vai cobrar. O tipo `cpf` já existe, com máscara e
// conferência de dígito — seria desperdício semear um `texto`, e tipo não se
// troca depois.
const COBRANCA = [
  { alias: "cpf", tipo: "cpf", grupo: "principal", ordem: 40, ativo: false, noCadastro: false },
  { alias: "cep", tipo: "cep", grupo: "endereco", ordem: 10 },
  { alias: "logradouro", tipo: "texto", grupo: "endereco", ordem: 20 },
  { alias: "numero", tipo: "texto", grupo: "endereco", ordem: 30 },
  { alias: "complemento", tipo: "texto", grupo: "endereco", ordem: 40 },
  { alias: "bairro", tipo: "texto", grupo: "endereco", ordem: 50 },
  { alias: "cidade", tipo: "texto", grupo: "endereco", ordem: 60 },
  { alias: "estado", tipo: "estado", grupo: "endereco", ordem: 70 },
];

const CAMPOS = {
  name: (v) => String(v || "").trim().slice(0, 80),
  tipo: (v) => tipos.normalizar(v),
  grupo: (v) => String(v || "").trim().slice(0, 40) || "principal",
  obrigatorio: (v) => v === true || v === "true",
  // IDENTIFICADOR ÚNICO: dois cadastros não podem responder a mesma coisa. É
  // para matrícula, CPF, número de convênio — e é o que permite achar a pessoa
  // por ele numa importação.
  unico: (v) => v === true || v === "true",
  // MOSTRAR NO CADASTRO RÁPIDO. Um campo pode existir na ficha e não aparecer
  // na hora de criar: a recepção cadastra com o telefone e a pessoa esperando,
  // e trinta perguntas ali fariam ninguém cadastrar.
  noCadastro: (v) => v === true || v === "true",
  valorPadrao: (v) => String(v == null ? "" : v).trim().slice(0, 240),
  ajuda: (v) => String(v || "").trim().slice(0, 200),
  ordem: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
  ativo: (v) => v !== false,
};

// As opções de um seletor. Cada uma tem `valor` (o que é guardado) e `rotulo`
// (o que se lê) — iguais quando ninguém pediu diferente, que é o caso comum.
//
// Duplicadas caem fora: duas opções com o mesmo valor são indistinguíveis
// depois de gravadas, e a segunda nunca seria selecionável.
function limparOpcoes(bruto) {
  if (!Array.isArray(bruto)) return [];

  const vistos = new Set();
  const saida = [];

  for (const o of bruto.slice(0, 200)) {
    const rotulo = String((typeof o === "string" ? o : o?.rotulo) || "").trim().slice(0, 80);
    if (!rotulo) continue;

    const valor = String((typeof o === "string" ? o : o?.valor) || rotulo).trim().slice(0, 80);
    if (vistos.has(valor)) continue;

    vistos.add(valor);
    saida.push({ valor, rotulo });
  }

  return saida;
}

function limpar(obj, { parcial = false } = {}) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (parcial && obj[campo] === undefined) continue;
    saida[campo] = tratar(obj[campo]);
  }
  if (!parcial || obj.opcoes !== undefined) saida.opcoes = limparOpcoes(obj.opcoes);

  // ── OBRIGATÓRIO É SEMPRE VISÍVEL ──────────────────────────────────────
  //
  // *"Campos obrigatórios são sempre visíveis"* — um campo que a gravação exige
  // e a tela não mostra é um formulário que não salva e não diz por quê.
  if (saida.obrigatorio) saida.noCadastro = true;

  return saida;
}

CustomField_model.prototype.list = async function ({ ativos = false } = {}) {
  const col = await this.collection();
  const filtro = ativos ? { ativo: { $ne: false } } : {};

  // Pela ORDEM escolhida, e o nome desempata: sem critério estável, dois campos
  // da mesma ordem trocam de lugar entre uma abertura e outra da ficha.
  return col.find(filtro).collation({ locale: "pt" }).sort({ ordem: 1, name: 1 }).toArray();
};

CustomField_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(String(id)) })) || undefined;
};

CustomField_model.prototype.porAlias = async function (alias) {
  const col = await this.collection();
  return (await col.findOne({ alias: String(alias || "") })) || undefined;
};

// Devolve `{ id }`, ou `{ erro }` — o controller traduz. Não estoura: os três
// motivos de recusa são de quem preencheu, e nenhum é excepcional.
CustomField_model.prototype.insert = async function (obj) {
  const doc = limpar(obj);
  if (!doc.name) return { erro: "sem_nome" };

  // O alias pedido vence, se vier; senão sai do nome. Quem está importando de
  // outro sistema precisa poder casar a chave que já usa lá.
  const alias = aliasDe(obj.alias || doc.name);
  if (!alias) return { erro: "sem_alias" };
  if (RESERVADOS.includes(alias)) return { erro: "alias_reservado" };

  if (tipos.pedeOpcoes(doc.tipo) && !doc.opcoes.length) return { erro: "sem_opcoes" };

  const col = await this.collection();
  if (await col.findOne({ alias })) return { erro: "alias_em_uso" };

  // `nativo: false` explícito: `limpar` não o copia do pedido, e deixar o campo
  // ausente faria a consulta por `{ nativo: true }` e a por `{ nativo: false }`
  // discordarem sobre o mesmo documento.
  const r = await col.insertOne({
    ...doc,
    alias,
    nativo: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id: r.insertedId };
};

CustomField_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return { erro: "nao_encontrado" };

  const col = await this.collection();
  const antes = await col.findOne({ _id: new ObjectId(String(id)) });
  if (!antes) return { erro: "nao_encontrado" };

  const set = limpar(obj, { parcial: true });
  if (set.name !== undefined && !set.name) return { erro: "sem_nome" };

  // O ALIAS E O TIPO NÃO MUDAM.
  //
  // O alias porque as respostas de todo mundo estão guardadas sob ele. O tipo
  // porque trocar Número por Data não converte nada — deixaria valores
  // gravados que o campo novo não sabe ler, e a tela mostraria vazio onde há
  // dado. Quem errou o tipo cria outro campo; quem errou o nome corrige o nome.
  delete set.alias;
  delete set.tipo;
  // `nativo` nunca vem do pedido: é o sistema que decide o que é dele.
  delete set.nativo;
  delete set.rotuloPadrao;

  const tipoAtual = antes.tipo;
  if (tipos.pedeOpcoes(tipoAtual) && set.opcoes !== undefined && !set.opcoes.length) {
    return { erro: "sem_opcoes" };
  }

  await col.updateOne(
    { _id: new ObjectId(String(id)) },
    { $set: { ...set, updatedAt: new Date() } }
  );

  return { id: antes._id };
};

CustomField_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;

  const col = await this.collection();

  // NATIVO NÃO SE APAGA. Apagar a linha não tiraria o campo da ficha — ele é
  // uma coluna do documento da pessoa — e deixaria a tela sem o lugar de
  // configurá-lo. Quem não quer o campo o DESLIGA.
  const alvo = await col.findOne({ _id: new ObjectId(String(id)) });
  if (!alvo) return false;
  if (alvo.nativo) return "nativo";

  const r = await col.deleteOne({ _id: new ObjectId(String(id)) });
  return r.deletedCount > 0;
};

// ── A SEMEADURA, A CADA BOOT E SEM SOBRESCREVER ─────────────────────────
//
// Roda em `ensureInstanceEssencial`, como os papéis do sistema e os módulos
// liberados. Idempotente por `alias`: um segundo boot não toca no que já está
// lá, e é isso que deixa a casa renomear "Objetivo" para "Meta" sem o deploy
// seguinte desfazer.
//
// `gruposNovos` são as gavetas que NASCERAM neste boot (ver
// `CustomFieldGroup_model.semear`). Os campos de cobrança entram só quando a
// gaveta `endereco` aparece — uma vez na vida da instância. Guardá-los por
// alias, como os nativos, faria um campo apagado pela casa voltar no boot
// seguinte; e nativo não tem esse problema porque nativo não se apaga.
CustomField_model.prototype.semear = async function ({ gruposNovos = [] } = {}) {
  const col = await this.collection();
  const existentes = new Set((await col.find({}, { projection: { alias: 1 } }).toArray()).map((c) => c.alias));

  const deCobranca = gruposNovos.includes("endereco")
    ? COBRANCA.filter((c) => !existentes.has(c.alias)).map((c) => ({
        name: "",
        rotuloPadrao: `customFields.seed.${c.alias}`,
        alias: c.alias,
        tipo: c.tipo,
        nativo: false,
        grupo: c.grupo,
        obrigatorio: false,
        unico: false,
        noCadastro: c.noCadastro !== false,
        valorPadrao: "",
        ajuda: "",
        opcoes: [],
        ordem: c.ordem,
        ativo: c.ativo !== false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    : [];

  const novos = NATIVOS.filter((n) => !existentes.has(n.alias)).map((n) => ({
    // Sem `name`: quem lê resolve pelo `rotuloPadrao`, no idioma de quem abre.
    name: "",
    rotuloPadrao: n.rotuloPadrao,
    alias: n.alias,
    tipo: n.tipo,
    nativo: true,
    grupo: "principal",
    obrigatorio: false,
    unico: false,
    noCadastro: true,
    valorPadrao: "",
    ajuda: "",
    opcoes: [],
    ordem: n.ordem,
    ativo: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  const tudo = [...novos, ...deCobranca];
  if (!tudo.length) return { criados: 0 };

  await col.insertMany(tudo);
  return { criados: tudo.length };
};

// Os números do topo da tela. Contados no banco, e não na página: a lista
// pagina, e "7 visíveis ao cadastrar" tem de falar do catálogo inteiro.
CustomField_model.prototype.resumo = async function () {
  const col = await this.collection();

  const [saida] = await col
    .aggregate([
      {
        $facet: {
          total: [{ $count: "n" }],
          obrigatorios: [{ $match: { obrigatorio: true } }, { $count: "n" }],
          noCadastro: [{ $match: { noCadastro: true } }, { $count: "n" }],
          unicos: [{ $match: { unico: true } }, { $count: "n" }],
        },
      },
    ])
    .toArray();

  const n = (x) => saida?.[x]?.[0]?.n || 0;

  return {
    total: n("total"),
    obrigatorios: n("obrigatorios"),
    noCadastro: n("noCadastro"),
    unicos: n("unicos"),
  };
};

module.exports = CustomField_model;
module.exports.aliasDe = aliasDe;
module.exports.RESERVADOS = RESERVADOS;
module.exports.NATIVOS = NATIVOS;
