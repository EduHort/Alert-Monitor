/** Tipos compartilhados entre os módulos. */

export interface Fonte {
    nome: string;
    url: string;
    cor: string;
    instrucao: string;
    /**
     * Baixa o HTML aqui e manda o texto para a IA, em vez de deixar o urlContext
     * buscar a página. Necessário nos sites que bloqueiam o buscador do Google.
     */
    baixarHtml?: boolean;
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
