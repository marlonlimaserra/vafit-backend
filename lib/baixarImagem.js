// COPIAR OS BYTES DE UMA IMAGEM DE FORA.
//
// A regra que este arquivo existe para cumprir: **guardar os BYTES, nunca a
// URL**. URL de CDN de rede social carrega assinatura com prazo — funciona no
// dia em que a pessoa conectou e vira quadradinho quebrado depois, sem nada
// ter acontecido do nosso lado.
//
// *"ao conectar o facebook quebrou a imagem, salve a imagem e faça o upload e
// deixe o link fixo"* (15/10/2026), com o print das quatro Páginas sem foto.
//
// Nasceu dentro de `lib/fotoDoWhatsapp.js`, que tinha a mesma necessidade
// primeiro. Saiu de lá quando a Página do Facebook virou o segundo caso: a
// alternativa era uma segunda cópia das mesmas três guardas, e a terceira
// cópia viria com um limite diferente que ninguém notaria.
const TEMPO_LIMITE = 10000;

// Teto dos bytes que aceito baixar.
//
// Foto de perfil é pequena — as maiores que já vi têm uns 100 KB. Um teto de
// 2 MB cobre folgado e ainda protege de um host respondendo outra coisa (um
// HTML de erro, um redirecionamento para uma página inteira).
const MAX_BYTES = 2 * 1024 * 1024;

// O que o navegador exibe sem plugin. SVG fica de fora: é documento
// executável, não imagem, e serviria script na nossa origem.
const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Devolve `{ mime, bytes }` ou `null`. NUNCA lança: quem chama está no meio de
// conectar uma conta ou de cadastrar uma pessoa, e perder a foto é perder um
// enfeite — perder a operação é perder o trabalho de quem clicou.
async function baixar(url, { chamar = fetch } = {}) {
  if (!/^https:\/\//i.test(String(url || ""))) return null;

  try {
    const res = await chamar(url, { signal: AbortSignal.timeout(TEMPO_LIMITE) });
    if (!res.ok) return null;

    const mime = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!MIMES.has(mime)) return null;

    // O `content-length` é conferido ANTES de ler o corpo: é o que evita puxar
    // 40 MB para descobrir no fim que era grande demais.
    const tamanho = Number(res.headers.get("content-length"));
    if (Number.isFinite(tamanho) && tamanho > MAX_BYTES) return null;

    const bytes = Buffer.from(await res.arrayBuffer());
    // E de novo depois, porque o cabeçalho pode faltar ou mentir.
    if (!bytes.length || bytes.length > MAX_BYTES) return null;

    return { mime, bytes };
  } catch (erro) {
    return null;
  }
}

module.exports = { baixar, MAX_BYTES, MIMES, TEMPO_LIMITE };
