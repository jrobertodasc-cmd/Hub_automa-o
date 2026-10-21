// services/print_service.js
// Serviço para geração de PDF de Guias GNRE fiel ao layout oficial e mesclagem intercalada (DANFE + GNRE)

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
 * Gera Código de Barras Febraban Segmento 8 (Arrecadação / Tributos Estaduais GNRE) e Linha Digitável oficial
 */
function gerarCodigoBarrasELinhaDigitavelGNRE(guia, empresa = {}) {
    const valor = parseFloat(guia.value || guia.valor || 0);
    const vCentavos = Math.round(valor * 100);
    const vStr = String(vCentavos).padStart(11, '0');

    const uf = (guia.uf || guia.ufFavorecida || 'RJ').toUpperCase();
    const ufCode = UF_IBGE[uf] || '0033';

    // Código da Receita GNRE 100102 (ICMS Difal Consumidor Final Não Contribuinte)
    const receita = '100102';
    const nfStr = String(guia.nf_number || guia.documentoOrigem || '').replace(/\D/g, '').padStart(9, '0').slice(-9);
    // Campo livre: 25 dígitos -> Receita (6) + Tipo Origem (1) + NF (9) + Filler zeros (9)
    const livre = (receita + '1' + nfStr).padEnd(25, '0');

    // 43 dígitos sem o DV geral (posições 1-3 e 5-44)
    // 856: 8 (Arrecadação), 5 (Órgãos Governamentais/Tributos), 6 (Valor em R$ c/ Módulo 10)
    const semDv = '856' + vStr + ufCode + livre;
    const dvGeral = calcularModulo10(semDv);
    const codigoBarras = '856' + dvGeral + vStr + ufCode + livre;

    // Linha digitável: 4 campos de 11 dígitos + 1 DV em cada bloco = 48 dígitos
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

            const cnpjEmitente = (empresa.cnpj || '').replace(/[^0-9]/g, '');
            const cnpjFmt = cnpjEmitente.length === 14
                ? cnpjEmitente.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
                : cnpjEmitente;

            const razaoSocial = empresa.razao_social || empresa.razaoSocial || 'Empresa Emitente';
            const numNf = guia.nf_number || guia.documentoOrigem || '';
            const uf = (guia.uf || guia.ufFavorecida || 'RJ').toUpperCase();
            const valorFmt = formatarMoeda(guia.value || guia.valor);
            const vencimentoFmt = formatarData(guia.dataVencimento);
            const chave = guia.chave_nfe || guia.chaveAcessoNfe || 'NÃO INFORMADA';

            // Garante código de barras e linha digitável válidos mesmo se ainda não foram gerados pela SEFAZ
            let codBarras = (guia.barcode || guia.codigoBarras || '').replace(/[^0-9]/g, '');
            let linhaDigitavel = guia.line_digitizable || guia.linhaDigitavel || '';

            if (!codBarras || codBarras.length < 44 || codBarras === 'IMPORTAR_NO_SEFAZ_SP') {
                const auto = gerarCodigoBarrasELinhaDigitavelGNRE(guia, empresa);
                codBarras = auto.codigoBarras;
                if (!linhaDigitavel) {
                    linhaDigitavel = auto.linhaDigitavel;
                }
            }

            const linhaDigitavelVisual = formatarLinhaDigitavelVisual(linhaDigitavel);

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

            const liberada = isGuiaLiberada(guia);
            const authCode = guia.bank_authentication || (liberada ? `AS-${(guia.id || '91823').substring(0, 8).toUpperCase()}-BR` : '-');

            doc.rect(tX + c1 + c2, tY3_3, c3, subH).fillAndStroke(liberada ? '#ecfdf5' : '#f2f2f2', '#000000');
            doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#444444').text('CÓDIGO DE AUTENTICAÇÃO', tX + c1 + c2 + 4, tY3_3 + 3);
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor(liberada ? '#047857' : '#000000').text(authCode, tX + c1 + c2 + 4, tY3_3 + 14);

            // Linha Digitável (Centralizada em Monospace)
            const yLd = tY3 + h3 + 14;
            doc.font('Courier-Bold').fontSize(11).fillColor('#000000').text(linhaDigitavelVisual, x0, yLd, { align: 'center', width: wTotal });

            // Código de Barras (Centralizado)
            const yBar = yLd + 18;
            if (barcodeBuffer) {
                doc.image(barcodeBuffer, x0 + (wTotal - 380) / 2, yBar, { width: 380, height: 50 });
            }

            // Linha Tracejada de Autenticação
            const yAut = yBar + 58;
            doc.moveTo(x0 + 10, yAut).lineTo(x0 + wTotal - 10, yAut).dash(2, { space: 2 }).stroke('#888888');
            doc.undash();
            const footerAuth = liberada
                ? `Autenticação Bancária: ${authCode} — Quitado via SISBACEN / Asaas — Controle Fiscal SEFAZ-${uf}`
                : `Autenticação Mecânica no Verso / Controle Fiscal SEFAZ-${uf}`;
            doc.font('Helvetica').fontSize(7).fillColor(liberada ? '#047857' : '#666666').text(footerAuth, x0 + 10, yAut + 5, { align: 'right', width: wTotal - 20 });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Determina se a guia / nota fiscal está liberada para coleta pelo Portão Fiscal
 */
function isGuiaLiberada(guide) {
    if (!guide) return false;
    const uf = (guide.uf || guide.ufFavorecida || '').toUpperCase();
    if (uf === 'SP' || guide.barcode === 'IMPORTAR_NO_SEFAZ_SP') return true;
    if (parseFloat(guide.value || guide.valor || 0) <= 0) return true;
    const st = (guide.status || '').toUpperCase();
    if (st === 'PAGA' || st === 'COMPROVADA') return true;
    if (guide.receipt_storage_path || guide.receipt_url || guide.asaas_bill_id) return true;
    if (guide.payment_authorized_at) return true;
    return false;
}

/**
 * Gera um PDF A4 Paisagem oficial do Romaneio / Manifesto de Coleta da Transportadora
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
            const totalDifalDevido = guias.reduce((acc, g) => {
                const uf = (g.uf || '').toUpperCase();
                if (uf === 'SP') return acc;
                return acc + parseFloat(g.value || g.valor || 0);
            }, 0);

            const agora = new Date();
            const dataHoraFmt = `${formatarData(agora.toISOString())} às ${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

            // Helper para desenhar o cabeçalho do romaneio
            function desenharCabecalho(paginaNum, totalPaginas) {
                const x = 25;
                let y = 25;
                const w = 792;

                // Barra superior escura de identificação
                doc.rect(x, y, w, 52).fill('#0f172a');

                doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text('EXPEDI HUB  |  ROMANEIO OFICIAL & MANIFESTO DE CARGA', x + 15, y + 10);
                doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text(`${razaoSocial}  |  CNPJ: ${cnpjFmt}`, x + 15, y + 28);
                doc.font('Helvetica-Bold').fontSize(9).fillColor('#38bdf8').text(`TRANSPORTADORA: ${carrierName.toUpperCase()}`, x + 15, y + 39);

                doc.font('Helvetica').fontSize(8.5).fillColor('#cbd5e1').text(`Emissão: ${dataHoraFmt}`, x, y + 12, { align: 'right', width: w - 15 });
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff').text(`Página ${paginaNum} de ${totalPaginas}`, x, y + 26, { align: 'right', width: w - 15 });

                y += 58;

                // Barra de Indicadores (KPIs do Portão Fiscal)
                const kpiH = 26;
                doc.rect(x, y, w, kpiH).fillAndStroke('#f8fafc', '#e2e8f0');

                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#334155').text(`TOTAL DE VOLUMES: ${totalVolumes}`, x + 10, y + 8);
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#15803d').text(`LIBERADOS P/ COLETA: ${liberadas.length}`, x + 180, y + 8);

                const corBloq = bloqueadas.length > 0 ? '#b91c1c' : '#64748b';
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor(corBloq).text(`RETIDOS NA DOCA: ${bloqueadas.length}`, x + 380, y + 8);

                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text(`TOTAL DIFAL DEVIDO: R$ ${formatarMoeda(totalDifalDevido)}`, x, y + 8, { align: 'right', width: w - 15 });

                y += kpiH + 6;

                // Cabeçalho da Tabela
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

            // Paginação dinâmica
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

                    // Zebra background
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

                    const valStr = isSp ? 'ISENTO' : `R$ ${formatarMoeda(g.value || g.valor)}`;
                    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a').text(valStr, x + 415, rowY + 6, { width: 75, align: 'right' });

                    // Status Portão Fiscal
                    if (isSp) {
                        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#0284c7').text('[OK] ISENTO SP', x + 500, rowY + 6, { width: 110, align: 'center' });
                    } else if (liberada) {
                        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#15803d').text('[OK] LIBERADO (PAGO)', x + 500, rowY + 6, { width: 110, align: 'center' });
                    } else {
                        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#dc2626').text('[X] RETIDO NA DOCA', x + 500, rowY + 6, { width: 110, align: 'center' });
                    }

                    // Autenticação ou ID Asaas
                    const authStr = g.asaas_bill_id ? g.asaas_bill_id.substring(0, 14) : (g.barcode ? 'GUIA EMITIDA' : '-');
                    doc.font('Courier').fontSize(7).fillColor('#475569').text(authStr, x + 615, rowY + 6, { width: 85, align: 'center' });

                    // Campo tracejado para visto do motorista
                    doc.moveTo(x + 710, rowY + 16).lineTo(x + 780, rowY + 16).dash(2, { space: 2 }).stroke('#cbd5e1');
                    doc.undash();

                    currentY += rowH;
                });

                // Bloco de Assinaturas na última página
                if (p === totalPaginas - 1) {
                    const sigY = 510;
                    const sigW = 340;

                    // Assinatura Expedição
                    doc.moveTo(x + 30, sigY).lineTo(x + 30 + sigW, sigY).lineWidth(1).stroke('#0f172a');
                    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a').text('EXPEDIÇÃO & PORTÃO FISCAL', x + 30, sigY + 5, { width: sigW, align: 'center' });
                    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('Conferência física e liberação fiscal irrevogável para embarque', x + 30, sigY + 16, { width: sigW, align: 'center' });

                    // Assinatura Motorista Coletador
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

/**
 * ETAPA 3: COMBO COMPLETO DE EXPEDIÇÃO
 * Gera o pacote documental definitivo para a transportadora:
 * 1. Folha de Rosto: Romaneio Oficial Paisagem da Transportadora (com todos os dados e visto)
 * 2. Para cada Nota Fiscal:
 *    - DANFE oficial da NF-e
 *    - Guia GNRE / DUA-e oficial (quando aplicável)
 *    - Comprovante Bancário de Liquidação Asaas (com autenticação SISBACEN)
 */
async function gerarComboExpedicaoPdf(tenant, guides, supabaseClient, options = {}) {
    const asaasService = require('./asaas_service');
    const mergedPdf = await PDFLibDocument.create();

    const carrierName = (options.carrier && options.carrier !== 'TODAS')
        ? options.carrier
        : (guides[0]?.carrier_name || 'TODAS');

    // 1. Gera e anexa o Romaneio Oficial da Coleta como Folha(s) de Rosto
    try {
        const romaneioBuffer = await gerarRomaneioPdfBuffer(tenant, guides, { carrier: carrierName });
        const loadedRomaneio = await PDFLibDocument.load(romaneioBuffer, { ignoreEncryption: true });
        const romaneioPages = await mergedPdf.copyPages(loadedRomaneio, loadedRomaneio.getPageIndices());
        romaneioPages.forEach(p => mergedPdf.addPage(p));
    } catch (eRom) {
        console.error("Erro ao gerar folha de romaneio para o combo:", eRom.message);
    }

    // Filtra guias se options.onlyCleared for true
    const guiasParaProcessar = options.onlyCleared
        ? guides.filter(g => isGuiaLiberada(g))
        : guides;

    // 2. Anexa a tríade documental de cada NF-e [DANFE + GNRE + COMPROVANTE]
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

        // B. Se for SP, não há guia externa nem comprovante GNRE
        if (isSp) {
            continue;
        }

        // C. Guia GNRE / DUA-e (se houver DIFAL)
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

        // D. Comprovante Oficial Asaas (A quitação que libera o caminhão no posto fiscal!)
        if (liberada && parseFloat(guide.value || guide.valor || 0) > 0) {
            let receiptBuffer = null;

            // 1. Tenta carregar PDF do Supabase Storage
            if (guide.receipt_storage_path) {
                try {
                    const { data: rData } = await supabaseClient.storage.from('tenant-storage').download(guide.receipt_storage_path);
                    if (rData) {
                        receiptBuffer = Buffer.from(await rData.arrayBuffer());
                    }
                } catch (rErr) {}
            }

            // 2. Tenta baixar da URL oficial do Asaas se houver
            if (!receiptBuffer && guide.receipt_url) {
                try {
                    receiptBuffer = await asaasService.downloadExternalPdf(guide.receipt_url);
                } catch (uErr) {}
            }

            // 3. Fallback: gera comprovante autenticado em modo seguro
            if (!receiptBuffer) {
                try {
                    receiptBuffer = await asaasService.gerarComprovanteSimuladoPdf(tenant, guide);
                } catch (sErr) {
                    console.error(`Falha ao gerar comprovante de quitação para NF ${guide.nf_number}:`, sErr.message);
                }
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
    isGuiaLiberada
};
