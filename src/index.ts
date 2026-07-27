import 'dotenv/config';
import cron from 'node-cron';
import { Fonte, Oportunidade, Falha } from './tipos';
import { initDB, registrarItens, buscarPendentes, marcarNotificadas, limparAntigas } from './db';
import { lerFonte } from './gemini';
import { enviarEmails, verificarConexao, EMAIL_CLIENTS, EMAIL_ADMIN } from './email';

// --- CONFIGURAÇÃO ---
const CRON_EXPRESSION = '0 */6 * * *'; // A cada 6 horas
const TIMEZONE = 'America/Sao_Paulo';

const FONTES: Fonte[] = [
    {
        nome: 'IPEA',
        url: 'https://www.ipea.gov.br/portal/bolsas-de-pesquisa',
        cor: '#2980b9', // Azul
        instrucao: `
            Liste os itens da primeira página cuja situação seja ABERTA.
            Cada item traz: Título, Objeto, "Situação: ABERTA" ou "Situação: FECHADA", Programa, Ano e Prazo de inscrição.
            IGNORE todos os itens com "Situação: FECHADA" — a lista é ordenada por data e mistura os dois.
            Use como "titulo" o título da chamada exatamente como aparece (ex: "Chamada Pública nº 024/2026",
            "Processo Seletivo Simplificado para Pesquisadores Internacionais IPEA/PIPA").
            Use como "prazo" o Prazo de inscrição inteiro, com as duas datas (ex: "09/07/2026 a 27/07/2026").
            Alguns itens ABERTA não têm prazo publicado: nesse caso devolva "prazo": "".
        `
    },
    {
        nome: 'FNP',
        url: 'https://fnp.org.br/transparencia/documentos?cat=37',
        cor: '#e67e22', // Laranja
        instrucao: `
            Liste os chamamentos públicos da primeira página.
            Cada item tem um título (ex: "Chamamento Público Nº 04/2026"), uma data no formato DD/MM/AA
            logo abaixo do título, e um parágrafo descrevendo o objeto da contratação.
            Use como "titulo" o título do chamamento e como "prazo" essa data.
            Ignore os botões azuis de Download e qualquer texto dentro deles.
            NÃO liste itens encerrados ou cancelados. O sinal pode ser um texto de status abaixo da data
            (algo como "Termo de referência encerrado") ou um documento anexo "Comunicado de Cancelamento".
            Na ausência de qualquer um desses sinais, considere o item ativo e inclua na lista.
        `
    },
    {
        nome: 'UNDP',
        url: 'https://parceiros.undp.org.br/opportunities',
        cor: '#27ae60', // Verde
        // A listagem é renderizada por JavaScript (SPA Angular): o HTML servido vem vazio.
        // Depende da IA conseguir renderizar a página antes de ler.
        instrucao: `
            A lista de oportunidades é uma TABELA carregada dinamicamente, com colunas de
            título/descrição, localidade e data limite, e um paginador embaixo.
            Liste as oportunidades da primeira página da tabela.
            Os títulos costumam ter o formato "PCT BRA 25/005 – TR nº 003/2026 – SUPEN/MDA – Contratação de
            Consultoria Especializada para ..." — use como "titulo" o título inteiro, sem cortar nada.
            Use como "prazo" a data limite da oportunidade.
            Se a tabela não carregar ou aparecer vazia, retorne [] — NÃO invente oportunidades
            e NÃO use conhecimento prévio sobre o site.
        `
    },
    {
        nome: 'ICLEI Editais',
        url: 'https://americadosul.iclei.org/editais/',
        cor: '#8e44ad', // Roxo
        instrucao: `
            Liste os editais e chamadas públicas da página.
            Cada item tem um título, um parágrafo de descrição e um prazo escrito por extenso
            (ex: "Esta chamada está aberta até o dia 26 de Julho de 2026, às 23h59").
            Use como "titulo" o título do edital e como "prazo" APENAS a data, sem a frase em volta
            (do exemplo acima, o prazo seria "26 de Julho de 2026, às 23h59").
            Ignore os links para os PDFs de termo de referência.
        `
    },
    {
        nome: 'ICLEI Carreira',
        url: 'https://americadosul.iclei.org/carreira/',
        cor: '#9b59b6', // Roxo claro
        instrucao: `
            Liste todas as oportunidades abertas, sem filtrar por aba
            (as abas são Consultorias, Contratação, Estágio, Vagas, Voluntariado — considere TODAS).
            Cada item tem título, descrição, prazo (ex: "30 de julho de 2026, às 23h59 (GMT-3)"),
            localidade, tipo de contratação e modalidade.
            Use como "titulo" o título da oportunidade e como "prazo" a data de encerramento das inscrições.
        `
    },
    {
        nome: 'WRI',
        url: 'https://www.wribrasil.org.br/trabalhe-conosco',
        cor: '#d4ac0d', // Amarelo escuro
        instrucao: `
            A página tem DUAS seções: "Vagas abertas" e "Oportunidades de consultoria". Liste os itens das duas.
            ATENÇÃO: os itens NÃO têm data nenhuma — cada um é só um título com um link
            (Workday nas vagas, PDF nas consultorias). Não invente datas.
            Use como "titulo" o título exato, prefixado pela seção de origem:
            "[Vaga] <título>" para a primeira seção e "[Consultoria] <título>" para a segunda.
            Devolva sempre "prazo": "".
            Nos links entre parênteses, "myworkdayjobs.com" indica vaga e um arquivo .pdf indica consultoria.
        `,
        // O urlContext recebe URL_RETRIEVAL_STATUS_ERROR neste site, mas um GET normal funciona.
        baixarHtml: true
    }
];

