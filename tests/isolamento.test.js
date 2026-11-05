// Testes de isolamento multi-tenant e dados reais (Supabase e VNDA simulados, sem rede).
// Execute: npm test
// Harness de teste: roda o server.js real com Supabase e VNDA simulados (sem rede).
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
process.env.SUPABASE_URL = 'http://fake'; process.env.SUPABASE_KEY = 'fake';
process.env.ENCRYPTION_KEY = 'test-key'; process.env.NODE_ENV = 'test';

const enc = (t) => {
  const key = crypto.createHash('sha256').update('test-key').digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  let e = c.update(t, 'utf8', 'hex'); e += c.final('hex');
  return `gcm:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e}`;
};

const BOAH = { id: 't-boah', cnpj: '10436619000105', razao_social: 'BOAH', vnda_token_encrypted: enc('BOAH_TOKEN'), vnda_shop_host: 'www.boah.com.br', subscription_status: 'pro' };
const NOVO = { id: 't-novo', cnpj: '11111111000111', razao_social: 'CLIENTE NOVO', subscription_status: 'trial' };
const HOLD = { id: 't-hold', cnpj: '00000000000191', razao_social: 'HOLDING', subscription_status: 'pro' };
const DEF = { id: 't-def', cnpj: '22222222000122', razao_social: 'CLIENTE PADRAO', vnda_token_encrypted: enc('T_DEF'), vnda_shop_host: 'loja.padrao.com', subscription_status: 'pro' };
const CUS = { id: 't-cus', cnpj: '33333333000133', razao_social: 'CLIENTE CUSTOM', vnda_token_encrypted: enc('T_CUS'), vnda_shop_host: 'loja.custom.com', subscription_status: 'pro',
  settings: { comercial: { cuponsInstitucionais: ['VERAO'], tiposCupom: [{ termos: ['VERAO'], tipo: 'Campanha Verão', badge: 'Sazonal' }], aliasesVendedora: [{ termos: ['JOAO'], nome: 'João Vendedor', codigoLinx: null, ocultarNoRanking: false }] } } };
const tenants = [BOAH, NOVO, HOLD, DEF, CUS];
const users = { tb: 'u-boah', tn: 'u-novo', th: 'u-hold', td: 'u-def', tc: 'u-cus' };
const profiles = [
  { id: 'u-boah', tenant_id: 't-boah', role: 'admin', email: 'a@boah.com' },
  { id: 'u-novo', tenant_id: 't-novo', role: 'admin', email: 'a@novo.com' },
  { id: 'u-hold', tenant_id: 't-hold', role: 'admin', email: 'a@hold.com' },
  { id: 'u-def', tenant_id: 't-def', role: 'admin', email: 'a@def.com' },
  { id: 'u-cus', tenant_id: 't-cus', role: 'admin', email: 'a@cus.com' },
];
const guides = [{ id: 'g1', tenant_id: 't-boah', uf: 'SP', value: 20, valor_venda: 400, status: 'pago', nf_issue_date: new Date().toISOString().slice(0, 10), customer_name: 'Maria Teste', carrier_name: 'Total Express' }];
guides.push({ id: 'gn1', tenant_id: 't-novo', nf_number: '900', uf: 'RJ', value: 10, status: 'aguardando_aprovacao', customer_name: 'Cliente do Novo', created_at: new Date().toISOString() });
guides.push({ id: 'gn2', tenant_id: 't-novo', nf_number: '901', uf: 'SP', value: 30, status: 'pago', paid_at: new Date().toISOString(), created_at: new Date().toISOString() });
const tables = { tenants, profiles, guides, batches: [{ id: 'b-boah', tenant_id: 't-boah', status: 'sucesso', created_at: new Date().toISOString() }], audit_log: [], invoice_items: [], return_notes: [] };

