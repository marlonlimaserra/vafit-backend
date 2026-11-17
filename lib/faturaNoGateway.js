const cartaoDoAluno = require("./cartaoDoAluno.js");

// ── EMITIR UMA FATURA NO GATEWAY DA UNIDADE DA PESSOA ────────────────────
//
// Isto morava dentro de `controllers/Finance.js`, onde nasceu. Saiu de lá em
// 19/10/2026 porque ganhou um segundo chamador que não é rota nenhuma: a
// GERAÇÃO DA ASSINATURA (`model/Recurrence_model.js`), que roda pela fila e
// pela abertura da tela, sem `req` e sem resposta para escrever.
//
// Copiar as duas funções para lá seria garantir que a cópia envelheceria — o
// token do cartão, o documento do cliente e o vocabulário dos erros mudariam
// de um lado só. É o mesmo motivo que já juntou os formulários de cobrança.
//
// Recebem `app` em vez de fechar sobre ele: um módulo não tem o escopo da
// rota, e passar explicitamente é o que deixa testá-las sem subir servidor.

// ── A CONTA QUE COBRA, E O CLIENTE DELA ───────────────────────────────
//
// Os dois passos que antecedem QUALQUER cobrança no gateway: achar a conta
// da unidade da pessoa e garantir que ela existe como cliente lá. O carnê e
// a cobrança avulsa fazem os dois igual, e escrevê-los duas vezes era
// garantir que a segunda cópia envelheceria — foi o que já aconteceu com os
// formulários de cobrança antes de virarem compartilhados.
//
// Devolve `{ok:false, erro}` no nosso vocabulário, nunca o texto cru de lá.
// SÓ A CONTA: a chave e o adaptador da unidade da pessoa. É o que cancelar,
// apagar e estornar uma fatura precisam — elas falam de uma fatura que JÁ
// existe, e não do cliente. Até 16/11/2026 elas passavam por `contaECliente`,
// que procurava (e podia CRIAR) o cliente no gateway a cada cancelamento.
async function contaDoGateway(app, student) {
  const credenciais = await app.api.paymentGateway.ativo(student.unit);
  if (!credenciais) return { ok: false, erro: "sem_gateway" };
  const gw = require("../lib/gateways").de(credenciais.tipo);
  if (!gw?.cobranca) return { ok: false, erro: "gateway_nao_cobra" };
  return { ok: true, credenciais, gw };
}

// A CONTA E O CLIENTE: o que EMITIR precisa (avulsa, carnê, assinatura).
async function contaECliente(app, student) {
  const conta = await contaDoGateway(app, student);
  if (!conta.ok) return conta;

  // ── SEM DOCUMENTO, NENHUMA BUSCA (16/11/2026) ───────────────────────────
  //
  // Sem CPF/CNPJ nenhum gateway acha o cliente CERTO: a busca é por documento,
  // e uma busca vazia devolve OUTRO cliente da conta — a fatura nasceria no
  // nome dele, e o aviso iria para ele. A trava fica aqui, antes de qualquer
  // rede, para valer para todo adaptador; o do Asaas confere o formato também.
  const documento = student.customFields?.cpf || student.customFields?.cnpj || "";
  if (!String(documento).replace(/\D/g, "")) return { ok: false, erro: "sem_documento" };

  const cliente = await conta.gw.cobranca.cliente({
    chave: conta.credenciais.chave,
    ambiente: conta.credenciais.ambiente,
    pessoa: {
      id: String(student._id),
      nome: student.name,
      documento,
      email: student.email,
      telefone: student.phone,
    },
  });
  if (!cliente.ok) return cliente;
  return { ...conta, cliente: cliente.id };
}

