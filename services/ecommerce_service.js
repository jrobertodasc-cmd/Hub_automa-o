// services/ecommerce_service.js
// Orquestrador de Alta Performance do Cockpit E-commerce & Vendas 360° (Vnda + Linx + DIFAL + Devoluções)
// Suporta pedidos multi-peças, agrupamento por pedido e agrupamento por cliente

const https = require('https');
const crypto = require('crypto');

function getEncryptionKey(keyStr) {
    return crypto.createHash('sha256').update(String(keyStr)).digest();
}

function decrypt(text, secretKey) {
    const str = String(text || '');
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
        try {
            return tryDecryptWithKey(getEncryptionKey('d7b5f12a893e4b0c7a6d9f8e5c3b2a10'));
        } catch {
            return tryDecryptWithKey(getEncryptionKey('expedi_default_secret_key_32_bytes_long!!'));
        }
    }
}

// Executador concorrente com limite para altíssima performance
async function mapConcurrent(items, limit, fn) {
    if (!items || items.length === 0) return [];
    const results = new Array(items.length);
    let index = 0;
    const workerCount = Math.min(limit, items.length);
    const workers = new Array(workerCount).fill(0).map(async () => {
        while (index < items.length) {
            const currentIdx = index++;
            try {
                results[currentIdx] = await fn(items[currentIdx], currentIdx);
            } catch (err) {
                results[currentIdx] = null;
            }
        }
    });
    await Promise.all(workers);
    return results;
}

// Cache local em memória de produtos e fotos por SKU
const vndaProductCache = new Map();
// Cache em memória de XMLs parseados
const xmlParsedCache = new Map();

/**
 * Consulta catálogo da Vnda para obter foto e dados reais do produto por SKU de variante
 */
