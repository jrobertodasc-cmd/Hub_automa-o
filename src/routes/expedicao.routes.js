// src/routes/expedicao.routes.js
// Doca, Romaneios, Bipagem, Total Express, Remessas Bancárias e Fechamento Contábil

const express = require('express');
const router = express.Router();
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const multer = require('multer');

const supabase = require('../config/supabase');
const { requireAuth, requireRole, requireActiveSubscription } = require('../middlewares/auth');
const { HOLDING_CNPJ } = require('../config/constants');
const { sseClients, activeTasks, broadcastDockEvent } = require('../utils/events');
const {
    normalizarTransportadora,
    situacaoPagamentoGuia,
    extrairVencimentoGuiaReal,
    obterDataHojeBrasilIso,
    credenciaisTotalExpress
} = require('../utils/tenantHelper');

const printService = require('../../services/print_service');
const cnabService = require('../../services/cnab_service');
const totalExpressService = require('../../services/total_express_service');
const closingService = require('../../services/closing_service');
const sefazSpRetornoService = require('../../services/sefaz_sp_retorno_service');
const auditService = require('../../services/audit_service');
const parserService = require('../../services/parser_service');
const {
    calcularResumoRemessaDeGuias,
    sincronizarRemessaAutomaticaLote
} = require('../../services/batch_processor');

const uploadRetorno = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

const globalTotalTrackingCache = {};

// ==========================================
// CANAL EM TEMPO REAL (SSE - COCKPIT DA DOCA)
// ==========================================

router.get('/events/dock', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    res.tenantId = req.tenant.id;
    res.userId = req.user.id;

    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', tenantId: req.tenant.id, timestamp: new Date().toISOString() })}\n\n`);

    sseClients.add(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        } catch (e) {
            clearInterval(heartbeat);
            sseClients.delete(res);
        }
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});

// ==========================================
// REMESSA BANCÁRIA CNAB 240
// ==========================================

router.get('/remessa/resumo', requireAuth, async (req, res) => {
    try {
        const paymentDateChosen = req.query.dataPagamento || req.query.paymentDate || null;
        let tenant = req.tenant;
        if (tenant.cnpj === HOLDING_CNPJ) {
            try {
                const { data: lalua } = await supabase.from('tenants').select('*').eq('cnpj', '10436619000105').limit(1);
                if (lalua && lalua.length > 0) {
                    tenant = lalua[0];
                }
            } catch (tErr) {}
        }
        const rem = await sincronizarRemessaAutomaticaLote('todos', tenant, paymentDateChosen);
        if (!rem) {
            const dataPadrao = paymentDateChosen || obterDataHojeBrasilIso();
            const [ano, mes, dia] = String(dataPadrao).split('-');
            const cod = (dia && mes) ? `REM${dia}${mes}` : 'REMESSA';
            return res.json({
                gerada: false,
                qtdGuias: 0,
                valorTotal: 0,
                spAguardandoDare: 0,
                valorSpAguardando: 0,
                paymentDate: dataPadrao,
                codigoRemessa: cod,
                filename: `${cod}.txt`,
                contaBancaria: `Ag. ${tenant?.bank_agency || '0334'} C/C ${tenant?.bank_account || '98775'}-${tenant?.bank_dac || '7'}`
            });
        }
        const { cnabText, ...safeSummary } = rem;
        return res.json(safeSummary);
    } catch (err) {
        console.error('[API Remessa Resumo] Erro:', err);
        const dataPadrao = req.query.dataPagamento || req.query.paymentDate || obterDataHojeBrasilIso();
        const [ano, mes, dia] = String(dataPadrao).split('-');
        const cod = (dia && mes) ? `REM${dia}${mes}` : 'REMESSA';
        return res.json({
            gerada: false,
            qtdGuias: 0,
            valorTotal: 0,
            spAguardandoDare: 0,
            valorSpAguardando: 0,
            paymentDate: dataPadrao,
            codigoRemessa: cod,
            filename: `${cod}.txt`,
            contaBancaria: `Ag. 0334 C/C 98775-7`,
            aviso: err.message
        });
    }
});

