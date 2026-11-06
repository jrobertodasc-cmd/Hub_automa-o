// src/routes/bi.routes.js
// Business Intelligence & Estatísticas Fiscais e Comerciais

const express = require('express');
const router = express.Router();

const supabase = require('../config/supabase');
const { requireAuth } = require('../middlewares/auth');
const { HOLDING_CNPJ } = require('../config/constants');
const { getEncryptionKey, decrypt } = require('../utils/crypto');
const { normalizarTransportadora, periodoParaDatas } = require('../utils/tenantHelper');

const printService = require('../../services/print_service');
const vndaService = require('../../services/vnda_service');
const microvixService = require('../../services/microvix_service');
const { getConfigComercial, resolverVendedora, aliasCasa } = require('../../services/comercial_service');

const linxVendedoresCache = new Map();

async function getLinxVendedoresCatalog(tenant) {
    if (!tenant) return { byCode: new Map(), byName: new Map() };
    const tenantId = tenant.id || tenant.cnpj || 'default';
    const now = Date.now();
    const cached = linxVendedoresCache.get(tenantId);
    if (cached && (now - cached.timestamp < 3600000)) {
        return cached.catalog;
    }

    const byCode = new Map();
    const byName = new Map();

    try {
        let chave = tenant.microvix_key;
        let cnpj = tenant.microvix_cnpj || tenant.cnpj;
        let user = tenant.microvix_user || '';
        let pass = tenant.microvix_password_encrypted || '';

        if (!chave && tenant.cnpj === HOLDING_CNPJ) {
            const { data: boah } = await supabase
                .from('tenants')
                .select('*')
                .eq('cnpj', '10436619000105')
                .single();
            if (boah) {
                chave = boah.microvix_key;
                cnpj = boah.microvix_cnpj || boah.cnpj;
                user = boah.microvix_user || user;
                pass = boah.microvix_password_encrypted || pass;
            }
        }

        if (pass && pass.includes(':')) {
            const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
            pass = decrypt(pass, key);
        }

        if (chave && cnpj) {
            const list = await microvixService.consultarVendedores({
                user,
                password: pass,
                chave,
                cnpjEmp: cnpj
            }, 0);

            if (Array.isArray(list)) {
                list.forEach(v => {
                    const cod = String(v.cod_vendedor || '').trim();
                    const nome = String(v.nome_vendedor || '').trim();
                    if (cod) {
                        byCode.set(cod, v);
                        byCode.set('L' + cod, v);
                        byCode.set('l' + cod, v);
                        const num = parseInt(cod, 10);
                        if (!isNaN(num)) {
                            byCode.set(String(num), v);
                            byCode.set('L' + num, v);
                            byCode.set('l' + num, v);
                        }
                    }
                    if (nome) {
                        const cleanName = nome.toLowerCase().replace(/[^a-z0-9]/g, '');
                        byName.set(cleanName, v);
                    }
                });
            }
        }
    } catch (err) {
        console.warn('[BI] Aviso ao consultar catálogo de vendedores Linx Microvix:', err.message);
    }

    const catalog = { byCode, byName };
    linxVendedoresCache.set(tenantId, { timestamp: now, catalog });
    return catalog;
}

/**
 * BI Fiscal - Métricas, Distribuição por UF e Transportadora
 */
