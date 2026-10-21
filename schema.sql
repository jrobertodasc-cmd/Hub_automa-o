-- schema.sql
-- Script DDL completo e atualizado para o Supabase (https://supabase.com)
-- SaaS Multi-Tenant: expedi HUB (Automação Fiscal e Portão de Expedição de Doca)
-- Versão: 2.4.0 - Homologado para Comercialização Multi-Tenant

-- 1. Habilitar geração automática de UUIDs e extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Tabela de Tenants (Empresas / Assinantes Multi-Tenant)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
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
    bank_convenio VARCHAR(30),

    -- Certificado Digital A1
    pfx_passphrase_encrypted TEXT,
    pfx_filename VARCHAR(255),
    certificado_path TEXT,
    certificado_senha_encrypted TEXT,
    certificado_valido_ate TIMESTAMP WITH TIME ZONE,

    -- Configuração de Ambiente e Assinatura
    environment VARCHAR(20) DEFAULT 'simulado', -- 'producao' ou 'simulado'
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
    microvix_token TEXT,
    microvix_group VARCHAR(100),
    microvix_user VARCHAR(100),
    microvix_password_encrypted TEXT,
    microvix_cnpj VARCHAR(14),

    -- Integração Olist Vnda
    vnda_token_encrypted TEXT,
    vnda_shop_host VARCHAR(255),

    -- Integração Conta Bancária Asaas
    asaas_api_key_encrypted TEXT,
    asaas_environment VARCHAR(20) DEFAULT 'simulado', -- 'producao' ou 'sandbox' / 'simulado'
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
    role VARCHAR(50) DEFAULT 'operador', -- 'operador', 'financeiro', 'diretoria', 'admin', 'superadmin'
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Tabela de Lotes de GNRE e Expedição
CREATE TABLE IF NOT EXISTS batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    environment VARCHAR(20) NOT NULL DEFAULT 'simulado',
    source VARCHAR(50) DEFAULT 'microvix', -- 'microvix', 'vnda', 'manual', 'xml'
    receipt VARCHAR(1000),
    status VARCHAR(30) DEFAULT 'processando', -- 'processando', 'aguardando_aprovacao', 'concluido', 'liquidado', 'erro'
    approval_status VARCHAR(30) DEFAULT 'pendente', -- 'pendente', 'aprovado', 'rejeitado'
    approved_by VARCHAR(255),
    approved_at TIMESTAMP WITH TIME ZONE,
    closed_at TIMESTAMP WITH TIME ZONE,
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
    city VARCHAR(100),
    order_number VARCHAR(50),
    due_date DATE,
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
    status VARCHAR(30) DEFAULT 'aguardando_aprovacao', -- 'aguardando_aprovacao', 'pagamento_em_processamento', 'pagamento_enviado', 'comprovada', 'paga', 'erro_pagamento', 'cancelada'
    paid_at TIMESTAMP WITH TIME ZONE,
    bank_authentication VARCHAR(100), -- Código de autenticação bancária SISBACEN / Asaas
    asaas_bill_id VARCHAR(100),
    payment_authorized_by VARCHAR(255),
    payment_authorized_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,

    -- Informações de Logística / Expedição
    carrier_name VARCHAR(100),
    carrier_cnpj VARCHAR(20),
    is_returned BOOLEAN DEFAULT false,
    return_nf_reference VARCHAR(50),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Tabela de Trilha de Auditoria e LGPD (audit_log)
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    user_id UUID,
    acao VARCHAR(100) NOT NULL,
    detalhe TEXT,
    ip_address VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Tabela de Itens de Nota Fiscal (invoice_items)
CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    guide_id UUID REFERENCES guides(id) ON DELETE CASCADE,
    nf_number VARCHAR(50),
    product_code VARCHAR(100),
    product_description VARCHAR(255),
    quantity NUMERIC(12, 4) DEFAULT 1,
    unit_price NUMERIC(12, 2) DEFAULT 0,
    total_price NUMERIC(12, 2) DEFAULT 0,
    uf_destination VARCHAR(2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 8. Tabela de Notas Fiscais de Devolução (return_notes)
CREATE TABLE IF NOT EXISTS return_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
    nf_return_number VARCHAR(50) NOT NULL,
    nf_original_number VARCHAR(50),
    chave_nfe_return VARCHAR(44),
    chave_nfe_original VARCHAR(44),
    customer_name VARCHAR(255),
    uf VARCHAR(2),
    value NUMERIC(10, 2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'registrada',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ========================================================
-- MIGRAÇÃO SEGURA PARA BANCOS JÁ EXISTENTES (IDEMPOTENTE)
-- Garante que todas as colunas estejam presentes mesmo se as tabelas já existiam
-- ========================================================
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bank_convenio VARCHAR(30);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS microvix_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS microvix_group VARCHAR(100);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notification_phone VARCHAR(30);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS environment VARCHAR(20) DEFAULT 'simulado';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'ativo';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ativo';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plano VARCHAR(50) DEFAULT 'pro';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS limite_guias_mes INTEGER DEFAULT 1000;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS guias_usadas_mes INTEGER DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vnda_token_encrypted TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vnda_shop_host VARCHAR(255);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS asaas_api_key_encrypted TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS asaas_environment VARCHAR(20) DEFAULT 'simulado';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(100);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS asaas_wallet_id VARCHAR(100);

ALTER TABLE batches ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) DEFAULT 'pendente';
ALTER TABLE batches ADD COLUMN IF NOT EXISTS approved_by VARCHAR(255);
ALTER TABLE batches ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE guides ADD COLUMN IF NOT EXISTS receita_code VARCHAR(10) DEFAULT '100102';
ALTER TABLE guides ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS bank_authentication VARCHAR(100);
ALTER TABLE guides ADD COLUMN IF NOT EXISTS asaas_bill_id VARCHAR(100);
ALTER TABLE guides ADD COLUMN IF NOT EXISTS payment_authorized_by VARCHAR(255);
ALTER TABLE guides ADD COLUMN IF NOT EXISTS payment_authorized_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS is_returned BOOLEAN DEFAULT false;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS return_nf_reference VARCHAR(50);
ALTER TABLE guides ADD COLUMN IF NOT EXISTS carrier_name VARCHAR(100);
ALTER TABLE guides ADD COLUMN IF NOT EXISTS carrier_cnpj VARCHAR(20);
ALTER TABLE guides ADD COLUMN IF NOT EXISTS danfe_storage_path TEXT;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS receipt_storage_path TEXT;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS xml_source TEXT;

-- 9. Índices para Otimização de Performance e Integridade
CREATE INDEX IF NOT EXISTS idx_guides_tenant_id ON guides(tenant_id);
CREATE INDEX IF NOT EXISTS idx_guides_batch_id ON guides(batch_id);
CREATE INDEX IF NOT EXISTS idx_guides_nf_number ON guides(nf_number);
CREATE INDEX IF NOT EXISTS idx_guides_chave_nfe ON guides(chave_nfe);
CREATE INDEX IF NOT EXISTS idx_guides_status ON guides(status);
CREATE INDEX IF NOT EXISTS idx_batches_tenant_id ON batches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_tenant_id ON invoice_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_guide_id ON invoice_items(guide_id);
CREATE INDEX IF NOT EXISTS idx_return_notes_tenant_id ON return_notes(tenant_id);

-- Índice único parcial para evitar duplicidade de NF-e por tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_guides_tenant_chave_unique ON guides(tenant_id, chave_nfe) WHERE chave_nfe IS NOT NULL;

-- 10. Configuração de Row Level Security (RLS)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_notes ENABLE ROW LEVEL SECURITY;

-- Políticas de Segurança RLS para Acesso Autenticado:
DO $$ 
BEGIN
    -- Profiles: leitura do próprio perfil pelo usuário autenticado
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Usuarios podem ler seu proprio perfil') THEN
        CREATE POLICY "Usuarios podem ler seu proprio perfil" ON profiles
            FOR SELECT TO authenticated USING (id = auth.uid());
    END IF;

    -- Tenants: leitura apenas do tenant vinculado ao perfil do usuário
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenants' AND policyname = 'Tenants podem ler seus proprios dados') THEN
        CREATE POLICY "Tenants podem ler seus proprios dados" ON tenants
            FOR SELECT TO authenticated USING (id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;

    -- Guias: visíveis e gerenciáveis apenas pelo tenant proprietário
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'guides' AND policyname = 'Guias visiveis apenas pelo tenant proprietario') THEN
        CREATE POLICY "Guias visiveis apenas pelo tenant proprietario" ON guides
            FOR ALL TO authenticated USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;

    -- Lotes: visíveis e gerenciáveis apenas pelo tenant proprietário
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'batches' AND policyname = 'Lotes visiveis apenas pelo tenant proprietario') THEN
        CREATE POLICY "Lotes visiveis apenas pelo tenant proprietario" ON batches
            FOR ALL TO authenticated USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;

    -- Audit Log: visível apenas pelo tenant proprietário
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'Auditoria visivel apenas pelo tenant proprietario') THEN
        CREATE POLICY "Auditoria visivel apenas pelo tenant proprietario" ON audit_log
            FOR ALL TO authenticated USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;

    -- Itens de Nota: visíveis apenas pelo tenant proprietário
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'invoice_items' AND policyname = 'Itens de nota visiveis apenas pelo tenant proprietario') THEN
        CREATE POLICY "Itens de nota visiveis apenas pelo tenant proprietario" ON invoice_items
            FOR ALL TO authenticated USING (tenant_id = (SELECT tenant_id FROM profiles WHERE id = auth.uid()));
    END IF;

    -- Notas de Devolução: visíveis apenas pelo tenant proprietário
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'return_notes' AND policyname = 'Devolucoes visiveis apenas pelo tenant proprietario') THEN
        CREATE POLICY "Devolucoes visiveis apenas pelo tenant proprietario" ON return_notes
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
