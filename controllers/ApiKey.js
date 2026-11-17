const limiteDoPlano = require("../lib/limiteDoPlano.js");
const dominio = require("../lib/domain.js");
const ApiKeyModel = require("../model/ApiKey_model.js");
const apiDocs = require("../lib/apiDocs.js");
const rateLimit = require("../lib/rateLimit.js");
const mcpTools = require("../lib/mcpTools.js");
const instanceContext = require("../lib/instance.js");

// As chaves de API da própria conta, o log de uso delas e a documentação.
//
// Tudo aqui é da PRÓPRIA pessoa: não há rota para um admin ver a chave de
// outro. A chave é uma credencial dela, e uma tela que lista credencial alheia
// é um alvo.
module.exports = function (app) {
  // ── QUEM É ATENDIDO NÃO TEM CHAVE (16/11/2026) ──────────────────────────
  //
  // Bastava estar logado, e uma conta de CLIENTE criava chave de API. Ela não
  // alcançava nada além do que a própria sessão já alcança (as ferramentas
  // pedem permissão, e o cliente não tem nenhuma) — mas gastava o teto de
  // chaves do PLANO da casa, que é contado na conta inteira, e punha uma
  // credencial a mais no mundo sem motivo nenhum. Achado na conferência de
  // "o aluno consegue mexer no sistema?".
  //
  // Pelo TIPO, como o portão da área do aluno (controllers/My.js): é a mesma
  // pergunta, ao contrário — quem é atendido não integra sistema.
  async function dono(req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return false;

    if (user.type === "student") {
      res.status(403).send({ msg: req.t("errors.noPermission"), code: "student_no_api_keys" });
      return false;
    }

    return user;
  }

  // ── As chaves ───────────────────────────────────────────────────────────

  app.get("/api-keys", async function (req, res) {
    const user = await dono(req, res);
    if (user === false) return;

    res.send({
      rows: await app.api.apiKey.list(user._id),
      max: ApiKeyModel.MAXIMO_POR_CONTA,
      rateLimit: rateLimit.LIMITE_PADRAO,
      // Para a lista poder dizer "12 de 83" sem baixar o catálogo inteiro: ele
      // só desce quando a pessoa abre a janela de escolher.
      totalFerramentas: mcpTools.FERRAMENTAS.length,
      // ── O ENDEREÇO QUE UM CLIENTE DE FORA COLA ────────────────────────
      //
      // Montado AQUI e não na tela porque metade dele a tela não sabe: o
      // endereço da API sai de `BASE_DOMAIN` (ver `lib/domain.js`) e a
      // instância sai do contexto da requisição. A tela só conhece o próprio
      // host, que é o do painel, e não serve.
      //
      // `?instance=` e não só o cabeçalho `X-Instance`: cliente MCP de fora
      // quase sempre aceita colar uma URL, e nem todos deixam acrescentar
      // cabeçalho. O que vai na URL é o NOME da conta, que já aparece no
      // endereço do painel — não é segredo. O segredo é a chave, e essa
      // continua indo no cabeçalho.
      mcpUrl: `${dominio.apiBaseUrl()}/mcp?instance=${encodeURIComponent(instanceContext.current() || "")}`,
    });
  });

  app.post("/api-keys", async function (req, res) {
    const user = await dono(req, res);
    if (user === false) return;

    // O teto do plano — ver lib/limiteDoPlano.js.
    if (await limiteDoPlano.barrou(app, req, res, "apiKeys", limiteDoPlano.contarNa(app, "api_keys"))) return;

    // Criar chave com chave seria uma credencial se multiplicando sozinha: quem
    // vazasse uma poderia fabricar outras e sobreviver à revogação da primeira.
    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const name = String(req.body?.name || "").trim();
    if (name.length < 2) {
      res.status(400).send({ msg: req.t("errors.requireApiKeyName") });
      return;
    }

    if ((await app.api.apiKey.countActive(user._id)) >= ApiKeyModel.MAXIMO_POR_CONTA) {
      res.status(400).send({
        msg: req.t("errors.tooManyApiKeys", { max: ApiKeyModel.MAXIMO_POR_CONTA }),
        code: "too_many_api_keys",
      });
      return;
    }

    const { doc, key } = await app.api.apiKey.create(user._id, name, req.body?.ferramentas, req.body?.nivel);

    app.insertUserActionHistory(req, user, "create_api_key", {
      category: "admin",
      local: { target_type: "api_keys", target_id: String(doc._id) },
      extra: { name: doc.name, prefix: doc.prefix, ferramentas: (doc.ferramentas || []).length },
    });

    // `key` sai UMA vez. Depois daqui nem o dono recupera — só cria outra.
    res.send({ ...app.api.apiKey.filter(doc), key });
  });

  // ── AS FERRAMENTAS QUE A CHAVE ALCANÇA ──────────────────────────────────
  //
  // *"no SprintHub a gente escolhe quais ferramentas vão estar disponíveis"*
  // (08/11/2026).
  //
  // O catálogo numa rota PRÓPRIA, e não dentro de `GET /api-keys`: são 83
  // linhas que não mudam entre um deploy e outro, e a lista de chaves é
  // recarregada a cada criar, revogar e voltar para a tela. Baixar o catálogo
  // junto seria pagá-lo em toda essas idas para desenhar três cartões.
  //
  // Fica ANTES de `/api-keys/:id` para ninguém ler "tools" como um id.
  app.get("/api-keys/tools", async function (req, res) {
    const user = await dono(req, res);
    if (user === false) return;

    res.send({
      rows: mcpTools.catalogo(),
      // Os níveis, na ordem da escada: cada degrau contém o anterior.
      niveis: mcpTools.NIVEIS,
      // O que a conta REALMENTE alcança — a tela marca o que está fora em vez
      // de deixar a pessoa escolher uma ferramenta que nunca vai responder.
      // Mesma ideia de `/api-docs`.
      permissions: user.permissions || [],
    });
  });

  app.put("/api-keys/:id/tools", async function (req, res) {
    const user = await dono(req, res);
    if (user === false) return;

    // Pelo mesmo motivo de criar e revogar: uma chave que edita o próprio
    // escopo é uma chave sem escopo. Quem vazasse uma estreita se daria as 83
    // de volta numa chamada.
    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const doc = await app.api.apiKey.data(user._id, req.params.id);
    if (!doc) {
      res.status(404).send({ msg: req.t("errors.apiKeyNotFound") });
      return;
    }
    if (doc.revokedAt) {
      res.status(400).send({ msg: req.t("errors.apiKeyRevoked") });
      return;
    }

    const ferramentas = mcpTools.ferramentasValidas(req.body?.ferramentas);
    const nivel = mcpTools.nivelValido(req.body?.nivel);
    await app.api.apiKey.setFerramentas(user._id, req.params.id, ferramentas, nivel);

    app.insertUserActionHistory(req, user, "update_api_key_tools", {
      category: "admin",
      local: { target_type: "api_keys", target_id: String(doc._id) },
      extra: { name: doc.name, prefix: doc.prefix, ferramentas: ferramentas.length, nivel },
    });

    res.send({ ferramentas, nivel, msg: req.t("ok.apiKeyToolsSaved") });
  });

  app.delete("/api-keys/:id", async function (req, res) {
    const user = await dono(req, res);
    if (user === false) return;

    if (req._viaApiKey) {
      res.status(403).send({ msg: req.t("errors.apiKeyCannotManage"), code: "api_key_cannot_manage" });
      return;
    }

    const doc = await app.api.apiKey.data(user._id, req.params.id);
    if (!doc) {
      res.status(404).send({ msg: req.t("errors.apiKeyNotFound") });
      return;
    }

    await app.api.apiKey.revoke(user._id, req.params.id);

    app.insertUserActionHistory(req, user, "revoke_api_key", {
      category: "admin",
      local: { target_type: "api_keys", target_id: String(doc._id) },
      extra: { name: doc.name, prefix: doc.prefix },
    });

    res.send({ msg: req.t("ok.apiKeyRevoked") });
  });

  // ── O log de uso ────────────────────────────────────────────────────────

  app.get("/api-keys/calls", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    const { rows, total } = await app.api.apiCall.list(user._id, req.query);
    res.send({ rows, total });
  });

  app.get("/api-keys/calls/summary", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send(await app.api.apiCall.summary(user._id));
  });

  // ── A documentação ──────────────────────────────────────────────────────

  // A MESMA documentação, sem sessão — para a página pública do site.
  //
  // ── Por que pode ser pública ──────────────────────────────────────────
  //
  // Porque não há segredo nela: são caminhos de rota e nomes de permissão. Quem
  // lê sem chave não consegue chamar nada, e quem tem chave já podia ver tudo
  // isto pela tela de Configuração.
  //
  // O que ela NÃO traz é a lista `permissions` da rota com sessão: aquilo é o
  // que a conta de quem está olhando realmente alcança, e é dado de conta.
  //
  // ── Por que uma rota, e não texto escrito no site ─────────────────────
  //
  // Porque a lista de rotas e a permissão de cada uma vivem em `lib/apiDocs.js`,
  // ao lado do código que as implementa. Uma cópia escrita à mão no site
  // envelheceria em silêncio — e documentação de API errada é pior que ausente:
  // quem integra confia nela e passa a tarde procurando o próprio erro.
  //
  // Fica ANTES de `/api-docs` para deixar claro que são a mesma coisa vista por
  // duas portas.
  app.get("/public/api-docs", async function (req, res) {
    // Cinco minutos no CDN: a lista muda com deploy, não com o minuto.
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

    res.send({
      baseUrl: dominio.apiBaseUrl(),
      rateLimit: rateLimit.LIMITE_PADRAO,
      groups: apiDocs.localized(req.t),
    });
  });

  app.get("/api-docs", async function (req, res) {
    const user = await app.helpers.ReqProtected.verify(req, res);
    if (user === false) return;

    res.send({
      baseUrl: dominio.apiBaseUrl(),
      rateLimit: rateLimit.LIMITE_PADRAO,
      groups: apiDocs.localized(req.t),
      // O que a conta REALMENTE pode: a tela marca o que está fora do alcance
      // dela em vez de deixar a pessoa descobrir por 403.
      permissions: user.permissions || [],
    });
  });
};
