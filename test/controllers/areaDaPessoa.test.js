const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const MyController = require("../../controllers/My.js");

// A ÁREA DA PESSOA (/my/*): as rotas que o ALUNO usa.
//
// O que estes casos guardam não é o formato das respostas — é a AUTORIZAÇÃO,
// que aqui é diferente de todo o resto do sistema:
//
//   • a identidade É o filtro: `student = eu`, cravado no servidor. Não existe
//     :personId em rota nenhuma — um id na URL seria um convite para trocá-lo.
//   • profissional NÃO entra: para ele existe a ficha. Uma lista vazia com cara
//     de defeito seria a resposta errada.
//   • treino de OUTRA pessoa devolve 404, não 403: de fora não se distingue
//     "não existe" de "não é seu".
const EU = { _id: "64b2c0f7e1a2b3c4d5e6f701", name: "Marlon", type: "student", sex: "female" };
const PROF = { _id: "64b2c0f7e1a2b3c4d5e6f7a8", name: "Bruna", type: "trainer" };

const TREINOS = [
  { _id: "w1", name: "A", status: "current", student: EU._id },
  { _id: "w2", name: "B", status: "past", student: EU._id },
];

function monta({ quem = EU, acompanhadoPor = 0 } = {}) {
  const pedidos = { workouts: [], exams: [], clipes: [], feitos: [] };
  // Os dias de treino concluído, como o modelo os guardaria: (pessoa, treino, dia).
  const feitos = [];

  const app = fakeApp({
    api: {
      // Quantos profissionais acompanham esta pessoa. É o que o portão passou a
      // perguntar no lugar de "que tipo de conta é esta?".
      link: {
        async countProfessionalsOf() {
          return acompanhadoPor;
        },
      },
      workout: {
        async listOfStudent(id) {
          pedidos.workouts.push(String(id));
          return TREINOS;
        },
        async feitosDaPessoa(studentId, hoje) {
          const meus = feitos.filter((f) => f.student === String(studentId));
          const porTreino = {};
          for (const f of meus) {
            const atual = porTreino[f.workout] || { today: false, count: 0, last: null, exercises: [] };
            const completo = f.completed !== false;
            if (completo) {
              atual.count += 1;
              if (!atual.last || f.day > atual.last) atual.last = f.day;
            }
            if (f.day === hoje) {
              atual.today = completo;
              atual.exercises = [...(f.exercises || [])].sort((a, b) => a - b);
            }
            porTreino[f.workout] = atual;
          }
          return porTreino;
        },
        async marcarExercicio(studentId, workoutId, dia, indice, feito, total) {
          pedidos.feitos.push({ acao: feito ? "exercicio" : "tirarExercicio", studentId: String(studentId), indice, total, dia });
          let f = feitos.find((x) => x.student === String(studentId) && x.workout === String(workoutId) && x.day === dia);
          if (!f) {
            if (!feito) return { completou: false };
            f = { student: String(studentId), workout: String(workoutId), day: dia, exercises: [], completed: false };
            feitos.push(f);
          }
          if (!feito) {
            f.exercises = f.exercises.filter((x) => x !== indice);
            f.completed = false;
            return { completou: false };
          }
          if (!f.exercises.includes(indice)) f.exercises.push(indice);
          if (f.completed !== false) return { completou: false };
          const todos = Array.from({ length: total }, (_, i) => i).every((i) => f.exercises.includes(i));
          if (todos) f.completed = true;
          return { completou: todos };
        },
        async marcarFeito(studentId, workoutId, dia, origem) {
          pedidos.feitos.push({ acao: "marcar", studentId: String(studentId), workoutId: String(workoutId), dia, origem });
          const ja = feitos.some((f) => f.student === String(studentId) && f.workout === String(workoutId) && f.day === dia);
          if (!ja) feitos.push({ student: String(studentId), workout: String(workoutId), day: dia });
          return true;
        },
        async desmarcarFeito(studentId, workoutId, dia) {
          pedidos.feitos.push({ acao: "desmarcar", studentId: String(studentId), workoutId: String(workoutId), dia });
          const i = feitos.findIndex((f) => f.student === String(studentId) && f.workout === String(workoutId) && f.day === dia);
          if (i >= 0) feitos.splice(i, 1);
          return i >= 0;
        },
        async dataOfStudent(studentId, id) {
          return id === "meu"
            ? {
                _id: "meu",
                name: "A",
                student: String(studentId),
                exercises: [
                  { exerciseId: "e1", name: "Agachamento" },
                  { exerciseId: "e2", name: "Supino" },
                ],
              }
            : undefined;
        },
      },
      // O catálogo, para a rota poder pedir os clipes. Só `e1` tem — é o caso
      // real: hoje 32 dos 1471 exercícios têm demonstração gravada.
      exercise: {
        async clipesPorExercicio(ids) {
          pedidos.clipes.push(ids.map(String));
          return { e1: { clipSlug: "agachamento-livre", clipV: 1725300000000 } };
        },
      },
      diet: { async listOfStudent() { return [{ _id: "d1", status: "current" }]; } },
      supplement: {
        MOMENTOS: ["wake", "any"],
        async listOfStudent() {
          return [
            { _id: "s1", name: "Creatina", moment: "wake", status: "current" },
            { _id: "s2", name: "Termogênico", moment: "any", status: "past" },
          ];
        },
      },
      exam: {
        async listOfStudent(id) {
          pedidos.exams.push(String(id));
          return [{ _id: "e1", collectedAt: "2026-08-01", markers: [] }];
        },
      },
      appointment: {
        async listAllOfStudent() {
          return [
            { _id: "a1", date: new Date(Date.now() + 86400000).toISOString(), trainer: PROF._id },
            { _id: "a2", date: new Date(Date.now() - 86400000).toISOString(), trainer: PROF._id },
            { _id: "a3", date: new Date(Date.now() + 172800000).toISOString(), trainer: PROF._id, status: "canceled" },
          ];
        },
      },
      // O relógio da casa: o "hoje" do treino concluído sai dele.
      tenant: { async timezoneOfInstance() { return "America/Sao_Paulo"; } },
      user: {
        async data() { return { _id: PROF._id, name: "Bruna" }; },
        async briefByIds(ids) {
          return Object.fromEntries(
            ids.map(String).filter((id) => id === PROF._id).map((id) => [id, { name: "Bruna", avatarAt: new Date("2026-11-01"), bio: "" }])
          );
        },
      },
    },
    helpers: { ReqProtected: { verify: async () => quem } },
  });

  MyController(app);
  return { app, pedidos };
}

