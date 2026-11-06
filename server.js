// server.js
// expedi HUB — Plataforma SaaS Multi-Tenant de Inteligência e Automação Fiscal/Logística

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');

const supabase = require('./src/config/supabase');
const { apiLimiter, authLimiter } = require('./src/middlewares/rateLimiter');
const { broadcastDockEvent } = require('./src/utils/events');
const syncService = require('./services/sync_service');
const { runBatchProcessInBackground } = require('./services/batch_processor');

// Importação dos Módulos Arquiteturais de Rotas
const authRoutes = require('./src/routes/auth.routes');
const tenantRoutes = require('./src/routes/tenant.routes');
const billingRoutes = require('./src/routes/billing.routes');
const webhooksRoutes = require('./src/routes/webhooks.routes');
const difalRoutes = require('./src/routes/difal.routes');
const biRoutes = require('./src/routes/bi.routes');
const relatoriosRoutes = require('./src/routes/relatorios.routes');
const adminRoutes = require('./src/routes/admin.routes');
const syncRoutes = require('./src/routes/sync.routes');
const erpRoutes = require('./src/routes/erp.routes');
const batchRoutes = require('./src/routes/batch.routes');
const expedicaoRoutes = require('./src/routes/expedicao.routes');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Configuração de Segurança: Helmet
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// Middlewares Globais de Parsing e Cookies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// Proteção contra brute force / DoS na API
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

// Arquivos estáticos frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Montagem dos Módulos de Rotas (src/routes/)
app.use('/api/auth', authRoutes);
app.use('/api/tenant', tenantRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/difal', difalRoutes);
app.use('/api/bi', biRoutes);
app.use('/api/relatorios', relatoriosRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api', erpRoutes);
app.use('/api', batchRoutes);
app.use('/api', expedicaoRoutes);

// Fallback SPA (rotas frontend servem login.html se não autenticado)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/download')) {
        return next();
    }
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Inicialização do Servidor Express
if (require.main === module) {
    const HOST = '0.0.0.0';
    app.listen(PORT, HOST, () => {
        console.log(`\n==================================================`);
        console.log(`🚀 expedi HUB SaaS rodando na porta ${PORT}`);
        console.log(`🔗 Ambiente: ${process.env.NODE_ENV || 'development'}`);
        console.log(`==================================================\n`);

        try {
            syncService.iniciarAgendador(supabase, runBatchProcessInBackground, 5, broadcastDockEvent);
        } catch (e) {
            console.error("Erro ao inicializar agendador automático:", e.message);
        }
    });
}

module.exports = app;
