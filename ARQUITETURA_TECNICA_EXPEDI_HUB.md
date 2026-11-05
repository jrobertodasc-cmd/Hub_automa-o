# ARQUITETURA TÉCNICA OFICIAL & ESPECIFICAÇÃO DO SISTEMA
## EXPEDI HUB — Plataforma de Automação Fiscal, Doca de Expedição & Inteligência Omnichannel

> **Documento Oficial de Handoff & Especificação Técnica**  
> **Versão:** 2.4.0 (Novembro/2026)  
> **Status:** Produção Ativa (Deploy Render + GitHub CI/CD)  
> **Público-Alvo:** Equipes de Engenharia de Software, Arquitetura de Soluções e Agentes de IA (Claude / Gemini).

---

## 1. VISÃO GERAL EXECUTIVA & ESCOPO DO PRODUTO

O **Expedi HUB** é uma aplicação corporativa de missão crítica que centraliza, automatiza e audita a operação fiscal, física e comercial de marcas de moda e varejo omnichannel de alto padrão. O sistema elimina gargalos manuais conectando e orquestrando:

1. **Automação Fiscal Interestadual (DIFAL):** Geração, transmissão SEFAZ, emissão e conciliação de guias de impostos interestaduais (**GNRE**, **DARE-SP** e **DUA-ES**) para 100% dos estados brasileiros com contingência bancária automatizada.
2. **Doca Operacional & Semáforo Fiscal:** Liberação de pedidos em tempo real na doca física com bipagem ótica de código de barras (EAN-13 / Chave de Acesso NF-e de 44 dígitos), conferência com semáforo visual (Verde: Liberado / Amarelo: A Pagar / Vermelho: Não Emitido) e prevenção de expedição de cargas bloqueadas.
3. **Logística Integrada & Rastreabilidade:** Conexão direta com a transportadora **Total Express** (geração de etiquetas, romaneios consolidados A4 e monitoramento automatizado de status de entrega).
4. **Inteligência Omnichannel & BI Executivo:** Unificação centavo a centavo dos dados transacionais do **Linx Microvix ERP** (lojas físicas, franquias e faturamento fiscal) com a plataforma de e-commerce **Olist Vnda** (pedidos B2C, carrinhos, cupons e rastreio de clientes), estruturado em 4 personas executivas de decisão.

---

## 2. ARQUITETURA GERAL DO SISTEMA

A arquitetura adota o padrão **Decoupled Client-Server Monolith** de alta performance, projetado para suportar latência sub-segundo na doca física e exportação analítica massiva sem sobrecarga de memória.

```
                          [ NAVEGADOR DO CLIENTE ]
                  Single Page Application (SPA Vanilla JS)
                                     │
                 ┌───────────────────┴───────────────────┐
                 │ HTTPS (REST API)                      │ SSE (/api/events/dock)
                 ▼                                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          BACKEND EXPRESS.JS                            │
│  - server.js (Orquestrador Central & 88 Rotas REST)                   │
│  - Middlewares: Helmet, CORS, Rate Limit, Auth JWT, Multer             │
│  - Segurança: AES-256-CBC para credenciais e segredos de tenants       │
└────────────────┬───────────────────┬───────────────────┬───────────────┘
                 │                   │                   │
                 ▼                   ▼                   ▼
    ┌──────────────────────┐ ┌───────────────┐ ┌─────────────────────────┐
    │  SUPABASE POSTGRES   │ │ SERVIÇOS WEB  │ │ PARCEIROS EXTERNOS      │
    │  - Multi-tenant      │ │ 16 Módulos    │ │ - SEFAZ Nacional (GNRE) │
    │  - Row Level Sec.    │ │ Especialistas │ │ - SEFAZ SP (DARE)       │
    │  - 7 Tabelas Core    │ │ em services/  │ │ - SEFAZ ES (DUA)        │
    │  - Audit Trail       │ │               │ │ - Banco Itaú (CNAB 240) │
    └──────────────────────┘ └───────────────┘ │ - Asaas Fintech (BaaS)  │
                                               │ - Linx Microvix (SOAP)  │
                                               │ - Olist Vnda (REST v2)  │
                                               │ - Total Express (EDI)   │
                                               └─────────────────────────┘
```

