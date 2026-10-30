// services/sefaz_sp_retorno_service.js
// Extrator 100% Node.js nativo (sem dependência de Python/PyMuPDF) para arquivos .ZIP ou .PDF de retorno DARE-SP.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const {
    PDFDocument,
    PDFName,
    PDFDict,
    PDFArray,
    PDFRawStream,
    PDFRef
} = require('pdf-lib');

const GLYPH_NAME_TO_CHAR = {
    space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
    ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
    plus: '+', comma: ',', hyphen: '-', minus: '-', period: '.', slash: '/',
    zero: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
    bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
    grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~'
};

function calcularModulo10(numStr) {
    let soma = 0;
    let peso = 2;
    for (let i = numStr.length - 1; i >= 0; i--) {
        const mult = parseInt(numStr[i], 10) * peso;
        soma += mult >= 10 ? (Math.floor(mult / 10) + (mult % 10)) : mult;
        peso = peso === 2 ? 1 : 2;
    }
    const resto = soma % 10;
    return (10 - resto) % 10;
}

function calcularModulo11Arrecadacao(numStr) {
    let soma = 0;
    let peso = 2;
    for (let i = numStr.length - 1; i >= 0; i--) {
        soma += parseInt(numStr[i], 10) * peso;
        peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    if (resto === 0 || resto === 1) return 0;
    if (resto === 10) return 1;
    return 11 - resto;
}

function montarLinhaDigitavelDe44(bar44) {
    if (!bar44 || bar44.length !== 44 || !bar44.startsWith('8')) return null;
    const idValor = bar44[2];
    const calcDv = (idValor === '6' || idValor === '8') ? calcularModulo10 : calcularModulo11Arrecadacao;
    const b1 = bar44.slice(0, 11);
    const b2 = bar44.slice(11, 22);
    const b3 = bar44.slice(22, 33);
    const b4 = bar44.slice(33, 44);
    return `${b1}-${calcDv(b1)} ${b2}-${calcDv(b2)} ${b3}-${calcDv(b3)} ${b4}-${calcDv(b4)}`;
}

function inflatePdfStream(streamObj) {
    if (!streamObj || !(streamObj instanceof PDFRawStream)) return Buffer.alloc(0);
    let buf = Buffer.from(streamObj.contents);
    const filter = streamObj.dict.get(PDFName.of('Filter'));
    const fStr = filter ? filter.toString() : '';
    if (fStr.includes('FlateDecode')) {
        try {
            buf = zlib.inflateSync(buf);
        } catch (e) {
            try { buf = zlib.inflateRawSync(buf); } catch (e2) {}
        }
    }
    return buf;
}

function parseToUnicodeCMap(cmapText) {
    const map = new Map();
    let isTwoByte = /<0000>\s*<FFFF>/i.test(cmapText);

    const hexToStr = (hex) => {
        const clean = hex.replace(/[^0-9a-fA-F]/g, '');
        let out = '';
        for (let i = 0; i < clean.length; i += 4) {
            const code = parseInt(clean.slice(i, i + 4), 16);
            if (!isNaN(code)) out += String.fromCodePoint(code);
        }
        return out;
    };

    const bfCharBlocks = cmapText.match(/beginbfchar([\s\S]*?)endbfchar/gi) || [];
    for (const block of bfCharBlocks) {
        const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let m;
        while ((m = pairRe.exec(block)) !== null) {
            if (m[1].length === 4) isTwoByte = true;
            map.set(parseInt(m[1], 16), hexToStr(m[2]));
        }
    }

    const bfRangeBlocks = cmapText.match(/beginbfrange([\s\S]*?)endbfrange/gi) || [];
    for (const block of bfRangeBlocks) {
        const lines = block.split(/\r?\n/);
        for (const line of lines) {
            const mArr = line.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/);
            if (mArr) {
                if (mArr[1].length === 4) isTwoByte = true;
                const start = parseInt(mArr[1], 16);
                const end = parseInt(mArr[2], 16);
                const targets = [...mArr[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => hexToStr(x[1]));
                for (let c = start; c <= end && (c - start) < targets.length; c++) {
                    map.set(c, targets[c - start]);
                }
                continue;
            }
            const mSeq = line.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
            if (mSeq) {
                if (mSeq[1].length === 4) isTwoByte = true;
                const start = parseInt(mSeq[1], 16);
                const end = parseInt(mSeq[2], 16);
                const base = parseInt(mSeq[3], 16);
                for (let c = start; c <= end; c++) {
                    map.set(c, String.fromCodePoint(base + (c - start)));
                }
            }
        }
    }

    return { map, isTwoByte };
}

function parseEncodingDifferences(encObj, ctx) {
    const resolved = encObj instanceof PDFRef ? ctx.lookup(encObj) : encObj;
    if (!(resolved instanceof PDFDict)) return null;
    const diffEntry = resolved.get(PDFName.of('Differences'));
    const diffs = diffEntry instanceof PDFRef ? ctx.lookup(diffEntry) : diffEntry;
    if (!(diffs instanceof PDFArray)) return null;

    const map = new Map();
    let code = 0;
    for (let i = 0; i < diffs.size(); i++) {
        const item = diffs.get(i);
        const s = item.toString();
        if (/^\d+$/.test(s)) {
            code = parseInt(s, 10);
        } else if (s.startsWith('/')) {
            const gName = s.slice(1);
            if (GLYPH_NAME_TO_CHAR[gName]) {
                map.set(code, GLYPH_NAME_TO_CHAR[gName]);
            } else if (gName.length === 1) {
                map.set(code, gName);
            } else if (/^uni([0-9A-Fa-f]{4})$/.test(gName)) {
                map.set(code, String.fromCharCode(parseInt(gName.slice(3), 16)));
            }
            code++;
        }
    }
    return map.size > 0 ? { map, isTwoByte: false } : null;
}

function unescapePdfLiteralBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '\\' && i + 1 < str.length) {
            const next = str[++i];
            if (next >= '0' && next <= '7') {
                let oct = next;
                if (i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '7') oct += str[++i];
                if (i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '7') oct += str[++i];
                bytes.push(parseInt(oct, 8) & 0xFF);
            } else if (next === 'n') bytes.push(10);
            else if (next === 'r') bytes.push(13);
            else if (next === 't') bytes.push(9);
            else if (next === 'b') bytes.push(8);
            else if (next === 'f') bytes.push(12);
            else if (next === '\r' || next === '\n') {
                if (next === '\r' && str[i + 1] === '\n') i++;
            } else {
                bytes.push(next.charCodeAt(0) & 0xFF);
            }
        } else {
            bytes.push(ch.charCodeAt(0) & 0xFF);
        }
    }
    return Buffer.from(bytes);
}

