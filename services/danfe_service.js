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

module.exports = {
    gerarDanfePdf,
    normalizarXmlParaDanfe
};
