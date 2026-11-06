// services/batch_processor.js
// Motor de Processamento Assíncrono em Lote: Pré-validação, Transmissão SEFAZ e Remessa Bancária

const path = require('path');
const fs = require('fs').promises;

const supabase = require('../src/config/supabase');
const { getEncryptionKey, decrypt } = require('../src/utils/crypto');
const { activeTasks, broadcastDockEvent } = require('../src/utils/events');
const { situacaoPagamentoGuia, extrairVencimentoGuiaReal, obterDataHojeBrasilIso } = require('../src/utils/tenantHelper');

const parserService = require('./parser_service');
const danfeService = require('./danfe_service');
const gnreService = require('./gnre_service');
const duaEsService = require('./dua_es_service');
const printService = require('./print_service');
const cnabService = require('./cnab_service');

/**
 * 1. Importa os XMLs, valida regras fiscais, calcula DIFAL e deixa o lote aguardando aprovação
 */
function stageBatchForApproval(batchId, tenant, filesData, paymentDate, source = 'upload') {
    setImmediate(async () => {
        activeTasks[batchId] = {
            logs: [],
            progress: 10,
            status: 'aguardando_aprovacao'
        };

        const task = activeTasks[batchId];
        const log = (msg) => {
            const timestamp = new Date().toLocaleTimeString('pt-BR');
            task.logs.push(`[${timestamp}] ${msg}`);
        };

        try {
            log(`📥 Importando e pré-validando ${filesData.length} arquivo(s) de nota fiscal...`);
            task.progress = 20;

            const notasValidas = [];
            let totalDifal = 0;

            for (const f of filesData) {
                try {
                    const dadosNfe = parserService.extrairDadosNfeXML(f.content);
                    dadosNfe.caminhoOriginal = f.path;
                    dadosNfe.nomeArquivoOriginal = f.filename;
                    dadosNfe.xmlSource = f.xmlSource || source;
                    dadosNfe.xmlContent = f.content;

                    const ch = (dadosNfe.chaveAcessoNfe || '').trim();
                    const doc = (dadosNfe.documentoOrigem || '').trim();

                    // Checa se já existe guia emitida anteriormente
                    let jaExiste = null;
                    if (ch) {
                        const { data } = await supabase
                            .from('guides')
                            .select('id, nf_number, status')
                            .eq('tenant_id', tenant.id)
                            .eq('chave_nfe', ch)
                            .neq('status', 'aguardando_aprovacao')
                            .limit(1);
                        if (data && data.length > 0) jaExiste = data[0];
                    }
                    if (!jaExiste && doc) {
                        const { data } = await supabase
                            .from('guides')
                            .select('id, nf_number, status')
                            .eq('tenant_id', tenant.id)
                            .eq('nf_number', doc)
                            .neq('status', 'aguardando_aprovacao')
                            .limit(1);
                        if (data && data.length > 0) jaExiste = data[0];
                    }

                    if (jaExiste) {
                        log(`   ⏭ NF Nº ${doc} já emitida anteriormente no sistema. Ignorada para evitar duplicidade.`);
                        continue;
                    }

                    // Salva XML no Storage para transmissão posterior quando autorizado
                    let xmlRemotePath = null;
                    if (f.content) {
                        xmlRemotePath = `${tenant.id}/lotes_xml/${batchId}/${f.filename || `nfe_${doc}.xml`}`;
                        await supabase.storage
                            .from('tenant-storage')
                            .upload(xmlRemotePath, Buffer.from(f.content, 'utf-8'), {
                                contentType: 'application/xml; charset=utf-8',
                                upsert: true
                            });
                        dadosNfe.xml_storage_path = xmlRemotePath;
                    }

                    // Gera DANFE em PDF antecipadamente
                    let danfeRemotePath = null;
                    try {
                        const danfeBuffer = await danfeService.gerarDanfePdf(f.content);
                        danfeRemotePath = `${tenant.id}/danfe/danfe_NF_${doc}.pdf`;
                        await supabase.storage
                            .from('tenant-storage')
                            .upload(danfeRemotePath, danfeBuffer, {
                                contentType: 'application/pdf',
                                upsert: true
                            });
                        dadosNfe.danfe_storage_path = danfeRemotePath;
                    } catch (eDanfe) {}

                    const val = parseFloat(dadosNfe.valor || 0);
                    totalDifal += val;
                    notasValidas.push(dadosNfe);

                    log(`   ✔ NF Nº ${dadosNfe.documentoOrigem} (Destino: ${dadosNfe.ufFavorecida}, DIFAL: R$ ${dadosNfe.valor}) pré-validada.`);
                } catch (err) {
                    log(`   ⚠ Ignorado arquivo ${f.filename}: ${err.message}`);
                }
            }

            if (notasValidas.length === 0) {
                throw new Error("Nenhuma nota fiscal pendente de emissão foi localizada.");
            }

            task.progress = 70;

            const guidesDb = notasValidas.map(n => ({
                tenant_id: tenant.id,
                batch_id: batchId,
                nf_number: n.documentoOrigem,
                uf: n.ufFavorecida,
                value: n.valor,
                status: 'aguardando_aprovacao',
                customer_name: n.destNome || null,
                carrier_name: n.carrierName || null,
                chave_nfe: n.chaveAcessoNfe || null,
                xml_storage_path: n.xml_storage_path || null,
                danfe_storage_path: n.danfe_storage_path || null,
                xml_source: n.xmlSource || source,
                barcode: null,
                line_digitizable: null
            }));

            await supabase.from('guides').insert(guidesDb);

            await supabase
                .from('batches')
                .update({
                    status: 'aguardando_aprovacao',
                    file_count: notasValidas.length
                })
                .eq('id', batchId).eq('tenant_id', tenant.id);

            log(`\n==================================================`);
            log(`📋 PRÉ-VALIDAÇÃO CONCLUÍDA COM SUCESSO!`);
            log(`📊 Total: ${notasValidas.length} nota(s) fiscal(is) prontas.`);
            log(`💰 Total DIFAL: R$ ${totalDifal.toFixed(2)}.`);
            log(`🛑 AGUARDANDO AUTORIZAÇÃO: Revise as notas no painel e clique em "Autorizar Emissão" para transmitir à SEFAZ.`);
            log(`==================================================`);

            task.progress = 100;
            task.status = 'aguardando_aprovacao';

        } catch (err) {
            log(`❌ Erro na importação: ${err.message}`);
            task.status = 'erro';
            task.error = err.message;
            await supabase
                .from('batches')
                .update({ status: 'erro', error_message: err.message })
                .eq('id', batchId).eq('tenant_id', tenant.id);
        }
    });
}

