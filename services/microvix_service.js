// services/microvix_service.js
// Encapsula a integração com o WebAPI da Linx Microvix (B2CConsultaNFe)
// Retorna os XMLs de NF-e completos para processamento de DIFAL/GNRE.

const https = require('https');
const http  = require('http');

const MICROVIX_ENDPOINT = 'https://webapi.microvix.com.br/1.0/api/integracao';

/**
 * Monta o envelope XML para o comando B2CConsultaNFe.
 */
function buildRequestXml({ user, password, chave, cnpjEmp, dataInicial, dataFim, timestamp = 0 }) {
    return `<?xml version="1.0" encoding="utf-8"?>
<LinxMicrovix>
    <Authentication user="${user}" password="${password}" />
    <ResponseFormat>json</ResponseFormat>
    <Command>
        <Name>B2CConsultaNFe</Name>
        <Parameters>
            <Parameter id="chave">${chave}</Parameter>
            <Parameter id="cnpjEmp">${cnpjEmp}</Parameter>
            <Parameter id="data_inicial">${dataInicial}</Parameter>
            <Parameter id="data_fim">${dataFim}</Parameter>
            <Parameter id="timestamp">${timestamp}</Parameter>
        </Parameters>
    </Command>
</LinxMicrovix>`;
}

/**
 * Faz a chamada HTTP POST para o WebAPI da Linx Microvix.
 * @returns {Promise<string>} Corpo da resposta em texto (JSON serializado pela Linx)
 */
function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            path:     parsed.pathname + (parsed.search || ''),
            method:   'POST',
            headers: {
                'Content-Type':   'text/xml; charset=utf-8',
                'Content-Length': Buffer.byteLength(body, 'utf8')
            }
        };

        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`Linx Microvix retornou HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Timeout na chamada para Linx Microvix (30s)'));
        });

        req.write(body, 'utf8');
        req.end();
    });
}

/**
 * Consulta NF-e no Linx Microvix usando o comando B2CConsultaNFe.
 *
 * @param {object} credentials - Credenciais do tenant { user, password, chave, cnpjEmp }
 * @param {string} dataInicial - Data inicial AAAA-MM-DD
 * @param {string} dataFim     - Data final AAAA-MM-DD
 * @param {number} timestamp   - Timestamp incremental (0 para buscar tudo)
 * @returns {Promise<Array>}   - Array de objetos { documento, chave_nfe, nProt, data_emissao, valor_nota, xml, timestamp }
 */
async function consultarNFe({ user, password, chave, cnpjEmp }, dataInicial, dataFim, timestamp = 0) {
    const xmlBody = buildRequestXml({ user, password, chave, cnpjEmp, dataInicial, dataFim, timestamp });
    const rawResponse = await httpPost(MICROVIX_ENDPOINT, xmlBody);

    let parsed;
    try {
        // A Linx retorna o JSON embrulhado em um envelope; tentamos parsear diretamente.
        parsed = JSON.parse(rawResponse);
    } catch {
        // Às vezes vem com BOM ou wrapper XML – tenta extrair JSON interno
        const jsonMatch = rawResponse.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        if (!jsonMatch) {
            throw new Error('Resposta da Linx Microvix não é JSON válido: ' + rawResponse.substring(0, 300));
        }
        parsed = JSON.parse(jsonMatch[1]);
    }

    // A API pode retornar um array diretamente ou dentro de ResponseData / data
    const notas = Array.isArray(parsed)
        ? parsed
        : (parsed.ResponseData || parsed.data || parsed.notas || parsed.result || []);

    if (!Array.isArray(notas)) {
        throw new Error('Estrutura de resposta da Linx inesperada: ' + JSON.stringify(parsed).substring(0, 300));
    }

    // Normaliza os campos para nomes padronizados
    return notas.map(n => ({
        documento:    String(n.documento   || n.nNF       || '').trim(),
        chave_nfe:    String(n.chave_nfe   || n.chaveNFe  || '').trim(),
        nProt:        String(n.nProt       || n.protocolo || '').trim(),
        data_emissao: String(n.data_emissao || n.dhEmi    || '').trim(),
        valor_nota:   parseFloat(n.valor_nota || n.vNF    || 0),
        xml:          String(n.xml || '').trim(),
        timestamp:    Number(n.timestamp   || 0)
    })).filter(n => n.xml && n.xml.length > 100); // Descarta entradas sem XML
}

module.exports = { consultarNFe };
