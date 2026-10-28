// services/total_express_service.js
// Conector oficial da API Smart Label da Total Express
// Responsável pelo registro de encomendas, obtenção de AWB/Rota e geração da Etiqueta Térmica 10x15cm.

const https = require('https');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const ENDPOINTS = {
    smartlabel: {
        producao: 'https://apis.totalexpress.com.br/ics-edi-lv/v1/coleta/smartlabel/registrar',
        homologacao: 'https://apis-qa.totalexpress.com.br/ics-edi-lv/v1/coleta/smartLabel/registrar'
    },
    tracking: {
        producao: 'https://apis.totalexpress.com.br/ics-tracking-encomenda-lv/v1/tracking',
        homologacao: 'https://apis-qa.totalexpress.com.br/ics-tracking-encomenda-lv/v1/tracking'
    },
    producao: 'https://apis.totalexpress.com.br/ics-edi-lv/v1/coleta/smartlabel/registrar',
    homologacao: 'https://apis-qa.totalexpress.com.br/ics-edi-lv/v1/coleta/smartLabel/registrar'
};

/**
 * Monta o cabeçalho de autenticação Basic Auth em Base64
 */
function getBasicAuthHeader(user, password) {
    const credentials = `${user}:${password}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

/**
 * Monta o payload JSON oficial da Smart Label a partir dos dados da NF-e e remetente
 */
function montarPayloadSmartLabel(dadosNfe, config) {
    const cnpjRemetente = (config.cnpj || '10436619000105').replace(/\D/g, '');
    const numNf = String(dadosNfe.documentoOrigem || dadosNfe.nfNumero || '').trim();
    const chaveNfe = String(dadosNfe.chaveAcessoNfe || dadosNfe.chave_nfe || '').replace(/\D/g, '');
    
    // Tratamento de endereço
    const cepDest = String(dadosNfe.destCep || '').replace(/\D/g, '').padStart(8, '0');
    const cpfCnpjDest = String(dadosNfe.destCnpjCpf || '').replace(/\D/g, '');
    const ufDest = String(dadosNfe.ufFavorecida || dadosNfe.destUF || 'BA').toUpperCase().substring(0, 2);

    return {
        remetenteId: parseInt(config.remetenteId || 0, 10),
        cnpj: cnpjRemetente,
        remessaCodigo: `REM_${numNf}_${Date.now()}`.substring(0, 20),
        encomendas: [
            {
                servicoTipo: parseInt(config.servicoTipo || 1, 10), // 1 = Standard / 7 = Expresso
                servicoTipoInfo: config.servicoTipoInfo || undefined,
                entregaTipo: 0, // 0 = Entrega Normal
                peso: parseFloat(dadosNfe.pesoBruto || 0.45),
                volumes: parseInt(dadosNfe.volumes || 1, 10),
                condFrete: "CIF",
                pedido: String(dadosNfe.pedidoVenda || numNf).substring(0, 60),
                clienteCodigo: String(numNf).substring(0, 20),
                natureza: (config.natureza || "VESTUARIO").substring(0, 60),
                volumesTipo: "CX",
                icmsIsencao: 0,
                destinatario: {
                    nome: String(dadosNfe.destNome || 'Consumidor Final').substring(0, 60),
                    cpfCnpj: cpfCnpjDest,
                    ie: dadosNfe.destIE || "ISENTO",
                    endereco: {
                        logradouro: String(dadosNfe.destLogradouro || 'RUA').substring(0, 150),
                        numero: String(dadosNfe.destNumero || 'S/N').substring(0, 30),
                        complemento: String(dadosNfe.destComplemento || '').substring(0, 100),
                        bairro: String(dadosNfe.destBairro || 'BAIRRO').substring(0, 100),
                        cidade: String(dadosNfe.destMunicipio || 'CIDADE').substring(0, 80),
                        estado: ufDest,
                        pais: "Brasil",
                        cep: cepDest
                    },
                    email: dadosNfe.destEmail ? String(dadosNfe.destEmail).substring(0, 80) : undefined,
                    telefone1: dadosNfe.destTelefone ? String(dadosNfe.destTelefone).replace(/\D/g, '').substring(0, 12) : undefined
                },
                docFiscal: {
                    nfe: [
                        {
                            nfeNumero: parseInt(numNf, 10),
                            nfeSerie: parseInt(dadosNfe.serie || 2, 10),
                            nfeData: dadosNfe.dataEmissaoIso || new Date().toISOString().split('T')[0],
                            nfeValTotal: parseFloat(dadosNfe.valorTotalNota || dadosNfe.valorTotal || dadosNfe.valor || 0),
                            nfeValProd: parseFloat(dadosNfe.valorProdutos || dadosNfe.valorTotalNota || dadosNfe.valorTotal || dadosNfe.valor || 0),
                            nfeCfop: parseInt(dadosNfe.cfop || 6108, 10),
                            nfeChave: chaveNfe
                        }
                    ]
                }
            }
        ]
    };
}

/**
 * Transmite o registro da encomenda para a API Smart Label da Total Express
 */
async function registrarEncomendaSmartLabel(dadosNfe, config) {
    const ambiente = (config.environment || 'producao').toLowerCase();
    const endpointUrl = ambiente === 'homologacao' ? ENDPOINTS.homologacao : ENDPOINTS.producao;
    const authHeader = getBasicAuthHeader(config.user, config.password);
    const payload = montarPayloadSmartLabel(dadosNfe, config);
    const bodyStr = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
        const parsed = new URL(endpointUrl);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader,
                'User-Agent': 'ExpediHub/2.0',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr, 'utf8')
            }
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { resData += chunk; });
            res.on('end', () => {
                let parsedRes = null;
                try {
                    parsedRes = JSON.parse(resData);
                } catch(e) {
                    parsedRes = { raw: resData };
                }

                if (res.statusCode === 200 || res.statusCode === 206) {
                    const retorno = parsedRes.retorno || parsedRes;
                    const encomendas = retorno.encomendas || (retorno.sucesso ? retorno.sucesso : []);
                    
                    if (encomendas.length > 0) {
                        const enc = encomendas[0];
                        const volume = enc.volumes && enc.volumes.length > 0 ? enc.volumes[0] : {};
                        return resolve({
                            sucesso: true,
                            statusCode: res.statusCode,
                            pedido: enc.pedido,
                            clienteCodigo: enc.clienteCodigo,
                            awb: volume.awb,
                            rota: volume.rota,
                            codigoBarras: volume.codigoBarras || volume.awb,
                            raw: parsedRes
                        });
                    }

                    if (retorno.erros && retorno.erros.length > 0) {
                        const errDesc = retorno.erros.map(e => e.erro || JSON.stringify(e)).join(' | ');
                        return reject(new Error(`Total Express [${res.statusCode}]: ${errDesc}`));
                    }
                }

                // Erro 400 ou outros
                const msgErro = parsedRes?.descricao || parsedRes?.codigo || parsedRes?.retorno?.erros || resData;
                reject(new Error(`Erro Total Express (HTTP ${res.statusCode}): ${typeof msgErro === 'object' ? JSON.stringify(msgErro) : msgErro}`));
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Falha de conexão com a Total Express: ${err.message}`));
        });

        req.setTimeout(25000, () => {
            req.destroy();
            reject(new Error("Tempo esgotado aguardando resposta da Total Express (25s)."));
        });

        req.write(bodyStr, 'utf8');
        req.end();
    });
}

