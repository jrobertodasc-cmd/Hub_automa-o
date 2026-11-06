// src/utils/tenantHelper.js
// Funções auxiliares para resolução de credenciais, escopo de Tenants e formatação

const { BOAH_CNPJ, HOLDING_CNPJ } = require('../config/constants');
const printService = require('../../services/print_service');

function getTenantMicrovixUser(tenant) {
    const t = tenant || {};
    if (t.microvix_user) return t.microvix_user;
    if (t.cnpj === BOAH_CNPJ || t.cnpj === HOLDING_CNPJ) return 'linx_b2c';
    return '';
}

function credenciaisTotalExpress(tenant) {
    const t = tenant || {};
    const usaEnv = t.cnpj === BOAH_CNPJ || t.cnpj === HOLDING_CNPJ;
    return {
        user: t.total_express_user || (usaEnv ? process.env.TOTAL_EXPRESS_USER : '') || '',
        password: t.total_express_password || (usaEnv ? process.env.TOTAL_EXPRESS_PASSWORD : '') || '',
        remetenteId: t.total_express_remetente_id || (usaEnv ? process.env.TOTAL_EXPRESS_REMETENTE_ID : '') || ''
    };
}

async function resolverTenantHolding(tenant, supabase) {
    if (tenant && tenant.cnpj === HOLDING_CNPJ) {
        try {
            const { data } = await supabase.from('tenants').select('*').eq('cnpj', BOAH_CNPJ).limit(1);
            if (data && data.length > 0) return data[0];
        } catch (e) {}
    }
    return tenant;
}

function periodoParaDatas(periodo, q) {
    const fmt = d => d.toISOString().slice(0, 10);
    const agora = new Date(Date.now() - 3 * 3600 * 1000); // Horario de Brasilia
    const y = agora.getUTCFullYear(), m = agora.getUTCMonth();
    if (q && q.dataInicial && q.dataFim) return { ini: String(q.dataInicial), fim: String(q.dataFim) };
    if (periodo === 'mes_anterior') return { ini: fmt(new Date(Date.UTC(y, m - 1, 1))), fim: fmt(new Date(Date.UTC(y, m, 0))) };
    if (periodo === '7dias') return { ini: fmt(new Date(agora.getTime() - 6 * 86400000)), fim: fmt(agora) };
    return { ini: fmt(new Date(Date.UTC(y, m, 1))), fim: fmt(agora) };
}

function normalizarTransportadora(nomeOuCnpj) {
    if (!nomeOuCnpj) return 'Total Express';
    const str = String(nomeOuCnpj).toUpperCase().trim();
    if (str.includes('TOTAL') || str.includes('TEX COURIER') || str.includes('TEX') || str.includes('DLOG') || str.includes('73939449')) {
        return 'Total Express';
    }
    if (str.includes('CORREIO') || str.includes('ECT') || str.includes('EBCT') || str.includes('SEDEX') || str.includes('PAC') || str.includes('34028316')) {
        return 'Correios';
    }
    if (str.includes('JADLOG') || str.includes('JAD')) return 'Jadlog';
    if (str.includes('LOGGI')) return 'Loggi';
    if (str.includes('MELHOR')) return 'Melhor Envio';
    if (str.includes('AZUL')) return 'Azul Cargo';
    if (str.includes('BRASPRESS')) return 'Braspress';
    return (nomeOuCnpj || 'Total Express').trim();
}

function obterDataHojeBrasilIso() {
    try {
        return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    } catch {
        return new Date().toISOString().slice(0, 10);
    }
}

function situacaoPagamentoGuia(g) {
    if (!g) return 'sem_guia';
    const st = String(g.status || '').toLowerCase().trim();
    const bar = String(g.barcode || '').replace(/\D/g, '');
    const val = parseFloat(g.value || g.valor || 0);

    // 1. Pagas / Liquidadas (ou isentas / valor zerado)
    if (['paga', 'comprovada', 'liquidada', 'baixada', 'pago'].includes(st) || !!g.paid_at || g.receipt_storage_path || g.bank_authentication || val <= 0) {
        return 'paga';
    }

    // 2. Não Pagas / Retidas
    if (g.barcode === 'IMPORTAR_NO_SEFAZ_SP') return 'sp_manual';
    if (['rejeitada', 'rejeitada_sefaz', 'erro_pagamento', 'divergencia_uf_portal', 'cancelada', 'pendente_xml'].includes(st)) {
        return 'rejeitada';
    }
    if (bar.length < 44) {
        return 'sem_guia';
    }

    // 3. Agendada ou em processamento bancário
    if (['agendada', 'pagamento_autorizado', 'pagamento_enviado', 'pagamento_em_processamento', 'remessa_gerada'].includes(st)) {
        return 'agendada';
    }

    // 4. Pendente pronta para entrar em lote de remessa
    return 'a_pagar';
}

function extrairVencimentoGuiaReal(g) {
    if (!g) return null;
    if (g.due_date && /^\d{4}-\d{2}-\d{2}$/.test(String(g.due_date).slice(0, 10))) {
        return String(g.due_date).slice(0, 10);
    }
    const vencBar = printService.extrairVencimentoDeBarcodeGnre(g.barcode);
    if (vencBar && /^\d{4}-\d{2}-\d{2}$/.test(vencBar)) return vencBar;
    const mSp = String(g.line_digitizable || '').match(/Venc\.\s*(\d{2})\/(\d{2})\/(\d{4})/);
    if (mSp) return `${mSp[3]}-${mSp[2]}-${mSp[1]}`;
    return null;
}

module.exports = {
    getTenantMicrovixUser,
    credenciaisTotalExpress,
    resolverTenantHolding,
    periodoParaDatas,
    normalizarTransportadora,
    obterDataHojeBrasilIso,
    situacaoPagamentoGuia,
    extrairVencimentoGuiaReal
};