router.get('/remessa/download/:batchId', requireAuth, async (req, res) => {
    try {
        const isTodos = req.params.batchId === 'todos';
        let batch = null;
        if (!isTodos) {
            const { data: b } = await supabase
                .from('batches')
                .select('*')
                .eq('id', req.params.batchId)
                .eq('tenant_id', req.tenant.id)
                .single();
            batch = b;
            if (!batch) {
                return res.status(404).json({ error: "Lote não localizado." });
            }
        }

        const effectiveBatchId = isTodos ? 'todos' : batch.id;
        const bankParam = (req.query.banco || 'itau').toLowerCase();
        const paymentDateChosen = req.query.paymentDate || req.query.dataPagamento;

        let queryGuides = supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id);

        if (!isTodos) {
            queryGuides = queryGuides.eq('batch_id', batch.id);
        }

        if (req.query.ids) {
            const idList = String(req.query.ids).split(',').map(s => s.trim()).filter(Boolean);
            if (idList.length > 0) queryGuides = queryGuides.in('id', idList);
        }

        const { data: batchGuides } = await queryGuides;

        if (bankParam === 'bradesco' || bankParam === 'bb') {
            const resumoBanco = calcularResumoRemessaDeGuias(batchGuides || [], req.tenant, effectiveBatchId, paymentDateChosen, { forcarPagas: !!req.query.forcarPagas });
            const validGuides = resumoBanco.validItauGuides || [];

            if (validGuides.length === 0) {
                return res.status(400).json({ error: "Nenhuma guia pendente para pagamento encontrada. Todas as guias já foram quitadas ou não possuem código de barras válido." });
            }

            const dadosBancarios = {
                cnpj: req.tenant.cnpj,
                razaoSocial: req.tenant.razao_social,
                agencia: req.tenant.bank_agency || '0001',
                conta: req.tenant.bank_account || '00001',
                dac: req.tenant.bank_dac || '0',
                convenio: req.tenant.bank_convenio || ''
            };

            const mapped = validGuides.map(g => ({
                codigoBarras: cnabService.normalizarCodigoBarras44(g.barcode),
                valor: g.value,
                dataVencimento: extrairVencimentoGuiaReal(g) || resumoBanco.paymentDate,
                documentoOrigem: g.nf_number,
                ufFavorecida: g.uf
            }));

            const cnabText = bankParam === 'bradesco'
                ? cnabService.gerarRemessaBradesco(dadosBancarios, mapped, resumoBanco.paymentDate)
                : cnabService.gerarRemessaBB(dadosBancarios, mapped, resumoBanco.paymentDate);

            res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
            res.setHeader('Content-Disposition', `attachment; filename="${resumoBanco.filename}"`);
            return res.send(Buffer.from(cnabText, 'latin1'));
        }

        const resumoRem = calcularResumoRemessaDeGuias(batchGuides || [], req.tenant, effectiveBatchId, paymentDateChosen, { forcarPagas: !!req.query.forcarPagas });
        const validItauGuides = resumoRem.validItauGuides || [];

        if (validItauGuides.length === 0) {
            const msgSp = resumoRem.spAguardandoDare > 0
                ? ` As ${resumoRem.spAguardandoDare} nota(s) de SP aguardam a importação do arquivo .ZIP/.PDF de DAREs da SEFAZ-SP.`
                : '';
            return res.status(400).json({ 
                error: `Nenhuma guia emitida pendente de pagamento encontrada.${msgSp}`
            });
        }

        const dadosBancarios = {
            cnpj: req.tenant.cnpj,
            razaoSocial: req.tenant.razao_social,
            agencia: req.tenant.bank_agency || '0334',
            conta: req.tenant.bank_account || '98775',
            dac: req.tenant.bank_dac || '7',
            convenio: req.tenant.bank_convenio || ''
        };

        const mapped = validItauGuides.map(g => ({
            codigoBarras: cnabService.normalizarCodigoBarras44(g.barcode),
            valor: g.value,
            dataVencimento: extrairVencimentoGuiaReal(g) || resumoRem.paymentDate,
            documentoOrigem: g.nf_number,
            ufFavorecida: g.uf
        }));

        const cnabText = cnabService.gerarRemessaSispag(dadosBancarios, mapped, resumoRem.paymentDate);

        const remessaPath = `${req.tenant.id}/remessas/remessa_${batch ? batch.id : effectiveBatchId}.txt`;
        supabase.storage
            .from('tenant-storage')
            .upload(remessaPath, Buffer.from(cnabText, 'latin1'), { contentType: 'text/plain', upsert: true })
            .catch(e => console.warn('[Storage] Falha ao persistir remessa Itaú:', e.message));

        res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
        res.setHeader('Content-Disposition', `attachment; filename="${resumoRem.filename}"`);
        return res.send(Buffer.from(cnabText, 'latin1'));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/fintech/itau/remessa-cnab240', requireAuth, async (req, res) => {
    try {
        const paymentDateChosen = req.query.dataPagamento || req.query.paymentDate || null;
        const rem = await sincronizarRemessaAutomaticaLote('todos', req.tenant, paymentDateChosen);
        if (!rem || !rem.gerada || !rem.cnabText) {
            const msgSp = rem && rem.spAguardandoDare > 0
                ? ` (${rem.spAguardandoDare} nota(s) de SP aguardando importação de DARE-SP)`
                : '';
            return res.status(400).json({
                error: `Nenhuma guia emitida pendente de pagamento disponível para gerar remessa CNAB 240${msgSp}.`
            });
        }
        res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
        res.setHeader('Content-Disposition', `attachment; filename="${rem.filename}"`);
        return res.send(Buffer.from(rem.cnabText, 'latin1'));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

async function conciliarConteudoRetornoCnab(conteudo, tenant) {
    const resultadoParsing = cnabService.processarRetornoSispag(conteudo);
    const atualizadas = [];
    const naoLocalizadas = [];

    const { data: todasGuiasTenant } = await supabase
        .from('guides')
        .select('id, nf_number, uf, value, status, barcode')
        .eq('tenant_id', tenant.id);

    const listaTenant = todasGuiasTenant || [];

    for (const pag of resultadoParsing.pagamentos) {
        const barRet44 = cnabService.normalizarCodigoBarras44(pag.codigoBarras);
        let guiasEncontradas = [];

        if (barRet44.length === 44) {
            guiasEncontradas = listaTenant.filter(g => cnabService.normalizarCodigoBarras44(g.barcode) === barRet44);
        } else if (pag.codigoBarras && pag.codigoBarras.length >= 40) {
            guiasEncontradas = listaTenant.filter(g => String(g.barcode || '').trim() === pag.codigoBarras);
        }

        if (guiasEncontradas.length === 0 && pag.nfNumber) {
            const numRet = parseInt(pag.nfNumber, 10);
            guiasEncontradas = listaTenant.filter(g => {
                const numG = parseInt(g.nf_number, 10);
                return (!isNaN(numG) && !isNaN(numRet) && numG === numRet);
            });
        }

        const dataPagIso = pag.dataPagamentoIso || new Date().toISOString().split('T')[0];

        if (guiasEncontradas.length > 0) {
            for (const g of guiasEncontradas) {
                await supabase
                    .from('guides')
                    .update({
                        status: 'paga',
                        paid_at: dataPagIso,
                        bank_authentication: pag.autenticacaoBancaria || 'RETORNO_CNAB240'
                    })
                    .eq('id', g.id)
                    .eq('tenant_id', tenant.id);

                atualizadas.push({
                    id: g.id,
                    nf: g.nf_number,
                    uf: g.uf,
                    valor: pag.valorPago || g.value,
                    autenticacao: pag.autenticacaoBancaria,
                    dataPagamento: dataPagIso
                });
            }
        } else {
            naoLocalizadas.push(pag);
        }
    }

    if (atualizadas.length > 0) {
        const syncRem = await sincronizarRemessaAutomaticaLote('todos', tenant).catch(() => null);
        const remessaPayload = syncRem ? { ...syncRem, cnabText: undefined } : null;

        broadcastDockEvent({
            type: 'LOTE_ATUALIZADO',
            message: `${atualizadas.length} guias baixadas automaticamente pelo Retorno CNAB 240!`,
            remessa: remessaPayload,
            timestamp: new Date().toISOString()
        }, tenant.id);
    }

    return {
        success: true,
        totalLinhasRetorno: resultadoParsing.totalPagamentos,
        valorTotalLiquidado: resultadoParsing.valorTotal,
        dataArquivo: resultadoParsing.dataGravacao,
        atualizadas: atualizadas.length,
        guiasBaixadas: atualizadas,
        naoLocalizadas: naoLocalizadas.length,
        detalhesNaoLocalizadas: naoLocalizadas
    };
}

router.post('/cnab/upload-retorno', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), uploadRetorno.single('retornoFile'), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: "Nenhum arquivo de retorno (.RET) foi enviado." });
        }
        const conteudo = req.file.buffer.toString('utf-8');
        const resultado = await conciliarConteudoRetornoCnab(conteudo, req.tenant);
        return res.json(resultado);
    } catch (err) {
        console.error("Erro ao processar retorno CNAB 240:", err);
        return res.status(500).json({ error: `Erro ao processar retorno bancário: ${err.message}` });
    }
});

