require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const vndaService = require('../services/vnda_service');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function getEncryptionKey(keyStr) {
    return crypto.createHash('sha256').update(String(keyStr)).digest();
}

function decrypt(text, secretKey) {
    const str = String(text || '');
    if (!str.includes(':')) return str;
    const tryDecryptWithKey = (k) => {
        if (str.startsWith('gcm:')) {
            const [, ivHex, tagHex, encryptedHex] = str.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(tagHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        const parts = str.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', k, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    };
    try {
        return tryDecryptWithKey(secretKey);
    } catch {
        return null;
    }
}

async function runCheck() {
    console.log('--- INICIANDO DIAGNÓSTICO DO AMBIENTE REAL ---');
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('ERRO: SUPABASE_URL ou SUPABASE_KEY ausentes no .env');
        process.exit(1);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    // 1. Teste de conexão Supabase com campos base
    const { data: tenants, error: tErr } = await supabase
        .from('tenants')
        .select('id, cnpj, razao_social, vnda_shop_host, vnda_token_encrypted, microvix_cnpj');

    if (tErr) {
        console.error('Falha ao conectar no Supabase:', tErr.message);
        process.exit(1);
    }
    console.log(`[Supabase Real] Conectado com sucesso! Total de empresas cadastradas: ${tenants.length}`);

    // 2. Checagem da coluna settings
    const { data: colCheck, error: colErr } = await supabase.from('tenants').select('settings').limit(1);
    const hasSettingsCol = !colErr;
    console.log(`[Banco de Dados] Coluna 'settings' (JSONB) em tenants: ${hasSettingsCol ? 'PRESENTE' : 'PENDENTE (rodar migration: ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT \'{}\'::jsonb;)'}`);

    // 3. Localização do tenant BOAH
    const boah = tenants.find(t => t.cnpj === '10436619000105');
    if (boah) {
        console.log(`[Tenant BOAH Real] Localizado: ${boah.razao_social} (ID: ${boah.id})`);
        console.log(`  - Loja VNDA: ${boah.vnda_shop_host || 'Não informado'}`);
        console.log(`  - Token VNDA: ${boah.vnda_token_encrypted ? 'Configurado (criptografado)' : 'Não informado'}`);
        console.log(`  - CNPJ Microvix: ${boah.microvix_cnpj || 'Não informado'}`);

        // 4. Teste de API VNDA se houver token
        if (boah.vnda_token_encrypted && ENCRYPTION_KEY && boah.vnda_shop_host) {
            const key = getEncryptionKey(ENCRYPTION_KEY);
            const tokenDec = decrypt(boah.vnda_token_encrypted, key);
            if (tokenDec) {
                console.log('[VNDA Real] Testando conectividade com API Olist VNDA...');
                try {
                    const pedidos = await vndaService.listarPedidosRecentes(tokenDec, boah.vnda_shop_host, 5);
                    if (Array.isArray(pedidos)) {
                        console.log(`[VNDA Real] SUCESSO! Conexão ativa, retornou ${pedidos.length} pedidos recentes ao vivo.`);
                        if (pedidos.length > 0) {
                            console.log(`  - Exemplo pedido recente: ID #${pedidos[0].id || pedidos[0].code} - Status: ${pedidos[0].status} - Data: ${pedidos[0].received_at || pedidos[0].confirmed_at}`);
                        }
                    } else {
                        console.log('[VNDA Real] Resposta não array:', pedidos);
                    }
                } catch (vErr) {
                    console.warn('[VNDA Real] Erro ao chamar API Vnda:', vErr.message);
                }
            } else {
                console.log('[VNDA Real] Não foi possível decriptar o token com a ENCRYPTION_KEY atual.');
            }
        }
    } else {
        console.log('[Tenant BOAH] CNPJ 10436619000105 não encontrado na base.');
    }

    // 5. Total de guias
    const { count: totalGuides, error: gErr } = await supabase.from('guides').select('id', { count: 'exact', head: true });
    if (!gErr) {
        console.log(`[Guias/NFs Real] Total de guias registradas no Supabase: ${totalGuides}`);
    }

    console.log('--- DIAGNÓSTICO CONCLUÍDO COM SUCESSO ---');
}

runCheck().catch(err => {
    console.error('Erro no diagnóstico:', err);
});
