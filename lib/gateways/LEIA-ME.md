# Um gateway por arquivo

Crie um arquivo aqui e ele existe. Não há índice para editar nem lista para
registrar: `index.js` lê a pasta — mesma decisão de `lib/condicoes/`, e pela
mesma razão (um registro central faz toda adição mexer nas mesmas linhas).

```js
module.exports = {
  chave: "mercadopago",      // o id: banco, URL, tradução
  nome: "Mercado Pago",      // como a empresa se escreve
  ondePegar: "https://…",    // a tela onde a pessoa copia a chave dela
  formato: /^APP_USR-/,      // recusa antes de bater na rede
  async conferir(chave, buscar = fetch) { … },

  tokeniza: true,            // OPCIONAL: sabe guardar cartão (ver abaixo)
  cobranca: { … },           // OPCIONAL: sabe gerar fatura e assinatura
};
```

O `nome` NÃO passa por tradução, e isso é de propósito: "Asaas" e "Pagar.me"
são nomes de empresa, iguais nos quatro idiomas. O que mora em
`lib/i18n/locales/<idioma>/gateways.json` são as RECUSAS — e essas sim, nos
quatro.

## O AMBIENTE NÃO SE PERGUNTA. Ele se descobre

Esta é a decisão que vale a pena entender antes de mexer em qualquer coisa
aqui.

O caminho óbvio seria um seletor na tela: "sandbox / produção". Ele está
errado, e o jeito de ver isso é imaginar quem erra. Alguém cola a chave de
PRODUÇÃO e deixa marcado "sandbox" — porque está testando, e porque a cabeça
dele está em testar. O sistema acredita. O primeiro boleto gerado "só para
ver se funciona" é um boleto de verdade, com o nome da casa, na mão de um
aluno de verdade. Ninguém descobre no mesmo dia.

Então `conferir` **devolve** o ambiente, e a tela só mostra o que ele achou.
Cada gateway descobre do jeito dele, porque os dois são diferentes de verdade:

| gateway | como se sabe |
|---|---|
| Asaas | dois HOSTS separados; a chave vale num e dá 401 no outro — então se tenta os dois (sandbox primeiro) |
| Pagar.me | um host só; o PREFIXO decide (`sk_test_` é sandbox, `sk_` é produção) |

Se um dia aparecer um gateway em que os dois ambientes respondem à mesma
chave, a leitura segura é **sandbox** — é por isso que a lista do Asaas tem o
sandbox na frente.

## A chave é conferida ANTES de ser gravada

O controlador não grava o que não passou por `conferir`. Uma chave torta
guardada com cara de "conectado" só falha na primeira cobrança de verdade —
longe daqui, no pior momento, e para quem não configurou nada.

`conferir` distingue dois fracassos, e a distinção importa:

- `chave_invalida` (401/403) — é a chave. Trocar resolve.
- `fora_do_ar` (rede, tempo esgotado, 500 deles) — **não é a chave**. Dizer
  "chave inválida" aqui manda a pessoa trocar uma chave boa, e ela vai
  procurar o problema onde ele não está.

## A chave NUNCA volta para a tela

`PaymentGateway_model.paraTela` existe para isso e é o único caminho que o
controlador usa. O que a tela recebe são os seis últimos caracteres e — quando
o gateway sabe dizer — o nome e o e-mail da conta, que identificam melhor e não
são segredo.

Quem precisa da chave de verdade é só a camada que vai COBRAR, e ela a pede
por `ativo()`, que é o único método que a lê do banco.

## Um ativo, e o banco é quem garante

"Só vai poder escolher por onde as faturas e assinaturas serão geradas": no
máximo um gateway ativo por cliente. Isso não é um `if` no modelo — é índice
único parcial (`{ instance, ativo }` com `ativo: true`), em `database/schema.js`.
Um `if` perde a corrida entre duas abas, e o estrago é silencioso: dois ativos,
e a cobrança sai por quem o `findOne` devolver primeiro naquele dia.

## `tokeniza` é capacidade; a liberação é declarada

O Asaas só tokeniza cartão numa conta em que a função foi **liberada pelo
suporte dele** — a casa abre um chamado e pede. Não existe, na API, nada que
responda "a minha conta pode?".

Então são duas coisas separadas, e confundi-las dá uma tela que mente:

| o quê | onde | quem responde |
|---|---|---|
| `tokeniza` | aqui, no arquivo do gateway | nós: *este gateway sabe guardar cartão* |
| `tokenizacao` | a linha no banco, por gateway e por unidade | a casa: *a minha conta já foi liberada* |

Isto é o contrário do ambiente, e de propósito. O ambiente **se descobre**
porque dá para perguntar (a chave responde 401 num host e 200 no outro); a
liberação **se declara** porque não dá. Onde existe pergunta, não se pergunta
à pessoa; onde não existe, não se inventa uma descoberta.

A declaração é apagada sozinha num caso só: quando a chave colada é de
**outra conta** (o CPF/CNPJ do titular mudou). Ver `salvar` no modelo.