test("um profissional que NÃO é acompanhado por ninguém é barrado — a ficha é o lugar dele", async () => {
  const { app, pedidos } = monta({ quem: PROF, acompanhadoPor: 0 });

  const r = await call(app, "get", "/my/workouts");

  assert.equal(r.status, 403);
  assert.equal(pedidos.workouts.length, 0);
});

// O portão pergunta "alguém acompanha esta pessoa?", e não "que tipo de conta é
// esta?".
//
// O caso real que mudou a regra: o Marlon é profissional na conta dele e
// ATENDIDO na conta do Willian — com três dietas e uma avaliação montadas para
// ele que nenhuma tela alcançava. A home de profissional listava quem ELE
// acompanha (ninguém) e esta área estava fechada pelo tipo: um vão.
test("um profissional que É acompanhado entra — e vê o que é DELE", async () => {
  const { app, pedidos } = monta({ quem: PROF, acompanhadoPor: 1 });

  const r = await call(app, "get", "/my/workouts");

  assert.equal(r.status, 200);
  // O filtro continua sendo a identidade de quem perguntou: entrar aqui nunca
  // deu acesso ao dado de outra pessoa, e continua não dando.
  assert.deepEqual(pedidos.workouts, [String(PROF._id)]);
});

test("a lista de treinos é filtrada pela MINHA identidade, não por parâmetro", async () => {
  const { app, pedidos } = monta();

  const r = await call(app, "get", "/my/workouts");

  assert.equal(r.status, 200);
  assert.deepEqual(pedidos.workouts, [String(EU._id)]);
  assert.equal(r.body.counts.current, 1);
  assert.equal(r.body.counts.all, 2);
});

test("treino de OUTRA pessoa é 404 — indistinguível de não existir", async () => {
  const { app } = monta();

  const meu = await call(app, "get", "/my/workouts/meu", { params: { id: "meu" } });
  assert.equal(meu.status, 200);

  const alheio = await call(app, "get", "/my/workouts/deOutro", { params: { id: "deOutro" } });
  assert.equal(alheio.status, 404);
});

