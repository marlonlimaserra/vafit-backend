// O CPF: limpar e CONFERIR OS DÍGITOS.
//
// Nasceu com a assinatura de plano pela vitrine (14/10/2026), onde o CPF é a
// chave que diz "você já é aluno daqui". Até então o produto só MASCARAVA o
// CPF (`vafit-frontend/src/lib/documentoMascara.js`) — mostrava os pontos e
// aceitava qualquer sequência de onze dígitos.
//
// ── POR QUE CONFERIR, E NÃO SÓ CONTAR ONZE ───────────────────────────────
//
// Porque numa rota pública esta conta vale por três coisas:
//
//   1. UM DÍGITO TROCADO não vira pessoa nova. "11144477735" digitado errado
//      passa a ser recusado na hora, e não cadastrado como um segundo aluno
//      que ninguém vai encontrar depois.
//   2. A BUSCA É UM ORÁCULO. Quem quiser varrer a base da academia precisa de
//      CPFs válidos, e os dígitos cortam 99% das tentativas cegas antes de
//      qualquer consulta ao banco.
//   3. O GATEWAY RECUSA depois. O Asaas exige `cpfCnpj` válido para emitir
//      boleto ou pix; descobrir isso na hora de cobrar é descobrir tarde, com
//      a pessoa já matriculada e o dado errado gravado.
//
// ── O QUE ELA NÃO FAZ ────────────────────────────────────────────────────
//
// Não diz se o CPF EXISTE — isso só a Receita sabe, e não é pergunta que se
// faça numa página de venda. Ela diz que o número é bem formado, o que é
// outra coisa e é o que dá para saber de graça.
const TAMANHO = 11;

// Todos os dígitos iguais passam na conta dos verificadores — 111.111.111-11
// fecha certinho. São onze sequências, e todas são lixo conhecido.
const REPETIDO = /^(\d)\1{10}$/;

function limpar(valor) {
  return String(valor || "").replace(/\D/g, "");
}

// O dígito verificador: soma ponderada decrescente, resto 11, e 10 ou 11 viram
// zero. Vale para os dois dígitos — só muda por onde o peso começa.
function digito(base, pesoInicial) {
  let soma = 0;
  for (let i = 0; i < base.length; i += 1) soma += Number(base[i]) * (pesoInicial - i);

  const resto = (soma * 10) % 11;
  return resto >= 10 ? 0 : resto;
}

function valido(valor) {
  const so = limpar(valor);
  if (so.length !== TAMANHO || REPETIDO.test(so)) return false;

  return digito(so.slice(0, 9), 10) === Number(so[9]) && digito(so.slice(0, 10), 11) === Number(so[10]);
}

// Como se escreve numa tela: 111.444.777-35. Guardamos os DÍGITOS e formatamos
// na leitura — um documento guardado com pontuação não casa com o mesmo
// documento digitado sem ela, e a busca por CPF é justamente o que esta
// biblioteca existe para servir.
function formatar(valor) {
  const so = limpar(valor);
  if (so.length !== TAMANHO) return so;

  return `${so.slice(0, 3)}.${so.slice(3, 6)}.${so.slice(6, 9)}-${so.slice(9)}`;
}

module.exports = { limpar, valido, formatar, TAMANHO };
