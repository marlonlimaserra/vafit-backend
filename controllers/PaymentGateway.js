const gateways = require("../lib/gateways");

// OS GATEWAYS DE PAGAMENTO DA CASA — Asaas, Pagar.me.
//
//   GET    /payment-gateways              o catálogo e o que está ligado
//   PUT    /payment-gateways/:tipo        cola a chave (confere ANTES de gravar)
//   POST   /payment-gateways/:tipo/ativo  escolhe por onde as cobranças saem
//   POST   /payment-gateways/:tipo/tokenizacao  a conta pode guardar cartão
//   DELETE /payment-gateways/ativo        volta a cobrar na mão
//   DELETE /payment-gateways/:tipo        desliga e apaga a chave
//
// ── A PERMISSÃO É A DO FINANCEIRO, e não a das integrações ──────────────
//
// `integrations.*` existe e seria o encaixe fácil — é o que guarda as contas
// de Instagram. Mas o que se decide aqui não é "com quem o sistema conversa",
// é POR ONDE O DINHEIRO DA CASA ENTRA. Quem pode trocar isso pode redirecionar
// a cobrança de todos os alunos para outra conta.
//
// Então: `finance.view` para ver, `finance.manage` para mexer — as mesmas de
// quem edita uma cobrança.
module.exports = function (app) {
  // ── DE QUAL UNIDADE SÃO ESTAS CHAVES ───────────────────────────────────
  //
  // *"acho que cada filial terá que ter suas chaves de gateway de pagamento
  // também"* (14/10/2026).
  //
  // Vazio é A CASA — o que existia até hoje, e o que continua valendo para
  // quem só tem um lugar. Todas as rotas daqui leem o mesmo parâmetro, e é
  // isso que faz a tela da unidade ser a MESMA tela da casa com um argumento
  // a mais, em vez de uma segunda cópia que diverge na primeira mudança.
  const unidadeDe = (req) => String(req.query.unidade || "");

  const recusa = (req, res, erro) => {
    const porErro = {
      gateway_desconhecido: ["gatewayUnknown", 404],
      sem_chave: ["gatewayNoKey", 400],
      chave_invalida: ["gatewayBadKey", 400],
      chave_do_tipo_errado: ["gatewayWrongKeyType", 400],
      fora_do_ar: ["gatewayUnreachable", 502],
      nao_configurado: ["gatewayNotSet", 409],
      sem_tokenizacao: ["gatewayNoTokenize", 400],
      nao_encontrado: ["gatewayUnknown", 404],
    };
    const [chave, status] = porErro[erro] || ["gatewayBadKey", 400];
    res.status(status).send({ msg: req.t("errors." + chave), code: erro });
  };

  // ── A LISTA ────────────────────────────────────────────────────────────
  //
  // Sempre os DOIS, ligados ou não: a tela precisa oferecer o que ainda não
  // foi configurado, e uma lista só do que existe faria a tela vazia não ter
  // nada para mostrar nem onde clicar.
  app.get("/payment-gateways", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    res.send({ rows: await app.api.paymentGateway.lista(unidadeDe(req)) });
  });

  // ── COLAR A CHAVE ──────────────────────────────────────────────────────
  //
  // Confere ANTES de gravar, e é esta ordem que faz a tela não mentir. Uma
  // chave torta guardada com cara de "conectado" só falha na primeira cobrança
  // de verdade: longe daqui, e para quem não configurou nada.
  //
  // E é a conferência que diz o AMBIENTE — não há seletor na tela. Ver
  // `lib/gateways/LEIA-ME.md`: perguntar seria aceitar uma chave de produção
  // marcada como teste, e o primeiro boleto "de teste" seria um boleto real.
  app.put("/payment-gateways/:tipo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const gateway = gateways.de(req.params.tipo);
    if (!gateway) return recusa(req, res, "gateway_desconhecido");

    const chave = String((req.body || {}).chave || "").trim();
    if (!chave) return recusa(req, res, "sem_chave");
    // O TIPO ERRADO antes do formato torto: são erros diferentes e merecem
    // frases diferentes. Quem colou a chave pública copiou CERTO — mandá-lo
    // "conferir se copiou inteira" o faz repetir o mesmo acerto inútil.
    if (gateway.tipoErrado?.test(chave)) return recusa(req, res, "chave_do_tipo_errado");
    // O formato depois: recusa o campo colado torto sem mandar para uma API
    // de terceiro o que a pessoa colou por engano.
    if (!gateway.formato.test(chave)) return recusa(req, res, "chave_invalida");

    const conferido = await gateway.conferir(chave);
    if (!conferido.ok) return recusa(req, res, conferido.erro);

    const salvo = await app.api.paymentGateway.salvar(
      gateway.chave,
      { chave, ambiente: conferido.ambiente, conta: conferido.conta },
      user._id,
      unidadeDe(req)
    );

    app.insertUserActionHistory(req, user, "connect_payment_gateway", {
      category: "configuration",
      // A chave NÃO vai para o histórico. O que fica é qual gateway e em que
      // ambiente — que é o que alguém vai querer ler meses depois.
      local: { target_type: "payment_gateways", target_id: gateway.chave },
      data: { ambiente: conferido.ambiente, unidade: unidadeDe(req) || null },
    });

    // ── E O AVISO DE PAGAMENTO JÁ FICA REGISTRADO LÁ ───────────────────
    //
    // *"eu entrei lá, e não tem o webhook"* (15/10/2026). Antes ele só nascia
    // dentro da primeira matrícula com "gerar no gateway" — então, numa conta
    // que ainda não vendeu nada pela vitrine, a tela de Webhooks do Asaas
    // ficava vazia e não havia como saber se a integração estava de pé.
    //
    // Não derruba a conexão: a chave foi conferida e está gravada, e um
    // webhook que falhou se resolve clicando em salvar de novo. Mas o
    // resultado VAI NA RESPOSTA — melhor esforço calado foi exatamente o que
    // escondeu isto por um dia.
    const aviso = await app.api.cobrador.registrarWebhook(gateway.chave, unidadeDe(req));
    res.send({ ...salvo, webhook: aviso });
  });

  // ── ESCOLHER POR ONDE COBRA ────────────────────────────────────────────
  //
  // `/ativo` ANTES de `/:tipo` no DELETE: o Express casa na ordem de registro,
  // e com `/:tipo` em cima um pedido para `/ativo` cairia na rota de desligar
  // um gateway chamado "ativo". É a mesma pegadinha que o Departamento
  // documenta — aqui já nasce certa.
  app.delete("/payment-gateways/ativo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    await app.api.paymentGateway.desativar(unidadeDe(req));
    app.insertUserActionHistory(req, user, "choose_payment_gateway", {
      category: "configuration",
      local: { target_type: "payment_gateways", target_id: "nenhum" },
      data: { unidade: unidadeDe(req) || null },
    });

    res.send({ rows: await app.api.paymentGateway.lista(unidadeDe(req)) });
  });

  app.post("/payment-gateways/:tipo/ativo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    if (!gateways.de(req.params.tipo)) return recusa(req, res, "gateway_desconhecido");

    const r = await app.api.paymentGateway.ativar(req.params.tipo, unidadeDe(req));
    if (r.erro) return recusa(req, res, r.erro);

    // Escolher por onde a casa cobra é o outro momento em que o aviso precisa
    // existir lá. Idempotente por URL: registrar duas vezes não cria dois.
    await app.api.cobrador.registrarWebhook(req.params.tipo, unidadeDe(req));

    app.insertUserActionHistory(req, user, "choose_payment_gateway", {
      category: "configuration",
      local: { target_type: "payment_gateways", target_id: req.params.tipo },
      data: { unidade: unidadeDe(req) || null },
    });

    res.send({ rows: await app.api.paymentGateway.lista(unidadeDe(req)) });
  });

  // ── A TOKENIZAÇÃO DE CARTÃO DESTA CONTA ────────────────────────────────
  //
  // *"coloque um checkbox, 'tokenização de cartão ativo' no asaas, pelo
  // menos, eles precisam pedir para ativar, aí, se ativar, conseguimos
  // tokerizar o cartão de crédito para pagar faturas"* (16/10/2026).
  //
  // O Asaas não libera tokenização sozinho: a casa abre um chamado e eles
  // ligam a função na conta. Não há como perguntar isso pela API — então
  // quem responde é quem pediu, e esta rota guarda a resposta.
  //
  // `finance.manage`, como todo o resto daqui: a caixa decide se o cartão de
  // um aluno pode ser guardado para cobrar de novo depois.
  app.post("/payment-gateways/:tipo/tokenizacao", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const gateway = gateways.de(req.params.tipo);
    if (!gateway) return recusa(req, res, "gateway_desconhecido");
    // Gateway que não tokeniza não tem o que declarar. A tela já não mostra a
    // caixa, e esta é a conferência que vale — a tela é um palpite sobre o
    // que o servidor aceita.
    if (!gateway.tokeniza) return recusa(req, res, "sem_tokenizacao");

    const ativa = (req.body || {}).ativa === true;

    const r = await app.api.paymentGateway.marcarTokenizacao(
      gateway.chave,
      unidadeDe(req),
      ativa
    );
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "set_gateway_tokenization", {
      category: "configuration",
      local: { target_type: "payment_gateways", target_id: gateway.chave },
      data: { ativa, unidade: unidadeDe(req) || null },
    });

    res.send({ rows: await app.api.paymentGateway.lista(unidadeDe(req)) });
  });

  // ── DESLIGAR ───────────────────────────────────────────────────────────
  //
  // Apaga a linha com a chave dentro: guardar a credencial de um gateway que a
  // casa desligou é manter vivo um segredo que ninguém mais vigia.
  app.delete("/payment-gateways/:tipo", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    if (!gateways.de(req.params.tipo)) return recusa(req, res, "gateway_desconhecido");

    // ── O AVISO SAI DE LÁ ANTES DA CHAVE SAIR DAQUI ────────────────────
    //
    // *"quando eu excluí a chave deveria excluir o webhook lá"* (15/10/2026).
    //
    // A ORDEM é a coisa toda: é a chave que autentica a remoção. Depois do
    // `desligar` não há mais como falar com o gateway, e o webhook ficaria
    // apontando para um endereço que recusa — 401 em cada aviso até o Asaas
    // penalizar a configuração e INTERROMPER a fila, que é a da conta
    // inteira, com as outras integrações dentro.
    //
    // Falhar aqui não impede o desligamento: a chave é nossa e sai. O que
    // volta na resposta é o aviso de que sobrou trabalho para a mão.
    const aviso = await app.api.cobrador.removerWebhook(req.params.tipo, unidadeDe(req));

    const r = await app.api.paymentGateway.desligar(req.params.tipo, unidadeDe(req));
    if (!r.ok) return recusa(req, res, "nao_encontrado");

    app.insertUserActionHistory(req, user, "disconnect_payment_gateway", {
      category: "configuration",
      local: { target_type: "payment_gateways", target_id: req.params.tipo },
      data: { unidade: unidadeDe(req) || null, webhook: aviso.ok },
    });

    res.send({ rows: await app.api.paymentGateway.lista(unidadeDe(req)), webhook: aviso });
  });

  // ── O DIÁRIO DOS AVISOS, PARA A TELA DE DEPURAÇÃO ───────────────────────
  //
  // *"crie uma aba chamada depuração, e coloque 'log asaas' para a gente
  // poder ver o que chegou, se foi processado ou não"* (19/10/2026).
  //
  // Só LEITURA, e nada aqui apaga: o diário se limpa sozinho em 30 dias (TTL
  // no schema). Um botão de limpar serviria para esconder exatamente o que
  // alguém precisa ver depois.
  //
  // A chave é `finance.view`, a mesma da tela de gateways: quem pode ver por
  // onde a casa cobra pode ver se o aviso chegou. O corpo do aviso não tem
  // segredo nenhum — o token do cabeçalho nunca é gravado (ver o modelo).
  app.get("/gateway-webhook-logs", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const dados = await app.api.avisoDoGateway.lista({
      pagina: req.query.page,
      limite: req.query.limit,
      estado: req.query.estado,
      busca: req.query.q,
    });

    // Os ESTADOS vão junto, traduzidos, como todo catálogo desta casa: a tela
    // desenha o filtro e pinta as cores sem conhecer nenhum deles.
    res.send({ ...dados, estados: app.api.avisoDoGateway.estados(req.t) });
  });
};