router.post('/fintech/itau/retorno-cnab240', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), async (req, res) => {
    try {
        const conteudo = req.body?.conteudoRetorno || '';
        if (!conteudo || typeof conteudo !== 'string') {
            return res.status(400).json({ error: "Conteúdo do arquivo de retorno (.RET) não informado." });
        }
        const resultado = await conciliarConteudoRetornoCnab(conteudo, req.tenant);
        return res.json(resultado);
    } catch (err) {
        console.error("Erro ao processar retorno CNAB 240 (JSON):", err);
        return res.status(500).json({ error: `Erro ao processar retorno bancário: ${err.message}` });
    }
});

router.post('/sefaz-sp/upload-retorno-zip', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin', 'operador']), uploadRetorno.single('retornoZip'), async (req, res) => {
    let tempFilePath = null;
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: "Nenhum arquivo .ZIP de retorno da SEFAZ-SP foi enviado." });
        }

        tempFilePath = path.join(os.tmpdir(), `sefaz_sp_${Date.now()}_${req.file.originalname}`);
        await fs.writeFile(tempFilePath, req.file.buffer);

        const resultado = await sefazSpRetornoService.processarRetornoSpZip({
            supabase,
            tenantId: req.tenant.id,
            caminhoZip: tempFilePath
        });

        await fs.unlink(tempFilePath).catch(() => {});
        tempFilePath = null;

        let remessaSp = null;
        if (resultado.atualizadas > 0) {
            const syncRem = await sincronizarRemessaAutomaticaLote('todos', req.tenant).catch(() => null);
            if (syncRem) {
                remessaSp = { ...syncRem };
                delete remessaSp.cnabText;
            }

            broadcastDockEvent({
                type: 'LOTE_ATUALIZADO',
                message: `${resultado.atualizadas} DAREs de SP importados com sucesso!`,
                remessa: remessaSp,
                timestamp: new Date().toISOString()
            }, req.tenant.id);

            await auditService.logAudit({
                supabase,
                tenantId: req.tenant.id,
                userId: req.user ? req.user.id : null,
                action: 'UPLOAD_RETORNO_SP_ZIP',
                details: {
                    atualizadas: resultado.atualizadas,
                    totalProcessados: resultado.totalProcessados,
                    nomeArquivo: req.file.originalname,
                    remessaCodigo: remessaSp?.codigoRemessa || null,
                    remessaQtdGuias: remessaSp?.qtdGuias || 0
                }
            }).catch(() => {});
        }

        return res.json({
            success: true,
            message: resultado.message,
            resumo: {
                totalEncontrados: resultado.totalEncontrados,
                totalProcessados: resultado.totalProcessados,
                atualizadas: resultado.atualizadas,
                ignoradasJaPagas: resultado.ignoradasJaPagas,
                naoLocalizadas: resultado.naoLocalizadas
            },
            detalhes: resultado.detalhes,
            remessa: remessaSp
        });
    } catch (err) {
        if (tempFilePath) {
            await fs.unlink(tempFilePath).catch(() => {});
        }
        console.error("Erro ao importar retorno SP (.zip):", err);
        return res.status(500).json({ error: `Erro ao processar arquivo da SEFAZ-SP: ${err.message}` });
    }
});

