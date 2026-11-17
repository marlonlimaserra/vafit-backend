// AS ABAS COMPARTILHADAS DO PAINEL.
//
// *"quem poderia ver aquela aba, quais departamentos etc…"* (24/10/2026).
//
// ── AS DUAS PERMISSÕES, PELO MESMO MOTIVO DOS DEPARTAMENTOS ────────────
//
// ESCREVER é `users.manage`. Montar a tela que a equipe abre de manhã é
// decisão de instalação, da mesma família de Tipos de usuário, Grupos de
// permissão e Departamentos — que é, literalmente, a lista de coisas que esta
// aba endereça. Chave nova não foi criada de propósito: ela nasceria em zero
// papéis e teria de ser herdada à mão por quem já administrava a conta (ver
// `permissao-nova-nao-revoga`), para conceder exatamente o mesmo poder que
// `users.manage` já concede.
//
// LER é `people.view`, que é a porta do próprio painel. Quem abre o painel
// recebe as abas endereçadas a ele; quem não abre o painel não tem o que fazer
// com elas.
//
// ── O QUE ESTA ROTA NÃO FAZ, E É O PONTO ───────────────────────────────
//
// Ela não libera número nenhum. A aba diz QUAIS números a pessoa veria, entre
// os que ela já podia ver — quem decide o "podia" continua sendo `/dashboard`,
// que manda o bloco `null` sem a permissão e sem o módulo. Ver o cabeçalho de
// `model/AbaDoPainel_model.js`.
module.exports = function (app) {
  // Os ids saem como TEXTO: um ObjectId cru vira `{}` no JSON, e a tela
  // compararia o id da lista com o do seletor e nunca casaria. Mesma regra de
  // `controllers/Departamento.js`.
  const paraTela = (a) => ({
    id: String(a._id),
    nome: a.nome,
    pecas: a.pecas || [],
    ordem: a.ordem || 0,
    ativo: a.ativo !== false,
    publico: {
      todos: a.publico?.todos !== false,
      papeis: (a.publico?.papeis || []).map(String),
      departamentos: (a.publico?.departamentos || []).map(String),
      pessoas: (a.publico?.pessoas || []).map(String),
    },
  });

  // ── O QUE O PAINEL PEDE ────────────────────────────────────────────
  //
  // Só o que esta pessoa recebe, e sem o `publico`: o painel não tem o que
  // fazer com a lista de quem mais vê aquela aba, e mandá-la seria contar a
  // uma recepcionista que existe uma aba endereçada a três diretores.
  app.get("/dashboard/abas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "people.view");
    if (user === false) return;

    // Quem pode mexer nelas. A tela precisa saber antes de desenhar o botão:
    // oferecer "Editar" para quem o servidor vai recusar é prometer uma coisa
    // que não acontece.
    const podeGerenciar = await app.api.user.hasPermission(user, "users.manage");
    const minhas = await app.api.abaDoPainel.daPessoa(user);

    res.send({
      // O PÚBLICO só viaja para quem administra — que é quem o editaria, e
      // para quem ele já estaria a uma chamada de distância. Para os outros
      // ele é informação de dentro da casa: contaria a uma recepcionista que
      // existe uma tela endereçada a três diretores, e ela não tem o que fazer
      // com isso.
      rows: minhas.map((a) => ({
        id: String(a._id),
        nome: a.nome,
        pecas: a.pecas || [],
        ...(podeGerenciar ? { publico: paraTela(a).publico } : {}),
      })),
      podeGerenciar,
    });
  });

  const recusa = (req, res, erro) => {
    const porErro = {
      sem_nome: ["tabNoName", 400],
      nao_encontrado: ["tabNotFound", 404],
    };

    const [chave, status] = porErro[erro] || ["tabNoName", 400];
    res.status(status).send({ msg: req.t("errors." + chave), code: erro });
  };

  // A lista CHEIA, com o público de cada uma — a tela de administração.
  app.get("/dashboard/abas/todas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const lista = await app.api.abaDoPainel.list();
    res.send({ rows: lista.map(paraTela) });
  });

  app.post("/dashboard/abas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.abaDoPainel.insert(req.body || {}, { porQuem: user._id });
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "create_dashboard_tab", {
      category: "configuration",
      local: { target_type: "dashboard_tabs", target_id: String(r.id) },
    });

    res.status(201).send(paraTela(await app.api.abaDoPainel.data(r.id)));
  });

  // `/ordem` ANTES de `/:id`: o Express casa na ordem de registro, e com
  // `/:id` em cima este pedido entraria na rota de UMA aba com `id = "ordem"`
  // — respondendo "não encontrada" e nunca salvando a ordem. Já pegou nas
  // gavetas de campos e nos departamentos; aqui já nasce certo.
  app.put("/dashboard/abas/ordem", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.abaDoPainel.reordenar((req.body || {}).ids);
    if (!r.ok) return recusa(req, res, "nao_encontrado");

    const lista = await app.api.abaDoPainel.list();
    res.send({ rows: lista.map(paraTela) });
  });

  app.put("/dashboard/abas/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const r = await app.api.abaDoPainel.update(req.params.id, req.body || {});
    if (r.erro) return recusa(req, res, r.erro);

    res.send(paraTela(await app.api.abaDoPainel.data(req.params.id)));
  });

  app.delete("/dashboard/abas/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "users.manage");
    if (user === false) return;

    const alvo = await app.api.abaDoPainel.data(req.params.id);
    if (!alvo) return recusa(req, res, "nao_encontrado");

    await app.api.abaDoPainel.remove(req.params.id);

    app.insertUserActionHistory(req, user, "delete_dashboard_tab", {
      category: "configuration",
      local: { target_type: "dashboard_tabs", target_id: String(req.params.id) },
      extra: { nome: alvo.nome },
    });

    res.send({ msg: req.t("ok.tabRemoved") });
  });
};
