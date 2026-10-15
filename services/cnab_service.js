// services/cnab_service.js
// Geração de arquivos de remessa CNAB 240 (Itaú SISPAG)

const padZero = (num, size) => String(num || 0).padStart(size, '0').slice(0, size);
const padSpace = (str, size) => String(str || '').padEnd(size, ' ').slice(0, size);

// Remove acentos e caracteres especiais para evitar rejeição no banco
const limparTexto = (txt) => String(txt)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/gi, "")
    .toUpperCase();

// Formatadores de data para o padrão DDMMAAAA exigido pelo banco
const formatarDataCNAB = (dataStr) => {
    if (!dataStr) return padZero(0, 8);
    // Trata formato YYYY-MM-DD vindo do banco/XML
    if (dataStr.includes('-')) {
        const parts = dataStr.split('T')[0].split('-');
        if (parts.length === 3) {
            const [ano, mes, dia] = parts;
            return `${dia}${mes}${ano}`;
        }
    }
    return dataStr.replace(/[^0-9]/g, '');
};

/**
 * Gera o conteúdo de texto para remessa Itaú SISPAG CNAB 240
 * @param {Object} dadosEmpresa { cnpj, agencia, conta, dac, razaoSocial }
 * @param {Array} guiasExtraidas Lista de guias pagas com { codigoBarras, valor, dataVencimento, documentoOrigem }
 * @returns {String} Conteúdo CNAB 240 formatado com quebras CRLF (\r\n)
 */
