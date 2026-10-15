// services/print_service.js
// Serviço para geração de PDF de Guias GNRE fiel ao layout oficial e mesclagem intercalada (DANFE + GNRE)

const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const bwipjs = require('bwip-js');
const danfeService = require('./danfe_service');

function formatarLinhaDigitavelVisual(ld) {
    if (!ld) return '';
    const l = String(ld).replace(/[^0-9]/g, '');
    if (l.length === 48) {
        return `${l.slice(0, 12)} ${l.slice(12, 24)} ${l.slice(24, 36)} ${l.slice(36, 48)}`;
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

/**
 * Gera um PDF A4 da Guia GNRE oficial com a diagramação IDÊNTICA ao modelo visual oficial da GNRE
 */
async function gerarGnrePdfBuffer(empresa, guia) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 30 });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', err => reject(err));

            const cnpjEmitente = (empresa.cnpj || '10436619000105').replace(/[^0-9]/g, '');
            const cnpjFmt = cnpjEmitente.length === 14
                ? cnpjEmitente.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
                : cnpjEmitente;

            const razaoSocial = empresa.razao_social || empresa.razaoSocial || 'LALUA COMERCIO DE MODAS EIRELI';
            const numNf = guia.nf_number || guia.documentoOrigem || '';
            const uf = guia.uf || guia.ufFavorecida || 'RJ';
            const valorFmt = formatarMoeda(guia.value || guia.valor);
            const vencimentoFmt = formatarData(guia.dataVencimento);
            const chave = guia.chave_nfe || guia.chaveAcessoNfe || 'NÃO INFORMADA';
            const linhaDigitavel = formatarLinhaDigitavelVisual(guia.line_digitizable || guia.linhaDigitavel);
            const codBarras = (guia.barcode || guia.codigoBarras || '').replace(/[^0-9]/g, '');

            let barcodeBuffer = null;
            if (codBarras && codBarras.length >= 44 && codBarras !== 'IMPORTAR_NO_SEFAZ_SP') {
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

            // ==========================================
            // DESENHO FIEL DA GUIA GNRE (FOLHA A4)
            // ==========================================
            const x0 = 30;
            const y0 = 30;
            const wTotal = 535;

            // Borda do container principal (2px)
            doc.rect(x0, y0, wTotal, 395).lineWidth(2).stroke('#000000');

            // Via Contribuinte
            doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000').text('VIA CONTRIBUINTE', x0 + 10, y0 + 10, { align: 'right', width: wTotal - 20 });

            // Título Oficial da Guia
            doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text('GUIA NACIONAL DE RECOLHIMENTO DE TRIBUTOS ESTADUAIS - GNRE', x0 + 10, y0 + 24, { align: 'center', width: wTotal - 20 });
            doc.moveTo(x0 + 10, y0 + 42).lineTo(x0 + wTotal - 10, y0 + 42).lineWidth(1.5).stroke('#000000');

            // Grade da Tabela (515 pt de largura útil)
            const tY = y0 + 48;
            const tX = x0 + 10;
            const c1 = 309; // 60%
            const c2 = 103; // 20%
            const c3 = 103; // 20%

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
            doc.font('Helvetica-Bold').fontSize(13).fillColor('#000000').text('100102', tX + c1 + c2, tY + 18, { align: 'center', width: c3 });

            // Linha 2: Documento de Origem, Data de Vencimento, Data Limite de Pagto
            const tY2 = tY + h1;
            const h2 = 32;
            doc.rect(tX, tY2, c1, h2).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('DOCUMENTO DE ORIGEM', tX + 4, tY2 + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(`Nota Fiscal Eletrônica (NF-e) nº ${numNf}`, tX + 4, tY2 + 16);

            doc.rect(tX + c1, tY2, c2, h2).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('DATA DE VENCIMENTO', tX + c1 + 4, tY2 + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(vencimentoFmt, tX + c1 + 4, tY2 + 16);

            doc.rect(tX + c1 + c2, tY2, c3, h2).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('DATA LIMITE DE PAGTO', tX + c1 + c2 + 4, tY2 + 4);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(vencimentoFmt, tX + c1 + c2 + 4, tY2 + 16);

            // Linha 3: Chave NFe + Instruções (c1, alt: 84) e valores (3 sublinhas de 28)
            const tY3 = tY2 + h2;
            const h3 = 84;
            const subH = 28;
            doc.rect(tX, tY3, c1, h3).stroke('#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('CHAVE DE ACESSO DA NF-E', tX + 4, tY3 + 4);
            doc.font('Courier-Bold').fontSize(7.5).fillColor('#000000').text(chave, tX + 4, tY3 + 15);
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('INSTRUÇÕES', tX + 4, tY3 + 32);
            doc.font('Helvetica').fontSize(6.5).fillColor('#555555').text(
                'Guia emitida via integração Webservice GNRE v2.00.\nDestinada ao recolhimento de DIFAL - Consumidor Final não contribuinte.',
                tX + 4, tY3 + 42, { width: c1 - 8 }
            );

            // Sub-linha 1: Valor Principal, Atualização Monetária
            doc.rect(tX + c1, tY3, c2, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('VALOR PRINCIPAL', tX + c1 + 4, tY3 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text(`R$ ${valorFmt}`, tX + c1 + 4, tY3 + 14);

            doc.rect(tX + c1 + c2, tY3, c3, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('ATUALIZAÇÃO MONETÁRIA', tX + c1 + c2 + 4, tY3 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text('R$ 0,00', tX + c1 + c2 + 4, tY3 + 14);

            // Sub-linha 2: Juros / Encargos, Multa de Mora
            const tY3_2 = tY3 + subH;
            doc.rect(tX + c1, tY3_2, c2, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('JUROS / ENCARGOS', tX + c1 + 4, tY3_2 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text('R$ 0,00', tX + c1 + 4, tY3_2 + 14);

            doc.rect(tX + c1 + c2, tY3_2, c3, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('MULTA DE MORA', tX + c1 + c2 + 4, tY3_2 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text('R$ 0,00', tX + c1 + c2 + 4, tY3_2 + 14);

            // Sub-linha 3: Valor Total, Código de Autenticação
            const tY3_3 = tY3_2 + subH;
            doc.rect(tX + c1, tY3_3, c2, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('VALOR TOTAL', tX + c1 + 4, tY3_3 + 3);
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000000').text(`R$ ${valorFmt}`, tX + c1 + 4, tY3_3 + 14);

            doc.rect(tX + c1 + c2, tY3_3, c3, subH).fillAndStroke('#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('CÓDIGO DE AUTENTICAÇÃO', tX + c1 + c2 + 4, tY3_3 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000000').text('-', tX + c1 + c2 + 4, tY3_3 + 14);

            // Linha Digitável (Centralizada em Monospace)
            const yLd = tY3 + h3 + 14;
            doc.font('Courier-Bold').fontSize(11).fillColor('#000000').text(linhaDigitavel, x0, yLd, { align: 'center', width: wTotal });

            // Código de Barras (Centralizado)
            const yBar = yLd + 18;
            if (barcodeBuffer) {
                doc.image(barcodeBuffer, x0 + (wTotal - 380) / 2, yBar, { width: 380, height: 50 });
            }

            // Linha Tracejada de Autenticação
            const yAut = yBar + 58;
            doc.moveTo(x0 + 10, yAut).lineTo(x0 + wTotal - 10, yAut).dash(2, { space: 2 }).stroke('#888888');
            doc.undash();
            doc.font('Helvetica').fontSize(7).fillColor('#666666').text(`Autenticação Mecânica no Verso / Controle Fiscal SEFAZ-${uf}`, x0 + 10, yAut + 5, { align: 'right', width: wTotal - 20 });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Mescla todos os DANFEs e Guias GNRE em um único PDF sequencial intercalado:
 * - Se for UF diferente de SP: [DANFE NF X] seguido de [Guia GNRE NF X]
 * - Se for SP: APENAS [DANFE NF X] (sem guia fake)
 */
async function gerarLoteIntercaladoPdf(tenant, guides, supabaseClient) {
    const mergedPdf = await PDFLibDocument.create();

    for (const guide of guides) {
        const isSp = (guide.uf === 'SP' || guide.ufFavorecida === 'SP' || guide.barcode === 'IMPORTAR_NO_SEFAZ_SP');

        // 1. Carrega ou Gera DANFE em PDF
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

        // Se tem DANFE, copia as páginas dele para o documento mestre
        if (danfeBuffer) {
            try {
                const loadedDanfe = await PDFLibDocument.load(danfeBuffer, { ignoreEncryption: true });
                const danfePages = await mergedPdf.copyPages(loadedDanfe, loadedDanfe.getPageIndices());
                danfePages.forEach(p => mergedPdf.addPage(p));
            } catch (err) {
                console.error(`Falha ao copiar DANFE da NF ${guide.nf_number}:`, err.message);
            }
        }

        // 2. Para São Paulo (SP): NÃO inclui guia, apenas o DANFE (conforme exigência operacional)
        if (isSp) {
            continue;
        }

        // 3. Para as demais UFs: Carrega ou Gera a Guia GNRE fiel
        let gnreBuffer = null;
        if (guide.storage_path && guide.storage_path.toLowerCase().endsWith('.pdf')) {
            // Se já era PDF nativo (ex: DUA-ES)
            try {
                const { data: gData } = await supabaseClient.storage.from('tenant-storage').download(guide.storage_path);
                if (gData) {
                    gnreBuffer = Buffer.from(await gData.arrayBuffer());
                }
            } catch (gErr) {}
        }

        if (!gnreBuffer) {
            // Gera PDF com a diagramação oficial idêntica ao HTML da GNRE
            try {
                gnreBuffer = await gerarGnrePdfBuffer(tenant, guide);
            } catch (genErr) {
                console.error(`Falha ao renderizar GNRE em PDF da NF ${guide.nf_number}:`, genErr.message);
            }
        }

        // Copia a página da GNRE logo em seguida (intercalado com o DANFE)
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

module.exports = {
    gerarGnrePdfBuffer,
    gerarLoteIntercaladoPdf
};
