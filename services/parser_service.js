// services/parser_service.js
// Lógica de leitura de XMLs fiscais e respostas da SEFAZ

function extrairTag(xml, tagName) {
    const regex = new RegExp('<(?:[a-zA-Z0-9]+:)?' + tagName + '[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?' + tagName + '>');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
}

function extrairDadosNfeXML(xml) {
    try {
        // Extrai a Chave de Acesso (atributo Id na tag infNFe)
        const chaveMatch = xml.match(/<infNFe\s+[^>]*Id="NFe([^"]+)"/);
        // Extrai o Número da Nota (tag nNF)
        const numeroMatch = xml.match(/<nNF>([^<]+)<\/nNF>/);
        // Extrai o CNPJ do Emitente (dentro do grupo emit)
        const emitenteMatch = xml.match(/<emit>[^]*?<CNPJ>([^<]+)<\/CNPJ>/);
        // Extrai a UF do Destinatário (dentro de dest -> enderDest -> UF)
        const ufDestMatch = xml.match(/<dest>[^]*?<UF>([^<]+)<\/UF>/);
        
        // Extrai o Valor do DIFAL Destino (tag vICMSUFDest no ICMSTot - Bloco de totais da NF-e)
        const totalMatch = xml.match(/<ICMSTot>([\s\S]*?)<\/ICMSTot>/);
        let valorDifalMatch = null;
        if (totalMatch) {
            valorDifalMatch = totalMatch[1].match(/<vICMSUFDest>([^<]+)<\/vICMSUFDest>/);
        }

        if (!chaveMatch || !numeroMatch || !emitenteMatch || !ufDestMatch || !valorDifalMatch) {
            throw new Error("Não foi possível extrair todos os dados fiscais essenciais do XML da NF-e.");
        }

        // Extrai dados do destinatário isolando estritamente o bloco <dest>...</dest>
        const destBlockMatch = xml.match(/<dest>([\s\S]*?)<\/dest>/);
        let destCnpjCpf = null;
        let destTipoIdentificacao = null;
        let destNome = null;
        let destMun = null;

        if (destBlockMatch) {
            const destBlock = destBlockMatch[1];
            const destCnpjMatch = destBlock.match(/<CNPJ>([^<]+)<\/CNPJ>/);
            const destCpfMatch  = destBlock.match(/<CPF>([^<]+)<\/CPF>/);
            destCnpjCpf = destCnpjMatch ? destCnpjMatch[1] : (destCpfMatch ? destCpfMatch[1] : null);
            destTipoIdentificacao = destCnpjMatch ? "CNPJ" : (destCpfMatch ? "CPF" : null);

            const destNomeMatch = destBlock.match(/<xNome>([^<]+)<\/xNome>/);
            destNome = destNomeMatch ? destNomeMatch[1] : null;

            const destMunMatch = destBlock.match(/<cMun>([^<]+)<\/cMun>/);
            destMun = destMunMatch ? destMunMatch[1] : null;
        }

        // Extrai data de emissao
        const dataEmiMatch = xml.match(/<dhEmi>([^<]+)<\/dhEmi>/);
        const dhEmi = dataEmiMatch ? dataEmiMatch[1] : new Date().toISOString();
        
        const anoApur = dhEmi.substring(0, 4);
        const mesApur = dhEmi.substring(5, 7);
        const diaEmi = dhEmi.substring(8, 10);
        
        const dataEmissaoFormatadaRJ = dhEmi.substring(0, 10);
        const hoje = new Date().toISOString().split('T')[0];

        // Extrai dados da transportadora (<transp> -> <transporta>)
        const transpMatch = xml.match(/<transp>[\s\S]*?<\/transp>/);
        let carrierName = 'NÃO INFORMADA / PRÓPRIA';
        let carrierCnpj = null;
        if (transpMatch) {
            const xNomeMatch = transpMatch[0].match(/<xNome>([^<]+)<\/xNome>/);
            const cnpjTranspMatch = transpMatch[0].match(/<CNPJ>([^<]+)<\/CNPJ>/);
            if (xNomeMatch) {
                carrierName = xNomeMatch[1].trim();
            }
            if (cnpjTranspMatch) {
                carrierCnpj = cnpjTranspMatch[1].trim();
            }
        }

        // Normalização amigável de nomes comerciais conhecidos (Total Express, MT Log, Gollog, Correios)
        let carrierDisplay = carrierName;
        const cNomeUpper = carrierName.toUpperCase();
        if (cNomeUpper.includes('TEX COURIER') || cNomeUpper.includes('TOTAL EXPRESS') || carrierCnpj === '73939449000193') {
            carrierDisplay = 'TOTAL EXPRESS';
        } else if (cNomeUpper.includes('MT LOG') || cNomeUpper.includes('MT-LOG')) {
            carrierDisplay = 'MT LOG';
        } else if (cNomeUpper.includes('GOL') || cNomeUpper.includes('GOLLOG')) {
            carrierDisplay = 'GOL LOG (GOL)';
        } else if (cNomeUpper.includes('CORREIOS')) {
            carrierDisplay = 'CORREIOS';
        }

        return {
            ufFavorecida: ufDestMatch[1],
            cnpjEmitente: emitenteMatch[1],
            codigoReceita: "100102", // DIFAL Consumidor Final
            valor: parseFloat(valorDifalMatch[1]).toFixed(2),
            dataVencimento: hoje,
            tipoDocumentoOrigem: "10", // NF-e
            documentoOrigem: numeroMatch[1],
            chaveAcessoNfe: chaveMatch[1],
            
            destCnpjCpf,
            destTipoIdentificacao,
            destNome,
            destMun,
            anoApuracao: anoApur,
            mesApuracao: mesApur,
            dataEmissaoRJ: dataEmissaoFormatadaRJ,
            carrierName: carrierDisplay,
            carrierCnpj: carrierCnpj
        };
    } catch (err) {
        throw new Error(`Falha ao ler XML da NF-e: ${err.message}`);
    }
}

