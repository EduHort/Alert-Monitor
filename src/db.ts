import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { createHash } from 'node:crypto';
import { Fonte, ItemBruto, PendenteDb } from './tipos';

const DB_FILENAME = 'monitor_oportunidades.db';
const RETENCAO_MESES = 3; // Oportunidades já notificadas e fora do ar são apagadas depois disso

export async function initDB(): Promise<Database> {
    const db = await open({ filename: DB_FILENAME, driver: sqlite3.Database });
    await db.exec(`
    CREATE TABLE IF NOT EXISTS oportunidades (
      id TEXT PRIMARY KEY,
      projeto TEXT,
      prazo TEXT,
      fonte TEXT,
      notificado INTEGER NOT NULL DEFAULT 1,
      data_detectada DATETIME DEFAULT CURRENT_TIMESTAMP,
      data_vista DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
    await migrarColunas(db);
    return db;
}

// Bancos criados antes dessas colunas: o que já está gravado já foi notificado.
async function migrarColunas(db: Database): Promise<void> {
    const colunas = await db.all<{ name: string }[]>('PRAGMA table_info(oportunidades)');
    const nomes = new Set(colunas.map(c => c.name));

    if (!nomes.has('notificado')) {
        await db.exec('ALTER TABLE oportunidades ADD COLUMN notificado INTEGER NOT NULL DEFAULT 1');
    }
    if (!nomes.has('data_vista')) {
        // SQLite não aceita CURRENT_TIMESTAMP como default em ALTER TABLE.
        await db.exec('ALTER TABLE oportunidades ADD COLUMN data_vista DATETIME');
        await db.exec('UPDATE oportunidades SET data_vista = data_detectada WHERE data_vista IS NULL');
    }
}

// Só o título entra no ID: o prazo costuma variar de formato entre execuções
// e faria a mesma oportunidade ser notificada de novo.
function gerarIdEstavel(fonteNome: string, titulo: string): string {
    const tituloLimpo = titulo
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');

    // O slug legível é cortado em 60 chars, então o hash do título inteiro
    // evita que dois editais de começo parecido virem o mesmo registro.
    const hash = createHash('sha1').update(tituloLimpo).digest('hex').substring(0, 8);
    return `${fonteNome}-${tituloLimpo.substring(0, 60)}-${hash}`;
}

/**
 * Grava o que a fonte devolveu e retorna quantos eram inéditos.
 * Itens já conhecidos só têm prazo e data_vista atualizados.
 */
export async function registrarItens(db: Database, fonte: Fonte, itens: ItemBruto[]): Promise<number> {
    let novos = 0;

    for (const item of itens) {
        const idUnico = gerarIdEstavel(fonte.nome, item.titulo);
        const existente = await db.get<{ prazo: string }>(
            'SELECT prazo FROM oportunidades WHERE id = ?', idUnico
        );

        if (existente) {
            await db.run(
                'UPDATE oportunidades SET prazo = ?, data_vista = CURRENT_TIMESTAMP WHERE id = ?',
                item.prazo, idUnico
            );
            continue;
        }

        console.log(`✨ [${fonte.nome}] DETECTADO: ${item.titulo.substring(0, 50)}...`);
        await db.run(
            `INSERT INTO oportunidades (id, projeto, prazo, fonte, notificado, data_vista)
             VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
            idUnico, item.titulo, item.prazo, fonte.nome
        );
        novos++;
    }

    return novos;
}

// Inclui o que ficou para trás em ciclos anteriores cujo envio de email falhou.
export async function buscarPendentes(db: Database): Promise<PendenteDb[]> {
    const linhas = await db.all<{ id: string, projeto: string, prazo: string, fonte: string }[]>(
        'SELECT id, projeto, prazo, fonte FROM oportunidades WHERE notificado = 0 ORDER BY data_detectada'
    );

    return linhas.map(l => ({
        id_unico: l.id,
        titulo: l.projeto,
        prazo: l.prazo,
        fonteNome: l.fonte
    }));
}

export async function marcarNotificadas(db: Database, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    await db.run(`UPDATE oportunidades SET notificado = 1 WHERE id IN (${placeholders})`, ...ids);
}

// Só apaga o que já foi notificado e sumiu do site há mais de RETENCAO_MESES.
export async function limparAntigas(db: Database): Promise<void> {
    const resultado = await db.run(
        `DELETE FROM oportunidades WHERE notificado = 1 AND data_vista < datetime('now', ?)`,
        `-${RETENCAO_MESES} months`
    );
    if (resultado.changes) {
        console.log(`🧹 ${resultado.changes} registro(s) antigo(s) removido(s).`);
    }
}
