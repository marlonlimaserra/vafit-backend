// UM EVENTO DE CALENDÁRIO (.ics) — o anexo que vira "Adicionar à agenda".
//
// Vai junto com a confirmação do compromisso: o Gmail, o Outlook e o Calendário
// da Apple reconhecem `text/calendar` e mostram o cartão do evento com o botão
// de salvar. É o que faz o horário chegar na agenda do celular da pessoa sem
// ela redigitar nada — e o lembrete do próprio celular é melhor que qualquer
// lembrete nosso.
//
// METHOD:PUBLISH, e não REQUEST: REQUEST é CONVITE, e o cliente de e-mail
// pergunta "vai comparecer?" e tenta responder ao organizador. Aqui não há o
// que responder: o horário já foi combinado.
//
// RFC 5545 nas três coisas que quebram calado:
//   - fim de linha CRLF (alguns leitores rejeitam LF sozinho);
//   - escape de `\`, `;`, `,` e quebra de linha no texto;
//   - linha dobrada em 75 octetos — em BYTES de UTF-8, não em caracteres: um
//     "ç" ocupa dois, e cortar no meio dele estraga a letra.

function escaparTexto(valor) {
  return String(valor ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// 2026-11-18T11:00:00.000Z → 20261118T110000Z
function emUtc(data) {
  return new Date(data).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function dobrar(linha) {
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  if (bytes(linha) <= 75) return linha;

  const partes = [];
  let atual = "";
  let limite = 75;
  for (const ch of linha) {
    if (bytes(atual + ch) > limite) {
      partes.push(atual);
      atual = ch;
      // As continuações começam com um espaço, que conta no limite.
      limite = 74;
    } else {
      atual += ch;
    }
  }
  partes.push(atual);
  return partes.join("\r\n ");
}

function eventoIcs({ uid, inicio, fim, titulo, descricao, local, agora = new Date() }) {
  const linhas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//VAFIT//Agenda//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escaparTexto(uid)}`,
    `DTSTAMP:${emUtc(agora)}`,
    `DTSTART:${emUtc(inicio)}`,
    `DTEND:${emUtc(fim)}`,
    `SUMMARY:${escaparTexto(titulo)}`,
    ...(descricao ? [`DESCRIPTION:${escaparTexto(descricao)}`] : []),
    ...(local ? [`LOCATION:${escaparTexto(local)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return linhas.map(dobrar).join("\r\n") + "\r\n";
}

// O anexo pronto para o `mailer.send`.
function anexoIcs(evento, nome = "compromisso.ics") {
  return {
    filename: nome,
    content: eventoIcs(evento),
    contentType: "text/calendar; charset=utf-8; method=PUBLISH",
  };
}

module.exports = { eventoIcs, anexoIcs, escaparTexto, dobrar };
