// services/gnre_service.js
// Comunicação SOAP com a SEFAZ e emissão de guias GNRE

const https = require('https');
const fs = require('fs').promises;
const path = require('path');

// URLs SEFAZ PE (Ambientes homologação e produção)
const URLS_SEFAZ = {
    producao: {
        recepcao: "https://www.gnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao",
        consulta: "https://www.gnre.pe.gov.br/gnreWS/services/GnreResultadoLote"
    },
    simulado: {
        recepcao: "https://www.testegnre.pe.gov.br/gnreWS/services/GnreLoteRecepcao",
        consulta: "https://www.testegnre.pe.gov.br/gnreWS/services/GnreResultadoLote"
    }
};

function escapeXml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Cria o agente HTTPS com certificado digital para autenticação mTLS
 */
function createHttpsAgent({ pfxBuffer, passphrase }) {
    if (!pfxBuffer) {
        throw new Error("Certificado PFX ausente para inicialização do agente mTLS.");
    }

    // Validação TLS habilitada por padrão; permite override explícito apenas se SEFAZ_INSECURE_TLS=true
    const rejectUnauthorized = process.env.SEFAZ_INSECURE_TLS === 'true' ? false : true;
    const tlsOptions = {
        pfx: pfxBuffer,
        passphrase: passphrase,
        keepAlive: true,
        rejectUnauthorized
    };

    if (process.env.SEFAZ_CA_PEM) {
        tlsOptions.ca = process.env.SEFAZ_CA_PEM;
    }

    if (process.env.PROXY_HOST) {
        const proxyPort = process.env.PROXY_PORT || '8080';
        const proxyUser = process.env.PROXY_USER || '';
        const proxyPass = process.env.PROXY_PASSWORD || '';

        let proxyUrl = '';
        if (proxyUser && proxyPass) {
            proxyUrl = `http://${proxyUser}:${proxyPass}@${process.env.PROXY_HOST}:${proxyPort}`;
        } else {
            proxyUrl = `http://${process.env.PROXY_HOST}:${proxyPort}`;
        }

        try {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            return new HttpsProxyAgent(proxyUrl, tlsOptions);
        } catch (err) {
            console.error("⚠️ Falha ao inicializar HttpsProxyAgent (certifique-se de rodar npm install):", err.message);
        }
    }

    return new https.Agent(tlsOptions);
}

function sendSoapRequest(urlStr, soapAction, xmlPayload, agent) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const options = {
            method: 'POST',
            hostname: url.hostname,
            path: url.pathname + url.search,
            port: url.port || 443,
            agent: agent,
            timeout: 60000,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8;',
                'SOAPAction': soapAction,
                'Content-Length': Buffer.byteLength(xmlPayload)
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => { responseData += chunk; });
            res.on('end', () => { resolve({ statusCode: res.statusCode, body: responseData }); });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error("Timeout na comunicação com a SEFAZ"));
        });

        req.on('error', (err) => { reject(err); });
        req.write(xmlPayload);
        req.end();
    });
}

// Remove acentos, caracteres especiais e espaços nas bordas (exigência XSD SEFAZ)
const limparTexto = (txt) => String(txt || '')
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

/**
 * Constrói a string XML interna com a lista de guias <TDadosGNRE>
 */
