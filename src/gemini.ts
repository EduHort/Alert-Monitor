import 'dotenv/config';
import { GoogleGenAI, UrlRetrievalStatus } from '@google/genai';
import { Fonte, ItemBruto } from './tipos';

const GEMINI_MODEL = 'models/gemini-flash-latest';
const GEMINI_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_CARACTERES_PAGINA = 100_000; // Corta páginas gigantes antes de mandar para a IA

// Criado sob demanda para que a validação do ambiente rode antes.
let cliente: GoogleGenAI | null = null;
function ia(): GoogleGenAI {
    if (!cliente) cliente = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return cliente;
}

// --- PROMPTS ---
const INSTRUCAO_JSON = `
    Retorne APENAS um Array JSON puro.

    Analise apenas a primeira página visível, ou seja, a página que aparece quando o site é aberto.
    Não navegue para páginas antigas ou paginação numerada (2, 3...).

    Estrutura obrigatória:
    [
      {
        "titulo": "O título completo e exato como aparece na lista.",
        "prazo": "Qualquer data associada (prazo, publicação ou validade)."
      }
    ]
`;

function montarPrompt(fonte: Fonte): string {
    return `
        Acesse: ${fonte.url}
        ${fonte.instrucao.trim()}
        Caso não haja nada, retorne [].
        NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
        ${INSTRUCAO_JSON}
    `;
}

function montarPromptComTexto(fonte: Fonte, texto: string): string {
    return `
        Abaixo, depois de "CONTEÚDO DA PÁGINA", está o texto extraído de ${fonte.url}.
        Analise SOMENTE esse texto — não use conhecimento prévio sobre o site.
        ${fonte.instrucao.trim()}
        Caso não haja nada, retorne [].
        NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
        ${INSTRUCAO_JSON}

        --- CONTEÚDO DA PÁGINA ---
        ${texto}
    `;
}

// --- LEITURA DA PÁGINA ---
const CABECALHOS_NAVEGADOR = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9'
};

async function baixarTexto(url: string): Promise<string> {
    const resposta = await fetch(url, {
        headers: CABECALHOS_NAVEGADOR,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (!resposta.ok) throw new Error(`o site respondeu HTTP ${resposta.status}`);

    const texto = htmlParaTexto(await resposta.text());
    if (!texto) throw new Error('a página foi baixada mas veio sem texto');

    return texto.substring(0, MAX_CARACTERES_PAGINA);
}

function htmlParaTexto(html: string): string {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        // O destino do link separa vaga de consultoria, então preserva o href.
        .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, rotulo) => `${rotulo} (${href}) `)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/(\s*\n\s*){3,}/g, '\n\n')
        .trim();
}

function extrairJson(text: string): ItemBruto[] {
    let limpo = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const inicio = limpo.indexOf('[');
    const fim = limpo.lastIndexOf(']');
    if (inicio === -1 || fim === -1) {
        throw new Error(`resposta sem array JSON: ${text.substring(0, 120)}`);
    }

    limpo = limpo.substring(inicio, fim + 1);
    const bruto = JSON.parse(limpo);
    if (!Array.isArray(bruto)) throw new Error('JSON retornado não é um array');

    return bruto
        .filter(item => item && typeof item.titulo === 'string' && item.titulo.trim() !== '')
        .map(item => ({
            titulo: String(item.titulo).trim(),
            prazo: item.prazo ? String(item.prazo).trim() : ''
        }));
}

/**
 * Lê uma fonte. Sites que bloqueiam o buscador do Google têm o HTML baixado
 * aqui e mandado como texto; o resto vai pelo urlContext.
 */
export async function lerFonte(fonte: Fonte): Promise<ItemBruto[]> {
    if (fonte.baixarHtml) {
        const texto = await baixarTexto(fonte.url);
        return consultarGemini(montarPromptComTexto(fonte, texto), false);
    }
    return consultarGemini(montarPrompt(fonte), true);
}

// Erros sobem para o chamador: falha de fonte precisa ser reportada, não virar lista vazia.
async function consultarGemini(prompt: string, usarUrlContext: boolean): Promise<ItemBruto[]> {
    const response = await ia().models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
            httpOptions: { timeout: GEMINI_TIMEOUT_MS },
            tools: usarUrlContext ? [{ urlContext: {} }] : undefined,
        },
    });

    const candidato = response?.candidates?.[0];

    // Quando o urlContext não consegue baixar a página, o modelo obedece o
    // "caso não haja nada, retorne []" e a fonte inacessível vira "nenhuma
    // novidade" para sempre. O metadado de recuperação é o único jeito de saber.
    const urls = candidato?.urlContextMetadata?.urlMetadata ?? [];
    const algumSucesso = urls.some(u => u.urlRetrievalStatus === UrlRetrievalStatus.URL_RETRIEVAL_STATUS_SUCCESS);
    if (urls.length > 0 && !algumSucesso) {
        const status = [...new Set(urls.map(u => u.urlRetrievalStatus ?? 'desconhecido'))].join(', ');
        throw new Error(`a IA não conseguiu acessar a página (${status})`);
    }

    const text = candidato?.content?.parts
        ?.map(p => p.text ?? '')
        .join('')
        .trim();

    if (!text) throw new Error('resposta vazia da API');
    return extrairJson(text);
}