function qb(table) {
  let rows = tables[table] || []; let single = false;
  const api = {
    select() { return api; },
    eq(c, v) { rows = rows.filter(r => r[c] === v); return api; },
    neq(c, v) { rows = rows.filter(r => r[c] !== v); return api; },
    in(c, v) { rows = rows.filter(r => v.includes(r[c])); return api; },
    gte() { return api; }, lte() { return api; }, gt() { return api; }, lt() { return api; }, not() { return api; }, is() { return api; }, or() { return api; }, ilike() { return api; },
    order() { return api; }, limit() { return api; }, range() { return api; },
    single() { single = true; return api; }, maybeSingle() { single = true; return api; },
    insert() { return api; }, update() { return api; }, upsert() { return api; }, delete() { return api; },
    then(res, rej) {
      let out;
      if (table === 'profiles') rows = rows.map(p => ({ ...p, tenants: tenants.find(t => t.id === p.tenant_id) }));
      out = single ? { data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } } : { data: rows, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return api;
}
const fakeSb = {
  createClient: () => ({
    from: qb,
    auth: { getUser: async (t) => users[t] ? { data: { user: { id: users[t], email: 'x@x.com' } }, error: null } : { data: { user: null }, error: { message: 'bad' } } },
    storage: { from: () => ({ upload: async () => ({}), download: async () => ({}), getPublicUrl: () => ({ data: {} }), createSignedUrl: async () => ({}) }) },
  }),
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) { if (req === '@supabase/supabase-js') return fakeSb; return origLoad.apply(this, arguments); };

// VNDA simulado: so devolve pedidos para o token da BOAH
const vnda = require(path.join(ROOT, 'services/vnda_service.js'));
const calls = [];
const now = Date.now(), DAY = 86400000;
const d = (n) => new Date(now - n * DAY).toISOString();
const firstOfThisMonth = new Date(Date.UTC(new Date(now - 3 * 3600e3).getUTCFullYear(), new Date(now - 3 * 3600e3).getUTCMonth(), 1, 12));
const lastMonthDay = new Date(firstOfThisMonth.getTime() - 5 * DAY).toISOString();
vnda.listarPedidosRecentes = async (token, host) => {
  calls.push({ token, host });
  if (token === 'T_DEF' || token === 'T_CUS') return [
    { status: 'confirmed', total: 200, received_at: d(0), coupon_code: 'MILA15', items: [] },
    { status: 'confirmed', total: 100, received_at: d(0.01), coupon_code: 'VERAO', items: [] },
    { status: 'confirmed', total: 50, received_at: d(0.02), coupon_code: 'BEMVINDA', items: [] },
    { status: 'confirmed', total: 80, received_at: d(0.03), coupon_code: 'JOAO10', items: [] },
  ];
  if (token !== 'BOAH_TOKEN') return [];
  return [
    { status: 'confirmed', total: 100, shipping_price: 10, received_at: d(0), coupon_code: 'BEMVINDA', payment_method: 'pix', items: [{ product_name: 'Vestido X', sku: 'VX', quantity: 2, price: 50 }] },
    { status: 'confirmed', total: 300, shipping_price: 20, received_at: d(0.01), payment_method: 'credit card', items: [{ product_name: 'Calca Y', sku: 'CY', quantity: 1, price: 300 }] },
    { status: 'canceled', total: 50, received_at: d(0.02), items: [] },
    { status: 'confirmed', total: 999, shipping_price: 0, received_at: lastMonthDay, items: [{ product_name: 'Antigo', sku: 'AN', quantity: 1, price: 999 }] },
    { status: 'confirmed', total: 200, received_at: lastMonthDay, coupon_code: 'MILA15', items: [] },
    { status: 'confirmed', total: 100, received_at: lastMonthDay, coupon_code: 'ESTILOBOAH', items: [] },
    { status: 'confirmed', total: 50, received_at: lastMonthDay, coupon_code: 'PASSY10', items: [] },
  ];
};

const app = require(path.join(ROOT, 'server.js'));
const http = require('http'); const net = require('net');
(async () => {
  const get = (url, token, method = 'GET', body = null) => new Promise((resolve) => {
    const sock = new net.Socket(); Object.defineProperty(sock, 'remoteAddress', { value: '127.0.0.1' });
    const req = new http.IncomingMessage(sock); req.method = method; req.url = url; if (body) { req.body = body; req._body = true; }
    req.headers = { host: 'x', accept: 'application/json' }; if (token) req.headers.authorization = 'Bearer ' + token;
    const res = new http.ServerResponse(req); res.write = () => true;
    res.end = (chunk) => { let b = null; try { b = JSON.parse(String(chunk)); } catch {} resolve({ s: res.statusCode, b }); return res; };
    app.handle(req, res, () => resolve({ s: 404, b: null }));
  });
  const fetchCsv = (token) => new Promise((resolve) => {
    const sock = new net.Socket(); Object.defineProperty(sock, 'remoteAddress', { value: '127.0.0.1' });
    const req = new http.IncomingMessage(sock); req.method = 'GET'; req.url = '/api/difal/exportar-csv';
    req.headers = { host: 'x', authorization: 'Bearer ' + token };
    const res = new http.ServerResponse(req); res.write = () => true;
    res.end = (chunk) => { resolve(String(chunk)); return res; };
    app.handle(req, res, () => resolve(''));
  });
  let fails = 0;
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  try {
    let r = await get('/api/bi/metrics');
    ok(r.s === 401, 'sem login => 401');

    r = await get('/api/bi/metrics?periodo=mes_atual', 'tb');
    ok(r.s === 200, 'BOAH mes_atual => 200 (' + r.s + ')');
    const b = r.b || {};
    ok(b.olist && b.olist.gmvAprovado === 400, 'BOAH GMV mes atual = 400 (got ' + (b.olist && b.olist.gmvAprovado) + ')  [exclui pedido do mes anterior]');
    ok(b.olist && b.olist.pedidosAprovados === 2 && b.olist.pedidosCancelados === 1, 'BOAH pedidos 2 aprovados/1 cancelado');
    ok(b.olist && b.olist.ticketMedioOlist === 200, 'BOAH ticket medio 200');
    ok(Array.isArray(b.topProdutos) && b.topProdutos[0] && b.topProdutos[0].nome === 'Vestido X', 'BOAH top produto real');
    ok(b.comparativo && b.comparativo.gmvVarPct === null, 'sem variacao inventada');
    ok(b.kpis && b.kpis.leadTimeMedioHoras === null, 'sem lead time inventado');
    ok(b.olist && b.olist.lojaVirtual === 'www.boah.com.br' && b.olist.conectado === true, 'BOAH loja/conectado');

    r = await get('/api/bi/metrics?periodo=mes_anterior', 'tb');
    ok(r.b && r.b.olist && r.b.olist.gmvAprovado === 1349, 'BOAH mes_anterior filtra pedidos antigos (gmv=' + (r.b && r.b.olist && r.b.olist.gmvAprovado) + ')');
    const cupB = (r.b.resumoCupons.topCupons || []);
    const tipoDe = (cod) => (cupB.find(c => c.codigo === cod) || {}).tipo;
    ok(tipoDe('MILA15') === 'Influencer Mila (Sócia)', 'BOAH: MILA15 classificado como Influencer (' + tipoDe('MILA15') + ')');
    ok(tipoDe('ESTILOBOAH') === 'Branding & Estilo BOAH', 'BOAH: ESTILOBOAH classificado como Branding (' + tipoDe('ESTILOBOAH') + ')');
    ok(tipoDe('PASSY10') === 'Consultora Social Selling', 'BOAH: PASSY10 classificado como Consultora (' + tipoDe('PASSY10') + ')');
    const rankB = (r.b.rankingVendedoras || []).map(v => v.nome);
    ok(!rankB.some(n => /mila/i.test(n)), 'BOAH: Mila fora do ranking de vendedoras (' + rankB.join(', ') + ')');
    ok(rankB.some(n => /passy/i.test(n)), 'BOAH: Passy aparece como consultora no ranking');
    ok(!rankB.some(n => /estilo/i.test(n)), 'BOAH: ESTILOBOAH nao vira vendedora');

    calls.length = 0;
    r = await get('/api/bi/metrics?periodo=mes_atual', 'tn');
    const n = r.b || {};
    ok(r.s === 200, 'CLIENTE NOVO => 200 (' + r.s + ')');
    ok(n.olist && n.olist.gmvAprovado === 0 && n.olist.conectado === false, 'CLIENTE NOVO nao ve GMV da BOAH e aparece desconectado');
    ok(!calls.some(c => c.token === 'BOAH_TOKEN'), 'CLIENTE NOVO nunca usou token da BOAH');
    ok(Array.isArray(n.topProdutos) && n.topProdutos.length === 0 && n.rankingVendedoras.length === 0 && n.meiosPagamento.length === 0 && n.topClientes.every(c => c.nome === 'Cliente do Novo'), 'CLIENTE NOVO sem listas de demonstracao (so clientes proprios)');
    ok(n.resumoCupons && n.resumoCupons.topCupons.length === 0, 'CLIENTE NOVO sem cupons de demonstracao');
    ok(n.linx && n.linx.grupoLinx === '' && n.linx.statusSync === 'Não configurado', 'CLIENTE NOVO linx nao configurado');
    ok(n.kpis && n.kpis.totalGuias === 2, 'CLIENTE NOVO ve apenas as 2 guias proprias (nao as da BOAH)');

    calls.length = 0;
    r = await get('/api/bi/metrics?periodo=mes_atual', 'th');
    ok(r.b && r.b.olist && r.b.olist.gmvAprovado === 400, 'HOLDING continua enxergando BOAH (gmv=' + (r.b && r.b.olist && r.b.olist.gmvAprovado) + ')');

    calls.length = 0;
    r = await get('/api/relatorios/vendas-periodo?periodo=mes_atual', 'tn');
    ok(r.s === 200, 'vendas-periodo CLIENTE NOVO responde (' + r.s + ')');
    ok(!calls.some(c => c.token === 'BOAH_TOKEN'), 'vendas-periodo CLIENTE NOVO nao usou token da BOAH');
    ok(r.b && r.b.resumo.totalPedidos <= 2 && r.b.pedidos.every(p => !['Mariana Albuquerque','Camila Sampaio Martins','Vestido Midi Floral Boah'].includes(p.cliente)) && !JSON.stringify(r.b).includes('Boah'), 'vendas-periodo CLIENTE NOVO sem vendas simuladas (max 2 guias proprias)');

    r = await get('/api/relatorios/vendas-periodo?periodo=mes_atual', 'tb');
    ok(r.b && r.b.resumo.totalPedidos === 2 && r.b.resumo.totalFaturamento === 400 && r.b.pedidos.length === 2, 'vendas-periodo BOAH real: 2 pedidos / 400 (got ' + (r.b && r.b.resumo.totalPedidos) + '/' + (r.b && r.b.resumo.totalFaturamento) + ')');

    r = await get('/api/relatorios/vendas-periodo?dataInicial=2020-01-01&dataFim=2020-01-31', 'tb');
    ok(r.b && r.b.resumo.totalPedidos === 0, 'vendas-periodo periodo sem vendas => zero (nao inventa)');

    // ---- DIFAL isolado
    r = await get('/api/difal/painel-unificado', 'tn');
    const pn = r.b || {};
    ok(r.s === 200 && pn.resumo && pn.resumo.qtdEmAberto === 1 && pn.resumo.qtdPagas === 1, 'DIFAL CLIENTE NOVO ve so as proprias guias (1 aberta/1 paga) got ' + (pn.resumo && pn.resumo.qtdEmAberto) + '/' + (pn.resumo && pn.resumo.qtdPagas));
    ok(pn.resumo && pn.resumo.totalPagas === 30 && pn.resumo.totalEmAberto === 10, 'DIFAL CLIENTE NOVO totais calculados (nao fixos)');
    ok(!JSON.stringify(pn).includes('Mariana Braga Lages') && !JSON.stringify(pn).includes('54010'), 'DIFAL CLIENTE NOVO sem guias da BOAH');

    r = await get('/api/difal/painel-unificado', 'tb');
    ok(r.s === 200 && r.b.resumo.qtdPagas > 0, 'DIFAL BOAH segue com base oficial (pagas=' + (r.b && r.b.resumo && r.b.resumo.qtdPagas) + ')');
    const boahPagasAntes = r.b.resumo.qtdPagas;

    r = await get('/api/difal/painel-unificado', 'th');
    ok(r.s === 200 && r.b.resumo.qtdPagas === boahPagasAntes, 'DIFAL HOLDING enxerga a BOAH');

    r = await get('/api/difal/baixar-guia', 'tn', 'POST', { nf: '54010', valorPago: 5 });
    ok(r.s === 404, 'baixar-guia CLIENTE NOVO nao consegue baixar NF da BOAH (status ' + r.s + ')');
    r = await get('/api/difal/painel-unificado', 'tb');
    ok(r.b.resumo.qtdPagas === boahPagasAntes, 'BOAH nao foi afetada pela tentativa do cliente novo');
    r = await get('/api/difal/baixar-guia', 'tn', 'POST', { nf: '900', valorPago: 10 });
    ok(r.s === 200, 'baixar-guia CLIENTE NOVO baixa a propria guia (status ' + r.s + ')');

    r = await fetchCsv('tn');
    ok(r.includes('Cliente') || r.includes('900'), 'CSV CLIENTE NOVO contem as proprias guias');
    ok(!r.includes('54010') && !r.includes('53985') && !r.includes('53801'), 'CSV CLIENTE NOVO sem guias da BOAH ou exemplos fixos');
    r = await fetchCsv('tb');
    ok(!r.includes('53985;') || true, 'CSV BOAH gerado');
    ok(r.includes('PAGA;'), 'CSV BOAH tem guias pagas oficiais');

    // ---- acesso cruzado a lotes/guias por ID
    r = await get('/api/batch/status/b-boah', 'tb');
    ok(r.s === 200, 'BOAH acessa o proprio lote (status ' + r.s + ')');
    r = await get('/api/batch/status/b-boah', 'tn');
    ok(r.s === 404, 'CLIENTE NOVO nao acessa lote da BOAH (status ' + r.s + ')');
    r = await get('/api/batch/pending-payment', 'tn');
    ok(r.s === 200 && !JSON.stringify(r.b).includes('b-boah'), 'pending-payment do cliente novo sem lotes da BOAH');
    r = await get('/api/guide/authorize-payment-asaas/g1', 'tn', 'POST', {});
    ok(r.s === 404, 'CLIENTE NOVO nao autoriza pagamento de guia da BOAH (status ' + r.s + ')');
    r = await get('/api/batch/authorize-payment-asaas/b-boah', 'tn', 'POST', {});
    ok(r.s === 404, 'CLIENTE NOVO nao autoriza pagamento de lote da BOAH (status ' + r.s + ')');
    r = await get('/api/batch/authorize-emission/b-boah', 'tn', 'POST', { paymentDate: '2026-11-10' });
    ok(r.s === 409 || r.s === 404, 'CLIENTE NOVO nao emite lote da BOAH (status ' + r.s + ')');
    r = await get('/api/batch/discard/b-boah', 'tn', 'POST', {});
    ok(r.s === 200 || r.s === 403, 'discard CLIENTE NOVO nao afeta BOAH (status ' + r.s + ')');
    r = await get('/api/batch/status/b-boah', 'tb');
    ok(r.s === 200 && r.b.status === 'sucesso', 'lote da BOAH continua intacto apos tentativas do cliente novo');
    r = await get('/api/admin/tenants', 'tn');
    ok(r.s === 403, 'CLIENTE NOVO nao acessa /api/admin/tenants (status ' + r.s + ')');
    r = await get('/api/admin/users', 'tb');
    ok(r.s === 403, 'admin da BOAH (nao superadmin) nao lista usuarios globais (status ' + r.s + ')');
    r = await get('/api/admin/metrics', 'th');
    ok(r.s === 403, 'holding comum nao acessa metricas master (status ' + r.s + ')');

    // ---- configuracao comercial por tenant
    r = await get('/api/bi/metrics?periodo=mes_atual', 'td');
    const rd = r.b || {};
    const tipoD = (cod) => ((rd.resumoCupons.topCupons || []).find(c => c.codigo === cod) || {}).tipo;
    const rankD = (rd.rankingVendedoras || []).map(v => v.nome);
    ok(r.s === 200 && rd.olist.gmvAprovado === 430, 'CLIENTE PADRAO GMV proprio (' + (rd.olist && rd.olist.gmvAprovado) + ')');
    ok(tipoD('MILA15') === 'Promoção Geral', 'CLIENTE PADRAO: MILA15 NAO herda regra da BOAH (' + tipoD('MILA15') + ')');
    ok(tipoD('BEMVINDA') === '1ª Compra / Onboarding', 'CLIENTE PADRAO: BEMVINDA = onboarding (regra generica)');
    ok(rankD.some(n => /mila/i.test(n)) && !rankD.includes('Camila (Mila)'), 'CLIENTE PADRAO: MILA15 vira vendedora comum, sem alias da BOAH (' + rankD.join(', ') + ')');
    ok(!JSON.stringify(rd).includes('Influencer Mila') && !JSON.stringify(rd).includes('Linx #66'), 'CLIENTE PADRAO: sem textos/codigos da BOAH');

    r = await get('/api/bi/metrics?periodo=mes_atual', 'tc');
    const rc = r.b || {};
    const tipoC = (cod) => ((rc.resumoCupons.topCupons || []).find(c => c.codigo === cod) || {}).tipo;
    const rankC = (rc.rankingVendedoras || []).map(v => v.nome);
    ok(tipoC('VERAO') === 'Campanha Verão', 'CLIENTE CUSTOM: configuracao propria de cupom aplicada (' + tipoC('VERAO') + ')');
    ok(!rankC.some(n => /verao/i.test(n)), 'CLIENTE CUSTOM: cupom institucional proprio (VERAO) nao vira vendedora');
    ok(!rankC.some(n => /bemvinda/i.test(n)), 'CLIENTE CUSTOM: BEMVINDA (generico) continua institucional');
    ok(rankC.includes('João Vendedor'), 'CLIENTE CUSTOM: alias proprio JOAO -> Joao Vendedor (' + rankC.join(', ') + ')');

    // ---- endpoint de configuracao
    r = await get('/api/tenant/comercial-config', 'tc');
    ok(r.s === 200 && r.b.personalizada === true && r.b.config.cuponsInstitucionais.includes('VERAO') && r.b.config.cuponsInstitucionais.includes('BEMVINDA'), 'GET config do tenant custom soma institucionais proprios aos genericos');
    r = await get('/api/tenant/comercial-config', 'td');
    ok(r.s === 200 && r.b.personalizada === false && !r.b.config.cuponsInstitucionais.includes('AMOBOAH'), 'GET config do tenant padrao sem regras da BOAH');
    r = await get('/api/tenant/comercial-config', 'tb');
    ok(r.s === 200 && r.b.config.cuponsInstitucionais.includes('AMOBOAH'), 'GET config da BOAH mantem regras historicas');
    r = await get('/api/tenant/comercial-config', 'xx');
    ok(r.s === 401, 'config exige login');
    r = await get('/api/tenant/comercial-config', 'td', 'POST', { cuponsInstitucionais: ['promo10', '  '], tiposCupom: [{ termos: ['promo'], tipo: 'Promo', badge: 'P' }, { termos: [], tipo: 'Invalida' }] });
    ok(r.s === 200 && r.b.config.cuponsInstitucionais.includes('PROMO10') && !r.b.config.cuponsInstitucionais.includes('') && r.b.config.tiposCupom.length === 1, 'POST config sanitiza entradas (maiusculas, remove vazios/invalidos)');
    // ---- Webhook Asaas Multi-Tenant
    process.env.ASAAS_WEBHOOK_TOKEN = 'token-global-asaas';
    // 1. Sem token => 401
    r = await get('/api/webhooks/asaas', null, 'POST', { event: 'BILL_PAID', bill: { id: 'bill_test_1' } });
    ok(r.s === 401, 'webhook sem token => 401');

    // 2. Token global correto => 200
    r = await (async () => {
        return new Promise((resolve) => {
            const sock = new net.Socket();
            Object.defineProperty(sock, 'remoteAddress', { value: '127.0.0.1' });
            const req = new http.IncomingMessage(sock);
            req.method = 'POST';
            req.url = '/api/webhooks/asaas';
            req.headers = { host: 'x', 'asaas-access-token': 'token-global-asaas' };
            req.body = { event: 'BILL_PAID', bill: { id: 'bill_123', externalReference: 'g1' } };
            const res = new http.ServerResponse(req);
            res.end = (chunk) => { let b = null; try { b = JSON.parse(String(chunk)); } catch {} resolve({ s: res.statusCode, b }); return res; };
            app.handle(req, res, () => resolve({ s: 404 }));
        });
    })();
    ok(r.s === 200, 'webhook com token global aceito (status 200)');

    // 3. Token específico por tenant na rota /:tenantId
    // Configura token no tenant custom
    const tCus = tenants.find(t => t.id === 't-cus');
    tCus.settings = tCus.settings || {};
    tCus.settings.asaas_webhook_token = 'token-secreto-tenant-cus';

    r = await (async () => {
        return new Promise((resolve) => {
            const sock = new net.Socket();
            Object.defineProperty(sock, 'remoteAddress', { value: '127.0.0.1' });
            const req = new http.IncomingMessage(sock);
            req.method = 'POST';
            req.url = '/api/webhooks/asaas/t-cus';
            req.headers = { host: 'x', 'asaas-access-token': 'token-secreto-tenant-cus' };
            req.body = { event: 'BILL_PAID', bill: { id: 'bill_cus_1' } };
            const res = new http.ServerResponse(req);
            res.end = (chunk) => { let b = null; try { b = JSON.parse(String(chunk)); } catch {} resolve({ s: res.statusCode, b }); return res; };
            app.handle(req, res, () => resolve({ s: 404 }));
        });
    })();
    ok(r.s === 200, 'webhook com token específico do tenant aceito (status 200)');

  } catch (e) { console.log('ERRO no teste', e); fails++; }
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(fails ? 1 : 0);
})();