function gerarRemessaSispag(dadosEmpresa, guiasExtraidas, dataPagamentoPersonalizada) {
    if (!dadosEmpresa || !dadosEmpresa.cnpj) {
        throw new Error("Dados da empresa inválidos ou ausentes para geração de remessa.");
    }

    // Filtra para remover guias que não possuem um código de barras numérico válido
    // (por exemplo, guias pendentes do Estado de São Paulo que ficam com "IMPORTAR_NO_SEFAZ_SP")
    const guiasValidas = (guiasExtraidas || []).filter(g => {
        if (!g.codigoBarras) return false;
        const limpo = g.codigoBarras.replace(/[^0-9]/g, '');
        // O código de barras de tributos/GNRE deve ter entre 44 e 48 dígitos numéricos
        return limpo.length >= 40 && limpo === g.codigoBarras;
    });

    if (guiasValidas.length === 0) {
        return "SEM_GUIAS_VALIDAS_PARA_CNAB\r\nEste lote não possui nenhuma guia com código de barras numérico válido emitido (ex: contém apenas guias de São Paulo que exigem importação manual no portal do Posto Fiscal/SEFAZ-SP).\r\nImporte o lote XML gerado no portal da SEFAZ-SP para obter os códigos de barras reais.";
    }

    const linhas = [];
    const agora = new Date();
    
    // Formatação de data/hora atual local (do servidor ou ajustado)
    // Usar fuso local brasileiro se possível
    const dataHoje = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(/[^0-9]/g, ''); // DDMMAAAA
    const horaHoje = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(/[^0-9]/g, ''); // HHMMSS

    let dataPagamentoFormatada = dataHoje;
    if (dataPagamentoPersonalizada) {
        if (dataPagamentoPersonalizada.includes('-')) {
            const parts = dataPagamentoPersonalizada.split('T')[0].split('-');
            if (parts.length === 3) {
                const [ano, mes, dia] = parts;
                dataPagamentoFormatada = `${dia}${mes}${ano}`;
            }
        } else {
            dataPagamentoFormatada = dataPagamentoPersonalizada.replace(/[^0-9]/g, '');
        }
    }

    // 1. REGISTRO 0: HEADER DE ARQUIVO (Layout 080)
    let headerArquivo = '';
    headerArquivo += padZero(341, 3);                              // 001-003: Banco Itaú
    headerArquivo += padZero(0, 4);                                // 004-007: Lote de Serviço
    headerArquivo += '0';                                          // 008-008: Tipo Registro (0=Header Arquivo)
    headerArquivo += padSpace('', 6);                              // 009-014: Brancos
    headerArquivo += padZero(86, 3);                               // 015-017: Versão do Layout do Arquivo (086)
    headerArquivo += '2';                                          // 018-018: Tipo Inscrição (2=CNPJ)
    headerArquivo += padZero(dadosEmpresa.cnpj.replace(/[^0-9]/g, ''), 14); // 019-032: Número CNPJ
    headerArquivo += padSpace('', 20);                             // 033-052: Código do Convênio no Banco (Brancos)
    headerArquivo += padZero(dadosEmpresa.agencia, 5);             // 053-057: Agência Débito
    headerArquivo += padSpace('', 1);                              // 058-058: Branco
    headerArquivo += padZero(dadosEmpresa.conta, 12);              // 059-070: Conta Corrente
    headerArquivo += padSpace('', 1);                              // 071-071: Branco
    headerArquivo += padZero(dadosEmpresa.dac, 1);                 // 072-072: Dígito Verificador DAC
    headerArquivo += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30); // 073-102: Nome da Empresa
    headerArquivo += padSpace("BANCO ITAU SA", 30);                // 103-132: Nome do Banco
    headerArquivo += padSpace('', 10);                             // 133-142: Uso FEBRABAN (Brancos)
    headerArquivo += '1';                                          // 143-143: Código Remessa (1)
    headerArquivo += padZero(dataHoje, 8);                         // 144-151: Data de Geração
    headerArquivo += padZero(horaHoje.padEnd(6, '0'), 6);           // 152-157: Hora de Geração
    headerArquivo += padZero(0, 9);                                // 158-166: Zeros (Complemento de Registro)
    headerArquivo += padZero(0, 5);                                // 167-171: Densidade Grav. (00000)
    headerArquivo += padSpace('', 20);                             // 172-191: Uso Banco (Brancos)
    headerArquivo += padSpace('', 20);                             // 192-211: Uso Empresa (Brancos)
    headerArquivo += padSpace('', 29);                             // 212-240: Uso FEBRABAN (Brancos)
    linhas.push(headerArquivo);

    // 2. REGISTRO 1: HEADER DE LOTE (Layout 030 - Tributos)
    let headerLote = '';
    headerLote += padZero(341, 3);                                 // 001-003: Banco
    headerLote += padZero(1, 4);                                   // 004-007: Lote Sequencial
    headerLote += '1';                                             // 008-008: Tipo Registro (1=Header Lote)
    headerLote += 'C';                                             // 009-009: Operação (C=Crédito)
    headerLote += padZero(22, 2);                                  // 010-011: Tipo de Serviço (22=Tributos)
    headerLote += padZero(91, 2);                                  // 012-013: Forma Lançamento (91=GNRE com Cód. Barras)
    headerLote += padZero(40, 3);                                  // 014-016: Layout do Lote (040)
    headerLote += padSpace('', 1);                                 // 017-017: Branco
    headerLote += '2';                                             // 018-018: Tipo Inscrição
    headerLote += padZero(dadosEmpresa.cnpj.replace(/[^0-9]/g, ''), 14); // 019-032: CNPJ Empresa
    headerLote += padSpace('', 4);                                 // 033-036: Identificação Lançamento
    headerLote += padSpace('', 16);                                // 037-052: Brancos
    headerLote += padZero(dadosEmpresa.agencia, 5);                // 053-057: Agência
    headerLote += padSpace('', 1);                                 // 058-058: Branco
    headerLote += padZero(dadosEmpresa.conta, 12);                 // 059-070: Conta
    headerLote += padSpace('', 1);                                 // 071-071: Branco
    headerLote += padZero(dadosEmpresa.dac, 1);                    // 072-072: DAC
    headerLote += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30); // 073-102: Empresa
    headerLote += padSpace('', 30);                                // 103-132: Finalidade Lote
    headerLote += padSpace('', 10);                                // 133-142: Histórico C/C
    headerLote += padSpace('', 30);                                // 143-172: Logradouro/Endereço
    headerLote += padZero(0, 5);                                   // 173-177: Número do Local (Preenchido com zeros)
    headerLote += padSpace('', 35);                                // 178-212: Bairro e Cidade
    headerLote += padZero(0, 8);                                   // 213-220: CEP (Preenchido com zeros)
    headerLote += padSpace('', 20);                                // 221-240: UF + Uso FEBRABAN
    linhas.push(headerLote);

    let totalLoteFinanceiro = 0;
    let contadorRegistrosLote = 1; // O lote começa no Header de Lote (1)

    // 3. REGISTRO 3: DETALHE - SEGMENTO O (Tributos com Código de Barras)
    guiasValidas.forEach((guia, idx) => {
        let segO = '';
        const seq = idx + 1;
        contadorRegistrosLote++; 
        totalLoteFinanceiro += parseFloat(guia.valor || 0);

        segO += padZero(341, 3);                                   // 001-003: Banco
        segO += padZero(1, 4);                                     // 004-007: Lote
        segO += '3';                                               // 008-008: Tipo Registro (3=Detalhe)
        segO += padZero(seq, 5);                                   // 009-013: Sequencial no Lote
        segO += 'O';                                               // 014-014: Segmento (O)
        segO += padZero(0, 3);                                     // 015-017: Tipo Movimento (000=Inclusão)
        segO += padSpace(guia.codigoBarras, 48);                   // 018-065: Código de Barras da Guia
        segO += padSpace("SEFAZ PE GNRE TRIBUTOS", 30);            // 066-095: Nome Concessionária/Órgão
        segO += padZero(formatarDataCNAB(guia.dataVencimento), 8); // 096-103: Vencimento
        segO += 'REA';                                             // 104-106: Moeda (REA)
        segO += padZero(0, 15);                                    // 107-121: Qtd Moeda
        
        // Valor sem pontos em centavos (Ex: 150.00 vira 15000)
        const valorEmCentavos = Math.round(parseFloat(guia.valor || 0) * 100);
        segO += padZero(valorEmCentavos, 15);                      // 122-136: Valor da Guia
        segO += padZero(dataPagamentoFormatada, 8);                      // 137-144: Data de Pagamento (Agendado)
        segO += padZero(0, 15);                                    // 145-159: Valor Pago (Preenche com zeros na remessa)
        segO += padSpace('', 3);                                   // 160-162: Brancos
        segO += padSpace('', 9);                                   // 163-171: Complemento de Registro (Devem ser Brancos)
        segO += padSpace('', 3);                                   // 172-174: Brancos
        
        // Referência do documento de origem (ex: número da nota)
        const idDoc = guia.documentoOrigem ? `GNRE-NF-${guia.documentoOrigem}` : `GNRE-SEQ-${idx + 1}`;
        segO += padSpace(idDoc, 20);                               // 175-194: Seu Número (ID do documento no seu sistema)
        segO += padSpace('', 21);                                  // 195-215: Brancos
        segO += padSpace('', 15);                                  // 216-230: Nosso Número
        segO += padSpace('', 10);                                  // 231-240: Ocorrências de retorno
        linhas.push(segO);
    });

    // 4. REGISTRO 5: TRAILER DE LOTE (Layout Tributos)
    contadorRegistrosLote++; // Adiciona o próprio trailer de lote na contagem
    let trailerLote = '';
    trailerLote += padZero(341, 3);                                // 001-003: Banco
    trailerLote += padZero(1, 4);                                  // 004-007: Lote
    trailerLote += '5';                                            // 008-008: Tipo Registro (5=Trailer Lote)
    trailerLote += padSpace('', 9);                                // 009-017: Brancos
    trailerLote += padZero(contadorRegistrosLote, 6);              // 018-023: Quantidade total de registros do lote
    
    const totalFinanceiroCentavos = Math.round(totalLoteFinanceiro * 100);
    trailerLote += padZero(totalFinanceiroCentavos, 18);           // 024-041: Somatória dos valores do lote
    trailerLote += padZero(0, 15);                                 // 042-056: Soma quantidade de moeda
    trailerLote += padSpace('', 174);                              // 057-230: Brancos Complemento
    trailerLote += padSpace('', 10);                               // 231-240: Ocorrências
    linhas.push(trailerLote);

    // 5. REGISTRO 9: TRAILER DE ARQUIVO
    let trailerArquivo = '';
    trailerArquivo += padZero(341, 3);                             // 001-003: Banco
    trailerArquivo += padZero(9999, 4);                            // 004-007: Código do Lote (9999 padrão)
    trailerArquivo += '9';                                         // 008-008: Tipo Registro (9=Trailer Arquivo)
    trailerArquivo += padSpace('', 9);                             // 009-017: Brancos
    trailerArquivo += padZero(1, 6);                               // 018-023: Quantidade de lotes do arquivo
    trailerArquivo += padZero(linhas.length + 1, 6);               // 024-029: Quantidade total de linhas do arquivo
    trailerArquivo += padSpace('', 211);                           // 030-240: Brancos
    linhas.push(trailerArquivo);

    // Validação rígida de 240 caracteres por linha
    return linhas.map((linha, index) => {
        if (linha.length !== 240) {
            throw new Error(`CRÍTICO: Linha ${index} gerada com tamanho inválido (${linha.length} bytes). O banco rejeitará o arquivo.`);
        }
        return linha;
    }).join('\r\n') + '\r\n';
}

