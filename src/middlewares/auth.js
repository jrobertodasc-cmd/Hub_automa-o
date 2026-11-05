// src/middlewares/auth.js
// Middlewares de autenticação, RBAC e validação de assinatura SaaS

const supabase = require('../config/supabase');
const { MASTER_SUPERADMIN_EMAILS } = require('../config/constants');
const auditService = require('../../services/audit_service');

const requireAuth = async (req, res, next) => {
    const token = req.cookies?.sb_access_token || 
                  req.headers.authorization?.replace(/^Bearer\s+/i, '') || 
                  req.query?.token;

    const isApi = (req.originalUrl || req.baseUrl || req.path || '').startsWith('/api/');

    if (!token) {
        if (req.accepts('html') && !isApi) {
            return res.redirect('/login.html');
        }
        return res.status(401).json({ error: "Acesso não autorizado: credenciais ausentes. Realize login." });
    }
    
    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            if (req.accepts('html') && !isApi) {
                return res.redirect('/login.html');
            }
            return res.status(401).json({ error: "Sessão inválida ou expirada. Realize login novamente." });
        }

        // Busca o perfil do usuário e dados do tenant correspondente
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*, tenants(*)')
            .eq('id', user.id)
            .single();

        if (profileError || !profile) {
            return res.status(403).json({ error: "Perfil de usuário não localizado no sistema." });
        }

        let tenant = profile.tenants;
        if (Array.isArray(tenant)) {
            tenant = tenant[0];
        }

        if (!tenant) {
            return res.status(403).json({ error: "Nenhuma empresa vinculada ao perfil deste usuário." });
        }

        // Resolução estrita de privilégios (RBAC)
        const userEmail = (user.email || profile.email || '').toLowerCase().trim();
        let determinedRole = 'operador';

        if (MASTER_SUPERADMIN_EMAILS.includes(userEmail)) {
            determinedRole = 'superadmin';
            profile.is_admin = true;
        } else if (profile.role) {
            const r = String(profile.role).toLowerCase().trim();
            determinedRole = (r === 'operator') ? 'operador' : r;
        } else if (profile.is_admin) {
            determinedRole = 'admin';
        }

        profile.role = determinedRole;

        req.user = user;
        req.profile = profile;
        req.tenant = tenant;
        next();
    } catch (err) {
        console.error("[requireAuth] Erro ao validar credenciais:", err.message);
        if (req.accepts('html') && !isApi) {
            return res.redirect('/login.html');
        }
        return res.status(401).json({ error: "Falha na validação de credenciais: " + err.message });
    }
};

// Middleware de RBAC (Role-Based Access Control)
const requireRole = (allowedRoles = []) => {
    return (req, res, next) => {
        if (!req.profile) {
            return res.status(401).json({ error: "Usuário não autenticado." });
        }

        const userRole = (req.profile.role || 'operador').toLowerCase();

        // SuperAdmin tem acesso irrestrito
        if (userRole === 'superadmin') {
            return next();
        }

        const normalizedAllowed = allowedRoles.map(r => {
            const low = r.toLowerCase();
            return low === 'operator' ? 'operador' : low;
        });

        if (!normalizedAllowed.includes(userRole)) {
            auditService.logAudit(supabase, {
                tenantId: req.tenant?.id,
                userId: req.user?.id,
                acao: 'ACESSO_NEGADO_RBAC',
                detalhe: `Perfil '${userRole}' tentou acessar rota restrita: ${req.method} ${req.originalUrl}`,
                ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
            });

            return res.status(403).json({
                error: `Acesso não autorizado: seu perfil ('${userRole}') não tem permissão para esta ação. Requer: [${allowedRoles.join(', ')}].`,
                currentRole: userRole,
                allowedRoles: allowedRoles
            });
        }
        next();
    };
};

// Middleware exclusivo para SuperAdmin Master da plataforma SaaS
const requireSuperAdmin = (req, res, next) => {
    const userRole = (req.profile?.role || '').toLowerCase();
    if (userRole !== 'superadmin') {
        auditService.logAudit(supabase, {
            tenantId: req.tenant?.id,
            userId: req.user?.id,
            acao: 'ACESSO_NEGADO_SUPERADMIN',
            detalhe: `Tentativa de acesso não autorizado à rota administrativa master: ${req.method} ${req.originalUrl}`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });
        return res.status(403).json({ error: "Acesso restrito exclusivamente aos administradores master da plataforma (SuperAdmin)." });
    }
    next();
};

// Middleware para administradores (da loja ou master)
const requireAdmin = (req, res, next) => {
    const role = (req.profile?.role || '').toLowerCase();
    const isAdmin = req.profile?.is_admin || role === 'admin' || role === 'superadmin';
    if (!isAdmin) {
        return res.status(403).json({ error: "Acesso negado. Apenas administradores podem acessar esta área." });
    }
    next();
};

const requireActiveSubscription = (req, res, next) => {
    if (req.tenant) {
        const status = (req.tenant.status || req.tenant.subscription_status || 'ativo').toLowerCase();
        if (status === 'bloqueado' || status === 'inativo' || status === 'suspenso') {
            return res.status(403).json({ error: "Assinatura do expedi HUB suspensa ou bloqueada. Regularize seu plano com o administrador." });
        }

        const limite = req.tenant.limite_guias_mes || req.tenant.plan_limit_guides || 1000;
        const usadas = req.tenant.guias_usadas_mes || 0;
        if (limite > 0 && usadas >= limite) {
            return res.status(403).json({ error: `Limite mensal de emissão de guias do seu plano atingido (${usadas}/${limite} guias). Contate o suporte para upgrade de plano.` });
        }
    }
    next();
};

module.exports = {
    requireAuth,
    requireRole,
    requireSuperAdmin,
    requireAdmin,
    requireActiveSubscription
};