// ── UMA COBRANÇA SÓ, LÁ ───────────────────────────────────────────────
//
// O que a caixa "gerar no {{nome}}" do formulário faz. Devolve o id da
// fatura e o LINK de pagamento, que é o que a pessoa de fato usa.
async function emitirAvulsa(
  app,
  student,
  cobranca,
  // `cartao`  — `true` para o principal guardado, ou o id de um deles.
  // `cartaoNovo` — os dados digitados na hora, que serão tokenizados aqui.
  // `salvar`  — guardar esse token para as próximas (a caixa do diálogo).
  { cartao = false, cartaoNovo = null, salvar = false, ip = "", porQuem = null } = {}
) {
  // ── CONFERIR O CARTÃO DIGITADO ANTES DE QUALQUER REDE ──────────────
  //
  // Mesma ordem da aba Cartão de crédito, e pela mesma razão: um CEP com
  // cara de CPF reprovado aqui não cria cliente nenhum no gateway e não
  // manda o número do cartão numa viagem que já se sabe perdida.
  const conferido = cartaoNovo ? cartaoDoAluno.conferir(student, cartaoNovo) : null;
  if (conferido && !conferido.ok) return conferido;

  const conta = await contaECliente(app, student);
  if (!conta.ok) return conta;
  if (!conta.gw.cobranca.avulsa) return { ok: false, erro: "gateway_nao_cobra" };

  // ── O CARTÃO, quando é ele que vai pagar ───────────────────────────
  //
  // Dois caminhos, e os dois terminam num token: o GUARDADO, procurado
  // pelo trio (pessoa, tipo do gateway, unidade da conta) — um token nasceu
  // para um cliente de uma conta, e tentá-lo em outra volta recusado na
  // frente do aluno —, e o DIGITADO NA HORA, que é tokenizado agora.
  //
  // Não achar o guardado é RECUSA e não silêncio: quem pediu "cobrar no
  // cartão" não quer um boleto no lugar.
  let token = "";
  if (conferido) {
    if (!conta.gw.cobranca.tokenizarCartao) return { ok: false, erro: "gateway_nao_cobra" };
    // A conta precisa ter a tokenização LIBERADA — é pedido ao suporte do
    // gateway, e não caixa que a gente marca. Ver `PaymentGateway_model`.
    if (!conta.credenciais.tokenizacao) return { ok: false, erro: "sem_tokenizacao" };

    const feito = await cartaoDoAluno.tokenizar({
      ...conferido,
      ip,
      credenciais: conta.credenciais,
      gateway: conta.gw,
      cliente: conta.cliente,
    });
    if (!feito.ok) return feito;
    token = feito.token;

    // ── "SALVAR PARA FUTUROS PAGAMENTOS" ────────────────────────────
    //
    // *"se for por na hora, mostre o checkbox 'salvar para futuros
    // pagamentos'"* (19/10/2026). Desmarcada, o token existe no gateway e
    // NÃO fica aqui: o cartão pagou esta fatura e some da nossa vista —
    // que é o que alguém que digita o cartão de outra pessoa no balcão
    // espera.
    //
    // E guardar não pode derrubar a cobrança: o dinheiro já foi debitado
    // quando esta linha roda, e estourar aqui perderia a fatura que já
    // existe lá.
    if (salvar) {
      try {
        await cartaoDoAluno.guardar(
          app,
          student,
          { credenciais: conta.credenciais, cliente: conta.cliente, ...feito },
          porQuem
        );
      } catch (erro) {
        console.error("[fatura] cartão cobrado mas não guardado:", erro?.message || erro);
      }
    }
  } else if (cartao) {
    const guardado = await app.api.cartaoSalvo?.paraCobrar?.(student._id, {
      tipo: conta.credenciais.tipo,
      unidade: conta.credenciais.unidade || "",
      // `true` quer dizer "o principal". Um id escolhe um deles — é o que o
      // diálogo manda quando a pessoa tem três cartões guardados.
      id: cartao === true ? "" : String(cartao),
    });
    if (!guardado?.token) return { ok: false, erro: "sem_cartao" };
    token = guardado.token;
  }

  const feito = await conta.gw.cobranca.avulsa({
    chave: conta.credenciais.chave,
    ambiente: conta.credenciais.ambiente,
    cliente: conta.cliente,
    cartao: token,
    cobranca: {
      id: String(cobranca?._id || ""),
      valor: cobranca?.amount,
      vencimento: cobranca?.dueDate,
      descricao: cobranca?.description || "",
      // A FORMA escolhida no formulário, quando houve uma. Vazio é "todas":
      // a fatura abre com pix, boleto e cartão, e quem escolhe é quem vai
      // pagar. Ver `formaDeCobranca`.
      formasDePagamento: cobranca?.method ? [cobranca.method] : [],
    },
  });

  return feito.ok ? { ...feito, noCartao: Boolean(token) } : feito;
}

module.exports = { contaDoGateway, contaECliente, emitirAvulsa };