// ── A DEMONSTRAÇÃO DO EXERCÍCIO ────────────────────────────────────────────
//
// *"Precisa mostrar aqueles vídeos que você fez dos exercícios."*
//
// O exercício gravado DENTRO do treino é um retrato e não carrega `clipSlug` —
// a chave é do catálogo. Sem este enriquecimento a tela do aluno não tem como
// saber que existe demonstração, e é por isso que ela nunca mostrou nenhuma.
test("o treino aberto vem com o clipe de quem tem, e sem campo para quem não tem", async () => {
  const { app, pedidos } = monta();

  const r = await call(app, "get", "/my/workouts/meu", { params: { id: "meu" } });

  assert.equal(r.status, 200);

  // UMA busca para o treino inteiro, com os dois ids — e não uma por exercício.
  assert.deepEqual(pedidos.clipes, [["e1", "e2"]]);

  const [agachamento, supino] = r.body.exercises;
  assert.equal(agachamento.clipSlug, "agachamento-livre");
  assert.equal(agachamento.clipV, 1725300000000);

  // O que NÃO tem clipe não ganha campo nenhum. É o caso da maioria: inventar
  // um lugar vazio para 1439 exercícios seria pior que não mostrar.
  assert.equal("clipSlug" in supino, false);
  assert.equal(supino.name, "Supino");
});

test("os exames vêm com o catálogo resolvido pelo MEU sexo", async () => {
  const { app } = monta(); // EU é female

  const r = await call(app, "get", "/my/exams");

  const hormonal = r.body.catalog.find((g) => g.key === "hormonal");
  const testo = hormonal.markers.find((m) => m.key === "testosteroneTotal");
  assert.equal(testo.low, 15);
  assert.equal(testo.high, 70);
});

test("a agenda reparte em 'o que vem' e 'o que já foi', sem os cancelados", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/my/appointments");

  assert.equal(r.body.upcoming.length, 1);
  assert.equal(r.body.past.length, 1);
  // Quem atende vem com nome — id sozinho não veste tela.
  assert.equal(r.body.upcoming[0].trainerName, "Bruna");
  // E com a versão da FOTO, para a tela pedir `/avatars/:id?v=` (16/11/2026).
  assert.equal(r.body.upcoming[0].professional._id, PROF._id);
  assert.ok(r.body.upcoming[0].professional.avatarAt);
});

test("a minha suplementação vem só com o que vale HOJE", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/my/supplements");

  // O termogênico encerrado não é "o que eu tomo".
  assert.deepEqual(r.body.rows.map((s) => s.name), ["Creatina"]);
  assert.deepEqual(r.body.moments, ["wake", "any"]);
});

test("o resumo conta o que vale HOJE e aponta o próximo compromisso", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/my/overview");

  assert.equal(r.body.counts.workouts, 1); // só o current
  assert.equal(r.body.counts.exams, 1);
  assert.equal(r.body.counts.supplements, 1); // a creatina; o termogênico encerrou
  assert.equal(r.body.nextAppointment._id, "a1"); // o cancelado de depois não ganha
});

// *"se não tem treino, não mostre; se não tem dieta, não mostre o botão"*
// (16/11/2026). `has` diz se a tela atrás da porta teria o que mostrar.
test("o resumo diz o que EXISTE atrás de cada porta", async () => {
  const { app } = monta();

  const r = await call(app, "get", "/my/overview");

  assert.deepEqual(r.body.has, { workouts: true, diets: true, supplements: true, exams: true });
});

test("sem nada montado, nenhuma porta tem o que abrir — e treino encerrado ainda conta", async () => {
  const { app } = monta();
  app.api.diet.listOfStudent = async () => [];
  app.api.exam.listOfStudent = async () => [];
  app.api.supplement.listOfStudent = async () => [{ _id: "s2", status: "past" }];
  app.api.workout.listOfStudent = async () => [{ _id: "w2", status: "past" }];

  const r = await call(app, "get", "/my/overview");

  assert.equal(r.body.counts.workouts, 0);
  // O treino encerrado é histórico que `/my/workouts` mostra: a porta fica.
  assert.equal(r.body.has.workouts, true);
  // O suplemento encerrado, não: `/my/supplements` só mostra o de hoje.
  assert.equal(r.body.has.supplements, false);
  assert.equal(r.body.has.diets, false);
  assert.equal(r.body.has.exams, false);
});

