// OS PLANOS DA CASA, e as linhas que os comparam.
//
// Pedido do Marlon em 17/09/2026: *"como pretendo oferecer para academias, ai eu
// crio a recorrencia com um plano"*, com a página da Smart Fit ao lado.
//
// ── DUAS PERMISSÕES, e a diferença importa ───────────────────────────────
//
// LER é `finance.view`: quem cadastra a recorrência de alguém precisa escolher o
// plano, e essa é a permissão que a aba Financeiro da ficha já exige.
//
// MEXER é `finance.manage`: mudar o cardápio é mudar o preço do que a casa
// vende, e é a escrita mais cara desta tela.
//
// ── E A VITRINE PÚBLICA, que é uma rota À PARTE ──────────────────────────
//
// *"crie um botão ver vitrine, aí você monta uma rota pública... pois em breve
// nossos clientes vão criar um iframe dentro do site deles com essa URL"*.
//
// Ela é OUTRA rota (`/public/memberships`) e não um afrouxamento destas, e a
// diferença é o que ela devolve: só o que está À VENDA, e só os campos que o
// cartão desenha. Sem contagem de assinantes, sem quem assinou, sem nada que a
// academia não tenha escolhido pendurar na parede.
const recorrencia = require("../lib/recorrencia.js");
const modelosDeCartao = require("../lib/modelosDeCartao.js");
const instanceContext = require("../lib/instance.js");
const limiteDoPlano = require("../lib/limiteDoPlano.js");
const arquivos = require("../lib/arquivos.js");
const dominio = require("../lib/domain.js");
// `umaLinha` monta o endereço num formato só: o comentário dele já previa a
// vitrine, e três telas montando a mesma linha dão três formatos.
const cep = require("../lib/cep.js");
const cpfLib = require("../lib/cpf.js");
const rateLimit = require("../lib/rateLimit.js");
const clientIp = require("../lib/clientIp.js");
// O catálogo de gateways: a tela de planos precisa saber se o ativo sabe COBRAR
// antes de oferecer "gerar no gateway".
const gateways = require("../lib/gateways");
const { planWelcome, planSignupToUnit } = require("../lib/emailTemplates.js");
const { enderecoDaInstancia } = require("../lib/enderecoDaInstancia.js");
const { dinheiro } = require("../lib/documentoBase.js");

