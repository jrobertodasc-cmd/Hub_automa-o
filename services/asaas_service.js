// services/asaas_service.js
// Conector oficial com a API v3 do Asaas para Pagamento de Contas e Tributos (Pague Contas)
// Suporta ambiente de Produção, Sandbox e Modo Simulado de Homologação.

const https = require('https');
const http = require('http');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const ASAAS_PROD_URL = 'https://api.asaas.com/v3';
const ASAAS_SANDBOX_URL = 'https://api-sandbox.asaas.com/v3';

function getBaseUrl(env) {
    if (env === 'producao' || env === 'production') {
        return ASAAS_PROD_URL;
    }
    return ASAAS_SANDBOX_URL;
}

/**
 * Executa requisição HTTP para a API do Asaas
 */
function requestAsaas(endpoint, method, apiKey, body = null, env = 'sandbox') {
    return new Promise((resolve, reject) => {
        const baseUrl = getBaseUrl(env);
        const fullUrl = new URL(baseUrl + endpoint);

        const headers = {
            'User-Agent': 'expediHUB/2.0',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'access_token': apiKey
        };

        const postData = body ? JSON.stringify(body) : null;
        if (postData) {
            headers['Content-Length'] = Buffer.byteLength(postData, 'utf8');
        }

        const options = {
            hostname: fullUrl.hostname,
            path: fullUrl.pathname + fullUrl.search,
            method: method.toUpperCase(),
            headers: headers,
            timeout: 25000
        };

        const lib = fullUrl.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        const errMsg = json.errors?.[0]?.description || json.message || `HTTP ${res.statusCode}: ${data.substring(0, 200)}`;
                        const err = new Error(errMsg);
                        err.statusCode = res.statusCode;
                        err.details = json;
                        reject(err);
                    }
                } catch {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        const err = new Error(`Erro HTTP ${res.statusCode} na API Asaas: ${data.substring(0, 200)}`);
                        err.statusCode = res.statusCode;
                        reject(err);
                    }
                }
            });
        });

        req.on('error', (err) => {
            const wrapped = new Error('Falha de conexão com Asaas: ' + err.message);
            wrapped.isNetworkOrTimeout = true;
            reject(wrapped);
        });
        req.setTimeout(25000, () => {
            req.destroy();
            const timeoutErr = new Error('Timeout de comunicação com API Asaas (25s)');
            timeoutErr.isNetworkOrTimeout = true;
            reject(timeoutErr);
        });

        if (postData) req.write(postData);
        req.end();
    });
}

/**
 * 1. Consulta o Saldo da Conta Asaas
 */
async function obterSaldo(apiKey, env = 'sandbox') {
    if (env === 'simulado') {
        return {
            balance: 10000.00,
            simulado: true,
            mensagem: 'Modo Simulado: Saldo virtual disponível apenas para homologação.'
        };
    }

    if (!apiKey) {
        throw new Error('Chave de API do Asaas não configurada.');
    }

    try {
        const res = await requestAsaas('/finance/balance', 'GET', apiKey, null, env);
        return {
            balance: parseFloat(res.balance || 0),
            simulado: false
        };
    } catch (err) {
        console.error('[Asaas] Erro ao obter saldo:', err.message);
        throw err;
    }
}

/**
 * 2. Simula o Pagamento de uma Conta / Tributo (Validação prévia da linha digitável)
 */
async function simularPagamento(identificationField, apiKey, env = 'sandbox') {
    const cleanLine = String(identificationField || '').replace(/[^0-9]/g, '');
    if (!cleanLine || cleanLine.length < 44) {
        throw new Error('Linha digitável ou código de barras da guia inválido para pagamento.');
    }

    if (env === 'simulado') {
        return {
            canBePaid: true,
            value: 0,
            identificationField: cleanLine,
            description: 'Simulação de GNRE / DUA-e aprovada no ambiente simulado.',
            simulated: true
        };
    }

    if (!apiKey) {
        throw new Error('Chave de API do Asaas ausente para validação bancária.');
    }

    return await requestAsaas('/bill/simulate', 'POST', apiKey, { identificationField: cleanLine }, env);
}

