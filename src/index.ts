import 'dotenv/config';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { GoogleGenAI } from '@google/genai';
import nodemailer from 'nodemailer';
import cron from 'node-cron';

// --- CONFIGURAÇÃO ---
const DB_FILENAME = 'monitor_oportunidades.db';

const FONTE_IPEA = {
    nome: 'IPEA',
    url: 'https://www.ipea.gov.br/portal/bolsas-de-pesquisa',
    cor: '#2980b9' // Azul
};

const FONTE_FNP = {
    nome: 'FNP',
    url: 'https://fnp.org.br/transparencia/documentos?cat=37',
    cor: '#e67e22' // Laranja
};

const FONTE_UNDP = {
    nome: 'UNDP',
    url: 'https://parceiros.undp.org.br/opportunities',
    cor: '#27ae60' // Verde
};

const FONTE_ICLEI = {
    nome: 'ICLEI',
    url: 'https://americadosul.iclei.org/trabalhe-conosco/?cat=15',
    cor: '#8e44ad' // Roxo
};

// --- INSTRUÇÃO PADRÃO ---
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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Configuração do Gmail (Nodemailer)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

interface Oportunidade {
    id_unico: string;
    titulo: string;
    prazo: string;
    fonte_nome: string;
    fonte_url: string;
    cor: string;
}