function construirXmlGuias(listaGuias, dadosEmpresa) {
    let xmlGuias = '';
    const hoje = new Date().toISOString().split('T')[0];

    const primeiraGuia = listaGuias[0] || {};
    const rawMunEmit = String(dadosEmpresa.municipio || primeiraGuia.emitMunicipio || "").replace(/[^0-9]/g, '');
    const emitente = {
        cnpj: String(dadosEmpresa.cnpj || primeiraGuia.cnpjEmitente || "").replace(/[^0-9]/g, ''),
        razaoSocial: escapeXml(limparTexto(dadosEmpresa.razaoSocial || dadosEmpresa.razao_social || primeiraGuia.emitRazaoSocial || "Empresa Emitente").substring(0, 60).trim()),
        endereco: escapeXml(limparTexto(dadosEmpresa.endereco || primeiraGuia.emitEndereco || "").substring(0, 60).trim()),
        municipio: escapeXml(rawMunEmit.slice(-5)),
        uf: escapeXml((dadosEmpresa.uf || primeiraGuia.ufEmitente || "").toUpperCase().trim()),
        cep: String(dadosEmpresa.cep || primeiraGuia.emitCep || "").replace(/[^0-9]/g, '')
    };

    for (const guia of listaGuias) {
        const ufFav = (guia.ufFavorecida || '').toUpperCase().trim();
        if (!ufFav || ufFav.length !== 2) {
            throw new Error(`UF Favorecida ausente ou inválida para a NF ${guia.documentoOrigem || 'N/A'}.`);
        }

        let xmlCamposExtras = '';
        let camposExtras = [];

        // Código do campo extra para a Chave de Acesso NFe conforme a UF
        let codigoCampoChave = 55;
        if (ufFav === 'MA') {
            codigoCampoChave = 94;
        } else if (ufFav === 'MS') {
            codigoCampoChave = 88;
        } else if (ufFav === 'PR') {
            codigoCampoChave = 107;
        } else if (ufFav === 'SC') {
            codigoCampoChave = 84;
        } else if (ufFav === 'PB') {
            codigoCampoChave = 99;
        } else if (ufFav === 'SE') {
            codigoCampoChave = 77;
        }

        // UFs que não utilizam ou rejeitam campos adicionais na receita 100102
        if (!['PE', 'RN', 'DF'].includes(ufFav)) {
            if (guia.chaveAcessoNfe) {
                camposExtras.push({ codigo: codigoCampoChave, valor: escapeXml(guia.chaveAcessoNfe) });
            }
        }

        // Caso especial do Rio de Janeiro com a data de emissão
        if (ufFav === 'RJ' && guia.dataEmissaoRJ) {
            camposExtras.push({ codigo: 117, valor: escapeXml(guia.dataEmissaoRJ) });
        }

        if (camposExtras.length > 0) {
            xmlCamposExtras = '\n                <camposExtras>';
            for (const ce of camposExtras) {
                xmlCamposExtras += `
                  <campoExtra>
                    <codigo>${ce.codigo}</codigo>
                    <valor>${ce.valor}</valor>
                  </campoExtra>`;
            }
            xmlCamposExtras += '\n                </camposExtras>';
        }

        let tipoDoc = guia.tipoDocumentoOrigem || '10';
        let numDoc = guia.documentoOrigem;

        if (['RJ', 'SC', 'PE'].includes(ufFav)) {
            tipoDoc = '24';
            numDoc = guia.chaveAcessoNfe;
        } else if (['AL', 'RN', 'DF'].includes(ufFav)) {
            tipoDoc = '22';
            numDoc = guia.chaveAcessoNfe;
        }

        let xmlDocOrigem = '';
        const ufsRejeitamDocOrigem = ['RS'];
        if (!ufsRejeitamDocOrigem.includes(ufFav) && numDoc) {
            xmlDocOrigem = `\n                <documentoOrigem tipo="${escapeXml(tipoDoc)}">${escapeXml(numDoc)}</documentoOrigem>`;
        }

        let xmlConvenio = '';
        if (ufFav === 'AL') {
            xmlConvenio = '\n                <convenio>093/15</convenio>';
        }

        let xmlReferencia = '';
        let mesAp = guia.mesApuracao;
        let anoAp = guia.anoApuracao;
        if (ufFav === 'SE') {
            const dObj = new Date();
            mesAp = String(dObj.getMonth() + 1).padStart(2, '0');
            anoAp = String(dObj.getFullYear());
        }
        if (mesAp && anoAp) {
            xmlReferencia = `
                <referencia>
                  <periodo>0</periodo>
                  <mes>${escapeXml(mesAp)}</mes>
                  <ano>${escapeXml(anoAp)}</ano>
                </referencia>`;
        }

        let xmlDestinatario = '';
        if (guia.destCnpjCpf && (guia.destTipoIdentificacao === 'CNPJ' || guia.destTipoIdentificacao === 'CPF')) {
            const nomeLimpo = escapeXml(limparTexto(guia.destNome).substring(0, 60).trim());
            const mun5Digitos = guia.destMun ? escapeXml(String(guia.destMun).replace(/[^0-9]/g, '').slice(-5)) : '';
            xmlDestinatario = `
                <contribuinteDestinatario>
                  <identificacao>
                    <${guia.destTipoIdentificacao}>${escapeXml(guia.destCnpjCpf)}</${guia.destTipoIdentificacao}>
                  </identificacao>
                  <razaoSocial>${nomeLimpo}</razaoSocial>
                  <municipio>${mun5Digitos}</municipio>
                </contribuinteDestinatario>`;
        }

        let xmlValorFecp = '';
        if (ufFav === 'SE' && guia.valorFecp) {
            xmlValorFecp = `\n                <valor tipo="12">${escapeXml(guia.valorFecp)}</valor>`;
        }

        xmlGuias += `
          <TDadosGNRE versao="2.00">
            <ufFavorecida>${escapeXml(ufFav)}</ufFavorecida>
            <tipoGnre>0</tipoGnre>
            <contribuinteEmitente>
              <identificacao>
                <CNPJ>${emitente.cnpj}</CNPJ>
              </identificacao>
              <razaoSocial>${emitente.razaoSocial}</razaoSocial>
              <endereco>${emitente.endereco}</endereco>
              <municipio>${emitente.municipio}</municipio>
              <uf>${emitente.uf}</uf>
              <cep>${emitente.cep}</cep>
            </contribuinteEmitente>
            <itensGNRE>
              <item>
                <receita>${escapeXml(guia.codigoReceita || '100102')}</receita>${xmlDocOrigem}${xmlReferencia}
                <dataVencimento>${escapeXml(guia.dataVencimento || hoje)}</dataVencimento>
                <valor tipo="11">${escapeXml(guia.valor)}</valor>${xmlValorFecp}
                <valor tipo="21">${escapeXml(guia.valor)}</valor>${xmlConvenio}${xmlDestinatario}${xmlCamposExtras}
              </item>
            </itensGNRE>
            <valorGNRE>${escapeXml(guia.valor)}</valorGNRE>
            <dataPagamento>${escapeXml(guia.dataPagamento || hoje)}</dataPagamento>
          </TDadosGNRE>`;
    }
    return xmlGuias;
}

