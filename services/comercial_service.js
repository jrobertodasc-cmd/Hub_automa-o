// services/comercial_service.js
// Configuração Comercial, Social Selling e Classificação de Campanhas Multi-Tenant

const { BOAH_CNPJ, HOLDING_CNPJ } = require('../src/config/constants');

function formatarNomePessoa(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .split(' ')
        .map(w => ['de', 'da', 'do', 'das', 'dos', 'e'].includes(w) ? w : (w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}

// Configuração padrão genérica para novos clientes SaaS
const CONFIG_COMERCIAL_PADRAO = {
    cuponsInstitucionais: ['BEMVINDA', 'PRIMEIRACOMPRA', 'FRETEGRATIS', 'BLACKFRIDAY', 'TROCA'],
    aliasesVendedora: [],
    tiposCupom: [
        { termos: ['BEMVINDA', 'PRIMEIRA'], tipo: '1ª Compra / Onboarding', badge: 'Boas-Vindas' }
    ],
    codigoVendaOnline: null
};

// Configuração comercial histórica da loja âncora (BOAH)
const CONFIG_COMERCIAL_BOAH = {
    cuponsInstitucionais: ['BEMVINDA', 'PRIMEIRACOMPRA', 'FRETEGRATIS', 'BLACKFRIDAY', 'AMOBOAH', 'ESTILOBOAH', 'NIVERBOAH', '+20OFF', 'TROCA', 'LANDY', 'SERRANO', 'JBATALHA'],
    aliasesVendedora: [
        { termos: ['MILA', 'CAMILA'], nome: 'Camila (Mila)', codigoLinx: '66', ocultarNoRanking: true },
        { termos: ['CLARACOELHO', 'CLARA_COELHO', 'COELHO'], prefixos: ['CLARA'], nome: 'Clara Coelho de Carvalho', codigoLinx: '151' }
    ],
    tiposCupom: [
        { termos: ['MILA'], tipo: 'Influencer Mila (Sócia)', badge: 'Influencer' },
        { termos: ['BEMVINDA', 'PRIMEIRA'], tipo: '1ª Compra / Onboarding', badge: 'Boas-Vindas' },
        { termos: ['ESTILO', 'BOAH'], tipo: 'Branding & Estilo BOAH', badge: 'Branding' },
        { termos: ['PASSY', 'BRU', 'LANE', 'CLARA'], tipo: 'Consultora Social Selling', badge: 'Consultora' }
    ],
    codigoVendaOnline: '3'
};

function getConfigComercial(tenant) {
    const t = tenant || {};
    const base = (t.cnpj === BOAH_CNPJ || t.cnpj === HOLDING_CNPJ) ? CONFIG_COMERCIAL_BOAH : CONFIG_COMERCIAL_PADRAO;
    const custom = t.settings && t.settings.comercial;
    if (!custom || typeof custom !== 'object') return base;
    const merged = { ...base, ...custom };
    if (Array.isArray(custom.cuponsInstitucionais)) {
        merged.cuponsInstitucionais = Array.from(new Set([...CONFIG_COMERCIAL_PADRAO.cuponsInstitucionais, ...custom.cuponsInstitucionais]));
    }
    return merged;
}

function aliasCasa(alias, textoUpper) {
    return (alias.termos || []).some(x => textoUpper.includes(String(x).toUpperCase())) ||
        (alias.prefixos || []).some(x => textoUpper.startsWith(String(x).toUpperCase()));
}

function aliasPorCodigo(cfg, cod) {
    return (cfg.aliasesVendedora || []).find(a => String(a.codigoLinx) === String(cod)) || null;
}

function sanitizarConfigComercial(body) {
    const listaTxt = (v, max = 200, len = 60) => (Array.isArray(v) ? v : [])
        .map(x => String(x || '').trim().toUpperCase().slice(0, len)).filter(Boolean).slice(0, max);
    const txt = (v, len = 80) => String(v || '').trim().slice(0, len);
    const out = {};
    if (body.cuponsInstitucionais !== undefined) out.cuponsInstitucionais = listaTxt(body.cuponsInstitucionais);
    if (body.aliasesVendedora !== undefined) {
        out.aliasesVendedora = (Array.isArray(body.aliasesVendedora) ? body.aliasesVendedora : []).slice(0, 100).map(a => ({
            termos: listaTxt(a.termos, 20),
            prefixos: listaTxt(a.prefixos, 20),
            nome: txt(a.nome),
            codigoLinx: a.codigoLinx ? txt(a.codigoLinx, 20) : null,
            ocultarNoRanking: !!a.ocultarNoRanking
        })).filter(a => a.nome && (a.termos.length || a.prefixos.length));
    }
    if (body.tiposCupom !== undefined) {
        out.tiposCupom = (Array.isArray(body.tiposCupom) ? body.tiposCupom : []).slice(0, 100).map(t => ({
            termos: listaTxt(t.termos, 20), tipo: txt(t.tipo), badge: txt(t.badge, 30) || 'Campanha'
        })).filter(t => t.tipo && t.termos.length);
    }
    if (body.codigoVendaOnline !== undefined) out.codigoVendaOnline = body.codigoVendaOnline ? txt(body.codigoVendaOnline, 20) : null;
    return out;
}

function resolverVendedora(rawIdentifier, linxCatalog, cfg = CONFIG_COMERCIAL_PADRAO) {
    const raw = String(rawIdentifier || '').trim();
    if (!raw) return null;

    const up = raw.toUpperCase();

    // 1. Cupons ligados a uma pessoa especifica (configuravel por tenant)
    for (const alias of (cfg.aliasesVendedora || [])) {
        if (aliasCasa(alias, up)) {
            const cat = alias.codigoLinx ? (linxCatalog?.byCode ? linxCatalog.byCode.get(String(alias.codigoLinx)) : null) : null;
            return {
                nome: cat && cat.nome_vendedor ? formatarNomePessoa(cat.nome_vendedor) : alias.nome,
                codigoLinx: alias.codigoLinx || null,
                canal: alias.codigoLinx ? `Social Selling (Linx #${alias.codigoLinx})` : 'Social Selling VNDA',
                ativo: true,
                ocultarNoRanking: !!alias.ocultarNoRanking
            };
        }
    }

    // 2. Busca por código de vendedor estrito no Linx Microvix
    const matchCode = raw.match(/^L?(\d+)$/i);
    if (matchCode && linxCatalog?.byCode) {
        const codStr = matchCode[1];
        const match = linxCatalog.byCode.get(codStr);

        if (match) {
            if (match.tipo === 'A' && match.ativo === '0' && !aliasPorCodigo(cfg, codStr)) {
                return null;
            }

            let nomeLimpo = formatarNomePessoa(match.nome_vendedor);
            if (cfg.codigoVendaOnline && codStr === String(cfg.codigoVendaOnline)) {
                return {
                    nome: 'Venda Online',
                    codigoLinx: '3',
                    canal: 'Loja Online (Linx #3)',
                    ativo: match.ativo === '1'
                };
            }
            const aliasCod = aliasPorCodigo(cfg, codStr);
            if (aliasCod) {
                nomeLimpo = aliasCod.nome;
            }
            return {
                nome: nomeLimpo,
                codigoLinx: match.cod_vendedor,
                canal: `Social Selling (Linx #${match.cod_vendedor})`,
                ativo: match.ativo === '1',
                ocultarNoRanking: !!(aliasCod && aliasCod.ocultarNoRanking)
            };
        }
    }

    // 3. Fallback inteligente para cupons nominais de consultoras (ex: LANESANTOS, FLAVIAPEREIRA, JEUANDRADE, PASSY10, LORI10)
    if (/^[a-f0-9]{8,}$/i.test(raw) || (/^[0-9a-z_]{8,}$/i.test(raw) && !/[aeiouy]/i.test(raw))) {
        return null;
    }

    // Remove sufixos de desconto (ex: 10, 15, 20, 20OFF, OFF)
    let nomeLimpo = up.replace(/(\d+OFF|\d+|OFF)$/, '').trim();
    const cuponsInstitucionais = (cfg.cuponsInstitucionais || []).map(c => String(c).toUpperCase());
    
    if (nomeLimpo.length >= 3 && !cuponsInstitucionais.some(c => nomeLimpo.includes(c))) {
        return {
            nome: formatarNomePessoa(nomeLimpo),
            codigoLinx: null,
            canal: 'Social Selling VNDA',
            ativo: true
        };
    }

    return null;
}

module.exports = {
    formatarNomePessoa,
    CONFIG_COMERCIAL_PADRAO,
    CONFIG_COMERCIAL_BOAH,
    getConfigComercial,
    aliasCasa,
    aliasPorCodigo,
    sanitizarConfigComercial,
    resolverVendedora
};
