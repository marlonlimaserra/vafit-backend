const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");

const Recurrence_model = require("../../model/Recurrence_model.js");

// A GERAÇÃO DA MENSALIDADE.
//
// Ela roda na LEITURA de duas telas — a aba da pessoa e o Financeiro geral —,
// então ela roda MUITO. O que estes casos seguram é que rodar muito não produz
// nada de novo, e que nada do que pode dar errado numa regra mal cadastrada
// derruba a tela que mostra o dinheiro.
const HOJE = new Date("2026-09-17T12:00:00.000Z");

const ALUNO = new ObjectId("6a7f8e18ac5f3b34bb4e4801");
const R1 = new ObjectId("6a7f8e18ac5f3b34bb4e4901");

const REGRA = {
  _id: R1,
  student: ALUNO,
  amount: 80000,
  currency: "BRL",
  cadencia: "monthly",
  startsAt: new Date("2026-07-05T00:00:00.000Z"),
  endsAt: null,
  status: "active",
  description: "Mensalidade",
};

// Um dobro da collection de cobranças que GUARDA o que foi inserido — é o que
// permite afirmar o que nasceu, e não só quantas.
function montar(regras, jaGeradas = [], aoInserir = null, planos = []) {
  const inseridas = [];
  const model = new Recurrence_model({
    api: {
      // O catálogo de planos só é consultado quando alguma regra não tem
      // descrição — é de lá que sai o nome da cobrança nesse caso.
      membership: {
        async collection() {
          return {
            find: (filtro) => ({
              toArray: async () =>
                planos.filter((p) =>
                  (filtro._id.$in || []).some((id) => String(id) === String(p._id))
                ),
            }),
          };
        },
      },
      finance: {
        async charges() {
          return {
            find: () => ({ toArray: async () => jaGeradas }),
            async insertOne(doc) {
              if (aoInserir) await aoInserir(doc);
              inseridas.push(doc);
              return { insertedId: new ObjectId() };
            },
          };
        },
      },
    },
  });

  model.collection = async () => ({
    find: () => ({ toArray: async () => regras }),
  });

  return { model, inseridas };
}

test("a primeira passada cria o que está vencido e o que vence na janela", async () => {
  const { model, inseridas } = montar([REGRA]);

  const criadas = await model.gerar({ hoje: HOJE });

  assert.equal(criadas, 3);
  assert.deepEqual(inseridas.map((c) => c.periodo), ["2026-07-05", "2026-08-05", "2026-09-05"]);
  // Cada uma carrega o VÍNCULO e a ETIQUETA — é o par que o índice único
  // protege. Sem eles a mensalidade de setembro nasceria de novo a cada
  // abertura da tela.
  assert.equal(String(inseridas[0].recurrence), String(R1));
  assert.equal(inseridas[0].amount, 80000);
  assert.equal(inseridas[0].status, "open");
  assert.equal(inseridas[0].description, "Mensalidade");
});

