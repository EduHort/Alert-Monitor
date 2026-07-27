import 'dotenv/config';
import nodemailer, { Transporter } from 'nodemailer';
import { Fonte, Oportunidade, Falha } from './tipos';

function lerListaEmails(nome: string): string[] {
    return (process.env[nome] ?? '').split(',').map(e => e.trim()).filter(Boolean);
}

export const EMAIL_CLIENTS = lerListaEmails('EMAIL_CLIENTS');
export const EMAIL_ADMIN = lerListaEmails('EMAIL_ADMIN');

// Criado sob demanda para que a validação do ambiente rode antes.
let transporter: Transporter | null = null;
function conexao(): Transporter {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });
    }
    return transporter;
}

export async function verificarConexao(): Promise<void> {
    await conexao().verify();
}

function escaparHtml(valor: string | undefined | null): string {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// --- TEMPLATES ---
function htmlResumoClientes(oportunidades: Oportunidade[]): string {
    const resumoPorFonte = new Map<string, { fonte: Fonte, qtd: number }>();
    oportunidades.forEach(op => {
        const atual = resumoPorFonte.get(op.fonte.nome);
        if (atual) {
            atual.qtd++;
        } else {
            resumoPorFonte.set(op.fonte.nome, { fonte: op.fonte, qtd: 1 });
        }
    });

    let htmlBlocos = '';
    resumoPorFonte.forEach(({ fonte, qtd }) => {
        htmlBlocos += `
            <div style="border-left: 6px solid ${fonte.cor}; padding: 15px; margin-bottom: 20px; background-color: #f8f9fa; border-radius: 4px;">
                <h3 style="margin: 0 0 5px 0; color: ${fonte.cor};">${escaparHtml(fonte.nome)}</h3>
                <p style="margin: 0 0 10px 0; font-size: 14px; color: #555;">
                    Novos editais/vagas encontrados: <strong>${qtd}</strong>
                </p>
                <a href="${escaparHtml(fonte.url)}" style="background-color: ${fonte.cor}; color: #fff; text-decoration: none; padding: 8px 15px; border-radius: 4px; font-size: 13px; font-weight: bold; display: inline-block;">
                    Acessar Site do ${escaparHtml(fonte.nome)}
                </a>
            </div>
        `;
    });

    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; color: #333;">
            <h2 style="color: #2c3e50; border-bottom: 1px solid #eee; padding-bottom: 10px;">Atualização de Monitoramento</h2>
            <p>O sistema detectou novas publicações nos seguintes sites:</p>
            ${htmlBlocos}
            <hr style="border: 0; border-top: 1px solid #eee; margin-top: 30px;" />
            <p style="font-size: 12px; color: #888;">Monitoramento automático.</p>
        </div>
    `;
}

function htmlDebugAdmin(oportunidades: Oportunidade[], falhas: Falha[]): string {
    const itensHtml = oportunidades.map(op => `
        <li style="margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px dashed #ccc;">
            <strong style="color: ${op.fonte.cor}">[${escaparHtml(op.fonte.nome)}]</strong>
            <span style="font-size: 14px;">${escaparHtml(op.titulo)}</span><br>
            <small style="color: #666;">Data: ${escaparHtml(op.prazo) || 'não informada'}</small><br>
            <small style="color: #999; font-size: 10px;">ID: ${escaparHtml(op.id_unico)}</small>
        </li>
    `).join('');

    const blocoItens = oportunidades.length > 0
        ? `<p>Lista exata dos títulos capturados pela IA nesta rodada:</p>
           <ul style="padding-left: 20px;">${itensHtml}</ul>`
        : '<p>Nenhuma oportunidade nova nesta rodada.</p>';

    const blocoFalhas = falhas.length > 0
        ? `
            <div style="border-left: 6px solid #c0392b; background-color: #fdf3f2; padding: 15px; margin-top: 20px; border-radius: 4px;">
                <h4 style="margin: 0 0 10px 0; color: #c0392b;">⚠️ Fontes que falharam (${falhas.length})</h4>
                <p style="margin: 0 0 10px 0; font-size: 13px; color: #555;">
                    Estas fontes NÃO foram verificadas nesta rodada. Pode haver oportunidades não detectadas.
                </p>
                <ul style="padding-left: 20px; font-size: 13px;">
                    ${falhas.map(f => `<li><strong>${escaparHtml(f.fonte)}</strong>: ${escaparHtml(f.erro)}</li>`).join('')}
                </ul>
            </div>
        `
        : '';

    return `
        <div style="font-family: Arial, sans-serif; color: #333;">
            <h3>Relatório Técnico de Execução</h3>
            ${blocoItens}
            ${blocoFalhas}
        </div>
    `;
}

// --- ENVIO ---
async function enviar(destinatarios: string[], assunto: string, html: string, rotulo: string): Promise<boolean> {
    try {
        await conexao().sendMail({
            from: `"Monitor de Editais" <${process.env.EMAIL_USER}>`,
            to: destinatarios,
            subject: assunto,
            html
        });
        console.log(`📧 Email (${rotulo}) enviado para: ${destinatarios.join(', ')}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro no envio (${rotulo}):`, error);
        return false;
    }
}

/**
 * Retorna true quando o destino principal recebeu o aviso — só aí as
 * oportunidades podem ser marcadas como notificadas.
 */
export async function enviarEmails(oportunidades: Oportunidade[], falhas: Falha[]): Promise<boolean> {
    const temClientes = EMAIL_CLIENTS.length > 0;
    const temAdmin = EMAIL_ADMIN.length > 0;

    const okClientes = temClientes && oportunidades.length > 0
        ? await enviar(
            EMAIL_CLIENTS,
            '🔔 Novas Oportunidades Detectadas',
            htmlResumoClientes(oportunidades),
            'Resumo'
        )
        : true;

    const okAdmin = temAdmin
        ? await enviar(
            EMAIL_ADMIN,
            `🔧 DEBUG: ${oportunidades.length} Itens${falhas.length ? ` / ${falhas.length} falha(s)` : ''}`,
            htmlDebugAdmin(oportunidades, falhas),
            'Debug'
        )
        : true;

    return temClientes ? okClientes : okAdmin;
}