/**
 * 2. Transmite o lote já validado para a SEFAZ após a autorização expressa do operador
 */
function transmitStagedBatchToSefaz(batchId, tenant, paymentDate, guideIds = null) {
    setImmediate(async () => {
        activeTasks[batchId] = {
            logs: [`[${new Date().toLocaleTimeString('pt-BR')}] 🚀 Emissão autorizada pelo operador (Data Pagamento: ${paymentDate || 'hoje'})! Conectando com a SEFAZ...`],
            progress: 10,
            status: 'processando'
        };

        const task = activeTasks[batchId];
        const log = (msg) => {
            const timestamp = new Date().toLocaleTimeString('pt-BR');
            task.logs.push(`[${timestamp}] ${msg}`);
        };

        try {
            await supabase.from('batches').update({ status: 'processando' }).eq('id', batchId).eq('tenant_id', tenant.id);

            let gQuery = supabase
                .from('guides')
                .select('*')
                .eq('batch_id', batchId)
                .eq('tenant_id', tenant.id);
            if (Array.isArray(guideIds) && guideIds.length > 0) {
                gQuery = gQuery.in('id', guideIds);
            }
            const { data: stagedGuides, error: gError } = await gQuery;

            if (gError || !stagedGuides || stagedGuides.length === 0) {
                throw new Error("Nenhuma nota encontrada para este lote.");
            }

            const hoje = new Date().toISOString().split('T')[0];
            const dataAlvo = paymentDate || hoje;

            const notasFiscais = [];
            let guiasPagasIgnoradas = 0;
            let guiasJaEmitidasPreservadas = 0;
            let guiasSemXmlIgnoradas = 0;

            for (const g of stagedGuides) {
                const st = (g.status || '').toLowerCase();
                const sit = (g.situacao_pagamento || '').toLowerCase();
                if (st === 'paga' || st === 'comprovada' || sit === 'paga' || g.paid_at) {
                    guiasPagasIgnoradas++;
                    continue;
                }

                const barClean = String(g.barcode || '').replace(/\D/g, '');
                const temBarcodeSefazValido = barClean.length >= 44
                    && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP'
                    && !printService.isCodigoBarrasSinteticoLocal(barClean);

                if (temBarcodeSefazValido) {
                    const vencAtual = printService.extrairVencimentoDeBarcodeGnre(g.barcode);
                    if (vencAtual && vencAtual === dataAlvo) {
                        if (st === 'rejeitada_sefaz' || st === 'rejeitada') {
                            await supabase
                                .from('guides')
                                .update({ status: 'aguardando_pagamento' })
                                .eq('id', g.id)
                                .eq('tenant_id', tenant.id);
                        }
                        guiasJaEmitidasPreservadas++;
                        log(`🛡 NF ${g.nf_number} (${g.uf}) já possui guia oficial SEFAZ autorizada para ${dataAlvo.split('-').reverse().join('/')} — preservada sem reenvio.`);
                        continue;
                    }
                }

                let content = null;
                if (g.xml_storage_path) {
                    try {
                        const { data: xData } = await supabase.storage.from('tenant-storage').download(g.xml_storage_path);
                        if (xData) content = await xData.text();
                    } catch (e) {}
                }
                if (!content && g.nf_number) {
                    try {
                        const { data: otherG } = await supabase
                            .from('guides')
                            .select('xml_storage_path')
                            .eq('tenant_id', tenant.id)
                            .eq('nf_number', g.nf_number)
                            .not('xml_storage_path', 'is', null)
                            .limit(1)
                            .single();
                        if (otherG && otherG.xml_storage_path) {
                            const { data: xData } = await supabase.storage.from('tenant-storage').download(otherG.xml_storage_path);
                            if (xData) content = await xData.text();
                        }
                    } catch (e) {}
                }
                if (content) {
                    const dadosNfe = parserService.extrairDadosNfeXML(content);
                    dadosNfe.guide_id = g.id;
                    dadosNfe.jaTinhaBarcodeValido = temBarcodeSefazValido;
                    dadosNfe.xmlContent = content;
                    dadosNfe.xml_storage_path = g.xml_storage_path;
                    dadosNfe.danfe_storage_path = g.danfe_storage_path;
                    notasFiscais.push(dadosNfe);
                } else {
                    guiasSemXmlIgnoradas++;
                    log(`⚠ NF ${g.nf_number} sem XML de NF-e anexado — ignorada no envio automático.`);
                }
            }

            if (guiasPagasIgnoradas > 0) {
                log(`🛡 Trava anti-duplicidade ativada: ${guiasPagasIgnoradas} guia(s) já quitadas/pagas foram preservadas e não reenviadas.`);
            }

            if (notasFiscais.length === 0) {
                if (guiasPagasIgnoradas > 0 || guiasJaEmitidasPreservadas > 0) {
                    log(`✔ Todas as guias elegíveis com XML deste lote já estão autorizadas na SEFAZ para ${dataAlvo.split('-').reverse().join('/')} (ou já quitadas).`);
                    const syncRemPreserv = await sincronizarRemessaAutomaticaLote(batchId, tenant, dataAlvo).catch(() => null);
                    const remPreservPayload = syncRemPreserv ? { ...syncRemPreserv, cnabText: undefined } : null;
                    if (remPreservPayload && remPreservPayload.gerada) {
                        log(`🏦 Remessa Itaú SISPAG (${remPreservPayload.filename}) gerada automaticamente: ${remPreservPayload.qtdGuias} guia(s) · R$ ${remPreservPayload.valorTotal.toFixed(2).replace('.', ',')}.`);
                    }
                    task.remessa = remPreservPayload;
                    task.progress = 100;
                    task.status = 'sucesso';
                    await supabase.from('batches').update({ status: 'sucesso', error_message: null }).eq('id', batchId).eq('tenant_id', tenant.id);
                    broadcastDockEvent({
                        type: 'LOTE_ATUALIZADO',
                        batchId,
                        status: 'sucesso',
                        paymentDate: dataAlvo,
                        remessa: remPreservPayload,
                        timestamp: new Date().toISOString()
                    }, tenant.id);
                    return;
                }
                throw new Error(guiasSemXmlIgnoradas > 0
                    ? `As ${guiasSemXmlIgnoradas} nota(s) selecionada(s) são registros financeiros antigos sem arquivo XML de NF-e anexado.`
                    : "Não foi possível carregar os arquivos XML do lote para transmissão.");
            }

            // Agente mTLS
            let agent = null;
            if (tenant.environment === 'producao') {
                log("🔍 Carregando certificado PFX do armazenamento seguro...");
                if (!tenant.pfx_filename) {
                    throw new Error("Nenhum certificado digital PFX cadastrado.");
                }
                const { data: pfxFile, error: downloadError } = await supabase.storage
                    .from('tenant-storage')
                    .download(`${tenant.id}/certificados/${tenant.pfx_filename}`);

                if (downloadError || !pfxFile) {
                    throw new Error("Falha ao baixar certificado: " + (downloadError?.message || 'Arquivo ausente'));
                }

                const pfxBuffer = Buffer.from(await pfxFile.arrayBuffer());
                const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
                const passphrase = decrypt(tenant.pfx_passphrase_encrypted, key);

                log("⚙ Canal mTLS SEFAZ inicializado.");
                agent = gnreService.createHttpsAgent({ pfxBuffer, passphrase });
            } else {
                log("🧪 Modo SIMULADO ativado.");
            }

            task.progress = 25;

            for (const nota of notasFiscais) {
                nota.dataVencimento = dataAlvo;
                nota.dataPagamento = dataAlvo;
            }

            const notasPorUf = {};
            for (const n of notasFiscais) {
                if (!notasPorUf[n.ufFavorecida]) notasPorUf[n.ufFavorecida] = [];
                notasPorUf[n.ufFavorecida].push(n);
            }

            const ufs = Object.keys(notasPorUf);
            log(`🌍 Transmitindo para ${ufs.length} UF(s): ${ufs.join(', ')}...`);

            const logsDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'xml_logs')
                : path.join(__dirname, '..', 'xml_logs');
            await fs.mkdir(logsDir, { recursive: true });

            const todasGuias = [];
            const recibosEfetuados = [];
            const errosUf = {};

            for (let i = 0; i < ufs.length; i++) {
                const uf = ufs[i];
                if (i > 0 && tenant.environment === 'producao') {
                    log(`⏳ Aguardando 3s antes de transmitir para ${uf}...`);
                    await new Promise(r => setTimeout(r, 3000));
                }
                log(`[${uf}] Transmitindo lote de ${notasPorUf[uf].length} guia(s)...`);

                try {
                    let resultadoUf;
                    if (tenant.environment === 'simulado') {
                        const xmlSimulado = notasPorUf[uf].map((nota, idx) => {
                            const valorCentavos = Math.round(parseFloat(nota.valor) * 100);
                            const codBarras = `8589${String(valorCentavos).padStart(11, '0')}01352026062010436619000${idx}${String(nota.documentoOrigem).slice(-3)}`;
                            return {
                                ufFavorecida: nota.ufFavorecida,
                                documentoOrigem: nota.documentoOrigem,
                                valor: nota.valor,
                                linhaDigitavel: codBarras,
                                codigoBarras: codBarras,
                                situacaoGuia: '0',
                                simulado: true,
                                recibo: `SIMULADO_${uf}`
                            };
                        });
                        resultadoUf = { guias: xmlSimulado, recibo: `SIMULADO_${uf}` };
                        log(`[${uf}] 🧪 Simulação concluída (ambiente não produtivo).`);
                    } else if (uf === 'SP') {
                        const xmlSp = gnreService.gerarXmlLoteRaw(notasPorUf[uf], tenant);
                        const remotePathSp = `${tenant.id}/lotes_sp/lote_sp_${batchId}.xml`;
                        await supabase.storage
                            .from('tenant-storage')
                            .upload(remotePathSp, Buffer.from(xmlSp, 'utf-8'), {
                                contentType: 'application/xml',
                                upsert: true
                            });

                        const dataSpBr = dataAlvo.split('-').reverse().join('/');
                        for (const n of notasPorUf[uf]) {
                            await supabase
                                .from('guides')
                                .update({
                                    barcode: 'IMPORTAR_NO_SEFAZ_SP',
                                    line_digitizable: `Gerar em lote pelo arquivo XML de SP (Venc. ${dataSpBr})`,
                                    status: 'requer_dare_sp'
                                })
                                .eq('batch_id', batchId)
                                .eq('tenant_id', tenant.id)
                                .eq('nf_number', n.documentoOrigem);
                        }
                        resultadoUf = { guias: [], recibo: `XML_LOTE_SP`, isSpDare: true };
                        log(`[${uf}] 📦 Lote XML de SP (${notasPorUf[uf].length} notas) gerado e disponível para download e emissão manual no portal.`);
                    } else if (uf === 'ES') {
                        let xmlGuiasEs = [];
                        for (const nota of notasPorUf[uf]) {
                            log(`[${uf}] Emitindo DUA-e para NF ${nota.documentoOrigem}...`);
                            const { nDua, nBar } = await duaEsService.transmitirEmissao(nota, agent, tenant.environment);
                            const pdfBuffer = await duaEsService.transmitirObterPdf(nDua, nota.destCnpjCpf, agent, tenant.environment);
                            const remotePath = `${tenant.id}/guias/guia_NF_${nota.documentoOrigem}.pdf`;
                            await supabase.storage
                                .from('tenant-storage')
                                .upload(remotePath, pdfBuffer, {
                                    contentType: 'application/pdf',
                                    upsert: true
                                });
                            xmlGuiasEs.push({
                                ufFavorecida: 'ES',
                                documentoOrigem: nota.documentoOrigem,
                                valor: nota.valor,
                                linhaDigitavel: nBar,
                                codigoBarras: nBar,
                                numeroControle: nDua,
                                recibo: `DUA_${nDua}`,
                                situacaoGuia: '0',
                                storage_path: remotePath,
                                isPdf: true
                            });
                        }
                        resultadoUf = { guias: xmlGuiasEs, recibo: `DUA_ES_${batchId}` };
                    } else {
                        const recibo = await gnreService.enviarLote(notasPorUf[uf], agent, uf, tenant.environment, tenant, logsDir);
                        log(`[${uf}] Lote recebido! Recibo ${recibo}. Consultando retorno individual da SEFAZ...`);

                        let dadosGuias = null;
                        let tentativas = 0;
                        const maxTentativas = ['RJ', 'SE'].includes(uf) ? 50 : 35;
                        while (tentativas < maxTentativas) {
                            const seg = tentativas === 0 ? 8 : 5;
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

                        if (!dadosGuias) throw new Error("Tempo esgotado aguardando retorno da SEFAZ.");

                        if (Array.isArray(dadosGuias.rejeicoesDetalhadas) && dadosGuias.rejeicoesDetalhadas.length > 0) {
                            for (const rej of dadosGuias.rejeicoesDetalhadas) {
                                log(`[${uf}] ⚠ NF ${rej.documentoOrigem} rejeitada pela SEFAZ: ${rej.motivo}`);
                                const notaRef = notasPorUf[uf].find(n => parserService.normalizarDocumentoOrigem(n.documentoOrigem) === parserService.normalizarDocumentoOrigem(rej.documentoOrigem));
                                if (!notaRef || !notaRef.jaTinhaBarcodeValido) {
                                    await supabase
                                        .from('guides')
                                        .update({
                                            status: 'rejeitada_sefaz'
                                        })
                                        .eq('batch_id', batchId)
                                        .eq('tenant_id', tenant.id)
                                        .eq('nf_number', rej.documentoOrigem);
                                }
                            }
                        }

                        for (const g of dadosGuias) {
                            g.recibo = recibo;
                        }
                        resultadoUf = { guias: dadosGuias, recibo };
                    }

                    todasGuias.push(...resultadoUf.guias);
                    if (resultadoUf.recibo) recibosEfetuados.push(`${uf}:${resultadoUf.recibo}`);
                    if (!resultadoUf.isSpDare) {
                        log(`[${uf}] ✔ ${resultadoUf.guias.length} guia(s) processada(s) com sucesso!`);
                    }

                } catch (err) {
                    log(`[${uf}] ❌ Erro: ${err.message}`);
                    errosUf[uf] = err.message;
                    const notasSemGuiaPrevia = notasPorUf[uf].filter(n => !n.jaTinhaBarcodeValido);
                    const notasComGuiaPrevia = notasPorUf[uf].filter(n => n.jaTinhaBarcodeValido);
                    if (notasComGuiaPrevia.length > 0) {
                        log(`[${uf}] 🛡 ${notasComGuiaPrevia.length} guia(s) já autorizada(s) anteriormente foram preservadas sem perder o código SEFAZ.`);
                    }
                    if (notasSemGuiaPrevia.length > 0) {
                        const nfsSemGuia = notasSemGuiaPrevia.map(n => n.documentoOrigem);
                        await supabase
                            .from('guides')
                            .update({
                                status: 'rejeitada_sefaz'
                            })
                            .eq('batch_id', batchId)
                            .eq('tenant_id', tenant.id)
                            .in('nf_number', nfsSemGuia);
                    }
                }

                task.progress = Math.round(25 + (55 * ((i + 1) / ufs.length)));
            }

            const houveSpGerado = recibosEfetuados.some(r => r.startsWith('SP:'));
            if (todasGuias.length === 0 && !houveSpGerado && Object.keys(errosUf).length > 0) {
                const resumoErros = Object.entries(errosUf).map(([u, m]) => `${u}: ${m}`).join(' | ');
                throw new Error(`Não foi possível concluir a transmissão na SEFAZ (${resumoErros}).`);
            }

            log("Validando retorno individual e gerando espelhos de conferência...");
            const dadosBancarios = {
                cnpj: tenant.cnpj,
                razaoSocial: tenant.razao_social,
                agencia: tenant.bank_agency,
                conta: tenant.bank_account,
                dac: tenant.bank_dac
            };

            for (const guia of todasGuias) {
                const docNorm = parserService.normalizarDocumentoOrigem(guia.documentoOrigem);
                const nota = notasFiscais.find(n => parserService.normalizarDocumentoOrigem(n.documentoOrigem) === docNorm);
                const nfAlvo = nota ? nota.documentoOrigem : guia.documentoOrigem;

                const ufRetornada = (guia.ufFavorecida || '').toUpperCase().trim();
                const ufEsperada = (nota?.ufFavorecida || '').toUpperCase().trim();
                if (ufRetornada && ufEsperada && ufRetornada !== ufEsperada) {
                    const msgDiv = `BLOQUEIO DE SEGURANÇA: UF retornada pelo portal (${ufRetornada}) diverge da UF da NF-e (${ufEsperada}). Não pagar sem conciliação no Portal GNRE.`;
                    log(`❌ NF ${nfAlvo}: ${msgDiv}`);
                    await supabase
                        .from('guides')
                        .update({
                            status: 'divergencia_uf_portal'
                        })
                        .eq('batch_id', batchId)
                        .eq('tenant_id', tenant.id)
                        .eq('nf_number', nfAlvo);
                    continue;
                }

                let remotePath = guia.storage_path;

                if (!guia.isPdf && guia.codigoBarras !== 'IMPORTAR_NO_SEFAZ_SP') {
                    const htmlGuia = gnreService.exportarGuiaHtml(dadosBancarios, guia, nota);
                    const nomeLocal = `guia_NF_${nfAlvo}.html`;
                    remotePath = `${tenant.id}/guias/${nomeLocal}`;
                    await supabase.storage
                        .from('tenant-storage')
                        .upload(remotePath, Buffer.from(htmlGuia, 'utf-8'), {
                            contentType: 'text/html',
                            upsert: true
                        });
                }

                const { error: upGuideErr } = await supabase
                    .from('guides')
                    .update({
                        uf: ufRetornada || ufEsperada,
                        barcode: guia.codigoBarras,
                        line_digitizable: guia.linhaDigitavel || guia.codigoBarras,
                        storage_path: remotePath,
                        status: 'aguardando_pagamento'
                    })
                    .eq('batch_id', batchId)
                    .eq('tenant_id', tenant.id)
                    .eq('nf_number', nfAlvo);
                if (upGuideErr) {
                    log(`⚠ Falha ao atualizar guia NF ${nfAlvo} no banco: ${upGuideErr.message}`);
                }
            }

            let reciboFinal = recibosEfetuados.join(', ');
            try {
                const { data: batchAtual } = await supabase.from('batches').select('receipt').eq('id', batchId).eq('tenant_id', tenant.id).single();
                if (batchAtual && batchAtual.receipt) {
                    const mapaRec = {};
                    String(batchAtual.receipt).split(',').map(s => s.trim()).filter(Boolean).forEach(par => {
                        const idx = par.indexOf(':');
                        if (idx > 0) mapaRec[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
                    });
                    recibosEfetuados.forEach(par => {
                        const idx = par.indexOf(':');
                        if (idx > 0) mapaRec[par.slice(0, idx).trim()] = par.slice(idx + 1).trim();
                    });
                    const listaRec = Object.entries(mapaRec).map(([k, v]) => `${k}:${v}`);
                    if (listaRec.length > 0) reciboFinal = listaRec.join(', ');
                }
            } catch (eRec) {}

            const resumoParcialErros = Object.keys(errosUf).length > 0
                ? Object.entries(errosUf).map(([u, m]) => `${u}: ${m}`).join(' | ')
                : null;
            await supabase
                .from('batches')
                .update({
                    status: 'sucesso',
                    receipt: reciboFinal,
                    error_message: resumoParcialErros
                })
                .eq('id', batchId).eq('tenant_id', tenant.id);

            const syncRemAuto = await sincronizarRemessaAutomaticaLote(batchId, tenant, dataAlvo).catch(e => {
                console.warn('[CNAB Auto] Aviso ao sincronizar remessa automática:', e.message);
                return null;
            });
            const remAutoPayload = syncRemAuto ? { ...syncRemAuto, cnabText: undefined } : null;
            task.remessa = remAutoPayload;

            log(`\n==================================================`);
            log(`🎉 TODAS AS GUIAS FORAM EMITIDAS COM SUCESSO!`);
            if (remAutoPayload && remAutoPayload.gerada) {
                const obsSp = remAutoPayload.spAguardandoDare > 0
                    ? ` (${remAutoPayload.spAguardandoDare} nota(s) SP serão incluídas ao importar o DARE-SP)`
                    : '';
                log(`🏦 REMESSA ITAÚ SISPAG GERADA AUTOMATICAMENTE: ${remAutoPayload.filename} · ${remAutoPayload.qtdGuias} guia(s) · R$ ${remAutoPayload.valorTotal.toFixed(2).replace('.', ',')}${obsSp}`);
            } else if (remAutoPayload && remAutoPayload.spAguardandoDare > 0) {
                log(`ℹ Remessa Itaú aguardando importação do retorno DARE-SP (${remAutoPayload.spAguardandoDare} nota(s) de SP).`);
            } else {
                log(`💳 STATUS: Guias emitidas. Aguardando autorização de pagamento bancário.`);
            }
            log(`==================================================`);

            task.progress = 100;
            task.status = 'sucesso';

            broadcastDockEvent({
                type: 'LOTE_ATUALIZADO',
                batchId,
                status: 'sucesso',
                paymentDate: dataAlvo,
                remessa: remAutoPayload,
                timestamp: new Date().toISOString()
            }, tenant.id);

        } catch (err) {
            log(`❌ Erro na transmissão: ${err.message}`);
            task.status = 'erro';
            task.error = err.message;
            await supabase
                .from('batches')
                .update({ status: 'erro', error_message: err.message })
                .eq('id', batchId).eq('tenant_id', tenant.id);

            broadcastDockEvent({
                type: 'LOTE_ATUALIZADO',
                batchId,
                status: 'erro',
                error: err.message,
                timestamp: new Date().toISOString()
            }, tenant.id);
        }
    });
}

/**
 * Calcula o resumo em tempo real da Remessa Itaú SISPAG CNAB 240 para o lote ativo.
 */
function calcularResumoRemessaDeGuias(guiasLista, tenant, batchId = 'todos', paymentDatePreferida = null, opcoes = {}) {
    const isSimuladoCnab = ((tenant?.environment || '').toLowerCase() === 'simulado');
    const ordenadas = [...(guiasLista || [])].sort((a, b) => (parseInt(a.nf_number, 10) || 0) - (parseInt(b.nf_number, 10) || 0));

    let spAguardandoDare = 0;
    let valorSpAguardando = 0;

    const validItauGuides = ordenadas.filter(g => {
        const sit = situacaoPagamentoGuia(g);
        if (sit === 'sp_manual') {
            spAguardandoDare++;
            valorSpAguardando += parseFloat(g.value || 0);
            return false;
        }
        if (sit === 'paga' && !opcoes.forcarPagas) return false;
        if (sit !== 'a_pagar' && sit !== 'agendada' && !(sit === 'paga' && opcoes.forcarPagas)) return false;

        if (!g.barcode || String(g.barcode).includes('IMPORTAR_NO_SEFAZ_SP')) return false;
        const bar44 = cnabService.normalizarCodigoBarras44(g.barcode);
        if (bar44.length !== 44) return false;
        const isSynthetic = !isSimuladoCnab && printService.isCodigoBarrasSinteticoLocal(bar44);
        return !isSynthetic;
    });

    let dataPagamentoEfetiva = (paymentDatePreferida && /^\d{4}-\d{2}-\d{2}$/.test(paymentDatePreferida))
        ? paymentDatePreferida
        : null;

    if (!dataPagamentoEfetiva) {
        for (const g of validItauGuides) {
            const dt = extrairVencimentoGuiaReal(g);
            if (dt) {
                dataPagamentoEfetiva = dt;
                break;
            }
        }
    }
    if (!dataPagamentoEfetiva) {
        for (const g of ordenadas) {
            const dt = extrairVencimentoGuiaReal(g);
            if (dt) {
                dataPagamentoEfetiva = dt;
                break;
            }
        }
    }
    if (!dataPagamentoEfetiva) {
        dataPagamentoEfetiva = obterDataHojeBrasilIso();
    }

    const [anoRem, mesRem, diaRem] = String(dataPagamentoEfetiva).split('-');
    const codigoRemessa = (diaRem && mesRem) ? `REM${diaRem}${mesRem}` : 'REMESSA';
    const filename = `${codigoRemessa}.txt`;
    const valorTotal = parseFloat(validItauGuides.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0).toFixed(2));
    const agencia = tenant?.bank_agency || '0334';
    const conta = tenant?.bank_account || '98775';
    const dac = tenant?.bank_dac || '7';
    const batchRef = batchId || 'todos';

    return {
        batchId: batchRef,
        codigoRemessa,
        filename,
        qtdGuias: validItauGuides.length,
        valorTotal,
        spAguardandoDare,
        valorSpAguardando: parseFloat(valorSpAguardando.toFixed(2)),
        paymentDate: dataPagamentoEfetiva,
        contaBancaria: `Ag. ${agencia} C/C ${conta}-${dac}`,
        downloadUrl: `/api/remessa/download/${batchRef}?banco=itau&paymentDate=${encodeURIComponent(dataPagamentoEfetiva)}`,
        validItauGuides
    };
}

