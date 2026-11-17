const { translator } = require("./i18n");

// E-mail bodies.
//
// O idioma vem do DESTINATÁRIO, não de quem disparou: quem lê o e-mail é a
// pessoa que o recebe. Cada função recebe `lang` — o campo gravado na conta
// dela — e cai em pt-BR quando ela nunca escolheu um idioma.
//
// Inline styles only, and a table-free single-column layout: e-mail clients
// strip <style> blocks and support for modern CSS is unreliable.
// ── A MARCA DA CASA, e não uma cor cravada ───────────────────────────────
//
// O e-mail era lima sobre grafite: as cores do ShapeApp, que a marca foi por um
// dia em 24/08/2026. Ficaram aqui depois que ela voltou — e-mail não tem
// variável de CSS, então cada cor precisa ser escrita, e escrever é esquecer.
//
// Agora ele recebe a marca de QUEM ENVIA. Cada casa tem a sua (é o produto
// inteiro: o cliente escolhe cor e logo), e um e-mail que chega com a cor de
// outra pessoa denuncia que o sistema é alugado.
//
// `scale(brand)` é a MESMA função que pinta o botão do produto e o do site — o
// botão do e-mail e o botão da tela são o mesmo pixel, sem ninguém combinar.
const theme = require("./theme.js");
const {
  faixaDoTopo,
  tiraDoFundo,
  ALTURA: ALTURA_FAIXA,
  LARGURA: LARGURA_FAIXA,
} = require("./auroraDoEmail.js");

// A logo padrão, para a casa que não subiu a dela.
//
// URL pública e absoluta, e não `data:` URI: cliente de e-mail bloqueia imagem
// embutida com mais frequência do que imagem hospedada, e um `data:` de 260 kB
// engorda toda mensagem. O endereço é o do site, servido pela Cloudflare.
const LOGO_PADRAO = "https://vafit.app/logo.png";

// A altura do wordmark no e-mail. Em pontos e no atributo `height`, não só no
// CSS: o Outlook ignora `style` em `<img>` e desenha a imagem no tamanho
// original — 1214 px de largura estourando a caixa.
const ALTURA_LOGO = 34;

function marca(tema) {
  const t = theme.sanitize(tema);
  const escala = theme.scale(t.brand);

  return {
    // 600 no botão e 700 no texto: a mesma dupla que o produto usa. O 600 tem
    // contraste suficiente com o branco do texto do botão em qualquer marca que
    // a paleta gere.
    botao: escala[600] || t.brand,
    texto: escala[700] || t.brand,
    logo: t.logo || LOGO_PADRAO,
  };
}

