import 'dotenv/config';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { GoogleGenAI } from '@google/genai';
import nodemailer from 'nodemailer';

// --- CONFIGURAÇÃO ---
const DB_FILENAME = 'monitor_oportunidades.db';

const FONTE_IPEA = {
    nome: 'IPEA',
    url: 'https://www.ipea.gov.br/portal/bolsas-de-pesquisa'
};

const FONTE_FNP = {
    nome: 'FNP',
    url: 'https://fnp.org.br/transparencia/documentos?cat=37'
};

// --- PADRONIZAÇÃO DE FORMATO (JSON) ---
const INSTRUCAO_JSON = `
    Retorne APENAS um Array JSON puro (sem markdown, sem texto introdutório).
    Use EXATAMENTE as chaves abaixo para os objetos:
    [
      {
        "numero": "O identificador (ex: Edital 01/2025, TR 10/2025, Chamada 03...)",
        "projeto": "Título resumido do projeto ou vaga",
        "prazo": "Para IPEA: prazo de inscrição. Para FNP: data de publicação (ex: 'Publ. 10/11/2025')"
      }
    ]
`;

// Inicializa o Client do Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Configuração do Email
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

interface Oportunidade {
    id_unico: string;
    numero: string;
    projeto: string;
    prazo: string;
    fonte_nome: string;
    fonte_url: string;
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

// --- FUNÇÃO DE LIMPEZA DO JSON ---
function extrairJson(text: string): any[] {
    try {
        let limpo = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicio = limpo.indexOf('[');
        const fim = limpo.lastIndexOf(']');

        if (inicio === -1 || fim === -1) return [];

        limpo = limpo.substring(inicio, fim + 1);
        return JSON.parse(limpo);
    } catch (e) {
        console.error("⚠️ Erro ao limpar/parsear JSON:", e);
        return [];
    }
}

// --- CONSULTA GEMINI ---
async function consultarGemini(prompt: string): Promise<any[]> {
    try {
        const response = await ai.models.generateContent({
            model: 'models/gemini-flash-lite-latest',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                tools: [
                    { googleSearch: {} },
                    { urlContext: {} },
                ]
            },
        });

        const text = response?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) return [];

        return extrairJson(text);
    } catch (e) {
        console.error("Erro na API Gemini:", e);
        return [];
    }
}

// --- ENVIO DE EMAIL ---
async function enviarEmailResumo(oportunidades: Oportunidade[]) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_TO) {
        console.warn("⚠️ Email não configurado.");
        return;
    }

    const itensHtml = oportunidades.map(op => `
        <li style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #eee;">
            <div style="font-size: 10px; font-weight: bold; text-transform: uppercase; color: #fff; background-color: ${op.fonte_nome === 'IPEA' ? '#2980b9' : '#e67e22'}; padding: 2px 6px; display: inline-block; border-radius: 3px; margin-bottom: 5px;">
                ${op.fonte_nome}
            </div>
            <div style="font-size: 16px; font-weight: bold; color: #333;">${op.numero}</div>
            <div style="color: #555; margin: 5px 0;">${op.projeto}</div>
            <div style="font-size: 0.9em; color: #777;">📅 ${op.prazo}</div>
            <div style="margin-top: 5px;">
                <a href="${op.fonte_url}" style="font-size: 12px; color: ${op.fonte_nome === 'IPEA' ? '#2980b9' : '#e67e22'}; text-decoration: none;">➜ Ver na fonte</a>
            </div>
        </li>
    `).join('');

    const mailOptions = {
        from: `"Monitor de Editais" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_TO,
        subject: `🔔 ${oportunidades.length} Novas Oportunidades Encontradas`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px;">
                <h2 style="color: #2c3e50;">Novas Oportunidades</h2>
                <ul style="list-style: none; padding-left: 0;">${itensHtml}</ul>
                <p style="font-size: 12px; color: #888;">Monitoramento Gemini AI.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧 Email enviado.`);
    } catch (error) {
        console.error(`❌ Erro email:`, error);
    }
}

// --- FLUXO PRINCIPAL ---
async function main() {
    const db = await initDB();
    const novasOportunidades: Oportunidade[] = [];

    // ===============================================
    // 1. IPEA (Filtra por Prazo Aberto)
    // ===============================================
    console.log("🤖 Analisando IPEA...");
    const promptIPEA = `
        Acesse: ${FONTE_IPEA.url}
        Identifique Chamadas Públicas com inscrições ABERTAS.
        Ignore chamadas com prazo encerrado.
        ${INSTRUCAO_JSON}
    `;
    const dadosIPEA = await consultarGemini(promptIPEA);

    for (const item of dadosIPEA) {
        if (!item.numero) continue;
        const idUnico = `IPEA-${item.numero}`;

        const existe = await db.get('SELECT id FROM oportunidades WHERE id = ?', idUnico);
        if (!existe) {
            console.log(`✨ [IPEA] NOVO: ${item.numero}`);
            await db.run('INSERT INTO oportunidades (id, projeto, prazo, fonte) VALUES (?, ?, ?, ?)',
                idUnico, item.projeto, item.prazo, 'IPEA');

            novasOportunidades.push({
                id_unico: idUnico,
                numero: item.numero,
                projeto: item.projeto,
                prazo: item.prazo,
                fonte_nome: FONTE_IPEA.nome,
                fonte_url: FONTE_IPEA.url
            });
        }
    }

    // ===============================================
    // 2. FNP (Filtra por Status Textual)
    // ===============================================
    console.log("🤖 Analisando FNP...");
    const promptFNP = `
        Acesse: ${FONTE_FNP.url}
        
        Liste: Termos de Referência (TR), Editais, Cotações, Processos Seletivos ou outros.
        
        REGRAS DE FILTRO:
        1. Verifique o texto ao lado ou abaixo de cada item.
        2. Se contiver palavras como "Encerrado", "Finalizado" ou "Concluído", IGNORE este item.
        3. Queremos apenas itens que parecem estar ABERTOS ou que foram lançados muito recentemente e não têm aviso de encerramento.
        
        CAMPO 'PRAZO':
        Como não há data limite explícita, capture a Data de Publicação e retorne no formato: "Publicado em dd/mm/aaaa".
        
        ${INSTRUCAO_JSON}
    `;

    const dadosFNP = await consultarGemini(promptFNP);

    for (const item of dadosFNP) {
        if (!item.numero) continue;
        const idUnico = `FNP-${item.numero}`;

        const existe = await db.get('SELECT id FROM oportunidades WHERE id = ?', idUnico);
        if (!existe) {
            console.log(`✨ [FNP] NOVO: ${item.numero}`);
            await db.run('INSERT INTO oportunidades (id, projeto, prazo, fonte) VALUES (?, ?, ?, ?)',
                idUnico, item.projeto, item.prazo, 'FNP');

            novasOportunidades.push({
                id_unico: idUnico,
                numero: item.numero,
                projeto: item.projeto,
                prazo: item.prazo,
                fonte_nome: FONTE_FNP.nome,
                fonte_url: FONTE_FNP.url
            });
        }
    }

    // ===============================================
    // 3. ENVIO CONSOLIDADO
    // ===============================================
    if (novasOportunidades.length > 0) {
        console.log(`📤 Enviando email com ${novasOportunidades.length} itens...`);
        await enviarEmailResumo(novasOportunidades);
    } else {
        console.log("✅ Nenhuma novidade encontrada.");
    }

    await db.close();
}

main();