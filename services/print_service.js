// services/print_service.js
// Serviço para geração de PDF de Espelho de Guias GNRE e mesclagem intercalada (DANFE + GNRE)

const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const bwipjs = require('bwip-js');
const danfeService = require('./danfe_service');

const UF_IBGE = {
    'AC': '0012', 'AL': '0027', 'AP': '0016', 'AM': '0013', 'BA': '0029',
    'CE': '0023', 'DF': '0053', 'ES': '0032', 'GO': '0052', 'MA': '0021',
    'MT': '0051', 'MS': '0050', 'MG': '0031', 'PA': '0015', 'PB': '0025',
    'PR': '0041', 'PE': '0026', 'PI': '0022', 'RJ': '0033', 'RN': '0024',
    'RS': '0043', 'RO': '0011', 'RR': '0014', 'SC': '0042', 'SP': '0035',
    'SE': '0028', 'TO': '0017'
};

function calcularModulo10(numStr) {
    let soma = 0;
    let peso = 2;
    for (let i = numStr.length - 1; i >= 0; i--) {
        let mult = parseInt(numStr[i], 10) * peso;
        if (mult >= 10) {
            soma += (Math.floor(mult / 10) + (mult % 10));
        } else {
            soma += mult;
        }
        peso = peso === 2 ? 1 : 2;
    }
    const resto = soma % 10;
    return (10 - resto) % 10;
}

/**
 * USO EXCLUSIVO EM MODO SIMULADO DE HOMOLOGAÇÃO:
 * Em produção, o código de barras GNRE NUNCA pode ser fabricado localmente, pois depende do
 * Número de Controle gerado exclusivamente pelo Portal GNRE / SEFAZ.
 */
function gerarCodigoBarrasELinhaDigitavelGNRE(guia, empresa = {}) {
    const isProducao = (empresa?.environment || '').toLowerCase() === 'producao';
    if (isProducao) {
        return {
            codigoBarras: null,
            linhaDigitavel: null,
            linhaDigitavelVisual: ''
        };
    }

    const uf = (guia.uf || guia.ufFavorecida || '').toUpperCase().trim();
    const ufCode = UF_IBGE[uf];
    if (!ufCode) {
        return {
            codigoBarras: null,
            linhaDigitavel: null,
            linhaDigitavelVisual: ''
        };
    }

    const valor = parseFloat(guia.value || guia.valor || 0);
    const vCentavos = Math.round(valor * 100);
    const vStr = String(vCentavos).padStart(11, '0');

    const receita = '100102';
    const nfStr = String(guia.nf_number || guia.documentoOrigem || '').replace(/\D/g, '').padStart(9, '0').slice(-9);
    const livre = (receita + '1' + nfStr).padEnd(25, '0');

    const semDv = '856' + vStr + ufCode + livre;
    const dvGeral = calcularModulo10(semDv);
    const codigoBarras = '856' + dvGeral + vStr + ufCode + livre;

    const b1 = codigoBarras.slice(0, 11);
    const d1 = calcularModulo10(b1);
    const b2 = codigoBarras.slice(11, 22);
    const d2 = calcularModulo10(b2);
    const b3 = codigoBarras.slice(22, 33);
    const d3 = calcularModulo10(b3);
    const b4 = codigoBarras.slice(33, 44);
    const d4 = calcularModulo10(b4);

    const linhaDigitavel = `${b1}${d1}${b2}${d2}${b3}${d3}${b4}${d4}`;
    const linhaDigitavelVisual = `${b1}-${d1} ${b2}-${d2} ${b3}-${d3} ${b4}-${d4}`;

    return {
        codigoBarras,
        linhaDigitavel,
        linhaDigitavelVisual
    };
}

function formatarLinhaDigitavelVisual(ld) {
    if (!ld) return '';
    const l = String(ld).replace(/[^0-9]/g, '');
    if (l.length === 48) {
        return `${l.slice(0, 11)}-${l.slice(11, 12)} ${l.slice(12, 23)}-${l.slice(23, 24)} ${l.slice(24, 35)}-${l.slice(35, 36)} ${l.slice(36, 47)}-${l.slice(47, 48)}`;
    }
    if (l.length === 44) {
        return `${l.slice(0, 11)} ${l.slice(11, 22)} ${l.slice(22, 33)} ${l.slice(33, 44)}`;
    }
    return ld;
}

function formatarMoeda(val) {
    return parseFloat(val || 0).toFixed(2).replace('.', ',');
}

