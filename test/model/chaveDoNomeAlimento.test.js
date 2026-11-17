const test = require("node:test");
const assert = require("node:assert/strict");

const FoodImage_model = require("../../model/FoodImage_model.js");

// ── A CLASSE DE DEFEITO QUE ISTO SEGURA ────────────────────────────────────
//
// 15/11/2026, relato do Marlon: *"ao clicar em ver pdf, a fotinho do alimento
// não vem"*. Os planos gerados pela IA (e os antigos) foram gravados com
// `imageKey` VAZIO em cada alimento. A tela da dieta não se importa porque
// adivinha a chave pelo NOME; o documento lia só o `imageKey` gravado e saía
// sem foto, embora o catálogo `food_images` tivesse a foto de todos.
//
// O conserto é o documento usar o MESMO caminho de trás da tela: nome → slug →
// chave. `chaveDoNome` é o dono desse slug no backend, e ele TEM de concordar,
// caractere por caractere, com o `chaveDaFoto` do frontend (nutricao.js) e com
// as chaves já gravadas no catálogo — senão o documento procuraria uma chave
// que não existe.

const model = new FoodImage_model({});

test("o nome do alimento vira a MESMA chave que o catálogo usa", () => {
  // Os cinco alimentos exatos da dieta do relato, e a chave que cada um tem no
  // catálogo `food_images` (conferido em produção).
  assert.equal(model.chaveDoNome("Suco de laranja natural"), "suco-de-laranja-natural");
  assert.equal(model.chaveDoNome("Abacaxi"), "abacaxi");
  assert.equal(model.chaveDoNome("Água de coco"), "agua-de-coco");
  assert.equal(model.chaveDoNome("Couve refogada"), "couve-refogada");
  assert.equal(model.chaveDoNome("Coxa de frango assada"), "coxa-de-frango-assada");
});

test("tira acento, caixa e pontuação — o acento é o que mais quebra", () => {
  assert.equal(model.chaveDoNome("PÃO de Fôrma"), "pao-de-forma");
  assert.equal(model.chaveDoNome("Açaí"), "acai");
  assert.equal(model.chaveDoNome("Feijão-preto, cozido"), "feijao-preto-cozido");
});

test("nome vazio vira chave vazia — e chave vazia NÃO vira foto", () => {
  // O documento só preenche a chave quando há nome, e só desenha `<img>` quando
  // a chave existe no mapa. Vazio em qualquer ponto é uma linha sem foto, que é
  // legível — nunca um ícone quebrado.
  assert.equal(model.chaveDoNome(""), "");
  assert.equal(model.chaveDoNome(null), "");
  assert.equal(model.chaveDoNome(undefined), "");
  assert.equal(model.chaveDoNome("   "), "");
});

test("concorda com o slug do próprio byKey — os dois leem a mesma collection", () => {
  // `chaveDoNome` e `byKey` têm de usar o mesmíssimo slug: um gera a chave a
  // partir do nome, o outro busca por ela. Se divergirem, a foto existe e não é
  // achada. Ambos saem de `FoodImage_model.slug`, e este teste prende isso.
  const slug = FoodImage_model.slug;
  for (const nome of ["Arroz Branco Cozido", "Pão de Açúcar", "Óleo de coco"]) {
    assert.equal(model.chaveDoNome(nome), slug(nome));
  }
});
