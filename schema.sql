-- schema.sql
-- Script DDL completo e atualizado para o Supabase (https://supabase.com)
-- Cliente: Lalua Comércio de Modas Eireli (Boah) - Shopping Barra (Salvador / BA)
-- Data da última atualização: 20/10/2026

-- 1. Habilitar geração automática de UUIDs e extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Tabela de Tenants (Empresas / Assinantes Multi-Tenant)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    cnpj VARCHAR(14) UNIQUE NOT NULL,
    razao_social VARCHAR(255) NOT NULL,
    nome_fantasia VARCHAR(255),
    endereco TEXT,
    municipio VARCHAR(100),
    cod_municipio_ibge VARCHAR(10),
    uf VARCHAR(2) DEFAULT 'BA',
    cep VARCHAR(10),
    email_admin VARCHAR(255),
    telefone VARCHAR(30),
    notification_phone VARCHAR(30),
    notification_email VARCHAR(255),

    -- Dados Bancários Itaú SISPAG / CNAB 240
    bank_agency VARCHAR(4) NOT NULL,
    bank_account VARCHAR(5) NOT NULL,
    bank_dac VARCHAR(1) NOT NULL,

    -- Certificado Digital A1
    pfx_passphrase_encrypted TEXT,
    pfx_filename VARCHAR(255),
    certificado_path TEXT,
    certificado_senha_encrypted TEXT,
    certificado_valido_ate TIMESTAMP WITH TIME ZONE,

    -- Configuração de Ambiente e Assinatura
    environment VARCHAR(20) DEFAULT 'producao', -- 'producao' ou 'simulado'
    subscription_status VARCHAR(20) DEFAULT 'ativo',
    status VARCHAR(20) DEFAULT 'ativo',
    plano VARCHAR(50) DEFAULT 'pro',
    plano_valor NUMERIC(10, 2) DEFAULT 0.00,
    plan_name VARCHAR(50) DEFAULT 'Plano Expedição Enterprise',
    limite_guias_mes INTEGER DEFAULT 1000,
    plan_limit_guides INTEGER DEFAULT 1000,
    guias_usadas_mes INTEGER DEFAULT 0,
    ciclo_inicio TIMESTAMP WITH TIME ZONE,
    ciclo_fim TIMESTAMP WITH TIME ZONE,
    onboarding_completo BOOLEAN DEFAULT true,
    api_key TEXT,
    stripe_customer_id VARCHAR(100),

    -- Integração Linx Microvix
    microvix_key TEXT,
    microvix_group VARCHAR(100),
    microvix_user VARCHAR(100),
    microvix_password_encrypted TEXT,
    microvix_cnpj VARCHAR(14),

    -- Integração Olist Vnda
    vnda_token_encrypted TEXT,
    vnda_shop_host VARCHAR(255),

    -- Integração Conta Bancária Asaas
    asaas_api_key_encrypted TEXT,
    asaas_environment VARCHAR(20) DEFAULT 'producao', -- 'producao' ou 'sandbox'
    asaas_customer_id VARCHAR(100),
    asaas_wallet_id VARCHAR(100),

    -- Integrações adicionais (Bling, Tiny, Omie)
    bling_token_encrypted TEXT,
    tiny_token_encrypted TEXT,
    omie_app_key TEXT,
    omie_app_secret_encrypted TEXT
);

-- 3. Tabela de Perfis de Usuários (Vinculada ao Supabase Auth)
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'operador', -- 'operador', 'financeiro', 'diretoria', 'admin'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Tabela de Lotes de GNRE e Expedição
CREATE TABLE IF NOT EXISTS batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    environment VARCHAR(20) NOT NULL DEFAULT 'producao',
    source VARCHAR(50) DEFAULT 'microvix', -- 'microvix', 'vnda', 'manual', 'xml'
    receipt VARCHAR(1000),
    status VARCHAR(30) DEFAULT 'processando', -- 'processando', 'concluido', 'erro'
    approval_status VARCHAR(30) DEFAULT 'pendente', -- 'pendente', 'aprovado', 'rejeitado'
    approved_by VARCHAR(255),
    approved_at TIMESTAMP WITH TIME ZONE,
    file_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Tabela de Guias GNRE / DIFAL e Documentos Fiscais
