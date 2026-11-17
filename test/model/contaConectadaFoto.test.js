const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const instanceContext = require("../../lib/instance.js");
const arquivos = require("../../lib/arquivos.js");
const baixarImagem = require("../../lib/baixarImagem.js");
const ContaConectada = require("../../model/ContaConectada_model.js");

// A FOTO DA CONTA DE FORA — copiada, nunca apontada.
//
// *"ao conectar o facebook quebrou a imagem, salve a imagem e faça o upload e
// deixe o link fixo, se eu remover a conta você remove a imagem que você
// subiu"* (15/10/2026), com o print das quatro Páginas sem foto.
//
// ── O DEFEITO ─────────────────────────────────────────────────────────────
//
// Guardava-se a URL que o Graph devolve. Ela é do CDN da Meta e vem ASSINADA
// com prazo: funciona no minuto em que a pessoa conectou e vira quadrado
// quebrado dias depois. Nada do nosso lado muda, ninguém liga uma coisa à
// outra, e o que se vê é "o sistema está bugado".
//
// O que estes casos seguram é o que não dá para ver olhando a tela no dia em
// que foi feita: que os BYTES foram copiados, que a URL de fora ficou só como
// origem, e que apagar a conta apaga os bytes — senão o balde acumula foto de
// Página que ninguém conectou mais, para sempre.

const ID = new ObjectId("6ab87796d58878d726fe75fa");
const BYTES = Buffer.from([1, 2, 3, 4]);

// Os dois módulos de verdade, trocados por dublês em volta de cada caso. São
// objetos de `module.exports`, e é assim que este projeto já dubla rede.
function comDubles(cenario, corpo) {
  const originais = {
    baixar: baixarImagem.baixar,
    ondeGuardar: arquivos.ondeGuardar,
    apagar: arquivos.apagar,
  };

  const registro = { baixadas: [], guardadas: [], apagadas: [] };

  baixarImagem.baixar = async (url) => {
    registro.baixadas.push(String(url));
    return cenario.baixa === undefined ? { mime: "image/jpeg", bytes: BYTES } : cenario.baixa;
  };
  arquivos.ondeGuardar = async (chave, bytes, mime) => {
    registro.guardadas.push({ chave, bytes, mime });
    return cenario.noBanco
      ? { set: { data: bytes }, unset: { chave: "" } }
      : { set: { chave }, unset: { data: "" } };
  };
  arquivos.apagar = async (chave) => {
    registro.apagadas.push(chave);
    return true;
  };

  return corpo(registro).finally(() => {
    baixarImagem.baixar = originais.baixar;
    arquivos.ondeGuardar = originais.ondeGuardar;
    arquivos.apagar = originais.apagar;
  });
}

function modelo({ docs = [] } = {}) {
  const chamadas = [];
  const col = {
    find(filtro, opcoes) {
      chamadas.push({ metodo: "find", filtro, opcoes });
      return { sort: () => ({ async toArray() { return docs; } }), async toArray() { return docs; } };
    },
    async findOne(filtro, opcoes) {
      chamadas.push({ metodo: "findOne", filtro, opcoes });
      return docs[0] || null;
    },
    async updateOne(filtro, mudanca, opcoes) {
      chamadas.push({ metodo: "updateOne", filtro, mudanca, opcoes });
    },
    async deleteOne(filtro) {
      chamadas.push({ metodo: "deleteOne", filtro });
      return { deletedCount: 1 };
    },
  };

  const m = new ContaConectada({
    mongodb: { async connectToServer() { return { collection: () => col }; } },
  });
  return { m, chamadas };
}

const naCasa = (fn) => instanceContext.run("marlon", fn);

test("conectar COPIA os bytes da foto, e a URL da Meta fica só como origem", async () => {
  await comDubles({}, async (reg) => {
    const { m, chamadas } = modelo({ docs: [{ _id: ID, tipo: "facebook", externalId: "7788" }] });

    await naCasa(() =>
      m.guardar({
        tipo: "facebook",
        externalId: "7788",
        token: "t",
        nome: "SuperGeeks",
        foto: "https://scontent.xx.fbcdn.net/foto.jpg?_nc_sid=abc&oe=EXPIRA",
      })
    );

    assert.deepEqual(reg.baixadas, ["https://scontent.xx.fbcdn.net/foto.jpg?_nc_sid=abc&oe=EXPIRA"]);

    // O upsert guarda a URL como ORIGEM, e NÃO no campo que a tela lê.
    const upsert = chamadas.find((c) => c.metodo === "updateOne" && c.opcoes?.upsert);
    assert.equal(upsert.mudanca.$set.fotoDeFora, "https://scontent.xx.fbcdn.net/foto.jpg?_nc_sid=abc&oe=EXPIRA");
    assert.equal(upsert.mudanca.$set.foto, undefined, "o campo antigo não volta");

    // E os bytes foram para a pasta do cliente, com o id da conta por nome.
    assert.equal(reg.guardadas.length, 1);
    assert.equal(reg.guardadas[0].chave, `marlon/contas/${ID}`);
    assert.equal(reg.guardadas[0].mime, "image/jpeg");
  });
});

