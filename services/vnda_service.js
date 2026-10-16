// services/vnda_service.js
// Conector oficial REST para a API v2 da Olist Vnda (E-commerce Boah)

const https = require('https');

const VNDA_HOST = 'api.vnda.com.br';

function requestVnda(path, token, shopHost, options = {}) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Authorization': `Bearer ${token}`,
            'X-Shop-Host': shopHost,
            'User-Agent': 'BoahFiscal/1.0',
            'Accept': 'application/json',
            ...(options.headers || {})
        };

        const reqOpts = {
            hostname: VNDA_HOST,
            path: path,
            method: options.method || 'GET',
            headers: headers
        };

        const req = https.request(reqOpts, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        reject(new Error(json.error || json.message || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                } catch (e) {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                    }
                }
            });
        });

        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

/**
 * 1. Lista os pedidos da loja com filtros
 */
async function listarPedidos(token, shopHost, params = {}) {
    let opts = {};
    if (typeof params === 'number') {
        opts = { page: params, per_page: arguments[3] || 50 };
    } else if (params && typeof params === 'object') {
        opts = { ...params };
    }

    let qs = new URLSearchParams();
    if (opts.status) qs.append('status', opts.status);
    qs.append('per_page', String(opts.per_page || 50));
    if (opts.page) qs.append('page', String(opts.page || 1));
    if (opts.type) qs.append('type', opts.type);
    
    // Parâmetros opcionais (só anexa se explicitamente configurado)
    if (opts.sort) qs.append('sort', opts.sort);
    if (opts.direction) qs.append('direction', opts.direction);

    const path = `/api/v2/orders?${qs.toString()}`;
    return await requestVnda(path, token, shopHost);
}

/**
 * 2. Busca os detalhes completos de um pedido pelo ID ou código (xPed)
 */
async function obterPedidoPorCodigo(token, shopHost, orderCode) {
    if (!orderCode) return null;
    const cleanCode = String(orderCode).trim();
    try {
        // Na API v2 da Vnda, o código alfanumérico do pedido é consultado diretamente na rota: /api/v2/orders/:code
        const pedido = await requestVnda(`/api/v2/orders/${encodeURIComponent(cleanCode)}`, token, shopHost);
        if (pedido && (pedido.id || pedido.code)) {
            return pedido;
        }
        return null;
    } catch (err) {
        // Se for 404 (pedido não existe na loja), retorna null silenciosamente
        return null;
    }
}

/**
 * 3. Busca o catálogo de produtos com imagens e SKUs
 */
async function listarProdutos(token, shopHost, perPage = 50) {
    return await requestVnda(`/api/v2/products?per_page=${perPage}`, token, shopHost);
}

/**
 * 4. Anexa a NF-e e a Guia GNRE ao pedido na VNDA
 */
async function anexarNfe(token, shopHost, orderId, { numero, chave, urlDanfe, urlGuia }) {
    const payload = {
        invoice: {
            number: String(numero),
            key: chave,
            danfe_url: urlDanfe || null,
            gnre_url: urlGuia || null
        }
    };

    return await requestVnda(`/api/v2/orders/${orderId}/invoices`, token, shopHost, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
    });
}

module.exports = {
    listarPedidos,
    obterPedidoPorCodigo,
    listarProdutos,
    anexarNfe
};
