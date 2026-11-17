const { ObjectId } = require("mongodb");

const clientIp = require("../lib/clientIp.js");
const cartaoDoAluno = require("../lib/cartaoDoAluno.js");

// OS CARTÕES GUARDADOS DE UMA PESSOA — a aba "Cartões" do Financeiro dela.
//
//   GET    /people/:personId/cards                 a lista, e se dá para guardar
//   POST   /people/:personId/cards                 tokeniza no gateway e guarda
//   POST   /people/:personId/cards/:id/principal   qual deles cobra
//   DELETE /people/:personId/cards/:id             tira o token daqui
//
// *"crie aqui, aba de cartão de crédito para colocar os cartões para pagar as
// faturas que a unidade gerar"* (16/10/2026).
//
// ── O NÚMERO DO CARTÃO ATRAVESSA, E NÃO FICA ────────────────────────────
//
// Ele chega aqui, vai para o Asaas na mesma requisição e some. Não é gravado,
// não entra no histórico de ações, não entra em log — nem no de erro, que é
// onde esse tipo de coisa costuma vazar. O que sobra guardado é o token mais
// os quatro últimos dígitos. Ver `model/CartaoSalvo_model.js`.
//
// ── A PERMISSÃO É A DO FINANCEIRO ───────────────────────────────────────
//
// `finance.view` para ver, `finance.manage` para mexer — as mesmas de quem
// edita uma cobrança. Quem pode guardar um cartão está autorizando cobranças
// futuras automáticas nele.
module.exports = function (app) {
  // O vocabulário das recusas mora em `lib/cartaoDoAluno.js`: o Financeiro
  // tokeniza pela mesma função (o cartão digitado na hora, no botão Cobrar) e
  // precisa recusar com a MESMA frase. A recusa do gateway vai junto quando
  // existe — "CPF/CNPJ inválido" diz o que fazer, e qualquer coisa nossa no
  // lugar dela seria um palpite.
  const recusa = (req, res, erro, detalhe) => {
    const { status, corpo } = cartaoDoAluno.recusaDe(req.t, erro, detalhe);
    res.status(status).send(corpo);
  };

  // A pessoa, com o que o gateway vai pedir sobre o titular. O CPF mora em
  // `customFields.cpf` — é campo semeado, e não coluna. Ver `User_model`.
  const pessoaDe = async (personId) => {
    if (!ObjectId.isValid(String(personId))) return null;
    const users = await app.api.user.collection();
    return users.findOne(
      { _id: new ObjectId(String(personId)) },
      { projection: { name: 1, email: 1, phone: 1, unit: 1, customFields: 1 } }
    );
  };

  // O titular e as três perguntas do gateway moram em `lib/cartaoDoAluno.js`
  // desde 19/10/2026: o botão Cobrar do Financeiro tokeniza pelo mesmo
  // caminho, e duas cópias da lista de campos obrigatórios do titular
  // divergiriam na primeira mudança. Aqui ficam só os nomes curtos.
  const titularDe = cartaoDoAluno.titularDe;
  const situacao = (pessoa) => cartaoDoAluno.situacao(app, pessoa);

  app.get("/people/:personId/cards", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.view");
    if (user === false) return;

    const pessoa = await pessoaDe(req.params.personId);
    if (!pessoa) return recusa(req, res, "pessoa_invalida");

    const estado = await situacao(pessoa);

    res.send({
      rows: await app.api.cartaoSalvo.lista(req.params.personId),
      // O que a tela usa para explicar a ausência do formulário. `motivo` é
      // um id do nosso vocabulário, nunca uma frase — a frase é da tela, nos
      // quatro idiomas.
      gateway: { nome: estado.nome || "", pronto: estado.pronto, motivo: estado.motivo || "" },
      titular: titularDe(pessoa),
    });
  });

  app.post("/people/:personId/cards", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const pessoa = await pessoaDe(req.params.personId);
    if (!pessoa) return recusa(req, res, "pessoa_invalida");

    const estado = await situacao(pessoa);
    if (!estado.pronto) return recusa(req, res, estado.motivo);

    const { credenciais, gateway } = estado;

    // CONFERIR PRIMEIRO, pedir o cliente ao gateway DEPOIS. Um CEP com cara
    // de CPF reprovado aqui não deixa para trás um cadastro novo lá — e não
    // manda o número do cartão numa viagem que já se sabe perdida. As regras
    // moram na lib: o botão Cobrar do Financeiro passa pelas mesmas.
    const conferido = cartaoDoAluno.conferir(pessoa, req.body || {});
    if (!conferido.ok) return recusa(req, res, conferido.erro);

    // O CLIENTE no gateway, pelo caminho de sempre: busca por CPF e cria se
    // não existir. Reusar `cobranca.cliente` é o que garante que o token
    // nasce no MESMO cliente que a assinatura vai usar — token de um cliente
    // não cobra em outro.
    const cliente = await gateway.cobranca.cliente({
      chave: credenciais.chave,
      ambiente: credenciais.ambiente,
      pessoa: {
        id: String(pessoa._id),
        nome: conferido.titular.nome,
        documento: conferido.titular.documento,
        email: conferido.titular.email,
        telefone: conferido.titular.telefone,
      },
    });
    if (!cliente.ok) return recusa(req, res, cliente.erro, cliente.detalhe);

    const token = await cartaoDoAluno.tokenizar({
      ...conferido,
      ip: clientIp(req),
      credenciais,
      gateway,
      cliente: cliente.id,
    });
    if (!token.ok) return recusa(req, res, token.erro, token.detalhe);

    const salvo = await cartaoDoAluno.guardar(
      app,
      pessoa,
      { credenciais, cliente: cliente.id, ...token },
      user._id
    );
    if (salvo.erro) return recusa(req, res, salvo.erro);

    app.insertUserActionHistory(req, user, "save_card", {
      category: "finance",
      local: { target_type: "people", target_id: String(pessoa._id) },
      // Os quatro últimos e a bandeira. O número e o token NÃO vão para o
      // histórico — ele é lido por gente, e exportado.
      data: { bandeira: token.bandeira, fim: token.fim },
    });

    res.send({ rows: await app.api.cartaoSalvo.lista(req.params.personId) });
  });

  app.post("/people/:personId/cards/:id/principal", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const r = await app.api.cartaoSalvo.principal(req.params.personId, req.params.id);
    if (r.erro) return recusa(req, res, r.erro);

    res.send({ rows: await app.api.cartaoSalvo.lista(req.params.personId) });
  });

  app.delete("/people/:personId/cards/:id", async function (req, res) {
    const user = await app.helpers.ReqProtected.can(req, res, "finance.manage");
    if (user === false) return;

    const r = await app.api.cartaoSalvo.remover(req.params.personId, req.params.id);
    if (r.erro) return recusa(req, res, r.erro);

    app.insertUserActionHistory(req, user, "delete_card", {
      category: "finance",
      local: { target_type: "people", target_id: String(req.params.personId) },
    });

    res.send({ rows: await app.api.cartaoSalvo.lista(req.params.personId) });
  });
};
