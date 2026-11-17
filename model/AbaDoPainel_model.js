const { ObjectId } = require("mongodb");

// AS ABAS COMPARTILHADAS DO PAINEL — e quem enxerga cada uma.
//
// *"quem poderia ver aquela aba, quais departamentos etc…"* (24/10/2026).
//
// ── POR QUE ISTO É UMA COLEÇÃO, E NÃO MAIS UMA PREFERÊNCIA ─────────────
//
// A aba nasceu em `user.preferences.painel.abas`: cada pessoa monta a dela, e
// ninguém mais vê. Nessa forma, "quem pode ver esta aba" não tem resposta —
// a resposta é sempre "só eu", porque o objeto mora dentro de um usuário.
//
// Para a pergunta existir, a aba precisa ser um objeto DA CONTA, criado por
// quem administra e endereçado a um público. É isto aqui. As abas pessoais
// continuam exatamente onde estavam: as duas convivem na mesma faixa, e a
// pessoa continua podendo montar as suas sem pedir nada a ninguém.
//
// ── O PÚBLICO NÃO É PERMISSÃO. ISTO É O PONTO MAIS IMPORTANTE DO ARQUIVO ─
//
// Mandar a recepção ver uma aba que tem "Atrasado" dentro **não** mostra
// dinheiro para a recepção. Quem decide se aquele número existe para alguém é
// `/dashboard`, que manda o bloco `null` sem a permissão e sem o módulo — e
// isso continua valendo por cima disto aqui. A aba chega, o cartão não.
//
// Se o público concedesse visibilidade, esta coleção viraria uma porta dos
// fundos do catálogo de permissões: qualquer um com `users.manage` passaria a
// poder revelar o faturamento criando uma aba. Então ela só faz CURADORIA —
// escolhe o que aparece entre o que a pessoa já podia ver.
//
// Na prática, uma aba cujas peças são todas indisponíveis simplesmente não
// aparece para aquela pessoa: `abasVisiveis`, no painel, já cuidava disso
// desde as abas de fábrica.
//
// ── AS QUATRO FORMAS DE ENDEREÇAR ──────────────────────────────────────
//
//   todos           a casa inteira — o caso comum, e o padrão
//   papeis          por TIPO DE USUÁRIO: "toda recepção", "todo professor"
//   departamentos   por FILA: Financeiro, Vendas, Suporte
//   pessoas         nominal, para a exceção
//
// Os três últimos se somam (OU, não E): estar em qualquer uma das listas basta.
// Um "E" entre elas pareceria mais poderoso e seria impossível de explicar na
// tela — "esta aba é para quem é recepcionista **e** está no Financeiro" é uma
// frase que ninguém monta de propósito.
//
// ── PAPEL E DEPARTAMENTO RESPONDEM COISAS DIFERENTES ───────────────────
//
// Já está escrito em `Departamento_model.js` e vale aqui: papel é **o que a
// pessoa pode fazer**, departamento é **por onde o assunto entra**. Duas
// recepcionistas com o mesmo papel podem estar em filas diferentes, e é
// exatamente por isso que as duas formas existem lado a lado — endereçar a aba
// de cobrança ao Financeiro não é a mesma coisa que endereçá-la a um papel.
function AbaDoPainel_model(app) {
  this.app = app;
}

AbaDoPainel_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("dashboard_tabs");
};

// ── AS PEÇAS SÃO VALIDADAS COMO FORMATO, NÃO CONTRA UM CATÁLOGO ────────
//
// O catálogo de números (`views/dashboard/catalogo.js` no painel, `lib/painel.js`
// no app) mora nos CLIENTES, porque é ele que sabe desenhar cada um. Repetir a
// lista aqui criaria duas listas para manter, e a esquecida seria sempre esta —
// o dia em que o painel ganhasse um número novo, o servidor o recusaria ao
// salvar, com uma mensagem que ninguém entenderia.
//
// Então aqui se exige só a FORMA de uma chave, e quem não reconhece ignora: o
// painel já monta a aba filtrando o catálogo, e uma chave desconhecida some
// sozinha. O estrago possível é uma aba com um item a menos, não um erro.
function pecasValidas(bruto) {
  if (!Array.isArray(bruto)) return [];

  const vistas = new Set();
  const saida = [];

  // Vinte e quatro é teto de sanidade: o catálogo inteiro tem doze peças hoje,
  // e uma aba com o dobro disso é alguém mandando lixo, não alguém montando
  // uma tela.
  for (const chave of bruto.slice(0, 24)) {
    const texto = String(chave || "").trim();
    if (!/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)?$/.test(texto)) continue;
    if (vistas.has(texto)) continue;
    vistas.add(texto);
    saida.push(texto);
  }

  return saida;
}

function idsValidos(bruto, teto = 100) {
  if (!Array.isArray(bruto)) return [];

  const vistos = new Set();
  const saida = [];

  for (const id of bruto.slice(0, teto)) {
    const texto = String(id || "");
    if (!ObjectId.isValid(texto) || vistos.has(texto)) continue;
    vistos.add(texto);
    saida.push(new ObjectId(texto));
  }

  return saida;
}

