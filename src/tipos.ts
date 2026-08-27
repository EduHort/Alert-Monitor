/** Tipos compartilhados entre os módulos. */

export interface Fonte {
    nome: string;
    url: string;
    cor: string;
    /** Instrução para a IA. Dispensável nas fontes que têm leitor próprio (`ler`). */
    instrucao?: string;
    /**
     * Baixa o HTML aqui e manda o texto para a IA, em vez de deixar o urlContext
     * buscar a página. Necessário nos sites que bloqueiam o buscador do Google.
     */
    baixarHtml?: boolean;
    /**
     * Leitor próprio: quando existe, a fonte é lida por ele e a IA não entra.
     * Serve para os sites que expõem uma API — o dado vem exato e de graça.
     */
    ler?: () => Promise<ItemBruto[]>;
}

/** Item cru, do jeito que a IA devolveu. */
export interface ItemBruto {
    titulo: string;
    prazo: string;
}

/** Oportunidade pronta para virar email, já ligada à sua fonte. */
export interface Oportunidade {
    id_unico: string;
    titulo: string;
    prazo: string;
    fonte: Fonte;
}

/** Linha pendente de notificação, como sai do banco (sem a config da fonte). */
export interface PendenteDb {
    id_unico: string;
    titulo: string;
    prazo: string;
    fonteNome: string;
}

export interface Falha {
    fonte: string;
    erro: string;
}
