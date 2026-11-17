const lenteDeUnidade = require("../lib/lenteDeUnidade.js");
const tempo = require("../lib/tempo.js");

// O PAINEL — a tela que abre quando alguém entra.
//
// *"agora precisa melhorar o dashboard, ta super desatualizado nem leva em
// consideração a unidade"* (20/10/2026), com o print: quatro cartões de
// pessoas e uma lista de últimos cadastrados, numa casa que desde então ganhou
// agenda, aula coletiva, catraca, financeiro, contas a pagar e unidades.
//
// ── POR QUE UMA ROTA, E NÃO SEIS CHAMADAS DA TELA ───────────────────────
//
// Porque a tela não sabe o que PODE perguntar. Cada bloco depende de uma
// permissão e de um módulo liberado, e descobrir isso no navegador significa
// seis requisições das quais três voltam 403 — barulho no log, três idas
// perdidas na abertura, e um painel que pisca enquanto decide o que mostrar.
//
// Aqui o servidor monta o que aquela pessoa pode ver e manda pronto. O que ela
// não alcança não vem — e o que não vem a tela não desenha. É a mesma regra do
// menu, do outro lado: o menu esconde, o servidor recusa.
//
// ── A LENTE DA UNIDADE VALE PARA TUDO ───────────────────────────────────
//
// Era o pedido principal. Todo bloco passa pela cerca de `lenteDeUnidade`, e
// os que não guardam unidade PRÓPRIA — a agenda — são recortados pela unidade
// da PESSOA atendida. Ver cada bloco.
//
// ── O QUE NÃO ESTÁ AQUI ─────────────────────────────────────────────────
//
// Gráfico de evolução, comparação com o mês passado, meta. Nenhum dos três
// existe hoje em lugar nenhum do produto, e um painel que inventa número é
// pior que um painel pobre: ninguém confere o que concorda com a expectativa.
module.exports = function (app) {
  // O conjunto de agendas que esta pessoa enxerga — a própria, ou a da equipe
  // inteira com `schedule.team`. É a mesma regra de `controllers/Appointment.js`,
  // e ela mora lá porque é dele a tela; aqui é a leitura de um número.
  async function agendasVisiveis(user) {
    const daEquipe = await app.api.user.hasPermission(user, "schedule.team");
    return daEquipe ? await app.api.user.professionalIds() : [user._id];
  }

  // ── O DIA DE HOJE, NO FUSO DA CASA ────────────────────────────────────
  //
  // Tudo neste painel é "hoje" e "este mês", e as duas palavras só querem
  // dizer alguma coisa depois de passar pelo fuso: o servidor roda em UTC, e
  // às 21h de Brasília ele já virou amanhã. Um painel que troca de dia às 21h
  // é um painel que mente uma vez por dia, todo dia.
  async function quando() {
    const fuso = await app.api.tenant.timezoneOfInstance().catch(() => tempo.PADRAO);
    const agora = new Date();
    const parede = tempo.paredeDe(agora, fuso);

    const inicio = tempo.instante({ ano: parede.ano, mes: parede.mes, dia: parede.dia }, fuso);
    const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000 - 1);

    // O último dia do mês pelo truque do dia 0 do mês seguinte — `new Date` em
    // UTC só para contar quantos dias tem fevereiro, não para marcar instante.
    const ultimo = new Date(Date.UTC(parede.ano, parede.mes, 0)).getUTCDate();
    const mes = String(parede.mes).padStart(2, "0");

    return {
      fuso,
      agora,
      dia: parede.data,
      inicio,
      fim,
      mesDe: `${parede.ano}-${mes}-01`,
      mesAte: `${parede.ano}-${mes}-${String(ultimo).padStart(2, "0")}`,
    };
  }

  // ── A AGENDA DE HOJE ──────────────────────────────────────────────────
  //
  // Um compromisso NÃO guarda unidade: ele é de um profissional e de uma
  // pessoa (ver `model/Appointment_model.js`). Então a unidade dele é a de
  // quem vai ser atendido — é a mesma leitura que o financeiro faz da cobrança
  // pelo `studentUnit`, e a única que responde "o que tem hoje em Niterói".
  //
  // Cancelado fica fora do total: ele não é compromisso de hoje, é um que
  // deixou de existir. Mantê-lo faria o painel dizer "8 hoje" num dia com 5.
  async function agendaDeHoje(user, cerca, t) {
    const linhas = await app.api.appointment.between(await agendasVisiveis(user), t.inicio, t.fim);
    const vivos = linhas.filter((l) => l.status !== "canceled");
    if (!vivos.length) return { total: 0, feitos: 0, faltas: 0, aFazer: 0 };

    const naUnidade = new Set(
      (
        await app.api.user.idsNaUnidade(
          vivos.map((l) => l.student),
          cerca,
        )
      ).map(String),
    );

    const meus = vivos.filter((l) => naUnidade.has(String(l.student)));

    return {
      total: meus.length,
      feitos: meus.filter((l) => l.status === "done").length,
      faltas: meus.filter((l) => l.status === "missed").length,
      aFazer: meus.filter((l) => l.status === "scheduled").length,
    };
  }

  // ── AS AULAS COLETIVAS DE HOJE ────────────────────────────────────────
  //
  // A mesma conta de `/group-classes/today`, reduzida ao que cabe num cartão:
  // quantas acontecem hoje e quantas pessoas já estão marcadas nelas. A grade
  // inteira é a tela de Aulas; aqui é o aviso de que ela existe.
  //
  // `listActive` recebe UMA unidade — quem é restrito e não escolheu recebe a
  // primeira das dele, como naquela rota: a grade é de uma unidade por vez.
  async function aulasDeHoje(cerca, t) {
    const aulas = await app.api.groupClass.listActive(cerca.unit || (cerca.units || [])[0] || "");

    const hoje = aulas
      .map((a) => ({ aula: a, estado: app.api.groupClass.estadoAgora(a, t.agora, t.fuso) }))
      .filter((x) => x.estado.hoje);

    if (!hoje.length) return { quantas: 0, horarios: 0, inscritos: 0 };

    const contagem = await app.api.groupClassCheckin.contagemDoDia(t.dia);

    let horarios = 0;
    let inscritos = 0;
    for (const { aula } of hoje) {
      for (const h of aula.horarios || []) {
        horarios++;
        inscritos += contagem[`${aula._id}:${h.inicio}`] || 0;
      }
    }

    return { quantas: hoje.length, horarios, inscritos };
  }

  // ── AS DUAS JANELAS DO GRÁFICO ────────────────────────────────────────
  //
  // DOZE MESES para o dinheiro e os cadastros; CATORZE DIAS para a agenda e a
  // catraca. O grão não é gosto: ele é ditado pelo cartão que a linha vai
  // acompanhar. O cartão do dinheiro é do MÊS, então a série é mensal; o da
  // agenda é de HOJE, então a série é diária.
  //
  // Catorze e não trinta porque a leitura é "hoje foi um dia bom?", e a
  // resposta mora nas duas semanas de trás — com trinta barras de 3 px numa
  // faixa de 90 px, o fim de semana vira ruído e nada se lê.
  //
  // A lista de rótulos é montada aqui, pelo CALENDÁRIO, e não deduzida do que
  // voltou do banco: mês sem cobrança nenhuma não volta do `$group`, e é
  // justamente ele que tem de aparecer como zero.
  const MESES_NO_GRAFICO = 12;
  const DIAS_NO_GRAFICO = 14;

  function janelas(t) {
    const parede = tempo.paredeDe(t.agora, t.fuso);

    // Os doze rótulos "AAAA-MM", andando para trás a partir do mês atual.
    // A conta é sobre ANO e MÊS, nunca sobre milissegundos: somar "trinta dias"
    // doze vezes erra em fevereiro e no horário de verão.
    const meses = [];
    for (let i = MESES_NO_GRAFICO - 1; i >= 0; i--) {
      const total = parede.ano * 12 + (parede.mes - 1) - i;
      const ano = Math.floor(total / 12);
      const mes = (total % 12) + 1;
      meses.push(`${ano}-${String(mes).padStart(2, "0")}`);
    }

    const primeiro = meses[0];
    const [anoDe, mesDe] = primeiro.split("-").map(Number);
    const mesesDe = tempo.instante({ ano: anoDe, mes: mesDe, dia: 1 }, t.fuso);

    // Os catorze rótulos "AAAA-MM-DD", terminando HOJE. Cada um sai de
    // `paredeDe` em vez de aritmética de string: é o que faz o dia certo numa
    // virada de mês e numa de ano.
    const dias = [];
    for (let i = DIAS_NO_GRAFICO - 1; i >= 0; i--) {
      dias.push(
        tempo.paredeDe(new Date(t.inicio.getTime() - i * 24 * 60 * 60 * 1000), t.fuso).data,
      );
    }
    const diasDe = new Date(t.inicio.getTime() - (DIAS_NO_GRAFICO - 1) * 24 * 60 * 60 * 1000);

    return {
      meses,
      mesesDe,
      mesDe: `${primeiro}-01`,
      mesAte: t.mesAte,
      dias,
      diasDe,
    };
  }

  // ── A AGENDA, DIA A DIA ───────────────────────────────────────────────
  //
  // A mesma conta de `agendaDeHoje`, repetida em catorze dias: cancelado fora,
  // e a unidade é a da PESSOA atendida, porque um compromisso não guarda
  // unidade própria.
  //
  // A cerca é aplicada UMA vez, sobre todas as pessoas dos catorze dias, e não
  // uma vez por dia: `idsNaUnidade` é uma ida ao banco, e quatorze delas para
  // desenhar uma faixa de 90 px seria o gráfico custando mais que a tela.
  async function agendaPorDia(user, cerca, t, j) {
    const fim = new Date(t.fim);
    const linhas = await app.api.appointment.between(await agendasVisiveis(user), j.diasDe, fim);
    const vivos = linhas.filter((l) => l.status !== "canceled");
    if (!vivos.length) return [];

    const naUnidade = new Set(
      (
        await app.api.user.idsNaUnidade(
          vivos.map((l) => l.student),
          cerca,
        )
      ).map(String),
    );

    const porDia = new Map();
    for (const l of vivos) {
      if (!naUnidade.has(String(l.student))) continue;
      // O dia NO FUSO DA CASA. `date` é um instante, e sem isto o compromisso
      // das 21h de Brasília cairia na barra do dia seguinte.
      const r = tempo.paredeDe(new Date(l.date), t.fuso).data;
      porDia.set(r, (porDia.get(r) || 0) + 1);
    }

    return [...porDia].map(([r, total]) => ({ r, total }));
  }

  // ── O RÓTULO DO PONTO VIRA UMA JANELA DE TEMPO ────────────────────────
  //
  // "2026-10" é o mês inteiro; "2026-10-22" é o dia inteiro. Em AMBOS os casos
  // no fuso da casa, pelo mesmo motivo de sempre: o servidor roda em UTC e às
  // 21h de Brasília ele já virou amanhã.
  //
  // Devolve `null` para qualquer outra coisa. O rótulo vem da URL, e a URL é
  // um endereço que se edita — sem esta peneira, um `?r=qualquer+coisa` viraria
  // `new Date("qualquer coisa")`, que é `Invalid Date`, que o driver do Mongo
  // trata de um jeito que não é o nosso problema descobrir.
  function janelaDoRotulo(rotulo, grao, t) {
    if (grao === "dia") {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rotulo);
      if (!m) return null;
      const de = tempo.instante({ ano: +m[1], mes: +m[2], dia: +m[3] }, t.fuso);
      return { de, ate: new Date(de.getTime() + 24 * 60 * 60 * 1000 - 1), dia: rotulo };
    }

    const m = /^(\d{4})-(\d{2})$/.exec(rotulo);
    if (!m) return null;
    const ano = +m[1];
    const mes = +m[2];
    if (mes < 1 || mes > 12) return null;

    // O último dia pelo truque do dia 0 do mês seguinte — `Date.UTC` só para
    // contar quantos dias tem fevereiro, não para marcar instante.
    const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    return {
      de: tempo.instante({ ano, mes, dia: 1 }, t.fuso),
      ate: new Date(
        tempo.instante({ ano, mes, dia: ultimo, hora: 23, minuto: 59 }, t.fuso).getTime() + 59999,
      ),
      // As duas formas de texto, porque `carteira` e `payable.listar` recebem
      // "AAAA-MM-DD" e fazem a conta de fuso por dentro.
      dataDe: `${rotulo}-01`,
      dataAte: `${rotulo}-${String(ultimo).padStart(2, "0")}`,
    };
  }

  // ── DE CADA COLEÇÃO PARA A FORMA ÚNICA ────────────────────────────────
  //
  // `titulo` é a primeira linha (quem), `subtitulo` a segunda (o quê), `valor`
  // o dinheiro em centavos quando existe, `quando` a data, `estado` o selo
  // colorido e `para` a tela da linha. Nulo onde a fonte não tem a informação —
  // e a tela não desenha o que vem nulo.
  const comoCobranca = (l) => ({
    id: l.id,
    titulo: l.studentName || l.description || "",
    subtitulo: l.studentName ? l.description || "" : "",
    valor: l.falta > 0 ? l.falta : l.pago,
    quando: l.dueDate,
    estado: l.atrasada ? "late" : l.status,
    // A cobrança abre na ficha de quem deve, aba Financeiro: é de lá que se
    // age sobre ela (cobrar, marcar paga, reenviar o boleto).
    para: l.student ? `/people/${l.student}` : "",
  });

  const comoConta = (l) => ({
    id: l.id,
    titulo: l.supplierName || l.description || "",
    subtitulo: l.supplierName ? l.description || "" : "",
    valor: l.amount,
    quando: l.dueDate,
    estado: l.atrasada ? "late" : l.status,
    para: "",
  });

  // As fontes, por peça. `grao` tem de casar com o da série — o gráfico mensal
  // manda "2026-10" e o diário manda "2026-10-22", e abrir a janela errada
  // devolveria uma lista vazia sem dizer por quê.
  const FONTES = {
    "dinheiro.recebido": {
      grao: "mes",
      permissao: "finance.view",
      menu: "/financeiro",
      async buscar({ cerca, t, janela }) {
        const r = await app.api.finance.carteira({
          de: janela.dataDe,
          ate: janela.dataAte,
          fuso: t.fuso,
          ...cerca,
          comAvulsos: true,
          somentePagas: true,
          ordem: "pago",
          direcao: "desc",
          pagina: 1,
          limite: TETO_DAS_LINHAS,
        });
        return { total: r.total ?? r.rows?.length ?? 0, linhas: (r.rows || []).map(comoCobranca) };
      },
    },

    "dinheiro.aReceber": {
      grao: "mes",
      permissao: "finance.view",
      menu: "/financeiro",
      async buscar({ cerca, t, janela }) {
        const r = await app.api.finance.carteira({
          de: janela.dataDe,
          ate: janela.dataAte,
          fuso: t.fuso,
          ...cerca,
          comAvulsos: true,
          status: "open",
          ordem: "dueDate",
          direcao: "asc",
          pagina: 1,
          limite: TETO_DAS_LINHAS,
        });
        return { total: r.total ?? r.rows?.length ?? 0, linhas: (r.rows || []).map(comoCobranca) };
      },
    },

    "dinheiro.atrasado": {
      grao: "mes",
      permissao: "finance.view",
      menu: "/financeiro",
      async buscar({ cerca, t, janela }) {
        const r = await app.api.finance.carteira({
          de: janela.dataDe,
          ate: janela.dataAte,
          fuso: t.fuso,
          ...cerca,
          comAvulsos: true,
          // "late" não é estado gravado: é a cobrança ABERTA cuja data passou,
          // calculada na leitura. É o mesmo conjunto que o cartão soma.
          status: "late",
          ordem: "dueDate",
          direcao: "asc",
          pagina: 1,
          limite: TETO_DAS_LINHAS,
        });
        return { total: r.total ?? r.rows?.length ?? 0, linhas: (r.rows || []).map(comoCobranca) };
      },
    },

    "contas.aPagar": {
      grao: "mes",
      permissao: "finance.view",
      menu: "/contas",
      async buscar({ cerca, t, janela }) {
        const r = await app.api.payable.listar({
          de: janela.dataDe,
          ate: janela.dataAte,
          fuso: t.fuso,
          ...cerca,
          status: "open",
          ordem: "dueDate",
          direcao: "asc",
          pagina: 1,
          limite: TETO_DAS_LINHAS,
        });
        return { total: r.total ?? r.rows?.length ?? 0, linhas: (r.rows || []).map(comoConta) };
      },
    },

    agenda: {
      grao: "dia",
      permissao: "schedule.view",
      menu: "/agenda",
      async buscar({ user, cerca, janela }) {
        const linhas = await app.api.appointment.between(
          await agendasVisiveis(user),
          janela.de,
          janela.ate,
        );
        // Cancelado fora, como no cartão e no gráfico: ele não é compromisso
        // do dia, é um que deixou de existir.
        const vivos = linhas.filter((l) => l.status !== "canceled");
        if (!vivos.length) return { total: 0, linhas: [] };

        // Um compromisso não guarda unidade: a dele é a da PESSOA atendida.
        const naUnidade = new Set(
          (
            await app.api.user.idsNaUnidade(
              vivos.map((l) => l.student),
              cerca,
            )
          ).map(String),
        );
        const meus = vivos.filter((l) => naUnidade.has(String(l.student)));

        // `namesByIds` devolve um Map, e só nome — o documento da pessoa tem
        // senha, sal e ficha inteira, e nada disso precisa sair daqui.
        const nomes = await app.api.user
          .namesByIds(meus.map((l) => l.student))
          .catch(() => new Map());

        return {
          total: meus.length,
          linhas: meus.slice(0, TETO_DAS_LINHAS).map((l) => ({
            id: String(l._id),
            titulo: nomes.get(String(l.student)) || "",
            subtitulo: l.service || l.note || "",
            valor: null,
            quando: l.date,
            estado: l.status,
            para: l.student ? `/people/${l.student}` : "",
          })),
        };
      },
    },

    porta: {
      grao: "dia",
      menu: "/people/tab/frequency",
      async buscar({ cerca, janela }) {
        const r = await app.api.checkin.linhasDoDia(janela.de, janela.ate, cerca, TETO_DAS_LINHAS);
        return {
          total: r.total,
          linhas: r.linhas.map((l) => ({
            id: l.id,
            titulo: l.nome,
            subtitulo: "",
            valor: null,
            quando: l.em,
            // A passagem traz a HORA, e é ela que informa: "entrou às 7h12".
            hora: true,
            estado: null,
            para: l.pessoa ? `/people/${l.pessoa}` : "",
          })),
        };
      },
    },

    "pessoas.newThisMonth": {
      grao: "mes",
      async buscar({ user, cerca, janela }) {
        const r = await app.api.user.cadastradosEntre(
          user._id,
          cerca,
          { de: janela.de, ate: janela.ate },
          TETO_DAS_LINHAS,
        );
        return {
          total: r.total,
          linhas: r.linhas.map((l) => ({
            id: l.id,
            titulo: l.nome,
            subtitulo: l.email || "",
            valor: null,
            quando: l.em,
            estado: null,
            para: `/people/${l.id}`,
          })),
        };
      },
    },

    // ── E "TOTAL" NÃO TEM LISTA, DE PROPÓSITO ───────────────────────────
    //
    // O número dele é CUMULATIVO: o total em março é todo mundo que entrou até
    // março. A lista por trás seria a casa inteira — que é a tela de Pessoas,
    // com busca e filtro, e não cabe num dialog.
    //
    // Listar "quem entrou em março" aqui seria responder a pergunta do cartão
    // AO LADO ("novos no mês") com o título deste. A ausência é a resposta
    // honesta, e a tela a trata: o cartão do total não vira botão no gráfico.
  };

  // ── AS LINHAS POR TRÁS DE UM PONTO DO GRÁFICO (22/10/2026) ────────────
  //
  // *"se clicar no gráfico tinha que abrir outro dialog com as faturas"*.
  //
  // O gráfico responde "quanto" e "quando"; esta rota responde **quem**. É o
  // último degrau: número → forma → linhas.
  //
  // ── UMA FORMA SÓ PARA SEIS FONTES ───────────────────────────────────
  //
  // Cobrança, conta a pagar, compromisso, passagem na catraca e cadastro são
  // cinco coleções com cinco formatos. Se cada uma desenhasse a sua lista,
  // seriam cinco janelas para manter — e a sexta nasceria torta.
  //
  // Então todas saem daqui como `{ id, titulo, subtitulo, valor, quando,
  // estado, para }`, e a tela desenha UMA lista. Quem traduz cada coleção para
  // essa forma é a função dela aqui embaixo, num lugar só.
  //
  // ── O CONJUNTO É O MESMO QUE O NÚMERO SOMOU ─────────────────────────
  //
  // É a mesma regra do gráfico, um degrau abaixo: "atrasado" lista
  // `status=late`, "a receber" lista `status=open`, "recebido" lista as que
  // RECEBERAM alguma coisa (`somentePagas` — e não `status=paid`, que quer
  // dizer "falta zero" e deixaria de fora a cobrança paga pela metade que
  // entrou no total).
  //
  // Uma lista cuja soma não bate com o número no topo dela é pior que lista
  // nenhuma.
  //
  // ── O TETO, E POR QUE ELE NÃO É UMA PÁGINA ──────────────────────────
  //
  // Cinquenta linhas, com o TOTAL ao lado. Paginar aqui seria construir uma
  // segunda tela de Financeiro dentro de um dialog — e a de verdade está a um
  // clique, com busca, filtro e ordenação. A janela mostra o começo e diz
  // quantas são.
  const TETO_DAS_LINHAS = 50;

  app.get("/dashboard/linhas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const peca = String(req.query.peca || "");
    const rotulo = String(req.query.r || "");
    const fonte = FONTES[peca];
    if (!fonte) {
      res.status(400).send({ msg: req.t("errors.invalidField") });
      return;
    }

    const cerca = lenteDeUnidade.recorte(user, req.query.unit);
    const t = await quando();

    // ── O RÓTULO VIRA JANELA AQUI, E É CONFERIDO ────────────────────────
    //
    // Ele chega da URL — que é um endereço que a pessoa pode mandar para
    // alguém, e portanto editar. `2026-10` e `2026-10-22` são as duas formas
    // que o gráfico produz; qualquer outra coisa é recusada antes de virar
    // `new Date` de algo que o Mongo depois interpreta como quiser.
    const janela = janelaDoRotulo(rotulo, fonte.grao, t);
    if (!janela) {
      res.status(400).send({ msg: req.t("errors.invalidField") });
      return;
    }

    // A MESMA porta de permissão e módulo do cartão e do gráfico. Sem ela,
    // quem não vê o financeiro na tela leria a lista de cobranças pela URL.
    if (fonte.permissao && !(await app.api.user.hasPermission(user, fonte.permissao))) {
      res.status(403).send({ msg: req.t("errors.noPermission") });
      return;
    }
    const escondidos = new Set(await app.api.modulo.menusEscondidos().catch(() => []));
    if (fonte.menu && escondidos.has(fonte.menu)) {
      res.status(403).send({ msg: req.t("errors.noPermission") });
      return;
    }

    const saida = await fonte.buscar({ user, cerca, t, janela, peca });
    res.send({ peca, r: rotulo, ...saida });
  });

  // ── AS SÉRIES, QUE VIRAM OS GRÁFICOS (22/10/2026) ─────────────────────
  //
  // *"cadê os gráficos? veja a riqueza de detalhes que é no SprintHub, aqui
  // nem gráfico tem"*.
  //
  // Eu tinha dito duas vezes que não dava, porque o VAFIT não guarda
  // histórico. Estava errado: não há FOTOGRAFIA de agregado, mas as linhas têm
  // data. Pagamento tem data de pagamento, fatura tem vencimento, passagem na
  // catraca tem hora, cadastro tem `createdAt`. A história está toda lá — o que
  // não existia era alguém perguntando por ela.
  //
  // ── A REGRA QUE TODO GRÁFICO DESTE PAINEL OBEDECE ───────────────────
  //
  // **O último ponto da série é o número do cartão.** Não um parente dele, não
  // uma definição parecida: o mesmo. É por isso que a série do dinheiro
  // agrupa por VENCIMENTO (como a carteira) em vez de por data de pagamento, e
  // é por isso que a agenda e a catraca são por DIA, não por mês — os cartões
  // delas são de hoje.
  //
  // Duas respostas para a mesma pergunta a dez pixels de distância é o que
  // destrói a confiança num painel, e ninguém desconfia de um total.
  //
  // ── E O QUE *NÃO* GANHOU GRÁFICO, DE PROPÓSITO ──────────────────────
  //
  // "Ativo" e "com acesso ao app" são bandeiras de AGORA, não fatos datados:
  // nada no banco diz quantos estavam ativos em março. "Aulas de hoje" sai da
  // grade recorrente e não de linhas gravadas — reconstruir a grade de cada dia
  // dos últimos catorze é uma conta diferente, que daria um número parecido com
  // o certo, que é a pior espécie.
  //
  // Esses três cartões ficam sem linha embaixo. Um gráfico inventado é pior que
  // gráfico nenhum.
  //
  // ── ROTA PRÓPRIA, E NÃO DENTRO DE `/dashboard` ──────────────────────
  //
  // O painel abre em uma chamada e tem de continuar abrindo. Estas são oito
  // agregações sobre doze meses — se viajassem junto, a primeira tela depois do
  // login esperaria por elas para desenhar um número que já estava pronto.
  //
  // Então o número vem primeiro e a linha chega depois, por baixo. Enquanto ela
  // não chega, o cartão é exatamente o que era ontem.
  app.get("/dashboard/series", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const cerca = lenteDeUnidade.recorte(user, req.query.unit);
    const t = await quando();
    const j = janelas(t);

    const escondidos = new Set(await app.api.modulo.menusEscondidos().catch(() => []));
    const temMenu = (caminho) => !escondidos.has(caminho);

    const [podeAgenda, podeDinheiro] = await Promise.all([
      app.api.user.hasPermission(user, "schedule.view"),
      app.api.user.hasPermission(user, "finance.view"),
    ]);

    const verDinheiro = podeDinheiro && temMenu("/financeiro");
    const verContas = podeDinheiro && temMenu("/contas");

    const [cadastros, entradas, compromissos, dinheiro, contas] = await Promise.all([
      app.api.user.serieDeCadastros(user._id, cerca, {
        de: j.mesesDe,
        ate: t.fim,
        fuso: t.fuso,
      }),

      temMenu("/people/tab/frequency")
        ? app.api.checkin.seriePorDia(j.diasDe, t.fim, cerca, t.fuso)
        : null,

      podeAgenda && temMenu("/agenda") ? agendaPorDia(user, cerca, t, j) : null,

      verDinheiro
        ? app.api.finance.serieMensal({ de: j.mesDe, ate: j.mesAte, fuso: t.fuso, ...cerca })
        : null,

      verContas ? app.api.payable.serieMensal({ de: j.mesDe, ate: j.mesAte, ...cerca }) : null,
    ]);

    // ── OS BURACOS VIRAM ZERO AQUI, E NÃO NA TELA ───────────────────────
    //
    // Um mês sem cobrança nenhuma simplesmente não volta do `$group`. Entregue
    // cru, o gráfico ligaria março a maio com uma reta — desenhando um abril
    // que nunca foi medido, e ainda por cima no meio do caminho entre os dois.
    //
    // Quem sabe quantos dias tem fevereiro é o servidor, que já calculou o mês
    // no fuso da casa. Fazer a tela preencher o calendário seria pedir a ela
    // que refizesse essa conta — e errasse na virada do ano.
    const serieMes = (linhas, campo) => ({
      grao: "mes",
      pontos: j.meses.map((r) => ({
        r,
        v: (linhas || []).find((l) => l.r === r)?.[campo] || 0,
      })),
    });

    const serieDia = (linhas, campo) => ({
      grao: "dia",
      pontos: j.dias.map((r) => ({
        r,
        v: (linhas || []).find((l) => l.r === r)?.[campo] || 0,
      })),
    });

    const series = {};
    if (compromissos) series.agenda = serieDia(compromissos, "total");
    if (entradas) series.porta = serieDia(entradas, "entradas");

    series["pessoas.total"] = serieMes(cadastros, "total");
    series["pessoas.newThisMonth"] = serieMes(cadastros, "novos");

    if (dinheiro) {
      series["dinheiro.recebido"] = serieMes(dinheiro, "recebido");
      series["dinheiro.aReceber"] = serieMes(dinheiro, "aReceber");
      series["dinheiro.atrasado"] = serieMes(dinheiro, "atrasado");
    }
    if (contas) series["contas.aPagar"] = serieMes(contas, "aPagar");

    res.send({ series });
  });

  app.get("/dashboard", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    const cerca = lenteDeUnidade.recorte(user, req.query.unit);
    const t = await quando();

    // O que esta conta LIBEROU. A mesma lista que a barra lateral usa para
    // esconder menu — e por isso o painel nunca mostra um bloco cuja tela não
    // existe no menu daquela conta.
    //
    // Falha ABRINDO, como lá: sem a lista, nada é escondido. Perder o cartão
    // do dinheiro porque uma leitura não voltou é pior que mostrá-lo.
    const escondidos = new Set(await app.api.modulo.menusEscondidos().catch(() => []));
    const temMenu = (caminho) => !escondidos.has(caminho);

    const [podeAgenda, podeDinheiro] = await Promise.all([
      app.api.user.hasPermission(user, "schedule.view"),
      app.api.user.hasPermission(user, "finance.view"),
    ]);

    // ── A MENSALIDADE NASCE AQUI TAMBÉM ─────────────────────────────────
    //
    // Pela mesma razão de `/finance`: não há agendador neste servidor, e a
    // geração roda dentro da requisição. Se ela só rodasse lá, o painel diria
    // "a receber 1.200" e a tela do Financeiro, aberta em seguida, diria
    // 3.400 — a diferença sendo as mensalidades que a abertura dela acabou de
    // criar. Dois números para a mesma pergunta, e o primeiro sempre menor.
    //
    // E o painel é a tela mais aberta de todas: é onde a cobrança do mês tem a
    // melhor chance de nascer no dia certo. `gerar` nunca estoura.
    if (podeDinheiro && temMenu("/financeiro")) await app.api.recurrence.gerar({});

    const janelaDoMes = { de: t.mesDe, ate: t.mesAte, fuso: t.fuso, limite: 1, pagina: 1 };

    const [pessoas, ultimos, agenda, aulas, porta, dinheiro, contas] = await Promise.all([
      app.api.user.studentsSummary(user._id, cerca),

      app.api.user
        .pageStudents(user._id, { ...cerca, sort: "createdAt", dir: "desc", page: 1, limit: 5 })
        .then((r) => r.rows || []),

      podeAgenda && temMenu("/agenda") ? agendaDeHoje(user, cerca, t) : null,

      podeAgenda && temMenu("/aulas") ? aulasDeHoje(cerca, t) : null,

      // A porta é do módulo Frequência — é a aba da ficha que mostra as
      // passagens de uma pessoa, e este cartão é a soma do dia.
      temMenu("/people/tab/frequency") ? app.api.checkin.resumoDoDia(t.inicio, t.fim, cerca) : null,

      podeDinheiro && temMenu("/financeiro")
        ? app.api.finance.carteira({ ...janelaDoMes, ...cerca, comAvulsos: true })
        : null,

      podeDinheiro && temMenu("/contas")
        ? app.api.payable.listar({ ...janelaDoMes, ...cerca })
        : null,
    ]);

    // A moeda só é perguntada quando há número em dinheiro para escrever.
    const moedas =
      dinheiro || contas ? await app.api.tenant.currencyOfInstance().catch(() => ({})) : {};

    res.send({
      dia: t.dia,
      // A lente que VALEU, e não a que foi pedida: quem é restrito e pede uma
      // unidade de fora recebe as dele (ver a cerca), e a tela precisa poder
      // dizer de onde são os números que está mostrando.
      unidade: cerca.unit || "",
      pessoas,
      ultimos,
      agenda,
      aulas,
      porta,
      dinheiro: dinheiro ? { ...dinheiro.resumo, moeda: moedas.currency || "" } : null,
      contas: contas ? { ...contas.resumo, moeda: moedas.currency || "" } : null,
    });
  });
};
