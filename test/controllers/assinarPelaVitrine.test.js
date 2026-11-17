const test = require("node:test");
const assert = require("node:assert/strict");

const { fakeApp, call } = require("../helpers/harness.js");
const MembershipController = require("../../controllers/Membership.js");
const rateLimit = require("../../lib/rateLimit.js");

// O limite é POR IP e vale uma hora — a contagem é global ao processo, então
// sem isto o vigésimo primeiro caso deste arquivo levaria 429. Que é, aliás, a
// prova de que o limite funciona: ele pegou os próprios testes.
test.beforeEach(() => rateLimit.reset());

// ASSINAR UM PLANO PELA VITRINE — a rota que não tem sessão.
//
// *"quando clicarem 'quero este plano', deveria abrir a tela de login para o
// cliente criar o cadastro; ele informa o CPF e o sistema já vê se existe; se
// existir, usar o que já existe, se não abre uma telinha de cadastro"*
// (14/10/2026).
//
// ── O QUE ESTE ARQUIVO SEGURA ─────────────────────────────────────────────
//
// 1. QUE A BUSCA NÃO VIRE UM VARREDOR. "Digite um CPF e eu digo se é aluno
//    daqui" é literalmente o que esta rota faz, sem sessão, para qualquer um.
//    O limite por IP é contado ANTES de qualquer consulta — contar depois
//    deixaria a pergunta ser respondida antes de a conta fechar.
//
// 2. QUE UM DÍGITO TROCADO NÃO VIRE PESSOA NOVA. Sem os verificadores,
//    "11144477736" cadastraria um segundo aluno que ninguém acha depois.
//
// 3. QUE NÃO SE ASSINE DUAS VEZES. A pessoa clica, não vê resposta, clica de
//    novo — e a academia ganha duas mensalidades do mesmo plano.
//
// 4. QUE O LINK PRÓPRIO VENÇA. Decisão dele: quem montou um checkout continua
//    indo para lá, e esta rota recusa em vez de matricular por baixo.

const CPF_BOM = "11144477735";
const CPF_RUIM = "11144477736";

const PLANO = {
  // O plano é o CARDÁPIO DA CASA e não guarda autor — de propósito. O dono do
  // aluno vem do profissional mais antigo; ver a nota no controlador.
  _id: "m1",
  name: "Plano Fit",
  amount: 2000,
  cadencia: "mensal",
  currency: "BRL",
  active: true,
  botaoLink: "",
};

function monta({ plano = PLANO, pessoa = undefined, recorrencias = [], colide = false, semDono = false, unidadeSemEmail = false, correioQuebrado = false, cobranca } = {}) {
  const criados = [];
  const assinaturas = [];
  const atualizados = [];
  const enviados = [];
  const vinculos = [];
  const novasRecorrencias = [];

  const app = fakeApp({
    api: {
      center: { async byHost() { return { instance: "marlon", active: true }; } },
      membership: { async data() { return plano; } },
      paymentMethod: { async listActive() { return []; } },
      tenant: {
        async dataOfInstance() {
          return { name: "Academia", email: "casa@x.com", lang: "pt-BR", theme: {} };
        },
      },
      unit: {
        async listActive() {
          return [
            {
              _id: "un1",
              name: "Niteroi",
              alias: "niteroi",
              email: unidadeSemEmail ? "" : "niteroi@x.com",
            },
          ];
        },
      },
      user: {
        async dataByCpf(valor) {
          // O dobro responde o que o modelo responde: só casa com os DÍGITOS.
          return pessoa && String(pessoa.customFields?.cpf) === String(valor) ? pessoa : undefined;
        },
        async profissionalMaisAntigo() {
          return semDono ? undefined : "dono1";
        },
        async dataByEmail(valor) {
          return pessoa && pessoa.email === valor ? pessoa : undefined;
        },
        async updateStudent(dono, id, obj) {
          atualizados.push({ id: String(id), ...obj });
          return true;
        },
        async insertStudent(dono, obj) {
          if (colide) {
            const erro = new Error("E11000");
            erro.code = 11000;
            throw erro;
          }
          criados.push({ dono, ...obj });
          return "p-nova";
        },
      },
      link: { async link(dono, p, origem) { vinculos.push({ dono, p, origem }); } },
      // O COBRADOR. Por padrão ele recusa: assim os testes que não falam de
      // gateway exercitam o caminho que a casa inteira usa hoje.
      cobrador: {
        async assinar(arg) {
          assinaturas.push(arg);
          return cobranca || { ok: false, erro: "sem_gateway" };
        },
      },
      recurrence: {
        async listOfStudent() { return recorrencias; },
        async insert(p, obj, dono, moeda) {
          novasRecorrencias.push({ pessoa: String(p), ...obj, dono, moeda });
          return "r1";
        },
      },
    },
    helpers: {
      ReqProtected: { async can() { return { _id: "u1" }; } },
      // O carteiro: guarda para quem foi, em vez de mandar.
      mailer: {
        async send(msg) {
          if (correioQuebrado) throw new Error("smtp fora do ar");
          enviados.push(msg);
          return true;
        },
      },
    },
  });

  MembershipController(app);
  return { app, criados, atualizados, vinculos, novasRecorrencias, enviados, assinaturas };
}

