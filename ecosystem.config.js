module.exports = {
    apps: [{
        name: 'alert-monitor',
        script: 'dist/index.js',

        // O .env e o monitor_oportunidades.db são resolvidos a partir do diretório
        // de trabalho. Sem isso, o pm2 pode subir o processo de outro lugar e o
        // programa não acha as credenciais nem o banco já populado.
        cwd: __dirname,

        // O agendamento é interno (node-cron). O processo precisa ficar vivo,
        // então nada de cron_restart aqui — seriam dois agendadores brigando.
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,

        max_memory_restart: '300M',

        // Cada start executa um ciclo imediatamente. Sem essas travas, um crash
        // em loop viraria uma rajada de chamadas à API do Gemini.
        min_uptime: '60s',
        max_restarts: 10,
        exp_backoff_restart_delay: 5000,

        time: true, // Timestamp em cada linha de log
        merge_logs: true,

        env: {
            NODE_ENV: 'production',
            TZ: 'America/Sao_Paulo'
        }
    }]
};