module.exports = function (app) {
  const baseUrl = dominio.apiBaseUrl;

  // O ENDEREÇO da capa, montado aqui e não guardado no plano.
  //
  // O documento guarda só o ID da imagem. Guardar a URL inteira prenderia o
  // plano ao endereço do backend do dia em que a capa foi enviada — e este
  // sistema já mudou de endereço uma vez.
  // A contagem do teto, fora das rotas: a chamada a `barrou` tem de caber numa
  // linha com o `return`, e é assim que um `return` esquecido salta aos olhos
  // — ver `test/lib/limitesLigados.test.js`.
  const contarPlanos = limiteDoPlano.contarNa(app, "memberships");

  const urlDaCapa = (instancia, id) =>
    id ? `${baseUrl()}/public/membership-image/${instancia}/${id}` : null;
  // ── Planos ──────────────────────────────────────────────────────────────

  app.get("/memberships", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    // `?todos=1` traz também os desativados — é a tela de configuração. Quem
    // monta uma recorrência só quer os que estão à venda.
    const rows =
      req.query.todos === "1" ? await app.api.membership.list() : await app.api.membership.listActive();

    const moedas = await app.api.tenant.currencyOfInstance();

    res.send({
      rows: rows.map((p) => ({ ...p, coverUrl: urlDaCapa(req.instance, p.cover) })),
      // Os BENEFÍCIOS vão junto: eles são o que cada plano marca, e a tela não
      // consegue desenhar nem o cartão nem a tabela sem os nomes deles.
      beneficios: await app.api.membershipBenefit.list(),
      // E as CADÊNCIAS, já traduzidas — o mesmo catálogo que a recorrência usa,
      // porque é a mesma pergunta: de quanto em quanto tempo isto cobra.
      //
      // Junto, e não numa rota própria: a tela precisa das três listas para
      // desenhar, e três chamadas a fariam piscar em três tempos.
      cadencias: recorrencia.paraTela(req.t),
      // Os MODELOS DE COR, pela mesma razão das cadências: é um catálogo, ele
      // viaja traduzido, e acrescentar um modelo é mexer num arquivo só.
      modelos: modelosDeCartao.paraTela(req.t),
      // E as FORMAS DE PAGAMENTO, para o seletor de "como se paga este plano".
      //
      // Só as ATIVAS: o seletor é uma escolha a fazer hoje, e oferecer uma
      // forma que a casa desligou é oferecer o que ela não aceita mais. Um
      // plano que já guardava uma forma desativada não a perde — a lista
      // gravada é a chave, e o que some é a opção de marcá-la de novo.
      formas: await app.api.paymentMethod.paraTela(req.t),
      // ── E QUEM COBRA, se é que alguém cobra ────────────────────────────
      //
      // Só o NOME, e só quando o gateway ativo sabe gerar cobrança. É o que
      // deixa a opção "gerar no gateway" aparecer dizendo POR ONDE — "Gerar a
      // cobrança no Asaas" responde mais do que "gerar no gateway", que é
      // jargão nosso.
      //
      // `null` esconde a opção inteira na tela. Oferecer um interruptor que
      // não liga nada é pior que não oferecer: quem marca fica esperando uma
      // fatura que nunca sai.
      gateway: await quemCobra(),
      currency: moedas.currency,
    });
  });

  // O gateway ativo, se ele souber cobrar. Hoje o Pagar.me está ligado como
  // gateway e NÃO tem `cobranca` — ele confere chave e nada mais —, então uma
  // casa que escolheu o Pagar.me não vê a opção.
  async function quemCobra() {
    // Sem unidade: é a conta da CASA. Cada filial pode ter a dela, mas a
    // pergunta aqui é outra — "este plano gera cobrança?" é do plano, e um
    // plano é vendido em várias unidades.
    //
    // Então a opção aparece quando a casa sabe cobrar, e quem cobra de fato é
    // decidido na hora da matrícula, pela unidade da pessoa. Perguntar unidade
    // por unidade daria uma lista de nomes num interruptor de sim ou não.
    const ativo = await app.api.paymentGateway.ativo();
    if (!ativo) return null;

    const gateway = gateways.de(ativo.tipo);
    if (!gateway?.cobranca) return null;

    return { tipo: gateway.chave, nome: gateway.nome };
  }

  app.post("/memberships", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      return res.status(400).send({ msg: req.t("errors.requireName") });
    }

    // ── O TETO DO PLANO DO PRODUTO ──────────────────────────────────────
    //
    // *"crie esses limites na central, só para evitar abuso"*. Os planos da
    // casa são a VITRINE PÚBLICA do cliente: sem teto, nada impede uma conta
    // de virar um catálogo de duzentos itens numa página que nós hospedamos e
    // que carrega a nossa marca embaixo.
    //
    // Conta TUDO, rascunho incluído. Rascunho abandonado é lixo que a tela
    // apaga sozinha ao fechar; deixá-lo fora da conta abriria um caminho para
    // furar o teto criando e nunca salvando.
    if (await limiteDoPlano.barrou(app, req, res, "memberships", contarPlanos)) return;

    const moeda = await app.api.tenant.currencyFor(body.currency);
    const id = await app.api.membership.insert(body, moeda);

    app.insertUserActionHistory(req, user, "create_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(id) },
      extra: { name: body.name, amount: Number(body.amount) || 0 },
    });

    res.status(201).send(await app.api.membership.data(id));
  });

  // O RASCUNHO, criado no clique de "Novo plano" — antes de a pessoa digitar
  // qualquer coisa. É o que dá um id à capa desde o primeiro momento; ver o
  // modelo.
  //
  // Antes do `:id` pela mesma razão do `order` logo abaixo.
  app.post("/memberships/draft", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    // ── O TETO DO PLANO DO PRODUTO ──────────────────────────────────────
    //
    // *"crie esses limites na central, só para evitar abuso"*. Os planos da
    // casa são a VITRINE PÚBLICA do cliente: sem teto, nada impede uma conta
    // de virar um catálogo de duzentos itens numa página que nós hospedamos e
    // que carrega a nossa marca embaixo.
    //
    // Conta TUDO, rascunho incluído. Rascunho abandonado é lixo que a tela
    // apaga sozinha ao fechar; deixá-lo fora da conta abriria um caminho para
    // furar o teto criando e nunca salvando.
    if (await limiteDoPlano.barrou(app, req, res, "memberships", contarPlanos)) return;

    const moeda = await app.api.tenant.currencyFor();
    const id = await app.api.membership.rascunho(moeda);

    res.status(201).send(await app.api.membership.data(id));
  });

  // A ORDEM antes do `:id`: sem isso, "order" cairia na rota de baixo como se
  // fosse um id — e um id inválido vira 404 em vez de reordenar.
  app.put("/memberships/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const ok = await app.api.membership.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.membershipSaved") });
  });

  app.put("/memberships/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const existe = await app.api.membership.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.membershipNotFound") });

    await app.api.membership.update(req.params.id, req.body || {});

    app.insertUserActionHistory(req, user, "update_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(req.params.id) },
    });

    res.send(await app.api.membership.data(req.params.id));
  });

  // ── A CAPA ──────────────────────────────────────────────────────────────
  //
  // Sobe em `data:` no corpo, como a do aulão e a do avatar: a tela já reduz a
  // imagem antes de enviar, e um `multipart` só para isto traria uma dependência
  // e um caminho de erro a mais.
  //
  // Devolve a URL pronta — é ela que a tela põe no formulário e manda de volta
  // no `cover` ao salvar.
  app.post("/memberships/:id/cover", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const alvo = await app.api.membership.data(req.params.id);
    if (!alvo) return res.status(404).send({ msg: req.t("errors.membershipNotFound") });

    const parsed = app.api.membershipImage.parseDataUri((req.body || {}).image);
    if (!parsed) return res.status(400).send({ msg: req.t("errors.invalidImage") });

    const salva = await app.api.membershipImage.save(req.params.id, parsed.mime, parsed.buffer);

    res.status(201).send({ id: salva.id, url: urlDaCapa(req.instance, salva.id) });
  });

  // OS BYTES, sem sessão: a vitrine é pública, e a capa é parte dela.
  //
  // A instância vai no CAMINHO porque aqui não há de onde tirá-la: `<img src>`
  // não manda cabeçalho nosso, e `/public/` não passa pelo portão de instância.
  app.get("/public/membership-image/:instance/:id", async function (req, res) {
    const instancia = instanceContext.normalize(req.params.instance);
    if (!instancia) return res.status(404).end();

    const img = await instanceContext.run(instancia, () =>
      app.api.membershipImage.data(req.params.id)
    );
    // 404 seco: aqui não há quem leia mensagem traduzida.
    if (!img) return res.status(404).end();

    const etag = '"' + new Date(img.updatedAt).getTime() + '"';
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(img);
    if (!bytes) return res.status(404).end();

    res.setHeader("Content-Type", img.mime);
    res.setHeader("ETag", etag);
    // Cache longo e `immutable`: o id nunca é reaproveitado — trocar a capa gera
    // outro documento —, então não há como este endereço segurar imagem velha.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
  });

  app.post("/memberships/:id/clone", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    // ── O TETO DO PLANO DO PRODUTO ──────────────────────────────────────
    //
    // *"crie esses limites na central, só para evitar abuso"*. Os planos da
    // casa são a VITRINE PÚBLICA do cliente: sem teto, nada impede uma conta
    // de virar um catálogo de duzentos itens numa página que nós hospedamos e
    // que carrega a nossa marca embaixo.
    //
    // Conta TUDO, rascunho incluído. Rascunho abandonado é lixo que a tela
    // apaga sozinha ao fechar; deixá-lo fora da conta abriria um caminho para
    // furar o teto criando e nunca salvando.
    if (await limiteDoPlano.barrou(app, req, res, "memberships", contarPlanos)) return;

    const id = await app.api.membership.duplicate(req.params.id);
    if (!id) return res.status(404).send({ msg: req.t("errors.membershipNotFound") });

    app.insertUserActionHistory(req, user, "create_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(id) },
      extra: { clonadoDe: String(req.params.id) },
    });

    res.status(201).send(await app.api.membership.data(id));
  });

  app.delete("/memberships/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const feito = await app.api.membership.remove(req.params.id);

    if (feito?.erro === "notFound") {
      return res.status(404).send({ msg: req.t("errors.membershipNotFound") });
    }
    // O NÚMERO vai na mensagem: "não dá para apagar" sem dizer quantos deixaria
    // a pessoa procurando onde. Ver o modelo — desativar é o caminho.
    if (feito?.erro === "inUse") {
      return res.status(409).send({
        msg: req.t("errors.membershipInUse", { count: feito.quantas }),
        code: "in_use",
      });
    }

    app.insertUserActionHistory(req, user, "delete_membership", {
      category: "finance",
      local: { target_type: "memberships", target_id: String(req.params.id) },
    });

    res.send({ msg: req.t("ok.membershipRemoved") });
  });

  // ── A VITRINE, aberta ───────────────────────────────────────────────────
  //
  // De qual academia é esta vitrine sai do HOST, como na página pública da
  // agenda e na do aulão. `/public/` não passa pelo portão de instância (ver
  // `lib/instanceGate.js`), então quem resolve é a rota — e ela ENTRA no
  // contexto antes de tocar no banco, senão os modelos estouram de propósito.
  async function instanciaDoHost(req, res) {
    const host = String(
      req.query.host ||
        req.headers["x-instance-host"] ||
        req.headers["x-forwarded-host"] ||
        req.headers.host ||
        ""
    );

    const registro = await app.api.center.byHost(host);
    if (!registro || registro.active === false || registro.active === 0) {
      // 404 seco: aqui não há sessão nem idioma, e ninguém lê mensagem
      // traduzida dentro de um iframe no site de outra pessoa.
      res.status(404).send({ msg: "unknown" });
      return false;
    }

    return registro.instance;
  }

  // ── ASSINAR UM PLANO PELA VITRINE ───────────────────────────────────────
  //
  // *"quando clicarem 'quero este plano', deveria abrir a tela de login para o
  // cliente criar o cadastro; ele informa o CPF e o sistema já vê se existe;
  // se existir, usar o que já existe, se não abre uma telinha de cadastro"*
  // (14/10/2026).
  //
  // É o mesmo desenho da inscrição no aulão, e de propósito: um dado
  // identifica, quem já existe não digita mais nada, quem não existe recebe um
  // segundo passo pedindo o nome. O que muda é a CHAVE — lá o WhatsApp, aqui o
  // CPF, porque é ele que o gateway vai exigir para emitir a cobrança.
  //
  // ── A BUSCA É UM ORÁCULO, e o limite vem ANTES dela ────────────────────
  //
  // "Digite um CPF e eu digo se é aluno daqui" é exatamente o que esta rota
  // faz, e ela responde sem sessão para qualquer um. Três coisas seguram isso:
  //
  //   1. O LIMITE POR IP, contado antes de qualquer consulta — contar depois
  //      deixaria a pergunta ser respondida antes de a conta fechar.
  //   2. OS DÍGITOS VERIFICADORES, que cortam a varredura cega: quem quiser
  //      testar a base precisa de CPFs bem formados, não de contagem.
  //   3. A RESPOSTA NÃO DIZ QUEM É. Ela diz "já conhecemos" e devolve o
  //      primeiro nome, que é o que a tela precisa para cumprimentar — e o que
  //      qualquer pessoa que digitou o próprio CPF já sabe.
  //
  // Mais que isso pediria desafio (Turnstile), que é o caminho se um dia
  // alguém insistir. Hoje o custo não se justifica numa página de venda.
  const LIMITE_ASSINATURAS_POR_HORA = 20;

  function chaveDaHoraDoPlano(ip) {
    return `planoAssinatura:${ip}:${Math.floor(Date.now() / 3600000)}`;
  }

  // Os dois e-mails de uma matrícula pela vitrine. Separados da rota porque
  // ela já é longa, e porque isto roda DEPOIS da resposta — nada aqui pode
  // mudar o que a pessoa viu na tela.
  // O vencimento como se lê num e-mail, no idioma de quem lê.
  //
  // Ele chega como "2026-10-14" — dia puro, sem hora. `new Date(iso)` o lê
  // como meia-noite UTC e, formatado em São Paulo, vira 13/10: o vencimento
  // andaria um dia para trás no e-mail. Por isso o `T12:00:00`, que põe a
  // data no meio do dia e sobrevive a qualquer fuso.
  function emDiaLocal(iso, lang) {
    if (!iso) return "";
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString(lang || "pt-BR", { timeZone: "UTC" });
  }

  async function avisarDaMatricula({ req, pessoa, nome, email, telefone, documento, plano, unidade, pagamento }) {
    const casa = await app.api.tenant.dataOfInstance();
    const valor = dinheiro(plano.amount, plano.currency);
    const endereco = await enderecoDaInstancia(app);
    const nomeDaUnidade = unidade?.name || casa?.name || "";

    // 1. QUEM SE CADASTROU. No idioma de quem lê — o do pedido, que é o do
    //    navegador dela.
    if (email) {
      await app.helpers.mailer.send({
        to: email,
        ...planWelcome({
          lang: req.language,
          name: nome,
          plano: plano.name,
          unidade: nomeDaUnidade,
          valor,
          // ── O LINK DE PAGAR, quando ele existe ──────────────────────
          //
          // Ele troca o botão inteiro do e-mail. É o que salva quem fechou a
          // aba antes de pagar: sem isto, a academia recebe o telefonema no
          // dia seguinte perguntando como se paga.
          pagamento: pagamento
            ? { url: pagamento.url, vencimento: emDiaLocal(pagamento.vencimento, req.language) }
            : null,
          // Para onde responder: a unidade, se ela tem WhatsApp; senão a
          // própria casa. Um botão que não leva a lugar nenhum é pior que
          // nenhum botão.
          url: unidade?.whatsapp
            ? `https://wa.me/${String(unidade.whatsapp).replace(/\D/g, "")}`
            : endereco,
          tema: casa?.theme,
        }),
      });
    }

    // 2. A UNIDADE. O e-mail dela, e — quando ela não tem — o da casa: uma
    //    matrícula não pode se perder porque alguém não preencheu um campo.
    const paraACasa = unidade?.email || casa?.email;
    if (!paraACasa) return;

    await app.helpers.mailer.send({
      to: paraACasa,
      ...planSignupToUnit({
        lang: casa?.lang,
        name: nomeDaUnidade,
        person: nome,
        plano: plano.name,
        unidade: nomeDaUnidade,
        valor,
        cpf: cpfLib.formatar(documento),
        whatsapp: telefone || "—",
        contact: email || "—",
        url: `${endereco}/people/${pessoa}`,
        tema: casa?.theme,
      }),
    });
  }

  app.post("/public/memberships/:id/assinar", async function (req, res) {
    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const limite = await rateLimit.checkShared(
      chaveDaHoraDoPlano(clientIp(req)),
      LIMITE_ASSINATURAS_POR_HORA
    );

    if (!limite.allowed) {
      res.setHeader("Retry-After", "3600");
      return res.status(429).send({
        msg: req.t("errors.planSignupRateLimited"),
        code: "too_many_requests",
      });
    }

    const documento = cpfLib.limpar((req.body || {}).cpf);
    if (!cpfLib.valido(documento)) {
      return res.status(400).send({ msg: req.t("errors.invalidCpf"), code: "cpf_invalido" });
    }

    // ── NOME E SOBRENOME, como no resto do produto ────────────────────────
    //
    // *"aqui deveria ser nome e sobrenome, não?"* (14/10/2026). Deveria: a
    // ficha trabalha com as duas partes desde 01/10, e só as páginas públicas
    // seguiam mandando a linha inteira — herança da inscrição no aulão, onde
    // o nome é só para chamar na porta.
    //
    // Aqui não é: isto vira contrato, cobrança e, um dia, o `name` que o
    // gateway imprime no boleto. Um "Marlon" sozinho no lugar do titular é um
    // cadastro que a academia não acha e um boleto que o banco estranha.
    //
    // A linha inteira continua aceita para quem chamar a rota direto — é
    // `nomeDaPessoa.paraGravar` quem decide, e ele já sabe fazer os dois.
    const firstName = String((req.body || {}).firstName || "").trim();
    const lastName = String((req.body || {}).lastName || "").trim();
    const nome = String((req.body || {}).nome || "").trim();
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const telefone = String((req.body || {}).telefone || "").trim();
    if (email && !app.validator.isEmail(email)) {
      return res.status(400).send({ msg: req.t("errors.invalidEmail"), code: "email_invalido" });
    }

    return instanceContext.run(instancia, async () => {
      const plano = await app.api.membership.data(req.params.id);
      if (!plano || plano.active === false) {
        return res.status(404).send({ msg: req.t("errors.planNotFound"), code: "plano_nao_achado" });
      }

      // ── LINK PREENCHIDO VENCE ────────────────────────────────────────
      //
      // Decisão dele: quem configurou um checkout próprio continua indo para
      // lá. Esta rota existe para o plano SEM link — e recusa o outro em vez
      // de matricular por baixo de um fluxo que a casa montou noutro lugar.
      if (plano.botaoLink) {
        return res.status(409).send({ msg: req.t("errors.planHasOwnLink"), code: "tem_link_proprio" });
      }

      // ── QUEM É ESTA PESSOA: CPF, E DEPOIS E-MAIL ──────────────────────
      //
      // O CPF é a chave — mas ele só encontra quem JÁ TEM CPF gravado, e
      // quase ninguém tem: o campo nasceu hoje, desligado. O aluno antigo,
      // cadastrado pelo e-mail, não é achado por aqui.
      //
      // E isso não dava "não achei": dava ERRO INTERNO. O cadastro novo batia
      // no índice único de e-mail (`E11000`) e a tela dizia "Erro interno.",
      // que é a pior frase possível — ela não diz o que fazer e sugere que o
      // problema é nosso quando o dado é dele.
      //
      // Então o e-mail é a SEGUNDA chave, como no aulão. E quando ele
      // encontra, o CPF é gravado na ficha: a pessoa estava lá, faltava o
      // documento, e é exatamente o dado que a cobrança vai precisar.
      // ── A UNIDADE ESCOLHIDA, resolvida como na vitrine ────────────────
      //
      // Chega por apelido (`niteroi`, do endereço) ou por id (links antigos),
      // exatamente como na listagem — e os dois custam uma comparação.
      const pedida = String((req.body || {}).unidade || "").trim();
      const todasAsUnidades = pedida ? await app.api.unit.listActive() : [];
      const aUnidade = todasAsUnidades.find(
        (u) => String(u._id) === pedida || (u.alias && u.alias === pedida)
      );
      const escolhida = aUnidade ? String(aUnidade._id) : "";

      let existente = await app.api.user.dataByCpf(documento);
      if (!existente && email) existente = await app.api.user.dataByEmail(email);

      // `dataByEmail` é de uso geral e acha QUALQUER conta — inclusive a do
      // profissional, que foi exatamente o que mandou a mensalidade para a
      // conta errada. Aqui ela só vale para aluno; `dataByCpf` já filtra.
      //
      // Descartar e seguir para o cadastro novo também não serve: o índice
      // único de e-mail recusaria, e a pessoa veria uma colisão sem
      // explicação.
      //
      // A frase é curta de propósito — *"troque para 'Esse e-mail já é de uma
      // conta.'"* (14/10/2026). Ela dizia "de uma conta DA ACADEMIA", e isso
      // contava a quem estivesse testando e-mails que aquele endereço é de
      // alguém da equipe. Numa página pública, a resposta diz que o caminho
      // acabou, não de quem é a porta.
      if (existente && existente.type !== "student") {
        return res
          .status(409)
          .send({ msg: req.t("errors.planSignupStaffEmail"), code: "email_da_equipe" });
      }

      // ── CONFERIR NÃO É CONTRATAR ──────────────────────────────────────
      //
      // *"ao preencher o cpf já pesquisa automático"* (14/10/2026). A tela
      // consulta sozinha quando os onze dígitos ficam prontos — e se essa
      // consulta matriculasse, quem só digitou o documento sairia assinado
      // sem ter clicado em nada.
      //
      // Por isso o mesmo pedido, com `conferir`, para e responde. MESMA rota
      // de propósito: uma rota só de consulta seria um oráculo puro,
      // perguntável à vontade e sem nada acontecendo do outro lado. Aqui ela
      // paga o mesmo limite por IP e passa pelos mesmos dígitos
      // verificadores.
      //
      // E responde o mínimo: "conheço" e o primeiro nome, que é o que a tela
      // usa para cumprimentar — e o que quem digitou o próprio CPF já sabe.
      if ((req.body || {}).conferir) {
        return res.send({
          conferido: true,
          conhecido: Boolean(existente),
          nome: String(existente?.name || "").split(" ")[0],
        });
      }

      // ── A QUEM ESTE ALUNO PERTENCE ────────────────────────────────────
      //
      // Não ao plano, e não a quem o criou. *"muito estranho isso, ter que
      // salvar quem criou o plano; quem criou seria uma pessoa?"*
      // (14/10/2026) — e ele está certo: o plano é o CARDÁPIO DA CASA, não a
      // obra de alguém. Se a recepcionista cadastrou o "Black", todo mundo
      // que assinar pela internet viraria aluno da recepcionista.
      //
      // Eu cheguei a gravar o autor no plano para resolver isto. Era a
      // resposta errada para a pergunta certa, e saiu.
      //
      // ── A PERGUNTA CERTA, e o buraco que ela revela ────────────────
      //
      // "A quem pertence um aluno da casa?" O sistema não sabe responder:
      // aqui só existe ALUNO DE UM PROFISSIONAL. `listStudents` lista pelo
      // vínculo, e quem não tem vínculo não aparece para ninguém. Numa
      // academia — onde o aluno é da academia, e não do professor da terça —
      // isso é uma modelagem que ainda não existe.
      //
      // Enquanto não existe, o aluno vai para o profissional MAIS ANTIGO:
      // numa casa com três, é quem a montou. É um palpite, e é assumido como
      // tal — mover o aluno depois é um clique.
      //
      // Sem profissional nenhum não há a quem ligar, e inventar um dono é
      // como o defeito começou. Recusa.
      const dono = await app.api.user.profissionalMaisAntigo();
      if (!dono) {
        return res.status(409).send({ msg: req.t("errors.planSignupNoOwner"), code: "sem_dono" });
      }
      let pessoa;

      if (existente) {
        pessoa = existente._id;

        // O documento que faltava. Só grava quando não havia: sobrescrever o
        // CPF de alguém porque outra pessoa usou o mesmo e-mail seria trocar
        // a identidade de um cadastro por engano.
        // O documento e — se ela ainda não tinha — a unidade que acabou de
        // escolher. A unidade de quem JÁ tem uma não se mexe: a pessoa pode
        // treinar em Niterói e estar comprando o plano de Paraty para a
        // irmã, e trocar a unidade dela por isso seria um efeito colateral
        // de uma compra.
        const faltando = {};
        if (!existente.customFields?.cpf) faltando.customFields = { cpf: documento };
        if (!existente.unit && escolhida) faltando.unit = escolhida;

        if (Object.keys(faltando).length) {
          await app.api.user.updateStudent(dono, String(pessoa), faltando);
        }

        // Sem o vínculo, a pessoa existe e não aparece na lista de ninguém.
        await app.api.link.link(dono, pessoa, "vitrine");
      } else {
        // Só AQUI o nome é necessário. A tela lê o código para saber que deve
        // mostrar o segundo passo; a mensagem é para quem chamar a rota direto.
        if (!firstName && !nome) {
          return res.status(422).send({ msg: req.t("errors.planSignupName"), code: "precisa_do_nome" });
        }

        // ── O E-MAIL PASSOU A SER PEDIDO ──────────────────────────────
        //
        // *"peça o e-mail sim"* (14/10/2026). Ele era opcional porque campo a
        // mais em página de venda é gente que desiste — mas sem e-mail a
        // academia não tem como mandar o boleto, o recibo nem a senha do app,
        // e sobra ligar. O WhatsApp é por onde se fala; o e-mail é por onde
        // se ENTREGA.
        if (!email) {
          return res.status(422).send({ msg: req.t("errors.planSignupEmail"), code: "precisa_do_email" });
        }

        // ── A COLISÃO QUE SOBRA ────────────────────────────────────
        //
        // O e-mail acima resolve o caso comum. Resta o raro: dois cadastros
        // com o mesmo telefone, um username tomado, uma corrida entre duas
        // abas. Qualquer um deles estourava como "Erro interno.".
        //
        // Aqui vira uma frase que diz o que fazer — e o 500 fica para o que
        // é defeito nosso de verdade.
        try {
        pessoa = await app.api.user.insertStudent(dono, {
          ...(firstName ? { firstName, lastName } : { name: nome }),
          email,
          phone: telefone,
          // ── A UNIDADE QUE ELA ESCOLHEU ──────────────────────────────
          //
          // *"mas não aparece"* (14/10/2026), com a lista filtrada em
          // Niterói e a frase "quem ainda não foi atribuído aparece em todas
          // as unidades". O aluno estava lá, sem unidade — e quem abre a
          // lista abre na unidade dele.
          //
          // A pessoa ESCOLHEU a unidade na vitrine, no primeiro passo de
          // todos (`/vitrine/niteroi`). Perder essa escolha no cadastro é
          // perguntar à toa, e deixa o aluno invisível para quem o espera.
          ...(escolhida ? { unit: escolhida } : {}),
          // O CPF entra pelo campo semeado, que é onde `dataByCpf` o procura.
          // Só os dígitos: ver a nota lá.
          customFields: { cpf: documento },
        });
        } catch (erro) {
          if (erro?.code === 11000) {
            return res
              .status(409)
              .send({ msg: req.t("errors.planSignupDuplicate"), code: "ja_cadastrado" });
          }
          throw erro;
        }
      }

      // ── A MATRÍCULA É UMA RECORRÊNCIA ────────────────────────────────
      //
      // O valor e a cadência são COPIADOS do plano agora, e são eles que valem
      // daí em diante — reajustar o cardápio não reajusta quem já assinou. A
      // primeira cobrança nasce da leitura do financeiro
      // (`Recurrence_model.gerar`), que é o jeito desta casa.
      //
      // O NOME não é copiado: fica vazio, e quem nomeia a cobrança é o plano,
      // pelo vínculo (*"descrição deveria ficar em branco"*, 15/10/2026). Uma
      // cópia do nome congelaria "Plano Fit" numa recorrência que seguiria
      // viva depois de o plano virar outra coisa.
      const daPessoa = await app.api.recurrence.listOfStudent(pessoa);
      const jaTem = daPessoa.find(
        (r) => String(r.membership) === String(plano._id) && r.status !== "cancelada"
      );

      // O id importa agora: é ele que amarra a assinatura do gateway à regra
      // daqui, e é por ele que o aviso de pagamento volta a encontrar o dono.
      const regra = jaTem
        ? jaTem._id
        : await app.api.recurrence.insert(
            pessoa,
            {
              description: "",
              amount: plano.amount,
              cadencia: plano.cadencia,
              membership: plano._id,
              startsAt: new Date(),
            },
            dono,
            plano.currency
          );

      // ── E, SE O PLANO PEDIR, A COBRANÇA JÁ NASCE NO GATEWAY ───────────
      //
      // *"se essa opção tiver marcada, em vez de falar que a unidade vai
      // entrar em contato, já gera o cadastro dele no gateway e cria a
      // recorrência direto lá"* (14/10/2026).
      //
      // DEPOIS da matrícula, e sem poder desfazê-la. Tudo daqui para baixo é
      // melhoria do desfecho: o caminho de sempre — a academia liga, combina
      // o pagamento — continua valendo se o Asaas estiver fora do ar, se a
      // chave tiver sido trocada, ou se o CPF for recusado lá.
      //
      // `jaTem` não repete a assinatura: quem clicou duas vezes não ganha
      // duas cobranças no gateway, e quem já assinou pelo balcão não ganha
      // uma segunda pelo site.
      let pagamento = null;

      if (plano.gerarNoGateway && !jaTem?.gateway?.assinatura) {
        const cobrado = await app.api.cobrador.assinar({
          instancia,
          // A unidade que ela escolheu na vitrine: é por ela que se decide
          // em qual conta do gateway a cobrança nasce. Cada filial pode ter
          // o CNPJ dela, e o dinheiro tem de cair na conta certa.
          unidade: escolhida ? String(escolhida) : "",
          pessoa: {
            id: pessoa,
            nome: String(existente?.name || [firstName, lastName].filter(Boolean).join(" ") || nome),
            documento,
            email: email || existente?.email || "",
            telefone: telefone || existente?.phone || "",
          },
          plano,
          recorrencia: regra,
        });

        if (cobrado.ok) pagamento = cobrado.pagamento;
        // Falhar aqui NÃO é 500. A pessoa está matriculada; o que não saiu foi
        // a fatura, e a tela cai no texto de sempre. O log é para o dono da
        // casa descobrir que a integração dele está torta.
        else console.error(`[vitrine] gateway recusou (${cobrado.erro}):`, cobrado.detalhe || "");
      }

      // ── OS DOIS AVISOS ────────────────────────────────────────────────
      //
      // *"envie e-mail para quem se cadastrou agradecendo etc... e também
      // e-mail para a unidade com os dados"* (14/10/2026).
      //
      // DEPOIS de a matrícula estar gravada, e engolindo qualquer falha: um
      // aviso que não saiu não pode desfazer uma matrícula que já existe. É a
      // mesma escolha do agendamento e do `lib/avisar.js`.
      //
      // Sem `await` no `res`: a pessoa não espera o SMTP para ver "pronto".
      avisarDaMatricula({
        req,
        pessoa,
        nome: String(existente?.name || [firstName, lastName].filter(Boolean).join(" ") || nome),
        email,
        telefone,
        documento,
        plano,
        unidade: aUnidade,
        pagamento,
      }).catch((erro) => console.error("[vitrine] o aviso não saiu:", erro?.message));

      return res.send({
        ok: true,
        jaEraAluno: Boolean(existente),
        // O primeiro nome, e só ele: é o que a tela usa para cumprimentar, e
        // quem digitou o próprio CPF já o sabe.
        //
        // `firstName` entra na conta porque o cadastro passou a mandar as
        // partes separadas — sem ele, quem acabou de se cadastrar via
        // "Pronto, !" na tela de agradecimento.
        nome: String(existente?.name || firstName || nome || "").split(" ")[0],
        // `Boolean` e não o objeto: `jaTem` passou a ser a RECORRÊNCIA
        // encontrada (o id dela amarra a assinatura do gateway), e mandá-la
        // crua despejaria a regra inteira — valor, datas, quem criou — numa
        // resposta pública.
        repetida: Boolean(jaTem),
        // ── O QUE A PESSOA PAGA AGORA ────────────────────────────────────
        //
        // `null` é o caso comum e NÃO é falha: o plano pode não gerar no
        // gateway, ou a fatura pode ainda não ter nascido do lado de lá. A
        // tela lê a ausência como "a academia entra em contato", que é o
        // texto que sempre esteve ali.
        pagamento: pagamento || null,
      });
    });
  });

  app.get("/public/memberships", async function (req, res) {
    const instancia = await instanciaDoHost(req, res);
    if (instancia === false) return;

    const dados = await instanceContext.run(instancia, async () => {
      const [planos, beneficios, moedas, unidades, formas] = await Promise.all([
        app.api.membership.listActive(),
        app.api.membershipBenefit.listActive(),
        app.api.tenant.currencyOfInstance(),
        app.api.unit.listActive(),
        // Já com o nome resolvido: a vitrine carrega só a parte `vitrine` da
        // tradução, e não teria como escrever "Dinheiro" sozinha.
        app.api.paymentMethod.paraTela(req.t),
      ]);

      return { planos, beneficios, moeda: moedas.currency, unidades, formas };
    });

    // ── A VITRINE POR UNIDADE ────────────────────────────────────────────
    //
    // *"na vitrine pública teria que ter um jeito de eu escolher a unidade,
    // pois cada unidade pode ter planos e preços diferentes"*.
    //
    // Plano sem unidade nenhuma vale em TODAS — é a mesma leitura de
    // `users.units`, e é o que mantém no ar todo plano cadastrado antes desta
    // mudança.
    // ── O PEDIDO CHEGA POR APELIDO, E AINDA POR ID ────────────────────────
    //
    // *"quando eu clicar na unidade, mude a rota /vitrine/alias-unidade"*
    // (14/10/2026). O endereço passou a carregar `niteroi`; o filtro dos
    // planos continua por id, que é o que está gravado em `plano.units`.
    //
    // O ID continua aceito e não é por teimosia: `?unidade=<id>` é o que
    // está hoje em todo iframe já pendurado, e no link que alguém mandou por
    // WhatsApp semana passada. Os dois caminhos custam uma comparação.
    const pedida = String(req.query.unidade || "").trim();
    const porApelido = dados.unidades.find((u) => u.alias && u.alias === pedida);
    const escolhida = porApelido ? String(porApelido._id) : pedida;

    const daUnidade = (p) => {
      const dele = (p.units || []).map(String);
      if (!dele.length) return true;
      return escolhida ? dele.includes(escolhida) : true;
    };

    const planosVisiveis = dados.planos.filter(daUnidade);

    // ── SÓ OS CAMPOS DO CARTÃO ────────────────────────────────────────────
    //
    // Montado à mão, e não `...plano`. O documento tem `createdBy`, `order`,
    // `updatedAt` — nada disso desenha nada, e uma vitrine que devolve o
    // documento inteiro vaza o próximo campo que alguém acrescentar sem pensar
    // nisto aqui.
    const beneficiosVisiveis = dados.beneficios.map((b) => ({
      id: String(b._id),
      name: b.name,
      description: b.description || "",
      icone: b.icone || "",
      iconeSvg: b.iconeSvg || "",
      iconeCaixa: b.iconeCaixa || "",
    }));

    const validos = new Set(beneficiosVisiveis.map((b) => b.id));


    // ── A VITRINE NÃO PODE FICAR VELHA ────────────────────────────────────
    //
    // *"parece que só aparece 3 benefícios, mesmo eu tendo colocado mais"*. Os
    // seis estavam no banco e seis saíam daqui: o que a tela mostrava era a
    // resposta de um minuto antes, guardada pelo navegador por causa do
    // `max-age=60` que eu mesmo tinha posto.
    //
    // Um minuto é pouco em teoria e é tudo na prática: o fluxo desta tela é
    // editar no painel e olhar a vitrine em seguida, e nessa janela ela mente.
    // Quem editou não desconfia do cache — desconfia do que acabou de salvar.
    //
    // `max-age=0, must-revalidate` NÃO é "não guarde": o navegador continua
    // guardando e pergunta antes de usar. Com o ETag que o Express já manda,
    // a resposta repetida é um 304 sem corpo — quase de graça, e nunca velha.
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");

    res.send({
      moeda: dados.moeda,
      beneficios: beneficiosVisiveis,
      cadencias: recorrencia.paraTela(req.t),
      // ── AS UNIDADES QUE A VITRINE OFERECE ──────────────────────────────
      //
      // Só as que TÊM plano: uma opção que leva a uma página vazia é pior que
      // opção nenhuma, e quem abre a vitrine é um cliente em potencial, não
      // alguém disposto a investigar.
      //
      // ── O QUE SAI, E POR QUE MUDOU EM 14/10/2026 ───────────────────────
      //
      // Aqui saíam só `id` e `name`, com uma nota minha dizendo que telefone e
      // endereço eram "dados de contato da casa" e não sairiam numa rota sem
      // sessão. Ele desfez isso e tem razão: *"mostre o card de cada unidade
      // com a foto em cima, endereço, telefone, whatsapp"*.
      //
      // A nota confundia DADO PESSOAL com VITRINE. O endereço e o telefone de
      // uma academia são a placa na porta: ela paga para que apareçam no mapa,
      // no Instagram e na lista do bairro. Esconder aqui não protegia ninguém
      // — só obrigava quem estava escolhendo entre duas filiais a sair da
      // página para descobrir qual é a mais perto.
      //
      // O que continua FORA é o `email`: numa página pública ele é endereço de
      // robô de spam, e quem quer falar usa o WhatsApp, que está logo ali.
      unidades: dados.unidades
        .filter((u) =>
          dados.planos.some((p) => {
            const dele = (p.units || []).map(String);
            return !dele.length || dele.includes(String(u._id));
          })
        )
        .map((u) => ({
          id: String(u._id),
          // O pedaço que vira endereço: `/vitrine/niteroi`.
          alias: u.alias || "",
          name: u.name,
          // A foto já era pública antes desta mudança: `/public/unit-image/`
          // existe desde o início, porque "uma foto que exige login não
          // aparece" (ver `controllers/Unit.js`).
          photoUrl: u.photo ? `${baseUrl()}/public/unit-image/${instancia}/${u.photo}` : null,
          endereco: cep.umaLinha(u),
          phone: u.phone || "",
          whatsapp: u.whatsapp || "",
          // Para o botão "como chegar": quem está escolhendo filial quer ver
          // onde ela fica, e o mapa resolve o que a linha de endereço não diz.
          lat: u.lat ?? null,
          lng: u.lng ?? null,
        })),
      planos: planosVisiveis.map((p) => ({
        id: String(p._id),
        // ── AS FORMAS, RESOLVIDAS AQUI ──────────────────────────────────
        //
        // A tela recebe os NOMES prontos, não as chaves. Resolver lá pediria
        // que a vitrine conhecesse o catálogo da casa — e o nome é da casa:
        // ela pode ter chamado o Pix de "Pix (chave CNPJ)".
        //
        // Lista vazia no plano quer dizer TODAS as ativas. Ver
        // `formasDePagamento` em `Membership_model`.
        formasDePagamento: (dados.formas || [])
          .filter(
            (f) =>
              !(p.formasDePagamento || []).length ||
              (p.formasDePagamento || []).includes(f.key)
          )
          .map((f) => ({ key: f.key, name: f.name })),
        name: p.name,
        tagline: p.tagline || "",
        description: p.description || "",
        amount: p.amount || 0,
        currency: p.currency || dados.moeda,
        cadencia: p.cadencia,
        fidelidadeMeses: p.fidelidadeMeses || 0,
        destaque: p.destaque === true,
        coverUrl: urlDaCapa(instancia, p.cover),
        // ── A APARÊNCIA ESCOLHIDA ───────────────────────────────────────
        //
        // Elas viram `style=` no cartão, então saem daqui já validadas pelo
        // modelo: hex de seis dígitos ou vazio, nunca uma string livre. Vazio
        // é "usa a cor da marca", e é o que a esmagadora maioria dos planos
        // vai mandar.
        corFundo: p.corFundo || "",
        corTexto: p.corTexto || "",
        corDestaque: p.corDestaque || "",
        corBotao: p.corBotao || "",
        corBotaoTexto: p.corBotaoTexto || "",
        // ── O BOTÃO APARECE MESMO SEM LINK ──────────────────────────────
        //
        // *"na vitrine não aparecem os botões"*.
        //
        // Eu tinha escondido o botão sem destino, com o argumento de que porta
        // pintada é pior que parede. Errado para esta tela: o cartão SEM botão
        // não é um cartão honesto, é um cartão incompleto — ele termina na
        // lista de benefícios e não convida a nada, e o lugar onde ele vive é
        // justamente uma página de venda.
        //
        // Quem ainda não pôs o link vê o botão e entende o que falta. A tela
        // de edição diz onde preenchê-lo.
        botaoTexto: p.botaoTexto || "",
        botaoLink: p.botaoLink || "",
        // O DESENHO vem do nosso banco, conferido contra a lista fechada de
        // tags de `lib/iconify.js`. A vitrine nunca fala com a Iconify: ela
        // abre dentro do site do cliente, e um ícone que depende de um
        // terceiro responder é um buraco no cartão de venda dele.
        botaoIconeSvg: p.botaoIconeSvg || "",
        botaoIconeCaixa: p.botaoIconeCaixa || "",
        // Benefício DESATIVADO some do cartão junto com a linha da tabela:
        // deixá-lo aqui faria o cartão prometer algo que a comparação nem lista.
        beneficios: (p.beneficios || []).map(String).filter((id) => validos.has(id)),
      })),
    });
  });

  // ── Benefícios: as linhas da tabela de comparação ───────────────────────

  app.get("/membership-benefits", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const rows =
      req.query.todos === "1"
        ? await app.api.membershipBenefit.list()
        : await app.api.membershipBenefit.listActive();

    res.send({ rows });
  });

  app.post("/membership-benefits", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const id = await app.api.membershipBenefit.insert(req.body || {});
    if (!id) return res.status(400).send({ msg: req.t("errors.requireName") });

    res.status(201).send(await app.api.membershipBenefit.data(id));
  });

  app.put("/membership-benefits/order", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const ok = await app.api.membershipBenefit.reorder((req.body || {}).ids);
    if (!ok) return res.status(400).send({ msg: req.t("errors.invalidOrder") });

    res.send({ msg: req.t("ok.membershipSaved") });
  });

  app.put("/membership-benefits/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const existe = await app.api.membershipBenefit.data(req.params.id);
    if (!existe) return res.status(404).send({ msg: req.t("errors.membershipBenefitNotFound") });

    await app.api.membershipBenefit.update(req.params.id, req.body || {});
    res.send(await app.api.membershipBenefit.data(req.params.id));
  });

  app.delete("/membership-benefits/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const feito = await app.api.membershipBenefit.remove(req.params.id);

    if (feito?.erro === "notFound") {
      return res.status(404).send({ msg: req.t("errors.membershipBenefitNotFound") });
    }
    if (feito?.erro === "inUse") {
      return res.status(409).send({
        msg: req.t("errors.membershipBenefitInUse", { count: feito.quantos }),
        code: "in_use",
      });
    }

    res.send({ msg: req.t("ok.membershipBenefitRemoved") });
  });
};
