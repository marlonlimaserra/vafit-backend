// As FOTOS do catálogo de alimentos, vistas deste lado.
//
// A collection `food_images` vive no banco CENTRAL e é do painel: ele cria,
// indexa e escreve. Daqui é só leitura — a mesma divisão de `instances`, ao
// contrário.
//
// ── Por que este backend serve a imagem, se o painel já serve ─────────────
//
// Porque o app não fala com o painel. Ele conhece um endereço só, o do backend
// dele; apontar uma `<img>` do aplicativo para `backend-center.gofitnow.fit`
// amarraria a tela do aluno à disponibilidade do painel e a mais um domínio
// para configurar, medir e manter no ar.
//
// Os bytes são os mesmos, lidos da mesma collection. O que muda é de quem é a
// porta.
function FoodImage_model(app) {
  this.app = app;
}

// O nome do alimento vira a chave: "Peito de frango grelhado" →
// "peito-de-frango-grelhado". A MESMA função do painel — as duas leem a mesma
// collection, então elas têm de concordar sobre o que é uma chave válida.
function slug(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

FoodImage_model.prototype.collection = async function () {
  // centralDb: a foto é do catálogo, que é de todos os clientes — não do banco
  // de uma instância.
  const db = await this.app.mongodb.centralDb();
  return db.collection("food_images");
};

FoodImage_model.prototype.byKey = async function (key) {
  const chave = slug(key);
  if (!chave) return undefined;
  const col = await this.collection();
  return (await col.findOne({ key: chave })) || undefined;
};

// A chave que um NOME de alimento TERIA no catálogo — o "caminho de trás".
//
// Um alimento gravado dentro de uma refeição guarda uma CÓPIA do catálogo, e a
// chave da foto (`imageKey`) é copiada no momento em que ele entra. Planos
// gerados (IA) e planos antigos foram gravados SEM essa chave: o alimento tem só
// o nome. Mas o nome dele É o rótulo do catálogo, e `slug(rótulo)` é a chave —
// então "Couve refogada" acha `couve-refogada` sozinho.
//
// É a MESMA adivinhação que a tela da dieta faz (`chaveDaFoto`, `adivinhar:true`
// em views/student/diets/nutricao.js). Ela só é segura porque `byKey` casa a
// chave exata ou devolve nada: nome que não existe no catálogo ("Abacate cru" →
// "abacate-cru") não aponta para foto alheia, aponta para foto nenhuma.
FoodImage_model.prototype.chaveDoNome = function (nome) {
  return slug(nome);
};

module.exports = FoodImage_model;
module.exports.slug = slug;
