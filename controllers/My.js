const { catalogoPara } = require("../lib/examMarkers.js");
const tempo = require("../lib/tempo.js");

// A ÁREA DA PESSOA: as rotas que o ALUNO usa para ver o que é dele.
//
// Elas existem porque as rotas da ficha são do PROFISSIONAL: exigem permissão
// (`workouts.view`) e escopo (`dataStudent(trainer, pessoa)`) — um aluno não tem
// nem uma coisa nem outra. Aqui a autorização é a IDENTIDADE: quem pergunta é o
// dono do dado, e o filtro é sempre `student = eu`, cravado do lado do servidor.
// Não existe `:personId` em rota nenhuma — um id na URL seria um convite para
// trocá-lo.
//
// Filtro por pessoa, SEM recorte de profissional, de propósito: numa clínica com
// dois profissionais, o treino que o segundo montou é tão do aluno quanto o do
// primeiro. O aluno não conhece a divisão interna da equipe, e a área dele não
// deveria obrigá-lo a conhecer.
//
// Tudo aqui é LEITURA. O aluno marca horário pela agenda pública (as rotas
// `/public/booking`, que casam a pessoa pelo e-mail) — escrever na ficha
// continua sendo trabalho de quem atende.
module.exports = function (app) {
  // ── O PORTÃO: quem É ACOMPANHADO, e não quem é "do tipo aluno" ────────────
  //
  // A regra era `type === "student"`, com o argumento de que "um profissional
  // tem a ficha inteira, devolver os treinos dele aqui seria uma lista vazia
  // com cara de defeito". O argumento assumia que profissional nunca é
  // atendido — e o Marlon é o contraexemplo: profissional na conta dele,
  // ATENDIDO na conta do Willian, com três dietas e uma avaliação montadas
  // para ele que nenhuma tela alcançava.
  //
  // Ele caía num vão: a home de profissional lista quem ELE acompanha
  // (ninguém), e a área de quem é acompanhado estava fechada pelo tipo.
  //
  // A pergunta certa não é "que tipo de conta é esta?", é "alguém acompanha
  // esta pessoa?". Quem tem vínculo tem o que ver aqui, seja qual for o tipo.
  //
  // NÃO afrouxa nada: o filtro de todas as rotas continua sendo `student = eu`,
  // cravado no servidor. Ninguém passa a ver o dado de outro — passa a ver o
  // PRÓPRIO, que é o que esta área sempre serviu.
  async function aluno(req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return false;

    if (user.type === "student") return user;

    // Um profissional sem ninguém acompanhando-o continua recebendo 403: para
    // ele esta área é mesmo uma lista vazia, e a mensagem manda para a ficha.
    const acompanhado = await app.api.link.countProfessionalsOf(user._id);
    if (!acompanhado) {
      res.status(403).send({ msg: req.t("errors.studentAreaOnly") });
      return false;
    }

    return user;
  }

  // O RESUMO que abre a tela inicial: uma chamada, os números de cada porta e o
  // próximo compromisso. O celular abre a área da pessoa no elevador — quatro
  // requisições para desenhar quatro cartões seria pagar a latência quatro vezes.
  app.get("/my/overview", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const [treinos, dietas, exames, agenda, suplementos] = await Promise.all([
      app.api.workout.listOfStudent(eu._id),
      app.api.diet.listOfStudent(eu._id),
      app.api.exam.listOfStudent(eu._id),
      app.api.appointment.listAllOfStudent(eu._id),
      app.api.supplement.listOfStudent(eu._id),
    ]);

    const agora = new Date();
    const proximo = agenda.find((a) => a.status !== "canceled" && new Date(a.date) >= agora);
    // Suplemento só conta o de HOJE — é o que `/my/supplements` mostra.
    const suplementosDeHoje = suplementos.filter((s) => s.status === "current").length;

    res.send({
      counts: {
        // O que vale HOJE, como os selos da ficha: treino encerrado em março
        // não é "o meu treino".
        workouts: treinos.filter((w) => w.status === "current").length,
        diets: dietas.filter((d) => d.status === "current").length,
        supplements: suplementosDeHoje,
        exams: exames.length,
        appointments: agenda.filter((a) => a.status !== "canceled" && new Date(a.date) >= agora)
          .length,
      },
      // ── O QUE EXISTE ATRÁS DE CADA PORTA (16/11/2026) ──────────────────
      //
      // *"se não tem treino, não mostre; se não tem dieta, não mostre o
      // botão"*. A porta (e o item do menu) some quando a tela atrás dela
      // estaria VAZIA — e não quando o número de hoje é zero: quem só tem um
      // treino encerrado ainda tem o histórico para abrir, e `/my/workouts`
      // o mostra. Por isso é outra pergunta que `counts`.
      //
      // A agenda não entra: ela é também onde se MARCA, e existe sem nada
      // marcado.
      has: {
        workouts: treinos.length > 0,
        diets: dietas.length > 0,
        supplements: suplementosDeHoje > 0,
        exams: exames.length > 0,
      },
      nextAppointment: proximo || null,
    });
  });

  // HOJE no relógio da CASA — a chave do treino concluído. "Fiz o treino de
  // hoje" às 23h em São Paulo não pode cair no dia seguinte porque em UTC já
  // virou.
  async function hojeDaCasa() {
    const fuso = await app.api.tenant.timezoneOfInstance().catch(() => undefined);
    return tempo.paredeDe(new Date(), fuso).data;
  }

  const SEM_FEITO = { today: false, count: 0, last: null, exercises: [] };

  app.get("/my/workouts", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const [lista, hoje] = await Promise.all([app.api.workout.listOfStudent(eu._id), hojeDaCasa()]);
    // O concluído de cada treino, para o cartão dizer "feito hoje" — uma
    // consulta para a lista inteira.
    const feitos = await app.api.workout.feitosDaPessoa(eu._id, hoje);
    const rows = lista.map((w) => ({ ...w, done: feitos[String(w._id)] || SEM_FEITO }));

    res.send({
      rows,
      counts: {
        current: rows.filter((w) => w.status === "current").length,
        past: rows.filter((w) => w.status === "past").length,
        future: rows.filter((w) => w.status === "future").length,
        all: rows.length,
      },
    });
  });

  app.get("/my/workouts/:id", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    // O filtro é (id, eu): um id de treino de OUTRA pessoa devolve 404 — de
    // fora não se distingue "não existe" de "não é seu", e é assim que deve ser.
    const workout = await app.api.workout.dataOfStudent(eu._id, req.params.id);
    if (!workout) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    // ── A DEMONSTRAÇÃO DE CADA EXERCÍCIO ────────────────────────────────
    //
    // O exercício gravado no treino é um retrato e não carrega a chave do
    // clipe — ela é do catálogo, e um retrato de dois meses atrás apontaria
    // para um clipe já regravado. Ver `Exercise_model.clipesPorExercicio`.
    //
    // Duas consultas para o treino inteiro. Exercício sem clipe não ganha
    // campo, e a tela não desenha nada por ele.
    //
    // Só na tela do TREINO ABERTO, e não na lista: a lista não mostra
    // exercício, então pagar as consultas ali seria trabalho para ninguém.
    const clipes = await app.api.exercise.clipesPorExercicio(
      (workout.exercises || []).map((e) => e.exerciseId)
    );

    const feitos = await app.api.workout.feitosDaPessoa(eu._id, await hojeDaCasa());

    res.send({
      ...workout,
      exercises: (workout.exercises || []).map((e) => {
        const c = clipes[String(e.exerciseId)];
        return c ? { ...e, ...c } : e;
      }),
      done: feitos[String(workout._id)] || SEM_FEITO,
    });
  });

  // ── CONCLUIR O TREINO DE HOJE (16/11/2026) ────────────────────────────────
  //
  // *"gostaria de marcar se foi concluído ou não"*. A pessoa marca (POST) e
  // desmarca (DELETE) o treino de HOJE — o dia é o da casa, e quem decide é o
  // servidor: um dia mandado pela tela deixaria marcar a semana inteira de
  // uma vez.
  //
  // O treino tem de ser DELA (`dataOfStudent` filtra por eu): id de treino de
  // outra pessoa responde 404, como na leitura.
  async function treinoMeu(req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return null;

    const workout = await app.api.workout.dataOfStudent(eu._id, req.params.id);
    if (!workout) {
      res.status(404).send({ msg: req.t("errors.workoutNotFound") });
      return null;
    }
    return { eu, workout };
  }

  app.post("/my/workouts/:id/done", async function (req, res) {
    const achado = await treinoMeu(req, res);
    if (!achado) return;

    const hoje = await hojeDaCasa();
    await app.api.workout.marcarFeito(achado.eu._id, achado.workout._id, hoje, (req.body || {}).origem);
    const feitos = await app.api.workout.feitosDaPessoa(achado.eu._id, hoje);

    res.send({ done: feitos[String(achado.workout._id)] || SEM_FEITO });
  });

  app.delete("/my/workouts/:id/done", async function (req, res) {
    const achado = await treinoMeu(req, res);
    if (!achado) return;

    const hoje = await hojeDaCasa();
    await app.api.workout.desmarcarFeito(achado.eu._id, achado.workout._id, hoje);
    const feitos = await app.api.workout.feitosDaPessoa(achado.eu._id, hoje);

    res.send({ done: feitos[String(achado.workout._id)] || SEM_FEITO });
  });

  // ── EXERCÍCIO A EXERCÍCIO (16/11/2026) ────────────────────────────────────
  //
  // *"queria concluir exercício por exercício"*. `:n` é a POSIÇÃO do exercício
  // no treino (0, 1, 2…) — ver Workout_model.marcarExercicio. Marcar o último
  // conclui o treino, e a resposta diz `completou: true` só nessa vez, para a
  // tela comemorar uma vez só.
  async function marcarExercicio(req, res, feito) {
    const achado = await treinoMeu(req, res);
    if (!achado) return;

    const total = (achado.workout.exercises || []).length;
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= total) {
      res.status(400).send({ msg: req.t("errors.workoutNotFound") });
      return;
    }

    const hoje = await hojeDaCasa();
    const { completou } = await app.api.workout.marcarExercicio(
      achado.eu._id,
      achado.workout._id,
      hoje,
      n,
      feito,
      total,
      (req.body || {}).origem
    );
    const feitos = await app.api.workout.feitosDaPessoa(achado.eu._id, hoje);

    res.send({ done: feitos[String(achado.workout._id)] || SEM_FEITO, completou: Boolean(completou) });
  }

  app.post("/my/workouts/:id/exercises/:n/done", (req, res) => marcarExercicio(req, res, true));
  app.delete("/my/workouts/:id/exercises/:n/done", (req, res) => marcarExercicio(req, res, false));

  app.get("/my/diets", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const rows = await app.api.diet.listOfStudent(eu._id);

    res.send({
      rows,
      counts: {
        current: rows.filter((d) => d.status === "current").length,
        past: rows.filter((d) => d.status === "past").length,
        future: rows.filter((d) => d.status === "future").length,
        all: rows.length,
      },
    });
  });

  app.get("/my/exams", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const rows = await app.api.exam.listOfStudent(eu._id);

    // O catálogo resolvido pelo MEU sexo — mesma regra da rota do profissional.
    res.send({ rows, catalog: catalogoPara(eu.sex) });
  });

  app.get("/my/supplements", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const rows = await app.api.supplement.listOfStudent(eu._id);

    // Só o que vale HOJE: a pergunta de quem abre é "o que eu tomo", e um
    // termogênico encerrado em março não é resposta. Os momentos vão junto para
    // a tela agrupar com os mesmos rótulos da ficha.
    res.send({
      rows: rows.filter((s) => s.status === "current"),
      moments: app.api.supplement.MOMENTOS,
    });
  });

  app.get("/my/appointments", async function (req, res) {
    const eu = await aluno(req, res);
    if (eu === false) return;

    const todos = await app.api.appointment.listAllOfStudent(eu._id);
    const agora = new Date();

    // Repartido AQUI, e não na tela: "o que vem" e "o que já foi" são as duas
    // perguntas da agenda, e as duas pontas (web futura e app) repartirão igual.
    const validos = todos.filter((a) => a.status !== "canceled");

    // Quem atende, para a tela dizer "com a Bruna" — id sozinho não veste tela.
    //
    // E a FOTO dela (16/11/2026): *"quando cliquei em ver minha agenda poderia
    // aparecer a foto da pessoa que vai me atender"*. Vai o `avatarAt`, que é a
    // versão; os bytes saem de `/avatars/:id`, que já serve qualquer conta da
    // casa a quem está logado. Uma consulta para todos, e não uma por linha.
    const fichas = await app.api.user.briefByIds(validos.map((a) => a.trainer));
    const vestido = (a) => {
      const f = fichas[String(a.trainer)];
      return {
        ...a,
        trainerName: f?.name || "",
        professional: f ? { _id: String(a.trainer), name: f.name, avatarAt: f.avatarAt || null } : null,
      };
    };

    res.send({
      upcoming: validos.filter((a) => new Date(a.date) >= agora).map(vestido),
      past: validos
        .filter((a) => new Date(a.date) < agora)
        .reverse()
        .map(vestido),
    });
  });
};