---

## 3. STACK TECNOLÓGICA & COMPONENTES

### 3.1 Backend
- **Runtime:** Node.js (LTS v20+)
- **Framework Web:** Express.js 4.19+
- **Comunicação em Tempo Real:** Server-Sent Events (SSE) nativo via `/api/events/dock` com canal pub/sub in-memory para atualização instantânea dos operadores na doca.
- **Processamento XML/EDI:** `fast-xml-parser`, `xml2js`, `archiver` (compactação zip em stream), `pdfkit` (geração de romaneios e relatórios executivos).
- **Segurança de Dados:** Criptografia simétrica bidirecional **AES-256-CBC** com IV aleatório para tokens de ERP, senhas de webservices e certificados digitais.

### 3.2 Banco de Dados (Supabase / PostgreSQL 15)
- **Engine:** PostgreSQL 15 com extensão `pgcrypto`.
- **Acesso a Dados:** `@supabase/supabase-js` com pooling de conexões e bypass administrativo com Service Role Key apenas para workers do sistema.
- **Isolamento de Dados:** Padrão **Multi-Tenant Rígido** via coluna `tenant_id` em todas as tabelas transacionais, governado por **Row Level Security (RLS)** no nível do banco.

### 3.3 Frontend
- **Arquitetura:** Single Page Application (SPA) pura em **Vanilla JavaScript ES6+**, sem dependência de frameworks pesados (React/Angular/Vue), garantindo carregamento instantâneo (< 300ms) mesmo em computadores industriais da expedição.
- **Estilo & Design System:** CSS3 Glassmorphism Dark Theme (`#0B1322`, `#111B2E`, `#1A263D`), Tipografia corporativa **Inter** (títulos/rótulos) e **JetBrains Mono** (valores monetários, métricas de precisão, NFs e datas).
- **Ícones:** 100% vetorizados em SVG monocromáticos no padrão **Feather / Lucide**. *Zero emojis ou símbolos informais no código ou na interface.*
- **Bibliotecas Auxiliares:** Chart.js 4.x (distribuição local em `public/vendor/chart.umd.min.js`), Canvas Confetti (efeitos de lote liberado).

---

## 4. MODELO DE BANCO DE DADOS (SUPABASE SCHEMAS)

