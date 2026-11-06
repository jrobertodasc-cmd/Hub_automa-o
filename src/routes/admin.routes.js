// src/routes/admin.routes.js
// Painel Administrativo Master (SuperAdmin)

const express = require('express');
const router = express.Router();

const supabase = require('../config/supabase');
const { requireAuth, requireSuperAdmin } = require('../middlewares/auth');
const auditService = require('../../services/audit_service');

// 1. Métricas Consolidadas do SaaS (SuperAdmin Master)
router.get('/metrics', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { data: tenants } = await supabase.from('tenants').select('id, status, subscription_status, plano, guias_usadas_mes, limite_guias_mes');
        const { count: totalGuias } = await supabase.from('guides').select('id', { count: 'exact', head: true });
        const { data: guiasPagas } = await supabase.from('guides').select('value').eq('status', 'comprovada');

        const totalTenants = tenants ? tenants.length : 0;
        const ativos = tenants ? tenants.filter(t => (t.status || t.subscription_status) === 'ativo').length : 0;
        const bloqueados = totalTenants - ativos;
        const totalDifalLiquidado = (guiasPagas || []).reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);

        return res.json({
            totalTenants,
            ativos,
            bloqueados,
            totalGuias: totalGuias || 0,
            totalDifalLiquidado: parseFloat(totalDifalLiquidado.toFixed(2))
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 2. Listar todas as empresas (Tenants) - Sanitizado sem expor credenciais privadas
router.get('/tenants', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { data: rawTenants, error } = await supabase
            .from('tenants')
            .select('id, cnpj, razao_social, nome_fantasia, email_admin, plano, limite_guias_mes, guias_usadas_mes, status, subscription_status, environment, bank_agency, bank_account, bank_dac, pfx_filename, asaas_api_key_encrypted, microvix_token, created_at, updated_at')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const tenants = (rawTenants || []).map(t => ({
            id: t.id,
            cnpj: t.cnpj,
            razao_social: t.razao_social,
            nome_fantasia: t.nome_fantasia || t.razao_social,
            email_admin: t.email_admin,
            plano: t.plano || t.subscription_status || 'pro',
            limite_guias_mes: t.limite_guias_mes || 1000,
            guias_usadas_mes: t.guias_usadas_mes || 0,
            status: t.status || t.subscription_status || 'ativo',
            environment: t.environment || 'simulado',
            bank_agency: t.bank_agency,
            bank_account: t.bank_account,
            bank_dac: t.bank_dac,
            has_pfx: !!t.pfx_filename,
            has_asaas: !!t.asaas_api_key_encrypted,
            has_microvix: !!t.microvix_token,
            created_at: t.created_at,
            updated_at: t.updated_at
        }));

        return res.status(200).json(tenants);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 3. Cadastrar Nova Empresa Cliente (Tenant)
router.post('/tenants/create', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { cnpj, razao_social, nome_fantasia, email_admin, plano, limite_guias_mes } = req.body;
        if (!cnpj || !razao_social) {
            return res.status(400).json({ error: "CNPJ e Razão Social são obrigatórios." });
        }

        const cleanCnpj = String(cnpj).replace(/\D/g, '');
        if (cleanCnpj.length !== 14) {
            return res.status(400).json({ error: "CNPJ inválido. Digite exatamente os 14 dígitos numéricos." });
        }

        const { data: existing } = await supabase.from('tenants').select('id, razao_social').eq('cnpj', cleanCnpj).maybeSingle();
        if (existing) {
            return res.status(400).json({ error: `Este CNPJ já está cadastrado para a empresa "${existing.razao_social}".` });
        }

        const { data: newTenant, error } = await supabase.from('tenants').insert([{
            cnpj: cleanCnpj,
            razao_social: String(razao_social).trim(),
            nome_fantasia: nome_fantasia ? String(nome_fantasia).trim() : String(razao_social).trim(),
            email_admin: email_admin ? String(email_admin).trim() : null,
            plano: plano || 'pro',
            limite_guias_mes: parseInt(limite_guias_mes, 10) || 1000,
            status: 'ativo',
            subscription_status: 'ativo',
            bank_agency: '0000',
            bank_account: '00000',
            bank_dac: '0'
        }]).select().single();

        if (error) {
            console.error("[Criar Empresa] Erro Supabase:", error);
            if (error.code === '23505') {
                return res.status(400).json({ error: "Este CNPJ já está cadastrado no sistema." });
            }
            return res.status(400).json({ error: error.message });
        }

        auditService.logAudit(supabase, {
            tenantId: newTenant.id,
            userId: req.user?.id,
            acao: 'CRIAR_EMPRESA',
            detalhe: `Nova empresa criada: ${razao_social} (CNPJ: ${cleanCnpj}) no plano ${plano || 'pro'}`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(201).json({ message: "Empresa cadastrada com sucesso!", tenant: newTenant });
    } catch (err) {
        console.error("[Criar Empresa] Erro capturado:", err);
        return res.status(400).json({ error: err.message || "Erro ao cadastrar empresa." });
    }
});

// 4. Bloquear/Desbloquear Empresa (Status da Licença)
router.post('/tenants/status', requireAuth, requireSuperAdmin, async (req, res) => {
    const { tenantId, status } = req.body;
    if (!tenantId || !status) {
        return res.status(400).json({ error: "Empresa e status são obrigatórios." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({ 
                subscription_status: status,
                status: status
            })
            .eq('id', tenantId);

        if (error) throw error;

        auditService.logAudit(supabase, {
            tenantId,
            userId: req.user?.id,
            acao: status === 'ativo' ? 'DESBLOQUEAR_EMPRESA' : 'BLOQUEAR_EMPRESA',
            detalhe: `Status da licença da empresa alterado para '${status}'`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: `Empresa atualizada para '${status}' com sucesso!` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 5. Atualizar Plano e Limite de Guias da Empresa
router.post('/tenants/plan', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { tenantId, plano, limite_guias_mes } = req.body;
        if (!tenantId || !plano) {
            return res.status(400).json({ error: "ID da empresa e plano são obrigatórios." });
        }

        const updates = { plano };
        if (limite_guias_mes !== undefined) {
            updates.limite_guias_mes = parseInt(limite_guias_mes, 10);
            updates.plan_limit_guides = parseInt(limite_guias_mes, 10);
        }

        const { error } = await supabase.from('tenants').update(updates).eq('id', tenantId);
        if (error) throw error;

        auditService.logAudit(supabase, {
            tenantId,
            userId: req.user?.id,
            acao: 'ALTERAR_PLANO',
            detalhe: `Plano alterado para ${plano} com limite de ${limite_guias_mes || 'padrão'} guias/mês`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.json({ message: `Plano da empresa atualizado para '${plano}' com sucesso!` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 6. Trilha de Auditoria Geral (LGPD & Compliance)
router.get('/audit-logs', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const tenantId = req.query.tenantId || null;
        const logs = await auditService.getRecentAuditLogs(supabase, { tenantId, limit });
        return res.json(logs);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 7. Listar todos os usuários/perfis cadastrados com seus respectivos tenants
router.get('/users', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('*, tenants(razao_social, cnpj)')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json(profiles);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 8. Criar um novo usuário vinculado a uma empresa (Tenant)
router.post('/users/create', requireAuth, requireSuperAdmin, async (req, res) => {
    const { email, password, name, tenantId, role, is_admin } = req.body;
    if (!email || !password || !tenantId) {
        return res.status(400).json({ error: "E-mail, senha e empresa são obrigatórios." });
    }

    try {
        const { data: userData, error: createUserError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });

        if (createUserError || !userData.user) {
            return res.status(400).json({ error: "Erro ao criar credenciais do usuário: " + (createUserError?.message || "Erro desconhecido") });
        }

        const newUser = userData.user;

        const userRole = role || (is_admin ? 'admin' : 'operador');
        const { error: profileError } = await supabase
            .from('profiles')
            .insert({
                id: newUser.id,
                tenant_id: tenantId,
                email: email,
                name: name || email.split('@')[0],
                role: userRole,
                is_admin: userRole === 'admin' || userRole === 'superadmin' || !!is_admin
            });

        if (profileError) {
            await supabase.auth.admin.deleteUser(newUser.id);
            return res.status(400).json({ error: "Erro ao criar perfil de usuário: " + profileError.message });
        }

        auditService.logAudit(supabase, {
            tenantId: tenantId,
            userId: req.user?.id,
            acao: 'CRIAR_USUARIO',
            detalhe: `Usuário ${email} criado com perfil '${userRole}'`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: "Usuário criado com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 9. Redefinir senha de um usuário existente
router.post('/users/reset-password', requireAuth, requireSuperAdmin, async (req, res) => {
    const userId = req.body.userId;
    const password = req.body.password || req.body.newPassword;
    if (!userId || !password) {
        return res.status(400).json({ error: "Usuário e nova senha são obrigatórios." });
    }

    try {
        const { error } = await supabase.auth.admin.updateUserById(userId, {
            password: password
        });

        if (error) throw error;

        auditService.logAudit(supabase, {
            userId: req.user?.id,
            acao: 'REDEFINIR_SENHA',
            detalhe: `Senha do usuário ID ${userId} redefinida pelo administrador`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: "Senha redefinida com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 10. Excluir usuário do sistema permanentemente
router.post('/users/delete', requireAuth, requireSuperAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: "ID do usuário é obrigatório." });
    }

    if (userId === req.user?.id) {
        return res.status(400).json({ error: "Você não pode excluir sua própria conta de administrador em uso." });
    }

    try {
        const { data: profile } = await supabase.from('profiles').select('email, name').eq('id', userId).single();
        const userEmail = profile?.email || userId;

        await supabase.from('profiles').delete().eq('id', userId);
        const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
        if (authErr) throw authErr;

        auditService.logAudit(supabase, {
            userId: req.user?.id,
            acao: 'EXCLUIR_USUARIO',
            detalhe: `Usuário ${userEmail} removido pelo administrador master`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: "Usuário removido com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