test("a segunda passada não cria nada — e é isso que permite gerar na leitura", async () => {
  const jaGeradas = ["2026-07-05", "2026-08-05", "2026-09-05"].map((periodo) => ({
    recurrence: R1,
    periodo,
  }));

  const { model, inseridas } = montar([REGRA], jaGeradas);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("o índice único ganhando a corrida não é erro — é o desenho funcionando", async () => {
  // Duas abas abertas leem "não existe" juntas e inserem juntas. A segunda bate
  // no índice, e a geração tem de seguir em frente: um 11000 propagado aqui
  // derrubaria a abertura do financeiro inteiro.
  const duplicada = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  let vez = 0;

  const { model, inseridas } = montar([REGRA], [], () => {
    vez++;
    if (vez === 2) throw duplicada;
  });

  const criadas = await model.gerar({ hoje: HOJE });

  assert.equal(criadas, 2, "a que colidiu não conta");
  assert.equal(inseridas.length, 2);
});

test("erro que NÃO é colisão não passa como sucesso", async () => {
  // Banco fora do ar precisa virar log e zero, não uma contagem inventada.
  const { model } = montar([REGRA], [], () => {
    throw new Error("sem conexão");
  });

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
});

test("regra cancelada não gera — cancelar é o jeito de parar sem apagar o passado", async () => {
  // O filtro é do banco (`{ status: { $in: GERAM } }`), então o dobro devolve a
  // lista já filtrada; o que este caso prende é que a rota pede o filtro.
  const { model, inseridas } = montar([]);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("valor zero não vira uma cobrança de R$ 0,00 por mês, para sempre", async () => {
  const { model, inseridas } = montar([{ ...REGRA, amount: 0 }]);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("regra sem data de início não gera cobrança de 1970", async () => {
  // `new Date(null)` é a época, e não data inválida. Antes da guarda em
  // `lib/recorrencia.js`, isto despejava 24 mensalidades datadas de 1970.
  const { model, inseridas } = montar([{ ...REGRA, startsAt: null }]);

  assert.equal(await model.gerar({ hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("a data de FIM para a série", async () => {
  const { model, inseridas } = montar([{ ...REGRA, endsAt: new Date("2026-08-31T00:00:00.000Z") }]);

  await model.gerar({ hoje: HOJE });
  assert.deepEqual(inseridas.map((c) => c.periodo), ["2026-07-05", "2026-08-05"]);
});

test("aluno inválido devolve zero em vez de varrer a conta inteira", async () => {
  const { model, inseridas } = montar([REGRA]);

  assert.equal(await model.gerar({ student: "não é id", hoje: HOJE }), 0);
  assert.deepEqual(inseridas, []);
});

test("duas regras da mesma pessoa não se confundem", async () => {
  // A mensalidade e a anuidade convivem: *"todo mês eu pago 800 reais pra minha
  // personal. Mas na academia eu pago anual"*. O conjunto de "já gerados" é POR
  // REGRA — compartilhá-lo faria uma calar a outra.
  const R2 = new ObjectId("6a7f8e18ac5f3b34bb4e4902");
  const anual = {
    ...REGRA,
    _id: R2,
    amount: 120000,
    cadencia: "annual",
    startsAt: new Date("2026-09-05T00:00:00.000Z"),
    description: "Anuidade",
  };

  const { model, inseridas } = montar(
    [REGRA, anual],
    // A mensalidade de setembro já existe; a anuidade tem a MESMA etiqueta e
    // ainda não existe.
    [{ recurrence: R1, periodo: "2026-09-05" }]
  );

  await model.gerar({ hoje: HOJE });

  assert.deepEqual(
    inseridas.map((c) => `${c.description} ${c.periodo}`),
    ["Mensalidade 2026-07-05", "Mensalidade 2026-08-05", "Anuidade 2026-09-05"]
  );
});

test("o estado vem do CATÁLOGO, e é ele que a geração consulta", async () => {
  // O filtro não é `status !== "canceled"` escrito à mão: é `$in` na lista dos
  // que geram. O dia em que "pausada" entrar em `lib/statusDeRecorrencia.js`
  // com `gera: false`, ela para de gerar sem ninguém procurar os lugares.
  const statusDeRecorrencia = require("../../lib/statusDeRecorrencia.js");
  let filtroVisto = null;

  const model = new Recurrence_model({ api: { finance: { async charges() { return {}; } } } });
  model.collection = async () => ({
    find: (filtro) => {
      filtroVisto = filtro;
      return { toArray: async () => [] };
    },
  });

  await model.gerar({ hoje: HOJE });

  assert.deepEqual(filtroVisto, { status: { $in: statusDeRecorrencia.GERAM } });
  assert.ok(!statusDeRecorrencia.GERAM.includes("canceled"), "cancelada não pode gerar");
});

// ── O NOME DA COBRANÇA QUANDO A REGRA NÃO TEM NOME ──────────────────────
//
// *"descrição deveria ficar em branco"* (15/10/2026): a recorrência vendida
// pela vitrine guarda o VÍNCULO com o plano, e não uma cópia do nome dele.
const PLANO = new ObjectId("6a7f8e18ac5f3b34bb4e4a01");

test("sem descrição, a cobrança nasce com o nome do PLANO", async () => {
  const { model, inseridas } = montar(
    [{ ...REGRA, description: "", membership: PLANO }],
    [],
    null,
    [{ _id: PLANO, name: "Plano Fit" }]
  );

  assert.equal(await model.gerar({ hoje: HOJE }), 3);
  // COPIADO na cobrança, e aqui isso é o certo: a cobrança é o fato de um mês,
  // e precisa continuar dizendo o que foi cobrado depois de o plano ser
  // renomeado ou apagado.
  assert.deepEqual([...new Set(inseridas.map((c) => c.description))], ["Plano Fit"]);
});

test("o que foi digitado vence o nome do plano", async () => {
  const { model, inseridas } = montar(
    [{ ...REGRA, description: "Mensalidade da Giovana", membership: PLANO }],
    [],
    null,
    [{ _id: PLANO, name: "Plano Fit" }]
  );

  await model.gerar({ hoje: HOJE });
  assert.equal(inseridas[0].description, "Mensalidade da Giovana");
});

test("plano apagado não impede a cobrança de nascer", async () => {
  // A regra continua valendo: ela tem valor, cadência e vencimento. Ficar sem
  // nome é ruim; deixar de cobrar a mensalidade é pior.
  const { model, inseridas } = montar([{ ...REGRA, description: "", membership: PLANO }]);

  assert.equal(await model.gerar({ hoje: HOJE }), 3);
  assert.equal(inseridas[0].description, "");
});

// ── A LÁPIDE: APAGADO TEM DE FICAR APAGADO ───────────────────────────────
//
// *"tentei excluir o pagamento que pertence a assinatura, ele falou que apagou
// mas continua"* (17/10/2026).
//
// E ele apagava mesmo — a mensagem não mentia. Mas a geração roda a cada
// LEITURA da tela do dinheiro, e ela decide o que falta comparando os
// períodos que já existem. Apagado o de setembro, setembro voltava a faltar,
// e nascia de novo antes de a tela terminar de carregar.
//
// É o pior tipo de defeito: a confirmação diz que deu certo.
test("período apagado de propósito NÃO volta na próxima leitura", async () => {
  const { model, inseridas } = montar([
    { ...REGRA, periodosApagados: ["2026-08-05", "2026-09-05"] },
  ]);

  await model.gerar({ hoje: HOJE });

  // Julho é o único que sobra: agosto e setembro foram apagados à mão.
  assert.deepEqual(inseridas.map((c) => c.periodo), ["2026-07-05"]);
});

test("a lápide convive com o que já existe", async () => {
  // Uma regra pode ter mensalidade gerada E mensalidade apagada. Os dois são
  // "período resolvido" para a geração, e nenhum dos dois volta.
  const { model, inseridas } = montar(
    [{ ...REGRA, periodosApagados: ["2026-09-05"] }],
    [{ recurrence: R1, periodo: "2026-07-05" }]
  );

  await model.gerar({ hoje: HOJE });

  assert.deepEqual(inseridas.map((c) => c.periodo), ["2026-08-05"]);
});

test("sem lápide nenhuma, nada muda", async () => {
  // A regra velha não tem o campo. `|| []` é o que impede a geração de
  // quebrar em toda conta que já existia.
  const { model, inseridas } = montar([REGRA]);

  await model.gerar({ hoje: HOJE });
  assert.equal(inseridas.length, 3);
});

// ── A MENSALIDADE QUE NASCE TAMBÉM NO GATEWAY (19/10/2026) ───────────────
//
// *"faltou o checkbox do criar no asaas também"*. É propriedade da REGRA, e
// não de um clique: a assinatura gera uma cobrança por mês, para sempre, e
// ninguém vai abrir a ficha todo dia 5 para pedir o boleto.
//
// O que estes casos seguram é a ORDEM de importância: a cobrança daqui é o
// fato contábil, a fatura de lá é o meio de receber. Gateway fora do ar não
// pode fazer a mensalidade de outubro deixar de existir.
const COM_FATURA = { ...REGRA, noGateway: true };

function comEmissao({ falha = false, regras = [COM_FATURA] } = {}) {
  const emitidas = [];
  const { model, inseridas } = montar(regras);

  model.emitirFatura = async (regra, chargeId) => {
    emitidas.push(String(regra._id));
    if (falha) throw new Error("gateway fora do ar");
    return true;
  };

  return { model, inseridas, emitidas };
}

test("com a caixa marcada, cada mensalidade nova ganha a fatura dela", async () => {
  const { model, inseridas, emitidas } = comEmissao();

  const criadas = await model.gerar({ hoje: HOJE });

  assert.equal(criadas, 3);
  assert.equal(emitidas.length, 3, "uma fatura por ocorrência, e não uma por regra");
  assert.equal(inseridas.length, 3);
});

test("sem a caixa, ninguém fala com o gateway", async () => {
  const { model, emitidas } = comEmissao({ regras: [REGRA] });

  await model.gerar({ hoje: HOJE });

  assert.deepEqual(emitidas, []);
});

test("gateway fora do ar NÃO impede a mensalidade de nascer", async () => {
  // Sem esta garantia, uma recusa do Asaas deixaria o mês sem cobrança E sem
  // boleto — e a cobrança é o que fecha o caixa. O link se gera depois, pelo
  // menu da linha.
  const { model, inseridas } = comEmissao({ falha: true });

  const criadas = await model.gerar({ hoje: HOJE });

  assert.equal(inseridas.length, 3, "as três nasceram");
  assert.equal(criadas, 3, "e as três foram contadas");
});

// ── A FORMA COMBINADA É COPIADA PARA CADA MENSALIDADE ───────────────────
//
// *"em parcelamento e assinatura, faltaram os métodos de pagamento igual em
// fatura avulsa"* (19/10/2026).
//
// COPIADA, como o valor e a descrição: a cobrança é um fato do mês, e trocar
// a forma na regra em março não pode reescrever o que foi combinado em
// janeiro.
test("a forma da regra entra na cobrança que nasce", async () => {
  const { model, inseridas } = montar([{ ...REGRA, method: "billet" }]);

  await model.gerar({ hoje: HOJE });

  assert.ok(inseridas.every((c) => c.method === "billet"));
});

test("regra sem forma gera cobrança com forma VAZIA — que quer dizer 'todas'", async () => {
  // Vazio não é ausência: é a fatura abrindo com pix, boleto e cartão, e
  // quem escolhe sendo quem paga.
  const { model, inseridas } = montar([REGRA]);

  await model.gerar({ hoje: HOJE });

  assert.ok(inseridas.every((c) => c.method === ""));
});