/**
 * Faz o parsing de arquivo de retorno CNAB 240 (Itaú SISPAG Tributos)
 * Extrai pagamentos efetuados (Segmento O) e autenticações eletrônicas (Segmento Z)
 * @param {String} conteudoRetorno Conteúdo texto do arquivo .RET
 * @returns {Object} { totalProcessadas, baixadas, rejeitadas, guias: [...] }
 */
function processarRetornoSispag(conteudoRetorno) {
    if (!conteudoRetorno || typeof conteudoRetorno !== 'string') {
        throw new Error("Arquivo de retorno vazio ou inválido.");
    }

    const linhas = conteudoRetorno.split(/\r?\n/).filter(l => l.trim().length > 0);
    const pagamentos = [];
    let ultimoPagamento = null;

    for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i];
        if (linha.length < 240) continue;

        const tipoRegistro = linha.substring(7, 8); // pos 008: 0=Header, 1=Header Lote, 3=Detalhe, 5=Trailer Lote, 9=Trailer Arquivo
        if (tipoRegistro !== '3') continue;

        const segmento = linha.substring(13, 14); // pos 014: O, Z, J, etc.

        if (segmento === 'O') {
            // Segmento O: Dados do tributo pago
            const codigoBarras = linha.substring(17, 65).trim();
            const vencimentoRaw = linha.substring(95, 103).trim();
            const valorGuiaCentavos = parseInt(linha.substring(121, 136), 10) || 0;
            const dataPagamentoRaw = linha.substring(136, 144).trim();
            const valorPagoCentavos = parseInt(linha.substring(144, 159), 10) || 0;
            const seuNumero = linha.substring(174, 194).trim(); // ex: GNRE-NF-53304
            const nossoNumero = linha.substring(215, 230).trim();
            const ocorrencias = linha.substring(230, 240).trim(); // ex: 00 (Pago), BD (Agendado), etc.

            // Extrai o número da NF caso conste no seuNumero
            let nfNumber = null;
            const matchNf = seuNumero.match(/(?:NF-?|SEQ-?)(\d+)/i);
            if (matchNf) {
                nfNumber = matchNf[1];
            }

            // Formata datas YYYY-MM-DD
            const formatarDataIso = (dStr) => {
                if (!dStr || dStr.length !== 8 || dStr === '00000000') return null;
                const dia = dStr.substring(0, 2);
                const mes = dStr.substring(2, 4);
                const ano = dStr.substring(4, 8);
                return `${ano}-${mes}-${dia}`;
            };

            const status = (ocorrencias.startsWith('00') || ocorrencias === '00') ? 'PAGO' :
                           (ocorrencias.startsWith('BD') ? 'AGENDADO' : 'REJEITADO');

            ultimoPagamento = {
                codigoBarras,
                nfNumber,
                seuNumero,
                nossoNumero,
                vencimento: formatarDataIso(vencimentoRaw),
                dataPagamento: formatarDataIso(dataPagamentoRaw),
                valorGuia: valorGuiaCentavos / 100,
                valorPago: valorPagoCentavos > 0 ? (valorPagoCentavos / 100) : (valorGuiaCentavos / 100),
                ocorrencias,
                status,
                autenticacao: null
            };

            pagamentos.push(ultimoPagamento);
        } else if (segmento === 'Z') {
            // Segmento Z: Autenticação bancária do pagamento anterior
            const autenticacao = linha.substring(14, 78).trim();
            if (ultimoPagamento && autenticacao) {
                ultimoPagamento.autenticacao = autenticacao;
            }
        }
    }

    const baixadas = pagamentos.filter(p => p.status === 'PAGO').length;
    const agendadas = pagamentos.filter(p => p.status === 'AGENDADO').length;
    const rejeitadas = pagamentos.filter(p => p.status === 'REJEITADO').length;

    return {
        totalProcessadas: pagamentos.length,
        baixadas,
        agendadas,
        rejeitadas,
        pagamentos
    };
}

