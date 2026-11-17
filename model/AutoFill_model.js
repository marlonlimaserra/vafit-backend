const { ObjectId } = require("mongodb");
const fields = require("../lib/autoFillFields.js");

// A collection `auto_fill_values` — os valores que cada profissional guardou
// PARA CADA CAMPO.
//
// Diferente de um template, que preenche o formulário inteiro de uma vez, aqui
// cada campo tem a sua própria lista: "Objetivo" oferece objetivos, "Dica"
// oferece dicas. Serve para o caso comum de repetir uma frase num campo só,
// sem querer trazer o resto junto.
//
// O par (profissional, campo, valor) é único: salvar duas vezes a mesma frase
// não cria duas opções idênticas na lista.
function AutoFill_model(app) {
  this.app = app;
}

AutoFill_model.prototype.collection = async function () {
  const db = await this.app.mongodb.connectToServer();
  return db.collection("auto_fill_values");
};

AutoFill_model.prototype.list = async function (professionalId, field) {
  const col = await this.collection();

  const query = { professional: new ObjectId(professionalId) };
  if (field && fields.isValid(field)) query.field = String(field);

  const rows = await col.find(query).sort({ field: 1, value: 1 }).toArray();
  return ordenar(rows);
};

// Campo NUMÉRICO em ordem de número: a ordem do banco é de texto, e nela "120"
// vem antes de "30". Os outros campos ficam como o banco devolveu.
function ordenar(rows) {
  return rows.sort((a, b) => {
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    if (fields.campo(a.field)?.numeric) return Number(a.value) - Number(b.value);
    return 0;
  });
}

// ── A SEMEADURA: o padrão entra UMA vez na lista de cada profissional ────
//
// Campo com `padrao` (as durações do compromisso) nasce com aqueles valores, e
// a partir daí a lista é dele. A marca de "já semeei" fica no documento da
// conta (`autoFillSemeado`), e é lida do BANCO, não da sessão: a sessão é
// guardada por um minuto, e com ela um valor apagado logo depois de semear
// voltaria na próxima leitura — o profissional apaga o 45 e o 45 reaparece.
//
// Inserir é upsert, então duas leituras ao mesmo tempo semeiam sem duplicar.
AutoFill_model.prototype.semear = async function (professionalId) {
  const comPadrao = fields.FIELDS.filter((f) => Array.isArray(f.padrao) && f.padrao.length);
  if (!comPadrao.length) return [];

  const conta = await this.app.api.user.data(professionalId);
  if (!conta) return [];

  const feitos = new Set((conta.autoFillSemeado || []).map(String));
  const faltam = comPadrao.filter((f) => !feitos.has(f.key));
  if (!faltam.length) return [];

  for (const f of faltam) {
    for (const valor of f.padrao) await this.insert(professionalId, f.key, valor);
  }
  await this.app.api.user.marcarAutoFillSemeado(
    professionalId,
    faltam.map((f) => f.key)
  );
  return faltam.map((f) => f.key);
};

// Devolve tudo agrupado por campo, que é como a tela do perfil desenha.
AutoFill_model.prototype.listGrouped = async function (professionalId) {
  const rows = await this.list(professionalId);

  const byField = {};
  for (const key of fields.KEYS) byField[key] = [];
  for (const row of rows) {
    if (!byField[row.field]) byField[row.field] = [];
    byField[row.field].push({ _id: row._id, value: row.value });
  }

  return byField;
};

AutoFill_model.prototype.insert = async function (professionalId, field, value) {
  const col = await this.collection();
  const clean = String(value == null ? "" : value).trim();

  if (!clean || !fields.isValid(field)) return undefined;

  // Upsert em vez de insert: repetir um valor que já está lá devolve o mesmo
  // registro em vez de sujar a lista com duplicatas.
  //
  // O driver 6 devolve o DOCUMENTO direto. O `.value` da API antiga não existe
  // mais — e aqui seria uma armadilha: este documento tem um campo chamado
  // `value`, então um fallback `r.value || r` devolveria a string salva no
  // lugar do registro.
  return await col.findOneAndUpdate(
    { professional: new ObjectId(professionalId), field: String(field), value: clean },
    { $setOnInsert: { createdAt: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
};

AutoFill_model.prototype.delete = async function (professionalId, id) {
  if (!ObjectId.isValid(id)) return false;
  const col = await this.collection();

  // O dono entra na CONSULTA: um id adivinhado não alcança a lista de outro.
  const r = await col.deleteOne({
    _id: new ObjectId(id),
    professional: new ObjectId(professionalId),
  });

  return r.deletedCount > 0;
};

AutoFill_model.prototype.data = async function (professionalId, id) {
  if (!ObjectId.isValid(id)) return undefined;
  const col = await this.collection();

  const doc = await col.findOne({
    _id: new ObjectId(id),
    professional: new ObjectId(professionalId),
  });

  return doc || undefined;
};

module.exports = AutoFill_model;
