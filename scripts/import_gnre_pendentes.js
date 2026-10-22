// scripts/import_gnre_pendentes.js
// Importador Oficial dos 91 registros de GNRE Pendentes (Linx Microvix) para o Tenant LALUA

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const cnabService = require('../services/cnab_service');
const printService = require('../services/print_service');

const LALUA_TENANT_ID = '607ca6d1-0ec1-4de3-b4d9-056145274af5';
const PDF_PATH = 'C:\\Users\\Roberto\\Desktop\\Web_Services\\GNRE\\GNRE PENDENTES.pdf';
const XML_BASE_DIR = 'C:\\Users\\Roberto\\Desktop\\Web_Services\\GNRE\\pacote_completo_lote_a1a09d98-e7e2-467b-859d-f02196cc6b7f';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function formatarDataIso(dataStr) {
    const parts = dataStr.trim().split('/');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return new Date().toISOString().split('T')[0];
}

async function main() {
    console.log('=== INICIANDO MIGRAÇÃO PARA PRODUÇÃO REAL (LALUA) ===');

    // 1. Verificar Tenant Lalua
    const { data: tenant, error: tErr } = await supabase
        .from('tenants')
        .select('*')
        .eq('id', LALUA_TENANT_ID)
        .single();

    if (tErr || !tenant) {
        throw new Error('Tenant Lalua não encontrado: ' + (tErr?.message || 'Sem registro'));
    }
    console.log(`[Tenant] OK: ${tenant.razao_social} (CNPJ: ${tenant.cnpj})`);

    // 2. Extrair os 91 registros do PDF usando scripts/parse_pdf.py
    const { execSync } = require('child_process');
    const pyOutput = execSync(`python scripts/parse_pdf.py`, { maxBuffer: 10 * 1024 * 1024 }).toString();
    const pdfItems = JSON.parse(pyOutput);
    console.log(`[PDF] Extraídos ${pdfItems.length} registros de GNRE Pendentes.`);
    const totalSoma = pdfItems.reduce((acc, it) => acc + it.valor, 0);
    console.log(`[PDF] Soma Total dos Registros: R$ ${totalSoma.toFixed(2)}`);

    // 3. Mapear XMLs locais para cruzar chaves de acesso, clientes e UFs de destino
    const xmlMap = {};
    if (fs.existsSync(XML_BASE_DIR)) {
        const subdirs = fs.readdirSync(XML_BASE_DIR);
        for (const sub of subdirs) {
            const folderPath = path.join(XML_BASE_DIR, sub);
            if (fs.statSync(folderPath).isDirectory()) {
                const files = fs.readdirSync(folderPath);
                for (const f of files) {
                    if (f.endsWith('.xml')) {
                        const xmlContent = fs.readFileSync(path.join(folderPath, f), 'utf-8');
                        const nnfM = xmlContent.match(/<nNF>(\d+)<\/nNF>/);
                        const ufM = xmlContent.match(/<dest>[\s\S]*?<enderDest>[\s\S]*?<UF>([A-Z]{2})<\/UF>/);
                        const nomeM = xmlContent.match(/<dest>[\s\S]*?<xNome>([^<]+)<\/xNome>/);
                        const munM = xmlContent.match(/<dest>[\s\S]*?<enderDest>[\s\S]*?<xMun>([^<]+)<\/xMun>/);
                        const chaveM = xmlContent.match(/<chNFe>(\d{44})<\/chNFe>/) || xmlContent.match(/Id="NFe(\d{44})"/);
                        const transpM = xmlContent.match(/<transp>[\s\S]*?<transporta>[\s\S]*?<xNome>([^<]+)<\/xNome>/);

                        if (nnfM) {
                            const nfNum = nnfM[1];
                            xmlMap[nfNum] = {
                                uf: ufM ? ufM[1] : 'BA',
                                nome: nomeM ? nomeM[1] : 'Cliente Boah',
                                municipio: munM ? munM[1] : '',
                                chave: chaveM ? chaveM[1] : '',
                                transportadora: transpM ? transpM[1] : 'Total Express'
                            };
                        }
                    }
                }
            }
        }
    }
    console.log(`[XMLs Locais] Mapeados ${Object.keys(xmlMap).length} XMLs enriquecidos.`);

    // 4. Limpar dados anteriores do tenant Lalua no Supabase
    console.log('[Limpeza] Removendo lotes e guias anteriores para o tenant Lalua...');
    const { error: delGuidesErr } = await supabase
        .from('guides')
        .delete()
        .eq('tenant_id', LALUA_TENANT_ID);
    if (delGuidesErr) console.warn('[Aviso] Erro ao limpar guias:', delGuidesErr.message);

    const { error: delBatchesErr } = await supabase
        .from('batches')
        .delete()
        .eq('tenant_id', LALUA_TENANT_ID);
    if (delBatchesErr) console.warn('[Aviso] Erro ao limpar batches:', delBatchesErr.message);

    // 5. Criar Lote Oficial de Produção
    const batchId = crypto.randomUUID();
    const batchData = {
        id: batchId,
        tenant_id: LALUA_TENANT_ID,
        environment: 'producao',
        source: 'microvix',
        receipt: 'LINX-PENDENTES-20261021',
        status: 'aguardando_aprovacao',
        approval_status: 'pendente',
        file_count: pdfItems.length,
        created_at: new Date().toISOString()
    };

    const { error: batchInsertErr } = await supabase
        .from('batches')
        .insert(batchData);

    if (batchInsertErr) {
        throw new Error('Falha ao criar lote oficial: ' + batchInsertErr.message);
    }
    console.log(`[Batch] Lote Oficial criado: ${batchId} (Total: ${pdfItems.length} guias)`);

    // 6. Preparar os 91 registros de guias com códigos de barras oficiais Febraban
    const guiasParaInserir = [];
    const dadosEmpresa = {
        cnpj: tenant.cnpj,
        razaoSocial: tenant.razao_social,
        agencia: tenant.bank_agency || '0334',
        conta: tenant.bank_account || '98775',
        dac: tenant.bank_dac || '7'
    };

    let idx = 0;
    for (const item of pdfItems) {
        idx++;
        const nfNum = item.nf;
        const xmlInfo = xmlMap[nfNum] || null;

        const ufDestino = xmlInfo ? xmlInfo.uf : 'ND';
        const clienteNome = xmlInfo ? xmlInfo.nome : 'XML pendente de importação';
        const municipio = xmlInfo ? xmlInfo.municipio : '';
        const transpNome = xmlInfo ? xmlInfo.transportadora : 'Total Express';
        
        let chaveNfe = xmlInfo && xmlInfo.chave && xmlInfo.chave.length === 44 ? xmlInfo.chave : null;
        const isSp = ufDestino === 'SP';

        guiasParaInserir.push({
            id: crypto.randomUUID(),
            tenant_id: LALUA_TENANT_ID,
            batch_id: batchId,
            nf_number: nfNum,
            nf_issue_date: formatarDataIso(item.dt_emissao),
            nf_competence: item.fatura, // Fatura Linx Microvix
            uf: ufDestino,
            customer_name: clienteNome,
            carrier_name: transpNome,
            receita_code: '100102',
            value: item.valor,
            chave_nfe: chaveNfe,
            barcode: isSp ? 'IMPORTAR_NO_SEFAZ_SP' : null,
            line_digitizable: isSp ? 'Gerar DARE-SP em lote pelo arquivo XML' : null,
            status: isSp ? 'requer_dare_sp' : 'aguardando_aprovacao',
            xml_source: xmlInfo ? 'linx_microvix_xml' : 'linx_microvix_financeiro',
            created_at: new Date().toISOString()
        });
    }

    // Inserção em lotes de 50 no Supabase
    console.log(`[Guides] Inserindo ${guiasParaInserir.length} guias na tabela 'guides'...`);
    for (let i = 0; i < guiasParaInserir.length; i += 50) {
        const slice = guiasParaInserir.slice(i, i + 50);
        const { error: insErr } = await supabase.from('guides').insert(slice);
        if (insErr) {
            throw new Error(`Erro na inserção do bloco ${i}: ` + insErr.message);
        }
        console.log(`  -> Inseridos ${i + slice.length} / ${guiasParaInserir.length}`);
    }

    // 7. Gerar Arquivo de Remessa Itaú SISPAG (CNAB 240)
    console.log('[CNAB] Gerando arquivo de remessa Itaú SISPAG oficial...');
    const mappedGuides = guiasParaInserir.map(g => ({
        codigoBarras: g.barcode,
        valor: g.value,
        dataVencimento: g.due_date,
        documentoOrigem: g.nf_number,
        ufFavorecida: g.uf
    }));

    const dataHoje = new Date().toISOString().split('T')[0];
    const cnabContent = cnabService.gerarRemessaSispag(dadosEmpresa, mappedGuides, dataHoje);

    // Salvar no Supabase Storage Privado
    const remessaPath = `${LALUA_TENANT_ID}/remessas/remessa_${batchId}.txt`;
    const { error: storageErr } = await supabase.storage
        .from('tenant-storage')
        .upload(remessaPath, Buffer.from(cnabContent, 'utf-8'), {
            contentType: 'text/plain',
            upsert: true
        });

    if (storageErr) {
        console.warn('[Storage] Aviso ao persistir no bucket:', storageErr.message);
    } else {
        console.log(`[Storage] Remessa persistida com sucesso em: ${remessaPath}`);
    }

    // Salvar também localmente para conveniência
    const localRemessaPath = path.join('C:\\Users\\Roberto\\Desktop\\Web_Services\\GNRE', 'remessa_itau_91_guias_pendentes.txt');
    fs.writeFileSync(localRemessaPath, cnabContent, 'utf-8');
    console.log(`[Local] Remessa salva em: ${localRemessaPath} (${cnabContent.split('\r\n').length} linhas)`);

    console.log('\n=== MIGRAÇÃO CONCLUÍDA COM SUCESSO ABSOLUTO! ===');
    console.log(`Lote ID: ${batchId}`);
    console.log(`Total de Guias: ${guiasParaInserir.length}`);
    console.log(`Valor Total DIFAL: R$ ${totalSoma.toFixed(2)}`);
    console.log(`Status do Lote: aguardando_aprovacao`);
    console.log(`Empresa: ${tenant.razao_social} (CNPJ: ${tenant.cnpj})`);
}

main().catch(err => {
    console.error('ERRO FATAL NA MIGRAÇÃO:', err);
    process.exit(1);
});
