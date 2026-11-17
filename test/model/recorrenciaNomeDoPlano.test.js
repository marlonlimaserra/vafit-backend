const test = require("node:test");
const assert = require("node:assert/strict");

const Recurrence_model = require("../../model/Recurrence_model.js");

// A RECORRÊNCIA NASCIDA DE UM PLANO NÃO GUARDA O NOME DELE.
//
// *"descrição deveria ficar em branco e deveria ter um select para escolher o
// plano"* (15/10/2026), olhando uma mensalidade com "Plano Fit" no seletor e
// "Plano Fit" de novo no campo logo abaixo.
//
// O que fica guardado é o VÍNCULO. O nome é resolvido na hora de mostrar — e é
// esta tabela, a do Financeiro geral, que precisava aprender a resolvê-lo:
// sem a junção, toda mensalidade vendida pela vitrine vira um travessão na
// coluna "O quê".
//
// Estes casos medem o PIPELINE, e não o resultado: não há Mongo aqui. O que
// eles seguram é a ordem, que é onde isto quebraria em silêncio.
function pipelineDe() {
  const pipelines = [];
  const model = new Recurrence_model({});

  model.collection = async () => ({
    aggregate(pipeline) {
      pipelines.push(pipeline);
      return { async toArray() { return [{ resumo: [], rows: [], total: [] }]; } };
    },
  });

  return { model, pipelines };
}

const juncaoComPlano = (pipeline) =>
  pipeline.find((e) => e.$lookup && e.$lookup.from === "memberships");

test("a tabela junta o plano para poder nomear a regra sem descrição", async () => {
  const { model, pipelines } = pipelineDe();

  await model.todas({}).catch(() => {});
  const junta = juncaoComPlano(pipelines[0]);

  assert.ok(junta, "sem a junção, a coluna sai vazia para quem veio da vitrine");
  // O `instance` à mão: sub-pipeline de `$lookup` não passa pelo escopo
  // automático, e sem ele a junção leria o plano de OUTRO cliente.
  const filtro = junta.$lookup.pipeline[0].$match;
  assert.ok("instance" in filtro || filtro.$expr, "a junção precisa do recorte do cliente");
});

test("o nome resolvido entra ANTES do recorte — procurar pelo plano acha a regra", async () => {
  // A busca da tela casa contra `description`. Se a queda para o nome do plano
  // acontecesse só na projeção, procurar por "Plano Fit" não acharia nenhuma
  // das mensalidades vendidas pela vitrine.
  const { model, pipelines } = pipelineDe();

  await model.todas({ busca: "Plano Fit" }).catch(() => {});
  const pipeline = pipelines[0];

  const ondeJunta = pipeline.findIndex((e) => e.$lookup && e.$lookup.from === "memberships");
  const ondeDeriva = pipeline.findIndex((e) => e.$addFields && e.$addFields.description);
  const facet = pipeline.findIndex((e) => e.$facet);

  assert.ok(ondeJunta >= 0 && ondeDeriva > ondeJunta, "a derivação tem de vir depois da junção");
  assert.ok(facet > ondeDeriva, "o recorte da busca mora no $facet, depois da derivação");

  const buscaNoFacet = JSON.stringify(pipeline[facet].$facet.rows);
  assert.ok(buscaNoFacet.includes("description"), "a busca continua casando pela descrição");
});
