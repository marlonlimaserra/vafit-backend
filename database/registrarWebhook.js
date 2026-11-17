require("dotenv").config();

const instanceContext = require("../lib/instance.js");
const appModels = require("../appModels.js");
const defaultModules = require("../defaultModules.js");

// REGISTRA (OU CONSERTA) O AVISO DE PAGAMENTO DE UMA CONTA — à mão.
//
// Nasceu em 19/10/2026, quando ele pediu *"faz você aí"* em vez de abrir a
// tela e salvar a chave de novo. O que ele conserta na prática apareceu na
// mesma hora: a conta tinha DOIS webhooks nossos — o da casa, completo, e o
// de uma unidade com conta própria, parado nos 10 eventos de antes da
// expansão de 15/10. Dez eventos querem dizer que a maioria dos avisos
// simplesmente não chegava àquela unidade.
//
// ── POR QUE UM SCRIPT, E NÃO UM CURL NA API DO ASAAS ──────────────────────
//
// Porque o webhook carrega um SEGREDO que o nosso lado confere em cada aviso
// (`authToken`). Registrá-lo com um segredo que o banco não conhece criaria
// um webhook que o Asaas entrega e nós recusamos — pior que não ter nenhum,
// porque de fora parece configurado.
//
// Este script chama exatamente o que a tela chama. Idempotente por URL:
// rodar duas vezes não cria dois, e completa os eventos que faltarem.
//
// ── POR QUE NÃO VARRE TODAS AS CONTAS ─────────────────────────────────────
//
// Porque cada chamada fala com a conta de um cliente de verdade, no ambiente
// de PRODUÇÃO dele. Uma varredura que "conserta tudo" é a que um dia mexe na
// conta errada. A instância vem no argumento, sempre.
//
//   node database/registrarWebhook.js <instancia> [unidade]
//
// A unidade só quando ela tem conta PRÓPRIA — sem ela, o webhook é o da casa.
const app = {};
app.mongodb = require("../config/mongodb.js");
for (const k in defaultModules) app[k] = defaultModules[k];
app.api = {};
for (const k in appModels) app.api[k] = new appModels[k](app);

const [, , instancia, unidade] = process.argv;

if (!instancia) {
  console.error("uso: node database/registrarWebhook.js <instancia> [unidade]");
  process.exit(1);
}

instanceContext.run(instancia, async () => {
  const r = await app.api.cobrador.registrarWebhook("asaas", unidade || null, instancia);

  // A URL e o resultado. NUNCA a chave nem o segredo — este log vai parar no
  // terminal de quem rodou, e um deles basta para cobrar em nome da casa.
  console.log(
    JSON.stringify(
      {
        instancia,
        unidade: unidade || null,
        ok: r.ok,
        ja: r.ja || false,
        atualizado: r.atualizado || false,
        eventosNovos: r.eventosNovos || 0,
        erro: r.erro || "",
      },
      null,
      2
    )
  );

  process.exit(r.ok ? 0 : 2);
});
