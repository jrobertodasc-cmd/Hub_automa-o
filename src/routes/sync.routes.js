// src/routes/sync.routes.js
// Sincronização Automática (Scheduler / Worker)

const express = require('express');
const router = express.Router();

const supabase = require('../config/supabase');
const { requireAuth, requireActiveSubscription } = require('../middlewares/auth');
const syncService = require('../../services/sync_service');
const { runBatchProcessInBackground } = require('../../services/batch_processor');

// 1. Status do agendador automático
router.get('/status', requireAuth, (req, res) => {
    return res.status(200).json(syncService.obterStatus());
});

// 2. Disparo manual imediato da sincronização automática para o tenant logado
router.post('/run', requireAuth, requireActiveSubscription, async (req, res) => {
    try {
        const { dataInicial, dataFim, paymentDate } = req.body;
        const resultado = await syncService.sincronizarTenant(
            req.tenant, 
            supabase, 
            runBatchProcessInBackground, 
            { dataInicial, dataFim, paymentDate }
        );
        return res.status(200).json(resultado);
    } catch (err) {
        console.error("Erro ao disparar sincronização manual:", err);
        return res.status(500).json({ error: "Falha na sincronização: " + err.message });
    }
});

module.exports = router;
