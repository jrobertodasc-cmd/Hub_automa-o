// src/routes/auth.routes.js
// Rotas de autenticação (Cadastro, Login, Logout, Sessão do Usuário)

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middlewares/auth');
const { authLimiter } = require('../middlewares/rateLimiter');
const auditService = require('../../services/audit_service');

// Cadastro público com Rate Limiting
router.post('/register', authLimiter, async (req, res) => {
    const { email, password, name, cnpj, razao_social, plan } = req.body;
    if (!email || !password || !cnpj || !razao_social) {
        return res.status(400).json({ error: "Campos obrigatórios ausentes. Preencha e-mail, senha, CNPJ e Razão Social." });
    }

    const cleanCnpj = String(cnpj).replace(/\D/g, '');
    if (cleanCnpj.length !== 14) {
        return res.status(400).json({ error: "CNPJ inválido. Forneça um CNPJ com 14 dígitos." });
    }

    if (String(password).length < 8) {
        return res.status(400).json({ error: "A senha deve conter no mínimo 8 caracteres." });
    }

    const validPlans = ['trial', 'starter', 'pro', 'advanced'];
    const finalPlan = validPlans.includes(String(plan).toLowerCase()) ? String(plan).toLowerCase() : 'trial';

    try {
        // 1. Cadastra no Supabase Auth usando a API admin
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            email: email.trim().toLowerCase(),
            password: String(password),
            email_confirm: true
        });

        if (authError || !authData.user) {
            return res.status(400).json({ error: authError?.message || "Erro no cadastro de credenciais de acesso." });
        }

        const user = authData.user;

        // 2. Insere a nova empresa na tabela de tenants
        const { data: tenantData, error: tenantError } = await supabase
            .from('tenants')
            .insert({
                cnpj: cleanCnpj,
                razao_social: razao_social.trim(),
                bank_agency: '0000',
                bank_account: '00000',
                bank_dac: '0',
                environment: 'simulado',
                subscription_status: finalPlan,
                status: 'ativo',
                settings: {}
            })
            .select()
            .single();

        if (tenantError) {
            // Rollback do usuário de auth para não deixar órfão
            await supabase.auth.admin.deleteUser(user.id);
            return res.status(400).json({ error: "Erro ao registrar a empresa: " + tenantError.message });
        }

        // 3. Cria o perfil do usuário como Administrador do seu tenant
        const { error: profileError } = await supabase
            .from('profiles')
            .insert({
                id: user.id,
                tenant_id: tenantData.id,
                email: email.trim().toLowerCase(),
                name: (name || razao_social).trim(),
                role: 'admin',
                is_admin: true
            });

        if (profileError) {
            return res.status(400).json({ error: "Erro ao criar perfil de usuário: " + profileError.message });
        }

        // Auditoria
        await auditService.logAudit(supabase, {
            tenantId: tenantData.id,
            userId: user.id,
            acao: 'CADASTRO_TENANT',
            detalhe: `Novo cadastro autônomo via portal. Plano: ${finalPlan}`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ 
            message: "Cadastro realizado com sucesso! Faça login com seu e-mail e senha.",
            tenantId: tenantData.id 
        });
    } catch (err) {
        console.error("[auth.routes /register] Erro:", err);
        return res.status(500).json({ error: "Falha interna no processamento do cadastro: " + err.message });
    }
});

// Login
router.post('/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "E-mail e senha são obrigatórios." });
    }

    try {
        const tempClient = createClient(process.env.SUPABASE_URL || 'http://localhost:54321', process.env.SUPABASE_KEY || 'fake', {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });

        const { data, error } = await tempClient.auth.signInWithPassword({
            email: email.trim().toLowerCase(),
            password: String(password)
        });

        if (error || !data.session) {
            return res.status(401).json({ error: error?.message || "E-mail ou senha incorretos." });
        }

        // Define cookie de autenticação válido por 7 dias
        res.cookie('sb_access_token', data.session.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        });

        return res.status(200).json({ 
            message: "Login efetuado com sucesso!", 
            token: data.session.access_token 
        });
    } catch (err) {
        console.error("[auth.routes /login] Erro:", err);
        return res.status(500).json({ error: err.message });
    }
});

// Logout
router.post('/logout', (req, res) => {
    res.clearCookie('sb_access_token');
    return res.status(200).json({ message: "Logout efetuado com sucesso." });
});

// Sessão do usuário atual
router.get('/me', requireAuth, (req, res) => {
    const t = req.tenant || {};
    return res.status(200).json({
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.profile?.name || req.user.email
        },
        profile: {
            is_admin: req.profile?.is_admin || req.profile?.role === 'admin' || req.profile?.role === 'superadmin',
            role: req.profile?.role || 'operador',
            name: req.profile?.name || req.user.email,
            email: req.profile?.email || req.user.email
        },
        tenant: {
            id: t.id,
            razao_social: t.razao_social,
            nome_fantasia: t.nome_fantasia || t.razao_social,
            cnpj: t.cnpj,
            environment: t.environment || 'simulado',
            status: t.status || t.subscription_status || 'ativo',
            plano: t.plano || t.subscription_status || 'starter',
            bank_agency: t.bank_agency,
            bank_account: t.bank_account,
            bank_dac: t.bank_dac,
            notification_phone: t.notification_phone || null,
            notification_email: t.notification_email || null,
            has_pfx: !!(t.pfx_certificate || t.pfx_filename),
            has_asaas: !!(t.asaas_api_key || t.asaas_api_key_encrypted),
            has_microvix: !!(t.microvix_token || t.microvix_key)
        }
    });
});

module.exports = router;
