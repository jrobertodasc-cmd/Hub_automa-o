// services/sefaz_sp_retorno_service.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Localiza o executável do Python compatível no ambiente.
 */
function obterComandoPython() {
    const caminhosPossiveis = [
        'C:\\Users\\Roberto\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
        'python',
        'python3'
    ];
    for (const p of caminhosPossiveis) {
        if (p.includes('\\') && fs.existsSync(p)) {
            return p;
        }
    }
    return 'python';
}

/**
 * Executa o script extrator em Python sobre o arquivo .zip ou pasta enviada.
 * Retorna os dados estruturados de cada DARE processado.
 */
function extrairDadosZipRetornoSp(caminhoArquivoOuPasta) {
    return new Promise((resolve, reject) => {
        const pythonCmd = obterComandoPython();
        const scriptPath = path.join(__dirname, '..', 'scripts', 'extrair_retorno_sp_json.py');

        const proc = spawn(pythonCmd, [scriptPath, caminhoArquivoOuPasta]);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString('utf8');
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString('utf8');
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Falha no extrator Python (código ${code}): ${stderr || stdout}`));
            }

            try {
                // Remove eventuais logs antes do JSON
                const jsonStart = stdout.indexOf('{');
                if (jsonStart === -1) {
                    return reject(new Error(`Nenhum JSON retornado pelo extrator: ${stdout}`));
                }
                const jsonStr = stdout.substring(jsonStart).trim();
                const parsed = JSON.parse(jsonStr);
                if (parsed.error) {
                    return reject(new Error(parsed.error));
                }
                resolve(parsed);
            } catch (err) {
                reject(new Error(`Erro ao interpretar retorno JSON do extrator: ${err.message}. Saída: ${stdout}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Erro ao invocar Python: ${err.message}`));
        });
    });
}

/**
 * Processa a importação do ZIP de retorno da SEFAZ-SP, vinculando os códigos
 * de barras e linhas digitáveis às guias correspondentes no Supabase.
 */
async function processarRetornoSpZip({ supabase, tenantId, caminhoZip }) {
    if (!fs.existsSync(caminhoZip)) {
        throw new Error(`Arquivo ZIP não encontrado: ${caminhoZip}`);
    }

    const extracao = await extrairDadosZipRetornoSp(caminhoZip);
    const itens = extracao.itens || [];

    if (itens.length === 0) {
        return {
            sucesso: true,
            totalEncontrados: extracao.total_encontrados || 0,
            atualizadas: 0,
            ignoradasJaPagas: 0,
            naoLocalizadas: 0,
            detalhes: [],
            message: "Nenhum DARE válido com código de barras localizado no arquivo enviado."
        };
    }

    let atualizadas = 0;
    let ignoradasJaPagas = 0;
    let naoLocalizadas = 0;
    const detalhes = [];

    for (const item of itens) {
        // Tenta localizar a guia por chave de acesso (44 dígitos) ou número da nota fiscal
        let query = supabase.from('guides').select('*').eq('tenant_id', tenantId);

        if (item.chave_nfe && item.chave_nfe.length === 44) {
            query = query.eq('chave_nfe', item.chave_nfe);
        } else if (item.nota_fiscal) {
            query = query.eq('nf_number', String(item.nota_fiscal));
        } else {
            naoLocalizadas++;
            detalhes.push({ item, status: 'SEM_IDENTIFICADOR' });
            continue;
        }

        const { data: guias, error: errBusca } = await query;
        if (errBusca || !guias || guias.length === 0) {
            // Fallback por número da NF caso tenha buscado por chave
            if (item.nota_fiscal) {
                const { data: guiasFb } = await supabase
                    .from('guides')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('nf_number', String(item.nota_fiscal));

                if (guiasFb && guiasFb.length > 0) {
                    const g = guiasFb[0];
                    const resProc = await atualizarGuiaComDare(supabase, g, item);
                    if (resProc.atualizou) atualizadas++;
                    if (resProc.jaPaga) ignoradasJaPagas++;
                    detalhes.push({ nf: item.nota_fiscal, chave: item.chave_nfe, status: resProc.status });
                    continue;
                }
            }

            naoLocalizadas++;
            detalhes.push({ nf: item.nota_fiscal, chave: item.chave_nfe, status: 'NAO_LOCALIZADA_NO_BANCO' });
            continue;
        }

        const g = guias[0];
        const resProc = await atualizarGuiaComDare(supabase, g, item);
        if (resProc.atualizou) atualizadas++;
        if (resProc.jaPaga) ignoradasJaPagas++;
        detalhes.push({ nf: item.nota_fiscal, chave: item.chave_nfe, status: resProc.status });
    }

    return {
        sucesso: true,
        totalEncontrados: extracao.total_encontrados || itens.length,
        totalProcessados: itens.length,
        atualizadas,
        ignoradasJaPagas,
        naoLocalizadas,
        detalhes,
        message: `${atualizadas} DARE(s) de SP atualizado(s) com sucesso com código de barras oficial!`
    };
}

async function atualizarGuiaComDare(supabase, guia, item) {
    const st = (guia.status || '').toLowerCase();
    const jaPaga = st === 'paga' || st === 'liquidada' || st === 'baixada' || st === 'comprovada' || !!guia.paid_at;

    if (jaPaga) {
        return { atualizou: false, jaPaga: true, status: 'JA_PAGA_PRESERVADA' };
    }

    const updatePayload = {
        barcode: item.codigo_barras,
        line_digitizable: item.linha_digitavel,
        status: 'aguardando_pagamento'
    };

    const { error: errUp } = await supabase
        .from('guides')
        .update(updatePayload)
        .eq('id', guia.id);

    if (errUp) {
        return { atualizou: false, jaPaga: false, status: `ERRO_UPDATE: ${errUp.message}` };
    }

    return { atualizou: true, jaPaga: false, status: 'ATUALIZADA_COM_SUCESSO' };
}

module.exports = {
    extrairDadosZipRetornoSp,
    processarRetornoSpZip
};
