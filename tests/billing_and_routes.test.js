// tests/billing_and_routes.test.js
// Testes automatizados para Rotas Modularizadas, Gestão de Planos e Assinaturas SaaS

const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const http = require('http');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SUPABASE_URL = 'http://fake';
process.env.SUPABASE_KEY = 'fake';
process.env.ENCRYPTION_KEY = 'test-key';
process.env.NODE_ENV = 'test';
process.env.ASAAS_WEBHOOK_TOKEN = 'token-global-asaas';

const enc = (t) => {
    const key = crypto.createHash('sha256').update('test-key').digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    let e = c.update(t, 'utf8', 'hex'); e += c.final('hex');
    return `gcm:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e}`;
};

const NOVO = { 
    id: 't-novo', 
    cnpj: '11111111000111', 
    razao_social: 'CLIENTE NOVO', 
    subscription_status: 'trial',
    limite_guias_mes: 10,
    guias_usadas_mes: 2
};

const tenants = [NOVO];
const users = { 'u-novo-token': 'u-novo' };
const profiles = [
    { id: 'u-novo', tenant_id: 't-novo', role: 'admin', is_admin: true, email: 'novo@teste.com' }
];

const tables = { tenants, profiles, audit_log: [], guides: [], batches: [] };

function qb(table) {
    let rows = tables[table] || [];
    let single = false;
    let updatePayload = null;
    let insertPayload = null;
    let filterCol = null;
    let filterVal = null;

    const api = {
        select() { return api; },
        eq(c, v) { 
            filterCol = c;
            filterVal = v;
            rows = rows.filter(r => r[c] === v); 
            return api; 
        },
        single() { single = true; return api; },
        maybeSingle() { single = true; return api; },
        limit() { return api; },
        insert(data) {
            insertPayload = data;
            const toAdd = Array.isArray(data) ? data : [data];
            toAdd.forEach(item => {
                if (!item.id) item.id = 'gen_' + Math.random().toString(36).substring(2, 9);
                if (tables[table]) tables[table].push(item);
            });
            rows = toAdd;
            return api;
        },
        update(data) {
            updatePayload = data;
            return api;
        },
        then(res, rej) {
            if (updatePayload && filterCol && filterVal) {
                (tables[table] || []).forEach(r => {
                    if (r[filterCol] === filterVal) {
                        Object.assign(r, updatePayload);
                    }
                });
            }
            let out;
            if (table === 'profiles') {
                rows = rows.map(p => ({ ...p, tenants: tenants.find(t => t.id === p.tenant_id) }));
            }
            out = single ? { data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } } : { data: rows, error: null };
            return Promise.resolve(out).then(res, rej);
        }
    };
    return api;
}

const fakeSb = {
    createClient: () => ({
        from: qb,
        auth: { 
            getUser: async (t) => users[t] ? { data: { user: { id: users[t], email: 'x@x.com' } }, error: null } : { data: { user: null }, error: { message: 'bad' } },
            admin: {
                createUser: async ({ email, password }) => ({ data: { user: { id: 'u_reg_' + Date.now(), email } }, error: null }),
                deleteUser: async () => ({ error: null })
            }
        },
        storage: { from: () => ({ upload: async () => ({}), download: async () => ({}), getPublicUrl: () => ({ data: {} }), createSignedUrl: async () => ({}) }) }
    })
};

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
    if (req === '@supabase/supabase-js') return fakeSb;
    return origLoad.apply(this, arguments);
};

const app = require(path.join(ROOT, 'server.js'));

