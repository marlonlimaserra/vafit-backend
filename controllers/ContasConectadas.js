const instanceContext = require("../lib/instance.js");
const dominio = require("../lib/domain.js");
const arquivos = require("../lib/arquivos.js");
const estadoDaConta = require("../lib/estadoDaConta.js");

// CONECTAR O INSTAGRAM DO PROFISSIONAL AO VAFIT.
//
// *"agora precisamos conectar a conta do Facebook e a conta do Instagram no
// VAFIT"* (26/09/2026).
//
// Três rotas para a pessoa e uma para a Meta:
//
//   GET    /contas-conectadas          a lista, sem token nenhum
//   GET    /contas-conectadas/url      para onde mandar o navegador
//   DELETE /contas-conectadas/:id      desliga
//   GET    /auth/instagram/callback    a volta, chamada pelo Instagram
//
// ── Por que o callback é PÚBLICO e sem sessão ───────────────────────────
//
// Porque quem bate nele é o navegador da pessoa voltando do instagram.com, e
// nessa volta não há cabeçalho de autorização — é uma navegação, não uma
// chamada da aplicação. O que prova que a volta é legítima é o `state`: um
// bilhete de uso único que NÓS emitimos, guardado no banco com TTL, carregando
// de qual cliente ele saiu. Ver `Oauth_model`.
// A tela para onde cada volta devolve. Uma SEÇÃO por rede, no grupo "Contas"
// da coluna de Configurações — devolver o Facebook na tela do Instagram faria
// a pessoa procurar a conta que acabou de ligar.
//
// `/configuration/` em inglês: é a rota do painel (`App.jsx`), e ela NÃO é
// traduzida de propósito — um endereço que mudasse com o idioma quebraria o
// link que alguém mandou para outra pessoa.
const TELA = {
  instagram: "/configuration/instagram",
  facebook: "/configuration/facebook",
};

// De quantos em quantos dias a cópia da foto é refeita.
//
// A URL que o Graph devolve é assinada e MUDA a cada chamada, então comparar
// endereços não diz nada sobre a imagem ter mudado. Sem um prazo, a foto que
// copiamos no dia da conexão ficaria para sempre — a Página troca de logo e
// aqui continua a antiga. Um mês é barato (um download por conta por mês) e
// resolve o caso real, que é raro.
const REFRESCA_APOS_DIAS = 30;