/**
 * Gera remessa CNAB 240 para Bradesco (Multipag / Pag-For Tributos com Código de Barras - Segmento O)
 */
function gerarRemessaBradesco(dadosEmpresa, guiasExtraidas, dataPagamentoPersonalizada) {
    if (!dadosEmpresa || !dadosEmpresa.cnpj) {
        throw new Error("Dados da empresa inválidos para remessa Bradesco.");
    }

    const guiasValidas = (guiasExtraidas || []).filter(g => {
        if (!g.codigoBarras) return false;
        const limpo = g.codigoBarras.replace(/[^0-9]/g, '');
        return limpo.length >= 40 && limpo === g.codigoBarras;
    });

    if (guiasValidas.length === 0) {
        return "SEM_GUIAS_VALIDAS_PARA_CNAB\r\nNenhuma guia válida encontrada para a remessa Bradesco.";
    }

    const linhas = [];
    const agora = new Date();
    const dataHoje = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(/[^0-9]/g, '');
    const horaHoje = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(/[^0-9]/g, '');

    let dataPagamentoFormatada = dataHoje;
    if (dataPagamentoPersonalizada) {
        if (dataPagamentoPersonalizada.includes('-')) {
            const parts = dataPagamentoPersonalizada.split('T')[0].split('-');
            dataPagamentoFormatada = `${parts[2]}${parts[1]}${parts[0]}`;
        } else {
            dataPagamentoFormatada = dataPagamentoPersonalizada.replace(/[^0-9]/g, '');
        }
    }

    // 1. Header de Arquivo (Banco 237 - Bradesco)
    let headerArq = '';
    headerArq += padZero(237, 3);                                     // 001-003: Bradesco
    headerArq += padZero(0, 4);                                       // 004-007: Lote 0000
    headerArq += '0';                                                 // 008-008: Header Arquivo
    headerArq += padSpace('', 9);                                     // 009-017: Brancos
    headerArq += '2';                                                 // 018-018: CNPJ
    headerArq += padZero(dadosEmpresa.cnpj.replace(/[^0-9]/g, ''), 14); // 019-032: CNPJ
    headerArq += padSpace(dadosEmpresa.convenio || '', 20);           // 033-052: Convênio no Bradesco
    headerArq += padZero(dadosEmpresa.agencia, 5);                    // 053-057: Agência
    headerArq += padSpace(dadosEmpresa.agenciaDac || '', 1);          // 058-058: Dígito Agência
    headerArq += padZero(dadosEmpresa.conta, 12);                     // 059-070: Conta
    headerArq += padZero(dadosEmpresa.dac, 1);                        // 071-071: Dígito Conta
    headerArq += padSpace('', 1);                                     // 072-072: Dígito Ag/Conta
    headerArq += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30); // 073-102: Nome Empresa
    headerArq += padSpace("BANCO BRADESCO S.A.", 30);                 // 103-132: Nome do Banco
    headerArq += padSpace('', 10);                                    // 133-142: Reservado
    headerArq += '1';                                                 // 143-143: Código Remessa (1)
    headerArq += padZero(dataHoje, 8);                                // 144-151: Data Geração
    headerArq += padZero(horaHoje.padEnd(6, '0'), 6);                  // 152-157: Hora Geração
    headerArq += padZero(0, 9);                                       // 158-166: Sequencial do Arquivo
    headerArq += padZero(0, 5);                                       // 167-171: Densidade
    headerArq += padSpace('', 69);                                    // 172-240: Reservado Banco/Empresa
    linhas.push(headerArq);

    // 2. Header de Lote (Tributos / Código de Barras)
    let headerLote = '';
    headerLote += padZero(237, 3);                                    // 001-003: Bradesco
    headerLote += padZero(1, 4);                                      // 004-007: Lote 0001
    headerLote += '1';                                                // 008-008: Header de Lote
    headerLote += 'C';                                                // 009-009: Operação (C=Crédito)
    headerLote += padZero(22, 2);                                     // 010-011: Serviço (22=Tributos)
    headerLote += padZero(11, 2);                                     // 012-013: Forma (11=Tributos com Código de Barras)
    headerLote += padZero(40, 3);                                     // 014-016: Layout do Lote
    headerLote += padSpace('', 1);                                    // 017-017: Branco
    headerLote += '2';                                                // 018-018: CNPJ
    headerLote += padZero(dadosEmpresa.cnpj.replace(/[^0-9]/g, ''), 14); // 019-032: CNPJ
    headerLote += padSpace(dadosEmpresa.convenio || '', 20);          // 033-052: Convênio
    headerLote += padZero(dadosEmpresa.agencia, 5);                   // 053-057: Agência
    headerLote += padSpace(dadosEmpresa.agenciaDac || '', 1);         // 058-058: DAC Agência
    headerLote += padZero(dadosEmpresa.conta, 12);                    // 059-070: Conta
    headerLote += padZero(dadosEmpresa.dac, 1);                       // 071-071: DAC Conta
    headerLote += padSpace('', 1);                                    // 072-072: DAC Ag/Conta
    headerLote += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30);// 073-102: Nome Empresa
    headerLote += padSpace('', 138);                                  // 103-240: Complemento
    linhas.push(headerLote);

    let totalLote = 0;
    let seqLote = 1;

    // 3. Segmento O (Detalhe)
    guiasValidas.forEach((guia, idx) => {
        seqLote++;
        totalLote += parseFloat(guia.valor || 0);
        let segO = '';
        segO += padZero(237, 3);                                      // 001-003: Banco
        segO += padZero(1, 4);                                        // 004-007: Lote
        segO += '3';                                                  // 008-008: Detalhe
        segO += padZero(idx + 1, 5);                                  // 009-013: Sequencial
        segO += 'O';                                                  // 014-014: Segmento O
        segO += padZero(0, 3);                                        // 015-017: Movimento Inclusão
        segO += padSpace(guia.codigoBarras, 48);                      // 018-065: Código de Barras
        segO += padSpace("SEFAZ GNRE TRIBUTOS", 30);                  // 066-095: Órgão
        segO += padZero(formatarDataCNAB(guia.dataVencimento), 8);    // 096-103: Vencimento
        segO += 'BRL';                                                // 104-106: Moeda
        segO += padZero(0, 15);                                       // 107-121: Qtd Moeda
        const vCentavos = Math.round(parseFloat(guia.valor || 0) * 100);
        segO += padZero(vCentavos, 15);                               // 122-136: Valor
        segO += padZero(dataPagamentoFormatada, 8);                   // 137-144: Data Pagamento
        segO += padZero(0, 15);                                       // 145-159: Valor Pago
        segO += padSpace('', 15);                                     // 160-174: Reservado
        const idDoc = guia.documentoOrigem ? `NF-${guia.documentoOrigem}` : `SEQ-${idx + 1}`;
        segO += padSpace(idDoc, 20);                                  // 175-194: Seu Número
        segO += padSpace('', 46);                                     // 195-240: Reservado/Ocorrências
        linhas.push(segO);
    });

    // 4. Trailer de Lote
    seqLote++;
    let trailerLote = '';
    trailerLote += padZero(237, 3);
    trailerLote += padZero(1, 4);
    trailerLote += '5';
    trailerLote += padSpace('', 9);
    trailerLote += padZero(seqLote, 6);
    trailerLote += padZero(Math.round(totalLote * 100), 18);
    trailerLote += padSpace('', 199);
    linhas.push(trailerLote);

    // 5. Trailer de Arquivo
    let trailerArq = '';
    trailerArq += padZero(237, 3);
    trailerArq += padZero(9999, 4);
    trailerArq += '9';
    trailerArq += padSpace('', 9);
    trailerArq += padZero(1, 6);
    trailerArq += padZero(linhas.length + 1, 6);
    trailerArq += padSpace('', 211);
    linhas.push(trailerArq);

    return linhas.map((l, i) => {
        if (l.length !== 240) throw new Error(`Linha ${i} Bradesco com tamanho inválido (${l.length})`);
        return l;
    }).join('\r\n') + '\r\n';
}