(async () => {
    let fails = 0;
    const ok = (cond, msg) => {
        if (!cond) { console.error('FAIL:', msg); fails++; }
        else { console.log('PASS', msg); }
    };

    const request = (url, token = null, method = 'GET', body = null, headers = {}) => new Promise((resolve) => {
        const sock = new net.Socket();
        Object.defineProperty(sock, 'remoteAddress', { value: '127.0.0.1' });
        const req = new http.IncomingMessage(sock);
        req.method = method;
        req.url = url;
        req.headers = { host: 'localhost', ...headers };
        if (token) req.headers.authorization = 'Bearer ' + token;
        if (body) {
            req.body = body;
            req.headers['content-type'] = 'application/json';
        }
        const res = new http.ServerResponse(req);
        res.end = (chunk) => {
            let b = null;
            try { b = JSON.parse(String(chunk)); } catch {}
            resolve({ s: res.statusCode, b });
            return res;
        };
        app.handle(req, res, () => resolve({ s: 404, b: null }));
    });

    try {
        console.log('\n--- 1. TESTES DE GESTÃO DE PLANOS E ASSINATURA SAAS ---');
        
        // 1.1 Listagem pública de planos
        let r = await request('/api/billing/plans');
        ok(r.s === 200, 'GET /api/billing/plans retorna 200');
        ok(r.b.plans?.starter?.guideLimit === 100, 'Plano starter possui limite de 100 guias');
        ok(r.b.plans?.pro?.guideLimit === 500, 'Plano pro possui limite de 500 guias');
        ok(r.b.plans?.advanced?.guideLimit === 1500, 'Plano advanced possui limite de 1500 guias');

        // 1.2 Status sem autenticação => 401
        r = await request('/api/billing/status');
        ok(r.s === 401, 'GET /api/billing/status sem login => 401');

        // 1.3 Status do tenant com login
        r = await request('/api/billing/status', 'u-novo-token');
        ok(r.s === 200, 'GET /api/billing/status com login => 200');
        ok(r.b.plan === 'trial', 'Tenant novo começa com plano trial');
        ok(r.b.usage?.guidesLimit === 10, 'Limite inicial trial = 10 guias');

        // 1.4 Assinatura / Upgrade para o plano Pro
        r = await request('/api/billing/subscribe', 'u-novo-token', 'POST', { plan: 'pro', cycle: 'mensal', billingType: 'PIX' });
        ok(r.s === 200, 'POST /api/billing/subscribe => 200 (upgrade confirmado)');
        ok(r.b.guideLimit === 500, 'Novo limite retornado: 500');

        // 1.5 Verifica novo status após upgrade
        r = await request('/api/billing/status', 'u-novo-token');
        ok(r.b.plan === 'pro', 'Status agora reflete plano pro');
        ok(r.b.usage?.guidesLimit === 500, 'Limite atualizado no banco para 500 guias');

        console.log('\n--- 2. TESTES DE CADASTRO PÚBLICO E ONBOARDING ---');

        // 2.1 Validação de CNPJ inválido
        r = await request('/api/auth/register', null, 'POST', {
            email: 'lead@empresa.com',
            password: 'senhaSegura123',
            name: 'Diretor Teste',
            cnpj: '123', // CNPJ inválido
            razao_social: 'Empresa Teste LTDA'
        });
        ok(r.s === 400, 'Cadastro recusa CNPJ com tamanho diferente de 14 dígitos');

        // 2.2 Validação de Senha curta
        r = await request('/api/auth/register', null, 'POST', {
            email: 'lead@empresa.com',
            password: '123', // Senha < 8 chars
            name: 'Diretor Teste',
            cnpj: '12345678000199',
            razao_social: 'Empresa Teste LTDA'
        });
        ok(r.s === 400, 'Cadastro recusa senha com menos de 8 caracteres');

        // 2.3 Cadastro público válido
        r = await request('/api/auth/register', null, 'POST', {
            email: 'novo.cliente@ecommerce.com.br',
            password: 'SenhaForte2026!',
            name: 'Mariana Gestora',
            cnpj: '99.888.777/0001-66',
            razao_social: 'Mariana Modas LTDA',
            plan: 'starter'
        });
        ok(r.s === 200, 'Cadastro autônomo concluído com sucesso (status 200)');
        ok(!!r.b.tenantId, 'Retornou ID do novo tenant criado');

        console.log('\n--- 3. TESTE DE ATIVAÇÃO DE ASSINATURA VIA WEBHOOK ASAAS ---');

        // 3.1 Webhook Asaas recebe confirmação de pagamento de assinatura
        r = await request('/api/webhooks/asaas', null, 'POST', {
            event: 'PAYMENT_RECEIVED',
            payment: {
                id: 'pay_sub_999',
                externalReference: 'sub_tenant_t-novo_advanced'
            }
        }, { 'asaas-access-token': 'token-global-asaas' });
        ok(r.s === 200, 'Webhook de pagamento de assinatura aceito (status 200)');

        // 3.2 Verifica que o tenant subiu para Advanced automaticamente
        r = await request('/api/billing/status', 'u-novo-token');
        ok(r.b.plan === 'advanced', 'Tenant automaticamente promovido para plano Advanced via Webhook!');
        ok(r.b.usage?.guidesLimit === 1500, 'Limite mensal atualizado para 1500 guias!');

    } catch (e) {
        console.error('ERRO nos testes de billing/rotas:', e);
        fails++;
    }

    console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES DE BILLING E ROTAS PASSARAM COM SUCESSO!');
    process.exit(fails ? 1 : 0);
})();
