// services/sync_service.js
// Serviço centralizado de sincronização automática com Linx Microvix e Olist Vnda
// Busca pedidos faturados do dia, deduplica, emite GNRE e atualiza transportadoras/clientes.

const crypto = require('crypto');
const microvixService = require('./microvix_service');
const vndaService = require('./vnda_service');

function getEncryptionKey(keyStr) {
    return crypto.createHash('sha256').update(String(keyStr)).digest();
}

function decrypt(text, key) {
    if (!text) return null;
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// Estado em memória da sincronização para exibição no Dashboard
let syncState = {
    ativo: true,
    intervaloMinutos: 30,
    ultimaExecucao: null,
    status: 'ocioso',
    mensagem: 'Agendador de sincronização automática ativo (a cada 30 min).',
    historico: []
};

let cronTimer = null;

/**
 * Executa a sincronização completa para um tenant específico
 */
async function sincronizarTenant(tenant, supabase, runBatchProcessFn, options = {}) {
    const hoje = new Date().toISOString().split('T')[0];
    const dataInicial = options.dataInicial || hoje;
    const dataFim = options.dataFim || hoje;
    const paymentDate = options.paymentDate || hoje;

    console.log(`[AutoSync] Iniciando sincronização para ${tenant.razao_social} (${tenant.cnpj}) - Período: ${dataInicial} a ${dataFim}`);

    let resultado = {
        tenantId: tenant.id,
        razaoSocial: tenant.razao_social,
        data: new Date().toISOString(),
        microvix: { consultado: false, total: 0, novas: 0, comDifal: 0, batchId: null },
        vnda: { consultado: false, pedidosLidos: 0, guiasEnriquecidas: 0 },
        mensagem: ''
    };

    // 1. Sincronização Linx Microvix (Busca de NF-e e emissão automática)
    if (tenant.microvix_key && tenant.microvix_cnpj) {
        resultado.microvix.consultado = true;
        try {
            let microvixPassword = tenant.microvix_password_encrypted || '';
            if (microvixPassword.includes(':')) {
                const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
                microvixPassword = decrypt(microvixPassword, key);
            }

            const credentials = {
                user: tenant.microvix_user || 'linx_b2c',
                password: microvixPassword,
                chave: tenant.microvix_key,
                cnpjEmp: tenant.microvix_cnpj
            };

            const notasBrutas = await microvixService.consultarNFe(credentials, dataInicial, dataFim);
            resultado.microvix.total = notasBrutas ? notasBrutas.length : 0;

            if (notasBrutas && notasBrutas.length > 0) {
                // Deduplica internamente
                const notasUnicas = [];
                const chavesVistas = new Set();
                const docsVistos = new Set();

                for (const n of notasBrutas) {
                    const ch = (n.chave_nfe || '').trim();
                    const doc = (n.documento || '').trim();
                    if (ch && chavesVistas.has(ch)) continue;
                    if (doc && docsVistos.has(doc)) continue;
                    if (ch) chavesVistas.add(ch);
                    if (doc) docsVistos.add(doc);
                    notasUnicas.push(n);
                }

                // Checa no banco se já existem guias emitidas para essas notas
                const todasChaves = notasUnicas.map(n => n.chave_nfe).filter(Boolean);
                const todosDocs = notasUnicas.map(n => n.documento).filter(Boolean);

                const chavesDuplicadas = new Set();
                const docsDuplicados = new Set();

                if (todasChaves.length > 0) {
                    const { data: dbChaves } = await supabase
                        .from('guides')
                        .select('chave_nfe, nf_number')
                        .eq('tenant_id', tenant.id)
                        .in('chave_nfe', todasChaves);

                    (dbChaves || []).forEach(r => {
                        if (r.chave_nfe) chavesDuplicadas.add(r.chave_nfe.trim());
                        if (r.nf_number) docsDuplicados.add(r.nf_number.trim());
                    });
                }

                if (todosDocs.length > 0) {
                    const { data: dbDocs } = await supabase
                        .from('guides')
                        .select('chave_nfe, nf_number')
                        .eq('tenant_id', tenant.id)
                        .in('nf_number', todosDocs);

                    (dbDocs || []).forEach(r => {
                        if (r.chave_nfe) chavesDuplicadas.add(r.chave_nfe.trim());
                        if (r.nf_number) docsDuplicados.add(r.nf_number.trim());
                    });
                }

                // Apenas notas que nunca foram processadas
                const notasNovas = notasUnicas.filter(n => {
                    const ch = (n.chave_nfe || '').trim();
                    const doc = (n.documento || '').trim();
                    if (ch && chavesDuplicadas.has(ch)) return false;
                    if (doc && docsDuplicados.has(doc)) return false;
                    return true;
                });

                resultado.microvix.novas = notasNovas.length;

                // Filtra as que têm DIFAL interestadual
                const xmlsParaProcessar = [];
                for (const nota of notasNovas) {
                    const difalMatch = nota.xml.match(/<vICMSUFDest>([^<]+)<\/vICMSUFDest>/);
                    const difalVal = difalMatch ? parseFloat(difalMatch[1]) : 0;
                    if (difalVal > 0) {
                        xmlsParaProcessar.push({
                            filename: `linx_nfe_${nota.documento || nota.chave_nfe.substring(0, 9)}.xml`,
                            content: nota.xml,
                            xmlSource: 'linx_microvix_auto'
                        });
                    }
                }

                resultado.microvix.comDifal = xmlsParaProcessar.length;

                if (xmlsParaProcessar.length > 0) {
                    // 1. Checagem de assinatura ativa
                    if (tenant.subscription_status === 'inativo') {
                        console.warn(`[AutoSync] Tenant ${tenant.razao_social} está com assinatura inativa. Bloqueando criação de lote automático.`);
                        resultado.mensagem += " Assinatura inativa: emissão de guias bloqueada.";
                        return resultado;
                    }

                    // 2. Trava de concorrência: verifica se já existe lote em processamento para este tenant
                    const { data: runningBatches } = await supabase
                        .from('batches')
                        .select('id, created_at')
                        .eq('tenant_id', tenant.id)
                        .eq('status', 'processando')
                        .order('created_at', { ascending: false })
                        .limit(1);

                    if (runningBatches && runningBatches.length > 0) {
                        console.warn(`[AutoSync] Lote #${runningBatches[0].id} ainda está em processamento para ${tenant.razao_social}. Pulando para evitar concorrência.`);
                        resultado.mensagem += ` Lote #${runningBatches[0].id} em andamento. Aguardando conclusão para não duplicar guias.`;
                        return resultado;
                    }

                    // Cria novo lote aguardando autorização humana do operador
                    const { data: batchData, error: batchError } = await supabase
                        .from('batches')
                        .insert({
                            tenant_id: tenant.id,
                            status: 'aguardando_aprovacao',
                            environment: tenant.environment || 'simulado',
                            source: 'auto_sync',
                            file_count: xmlsParaProcessar.length
                        })
                        .select('id')
                        .single();

                    if (!batchError && batchData) {
                        resultado.microvix.batchId = batchData.id;
                        console.log(`[AutoSync] Criado lote #${batchData.id} com ${xmlsParaProcessar.length} nota(s) DIFAL. Aguardando autorização no painel.`);
                        if (typeof runBatchProcessFn === 'function') {
                            runBatchProcessFn(batchData.id, tenant, xmlsParaProcessar, paymentDate, 'linx_microvix');
                        }
                    }
                }
            }
        } catch (mErr) {
            console.error(`[AutoSync] Erro na consulta Microvix:`, mErr.message);
            resultado.mensagem += ` Microvix: ${mErr.message};`;
        }
    }

    // 2. Sincronização e Enriquecimento Olist Vnda
    if (tenant.vnda_token_encrypted && tenant.vnda_shop_host) {
        resultado.vnda.consultado = true;
        try {
            const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
            const token = decrypt(tenant.vnda_token_encrypted, key);
            const shopHost = tenant.vnda_shop_host;

            const pedidos = await vndaService.listarPedidos(token, shopHost, {
                page: 1,
                per_page: 50
            });
            resultado.vnda.pedidosLidos = pedidos ? pedidos.length : 0;

            // Enriquecer guias recentes que ainda não têm cliente ou transportadora
            const { data: guiasSemDados } = await supabase
                .from('guides')
                .select('id, nf_number, customer_name, carrier_name, xml_storage_path')
                .eq('tenant_id', tenant.id)
                .or('carrier_name.is.null,customer_name.is.null')
                .order('created_at', { ascending: false })
                .limit(50);

            if (guiasSemDados && guiasSemDados.length > 0) {
                // Mapa de pedidos por código e id
                const mapPedidos = new Map();
                if (Array.isArray(pedidos)) {
                    pedidos.forEach(p => {
                        if (p.code) mapPedidos.set(String(p.code), p);
                        if (p.id) mapPedidos.set(String(p.id), p);
                    });
                }

                for (const g of guiasSemDados) {
                    // Se a guia tiver XML armazenado, tenta extrair o <xPed> do XML
                    let pedidoCode = null;
                    if (g.xml_storage_path) {
                        try {
                            const { data: xData } = await supabase.storage.from('tenant-storage').download(g.xml_storage_path);
                            if (xData) {
                                const xmlStr = await xData.text();
                                const xPedMatch = xmlStr.match(/<xPed>([^<]+)<\/xPed>/);
                                if (xPedMatch) pedidoCode = xPedMatch[1].trim();
                            }
                        } catch (err) {}
                    }

                    let pedido = null;
                    if (pedidoCode) {
                        if (mapPedidos.has(pedidoCode)) {
                            pedido = mapPedidos.get(pedidoCode);
                        } else {
                            try {
                                pedido = await vndaService.obterPedidoPorCodigo(token, shopHost, pedidoCode);
                            } catch (e) {}
                        }
                    }

                    if (pedido) {
                        const updates = {};
                        if (!g.customer_name && (pedido.client?.name || pedido.email)) {
                            updates.customer_name = pedido.client?.name || pedido.email;
                        }
                        if (!g.carrier_name && pedido.shipping_label) {
                            const rawLabel = String(pedido.shipping_label).trim();
                            const label = rawLabel.toLowerCase();
                            let transp = rawLabel.toUpperCase();
                            if (label.includes('mt log') || label.includes('mtlog') || label.includes('mt_log')) transp = 'MT LOG';
                            else if (label.includes('total') || label.includes('express')) transp = 'TOTAL EXPRESS';
                            else if (label.includes('correios') || label.includes('pac') || label.includes('sedex') || label.includes('normal')) transp = 'CORREIOS';
                            else if (label.includes('gol')) transp = 'GOL LOG';
                            else if (label.includes('jadlog')) transp = 'JADLOG';
                            updates.carrier_name = transp;
                        }

                        if (Object.keys(updates).length > 0) {
                            await supabase.from('guides').update(updates).eq('id', g.id);
                            resultado.vnda.guiasEnriquecidas++;
                        }
                    }
                }
            }
        } catch (vErr) {
            console.error(`[AutoSync] Erro na sincronização Vnda:`, vErr.message);
            resultado.mensagem += ` Vnda: ${vErr.message};`;
        }
    }

    // Monta resumo amigável
    if (!resultado.mensagem) {
        if (resultado.microvix.comDifal > 0) {
            resultado.mensagem = `Sucesso: ${resultado.microvix.comDifal} nova(s) nota(s) com DIFAL importadas e aguardando sua autorização no painel!`;
        } else if (resultado.microvix.novas > 0) {
            resultado.mensagem = `${resultado.microvix.novas} nota(s) nova(s) lidas, mas nenhuma possui DIFAL interestadual.`;
        } else {
            resultado.mensagem = `Tudo atualizado! Todas as notas do dia já foram emitidas anteriormente.`;
        }
    }

    return resultado;
}

/**
 * Inicia o Agendador Automático periódico
 */
function iniciarAgendador(supabase, runBatchProcessFn, intervaloMinutos = 30) {
    if (cronTimer) clearInterval(cronTimer);

    syncState.intervaloMinutos = intervaloMinutos;
    syncState.ativo = true;
    console.log(`[AutoSync] Agendador automático iniciado! Intervalo: a cada ${intervaloMinutos} minutos.`);

    const executarCiclo = async () => {
        syncState.status = 'executando';
        try {
            // Busca tenants ativos com Microvix ou Vnda configurados
            const { data: tenants, error } = await supabase
                .from('tenants')
                .select('*')
                .eq('status', 'ativo')
                .or('microvix_key.not.is.null,vnda_token_encrypted.not.is.null');

            if (error || !tenants || tenants.length === 0) {
                // Fallback para buscar tenant Lalua especificamente se o filtro retornar vazio
                const { data: lalua } = await supabase
                    .from('tenants')
                    .select('*')
                    .eq('cnpj', '10436619000105')
                    .single();

                if (lalua) {
                    const res = await sincronizarTenant(lalua, supabase, runBatchProcessFn);
                    syncState.ultimaExecucao = new Date().toISOString();
                    syncState.status = 'sucesso';
                    syncState.mensagem = res.mensagem;
                    syncState.historico.unshift(res);
                    if (syncState.historico.length > 20) syncState.historico.pop();
                }
                return;
            }

            for (const tenant of tenants) {
                const res = await sincronizarTenant(tenant, supabase, runBatchProcessFn);
                syncState.ultimaExecucao = new Date().toISOString();
                syncState.status = 'sucesso';
                syncState.mensagem = res.mensagem;
                syncState.historico.unshift(res);
                if (syncState.historico.length > 20) syncState.historico.pop();
            }
        } catch (err) {
            console.error(`[AutoSync] Falha no ciclo do agendador:`, err.message);
            syncState.status = 'erro';
            syncState.mensagem = 'Erro no ciclo automático: ' + err.message;
        }
    };

    // Executa a primeira checagem após 5 segundos da inicialização
    setTimeout(executarCiclo, 5000);

    // E repete a cada X minutos
    cronTimer = setInterval(executarCiclo, intervaloMinutos * 60 * 1000);
}

function obterStatus() {
    return {
        ...syncState,
        proximaExecucao: syncState.ultimaExecucao 
            ? new Date(new Date(syncState.ultimaExecucao).getTime() + syncState.intervaloMinutos * 60 * 1000).toISOString()
            : null
    };
}

module.exports = {
    sincronizarTenant,
    iniciarAgendador,
    obterStatus
};