/**
 * Monta o lote XML de envio de guias GNRE (com envelope SOAP para webservice)
 */
function montarXmlLote(listaGuias, dadosEmpresa) {
    const xmlGuias = construirXmlGuias(listaGuias, dadosEmpresa);
    return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <gnreCabecMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreLoteRecepcao">
      <versaoDados>2.00</versaoDados>
    </gnreCabecMsg>
  </soap12:Header>
  <soap12:Body>
    <gnreDadosMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreLoteRecepcao">
      <TLote_GNRE xmlns="http://www.gnre.pe.gov.br" versao="2.00">
        <guias>${xmlGuias}
        </guias>
      </TLote_GNRE>
    </gnreDadosMsg>
  </soap12:Body>
</soap12:Envelope>`.trim();
}

/**
 * Gera o XML de lote GNRE puro (sem envelope SOAP)
 */
function gerarXmlLoteRaw(listaGuias, dadosEmpresa) {
    const xmlGuias = construirXmlGuias(listaGuias, dadosEmpresa);
    return `<?xml version="1.0" encoding="UTF-8"?>
<TLote_GNRE xmlns="http://www.gnre.pe.gov.br" versao="2.00">
  <guias>${xmlGuias}
  </guias>
</TLote_GNRE>`.trim();
}

/**
 * Envia o lote de guias para a SEFAZ
 */
async function enviarLote(listaGuias, agent, uf, environment, dadosEmpresa, logsDir) {
    const isProducao = environment === 'producao';
    const urls = isProducao ? URLS_SEFAZ.producao : URLS_SEFAZ.simulado;

    const soapXml = montarXmlLote(listaGuias, dadosEmpresa);
    const timestamp = Date.now();

    // Só grava XML em disco local se explicitamente habilitado para debug seguro
    if (logsDir && process.env.SAVE_DEBUG_XML_LOGS === 'true') {
        await fs.mkdir(logsDir, { recursive: true });
        await fs.writeFile(path.join(logsDir, `envio_lote_${timestamp}_${uf || 'geral'}.xml`), soapXml, 'utf-8');
    }

    let response;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
        response = await sendSoapRequest(urls.recepcao, 'processar', soapXml, agent);
        if (response.statusCode === 429 || (response.body && response.body.includes('429 Too Many Requests'))) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        break;
    }

    if (logsDir && process.env.SAVE_DEBUG_XML_LOGS === 'true') {
        await fs.writeFile(path.join(logsDir, `resposta_lote_${timestamp}_${uf || 'geral'}.xml`), response.body, 'utf-8');
    }

    const codigoMatch = response.body.match(/<(?:[a-zA-Z0-9]+:)?codigo>([^<]+)<\/(?:[a-zA-Z0-9]+:)?codigo>/);
    const descricaoMatch = response.body.match(/<(?:[a-zA-Z0-9]+:)?descricao>([^<]+)<\/(?:[a-zA-Z0-9]+:)?descricao>/);
    const reciboMatch = response.body.match(/<(?:[a-zA-Z0-9]+:)?numero>([^<]+)<\/(?:[a-zA-Z0-9]+:)?numero>/);

    if (!reciboMatch) {
        if (descricaoMatch && descricaoMatch[1]) {
            let desc = descricaoMatch[1]
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
            throw new Error(`Rejeição da SEFAZ (Código ${codigoMatch ? codigoMatch[1] : 'N/A'}): ${desc}`);
        }
        throw new Error("Lote rejeitado ou estrutura inválida na resposta da SEFAZ.");
    }

    return reciboMatch[1];
}

/**
 * Consulta o processamento do lote na SEFAZ
 */
async function consultarLote(numeroRecibo, agent, uf, environment, logsDir) {
    const isProducao = environment === 'producao';
    const urls = isProducao ? URLS_SEFAZ.producao : URLS_SEFAZ.simulado;

    const soapXml = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <gnreCabecMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreResultadoLote">
      <versaoDados>2.00</versaoDados>
    </gnreCabecMsg>
  </soap12:Header>
  <soap12:Body>
    <gnreDadosMsg xmlns="http://www.gnre.pe.gov.br/webservice/GnreResultadoLote">
      <TConsLote_GNRE xmlns="http://www.gnre.pe.gov.br">
        <ambiente>${isProducao ? '1' : '2'}</ambiente>
        <numeroRecibo>${escapeXml(numeroRecibo)}</numeroRecibo>
      </TConsLote_GNRE>
    </gnreDadosMsg>
  </soap12:Body>
</soap12:Envelope>`.trim();

    const response = await sendSoapRequest(urls.consulta, 'consultar', soapXml, agent);

    if (logsDir && process.env.SAVE_DEBUG_XML_LOGS === 'true') {
        await fs.mkdir(logsDir, { recursive: true });
        await fs.writeFile(path.join(logsDir, `resultado_consulta_${numeroRecibo}.xml`), response.body, 'utf-8');
    }

    return response.body;
}

