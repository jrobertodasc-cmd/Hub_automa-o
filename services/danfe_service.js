// services/danfe_service.js
// Serviço responsável por gerar DANFE em PDF de alta qualidade e gerenciar XMLs de NF-e

const { gerarPDF } = require('@mmachadosantos/nfe-danfe-pdf');

/**
 * Prepara o XML para o gerador de DANFE:
 * Garante que o XML esteja envolvido na tag <nfeProc> (exigida pela SEFAZ e pelo gerador).
 * Se o XML contiver apenas a tag <NFe>, envolve com <nfeProc> e sintetiza o protocolo básico.
 */
function normalizarXmlParaDanfe(xmlString) {
    if (!xmlString) throw new Error('XML não fornecido.');

    let xml = xmlString.trim();

    // Se já contém nfeProc, retorna direto
    if (/<(?:\w+:)?nfeProc[\s>]/i.test(xml)) {
        return xml;
    }

    // Se é apenas <NFe>
    if (/<(?:\w+:)?NFe[\s>]/i.test(xml)) {
        // Extrai chave de acesso e protocolo se existirem
        const chMatch = xml.match(/Id="NFe(\d{44})"/i);
        const chaveAcesso = chMatch ? chMatch[1] : '00000000000000000000000000000000000000000000';
        
        // Remove declaração <?xml ... ?> para evitar duplicação
        const xmlSemHeader = xml.replace(/<\?xml[^>]*\?>/gi, '').trim();

        return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
${xmlSemHeader}
<protNFe versao="4.00">
  <infProt>
    <tpAmb>1</tpAmb>
    <verAplic>1.0</verAplic>
    <chNFe>${chaveAcesso}</chNFe>
    <dhRecbto>${new Date().toISOString()}</dhRecbto>
    <nProt>000000000000000</nProt>
    <digVal>PROT_AUTO</digVal>
    <cStat>100</cStat>
    <xMotivo>Autorizado o uso da NF-e</xMotivo>
  </infProt>
</protNFe>
</nfeProc>`;
    }

    return xml;
}

/**
 * Gera o DANFE em PDF a partir do XML da NF-e.
 * Retorna um Buffer contendo o PDF binário.
 */
async function gerarDanfePdf(xmlString) {
    const xmlPronto = normalizarXmlParaDanfe(xmlString);
    const doc = await gerarPDF(xmlPronto);

    if (Buffer.isBuffer(doc)) {
        return doc;
    }

    // Se retornou ReadableStream / PDFKit Document
    return new Promise((resolve, reject) => {
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', err => reject(err));
    });
}

const { PDFDocument: PDFLibDocument } = require('pdf-lib');

/**
 * Obtém do Storage ou gera dinamicamente a DANFE em PDF de uma guia
 */
async function obterOuGerarDanfePdfGuia(supabaseClient, tenantId, guide) {
    if (!guide) return null;

    const danfePath = guide.danfe_storage_path || `${tenantId}/danfe/danfe_NF_${guide.nf_number}.pdf`;

    // 1. Tenta baixar do storage se já existir
    try {
        const { data: dData, error: dErr } = await supabaseClient.storage.from('tenant-storage').download(danfePath);
        if (!dErr && dData) {
            return Buffer.from(await dData.arrayBuffer());
        }
    } catch (e) {}

    // 2. Se não existir, baixa o XML e gera
    if (guide.xml_storage_path) {
        try {
            const { data: xData, error: xErr } = await supabaseClient.storage.from('tenant-storage').download(guide.xml_storage_path);
            if (!xErr && xData) {
                const xmlStr = await xData.text();
                const pdfBuffer = await gerarDanfePdf(xmlStr);

                // Salva no storage e atualiza o caminho no banco
                await supabaseClient.storage.from('tenant-storage').upload(danfePath, pdfBuffer, {
                    contentType: 'application/pdf',
                    upsert: true
                });

                if (!guide.danfe_storage_path) {
                    await supabaseClient.from('guides').update({ danfe_storage_path: danfePath }).eq('id', guide.id);
                }

                return pdfBuffer;
            }
        } catch (e) {
            console.error(`Erro ao gerar DANFE a partir do XML da NF ${guide.nf_number}:`, e.message);
        }
    }

    return null;
}

/**
 * Mescla múltiplos buffers de DANFE em um único PDF sequencial para impressão
 */
async function mesclarDanfesPdf(pdfBuffers) {
    const mergedPdf = await PDFLibDocument.create();
    for (const buf of pdfBuffers) {
        if (!buf) continue;
        try {
            const doc = await PDFLibDocument.load(buf, { ignoreEncryption: true });
            const pages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            pages.forEach(p => mergedPdf.addPage(p));
        } catch (err) {
            console.error("Erro ao incluir página de DANFE no PDF mesclado:", err.message);
        }
    }
    const mergedBytes = await mergedPdf.save();
    return Buffer.from(mergedBytes);
}

module.exports = {
    gerarDanfePdf,
    normalizarXmlParaDanfe,
    obterOuGerarDanfePdfGuia,
    mesclarDanfesPdf
};

