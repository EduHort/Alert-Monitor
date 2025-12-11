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

    Analise apenas a primeira página, ou seja, a página que aparece quando o site é aberto.
    Não navegue para páginas 2, 3, "Pŕoxima" ou similares.

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
    // 1. Normaliza Título
    const tituloLimpo = titulo
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');

    // 2. Pega os primeiros 60 caracteres
    const slugTitulo = tituloLimpo.substring(0, 60);

    // 3. Normaliza Data (apenas números)
    const slugPrazo = prazo ? prazo.replace(/[^0-9]/g, '') : '0000';

    // ID Final
    return `${fonteNome}-${slugTitulo}-${slugPrazo}`;
}

async function consultarGemini(prompt: string): Promise<any[]> {
    try {
        const response = await ai.models.generateContent({
            model: 'models/gemini-flash-latest',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                tools: [
                    { googleSearch: {} },
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

// --- EMAIL ---
async function enviarEmailResumo(oportunidades: Oportunidade[]) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_TO) return;

    // 1. Agrupar oportunidades por Fonte
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

    // 2. Criar HTML simplificado (Card por Fonte)
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

    // 3. Preparar envio
    const listaDestinatarios = process.env.EMAIL_TO.split(',').map(email => email.trim());

    const mailOptions = {
        from: `"Monitor de Editais" <${process.env.EMAIL_USER}>`,
        to: listaDestinatarios,
        subject: `🔔 Novas Oportunidades Detectadas`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; color: #333;">
                <h2 style="color: #2c3e50; border-bottom: 1px solid #eee; padding-bottom: 10px;">Atualização de Monitoramento</h2>
                <p>O sistema detectou novas publicações nos seguintes sites:</p>
                
                ${htmlBlocos}

                <hr style="border: 0; border-top: 1px solid #eee; margin-top: 30px;" />
                <p style="font-size: 12px; color: #888;">Monitoramento automático Gemini AI.</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧 Email simplificado enviado para: ${listaDestinatarios.join(', ')}`);
    } catch (error) {
        console.error(`❌ Erro email:`, error);
    }
}

// --- FUNÇÃO PRINCIPAL DE VERIFICAÇÃO ---
async function checkSites() {
    console.log(`\n🕒 [${new Date().toLocaleString()}] Iniciando ciclo de verificação...`);

    // Abre conexão para este ciclo
    const db = await initDB();
    const novasOportunidades: Oportunidade[] = [];

    try {
        // 1. IPEA
        console.log("🤖 [1/4] IPEA...");
        const dadosIPEA = await consultarGemini(`
            Acesse: ${FONTE_IPEA.url}
            Liste TODAS as Chamadas Públicas visíveis na lista.
            Pegue apenas o título azul da chamada pública (ex: "Chamada Pública n° 56/2025", "Chamada Pública 057/2025").
            Pegue o título igual ele está na lista.
            Não filtre por status. Capture título completo.
            Caso não haja nada listado, retorne um array vazio.
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // 2. FNP
        console.log("🤖 [2/4] FNP...");
        const dadosFNP = await consultarGemini(`
            Acesse: ${FONTE_FNP.url}
            Liste TODOS os itens (Editais, TRs, Cotações, etc).
            Ignore o botão de Download azul e qualquer conteúdo dentro dele.
            Não filtre nada. Capture apenas o título inteiro e a data.
            O título está em cima da data.
            Caso não haja nada listado, retorne um array vazio.
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // 3. UNDP
        console.log("🤖 [3/4] UNDP...");
        const dadosUNDP = await consultarGemini(`
            Acesse: ${FONTE_UNDP.url}
            Liste TODAS as oportunidades/vagas/editais da página.
            Não filtre por status. Capture título completo.
            Caso não haja nada listado, retorne um array vazio.
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // 4. ICLEI
        console.log("🤖 [4/4] ICLEI...");
        const dadosICLEI = await consultarGemini(`
            Acesse a página "Trabalhe Conosco" do ICLEI: ${FONTE_ICLEI.url}
            
            Sua tarefa: Listar TODAS as Vagas, Termos de Referência (TdR) ou Licitações listadas.
            Não filtre por data ou status. Queremos tudo o que está na lista.
            Capture o título completo no campo 'titulo'.
            Capture a data de publicação ou prazo no campo 'prazo'.

            Caso não haja nada listado, retorne um array vazio.
            NÃO retorne mensagens dizendo "não há nada listado", ou parecido.
            ${INSTRUCAO_JSON}
        `);

        // Consolidação Geral
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
            console.log(`📤 Enviando email com ${novasOportunidades.length} novos itens...`);
            await enviarEmailResumo(novasOportunidades);
        } else {
            console.log("✅ Ciclo finalizado. Nenhuma alteração detectada.");
        }

    } catch (error) {
        console.error("❌ Erro fatal durante o ciclo de verificação:", error);
    } finally {
        // Garante que o banco fecha mesmo se der erro
        await db.close();
    }
}

// --- SERVIÇO DE AGENDAMENTO ---
async function main() {
    console.log("🚀 Serviço de Monitoramento de Editais Iniciado.");

    // Executa imediatamente ao iniciar (para não esperar 2h pelo primeiro teste)
    await checkSites();

    // Agenda para rodar a cada 6 horas (Minuto 0, a cada 6 horas: 0, 6, 12...)
    cron.schedule('0 */6 * * *', async () => {
        try {
            await checkSites();
        } catch (err) {
            console.error("Erro no Cron Job:", err);
        }
    });

    console.log("⏳ Agendado para rodar a cada 6 horas.");
}

main();