// src/routes/tenant.routes.js
// Rotas de configuração de dados cadastrais, bancários, fiscais e comerciais do Tenant

const express = require('express');
const router = express.Router();
const upload = require('../middlewares/upload');
const supabase = require('../config/supabase');
const { getEncryptionKey, encrypt } = require('../utils/crypto');
const { requireAuth, requireRole, requireAdmin, requireSuperAdmin } = require('../middlewares/auth');
const { getConfigComercial, sanitizarConfigComercial } = require('../../services/comercial_service');



// Configurações cadastrais e bancárias
router.post('/settings', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    const { cnpj, razao_social, bank_agency, bank_account, bank_dac, environment } = req.body;
    if (!cnpj || !razao_social || !bank_agency || !bank_account || !bank_dac) {
        return res.status(400).json({ error: "Todos os dados cadastrais e bancários são obrigatórios." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({
                cnpj: cnpj.replace(/[^0-9]/g, ''),
                razao_social: razao_social,
                bank_agency: bank_agency.replace(/[^0-9]/g, ''),
                bank_account: bank_account.replace(/[^0-9]/g, ''),
                bank_dac: bank_dac.replace(/[^0-9]/g, ''),
                environment: environment || 'simulado'
            })
            .eq('id', req.tenant.id);

        if (error) throw error;

        return res.status(200).json({ message: "Configurações atualizadas com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Contatos privados de notificação da responsável / diretoria
router.post('/notifications', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    const { notification_phone, notification_email } = req.body;

    try {
        const { error } = await supabase
            .from('tenants')
            .update({
                notification_phone: notification_phone ? notification_phone.trim() : null,
                notification_email: notification_email ? notification_email.trim() : null
            })
            .eq('id', req.tenant.id);

        if (error) throw error;

        return res.status(200).json({ message: "Preferências de notificação salvas com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Upload do Certificado Digital A1 (.pfx)
router.post('/upload-pfx', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), upload.single('pfx'), async (req, res) => {
    const { passphrase } = req.body;
    if (!req.file || !passphrase) {
        return res.status(400).json({ error: "Arquivo do certificado .pfx e senha são obrigatórios." });
    }

    try {
        const rawFilename = req.file.originalname;
        const filename = rawFilename
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9.\-_]/g, '_');

        // 1. Upload para o storage isolado por tenant
        const { error: uploadError } = await supabase.storage
            .from('tenant-storage')
            .upload(`${req.tenant.id}/certificados/${filename}`, req.file.buffer, {
                contentType: 'application/x-pkcs12',
                upsert: true
            });

        if (uploadError) {
            return res.status(400).json({ error: "Falha ao enviar arquivo do certificado: " + uploadError.message });
        }

        // 2. Criptografa a senha com AES-256
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const encryptedPassphrase = encrypt(passphrase, key);

        // 3. Atualiza cadastro do tenant
        const { error: dbError } = await supabase
            .from('tenants')
            .update({
                pfx_filename: filename,
                pfx_passphrase_encrypted: encryptedPassphrase
            })
            .eq('id', req.tenant.id);

        if (dbError) throw dbError;

        return res.status(200).json({ message: "Certificado PFX cadastrado e salvo com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Alteração de plano (SuperAdmin)
router.post('/plan', requireAuth, requireSuperAdmin, async (req, res) => {
    const { plan } = req.body;
    const validPlans = ['trial', 'starter', 'pro', 'advanced', 'ativo'];
    if (!plan || !validPlans.includes(plan)) {
        return res.status(400).json({ error: "Plano selecionado inválido." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({ subscription_status: plan })
            .eq('id', req.tenant.id);

        if (error) throw error;

        return res.status(200).json({ message: "Plano de assinatura atualizado com sucesso!", plan });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Credenciais de API do Asaas para pagamentos automatizados
router.post('/asaas-credentials', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    try {
        const { asaas_api_key, asaas_environment } = req.body;
        const tenant = req.tenant;
        const updateData = {};

        if (asaas_environment) {
            updateData.asaas_environment = asaas_environment === 'producao' ? 'producao' : 'sandbox';
        }

        if (asaas_api_key && asaas_api_key.trim()) {
            const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
            updateData.asaas_api_key_encrypted = encrypt(asaas_api_key.trim(), key);
        }

        const { error } = await supabase
            .from('tenants')
            .update(updateData)
            .eq('id', tenant.id);

        if (error) throw error;
        return res.status(200).json({ message: "Configurações do Asaas salvas com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: "Erro ao salvar credenciais do Asaas: " + err.message });
    }
});

// Gestão Comercial do E-commerce (Social Selling, Cupons, Campanhas)
router.get('/comercial-config', requireAuth, requireAdmin, (req, res) => {
    return res.json({ 
        config: getConfigComercial(req.tenant), 
        personalizada: !!(req.tenant.settings && req.tenant.settings.comercial) 
    });
});

router.post('/comercial-config', requireAuth, requireAdmin, async (req, res) => {
    try {
        const novo = sanitizarConfigComercial(req.body || {});
        const atual = (req.tenant.settings && typeof req.tenant.settings === 'object') ? req.tenant.settings : {};
        const comercial = { ...getConfigComercial(req.tenant), ...novo };
        const { error } = await supabase
            .from('tenants')
            .update({ settings: { ...atual, comercial } })
            .eq('id', req.tenant.id);
        if (error) {
            const faltaColuna = /settings/i.test(error.message || '');
            return res.status(500).json({
                error: faltaColuna
                    ? "A coluna 'settings' não existe na tabela tenants. Execute: ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;"
                    : error.message
            });
        }
        return res.json({ success: true, config: comercial });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