const FONTES_POR_NOME = new Map(FONTES.map(f => [f.nome, f]));

// Uma fonte removida da config pode ter deixado pendências no banco.
const FONTE_DESCONHECIDA = (nome: string): Fonte => ({ nome, url: '#', cor: '#7f8c8d', instrucao: '' });

// --- AMBIENTE ---
function validarAmbiente(): void {
    const faltando = ['GEMINI_API_KEY', 'EMAIL_USER', 'EMAIL_PASS'].filter(v => !process.env[v]);
    if (EMAIL_CLIENTS.length === 0 && EMAIL_ADMIN.length === 0) {
        faltando.push('EMAIL_CLIENTS ou EMAIL_ADMIN');
    }
    if (faltando.length > 0) {
        console.error(`❌ Variáveis de ambiente ausentes: ${faltando.join(', ')}`);
        console.error('   Preencha o arquivo .env (veja .env_example) antes de iniciar.');
        process.exit(1);
    }
}

// --- CICLO ---
let executando = false;

async function checkSites(): Promise<void> {
    if (executando) {
        console.warn('⏭️ Ciclo anterior ainda em execução. Pulando esta rodada.');
        return;
    }
    executando = true;

    console.log(`\n🕒 [${new Date().toLocaleString('pt-BR', { timeZone: TIMEZONE })}] Iniciando ciclo de verificação...`);

    const db = await initDB();
    const falhas: Falha[] = [];

    try {
        console.log(`🤖 Consultando ${FONTES.length} fontes em paralelo...`);
        const resultados = await Promise.allSettled(FONTES.map(fonte => lerFonte(fonte)));

        for (let i = 0; i < FONTES.length; i++) {
            const fonte = FONTES[i];
            const resultado = resultados[i];

            if (resultado.status === 'rejected') {
                const erro = resultado.reason instanceof Error ? resultado.reason.message : String(resultado.reason);
                console.error(`❌ [${fonte.nome}] falhou: ${erro}`);
                falhas.push({ fonte: fonte.nome, erro });
                continue;
            }

            const novos = await registrarItens(db, fonte, resultado.value);
            console.log(`✅ [${fonte.nome}] ${resultado.value.length} item(ns) lido(s), ${novos} novo(s).`);
        }

        const pendentes: Oportunidade[] = (await buscarPendentes(db)).map(p => ({
            id_unico: p.id_unico,
            titulo: p.titulo,
            prazo: p.prazo,
            fonte: FONTES_POR_NOME.get(p.fonteNome) ?? FONTE_DESCONHECIDA(p.fonteNome)
        }));

        if (pendentes.length > 0 || falhas.length > 0) {
            console.log(`📤 Processando envios de email (${pendentes.length} pendente(s), ${falhas.length} falha(s))...`);
            const entregue = await enviarEmails(pendentes, falhas);
            if (entregue) {
                await marcarNotificadas(db, pendentes.map(p => p.id_unico));
            } else {
                console.warn('⚠️ Envio falhou. As oportunidades continuam pendentes para o próximo ciclo.');
            }
        } else {
            console.log('✅ Ciclo finalizado. Nenhuma alteração.');
        }

        await limparAntigas(db);
    } catch (error) {
        console.error('❌ Erro fatal durante o ciclo:', error);
    } finally {
        await db.close();
        executando = false;
    }
}

// --- MAIN ---
async function main(): Promise<void> {
    console.log('🚀 Monitor Iniciado.');
    validarAmbiente();

    try {
        await verificarConexao();
        console.log('✉️ Conexão SMTP verificada.');
    } catch (error) {
        console.warn('⚠️ Não foi possível verificar a conexão SMTP:', error);
    }

    await checkSites();

    const tarefa = cron.schedule(CRON_EXPRESSION, checkSites, { timezone: TIMEZONE });
    console.log(`⏳ Agendado: "${CRON_EXPRESSION}" (${TIMEZONE}).`);

    const encerrar = (sinal: string) => {
        console.log(`\n👋 Recebido ${sinal}. Encerrando...`);
        tarefa.stop();
        process.exit(0);
    };
    process.on('SIGINT', () => encerrar('SIGINT'));
    process.on('SIGTERM', () => encerrar('SIGTERM'));
}

process.on('unhandledRejection', (motivo) => console.error('❌ Promise rejeitada sem tratamento:', motivo));
process.on('uncaughtException', (erro) => console.error('❌ Exceção não capturada:', erro));

main().catch(erro => {
    console.error('❌ Falha ao iniciar o monitor:', erro);
    process.exit(1);
});
