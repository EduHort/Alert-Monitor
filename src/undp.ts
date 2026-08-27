import { ItemBruto } from './tipos';

/**
 * A página de oportunidades do PNUD é um SPA Angular: o HTML servido vem sem
 * dado nenhum e a IA não conseguia lê-la (URL_RETRIEVAL_STATUS_ERROR em toda
 * rodada). Esta é a mesma API que a tabela do site consome — aberta, sem
 * autenticação, com os títulos e prazos exatos.
 *
 * É uma API interna: pode mudar sem aviso. Como o ciclo trata falha por fonte,
 * uma quebra aqui vira um aviso no email de debug, não uma parada geral.
 */
const API_URL = 'https://icnim-api.undp.org.br/v1/Publish/list/active';
const TIMEOUT_MS = 30_000;

interface PublicacaoUndp {
    title?: string;
    endDate?: string;
    enabled?: boolean;
}

// "2026-08-16T03:00:00" -> "16/08/2026". Só a parte da data: o horário vem em
// UTC e converter para Date arriscaria puxar o prazo um dia para trás.
function formatarPrazo(iso?: string): string {
    const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
    return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : '';
}

export async function lerUndp(): Promise<ItemBruto[]> {
    const resposta = await fetch(API_URL, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!resposta.ok) throw new Error(`a API respondeu HTTP ${resposta.status}`);

    const dados: unknown = await resposta.json();
    if (!Array.isArray(dados)) throw new Error('a API não devolveu uma lista');

    return (dados as PublicacaoUndp[])
        .filter(item => item?.enabled !== false && typeof item?.title === 'string' && item.title.trim() !== '')
        .map(item => ({
            titulo: item.title!.trim(),
            prazo: formatarPrazo(item.endDate)
        }));
}
