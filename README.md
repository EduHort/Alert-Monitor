# Alert Monitor

Monitor automático de editais, chamadas públicas e vagas. A cada 6 horas o sistema
consulta os sites configurados usando o Gemini (com `urlContext`), guarda o que já foi
visto em um SQLite local e dispara um email quando aparece algo novo.

## Fontes monitoradas

| Fonte | Site | Observação |
| --- | --- | --- |
| IPEA | https://www.ipea.gov.br/portal/bolsas-de-pesquisa | Lista paginada e enorme (~1700 itens), misturando `Situação: ABERTA` e `FECHADA` |
| FNP | https://fnp.org.br/transparencia/documentos?cat=37 | 6 páginas; encerramento nem sempre é sinalizado no texto |
| UNDP | https://parceiros.undp.org.br/opportunities | ⚠️ SPA Angular — a listagem só existe depois do JavaScript rodar |
| ICLEI Editais | https://americadosul.iclei.org/editais/ | Chamadas públicas e termos de referência |
| ICLEI Carreira | https://americadosul.iclei.org/carreira/ | Vagas, consultorias, estágio e voluntariado |
| WRI | https://www.wribrasil.org.br/trabalhe-conosco | Duas seções (vagas e consultorias); **nenhum item tem data** |

> A URL antiga do ICLEI (`/trabalhe-conosco/?cat=15`) foi desativada e hoje responde
> HTTP 404 — foi substituída pelas duas páginas acima.

## Configuração

```bash
npm install
cp .env_example .env   # preencha as variáveis
```

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `GEMINI_API_KEY` | sim | Chave da API do Google Gemini |
| `EMAIL_USER` | sim | Conta Gmail remetente |
| `EMAIL_PASS` | sim | **Senha de app** do Google (não a senha da conta) |
| `EMAIL_CLIENTS` | ao menos uma das duas | Destinatários do resumo, separados por vírgula |
| `EMAIL_ADMIN` | ao menos uma das duas | Destinatários do relatório técnico, separados por vírgula |

O processo aborta na inicialização se alguma variável obrigatória estiver faltando.

## Execução

```bash
npm run dev     # desenvolvimento (ts-node)
npm run build   # compila para dist/
npm start       # produção (node dist/index.js)
```

O primeiro ciclo roda assim que o processo sobe; depois disso o cron assume
(`0 */6 * * *`, fuso `America/Sao_Paulo`). Requer Node 22.5 ou superior (usa o
`node:sqlite` embutido — sem módulo nativo para compilar).

### Em produção com pm2 (primeira execução)

```bash
npm ci && cp .env_example .env && nano .env && npm run build && pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

O banco usa o `node:sqlite` embutido do próprio Node — não há módulo nativo
para compilar, então `npm ci` é só instalação mesmo (requer Node 22.5+; em
produção usamos Node 24, que já suporta sem flag nenhuma). O `nano .env`
abre o editor no meio da cadeia — preencha as variáveis, salve e feche para
os comandos seguintes continuarem. O `pm2 startup` imprime, no final, um
comando `sudo env PATH=... pm2 startup ...`: copie e rode-o separadamente —
é isso que faz o pm2 subir sozinho depois de um reboot do servidor.

O agendamento é **interno** ao processo (node-cron), então o pm2 só precisa
manter a aplicação viva — não use `cron_restart`, e não suba mais de uma
instância: seriam ciclos duplicados, emails repetidos e escrita concorrente no
SQLite. O `cwd` no [`ecosystem.config.js`](ecosystem.config.js) é o que garante
que o `.env` e o `monitor_oportunidades.db` sejam encontrados.

## Atualizando

```bash
git pull && npm ci && npm run build && pm2 restart alert-monitor && pm2 logs alert-monitor --lines 30
```

- `.env` e `monitor_oportunidades.db` são ignorados pelo git (veja
  [`.gitignore`](.gitignore)), então credenciais e o histórico já coletado não
  são afetados pelo `git pull`.
- `dist/` também é ignorado pelo git — por isso o `npm run build` é sempre
  necessário depois de um pull, mesmo em mudanças pequenas.
- `npm ci` só é estritamente necessário quando `package.json` ou
  `package-lock.json` mudaram; rodar sempre não tem custo real além de alguns
  segundos a mais.
- `pm2 restart` mata o processo atual e sobe o novo já com o código
  atualizado; como o cron é interno, o restart dispara um ciclo de
  verificação imediatamente e depois retoma o agendamento de 6 em 6 horas —
  não é preciso rodar `pm2 save` de novo (isso só é necessário se o
  [`ecosystem.config.js`](ecosystem.config.js) em si mudar).

## Estrutura

| Arquivo | Responsabilidade |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Configuração das fontes, ciclo de verificação, cron e inicialização |
| [`src/gemini.ts`](src/gemini.ts) | Montagem dos prompts, chamada da IA, download de HTML e parsing do JSON |
| [`src/db.ts`](src/db.ts) | Schema, migrações, IDs estáveis, persistência e limpeza |
| [`src/email.ts`](src/email.ts) | Conexão SMTP, templates HTML e envio |
| [`src/tipos.ts`](src/tipos.ts) | Interfaces compartilhadas entre os módulos |

O cliente do Gemini e o transporte SMTP são criados sob demanda, na primeira vez
que são usados — assim a validação das variáveis de ambiente roda antes de
qualquer tentativa de conexão.

## Como funciona

1. As 5 fontes são consultadas **em paralelo**. Cada fonte tem timeout de 2 minutos.
2. Uma fonte que falha é registrada como falha — ela **não** é confundida com
   "nenhuma novidade". As falhas aparecem no email de admin.
3. Cada item recebe um ID estável derivado da fonte + título (o prazo fica de fora,
   porque a IA varia o formato da data entre execuções).
4. Itens novos entram no banco com `notificado = 0`. A flag só vira `1` depois que o
   email sai com sucesso — se o envio falhar, o item é reenviado no ciclo seguinte em
   vez de se perder.
5. Itens já notificados que sumiram do site há mais de 3 meses são apagados.

## Emails

- **Clientes** (`EMAIL_CLIENTS`): resumo agrupado por fonte, com a quantidade de novidades
  e o link para o site. Só é enviado quando há novidades.
- **Admin** (`EMAIL_ADMIN`): lista completa dos títulos capturados, IDs gerados e as
  fontes que falharam. É enviado também quando só há falhas.

## Adicionando uma fonte

Basta acrescentar um objeto no array `FONTES` em [`src/index.ts`](src/index.ts) com
`nome`, `url`, `cor` e a `instrucao` específica do site. O restante do fluxo (prompt,
consulta, persistência, email) é genérico.

## Banco de dados

SQLite em `monitor_oportunidades.db` (ignorado pelo git), tabela `oportunidades`:

| Coluna | Descrição |
| --- | --- |
| `id` | ID estável (`FONTE-slug-do-titulo-hash`) |
| `projeto` | Título capturado |
| `prazo` | Data associada, atualizada a cada rodada |
| `fonte` | Nome da fonte |
| `notificado` | `0` = pendente de email, `1` = já avisado |
| `data_detectada` | Primeira vez que apareceu |
| `data_vista` | Última vez que apareceu no site |