/**
 * 3. Cria a solicitação de Pagamento da Guia (Pague Contas)
 */
async function pagarGuia({ identificationField, value, description, externalReference, dueDate }, apiKey, env = 'sandbox') {
    const cleanLine = String(identificationField || '').replace(/[^0-9]/g, '');
    if (!cleanLine || cleanLine.length < 44) {
        throw new Error('Código de barras/linha digitável inválido (mínimo 44 dígitos numéricos oficiais) para envio ao Asaas.');
    }

    if (env === 'simulado') {
        const simulatedBillId = 'bill_sim_' + Math.floor(10000000 + Math.random() * 90000000);
        return {
            id: simulatedBillId,
            status: 'PENDING',
            value: parseFloat(value || 0),
            identificationField: cleanLine,
            description: description || 'Pagamento DIFAL GNRE (Simulado)',
            externalReference: externalReference,
            simulated: true,
            scheduledDate: new Date().toISOString().split('T')[0]
        };
    }

    if (!apiKey) {
        throw new Error('Chave de API do Asaas obrigatória para pagamento real.');
    }

    const payload = {
        identificationField: cleanLine,
        value: parseFloat(value),
        description: description || 'Pagamento DIFAL GNRE',
        externalReference: String(externalReference || ''),
        dueDate: dueDate || new Date().toISOString().split('T')[0]
    };

    return await requestAsaas('/bill', 'POST', apiKey, payload, env);
}

/**
 * 4. Consulta o Status de um Pagamento
 */
async function consultarPagamento(billId, apiKey, env = 'sandbox') {
    if (!billId) throw new Error('ID do pagamento Asaas não informado.');

    if (env === 'simulado' || String(billId).startsWith('bill_sim_')) {
        return {
            id: billId,
            status: 'PAID',
            value: 0,
            simulated: true,
            transactionReceiptUrl: null
        };
    }

    if (!apiKey) {
        throw new Error('Chave de API do Asaas ausente para consulta de pagamento.');
    }

    return await requestAsaas(`/bill/${encodeURIComponent(billId)}`, 'GET', apiKey, null, env);
}

/**
 * Valida se uma URL externa de comprovante pertence a domínios confiáveis (prevenção de SSRF)
 */