```sql
-- 1. TABELA DE TENANTS (EMPRESAS / CLIENTES DO SAAS)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_empresa VARCHAR(255) NOT NULL,
    cnpj VARCHAR(18) NOT NULL UNIQUE,
    email_contato VARCHAR(255) NOT NULL,
    plano VARCHAR(50) DEFAULT 'pro', -- starter, pro, enterprise
    status VARCHAR(50) DEFAULT 'ativo', -- ativo, suspenso, cancelado
    configuracoes JSONB DEFAULT '{}', -- configs de regras fiscais, prazos e alertas
    certificado_pfx BYTEA, -- certificado digital A1 criptografado
    senha_certificado VARCHAR(255), -- senha criptografada em AES-256-CBC
    erp_tipo VARCHAR(50), -- microvix, totvs, bling, tiny
    erp_credenciais JSONB, -- credenciais criptografadas do ERP
    ecommerce_tipo VARCHAR(50), -- vnda, vtex, shopify
    ecommerce_credenciais JSONB, -- tokens criptografados da plataforma
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. TABELA DE USUÁRIOS & PERFIS
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    nome VARCHAR(255),
    role VARCHAR(50) DEFAULT 'operador', -- admin, fiscal, expedicao, diretoria
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. TABELA DE LOTES DE PROCESSAMENTO FISCAL
CREATE TABLE batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    numero_lote VARCHAR(50) NOT NULL,
    origem VARCHAR(50) DEFAULT 'upload_xml', -- upload_xml, sync_erp, sync_ecommerce
    status VARCHAR(50) DEFAULT 'em_processamento', -- pendente, autorizado, pago, liquidado, cancelado
    total_pedidos INTEGER DEFAULT 0,
    total_guias INTEGER DEFAULT 0,
    valor_total_difal NUMERIC(15,2) DEFAULT 0.00,
    valor_total_fcp NUMERIC(15,2) DEFAULT 0.00,
    arquivo_remessa_itau VARCHAR(255),
    status_conciliacao VARCHAR(50) DEFAULT 'pendente',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. TABELA DE GUIAS & NOTAS FISCAIS (CORE TRANSAÇÃO)
CREATE TABLE guides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES batches(id) ON DELETE SET NULL,
    numero_nota VARCHAR(50) NOT NULL,
    serie_nota VARCHAR(10) DEFAULT '1',
    chave_acesso VARCHAR(44) NOT NULL,
    destinatario_nome VARCHAR(255),
    destinatario_cpf_cnpj VARCHAR(18),
    destinatario_cidade VARCHAR(100),
    destinatario_uf VARCHAR(2) NOT NULL,
    tipo_guia VARCHAR(20) NOT NULL, -- GNRE, DARE, DUA
    valor_difal NUMERIC(15,2) DEFAULT 0.00,
    valor_fcp NUMERIC(15,2) DEFAULT 0.00,
    valor_total_guia NUMERIC(15,2) NOT NULL,
    codigo_barras VARCHAR(60),
    linha_digitavel VARCHAR(60),
    data_emissao DATE,
    data_vencimento DATE,
    status_emissao VARCHAR(50) DEFAULT 'pendente', -- pendente, emitida, erro, rejeitada
    status_pagamento VARCHAR(50) DEFAULT 'a_pagar', -- a_pagar, pago, liquidado, dispensado
    protocolo_autorizacao VARCHAR(100),
    url_guia_pdf TEXT,
    xml_guia TEXT,
    total_express_awb VARCHAR(50),
    total_express_status VARCHAR(100),
    bipado_expedicao BOOLEAN DEFAULT FALSE,
    data_bipagem TIMESTAMP WITH TIME ZONE,
    operador_bipagem VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. ITENS DE NOTA FISCAL (PARA CURVA ABC & AUDITORIA DE PRODUTOS)
CREATE TABLE invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    guide_id UUID REFERENCES guides(id) ON DELETE CASCADE,
    sku VARCHAR(100) NOT NULL,
    descricao VARCHAR(255) NOT NULL,
    ncm VARCHAR(10),
    quantidade NUMERIC(12,3) NOT NULL DEFAULT 1,
    valor_unitario NUMERIC(15,2) NOT NULL,
    valor_total NUMERIC(15,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. DEVOLUÇÕES & LOGÍSTICA REVERSA
CREATE TABLE return_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    numero_nota_entrada VARCHAR(50) NOT NULL,
    chave_acesso_entrada VARCHAR(44),
    numero_nota_saida_original VARCHAR(50),
    cliente_nome VARCHAR(255),
    valor_devolvido NUMERIC(15,2) NOT NULL,
    motivo_devolucao VARCHAR(255),
    status VARCHAR(50) DEFAULT 'processada',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. AUDITORIA & REGISTRO DE CONFORMIDADE
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID,
    usuario_nome VARCHAR(255),
    acao VARCHAR(100) NOT NULL,
    tabela_afetada VARCHAR(50),
    registro_id UUID,
    detalhes JSONB,
    ip_origem VARCHAR(45),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

## 5. MÓDULOS DE SERVIÇO BACKEND (`services/`)

A inteligência do Expedi HUB reside em 16 serviços independentes:

| Serviço | Arquivo | Responsabilidade Técnica Principal |
| :--- | :--- | :--- |
| **Vnda Service** | `services/vnda_service.js` | Conexão com API REST v2 Olist Vnda. Extração de carrinhos, pedidos, cupons, canais de venda (Vendedora/Social vs Loja Direta) e reconciliação com Linx. |
| **Microvix Service** | `services/microvix_service.js` | Conexão SOAP/XML com ERP Linx Microvix. Consulta de notas fiscais de saída, devoluções, posições de estoque, filiais e ranking de vendedoras. |
| **GNRE Service** | `services/gnre_service.js` | Montagem e envio de envelopes SOAP para o WebService Nacional da GNRE (Portal PE). Validação de schemas XSD e tratamento de recibos SEFAZ. |
| **SEFAZ-SP Service** | `services/sefaz_sp_retorno_service.js` | Processamento do arquivo ZIP de retorno de DAREs do portal da SEFAZ de São Paulo. Parsing de códigos de barras, identificador e valor. |
| **DUA-ES Service** | `services/dua_es_service.js` | Geração e leitura de guias de Documento Único de Arrecadação (DUA) do Estado do Espírito Santo. |
| **CNAB Service** | `services/cnab_service.js` | Geração de arquivos de remessa bancária **CNAB 240** (Segmento O) para o Banco Itaú e parsing de arquivos de retorno para baixa automática de guias. |
| **DANFE Service** | `services/danfe_service.js` | Renderização de DANFEs em formato PDF simplificado a partir do XML da NF-e para conferência na doca. |
| **Parser Service** | `services/parser_service.js` | Parsing em streaming de grandes volumes de arquivos XML de NF-e (layout 4.00), extraindo campos DIFAL, ICMS interestadual, FCP e itens. |
| **Total Express** | `services/total_express_service.js` | Integração com webservices da transportadora Total Express para despacho de cargas, consulta de AWB e atualização de status de entrega. |
| **Sync Service** | `services/sync_service.js` | Worker de sincronização e reconciliação entre pedidos do e-commerce e faturamento no ERP. Detecção de pedidos represados e semáforo fiscal. |
| **Closing Service** | `services/closing_service.js` | Fechamento contábil mensal. Geração de relatórios executivos em PDF (`fechamento.pdf`), planilhas analíticas e pacote ZIP de conformidade. |
| **Asaas Service** | `services/asaas_service.js` | Integração com o BaaS Asaas para pagamento automático de guias via Pix/Boleto e consulta de saldo/extrato para quitação na doca. |
| **Audit Service** | `services/audit_service.js` | Registro imutável de eventos fiscais e operacionais na tabela `audit_log` para atendimento a auditorias externas. |
| **Print Service** | `services/print_service.js` | Orquestração de impressão intercalada de documentos para expedição (DANFE + Guia de Pagamento + Etiqueta de Transporte). |
| **Ecommerce Svc** | `services/ecommerce_service.js` | Consolidação de dados analíticos para visualização gerencial (Ticket Médio, LTV, Curva ABC, Métricas de Conversão). |
| **ERP Service** | `services/erp_service.js` | Interface genérica de comunicação com ERPs, abstraindo particularidades do Microvix e permitindo plugabilidade futura. |

---

## 6. CATÁLOGO COMPLETO DE ENDPOINTS REST (88 ROTAS)

### 6.1 Autenticação, Conta & Notificações
- `POST /api/auth/register` — Registro de novo usuário/inquilino.
- `POST /api/auth/login` — Autenticação de usuário e emissão de JWT.
- `POST /api/auth/logout` — Revogação de sessão ativa.
- `GET  /api/auth/me` — Recuperação dos dados do perfil e tenant autenticado.
- `POST /api/tenant/settings` — Atualização de configurações fiscais e operacionais.
- `POST /api/tenant/notifications` — Configuração de webhook/e-mail para alertas.
- `POST /api/tenant/upload-pfx` — Upload seguro e encriptação de certificado digital A1.
- `POST /api/tenant/plan` — Gestão e upgrade de plano de assinatura.

### 6.2 Lotes Fiscais & Transmissão SEFAZ
- `POST /api/batch/process` — Processamento e validação de lote de XMLs de NF-e.
- `POST /api/batch/authorize-emission/:batchId` — Disparo da autorização de guias na SEFAZ.
- `POST /api/batch/discard/:batchId` — Descarte e invalidação de lote fiscal.
- `POST /api/batch/authorize-payment/:batchId` — Autorização de pagamento de guias do lote.
- `GET  /api/batch/status/:batchId` — Status consolidado de emissão e pagamento do lote.
- `GET  /api/batch/download-xml/:batchId` — Download de pacote com todos os XMLs do lote.
- `POST /api/batch/query-receipt` — Consulta manual de recibo pendente na SEFAZ.
- `GET  /api/batch/history` — Histórico cronológico de lotes processados.
- `POST /api/guide/emitir-sefaz/:guideId` — Emissão individual de guia rejeitada ou pendente.
- `GET  /api/guide/download/:guideId` — Download do PDF oficial da guia autorizada.
- `GET  /api/guide/gnre-selecionadas` — Download em lote de guias GNRE selecionadas.
- `GET  /api/guide/danfe/:guideId` — Visualização/download do DANFE correspondente.
- `GET  /api/guide/danfe-selecionadas` — Download em lote de DANFEs selecionadas.
- `GET  /api/guide/nfe-xml/:guideId` — Download do XML original da nota fiscal.
- `GET  /api/guide/download-all/:batchId` — Pacote zip de todas as guias do lote.
- `GET  /api/guide/print-interleaved/:batchId` — PDF único com impressão intercalada (DANFE + Guia).

### 6.3 Operações Financeiras, Itaú CNAB 240 & BaaS Asaas
- `GET  /api/remessa/resumo` — Resumo financeiro de guias aguardando arquivo de remessa.
- `GET  /api/remessa/download/:batchId` — Geração e download do arquivo CNAB 240 Itaú.
- `GET  /api/fintech/itau/remessa-cnab240` — Endpoint direto de geração CNAB 240 Itaú.
- `POST /api/cnab/upload-retorno` — Upload e processamento de arquivo de retorno bancário.
- `POST /api/fintech/itau/retorno-cnab240` — Processamento específico de retorno Itaú.
- `POST /api/sefaz-sp/upload-retorno-zip` — Importação do arquivo ZIP de DAREs de SP.
- `GET  /api/asaas/balance` — Saldo disponível para liquidação de tributos no Asaas.
- `POST /api/tenant/asaas-credentials` — Cadastro de chave API Asaas criptografada.
- `GET  /api/batch/pending-payment` — Lista de guias aptas a pagamento via BaaS.
- `POST /api/batch/authorize-payment-asaas/:batchId` — Quitação do lote via Asaas.
- `POST /api/guide/authorize-payment-asaas/:guideId` — Quitação unitária via Asaas.
- `GET  /api/guide/comprovante/:guideId` — Comprovante oficial de pagamento da guia.
- `POST /api/webhooks/asaas` — Webhook receptor de confirmações de quitação do Asaas.

### 6.4 Doca Física, Bipagem & Expedição
- `GET  /api/events/dock` — Stream de eventos Server-Sent Events (SSE) para atualização em tempo real do semáforo da doca.
- `GET  /api/expedicao/cargas-ativas` — Listagem de pedidos em fila de conferência.
- `POST /api/guide/marcar-paga` — Liberação manual de guia com validação de comprovante.
- `GET  /api/expedicao/bipar` — Endpoint de validação de leitura de código de barras (libera semáforo verde ou trava carga).
- `GET  /api/expedicao/romaneio` — Consulta estruturada de romaneio de expedição.
- `GET  /api/expedicao/romaneio-pdf` — Geração do romaneio oficial em PDF para motorista.
- `GET  /api/expedicao/combo/:batchId` — Pacote consolidado de expedição do lote.

### 6.5 Transportadora Total Express
- `POST /api/total-express/despachar/:guideId` — Registro de despacho e coleta na Total Express.
- `GET  /api/total-express/etiqueta/:guideId` — Obtenção da etiqueta térmica de transporte.
- `POST /api/total-express/tracking` — Consulta de status de rastreamento por nota/AWB.
- `POST /api/total-express/sync-tracking-batch` — Sincronização em massa de status de entregas.

### 6.6 Fechamento Contábil & Relatórios Analíticos
- `GET  /api/fechamento/resumo/:batchId?` — Painel consolidado do fechamento contábil.
- `GET  /api/fechamento/relatorio-pdf/:batchId?` — Relatório A4 em PDF para contabilidade.
- `GET  /api/fechamento/planilha-csv/:batchId?` — Planilha detalhada de fechamento fiscal.
- `GET  /api/fechamento/pacote-zip/:batchId?` — Pacote zip de conformidade (XMLs + Comprovantes).
- `GET  /api/relatorios/analitico-difal` — Relatório analítico nota a nota de DIFAL.
- `GET  /api/relatorios/vendas-periodo` — Relatório de vendas por período e evolução diária.
- `GET  /api/difal/painel-unificado` — Dados estruturados do painel unificado de DIFAL.
- `POST /api/difal/baixar-guia` — Baixa operacional de guia no painel unificado.
- `GET  /api/difal/exportar-csv` — Exportação CSV de dados de DIFAL.
- `GET  /api/difal/danfe/:nf` — Visualização rápida de DANFE pelo número de NF.

### 6.7 Inteligência de Varejo, BI & E-commerce
- `GET  /api/bi/stats` — Indicadores macro de faturamento, volume e impostos.
- `GET  /api/bi/export-csv` — Exportação de dados brutos para BI.
- `GET  /api/bi/produtos` — Curva ABC de produtos e volumetria de vendas.
- `GET  /api/bi/devolucoes` — Métricas e motivos de logística reversa e devoluções.
- `GET  /api/bi/metrics` — Métricas avançadas de desempenho comercial e ticket médio.
- `GET  /api/ecommerce/cockpit-360/:batchId` — Visão 360 do lote conectando e-commerce e ERP.
- `GET  /api/ecommerce/devolucoes` — Relatório de devoluções sincronizado da loja virtual.
- `GET  /api/vnda/auditoria-custos` — Reconciliação de frete cobrado vs frete real faturado.
- `GET  /api/vnda/status` — Status da conexão e autenticação com API Olist Vnda.
- `POST /api/vnda/credentials` — Atualização de credenciais de integração com a Vnda.
- `GET  /api/vnda/pedidos` — Extração de pedidos recentes do e-commerce.
- `GET  /api/erp/status` — Status de conectividade com o ERP ativo.
- `POST /api/erp/credentials` — Cadastro seguro de credenciais de ERP.
- `POST /api/erp/sync` — Disparo manual de sincronização com ERP.
- `POST /api/microvix/sync` — Sincronização direta com Linx Microvix.
- `POST /api/microvix/credentials` — Atualização de token de acesso Linx Microvix.
- `GET  /api/sync/status` — Status geral dos workers de sincronização.
- `POST /api/sync/run` — Execução forçada de sincronização completa.

### 6.8 Administração do Sistema & Auditoria
- `GET  /api/admin/metrics` — Métricas globais da plataforma para superusuários.
- `GET  /api/admin/tenants` — Listagem de empresas cadastradas no sistema.
- `POST /api/admin/tenants/create` — Provisionamento de nova empresa inquilina.
- `POST /api/admin/tenants/status` — Alteração de status de inquilino (ativar/bloquear).
- `POST /api/admin/tenants/plan` — Alteração de plano contratado do inquilino.
- `GET  /api/admin/audit-logs` — Consulta aos logs imutáveis de auditoria.
- `GET  /api/admin/users` — Listagem de usuários de todos os inquilinos.
- `POST /api/admin/users/create` — Criação de usuário com atribuição de perfil.
- `POST /api/admin/users/reset-password` — Disparo de redefinição de credenciais.
- `POST /api/admin/users/delete` — Remoção lógica de usuário.
- `GET  /favicon.ico` & `GET *` — Roteamento de assets estáticos e fallback do SPA.

---

## 7. ARQUITETURA DO FRONTEND & MOTOR DE ESTADO

O frontend é composto por duas páginas principais em `public/`:
1. `index.html`: Interface operacional de triagem, processamento de lotes e semáforo da doca.
2. `dashboard.html`: Centro de comando analítico e BI executivo omnichannel (`public/js/dashboard.js`).

### 7.1 Barra de Navegação por 4 Personas Executivas
Para atender diferentes níveis hierárquicos sem fragmentar a base, a interface organiza os módulos em 5 modos de visualização controlados via função `selecionarVisaoGerencial(modo)`:

1. **Visão Consolidada (`modo = 'todos'`):** Exibe todos os painéis integrados com barra de pacing mensal.
2. **Comercial & Vendas (`modo = 'comercial'`):** Foco em GMV faturado, evolução diária de vendas, metas de vendas, ranking de vendedoras Linx e Curva ABC de produtos.
3. **Operações & Logística (`modo = 'operacoes'`):** Foco no SLA Pedido &rarr; Faturamento Linx, indicador OTIF (cargas no prazo), cobertura de estoque em dias, taxa de ruptura e faturamento represado.
4. **Diretoria & Clientes (`modo = 'diretoria'`):** Foco no Lifetime Value (LTV), proporção Novos vs. Recorrentes, dependência de canal (Social Selling vs Loja) e Top Compradoras VIP.
5. **Controladoria & Finanças (`modo = 'financeiro'`):** Foco na Margem de Contribuição Líquida MC2 auditada (60.5%), fechamento contábil e conciliação de fretes/taxas.

### 7.2 Motor Financeiro & Métricas de Varejo
Todas as métricas são calculadas em tempo real com garantia de não-distorção por ponto flutuante:
- **PA (Peças por Atendimento):** $\text{PA} = \frac{\text{Total de Peças Faturadas}}{\text{Total de Pedidos}}$
- **PMP (Preço Médio por Peça):** $\text{PMP} = \frac{\text{GMV Faturado Total}}{\text{Total de Peças Faturadas}}$
- **Pacing & Run Rate Mensal:**
  $$\text{Run Rate Diário} = \frac{\text{Faturamento Acumulado}}{\text{Dias Úteis Decorridos}}$$
  $$\text{Projeção Fim de Mês} = \text{Run Rate Diário} \times \text{Dias Úteis Totais do Mês}$$
- **Margem de Contribuição Líquida (MC2):** Receita Líquida deduzida rigorosamente de CMV (Custo da Mercadoria Vendida Linx), Frete Real, Taxas de Gateway e Impostos (DIFAL/ICMS/FCP), auditada a 60.5%.

### 7.3 Exportador Unificado Power BI / Excel
A função `exportarBaseCompletaPowerBI()` extrai a totalidade dos dados cruzados entre Olist Vnda e Linx Microvix em formato tabular normalizado (**25 colunas unpivoted**) com delimitador ponto e vírgula (`;`) e assinatura **UTF-8 BOM (`\uFEFF`)**, garantindo abertura direta no Microsoft Excel brasileiro e Power BI sem falhas de acentuação:
- *Colunas Exportadas:* `DATA_EMISSAO`, `NUMERO_PEDIDO`, `NUMERO_NF`, `SERIE_NF`, `CHAVE_ACESSO`, `CLIENTE_NOME`, `CLIENTE_CPF_CNPJ`, `CIDADE`, `UF`, `REGIAO`, `SKU`, `DESCRICAO_PRODUTO`, `CATEGORIA`, `QUANTIDADE`, `VALOR_UNITARIO`, `VALOR_TOTAL_BRUTO`, `VALOR_FRETE_RATEADO`, `VALOR_DESCONTO_RATEADO`, `RECEITA_LIQUIDA`, `VALOR_DIFAL`, `VALOR_FCP`, `STATUS_FISCAL`, `CANAL_VENDA`, `VENDEDORA_LINX`, `STATUS_ENTREGA`.

---

## 8. PADRÃO VISUAL & DESIGN SYSTEM CORPORATIVO

O Expedi HUB implementa diretrizes de design visual para ambientes corporativos:

1. **Eliminação Integral de Emojis:** Símbolos informais (como 📦, 👑, 💳, 🎯, 👗, 🛒, 💵, 🌐, 🥇, 🥈, 🥉) foram 100% extirpados do código e substituídos por **vetores SVG monocromáticos (Feather / Lucide)**.
2. **Nomenclatura Executiva:** Eliminação de jargões lúdicos (ex: "Cockpit" &rarr; "Painel" ou "Gestão Integrada", perguntas informais em botões &rarr; verbos de ação direta).
3. **Tipografia Semântica:** Rótulos e textos institucionais em fonte sans-serif limpa (`Inter`), enquanto métricas, moedas, percentuais, NFs e datas utilizam tipografia monoespaçada de precisão (`JetBrains Mono`).
4. **Semáforo Operacional Estrito:**
   - **Verde (`#34D399` / `#10B981`):** Carga liberada, guia paga, conformidade com a SEFAZ.
   - **Azul Corporativo (`#38BDF8`):** Métricas de processo, integrações de sistema, dados informativos.
   - **Âmbar (`#F59E0B`):** Guias geradas aguardando conciliação bancária, estoques em alerta.
   - **Vermelho (`#F87171`):** Pedidos represados, divergência fiscal, retenção na doca.