function decodePdfBytesWithFont(buf, fontInfo) {
    if (fontInfo && fontInfo.map && fontInfo.map.size > 0) {
        let out = '';
        if (fontInfo.isTwoByte && buf.length % 2 === 0) {
            for (let i = 0; i < buf.length; i += 2) {
                const code = (buf[i] << 8) | buf[i + 1];
                out += fontInfo.map.has(code) ? fontInfo.map.get(code) : String.fromCharCode(code);
            }
            return out;
        }
        for (let i = 0; i < buf.length; i++) {
            const code = buf[i];
            out += fontInfo.map.has(code) ? fontInfo.map.get(code) : String.fromCharCode(code);
        }
        return out;
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
        let out = '';
        for (let i = 2; i + 1 < buf.length; i += 2) {
            out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
        }
        return out;
    }
    return buf.toString('latin1');
}

function extractTextFromContentStream(streamStr, fontMap) {
    let currentFont = null;
    let lastTmY = null;
    const chunks = [];

    const tokenRe = /\/([A-Za-z0-9_.\-+]+)\s+[-+]?\d*\.?\d+\s+Tf|([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+(?:Td|TD)|[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+([-+]?\d*\.?\d+)\s+Tm|\[((?:[^\[\]\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*)\]\s*TJ|\(((?:[^()\\]|\\[\s\S])*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]+)>\s*(?:Tj|'|")|\b(T\*|ET)\b/g;
    let m;
    while ((m = tokenRe.exec(streamStr)) !== null) {
        if (m[1]) {
            currentFont = fontMap.get(m[1]) || null;
        } else if (m[2] !== undefined && m[3] !== undefined) {
            const tx = parseFloat(m[2]);
            const ty = parseFloat(m[3]);
            if (Math.abs(ty) > 1.2) {
                chunks.push('\n');
            } else if (tx > 14) {
                chunks.push(' ');
            }
        } else if (m[4] !== undefined) {
            const tmY = parseFloat(m[4]);
            if (lastTmY !== null && Math.abs(tmY - lastTmY) > 2) {
                chunks.push('\n');
            }
            lastTmY = tmY;
        } else if (m[5] !== undefined) {
            const arrContent = m[5];
            const subRe = /\(((?:[^()\\]|\\[\s\S])*)\)|<([0-9a-fA-F\s]+)>|([-+]?\d*\.?\d+)/g;
            let sm;
            let linePart = '';
            while ((sm = subRe.exec(arrContent)) !== null) {
                if (sm[1] !== undefined) {
                    linePart += decodePdfBytesWithFont(unescapePdfLiteralBytes(sm[1]), currentFont);
                } else if (sm[2] !== undefined) {
                    const hex = sm[2].replace(/\s+/g, '');
                    if (hex.length > 0) {
                        linePart += decodePdfBytesWithFont(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex'), currentFont);
                    }
                } else if (sm[3] !== undefined) {
                    const kern = parseFloat(sm[3]);
                    if (kern < -120) linePart += ' ';
                }
            }
            chunks.push(linePart);
        } else if (m[6] !== undefined) {
            chunks.push(decodePdfBytesWithFont(unescapePdfLiteralBytes(m[6]), currentFont));
        } else if (m[7] !== undefined) {
            const hex = m[7].replace(/\s+/g, '');
            if (hex.length > 0) {
                chunks.push(decodePdfBytesWithFont(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex'), currentFont));
            }
        } else if (m[8]) {
            if (m[8] === 'T*') chunks.push('\n');
            else chunks.push(' ');
        }
    }
    return chunks.join('');
}

async function extrairPaginasTextoPdf(pdfBuffer) {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const ctx = pdfDoc.context;
    const pages = pdfDoc.getPages();

    const collectFontsFromResources = (resDict, fontMap) => {
        if (!resDict) return null;
        const resolvedRes = resDict instanceof PDFRef ? ctx.lookup(resDict) : resDict;
        if (!(resolvedRes instanceof PDFDict)) return null;

        const fontsEntry = resolvedRes.get(PDFName.of('Font'));
        const fontsDict = fontsEntry instanceof PDFRef ? ctx.lookup(fontsEntry) : fontsEntry;
        if (fontsDict instanceof PDFDict) {
            for (const [k, v] of fontsDict.entries()) {
                const fontName = k.toString().replace(/^\//, '');
                const fontObj = v instanceof PDFRef ? ctx.lookup(v) : v;
                if (fontObj instanceof PDFDict) {
                    const toUniRef = fontObj.get(PDFName.of('ToUnicode'));
                    const toUniStream = toUniRef instanceof PDFRef ? ctx.lookup(toUniRef) : toUniRef;
                    if (toUniStream instanceof PDFRawStream) {
                        const cmapStr = inflatePdfStream(toUniStream).toString('latin1');
                        fontMap.set(fontName, parseToUnicodeCMap(cmapStr));
                        continue;
                    }
                    const encRef = fontObj.get(PDFName.of('Encoding'));
                    if (encRef) {
                        const diffInfo = parseEncodingDifferences(encRef, ctx);
                        if (diffInfo) fontMap.set(fontName, diffInfo);
                    }
                }
            }
        }
        return resolvedRes;
    };

    const processPageOrForm = (dict, streamBuf, inheritedFontMap) => {
        const fontMap = new Map(inheritedFontMap || []);
        const res = dict.get(PDFName.of('Resources'));
        const resolvedRes = collectFontsFromResources(res, fontMap);

        let text = extractTextFromContentStream(streamBuf.toString('latin1'), fontMap);

        if (resolvedRes instanceof PDFDict) {
            const xObjEntry = resolvedRes.get(PDFName.of('XObject'));
            const xObjDict = xObjEntry instanceof PDFRef ? ctx.lookup(xObjEntry) : xObjEntry;
            if (xObjDict instanceof PDFDict) {
                for (const [, xv] of xObjDict.entries()) {
                    const xStream = xv instanceof PDFRef ? ctx.lookup(xv) : xv;
                    if (xStream instanceof PDFRawStream) {
                        const sub = xStream.dict.get(PDFName.of('Subtype'));
                        if (sub && sub.toString() === '/Form') {
                            text += '\n' + processPageOrForm(xStream.dict, inflatePdfStream(xStream), fontMap);
                        }
                    }
                }
            }
        }
        return text;
    };

    const pageTexts = [];
    for (let idx = 0; idx < pages.length; idx++) {
        const page = pages[idx];
        const contentsEntry = page.node.get(PDFName.of('Contents'));
        const resolvedContents = contentsEntry instanceof PDFRef ? ctx.lookup(contentsEntry) : contentsEntry;
        const streamBuffers = [];
        if (resolvedContents instanceof PDFRawStream) {
            streamBuffers.push(inflatePdfStream(resolvedContents));
        } else if (resolvedContents instanceof PDFArray) {
            for (let i = 0; i < resolvedContents.size(); i++) {
                const item = resolvedContents.get(i);
                const sObj = item instanceof PDFRef ? ctx.lookup(item) : item;
                if (sObj instanceof PDFRawStream) streamBuffers.push(inflatePdfStream(sObj));
            }
        }
        pageTexts.push(processPageOrForm(page.node, Buffer.concat(streamBuffers), null));
    }

    return { pdfDoc, pageTexts };
}

function validarExtrair48Digitos(clean48) {
    if (!clean48 || clean48.length !== 48 || !/^85[689]/.test(clean48)) return null;
    const b1 = clean48.slice(0, 11);
    const d1 = parseInt(clean48.slice(11, 12), 10);
    const b2 = clean48.slice(12, 23);
    const d2 = parseInt(clean48.slice(23, 24), 10);
    const b3 = clean48.slice(24, 35);
    const d3 = parseInt(clean48.slice(35, 36), 10);
    const b4 = clean48.slice(36, 47);
    const d4 = parseInt(clean48.slice(47, 48), 10);

    const idValor = clean48[2];
    const calcDv = (idValor === '6' || idValor === '8') ? calcularModulo10 : calcularModulo11Arrecadacao;
    const dvValido = (calcDv(b1) === d1 && calcDv(b2) === d2 && calcDv(b3) === d3 && calcDv(b4) === d4);

    return {
        dvValido,
        linha_digitavel: `${b1}-${d1} ${b2}-${d2} ${b3}-${d3} ${b4}-${d4}`,
        codigo_barras: b1 + b2 + b3 + b4
    };
}

function interpretarTextoDareSp(text, nomeArquivo = '') {
    if (!text) return null;

    // 1. Linha Digitável formato padrão com hífens/espaços (85810000000-5 19170185112-0 ...)
    let linha_digitavel = null;
    let codigo_barras = null;

    const ldMatch = text.match(/(?<!\d)(85[689]\d{8}\s*-\s*\d[\s\r\n]+\d{11}\s*-\s*\d[\s\r\n]+\d{11}\s*-\s*\d[\s\r\n]+\d{11}\s*-\s*\d)(?!\d)/)
        || text.match(/(?<!\d)(85[689]\d{8}\s+\d[\s\r\n]+\d{11}\s+\d[\s\r\n]+\d{11}\s+\d[\s\r\n]+\d{11}\s+\d)(?!\d)/);

    if (ldMatch) {
        const res48 = validarExtrair48Digitos(ldMatch[1].replace(/\D/g, ''));
        if (res48) {
            linha_digitavel = res48.linha_digitavel;
            codigo_barras = res48.codigo_barras;
        }
    }

    // Fallback: 48 dígitos contínuos ou quebrados em 2 linhas (validados pelos 4 dígitos verificadores FEBRABAN)
    if (!codigo_barras) {
        const candidatos48 = [...text.matchAll(/(?<!\d)(85[689](?:[\s\-]*\d){45})(?!\d)/g)];
        for (const m of candidatos48) {
            const res48 = validarExtrair48Digitos(m[1].replace(/\D/g, ''));
            if (res48 && res48.dvValido) {
                linha_digitavel = res48.linha_digitavel;
                codigo_barras = res48.codigo_barras;
                break;
            }
        }
        if (!codigo_barras && candidatos48.length > 0) {
            const res48 = validarExtrair48Digitos(candidatos48[0][1].replace(/\D/g, ''));
            if (res48) {
                linha_digitavel = res48.linha_digitavel;
                codigo_barras = res48.codigo_barras;
            }
        }
    }

    if (!codigo_barras) {
        const m44 = text.match(/(?<!\d)(85[689]\d{41})(?!\d)/);
        if (m44) {
            codigo_barras = m44[1];
            linha_digitavel = montarLinhaDigitavelDe44(codigo_barras);
        }
    }

    if (!codigo_barras && !linha_digitavel) {
        return null;
    }

    // 2. Número do DARE
    const dareMatch = text.match(/(?:09\s*-\s*)?N[ºuú?o°]*mero\s+do\s+DARE[\s:]*(\d{10,20})/i);
    const numero_dare = dareMatch ? dareMatch[1] : null;

    // 3. Nota Fiscal (texto ou nome do arquivo)
    let nota_fiscal = null;
    const nfPatterns = [
        /NOTA\s*FISCAL\s*[:\-º°]*\s*0*(\d{3,10})/i,
        /N[ºuú?o°]*mero\s+da\s+Nota\s*Fiscal[\s:]*0*(\d{3,10})/i,
        /NF-?e?\s*[nº°:\-]+\s*0*(\d{3,10})/i,
        /Documento\s+de\s+Origem[\s:]*0*(\d{3,10})/i
    ];
    for (const re of nfPatterns) {
        const m = text.match(re);
        if (m && m[1]) {
            nota_fiscal = String(parseInt(m[1], 10));
            break;
        }
    }
    if (!nota_fiscal && nomeArquivo) {
        const mFile = path.basename(nomeArquivo).match(/(?:NF|NOTA|DARE)[_\-\s]*0*(\d{4,9})/i);
        if (mFile && mFile[1]) {
            nota_fiscal = String(parseInt(mFile[1], 10));
        }
    }

    // 4. Chave de Acesso da NF-e (44 dígitos reais de NF-e modelo 55, ignorando o código de barras 858...)
    let chave_nfe = null;
    const chaveExplicita = text.match(/Campo\s*Extra[\s:]*(\d{44})/i)
        || text.match(/Chave\s*(?:de\s*Acesso)?[\s:]*(\d{44})/i);
    if (chaveExplicita && !/^85[689]/.test(chaveExplicita[1])) {
        chave_nfe = chaveExplicita[1];
    } else {
        const all44 = [...text.matchAll(/\b(\d{44})\b/g)].map(x => x[1]);
        for (const cand of all44) {
            if (!/^85[689]/.test(cand) && cand !== codigo_barras && cand.slice(20, 22) === '55') {
                chave_nfe = cand;
                break;
            }
        }
    }

    // Se tem chave_nfe mas não achou nota_fiscal no texto, extrai o nNF das posições 25..34 da chave de 44 dígitos!
    if (!nota_fiscal && chave_nfe && chave_nfe.length === 44) {
        const nNfFromKey = parseInt(chave_nfe.slice(25, 34), 10);
        if (!isNaN(nNfFromKey) && nNfFromKey > 0) {
            nota_fiscal = String(nNfFromKey);
        }
    }

    // 5. Data de Vencimento
    let data_vencimento = null;
    const vencMatch = text.match(/(?:07\s*-\s*)?Data\s+de\s+Vencimento[\s:]*(\d{2}\/\d{2}\/\d{4})/i);
    if (vencMatch) {
        data_vencimento = vencMatch[1];
    } else if (codigo_barras && codigo_barras.length === 44 && /^20[23]\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(codigo_barras.slice(36, 44))) {
        const ymd = codigo_barras.slice(36, 44);
        data_vencimento = `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
    }

    // 6. Valor Total (R$ ou centavos do próprio código de barras FEBRABAN posições 4..15)
    let valor = null;
    const valorMatch = text.match(/(?:08\s*-\s*)?Valor\s+Total(?:\s+do\s+Documento)?[\s:]*(?:R\$\s*)?([\d.]+,\d{2})/i);
    if (valorMatch && valorMatch[1]) {
        valor = parseFloat(valorMatch[1].replace(/\./g, '').replace(',', '.'));
    } else if (codigo_barras && codigo_barras.length === 44 && (codigo_barras[2] === '8' || codigo_barras[2] === '6')) {
        const centavos = parseInt(codigo_barras.slice(4, 15), 10);
        if (!isNaN(centavos) && centavos > 0) valor = centavos / 100;
    }

    return {
        arquivo: path.basename(nomeArquivo || 'dare_sp.pdf'),
        linha_digitavel,
        codigo_barras,
        numero_dare,
        nota_fiscal,
        chave_nfe,
        data_vencimento,
        valor
    };
}

async function extrairItensDePdfBuffer(pdfBuffer, nomeArquivo) {
    const { pdfDoc, pageTexts } = await extrairPaginasTextoPdf(pdfBuffer);
    const itensPagina = [];

    for (let i = 0; i < pageTexts.length; i++) {
        const parsed = interpretarTextoDareSp(pageTexts[i], nomeArquivo);
        if (parsed) {
            itensPagina.push({ parsed, pageIndex: i });
        }
    }

    // Se encontrou múltiplos DAREs distintos em um único PDF multipágina, recorta 1 PDF por página
    if (itensPagina.length > 1) {
        const resultados = [];
        for (const entry of itensPagina) {
            const singleDoc = await PDFDocument.create();
            const [copiedPage] = await singleDoc.copyPages(pdfDoc, [entry.pageIndex]);
            singleDoc.addPage(copiedPage);
            const singleBytes = await singleDoc.save({ useObjectStreams: true });
            resultados.push({
                ...entry.parsed,
                pdfBuffer: Buffer.from(singleBytes)
            });
        }
        return resultados;
    }

    if (itensPagina.length === 1) {
        return [{
            ...itensPagina[0].parsed,
            pdfBuffer
        }];
    }

    // Fallback: texto concatenado de todas as páginas
    const fullParsed = interpretarTextoDareSp(pageTexts.join('\n'), nomeArquivo);
    if (fullParsed) {
        return [{
            ...fullParsed,
            pdfBuffer
        }];
    }

    return [];
}

/**
 * Extrai os dados estruturados de todos os PDFs de DARE-SP contidos em um .ZIP, .PDF ou diretório.
 */
async function extrairDadosZipRetornoSp(caminhoArquivoOuPasta) {
    const pdfEntries = [];

    const stat = fs.statSync(caminhoArquivoOuPasta);
    if (stat.isDirectory()) {
        const walk = (dir) => {
            for (const f of fs.readdirSync(dir)) {
                const full = path.join(dir, f);
                if (fs.statSync(full).isDirectory()) walk(full);
                else if (f.toLowerCase().endsWith('.pdf')) {
                    pdfEntries.push({ name: f, buffer: fs.readFileSync(full) });
                }
            }
        };
        walk(caminhoArquivoOuPasta);
    } else {
        const rawBuf = fs.readFileSync(caminhoArquivoOuPasta);
        const isPdfMagic = rawBuf.slice(0, 5).toString('ascii') === '%PDF-';
        const isZipMagic = rawBuf.length >= 4 && rawBuf[0] === 0x50 && rawBuf[1] === 0x4B;

        if (isPdfMagic) {
            pdfEntries.push({ name: path.basename(caminhoArquivoOuPasta), buffer: rawBuf });
        } else if (isZipMagic || caminhoArquivoOuPasta.toLowerCase().endsWith('.zip')) {
            const zip = new AdmZip(rawBuf);
            for (const entry of zip.getEntries()) {
                if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.pdf')) {
                    pdfEntries.push({
                        name: path.basename(entry.entryName),
                        buffer: entry.getData()
                    });
                }
            }
        } else {
            throw new Error('Formato de arquivo inválido. Envie o arquivo .ZIP ou .PDF gerado pelo portal DARE-SP.');
        }
    }

    const itens = [];
    for (const p of pdfEntries) {
        try {
            const extraidos = await extrairItensDePdfBuffer(p.buffer, p.name);
            itens.push(...extraidos);
        } catch (errPdf) {
            console.warn(`[DARE-SP] Falha ao ler PDF ${p.name}:`, errPdf.message);
        }
    }

    return {
        success: true,
        total_encontrados: pdfEntries.length,
        total_processados: itens.length,
        itens
    };
}

/**
 * Processa a importação do ZIP/PDF de retorno da SEFAZ-SP, vinculando códigos
 * de barras, linhas digitáveis e o PDF oficial da DARE às guias de SP no Supabase.
 */
async function processarRetornoSpZip({ supabase, tenantId, caminhoZip }) {
    if (!fs.existsSync(caminhoZip)) {
        throw new Error(`Arquivo não encontrado: ${caminhoZip}`);
    }

    const extracao = await extrairDadosZipRetornoSp(caminhoZip);
    const itens = extracao.itens || [];

    if (itens.length === 0) {
        return {
            sucesso: true,
            totalEncontrados: extracao.total_encontrados || 0,
            totalProcessados: 0,
            atualizadas: 0,
            ignoradasJaPagas: 0,
            naoLocalizadas: 0,
            detalhes: [],
            message: 'Nenhum DARE-SP válido com código de barras foi localizado no arquivo enviado.'
        };
    }

    let atualizadas = 0;
    let ignoradasJaPagas = 0;
    let naoLocalizadas = 0;
    const detalhes = [];

    for (const item of itens) {
        let guiaEncontrada = null;

        // 1. Busca pela chave de acesso de 44 dígitos da NF-e
        if (item.chave_nfe && item.chave_nfe.length === 44) {
            const { data: gChave } = await supabase
                .from('guides')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('chave_nfe', item.chave_nfe)
                .order('created_at', { ascending: false })
                .limit(1);
            if (gChave && gChave.length > 0) guiaEncontrada = gChave[0];
        }

        // 2. Busca pelo número da Nota Fiscal (com ou sem zeros à esquerda)
        if (!guiaEncontrada && item.nota_fiscal) {
            const nfSemZero = String(parseInt(item.nota_fiscal, 10));
            const { data: gNf } = await supabase
                .from('guides')
                .select('*')
                .eq('tenant_id', tenantId)
                .in('nf_number', [String(item.nota_fiscal), nfSemZero])
                .order('created_at', { ascending: false })
                .limit(1);
            if (gNf && gNf.length > 0) guiaEncontrada = gNf[0];
        }

        // 3. Fallback seguro: se a DARE não trouxe nNF legível, mas existe exatamente 1 guia SP pendente com o mesmo valor exato
        if (!guiaEncontrada && typeof item.valor === 'number' && item.valor > 0) {
            const { data: spPendentes } = await supabase
                .from('guides')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('uf', 'SP')
                .eq('barcode', 'IMPORTAR_NO_SEFAZ_SP');

            const candidatas = (spPendentes || []).filter(g => Math.abs(parseFloat(g.value || 0) - item.valor) < 0.02);
            if (candidatas.length === 1) {
                guiaEncontrada = candidatas[0];
            }
        }

        if (!guiaEncontrada) {
            naoLocalizadas++;
            detalhes.push({ nf: item.nota_fiscal, chave: item.chave_nfe, valor: item.valor, status: 'NAO_LOCALIZADA_NO_BANCO' });
            continue;
        }

        const resProc = await atualizarGuiaComDare(supabase, tenantId, guiaEncontrada, item);
        if (resProc.atualizou) atualizadas++;
        if (resProc.jaPaga) ignoradasJaPagas++;
        detalhes.push({
            nf: guiaEncontrada.nf_number || item.nota_fiscal,
            chave: item.chave_nfe,
            status: resProc.status
        });
    }

    return {
        sucesso: true,
        totalEncontrados: extracao.total_encontrados || itens.length,
        totalProcessados: itens.length,
        atualizadas,
        ignoradasJaPagas,
        naoLocalizadas,
        detalhes,
        message: atualizadas > 0
            ? `${atualizadas} DARE(s) de SP importada(s) com sucesso! Status alterado para Emitida · A Pagar.`
            : `Arquivo lido (${itens.length} DARE), mas nenhuma guia pendente correspondente foi atualizada (${ignoradasJaPagas} já paga(s), ${naoLocalizadas} não localizada(s)).`
    };
}

async function atualizarGuiaComDare(supabase, tenantId, guia, item) {
    const st = (guia.status || '').toLowerCase();
    const jaPaga = st === 'paga' || st === 'liquidada' || st === 'baixada' || st === 'comprovada' || !!guia.paid_at;

    if (jaPaga) {
        return { atualizou: false, jaPaga: true, status: 'JA_PAGA_PRESERVADA' };
    }

    let remoteDarePdfPath = guia.storage_path || null;
    if (item.pdfBuffer && item.pdfBuffer.length > 100) {
        try {
            const targetPath = `${tenantId}/guias/dare_sp_NF_${guia.nf_number}.pdf`;
            const { error: upStorageErr } = await supabase.storage
                .from('tenant-storage')
                .upload(targetPath, item.pdfBuffer, {
                    contentType: 'application/pdf',
                    upsert: true
                });
            if (!upStorageErr) {
                remoteDarePdfPath = targetPath;
            }
        } catch (eSt) {}
    }

    const updatePayload = {
        barcode: item.codigo_barras,
        line_digitizable: item.linha_digitavel || item.codigo_barras,
        status: 'aguardando_pagamento'
    };
    if (remoteDarePdfPath) {
        updatePayload.storage_path = remoteDarePdfPath;
    }

    const { error: errUp } = await supabase
        .from('guides')
        .update(updatePayload)
        .eq('id', guia.id)
        .eq('tenant_id', tenantId);

    if (errUp) {
        return { atualizou: false, jaPaga: false, status: `ERRO_UPDATE: ${errUp.message}` };
    }

    return { atualizou: true, jaPaga: false, status: 'ATUALIZADA_COM_SUCESSO' };
}

module.exports = {
    extrairDadosZipRetornoSp,
    processarRetornoSpZip,
    interpretarTextoDareSp
};