/**
 * Extrai todos os itens de produtos/peças contidos no XML da NF-e
 */
function extrairItensNfe(xml) {
    const itens = [];
    const regexDet = /<det\s+nItem="([0-9]+)">([\s\S]*?)<\/det>/g;
    let m;
    while ((m = regexDet.exec(xml)) !== null) {
        const nItem = parseInt(m[1], 10);
        const bloco = m[2];
        const cProd = bloco.match(/<cProd>([^<]+)<\/cProd>/)?.[1] || '';
        const xProd = bloco.match(/<xProd>([^<]+)<\/xProd>/)?.[1] || 'PRODUTO';
        const qCom = parseFloat(bloco.match(/<qCom>([^<]+)<\/qCom>/)?.[1] || 1);
        const vUnCom = parseFloat(bloco.match(/<vUnCom>([^<]+)<\/vUnCom>/)?.[1] || 0);
        const vProd = parseFloat(bloco.match(/<vProd>([^<]+)<\/vProd>/)?.[1] || 0);
        const ncm = bloco.match(/<NCM>([^<]+)<\/NCM>/)?.[1] || '';

        itens.push({
            itemIndex: nItem,
            cProd: cProd.trim(),
            xProd: xProd.trim(),
            quantidade: qCom,
            precoUnitario: vUnCom,
            valorTotal: vProd,
            ncm: ncm.trim()
        });
    }
    return itens;
}

/**
 * Identifica se a nota é uma devolução de cliente e extrai as referências
 */
function extrairDadosDevolucaoXML(xml) {
    const tpNF = xml.match(/<tpNF>([^<]+)<\/tpNF>/)?.[1]; // 0=Entrada, 1=Saída
    const finNFe = xml.match(/<finNFe>([^<]+)<\/finNFe>/)?.[1]; // 4=Devolução
    const natOp = (xml.match(/<natOp>([^<]+)<\/natOp>/)?.[1] || '').trim();
    const isDevolucao = finNFe === '4' || tpNF === '0' || natOp.toLowerCase().includes('devolu');

    if (!isDevolucao) return null;

    const returnNfNumber = xml.match(/<nNF>([^<]+)<\/nNF>/)?.[1];
    const returnChaveNfe = xml.match(/<infNFe\s+[^>]*Id="NFe([^"]+)"/)?.[1];
    const refNFe = xml.match(/<refNFe>([^<]+)<\/refNFe>/)?.[1] || null;
    const vNF = parseFloat(xml.match(/<vNF>([^<]+)<\/vNF>/)?.[1] || 0);
    const dEmi = xml.match(/<dhEmi>([^<]+)<\/dhEmi>/)?.[1] || new Date().toISOString();

    let originalNfNumber = null;
    if (refNFe && refNFe.length === 44) {
        originalNfNumber = String(parseInt(refNFe.substring(25, 34), 10));
    }

    return {
        isDevolucao: true,
        returnNfNumber,
        returnChaveNfe,
        originalChaveNfe: refNFe,
        originalNfNumber,
        natOp,
        valor: vNF,
        dataDevolucao: dEmi.substring(0, 10)
    };
}

