const { translator } = require("./i18n");
const { appointmentForPerson, appointmentForProfessional } = require("./emailTemplates.js");
const { enderecoDaInstancia } = require("./enderecoDaInstancia.js");
const { anexoIcs } = require("./ics.js");
const notificacoes = require("./notificacoes.js");

// A CONFIRMAÇÃO DE UM COMPROMISSO MARCADO — e-mail para a pessoa e para quem
// atende.
//
// *"assim que eu marcar, envie um e-mail de confirmação para a pessoa e também
// para o profissional"* (16/11/2026).
//
// ── MELHOR ESFORÇO, E NUNCA NO CAMINHO DA RESPOSTA ────────────────────────
//
// O compromisso já está gravado quando isto roda. Um e-mail que não saiu —
// SMTP fora, endereço inválido — não pode desfazer a marcação nem atrasar a
// tela: quem chama não espera (`confirmarSemEsperar`), e todo erro morre aqui
// dentro, num log. É a mesma escolha do aviso da página pública.
//
// ── QUEM RECEBE, E QUANDO NÃO ─────────────────────────────────────────────
//
// - A pessoa: se tem e-mail e não desligou "Compromisso marcado com você"
//   (`appointment` nas preferências).
// - Quem atende: se tem e-mail e não desligou "Marcaram na sua agenda"
//   (`booking`) — é o MESMO assunto do aviso da página pública, porque para ele
//   é a mesma notícia.
// - Os dois o mesmo endereço (a pessoa É o profissional, num teste): um só.
//
// ── O IDIOMA E A HORA SÃO DE QUEM LÊ ──────────────────────────────────────
//
// O idioma é o da conta de quem recebe (cai no de quem atende, depois pt-BR).
// A hora é a do relógio do ESTÚDIO: o instante gravado é UTC, e mandar "11:00"
// para quem marcou 08:00 seria pior que não confirmar.

function quandoPorExtenso(inicio, lang, fuso) {
  try {
    return new Intl.DateTimeFormat(lang || "pt-BR", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: fuso,
    }).format(inicio);
  } catch {
    // Fuso inválido gravado na conta: melhor a hora em UTC que nenhum e-mail.
    return new Intl.DateTimeFormat(lang || "pt-BR", { dateStyle: "full", timeStyle: "short" }).format(
      inicio
    );
  }
}

// Onde: a casa e, se a pessoa é de uma unidade, a unidade com o endereço — é o
// que faz o "como chegar" do calendário do celular funcionar.
async function ondeDe(app, casa, pessoa) {
  const partes = [casa?.name].filter(Boolean);
  if (pessoa?.unit && app.api.unit?.data) {
    const unidade = await app.api.unit.data(pessoa.unit).catch(() => null);
    if (unidade?.name) partes.push(unidade.name);
    if (unidade?.endereco) partes.push(unidade.endereco);
  }
  return partes.join(" — ");
}

// Tem acesso ao app? Só então a confirmação ganha o botão "Ver no app".
function temAcesso(pessoa) {
  return Boolean(pessoa?.password) && pessoa?.appBloqueado !== true && pessoa?.active !== 0;
}

async function confirmarCompromisso(app, compromisso) {
  if (!compromisso?._id) return { enviados: 0 };

  try {
    const [pessoa, prof, casa, fuso] = await Promise.all([
      app.api.user.data(compromisso.student),
      app.api.user.data(compromisso.trainer),
      app.api.tenant.dataOfInstance().catch(() => null),
      app.api.tenant.timezoneOfInstance().catch(() => undefined),
    ]);

    const servico = compromisso.service
      ? await app.api.service.data(compromisso.service).catch(() => null)
      : null;

    const inicio = new Date(compromisso.date);
    const minutos = compromisso.minutes || 60;
    const fim = new Date(inicio.getTime() + minutos * 60000);
    const duracao = `${minutos} min`;
    const base = await enderecoDaInstancia(app);
    const onde = await ondeDe(app, casa, pessoa);
    const tema = casa?.theme;

    // O MESMO evento para os dois, com o MESMO uid: se a pessoa e o
    // profissional dividirem um calendário, ele aparece uma vez, não duas.
    const uid = `${compromisso._id}@${String(base).replace(/^https?:\/\//, "")}`;

    const envios = [];
    const avisados = new Set();

    if (pessoa?.email && notificacoes.querReceber(pessoa, "appointment")) {
      const lang = pessoa.lang || prof?.lang || "pt-BR";
      const t = translator(lang);
      const oQue = compromisso.title || servico?.name || t("email.appointmentDefaultWhat");
      const comQuem = prof?.name || casa?.name || "—";

      const mail = appointmentForPerson({
        lang,
        name: pessoa.name,
        professional: comQuem,
        what: oQue,
        when: quandoPorExtenso(inicio, lang, fuso),
        duration: duracao,
        place: onde || "—",
        url: temAcesso(pessoa) ? base : undefined,
        tema,
      });

      envios.push(
        app.helpers.mailer.send({
          to: pessoa.email,
          ...mail,
          attachments: [
            ...(mail.attachments || []),
            anexoIcs({ uid, inicio, fim, titulo: `${oQue} — ${comQuem}`, local: onde }),
          ],
        })
      );
      avisados.add(String(pessoa.email).toLowerCase());
    }

    if (
      prof?.email &&
      !avisados.has(String(prof.email).toLowerCase()) &&
      notificacoes.querReceber(prof, "booking")
    ) {
      const lang = prof.lang || "pt-BR";
      const t = translator(lang);
      const oQue = compromisso.title || servico?.name || t("email.appointmentDefaultWhat");
      const nome = pessoa?.name || "—";

      const mail = appointmentForProfessional({
        lang,
        name: prof.name,
        person: nome,
        what: oQue,
        when: quandoPorExtenso(inicio, lang, fuso),
        duration: duracao,
        contact: [pessoa?.phone, pessoa?.email].filter(Boolean).join(" · ") || "—",
        url: `${base}/agenda`,
        tema,
      });

      envios.push(
        app.helpers.mailer.send({
          to: prof.email,
          ...mail,
          attachments: [
            ...(mail.attachments || []),
            anexoIcs({ uid, inicio, fim, titulo: `${oQue} — ${nome}`, local: onde }),
          ],
        })
      );
    }

    const resultados = await Promise.allSettled(envios);
    for (const r of resultados) {
      if (r.status === "rejected") {
        console.error("[compromisso] uma confirmação não saiu:", r.reason?.message);
      }
    }
    return { enviados: resultados.filter((r) => r.status === "fulfilled").length };
  } catch (erro) {
    console.error("[compromisso] a confirmação não saiu:", erro?.message);
    return { enviados: 0 };
  }
}

// Para a rota: dispara e segue. A resposta da tela não espera o SMTP.
function confirmarSemEsperar(app, compromisso) {
  confirmarCompromisso(app, compromisso).catch(() => {});
}

module.exports = { confirmarCompromisso, confirmarSemEsperar, quandoPorExtenso, temAcesso };