// --- BANCO DE DADOS ---
async function initDB(): Promise<Database> {
    const db = await open({ filename: DB_FILENAME, driver: sqlite3.Database });
    await db.exec(`
    CREATE TABLE IF NOT EXISTS oportunidades (
      id TEXT PRIMARY KEY,
      projeto TEXT,
      prazo TEXT,
      fonte TEXT,
      data_detectada DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
    return db;
}

// --- UTILITÁRIOS ---
function extrairJson(text: string): any[] {
    try {
        let limpo = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicio = limpo.indexOf('[');
        const fim = limpo.lastIndexOf(']');
        if (inicio === -1 || fim === -1) return [];
        limpo = limpo.substring(inicio, fim + 1);
        return JSON.parse(limpo);
    } catch (e) {
        console.error("⚠️ Erro ao parsear JSON:", e);
        return [];
    }
}

function gerarIdEstavel(fonteNome: string, titulo: string, prazo: string): string {
    const tituloLimpo = titulo
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');

    const slugTitulo = tituloLimpo.substring(0, 60);
    const slugPrazo = prazo ? prazo.replace(/[^0-9]/g, '') : '0000';

    return `${fonteNome}-${slugTitulo}-${slugPrazo}`;
}

async function consultarGemini(prompt: string): Promise<any[]> {
    try {
        const response = await ai.models.generateContent({
            model: 'models/gemini-flash-latest',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                tools: [
                    //{ googleSearch: {} },
                    { urlContext: {} },
                ]
            },
        });

        const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;
        return text ? extrairJson(text) : [];
    } catch (e) {
        console.error("Erro API Gemini:", e);
        return [];
    }
}

// --- NOVA FUNÇÃO DE EMAIL (DUPLO DISPARO) ---
async function enviarEmailResumo(oportunidades: Oportunidade[]) {
    if (!process.env.EMAIL_USER) return;

    // ======================================================
    // 1. ENVIO PARA CLIENTES (RESUMO AGRUPADO)
    // ======================================================
    if (process.env.EMAIL_CLIENTS) {
        const listaClientes = process.env.EMAIL_CLIENTS.split(',').map(e => e.trim());

        // Agrupa por fonte
        const resumoPorFonte = new Map<string, { nome: string, url: string, cor: string, qtd: number }>();
        oportunidades.forEach(op => {
            if (!resumoPorFonte.has(op.fonte_nome)) {
                resumoPorFonte.set(op.fonte_nome, {
                    nome: op.fonte_nome,
                    url: op.fonte_url,
                    cor: op.cor,
                    qtd: 0
                });
            }
            resumoPorFonte.get(op.fonte_nome)!.qtd++;
        });

        let htmlBlocos = '';
        resumoPorFonte.forEach((dados) => {
            htmlBlocos += `
                <div style="border-left: 6px solid ${dados.cor}; padding: 15px; margin-bottom: 20px; background-color: #f8f9fa; border-radius: 4px;">
                    <h3 style="margin: 0 0 5px 0; color: ${dados.cor};">${dados.nome}</h3>
                    <p style="margin: 0 0 10px 0; font-size: 14px; color: #555;">
                        Novos editais/vagas encontrados: <strong>${dados.qtd}</strong>
                    </p>
                    <a href="${dados.url}" style="background-color: ${dados.cor}; color: #fff; text-decoration: none; padding: 8px 15px; border-radius: 4px; font-size: 13px; font-weight: bold; display: inline-block;">
                        Acessar Site do ${dados.nome}
                    </a>
                </div>
            `;
        });

        const mailOptionsClientes = {
            from: `"Monitor de Editais" <${process.env.EMAIL_USER}>`,
            to: listaClientes,
            subject: `🔔 Novas Oportunidades Detectadas`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; color: #333;">
                    <h2 style="color: #2c3e50; border-bottom: 1px solid #eee; padding-bottom: 10px;">Atualização de Monitoramento</h2>
                    <p>O sistema detectou novas publicações nos seguintes sites:</p>
                    ${htmlBlocos}
                    <hr style="border: 0; border-top: 1px solid #eee; margin-top: 30px;" />
                    <p style="font-size: 12px; color: #888;">Monitoramento automático.</p>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptionsClientes);
            console.log(`📧 Email (Resumo) enviado para clientes: ${listaClientes.join(', ')}`);
        } catch (error) {
            console.error(`❌ Erro envio clientes:`, error);
        }
    }

    // ======================================================
    // 2. ENVIO PARA ADMIN (DETALHADO/DEBUG)
    // ======================================================
    if (process.env.EMAIL_ADMIN) {
        const listaAdmin = process.env.EMAIL_ADMIN.split(',').map(e => e.trim());

        const itensHtml = oportunidades.map(op => `
            <li style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px dashed #ccc;">
                <strong style="color: ${op.cor}">[${op.fonte_nome}]</strong> 
                <span style="font-size: 14px;">${op.titulo}</span><br>
                <small style="color: #666;">Data: ${op.prazo}</small><br>
                <small style="color: #999; font-size: 10px;">ID: ${op.id_unico}</small>
            </li>
        `).join('');

        const mailOptionsAdmin = {
            from: `"Monitor Debug" <${process.env.EMAIL_USER}>`,
            to: listaAdmin,
            subject: `🔧 DEBUG: ${oportunidades.length} Itens (Lista Completa)`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h3>Relatório Técnico de Execução</h3>
                    <p>Lista exata dos títulos capturados pela IA nesta rodada:</p>
                    <ul style="padding-left: 20px;">
                        ${itensHtml}
                    </ul>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptionsAdmin);
            console.log(`🔧 Email (Debug) enviado para admin: ${listaAdmin.join(', ')}`);
        } catch (error) {
            console.error(`❌ Erro envio admin:`, error);
        }
    }
}

// --- FUNÇÃO PRINCIPAL ---
async function checkSites() {
    console.log(`\n🕒 [${new Date().toLocaleString()}] Iniciando ciclo de verificação...`);

    const db = await initDB();
    const novasOportunidades: Oportunidade[] = [];

    try {
        // 1. IPEA
        console.log("🤖 [1/4] IPEA...");
        const dadosIPEA = await consultarGemini(`
            Acesse: ${FONTE_IPEA.url}
            Liste TUDO visível na lista (Chamadas públicas, Processos simplificados, etc) com "Situação: ABERTA" (ou parecido com ABERTA).
            Pegue o título azul da chamada pública (ex: "Chamada Pública n° 56/2025") e o Prazo de inscrição.
            Capture o título igual ele está na lista.
            Caso não haja nada, retorne [].
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // 2. FNP
        console.log("🤖 [2/4] FNP...");
        const dadosFNP = await consultarGemini(`
            Acesse: ${FONTE_FNP.url}
            Liste TODOS os itens da lista principal que não estejam encerrados.
            Para saber se está encerrado, verifique em baixo da data, em cima dos botões de Download azul, algo como "Status: Termo de referência encerrado", ou "Termo de referência encerrado.".
            Ignore os botões de Download azul e qualquer conteúdo dentro deles. 
            Capture título completo e data.
            O título está em cima da data.
            Caso não haja nada, retorne [].
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // 3. UNDP
        console.log("🤖 [3/4] UNDP...");
        const dadosUNDP = await consultarGemini(`
            Acesse: ${FONTE_UNDP.url}
            Liste TODAS as oportunidades visíveis.
            Capture apenas Título e Data Limite, IGUAL eles estão na lista (não tire nada).
            Caso não haja nada, retorne [].
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // 4. ICLEI
        console.log("🤖 [4/4] ICLEI...");
        const dadosICLEI = await consultarGemini(`
            Acesse: ${FONTE_ICLEI.url}
            Liste TODAS as Vagas/TdR/Licitações listadas.
            Capture o título completo e data.
            Caso não haja nada, retorne [].
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // Consolidação
        const todosResultados = [
            { fonte: FONTE_IPEA, dados: dadosIPEA },
            { fonte: FONTE_FNP, dados: dadosFNP },
            { fonte: FONTE_UNDP, dados: dadosUNDP },
            { fonte: FONTE_ICLEI, dados: dadosICLEI }
        ];

        for (const grupo of todosResultados) {
            for (const item of grupo.dados) {
                if (!item.titulo) continue;

                const idUnico = gerarIdEstavel(grupo.fonte.nome, item.titulo, item.prazo);

                const existe = await db.get('SELECT id FROM oportunidades WHERE id = ?', idUnico);
                if (!existe) {
                    console.log(`✨ [${grupo.fonte.nome}] DETECTADO: ${item.titulo.substring(0, 50)}...`);

                    await db.run('INSERT INTO oportunidades (id, projeto, prazo, fonte) VALUES (?, ?, ?, ?)',
                        idUnico, item.titulo, item.prazo, grupo.fonte.nome);

                    novasOportunidades.push({
                        id_unico: idUnico,
                        titulo: item.titulo,
                        prazo: item.prazo,
                        fonte_nome: grupo.fonte.nome,
                        fonte_url: grupo.fonte.url,
                        cor: grupo.fonte.cor
                    });
                }
            }
        }

        if (novasOportunidades.length > 0) {
            console.log(`📤 Processando envios de email (${novasOportunidades.length} itens)...`);
            await enviarEmailResumo(novasOportunidades);
        } else {
            console.log("✅ Ciclo finalizado. Nenhuma alteração.");
        }

    } catch (error) {
        console.error("❌ Erro fatal durante o ciclo:", error);
    } finally {
        await db.close();
    }
}

// --- MAIN ---
async function main() {
    console.log("🚀 Monitor Iniciado.");
    await checkSites();

    // A cada 6 horas
    cron.schedule('0 */6 * * *', async () => {
        try { await checkSites(); } catch (e) { console.error(e); }
    });

    console.log("⏳ Agendado para rodar a cada 6 horas.");
}

main();