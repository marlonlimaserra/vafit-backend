const crypto = require("node:crypto");
const Oauth = require("./Oauth_model.js");

// O QUE É DA APPLE, e só dela (16/11/2026).
//
// O resto — chaves na central, bilhete, TTL, endereço de volta — é o mesmo do
// Google e do Facebook, e vem de `Oauth_model.js`. Ela existe por causa da
// diretriz 4.8 da App Store: um app que oferece "Entrar com o Google" tem de
// oferecer "Entrar com a Apple" junto, ou é recusado.
//
// ── TRÊS DIFERENÇAS, e todas moram aqui ──────────────────────────────────
//
// 1. O SEGREDO NÃO EXISTE PRONTO. O Google entrega um `client_secret`; a Apple
//    entrega uma CHAVE PRIVADA (o arquivo .p8), e o segredo é um JWT assinado
//    com ela a cada troca de código — ver `segredoDoCliente`. Por isso a
//    central guarda também o time e o id da chave (`CHAVES_EXTRAS`).
//
// 2. A VOLTA VEM POR POST. Pedindo nome e e-mail, a Apple exige
//    `response_mode=form_post`: ela devolve a pessoa com um formulário, não com
//    uma URL. O controlador registra o callback dela como POST.
//
// 3. "OCULTAR MEU E-MAIL". A pessoa pode esconder o endereço, e a Apple manda
//    um de repasse (`…@privaterelay.appleid.com`) que nunca casa com conta
//    nenhuma. Como o login social aqui só ENTRA em conta que já existe (ver
//    `porEmailVerificado`), esse caso é marcado como `oculto` — e a tela diz o
//    que fazer, em vez de um "sem conta" que seria mentira.
//
// ── A assinatura do id_token NÃO é conferida, e o motivo é o do Google ──
//
// O token não vem do navegador: vem da resposta de uma chamada que ESTE
// servidor fez à Apple, por HTTPS, com o segredo assinado. O TLS prova a
// origem. O `id_token` que a Apple também põe no formulário da volta — esse
// sim passou pelo navegador — é IGNORADO de propósito: só vale o da troca.

// Nome e e-mail. O nome a Apple só manda na PRIMEIRA vez, e nem o usamos: ele
// está no escopo porque é o que faz a tela da Apple oferecer "compartilhar ou
// ocultar o e-mail" — sem escopo nenhum, o token volta sem e-mail.
const ESCOPO = "name email";

const AUTORIZAR_URL = "https://appleid.apple.com/auth/authorize";
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const EMISSOR = "https://appleid.apple.com";

// O segredo vale cinco minutos. A Apple aceita até seis meses, mas ele é
// assinado na hora de cada troca — um segredo longo seria um segredo a mais
// para vazar, sem nada a ganhar.
const VALIDADE_DO_SEGREDO = 300;

const base64url = (objeto) => Buffer.from(JSON.stringify(objeto)).toString("base64url");

function OauthApple_model(app) {
  Oauth.call(this, app);
}

Oauth.herdar(OauthApple_model, "apple");

// `teamId` é o time da conta de desenvolvedor (DG447FV498); `keyId`, o id da
// chave .p8. O `clientId` é o Services ID, e o `clientSecret` guarda o
// CONTEÚDO do .p8.
OauthApple_model.prototype.CHAVES_EXTRAS = ["teamId", "keyId"];

OauthApple_model.prototype.urlDeAutorizacao = function (clientId, state) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: this.callback(),
    response_type: "code",
    scope: ESCOPO,
    // Obrigatório quando há escopo — ver o item 2 no topo.
    response_mode: "form_post",
    state,
  });
  // `URLSearchParams` escreve o espaço como `+`. A Apple documenta o escopo
  // com `%20`, e é o que vai: um `+` literal já viraria `%2B`, então a troca
  // não encosta em mais nada.
  return AUTORIZAR_URL + "?" + p.toString().replace(/\+/g, "%20");
};