const assinar = (app, corpo) =>
  call(app, "post", "/public/memberships/m1/assinar", {
    query: { host: "x.vafit.app" },
    body: corpo,
  });

test("CPF com dígito trocado é recusado ANTES de qualquer consulta", async () => {
  const { app } = monta();
  const r = await assinar(app, { cpf: CPF_RUIM });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "cpf_invalido");
});

test("e os onze dígitos iguais também — eles fecham a conta dos verificadores", async () => {
  const { app } = monta();
  const r = await assinar(app, { cpf: "11111111111" });

  assert.equal(r.body.code, "cpf_invalido");
});

test("CPF novo pede o NOME num segundo passo, e não cadastra nada ainda", async () => {
  const { app, criados, novasRecorrencias } = monta();
  const r = await assinar(app, { cpf: CPF_BOM });

  assert.equal(r.status, 422);
  assert.equal(r.body.code, "precisa_do_nome");
  assert.deepEqual(criados, []);
  assert.deepEqual(novasRecorrencias, []);
});

test("com o nome, cadastra a pessoa com o CPF em DÍGITOS e matricula", async () => {
  const { app, criados, novasRecorrencias } = monta();
  const r = await assinar(app, {
    cpf: "111.444.777-35",
    firstName: "Ana",
    lastName: "Lima",
    email: "ana@x.com",
    telefone: "21999990000",
  });

  assert.equal(r.body.ok, true);
  assert.equal(r.body.jaEraAluno, false);
  // Guardado sem pontuação: com ela, o mesmo CPF digitado de outro jeito
  // viraria um segundo cadastro.
  assert.equal(criados[0].customFields.cpf, CPF_BOM);
  // Nome e sobrenome separados, como no resto do produto: é isto que a
  // academia procura e o que um dia vai no boleto.
  assert.equal(criados[0].firstName, "Ana");
  assert.equal(criados[0].lastName, "Lima");

  // O valor e a cadência são COPIADOS do plano agora: reajustar o cardápio
  // amanhã não reajusta quem assinou hoje.
  assert.equal(novasRecorrencias[0].amount, 2000);
  assert.equal(novasRecorrencias[0].cadencia, "mensal");
  assert.equal(String(novasRecorrencias[0].membership), "m1");
  // O NOME não é copiado: fica em branco, e quem nomeia cada cobrança é o
  // plano, pelo vínculo (*"descrição deveria ficar em branco"*, 15/10/2026).
  assert.equal(novasRecorrencias[0].description, "");
});

test("a tela de agradecimento recebe o PRIMEIRO NOME de quem acabou de entrar", async () => {
  // Sem isto ela dizia "Pronto, !": o cadastro manda as partes separadas, e
  // a resposta só olhava para o nome em linha única.
  const { app } = monta();

  const r = await assinar(app, {
    cpf: CPF_BOM,
    firstName: "Ana",
    lastName: "Lima",
    email: "ana@x.com",
  });

  assert.equal(r.body.nome, "Ana");
});