function formatarData(dataStr) {
    if (!dataStr) {
        const d = new Date();
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
    if (dataStr.includes('-')) {
        const parts = dataStr.split('T')[0].split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return dataStr;
}

function isCodigoBarrasSinteticoLocal(barcode) {
    const clean = String(barcode || '').replace(/[^0-9]/g, '');
    if (!clean) return false;
    // Detecta padrões fabricados localmente por versões anteriores ou mocks de homologação:
    // 1) 856 + DV + valor(11) + 00 + ufCode(2) + 1001021 + nf(9) + 000000000
    // 2) 858...02992622... (mock gnre_service) ou 8589...2026062010436619...
    return /^856\d{16}1001021\d{9}0{9}$/.test(clean)
        || /^858\d{9}\d+02992622\d+$/.test(clean)
        || /^8589\d+2026062010436619\d+$/.test(clean);
}

/**
 * Gera um PDF A4 de Espelho de Conferência da Guia GNRE (apenas com dados retornados pelo Webservice SEFAZ)
 */
async function gerarGnrePdfBuffer(empresa, guia) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 30 });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', err => reject(err));

            const isSimulado = (empresa?.environment || '').toLowerCase() === 'simulado';
            const cnpjEmitente = (empresa.cnpj || '').replace(/[^0-9]/g, '');
            const cnpjFmt = cnpjEmitente.length === 14
                ? cnpjEmitente.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
                : cnpjEmitente;

            const razaoSocial = empresa.razao_social || empresa.razaoSocial || 'Empresa Emitente';
            const numNf = guia.nf_number || guia.documentoOrigem || '';
            const uf = (guia.uf || guia.ufFavorecida || '').toUpperCase().trim() || 'UF INDEFINIDA';
            const valorFmt = formatarMoeda(guia.value || guia.valor);
            const vencimentoFmt = formatarData(guia.due_date || guia.dataVencimento);
            const chave = guia.chave_nfe || guia.chaveAcessoNfe || 'NÃO INFORMADA';

            let codBarras = (guia.barcode || guia.codigoBarras || '').replace(/[^0-9]/g, '');
            let linhaDigitavel = guia.line_digitizable || guia.linhaDigitavel || '';

            if (!isSimulado && isCodigoBarrasSinteticoLocal(codBarras)) {
                codBarras = '';
                linhaDigitavel = '';
            }

            const temCodigoSefazValido = codBarras.length >= 44 && guia.barcode !== 'IMPORTAR_NO_SEFAZ_SP' && !isCodigoBarrasSinteticoLocal(codBarras);

            // REGRA ABSOLUTA: O sistema NUNCA gera documento fake ou prévia interna sem valor fiscal.
            // Se não há código de barras oficial retornado pela SEFAZ, bloqueia a geração.
            if (!temCodigoSefazValido && !isSimulado) {
                return reject(new Error('Esta guia ainda não possui código de barras oficial retornado pela SEFAZ. Utilize o botão "⚡ Emitir SEFAZ" na Doca para transmiti-la com a data de pagamento desejada.'));
            }

            const linhaDigitavelVisual = formatarLinhaDigitavelVisual(linhaDigitavel || codBarras);

            let barcodeBuffer = null;
            if (temCodigoSefazValido) {
                try {
                    barcodeBuffer = await bwipjs.toBuffer({
                        bcid: 'interleaved2of5',
                        text: codBarras,
                        height: 14,
                        includetext: false
                    });
                } catch (e) {
                    console.error("Erro ao gerar barcode ITF:", e.message);
                }
            }

            const x0 = 30;
            const y0 = 30;
            const wTotal = 535;

            const rawRecibo = String(guia.batch_receipt || guia.recibo || '').trim();
            const temReciboLote = Boolean(rawRecibo && rawRecibo !== '-');
            const rawControle = String(guia.numero_controle || guia.numeroControle || '').trim();
            const temControleSefaz = Boolean(
                rawControle &&
                rawControle !== '-' &&
                !rawControle.toUpperCase().includes('PORTAL') &&
                !rawControle.toUpperCase().includes('SIMULAD') &&
                !rawControle.toUpperCase().includes('VALIDA')
            );

            // Borda do container principal
            doc.rect(x0, y0, wTotal, 410).lineWidth(2).stroke('#000000');

            // Cabeçalho oficial com Número do Lote SEFAZ (ou aviso em modo simulado)
            if (isSimulado) {
                doc.rect(x0 + 6, y0 + 6, wTotal - 12, 18).fillAndStroke('#fee2e2', '#dc2626');
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#991b1b').text(
                    'AMBIENTE SIMULADO / HOMOLOGAÇÃO — PRÉVIA SEM VALOR FISCAL — NÃO PAGAR',
                    x0 + 10, y0 + 11, { align: 'center', width: wTotal - 20 }
                );
            } else {
                let textoTopoPdf = 'GUIA AUTORIZADA — WEBSERVICE OFICIAL GNRE SEFAZ v2.00';
                if (temReciboLote && temControleSefaz) {
                    textoTopoPdf = `LOTE SEFAZ Nº ${rawRecibo}  |  Nº DE CONTROLE SEFAZ: ${rawControle}`;
                } else if (temReciboLote) {
                    textoTopoPdf = `LOTE SEFAZ Nº ${rawRecibo}  |  WEBSERVICE OFICIAL GNRE SEFAZ v2.00`;
                } else if (temControleSefaz) {
                    textoTopoPdf = `Nº DE CONTROLE SEFAZ: ${rawControle}  |  WEBSERVICE OFICIAL GNRE SEFAZ v2.00`;
                }
                doc.rect(x0 + 6, y0 + 6, wTotal - 12, 18).fillAndStroke('#f2f2f2', '#000000');
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(
                    textoTopoPdf,
                    x0 + 10, y0 + 11, { align: 'center', width: wTotal - 20 }
                );
            }

            // Título da Guia
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(
                'GUIA NACIONAL DE RECOLHIMENTO DE TRIBUTOS ESTADUAIS — GNRE',
                x0 + 10, y0 + 30, { align: 'center', width: wTotal - 20 }
            );
            doc.moveTo(x0 + 10, y0 + 46).lineTo(x0 + wTotal - 10, y0 + 46).lineWidth(1.5).stroke('#000000');

            const tY = y0 + 52;
            const tX = x0 + 10;
            const c1 = 309;
            const c2 = 103;
            const c3 = 103;

            // Linha 1: Emitente (c1), UF Favorecida (c2), Código da Receita (c3)
            const h1 = 44;
            doc.rect(tX, tY, c1, h1).lineWidth(1).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('CONTRIBUINTE EMITENTE', tX + 4, tY + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(razaoSocial, tX + 4, tY + 14);
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('CNPJ', tX + 4, tY + 25);
            doc.font('Helvetica').fontSize(8).fillColor('#000000').text(cnpjFmt, tX + 4, tY + 33);

            doc.rect(tX + c1, tY, c2, h1).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('UF FAVORECIDA', tX + c1 + 4, tY + 4);
            doc.font('Helvetica-Bold').fontSize(14).fillColor('#000000').text(uf, tX + c1, tY + 18, { align: 'center', width: c2 });

            doc.rect(tX + c1 + c2, tY, c3, h1).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('CÓDIGO DA RECEITA', tX + c1 + c2 + 4, tY + 4);
            doc.font('Helvetica-Bold').fontSize(13).fillColor('#000000').text(guia.receita_code || '100102', tX + c1 + c2, tY + 18, { align: 'center', width: c3 });

            // Linha 2: Documento de Origem, Data de Vencimento, Recibo Lote SEFAZ / Ambiente
            const tY2 = tY + h1;
            const h2 = 32;
            doc.rect(tX, tY2, c1, h2).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('DOCUMENTO DE ORIGEM', tX + 4, tY2 + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(`Nota Fiscal Eletrônica (NF-e) nº ${numNf}`, tX + 4, tY2 + 16);

            doc.rect(tX + c1, tY2, c2, h2).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('DATA DE VENCIMENTO', tX + c1 + 4, tY2 + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(vencimentoFmt, tX + c1 + 4, tY2 + 16);

            doc.rect(tX + c1 + c2, tY2, c3, h2).stroke('#000000');
            if (temReciboLote && !isSimulado) {
                doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('RECIBO LOTE SEFAZ', tX + c1 + c2 + 4, tY2 + 4);
                doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000').text(rawRecibo, tX + c1 + c2 + 4, tY2 + 16);
            } else {
                doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('AMBIENTE', tX + c1 + c2 + 4, tY2 + 4);
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor(isSimulado ? '#b91c1c' : '#000000').text(isSimulado ? 'SIMULADO' : 'PRODUÇÃO', tX + c1 + c2 + 4, tY2 + 16);
            }

            // Linha 3: Chave NFe + Nº Controle SEFAZ + Instruções e Valores
            const tY3 = tY2 + h2;
            const h3 = 84;
            const subH = 28;
            doc.rect(tX, tY3, c1, h3).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('CHAVE DE ACESSO DA NF-E', tX + 4, tY3 + 4);
            doc.font('Courier-Bold').fontSize(7.5).fillColor('#000000').text(chave, tX + 4, tY3 + 14);
            if (temControleSefaz && !isSimulado) {
                doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text(`Nº DE CONTROLE SEFAZ: `, tX + 4, tY3 + 27, { continued: true });
                doc.font('Courier-Bold').fontSize(7.5).fillColor('#000000').text(rawControle);
                doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('INSTRUÇÕES', tX + 4, tY3 + 40);
                doc.font('Helvetica').fontSize(6.5).fillColor('#444444').text(
                    `Guia emitida e autorizada via Webservice Oficial GNRE SEFAZ v2.00${temReciboLote ? ` (Lote SEFAZ nº ${rawRecibo})` : ''}.\nDestinada ao recolhimento de DIFAL - Consumidor Final não contribuinte.`,
                    tX + 4, tY3 + 49, { width: c1 - 8 }
                );
            } else {
                doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('INSTRUÇÕES', tX + 4, tY3 + 32);
                doc.font('Helvetica').fontSize(6.8).fillColor('#444444').text(
                    `Guia emitida e autorizada via Webservice Oficial GNRE SEFAZ v2.00${temReciboLote ? ` (Lote SEFAZ nº ${rawRecibo})` : ''}.\nDestinada ao recolhimento de DIFAL - Consumidor Final não contribuinte.`,
                    tX + 4, tY3 + 42, { width: c1 - 8 }
                );
            }

            doc.rect(tX + c1, tY3, c2, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('VALOR PRINCIPAL', tX + c1 + 4, tY3 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(`R$ ${valorFmt}`, tX + c1 + 4, tY3 + 14);

            doc.rect(tX + c1 + c2, tY3, c3, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('ATUALIZAÇÃO MONETÁRIA', tX + c1 + c2 + 4, tY3 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text('R$ 0,00', tX + c1 + c2 + 4, tY3 + 14);

            const tY3_2 = tY3 + subH;
            doc.rect(tX + c1, tY3_2, c2, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('JUROS / ENCARGOS', tX + c1 + 4, tY3_2 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text('R$ 0,00', tX + c1 + 4, tY3_2 + 14);

            doc.rect(tX + c1 + c2, tY3_2, c3, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('MULTA DE MORA', tX + c1 + c2 + 4, tY3_2 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text('R$ 0,00', tX + c1 + c2 + 4, tY3_2 + 14);

            const tY3_3 = tY3_2 + subH;
            doc.rect(tX + c1, tY3_3, c2, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('VALOR TOTAL', tX + c1 + 4, tY3_3 + 3);
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000000').text(`R$ ${valorFmt}`, tX + c1 + 4, tY3_3 + 14);

            const liberada = isGuiaLiberada(guia);
            const authCode = guia.bank_authentication || '-';

            doc.rect(tX + c1 + c2, tY3_3, c3, subH).fillAndStroke(liberada ? '#ecfdf5' : '#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('AUTENTICAÇÃO BANCÁRIA', tX + c1 + c2 + 4, tY3_3 + 3);
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(liberada ? '#047857' : '#000000').text(authCode, tX + c1 + c2 + 4, tY3_3 + 14);

            // Linha Digitável
            const yLd = tY3 + h3 + 14;
            doc.font('Courier-Bold').fontSize(temCodigoSefazValido ? 10.5 : 8.5).fillColor(temCodigoSefazValido ? '#000000' : '#b91c1c').text(
                linhaDigitavelVisual, x0, yLd, { align: 'center', width: wTotal }
            );

            // Código de Barras (somente se retornado oficialmente pela SEFAZ)
            const yBar = yLd + 18;
            if (barcodeBuffer && !isSimulado) {
                doc.image(barcodeBuffer, x0 + (wTotal - 380) / 2, yBar, { width: 380, height: 50 });
            }

            const yAut = yBar + 58;
            doc.moveTo(x0 + 10, yAut).lineTo(x0 + wTotal - 10, yAut).dash(2, { space: 2 }).stroke('#888888');
            doc.undash();
            const footerAuth = isSimulado
                ? `DOCUMENTO DE PRÉVIA / SIMULAÇÃO — NÃO UTILIZAR PARA PAGAMENTO BANCÁRIO`
                : `Guia GNRE Autorizada via Webservice Oficial SEFAZ v2.00${temReciboLote ? ` — Lote SEFAZ Nº ${rawRecibo}` : ''} — UF: ${uf}`;
            doc.font('Helvetica').fontSize(7).fillColor(isSimulado ? '#b91c1c' : '#666666').text(footerAuth, x0 + 10, yAut + 5, { align: 'right', width: wTotal - 20 });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Determina se a guia / nota fiscal está efetivamente liberada para coleta pelo Portão Fiscal.
 * Exige quitação confirmada ('paga' ou 'comprovada') ou valor zero.
 * NUNCA libera apenas por ter sido enviada ao Asaas (asaas_bill_id) ou por ser SP com DIFAL em aberto.
 */
function isGuiaLiberada(guide) {
    if (!guide) return false;
    if (parseFloat(guide.value || guide.valor || 0) <= 0) return true;
    const st = (guide.status || '').toUpperCase().trim();
    if (st === 'PAGA' || st === 'COMPROVADA' || st === 'AGENDADA') return true;
    return false;
}

/**
 * Gera um PDF A4 Paisagem do Romaneio / Manifesto de Coleta da Transportadora
 */
async function gerarRomaneioPdfBuffer(empresa, guias = [], options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                layout: 'landscape',
                margin: 25,
                bufferPages: true
            });

            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', err => reject(err));

            const carrierName = (options.carrier && options.carrier !== 'TODAS')
                ? options.carrier
                : (guias[0]?.carrier_name || 'TODAS AS TRANSPORTADORAS');

            const razaoSocial = empresa.razao_social || empresa.razaoSocial || 'Empresa Emitente';
            const cnpj = (empresa.cnpj || '').replace(/[^0-9]/g, '');
            const cnpjFmt = cnpj.length === 14
                ? cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
                : cnpj;

            const totalVolumes = guias.length;
            const liberadas = guias.filter(g => isGuiaLiberada(g));
            const bloqueadas = guias.filter(g => !isGuiaLiberada(g));
            const totalDifalDevido = guias.reduce((acc, g) => acc + parseFloat(g.value || g.valor || 0), 0);

            const agora = new Date();
            const dataHoraFmt = `${formatarData(agora.toISOString())} às ${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

            function desenharCabecalho(paginaNum, totalPaginas) {
                const x = 25;
                let y = 25;
                const w = 792;

                doc.rect(x, y, w, 52).fill('#0f172a');

                doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text('EXPEDI HUB  |  ROMANEIO & MANIFESTO DE CARGA', x + 15, y + 10);
                doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text(`${razaoSocial}  |  CNPJ: ${cnpjFmt}`, x + 15, y + 28);
                doc.font('Helvetica-Bold').fontSize(9).fillColor('#38bdf8').text(`TRANSPORTADORA: ${carrierName.toUpperCase()}`, x + 15, y + 39);

                doc.font('Helvetica').fontSize(8.5).fillColor('#cbd5e1').text(`Emissão: ${dataHoraFmt}`, x, y + 12, { align: 'right', width: w - 15 });
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff').text(`Página ${paginaNum} de ${totalPaginas}`, x, y + 26, { align: 'right', width: w - 15 });

                y += 58;

                const kpiH = 26;
                doc.rect(x, y, w, kpiH).fillAndStroke('#f8fafc', '#e2e8f0');

                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#334155').text(`TOTAL DE VOLUMES: ${totalVolumes}`, x + 10, y + 8);
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#15803d').text(`LIBERADOS P/ COLETA: ${liberadas.length}`, x + 180, y + 8);

                const corBloq = bloqueadas.length > 0 ? '#b91c1c' : '#64748b';
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor(corBloq).text(`RETIDOS NA DOCA: ${bloqueadas.length}`, x + 380, y + 8);

                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text(`TOTAL DIFAL: R$ ${formatarMoeda(totalDifalDevido)}`, x, y + 8, { align: 'right', width: w - 15 });

                y += kpiH + 6;

                const tH = 20;
                doc.rect(x, y, w, tH).fill('#1e293b');

                doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
                doc.text('ITEM', x + 5, y + 6, { width: 30, align: 'center' });
                doc.text('PEDIDO', x + 40, y + 6, { width: 65 });
                doc.text('NF-e', x + 110, y + 6, { width: 65 });
                doc.text('UF', x + 180, y + 6, { width: 30, align: 'center' });
                doc.text('DESTINATÁRIO (CLIENTE)', x + 215, y + 6, { width: 195 });
                doc.text('DIFAL (R$)', x + 415, y + 6, { width: 75, align: 'right' });
                doc.text('STATUS PORTÃO FISCAL', x + 500, y + 6, { width: 110, align: 'center' });
                doc.text('AUTENTICAÇÃO / ASAAS', x + 615, y + 6, { width: 85, align: 'center' });
                doc.text('VISTO DO MOTORISTA', x + 705, y + 6, { width: 80, align: 'center' });

                return y + tH;
            }

            const itensPorPagina = 12;
            const totalPaginas = Math.max(1, Math.ceil(guias.length / itensPorPagina));

            for (let p = 0; p < totalPaginas; p++) {
                if (p > 0) doc.addPage({ size: 'A4', layout: 'landscape', margin: 25 });

                let currentY = desenharCabecalho(p + 1, totalPaginas);
                const inicio = p * itensPorPagina;
                const fim = Math.min(inicio + itensPorPagina, guias.length);
                const itensPagina = guias.slice(inicio, fim);

                const rowH = 22;
                const x = 25;
                const w = 792;

                itensPagina.forEach((g, idx) => {
                    const rowY = currentY;
                    const itemGlobalIdx = inicio + idx + 1;
                    const liberada = isGuiaLiberada(g);
                    const isSp = (g.uf === 'SP' || g.ufFavorecida === 'SP' || g.barcode === 'IMPORTAR_NO_SEFAZ_SP');

                    if (idx % 2 === 0) {
                        doc.rect(x, rowY, w, rowH).fill('#ffffff');
                    } else {
                        doc.rect(x, rowY, w, rowH).fill('#f8fafc');
                    }
                    doc.rect(x, rowY, w, rowH).stroke('#e2e8f0');

                    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(String(itemGlobalIdx), x + 5, rowY + 6, { width: 30, align: 'center' });
                    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a').text(String(g.order_number || g.xPed || '-'), x + 40, rowY + 6, { width: 65 });
                    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1e40af').text(String(g.nf_number || '-'), x + 110, rowY + 6, { width: 65 });
                    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a').text(String(g.uf || '-'), x + 180, rowY + 6, { width: 30, align: 'center' });

                    const cliente = String(g.customer_name || 'CONSUMIDOR FINAL').substring(0, 36);
                    doc.font('Helvetica').fontSize(7.5).fillColor('#334155').text(cliente, x + 215, rowY + 6, { width: 195 });

                    const valStr = `R$ ${formatarMoeda(g.value || g.valor)}`;
                    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a').text(valStr, x + 415, rowY + 6, { width: 75, align: 'right' });

                    if (liberada) {
                        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#15803d').text('[OK] LIBERADO (PAGO)', x + 500, rowY + 6, { width: 110, align: 'center' });
                    } else if (isSp) {
                        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#d97706').text('[!] REQUER DARE-SP', x + 500, rowY + 6, { width: 110, align: 'center' });
                    } else {
                        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#dc2626').text('[X] RETIDO NA DOCA', x + 500, rowY + 6, { width: 110, align: 'center' });
                    }

                    const authStr = g.bank_authentication ? g.bank_authentication.substring(0, 14) : (g.asaas_bill_id ? 'AGUARD. LIQ.' : '-');
                    doc.font('Courier').fontSize(7).fillColor('#475569').text(authStr, x + 615, rowY + 6, { width: 85, align: 'center' });

                    doc.moveTo(x + 710, rowY + 16).lineTo(x + 780, rowY + 16).dash(2, { space: 2 }).stroke('#cbd5e1');
                    doc.undash();

                    currentY += rowH;
                });

                if (p === totalPaginas - 1) {
                    const sigY = 510;
                    const sigW = 340;

                    doc.moveTo(x + 30, sigY).lineTo(x + 30 + sigW, sigY).lineWidth(1).stroke('#0f172a');
                    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text('EXPEDIÇÃO & PORTÃO FISCAL', x + 30, sigY + 5, { width: sigW, align: 'center' });
                    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('Conferência física e liberação para embarque', x + 30, sigY + 16, { width: sigW, align: 'center' });

                    const sig2X = x + w - sigW - 30;
                    doc.moveTo(sig2X, sigY).lineTo(sig2X + sigW, sigY).lineWidth(1).stroke('#0f172a');
                    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text(`MOTORISTA COLETADOR (${carrierName.toUpperCase()})`, sig2X, sigY + 5, { width: sigW, align: 'center' });
                    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('Assinatura / Nome Legível / RG / Placa do Veículo', sig2X, sigY + 16, { width: sigW, align: 'center' });
                }
            }

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

async function enriquecerReciboGuias(guides, tenantId, supabaseClient) {
    if (!supabaseClient || !Array.isArray(guides) || guides.length === 0) return;
    try {
        const gnreSvc = require('./gnre_service');
        const batchIds = [...new Set(guides.map(g => g.batch_id).filter(Boolean))];
        if (batchIds.length > 0) {
            const { data: batches } = await supabaseClient
                .from('batches')
                .select('id, receipt')
                .eq('tenant_id', tenantId)
                .in('id', batchIds);
            const receiptMap = {};
            (batches || []).forEach(b => { receiptMap[b.id] = b.receipt || ''; });
            for (const g of guides) {
                if (!g.batch_receipt && g.batch_id && receiptMap[g.batch_id]) {
                    const rec = gnreSvc.extrairReciboUfDoLote(receiptMap[g.batch_id], g.uf || g.ufFavorecida);
                    if (rec) g.batch_receipt = rec;
                }
            }
        }

        // Extrai Nº de Controle SEFAZ (e recibo, se faltar) do espelho HTML oficial salvo no Storage
        const htmlGuides = guides.filter(g => g.storage_path && String(g.storage_path).toLowerCase().endsWith('.html') && (!g.numero_controle || !g.batch_receipt));
        if (htmlGuides.length > 0) {
            await Promise.all(htmlGuides.map(async (g) => {
                try {
                    const { data } = await supabaseClient.storage.from('tenant-storage').download(g.storage_path);
                    if (!data) return;
                    const htmlText = Buffer.from(await data.arrayBuffer()).toString('utf8');
                    if (!g.numero_controle) {
                        const ctrlMatch = htmlText.match(/N[uú]mero de Controle SEFAZ<\/div>\s*<div[^>]*>([^<]+)<\/div>/i);
                        if (ctrlMatch && ctrlMatch[1] && ctrlMatch[1].trim() !== '-') {
                            g.numero_controle = ctrlMatch[1].trim();
                        }
                    }
                    if (!g.batch_receipt) {
                        const recMatch = htmlText.match(/Recibo Lote SEFAZ<\/div>\s*<div[^>]*>([^<]+)<\/div>/i)
                            || htmlText.match(/LOTE SEFAZ Nº\s*([0-9]+)/i);
                        if (recMatch && recMatch[1] && recMatch[1].trim() !== '-') {
                            g.batch_receipt = recMatch[1].trim();
                        }
                    }
                } catch (errHtml) {}
            }));
        }
    } catch (e) {}
}

/**
 * Mescla todos os DANFEs e Espelhos de Guias GNRE em um único PDF sequencial intercalado
 */
async function gerarLoteIntercaladoPdf(tenant, guides, supabaseClient) {
    await enriquecerReciboGuias(guides, tenant.id, supabaseClient);
    const mergedPdf = await PDFLibDocument.create();

    for (const guide of guides) {
        const isSp = (guide.uf === 'SP' || guide.ufFavorecida === 'SP' || guide.barcode === 'IMPORTAR_NO_SEFAZ_SP');

        let danfeBuffer = null;
        try {
            const danfePath = guide.danfe_storage_path || `${tenant.id}/danfe/danfe_NF_${guide.nf_number}.pdf`;
            const { data: dData } = await supabaseClient.storage.from('tenant-storage').download(danfePath);
            if (dData) {
                danfeBuffer = Buffer.from(await dData.arrayBuffer());
            }
        } catch (err) {}

        if (!danfeBuffer && guide.xml_storage_path) {
            try {
                const { data: xData } = await supabaseClient.storage.from('tenant-storage').download(guide.xml_storage_path);
                if (xData) {
                    const xmlStr = await xData.text();
                    danfeBuffer = await danfeService.gerarDanfePdf(xmlStr);
                }
            } catch (xErr) {
                console.error(`Erro ao gerar DANFE para NF ${guide.nf_number}:`, xErr.message);
            }
        }

        if (danfeBuffer) {
            try {
                const loadedDanfe = await PDFLibDocument.load(danfeBuffer, { ignoreEncryption: true });
                const danfePages = await mergedPdf.copyPages(loadedDanfe, loadedDanfe.getPageIndices());
                danfePages.forEach(p => mergedPdf.addPage(p));
            } catch (err) {
                console.error(`Falha ao copiar DANFE da NF ${guide.nf_number}:`, err.message);
            }
        }

        if (isSp) {
            continue;
        }

        let gnreBuffer = null;
        if (guide.storage_path && guide.storage_path.toLowerCase().endsWith('.pdf')) {
            try {
                const { data: gData } = await supabaseClient.storage.from('tenant-storage').download(guide.storage_path);
                if (gData) {
                    gnreBuffer = Buffer.from(await gData.arrayBuffer());
                }
            } catch (gErr) {}
        }

        if (!gnreBuffer) {
            try {
                gnreBuffer = await gerarGnrePdfBuffer(tenant, guide);
            } catch (genErr) {
                console.error(`Falha ao renderizar GNRE em PDF da NF ${guide.nf_number}:`, genErr.message);
            }
        }

        if (gnreBuffer) {
            try {
                const loadedGnre = await PDFLibDocument.load(gnreBuffer, { ignoreEncryption: true });
                const gnrePages = await mergedPdf.copyPages(loadedGnre, loadedGnre.getPageIndices());
                gnrePages.forEach(p => mergedPdf.addPage(p));
            } catch (err) {
                console.error(`Falha ao copiar Guia GNRE da NF ${guide.nf_number}:`, err.message);
            }
        }
    }

    const finalPdfBytes = await mergedPdf.save({ useObjectStreams: true });
    return Buffer.from(finalPdfBytes);
}

/**
 * ETAPA 3: COMBO COMPLETO DE EXPEDIÇÃO
 */
async function gerarComboExpedicaoPdf(tenant, guides, supabaseClient, options = {}) {
    await enriquecerReciboGuias(guides, tenant.id, supabaseClient);
    const asaasService = require('./asaas_service');
    const mergedPdf = await PDFLibDocument.create();

    const carrierName = (options.carrier && options.carrier !== 'TODAS')
        ? options.carrier
        : (guides[0]?.carrier_name || 'TODAS');

    try {
        const romaneioBuffer = await gerarRomaneioPdfBuffer(tenant, guides, { carrier: carrierName });
        const loadedRomaneio = await PDFLibDocument.load(romaneioBuffer, { ignoreEncryption: true });
        const romaneioPages = await mergedPdf.copyPages(loadedRomaneio, loadedRomaneio.getPageIndices());
        romaneioPages.forEach(p => mergedPdf.addPage(p));
    } catch (eRom) {
        console.error("Erro ao gerar folha de romaneio para o combo:", eRom.message);
    }

    const guiasParaProcessar = options.onlyCleared
        ? guides.filter(g => isGuiaLiberada(g))
        : guides;

    for (const guide of guiasParaProcessar) {
        const isSp = (guide.uf === 'SP' || guide.ufFavorecida === 'SP' || guide.barcode === 'IMPORTAR_NO_SEFAZ_SP');
        const liberada = isGuiaLiberada(guide);

        // A. Carrega ou Gera DANFE
        let danfeBuffer = null;
        try {
            const danfePath = guide.danfe_storage_path || `${tenant.id}/danfe/danfe_NF_${guide.nf_number}.pdf`;
            const { data: dData } = await supabaseClient.storage.from('tenant-storage').download(danfePath);
            if (dData) {
                danfeBuffer = Buffer.from(await dData.arrayBuffer());
            }
        } catch (eDan) {}

        if (!danfeBuffer && guide.xml_storage_path) {
            try {
                const { data: xData } = await supabaseClient.storage.from('tenant-storage').download(guide.xml_storage_path);
                if (xData) {
                    const xmlStr = await xData.text();
                    danfeBuffer = await danfeService.gerarDanfePdf(xmlStr);
                }
            } catch (xErr) {
                console.error(`Erro ao gerar DANFE para NF ${guide.nf_number}:`, xErr.message);
            }
        }

        if (danfeBuffer) {
            try {
                const loadedDanfe = await PDFLibDocument.load(danfeBuffer, { ignoreEncryption: true });
                const danfePages = await mergedPdf.copyPages(loadedDanfe, loadedDanfe.getPageIndices());
                danfePages.forEach(p => mergedPdf.addPage(p));
            } catch (err) {
                console.error(`Falha ao mesclar DANFE da NF ${guide.nf_number}:`, err.message);
            }
        }

        if (isSp) {
            continue;
        }

        // B. Espelho GNRE / DUA-e
        if (parseFloat(guide.value || guide.valor || 0) > 0 || guide.barcode) {
            let gnreBuffer = null;
            if (guide.storage_path && guide.storage_path.toLowerCase().endsWith('.pdf')) {
                try {
                    const { data: gData } = await supabaseClient.storage.from('tenant-storage').download(guide.storage_path);
                    if (gData) {
                        gnreBuffer = Buffer.from(await gData.arrayBuffer());
                    }
                } catch (gErr) {}
            }

            if (!gnreBuffer) {
                try {
                    gnreBuffer = await gerarGnrePdfBuffer(tenant, guide);
                } catch (genErr) {
                    console.error(`Falha ao gerar GNRE da NF ${guide.nf_number}:`, genErr.message);
                }
            }

            if (gnreBuffer) {
                try {
                    const loadedGnre = await PDFLibDocument.load(gnreBuffer, { ignoreEncryption: true });
                    const gnrePages = await mergedPdf.copyPages(loadedGnre, loadedGnre.getPageIndices());
                    gnrePages.forEach(p => mergedPdf.addPage(p));
                } catch (err) {
                    console.error(`Falha ao mesclar GNRE da NF ${guide.nf_number}:`, err.message);
                }
            }
        }

        // C. Comprovante Oficial Asaas (somente comprovante real em Produção)
        if (liberada && parseFloat(guide.value || guide.valor || 0) > 0) {
            let receiptBuffer = null;

            if (guide.receipt_storage_path) {
                try {
                    const { data: rData } = await supabaseClient.storage.from('tenant-storage').download(guide.receipt_storage_path);
                    if (rData) {
                        receiptBuffer = Buffer.from(await rData.arrayBuffer());
                    }
                } catch (rErr) {}
            }

            if (!receiptBuffer && guide.receipt_url) {
                try {
                    receiptBuffer = await asaasService.downloadExternalPdf(guide.receipt_url);
                } catch (uErr) {}
            }

            // Só permite comprovante simulado se o tenant estiver explicitamente em modo simulado
            if (!receiptBuffer && (tenant?.environment || '').toLowerCase() === 'simulado') {
                try {
                    receiptBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                        nfNumber: guide.nf_number,
                        uf: guide.uf,
                        valor: guide.value,
                        billId: guide.asaas_bill_id,
                        razaoSocial: tenant.razao_social,
                        environment: 'simulado'
                    });
                } catch (sErr) {}
            }

            if (receiptBuffer) {
                try {
                    const loadedReceipt = await PDFLibDocument.load(receiptBuffer, { ignoreEncryption: true });
                    const rPages = await mergedPdf.copyPages(loadedReceipt, loadedReceipt.getPageIndices());
                    rPages.forEach(p => mergedPdf.addPage(p));
                } catch (err) {
                    console.error(`Falha ao mesclar Comprovante Asaas da NF ${guide.nf_number}:`, err.message);
                }
            }
        }
    }

    const finalPdfBytes = await mergedPdf.save({ useObjectStreams: true });
    return Buffer.from(finalPdfBytes);
}

module.exports = {
    gerarGnrePdfBuffer,
    gerarRomaneioPdfBuffer,
    gerarLoteIntercaladoPdf,
    gerarComboExpedicaoPdf,
    gerarCodigoBarrasELinhaDigitavelGNRE,
    enriquecerReciboGuias,
    isGuiaLiberada,
    isCodigoBarrasSinteticoLocal
};
