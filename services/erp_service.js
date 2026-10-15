// services/erp_service.js
// Conectores REST para importação automática de Notas Fiscais via ERPs (Bling, Tiny ERP, Omie)

const https = require('https');

/**
 * Utilitário HTTP genérico para APIs REST
 */
function requestJson(url, options = {}, postData = null) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const reqOpts = {
            hostname: parsed.hostname,
            path: parsed.pathname + (parsed.search || ''),
            method: options.method || 'GET',
            headers: options.headers || {}
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
                        reject(new Error(json.error?.message || json.mensagem || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
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
        if (postData) {
            req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
        }
        req.end();
    });
}

/**
 * 1. CONECTOR BLING (API v3)
 * @param {String} accessToken Token OAuth2 ou API Key
 * @param {String} dataInicial YYYY-MM-DD
 * @param {String} dataFim YYYY-MM-DD
 * @returns {Promise<Array>} Lista de objetos { documento, chave_nfe, xml }
 */
async function consultarNFeBling(accessToken, dataInicial, dataFim) {
    if (!accessToken) throw new Error("Token de acesso do Bling não configurado.");

    // 1. Busca lista de notas fiscais de saída emitidas no período
    const urlBusca = `https://api.bling.com.br/Api/v3/nfe?dataEmissaoInicial=${dataInicial}&dataEmissaoFinal=${dataFim}&tipo=1`;
    const resBusca = await requestJson(urlBusca, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
        }
    });

    const notas = resBusca.data || [];
    const resultados = [];

    // 2. Para cada nota emitida, recupera o XML oficial assinado
    for (const nota of notas) {
        if (!nota.chaveAcesso) continue;
        try {
            const urlXml = `https://api.bling.com.br/Api/v3/nfe/documento/${nota.chaveAcesso}?formato=xml`;
            const xmlContent = await requestJson(urlXml, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/xml, text/xml, */*'
                }
            });

            if (typeof xmlContent === 'string' && xmlContent.includes('<infNFe')) {
                resultados.push({
                    documento: String(nota.numero),
                    chave_nfe: nota.chaveAcesso,
                    xml: xmlContent
                });
            }
        } catch (e) {
            console.warn(`[Bling] Não foi possível baixar XML da NF ${nota.numero}:`, e.message);
        }
    }

    return resultados;
}

/**
 * 2. CONECTOR TINY ERP (API 2.0 / Olist)
 * @param {String} apiToken Token da API gerado no Tiny
 * @param {String} dataInicial DD/MM/YYYY
 * @param {String} dataFim DD/MM/YYYY
 * @returns {Promise<Array>} Lista de objetos { documento, chave_nfe, xml }
 */
async function consultarNFeTiny(apiToken, dataInicial, dataFim) {
    if (!apiToken) throw new Error("API Token do Tiny ERP não configurado.");

    // Formata datas para o padrão do Tiny DD/MM/YYYY
    const formatarDataTiny = (dStr) => {
        if (dStr && dStr.includes('-')) {
            const [ano, mes, dia] = dStr.split('-');
            return `${dia}/${mes}/${ano}`;
        }
        return dStr;
    };

    const dIni = formatarDataTiny(dataInicial);
    const dFim = formatarDataTiny(dataFim);

    // 1. Pesquisa notas fiscais de saída
    const urlPesquisa = `https://api.tiny.com.br/api2/notas.fiscais.pesquisa.php?token=${apiToken}&dataEmissaoInicial=${dIni}&dataEmissaoFinal=${dFim}&tipo=S&formato=json`;
    const resPesquisa = await requestJson(urlPesquisa);

    if (resPesquisa.retorno?.status !== 'OK') {
        throw new Error(resPesquisa.retorno?.erros?.[0]?.erro || "Falha na consulta de notas do Tiny.");
    }

    const notas = resPesquisa.retorno.notas_fiscais || [];
    const resultados = [];

    // 2. Para cada nota, busca o XML correspondente
    for (const item of notas) {
        const nota = item.nota_fiscal;
        if (!nota || !nota.id) continue;

        try {
            const urlXml = `https://api.tiny.com.br/api2/nota.fiscal.obter.xml.php?token=${apiToken}&id=${nota.id}&formato=json`;
            const resXml = await requestJson(urlXml);

            if (resXml.retorno?.status === 'OK' && resXml.retorno.xml_nfe) {
                let xmlDecodificado = resXml.retorno.xml_nfe;
                // Se estiver em base64, converte
                if (!xmlDecodificado.startsWith('<') && !xmlDecodificado.startsWith('<?xml')) {
                    xmlDecodificado = Buffer.from(xmlDecodificado, 'base64').toString('utf-8');
                }

                resultados.push({
                    documento: String(nota.numero),
                    chave_nfe: nota.chave_acesso || '',
                    xml: xmlDecodificado
                });
            }
        } catch (e) {
            console.warn(`[Tiny] Erro ao obter XML da NF ${nota.numero}:`, e.message);
        }
    }

    return resultados;
}

/**
 * 3. CONECTOR OMIE ERP
 * @param {String} appKey Chave da Aplicação Omie
 * @param {String} appSecret Segredo da Aplicação Omie
 * @param {String} dataInicial DD/MM/YYYY
 * @param {String} dataFim DD/MM/YYYY
 */
async function consultarNFeOmie(appKey, appSecret, dataInicial, dataFim) {
    if (!appKey || !appSecret) throw new Error("Credenciais Omie (App Key / Secret) não configuradas.");

    const url = 'https://app.omie.com.br/api/v1/produtos/nfconsultar/';
    const body = {
        call: "ListarNF",
        app_key: appKey,
        app_secret: appSecret,
        param: [{
            pagina: 1,
            registros_por_pagina: 50,
            dEmiInicial: dataInicial,
            dEmiFinal: dataFim,
            tpNF: "1" // Saída
        }]
    };

    const res = await requestJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, body);

    const notas = res.pedidos_nf || [];
    const resultados = [];

    for (const n of notas) {
        if (n.cChaveNFe && n.cXmlNFe) {
            resultados.push({
                documento: String(n.nNF),
                chave_nfe: n.cChaveNFe,
                xml: n.cXmlNFe
            });
        }
    }

    return resultados;
}

module.exports = {
    consultarNFeBling,
    consultarNFeTiny,
    consultarNFeOmie
};