// ── OS DOIS AVISOS ──────────────────────────────────────────────────────
//
// *"envie e-mail para quem se cadastrou agradecendo etc... e também e-mail
// para a unidade com os dados"* (14/10/2026).
//
// Eles saem DEPOIS da matrícula e não podem derrubá-la: um aviso que não saiu
// não desfaz uma matrícula que já existe.
test("sai um e-mail para a pessoa e outro para a unidade", async () => {
  const { app, enviados } = monta({
    plano: { ...PLANO, amount: 2000, currency: "BRL" },
  });

  await assinar(app, {
    cpf: CPF_BOM,
    firstName: "Ana",
    lastName: "Lima",
    email: "ana@x.com",
    telefone: "21999990000",
    unidade: "niteroi",
  });

  await new Promise((r) => setImmediate(r));

  assert.equal(enviados.length, 2);
  assert.equal(enviados[0].to, "ana@x.com");
  assert.equal(enviados[1].to, "niteroi@x.com");
});

test("o aviso da unidade leva CPF, WhatsApp e e-mail — é ficha de trabalho", async () => {
  const { app, enviados } = monta();

  await assinar(app, {
    cpf: CPF_BOM,
    firstName: "Ana",
    email: "ana@x.com",
    telefone: "21999990000",
    unidade: "niteroi",
  });
  await new Promise((r) => setImmediate(r));

  const paraUnidade = enviados.find((m) => m.to === "niteroi@x.com");
  assert.match(paraUnidade.html, /111\.444\.777-35/);
  assert.match(paraUnidade.html, /21999990000/);
});

test("unidade SEM e-mail cai para o da casa — matrícula não se perde por campo vazio", async () => {
  const { app, enviados } = monta({ unidadeSemEmail: true });

  await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com", unidade: "niteroi" });
  await new Promise((r) => setImmediate(r));

  assert.ok(enviados.some((m) => m.to === "casa@x.com"));
});

test("e-mail que falha NÃO derruba a matrícula", async () => {
  // A matrícula já está gravada quando o carteiro é chamado. Deixar o erro
  // subir devolveria 500 para quem acabou de assinar com sucesso.
  const { app, novasRecorrencias } = monta({ correioQuebrado: true });

  const r = await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com" });
  await new Promise((r2) => setImmediate(r2));

  assert.equal(r.body.ok, true);
  assert.equal(novasRecorrencias.length, 1);
});

test("sem E-MAIL não cadastra — é por onde o boleto e a senha chegam", async () => {
  // *"peça o e-mail sim"* (14/10/2026). O WhatsApp é por onde se fala; o
  // e-mail é por onde se ENTREGA.
  const { app, criados } = monta();

  const r = await assinar(app, { cpf: CPF_BOM, firstName: "Ana", lastName: "Lima" });

  assert.equal(r.status, 422);
  assert.equal(r.body.code, "precisa_do_email");
  assert.deepEqual(criados, []);
});

test("a linha inteira do nome continua aceita por quem chamar a rota direto", async () => {
  // A importação e as outras páginas públicas mandam assim, e
  // `nomeDaPessoa.paraGravar` sabe separar.
  const { app, criados } = monta();

  await assinar(app, { cpf: CPF_BOM, nome: "Ana Lima", email: "ana@x.com" });

  assert.equal(criados[0].name, "Ana Lima");
});