// Funções auxiliares para geração do código de barras
function gerarSvgI25(codigo) {
    const padroes = {
        '0': 'NNWWN', '1': 'WNNNW', '2': 'NWNNW', '3': 'WWNNN', '4': 'NNWNW',
        '5': 'WNWNN', '6': 'NWWNN', '7': 'NNNWW', '8': 'WNNWN', '9': 'NWNWN'
    };

    let bars = '1010'; // Start

    const codLimpo = String(codigo || '').replace(/[^0-9]/g, '');
    if (!codLimpo || codLimpo.length % 2 !== 0) return '';

    for (let i = 0; i < codLimpo.length; i += 2) {
        const digito1 = codLimpo.charAt(i);
        const digito2 = codLimpo.charAt(i + 1);
        const p1 = padroes[digito1];
        const p2 = padroes[digito2];

        for (let j = 0; j < 5; j++) {
            const bWidth = p1.charAt(j) === 'W' ? '111' : '1';
            const sWidth = p2.charAt(j) === 'W' ? '000' : '0';
            bars += bWidth + sWidth;
        }
    }

    bars += '11101'; // Stop

    let svgContent = '';
    let x = 0;
    const altura = 60;
    let index = 0;
    while (index < bars.length) {
        let count = 0;
        const char = bars.charAt(index);
        while (index < bars.length && bars.charAt(index) === char) {
            count++;
            index++;
        }

        const largura = count * 1.25;
        if (char === '1') {
            svgContent += `<rect x="${x}" y="0" width="${largura}" height="${altura}" fill="#000000" />`;
        }
        x += largura;
    }

    return `<svg width="${x}" height="${altura}" viewBox="0 0 ${x} ${altura}" xmlns="http://www.w3.org/2000/svg" style="display: block; margin: 0 auto;">${svgContent}</svg>`;
}

