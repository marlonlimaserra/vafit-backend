// Os campos que aceitam "auto preencher": aqueles onde o profissional digita
// as mesmas coisas o tempo todo.
//
// A CHAVE fica gravada em cada valor salvo e nunca muda — renomear uma
// esconderia tudo que já foi guardado para aquele campo. O rótulo é só
// apresentação.
//
// Para oferecer um campo novo, basta acrescentar aqui: a tela do perfil se
// monta a partir desta lista, e o formulário pede pela chave.
const FIELDS = [
  { key: "workout.name", group: "workout" },
  { key: "workout.goal", group: "workout" },
  { key: "workout.tip", group: "workout", multiline: true },
  { key: "workout.calories", group: "workout" },
  { key: "workout.totalSessions", group: "workout" },
  { key: "session.name", group: "workout" },
  { key: "diet.name", group: "diet" },
  { key: "diet.goal", group: "diet" },
  // Multilinha, como a dica do treino: aqui cabe orientação de duas ou três
  // frases, e um campo de uma linha cortaria a leitura na tela do perfil.
  { key: "diet.mealNote", group: "diet", multiline: true },
  // A observação da coleta: o que aconteceu naquele dia e não cabe em número —
  // "em jejum", "logo após o treino", "relatou inchaço". São sempre as mesmas
  // meia dúzia de frases, e é exatamente o caso do auto preencher.
  { key: "assessment.note", group: "assessments", multiline: true },
  // O que é o encontro: "Treino", "Consulta", "Reavaliação". São sempre as
  // mesmas meia dúzia de palavras, digitadas a cada compromisso marcado.
  { key: "appointment.title", group: "schedule" },
  // O combinado do encontro: "levar toalha", "vem em jejum", "avaliar joelho".
  // Multilinha, como a dica do treino — cabe uma orientação de duas frases.
  { key: "appointment.note", group: "schedule", multiline: true },
  // A DURAÇÃO do encontro, em minutos (16/11/2026): *"permita eu digitar o
  // tempo, coloque essas durações na configuração do auto preencher, para eu
  // configurar as que eu uso, às vezes só uso uma"*.
  //
  // NUMÉRICO: o valor é um inteiro de minutos (guardado como texto, como todo
  // valor daqui), e a validação é de número, não de frase.
  //
  // `padrao` são as seis durações que o formulário oferecia cravadas no código.
  // Elas entram UMA vez na lista de cada profissional (ver `semear` no modelo),
  // e a partir daí a lista é dele: apagar a de 45 tira o 45 do formulário, e
  // apagar todas deixa só o campo de digitar.
  {
    key: "appointment.minutes",
    group: "schedule",
    numeric: true,
    padrao: ["30", "45", "50", "60", "90", "120"],
  },
  // O que se está cobrando: "Mensalidade", "Aulão na praia", "Avaliação
  // física". É a frase mais repetida do sistema inteiro — toda cobrança tem
  // uma, e numa conta com trinta alunos são trinta vezes a mesma.
  { key: "charge.description", group: "finance" },
  // A observação da cobrança: o combinado que não cabe na descrição — "pagou
  // metade agora, metade dia 10", "cancelada porque o aulão choveu".
  // Multilinha, como as outras observações.
  { key: "charge.note", group: "finance", multiline: true },
  { key: "person.goal", group: "people" },
];

const KEYS = FIELDS.map((f) => f.key);

function isValid(key) {
  return KEYS.includes(String(key));
}

function campo(key) {
  return FIELDS.find((f) => f.key === String(key));
}

// Os limites de um campo numérico de minutos: cinco minutos a dez horas. Fora
// disso é dedo escorregado ("6000"), não um atendimento.
const MINUTOS_MIN = 5;
const MINUTOS_MAX = 600;

// O valor de um campo numérico, limpo — ou null se não é um número aceitável.
function minutosValidos(valor) {
  const texto = String(valor ?? "").trim();
  if (!/^\d{1,3}$/.test(texto)) return null;
  const n = Number(texto);
  return n >= MINUTOS_MIN && n <= MINUTOS_MAX ? n : null;
}

// O catálogo com os textos do idioma pedido. `group` sai como TEXTO aqui — a
// tela agrupa os campos por ele — enquanto no FIELDS acima é a chave.
function localized(t) {
  return FIELDS.map((f) => ({
    ...f,
    label: t(`autoFill.fields.${f.key}.label`),
    hint: t(`autoFill.fields.${f.key}.hint`),
    group: t(`autoFill.groups.${f.group}`),
  }));
}

module.exports = { FIELDS, KEYS, isValid, localized, campo, minutosValidos, MINUTOS_MIN, MINUTOS_MAX };