function layout({ lang, title, body, buttonLabel, buttonUrl, footer, fallbackLabel, tema, faixa, tira }) {
  const m = marca(tema);

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <!-- ── O MODO ESCURO ESTAVA QUEBRANDO O CABEÇALHO ────────────────────────

       Sem esta declaração, o cliente de e-mail assume que a mensagem só sabe
       viver no claro e INVERTE as cores por conta própria. O estrago aparecia no
       topo: a faixa é uma imagem e imagem não se inverte, mas o marinho da linha
       da logo, logo abaixo dela, virava quase branco. Um degrau no meio do
       cabeçalho, e o texto branco do botão escurecendo junto.

       As duas metas dizem a mesma coisa para gerações diferentes de cliente:
       "esta mensagem cuida das próprias cores nos dois modos". O Apple Mail e o
       Outlook.com param de inverter aqui.

       O aplicativo do Gmail inverte assim mesmo, e é por isso que o fundo escuro
       do topo também vai como IMAGEM (ver tiraDoFundo): o que ele não inverte
       é justamente imagem.

       Falta aqui o bloco de style com ":root { color-scheme }" que a
       documentação costuma sugerir junto, e a ausência é decisão: este arquivo
       não usa style block nenhum porque cliente de e-mail os apaga (há um teste
       que reprova o primeiro que aparecer). As metas carregam o mesmo recado, e
       para quem as ignora a defesa é a imagem. -->
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <!-- TABELA, e não div com flex: Outlook não implementa nem flex nem grid, e a
       mensagem sairia com tudo empilhado à esquerda. -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;">

          <!-- ── O TOPO: A MESMA AURORA DA ENTRADA DO APP ──────────────────
               É ele que faz o e-mail ser reconhecido antes de ser lido. Era uma
               tarja chapada na cor da marca; virou o fundo escuro com brilhos da
               tela de entrada, a pedido do Marlon em 29/08/2026.

               São DUAS LINHAS, e não uma com imagem de fundo, porque background
               em e-mail LADRILHA em vez de escalar, e o Outlook só o desenha com
               VML. Aqui a faixa é um <img> comum — que todo cliente sabe
               desenhar e escalar — e a logo mora numa linha de bgcolor sólido
               logo abaixo. A imagem termina em marinho puro por construção (ver
               o desvanecer em lib/auroraDoEmail.js), então a junção não existe
               para o olho.

               O bgcolor na linha da IMAGEM também: com as imagens bloqueadas —
               que é o padrão do Outlook e de muita conta de Gmail — o topo
               continua escuro em vez de virar um retângulo branco. -->
          <tr>
            <td background="cid:${tira.cid}" bgcolor="#081025" style="background-color:#081025;background-image:url(cid:${tira.cid});font-size:0;line-height:0;">
              <img src="cid:${faixa.cid}" alt="" width="${LARGURA_FAIXA}" height="${ALTURA_FAIXA}" style="display:block;width:100%;max-width:${LARGURA_FAIXA}px;height:auto;border:0;" />
            </td>
          </tr>
          <tr>
            <td align="center" background="cid:${tira.cid}" bgcolor="#081025" style="background-color:#081025;background-image:url(cid:${tira.cid});padding:0 24px 24px;">
              <img src="${m.logo}" alt="" height="${ALTURA_LOGO}" style="height:${ALTURA_LOGO}px;width:auto;display:block;border:0;" />
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 12px;font-size:19px;line-height:1.35;color:#0f172a;font-weight:700;">${title}</h1>

              <div style="font-size:15px;line-height:1.65;color:#475569;">${body}</div>

              ${
                buttonUrl
                  ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0;">
                       <tr>
                         <td align="center" style="border-radius:10px;background:${m.botao};">
                           <a href="${buttonUrl}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;">${buttonLabel}</a>
                         </td>
                       </tr>
                     </table>
                     <p style="font-size:12px;color:#94a3b8;line-height:1.55;margin:0;">
                       ${fallbackLabel}<br>
                       <a href="${buttonUrl}" style="color:${m.texto};word-break:break-all;">${buttonUrl}</a>
                     </p>`
                  : ""
              }

              ${
                footer
                  ? `<p style="margin:26px 0 0;padding-top:18px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;line-height:1.55;">${footer}</p>`
                  : ""
              }
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Só o primeiro nome, como quem chama alguém. Sem nome nenhum, o cumprimento do
// idioma ("Olá", "Hello") entra no lugar — a frase é montada como "{nome}, ..."
// e não pode começar com vírgula.
function firstNameOf(name, t) {
  return String(name || "").split(" ")[0] || t("email.greeting");
}

// Um e-mail montado a partir de um bloco de chaves: os três têm exatamente a
// mesma forma (subject, title, body, button, footer, text), então a montagem é
// uma só e o que muda é o prefixo e as variáveis.
// ── O QUE VEM DE FORA ENTRA COMO TEXTO, NUNCA COMO HTML (16/11/2026) ─────
//
// A tradução NÃO escapa a interpolação (`<b>x</b>` passava cru), e as
// variáveis daqui são dados de gente: o nome de quem marcou pela página
// pública, o WhatsApp de quem se matriculou pela vitrine. Um anônimo que
// escrevesse `<a href="…">Pague aqui</a>` no próprio nome punha um link dentro
// do e-mail que a academia recebe, com a cor e a logo dela — phishing com a
// assinatura da casa.
//
// Nenhuma variável é HTML de propósito (conferido bloco a bloco: são nomes,
// planos, valores, datas, contatos). Então o título, o corpo, o rodapé e o
// botão recebem tudo escapado; o assunto e a versão em texto puro, não — lá
// `&amp;` apareceria escrito.
function escaparHtml(valor) {
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paraHtml(vars) {
  return Object.fromEntries(
    Object.entries(vars).map(([k, x]) => [k, typeof x === "string" ? escaparHtml(x) : x])
  );
}

function build(bloco, lang, vars, tema) {
  const t = translator(lang);
  const v = { ...vars, name: firstNameOf(vars.name, t) };
  const vHtml = paraHtml(v);
  // `k` para o que é TEXTO (assunto, versão sem HTML); `h` para o que vira HTML.
  const k = (nome) => t(`email.${bloco}.${nome}`, v);
  const h = (nome) => t(`email.${bloco}.${nome}`, vHtml);

  // A faixa do topo, desenhada na cor desta casa. Vai como anexo EMBUTIDO
  // (`cid:`) e não como `data:` URI, pela mesma razão das fotos do documento: o
  // Gmail descarta `<img src="data:…">`.
  const faixa = faixaDoTopo(tema);
  // A tira é uma cor sólida de um pixel de altura, ladrilhada. Ela existe só
  // para o modo escuro do Gmail, que inverte cor declarada e não inverte imagem.
  const tira = tiraDoFundo();

  return {
    subject: k("subject"),
    html: layout({
      lang: t.lang,
      title: h("title"),
      body: h("body"),
      buttonLabel: h("button"),
      // O endereço entra num `href="…"`: aspas e `&` precisam do escape também.
      buttonUrl: vars.url ? escaparHtml(vars.url) : vars.url,
      footer: h("footer"),
      fallbackLabel: t("email.fallbackLink"),
      tema,
      faixa,
      tira,
    }),
    text: k("text"),
    // `mailer.send` recebe isto por espalhamento no chamador. Quem já mandava
    // anexos (o PDF do documento) precisa CONCATENAR, não sobrescrever.
    attachments: [faixa, tira].map((a) => ({
      filename: a.filename,
      content: a.conteudo,
      contentType: a.contentType,
      cid: a.cid,
    })),
  };
}

// Password reset. The link carries the token; the e-mail never carries a
// password.
function passwordReset({ lang, name, url, minutes, tema }) {
  return build("reset", lang, { name, url, minutes }, tema);
}

// O convite para a pessoa responder a própria anamnese.
//
// Leva o NOME DO PROFISSIONAL no corpo, e isso não é cortesia: um e-mail pedindo
// histórico de saúde tem de dizer quem está pedindo, senão é indistinguível de
// golpe — e a pessoa certa é justamente a que não vai clicar.
function anamnesisInvite({ lang, name, professional, url, days, tema }) {
  return build("anamnesis", lang, { name, professional, url, days }, tema);
}

// A EXCLUSÃO DA CONTA FOI SOLICITADA.
//
// Este é o único e-mail do sistema que a pessoa pode receber sem ter pedido —
// não por engano nosso, mas porque é exatamente para o caso de NÃO ter sido ela:
// alguém que entrou na conta e pediu para apagar tudo. Sem este aviso, a
// primeira notícia seria uma ligação perguntando por que ela quer sair.
//
// Não leva DATA, e essa é a diferença em relação à versão de agendamento: não
// existe data. Existe um pedido na fila e uma conversa por vir — dizer "será
// apagada em tal dia" seria prometer o que ninguém prometeu.
//
// O botão leva para a tela de onde o pedido saiu, que é também de onde se desiste.
function exclusaoPedida({ lang, name, url, tema }) {
  return build("deletion", lang, { name, url }, tema);
}

// ── ALGUÉM MARCOU NA SUA AGENDA ───────────────────────────────────────────
//
// "quando alguém fizer agendamento, envie uma notificação pelo app se der, e um
// e-mail bem bonito para o dono ou pessoa do calendário."
//
// Quem recebe é QUEM ATENDE, e é o único e-mail do sistema nessa direção: todos
// os outros vão para o aluno. A diferença muda o texto — aqui não se explica o
// que é o VAFIT nem se pede ação; diz-se o que entrou na agenda e pronto.
//
// ── Por que ele importa mais que os outros ───────────────────────────────
//
// A página pública é a única porta em que alguém marca SEM o profissional estar
// na frente. Sem este aviso, a primeira notícia de um compromisso das 08:00 é
// abrir a agenda de manhã — ou a pessoa batendo na porta.
//
// ── O que vai no corpo, e o que não vai ──────────────────────────────────
//
// Vão as quatro coisas que decidem o dia: quem, o quê, quando e o contato. NÃO
// vai o que o cliente escreveu na observação: ela pode ter dado de saúde, e
// e-mail não é lugar para isso — fica na ficha, atrás de login.
function bookingReceived({ lang, name, person, service, when, contact, url, tema }) {
  return build("booking", lang, { name, person, service, when, contact, url }, tema);
}

// ── O COMPROMISSO MARCADO: AS DUAS CONFIRMAÇÕES ───────────────────────────
//
// *"assim que eu marcar, envie um e-mail de confirmação para a pessoa e também
// para o profissional"* (16/11/2026).
//
// Dois blocos, e não um com dois destinos, pela mesma razão da matrícula: para
// a PESSOA é "seu horário está garantido, e é aqui"; para QUEM ATENDE é uma
// linha de trabalho — quem vem, o contato dela, e o caminho para a agenda.
//
// O que NÃO vai, nos dois: a observação do compromisso. Ela pode ter dado de
// saúde ("dor no joelho"), e e-mail não é lugar disso — fica na agenda, atrás de
// login. É a mesma regra do aviso da página pública.
//
// `url` da pessoa é opcional: só vai botão quando ela TEM acesso ao app. Um
// "abrir o app" para quem não tem senha é um botão que leva a uma porta
// trancada.
function appointmentForPerson({ lang, name, professional, what, when, duration, place, url, tema }) {
  return build(
    url ? "appointmentPerson" : "appointmentPersonNoApp",
    lang,
    { name, professional, what, when, duration, place, url },
    tema
  );
}

function appointmentForProfessional({ lang, name, person, what, when, duration, contact, url, tema }) {
  return build("appointmentProfessional", lang, { name, person, what, when, duration, contact, url }, tema);
}

// ── OS DOIS AVISOS DE UMA MATRÍCULA PELA VITRINE ────────────────────────
//
// *"envie e-mail para quem se cadastrou agradecendo etc... e também e-mail
// para a unidade com os dados"* (14/10/2026).
//
// São DOIS blocos e não um com dois destinos, porque dizem coisas opostas:
// um agradece e tranquiliza, o outro é uma ficha de trabalho. O mesmo texto
// servindo aos dois seria frio para a pessoa e inútil para a recepção.
//
// E o IDIOMA é de quem LÊ: o aluno recebe no idioma do navegador dele, a
// unidade no da casa. É a mesma regra dos outros e-mails daqui.
// ── O MESMO E-MAIL, DUAS VERSÕES, E A DIFERENÇA É UMA SÓ ─────────────────
//
// Quando a cobrança nasceu no gateway, o botão deste e-mail deixa de ser
// "falar com a academia" e passa a ser "pagar". É o link que salva quem fechou
// a aba antes de pagar — sem ele, a academia recebe o telefonema no dia
// seguinte perguntando como paga.
//
// Dois blocos de tradução em vez de um `if` no texto: o corpo inteiro muda de
// assunto ("a academia vai falar com você" × "pague até o dia tal"), e um
// parágrafo condicional dentro de uma frase traduzida é o que faz tradução
// ficar errada em três idiomas de uma vez.
function planWelcome({ lang, name, plano, unidade, valor, url, pagamento, tema }) {
  if (pagamento?.url) {
    return build(
      "planWelcomePay",
      lang,
      { name, plano, unidade, valor, url: pagamento.url, vencimento: pagamento.vencimento || "" },
      tema
    );
  }

  return build("planWelcome", lang, { name, plano, unidade, valor, url }, tema);
}

// ── O LINK DE PAGAMENTO, MANDADO À MÃO ──────────────────────────────────
//
// *"botão de enviar pro e-mail"* (18/10/2026). O gateway manda o dele; este é
// o nosso, disparado quando alguém pede — o aluno que apagou, o que diz que
// não chegou, o que pediu segunda via em março.
//
// Ele NÃO repete o texto da matrícula: aqui não se está vendendo nada, só
// entregando um link que já existe.
function chargeLink({ lang, name, casa, valor, descricao, vencimento, url, tema }) {
  return build(
    "chargeLink",
    lang,
    // A descrição entra como um pedaço de frase (" — Mensalidade de agosto")
    // e não como um parágrafo próprio: cobrança sem descrição é comum, e um
    // parágrafo vazio no meio do e-mail parece defeito.
    { name, casa, valor, descricao: descricao ? ` — ${descricao}` : "", vencimento, url },
    tema
  );
}

function planSignupToUnit({ lang, name, person, plano, unidade, valor, cpf, whatsapp, contact, url, tema }) {
  return build(
    "planUnit",
    lang,
    { name, person, plano, unidade, valor, cpf, whatsapp, contact, url },
    tema
  );
}

// Sent when a trainer grants a student access to the app.
module.exports = {
  passwordReset,
  anamnesisInvite,
  exclusaoPedida,
  bookingReceived,
  appointmentForPerson,
  appointmentForProfessional,
  planWelcome,
  planSignupToUnit,
  chargeLink,
};