async function buscarInfoProdutoVnda(token, shopHost, skuOuRef) {
    if (!skuOuRef) return null;
    const cleanKey = String(skuOuRef).trim().toUpperCase();
    if (vndaProductCache.has(cleanKey)) {
        return vndaProductCache.get(cleanKey);
    }

    try {
        // Na Vnda / Olist, cada SKU faturado pela Linx Microvix corresponde diretamente ao SKU da variante (cor/tamanho)
        // Endpoint oficial: GET /api/v2/variants/:sku
        const path = `/api/v2/variants/${encodeURIComponent(cleanKey)}`;
        const res = await new Promise((resolve) => {
            const req = https.request({
                hostname: 'api.vnda.com.br',
                path: path,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Shop-Host': shopHost || 'www.boah.com.br',
                    'User-Agent': 'BoahFiscal/1.0',
                    'Accept': 'application/json'
                }
            }, (response) => {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    if (response.statusCode === 200) {
                        try {
                            const variant = JSON.parse(data);
                            resolve(variant);
                        } catch {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.setTimeout(2500, () => { req.destroy(); resolve(null); });
            req.end();
        });

        if (res) {
            let pictureUrl = res.image_url || null;
            if (!pictureUrl && res.images && res.images.length > 0) {
                pictureUrl = res.images[0].url || res.images[0].small_url;
            }

            // Fallback caso a variante herde foto do produto pai
            if (!pictureUrl && res.product_id) {
                const prodData = await new Promise((resolve) => {
                    const req = https.request({
                        hostname: 'api.vnda.com.br',
                        path: `/api/v2/products/${res.product_id}`,
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'X-Shop-Host': shopHost || 'www.boah.com.br',
                            'User-Agent': 'BoahFiscal/1.0',
                            'Accept': 'application/json'
                        }
                    }, (response) => {
                        let data = '';
                        response.on('data', chunk => data += chunk);
                        response.on('end', () => {
                            if (response.statusCode === 200) {
                                try { resolve(JSON.parse(data)); } catch { resolve(null); }
                            } else { resolve(null); }
                        });
                    });
                    req.on('error', () => resolve(null));
                    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
                    req.end();
                });
                if (prodData && prodData.images && prodData.images.length > 0) {
                    pictureUrl = prodData.images[0].url;
                }
            }

            if (pictureUrl && pictureUrl.startsWith('//')) {
                pictureUrl = 'https:' + pictureUrl;
            }

            const info = {
                name: res.name || res.title,
                sku: cleanKey,
                picture_url: pictureUrl,
                price: res.price || res.sale_price,
                url: res.slug ? `https://${shopHost || 'www.boah.com.br'}/produto/${res.slug}` : null
            };
            vndaProductCache.set(cleanKey, info);
            return info;
        }
    } catch {
        // Silêncio em caso de falha de rede externa
    }
    return null;
}

/**
 * Extrai dados do cliente e TODOS os itens/peças a partir do XML da NF-e no Storage
 */
async function extrairDadosXmlStorage(supabase, xmlStoragePath) {
    if (!xmlStoragePath) return null;
    if (xmlParsedCache.has(xmlStoragePath)) {
        return xmlParsedCache.get(xmlStoragePath);
    }

    try {
        const { data: file, error } = await supabase.storage.from('tenant-storage').download(xmlStoragePath);
        if (error || !file) return null;

        const xml = await file.text();
        const vNF = parseFloat(xml.match(/<vNF>(.*?)<\/vNF>/)?.[1] || '0');
        const xNome = xml.match(/<dest>[\s\S]*?<xNome>(.*?)<\/xNome>/)?.[1] || '';
        const xMun = xml.match(/<dest>[\s\S]*?<xMun>(.*?)<\/xMun>/)?.[1] || '';
        const uf = xml.match(/<dest>[\s\S]*?<UF>(.*?)<\/UF>/)?.[1] || '';

        // Extrai todas as tags <det nItem="..."> da NF-e
        const detRegex = /<det\s+nItem="(\d+)">([\s\S]*?)<\/det>/g;
        let match;
        const itens = [];
        while ((match = detRegex.exec(xml)) !== null) {
            const detXml = match[2];
            const cProd = detXml.match(/<cProd>(.*?)<\/cProd>/)?.[1] || '';
            const xProd = detXml.match(/<xProd>(.*?)<\/xProd>/)?.[1] || '';
            const qCom = parseFloat(detXml.match(/<qCom>(.*?)<\/qCom>/)?.[1] || '1');
            const vUnCom = parseFloat(detXml.match(/<vUnCom>(.*?)<\/vUnCom>/)?.[1] || '0');
            const vProd = parseFloat(detXml.match(/<vProd>(.*?)<\/vProd>/)?.[1] || '0');
            if (cProd || xProd) {
                itens.push({
                    item_num: parseInt(match[1]),
                    sku: cProd,
                    descricao: xProd,
                    quantidade: qCom,
                    preco_unitario: vUnCom,
                    preco_total: vProd,
                    foto_url: null
                });
            }
        }

        // Fallback caso a regex de det não case
        if (itens.length === 0) {
            const cProd = xml.match(/<cProd>(.*?)<\/cProd>/)?.[1] || '';
            const xProd = xml.match(/<xProd>(.*?)<\/xProd>/)?.[1] || '';
            const vProd = parseFloat(xml.match(/<vProd>(.*?)<\/vProd>/)?.[1] || '0');
            if (cProd || xProd) {
                itens.push({
                    item_num: 1,
                    sku: cProd,
                    descricao: xProd,
                    quantidade: 1,
                    preco_unitario: vProd,
                    preco_total: vProd,
                    foto_url: null
                });
            }
        }

        const parsed = {
            customer_name: xNome,
            cidade: xMun,
            uf,
            vNF,
            itens
        };
        xmlParsedCache.set(xmlStoragePath, parsed);
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Monta o Cockpit 360° para as guias do lote ativo agrupando por Pedido e Cliente
 */
async function gerarCockpit360(supabase, tenant, batchId) {
    // 1. Busca as guias do lote
    const { data: guides, error: gErr } = await supabase
        .from('guides')
        .select('*')
        .eq('batch_id', batchId)
        .eq('tenant_id', tenant.id)
        .order('nf_number', { ascending: true });

    if (gErr) throw gErr;
    if (!guides || guides.length === 0) return { guias360: [], clientes360: [], resumo: {} };

    // 2. Descriptografa token Vnda
    let vndaToken = null;
    let shopHost = tenant.vnda_shop_host || 'www.boah.com.br';
    if (tenant.vnda_token_encrypted) {
        try {
            const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
            vndaToken = decrypt(tenant.vnda_token_encrypted, key);
        } catch (e) {
            console.warn('[Cockpit360] Não foi possível decifrar token Vnda:', e.message);
        }
    }

    // 3. Busca itens de faturamento (invoice_items) e notas de devolução em paralelo
    const nfList = guides.map(g => g.nf_number).filter(Boolean);
    const [itemsRes, returnNotesRes] = await Promise.all([
        supabase.from('invoice_items').select('*').eq('tenant_id', tenant.id).in('nf_number', nfList),
        supabase.from('return_notes').select('*').eq('tenant_id', tenant.id).in('nf_original_number', nfList)
    ]);

    const itemsPorNf = new Map();
    (itemsRes.data || []).forEach(it => {
        if (!itemsPorNf.has(it.nf_number)) itemsPorNf.set(it.nf_number, []);
        itemsPorNf.get(it.nf_number).push({
            item_num: it.item_number || 1,
            sku: it.product_code,
            descricao: it.product_description,
            quantidade: it.quantity || 1,
            preco_unitario: parseFloat(it.unit_price || 0),
            preco_total: parseFloat(it.total_price || 0),
            foto_url: null
        });
    });

    const devolucoesPorNf = new Map();
    (returnNotesRes.data || []).forEach(rn => {
        devolucoesPorNf.set(rn.nf_original_number, rn);
    });

    // 4. Download concorrente dos XMLs faltantes (Pool de 12 downloads simultâneos)
    const guiasPrecisandoXml = guides.filter(g => (!itemsPorNf.has(g.nf_number) || itemsPorNf.get(g.nf_number).length === 0) && g.xml_storage_path);
    const xmlResultsMap = new Map();

    await mapConcurrent(guiasPrecisandoXml, 12, async (g) => {
        const xmlData = await extrairDadosXmlStorage(supabase, g.xml_storage_path);
        if (xmlData) {
            xmlResultsMap.set(g.nf_number, xmlData);
        }
    });

    // 5. Coleta preliminar de SKUs únicos de TODAS as peças de todos os pedidos
    const skusUnicos = new Set();
    guides.forEach(g => {
        const itensDaNf = itemsPorNf.get(g.nf_number) || (xmlResultsMap.get(g.nf_number)?.itens || []);
        itensDaNf.forEach(it => {
            if (it.sku) skusUnicos.add(it.sku.trim().toUpperCase());
        });
    });

    // Pré-carrega fotos do catálogo Vnda concorrentemente (Pool de 8 consultas paralelas às variantes)
    if (vndaToken && skusUnicos.size > 0) {
        const listaSkus = Array.from(skusUnicos);
        await mapConcurrent(listaSkus, 8, async (sku) => {
            await buscarInfoProdutoVnda(vndaToken, shopHost, sku);
        });
    }

    // 6. Montagem do Cockpit consolidado por Pedido / NF-e
    const guias360 = [];
    let totalDifal = 0;
    let totalVenda = 0;
    let totalDevolucoesAlerta = 0;
    let economiaDifalDevolucoes = 0;
    let totalPecasGlobal = 0;

    for (const g of guides) {
        let itens = itemsPorNf.get(g.nf_number) || [];
        const devolucao = devolucoesPorNf.get(g.nf_number) || null;
        const valorDifal = parseFloat(g.value || 0);
        totalDifal += valorDifal;

        let clienteNome = g.customer_name;
        let cidadeDestino = g.customer_city || g.uf;
        let valorVendaNf = 0;

        if (itens.length === 0) {
            const xmlData = xmlResultsMap.get(g.nf_number);
            if (xmlData) {
                if (!clienteNome || clienteNome.includes('Cliente Boah')) clienteNome = xmlData.customer_name;
                if (!cidadeDestino || cidadeDestino === g.uf) cidadeDestino = xmlData.cidade;
                valorVendaNf = xmlData.vNF || 0;
                itens = xmlData.itens || [];
            }
        }

        // Calcula total de venda caso não tenha vNF
        if (!valorVendaNf || valorVendaNf === 0) {
            valorVendaNf = itens.reduce((acc, it) => acc + (it.preco_total || 0), 0);
        }
        totalVenda += valorVendaNf;

        // Associa foto real oficial e descrição da Vnda a CADA peça do pedido
        let totalPecasPedido = 0;
        itens.forEach(it => {
            totalPecasPedido += (it.quantidade || 1);
            if (it.sku) {
                const cleanKey = String(it.sku).trim().toUpperCase();
                const infoVnda = vndaProductCache.get(cleanKey);
                if (infoVnda && infoVnda.picture_url) {
                    it.foto_url = infoVnda.picture_url;
                    if (infoVnda.name && !it.descricao) {
                        it.descricao = infoVnda.name;
                    }
                }
            }
        });
        totalPecasGlobal += (totalPecasPedido || 1);

        // Status de alerta fiscal / e-commerce
        let statusAlerta = 'NORMAL';
        let alertaMensagem = null;
        if (devolucao || g.is_returned) {
            statusAlerta = 'DEVOLUCAO_IDENTIFICADA';
            alertaMensagem = `NF Devolução #${devolucao?.nf_return_number || g.return_nf_reference || 'S/N'}`;
            totalDevolucoesAlerta++;
            economiaDifalDevolucoes += valorDifal;
        }

        const pecaPrincipal = itens.length > 0 ? itens[0] : null;

        guias360.push({
            id: g.id,
            nf_number: g.nf_number,
            chave_nfe: g.chave_nfe,
            customer_name: clienteNome || 'Cliente E-commerce',
            uf: g.uf,
            cidade: cidadeDestino,
            order_number: g.order_number || `VD-${g.nf_number}`,
            carrier_name: g.carrier_name || 'Total Express',
            valor_venda: valorVendaNf,
            valor_difal: valorDifal,
            status_bancario: g.status, // paga, agendada, aguardando_pagamento
            paid_at: g.paid_at,
            barcode: g.barcode,
            danfe_url: `/api/guide/danfe/${g.id}`,
            gnre_url: (g.uf !== 'SP' && valorDifal > 0) ? `/api/guide/download/${g.id}` : null,
            is_sp: g.uf === 'SP',
            peca_principal: pecaPrincipal,
            itens: itens,
            total_pecas: totalPecasPedido || itens.length || 1,
            status_alerta: statusAlerta,
            alerta_mensagem: alertaMensagem,
            devolucao: devolucao
        });
    }

    // 7. Agrupamento consolidado por Cliente (Visão Cliente 360°)
    const clientesMap = new Map();
    guias360.forEach(g => {
        const key = (g.customer_name || 'Cliente Sem Nome').trim().toUpperCase();
        if (!clientesMap.has(key)) {
            clientesMap.set(key, {
                cliente_nome: g.customer_name,
                cidade: g.cidade,
                uf: g.uf,
                pedidos: [],
                todas_pecas: [],
                total_venda: 0,
                total_difal: 0,
                total_pecas: 0,
                status_bancario_geral: g.status_bancario,
                has_devolucao: false
            });
        }
        const c = clientesMap.get(key);
        c.pedidos.push(g);
        c.total_venda += g.valor_venda;
        c.total_difal += g.valor_difal;
        c.total_pecas += g.total_pecas;
        if (g.status_alerta === 'DEVOLUCAO_IDENTIFICADA') c.has_devolucao = true;
        // Adiciona peças do pedido
        (g.itens || []).forEach(it => c.todas_pecas.push(it));
    });

    const clientes360 = Array.from(clientesMap.values());

    return {
        guias360,
        clientes360,
        resumo: {
            totalGuias: guias360.length,
            totalPedidos: guias360.length,
            totalClientes: clientes360.length,
            totalPecas: totalPecasGlobal,
            totalVendas: totalVenda,
            totalDifal: totalDifal,
            totalDevolucoes: totalDevolucoesAlerta,
            economiaPotencialDifal: economiaDifalDevolucoes,
            lojaVirtual: shopHost,
            integracaoVndaAtiva: !!vndaToken
        }
    };
}

module.exports = {
    gerarCockpit360,
    buscarInfoProdutoVnda
};
