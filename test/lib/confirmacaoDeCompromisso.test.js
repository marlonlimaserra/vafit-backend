const test = require("node:test");
const assert = require("node:assert/strict");

const instanceContext = require("../../lib/instance.js");
const { confirmarCompromisso } = require("../../lib/confirmacaoDeCompromisso.js");
const { eventoIcs, dobrar } = require("../../lib/ics.js");

// A CONFIRMAÇÃO DE UM COMPROMISSO MARCADO.
//
// *"assim que eu marcar, envie um e-mail de confirmação para a pessoa e também
// para o profissional"* (16/11/2026).
//
// O que erra calado aqui:
//   - a HORA: o e-mail com "11:00" para quem marcou 08:00 (UTC no lugar do fuso
//     do estúdio) é pior que e-mail nenhum;
//   - a PREFERÊNCIA: quem desligou o assunto não pode continuar recebendo;
//   - a OBSERVAÇÃO: ela pode ter dado de saúde e não vai para e-mail nenhum;
//   - a FALHA: um SMTP fora não pode virar erro de quem marcou.

const PESSOA = {
  _id: "p1",
  name: "Rafael Tibúrcio",
  email: "rafael@exemplo.test",
  phone: "(31) 99622-1180",
  password: "hash",
  unit: "u1",
};
const PROF = { _id: "t1", name: "Marlon Lima", email: "marlon@exemplo.test", lang: "pt-BR" };

const COMPROMISSO = {
  _id: "a1",
  trainer: "t1",
  student: "p1",
  // 18/11/2026 às 08:00 em São Paulo.
  date: new Date("2026-11-18T11:00:00.000Z"),
  minutes: 50,
  title: "Treino de perna",
  note: "Dor no joelho esquerdo — pegar leve",
};

function monta({ pessoa = PESSOA, prof = PROF, falhaNoEnvio = false } = {}) {
  const enviados = [];
  const app = {
    api: {
      user: {
        async data(id) {
          return String(id) === "p1" ? pessoa : String(id) === "t1" ? prof : undefined;
        },
      },
      tenant: {
        async dataOfInstance() {
          return { name: "Studio Marlon", theme: {} };
        },
        async timezoneOfInstance() {
          return "America/Sao_Paulo";
        },
      },
      service: {
        async data() {
          return null;
        },
      },
      unit: {
        async data() {
          return { name: "Niterói", endereco: "Rua da Praia, 10 - Icaraí, Niterói - RJ" };
        },
      },
      center: {
        async byInstance() {
          return { hosts: ["marlon.vafit.app"] };
        },
      },
    },
    helpers: {
      mailer: {
        async send(m) {
          if (falhaNoEnvio) throw new Error("SMTP fora");
          enviados.push(m);
        },
      },
    },
  };
  return { app, enviados };
}

const confirmar = (app, c = COMPROMISSO) =>
  instanceContext.run("marlon", () => confirmarCompromisso(app, c));

test("vão DOIS e-mails: um para a pessoa, um para quem atende", async () => {
  const { app, enviados } = monta();
  const r = await confirmar(app);

  assert.equal(r.enviados, 2);
  assert.deepEqual(
    enviados.map((m) => m.to),
    ["rafael@exemplo.test", "marlon@exemplo.test"]
  );
});

test("a hora é a do ESTÚDIO — 08:00, não as 11:00 do UTC", async () => {
  const { app, enviados } = monta();
  await confirmar(app);

  for (const m of enviados) {
    assert.match(m.html, /08:00/);
    assert.doesNotMatch(m.html, /11:00/);
  }
  assert.match(enviados[0].subject, /18 de novembro de 2026/);
});

test("a pessoa lê com quem, o quê, quanto tempo e onde (com o endereço da unidade)", async () => {
  const { app, enviados } = monta();
  await confirmar(app);
  const paraPessoa = enviados[0];

  assert.match(paraPessoa.html, /Treino de perna/);
  assert.match(paraPessoa.html, /Marlon Lima/);
  assert.match(paraPessoa.html, /50 min/);
  assert.match(paraPessoa.html, /Studio Marlon — Niterói — Rua da Praia/);
});

test("quem atende recebe o contato da pessoa e o caminho da agenda", async () => {
  const { app, enviados } = monta();
  await confirmar(app);
  const paraProf = enviados[1];

  assert.match(paraProf.html, /Rafael Tibúrcio/);
  assert.match(paraProf.html, /\(31\) 99622-1180 · rafael@exemplo\.test/);
  assert.match(paraProf.html, /https:\/\/marlon\.vafit\.app\/agenda/);
});

