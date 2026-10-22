// services/parser_service.js
// Lógica estruturada de leitura de XMLs fiscais (NF-e e Retornos SEFAZ GNRE/DUA)

const UFS_VALIDAS = new Set([
    'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO',
    'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
    'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
]);

function decodificarEntidadesXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&#xE3;/gi, 'ã')
        .replace(/&#xE7;/gi, 'ç')
        .replace(/&#xED;/gi, 'í')
        .replace(/&#xE1;/gi, 'á')
        .replace(/&#xE9;/gi, 'é')
        .replace(/&#xF3;/gi, 'ó')
        .replace(/&#xFA;/gi, 'ú')
        .replace(/&#xE2;/gi, 'â')
        .replace(/&#xEA;/gi, 'ê')
        .replace(/&#xF4;/gi, 'ô')
        .replace(/&#xFB;/gi, 'û')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function extrairTag(xml, tagName) {
    if (!xml || !tagName) return null;
    const regex = new RegExp('<(?:[a-zA-Z0-9_]+:)?' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?' + tagName + '>', 'i');
    const match = String(xml).match(regex);
    return match ? match[1].trim() : null;
}

function extrairDadosNfeXML(xml) {
    try {
        if (!xml || typeof xml !== 'string') {
            throw new Error("Conteúdo XML da NF-e vazio ou inválido.");
        }

        // Isola o bloco <infNFe> principal para não capturar tags de protocolo ou assinatura
        const infNfeMatch = xml.match(/<(?:[a-zA-Z0-9_]+:)?infNFe\b([^>]*)>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?infNFe>/i);
        const infNfeAttrs = infNfeMatch ? infNfeMatch[1] : '';
        const infNfeBody = infNfeMatch ? infNfeMatch[2] : xml;

        // 1. Extrai e valida a Chave de Acesso de 44 dígitos
        let chaveAcessoNfe = null;
        const idAttrMatch = infNfeAttrs.match(/\bId\s*=\s*["'](?:NFe)?(\d{44})["']/i) || xml.match(/<infNFe\s+[^>]*Id=["']NFe(\d{44})["']/i);
        if (idAttrMatch) {
            chaveAcessoNfe = idAttrMatch[1];
        } else {
            const chNFeProtocolo = extrairTag(xml, 'chNFe');
            if (chNFeProtocolo && /^\d{44}$/.test(chNFeProtocolo)) {
                chaveAcessoNfe = chNFeProtocolo;
            }
        }

        // 2. Isola blocos estruturais da NF-e (<ide>, <emit>, <dest>, <entrega>, <total>, <transp>)
        const ideBlock = extrairTag(infNfeBody, 'ide') || infNfeBody;
        const emitBlock = extrairTag(infNfeBody, 'emit');
        const destBlock = extrairTag(infNfeBody, 'dest');
        const entregaBlock = extrairTag(infNfeBody, 'entrega');
        const icmsTotBlock = extrairTag(infNfeBody, 'ICMSTot');
        const transpBlock = extrairTag(infNfeBody, 'transp');

        const numeroNota = extrairTag(ideBlock, 'nNF');
        const idDest = extrairTag(ideBlock, 'idDest'); // 1=Interna, 2=Interestadual, 3=Exterior

        if (!emitBlock || !destBlock || !icmsTotBlock) {
            throw new Error("Estrutura obrigatória da NF-e incompleta (blocos <emit>, <dest> ou <ICMSTot> ausentes).");
        }

        // 3. Emitente: extrai CNPJ, endereço e UF estritamente de <emit>/<enderEmit>
        const cnpjEmitente = extrairTag(emitBlock, 'CNPJ') || extrairTag(emitBlock, 'CPF');
        const emitRazaoSocial = decodificarEntidadesXml(extrairTag(emitBlock, 'xNome'));
        const enderEmitBlock = extrairTag(emitBlock, 'enderEmit') || emitBlock;
        const ufEmitente = (extrairTag(enderEmitBlock, 'UF') || '').toUpperCase();
        const emitLgr = decodificarEntidadesXml(extrairTag(enderEmitBlock, 'xLgr') || '');
        const emitNro = decodificarEntidadesXml(extrairTag(enderEmitBlock, 'nro') || '');
        const emitEndereco = [emitLgr, emitNro].filter(Boolean).join(' ').trim();
        const emitMunicipio = extrairTag(enderEmitBlock, 'cMun') || '';
        const emitCep = (extrairTag(enderEmitBlock, 'CEP') || '').replace(/\D/g, '');

        // 4. Destinatário: extrai UF estritamente de <dest>/<enderDest>/<UF>
        const enderDestBlock = extrairTag(destBlock, 'enderDest');
        if (!enderDestBlock) {
            throw new Error("Bloco de endereço do destinatário (<enderDest>) ausente no XML da NF-e.");
        }
        const ufDestinatario = (extrairTag(enderDestBlock, 'UF') || '').toUpperCase();
        const destMun = extrairTag(enderDestBlock, 'cMun');

        const destCnpj = extrairTag(destBlock, 'CNPJ');
        const destCpf = extrairTag(destBlock, 'CPF');
        const destCnpjCpf = destCnpj || destCpf || null;
        const destTipoIdentificacao = destCnpj ? 'CNPJ' : (destCpf ? 'CPF' : null);
        const destNome = decodificarEntidadesXml(extrairTag(destBlock, 'xNome'));
        const indIEDest = extrairTag(destBlock, 'indIEDest');

        // 5. Local de Entrega (<entrega>): verifica divergência entre UF do destinatário e UF de entrega física
        let ufEntrega = null;
        let munEntrega = null;
        if (entregaBlock) {
            const ufEntRaw = (extrairTag(entregaBlock, 'UF') || '').toUpperCase();
            if (ufEntRaw && ufEntRaw !== 'EX') {
                ufEntrega = ufEntRaw;
                munEntrega = extrairTag(entregaBlock, 'cMun');
            }
        }

        // 6. Valor do DIFAL Destino (<vICMSUFDest> e <vFCPUFDest> dentro de <ICMSTot>)
        const vIcmsUfDestStr = extrairTag(icmsTotBlock, 'vICMSUFDest');
        const vFcpUfDestStr = extrairTag(icmsTotBlock, 'vFCPUFDest');

        if (!chaveAcessoNfe || !numeroNota || !cnpjEmitente || !ufDestinatario || vIcmsUfDestStr === null) {
            throw new Error("Não foi possível extrair todos os dados fiscais essenciais (Chave 44 dígitos, nNF, Emitente, UF Destino ou vICMSUFDest) do XML da NF-e.");
        }

        if (!UFS_VALIDAS.has(ufDestinatario)) {
            throw new Error(`UF do destinatário inválida ou exterior ('${ufDestinatario}') na NF-e ${numeroNota}.`);
        }

        // Bloqueio preventivo se houver divergência entre UF do Destinatário e UF de Entrega (<entrega>)
        if (ufEntrega && ufEntrega !== ufDestinatario) {
            throw new Error(
                `BLOQUEIO FISCAL PREVENTIVO (NF-e ${numeroNota}): A UF do Destinatário (${ufDestinatario}) difere da UF do Local de Entrega (${ufEntrega}). Emissão automática suspensa para revisão fiscal humana.`
            );
        }

        // Bloqueio se operação for interna (UF emitente == UF destinatário ou idDest == 1)
        if ((ufEmitente && ufEmitente === ufDestinatario) || idDest === '1') {
            throw new Error(
                `Operação interna detectada na NF-e ${numeroNota} (Emitente: ${ufEmitente} -> Destino: ${ufDestinatario}). Não há recolhimento de GNRE DIFAL interestadual.`
            );
        }

        // 7. Datas de emissão e apuração
        const dhEmi = extrairTag(ideBlock, 'dhEmi') || extrairTag(ideBlock, 'dEmi') || new Date().toISOString();
        const anoApur = dhEmi.substring(0, 4);
        const mesApur = dhEmi.substring(5, 7);
        const dataEmissaoFormatadaRJ = dhEmi.substring(0, 10);
        const hoje = new Date().toISOString().split('T')[0];

        // 8. Transportadora (<transp>/<transporta>)
        let carrierName = 'NÃO INFORMADA / PRÓPRIA';
        let carrierCnpj = null;
        if (transpBlock) {
            const transportaBlock = extrairTag(transpBlock, 'transporta') || transpBlock;
            const xNomeTransp = extrairTag(transportaBlock, 'xNome');
            const cnpjTransp = extrairTag(transportaBlock, 'CNPJ') || extrairTag(transportaBlock, 'CPF');
            if (xNomeTransp) carrierName = decodificarEntidadesXml(xNomeTransp);
            if (cnpjTransp) carrierCnpj = cnpjTransp;
        }

        let carrierDisplay = carrierName;
        const cNomeUpper = carrierName.toUpperCase();
        if (cNomeUpper.includes('TEX COURIER') || cNomeUpper.includes('TOTAL EXPRESS') || carrierCnpj === '73939449000193') {
            carrierDisplay = 'TOTAL EXPRESS';
        } else if (cNomeUpper.includes('MT LOG') || cNomeUpper.includes('MT-LOG')) {
            carrierDisplay = 'MT LOG';
        } else if (cNomeUpper.includes('GOL') || cNomeUpper.includes('GOLLOG')) {
            carrierDisplay = 'GOL LOG (GOL)';
        } else if (cNomeUpper.includes('CORREIOS') || cNomeUpper.includes('EBCT')) {
            carrierDisplay = 'CORREIOS';
        }

        const valorDifalNum = parseFloat(vIcmsUfDestStr) || 0;
        const valorFcpNum = parseFloat(vFcpUfDestStr) || 0;

        return {
            ufFavorecida: ufDestinatario,
            ufEmitente: ufEmitente || null,
            emitRazaoSocial: emitRazaoSocial || null,
            emitEndereco: emitEndereco || null,
            emitMunicipio: emitMunicipio || null,
            emitCep: emitCep || null,
            ufDestinatario: ufDestinatario,
            ufEntrega: ufEntrega || null,
            idDest: idDest || null,
            indIEDest: indIEDest || null,
            cnpjEmitente: cnpjEmitente.replace(/\D/g, ''),
            codigoReceita: "100102", // DIFAL Consumidor Final
            valor: valorDifalNum.toFixed(2),
            valorFecp: valorFcpNum > 0 ? valorFcpNum.toFixed(2) : null,
            dataVencimento: hoje,
            tipoDocumentoOrigem: "10", // NF-e
            documentoOrigem: numeroNota.replace(/\D/g, '') || numeroNota,
            chaveAcessoNfe: chaveAcessoNfe,

            destCnpjCpf: destCnpjCpf ? destCnpjCpf.replace(/\D/g, '') : null,
            destTipoIdentificacao,
            destNome,
            destMun: munEntrega || destMun,
            anoApuracao: anoApur,
            mesApuracao: mesApur,
            dataEmissaoRJ: dataEmissaoFormatadaRJ,
            carrierName: carrierDisplay,
            carrierCnpj: carrierCnpj ? carrierCnpj.replace(/\D/g, '') : null
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
    const regexDet = /<(?:[a-zA-Z0-9_]+:)?det\s+[^>]*nItem=["']([0-9]+)["'][^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?det>/gi;
    let m;
    while ((m = regexDet.exec(xml)) !== null) {
        const nItem = parseInt(m[1], 10);
        const bloco = m[2];
        const prodBlock = extrairTag(bloco, 'prod') || bloco;
        const cProd = extrairTag(prodBlock, 'cProd') || '';
        const xProd = decodificarEntidadesXml(extrairTag(prodBlock, 'xProd') || 'PRODUTO');
        const qCom = parseFloat(extrairTag(prodBlock, 'qCom') || 1);
        const vUnCom = parseFloat(extrairTag(prodBlock, 'vUnCom') || 0);
        const vProd = parseFloat(extrairTag(prodBlock, 'vProd') || 0);
        const ncm = extrairTag(prodBlock, 'NCM') || '';

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
    const ideBlock = extrairTag(xml, 'ide') || xml;
    const tpNF = extrairTag(ideBlock, 'tpNF'); // 0=Entrada, 1=Saída
    const finNFe = extrairTag(ideBlock, 'finNFe'); // 4=Devolução
    const natOp = decodificarEntidadesXml(extrairTag(ideBlock, 'natOp') || '');
    const isDevolucao = finNFe === '4' || tpNF === '0' || natOp.toLowerCase().includes('devolu');

    if (!isDevolucao) return null;

    const returnNfNumber = extrairTag(ideBlock, 'nNF');
    const returnChaveNfe = xml.match(/<infNFe\s+[^>]*Id=["']NFe(\d{44})["']/i)?.[1] || extrairTag(xml, 'chNFe');
    const refNFe = extrairTag(ideBlock, 'refNFe') || null;
    const icmsTotBlock = extrairTag(xml, 'ICMSTot') || xml;
    const vNF = parseFloat(extrairTag(icmsTotBlock, 'vNF') || 0);
    const dEmi = extrairTag(ideBlock, 'dhEmi') || extrairTag(ideBlock, 'dEmi') || new Date().toISOString();

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
    const limpo = String(doc).replace(/[^A-Za-z0-9]/g, '');
    if (limpo.length === 44 && /^\d+$/.test(limpo)) {
        const nfNum = parseInt(limpo.substring(25, 34), 10);
        if (!isNaN(nfNum)) {
            return String(nfNum);
        }
    }
    if (/^\d+$/.test(limpo)) {
        const semZeros = String(parseInt(limpo, 10));
        if (semZeros && semZeros !== 'NaN') return semZeros;
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
                const descSitLimpa = decodificarEntidadesXml(descSit || "Rejeição geral do lote");
                throw new Error(`O Lote foi rejeitado pelo governo: ${descSitLimpa} (Código ${codSit})`);
            }
        }

        if (!xml.includes('<guia') && !xml.includes(':guia')) {
            const motivoRejeicao = extrairTag(xml, 'motivoRejeicao') || extrairTag(xml, 'motivosRejeicao');
            const codigoRejeicao = extrairTag(xml, 'codigo') || extrairTag(xml, 'codigoRejeicao');

            if (motivoRejeicao || (codigoRejeicao && codigoRejeicao === '102')) {
                const descRejeicao = decodificarEntidadesXml(extrairTag(xml, 'descricao') || "Rejeição geral do lote");
                throw new Error(`O Lote foi rejeitado pelo governo: ${descRejeicao}`);
            }
        }

        const guias = [];
        const rejeicoesDetalhadas = [];
        const rejeicoesLote = [];

        const regexGuia = /<(?:[a-zA-Z0-9_]+:)?guia\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?guia>/gi;
        let matchGuia;

        while ((matchGuia = regexGuia.exec(xml)) !== null) {
            const xmlGuia = matchGuia[1];
            const ufGuia = (extrairTag(xmlGuia, 'ufFavorecida') || extrairTag(xmlGuia, 'c01_UfFavorecida') || '').toUpperCase() || null;
            const docOrigemBruto = extrairTag(xmlGuia, 'documentoOrigem') || extrairTag(xmlGuia, 'c04_docOrigem') || null;
            const docOrigemNorm = normalizarDocumentoOrigem(docOrigemBruto);

            // Verifica situação individual da guia (0 = Processada com sucesso)
            const situacaoGuia = extrairTag(xmlGuia, 'situacaoGuia');
            if (situacaoGuia && situacaoGuia !== '0') {
                const motivos = [];
                const regexMotivo = /<(?:[a-zA-Z0-9_]+:)?descricao>([^<]+)<\/(?:[a-zA-Z0-9_]+:)?descricao>/gi;
                let matchMotivo;
                while ((matchMotivo = regexMotivo.exec(xmlGuia)) !== null) {
                    motivos.push(decodificarEntidadesXml(matchMotivo[1]));
                }
                const erroMsgLimpo = motivos.length > 0 ? motivos.join(' | ') : `Guia rejeitada pela SEFAZ (situação ${situacaoGuia})`;

                rejeicoesLote.push(`NF ${docOrigemNorm}: ${erroMsgLimpo}`);
                rejeicoesDetalhadas.push({
                    documentoOrigem: docOrigemNorm,
                    ufFavorecida: ufGuia,
                    situacaoGuia,
                    motivo: erroMsgLimpo
                });
                console.warn(`⚠ Guia individual rejeitada pela SEFAZ: NF ${docOrigemNorm} (${ufGuia || 'UF'}) - ${erroMsgLimpo}`);
                continue;
            }

            const codigoBarras = extrairTag(xmlGuia, 'codigoBarras') || extrairTag(xmlGuia, 'c30_codigoBarras');
            const linhaDigitavel = extrairTag(xmlGuia, 'linhaDigitavel') || extrairTag(xmlGuia, 'c29_linhaDigitavel');
            const numeroControle = extrairTag(xmlGuia, 'nossoNumero') || extrairTag(xmlGuia, 'c16_numeroControle') || extrairTag(xmlGuia, 'numeroControle');
            const codigoReceita = extrairTag(xmlGuia, 'receita') || extrairTag(xmlGuia, 'c02_receita') || '100102';

            const valorStr = extrairTag(xmlGuia, 'valorGNRE') ||
                             extrairTag(xmlGuia, 'c10_valorTotal') ||
                             extrairTag(xmlGuia, 'valor');

            const vencimentoStr = extrairTag(xmlGuia, 'dataVencimento') ||
                                  extrairTag(xmlGuia, 'c14_dataVencimento');

            const codBarrasLimpo = codigoBarras ? codigoBarras.replace(/[^0-9]/g, '') : '';
            const linDigitavelLimpa = linhaDigitavel ? linhaDigitavel.replace(/[^0-9]/g, '') : codBarrasLimpo;

            // Exige código de barras numérico real retornado pelo portal (44 ou 48 dígitos)
            if (!codBarrasLimpo || codBarrasLimpo.length < 44) {
                rejeicoesDetalhadas.push({
                    documentoOrigem: docOrigemNorm,
                    ufFavorecida: ufGuia,
                    situacaoGuia: situacaoGuia || 'SEM_BARRAS',
                    motivo: 'Portal SEFAZ não retornou código de barras oficial válido para esta guia.'
                });
                continue;
            }

            const chaveMatch = xmlGuia.match(/\b\d{44}\b/);
            const chaveAcessoNfe = chaveMatch ? chaveMatch[0] : null;

            guias.push({
                situacaoGuia: situacaoGuia || '0',
                numeroControle: numeroControle || null,
                codigoReceita,
                codigoBarras: codBarrasLimpo,
                linhaDigitavel: linDigitavelLimpa,
                valor: parseFloat(valorStr ? valorStr : 0),
                dataVencimento: vencimentoStr || null,
                documentoOrigem: docOrigemNorm,
                ufFavorecida: ufGuia,
                chaveAcessoNfe: chaveAcessoNfe || null
            });
        }

        // Anexa rejeições individuais ao array retornado para conciliação no banco
        Object.defineProperty(guias, 'rejeicoesDetalhadas', {
            value: rejeicoesDetalhadas,
            enumerable: false
        });

        if (guias.length === 0) {
            if (rejeicoesLote.length > 0) {
                const err = new Error(`Todas as guias do lote foram rejeitadas pelo governo: ${rejeicoesLote.join('; ')}`);
                err.rejeicoesDetalhadas = rejeicoesDetalhadas;
                throw err;
            }
            throw new Error("Nenhuma guia processada com sucesso (com código de barras oficial) foi localizada no XML de resposta.");
        }

        return guias;
    } catch (err) {
        if (err.rejeicoesDetalhadas) throw err;
        throw new Error(`Falha no processador do XML Fiscal: ${err.message}`);
    }
}

module.exports = {
    extrairTag,
    extrairDadosNfeXML,
    extrairDadosGuiaXML,
    extrairItensNfe,
    extrairDadosDevolucaoXML,
    normalizarDocumentoOrigem
};