// ==========================================
// DOCA E CARGAS ATIVAS
// ==========================================

router.get('/expedicao/cargas-ativas', requireAuth, async (req, res) => {
    try {
        const tenant = req.tenant;
        const { data: batches } = await supabase
            .from('batches')
            .select('*')
            .eq('tenant_id', tenant.id)
            .neq('status', 'cancelado')
            .order('created_at', { ascending: false })
            .limit(1);

        const activeBatch = batches && batches.length > 0 ? batches[0] : null;

        let query = supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenant.id)
            .order('nf_number', { ascending: false });

        if (activeBatch) {
            query = query.eq('batch_id', activeBatch.id);
        }

        const { data: guias } = await query;
        const lista = guias || [];

        let total = lista.length;
        let countPagas = 0;
        let countPendentes = 0;
        let countNaoPagas = 0;
        let valorTotal = 0;
        let valorPagas = 0;
        let valorPendentes = 0;
        let valorNaoPagas = 0;

        const porTransportadora = {};

        lista.forEach(g => {
            const val = parseFloat(g.value || 0);
            valorTotal += val;
            const sit = situacaoPagamentoGuia(g);
            const isPaga = (sit === 'paga');
            const isPendente = (sit === 'a_pagar' || sit === 'agendada');
            const isNaoPaga = (sit === 'sem_guia' || sit === 'sp_manual' || sit === 'rejeitada');

            if (isPaga) {
                countPagas++;
                valorPagas += val;
            } else if (isPendente) {
                countPendentes++;
                valorPendentes += val;
            } else {
                countNaoPagas++;
                valorNaoPagas += val;
            }

            let transp = normalizarTransportadora(g.carrier_name || g.carrier_cnpj);

            if (!porTransportadora[transp]) {
                porTransportadora[transp] = { total: 0, liberadas: 0, retidas: 0, pagas: 0, pendentes: 0, naoPagas: 0, valor: 0 };
            }
            porTransportadora[transp].total++;
            porTransportadora[transp].valor += val;
            if (isPaga) {
                porTransportadora[transp].liberadas++;
                porTransportadora[transp].pagas = (porTransportadora[transp].pagas || 0) + 1;
            } else if (isPendente) {
                porTransportadora[transp].retidas++;
                porTransportadora[transp].pendentes = (porTransportadora[transp].pendentes || 0) + 1;
            } else {
                porTransportadora[transp].retidas++;
                porTransportadora[transp].naoPagas = (porTransportadora[transp].naoPagas || 0) + 1;
            }
        });

        const liveTask = (activeBatch && activeTasks[activeBatch.id]) ? activeTasks[activeBatch.id] : null;
        const batchPayload = activeBatch ? {
            ...activeBatch,
            live_progress: liveTask ? liveTask.progress : (activeBatch.status === 'sucesso' ? 100 : 0),
            live_status: liveTask ? liveTask.status : activeBatch.status,
            live_logs: liveTask ? liveTask.logs : []
        } : null;

        const remessaResumo = calcularResumoRemessaDeGuias(lista, tenant, activeBatch ? activeBatch.id : 'todos');
        delete remessaResumo.validItauGuides;

        return res.json({
            batch: batchPayload,
            remessa: remessaResumo,
            resumo: {
                total,
                pagas: countPagas,
                pendentes: countPendentes,
                naoPagas: countNaoPagas,
                liberadas: countPagas,
                retidas: countPendentes + countNaoPagas,
                valorTotal: parseFloat(valorTotal.toFixed(2)),
                valorPagas: parseFloat(valorPagas.toFixed(2)),
                valorPendentes: parseFloat(valorPendentes.toFixed(2)),
                valorNaoPagas: parseFloat(valorNaoPagas.toFixed(2)),
                valorPendente: parseFloat(valorPendentes.toFixed(2))
            },
            porTransportadora,
            cargas: lista.map(g => {
                const val = parseFloat(g.value || 0);
                const sit = situacaoPagamentoGuia(g);
                const isPaga = (sit === 'paga');
                const isPendente = (sit === 'a_pagar' || sit === 'agendada');
                const isNaoPaga = !isPaga && !isPendente;

                return {
                    id: g.id,
                    nf_number: g.nf_number,
                    chave_nfe: g.chave_nfe,
                    uf: g.uf,
                    value: val,
                    customer_name: g.customer_name || 'Consumidor Final',
                    carrier_name: g.carrier_name || 'Transportadora Padrão',
                    status: g.status,
                    situacao_operacional: isPaga ? 'PAGA' : (isPendente ? 'PENDENTE' : 'NAO_PAGA'),
                    is_paga: isPaga,
                    is_pendente: isPendente,
                    is_nao_paga: isNaoPaga,
                    is_liberada: isPaga,
                    created_at: g.created_at,
                    emission_date: g.emission_date || g.nf_issue_date || g.created_at || null,
                    due_date: g.due_date
                        || printService.extrairVencimentoDeBarcodeGnre(g.barcode)
                        || (() => {
                            const mSp = String(g.line_digitizable || '').match(/Venc\.\s*(\d{2})\/(\d{2})\/(\d{4})/);
                            return mSp ? `${mSp[3]}-${mSp[2]}-${mSp[1]}` : null;
                        })()
                        || null,
                    has_xml: Boolean(g.xml_storage_path || (g.chave_nfe && String(g.chave_nfe).replace(/\D/g, '').length >= 44)),
                    storage_path: g.storage_path || null,
                    barcode: g.barcode || null,
                    line_digitizable: g.line_digitizable || null,
                    paid_at: g.paid_at || null,
                    bank_authentication: g.bank_authentication || null,
                    situacao_pagamento: sit,
                    return_nf_reference: g.return_nf_reference || (globalTotalTrackingCache[req.tenant.id + ':' + g.nf_number]?.awb) || null,
                    tracking: globalTotalTrackingCache[req.tenant.id + ':' + g.nf_number] || null
                };
            }).sort((a, b) => {
                const pesoA = a.is_nao_paga ? 1 : (a.is_pendente ? 2 : 3);
                const pesoB = b.is_nao_paga ? 1 : (b.is_pendente ? 2 : 3);
                if (pesoA !== pesoB) return pesoA - pesoB;
                return (parseInt(b.nf_number, 10) || 0) - (parseInt(a.nf_number, 10) || 0);
            })
        });
    } catch (err) {
        console.error("Erro ao buscar cargas ativas:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/expedicao/bipar', requireAuth, async (req, res) => {
    try {
        const { termo } = req.query;
        if (!termo) return res.status(400).json({ error: "Termo de busca não informado." });

        const clean = String(termo).replace(/[^0-9a-zA-Z\-]/g, '').substring(0, 44);
        let nfNumero = clean;
        if (clean.length >= 44) {
            const extraido = parseInt(clean.substring(25, 34), 10);
            if (!isNaN(extraido)) nfNumero = String(extraido);
        }

        const tenant = req.tenant;
        const { data: guias } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenant.id)
            .or(`chave_nfe.eq.${clean},nf_number.eq.${nfNumero},nf_number.eq.${clean},order_number.eq.${clean}`)
            .order('created_at', { ascending: false })
            .limit(1);

        if (!guias || guias.length === 0) {
            return res.status(404).json({ error: "Guia não encontrada para o código informado." });
        }

        const guia = guias[0];
        return res.json({
            guia: {
                id: guia.id,
                nf_number: guia.nf_number,
                chave_nfe: guia.chave_nfe,
                uf: guia.uf,
                value: parseFloat(guia.value || 0),
                customer_name: guia.customer_name || 'Consumidor Final',
                carrier_name: guia.carrier_name || 'Transportadora Padrão',
                status: guia.status,
                is_liberada: printService.isGuiaLiberada(guia),
                barcode: guia.barcode,
                line_digitizable: guia.line_digitizable
            }
        });
    } catch (err) {
        console.error("Erro na busca de bipagem:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/expedicao/romaneio', requireAuth, async (req, res) => {
    try {
        const { batchId, carrier } = req.query;
        let query = supabase.from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: false });

        if (batchId) {
            query = query.eq('batch_id', batchId);
        }
        if (carrier && carrier !== 'TODAS') {
            query = query.eq('carrier_name', carrier);
        }

        const { data: guiasDb } = await query;
        let guias = guiasDb || [];
        if (carrier && carrier !== 'TODAS') {
            const filtradas = guias.filter(g => (g.carrier_name || '').toLowerCase() === carrier.toLowerCase());
            if (filtradas.length > 0) guias = filtradas;
        }

        return res.json({
            total: guias.length,
            carrier: carrier || 'TODAS',
            guias
        });
    } catch (err) {
        console.error("Erro ao gerar romaneio:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/expedicao/romaneio-pdf', requireAuth, async (req, res) => {
    try {
        const { batchId, carrier } = req.query;
        let query = supabase.from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: false });

        if (batchId) {
            query = query.eq('batch_id', batchId);
        }
        if (carrier && carrier !== 'TODAS') {
            query = query.eq('carrier_name', carrier);
        }

        const { data: guias, error } = await query;
        if (error) throw error;

        const pdfBuffer = await printService.gerarRomaneioPdfBuffer(req.tenant, guias || [], { carrier });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Romaneio_Coleta_${(carrier || 'GERAL').replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar PDF do romaneio:", err);
        return res.status(500).json({ error: "Erro ao gerar PDF do romaneio: " + err.message });
    }
});

router.get('/expedicao/combo/:batchId', requireAuth, async (req, res) => {
    try {
        const { batchId } = req.params;
        const { carrier, onlyCleared } = req.query;

        let query = supabase.from('guides')
            .select('*')
            .eq('batch_id', batchId)
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: false });

        if (carrier && carrier !== 'TODAS') {
            query = query.eq('carrier_name', carrier);
        }

        const { data: guias, error } = await query;
        if (error || !guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para gerar o combo desta transportadora." });
        }

        const options = {
            carrier: carrier || 'TODAS',
            onlyCleared: onlyCleared === 'true' || onlyCleared === '1'
        };

        const comboPdfBuffer = await printService.gerarComboExpedicaoPdf(req.tenant, guias, supabase, options);

        const transpSafe = (carrier || 'Geral').replace(/[^a-zA-Z0-9]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Combo_Expedicao_${transpSafe}_Lote_${batchId}.pdf"`);
        return res.send(comboPdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar Combo Completo de Expedição:", err);
        return res.status(500).json({ error: "Erro ao gerar Combo Completo de Expedição: " + err.message });
    }
});

// ==========================================
// FECHAMENTO CONTÁBIL & CONCILIAÇÃO
// ==========================================

async function obterGuiasParaFechamento(tenantId, batchId, dataFiltro) {
    let query = supabase.from('guides')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('nf_number', { ascending: true });

    if (batchId && batchId !== 'hoje' && batchId !== 'todos') {
        query = query.eq('batch_id', batchId);
    } else if (dataFiltro) {
        query = query.gte('created_at', `${dataFiltro}T00:00:00`).lte('created_at', `${dataFiltro}T23:59:59`);
    }

    let { data: guias, error } = await query;
    if (error) console.warn("[Fechamento] Aviso ao consultar guias:", error.message);

    if ((!guias || guias.length === 0) && (batchId === 'hoje' || !batchId)) {
        try {
            const { data: latestBatch } = await supabase.from('batches')
                .select('id')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (latestBatch) {
                const { data: batchGuias } = await supabase.from('guides')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('batch_id', latestBatch.id)
                    .order('nf_number', { ascending: false });
                if (batchGuias && batchGuias.length > 0) {
                    guias = batchGuias;
                }
            }
        } catch (eBatch) {}
    }

    return guias || [];
}

router.get('/fechamento/resumo/:batchId?', requireAuth, async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        const resumo = closingService.conciliarLoteOuDia(req.tenant, guias);
        return res.status(200).json(resumo);
    } catch (err) {
        console.error("Erro ao gerar resumo de fechamento:", err);
        return res.status(500).json({ error: "Erro ao gerar resumo de conciliação: " + err.message });
    }
});