function formatarLinhaDigitavelVisual(ld) {
    if (!ld) return '';
    const l = ld.replace(/[^0-9]/g, '');
    if (l.length === 48) {
        return `${l.slice(0, 12)} ${l.slice(12, 24)} ${l.slice(24, 36)} ${l.slice(36, 48)}`;
    }
    if (l.length === 44) {
        return `${l.slice(0, 11)} ${l.slice(11, 22)} ${l.slice(22, 33)} ${l.slice(33, 44)}`;
    }
    return ld;
}

function formatarDataVisual(dataStr) {
    if (!dataStr) return '';
    if (dataStr.includes('-')) {
        const parts = dataStr.split('T')[0].split('-');
        if (parts.length === 3) {
            const [ano, mes, dia] = parts;
            return `${dia}/${mes}/${ano}`;
        }
    }
    if (dataStr.length === 8) {
        return `${dataStr.slice(0, 2)}/${dataStr.slice(2, 4)}/${dataStr.slice(4, 8)}`;
    }
    return dataStr;
}

function formatarMoedaVisual(val) {
    return parseFloat(val || 0).toFixed(2).replace('.', ',');
}

/**
 * Renderiza o espelho de conferência da guia GNRE em formato HTML
 * Prioriza estritamente os dados retornados pelo portal SEFAZ (`dadosGuia`) e bloqueia divergências de UF.
 */