test("a OBSERVAÇÃO não vai para e-mail nenhum — pode ter dado de saúde", async () => {
  const { app, enviados } = monta();
  await confirmar(app);

  for (const m of enviados) {
    assert.doesNotMatch(m.html, /joelho/);
    assert.doesNotMatch(m.text, /joelho/);
    const ics = m.attachments.find((a) => a.filename.endsWith(".ics"));
    assert.doesNotMatch(ics.content, /joelho/);
  }
});

test("cada um leva o .ics, com o MESMO uid — um calendário dividido mostra uma vez", async () => {
  const { app, enviados } = monta();
  await confirmar(app);

  const uids = enviados.map((m) => {
    const ics = m.attachments.find((a) => a.filename.endsWith(".ics"));
    assert.match(ics.contentType, /text\/calendar/);
    assert.match(ics.content, /DTSTART:20261118T110000Z/);
    assert.match(ics.content, /DTEND:20261118T115000Z/);
    return ics.content.match(/UID:(.+)\r\n/)[1];
  });
  assert.equal(uids[0], uids[1]);
});

test("sem acesso ao app, a pessoa não ganha um botão para uma porta trancada", async () => {
  const comAcesso = monta();
  await confirmar(comAcesso.app);
  assert.match(comAcesso.enviados[0].html, /Ver no app/);

  const semAcesso = monta({ pessoa: { ...PESSOA, password: undefined } });
  await confirmar(semAcesso.app);
  assert.doesNotMatch(semAcesso.enviados[0].html, /Ver no app/);
  assert.doesNotMatch(semAcesso.enviados[0].text, /undefined/);
});

test("quem desligou o assunto não recebe — cada um pela SUA chave", async () => {
  const pessoaDesligou = monta({
    pessoa: { ...PESSOA, preferences: { notify: { appointment: false } } },
  });
  await confirmar(pessoaDesligou.app);
  assert.deepEqual(pessoaDesligou.enviados.map((m) => m.to), ["marlon@exemplo.test"]);

  const profDesligou = monta({ prof: { ...PROF, preferences: { notify: { booking: false } } } });
  await confirmar(profDesligou.app);
  assert.deepEqual(profDesligou.enviados.map((m) => m.to), ["rafael@exemplo.test"]);
});

test("sem e-mail cadastrado, simplesmente não vai — sem erro", async () => {
  const { app, enviados } = monta({ pessoa: { ...PESSOA, email: "" } });
  const r = await confirmar(app);
  assert.equal(r.enviados, 1);
  assert.deepEqual(enviados.map((m) => m.to), ["marlon@exemplo.test"]);
});

test("a pessoa É o profissional (mesmo e-mail): um e-mail só", async () => {
  const { app, enviados } = monta({ pessoa: { ...PESSOA, email: "MARLON@exemplo.test" } });
  await confirmar(app);
  assert.equal(enviados.length, 1);
});

test("SMTP fora não estoura — a marcação já está gravada", async () => {
  const { app } = monta({ falhaNoEnvio: true });
  const erros = [];
  const original = console.error;
  console.error = (...a) => erros.push(a.join(" "));
  try {
    const r = await confirmar(app);
    assert.equal(r.enviados, 0);
  } finally {
    console.error = original;
  }
  assert.ok(erros.some((e) => /não saiu/.test(e)));
});

test("nome com HTML chega como texto no e-mail de quem atende", async () => {
  const { app, enviados } = monta({
    pessoa: { ...PESSOA, name: '<a href="https://golpe.test">Pague</a>' },
  });
  await confirmar(app);
  assert.ok(!enviados[1].html.includes('<a href="https://golpe.test">'));
});

// ── O .ics ──────────────────────────────────────────────────────────────────

test("o .ics escapa vírgula, ponto e vírgula e quebra de linha, com CRLF", () => {
  const ics = eventoIcs({
    uid: "a1@marlon.vafit.app",
    inicio: new Date("2026-11-18T11:00:00Z"),
    fim: new Date("2026-11-18T12:00:00Z"),
    titulo: "Treino; perna, glúteo",
    local: "Rua A, 10\nNiterói",
    agora: new Date("2026-11-16T12:00:00Z"),
  });

  assert.match(ics, /SUMMARY:Treino\\; perna\\, glúteo\r\n/);
  assert.match(ics, /LOCATION:Rua A\\, 10\\nNiterói\r\n/);
  assert.match(ics, /METHOD:PUBLISH\r\n/);
  assert.ok(!/[^\r]\n/.test(ics), "toda quebra de linha é CRLF");
});

test("linha longa é dobrada em 75 BYTES, sem partir letra acentuada", () => {
  const longa = "SUMMARY:" + "ção ".repeat(40);
  const dobrada = dobrar(longa);
  for (const linha of dobrada.split("\r\n")) {
    assert.ok(Buffer.byteLength(linha, "utf8") <= 75, linha);
  }
  // Desdobrar devolve o original, letra por letra.
  assert.equal(dobrada.replace(/\r\n /g, ""), longa);
});
