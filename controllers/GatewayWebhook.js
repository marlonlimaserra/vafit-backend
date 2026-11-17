const crypto = require("node:crypto");

const gateways = require("../lib/gateways");
const instanceContext = require("../lib/instance.js");

// O AVISO DE PAGAMENTO QUE CHEGA DO GATEWAY.
//
// *"o Asaas vai criar o pagamento lá e vai enviar ele via webhook"*
// (14/10/2026).
//
//   POST /public/gateway-webhook/:tipo/:instancia
//
// ── POR QUE A INSTÂNCIA VAI NO CAMINHO ───────────────────────────────────
//
// Porque, ao contrário da Meta, cada cliente tem a CONTA DELE no gateway. O
// Asaas da academia A não sabe que a B existe, e o aviso dele não traz nada
// que diga de quem é — os ids lá dentro são todos do mundo dele.
//
// Então o endereço registrado lá é por cliente, com a instância escrita nele.
// Não é segredo: é endereçamento, como o `:instance` da foto pública de um
// plano. O segredo é outro, e está logo abaixo.
//
// ── A PORTA É PÚBLICA, ENTÃO O SEGREDO É OBRIGATÓRIO ─────────────────────
//
// Quem bate aqui é o Asaas, de um IP que não controlamos, sem sessão. Sem
// conferência, qualquer um que descubra o endereço manda `PAYMENT_RECEIVED` e
// marca a mensalidade de quem quiser como paga — e a academia só descobre
// fechando o mês.
//
// O `authToken` que registramos no webhook volta no cabeçalho
// `asaas-access-token`. Ele é por cliente (`PaymentGateway_model`), e a
// comparação é de tempo fixo: um `!==` conta, pelo relógio, quantos
// caracteres iniciais estão certos, e isso basta para adivinhar um token a
// força bruta.
//
// ── 200 QUER DIZER "NÃO MANDE DE NOVO" ───────────────────────────────────
//
// O Asaas reenvia o que não deu 2xx, e com `sendType: SEQUENTIALLY` ele PARA
// A FILA inteira daquela conta enquanto insiste. Por isso um aviso que não
// casa com nada aqui — assinatura de antes desta função existir, recorrência
// apagada — responde 200 assim mesmo: ele não vai melhorar na terceira
// tentativa, e segurar a fila por causa dele atrasaria os pagamentos de
// verdade que vêm atrás.
//
// O que responde erro é o que PODE melhorar: banco fora, defeito nosso.
module.exports = function (app) {
  // `:unidade` é OPCIONAL, e a ausência dela quer dizer "a conta da casa". É
  // o que mantém válidos os webhooks já registrados no Asaas antes de as
  // filiais terem conta própria — eles continuam chegando com três segmentos.
  app.post("/public/gateway-webhook/:tipo/:instancia/:unidade?", async function (req, res) {
    const tipo = String(req.params.tipo || "");
    const instancia = String(req.params.instancia || "");
    const unidade = String(req.params.unidade || "");

    const gateway = gateways.de(tipo);
    if (!gateway?.cobranca) return res.status(404).send({ msg: "unknown" });

    const registro = await app.api.center.byInstance(instancia);
    if (!registro) return res.status(404).send({ msg: "unknown" });

    // ── O DIÁRIO ────────────────────────────────────────────────────────
    //
    // *"coloque 'log asaas' para a gente poder ver o que chegou, se foi
    // processado ou não"* (19/10/2026).
    //
    // Toda passagem por aqui vira uma linha — inclusive, e principalmente, a
    // RECUSADA: "chegou e foi recusado" e "não chegou" pedem consertos
    // opostos, e do lado de fora os dois são o mesmo silêncio.
    //
    // Grava DENTRO do contexto da instância (o banco é um só, e o escopo vem
    // dele) e NUNCA estoura: um erro ao escrever o diário não pode virar um
    // 500 que faz o Asaas reenviar e parar a fila da conta.
    //
    // O `?.` não é frouxidão: este caminho dá baixa em dinheiro, e a ausência
    // do diário — num teste, num processo meio montado — não pode ser o que
    // derruba um pagamento aplicado.
    const anotar = (dados) =>
      instanceContext.run(instancia, () =>
        app.api.avisoDoGateway?.registrar?.({ tipo, unidade, corpo: req.body || {}, ...dados })
      );

    try {
      const resultado = await instanceContext.run(instancia, async () => {
        const credenciais = await app.api.paymentGateway.credenciais(tipo, unidade);
        // Gateway desligado depois de o webhook ter sido registrado lá. O
        // aviso não tem para onde ir, e insistir não resolve.
        if (!credenciais?.segredo) return { recusado: true, semChave: true };

        if (!confere(req.headers["asaas-access-token"], credenciais.segredo)) {
          return { recusado: true };
        }

        // O `t` vai junto: um aviso de assinatura cancelada escreve o motivo
        // na ficha, e esse texto é lido por gente. Aqui ele sai no idioma da
        // requisição — que, vindo do Asaas, é o padrão da casa.
        return app.api.cobrador.aplicarAviso(tipo, req.body || {}, { t: req.t });
      });

      if (resultado.recusado) {
        // Barulhento no log, discreto na resposta: quem está tentando não
        // ganha a confirmação de que o endereço existe.
        console.warn(`[gateway-webhook] ${tipo}/${instancia}${unidade ? "/" + unidade : ""}: token recusado`);
        await anotar({
          estado: "recusado",
          http: 401,
          erro: resultado.semChave ? "gateway_sem_chave" : "token_nao_confere",
        });
        return res.status(401).send({ msg: "unauthorized" });
      }

      // ── APLICADO x IGNORADO ───────────────────────────────────────────
      //
      // O `feito` do cobrador conta o que houve. Os que começam por "sem_"
      // são avisos que chegaram inteiros e não acharam dono aqui — é o caso
      // que ninguém desconfia sozinho, e por isso ele tem estado próprio em
      // vez de se misturar aos que deram certo.
      const feito = resultado.feito || "ignorado";
      await anotar({
        estado: String(feito).startsWith("sem_") ? "ignorado" : "aplicado",
        feito,
        cobranca: resultado.cobranca || null,
        http: 200,
      });

      return res.send({ ok: true, feito });
    } catch (erro) {
      // 500 de propósito: isto é defeito NOSSO, e a reentrega do Asaas é a
      // segunda chance que não teríamos de outro jeito. `quitarCobranca` é
      // idempotente — a segunda passada devolve "já estava pago".
      console.error(`[gateway-webhook] ${tipo}/${instancia}:`, erro?.message || erro);
      await anotar({ estado: "erro", erro: erro?.message || String(erro), http: 500 });
      return res.status(500).send({ msg: "error" });
    }
  });
};

// Comparação de tempo fixo. `timingSafeEqual` exige o mesmo tamanho, então o
// tamanho é conferido antes — e ele, sozinho, não vaza nada que importe.
function confere(recebido, esperado) {
  const a = Buffer.from(String(recebido || ""));
  const b = Buffer.from(String(esperado || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