CREATE TABLE IF NOT EXISTS guides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
    nf_number VARCHAR(50) NOT NULL,
    nf_issue_date VARCHAR(20),
    nf_competence VARCHAR(20),
    chave_nfe VARCHAR(44),
    customer_name VARCHAR(255),
    uf VARCHAR(2) NOT NULL,
    receita_code VARCHAR(10) DEFAULT '100102',
    value NUMERIC(10, 2) NOT NULL,
    
    -- Código de Barras e Linha Digitável Febraban Segmento 8
    barcode VARCHAR(48),
    line_digitizable VARCHAR(60),
    qrcode_pix TEXT,

    -- Armazenamento no Supabase Storage
    storage_path TEXT,        -- Caminho do PDF da Guia GNRE
    xml_storage_path TEXT,    -- Caminho do XML original da NF-e
    danfe_storage_path TEXT,  -- Caminho do PDF da DANFE Simplificada
    receipt_storage_path TEXT,-- Caminho do PDF do Comprovante Bancário Asaas
    receipt_url TEXT,
    xml_source TEXT,

    -- Status Operacional e Quitação
    status VARCHAR(30) DEFAULT 'aguardando_aprovacao', -- 'aguardando_aprovacao', 'pagamento_enviado', 'comprovada', 'paga', 'cancelada'
    paid_at TIMESTAMP WITH TIME ZONE,
    bank_authentication VARCHAR(100), -- Código de autenticação bancária SISBACEN / Asaas
    asaas_bill_id VARCHAR(100),
    payment_authorized_by VARCHAR(255),
    payment_authorized_at TIMESTAMP WITH TIME ZONE,

    -- Informações de Logística / Expedição
    carrier_name VARCHAR(100),
    carrier_cnpj VARCHAR(20),
    is_returned BOOLEAN DEFAULT false,
    return_nf_reference VARCHAR(50),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Índices para Otimização de Performance
CREATE INDEX IF NOT EXISTS idx_guides_tenant_id ON guides(tenant_id);
CREATE INDEX IF NOT EXISTS idx_guides_batch_id ON guides(batch_id);
CREATE INDEX IF NOT EXISTS idx_guides_nf_number ON guides(nf_number);
CREATE INDEX IF NOT EXISTS idx_guides_chave_nfe ON guides(chave_nfe);
CREATE INDEX IF NOT EXISTS idx_guides_status ON guides(status);
CREATE INDEX IF NOT EXISTS idx_batches_tenant_id ON batches(tenant_id);

-- 7. Configuração de Row Level Security (RLS)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE guides ENABLE ROW LEVEL SECURITY;

-- Exemplo de Políticas de Segurança para Acesso Autenticado:
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Tenants podem ler seus proprios dados') THEN
        CREATE POLICY "Tenants podem ler seus proprios dados" ON tenants
            FOR SELECT TO authenticated USING (id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Guias visiveis apenas pelo tenant proprietario') THEN
        CREATE POLICY "Guias visiveis apenas pelo tenant proprietario" ON guides
            FOR ALL TO authenticated USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Lotes visiveis apenas pelo tenant proprietario') THEN
        CREATE POLICY "Lotes visiveis apenas pelo tenant proprietario" ON batches
            FOR ALL TO authenticated USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;
END $$;

-- ========================================================
-- OBSERVAÇÕES PARA O STORAGE BUCKET (Supabase Storage):
-- Bucket PRIVADO: "tenant-storage"
-- Estrutura de pastas no bucket:
--   - [tenant_id]/certificados/ (Arquivos .pfx do cliente)
--   - [tenant_id]/danfe/        (DANFEs Simplificadas em PDF)
--   - [tenant_id]/guias/        (Guias GNRE em PDF)
--   - [tenant_id]/comprovantes/ (Comprovantes de quitação bancária Asaas)
--   - [tenant_id]/remessas/     (Arquivos CNAB 240 remessa.txt)
-- ========================================================