function isTrustedReceiptUrl(urlStr) {
    try {
        const parsed = new URL(urlStr);
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        if (
            host === 'asaas.com' ||
            host.endsWith('.asaas.com') ||
            host.endsWith('.amazonaws.com') ||
            host.endsWith('.supabase.co')
        ) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * 5. Baixa o Comprovante Oficial em PDF da URL informada pelo Asaas (com proteção SSRF e limite de redirects)
 */
function downloadExternalPdf(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        if (!isTrustedReceiptUrl(url)) {
            return reject(new Error('URL de comprovante rejeitada por política de segurança (domínio não confiável).'));
        }
        if (redirectsLeft < 0) {
            return reject(new Error('Limite máximo de redirecionamentos excedido ao baixar comprovante.'));
        }

        const req = https.get(url, { timeout: 20000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, url).toString();
                return downloadExternalPdf(nextUrl, redirectsLeft - 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Falha ao baixar comprovante oficial (HTTP ${res.statusCode})`));
            }
            const chunks = [];
            let totalBytes = 0;
            const MAX_BYTES = 10 * 1024 * 1024; // 10MB
            res.on('data', c => {
                totalBytes += c.length;
                if (totalBytes > MAX_BYTES) {
                    req.destroy();
                    return reject(new Error('Arquivo de comprovante excede o tamanho máximo permitido (10MB).'));
                }
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout ao baixar PDF de comprovante externo.'));
        });
        req.on('error', reject);
    });
}

/**
 * 6. Gera Comprovante de Homologação em PDF (USO EXCLUSIVO EM AMBIENTE SIMULADO/SANDBOX)
 * Nunca deve ser chamado em Produção nem apresentar aparência de recibo SISBACEN real.
 */
async function gerarComprovanteSimuladoPdf(params = {}, maybeGuide = null) {
    // Suporte defensivo caso chamado com (tenant, guide)
    let nfNumber, uf, valor, billId, dataPagamento, razaoSocial, environment;
    if (maybeGuide) {
        environment = params?.environment;
        razaoSocial = params?.razao_social || params?.razaoSocial;
        nfNumber = maybeGuide.nf_number || maybeGuide.documentoOrigem;
        uf = maybeGuide.uf || maybeGuide.ufFavorecida;
        valor = maybeGuide.value || maybeGuide.valor;
        billId = maybeGuide.asaas_bill_id;
        dataPagamento = maybeGuide.paid_at;
    } else {
        ({ nfNumber, uf, valor, billId, dataPagamento, razaoSocial, environment } = params);
    }

    if (environment === 'producao' || environment === 'production') {
        throw new Error('PROIBIDO: Geração de comprovante simulado bloqueada em ambiente de Produção.');
    }

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const vermelhoAlerta = rgb(0.75, 0.1, 0.1);
    const cinzaTexto = rgb(0.2, 0.25, 0.3);

    // Faixa superior de aviso de simulação
    page.drawRectangle({
        x: 40,
        y: 735,
        width: 515,
        height: 65,
        color: rgb(1.0, 0.94, 0.94)
    });

    page.drawText('DEMONSTRAÇÃO DE HOMOLOGAÇÃO — SEM VALOR FISCAL OU BANCÁRIO', {
        x: 55,
        y: 772,
        size: 11.5,
        font: fontBold,
        color: vermelhoAlerta
    });

    page.drawText('Ambiente Simulado de Testes — NÃO UTILIZAR PARA LIBERAÇÃO DE CARGA REAL', {
        x: 55,
        y: 752,
        size: 9.5,
        font: fontBold,
        color: vermelhoAlerta
    });

    // Tag de Status Simulado
    page.drawRectangle({
        x: 40,
        y: 685,
        width: 515,
        height: 35,
        color: rgb(0.98, 0.95, 0.88)
    });

    page.drawText('[SIMULAÇÃO] PAGAMENTO FICTÍCIO DE TESTE (AMBIENTE NÃO PRODUTIVO)', {
        x: 55,
        y: 698,
        size: 10.5,
        font: fontBold,
        color: vermelhoAlerta
    });

    const campos = [
        ['Empresa (Teste):', razaoSocial || 'EMPRESA EM HOMOLOGAÇÃO'],
        ['Documento Vinculado:', `NF-e Nº ${nfNumber || 'N/A'} (UF: ${uf || 'N/A'})`],
        ['Valor Simulado:', `R$ ${parseFloat(valor || 0).toFixed(2).replace('.', ',')}`],
        ['Data da Simulação:', dataPagamento || new Date().toLocaleString('pt-BR')],
        ['ID Simulado:', billId || 'bill_sim_teste'],
        ['Autenticação Bancária:', 'SIMULACAO-SEM-AUTENTICACAO-BANCARIA']
    ];

    let yPos = 645;
    for (const [rotulo, valorCampo] of campos) {
        page.drawText(rotulo, {
            x: 55,
            y: yPos,
            size: 10,
            font: fontBold,
            color: cinzaTexto
        });

        page.drawText(String(valorCampo), {
            x: 230,
            y: yPos,
            size: 10,
            font: fontRegular,
            color: cinzaTexto
        });

        page.drawLine({
            start: { x: 55, y: yPos - 8 },
            end: { x: 540, y: yPos - 8 },
            thickness: 0.5,
            color: rgb(0.88, 0.9, 0.92)
        });

        yPos -= 32;
    }

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

module.exports = {
    obterSaldo,
    simularPagamento,
    pagarGuia,
    consultarPagamento,
    downloadExternalPdf,
    gerarComprovanteSimuladoPdf
};