test("quem JÁ É aluno não digita mais nada — reusa a ficha dele", async () => {
  const { app, criados, novasRecorrencias, vinculos } = monta({
    pessoa: { _id: "p1", type: "student", name: "Marlon Lima Serra", customFields: { cpf: CPF_BOM } },
  });

  const r = await assinar(app, { cpf: CPF_BOM });

  assert.equal(r.body.ok, true);
  assert.equal(r.body.jaEraAluno, true);
  // O primeiro nome, e só ele: é o que a tela usa para cumprimentar, e quem
  // digitou o próprio CPF já o sabe.
  assert.equal(r.body.nome, "Marlon");
  assert.deepEqual(criados, []);
  assert.equal(String(novasRecorrencias[0].pessoa), "p1");
  // Sem o vínculo, a pessoa existe e não aparece na lista de ninguém.
  assert.equal(vinculos[0].origem, "vitrine");
});

// ── O ALUNO ANTIGO, QUE NÃO TEM CPF ─────────────────────────────────────
//
// O campo CPF nasceu em 14/10/2026 e nasceu DESLIGADO: quase ninguém tem o
// documento gravado. Sem a segunda chave, todo aluno antigo caía num cadastro
// novo que batia no índice único de e-mail — e a tela dizia "Erro interno.",
// a pior frase possível: não diz o que fazer e sugere que o problema é nosso.
test("acha pelo E-MAIL quem ainda não tinha CPF, e grava o documento nele", async () => {
  const { app, criados, atualizados, novasRecorrencias } = monta({
    pessoa: { _id: "p1", type: "student", name: "Marlon Lima", email: "marlon@x.com", customFields: {} },
  });

  const r = await assinar(app, {
    cpf: CPF_BOM,
    firstName: "Marlon",
    lastName: "Lima",
    email: "marlon@x.com",
  });

  assert.equal(r.body.ok, true);
  assert.deepEqual(criados, []);
  // O documento que faltava entra na ficha que já existia — é exatamente o
  // dado que a cobrança vai precisar.
  assert.equal(atualizados[0].customFields.cpf, CPF_BOM);
  assert.equal(String(novasRecorrencias[0].pessoa), "p1");
});

test("mas NÃO sobrescreve o CPF de quem já tinha um", async () => {
  // Dois cadastros com o mesmo e-mail é possível; trocar a identidade de um
  // deles por engano, não.
  const { app, atualizados } = monta({
    pessoa: { _id: "p1", type: "student", name: "Marlon", email: "marlon@x.com", customFields: { cpf: "52998224725" } },
  });

  await assinar(app, { cpf: CPF_BOM, firstName: "Marlon", email: "marlon@x.com" });

  assert.deepEqual(atualizados, []);
});

// ── A CONTA DA EQUIPE NÃO É ALUNO ───────────────────────────────────────
//
// *"me cadastrei... fui em alunos e não tem nada"* (14/10/2026). A assinatura
// tinha ido para a conta do PROFISSIONAL: o e-mail casou, e ele não aparece
// na lista de alunos porque não é um.
//
// O estrago maior era o outro: esta rota GRAVA o CPF em quem ela acha. Numa
// conta de equipe, isso é escrita em dado de staff vinda de uma página que
// qualquer um abre.
// ── O DONO DO ALUNO ─────────────────────────────────────────────────────
//
// *"cadastrei de novo, onde deveria aparecer?"* (14/10/2026). O aluno estava
// no banco e não aparecia em lugar nenhum: o vínculo apontava para um id que
// não era de pessoa nenhuma.
//
// A causa: o plano não guarda quem o criou, `plano.createdBy` vinha vazio, e
// `new ObjectId(undefined)` INVENTA um id. Um aluno sem profissional de
// verdade não existe para ninguém — é o vínculo que o faz aparecer.
test("o aluno nasce ligado ao profissional mais antigo da casa", async () => {
  const { app, criados, vinculos } = monta();

  await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com" });

  assert.equal(String(criados[0].dono), "dono1");
  assert.equal(String(vinculos[0]?.dono || criados[0].dono), "dono1");
});