module.exports = function (app) {
  // O ENDEREÇO FIXO da foto — *"deixe o link fixo"* (15/10/2026).
  //
  // Ele nunca muda para uma conta: é o id dela. O que muda é o `?v=`, que sai
  // da data da cópia — é o que faz uma foto trocada aparecer sem esperar o
  // cache de um ano que a rota manda guardar.
  const urlDaFoto = (instancia, conta) =>
    conta.fotoEm
      ? `${dominio.apiBaseUrl()}/public/conta-foto/${instancia}/${conta._id}?v=${new Date(conta.fotoEm).getTime()}`
      : "";

  const paraTela = (instancia) => (c) => ({ ...c, foto: urlDaFoto(instancia, c) });

  // ── A LISTA ────────────────────────────────────────────────────────────
  app.get("/contas-conectadas", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.view");
    if (user === false) return;

    const [contas, doInstagram, daPagina] = await Promise.all([
      app.api.contaConectada.lista(req.query.tipo),
      app.api.oauthInstagram.chaves(),
      app.api.oauthPagina.chaves(),
    ]);

    // `ligado` é o que decide se cada botão de conectar aparece. Sem as chaves
    // na central, o botão levaria a uma tela de erro da Meta — e o que a
    // pessoa leria é que a conta DELA tem problema.
    //
    // São dois interruptores porque são dois caminhos independentes: o
    // Instagram usa o app de Instagram Business Login, a Página usa o app de
    // integração com uma configuração. Um pode estar pronto sem o outro.
    res.send({
      contas: contas.map(paraTela(req.instance)),
      instagram: { ligado: doInstagram.ligado },
      facebook: { ligado: daPagina.ligado },
      // O catálogo do selo, já traduzido. A tela não conhece estado nenhum:
      // acrescentar um aqui o faz aparecer lá sem mexer numa linha de lá.
      estados: estadoDaConta.paraTela(req.t),
    });
  });

  // ── O SELO: PERGUNTAR À META SE O TOKEN AINDA VALE ─────────────────────
  //
  // *"coloque um 'badge' de status, que vai no backend e consulta se o token
  // ainda está funcionando"* (15/10/2026).
  //
  // Rota SEPARADA da lista, de propósito. A lista abre com o último resultado
  // conhecido e isto chega depois: perguntar antes de desenhar faria a tela
  // esperar a rede da Meta — e quando ela está lenta é justamente quando
  // alguém veio olhar por quê.
  //
  // `integrations.view` e não `manage`: isto não muda a integração, só olha.
  app.post("/contas-conectadas/verificar", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.view");
    if (user === false) return;

    const tipo = req.query.tipo === "facebook" ? "facebook" : "instagram";
    const modelo = tipo === "facebook" ? app.api.oauthPagina : app.api.oauthInstagram;

    const contas = await app.api.contaConectada.paraConferir(tipo);
    const chaves = await modelo.chaves();

    // Sem as chaves do app não dá para perguntar nada — e isso não é defeito
    // da conta de ninguém. A lista volta como está, e o selo segue cinza.
    if (chaves.ligado) {
      await Promise.all(
        contas.map(async (conta) => {
          const r =
            tipo === "facebook" ? await modelo.conferir(conta, chaves) : await modelo.conferir(conta);

          await app.api.contaConectada.marcarEstado(conta._id, r);

          // A MESMA IDA TRAZ A FOTO, e é ela que conserta as contas ligadas
          // antes de 15/10 — quando o que se guardava era a URL do CDN, que
          // expira. Sem isto, só reconectar traria a imagem de volta.
          if (r.foto && precisaDeFoto(conta)) {
            await app.api.contaConectada.copiarFoto(conta, r.foto);
          }
        })
      );
    }

    res.send({ contas: (await app.api.contaConectada.lista(tipo)).map(paraTela(req.instance)) });
  });

  function precisaDeFoto(conta) {
    const em = conta.fotoArquivo?.em;
    if (!em) return true;
    return Date.now() - new Date(em).getTime() > REFRESCA_APOS_DIAS * 86400000;
  }

  // ── OS BYTES DA FOTO ───────────────────────────────────────────────────
  //
  // Pública e com endereço opaco, como a capa de um plano: é um `<img>` numa
  // tela, e `<img>` não manda cabeçalho de sessão. O que ela serve é a foto
  // de perfil de uma Página pública, e o id não deixa varrer nada — mas o
  // token, esse, nunca passa por aqui.
  app.get("/public/conta-foto/:instance/:id", async function (req, res) {
    const instancia = instanceContext.normalize(req.params.instance);
    if (!instancia) return res.status(404).end();

    const foto = await instanceContext.run(instancia, () =>
      app.api.contaConectada.foto(req.params.id)
    );
    // 404 seco: aqui não há quem leia mensagem traduzida.
    if (!foto) return res.status(404).end();

    const etag = '"' + new Date(foto.em || 0).getTime() + '"';
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    const bytes = await arquivos.bytesDoDocumento(foto);
    if (!bytes) return res.status(404).end();

    res.setHeader("Content-Type", foto.mime || "image/jpeg");
    res.setHeader("ETag", etag);
    // Um ano, mas NÃO `immutable`: o endereço é fixo e a imagem pode ser
    // trocada (a Página muda de logo). Quem troca o `?v=` é a lista, e o ETag
    // segura o resto.
    res.setHeader("Cache-Control", "public, max-age=31536000");
    res.send(bytes);
  });

  // ── PARA ONDE MANDAR O NAVEGADOR ───────────────────────────────────────
  app.get("/contas-conectadas/url", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.manage");
    if (user === false) return;

    // `tipo` escolhe o caminho. Lista FECHADA, e não o que chegou: um valor
    // qualquer aqui viraria `app.api[algo]` — o caminho mais curto para um
    // parâmetro da URL escolher que código roda.
    const tipo = req.query.tipo === "facebook" ? "facebook" : "instagram";
    const modelo = tipo === "facebook" ? app.api.oauthPagina : app.api.oauthInstagram;

    try {
      const chaves = await modelo.chaves();
      if (!chaves.ligado) return res.send({ ligado: false });

      const state = await modelo.criarEstado(
        instanceContext.current(),
        req.headers["x-instance-host"],
        req.query.destino,
        // Quem clicou atravessa a ida e a volta: na volta não há sessão, e sem
        // isto a conta ficaria registrada como conectada por ninguém.
        { userId: user._id }
      );

      // As assinaturas diferem porque os fluxos diferem: o Instagram pede
      // escopo por nome, a Página pede uma CONFIGURAÇÃO inteira.
      const url =
        tipo === "facebook"
          ? modelo.urlDeAutorizacao(chaves, state)
          : modelo.urlDeAutorizacao(chaves.clientId, state);

      res.send({ ligado: true, url });
    } catch (erro) {
      console.error(`[${tipo}] não consegui montar o link:`, erro.message);
      res.send({ ligado: false });
    }
  });

  // ── DESLIGAR ───────────────────────────────────────────────────────────
  //
  // Apaga dos DOIS lugares: a conta no banco do cliente e a linha do diretório
  // na central. Só o primeiro deixaria o webhook continuar entregando eventos
  // a um cliente que não tem mais token para responder.
  app.delete("/contas-conectadas/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.manage");
    if (user === false) return;

    const conta = await app.api.contaConectada.porId(req.params.id);
    if (!conta) return res.status(404).send({ msg: req.t("errors.notFound") });

    await app.api.center.esquecerContaDaMeta({
      tipo: conta.tipo,
      externalId: conta.externalId,
      instancia: instanceContext.current(),
    });

    await app.api.contaConectada.remover(req.params.id);

    app.insertUserActionHistory(req, user, "integrations.disconnect", {
      category: "integrations",
      extra: { tipo: conta.tipo, conta: conta.usuario || conta.externalId },
    });

    res.send({ ok: true });
  });

  // ── O QUE VOLTOU, PARA A PESSOA ESCOLHER ───────────────────────────────
  //
  // Sem token nenhum: é uma lista para marcar caixinha. Vem junto o que JÁ
  // está conectado, porque o diálogo abre com essas marcadas — e é isso que
  // faz o mesmo diálogo servir para ligar e para desligar.
  app.get("/contas-conectadas/escolha/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.manage");
    if (user === false) return;

    const doc = await app.api.escolhaDeConexao.ler(req.params.id);
    if (!doc) return res.status(404).send({ msg: req.t("errors.notFound"), code: "escolha_expirou" });

    const jaConectadas = await app.api.contaConectada.lista(doc.tipo);

    res.send({
      ...app.api.escolhaDeConexao.paraTela(doc),
      jaConectadas: jaConectadas.map((c) => c.externalId),
    });
  });

  // ── GRAVAR O QUE ELA MARCOU ────────────────────────────────────────────
  //
  // É uma SINCRONIZAÇÃO, não um "adicionar": o que foi marcado passa a valer,
  // o que estava conectado e saiu da marcação é desligado. Sem isso o diálogo
  // só saberia somar, e desmarcar não faria nada — o pior tipo de controle,
  // o que parece funcionar.
  app.post("/contas-conectadas/escolha/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "integrations.manage");
    if (user === false) return;

    const doc = await app.api.escolhaDeConexao.ler(req.params.id);
    if (!doc) return res.status(404).send({ msg: req.t("errors.notFound"), code: "escolha_expirou" });

    // Só ids que estavam NO RASCUNHO. Um id vindo de fora seria a tela
    // escolhendo por qual Página este cliente passa a falar.
    const oferecidas = new Map((doc.contas || []).map((c) => [String(c.externalId), c]));
    const pedidas = [...new Set((req.body?.ids || []).map(String))].filter((id) => oferecidas.has(id));

    const chaves = await app.api.oauthPagina.chaves();
    const instancia = instanceContext.current();

    const ligadas = [];
    const mudas = [];

    for (const id of pedidas) {
      const conta = oferecidas.get(id);
      // Assinar ANTES de gravar: gravar primeiro deixaria, numa falha de
      // rede, uma conta que aparece conectada e nunca recebe nada.
      const assinatura = await app.api.oauthPagina.assinarWebhook(
        { id: conta.externalId, access_token: conta.token },
        chaves
      );

      await app.api.contaConectada.guardar({ ...conta, assinada: assinatura.ok }, user);
      await app.api.center.registrarContaDaMeta({
        tipo: doc.tipo,
        externalId: conta.externalId,
        instancia,
      });

      ligadas.push(conta.nome || conta.externalId);
      if (!assinatura.ok) mudas.push(conta.nome || conta.externalId);
    }

    // O outro lado da sincronização: o que estava ligado, foi OFERECIDO de
    // novo e não foi marcado. Só isso — uma Página que não apareceu nesta
    // volta (a pessoa tirou o acesso no Facebook) não é "desmarcada", e
    // desligá-la por omissão seria decidir por ela.
    const desligadas = [];
    for (const atual of await app.api.contaConectada.lista(doc.tipo)) {
      if (!oferecidas.has(String(atual.externalId))) continue;
      if (pedidas.includes(String(atual.externalId))) continue;

      const completa = await app.api.contaConectada.porId(atual._id);
      if (completa) await app.api.oauthPagina.desassinarWebhook(completa, chaves).catch(() => {});

      await app.api.center.esquecerContaDaMeta({
        tipo: doc.tipo,
        externalId: atual.externalId,
        instancia,
      });
      await app.api.contaConectada.remover(atual._id);
      desligadas.push(atual.nome || atual.externalId);
    }

    await app.api.escolhaDeConexao.apagar(doc.escolha);

    app.insertUserActionHistory(req, user, "integrations.connect", {
      category: "integrations",
      extra: { tipo: doc.tipo, ligadas: ligadas.length, desligadas: desligadas.length },
    });

    res.send({ ok: true, ligadas: ligadas.length, desligadas: desligadas.length, mudas });
  });

  // ── A VOLTA DO INSTAGRAM ───────────────────────────────────────────────
  //
  // Sempre termina em REDIRECT, nunca em JSON: quem está do outro lado é uma
  // aba do navegador, e um JSON aqui deixaria a pessoa olhando chaves e
  // colchetes no meio de um fluxo que ela começou clicando num botão.
  app.get("/auth/instagram/callback", async function (req, res) {
    const semRumo = null;

    const paraTela = (estado, resultado) => {
      const base = app.api.oauthInstagram.enderecoDeVolta(estado);
      const p = new URLSearchParams(resultado);
      // A ABA da rede, e não a raiz da tela: voltar do Instagram para a aba
      // do Facebook faria a pessoa procurar a conta que acabou de ligar.
      return res.redirect(`${base}${TELA.instagram}?${p.toString()}`);
    };

    // A pessoa clicou em "Cancelar" no Instagram. Não é erro: é resposta.
    if (req.query.error) {
      const estado = await app.api.oauthInstagram.consumirEstado(req.query.state);
      return paraTela(estado, { meta: "cancelado" });
    }

    let estado = null;
    try {
      estado = await app.api.oauthInstagram.consumirEstado(req.query.state);
      if (!estado) return paraTela(semRumo, { meta: "expirou" });

      const chaves = await app.api.oauthInstagram.chaves();
      if (!chaves.ligado) return paraTela(estado, { meta: "sem_chaves" });

      const conta = await app.api.oauthInstagram.contaDoCodigo(req.query.code, chaves);
      if (conta.erro) {
        console.error("[instagram] a volta falhou:", conta.erro, conta.detalhe || "");
        return paraTela(estado, { meta: "falhou" });
      }

      // Daqui para baixo tudo acontece DENTRO do cliente que começou o fluxo —
      // o nome veio do bilhete, não de um cabeçalho que alguém possa escrever.
      await instanceContext.run(estado.instancia, async () => {
        const quem = estado.userId ? await app.api.user.data(estado.userId) : null;

        await app.api.contaConectada.guardar({ tipo: "instagram", ...conta }, quem);

        await app.api.center.registrarContaDaMeta({
          tipo: "instagram",
          externalId: conta.externalId,
          instancia: estado.instancia,
        });

        if (quem) {
          app.insertUserActionHistory({ ...req, user: quem }, quem, "integrations.connect", {
            category: "integrations",
            extra: { tipo: "instagram", conta: conta.usuario },
          });
        }
      });

      return paraTela(estado, { meta: "ok", conta: conta.usuario });
    } catch (erro) {
      console.error("[instagram] a volta estourou:", erro.message);
      return paraTela(estado, { meta: "falhou" });
    }
  });

  // ── A VOLTA DA PÁGINA DO FACEBOOK ──────────────────────────────────────
  //
  // `/auth/meta/` e não `/auth/pagina/`: é o endereço cadastrado no console do
  // app de integração, e o cadastro veio primeiro. Ver `OauthPagina_model`.
  //
  // A diferença para o Instagram: aqui volta uma LISTA. Uma pessoa administra
  // várias Páginas, e quais ela liberou foi decidido na tela da Meta — o que
  // chega aqui é o resultado dessa escolha.
  app.get("/auth/meta/callback", async function (req, res) {
    const paraTela = (estado, resultado) => {
      const base = app.api.oauthPagina.enderecoDeVolta(estado);
      const p = new URLSearchParams(resultado);
      return res.redirect(`${base}${TELA.facebook}?${p.toString()}`);
    };

    if (req.query.error) {
      const estado = await app.api.oauthPagina.consumirEstado(req.query.state);
      return paraTela(estado, { meta: "cancelado" });
    }

    let estado = null;
    try {
      estado = await app.api.oauthPagina.consumirEstado(req.query.state);
      if (!estado) return paraTela(null, { meta: "expirou" });

      const chaves = await app.api.oauthPagina.chaves();
      if (!chaves.ligado) return paraTela(estado, { meta: "sem_chaves" });

      const r = await app.api.oauthPagina.contasDoCodigo(req.query.code, chaves);
      if (r.erro) {
        console.error("[pagina] a volta falhou:", r.erro, r.detalhe || "");
        // "Autorizou mas não escolheu Página nenhuma" não é falha nossa, e
        // merece um recado próprio: quem lê "não consegui" vai tentar de novo
        // do mesmo jeito e chegar ao mesmo lugar.
        return paraTela(estado, { meta: r.erro === "nenhuma_pagina" ? "sem_pagina" : "falhou" });
      }

      // ── AQUI NÃO SE GRAVA NADA ────────────────────────────────────────
      //
      // A primeira versão conectava tudo o que voltasse, e ele apontou o
      // buraco: *"tem gente com mais de 200 páginas de Facebook"*. Autorizar
      // no Facebook é dizer "pode ver as minhas Páginas"; não é dizer "ligue
      // todas". As duas decisões são diferentes e agora são dois passos.
      //
      // O que acontece é um RASCUNHO com prazo, e a tela pergunta.
      const escolha = await instanceContext.run(estado.instancia, () =>
        app.api.escolhaDeConexao.criar("facebook", r.contas, {
          truncada: r.truncada,
          userId: estado.userId,
        })
      );

      return paraTela(estado, { meta: "escolher", escolha });
    } catch (erro) {
      console.error("[pagina] a volta estourou:", erro.message);
      return paraTela(estado, { meta: "falhou" });
    }
  });
};