router.get('/fechamento/relatorio-pdf/:batchId?', requireAuth, async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        const pdfBuffer = await closingService.gerarResumoExecutivoPdf(req.tenant, guias);
        const dataStr = new Date().toISOString().split('T')[0];

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Relatorio_Executivo_Diretoria_${dataStr}.pdf"; filename*="UTF-8''Relatorio_Executivo_Diretoria_${dataStr}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar Relatório Executivo PDF:", err);
        return res.status(500).json({ error: "Erro ao gerar Relatório Executivo: " + err.message });
    }
});

router.get('/fechamento/planilha-csv/:batchId?', requireAuth, async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        const csvBuffer = closingService.gerarPlanilhaConciliacaoCsv(req.tenant, guias);
        const dataStr = new Date().toISOString().split('T')[0];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="Conciliacao_Fiscal_${dataStr}.csv"; filename*="UTF-8''Conciliacao_Fiscal_${dataStr}.csv"`);
        return res.send(csvBuffer);
    } catch (err) {
        console.error("Erro ao gerar Planilha CSV:", err);
        return res.status(500).json({ error: "Erro ao gerar Planilha CSV: " + err.message });
    }
});

router.get('/fechamento/pacote-zip/:batchId?', requireAuth, requireRole(['diretoria', 'financeiro', 'admin']), async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        if (!guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para fechar pacote de auditoria." });
        }

        const zipBuffer = await closingService.gerarPacoteFechamentoZip(req.tenant, guias, supabase);
        const dataStr = new Date().toISOString().split('T')[0];

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="Pacote_Auditoria_Fiscal_${dataStr}.zip"; filename*="UTF-8''Pacote_Auditoria_Fiscal_${dataStr}.zip"`);
        return res.send(zipBuffer);
    } catch (err) {
        console.error("Erro ao gerar Pacote ZIP de Fechamento:", err);
        return res.status(500).json({ error: "Erro ao gerar Pacote ZIP: " + err.message });
    }
});