// ── O PÚBLICO VAZIO VIRA "TODOS" ───────────────────────────────────────
//
// Desmarcar "todos" e não escolher ninguém deixaria uma aba que existe no
// cadastro e não aparece para ser humano nenhum — inclusive para quem acabou de
// criá-la, que ficaria procurando o erro na tela errada. Nesse caso ela volta a
// ser de todo mundo, que é o estado em que dá para ver o que se fez.
function publicoValido(bruto) {
  const p = bruto && typeof bruto === "object" ? bruto : {};

  const papeis = idsValidos(p.papeis);
  const departamentos = idsValidos(p.departamentos);
  const pessoas = idsValidos(p.pessoas);

  const escolheuAlguem = papeis.length || departamentos.length || pessoas.length;
  const todos = p.todos === true || !escolheuAlguem;

  // Com "todos" ligado as listas são apagadas, e não guardadas em silêncio.
  // Guardá-las faria a tela reabrir com marcações que não valem nada — e, pior,
  // voltariam a valer no dia em que alguém desligasse o "todos" sem olhar.
  if (todos) return { todos: true, papeis: [], departamentos: [], pessoas: [] };

  return { todos: false, papeis, departamentos, pessoas };
}

const CAMPOS = {
  nome: (v) => String(v || "").trim().slice(0, 60),
  pecas: (v) => pecasValidas(v),
  ordem: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
  // DESLIGADA em vez de apagada: uma aba que sumiu do dia para a noite manda
  // todo mundo perguntar quem mexeu. Desligar tira da vista e deixa o caminho
  // de volta num clique.
  ativo: (v) => v !== false,
  publico: (v) => publicoValido(v),
};

function limpar(obj, { parcial = false } = {}) {
  const saida = {};
  for (const [campo, tratar] of Object.entries(CAMPOS)) {
    if (parcial && obj[campo] === undefined) continue;
    saida[campo] = tratar(obj[campo]);
  }
  return saida;
}

AbaDoPainel_model.prototype.list = async function ({ ativas = false } = {}) {
  const col = await this.collection();
  const filtro = ativas ? { ativo: { $ne: false } } : {};
  return col.find(filtro).collation({ locale: "pt" }).sort({ ordem: 1, nome: 1 }).toArray();
};

AbaDoPainel_model.prototype.data = async function (id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();
  return (await col.findOne({ _id: new ObjectId(String(id)) })) || undefined;
};

// ── AS ABAS QUE ESTA PESSOA RECEBE ─────────────────────────────────────
//
// Uma consulta a mais, nos departamentos, para saber de quais filas ela faz
// parte. É a direção "cara" da estrutura — os membros moram no documento do
// departamento, e não no usuário (ver `Departamento_model.js`) —, mas acontece
// uma vez por abertura do painel sobre uma coleção de dezenas de documentos.
// Inverter a estrutura por causa disto encareceria a pergunta que o chat vai
// fazer o tempo todo ("quem atende esta fila?") para baratear esta.
AbaDoPainel_model.prototype.daPessoa = async function (user) {
  if (!user || !user._id) return [];

  const db = await this.app.mongodb.connectToServer();

  const minhasFilas = await db
    .collection("departments")
    .find({ membros: user._id, ativo: { $ne: false } }, { projection: { _id: 1 } })
    .toArray();

  const col = await this.collection();

  // `$in: []` não casa com nada, que é o que se quer quando a pessoa não está
  // em fila nenhuma — não é preciso montar o `$or` condicionalmente.
  return col
    .find({
      ativo: { $ne: false },
      $or: [
        { "publico.todos": true },
        { "publico.papeis": user.role || null },
        { "publico.pessoas": user._id },
        { "publico.departamentos": { $in: minhasFilas.map((d) => d._id) } },
      ],
    })
    .collation({ locale: "pt" })
    .sort({ ordem: 1, nome: 1 })
    .toArray();
};

AbaDoPainel_model.prototype.insert = async function (obj, { porQuem } = {}) {
  const doc = limpar(obj);
  if (!doc.nome) return { erro: "sem_nome" };

  const col = await this.collection();

  // A ordem padrão é o fim da fila. Sem isto toda aba nova nasceria com
  // `ordem: 0` e furaria na frente das que já estavam lá.
  if (!obj.ordem) {
    const ultima = await col.find({}).sort({ ordem: -1 }).limit(1).toArray();
    doc.ordem = (ultima[0]?.ordem || 0) + 1;
  }

  const r = await col.insertOne({
    ...doc,
    criadaPor: porQuem && ObjectId.isValid(String(porQuem)) ? new ObjectId(String(porQuem)) : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { id: r.insertedId };
};

AbaDoPainel_model.prototype.update = async function (id, obj) {
  if (!ObjectId.isValid(id)) return { erro: "nao_encontrado" };

  const col = await this.collection();
  const antes = await col.findOne({ _id: new ObjectId(String(id)) });
  if (!antes) return { erro: "nao_encontrado" };

  const set = limpar(obj, { parcial: true });
  if (set.nome !== undefined && !set.nome) return { erro: "sem_nome" };

  await col.updateOne({ _id: antes._id }, { $set: { ...set, updatedAt: new Date() } });
  return { id: antes._id };
};

AbaDoPainel_model.prototype.remove = async function (id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();
  const r = await col.deleteOne({ _id: new ObjectId(String(id)) });
  return r.deletedCount > 0;
};

// A ordem é salva de uma vez, pela lista de ids — a tela arrasta e manda a
// ordem final. Salvar aba por aba faria N chamadas e deixaria a faixa metade
// ordenada se a quarta falhasse.
AbaDoPainel_model.prototype.reordenar = async function (ids) {
  const limpos = idsValidos(ids);
  if (!limpos.length) return { ok: false };

  const col = await this.collection();
  await Promise.all(
    limpos.map((id, i) => col.updateOne({ _id: id }, { $set: { ordem: i, updatedAt: new Date() } }))
  );

  return { ok: true };
};

module.exports = AbaDoPainel_model;
