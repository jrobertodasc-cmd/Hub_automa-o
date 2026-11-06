// src/routes/batch.routes.js
// Emissão, Autorização e Gestão de Lotes de Guias GNRE / DARE / SEFAZ

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');

const supabase = require('../config/supabase');
const { requireAuth, requireRole, requireActiveSubscription } = require('../middlewares/auth');
const upload = require('../middlewares/upload');
const { PLAN_LIMITS } = require('../config/constants');
const { getEncryptionKey, decrypt } = require('../utils/crypto');
const { activeTasks, broadcastDockEvent } = require('../utils/events');
const { situacaoPagamentoGuia } = require('../utils/tenantHelper');

const parserService = require('../../services/parser_service');
const danfeService = require('../../services/danfe_service');
const gnreService = require('../../services/gnre_service');
const duaEsService = require('../../services/dua_es_service');
const printService = require('../../services/print_service');
const cnabService = require('../../services/cnab_service');
const asaasService = require('../../services/asaas_service');
const {
    stageBatchForApproval,
    transmitStagedBatchToSefaz,
    calcularResumoRemessaDeGuias,
    sincronizarRemessaAutomaticaLote
} = require('../../services/batch_processor');

function getAsaasApiKey(tenant) {
    if (!tenant || !tenant.asaas_api_key_encrypted) return null;
    try {
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        return decrypt(tenant.asaas_api_key_encrypted, key);
    } catch {
        return null;
    }
}

async function getTenantHttpsAgent(tenant) {
    if (tenant.environment !== 'producao') return null;
    if (!tenant.pfx_filename) {
        throw new Error("Nenhum certificado digital PFX cadastrado para este emitente.");
    }
    const { data: pfxFile, error: downloadError } = await supabase.storage
        .from('tenant-storage')
        .download(`${tenant.id}/certificados/${tenant.pfx_filename}`);

    if (downloadError || !pfxFile) {
        throw new Error("Falha ao baixar certificado digital: " + (downloadError?.message || 'Arquivo ausente'));
    }

    const pfxBuffer = Buffer.from(await pfxFile.arrayBuffer());
    const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
    const passphrase = decrypt(tenant.pfx_passphrase_encrypted, key);

    return gnreService.createHttpsAgent({ pfxBuffer, passphrase });
}

// ==========================================
// ROTAS DE PROCESSAMENTO DE GNRE (LOTE)
// ==========================================