/**
 * Gera e persiste automaticamente o arquivo CNAB 240 Itaú SISPAG do lote no Supabase Storage.
 */
async function sincronizarRemessaAutomaticaLote(batchId, tenant, paymentDatePreferida = null) {
    if (!tenant || !tenant.id) return null;
    let batch = null;
    let batchGuides = [];
    let effectiveBatchId = 'todos';

    if (!batchId || batchId === 'todos') {
        effectiveBatchId = 'todos';
        const { data: allGuides } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenant.id);
        batchGuides = allGuides || [];
    } else {
        effectiveBatchId = batchId;
        const { data: b } = await supabase
            .from('batches')
            .select('*')
            .eq('id', batchId)
            .eq('tenant_id', tenant.id)
            .single();
        batch = b;
        if (!batch) return null;

        const { data: guides } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batch.id)
            .eq('tenant_id', tenant.id);
        batchGuides = guides || [];
    }

    const resumoRem = calcularResumoRemessaDeGuias(batchGuides, tenant, effectiveBatchId, paymentDatePreferida);
    const validas = resumoRem.validItauGuides || [];
    delete resumoRem.validItauGuides;

    if (validas.length === 0) {
        return {
            ...resumoRem,
            gerada: false,
            storagePath: null,
            cnabText: null
        };
    }

    const dadosBancarios = {
        cnpj: tenant.cnpj,
        razaoSocial: tenant.razao_social,
        agencia: tenant.bank_agency || '0334',
        conta: tenant.bank_account || '98775',
        dac: tenant.bank_dac || '7',
        convenio: tenant.bank_convenio || ''
    };

    const mapped = validas.map(g => ({
        codigoBarras: cnabService.normalizarCodigoBarras44(g.barcode),
        valor: g.value,
        dataVencimento: extrairVencimentoGuiaReal(g) || resumoRem.paymentDate,
        documentoOrigem: g.nf_number,
        ufFavorecida: g.uf
    }));

    const cnabText = cnabService.gerarRemessaSispag(dadosBancarios, mapped, resumoRem.paymentDate);
    const remessaPath = `${tenant.id}/remessas/remessa_${batch ? batch.id : effectiveBatchId}.txt`;

    await supabase.storage
        .from('tenant-storage')
        .upload(remessaPath, Buffer.from(cnabText, 'latin1'), { contentType: 'text/plain', upsert: true })
        .catch(e => console.warn('[Storage] Falha ao persistir remessa automática Itaú:', e.message));

    return {
        ...resumoRem,
        gerada: true,
        storagePath: remessaPath,
        cnabText
    };
}

function runBatchProcessInBackground(batchId, tenant, filesData, paymentDate) {
    return stageBatchForApproval(batchId, tenant, filesData, paymentDate);
}

module.exports = {
    stageBatchForApproval,
    transmitStagedBatchToSefaz,
    calcularResumoRemessaDeGuias,
    sincronizarRemessaAutomaticaLote,
    runBatchProcessInBackground
};