// ── A UNIDADE ESCOLHIDA ─────────────────────────────────────────────────
//
// *"mas eu me lembro que escolhi a unidade... deveria ter cadastro já na
// unidade"* (14/10/2026). E deveria: escolher a unidade é o PRIMEIRO passo da
// vitrine, antes até de ver o preço. Perder isso no cadastro é perguntar à
// toa — e o aluno nasce sem unidade, invisível para quem abre a lista filtrada
// na dele.
test("o aluno nasce NA UNIDADE que ele escolheu, pelo apelido", async () => {
  const { app, criados } = monta();

  await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com", unidade: "niteroi" });

  assert.equal(String(criados[0].unit), "un1");
});

test("e pelo id também, que é o que os links antigos carregam", async () => {
  const { app, criados } = monta();

  await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com", unidade: "un1" });

  assert.equal(String(criados[0].unit), "un1");
});

test("sem unidade escolhida, nasce sem unidade — e isso é válido", async () => {
  // Casa de uma unidade só não pergunta nada, e quem não foi atribuído
  // aparece em "Todas as unidades".
  const { app, criados } = monta();

  await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com" });

  assert.equal(criados[0].unit, undefined);
});

test("quem JÁ É aluno e não tinha unidade ganha a que escolheu", async () => {
  const { app, atualizados } = monta({
    pessoa: { _id: "p1", type: "student", name: "Ana", email: "ana@x.com", customFields: { cpf: CPF_BOM } },
  });

  await assinar(app, { cpf: CPF_BOM, unidade: "niteroi" });

  assert.equal(String(atualizados[0].unit), "un1");
});

test("mas a unidade de quem JÁ TEM uma não se mexe", async () => {
  // Ela pode treinar em Niterói e estar comprando o plano de Paraty para a
  // irmã. Trocar a unidade dela por isso seria efeito colateral de uma compra.
  const { app, atualizados } = monta({
    pessoa: {
      _id: "p1",
      type: "student",
      name: "Ana",
      email: "ana@x.com",
      unit: "outra",
      customFields: { cpf: CPF_BOM },
    },
  });

  await assinar(app, { cpf: CPF_BOM, unidade: "niteroi" });

  assert.deepEqual(atualizados, []);
});

test("casa SEM profissional nenhum recusa — inventar um dono foi o defeito", async () => {
  const { app, criados } = monta({ semDono: true });

  const r = await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "sem_dono");
  assert.deepEqual(criados, []);
});