router.post('/batch/process', requireAuth, requireActiveSubscription, upload.array('files'), async (req, res) => {
    const { source, paymentDate } = req.body;
    
    try {
        let filesData = [];

        if (source === 'local') {
            if (process.env.NODE_ENV === 'production') {
                return res.status(400).json({ error: "O modo de leitura local de arquivos em disco está desativado em ambiente de produção. Utilize o upload de arquivos." });
            }
            const pastaLocal = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'xml_nfe')
                : path.join(__dirname, '..', '..', 'xml_nfe');
            await fs.mkdir(pastaLocal, { recursive: true });
            const arquivos = await fs.readdir(pastaLocal);
            const xmlFiles = arquivos.filter(f => f.toLowerCase().endsWith('.xml'));

            if (xmlFiles.length === 0) {
                return res.status(400).json({ error: "Nenhum arquivo XML foi localizado na pasta local 'xml_nfe'." });
            }

            for (const file of xmlFiles) {
                const filePath = path.join(pastaLocal, file);
                const content = await fs.readFile(filePath, 'utf8');
                filesData.push({
                    filename: file,
                    content: content,
                    path: filePath
                });
            }
        } else {
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: "Nenhum arquivo XML foi enviado." });
            }

            filesData = req.files.map(file => ({
                filename: file.originalname,
                content: file.buffer.toString('utf8'),
                path: null
            }));
        }

        const isAdmin = req.profile && req.profile.is_admin;
        if (!isAdmin) {
            const planLimit = PLAN_LIMITS[req.tenant.subscription_status] || PLAN_LIMITS['ativo'];
            
            const inicioDoMes = new Date();
            inicioDoMes.setDate(1);
            inicioDoMes.setHours(0, 0, 0, 0);

            const { count, error: countError } = await supabase
                .from('guides')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', req.tenant.id)
                .gte('created_at', inicioDoMes.toISOString());

            if (countError) throw countError;

            const totalProjetado = (count || 0) + filesData.length;
            if (totalProjetado > planLimit) {
                return res.status(403).json({
                    error: `Limite de emissões do plano excedido. Seu plano atual (${req.tenant.subscription_status || 'ativo'}) permite até ${planLimit} guias/mês. Você já emitiu ${count || 0} guias este mês e esta operação com ${filesData.length} guias excederá o limite máximo de ${planLimit}. Por favor, faça um upgrade do seu plano no menu 'Planos' para continuar.`
                });
            }
        }

        const { data: batch, error: batchError } = await supabase
            .from('batches')
            .insert({
                tenant_id: req.tenant.id,
                environment: req.tenant.environment,
                status: 'aguardando_aprovacao',
                source: source || 'upload'
            })
            .select()
            .single();

        if (batchError || !batch) {
            throw new Error("Falha ao inicializar lote no banco de dados: " + batchError?.message);
        }

        stageBatchForApproval(batch.id, req.tenant, filesData, paymentDate, source || 'upload');

        return res.status(200).json({
            message: "Notas fiscais importadas com sucesso! Lote aguardando sua autorização para emissão.",
            batch_id: batch.id,
            status: 'aguardando_aprovacao'
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/batch/authorize-emission/:batchId', requireAuth, requireActiveSubscription, async (req, res) => {
    const { batchId } = req.params;
    const { paymentDate, ids } = req.body;
    const tenant = req.tenant;

    try {
        const { data: lockedBatch, error: lockErr } = await supabase
            .from('batches')
            .update({ status: 'processando' })
            .eq('id', batchId)
            .eq('tenant_id', tenant.id)
            .neq('status', 'processando')
            .select('id');

        if (lockErr || !lockedBatch || lockedBatch.length === 0) {
            return res.status(409).json({ error: "Este lote já está em transmissão na SEFAZ no momento. Aguarde a conclusão." });
        }

        transmitStagedBatchToSefaz(batchId, tenant, paymentDate, Array.isArray(ids) ? ids : null);

        return res.status(200).json({
            message: `Emissão na SEFAZ iniciada para a data de pagamento ${paymentDate || 'hoje'}!`,
            batch_id: batchId,
            paymentDate: paymentDate || new Date().toISOString().split('T')[0]
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/batch/discard/:batchId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), async (req, res) => {
    const { batchId } = req.params;
    const tenant = req.tenant;

    try {
        await supabase
            .from('guides')
            .delete()
            .eq('batch_id', batchId)
            .eq('tenant_id', tenant.id)
            .eq('status', 'aguardando_aprovacao');

        await supabase
            .from('batches')
            .update({ status: 'cancelado' })
            .eq('id', batchId)
            .eq('tenant_id', tenant.id);

        if (activeTasks[batchId]) {
            delete activeTasks[batchId];
        }

        return res.status(200).json({ message: "Lote descartado com sucesso." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/batch/authorize-payment/:batchId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), async (req, res) => {
    const { batchId } = req.params;
    const { banco, paymentDate } = req.body;
    const tenant = req.tenant;

    try {
        const { data: batch, error: bErr } = await supabase
            .from('batches')
            .select('*')
            .eq('id', batchId)
            .eq('tenant_id', tenant.id)
            .single();

        if (bErr || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        const { data: guias, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batchId)
            .eq('tenant_id', tenant.id);

        if (gErr || !guias || guias.length === 0) {
            return res.status(400).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const guiasValidas = guias.filter(g => g.barcode && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP');
        if (guiasValidas.length === 0) {
            return res.status(400).json({
                error: "Este lote não possui guias com código de barras numérico emitido para pagamento bancário."
            });
        }

        const dadosBancarios = {
            cnpj: tenant.cnpj,
            razaoSocial: tenant.razao_social,
            agencia: tenant.bank_agency,
            conta: tenant.bank_account,
            dac: tenant.bank_dac
        };

        const guiasParaCnab = guiasValidas.map(g => ({
            codigoBarras: g.barcode,
            valor: g.value,
            dataVencimento: paymentDate || g.created_at,
            documentoOrigem: g.nf_number,
            ufFavorecida: g.uf
        }));

        const bankChoice = (banco || 'itau').toLowerCase();
        let cnabContent = '';
        if (bankChoice === 'bradesco') {
            cnabContent = cnabService.gerarRemessaBradesco(dadosBancarios, guiasParaCnab, paymentDate);
        } else if (bankChoice === 'bb') {
            cnabContent = cnabService.gerarRemessaBB(dadosBancarios, guiasParaCnab, paymentDate);
        } else {
            cnabContent = cnabService.gerarRemessaSispag(dadosBancarios, guiasParaCnab, paymentDate);
        }

        const remessaFilename = `remessa_${batchId}.txt`;
        await supabase.storage
            .from('tenant-storage')
            .upload(`${tenant.id}/remessas/${remessaFilename}`, Buffer.from(cnabContent, 'utf-8'), {
                contentType: 'text/plain',
                upsert: true
            });

        const ids = guiasValidas.map(g => g.id);
        await supabase
            .from('guides')
            .update({
                status: 'pagamento_autorizado',
                paid_at: new Date().toISOString()
            })
            .in('id', ids).eq('tenant_id', tenant.id);

        return res.status(200).json({
            message: `Pagamento de ${guiasValidas.length} guia(s) autorizado com sucesso!`,
            downloadUrl: `/api/remessa/download/${batchId}?banco=${bankChoice}`,
            totalGuias: guiasValidas.length,
            valorTotal: guiasValidas.reduce((a, b) => a + parseFloat(b.value || 0), 0)
        });

    } catch (err) {
        console.error("Erro na autorização de pagamento:", err);
        return res.status(500).json({ error: "Falha ao autorizar pagamento: " + err.message });
    }
});

router.get('/asaas/balance', requireAuth, async (req, res) => {
    try {
        const tenant = req.tenant;
        const apiKey = getAsaasApiKey(tenant);
        const env = tenant.asaas_environment || (tenant.environment === 'producao' ? 'producao' : 'sandbox');

        const saldoInfo = await asaasService.obterSaldo(apiKey, apiKey ? env : 'simulado');
        return res.status(200).json({
            ...saldoInfo,
            environment: env,
            hasKey: !!apiKey
        });
    } catch (err) {
        console.error("[Asaas] Erro ao consultar saldo:", err.message);
        return res.status(500).json({ error: "Falha ao consultar saldo no Asaas: " + err.message });
    }
});

router.get('/batch/pending-payment', requireAuth, async (req, res) => {
    try {
        const tenant = req.tenant;
        const { data: batches } = await supabase
            .from('batches')
            .select('*')
            .eq('tenant_id', tenant.id)
            .neq('status', 'cancelado')
            .order('created_at', { ascending: false })
            .limit(10);

        if (!batches || batches.length === 0) {
            return res.status(200).json({ lote: null, totalGuias: 0, totalValor: 0, porTransportadora: {}, guias: [] });
        }

        for (const b of batches) {
            const { data: guias } = await supabase
                .from('guides')
                .select('*')
                .eq('batch_id', b.id)
                .eq('tenant_id', tenant.id);

            if (!guias || guias.length === 0) continue;

            const pendentes = guias.filter(g => {
                const hasLine = (g.line_digitizable && g.line_digitizable.length > 30) || (g.barcode && g.barcode.length > 30);
                const naoPaga = g.status !== 'paga' && g.status !== 'comprovada' && !g.asaas_bill_id;
                return hasLine && naoPaga;
            });

            if (pendentes.length > 0) {
                const totalValor = pendentes.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
                const porTransportadora = {};
                pendentes.forEach(g => {
                    const transp = g.carrier_name || 'OUTROS';
                    if (!porTransportadora[transp]) porTransportadora[transp] = { count: 0, valor: 0 };
                    porTransportadora[transp].count++;
                    porTransportadora[transp].valor += parseFloat(g.value || 0);
                });

                return res.status(200).json({
                    lote: b,
                    totalGuias: pendentes.length,
                    totalValor: totalValor,
                    porTransportadora,
                    guias: pendentes.map(g => ({
                        id: g.id,
                        nf_number: g.nf_number,
                        uf: g.uf,
                        value: g.value,
                        carrier_name: g.carrier_name,
                        customer_name: g.customer_name
                    }))
                });
            }
        }

        return res.status(200).json({ lote: null, totalGuias: 0, totalValor: 0, porTransportadora: {}, guias: [], mensagem: 'Tudo em dia! Nenhuma guia pendente de autorização.' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/batch/authorize-payment-asaas/:batchId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin']), requireActiveSubscription, async (req, res) => {
    const { batchId } = req.params;
    const tenant = req.tenant;
    const aprovador = req.profile?.name || req.user?.email || 'Responsável';

    try {
        const { data: batch, error: bErr } = await supabase
            .from('batches')
            .select('*')
            .eq('id', batchId)
            .eq('tenant_id', tenant.id)
            .single();

        if (bErr || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        const { data: guias, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batchId)
            .eq('tenant_id', tenant.id);

        if (gErr || !guias || guias.length === 0) {
            return res.status(400).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const isSimulado = (tenant.environment || '').toLowerCase() === 'simulado';

        if (isSimulado) {
            for (const g of guias) {
                const uf = (g.uf || '').toUpperCase();
                if (uf !== 'SP' && parseFloat(g.value || 0) > 0) {
                    if (!g.barcode || g.barcode.length < 44 || !g.line_digitizable) {
                        const auto = printService.gerarCodigoBarrasELinhaDigitavelGNRE(g, tenant);
                        if (auto.codigoBarras) {
                            g.barcode = auto.codigoBarras;
                            g.line_digitizable = auto.linhaDigitavel;
                            await supabase.from('guides').update({
                                barcode: auto.codigoBarras,
                                line_digitizable: auto.linhaDigitavel
                            }).eq('id', g.id).eq('tenant_id', tenant.id);
                        }
                    }
                }
            }
        }

        const statusBloqueados = new Set([
            'aguardando_aprovacao', 'rejeitada_sefaz', 'divergencia_uf_portal',
            'requer_dare_sp', 'pagamento_incerto', 'paga', 'comprovada', 'cancelada'
        ]);
        const guiasPendentes = guias.filter(g => {
            const cleanBar = String(g.barcode || '').replace(/\D/g, '');
            const cleanLine = String(g.line_digitizable || '').replace(/\D/g, '');
            const isSynthetic = !isSimulado && printService.isCodigoBarrasSinteticoLocal(cleanBar || cleanLine);
            const hasOfficialCode = !isSynthetic && (cleanBar.length >= 44 || cleanLine.length >= 44) && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP';
            const ufValida = g.uf && g.uf.toUpperCase() !== 'SP';
            const statusOk = !statusBloqueados.has((g.status || '').toLowerCase()) && !g.asaas_bill_id;
            return hasOfficialCode && ufValida && statusOk;
        });

        if (guiasPendentes.length === 0) {
            return res.status(400).json({
                error: "Nenhuma guia apta para pagamento bancário neste lote (verifique se o lote já foi transmitido e aceito pela SEFAZ com código de barras oficial)."
            });
        }

        const apiKey = getAsaasApiKey(tenant);
        if (!isSimulado && !apiKey) {
            return res.status(400).json({ error: "Chave de API do Asaas não configurada ou inválida para ambiente de Produção. Configure em Empresa > Integrações." });
        }
        const env = isSimulado ? 'simulado' : (tenant.asaas_environment || (apiKey ? 'sandbox' : 'simulado'));

        console.log(`[Asaas] Autorizando pagamento de ${guiasPendentes.length} guia(s) no lote ${batchId} por: ${aprovador}`);

        const resultados = [];
        const agora = new Date().toISOString();

        for (const g of guiasPendentes) {
            const linha = g.line_digitizable || g.barcode;
            const extRef = `guia_${g.id}`;

            const { data: claimed, error: claimErr } = await supabase
                .from('guides')
                .update({
                    status: 'pagamento_em_processamento',
                    payment_authorized_by: aprovador,
                    payment_authorized_at: agora
                })
                .eq('id', g.id)
                .eq('tenant_id', tenant.id)
                .is('asaas_bill_id', null)
                .neq('status', 'pagamento_em_processamento')
                .neq('status', 'pagamento_enviado')
                .neq('status', 'pagamento_incerto')
                .neq('status', 'comprovada')
                .neq('status', 'paga')
                .select('id');

            if (claimErr || !claimed || claimed.length === 0) {
                console.warn(`[Asaas] Guia NF ${g.nf_number} ignorada: já capturada ou liquidada concorrentemente.`);
                continue;
            }

            try {
                const billRes = await asaasService.pagarGuia({
                    identificationField: linha,
                    value: g.value,
                    description: `DIFAL NF ${g.nf_number} - ${g.uf}`,
                    externalReference: extRef,
                    dueDate: g.nf_issue_date || agora.split('T')[0]
                }, apiKey, env);

                const updatesGuia = {
                    asaas_bill_id: billRes.id,
                    payment_authorized_by: aprovador,
                    payment_authorized_at: agora,
                    status: 'pagamento_enviado'
                };

                if (isSimulado) {
                    const compPdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                        nfNumber: g.nf_number,
                        uf: g.uf,
                        valor: g.value,
                        billId: billRes.id,
                        razaoSocial: tenant.razao_social,
                        environment: 'simulado'
                    });

                    const remoteReceiptPath = `${tenant.id}/comprovantes/comprovante_simulado_NF_${g.nf_number}.pdf`;
                    await supabase.storage
                        .from('tenant-storage')
                        .upload(remoteReceiptPath, compPdfBuffer, {
                            contentType: 'application/pdf',
                            upsert: true
                        });

                    updatesGuia.status = 'comprovada';
                    updatesGuia.paid_at = agora;
                    updatesGuia.receipt_storage_path = remoteReceiptPath;
                    updatesGuia.bank_authentication = `SIMULADO-${g.id.substring(0, 8).toUpperCase()}`;
                }

                await supabase.from('guides').update(updatesGuia).eq('id', g.id).eq('tenant_id', tenant.id);
                resultados.push({ id: g.id, nf: g.nf_number, billId: billRes.id, sucesso: true });

            } catch (pErr) {
                console.error(`[Asaas] Erro ao pagar guia NF ${g.nf_number}:`, pErr.message);
                const isIncerto = pErr.isNetworkOrTimeout || (pErr.statusCode && pErr.statusCode >= 500);
                await supabase.from('guides').update({
                    status: isIncerto ? 'pagamento_incerto' : 'erro_pagamento'
                }).eq('id', g.id).eq('tenant_id', tenant.id);

                resultados.push({ id: g.id, nf: g.nf_number, erro: pErr.message, sucesso: false, incerto: isIncerto });
            }
        }

        await supabase
            .from('batches')
            .update({
                approved_by: aprovador,
                approved_at: agora,
                approval_status: 'aprovado'
            })
            .eq('id', batchId).eq('tenant_id', tenant.id);

        const totalSucesso = resultados.filter(r => r.sucesso).length;
        const totalFalha = resultados.filter(r => !r.sucesso).length;

        return res.status(200).json({
            message: `Pagamento autorizado com sucesso por ${aprovador}! ${totalSucesso} guia(s) processada(s).`,
            totalSucesso,
            totalFalha,
            detalhes: resultados
        });

    } catch (err) {
        console.error("[Asaas] Erro geral na autorização do lote:", err);
        return res.status(500).json({ error: "Falha na autorização do pagamento: " + err.message });
    }
});

router.post('/guide/authorize-payment-asaas/:guideId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin']), requireActiveSubscription, async (req, res) => {
    const { guideId } = req.params;
    const tenant = req.tenant;
    const aprovador = req.profile?.name || req.user?.email || 'Responsável';

    try {
        const { data: guia, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('id', guideId)
            .eq('tenant_id', tenant.id)
            .single();

        if (gErr || !guia) return res.status(404).json({ error: "Guia não encontrada." });

        const statusBloqueados = new Set([
            'aguardando_aprovacao', 'rejeitada_sefaz', 'divergencia_uf_portal',
            'requer_dare_sp', 'pagamento_incerto', 'paga', 'comprovada', 'cancelada'
        ]);
        if (statusBloqueados.has((guia.status || '').toLowerCase()) || guia.asaas_bill_id) {
            return res.status(400).json({
                error: `Esta guia não está apta para pagamento (status atual: '${guia.status}'). Verifique se ela já foi emitida e validada na SEFAZ.`
            });
        }

        const isSimulado = (tenant.environment || '').toLowerCase() === 'simulado';
        if (isSimulado && (!guia.barcode || guia.barcode.length < 44 || !guia.line_digitizable)) {
            const auto = printService.gerarCodigoBarrasELinhaDigitavelGNRE(guia, tenant);
            if (auto.codigoBarras) {
                guia.barcode = auto.codigoBarras;
                guia.line_digitizable = auto.linhaDigitavel;
                await supabase.from('guides').update({
                    barcode: auto.codigoBarras,
                    line_digitizable: auto.linhaDigitavel
                }).eq('id', guia.id).eq('tenant_id', tenant.id);
            }
        }

        const linha = String(guia.line_digitizable || guia.barcode || '').replace(/\D/g, '');
        if (!linha || linha.length < 44 || guia.barcode === 'IMPORTAR_NO_SEFAZ_SP' || (!isSimulado && printService.isCodigoBarrasSinteticoLocal(guia.barcode || linha))) {
            return res.status(400).json({ error: "Guia não possui código de barras oficial da SEFAZ (mínimo 44 dígitos) para pagamento." });
        }

        const apiKey = getAsaasApiKey(tenant);
        if (!isSimulado && !apiKey) {
            return res.status(400).json({ error: "Chave de API do Asaas não configurada ou inválida para ambiente de Produção. Configure em Empresa > Integrações." });
        }
        const env = isSimulado ? 'simulado' : (tenant.asaas_environment || (apiKey ? 'sandbox' : 'simulado'));
        const agora = new Date().toISOString();

        const { data: claimed, error: claimErr } = await supabase
            .from('guides')
            .update({
                status: 'pagamento_em_processamento',
                payment_authorized_by: aprovador,
                payment_authorized_at: agora
            })
            .eq('id', guia.id)
            .eq('tenant_id', tenant.id)
            .is('asaas_bill_id', null)
            .neq('status', 'pagamento_em_processamento')
            .neq('status', 'pagamento_enviado')
            .neq('status', 'pagamento_incerto')
            .neq('status', 'comprovada')
            .neq('status', 'paga')
            .select('id');

        if (claimErr || !claimed || claimed.length === 0) {
            return res.status(409).json({ error: "Esta guia já está em processamento de pagamento ou já foi liquidada por outro operador/sessão." });
        }

        const billRes = await asaasService.pagarGuia({
            identificationField: linha,
            value: guia.value,
            description: `DIFAL NF ${guia.nf_number} - ${guia.uf}`,
            externalReference: `guia_${guia.id}`,
            dueDate: guia.nf_issue_date || agora.split('T')[0]
        }, apiKey, env);

        const updatesGuia = {
            asaas_bill_id: billRes.id,
            payment_authorized_by: aprovador,
            payment_authorized_at: agora,
            status: 'pagamento_enviado'
        };

        if (isSimulado) {
            const compPdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                nfNumber: guia.nf_number,
                uf: guia.uf,
                valor: guia.value,
                billId: billRes.id,
                razaoSocial: tenant.razao_social,
                environment: 'simulado'
            });

            const remoteReceiptPath = `${tenant.id}/comprovantes/comprovante_simulado_NF_${guia.nf_number}.pdf`;
            await supabase.storage
                .from('tenant-storage')
                .upload(remoteReceiptPath, compPdfBuffer, {
                    contentType: 'application/pdf',
                    upsert: true
                });

            updatesGuia.status = 'comprovada';
            updatesGuia.paid_at = agora;
            updatesGuia.receipt_storage_path = remoteReceiptPath;
            updatesGuia.bank_authentication = `SIMULADO-${guia.id.substring(0, 8).toUpperCase()}`;
        }

        await supabase.from('guides').update(updatesGuia).eq('id', guia.id).eq('tenant_id', tenant.id);

        return res.status(200).json({
            message: `Pagamento da NF ${guia.nf_number} autorizado com sucesso!`,
            billId: billRes.id,
            status: updatesGuia.status
        });

    } catch (err) {
        console.error("[Asaas] Erro na autorização da guia:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/comprovante/:guideId', requireAuth, async (req, res) => {
    const { guideId } = req.params;
    const tenant = req.tenant;

    try {
        const { data: guia, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('id', guideId)
            .eq('tenant_id', tenant.id)
            .single();

        if (gErr || !guia) return res.status(404).json({ error: "Guia não encontrada." });

        const isSimulado = (tenant.environment || '').toLowerCase() === 'simulado';

        if (!guia.receipt_storage_path) {
            if (isSimulado && (guia.status === 'paga' || guia.status === 'comprovada')) {
                const compPdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                    nfNumber: guia.nf_number,
                    uf: guia.uf,
                    valor: guia.value,
                    billId: guia.asaas_bill_id || ('bill_sim_' + guia.id.substring(0, 8)),
                    razaoSocial: tenant.razao_social,
                    environment: 'simulado'
                });

                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="comprovante_simulado_NF_${guia.nf_number}.pdf"`);
                return res.send(compPdfBuffer);
            }
            return res.status(404).json({ error: "Esta guia ainda não possui comprovante bancário oficial liquidado." });
        }

        const { data: fileData, error: dlErr } = await supabase.storage
            .from('tenant-storage')
            .download(guia.receipt_storage_path);

        if (dlErr || !fileData) {
            return res.status(404).json({ error: "Arquivo de comprovante não encontrado no storage." });
        }

        const arrayBuffer = await fileData.arrayBuffer();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="comprovante_NF_${guia.nf_number}.pdf"`);
        return res.send(Buffer.from(arrayBuffer));

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/batch/status/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: batch, error } = await supabase
            .from('batches')
            .select('*, guides(*)')
            .eq('id', req.params.batchId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        const taskInfo = activeTasks[batch.id] || { logs: [], progress: batch.status === 'sucesso' ? 100 : 0 };
        const hasSpXml = req.tenant.environment === 'producao' && batch.guides && batch.guides.some(g => g.uf === 'SP');
        const remessaInfo = calcularResumoRemessaDeGuias(batch.guides || [], req.tenant, batch.id);
        delete remessaInfo.validItauGuides;

        return res.status(200).json({
            id: batch.id,
            status: batch.status,
            receipt: batch.receipt,
            error_message: batch.error_message,
            created_at: batch.created_at,
            progress: taskInfo.progress,
            logs: taskInfo.logs,
            guides: batch.guides,
            has_sp_xml: !!hasSpXml,
            remessa: remessaInfo
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/batch/download-xml/:batchId', requireAuth, async (req, res) => {
    const { batchId } = req.params;
    const { paymentDate, ids } = req.query;
    const tenant = req.tenant;

    try {
        const hoje = new Date().toISOString().split('T')[0];
        const dataEscolhida = (paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) ? paymentDate : hoje;
        const storagePath = `${tenant.id}/lotes_sp/lote_sp_${batchId}.xml`;

        let query = supabase.from('guides').select('*').eq('tenant_id', tenant.id).eq('uf', 'SP').order('nf_number', { ascending: true });
        if (ids) {
            const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
            if (idList.length > 0) query = query.in('id', idList);
        } else if (batchId && batchId !== 'todos') {
            query = query.eq('batch_id', batchId);
        }

        const { data: spGuidesRaw } = await query;
        const spGuides = (spGuidesRaw && !ids)
            ? (spGuidesRaw.filter(g => situacaoPagamentoGuia(g) !== 'paga').length > 0
                ? spGuidesRaw.filter(g => situacaoPagamentoGuia(g) !== 'paga')
                : spGuidesRaw)
            : (spGuidesRaw || []);

        if (spGuides && spGuides.length > 0) {
            const listaNotasSp = [];
            const idsAtualizadosSp = [];
            for (const g of spGuides) {
                let xmlText = null;
                if (g.xml_storage_path) {
                    try {
                        const { data: xData } = await supabase.storage.from('tenant-storage').download(g.xml_storage_path);
                        if (xData) xmlText = await xData.text();
                    } catch (e) {}
                }
                if (!xmlText && g.nf_number) {
                    try {
                        const { data: otherGuide } = await supabase
                            .from('guides')
                            .select('xml_storage_path')
                            .eq('tenant_id', tenant.id)
                            .eq('nf_number', g.nf_number)
                            .not('xml_storage_path', 'is', null)
                            .limit(1)
                            .single();
                        if (otherGuide && otherGuide.xml_storage_path) {
                            const { data: xData } = await supabase.storage.from('tenant-storage').download(otherGuide.xml_storage_path);
                            if (xData) xmlText = await xData.text();
                        }
                    } catch (e) {}
                }
                if (xmlText) {
                    const nota = parserService.extrairDadosNfeXML(xmlText);
                    nota.dataVencimento = dataEscolhida;
                    nota.dataPagamento = dataEscolhida;
                    listaNotasSp.push(nota);
                    if (situacaoPagamentoGuia(g) !== 'paga') idsAtualizadosSp.push(g.id);
                }
            }

            if (idsAtualizadosSp.length > 0) {
                const dataSpBr = dataEscolhida.split('-').reverse().join('/');
                await supabase
                    .from('guides')
                    .update({
                        barcode: 'IMPORTAR_NO_SEFAZ_SP',
                        line_digitizable: `Gerar em lote pelo arquivo XML de SP (Venc. ${dataSpBr})`,
                        status: 'requer_dare_sp'
                    })
                    .in('id', idsAtualizadosSp)
                    .eq('tenant_id', tenant.id)
                    .eq('barcode', 'IMPORTAR_NO_SEFAZ_SP');
            }

            if (listaNotasSp.length > 0) {
                const xmlSp = gnreService.gerarXmlLoteRaw(listaNotasSp, tenant);
                const xmlBuffer = Buffer.from(xmlSp, 'utf-8');
                await supabase.storage.from('tenant-storage').upload(storagePath, xmlBuffer, {
                    contentType: 'application/xml',
                    upsert: true
                });
                res.setHeader('Content-Type', 'application/xml');
                res.setHeader('Content-Disposition', `attachment; filename="lote_sp_gnre_${dataEscolhida}_${batchId.substring(0, 8)}.xml"`);
                return res.send(xmlBuffer);
            }
        }

        const { data: fileData, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(storagePath);

        if (downloadError || !fileData) {
            return res.status(404).json({ error: "Nenhuma nota de São Paulo localizada para gerar o XML em lote." });
        }

        const buffer = Buffer.from(await fileData.arrayBuffer());
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Content-Disposition', `attachment; filename="lote_sp_gnre_${batchId}.xml"`);
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/batch/query-receipt', requireAuth, async (req, res) => {
    const { receipt, uf, paymentDate } = req.body;
    if (!receipt || !uf) {
        return res.status(400).json({ error: "Número do recibo e UF são obrigatórios." });
    }

    const tenant = req.tenant;

    try {
        if (!tenant.pfx_filename) {
            return res.status(400).json({ error: "Nenhum certificado digital PFX configurado para esta empresa." });
        }

        const passphraseKey = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const passphrase = decrypt(tenant.pfx_passphrase_encrypted, passphraseKey);

        const { data: fileData, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(`${tenant.id}/certificados/${tenant.pfx_filename}`);

        if (downloadError || !fileData) {
            return res.status(400).json({ error: "Erro ao carregar arquivo de certificado do Storage: " + downloadError?.message });
        }

        const pfxBuffer = Buffer.from(await fileData.arrayBuffer());
        const agent = gnreService.createHttpsAgent({ pfxBuffer, passphrase });

        const logsDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
            ? path.join('/tmp', 'xml_logs')
            : path.join(__dirname, '..', '..', 'xml_logs');

        const xmlConsulta = await gnreService.consultarLote(receipt, agent, uf, tenant.environment, logsDir);

        const sitProcess = parserService.extrairTag(xmlConsulta, 'situacaoProcess');
        const codSit = sitProcess ? parserService.extrairTag(sitProcess, 'codigo') : null;
        const descSit = sitProcess ? parserService.extrairTag(sitProcess, 'descricao') : '';

        const processando = !codSit || ['401', '103', '105'].includes(codSit) || (descSit.toLowerCase().includes('processamento') && !['402', '403', '404'].includes(codSit));

        if (processando) {
            return res.status(202).json({ 
                status: 'processando',
                message: `O lote ainda está sendo processado pelo governo do ${uf}. Tente novamente em alguns instantes.` 
            });
        }

        let dadosGuias = null;
        try {
            dadosGuias = parserService.extrairDadosGuiaXML(xmlConsulta);
        } catch (parseErr) {
            return res.status(400).json({ 
                error: `O lote foi processado, mas nenhuma guia válida foi retornada. Detalhes: ${parseErr.message}. Status: ${codSit} - ${descSit}` 
            });
        }

        if (!dadosGuias || dadosGuias.length === 0) {
            return res.status(400).json({ 
                error: `O lote foi processado, mas nenhuma guia válida foi retornada. Status: ${codSit} - ${descSit}` 
            });
        }

        const { data: existingBatch } = await supabase
            .from('batches')
            .select('*')
            .eq('tenant_id', tenant.id)
            .ilike('receipt', `%${receipt}%`)
            .limit(1);

        let batchId;
        if (existingBatch && existingBatch.length > 0) {
            batchId = existingBatch[0].id;
            await supabase
                .from('batches')
                .update({ status: 'sucesso', receipt: `${uf}:${receipt}` })
                .eq('id', batchId).eq('tenant_id', tenant.id);
        } else {
            const { data: newBatch } = await supabase
                .from('batches')
                .insert({
                    tenant_id: tenant.id,
                    environment: tenant.environment,
                    status: 'sucesso',
                    receipt: `${uf}:${receipt}`
                })
                .select()
                .single();
            batchId = newBatch.id;
        }

        const dadosBancarios = {
            cnpj: tenant.cnpj,
            razaoSocial: tenant.razao_social,
            agencia: tenant.bank_agency,
            conta: tenant.bank_account,
            dac: tenant.bank_dac
        };

        const guiasDb = [];
        for (const guia of dadosGuias) {
            if (!guia.recibo) guia.recibo = receipt;
            const htmlGuia = gnreService.exportarGuiaHtml(dadosBancarios, guia, {
                cnpjEmitente: tenant.cnpj,
                razaoSocialEmitente: tenant.razao_social
            });

            const nomeLocal = `guia_NF_${guia.documentoOrigem || 'rec_importada'}.html`;
            const remotePath = `${tenant.id}/guias/${nomeLocal}`;

            await supabase.storage
                .from('tenant-storage')
                .upload(remotePath, Buffer.from(htmlGuia, 'utf-8'), {
                    contentType: 'text/html',
                    upsert: true
                });

            guiasDb.push({
                tenant_id: tenant.id,
                batch_id: batchId,
                nf_number: guia.documentoOrigem || 'N/A',
                uf: guia.ufFavorecida || uf,
                value: guia.valor,
                barcode: guia.codigoBarras,
                line_digitizable: guia.linhaDigitavel,
                storage_path: remotePath
            });
        }

        if (existingBatch && existingBatch.length > 0) {
            await supabase
                .from('guides')
                .delete()
                .eq('batch_id', batchId).eq('tenant_id', tenant.id);
        }

        const { error: insertError } = await supabase
            .from('guides')
            .insert(guiasDb);

        if (insertError) throw insertError;

        const { data: allGuides } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batchId).eq('tenant_id', tenant.id);

        if (allGuides && allGuides.length > 0) {
            const mappedGuides = allGuides.map(g => {
                const originalGuia = dadosGuias.find(dg => dg.codigoBarras === g.barcode);
                return {
                    codigoBarras: g.barcode,
                    valor: g.value,
                    dataVencimento: originalGuia ? originalGuia.dataVencimento : (g.created_at ? g.created_at.split('T')[0] : new Date().toISOString().split('T')[0]),
                    documentoOrigem: g.nf_number,
                    ufFavorecida: g.uf
                };
            });

            try {
                const cnabContent = cnabService.gerarRemessaSispag(dadosBancarios, mappedGuides, paymentDate);
                const remessaFilename = `remessa_${batchId}.txt`;
                await supabase.storage
                    .from('tenant-storage')
                    .upload(`${tenant.id}/remessas/${remessaFilename}`, Buffer.from(cnabContent, 'utf-8'), {
                        contentType: 'text/plain',
                        upsert: true
                    });
            } catch (cnabErr) {
                console.error("Erro ao regenerar arquivo CNAB:", cnabErr.message);
            }
        }

        return res.status(200).json({
            status: 'sucesso',
            message: `Lote consultado com sucesso! ${dadosGuias.length} guia(s) importada(s).`,
            batch_id: batchId
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/batch/history', requireAuth, async (req, res) => {
    try {
        const { data: batches, error } = await supabase
            .from('batches')
            .select('id, created_at, status, environment, file_count, source, error_message')
            .eq('tenant_id', req.tenant.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;
        return res.status(200).json(batches);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTAS DE GUIAS INDIVIDUAIS E IMPRESSÃO
// ==========================================

router.post('/guide/marcar-paga', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), async (req, res) => {
    try {
        const { ids, paga, paidAt } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: "Nenhuma guia informada." });
        }
        const marcar = paga !== false;
        const dataPg = (paidAt && /^\d{4}-\d{2}-\d{2}$/.test(paidAt)) ? paidAt : new Date().toISOString().split('T')[0];

        const update = marcar
            ? { status: 'paga', paid_at: dataPg }
            : { status: 'aguardando_pagamento', paid_at: null, bank_authentication: null };

        const { data, error } = await supabase
            .from('guides')
            .update(update)
            .in('id', ids)
            .eq('tenant_id', req.tenant.id)
            .select('id, nf_number');
        if (error) throw error;

        const syncRem = await sincronizarRemessaAutomaticaLote('todos', req.tenant).catch(() => null);
        const remessaPayload = syncRem ? { ...syncRem, cnabText: undefined } : null;
        broadcastDockEvent({
            type: 'LOTE_ATUALIZADO',
            remessa: remessaPayload,
            timestamp: new Date().toISOString()
        }, req.tenant.id);

        return res.json({
            success: true,
            atualizadas: (data || []).length,
            remessa: remessaPayload,
            message: marcar
                ? `${(data || []).length} guia(s) conciliada(s) como PAGA(S).`
                : `${(data || []).length} guia(s) revertida(s) para aguardando pagamento.`
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.post('/guide/emitir-sefaz/:guideId', requireAuth, requireActiveSubscription, async (req, res) => {
    const { guideId } = req.params;
    const { paymentDate } = req.body;
    const tenant = req.tenant;

    try {
        const { data: guide, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('id', guideId)
            .eq('tenant_id', tenant.id)
            .single();

        if (gErr || !guide) {
            return res.status(404).json({ error: "Guia não localizada no sistema." });
        }

        const st = (guide.status || '').toLowerCase();
        if (st === 'paga' || guide.paid_at) {
            return res.status(400).json({
                error: "Esta guia já consta como PAGA e liquidada no sistema. A reemissão está bloqueada para evitar duplicidade de pagamento."
            });
        }

        const hoje = new Date().toISOString().split('T')[0];
        const dataAlvo = paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate) ? paymentDate : hoje;

        let xmlContent = null;
        if (guide.xml_storage_path) {
            try {
                const { data: xData } = await supabase.storage
                    .from('tenant-storage')
                    .download(guide.xml_storage_path);
                if (xData) xmlContent = await xData.text();
            } catch (e) {}
        }

        if (!xmlContent && guide.nf_number) {
            const { data: otherGuide } = await supabase
                .from('guides')
                .select('xml_storage_path')
                .eq('tenant_id', tenant.id)
                .eq('nf_number', guide.nf_number)
                .not('xml_storage_path', 'is', null)
                .limit(1)
                .single();
            if (otherGuide && otherGuide.xml_storage_path) {
                try {
                    const { data: xData } = await supabase.storage
                        .from('tenant-storage')
                        .download(otherGuide.xml_storage_path);
                    if (xData) xmlContent = await xData.text();
                } catch (e) {}
            }
        }

        if (!xmlContent) {
            return res.status(400).json({
                error: `Arquivo XML da NF-e ${guide.nf_number} não encontrado para transmissão à SEFAZ.`
            });
        }

        const dadosNfe = parserService.extrairDadosNfeXML(xmlContent);
        dadosNfe.guide_id = guide.id;
        dadosNfe.dataVencimento = dataAlvo;
        dadosNfe.dataPagamento = dataAlvo;

        const uf = (guide.uf || dadosNfe.ufFavorecida || '').toUpperCase().trim();

        if (uf === 'SP') {
            const dataSpBr = dataAlvo.split('-').reverse().join('/');
            await supabase
                .from('guides')
                .update({
                    barcode: 'IMPORTAR_NO_SEFAZ_SP',
                    line_digitizable: `Gerar em lote pelo arquivo XML de SP (Venc. ${dataSpBr})`,
                    status: 'requer_dare_sp'
                })
                .eq('id', guide.id)
                .eq('tenant_id', tenant.id);

            return res.status(200).json({
                success: true,
                uf: 'SP',
                isSpDare: true,
                message: `Guia de SP configurada com vencimento para ${dataAlvo}. Baixe o XML do lote SP para gerar a DARE no Portal da SEFAZ-SP.`,
                dueDate: dataAlvo
            });
        }

        if (uf === 'ES') {
            let agent = null;
            if (tenant.environment === 'producao') {
                agent = await getTenantHttpsAgent(tenant);
            }
            const { nDua, nBar } = await duaEsService.transmitirEmissao(dadosNfe, agent, tenant.environment);
            const pdfBuffer = await duaEsService.transmitirObterPdf(nDua, dadosNfe.destCnpjCpf, agent, tenant.environment);
            const remotePath = `${tenant.id}/guias/guia_NF_${dadosNfe.documentoOrigem}.pdf`;
            await supabase.storage
                .from('tenant-storage')
                .upload(remotePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

            await supabase
                .from('guides')
                .update({
                    barcode: nBar,
                    line_digitizable: nBar,
                    status: 'aguardando_pagamento',
                    storage_path: remotePath
                })
                .eq('id', guide.id)
                .eq('tenant_id', tenant.id);

            const syncRemEs = await sincronizarRemessaAutomaticaLote(guide.batch_id || 'todos', tenant, dataAlvo).catch(() => null);
            const remessaEsPayload = syncRemEs ? { ...syncRemEs, cnabText: undefined } : null;
            broadcastDockEvent({
                type: 'LOTE_ATUALIZADO',
                batchId: guide.batch_id,
                remessa: remessaEsPayload,
                timestamp: new Date().toISOString()
            }, tenant.id);

            return res.status(200).json({
                success: true,
                uf: 'ES',
                barcode: nBar,
                lineDigitizable: nBar,
                dueDate: dataAlvo,
                remessa: remessaEsPayload,
                message: `Guia DUA-ES emitida com sucesso na SEFAZ!`,
                downloadUrl: `/api/guide/download/${guide.id}`
            });
        }

        const logsDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
            ? path.join('/tmp', 'xml_logs')
            : path.join(__dirname, '..', '..', 'xml_logs');
        await fs.mkdir(logsDir, { recursive: true });

        let agent = null;
        if (tenant.environment === 'producao') {
            agent = await getTenantHttpsAgent(tenant);
        }

        const recibo = await gnreService.enviarLote([dadosNfe], agent, uf, tenant.environment, tenant, logsDir);

        let dadosGuias = null;
        let tentativas = 0;
        const maxTentativas = ['RJ', 'SE'].includes(uf) ? 35 : 20;

        while (tentativas < maxTentativas) {
            const seg = tentativas === 0 ? 5 : 3;
            await new Promise(r => setTimeout(r, seg * 1000));
            const xmlConsulta = await gnreService.consultarLote(recibo, agent, uf, tenant.environment, logsDir);
            const sitProcess = parserService.extrairTag(xmlConsulta, 'situacaoProcess');
            const codSit = sitProcess ? parserService.extrairTag(sitProcess, 'codigo') : null;
            const descSit = sitProcess ? parserService.extrairTag(sitProcess, 'descricao') : '';
            const processando = !codSit || ['401', '103', '105'].includes(codSit) || (descSit.toLowerCase().includes('processamento') && !['402', '403', '404'].includes(codSit));
            if (!processando) {
                dadosGuias = parserService.extrairDadosGuiaXML(xmlConsulta);
                break;
            }
            tentativas++;
        }

        if (!dadosGuias) {
            throw new Error(`Tempo esgotado aguardando retorno da SEFAZ ${uf}. Recibo gerado: ${recibo}.`);
        }

        if (Array.isArray(dadosGuias.rejeicoesDetalhadas) && dadosGuias.rejeicoesDetalhadas.length > 0) {
            const rej = dadosGuias.rejeicoesDetalhadas[0];
            const barExistente = String(guide.barcode || '').replace(/\D/g, '');
            const jaTinhaGuiaValida = barExistente.length >= 44 && guide.barcode !== 'IMPORTAR_NO_SEFAZ_SP' && !printService.isCodigoBarrasSinteticoLocal(barExistente);
            if (!jaTinhaGuiaValida) {
                await supabase
                    .from('guides')
                    .update({ status: 'rejeitada_sefaz' })
                    .eq('id', guide.id)
                    .eq('tenant_id', tenant.id);
            }

            return res.status(400).json({
                error: `Guia rejeitada pela SEFAZ ${uf}: ${rej.motivo || 'Rejeição cadastral/fiscal.'}`
            });
        }

        const guiaEmitida = Array.isArray(dadosGuias) ? dadosGuias[0] : dadosGuias;
        if (!guiaEmitida || !guiaEmitida.codigoBarras) {
            throw new Error(`A SEFAZ ${uf} não retornou código de barras numérico válido para a NF ${guide.nf_number}.`);
        }

        const dadosBancarios = {
            cnpj: tenant.cnpj,
            razaoSocial: tenant.razao_social,
            agencia: tenant.bank_agency,
            conta: tenant.bank_account,
            dac: tenant.bank_dac
        };

        if (!guiaEmitida.recibo) guiaEmitida.recibo = recibo;
        const htmlGuia = gnreService.exportarGuiaHtml(dadosBancarios, guiaEmitida, dadosNfe);
        const remotePath = `${tenant.id}/guias/guia_NF_${guide.nf_number}.html`;
        await supabase.storage
            .from('tenant-storage')
            .upload(remotePath, Buffer.from(htmlGuia, 'utf-8'), {
                contentType: 'text/html',
                upsert: true
            });

        const { error: errUpIndiv } = await supabase
            .from('guides')
            .update({
                barcode: guiaEmitida.codigoBarras,
                line_digitizable: guiaEmitida.linhaDigitavel || guiaEmitida.codigoBarras,
                status: 'aguardando_pagamento',
                storage_path: remotePath
            })
            .eq('id', guide.id)
            .eq('tenant_id', tenant.id);
        if (errUpIndiv) {
            throw new Error(`Falha ao gravar guia emitida no banco: ${errUpIndiv.message}`);
        }

        const syncRemGnre = await sincronizarRemessaAutomaticaLote(guide.batch_id || 'todos', tenant, dataAlvo).catch(() => null);
        const remessaGnrePayload = syncRemGnre ? { ...syncRemGnre, cnabText: undefined } : null;
        broadcastDockEvent({
            type: 'LOTE_ATUALIZADO',
            batchId: guide.batch_id,
            remessa: remessaGnrePayload,
            timestamp: new Date().toISOString()
        }, tenant.id);

        return res.status(200).json({
            success: true,
            uf,
            barcode: guiaEmitida.codigoBarras,
            lineDigitizable: guiaEmitida.linhaDigitavel || guiaEmitida.codigoBarras,
            dueDate: dataAlvo,
            remessa: remessaGnrePayload,
            message: `Guia oficial autorizada e emitida com sucesso na SEFAZ ${uf}!`,
            downloadUrl: `/api/guide/download/${guide.id}`
        });

    } catch (err) {
        console.error(`Erro na emissão individual SEFAZ (Guia ${guideId}):`, err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/download/:guideId', requireAuth, async (req, res) => {
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

        const barLimpo = String(guide.barcode || '').replace(/\D/g, '');
        const isSimulado = (req.tenant.environment || '').toLowerCase() === 'simulado';

        if (!isSimulado && (barLimpo.length < 44 || guide.barcode === 'IMPORTAR_NO_SEFAZ_SP')) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="utf-8">
                    <title>Guia Pendente de Emissão SEFAZ</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0E1626; color: #E2E8F0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                        .card { background: #111B2E; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; max-width: 520px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
                        h2 { color: #FBBF24; margin-top: 0; font-size: 20px; }
                        p { font-size: 14px; color: #94A3B8; line-height: 1.6; }
                        .pill { display: inline-block; background: rgba(59,130,246,0.15); color: #60A5FA; border: 1px solid rgba(59,130,246,0.3); border-radius: 8px; padding: 6px 14px; font-weight: 700; font-size: 13px; margin: 12px 0; }
                        button { background: #2563EB; color: white; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 16px; }
                        button:hover { background: #1D4ED8; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <div style="font-size: 40px; margin-bottom: 12px;">⚡</div>
                        <h2>Guia Oficial Ainda Não Emitida</h2>
                        <div class="pill">NF ${guide.nf_number} · ${guide.uf} · R$ ${(guide.value || 0).toFixed(2).replace('.', ',')}</div>
                        <p>Esta nota ainda não possui código de barras oficial retornado pela Secretaria da Fazenda.</p>
                        <p>Para gerar o documento oficial apto para pagamento, retorne ao painel e utilize o botão <strong>"⚡ Emitir SEFAZ"</strong> informando a data de vencimento desejada.</p>
                        <button onclick="window.close()">Fechar Janela</button>
                    </div>
                </body>
                </html>
            `);
        }

        if (req.query.paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(req.query.paymentDate)) {
            guide.due_date = req.query.paymentDate;
        }

        await printService.enriquecerReciboGuias([guide], req.tenant.id, supabase);
        if (guide.storage_path && guide.storage_path.toLowerCase().endsWith('.html')) {
            try {
                const { data: hData } = await supabase.storage
                    .from('tenant-storage')
                    .download(guide.storage_path);
                if (hData) {
                    const rawHtml = await hData.text();
                    const htmlText = gnreService.atualizarCabecalhoGuiaHtmlLegada(rawHtml, guide.batch_receipt || '');
                    if (htmlText !== rawHtml) {
                        supabase.storage.from('tenant-storage').upload(guide.storage_path, Buffer.from(htmlText, 'utf-8'), { contentType: 'text/html', upsert: true }).catch(() => {});
                    }
                    res.setHeader('Content-Type', 'text/html; charset=utf-8');
                    return res.send(htmlText);
                }
            } catch (e) {}
        }

        let buffer = null;
        if (!req.query.paymentDate && guide.storage_path && guide.storage_path.toLowerCase().endsWith('.pdf')) {
            try {
                const { data } = await supabase.storage
                    .from('tenant-storage')
                    .download(guide.storage_path);
                if (data) buffer = Buffer.from(await data.arrayBuffer());
            } catch (e) {}
        }

        if (!buffer) {
            buffer = await printService.gerarGnrePdfBuffer(req.tenant, guide);
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="GNRE_NF_${guide.nf_number}.pdf"`);
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/gnre-selecionadas', requireAuth, async (req, res) => {
    try {
        const { ids, nfs, batchId, paymentDate } = req.query;
        let query = supabase.from('guides').select('*').eq('tenant_id', req.tenant.id);

        if (ids) {
            const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('id', idList);
        } else if (nfs) {
            const nfList = nfs.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('nf_number', nfList);
        } else if (batchId) {
            query = query.eq('batch_id', batchId);
        } else {
            return res.status(400).json({ error: "Nenhum ID ou número de NF informado." });
        }

        const { data: guias, error } = await query;
        if (error || !guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para os filtros fornecidos." });
        }

        let guiasComGnre = guias
            .filter(g => g.uf && g.uf !== 'ND' && parseFloat(g.value || 0) > 0 && (g.uf !== 'SP' || (g.barcode && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP' && g.storage_path)))
            .sort((a, b) => Number(a.nf_number || 0) - Number(b.nf_number || 0));
        if (guiasComGnre.length === 0) {
            return res.status(400).json({ error: "As notas selecionadas são para SP (Recolhimento via DARE-SP, sem GNRE)." });
        }

        const isSimulado = (req.tenant.environment || '').toLowerCase() === 'simulado';
        const pdfBuffers = [];
        if (!isSimulado) {
            guiasComGnre = guiasComGnre.filter(g => {
                const barClean = String(g.barcode || '').replace(/\D/g, '');
                return barClean.length >= 44 && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP';
            });
            if (guiasComGnre.length === 0) {
                return res.status(400).json({ error: "Nenhuma das guias selecionadas possui código de barras oficial SEFAZ. Emita as guias primeiro para poder imprimi-las." });
            }
        }
        await printService.enriquecerReciboGuias(guiasComGnre, req.tenant.id, supabase);
        for (const g of guiasComGnre) {
            if (paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
                g.due_date = paymentDate;
            }
            if (isSimulado && (!g.barcode || g.barcode.length < 44 || !g.line_digitizable)) {
                const auto = printService.gerarCodigoBarrasELinhaDigitavelGNRE(g, req.tenant);
                if (auto.codigoBarras) {
                    g.barcode = auto.codigoBarras;
                    g.line_digitizable = auto.linhaDigitavel;
                }
            }
            let buf = null;
            if (!paymentDate && g.storage_path && g.storage_path.toLowerCase().endsWith('.pdf')) {
                try {
                    const { data } = await supabase.storage.from('tenant-storage').download(g.storage_path);
                    if (data) buf = Buffer.from(await data.arrayBuffer());
                } catch (e) {}
            }
            if (!buf) {
                buf = await printService.gerarGnrePdfBuffer(req.tenant, g);
            }
            if (buf) pdfBuffers.push(buf);
        }

        const mergedBuffer = await danfeService.mesclarDanfesPdf(pdfBuffers);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="GUIAS_GNRE_SELECIONADAS_${guiasComGnre.length}_NOTAS.pdf"`);
        return res.send(mergedBuffer);
    } catch (err) {
        console.error("Erro ao gerar GNREs selecionadas:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/danfe/:guideId', requireAuth, async (req, res) => {
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

        const buffer = await danfeService.obterOuGerarDanfePdfGuia(supabase, req.tenant.id, guide);
        if (!buffer) {
            return res.status(404).json({ error: "DANFE não encontrado para esta nota fiscal." });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="DANFE_NF_${guide.nf_number}.pdf"`);
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/danfe-selecionadas', requireAuth, async (req, res) => {
    try {
        const { ids, nfs, batchId } = req.query;
        let query = supabase.from('guides').select('*').eq('tenant_id', req.tenant.id);

        if (ids) {
            const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('id', idList);
        } else if (nfs) {
            const nfList = nfs.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('nf_number', nfList);
        } else if (batchId) {
            query = query.eq('batch_id', batchId);
        } else {
            return res.status(400).json({ error: "Nenhum ID ou número de NF informado." });
        }

        const { data: guias, error } = await query.order('nf_number', { ascending: true });
        if (error || !guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para os filtros fornecidos." });
        }

        const pdfBuffers = [];
        const chunkSize = 15;
        for (let i = 0; i < guias.length; i += chunkSize) {
            const chunk = guias.slice(i, i + chunkSize);
            const results = await Promise.all(
                chunk.map(g => danfeService.obterOuGerarDanfePdfGuia(supabase, req.tenant.id, g))
            );
            for (const buf of results) {
                if (buf) pdfBuffers.push(buf);
            }
        }

        if (pdfBuffers.length === 0) {
            return res.status(404).json({ error: "Não foi possível carregar os DANFEs das notas selecionadas." });
        }

        const mergedBuffer = await danfeService.mesclarDanfesPdf(pdfBuffers);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="DANFES_SELECIONADAS_${pdfBuffers.length}_NOTAS.pdf"`);
        return res.send(mergedBuffer);
    } catch (err) {
        console.error("Erro ao gerar DANFEs selecionadas:", err);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/nfe-xml/:guideId', requireAuth, async (req, res) => {
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

        const xmlPath = guide.xml_storage_path || `${req.tenant.id}/nfe_xml/nfe_${guide.nf_number}.xml`;

        const { data, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(xmlPath);

        if (downloadError || !data) {
            return res.status(404).json({ error: "XML da NF-e não encontrado para esta nota fiscal." });
        }

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="NFe_${guide.nf_number}.xml"`);
        const buffer = Buffer.from(await data.arrayBuffer());
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/download-all/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: guides, error } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', req.params.batchId)
            .eq('tenant_id', req.tenant.id);

        if (error || !guides || guides.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const zip = new AdmZip();

        await printService.enriquecerReciboGuias(guides, req.tenant.id, supabase);
        await Promise.all(guides.map(async (guide) => {
            const folder = `NF_${guide.nf_number}`;

            if (guide.storage_path && guide.barcode !== 'IMPORTAR_NO_SEFAZ_SP') {
                try {
                    const { data, error: downloadError } = await supabase.storage
                        .from('tenant-storage')
                        .download(guide.storage_path);

                    if (!downloadError && data) {
                        const buffer = Buffer.from(await data.arrayBuffer());
                        const isPdf = guide.storage_path.toLowerCase().endsWith('.pdf');
                        const ext = isPdf ? 'pdf' : 'html';
                        const finalBuf = isPdf ? buffer : Buffer.from(gnreService.atualizarCabecalhoGuiaHtmlLegada(buffer.toString('utf-8'), guide.batch_receipt || ''), 'utf-8');
                        zip.addFile(`${folder}/guia_GNRE_${guide.uf}.${ext}`, finalBuf);
                    }
                } catch (err) {
                    console.error(`Erro ao incluir guia ${guide.nf_number} no zip:`, err.message);
                }
            }

            const danfePath = guide.danfe_storage_path || `${req.tenant.id}/danfe/danfe_NF_${guide.nf_number}.pdf`;
            try {
                const { data: danfeData, error: danfeErr } = await supabase.storage
                    .from('tenant-storage')
                    .download(danfePath);

                if (!danfeErr && danfeData) {
                    const danfeBuffer = Buffer.from(await danfeData.arrayBuffer());
                    zip.addFile(`${folder}/DANFE_NF_${guide.nf_number}.pdf`, danfeBuffer);
                }
            } catch (err) {}

            const xmlPath = guide.xml_storage_path || `${req.tenant.id}/nfe_xml/nfe_${guide.nf_number}.xml`;
            try {
                const { data: xmlData, error: xmlErr } = await supabase.storage
                    .from('tenant-storage')
                    .download(xmlPath);

                if (!xmlErr && xmlData) {
                    const xmlBuffer = Buffer.from(await xmlData.arrayBuffer());
                    zip.addFile(`${folder}/NFe_${guide.nf_number}.xml`, xmlBuffer);
                }
            } catch (err) {}
        }));

        const zipBuffer = zip.toBuffer();

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="pacote_completo_lote_${req.params.batchId}.zip"`);
        return res.send(zipBuffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/guide/print-interleaved/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: guides, error } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', req.params.batchId)
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: false });

        if (error || !guides || guides.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const pdfBuffer = await printService.gerarLoteIntercaladoPdf(req.tenant, guides, supabase);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Lote_Impressao_NF_e_GNRE_${req.params.batchId}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar PDF intercalado:", err.message);
        return res.status(500).json({ error: "Erro ao gerar PDF intercalado: " + err.message });
    }
});

module.exports = router;