test("a chave do arquivo é o id da CONTA — reconectar sobrescreve, não acumula", async () => {
  await comDubles({}, async (reg) => {
    const { m } = modelo({ docs: [{ _id: ID, tipo: "facebook", externalId: "7788" }] });

    await naCasa(() => m.copiarFoto({ _id: ID }, "https://x/1.jpg"));
    await naCasa(() => m.copiarFoto({ _id: ID }, "https://x/2.jpg"));

    // Duas cópias, UMA chave: é o que dispensa esta foto da coleta de lixo que
    // a capa de plano e a do aulão precisam ter.
    assert.deepEqual(new Set(reg.guardadas.map((g) => g.chave)), new Set([`marlon/contas/${ID}`]));
  });
});

test("download que falha não derruba a conexão — fica sem foto, e pronto", async () => {
  await comDubles({ baixa: null }, async (reg) => {
    const { m, chamadas } = modelo({ docs: [{ _id: ID, tipo: "facebook", externalId: "7788" }] });

    const salva = await naCasa(() =>
      m.guardar({ tipo: "facebook", externalId: "7788", token: "t", foto: "https://x/f.jpg" })
    );

    assert.equal(reg.guardadas.length, 0);
    assert.ok(salva !== undefined, "a conta foi gravada do mesmo jeito");
    assert.ok(chamadas.some((c) => c.opcoes?.upsert), "o upsert aconteceu");
  });
});

test("foto só é baixada quando há URL — conta sem foto não bate na rede", async () => {
  await comDubles({}, async (reg) => {
    const { m } = modelo({ docs: [{ _id: ID }] });

    await naCasa(() => m.guardar({ tipo: "instagram", externalId: "9", token: "t", foto: "" }));

    assert.deepEqual(reg.baixadas, []);
  });
});

test("desconectar APAGA os bytes que subimos", async () => {
  await comDubles({}, async (reg) => {
    const { m, chamadas } = modelo({
      docs: [{ _id: ID, fotoArquivo: { chave: `marlon/contas/${ID}` } }],
    });

    const r = await naCasa(() => m.remover(String(ID)));

    assert.equal(r.ok, true);
    assert.deepEqual(reg.apagadas, [`marlon/contas/${ID}`]);
    // A chave foi lida ANTES do delete: depois dele não há como saber qual
    // arquivo era, e os bytes ficariam no balde para sempre.
    const ordem = chamadas.map((c) => c.metodo);
    assert.ok(ordem.indexOf("findOne") < ordem.indexOf("deleteOne"));
  });
});

test("e desconectar conta sem foto não tenta apagar nada", async () => {
  await comDubles({}, async (reg) => {
    const { m } = modelo({ docs: [{ _id: ID }] });

    assert.equal((await naCasa(() => m.remover(String(ID)))).ok, true);
    assert.deepEqual(reg.apagadas, []);
  });
});

test("a tela recebe a DATA da cópia, nunca a URL da Meta", async () => {
  const { m } = modelo();
  const em = new Date("2026-10-15T12:00:00Z");

  const tela = m.paraTela({
    _id: ID,
    tipo: "facebook",
    externalId: "7788",
    fotoDeFora: "https://scontent.xx.fbcdn.net/expira.jpg",
    fotoArquivo: { chave: "k", mime: "image/jpeg", em },
  });

  assert.equal(tela.fotoEm, em);
  assert.equal(tela.foto, undefined, "o endereço quem monta é o controlador");
  assert.equal(JSON.stringify(tela).includes("fbcdn"), false);
});

test("e o token continua fora de tudo o que a tela recebe", async () => {
  const { m } = modelo();
  const tela = m.paraTela({ _id: ID, tipo: "facebook", externalId: "7788", token: "EAAB-segredo" });

  assert.equal(JSON.stringify(tela).includes("EAAB-segredo"), false);
});

test("a lista não traz os bytes da foto junto", async () => {
  const { m, chamadas } = modelo({ docs: [] });

  await m.lista("facebook");

  // Numa casa com 200 Páginas, trazer a imagem de cada uma para montar uma
  // lista de nomes é megabyte de banco atravessando a memória para nada.
  assert.equal(chamadas[0].opcoes.projection["fotoArquivo.data"], 0);
  assert.equal(chamadas[0].opcoes.projection.token, 0);
});