function normalizarDocumentoOrigem(doc) {
    if (!doc) return "SEM_NUMERO";
    const limpo = doc.replace(/[^A-Za-z0-9]/g, '');
    if (limpo.length === 44 && /^\d+$/.test(limpo)) {
        const nfNum = parseInt(limpo.substring(25, 34), 10);
        if (!isNaN(nfNum)) {
            return String(nfNum);
        }
    }
    return limpo;
}

function extrairDadosGuiaXML(xml) {
    try {
        // Tratamento de Rejeições do lote como um todo
        const sitProcess = extrairTag(xml, 'situacaoProcess');
        if (sitProcess) {
            const codSit = extrairTag(sitProcess, 'codigo');
            const descSit = extrairTag(sitProcess, 'descricao');
            
            // 402 = Processado com sucesso, 403 = Processado com pendências
            if (codSit && codSit !== '402' && codSit !== '403') {
                let descSitLimpa = (descSit || "Rejeição geral do lote")
                    .replace(/&#xE3;/g, 'ã')
                    .replace(/&#xE7;/g, 'ç')
                    .replace(/&#xED;/g, 'í')
                    .replace(/&#xE1;/g, 'á')
                    .replace(/&#xE9;/g, 'é')
                    .replace(/&#xF3;/g, 'ó')
                    .replace(/&#xFA;/g, 'ú')
                    .replace(/&#xE2;/g, 'â')
                    .replace(/&#xEA;/g, 'ê')
                    .replace(/&#xF4;/g, 'ô')
                    .replace(/&#xFB;/g, 'û');
                throw new Error(`O Lote foi rejeitado pelo governo: ${descSitLimpa} (Código ${codSit})`);
            }
        }

        if (!xml.includes('<guia') && !xml.includes(':guia')) {
            const motivoRejeicao = extrairTag(xml, 'motivoRejeicao') || extrairTag(xml, 'motivosRejeicao');
            const codigoRejeicao = extrairTag(xml, 'codigo') || extrairTag(xml, 'codigoRejeicao');
            
            if (motivoRejeicao || (codigoRejeicao && codigoRejeicao === '102')) {
                const descRejeicao = extrairTag(xml, 'descricao') || "Rejeição geral do lote";
                throw new Error(`O Lote foi rejeitado pelo governo: ${descRejeicao}`);
            }
        }

        const guias = [];
        const regexGuia = /<(?:[a-zA-Z0-9]+:)?guia[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?guia>/g;
        let matchGuia;
        const rejeicoesLote = [];

        while ((matchGuia = regexGuia.exec(xml)) !== null) {
            const xmlGuia = matchGuia[1];

            // Verifica rejeição individual da guia
            const situacaoGuia = extrairTag(xmlGuia, 'situacaoGuia');
            if (situacaoGuia && situacaoGuia !== '0') {
                const motivos = [];
                const regexMotivo = /<(?:[a-zA-Z0-9]+:)?descricao>([^<]+)<\/(?:[a-zA-Z0-9]+:)?descricao>/g;
                let matchMotivo;
                while ((matchMotivo = regexMotivo.exec(xmlGuia)) !== null) {
                    motivos.push(matchMotivo[1]);
                }
                const erroMsg = motivos.length > 0 ? motivos.join(' | ') : "Guia invalidada pela SEFAZ";
                
                let erroMsgLimpo = erroMsg
                    .replace(/&#xE3;/g, 'ã')
                    .replace(/&#xE7;/g, 'ç')
                    .replace(/&#xED;/g, 'í')
                    .replace(/&#xE1;/g, 'á')
                    .replace(/&#xE9;/g, 'é')
                    .replace(/&#xF3;/g, 'ó')
                    .replace(/&#xFA;/g, 'ú')
                    .replace(/&#xE2;/g, 'â')
                    .replace(/&#xEA;/g, 'ê')
                    .replace(/&#xF4;/g, 'ô')
                    .replace(/&#xFB;/g, 'û');

                const nfNum = extrairTag(xmlGuia, 'documentoOrigem') || 'NFe';
                rejeicoesLote.push(`NF ${nfNum}: ${erroMsgLimpo}`);
                console.warn(`⚠ Guia individual ignorada devido a falhas: NF ${nfNum} - ${erroMsgLimpo}`);
                continue;
            }

            const codigoBarras = extrairTag(xmlGuia, 'codigoBarras');
            const linhaDigitavel = extrairTag(xmlGuia, 'linhaDigitavel');
            
            const valorStr = extrairTag(xmlGuia, 'valorGNRE') || 
                             extrairTag(xmlGuia, 'c10_valorTotal') || 
                             extrairTag(xmlGuia, 'valor');
            
            const vencimentoStr = extrairTag(xmlGuia, 'dataVencimento') || 
                                   extrairTag(xmlGuia, 'c14_dataVencimento');

            const docOrigemStr = extrairTag(xmlGuia, 'documentoOrigem') ||
                                 extrairTag(xmlGuia, 'c05_referencia');

            if (!codigoBarras && !linhaDigitavel) {
                continue;
            }

            const codBarrasLimpo = codigoBarras ? codigoBarras.replace(/[^0-9]/g, '') : (linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : '');
            const linDigitavelLimpa = linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : codBarrasLimpo;
            const docOrigemLimpo = normalizarDocumentoOrigem(docOrigemStr);

            const ufFavorecida = extrairTag(xmlGuia, 'ufFavorecida');
            const chaveMatch = xmlGuia.match(/\d{44}/);
            const chaveAcessoNfe = chaveMatch ? chaveMatch[0] : null;

            guias.push({
                codigoBarras: codBarrasLimpo,
                linhaDigitavel: linDigitavelLimpa,
                valor: parseFloat(valorStr ? valorStr : 0),
                dataVencimento: vencimentoStr ? vencimentoStr : "2026-07-15",
                documentoOrigem: docOrigemLimpo,
                ufFavorecida: ufFavorecida || null,
                chaveAcessoNfe: chaveAcessoNfe || null
            });
        }

        // Se não encontrou guias em lotes, tenta como guia única
        if (guias.length === 0) {
            const codigoBarras = extrairTag(xml, 'codigoBarras');
            const linhaDigitavel = extrairTag(xml, 'linhaDigitavel');
            
            const valorStr = extrairTag(xml, 'valorGNRE') || 
                             extrairTag(xml, 'c10_valorTotal') || 
                             extrairTag(xml, 'valor');
            
            const vencimentoStr = extrairTag(xml, 'dataVencimento') || 
                                   extrairTag(xml, 'c14_dataVencimento');

            const docOrigemStr = extrairTag(xml, 'documentoOrigem');

            if (codigoBarras || linhaDigitavel) {
                const codBarrasLimpo = codigoBarras ? codigoBarras.replace(/[^0-9]/g, '') : (linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : '');
                const linDigitavelLimpa = linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : codBarrasLimpo;
                const docOrigemLimpo = normalizarDocumentoOrigem(docOrigemStr);
                
                const ufFavorecida = extrairTag(xml, 'ufFavorecida');
                const chaveMatch = xml.match(/\d{44}/);
                const chaveAcessoNfe = chaveMatch ? chaveMatch[0] : null;

                guias.push({
                    codigoBarras: codBarrasLimpo,
                    linhaDigitavel: linDigitavelLimpa,
                    valor: parseFloat(valorStr ? valorStr : 0),
                    dataVencimento: vencimentoStr ? vencimentoStr : "2026-07-15",
                    documentoOrigem: docOrigemLimpo,
                    ufFavorecida: ufFavorecida || null,
                    chaveAcessoNfe: chaveAcessoNfe || null
                });
            }
        }

        if (guias.length === 0) {
            if (rejeicoesLote.length > 0) {
                throw new Error(`Todas as guias do lote foram rejeitadas pelo governo: ${rejeicoesLote.join('; ')}`);
            }
            throw new Error("Nenhuma guia processada com sucesso foi localizada no XML de resposta.");
        }

        return guias;
    } catch (err) {
        throw new Error(`Falha no processador do XML Fiscal: ${err.message}`);
    }
}

module.exports = {
    extrairTag,
    extrairDadosNfeXML,
    extrairDadosGuiaXML,
    extrairItensNfe,
    extrairDadosDevolucaoXML
};
