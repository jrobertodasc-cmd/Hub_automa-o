// src/routes/relatorios.routes.js
// Relatórios Gerenciais e Fiscais Analíticos

const express = require('express');
const router = express.Router();

const supabase = require('../config/supabase');
const { requireAuth } = require('../middlewares/auth');
const { HOLDING_CNPJ } = require('../config/constants');
const { getEncryptionKey, decrypt } = require('../utils/crypto');
const { periodoParaDatas } = require('../utils/tenantHelper');

const vndaService = require('../../services/vnda_service');

/**
 * Relatório Analítico de DIFAL por período e estado
 */
router.get('/analitico-difal', requireAuth, async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { uf, dataInicial, dataFim } = req.query;

        let query = supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('nf_issue_date', { ascending: false });

        if (uf && uf !== 'todas' && uf !== 'todos') query = query.eq('uf', uf.toUpperCase());
        if (dataInicial) query = query.gte('nf_issue_date', dataInicial);
        if (dataFim) query = query.lte('nf_issue_date', dataFim);

        const { data: guides, error } = await query;
        if (error) throw error;

        return res.json({ guias: guides || [] });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

/**
 * Relatório Gerencial: Vendas por Período (Evolução Diária / Mensal e Detalhamento de Pedidos)
 */
router.get('/vendas-periodo', requireAuth, async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { dataInicial, dataFim, periodo } = req.query;

        let dtInicio = dataInicial;
        let dtFim = dataFim;
        if (!dtInicio || !dtFim) {
            const p = String(periodo || 'mes_atual').toLowerCase();
            if (p === 'hoje') {
                const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
                dtInicio = hoje;
                dtFim = hoje;
            } else {
                const r = periodoParaDatas(p, {});
                dtInicio = r.ini;
                dtFim = r.fim;
            }
        }

        let pedidosVnda = [];
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
                const list = await vndaService.listarPedidosRecentes(token, shopHost, 250).catch(() => null);
                if (Array.isArray(list) && list.length > 0) {
                    pedidosVnda = list.filter(p => p.status === 'confirmed');
                }
            }
        } catch (eVnda) {
            console.warn('[Relatório Período] Aviso ao consultar VNDA:', eVnda.message);
        }

        let { data: guides } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenantId)
            .gte('nf_issue_date', dtInicio)
            .lte('nf_issue_date', dtFim)
            .order('nf_issue_date', { ascending: true });

        const diasMap = new Map();

        if (pedidosVnda.length > 0) {
            pedidosVnda.forEach(p => {
                const dt = (p.confirmed_at || p.received_at || p.created_at || '').split('T')[0];
                if (dt && dt >= dtInicio && dt <= dtFim) {
                    if (!diasMap.has(dt)) {
                        diasMap.set(dt, { data: dt, pedidos: 0, faturamento: 0, pecas: 0 });
                    }
                    const diaObj = diasMap.get(dt);
                    diaObj.pedidos++;
                    diaObj.faturamento += (parseFloat(p.total) || 0);
                    const items = Array.isArray(p.items) ? p.items : [];
                    items.forEach(it => { diaObj.pecas += (parseInt(it.quantity, 10) || 1); });
                }
            });
        }

        if (Array.isArray(guides) && guides.length > 0) {
            guides.forEach(g => {
                const dt = (g.nf_issue_date || (g.created_at ? g.created_at.split('T')[0] : ''));
                if (dt && dt >= dtInicio && dt <= dtFim && !diasMap.has(dt)) {
                    if (!diasMap.has(dt)) {
                        diasMap.set(dt, { data: dt, pedidos: 0, faturamento: 0, pecas: 0 });
                    }
                    const diaObj = diasMap.get(dt);
                    diaObj.pedidos++;
                    const valV = parseFloat(g.valor_venda || g.invoice_total || (parseFloat(g.value || 0) / 0.08) || 0);
                    diaObj.faturamento += valV;
                    diaObj.pecas += 1;
                }
            });
        }

        const diasArray = Array.from(diasMap.values()).sort((a, b) => b.data.localeCompare(a.data));
        let totalPedidos = 0;
        let totalFaturamento = 0;
        let totalPecas = 0;
        let melhorDia = null;

        diasArray.forEach(d => {
            totalPedidos += d.pedidos;
            totalFaturamento += d.faturamento;
            totalPecas += d.pecas;
            if (!melhorDia || d.faturamento > melhorDia.faturamento) {
                melhorDia = { data: d.data, faturamento: d.faturamento, pedidos: d.pedidos };
            }
        });

        totalFaturamento = parseFloat(totalFaturamento.toFixed(2));
        const ticketMedioGeral = totalPedidos > 0 ? parseFloat((totalFaturamento / totalPedidos).toFixed(2)) : 0;
        const mediaDiaria = diasArray.length > 0 ? parseFloat((totalFaturamento / diasArray.length).toFixed(2)) : 0;

        const diasFormatados = diasArray.map((d, idx) => {
            const [ano, mes, dia] = d.data.split('-');
            const dataObj = new Date(`${ano}-${mes}-${dia}T12:00:00`);
            const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            const diaSemana = diasSemana[dataObj.getDay()] || '';
            const sharePct = totalFaturamento > 0 ? parseFloat(((d.faturamento / totalFaturamento) * 100).toFixed(1)) : 0;
            const tm = d.pedidos > 0 ? parseFloat((d.faturamento / d.pedidos).toFixed(2)) : 0;

            return {
                posicao: idx + 1,
                dataIso: d.data,
                dataFormatada: `${dia}/${mes}/${ano}`,
                diaSemana,
                pedidos: d.pedidos,
                faturamento: parseFloat(d.faturamento.toFixed(2)),
                ticketMedio: tm,
                pecas: d.pecas,
                sharePct,
                status: 'Conciliado'
            };
        });

        const pedidosDetalhados = [];
        if (pedidosVnda.length > 0) {
            pedidosVnda.forEach(p => {
                const dt = (p.confirmed_at || p.received_at || p.created_at || '').split('T')[0];
                if (dt && dt >= dtInicio && dt <= dtFim) {
                    const dtHora = (p.confirmed_at || p.received_at || p.created_at || '');
                    const hora = dtHora.includes('T') ? dtHora.split('T')[1].slice(0, 5) : '';
                    const rawItems = Array.isArray(p.items) ? p.items : [];
                    const itens = rawItems.map(it => ({
                        nome: it.name || it.product_name || 'Produto sem nome',
                        sku: it.sku || '',
                        qtd: parseInt(it.quantity, 10) || 1,
                        valorUnit: parseFloat(it.price || 0)
                    }));
                    const clienteNome = p.client?.name || p.client_name || 'Cliente não identificado';
                    const cidadeUf = p.address ? [p.address.city, p.address.state].filter(Boolean).join(' - ') : '';
                    pedidosDetalhados.push({
                        id: p.id || p.code,
                        codigo: p.code ? `#${p.code}` : `#VD-${p.id}`,
                        dataIso: dt,
                        dataFormatada: dt.split('-').reverse().join('/'),
                        hora,
                        cliente: clienteNome,
                        localidade: cidadeUf,
                        itens,
                        pecas: itens.reduce((acc, i) => acc + i.qtd, 0) || 1,
                        total: parseFloat(p.total) || 0,
                        pagamento: p.payment_method || '',
                        status: 'Faturado VNDA'
                    });
                }
            });
        }

        return res.json({
            sucesso: true,
            periodo: {
                dataInicial: dtInicio,
                dataFim: dtFim,
                descricao: `${dtInicio.split('-').reverse().join('/')} a ${dtFim.split('-').reverse().join('/')}`
            },
            resumo: {
                totalPedidos,
                totalFaturamento,
                ticketMedio: ticketMedioGeral,
                totalPecas,
                mediaDiaria,
                diasComVenda: diasArray.length,
                melhorDia
            },
            dias: diasFormatados,
            pedidos: pedidosDetalhados
        });
    } catch (e) {
        console.error('[Relatório Vendas por Período] Erro:', e);
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
