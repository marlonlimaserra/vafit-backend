# Uma condição por arquivo

*"em breve vamos ter um montão de condições, e tenho medo de dar conflito
quando outro programador for mexer; no SprintHub cada filtro é um arquivo
separado"* (10/10/2026).

Ele está certo, e o problema tem nome: **registro central**. Com um array só,
toda adição mexe nas mesmas linhas — duas pessoas acrescentando condições na
mesma semana conflitam sempre, e o conflito é no pior lugar possível, no meio
de uma lista onde um `>>>>>>>` passa despercebido na revisão.

## Como acrescentar uma condição

Crie um arquivo aqui e escreva o nome dela em
`lib/i18n/locales/<idioma>/condicoes.json`. **Só isso** — não há índice para
editar, nem lista para registrar: `index.js` lê a pasta.

```js
module.exports = {
  chave: "altura",          // o id; o nome mora em `condicoes.cond.altura`
  categoria: "contato",     // uma das de `categorias.js`
  icone: "Ruler",           // nome de ícone do lucide (o painel mapeia)
  tipo: "numero",           // booleano | opcao | texto | numero | data | pessoa
  campo: "height",          // o caminho no documento da PESSOA
};
```

Zero linha compartilhada: dois programadores acrescentando condições diferentes
na mesma tarde não se encontram em arquivo nenhum.

## O texto é DAQUI, e isso não é detalhe

O painel e o aplicativo não têm chave de tradução de condição nenhuma: o nome
da condição, o nome de cada operador, as palavras do sim/não e o nome de cada
opção saem prontos de `GET /people/conditions`, no idioma de quem pediu.

É um conserto, e a data é 10/10/2026: *"no app o filtro avançado ficou todo
bugado"*. O catálogo já era do servidor, mas a palavra morava no cliente — e o
app instalado, de uma hora antes, desenhou `cond_dieta_kcal` e `cat_frequencia`
crus para as dezesseis condições que tinham nascido naquela tarde. No painel
isso se conserta com um deploy; **no aplicativo exige recompilar e reinstalar**,
ou seja, toda condição nova nasceria quebrada no telefone até a próxima
publicação na loja.

Onde escrever, em cada um dos quatro idiomas:

| chave | o quê |
|---|---|
| `condicoes.cond.<chave>` | o nome da condição |
| `condicoes.cat.<chave>` | o nome da categoria (raro: elas quase não mudam) |
| `condicoes.op.<operador>` | o nome do operador — já existem todos |
| `condicoes.val.<valor>` | uma opção de `tipo: "opcao"` |
| `condicoes.sim.<chave>` / `condicoes.nao.<chave>` | as palavras de um booleano, quando "sim/não" lê mal ("Liberada/Bloqueada") |

`npm run i18n:check` **recusa** uma condição sem nome em qualquer idioma: a
lista de exigidas é gerada do próprio catálogo, então ela cobre as condições
que ainda nem foram escritas.

## Os campos opcionais, e quando cada um aparece

- **`padrao`** — o operador que vem escolhido. De nome se pergunta o que
  *contém*; de e-mail, se *existe*. Sem isto, o padrão seria por TIPO, e os dois
  são texto.
- **`opcoes`** — a lista fixa de um `tipo: "opcao"`. O tradutor recusa valor
  fora dela.
- **`fonte`** — as opções vêm de uma lista VIVA que o painel resolve
  (`"unidades"`). Nada de embutir no catálogo o que muda por conta e por
  pessoa.
- **`montar(valor, operador)`** — quando a condição não é um campo simples.
  Devolve o `$match` inteiro. É o caso de tudo que é derivado (acesso ao app é
  senha E não-bloqueado) e de tudo que precisa tratar a ausência de três
  formas (vazio, nulo, inexistente).
- **`precisaDoVinculo`** — o campo não mora na pessoa, e sim no vínculo com o
  profissional (hoje só o status). Avisa o modelo a subir a junção ANTES do
  filtro. Ela é cara, então não suba sem necessidade.

## O que NÃO fazer aqui

Nada neste arquivo vira caminho de consulta sem passar pelo `index.js`: é ele
que confere a chave, o operador e o tipo do valor. Um `montar` que recebesse
valor não validado seria o buraco que o catálogo existe para fechar — e por
isso a validação das `opcoes` roda **antes** dele.
