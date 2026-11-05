// src/routes/billing.routes.js
// Gestão de Planos, Assinaturas e Checkout SaaS do expedi HUB

const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { PLAN_LIMITS } = require('../config/constants');
const { requireAuth, requireAdmin } = require('../middlewares/auth');
const auditService = require('../../services/audit_service');

const PLAN_DETAILS = {
    'starter': {
        id: 'starter',
        name: 'Starter',
        priceMonthly: 199.00,
        priceYearly: 169.00, // 15% desc
        guideLimit: 100,
        features: [
            'Emissão em lote (ES, GNRE e SP)',
            'Remessa CNAB 240',
            'PDFs oficiais das guias',
            'Suporte por e-mail'
        ]
    },
    'pro': {
        id: 'pro',
        name: 'Pro',
        priceMonthly: 399.00,
        priceYearly: 339.00,
        guideLimit: 500,
        recommended: true,
        features: [
            'Tudo do Starter',
            'Múltiplos CNPJs',
            'Resposta de suporte em até 4h úteis',
            'Homologação de remessa bancária'
        ]
    },
    'advanced': {
        id: 'advanced',
        name: 'Advanced',
        priceMonthly: 699.00,
        priceYearly: 594.00,
        guideLimit: 1500,
        features: [
            'Tudo do Pro',
            'Acesso à API de integração',
            'Mapeamento de taxas sob medida',
            'Suporte premium prioritário'
        ]
    }
};

// 1. Listagem pública de planos
router.get('/plans', (req, res) => {
    return res.json({ plans: PLAN_DETAILS });
});

// 2. Status da assinatura do tenant autenticado
router.get('/status', requireAuth, async (req, res) => {
    try {
        const tenant = req.tenant;
        const currentPlan = (tenant.subscription_status || 'trial').toLowerCase();
        const limit = tenant.limite_guias_mes || tenant.plan_limit_guides || PLAN_LIMITS[currentPlan] || 10;
        const used = tenant.guias_usadas_mes || 0;

        return res.json({
            tenantId: tenant.id,
            razaoSocial: tenant.razao_social,
            plan: currentPlan,
            planDetails: PLAN_DETAILS[currentPlan] || null,
            status: tenant.status || 'ativo',
            usage: {
                guidesUsed: used,
                guidesLimit: limit,
                percentage: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
            },
            billingSettings: tenant.settings?.billing || {}
        });
    } catch (err) {
        return res.status(500).json({ error: "Erro ao consultar status da assinatura: " + err.message });
    }
});

// 3. Checkout / Assinatura de plano
router.post('/subscribe', requireAuth, requireAdmin, async (req, res) => {
    const { plan, billingType = 'PIX', cycle = 'mensal' } = req.body;
    const planKey = String(plan || '').toLowerCase();

    if (!PLAN_DETAILS[planKey]) {
        return res.status(400).json({ error: "Plano inválido. Escolha entre: starter, pro ou advanced." });
    }

    const selectedPlan = PLAN_DETAILS[planKey];
    const tenant = req.tenant;
    const newLimit = selectedPlan.guideLimit;

    try {
        const currentSettings = (tenant.settings && typeof tenant.settings === 'object') ? tenant.settings : {};
        const billingData = {
            plan: planKey,
            cycle,
            billingType,
            subscribedAt: new Date().toISOString(),
            status: 'ativo'
        };

        const { error } = await supabase
            .from('tenants')
            .update({
                subscription_status: planKey,
                status: 'ativo',
                limite_guias_mes: newLimit,
                settings: {
                    ...currentSettings,
                    billing: billingData
                }
            })
            .eq('id', tenant.id);

        if (error) throw error;

        await auditService.logAudit(supabase, {
            tenantId: tenant.id,
            userId: req.user?.id,
            acao: 'UPGRADE_PLANO',
            detalhe: `Assinatura do plano '${selectedPlan.name}' (${cycle}) confirmada. Limite: ${newLimit} guias/mês.`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.json({
            success: true,
            message: `Plano ${selectedPlan.name} ativado com sucesso!`,
            plan: planKey,
            guideLimit: newLimit
        });
    } catch (err) {
        return res.status(500).json({ error: "Falha ao processar assinatura do plano: " + err.message });
    }
});

module.exports = router;