test("e-mail de conta da EQUIPE não vira matrícula nem recebe CPF", async () => {
  const { app, novasRecorrencias, atualizados, criados } = monta({
    pessoa: { _id: "t1", type: "trainer", name: "Marlon", email: "dono@x.com", customFields: {} },
  });

  const r = await assinar(app, { cpf: CPF_BOM, firstName: "Alguém", email: "dono@x.com" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "email_da_equipe");
  assert.deepEqual(novasRecorrencias, []);
  assert.deepEqual(atualizados, []);
  assert.deepEqual(criados, []);
});

test("colisão que sobra vira FRASE, e nunca 500", async () => {
  const { app } = monta({ colide: true });

  const r = await assinar(app, { cpf: CPF_BOM, firstName: "Ana", email: "ana@x.com" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ja_cadastrado");
});

test("clicar DUAS vezes não cria duas mensalidades do mesmo plano", async () => {
  // A pessoa clica, a resposta demora, ela clica de novo. Sem isto a academia
  // ganha duas recorrências idênticas e cobra a mesma coisa duas vezes.
  const { app, novasRecorrencias } = monta({
    pessoa: { _id: "p1", type: "student", name: "Marlon", customFields: { cpf: CPF_BOM } },
    recorrencias: [{ membership: "m1", status: "ativa" }],
  });

  const r = await assinar(app, { cpf: CPF_BOM });

  assert.equal(r.body.ok, true);
  assert.equal(r.body.repetida, true);
  assert.deepEqual(novasRecorrencias, []);
});

test("mas uma assinatura CANCELADA não impede voltar", async () => {
  const { app, novasRecorrencias } = monta({
    pessoa: { _id: "p1", type: "student", name: "Marlon", customFields: { cpf: CPF_BOM } },
    recorrencias: [{ membership: "m1", status: "cancelada" }],
  });

  await assinar(app, { cpf: CPF_BOM });

  assert.equal(novasRecorrencias.length, 1);
});

test("CONFERIR não matricula ninguém — só diz se conhece", async () => {
  // A tela consulta sozinha quando os onze dígitos ficam prontos. Se essa
  // consulta matriculasse, quem só digitou o documento sairia assinado sem
  // ter clicado em nada.
  const { app, novasRecorrencias, criados } = monta({
    pessoa: { _id: "p1", type: "student", name: "Marlon Lima Serra", customFields: { cpf: CPF_BOM } },
  });

  const r = await assinar(app, { cpf: CPF_BOM, conferir: true });

  assert.equal(r.body.conhecido, true);
  assert.equal(r.body.nome, "Marlon");
  assert.deepEqual(novasRecorrencias, []);
  assert.deepEqual(criados, []);
});

test("e conferir um CPF desconhecido não cria ficha nenhuma", async () => {
  const { app, criados } = monta();

  const r = await assinar(app, { cpf: CPF_BOM, conferir: true });

  assert.equal(r.body.conhecido, false);
  assert.equal(r.body.nome, "");
  assert.deepEqual(criados, []);
});

test("conferir paga o MESMO limite e os MESMOS dígitos", async () => {
  // Uma rota separada de consulta seria um oráculo puro. Esta passa pelas
  // mesmas guardas.
  const { app } = monta();

  const r = await assinar(app, { cpf: CPF_RUIM, conferir: true });

  assert.equal(r.status, 400);
  assert.equal(r.body.code, "cpf_invalido");
});

test("plano com LINK PRÓPRIO recusa — o checkout da casa vence", async () => {
  const { app, novasRecorrencias } = monta({
    plano: { ...PLANO, botaoLink: "https://pagar.me/xyz" },
  });

  const r = await assinar(app, { cpf: CPF_BOM, nome: "Ana" });

  assert.equal(r.status, 409);
  assert.equal(r.body.code, "tem_link_proprio");
  assert.deepEqual(novasRecorrencias, []);
});

test("plano desligado não se assina", async () => {
  const { app } = monta({ plano: { ...PLANO, active: false } });
  const r = await assinar(app, { cpf: CPF_BOM, nome: "Ana" });

  assert.equal(r.status, 404);
  assert.equal(r.body.code, "plano_nao_achado");
});

test("e-mail torto é recusado antes de virar cadastro", async () => {
  const { app, criados } = monta();
  const r = await assinar(app, { cpf: CPF_BOM, nome: "Ana", email: "nao-e-email" });

  assert.equal(r.status, 400);
  assert.deepEqual(criados, []);
});

// ── GERAR NO GATEWAY ──────────────────────────────────────────────────────
//
// *"coloque uma opção aqui 'Gerar no gateway'; se essa opção tiver marcada, em
// vez de falar que a unidade vai entrar em contato, já gera o cadastro dele no
// gateway e cria a recorrência direto lá"* (14/10/2026).
//
// A regra que governa tudo: A MATRÍCULA JÁ EXISTE quando o gateway entra. Nada
// daqui pode desfazê-la.
const NO_GATEWAY = { ...PLANO, gerarNoGateway: true };
const FATURA = { id: "pay_1", url: "https://asaas/i/1", vencimento: "2026-10-14", valor: 2000 };
const NOVO = { cpf: CPF_BOM, firstName: "Marlon", lastName: "Silva", email: "m@x.com" };

test("plano SEM a opção não fala com o gateway", async () => {
  const { app, assinaturas } = monta();

  const r = await assinar(app, NOVO);

  assert.equal(r.body.ok, true);
  assert.equal(assinaturas.length, 0);
  assert.equal(r.body.pagamento, null);
});

test("com a opção, a fatura volta junto com o 'pronto'", async () => {
  const { app, assinaturas } = monta({
    plano: NO_GATEWAY,
    cobranca: { ok: true, assinatura: "sub_1", pagamento: FATURA },
  });

  const r = await assinar(app, NOVO);

  assert.deepEqual(r.body.pagamento, FATURA);
  // O id da recorrência recém-criada é o fio que amarra as duas pontas.
  assert.equal(String(assinaturas[0].recorrencia), "r1");
  assert.equal(assinaturas[0].pessoa.documento, CPF_BOM);
  assert.equal(assinaturas[0].instancia, "marlon");
});

test("gateway que falha NÃO desfaz a matrícula nem vira 500", async () => {
  // O aluno está gravado. O que não saiu foi a fatura, e a tela cai no texto
  // de sempre — a academia entra em contato.
  const { app, criados, novasRecorrencias } = monta({
    plano: NO_GATEWAY,
    cobranca: { ok: false, erro: "fora_do_ar" },
  });

  const r = await assinar(app, NOVO);

  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.pagamento, null);
  assert.equal(criados.length, 1);
  assert.equal(novasRecorrencias.length, 1);
});

test("quem JÁ tem a assinatura no gateway não ganha uma segunda", async () => {
  // Clicar duas vezes não pode render duas cobranças lá.
  const { app, assinaturas } = monta({
    plano: NO_GATEWAY,
    pessoa: { _id: "p1", name: "Marlon", customFields: { cpf: CPF_BOM }, type: "student" },
    recorrencias: [{ _id: "r9", membership: "m1", status: "ativa", gateway: { assinatura: "sub_ja" } }],
    cobranca: { ok: true, pagamento: FATURA },
  });

  const r = await assinar(app, { cpf: CPF_BOM });

  assert.equal(r.body.repetida, true);
  assert.equal(assinaturas.length, 0);
});

test("mas uma recorrência que existe SEM assinatura lá ainda pode ganhar uma", async () => {
  // É o caso de quem se matriculou antes de a casa ligar o gateway.
  const { app, assinaturas } = monta({
    plano: NO_GATEWAY,
    pessoa: { _id: "p1", name: "Marlon", customFields: { cpf: CPF_BOM }, type: "student" },
    recorrencias: [{ _id: "r9", membership: "m1", status: "ativa" }],
    cobranca: { ok: true, pagamento: FATURA },
  });

  await assinar(app, { cpf: CPF_BOM });

  assert.equal(String(assinaturas[0].recorrencia), "r9");
});

test("`repetida` é BOOLEANO — a regra inteira não vaza numa resposta pública", async () => {
  const { app } = monta({
    pessoa: { _id: "p1", name: "Marlon", customFields: { cpf: CPF_BOM }, type: "student" },
    recorrencias: [{ _id: "r9", membership: "m1", status: "ativa", amount: 99900, createdBy: "u1" }],
  });

  const r = await assinar(app, { cpf: CPF_BOM });

  assert.equal(r.body.repetida, true);
  assert.equal(JSON.stringify(r.body).includes("99900"), false);
});

test("o e-mail de boas-vindas troca o botão por PAGAR quando há fatura", async () => {
  // É o link que salva quem fechou a aba antes de pagar. Sem ele, a academia
  // recebe o telefonema no dia seguinte perguntando como se paga.
  const { app, enviados } = monta({
    plano: NO_GATEWAY,
    cobranca: { ok: true, pagamento: FATURA },
  });

  await assinar(app, NOVO);

  const paraOAluno = enviados.find((m) => m.to === "m@x.com");
  assert.match(paraOAluno.subject, /falta o pagamento/i);
  assert.ok(paraOAluno.html.includes(FATURA.url), "o botão leva à fatura");
  // O vencimento NÃO pode andar um dia: "2026-10-14" lido como meia-noite UTC
  // e formatado em São Paulo vira 13/10.
  assert.ok(paraOAluno.text.includes("14/10/2026"), paraOAluno.text);
});

test("sem fatura, o e-mail continua o de sempre", async () => {
  const { app, enviados } = monta();

  await assinar(app, NOVO);

  const paraOAluno = enviados.find((m) => m.to === "m@x.com");
  assert.doesNotMatch(paraOAluno.subject, /falta o pagamento/i);
});