function exportarGuiaHtml(dadosEmpresa, dadosGuia, dadosNfeExtraidos) {
    const ufRetornada = (dadosGuia?.ufFavorecida || '').toUpperCase().trim();
    const ufNfe = (dadosNfeExtraidos?.ufFavorecida || '').toUpperCase().trim();

    if (ufRetornada && ufNfe && ufRetornada !== ufNfe) {
        throw new Error(
            `Divergência crítica de UF na NF ${dadosGuia?.documentoOrigem || dadosNfeExtraidos?.documentoOrigem}: NF-e indica ${ufNfe}, mas retorno SEFAZ indica ${ufRetornada}.`
        );
    }

    const ufFavorecida = ufRetornada || ufNfe;
    if (!ufFavorecida || ufFavorecida.length !== 2) {
        throw new Error("UF Favorecida ausente para geração do espelho da guia.");
    }

    const codigoReceita = escapeHtml(dadosGuia?.codigoReceita || dadosNfeExtraidos?.codigoReceita || "100102");
    const numeroNota = escapeHtml(dadosGuia?.documentoOrigem || dadosNfeExtraidos?.documentoOrigem || "SEM_NUMERO");
    const chaveAcessoNfe = escapeHtml(dadosNfeExtraidos?.chaveAcessoNfe || dadosGuia?.chaveAcessoNfe || "NÃO INFORMADA");
    const numeroControle = escapeHtml(dadosGuia?.numeroControle || "CONSULTE PELO RECIBO/CÓDIGO DE BARRAS NO PORTAL GNRE");
    const reciboLote = escapeHtml(dadosGuia?.recibo || "-");
    const isSimulado = !!dadosGuia?.simulado;

    const dataVencimentoFormatada = escapeHtml(formatarDataVisual(dadosGuia.dataVencimento || dadosNfeExtraidos?.dataVencimento));
    const valorTotal = formatarMoedaVisual(dadosGuia.valor);
    const linhaDigitavelFormatada = escapeHtml(formatarLinhaDigitavelVisual(dadosGuia.linhaDigitavel));
    const svgBarcode = gerarSvgI25(dadosGuia.codigoBarras);

    let valorPrincipal = formatarMoedaVisual(dadosGuia.valor);
    let instrucoesAdicionais = "";

    if (dadosNfeExtraidos && dadosNfeExtraidos.valor && parseFloat(dadosNfeExtraidos.valor) < parseFloat(dadosGuia.valor)) {
        const difal = parseFloat(dadosNfeExtraidos.valor);
        const fcp = parseFloat(dadosGuia.valor) - difal;
        valorPrincipal = formatarMoedaVisual(difal);
        instrucoesAdicionais = `<br><br><b>Detalhamento dos Valores:</b><br>DIFAL Principal: R$ ${valorPrincipal}<br>Fundo de Combate à Pobreza (FCP): R$ ${formatarMoedaVisual(fcp)}`;
    }

    const cnpjEmitente = (dadosEmpresa.cnpj || '').replace(/[^0-9]/g, '');
    const cnpjFormatado = cnpjEmitente.length === 14
        ? cnpjEmitente.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
        : cnpjEmitente;

    const bannerSimulado = isSimulado
        ? `<div style="background:#fee2e2;color:#991b1b;border:2px solid #dc2626;padding:8px;text-align:center;font-weight:bold;font-size:12px;margin-bottom:10px;">
            AMBIENTE SIMULADO / HOMOLOGAÇÃO — PRÉVIA SEM VALOR FISCAL — NÃO PAGAR
           </div>`
        : `<div style="background:#fef3c7;color:#92400e;border:1px solid #f59e0b;padding:6px;text-align:center;font-weight:bold;font-size:10px;margin-bottom:8px;">
            ESPELHO DE CONFERÊNCIA INTERNA (WEBSERVICE SEFAZ) — CONFIRA NO PORTAL GNRE OFICIAL ANTES DE PAGAR
           </div>`;

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Espelho GNRE - Nota Fiscal ${numeroNota}</title>
    <style>
        body { font-family: Arial, sans-serif; font-size: 11px; color: #000; margin: 20px; }
        .guia-container { width: 680px; border: 2px solid #000; padding: 10px; margin-bottom: 20px; background: #fff; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .titulo-guia { font-size: 13px; font-weight: bold; text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 8px; }
        .table-guia { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
        .table-guia td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
        .label { font-size: 8px; text-transform: uppercase; font-weight: bold; color: #444; display: block; margin-bottom: 2px; }
        .valor { font-size: 11px; font-weight: bold; }
        .destaque { background-color: #f2f2f2; }
        .linha-digitavel { font-family: monospace; font-size: 13px; font-weight: bold; text-align: center; margin: 15px 0; letter-spacing: 0.5px; }
        .barcode-container { text-align: center; margin: 15px 0; }
        .autenticacao { font-size: 8px; text-align: right; border-top: 1px dashed #000; padding-top: 5px; margin-top: 15px; color: #666; }
        .via-titulo { font-size: 10px; font-weight: bold; text-align: right; margin-bottom: 5px; text-transform: uppercase; }
        @media print {
            body { margin: 0; }
            .guia-container { border: 1px solid #000; box-shadow: none; }
        }
    </style>
</head>
<body>

    <div class="guia-container">
        ${bannerSimulado}
        <div class="via-titulo">Espelho de Conferência — Via Contribuinte</div>
        <div class="titulo-guia">ESPELHO DE DADOS GNRE (WEBSERVICE SEFAZ v2.00)</div>
        
        <table class="table-guia">
            <tr>
                <td colspan="3" width="60%">
                    <span class="label">Contribuinte Emitente</span>
                    <span class="valor">${escapeHtml(dadosEmpresa.razaoSocial || dadosEmpresa.razao_social)}</span><br>
                    <span class="label" style="margin-top:4px;">CNPJ</span>
                    <span>${escapeHtml(cnpjFormatado)}</span>
                </td>
                <td width="20%" class="destaque">
                    <span class="label">UF Favorecida</span>
                    <span class="valor" style="font-size: 14px;">${escapeHtml(ufFavorecida)}</span>
                </td>
                <td width="20%" class="destaque">
                    <span class="label">Código da Receita</span>
                    <span class="valor" style="font-size: 14px;">${codigoReceita}</span>
                </td>
            </tr>
            <tr>
                <td colspan="3">
                    <span class="label">Documento de Origem</span>
                    <span class="valor">Nota Fiscal Eletrônica (NF-e) nº ${numeroNota}</span>
                </td>
                <td>
                    <span class="label">Data de Vencimento</span>
                    <span class="valor">${dataVencimentoFormatada}</span>
                </td>
                <td>
                    <span class="label">Recibo Lote SEFAZ</span>
                    <span class="valor">${reciboLote}</span>
                </td>
            </tr>
            <tr>
                <td colspan="3" rowspan="3">
                    <span class="label">Chave de Acesso da NF-e</span>
                    <span class="valor" style="font-family: monospace; font-size: 10px;">${chaveAcessoNfe}</span>
                    <br><br>
                    <span class="label">Número de Controle SEFAZ</span>
                    <span class="valor" style="font-family: monospace; font-size: 10px;">${numeroControle}</span>
                    <br><br>
                    <span class="label">Instruções</span>
                    <span style="font-size: 9px; color: #555;">Espelho gerado a partir do retorno do Webservice GNRE v2.00.<br>Destinado ao recolhimento de DIFAL - Consumidor Final não contribuinte.${instrucoesAdicionais}</span>
                </td>
                <td class="destaque">
                    <span class="label">Valor Principal</span>
                    <span class="valor">R$ ${valorPrincipal}</span>
                </td>
                <td class="destaque">
                    <span class="label">Atualização Monetária</span>
                    <span class="valor">R$ 0,00</span>
                </td>
            </tr>
            <tr>
                <td class="destaque">
                    <span class="label">Juros / Encargos</span>
                    <span class="valor">R$ 0,00</span>
                </td>
                <td class="destaque">
                    <span class="label">Multa de Mora</span>
                    <span class="valor">R$ 0,00</span>
                </td>
            </tr>
            <tr>
                <td class="destaque" style="border-top: 2px solid #000;">
                    <span class="label">Valor Total</span>
                    <span class="valor" style="font-size: 12px;">R$ ${valorTotal}</span>
                </td>
                <td class="destaque" style="border-top: 2px solid #000;">
                    <span class="label">Ambiente</span>
                    <span class="valor">${isSimulado ? 'SIMULADO' : 'PRODUÇÃO'}</span>
                </td>
            </tr>
        </table>

        <div class="linha-digitavel">${linhaDigitavelFormatada}</div>
        
        <div class="barcode-container">
            ${svgBarcode}
        </div>
        
        <div class="autenticacao">Espelho Interno expedi HUB — Recibo SEFAZ: ${reciboLote} — UF: ${escapeHtml(ufFavorecida)}</div>
    </div>

</body>
</html>`.trim();
}

module.exports = {
    createHttpsAgent,
    enviarLote,
    consultarLote,
    exportarGuiaHtml,
    gerarSvgI25,
    formatarLinhaDigitavelVisual,
    formatarDataVisual,
    formatarMoedaVisual,
    gerarXmlLoteRaw
};