// ── A CHAVE COMO A PESSOA COLOU ───────────────────────────────────────────
//
// O .p8 é um PEM de várias linhas. Colado num campo de linha única, as
// quebras somem; vindo do Windows, viram `\r\n`. Em vez de exigir o formato
// exato, a chave é remontada a partir do miolo em base64, que é o que importa.
function pemDaChave(texto) {
  const miolo = String(texto || "")
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!miolo) return "";
  return `-----BEGIN PRIVATE KEY-----\n${miolo.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
}

// ── O SEGREDO, ASSINADO NA HORA ───────────────────────────────────────────
//
// Um JWT ES256: o cabeçalho diz QUAL chave assinou (`kid`), o corpo diz quem
// pede (`iss` = time, `sub` = Services ID) e para quem (`aud` = a Apple).
//
// `dsaEncoding: "ieee-p1363"` é o detalhe que custa uma tarde: o Node assina
// ECDSA em DER por padrão, e o JWT exige os dois números (r, s) colados, 64
// bytes. Em DER a Apple recusa com `invalid_client`, que não diz o porquê.
OauthApple_model.prototype.segredoDoCliente = function (chaves, agora = Date.now()) {
  const iat = Math.floor(agora / 1000);
  const cabecalho = base64url({ alg: "ES256", kid: chaves.keyId });
  const corpo = base64url({
    iss: chaves.teamId,
    iat,
    exp: iat + VALIDADE_DO_SEGREDO,
    aud: EMISSOR,
    sub: chaves.clientId,
  });

  const chave = crypto.createPrivateKey({ key: pemDaChave(chaves.clientSecret), format: "pem" });
  const assinatura = crypto.sign("sha256", Buffer.from(`${cabecalho}.${corpo}`), {
    key: chave,
    dsaEncoding: "ieee-p1363",
  });

  return `${cabecalho}.${corpo}.${assinatura.toString("base64url")}`;
};

// ── O código vira token ───────────────────────────────────────────────────
OauthApple_model.prototype.trocarCodigo = async function (code, chaves) {
  // `app.appleFetch` para o teste responder sem rede, como o `googleFetch`.
  const chamar = this.app.appleFetch || fetch;

  const r = await chamar(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: chaves.clientId,
      client_secret: this.segredoDoCliente(chaves),
      code: String(code),
      grant_type: "authorization_code",
      redirect_uri: this.callback(),
    }).toString(),
  });

  if (!r.ok) {
    // `invalid_client` (segredo mal assinado, time ou chave trocados) e
    // `invalid_grant` (código vencido ou já usado) são consertos opostos. Sem
    // o corpo no log, os dois ficam iguais.
    const texto = await r.text().catch(() => "");
    throw new Error(`token ${r.status}: ${texto.slice(0, 200)}`);
  }

  return r.json();
};

// ── O token vira e-mail ───────────────────────────────────────────────────
//
// As mesmas afirmações do Google: o token é para o NOSSO Services ID, saiu da
// Apple, não venceu, e o e-mail está verificado.
OauthApple_model.prototype.pessoaDoIdToken = function (idToken, clientId) {
  const partes = String(idToken || "").split(".");
  if (partes.length !== 3) return { erro: "id_token_malformado" };

  let dados;
  try {
    dados = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8"));
  } catch {
    return { erro: "id_token_ilegivel" };
  }

  if (dados.aud !== clientId) return { erro: "aud_de_outro_app" };
  if (dados.iss !== EMISSOR) return { erro: "emissor_desconhecido" };

  // Em segundos, como no Google — comparar com `Date.now()` cru daria um token
  // sempre vencido.
  if (!dados.exp || dados.exp * 1000 < Date.now()) return { erro: "id_token_vencido" };

  // A Apple manda `"true"` em string; o booleano é aceito também, porque é o
  // que um dia ela pode passar a mandar.
  const verificado = dados.email_verified === true || dados.email_verified === "true";
  if (!verificado) return { erro: "email_nao_verificado" };

  const email = String(dados.email || "").trim().toLowerCase();
  if (!email) return { erro: "sem_email" };

  const oculto =
    dados.is_private_email === true ||
    dados.is_private_email === "true" ||
    email.endsWith("@privaterelay.appleid.com");

  return { email, nome: "", oculto };
};

// O caminho completo da volta, com a mesma forma dos outros provedores: troca
// o código e devolve quem entrou (ou `{ erro }`).
OauthApple_model.prototype.pessoaDoCodigo = async function (code, chaves) {
  const resposta = await this.trocarCodigo(code, chaves);
  return this.pessoaDoIdToken(resposta.id_token, chaves.clientId);
};

module.exports = OauthApple_model;
module.exports.ESCOPO = ESCOPO;
module.exports.TOKEN_URL = TOKEN_URL;
module.exports.EMISSOR = EMISSOR;
module.exports.pemDaChave = pemDaChave;
module.exports.CALLBACK = `${Oauth.BACKEND_POR_PROVEDOR.apple}/auth/apple/callback`;