// ==========================================
// TOTAL EXPRESS
// ==========================================

router.post('/total-express/despachar/:guideId', requireAuth, requireActiveSubscription, async (req, res) => {
    const { guideId } = req.params;
    const tenant = req.tenant;

    try {
        if (process.env.TOTAL_EXPRESS_ENABLED !== 'true') {
            return res.status(200).json({
                success: true,
                modoSimulado: true,
                message: "API da Total Express pausada temporariamente a pedido da operação para evitar coletas na loja/CD. Nenhuma coleta física foi solicitada.",
                awb: `SIM_${req.params.guideId}`,
                rota: `(A)01-SAO-L-TZO-[SIM]`,
                etiquetaUrl: `/api/total-express/etiqueta/${req.params.guideId}`
            });
        }

        const { data: guide, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('id', guideId)
            .eq('tenant_id', tenant.id)
            .single();

        if (gErr || !guide) {
            return res.status(404).json({ error: "Guia não encontrada no sistema." });
        }

        let xmlContent = null;
        if (guide.xml_storage_path) {
            try {
                const { data: xData } = await supabase.storage
                    .from('tenant-storage')
                    .download(guide.xml_storage_path);
                if (xData) xmlContent = await xData.text();
            } catch (e) {}
        }

        if (!xmlContent) {
            return res.status(400).json({ error: `XML da NF-e ${guide.nf_number} não encontrado para registrar na Total Express.` });
        }

        const dadosNfe = parserService.extrairDadosNfeXML(xmlContent);

        const totalConfig = {
            environment: tenant.total_express_env || process.env.TOTAL_EXPRESS_ENV || 'producao',
            ...credenciaisTotalExpress(tenant),
            cnpj: tenant.cnpj || '',
            servicoTipo: tenant.total_express_servico || 1
        };

        const retornoSmartLabel = await totalExpressService.registrarEncomendaSmartLabel(dadosNfe, totalConfig);

        const etiquetaPdf = await totalExpressService.gerarEtiquetaTermicaPdfBuffer({
            awb: retornoSmartLabel.awb,
            rota: retornoSmartLabel.rota,
            servico: totalConfig.servicoTipo === 7 ? 'EXP - EXPRESSO' : 'STD - STANDARD',
            dadosNfe,
            empresa: tenant
        });

        const remoteLabelPath = `${tenant.id}/etiquetas/etiqueta_NF_${guide.nf_number}.pdf`;
        await supabase.storage
            .from('tenant-storage')
            .upload(remoteLabelPath, etiquetaPdf, {
                contentType: 'application/pdf',
                upsert: true
            });

        await supabase
            .from('guides')
            .update({
                carrier_name: 'Total Express',
                carrier_cnpj: '73939449000156',
                return_nf_reference: retornoSmartLabel.awb
            })
            .eq('id', guide.id)
            .eq('tenant_id', tenant.id);

        return res.status(200).json({
            success: true,
            awb: retornoSmartLabel.awb,
            rota: retornoSmartLabel.rota,
            codigoBarras: retornoSmartLabel.codigoBarras,
            etiquetaUrl: `/api/total-express/etiqueta/${guide.id}`,
            message: `Encomenda despachada com sucesso na Total Express! AWB: ${retornoSmartLabel.awb} | Rota: ${retornoSmartLabel.rota}`
        });

    } catch (err) {
        console.error("Erro ao registrar Smart Label Total Express:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/total-express/etiqueta/:guideId', requireAuth, async (req, res) => {
    try {
        const { data: guide, error } = await supabase
            .from('guides')
            .select('*')
            .eq('id', req.params.guideId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !guide) {
            return res.status(404).json({ error: "Guia não encontrada." });
        }

        const remoteLabelPath = `${req.tenant.id}/etiquetas/etiqueta_NF_${guide.nf_number}.pdf`;
        let buffer = null;

        const temAwbOficial = guide.return_nf_reference && guide.return_nf_reference.startsWith('TXAQ');
        const forcar = req.query.force === 'true' || req.query.regerar === 'true';

        if (temAwbOficial && !forcar) {
            try {
                const { data } = await supabase.storage
                    .from('tenant-storage')
                    .download(remoteLabelPath);
                if (data) buffer = Buffer.from(await data.arrayBuffer());
            } catch(e) {}
        }

        if (!buffer) {
            let xmlContent = null;
            if (guide.xml_storage_path) {
                const { data: xData } = await supabase.storage.from('tenant-storage').download(guide.xml_storage_path);
                if (xData) xmlContent = await xData.text();
            }
            if (!xmlContent) {
                return res.status(400).send("XML da NF-e não encontrado para gerar etiqueta da Total Express.");
            }
            const dadosNfe = parserService.extrairDadosNfeXML(xmlContent);

            const totalConfig = {
                environment: req.tenant.total_express_env || process.env.TOTAL_EXPRESS_ENV || 'producao',
                ...credenciaisTotalExpress(req.tenant),
                cnpj: req.tenant.cnpj || '',
                servicoTipo: req.tenant.total_express_servico || 1
            };

            let awb = guide.return_nf_reference;
            let rota = null;

            if (!temAwbOficial) {
                try {
                    const retornoSmartLabel = await totalExpressService.registrarEncomendaSmartLabel(dadosNfe, totalConfig);
                    awb = retornoSmartLabel.awb;
                    rota = retornoSmartLabel.rota;

                    await supabase
                        .from('guides')
                        .update({
                            carrier_name: 'Total Express',
                            carrier_cnpj: '73939449000156',
                            return_nf_reference: awb
                        })
                        .eq('id', guide.id)
                        .eq('tenant_id', req.tenant.id);
                } catch (regErr) {
                    console.warn(`[SmartLabel] Aviso ao registrar NF ${guide.nf_number} na Total Express:`, regErr.message);
                    awb = awb || `TX${guide.nf_number}BR`;
                    rota = '(A)99-SAO-L-TZO-[999]';
                }
            }

            buffer = await totalExpressService.gerarEtiquetaTermicaPdfBuffer({
                awb: awb,
                rota: rota || '(A)99-SAO-L-TZO-[999]',
                servico: totalConfig.servicoTipo === 7 ? 'EXP - EXPRESSO' : 'STD - STANDARD',
                dadosNfe,
                empresa: req.tenant
            });

            try {
                await supabase.storage
                    .from('tenant-storage')
                    .upload(remoteLabelPath, buffer, {
                        contentType: 'application/pdf',
                        upsert: true
                    });
            } catch(e) {}
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="etiqueta_TotalExpress_NF_${guide.nf_number}.pdf"`);
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/total-express/tracking', requireAuth, async (req, res) => {
    try {
        if (process.env.TOTAL_EXPRESS_ENABLED !== 'true') {
            return res.json({ success: true, data: [], message: "API da Total Express pausada temporariamente." });
        }

        const tenant = req.tenant;
        const { guideId, nf_number, awb, notasFiscais, awbs, pedidos } = req.body;

        const config = {
            environment: tenant.total_express_env || process.env.TOTAL_EXPRESS_ENV || 'producao',
            ...credenciaisTotalExpress(tenant)
        };

        let params = {};
        if (awbs && awbs.length > 0) {
            params.awbs = awbs;
        } else if (awb) {
            params.awbs = [String(awb).trim()];
        } else if (notasFiscais && notasFiscais.length > 0) {
            params.notasFiscais = notasFiscais;
        } else if (nf_number) {
            params.notasFiscais = [String(nf_number).trim()];
        } else if (pedidos && pedidos.length > 0) {
            params.pedidos = pedidos;
        } else if (guideId) {
            const { data: guide } = await supabase
                .from('guides')
                .select('*')
                .eq('id', guideId)
                .eq('tenant_id', tenant.id)
                .single();
            if (!guide) return res.status(404).json({ error: "Guia não encontrada." });

            if (guide.return_nf_reference && guide.return_nf_reference.startsWith('TX')) {
                params.awbs = [guide.return_nf_reference];
            } else {
                params.notasFiscais = [String(guide.nf_number)];
            }
        } else {
            return res.status(400).json({ error: "Informe ao menos guideId, nf_number, awb ou lista de notas." });
        }

        const resultado = await totalExpressService.consultarStatusEntrega(params, config);
        return res.status(200).json({ success: true, ...resultado });
    } catch (err) {
        console.error("Erro na consulta de Tracking Total Express:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.post('/total-express/sync-tracking-batch', requireAuth, async (req, res) => {
    try {
        if (process.env.TOTAL_EXPRESS_ENABLED !== 'true') {
            return res.json({ success: true, count: 0, trackingMap: {}, message: "API da Total Express pausada temporariamente a pedido da operação." });
        }

        const tenant = req.tenant;
        let { nfs, force } = req.body;

        if (!nfs || !Array.isArray(nfs) || nfs.length === 0) {
            const { data: activeGuides } = await supabase
                .from('guides')
                .select('nf_number, return_nf_reference')
                .eq('tenant_id', tenant.id)
                .order('nf_number', { ascending: false })
                .limit(50);
            
            nfs = (activeGuides || []).map(g => String(g.nf_number).trim()).filter(Boolean);
        }

        if (nfs.length === 0) {
            return res.json({ success: true, count: 0, trackingMap: {}, message: "Nenhuma NF para sincronizar." });
        }

        const nfsToQuery = nfs.slice(0, 50).map(String);
        const now = Date.now();
        const nfsPendentes = force ? nfsToQuery : nfsToQuery.filter(nf => {
            const c = globalTotalTrackingCache[tenant.id + ':' + nf];
            return !c || (now - c.syncedAt > 120000);
        });

        if (nfsPendentes.length > 0) {
            const config = {
                environment: tenant.total_express_env || process.env.TOTAL_EXPRESS_ENV || 'producao',
                ...credenciaisTotalExpress(tenant)
            };

            try {
                const apiRes = await totalExpressService.consultarStatusEntrega({
                    notasFiscais: nfsPendentes,
                    comprovanteEntrega: true
                }, config);

                const encomendas = apiRes.data || [];
                for (const enc of encomendas) {
                    const nf = String(enc.notaFiscal || '').trim();
                    if (!nf) continue;

                    const eventos = enc.tracking || [];
                    const ultEvento = eventos.length > 0 ? eventos[eventos.length - 1] : null;
                    const statusCod = ultEvento ? parseInt(ultEvento.status, 10) : 0;
                    const desc = (ultEvento?.descricao || 'ARQUIVO RECEBIDO').toUpperCase();

                    const isEntregue = (statusCod === 1 || desc.includes('ENTREGA REALIZADA'));
                    const isColetada = (statusCod >= 83 || isEntregue || desc.includes('COLETA') || desc.includes('CD') || desc.includes('EMBARCADO') || desc.includes('ROTA') || desc.includes('TRANSFER'));
                    const isEmRota = (desc.includes('ROTA') || desc.includes('PROCESSO DE ENTREGA'));
                    const isTransferencia = (desc.includes('TRANSFER') || desc.includes('EMBARCADO'));
                    const hasProblema = (desc.includes('AUSENTE') || desc.includes('EXTRAV') || desc.includes('RETID') || desc.includes('INSUCESSO') || desc.includes('RECUSA'));

                    const recebedor = enc.dadosRecebedor;

                    globalTotalTrackingCache[tenant.id + ':' + nf] = {
                        nf: nf,
                        awb: enc.awb || null,
                        rota: enc.rota || null,
                        pesoCapturado: enc.pesoCapturado || 0,
                        previsaoEntrega: enc.previsaoEntregaAtualizada || enc.previsaoEntrega || null,
                        ultimoStatus: ultEvento?.descricao || 'ARQUIVO RECEBIDO',
                        statusCodigo: statusCod,
                        dataStatus: ultEvento?.data || null,
                        cidadeStatus: ultEvento?.cidade || null,
                        ufStatus: ultEvento?.uf || null,
                        isColetada,
                        isEntregue,
                        isEmRota,
                        isTransferencia,
                        hasProblema,
                        recebedorNome: recebedor?.nome || null,
                        recebedorDoc: recebedor?.documento || null,
                        comprovanteUrl: recebedor?.comprovanteEntrega?.urlArquivo || null,
                        totalEventos: eventos.length,
                        syncedAt: now
                    };

                    if (enc.awb) {
                        await supabase
                            .from('guides')
                            .update({ carrier_name: 'Total Express', return_nf_reference: enc.awb })
                            .eq('nf_number', nf)
                            .eq('tenant_id', tenant.id)
                            .is('return_nf_reference', null);
                    }
                }
            } catch (errApi) {
                console.warn("[TotalExpressSync] Erro na consulta em lote:", errApi.message);
            }
        }

        const trackingMap = {};
        nfsToQuery.forEach(nf => {
            if (globalTotalTrackingCache[tenant.id + ':' + nf]) {
                trackingMap[nf] = globalTotalTrackingCache[tenant.id + ':' + nf];
            }
        });

        return res.json({
            success: true,
            count: Object.keys(trackingMap).length,
            trackingMap,
            syncedAt: new Date().toISOString()
        });
    } catch (err) {
        console.error("Erro na rota de sync em lote da Total Express:", err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