/**
 * Gera o PDF da Etiqueta Térmica Oficial no padrão Total Express (100mm x 150mm)
 * Dimensões em pontos PDF: 100mm = 283.46 pt | 150mm = 425.20 pt
 */
async function gerarEtiquetaTermicaPdfBuffer({ awb, rota, servico, dadosNfe, empresa }) {
    return new Promise(async (resolve, reject) => {
        try {
            // 100mm x 150mm em pontos PDF (72 dpi)
            const wPt = 283.46;
            const hPt = 425.20;
            const doc = new PDFDocument({
                size: [wPt, hPt],
                margin: 10,
                autoFirstPage: true
            });

            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', err => reject(err));

            const awbText = String(awb || 'SEM_AWB').trim();
            const rotaText = String(rota || 'ROTA GERAL').trim();
            const servicoText = String(servico || 'STD - STANDARD').trim();
            const cepLimpo = String(dadosNfe.destCep || '').replace(/\D/g, '');
            const pedidoNum = String(dadosNfe.pedidoVenda || dadosNfe.documentoOrigem || dadosNfe.nfNumero || '');
            const nfNum = String(dadosNfe.documentoOrigem || dadosNfe.nfNumero || '');

            // 1. Gera Códigos de Barras via bwip-js
            let barcodeAwbBuffer = null;
            let barcodeCepBuffer = null;
            let datamatrixBuffer = null;

            try {
                barcodeAwbBuffer = await bwipjs.toBuffer({
                    bcid: 'code128',
                    text: awbText,
                    scale: 2,
                    height: 18,
                    includetext: false
                });
            } catch (e) {
                console.warn("Erro ao gerar Code128 AWB:", e.message);
            }

            try {
                if (cepLimpo.length === 8) {
                    barcodeCepBuffer = await bwipjs.toBuffer({
                        bcid: 'code128',
                        text: cepLimpo,
                        scale: 2,
                        height: 10,
                        includetext: false
                    });
                }
            } catch (e) {
                console.warn("Erro ao gerar Code128 CEP:", e.message);
            }

            try {
                datamatrixBuffer = await bwipjs.toBuffer({
                    bcid: 'datamatrix',
                    text: awbText,
                    scale: 3
                });
            } catch (e) {
                console.warn("Erro ao gerar DataMatrix:", e.message);
            }

            // Margens e borda externa da etiqueta
            const x0 = 10;
            const y0 = 10;
            const wBox = wPt - 20; // 263.46
            const hBox = hPt - 20; // 405.20

            doc.rect(x0, y0, wBox, hBox).lineWidth(1.5).stroke('#000000');

            // CABEÇALHO: LOGO TOTAL EXPRESS + TIPO DE SERVIÇO
            doc.rect(x0, y0, wBox, 36).fillAndStroke('#001F3F', '#000000');
            doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF').text('TOTAL EXPRESS', x0 + 10, y0 + 10);
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#38BDF8').text(servicoText, x0 + wBox - 110, y0 + 14, { align: 'right', width: 100 });

            // BLOCO 1: ROTA OPERACIONAL (DESTAQUE MÁXIMO)
            const yRota = y0 + 40;
            doc.rect(x0 + 4, yRota, wBox - 8, 38).fillAndStroke('#F1F5F9', '#000000');
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#475569').text('ROTA DA ENCOMENDA', x0 + 8, yRota + 4);
            doc.font('Helvetica-Bold').fontSize(13.5).fillColor('#000000').text(rotaText, x0 + 8, yRota + 15, { width: wBox - 16, align: 'center' });

            // BLOCO 2: CÓDIGO DE BARRAS AWB + DATAMATRIX 2D
            const yBar = yRota + 42;
            doc.rect(x0 + 4, yBar, wBox - 8, 92).lineWidth(1).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#475569').text('CÓDIGO DE RASTREIO (AWB)', x0 + 8, yBar + 4);

            if (barcodeAwbBuffer) {
                doc.image(barcodeAwbBuffer, x0 + 12, yBar + 16, { width: wBox - 80, height: 48 });
            }

            if (datamatrixBuffer) {
                doc.image(datamatrixBuffer, x0 + wBox - 65, yBar + 16, { width: 48, height: 48 });
            }

            doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text(awbText, x0 + 8, yBar + 68, { width: wBox - 16, align: 'center' });

            // BLOCO 3: DESTINATÁRIO & ENDEREÇO COMPLETO
            const yDest = yBar + 96;
            doc.rect(x0 + 4, yDest, wBox - 8, 120).lineWidth(1).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#001F3F').text('DESTINATÁRIO', x0 + 8, yDest + 4);
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000000').text(String(dadosNfe.destNome || '').toUpperCase(), x0 + 8, yDest + 16, { width: wBox - 16 });

            const endLinha1 = `${dadosNfe.destLogradouro || ''}, ${dadosNfe.destNumero || 'S/N'} ${dadosNfe.destComplemento || ''}`.trim();
            const endLinha2 = `Bairro: ${dadosNfe.destBairro || ''} — ${dadosNfe.destMunicipio || ''}/${dadosNfe.ufFavorecida || dadosNfe.destUF || ''}`.trim();
            doc.font('Helvetica').fontSize(8.5).fillColor('#1E293B').text(endLinha1, x0 + 8, yDest + 30, { width: wBox - 16 });
            doc.font('Helvetica').fontSize(8.5).fillColor('#1E293B').text(endLinha2, x0 + 8, yDest + 43, { width: wBox - 16 });

            // CEP com Código de Barras
            const cepFmt = cepLimpo.length === 8 ? `${cepLimpo.slice(0, 5)}-${cepLimpo.slice(5)}` : cepLimpo;
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(`CEP: ${cepFmt}`, x0 + 8, yDest + 58);

            if (barcodeCepBuffer) {
                doc.image(barcodeCepBuffer, x0 + 8, yDest + 74, { width: 140, height: 26 });
            }

            doc.font('Helvetica').fontSize(7.5).fillColor('#475569').text(`CPF/CNPJ: ${dadosNfe.destCnpjCpf || ''}`, x0 + 160, yDest + 78, { width: 95 });

            // BLOCO 4: DADOS DA NOTA FISCAL & EXPEDIDOR
            const yDoc = yDest + 124;
            doc.rect(x0 + 4, yDoc, wBox - 8, 54).lineWidth(1).stroke('#000000');
            
            doc.font('Helvetica-Bold').fontSize(7).fillColor('#475569').text('PEDIDO', x0 + 8, yDoc + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(pedidoNum, x0 + 8, yDoc + 14);

            doc.font('Helvetica-Bold').fontSize(7).fillColor('#475569').text('NOTA FISCAL', x0 + 75, yDoc + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(`NF ${nfNum} / S${dadosNfe.serie || 2}`, x0 + 75, yDoc + 14);

            doc.font('Helvetica-Bold').fontSize(7).fillColor('#475569').text('PESO / VOL', x0 + 165, yDoc + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(`${dadosNfe.pesoBruto || 0.45} kg / 1 VOL`, x0 + 165, yDoc + 14);

            // Chave de Acesso NF-e
            const chaveFmt = (dadosNfe.chaveAcessoNfe || dadosNfe.chave_nfe || '').replace(/\D/g, '');
            doc.font('Helvetica').fontSize(6.5).fillColor('#334155').text(`Chave: ${chaveFmt || 'Sem Chave'}`, x0 + 8, yDoc + 28, { width: wBox - 16 });

            // REMETENTE (RODAPÉ)
            doc.font('Helvetica').fontSize(6).fillColor('#64748B').text(
                `Remetente: ${empresa?.razao_social || 'LALUA COMERCIO DE MODAS EIRELI'} — CNPJ: 10.436.619/0001-05 — Expedição ExpediHub`,
                x0 + 8, yDoc + 40, { width: wBox - 16, align: 'center' }
            );

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}


/**
 * Consulta o status de entrega e ocorrências na API da Total Express
 * @param {Object} params - { awbs: string[], notasFiscais: string[], pedidos: string[], comprovanteEntrega: boolean }
 * @param {Object} config - { user, password, environment }
 */
async function consultarStatusEntrega(params, config = {}) {
    const ambiente = (config.environment || 'producao').toLowerCase();
    const endpointUrl = ambiente === 'homologacao' ? ENDPOINTS.tracking.homologacao : ENDPOINTS.tracking.producao;
    const user = config.user || process.env.TOTAL_EXPRESS_USER || 'clara50276';
    const password = config.password || process.env.TOTAL_EXPRESS_PASSWORD || '@Online1010';
    const authHeader = getBasicAuthHeader(user, password);

    const payload = {};
    if (params.awbs && params.awbs.length > 0) payload.awbs = params.awbs.map(String);
    else if (params.notasFiscais && params.notasFiscais.length > 0) payload.notasFiscais = params.notasFiscais.map(String);
    else if (params.pedidos && params.pedidos.length > 0) payload.pedidos = params.pedidos.map(String);
    else if (params.ediRecebimentoInicioData) {
        payload.ediRecebimentoInicioData = params.ediRecebimentoInicioData;
        if (params.ediRecebimentoFimData) payload.ediRecebimentoFimData = params.ediRecebimentoFimData;
    } else {
        throw new Error('Informe ao menos um critério: awbs, notasFiscais, pedidos ou data.');
    }

    if (params.comprovanteEntrega !== undefined) {
        payload.comprovanteEntrega = Boolean(params.comprovanteEntrega);
    } else {
        payload.comprovanteEntrega = true;
    }

    const bodyStr = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
        const parsed = new URL(endpointUrl);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'User-Agent': 'EXPEDI-HUB/1.0',
                'Content-Length': Buffer.byteLength(bodyStr)
            },
            timeout: 12000
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => resData += chunk);
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(resData);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedData);
                    } else if (res.statusCode === 404) {
                        resolve({ data: [], message: 'Nenhuma encomenda encontrada.' });
                    } else {
                        reject(new Error(parsedData.descricao || parsedData.message || `Erro Total Express (${res.statusCode}): ${resData}`));
                    }
                } catch (parseErr) {
                    reject(new Error(`Erro ao interpretar resposta da Total Express: ${resData}`));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout de comunicação com a API de Tracking da Total Express.'));
        });

        req.on('error', (err) => {
            reject(new Error(`Falha de conexão com a Total Express: ${err.message}`));
        });

        req.write(bodyStr);
        req.end();
    });
}

module.exports = {
    registrarEncomendaSmartLabel,
    gerarEtiquetaTermicaPdfBuffer,
    montarPayloadSmartLabel,
    consultarStatusEntrega,
    ENDPOINTS
};
