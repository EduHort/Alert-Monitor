import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Fonte, ItemBruto, PendenteDb } from './tipos';

const DB_FILENAME = 'monitor_oportunidades.db';
const RETENCAO_MESES = 3; // Oportunidades já notificadas e fora do ar são apagadas depois disso

export function initDB(): DatabaseSync {
    const db = new DatabaseSync(DB_FILENAME);
    db.exec(`
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
    migrarColunas(db);
    return db;
}

// Bancos criados antes dessas colunas: o que já está gravado já foi notificado.
function migrarColunas(db: DatabaseSync): void {
    const colunas = db.prepare('PRAGMA table_info(oportunidades)').all() as { name: string }[];
    const nomes = new Set(colunas.map(c => c.name));

    if (!nomes.has('notificado')) {
        db.exec('ALTER TABLE oportunidades ADD COLUMN notificado INTEGER NOT NULL DEFAULT 1');
    }
    if (!nomes.has('data_vista')) {
        // SQLite não aceita CURRENT_TIMESTAMP como default em ALTER TABLE.
        db.exec('ALTER TABLE oportunidades ADD COLUMN data_vista DATETIME');
        db.exec('UPDATE oportunidades SET data_vista = data_detectada WHERE data_vista IS NULL');
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
export function registrarItens(db: DatabaseSync, fonte: Fonte, itens: ItemBruto[]): number {
    let novos = 0;

    const selecionar = db.prepare('SELECT prazo FROM oportunidades WHERE id = ?');
    const atualizar = db.prepare(
        'UPDATE oportunidades SET prazo = ?, data_vista = CURRENT_TIMESTAMP WHERE id = ?'
    );
    const inserir = db.prepare(
        `INSERT INTO oportunidades (id, projeto, prazo, fonte, notificado, data_vista)
         VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`
    );

    for (const item of itens) {
        const idUnico = gerarIdEstavel(fonte.nome, item.titulo);
        const existente = selecionar.get(idUnico) as { prazo: string } | undefined;

        if (existente) {
            atualizar.run(item.prazo, idUnico);
            continue;
        }

        console.log(`✨ [${fonte.nome}] DETECTADO: ${item.titulo.substring(0, 50)}...`);
        inserir.run(idUnico, item.titulo, item.prazo, fonte.nome);
        novos++;
    }

    return novos;
}

// Inclui o que ficou para trás em ciclos anteriores cujo envio de email falhou.
export function buscarPendentes(db: DatabaseSync): PendenteDb[] {
    const linhas = db.prepare(
        'SELECT id, projeto, prazo, fonte FROM oportunidades WHERE notificado = 0 ORDER BY data_detectada'
    ).all() as { id: string, projeto: string, prazo: string, fonte: string }[];

    return linhas.map(l => ({
        id_unico: l.id,
        titulo: l.projeto,
        prazo: l.prazo,
        fonteNome: l.fonte
    }));
}

export function marcarNotificadas(db: DatabaseSync, ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(`UPDATE oportunidades SET notificado = 1 WHERE id IN (${placeholders})`).run(...ids);
}

// Só apaga o que já foi notificado e sumiu do site há mais de RETENCAO_MESES.
export function limparAntigas(db: DatabaseSync): void {
    const resultado = db.prepare(
        `DELETE FROM oportunidades WHERE notificado = 1 AND data_vista < datetime('now', ?)`
    ).run(`-${RETENCAO_MESES} months`);
    if (resultado.changes) {
        console.log(`🧹 ${resultado.changes} registro(s) antigo(s) removido(s).`);
    }
}