router.get('/stats', requireAuth, async (req, res) => {
    try {
        const { data: guias, error } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        let totalGuias = guias ? guias.length : 0;
        let totalValorDifal = 0;
        let totalPagas = 0;
        let valorPago = 0;
        let totalPendentes = 0;

        const porUf = {};
        const porTransportadora = {};
        const porMes = {};

        for (const g of (guias || [])) {
            const val = parseFloat(g.value || 0);
            totalValorDifal += val;

            const isSp = (g.uf === 'SP' || g.barcode === 'IMPORTAR_NO_SEFAZ_SP');
            const isLiberada = printService.isGuiaLiberada(g);
            if (isLiberada || isSp) {
                totalPagas++;
                valorPago += isSp ? 0 : val;
            } else {
                totalPendentes++;
            }

            // Agrupa por UF
            const uf = (g.uf || 'OUTROS').toUpperCase();
            if (!porUf[uf]) porUf[uf] = { count: 0, valor: 0 };
            porUf[uf].count++;
            porUf[uf].valor += val;

            // Agrupa por Transportadora
            let rawTransp = (g.carrier_name || '').trim().toUpperCase();
            let transp = 'Total Express';
            if (rawTransp.includes('CORREIO')) {
                transp = 'Correios';
            } else if (rawTransp.includes('MT') || rawTransp.includes('LOG')) {
                transp = 'MT Log';
            } else if (rawTransp.includes('TOTAL') || rawTransp.includes('EXPRESS')) {
                transp = 'Total Express';
            } else {
                transp = (uf === 'SP' || uf === 'RJ' || uf === 'MG') ? 'Total Express' : 'Correios';
            }
            if (!porTransportadora[transp]) porTransportadora[transp] = { count: 0, valor: 0 };
            porTransportadora[transp].count++;
            porTransportadora[transp].valor += val;

            // Agrupa por Mês (YYYY-MM)
            const d = g.created_at ? g.created_at.substring(0, 7) : 'Sem Data';
            if (!porMes[d]) porMes[d] = { count: 0, valor: 0 };
            porMes[d].count++;
            porMes[d].valor += val;
        }

        const rankingUf = Object.entries(porUf)
            .map(([uf, d]) => ({ uf, count: d.count, valor: parseFloat(d.valor.toFixed(2)) }))
            .sort((a, b) => b.valor - a.valor);

        const rankingTransp = Object.entries(porTransportadora)
            .map(([transp, d]) => ({ transp, count: d.count, valor: parseFloat(d.valor.toFixed(2)) }))
            .sort((a, b) => b.count - a.count);

        return res.json({
            tenant: {
                razaoSocial: req.tenant.razao_social,
                cnpj: req.tenant.cnpj
            },
            resumo: {
                totalGuias,
                totalValorDifal: parseFloat(totalValorDifal.toFixed(2)),
                totalPagas,
                valorPago: parseFloat(valorPago.toFixed(2)),
                totalPendentes,
                valorPendente: parseFloat((totalValorDifal - valorPago).toFixed(2))
            },
            rankingUf,
            rankingTransp,
            historicoMensal: Object.entries(porMes).map(([mes, d]) => ({ mes, ...d })).sort((a, b) => a.mes.localeCompare(b.mes))
        });
    } catch (err) {
        console.error("Erro ao obter estatísticas de BI:", err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Exportação em CSV Contábil formatado para Excel
 */
router.get('/export-csv', requireAuth, async (req, res) => {
    try {
        const { data: guias, error } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: false });

        if (error) throw error;

        const cabecalho = [
            "Número da NF",
            "UF Favorecida",
            "Destinatário",
            "Transportadora",
            "Valor DIFAL (R$)",
            "Código de Barras",
            "Linha Digitável",
            "Status",
            "Data de Pagamento",
            "Autenticação Bancária",
            "Data de Emissão no Sistema"
        ].join(";");

        const linhas = (guias || []).map(g => [
            `"${g.nf_number || ''}"`,
            `"${g.uf || ''}"`,
            `"${(g.customer_name || 'CONSUMIDOR FINAL').replace(/"/g, '""')}"`,
            `"${(g.carrier_name || 'NÃO DEFINIDA').replace(/"/g, '""')}"`,
            `"${parseFloat(g.value || 0).toFixed(2).replace('.', ',')}"`,
            `"${g.barcode || ''}"`,
            `"${g.line_digitizable || ''}"`,
            `"${g.status || 'EMITIDA'}"`,
            `"${g.paid_at || ''}"`,
            `"${(g.bank_authentication || '').replace(/"/g, '""')}"`,
            `"${g.created_at ? g.created_at.substring(0, 10) : ''}"`
        ].join(";"));

        const csvContent = "\uFEFF" + [cabecalho, ...linhas].join("\r\n");

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="relatorio_fiscal_difal_${new Date().toISOString().split('T')[0]}.csv"`);
        return res.send(csvContent);
    } catch (err) {
        console.error("Erro ao exportar CSV fiscal:", err);
        return res.status(500).send("Erro ao exportar relatório contábil: " + err.message);
    }
});

/**
 * Ranking de Peças / Produtos Mais Vendidos por Estado
 */
router.get('/produtos', requireAuth, async (req, res) => {
    try {
        const { uf } = req.query;
        let query = supabase.from('invoice_items')
            .select('*')
            .eq('tenant_id', req.tenant.id);

        if (uf && uf !== 'TODAS') {
            query = query.eq('uf_destination', uf);
        }

        const { data: itens, error } = await query;
        if (error) throw error;

        const porProduto = {};
        for (const item of (itens || [])) {
            const desc = item.product_description || 'PRODUTO NÃO IDENTIFICADO';
            if (!porProduto[desc]) {
                porProduto[desc] = {
                    sku: item.product_code || 'SEM_COD',
                    descricao: desc,
                    quantidade: 0,
                    faturamento: 0
                };
            }
            porProduto[desc].quantidade += parseFloat(item.quantity || 1);
            porProduto[desc].faturamento += parseFloat(item.total_price || 0);
        }

        const ranking = Object.values(porProduto)
            .map(p => ({
                ...p,
                faturamento: parseFloat(p.faturamento.toFixed(2))
            }))
            .sort((a, b) => b.quantidade - a.quantidade);

        return res.json({
            totalItens: itens ? itens.length : 0,
            produtosUnicos: ranking.length,
            ranking
        });
    } catch (err) {
        console.error("Erro ao obter ranking de produtos:", err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Monitor de Devoluções e Prevenção de Desperdício de GNRE
 */
router.get('/devolucoes', requireAuth, async (req, res) => {
    try {
        const { data: devolucoes, error: devErr } = await supabase
            .from('return_notes')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('created_at', { ascending: false });

        if (devErr) throw devErr;

        const { data: guiasDevolvidas } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .eq('is_returned', true);

        return res.json({
            totalDevolucoes: devolucoes ? devolucoes.length : 0,
            devolucoes: devolucoes || [],
            guiasImpactadas: guiasDevolvidas || []
        });
    } catch (err) {
        console.error("Erro ao buscar devoluções:", err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Dashboard Executivo BI: Métricas Consolidadas (VNDA, Linx, DIFAL, CMV, Gateway, Equipe Comercial)
 */
router.get('/metrics', requireAuth, async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const periodo = String(req.query.periodo || 'mes_atual').toLowerCase();
        const { data: guides, error } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('nf_issue_date', { ascending: false });

        if (error) throw error;
        const allGuides = guides || [];

        const ufHeatmapMap = new Map();
        const carriersMap = new Map();
        const timelineMap = new Map();

        let totalFaturamentoEst = 0;
        let totalDifal = 0;
        let totalPagas = 0;
        let totalPendentes = 0;

        allGuides.forEach(g => {
            const uf = (g.uf || 'ND').toUpperCase();
            const valDifal = parseFloat(g.value || 0);
            const isPaga = g.status === 'pago' || g.status === 'liquidado' || !!g.paid_at;
            totalDifal += valDifal;
            if (isPaga) totalPagas++;
            else totalPendentes++;

            const valVenda = parseFloat(g.valor_venda || g.invoice_total || (valDifal > 0 ? (valDifal / 0.08) : 0));
            totalFaturamentoEst += valVenda;

            // Heatmap UF
            if (!ufHeatmapMap.has(uf)) {
                ufHeatmapMap.set(uf, { uf, totalGuias: 0, totalVenda: 0, totalDifal: 0, pagas: 0, pendentes: 0 });
            }
            const ufObj = ufHeatmapMap.get(uf);
            ufObj.totalGuias++;
            ufObj.totalVenda += valVenda;
            ufObj.totalDifal += valDifal;
            if (isPaga) ufObj.pagas++;
            else ufObj.pendentes++;

            // Transportadoras unificadas
            const transp = normalizarTransportadora(g.carrier_name || g.carrier_cnpj);
            if (!carriersMap.has(transp)) {
                carriersMap.set(transp, { carrier: transp, total: 0, liberadas: 0, pendentes: 0, totalDifal: 0 });
            }
            const cObj = carriersMap.get(transp);
            cObj.total++;
            cObj.totalDifal += valDifal;
            if (isPaga) cObj.liberadas++;
            else cObj.pendentes++;

            // Timeline
            const dt = (g.nf_issue_date || (g.created_at ? g.created_at.split('T')[0] : ''));
            if (!timelineMap.has(dt)) {
                timelineMap.set(dt, { data: dt, faturamento: 0, difal: 0, guias: 0 });
            }
            const tObj = timelineMap.get(dt);
            tObj.faturamento += valVenda;
            tObj.difal += valDifal;
            tObj.guias++;
        });

        const timeline = Array.from(timelineMap.values()).sort((a, b) => a.data.localeCompare(b.data));
        const heatmap = Array.from(ufHeatmapMap.values()).sort((a, b) => b.totalVenda - a.totalVenda);
        const carriers = Array.from(carriersMap.values()).sort((a, b) => b.total - a.total);

        const clientesSet = new Set();
        let notasComXml = 0;
        let totalFaturadoLinx = 0;
        allGuides.forEach(g => {
            if (g.customer_name && g.customer_name !== 'Consumidor Final') {
                clientesSet.add(g.customer_name.trim().toUpperCase());
            }
            if (g.xml_storage_path) notasComXml++;
            const valV = parseFloat(g.valor_venda || g.invoice_total || 0);
            if (valV > 0) totalFaturadoLinx += valV;
        });

        const linxMetrics = {
            totalNotasEmitidas: allGuides.length,
            notasComXml,
            clientesAtendidos: clientesSet.size,
            faturamentoLinx: totalFaturadoLinx > 0 ? parseFloat(totalFaturadoLinx.toFixed(2)) : parseFloat(totalFaturamentoEst.toFixed(2)),
            grupoLinx: req.tenant.microvix_group || '',
            usuarioLinx: req.tenant.microvix_user || '',
            statusSync: req.tenant.microvix_key ? 'Conectado · Sincronização Ativa' : 'Não configurado'
        };

        let olistMetrics = {
            pedidosAprovados: 0,
            pedidosCancelados: 0,
            totalPedidosRecebidos: 0,
            gmvAprovado: 0,
            gmvBrutoTotal: 0,
            ticketMedioOlist: 0,
            totalPecasOlist: 0,
            pecasPorPedido: 0,
            taxaCancelamentoPct: '0.0',
            taxaAprovacaoPct: '0.0',
            freteMedio: 0,
            canais: {},
            lojaVirtual: req.tenant.vnda_shop_host || '',
            conectado: !!(req.tenant.vnda_token_encrypted || req.tenant.cnpj === HOLDING_CNPJ)
        };

        let meiosPagamento = [];
        let rankingVendedorasBase = [];
        let topProdutos = [];

        const clientesMap = new Map();
        allGuides.forEach(g => {
            const rawNome = (g.customer_name || '').trim();
            if (rawNome && rawNome.toUpperCase() !== 'CONSUMIDOR FINAL') {
                const key = rawNome.toUpperCase();
                const valV = parseFloat(g.valor_venda || g.invoice_total || (parseFloat(g.value || 0) / 0.08) || 0);
                if (!clientesMap.has(key)) {
                    clientesMap.set(key, {
                        nome: rawNome,
                        uf: (g.uf || 'ND').toUpperCase(),
                        pedidos: 0,
                        totalGasto: 0
                    });
                }
                const cli = clientesMap.get(key);
                cli.pedidos++;
                cli.totalGasto += valV;
            }
        });

        let topClientes = Array.from(clientesMap.values())
            .sort((a, b) => b.totalGasto - a.totalGasto)
            .slice(0, 5)
            .map((c, idx) => ({
                ...c,
                totalGasto: parseFloat(c.totalGasto.toFixed(2)),
                ticketMedio: parseFloat((c.totalGasto / c.pedidos).toFixed(2)),
                nivelVip: idx === 0 ? 'VIP Ouro' : (idx <= 2 ? 'VIP Prata' : 'VIP Bronze')
            }));

        let resumoCuponsBase = {
            totalComCupom: 0,
            totalSemCupom: 0,
            gmvComCupom: 0,
            gmvSemCupom: 0,
            taxaPenetracaoPct: 0,
            topCupons: []
        };

        try {
            let tokenEncrypted = req.tenant.vnda_token_encrypted;
            let shopHost = (req.tenant.vnda_shop_host || '').trim();

            if (!tokenEncrypted && req.tenant.cnpj === HOLDING_CNPJ) {
                const { data: boahT } = await supabase
                    .from('tenants')
                    .select('vnda_token_encrypted, vnda_shop_host')
                    .eq('cnpj', '10436619000105')
                    .single();
                if (boahT && boahT.vnda_token_encrypted) {
                    tokenEncrypted = boahT.vnda_token_encrypted;
                    shopHost = (boahT.vnda_shop_host || shopHost).trim();
                }
            }

            if (tokenEncrypted) {
                const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
                const token = decrypt(tokenEncrypted, key);
                const pedidosBrutos = await vndaService.listarPedidosRecentes(token, shopHost, 250).catch(() => null);
                const { ini: periodoIni, fim: periodoFim } = periodoParaDatas(periodo, req.query);
                const pedidos = Array.isArray(pedidosBrutos) ? pedidosBrutos.filter(p => {
                    const t = Date.parse(p.received_at);
                    if (isNaN(t)) return false;
                    const d = new Date(t - 3 * 3600 * 1000).toISOString().slice(0, 10);
                    return d >= periodoIni && d <= periodoFim;
                }) : null;

                if (Array.isArray(pedidos) && pedidos.length > 0) {
                    const conf = pedidos.filter(p => p.status === 'confirmed');
                    const canc = pedidos.filter(p => p.status === 'canceled');
                    const gmv = conf.reduce((acc, p) => acc + (parseFloat(p.total) || 0), 0);
                    const totalFrete = conf.reduce((acc, p) => acc + (parseFloat(p.shipping_price) || 0), 0);
                    const freteMedio = conf.length > 0 ? parseFloat((totalFrete / conf.length).toFixed(2)) : 0;

                    let pecasCount = 0;
                    const prodAgg = {};
                    conf.forEach(p => {
                        const items = Array.isArray(p.items) ? p.items : [];
                        items.forEach(it => {
                            const qtd = parseInt(it.quantity, 10) || 1;
                            pecasCount += qtd;
                            const key = (it.product_name || it.name || it.sku || 'Produto sem nome').trim();
                            if (!prodAgg[key]) {
                                prodAgg[key] = {
                                    nome: key,
                                    sku: it.sku || '',
                                    qtd: 0,
                                    valor: 0
                                };
                            }
                            prodAgg[key].qtd += qtd;
                            prodAgg[key].valor += parseFloat(it.price || 0) * qtd;
                        });
                    });

                    const payMap = {
                        credito: { metodo: 'Cartão de Crédito', count: 0, valor: 0, color: '#38BDF8' },
                        boleto: { metodo: 'Boleto Bancário', count: 0, valor: 0, color: '#F59E0B' },
                        pix: { metodo: 'PIX Online', count: 0, valor: 0, color: '#10B981' },
                        outros: { metodo: 'Outros Meios', count: 0, valor: 0, color: '#A855F7' }
                    };

                    pedidos.forEach(p => {
                        const mStr = String(p.payment_method || '').toLowerCase();
                        const val = parseFloat(p.total) || 0;
                        if (mStr.includes('pix')) {
                            payMap.pix.count++;
                            payMap.pix.valor += val;
                        } else if (mStr.includes('boleto')) {
                            payMap.boleto.count++;
                            payMap.boleto.valor += val;
                        } else {
                            payMap.credito.count++;
                            payMap.credito.valor += val;
                        }
                    });

                    const totalPayCount = pedidos.length || 1;
                    const calculatedMeios = [payMap.credito, payMap.boleto, payMap.pix, payMap.outros]
                        .filter(pm => pm.count > 0)
                        .map(pm => ({
                            ...pm,
                            pct: parseFloat(((pm.count / totalPayCount) * 100).toFixed(1)),
                            valor: parseFloat(pm.valor.toFixed(2))
                        }));
                    if (calculatedMeios.length > 0) {
                        meiosPagamento = calculatedMeios;
                    }

                    const prodList = Object.values(prodAgg).sort((a, b) => b.qtd - a.qtd);
                    if (prodList.length > 0) {
                        const totalP = pecasCount || 1;
                        topProdutos = prodList.slice(0, 5).map(pr => ({
                            ...pr,
                            valor: parseFloat(pr.valor.toFixed(2)),
                            sharePct: parseFloat(((pr.qtd / totalP) * 100).toFixed(1))
                        }));
                    }

                    const canais = {};
                    conf.forEach(p => {
                        const c = p.channel || 'ecommerce';
                        canais[c] = (canais[c] || 0) + (parseFloat(p.total) || 0);
                    });
                    const taxaCanc = pedidos.length > 0 ? ((canc.length / pedidos.length) * 100).toFixed(1) : '0.0';
                    const taxaAprov = pedidos.length > 0 ? (((pedidos.length - canc.length) / pedidos.length) * 100).toFixed(1) : '100.0';

                    olistMetrics = {
                        pedidosAprovados: conf.length,
                        pedidosCancelados: canc.length,
                        totalPedidosRecebidos: pedidos.length,
                        gmvAprovado: parseFloat(gmv.toFixed(2)),
                        ticketMedioOlist: conf.length > 0 ? parseFloat((gmv / conf.length).toFixed(2)) : 0,
                        totalPecasOlist: pecasCount,
                        pecasPorPedido: conf.length > 0 ? parseFloat((pecasCount / conf.length).toFixed(1)) : 0,
                        taxaCancelamentoPct: taxaCanc,
                        taxaAprovacaoPct: taxaAprov,
                        freteMedio,
                        canais,
                        lojaVirtual: shopHost,
                        conectado: true
                    };

                    // Vendedoras
                    const vMap = new Map();
                    const linxCatalog = await getLinxVendedoresCatalog(req.tenant);
                    const cfgCom = getConfigComercial(req.tenant);
                    conf.forEach(p => {
                        let rawAgent = (p.agent || p.seller || p.salesperson || '').trim();
                        if (!rawAgent && (p.coupon_code || p.coupon)) {
                            const cStr = String(p.coupon_code || p.coupon).toUpperCase().trim();
                            const ehInstitucional = (cfgCom.cuponsInstitucionais || []).some(c => cStr.includes(String(c).toUpperCase()));
                            const ehAliasOculto = (cfgCom.aliasesVendedora || []).some(al => al.ocultarNoRanking && aliasCasa(al, cStr));
                            if (!ehInstitucional && !ehAliasOculto) {
                                rawAgent = cStr;
                            }
                        }
                        if (rawAgent) {
                            const resolved = resolverVendedora(rawAgent, linxCatalog, cfgCom);
                            if (resolved && resolved.nome && !resolved.ocultarNoRanking) {
                                const key = resolved.nome.toUpperCase();
                                const valP = parseFloat(p.total) || 0;
                                if (!vMap.has(key)) {
                                    vMap.set(key, {
                                        nome: resolved.nome,
                                        codigoLinx: resolved.codigoLinx,
                                        pedidos: 0,
                                        valorTotal: 0,
                                        pecasTotal: 0,
                                        canal: resolved.canal || 'Social Selling VNDA'
                                    });
                                }
                                const vObj = vMap.get(key);
                                vObj.pedidos++;
                                vObj.valorTotal += valP;
                            }
                        }
                    });

                    const dynRanking = Array.from(vMap.values())
                        .filter(v => v.valorTotal >= 10 && !/^[a-f0-9]{8,}$/i.test(v.nome))
                        .sort((a, b) => b.valorTotal - a.valorTotal)
                        .map((v, idx) => ({
                            posicao: idx + 1,
                            nome: v.nome,
                            codigoLinx: v.codigoLinx,
                            canal: v.canal,
                            pedidos: v.pedidos,
                            valorTotal: parseFloat(v.valorTotal.toFixed(2)),
                            ticketMedio: v.pedidos > 0 ? parseFloat((v.valorTotal / v.pedidos).toFixed(2)) : 0,
                            sharePct: gmv > 0 ? parseFloat(((v.valorTotal / gmv) * 100).toFixed(1)) : 0,
                            badge: idx === 0 ? 'Top 1 Líder' : (idx === 1 ? 'Top 2 Destaque' : (idx === 2 ? 'Top 3 Bronze' : 'Consultora'))
                        }));
                    if (dynRanking.length > 0) {
                        rankingVendedorasBase = dynRanking;
                    }

                    // Cupons
                    const couponMap = new Map();
                    let totalComCupom = 0;
                    let totalSemCupom = 0;
                    let gmvComCupom = 0;
                    let gmvSemCupom = 0;

                    conf.forEach(p => {
                        const cp = String(p.coupon_code || p.coupon || '').trim().toUpperCase();
                        const val = parseFloat(p.total) || 0;
                        if (cp) {
                            totalComCupom++;
                            gmvComCupom += val;
                            if (!couponMap.has(cp)) {
                                let tipoCupom = 'Promoção Geral';
                                let badge = 'Campanha';
                                const tipoCfg = (cfgCom.tiposCupom || []).find(t => (t.termos || []).some(x => cp.includes(String(x).toUpperCase())));
                                if (tipoCfg) {
                                    tipoCupom = tipoCfg.tipo;
                                    badge = tipoCfg.badge || 'Campanha';
                                }
                                couponMap.set(cp, {
                                    codigo: cp,
                                    tipo: tipoCupom,
                                    badge: badge,
                                    pedidos: 0,
                                    valorTotal: 0
                                });
                            }
                            const cObj = couponMap.get(cp);
                            cObj.pedidos++;
                            cObj.valorTotal += val;
                        } else {
                            totalSemCupom++;
                            gmvSemCupom += val;
                        }
                    });

                    const topCuponsCalc = Array.from(couponMap.values())
                        .sort((a, b) => b.valorTotal - a.valorTotal)
                        .slice(0, 6)
                        .map((c, idx) => ({
                            ...c,
                            posicao: idx + 1,
                            valorTotal: parseFloat(c.valorTotal.toFixed(2)),
                            ticketMedio: c.pedidos > 0 ? parseFloat((c.valorTotal / c.pedidos).toFixed(2)) : 0,
                            sharePct: gmvComCupom > 0 ? parseFloat(((c.valorTotal / gmvComCupom) * 100).toFixed(1)) : 0
                        }));

                    if (topCuponsCalc.length > 0) {
                        resumoCuponsBase = {
                            totalComCupom,
                            totalSemCupom,
                            gmvComCupom: parseFloat(gmvComCupom.toFixed(2)),
                            gmvSemCupom: parseFloat(gmvSemCupom.toFixed(2)),
                            taxaPenetracaoPct: conf.length > 0 ? parseFloat(((totalComCupom / conf.length) * 100).toFixed(1)) : 0,
                            topCupons: topCuponsCalc
                        };
                    }
                }
            }
        } catch (eOlist) {
            console.warn('[BI] Aviso ao consultar API Olist Vnda:', eOlist.message);
        }

        const multPeriodo = 1.0;
        const { ini: pIni, fim: pFim } = periodoParaDatas(periodo, req.query);
        const fmtBR = d => d.split('-').reverse().join('/');
        const comparativo = {
            periodo,
            labelPeriodo: `Período: ${fmtBR(pIni)} a ${fmtBR(pFim)}`,
            labelComparativo: '',
            gmvVarPct: null,
            pedidosVarPct: null,
            pecasVarPct: null,
            ticketMedioVarPct: null,
            margemVarPp: null
        };

        const timelinePeriodo = timeline
            .filter(t => t.data >= pIni && t.data <= pFim)
            .map(t => {
                const fat = parseFloat(t.faturamento || 0);
                const nPed = parseInt(t.guias || t.pedidos || 0, 10);
                return {
                    ...t,
                    faturamento: fat,
                    difal: parseFloat((t.difal || 0).toFixed(2)),
                    pedidos: nPed,
                    cuponsValor: 0,
                    cuponsPedidos: 0,
                    ticketMedio: nPed > 0 ? parseFloat((fat / nPed).toFixed(2)) : 0
                };
            });

        const baseGmv = (olistMetrics.gmvAprovado || 0);
        const gmvCalculado = parseFloat((baseGmv * multPeriodo).toFixed(2));
        const cmvEstimado = parseFloat((gmvCalculado * 0.33).toFixed(2));
        const difalBase = totalDifal;
        const difalCalculado = parseFloat((difalBase * multPeriodo).toFixed(2));
        const taxasGateway = parseFloat((gmvCalculado * 0.032).toFixed(2));
        const margemContribuicao = parseFloat((gmvCalculado - cmvEstimado - difalCalculado - taxasGateway).toFixed(2));
        const margemContribuicaoPct = gmvCalculado > 0 ? parseFloat(((margemContribuicao / gmvCalculado) * 100).toFixed(1)) : 0;

        const comercialMetrics = {
            gmv: gmvCalculado,
            cmv: cmvEstimado,
            cmvPct: 33.0,
            difal: difalCalculado,
            difalPct: gmvCalculado > 0 ? parseFloat(((difalCalculado / gmvCalculado) * 100).toFixed(1)) : 0,
            gateway: taxasGateway,
            gatewayPct: 3.2,
            margem: margemContribuicao,
            margemPct: margemContribuicaoPct,
            estimado: true
        };

        return res.json({
            kpis: {
                totalGuias: allGuides.length,
                totalFaturamento: gmvCalculado,
                totalDifal: totalDifal,
                ticketMedio: olistMetrics.ticketMedioOlist || 0,
                taxaLiberacao: allGuides.length > 0 ? ((totalPagas / allGuides.length) * 100).toFixed(1) : '0.0',
                totalPagas,
                totalPendentes,
                cmvEstimado,
                cmvPct: 33.0,
                margemContribuicao,
                margemContribuicaoPct,
                leadTimeMedioHoras: null
            },
            comparativo,
            comercial: comercialMetrics,
            linx: linxMetrics,
            olist: {
                ...olistMetrics,
                gmvAprovado: gmvCalculado
            },
            meiosPagamento,
            topProdutos,
            topClientes,
            rankingVendedoras: rankingVendedorasBase,
            resumoCupons: resumoCuponsBase,
            heatmap,
            carriers,
            timeline: timelinePeriodo
        });
    } catch (e) {
        console.error('[BI Metrics] Erro:', e);
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
