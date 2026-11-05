// src/routes/webhooks.routes.js
// Webhooks de Integração Externa (Asaas: Liquidação de Guias e Assinaturas SaaS)

const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { safeCompareTokens } = require('../utils/crypto');
const { broadcastDockEvent } = require('../utils/events');
const { PLAN_LIMITS } = require('../config/constants');
const asaasService = require('../../services/asaas_service');
const auditService = require('../../services/audit_service');

async function validarTokenAsaasTenant(receivedToken, targetTenantId = null, billPayload = null) {
    if (!receivedToken) return { valid: false, tenant: null };
    const globalToken = process.env.ASAAS_WEBHOOK_TOKEN;

    // 1. Se especificado tenantId direto na rota/query
    if (targetTenantId) {
        const { data: tenant } = await supabase.from('tenants').select('*').eq('id', targetTenantId).maybeSingle();
        if (tenant) {
            const tenantToken = tenant.asaas_webhook_token || tenant.settings?.asaas_webhook_token || globalToken;
            if (tenantToken && safeCompareTokens(receivedToken, tenantToken)) {
                return { valid: true, tenant };
            }
        }
    }

    // 2. Se bate com o token global da plataforma
    if (globalToken && safeCompareTokens(receivedToken, globalToken)) {
        return { valid: true, tenant: null };
    }

    // 3. Resolução dinâmica pelo objeto da cobrança/guia
    if (billPayload) {
        const billId = billPayload.id;
        const extRef = billPayload.externalReference;
        let tenantIdFromGuide = null;
        if (extRef) {
            const guideId = extRef.startsWith('guia_') ? extRef.replace('guia_', '') : extRef;
            const { data: g } = await supabase.from('guides').select('tenant_id').eq('id', guideId).maybeSingle();
            if (g) tenantIdFromGuide = g.tenant_id;
        }
        if (!tenantIdFromGuide && billId) {
            const { data: g } = await supabase.from('guides').select('tenant_id').eq('asaas_bill_id', billId).maybeSingle();
            if (g) tenantIdFromGuide = g.tenant_id;
        }
        if (tenantIdFromGuide) {
            const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantIdFromGuide).maybeSingle();
            if (tenant) {
                const tenantToken = tenant.asaas_webhook_token || tenant.settings?.asaas_webhook_token;
                if (tenantToken && safeCompareTokens(receivedToken, tenantToken)) {
                    return { valid: true, tenant };
                }
            }
        }
    }

    return { valid: false, tenant: null };
}