/**
 * Gera remessa CNAB 240 para Banco do Brasil (Código 001 - Tributos com Código de Barras - Segmento O)
 */
function gerarRemessaBB(dadosEmpresa, guiasExtraidas, dataPagamentoPersonalizada) {
    if (!dadosEmpresa || !dadosEmpresa.cnpj) {
        throw new Error("Dados da empresa inválidos para remessa Banco do Brasil.");
    }

    const guiasValidas = (guiasExtraidas || []).filter(g => {
        if (!g.codigoBarras) return false;
        const limpo = g.codigoBarras.replace(/[^0-9]/g, '');
        return limpo.length >= 40 && limpo === g.codigoBarras;
    });

    if (guiasValidas.length === 0) {
        return "SEM_GUIAS_VALIDAS_PARA_CNAB\r\nNenhuma guia válida encontrada para a remessa Banco do Brasil.";
    }

    const linhas = [];
    const agora = new Date();
    const dataHoje = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(/[^0-9]/g, '');
    const horaHoje = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(/[^0-9]/g, '');

    let dataPagamentoFormatada = dataHoje;
    if (dataPagamentoPersonalizada) {
        if (dataPagamentoPersonalizada.includes('-')) {
            const parts = dataPagamentoPersonalizada.split('T')[0].split('-');
            dataPagamentoFormatada = `${parts[2]}${parts[1]}${parts[0]}`;
        } else {
            dataPagamentoFormatada = dataPagamentoPersonalizada.replace(/[^0-9]/g, '');
        }
    }

    // 1. Header de Arquivo (Banco 001 - Banco do Brasil)
    let headerArq = '';
    headerArq += padZero(1, 3);                                       // 001-003: BB
    headerArq += padZero(0, 4);                                       // 004-007: Lote 0000
    headerArq += '0';                                                 // 008-008: Header Arquivo
    headerArq += padSpace('', 9);                                     // 009-017: Brancos
    headerArq += '2';                                                 // 018-018: CNPJ
    headerArq += padZero(dadosEmpresa.cnpj.replace(/[^0-9]/g, ''), 14); // 019-032: CNPJ
    headerArq += padSpace(dadosEmpresa.convenio || '', 20);           // 033-052: Convênio no BB
    headerArq += padZero(dadosEmpresa.agencia, 5);                    // 053-057: Agência
    headerArq += padSpace(dadosEmpresa.agenciaDac || '', 1);          // 058-058: Dígito Agência
    headerArq += padZero(dadosEmpresa.conta, 12);                     // 059-070: Conta
    headerArq += padZero(dadosEmpresa.dac, 1);                        // 071-071: Dígito Conta
    headerArq += padSpace('', 1);                                     // 072-072: Dígito Ag/Conta
    headerArq += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30); // 073-102: Nome Empresa
    headerArq += padSpace("BANCO DO BRASIL S.A.", 30);                // 103-132: Nome do Banco
    headerArq += padSpace('', 10);                                    // 133-142: Reservado
    headerArq += '1';                                                 // 143-143: Código Remessa (1)
    headerArq += padZero(dataHoje, 8);                                // 144-151: Data Geração
    headerArq += padZero(horaHoje.padEnd(6, '0'), 6);                  // 152-157: Hora Geração
    headerArq += padZero(0, 9);                                       // 158-166: Sequencial
    headerArq += padZero(0, 5);                                       // 167-171: Densidade
    headerArq += padSpace('', 69);                                    // 172-240: Reservado
    linhas.push(headerArq);

    // 2. Header de Lote (Tributos com Código de Barras)
    let headerLote = '';
    headerLote += padZero(1, 3);
    headerLote += padZero(1, 4);
    headerLote += '1';
    headerLote += 'C';
    headerLote += padZero(20, 2);                                     // 010-011: Tipo Serviço Pagamento
    headerLote += padZero(11, 2);                                     // 012-013: Forma Lançamento
    headerLote += padZero(40, 3);
    headerLote += padSpace('', 1);
    headerLote += '2';
    headerLote += padZero(dadosEmpresa.cnpj.replace(/[^0-9]/g, ''), 14);
    headerLote += padSpace(dadosEmpresa.convenio || '', 20);
    headerLote += padZero(dadosEmpresa.agencia, 5);
    headerLote += padSpace(dadosEmpresa.agenciaDac || '', 1);
    headerLote += padZero(dadosEmpresa.conta, 12);
    headerLote += padZero(dadosEmpresa.dac, 1);
    headerLote += padSpace('', 1);
    headerLote += padSpace(limparTexto(dadosEmpresa.razaoSocial), 30);
    headerLote += padSpace('', 138);
    linhas.push(headerLote);

    let totalLote = 0;
    let seqLote = 1;

    // 3. Segmento O (Detalhe)
    guiasValidas.forEach((guia, idx) => {
        seqLote++;
        totalLote += parseFloat(guia.valor || 0);
        let segO = '';
        segO += padZero(1, 3);
        segO += padZero(1, 4);
        segO += '3';
        segO += padZero(idx + 1, 5);
        segO += 'O';
        segO += padZero(0, 3);
        segO += padSpace(guia.codigoBarras, 48);
        segO += padSpace("SEFAZ GNRE TRIBUTOS", 30);
        segO += padZero(formatarDataCNAB(guia.dataVencimento), 8);
        segO += 'BRL';
        segO += padZero(0, 15);
        const vCentavos = Math.round(parseFloat(guia.valor || 0) * 100);
        segO += padZero(vCentavos, 15);
        segO += padZero(dataPagamentoFormatada, 8);
        segO += padZero(0, 15);
        segO += padSpace('', 15);
        const idDoc = guia.documentoOrigem ? `NF-${guia.documentoOrigem}` : `SEQ-${idx + 1}`;
        segO += padSpace(idDoc, 20);
        segO += padSpace('', 46);
        linhas.push(segO);
    });

    // 4. Trailer de Lote
    seqLote++;
    let trailerLote = '';
    trailerLote += padZero(1, 3);
    trailerLote += padZero(1, 4);
    trailerLote += '5';
    trailerLote += padSpace('', 9);
    trailerLote += padZero(seqLote, 6);
    trailerLote += padZero(Math.round(totalLote * 100), 18);
    trailerLote += padSpace('', 199);
    linhas.push(trailerLote);

    // 5. Trailer de Arquivo
    let trailerArq = '';
    trailerArq += padZero(1, 3);
    trailerArq += padZero(9999, 4);
    trailerArq += '9';
    trailerArq += padSpace('', 9);
    trailerArq += padZero(1, 6);
    trailerArq += padZero(linhas.length + 1, 6);
    trailerArq += padSpace('', 211);
    linhas.push(trailerArq);

    return linhas.map((l, i) => {
        if (l.length !== 240) throw new Error(`Linha ${i} BB com tamanho inválido (${l.length})`);
        return l;
    }).join('\r\n') + '\r\n';
}

module.exports = {
    gerarRemessaSispag,
    gerarRemessaBradesco,
    gerarRemessaBB,
    processarRetornoSispag
};