// ── O TREINO CONCLUÍDO (16/11/2026) ─────────────────────────────────────────
//
// *"gostaria de marcar se foi concluído ou não"*. A pessoa marca o treino de
// HOJE — o dia é o da casa, decidido no servidor — e só o que é DELA.
test("concluir o treino de hoje marca o DIA DA CASA, e a resposta já diz 'feito hoje'", async () => {
  const { app, pedidos } = monta();

  const r = await call(app, "post", "/my/workouts/meu/done", { body: { origem: "web" } });

  assert.equal(r.status, 200);
  assert.equal(r.body.done.today, true);
  assert.equal(r.body.done.count, 1);
  const hojeEmSP = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  assert.equal(pedidos.feitos[0].dia, hojeEmSP);
  assert.equal(pedidos.feitos[0].studentId, EU._id);
});

test("o dia vem do servidor — um dia mandado pela tela é ignorado", async () => {
  const { app, pedidos } = monta();

  await call(app, "post", "/my/workouts/meu/done", { body: { day: "2020-01-01" } });

  assert.notEqual(pedidos.feitos[0].dia, "2020-01-01");
});

test("desmarcar tira o de hoje, e o treino volta a 'não feito'", async () => {
  const { app } = monta();
  await call(app, "post", "/my/workouts/meu/done");

  const r = await call(app, "delete", "/my/workouts/meu/done");

  assert.equal(r.status, 200);
  assert.equal(r.body.done.today, false);
  assert.equal(r.body.done.count, 0);
});

test("treino de OUTRA pessoa não se marca — 404, e nada é gravado", async () => {
  const { app, pedidos } = monta();

  const r = await call(app, "post", "/my/workouts/de-outro/done");

  assert.equal(r.status, 404);
  assert.equal(pedidos.feitos.length, 0);
});

test("o treino aberto e a lista dizem se foi feito hoje", async () => {
  const { app } = monta();
  await call(app, "post", "/my/workouts/meu/done");

  const aberto = await call(app, "get", "/my/workouts/meu");
  assert.equal(aberto.body.done.today, true);

  const lista = await call(app, "get", "/my/workouts");
  // A lista do arreio não tem o treino "meu": o que importa é que TODA linha
  // venha com o campo, mesmo sem nada feito.
  assert.ok(lista.body.rows.every((w) => typeof w.done?.today === "boolean"));
});

// ── EXERCÍCIO A EXERCÍCIO (16/11/2026) ──────────────────────────────────────
//
// *"queria concluir exercício por exercício"*. O treino "meu" do arreio tem
// DOIS exercícios: marcar os dois conclui, e só a segunda marca comemora.
test("marcar exercício por exercício, e o último conclui — `completou` só nessa vez", async () => {
  const { app } = monta();

  const um = await call(app, "post", "/my/workouts/meu/exercises/0/done");
  assert.equal(um.status, 200);
  assert.deepEqual(um.body.done.exercises, [0]);
  assert.equal(um.body.done.today, false);
  assert.equal(um.body.completou, false);

  const dois = await call(app, "post", "/my/workouts/meu/exercises/1/done");
  assert.equal(dois.body.completou, true);
  assert.equal(dois.body.done.today, true);
});

test("a posição tem de existir no treino — nem negativa, nem além do último", async () => {
  const { app, pedidos } = monta();

  for (const n of ["-1", "2", "abc", "1.5"]) {
    const r = await call(app, "post", `/my/workouts/meu/exercises/${n}/done`);
    assert.equal(r.status, 400, n);
  }
  assert.equal(pedidos.feitos.length, 0);
});

test("exercício de treino de OUTRA pessoa é 404, e nada é gravado", async () => {
  const { app, pedidos } = monta();

  const r = await call(app, "post", "/my/workouts/de-outro/exercises/0/done");

  assert.equal(r.status, 404);
  assert.equal(pedidos.feitos.length, 0);
});

test("desmarcar um exercício devolve o treino para 'não concluído'", async () => {
  const { app } = monta();
  await call(app, "post", "/my/workouts/meu/exercises/0/done");
  await call(app, "post", "/my/workouts/meu/exercises/1/done");

  const r = await call(app, "delete", "/my/workouts/meu/exercises/1/done");

  assert.equal(r.body.done.today, false);
  assert.deepEqual(r.body.done.exercises, [0]);
});