// Manipulador do Webhook do Asaas (montado em /api/webhooks)
const handleAsaasWebhook = async (req, res) => {
    try {
        const receivedToken = req.headers['asaas-access-token'];
        const targetTenantId = req.params?.tenantId || req.query?.tenantId || null;
        const bill = req.body?.bill || req.body?.payment;

        const authResult = await validarTokenAsaasTenant(receivedToken, targetTenantId, bill);
        if (!authResult.valid) {
            console.warn("[Webhook Asaas] Acesso rejeitado: token ausente, incorreto ou tenant divergente.");
            return res.status(401).json({ error: "Token de webhook não autorizado." });
        }

        const event = req.body?.event;
        console.log(`[Webhook Asaas] Recebido evento: ${event} para ID: ${bill?.id}`);

        if (!event || !bill) {
            return res.status(200).json({ received: true });
        }

        // ==========================================================
        // CASO 1: GUIA/TRIBUTO QUITADO (BILL_PAID)
        // ==========================================================
        if (event === 'BILL_PAID') {
            const billId = bill.id;
            const extRef = bill.externalReference;
            const receiptUrl = bill.transactionReceiptUrl;
            const identField = bill.identificationField ? String(bill.identificationField).replace(/[^0-9]/g, '') : null;

            let guia = null;

            if (extRef) {
                const guideId = extRef.startsWith('guia_') ? extRef.replace('guia_', '') : extRef;
                const { data: gList } = await supabase.from('guides').select('*, tenants(*)').eq('id', guideId).limit(1);
                if (gList && gList.length > 0) guia = gList[0];
            }

            if (!guia && billId) {
                const { data: gList } = await supabase.from('guides').select('*, tenants(*)').eq('asaas_bill_id', billId).limit(1);
                if (gList && gList.length > 0) guia = gList[0];
            }

            if (!guia && identField) {
                const { data: gList } = await supabase.from('guides').select('*, tenants(*)').or(`line_digitizable.eq.${identField},barcode.eq.${identField}`).limit(1);
                if (gList && gList.length > 0) guia = gList[0];
            }

            if (guia) {
                const agora = new Date().toISOString();
                const isTenantSimulado = (guia.tenants?.environment || '').toLowerCase() === 'simulado';
                const authCode = bill.bankAuthentication || bill.authenticationCode || guia.bank_authentication || null;
                let storagePath = null;
                let pdfBuffer = null;

                if (receiptUrl) {
                    try {
                        pdfBuffer = await asaasService.downloadExternalPdf(receiptUrl);
                        storagePath = `${guia.tenant_id}/comprovantes/comprovante_NF_${guia.nf_number}.pdf`;
                    } catch (eDl) {
                        console.warn("[Webhook Asaas] Falha ao baixar PDF oficial do Asaas:", eDl.message);
                    }
                }

                if (!pdfBuffer && isTenantSimulado) {
                    try {
                        pdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                            nfNumber: guia.nf_number,
                            uf: guia.uf,
                            valor: guia.value || bill.value,
                            billId: billId,
                            razaoSocial: guia.tenants?.razao_social || 'Empresa Emitente',
                            environment: 'simulado'
                        });
                        storagePath = `${guia.tenant_id}/comprovantes/comprovante_simulado_NF_${guia.nf_number}.pdf`;
                    } catch (eGen) {
                        console.error("[Webhook Asaas] Erro ao gerar comprovante simulado:", eGen.message);
                    }
                }

                if (pdfBuffer && storagePath) {
                    try {
                        await supabase.storage
                            .from('tenant-storage')
                            .upload(storagePath, pdfBuffer, {
                                contentType: 'application/pdf',
                                upsert: true
                            });
                    } catch (eUp) {
                        console.warn("[Webhook Asaas] Erro ao salvar comprovante no Supabase Storage:", eUp.message);
                        storagePath = null;
                    }
                }

                const updates = {
                    status: 'comprovada',
                    paid_at: bill.paymentDate || agora,
                    receipt_url: receiptUrl || null,
                    receipt_storage_path: storagePath || guia.receipt_storage_path || null,
                    bank_authentication: authCode,
                    asaas_bill_id: billId || guia.asaas_bill_id
                };

                await supabase.from('guides').update(updates).eq('id', guia.id).eq('tenant_id', guia.tenant_id);
                console.log(`[Webhook Asaas] Guia NF ${guia.nf_number} atualizada para COMPROVADA! Autenticação: ${authCode}`);

                if (guia.batch_id) {
                    try {
                        const { data: batchGuides } = await supabase
                            .from('guides')
                            .select('id, status, uf, value')
                            .eq('batch_id', guia.batch_id)
                            .eq('tenant_id', guia.tenant_id);

                        if (batchGuides && batchGuides.length > 0) {
                            const pendentes = batchGuides.filter(g => {
                                const uf = (g.uf || '').toUpperCase();
                                if (uf === 'SP' || parseFloat(g.value || 0) === 0) return false;
                                return g.status !== 'comprovada' && g.status !== 'paga';
                            });

                            if (pendentes.length === 0) {
                                await supabase.from('batches').update({
                                    status: 'liquidado',
                                    closed_at: agora
                                }).eq('id', guia.batch_id).eq('tenant_id', guia.tenant_id);
                                console.log(`[Webhook Asaas] Lote ${guia.batch_id} totalmente liquidado!`);
                            }
                        }
                    } catch (eBatch) {
                        console.warn("[Webhook Asaas] Falha ao verificar status global do lote:", eBatch.message);
                    }
                }

                broadcastDockEvent({
                    type: 'GUIA_PAGA',
                    guiaId: guia.id,
                    nf: guia.nf_number,
                    uf: guia.uf,
                    batchId: guia.batch_id,
                    status: 'comprovada',
                    bank_authentication: authCode,
                    receipt_storage_path: storagePath,
                    timestamp: agora
                }, guia.tenant_id);
            } else {
                console.warn(`[Webhook Asaas] Nenhuma guia encontrada para Bill ID: ${billId} / Ref: ${extRef}`);
            }
        }

        // ==========================================================
        // CASO 2: FALHA OU CANCELAMENTO DO PAGAMENTO DE GUIA
        // ==========================================================
        if (event === 'BILL_FAILED' || event === 'BILL_CANCELLED') {
            const billId = bill.id;
            const extRef = bill.externalReference;
            const motivo = bill.failReason || bill.description || 'Pagamento cancelado ou rejeitado no Asaas';

            let { data: guias } = await supabase.from('guides').select('*').eq('asaas_bill_id', billId).limit(1);
            if ((!guias || guias.length === 0) && extRef) {
                const guideId = extRef.startsWith('guia_') ? extRef.replace('guia_', '') : extRef;
                const { data: gList } = await supabase.from('guides').select('*').eq('id', guideId).limit(1);
                guias = gList;
            }

            if (guias && guias.length > 0) {
                const guia = guias[0];
                await supabase.from('guides').update({
                    status: 'erro_pagamento'
                }).eq('id', guia.id).eq('tenant_id', guia.tenant_id);

                console.warn(`[Webhook Asaas] Guia NF ${guia.nf_number} marcada com ERRO DE PAGAMENTO: ${motivo}`);

                broadcastDockEvent({
                    type: 'GUIA_ERRO',
                    guiaId: guia.id,
                    nf: guia.nf_number,
                    uf: guia.uf,
                    batchId: guia.batch_id,
                    status: 'erro_pagamento',
                    motivo: motivo,
                    timestamp: new Date().toISOString()
                }, guia.tenant_id);
            }
        }

        // ==========================================================
        // CASO 3: ASSINATURA SAAS PAGA (PAYMENT_RECEIVED / PAYMENT_CONFIRMED)
        // ==========================================================
        if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
            const extRef = String(bill.externalReference || '');
            if (extRef.startsWith('sub_tenant_')) {
                const parts = extRef.split('_'); // sub_tenant_<tenantId>_<plan>
                const tenantId = parts[2];
                const plan = parts[3] || 'starter';

                const newLimit = PLAN_LIMITS[plan] || 100;
                await supabase.from('tenants').update({
                    subscription_status: plan,
                    status: 'ativo',
                    limite_guias_mes: newLimit
                }).eq('id', tenantId);

                await auditService.logAudit(supabase, {
                    tenantId,
                    acao: 'ASSINATURA_PAGA_ASAAS',
                    detalhe: `Pagamento de assinatura do plano '${plan}' confirmado via Asaas webhook. Limite atualizado para ${newLimit} guias.`
                });
                console.log(`[Webhook Asaas] Assinatura do tenant ${tenantId} ativada para o plano ${plan}!`);
            }
        }

        // ==========================================================
        // CASO 4: ASSINATURA SAAS CANCELADA (SUBSCRIPTION_CANCELLED)
        // ==========================================================
        if (event === 'SUBSCRIPTION_CANCELLED') {
            const extRef = String(bill.externalReference || '');
            if (extRef.startsWith('sub_tenant_')) {
                const tenantId = extRef.split('_')[2];
                await supabase.from('tenants').update({
                    subscription_status: 'inativo',
                    status: 'bloqueado'
                }).eq('id', tenantId);

                await auditService.logAudit(supabase, {
                    tenantId,
                    acao: 'ASSINATURA_CANCELADA_ASAAS',
                    detalhe: 'Assinatura cancelada no gateway Asaas.'
                });
            }
        }

        return res.status(200).json({ received: true });
    } catch (err) {
        console.error("[Webhook Asaas] Erro ao processar webhook:", err);
        return res.status(500).json({ error: "Erro interno ao processar webhook" });
    }
};

router.post('/asaas', handleAsaasWebhook);
router.post('/asaas/:tenantId', handleAsaasWebhook);

module.exports = router;