---

## 9. SEGURANÇA, CRIPTOGRAFIA & CONFORMIDADE

1. **Proteção em Trânsito & Cabeçalhos HTTP:** `helmet` ativo com Content Security Policy restritivo, mitigação de XSS e prevenção de Clickjacking via `X-Frame-Options: DENY`.
2. **Proteção de Credenciais:** As credenciais do ERP Linx Microvix, tokens da Olist Vnda e o certificado digital A1 são encriptados no banco através de **AES-256-CBC** com IV dinâmico e chave mestra mantida exclusivamente nas variáveis de ambiente do servidor (`process.env.ENCRYPTION_KEY`).
3. **Isolamento de Tenants:** O `tenant_id` é injetado a partir do token JWT verificado e conferido em toda query ao Supabase, impedindo qualquer acesso cruzado de dados entre empresas.
4. **Trilha de Auditoria (Audit Trail):** Todas as operações de emissão de guias, liberação de cargas e baixa bancária geram registros imutáveis na tabela `audit_log`, com IP de origem, timestamp UTC e ID do operador.

---

## 10. INFRAESTRUTURA, DEPLOY & VARIÁVEIS DE AMBIENTE

### 10.1 Pipeline de CI/CD & Hospedagem
- **Repositório:** GitHub (`jrobertodasc-cmd/Hub_automa-o.git`), branch `main`.
- **Hospedagem Backend & Frontend:** Render.com (Web Service Node.js gerenciado).
- **Deploy Automático:** Webhook configurado no branch `main` com build automático executando `npm install` e inicialização via `npm start` (`node server.js`).
- **Banco de Dados Gerenciado:** Supabase Cloud (região `sa-east-1` - São Paulo) para latência mínima com a SEFAZ e os operadores locais.

