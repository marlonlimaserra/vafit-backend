const rateLimit = require("../lib/rateLimit.js");
const mcpTools = require("../lib/mcpTools.js");

// Autenticação por chave de API, alternativa ao cabeçalho `session`.
//
// A chave age COMO A PESSOA que a criou: mesmas permissões, nem mais nem menos.
// Sem isso seria preciso um segundo sistema de autorização em paralelo ao dos
// tipos de usuário, e dois lugares para conceder poder é onde o furo aparece.
//
// O contrato é o mesmo do AuthSession: devolve o usuário, ou false depois de já
// ter respondido. Assim o ReqProtected não precisa saber por qual porta a
// requisição entrou.
function ApiKeyAuth(app) {
  this.app = app;
}

// Aceita as duas formas comuns, para quem integra não ter de descobrir qual é:
//   Authorization: Bearer gfn_...
//   X-API-Key: gfn_...
ApiKeyAuth.prototype.readKey = function (req) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return null;
};

ApiKeyAuth.prototype.present = function (req) {
  return this.readKey(req) !== null;
};

ApiKeyAuth.prototype.protect = async function (req, res) {
  const key = this.readKey(req);
  if (!key) {
    res.status(401).send({ msg: req.t("errors.noApiKey"), code: "no_api_key" });
    return false;
  }

  const doc = await this.app.api.apiKey.verify(key);
  if (!doc) {
    // Registra a tentativa: chave errada ou revogada é exatamente o que o dono
    // precisa ver no log. Sem `user` porque não sabemos de quem é.
    this.app.api.apiCall.record({
      method: req.method,
      path: req.originalUrl || req.url,
      status: 401,
      ip: req.clientIp,
      userAgent: req.headers["user-agent"],
    });
    res.status(401).send({ msg: req.t("errors.invalidApiKey"), code: "invalid_api_key" });
    return false;
  }

  // O limite é POR CHAVE, não por conta: uma integração com defeito não pode
  // derrubar as outras chaves da mesma pessoa.
  // `checkShared` e não `check`: com o cluster ligado, quem tem o contador é o
  // primário. Um Map por worker faria o limite valer N vezes o prometido.
  const limite = await rateLimit.checkShared(String(doc._id));
  res.setHeader("X-RateLimit-Limit", limite.limit);
  res.setHeader("X-RateLimit-Remaining", limite.remaining);

  if (!limite.allowed) {
    res.setHeader("Retry-After", limite.retryAfter);
    this.app.api.apiCall.record({
      user: doc.user,
      apiKey: doc._id,
      prefix: doc.prefix,
      method: req.method,
      path: req.originalUrl || req.url,
      status: 429,
      ip: req.clientIp,
      userAgent: req.headers["user-agent"],
    });
    res.status(429).send({
      msg: req.t("errors.rateLimited", { limit: limite.limit, seconds: limite.retryAfter }),
      code: "rate_limited",
      retryAfter: limite.retryAfter,
    });
    return false;
  }

  const user = await this.app.api.user.data(doc.user);
  // Conta apagada, desativada ou com acesso BLOQUEADO não entra por chave — do
  // mesmo jeito que não entra por sessão. Bloquear fecha TODAS as portas.
  if (!user || user.active === 0 || user.appBloqueado === true) {
    res.status(401).send({ msg: req.t("errors.unavailableAccount") });
    return false;
  }

  // Pendurados no req para o log de saída saber o que registrar, e para as
  // rotas poderem distinguir a porta de entrada quando precisarem.
  req._apiKey = doc;
  req._viaApiKey = true;

  this.app.api.apiKey.touch(doc._id);

  const comPapel = await this.app.api.user.withRole(user);

  // ── A CHAVE RESPEITA O PRÓPRIO ESCOPO E NÍVEL NO REST TAMBÉM ──────────────
  //
  // O `/mcp` gateia ferramenta por ferramenta (ver controllers/Mcp.js) e por
  // isso recebe a pessoa INTEIRA — ele estreita sozinho, três vezes. Toda OUTRA
  // rota REST não sabia de escopo nenhum: `withRole` devolvia o poder cheio, e
  // a chave "só leitura, 3 ferramentas" apagava pela porta REST o que o painel
  // jurava que ela não tocava. Aqui a chave passa a valer no REST o MESMO que
  // vale no MCP. `/mcp` fica de fora de propósito: lá o gate é dele.
  if (req.path !== "/mcp") {
    const nivel = this.app.api.apiKey.nivelDe(doc);
    const metodo = String(req.method || "").toUpperCase();
    const soLeitura = metodo === "GET" || metodo === "HEAD" || metodo === "OPTIONS";

    // NÍVEL como teto de ação: "ler" não escreve nada; "escrever" cria e edita,
    // mas nunca apaga; "apagar" (e as chaves antigas, sem o campo) não restringe.
    if ((nivel === "ler" && !soLeitura) || (nivel === "escrever" && metodo === "DELETE")) {
      this.app.api.apiCall.record({
        user: doc.user,
        apiKey: doc._id,
        prefix: doc.prefix,
        method: req.method,
        path: req.originalUrl || req.url,
        status: 403,
        ip: req.clientIp,
        userAgent: req.headers["user-agent"],
      });
      res.status(403).send({ msg: req.t("errors.apiKeyLevelTooLow", { nivel }), code: "api_key_level" });
      return false;
    }

    // ESCOPO como teto de permissão: a chave só carrega as permissões das
    // ferramentas escolhidas. Vazio é TODAS — a mesma convenção do MCP, e o que
    // mantém a chave legada (sem escopo) exatamente como era.
    const escopo = this.app.api.apiKey.ferramentasDa(doc);
    if (Array.isArray(escopo) && escopo.length) {
      const permitidas = new Set();
      for (const nome of escopo) {
        const f = mcpTools.achar(nome);
        if (f) permitidas.add(f.permissao);
      }
      comPapel.permissions = (comPapel.permissions || []).filter((p) => permitidas.has(p));
      // Escopo explícito não herda o atalho de admin: há rota que lê
      // `user.admin` direto (PermissionGroup), e uma chave estreita não é admin.
      comPapel.admin = false;
    }
  }

  return comPapel;
};

module.exports = ApiKeyAuth;
