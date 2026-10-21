// services/audit_service.js
// Serviço de Auditoria, Conformidade LGPD e Rastreabilidade Operacional

const crypto = require('crypto');

/**
 * Mascara dados pessoais sensíveis conforme diretrizes da LGPD
 */
function maskCpf(cpf) {
    if (!cpf) return '';
    const clean = String(cpf).replace(/\D/g, '');
    if (clean.length === 11) {
        return `***.${clean.substring(3, 6)}.${clean.substring(6, 9)}-**`;
    }
    return '***.***.***-**';
}

function maskPhone(phone) {
    if (!phone) return '';
    const clean = String(phone).replace(/\D/g, '');
    if (clean.length >= 10) {
        return `(${clean.substring(0, 2)}) *****-${clean.slice(-4)}`;
    }
    return phone;
}

function maskEmail(email) {
    if (!email || !email.includes('@')) return email;
    const [user, domain] = email.split('@');
    if (user.length <= 2) return `**@${domain}`;
    return `${user[0]}***${user.slice(-1)}@${domain}`;
}

/**
 * Registra um evento de auditoria no Supabase na tabela audit_log
 */
async function logAudit(supabaseClient, { tenantId, userId, acao, detalhe, ipAddress }) {
    if (!supabaseClient) return;
    try {
        let detalheStr = '';
        if (typeof detalhe === 'object') {
            detalheStr = JSON.stringify(detalhe);
        } else {
            detalheStr = String(detalhe || '');
        }

        await supabaseClient.from('audit_log').insert([{
            tenant_id: tenantId || null,
            user_id: userId || null,
            acao: String(acao || 'OPERACAO').toUpperCase(),
            detalhe: detalheStr,
            ip_address: String(ipAddress || '127.0.0.1')
        }]);
    } catch (err) {
        console.warn("[AuditLog] Falha ao registrar log de auditoria:", err.message);
    }
}

/**
 * Consulta histórico recente de auditoria (para o Painel Admin)
 */
async function getRecentAuditLogs(supabaseClient, { tenantId = null, limit = 50 } = {}) {
    if (!supabaseClient) return [];
    try {
        let query = supabaseClient
            .from('audit_log')
            .select('*, tenants(razao_social, cnpj)')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (tenantId) {
            query = query.eq('tenant_id', tenantId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.warn("[AuditLog] Erro ao consultar logs de auditoria:", err.message);
        return [];
    }
}

module.exports = {
    maskCpf,
    maskPhone,
    maskEmail,
    logAudit,
    getRecentAuditLogs
};