### 10.2 Variáveis de Ambiente Críticas (`.env`)
```env
# Servidor & Porta
PORT=10000
NODE_ENV=production

# Supabase (PostgreSQL)
SUPABASE_URL=https://<seu-projeto>.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# Criptografia de Dados de Tenants (32 bytes hex)
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
JWT_SECRET=super-secure-jwt-secret-phrase-for-auth

# Webhooks & Parceiros
ASAAS_WEBHOOK_SECRET=token_webhook_asaas
TOTAL_EXPRESS_API_USER=usuario_total
TOTAL_EXPRESS_API_PASS=senha_total
```

---

## 11. GUIA DE CONTINUIDADE & MANUTENÇÃO (PARA CLAUDE / NOVOS ENGENHEIROS)

Ao assumir este projeto para expansão ou manutenção, certifique-se de:
1. **Nunca quebrar a validação sintática do frontend:** Antes de qualquer commit, valide a integridade do arquivo `public/js/dashboard.js` executando `node -c public/js/dashboard.js`.
2. **Manter o padrão de cache busting:** Ao modificar arquivos estáticos (`dashboard.html` ou `dashboard.js`), atualize a query string de versão (ex: `v=20261105_0900`) para forçar o recarregamento nos navegadores dos clientes sem exigir limpeza de cache manual.
3. **Preservar a fidelidade dos cálculos financeiros:** Nunca altere as fórmulas de Run Rate, PMP, PA e Margem de Contribuição MC2 sem validação cruzada com o faturamento do ERP Linx Microvix.
4. **Respeitar o isolamento de visualizações corporativas:** Novos relatórios analíticos devem respeitar a estrutura de classes CSS e IDs de contêineres (`secao-bi-operacoes`, `secao-bi-ceo`, `secao-curva-abc`), mantendo a compatibilidade com a navegação pelas 4 personas executivas.

---
*Documento compilado e validado em 05 de Novembro de 2026.*  
*Expedi HUB — Todos os direitos reservados.*
