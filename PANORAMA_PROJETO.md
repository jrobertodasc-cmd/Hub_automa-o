# PANORAMA TÉCNICO DO PROJETO (WEBSERVICE + PAINEL)

> **Documento gerado em:** 15/10/2026  
> **Finalidade:** Radiografia técnica fiel e sem suposições do projeto para subsidiar o planejamento da evolução arquitetural e do fluxo "Portão Fiscal de DIFAL" (`FLUXO_COMPLETO_expedi.md`).  
> **Premissa:** Análise 100% estática baseada no código-fonte, configurações e esquemas do repositório, sem chamadas a APIs externas ou mutações em banco de produção.

---

## 1. Visão Geral

### 1.1 Stack Tecnológico
* **Linguagem & Runtime:** Node.js (v18+ recomendado).
* **Framework Web:** Express (`^4.19.2`).
* **Banco de Dados & Storage:** Supabase (`@supabase/supabase-js ^2.39.8`) — PostgreSQL gerenciado + Supabase Storage (compatível com S3).
* **Autenticação:** Supabase Auth (JWT em cookies `httpOnly` e cabeçalhos `Bearer`).
* **Segurança & Resiliência:** `helmet ^8.3.0`, `express-rate-limit ^8.7.1`, `cookie-parser ^1.4.6`, `dotenv ^16.4.5`.
* **Manipulação de Arquivos e Fiscais:**
  * Multipart Upload: `multer ^1.4.5-lts.1` (em memória `multer.memoryStorage()`).
  * Processamento de DANFE/PDF: `@mmachadosantos/nfe-danfe-pdf ^1.0.6`, `pdfkit ^0.14.0`, `pdf-lib ^1.17.1`.
  * Códigos de barras de arrecadação: `bwip-js ^3.5.0`.
  * Compactação ZIP: `adm-zip ^0.5.17`.
  * Rede e mTLS/Proxy: `https-proxy-agent ^7.0.4`.

### 1.2 Execução Local vs. Produção
* **Localmente:** Executado via `npm run dev` (`node server.js` configurado em [package.json:8](file:///c:/Users/Roberto/Desktop/Web_Services/package.json#L8)). O servidor escuta na porta `process.env.PORT || 3001` ([server.js:28](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L28)). Quando iniciado como script principal fora de produção, inicializa também um `setInterval` em memória para o agendador automático ([server.js:2943-2956](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2943-L2956)).
* **Produção (Vercel Serverless):** Existe um [vercel.json](file:///c:/Users/Roberto/Desktop/Web_Services/vercel.json) roteando todas as requisições para `server.js` (`@vercel/node`). Em ambiente Serverless, o Express não roda como daemon contínuo (`app.listen` é ignorado via condicional `process.env.NODE_ENV !== 'production' && require.main === module` em [server.js:2943](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2943)), o que cria um **conflito severo** com tarefas agendadas em memória e jobs assíncronos desacoplados (detalhado na Seção 9).

### 1.3 Estrutura de Pastas Comentada
```text
Web_Services/
├── .env.example              # Modelo de variáveis de ambiente do servidor
├── .gitignore                # Proteção contra vazamento de .env, certificados e logs
├── server.js                 # Monólito Express com todas as rotas de API e orquestração
├── schema.sql                # DDL inicial do banco Supabase (tabelas e RLS inicial)
├── package.json              # Dependências e scripts do projeto
├── vercel.json               # Configuração de build e rotas serverless na Vercel
├── enviar_para_github.bat    # Script utilitário para git push interativo
│
├── services/                 # Módulos de regras de negócio e integrações
│   ├── parser_service.js     # Extração de dados de XMLs de NF-e e retornos da SEFAZ
│   ├── gnre_service.js       # Comunicação SOAP/mTLS com o Portal GNRE Nacional (PE)
│   ├── dua_es_service.js     # Comunicação SOAP 1.2/mTLS com a SEFAZ-ES (DUA-e)
│   ├── cnab_service.js       # Geração e leitura de remessas e retornos CNAB 240 Itaú SISPAG
│   ├── danfe_service.js      # Geração de DANFE em PDF a partir do XML da NF-e
│   ├── print_service.js      # Renderização visual de guias GNRE em PDF e intercalação
│   ├── microvix_service.js   # Conector WebAPI SOAP/XML da Linx Microvix (B2CConsultaNFe)
│   ├── vnda_service.js       # Conector REST API v2 da plataforma Olist Vnda
│   ├── erp_service.js        # Conectores REST para Bling v3, Tiny ERP e Omie
│   └── sync_service.js       # Orquestrador periódico de sincronização automática
│
├── public/                   # Interface frontend estática servida pelo Express
│   ├── _legacy/              # Arquivos antigos da versão "Apex" (backup protegido)
│   ├── css/
│   │   ├── expedi.css        # Novo design system claro Figma ("expedi HUB")
│   │   └── style.css         # CSS original escuro (preservado para o painel interno)
│   ├── js/
│   │   ├── auth-bridge.js    # Ponte de conexão do login/cadastro expedi com o backend
│   │   ├── app.js            # Comportamento compartilhado das páginas expedi HUB
│   │   ├── auth.js           # Lógica legada de autenticação e interceptor fetch
│   │   ├── dashboard.js      # Lógica e renderização do painel interno de faturamento
│   │   ├── profile.js        # Lógica de configurações de empresa e upload de PFX
│   │   ├── plans.js          # Lógica legada de seleção de planos
│   │   └── admin.js          # Lógica do painel de administração multi-tenant
│   ├── marca/                # Identidade visual oficial (SVGs e prancha de marca)
│   ├── index.html            # Landing page comercial nova (expedi HUB)
│   ├── login.html            # Tela de autenticação nova (expedi HUB)
│   ├── register.html         # Tela de cadastro de empresa nova (expedi HUB)
│   ├── plans.html            # Tabela de planos e FAQ nova (expedi HUB)
│   ├── dashboard.html        # Painel operacional interno (layout escuro Apex preservado)
│   ├── profile.html          # Gerenciamento de credenciais e certificado
│   ├── bi.html               # Relatórios e estatísticas fiscais
│   └── admin.html            # Painel do superadministrador
│
├── GNRE/                     # Documentação de especificação, fluxos e auditorias
│   ├── FLUXO_COMPLETO_expedi.md # Especificação funcional do Portão Fiscal (Fases 1 a 5)
│   ├── PROMPT_PANORAMA_OPUS.md  # Instruções para este levantamento técnico
│   └── auditoria_ui_figma.md    # Auditoria de paridade UI/UX Figma vs Implementação
│
└── scratch/                  # Scripts pontuais de diagnóstico e extrações de teste
```

---

## 2. Backend / Webservice

### 2.1 Catálogo Completo de Endpoints

| Método | Endpoint | Middleware / Autenticação | Função / Descrição |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Pública | Cadastra usuário no Supabase Auth via Admin API, cria tenant e perfil ([server.js:174](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L174)) |
| `POST` | `/api/auth/login` | Rate Limit (30 req/15min) | Valida credenciais com `tempClient`, retorna token e grava cookie `sb_access_token` ([server.js:236](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L236)) |
| `POST` | `/api/auth/logout` | Pública | Limpa cookie de autenticação ([server.js:276](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L276)) |
| `GET` | `/api/auth/me` | `requireAuth` | Retorna dados do usuário autenticado e seu tenant ([server.js:281](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L281)) |
| `POST` | `/api/tenant/settings` | `requireAuth` | Atualiza dados bancários (agência, conta, DAC) e ambiente ([server.js:300](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L300)) |
| `POST` | `/api/tenant/upload-pfx` | `requireAuth` + `multer` | Recebe arquivo `.pfx` e senha, grava no Storage e DB criptografado ([server.js:329](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L329)) |
| `POST` | `/api/tenant/plan` | `requireAuth` | Atualiza o plano de assinatura do tenant ([server.js:376](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L376)) |
| `POST` | `/api/batch/process` | `requireAuth` + `requireActiveSubscription` | Recebe lote de XMLs via upload manual, pré-valida e cria lote `pendente_autorizacao` ([server.js:400](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L400)) |
| `POST` | `/api/batch/authorize-emission/:batchId` | `requireAuth` + `requireActiveSubscription` | Dispara o processamento em background para emitir as guias na SEFAZ ([server.js:499](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L499)) |
| `POST` | `/api/batch/discard/:batchId` | `requireAuth` | Descarta lote pendente antes da emissão ([server.js:535](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L535)) |
| `POST` | `/api/batch/authorize-payment/:batchId` | `requireAuth` | Atualiza status das guias para pagamento autorizado ([server.js:568](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L568)) |
| `GET` | `/api/batch/status/:batchId` | `requireAuth` | Consulta status do lote em processamento (via memória `activeTasks` ou DB) ([server.js:661](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L661)) |
| `GET` | `/api/batch/download-xml/:batchId` | `requireAuth` | Gera e faz download do arquivo XML de lote para SP ([server.js:697](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L697)) |
| `POST` | `/api/batch/query-receipt` | `requireAuth` | Consulta manual do recibo SOAP na SEFAZ ([server.js:720](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L720)) |
| `GET` | `/api/batch/history` | `requireAuth` | Lista lotes e guias históricos do tenant ([server.js:925](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L925)) |
| `GET` | `/api/remessa/download/:batchId` | `requireAuth` | Gera e baixa arquivo CNAB 240 Itaú SISPAG das guias do lote ([server.js:944](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L944)) |
| `GET` | `/download/remessa.txt` | Pública (Legada) | Download da remessa legada em disco ([server.js:1015](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1015)) |
| `POST` | `/api/cnab/upload-retorno` | `requireAuth` + `multer` | Processa arquivo de retorno `.RET` do banco e atualiza baixas ([server.js:1034](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1034)) |
| `GET` | `/api/expedicao/romaneio` | `requireAuth` | Gera relatório de romaneio de expedição agrupado por transportadora ([server.js:1115](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1115)) |
| `GET` | `/api/bi/stats` | `requireAuth` | Agrega totais de guias, valores por UF e tempo de resposta ([server.js:1301](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1301)) |
| `GET` | `/api/bi/export-csv` | `requireAuth` | Exporta relatório em planilha CSV ([server.js:1388](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1388)) |
| `GET` | `/api/bi/produtos` | `requireAuth` | Ranking de itens faturados interestaduais ([server.js:1441](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1441)) |
| `GET` | `/api/bi/devolucoes` | `requireAuth` | Estatísticas de cancelamentos e divergências ([server.js:1491](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1491)) |
| `GET` | `/api/guide/download/:guideId` | `requireAuth` | Baixa PDF ou HTML oficial da guia individual ([server.js:1519](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1519)) |
| `GET` | `/api/guide/danfe/:guideId` | `requireAuth` | Gera DANFE em PDF da NF-e vinculada à guia ([server.js:1553](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1553)) |
| `GET` | `/api/guide/nfe-xml/:guideId` | `requireAuth` | Baixa XML da NF-e vinculado à guia ([server.js:1585](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1585)) |
| `GET` | `/api/guide/download-all/:batchId` | `requireAuth` | Baixa pacote ZIP com todos os PDFs de guias do lote ([server.js:1617](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1617)) |
| `GET` | `/api/guide/print-interleaved/:batchId` | `requireAuth` | Gera PDF único mesclado intercalando [DANFE + GNRE] ([server.js:1696](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1696)) |
| `GET` | `/api/admin/tenants` | `requireAuth` + `requireAdmin` | Painel superadmin: lista todas as empresas cadastradas ([server.js:1733](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1733)) |
| `POST` | `/api/admin/tenants/status` | `requireAuth` + `requireAdmin` | Painel superadmin: ativa/suspende tenant ([server.js:1748](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1748)) |
| `GET` | `/api/admin/users` | `requireAuth` + `requireAdmin` | Painel superadmin: lista todos os usuários do sistema ([server.js:1768](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1768)) |
| `POST` | `/api/admin/users/create` | `requireAuth` + `requireAdmin` | Painel superadmin: cria novo usuário manualmente ([server.js:1783](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1783)) |
| `POST` | `/api/admin/users/reset-password` | `requireAuth` + `requireAdmin` | Painel superadmin: redefine senha de usuário ([server.js:1827](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1827)) |
| `POST` | `/api/microvix/sync` | `requireAuth` + `requireActiveSubscription` | Sincroniza sob demanda NF-es do ERP Linx Microvix ([server.js:1849](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1849)) |
| `POST` | `/api/microvix/credentials` | `requireAuth` | Salva credenciais do Linx Microvix criptografadas ([server.js:2083](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2083)) |
| `GET` | `/api/erp/status` | `requireAuth` | Retorna status de conexão dos ERPs configurados ([server.js:2115](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2115)) |
| `GET` | `/api/vnda/status` | `requireAuth` | Verifica se o token Olist Vnda está configurado ([server.js:2135](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2135)) |
| `POST` | `/api/vnda/credentials` | `requireAuth` | Salva token e host da Olist Vnda ([server.js:2144](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2144)) |
| `GET` | `/api/vnda/pedidos` | `requireAuth` | Lista pedidos diretamente da API da Olist Vnda ([server.js:2169](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2169)) |
| `GET` | `/api/sync/status` | `requireAuth` | Retorna o status do agendador automático ([server.js:2197](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2197)) |
| `POST` | `/api/sync/run` | `requireAuth` + `requireActiveSubscription` | Força a execução imediata da rotina de sincronização ([server.js:2202](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2202)) |
| `POST` | `/api/erp/credentials` | `requireAuth` | Salva credenciais de Bling, Tiny ou Omie ([server.js:2219](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2219)) |
| `POST` | `/api/erp/sync` | `requireAuth` + `requireActiveSubscription` | Executa importação de notas fiscais via Bling, Tiny ou Omie ([server.js:2252](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2252)) |

---

### 2.2 Módulos de Negócio e o Real Funcionamento do "Cálculo" de DIFAL

> [!IMPORTANT]
> **Descoberta Crítica sobre o DIFAL:** O sistema **NÃO CALCULA DIFAL**.  
> Ao contrário do que a landing page sugere, não existe motor de cálculo de alíquotas internas/interestaduais, nem cálculo de base simples vs. dupla, nem tabela de FCP.

* **Como o valor do DIFAL é obtido:**  
  Em [services/parser_service.js:21-26](file:///c:/Users/Roberto/Desktop/Web_Services/services/parser_service.js#L21-L26), o webservice lê o bloco `<ICMSTot>` do XML da NF-e e extrai puramente a tag preenchida pelo emissor da nota:
  ```javascript
  const totalMatch = xml.match(/<ICMSTot>([\s\S]*?)<\/ICMSTot>/);
  if (totalMatch) {
      valorDifalMatch = totalMatch[1].match(/<vICMSUFDest>([^<]+)<\/vICMSUFDest>/);
  }
  ```
  Se o valor estiver ausente ou o XML não contiver a tag `<vICMSUFDest>`, o parser lança exceção ([parser_service.js:29](file:///c:/Users/Roberto/Desktop/Web_Services/services/parser_service.js#L29)).
* **Tabelas de alíquotas / Vigência:** Inexistentes. O sistema delega 100% da responsabilidade tributária ao ERP que gerou a NF-e.
* **Operações intraestaduais:** Se o destinatário for da mesma UF do emitente (ex: SP $\rightarrow$ SP), não há tag `<vICMSUFDest>`, fazendo o parser rejeitar o XML como "ausência de dados fiscais essenciais", em vez de classificar amigavelmente como `SEM_GUIA`.

### 2.3 Emissão de Guias
* **Espírito Santo (DUA-e):** Implementado em [services/dua_es_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/dua_es_service.js). Comunicação SOAP 1.2 com `https://app.sefaz.es.gov.br/WsDua/DuaService.asmx`. Usa certificado A1 via mTLS. Possui tabela estática de códigos de municípios do ES ([dua_es_service.js:13-91](file:///c:/Users/Roberto/Desktop/Web_Services/services/dua_es_service.js#L13-L91)).
* **Portal GNRE (Demais UFs):** Implementado em [services/gnre_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/gnre_service.js). Comunicação SOAP com o WebService GNRE v2.00 mantido pela SEFAZ-PE (`GnreLoteRecepcao` e `GnreResultadoLote`).
* **São Paulo (SP):** A SEFAZ-SP não aceita GNRE nacional. O sistema gera uma estrutura XML proprietária paulista para download (`/api/batch/download-xml/:batchId` em [server.js:697](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L697)). O operador precisa fazer o upload manual desse XML no portal Posto Fiscal Eletrônico de SP.

### 2.4 Geração de Remessa CNAB 240 (Itaú SISPAG)
* Implementado em [services/cnab_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/cnab_service.js).
* Gera arquivo padrão texto posicional (240 posições com quebra `\r\n`).
* Contém Header de Arquivo (Banco 341), Header de Lote (Tipo de serviço `03` - Pagamento de Tributos), Segmento O (para guias com código de barras iniciado em `858...` - tributos estaduais) e Trailers.
* Possui filtro para excluir guias sem código de barras numérico (ex.: pendências de SP com texto marcador `IMPORTAR_NO_SEFAZ_SP`) ([cnab_service.js:40-49](file:///c:/Users/Roberto/Desktop/Web_Services/services/cnab_service.js#L40-L49)).

### 2.5 Processamento Assíncrono e Idempotência
* **Filas e Jobs:** Não há Redis, RabbitMQ ou BullMQ. O processamento assíncrono é feito disparando uma Promise com `setImmediate` dentro da função `runBatchProcessInBackground` ([server.js:2676](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2676)).
* **Estado das Tarefas:** Fica mantido em uma variável volátil na memória RAM: `activeTasks[batchId]` ([server.js:74](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L74)). Se o servidor reiniciar (ou o container serverless morrer), a tarefa perde seu progresso e a interface fica travada em estado inconsistente.
* **Idempotência:** **Inexistente.** Não há chaves únicas de idempotência nas rotas de emissão (`/api/batch/authorize-emission/:batchId`) nem controle no banco contra retransmissão do mesmo lote para a SEFAZ.

---

## 3. Banco de Dados (Supabase)

### 3.1 Esquema Declarado em [schema.sql](file:///c:/Users/Roberto/Desktop/Web_Services/schema.sql)
1. **`tenants`**: Identifica a empresa/assinante.
   * Colunas: `id` (UUID PK), `created_at`, `cnpj` (VARCHAR 14 UNIQUE), `razao_social`, `bank_agency` (VARCHAR 4), `bank_account` (VARCHAR 5), `bank_dac` (VARCHAR 1), `pfx_passphrase_encrypted` (TEXT), `pfx_filename` (VARCHAR 255), `environment` (VARCHAR 20, default `'simulado'`), `subscription_status` (VARCHAR 20, default `'ativo'`).
2. **`profiles`**: Usuários do sistema (vinculados ao Supabase Auth).
   * Colunas: `id` (UUID PK $\rightarrow$ `auth.users(id)`), `tenant_id` (UUID $\rightarrow$ `tenants(id)`), `email` (VARCHAR 255 UNIQUE), `name`, `created_at`.
3. **`batches`**: Lotes de envio de guias.
   * Colunas: `id` (UUID PK), `tenant_id` (UUID $\rightarrow$ `tenants(id)`), `environment`, `receipt` (VARCHAR 1000), `status` (default `'processando'`), `error_message` (TEXT), `created_at`.
4. **`guides`**: Guias fiscais emitidas.
   * Colunas: `id` (UUID PK), `tenant_id` (UUID $\rightarrow$ `tenants(id)`), `batch_id` (UUID $\rightarrow$ `batches(id)`), `nf_number`, `uf`, `value` (NUMERIC 10,2), `barcode` (VARCHAR 48), `line_digitizable` (VARCHAR 48), `storage_path` (TEXT), `created_at`.

### 3.2 O Descompasso Entre [schema.sql](file:///c:/Users/Roberto/Desktop/Web_Services/schema.sql) e o Código Real
O arquivo [schema.sql](file:///c:/Users/Roberto/Desktop/Web_Services/schema.sql) está **desatualizado** em relação ao que [server.js](file:///c:/Users/Roberto/Desktop/Web_Services/server.js) e [services/sync_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/sync_service.js) consultam e gravam:
* Faltam colunas na tabela `tenants`:
  * `microvix_user`, `microvix_password_encrypted`, `microvix_key`, `microvix_cnpj` ([server.js:2088-2095](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2088-L2095)).
  * `vnda_token_encrypted`, `vnda_host` ([server.js:2149-2152](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2149-L2152)).
  * `erp_type`, `erp_token_encrypted`, `erp_app_key`, `erp_app_secret_encrypted` ([server.js:2226-2234](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2226-L2234)).
  * `payment_date` em lotes/tenants.
* Faltam colunas na tabela `guides`:
  * `chave_nfe`, `carrier_name`, `carrier_cnpj`, `dest_name`, `dest_cpf_cnpj`, `dest_municipio`, `nfe_xml_path`, `danfe_pdf_path` (usadas intensamente no dashboard e em [server.js:2830-2845](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2830-L2845)).

### 3.3 Row Level Security (RLS) e Isolamento Multi-Tenant
* O [schema.sql](file:///c:/Users/Roberto/Desktop/Web_Services/schema.sql#L59-L62) executa `ENABLE ROW LEVEL SECURITY`, mas **as políticas reais estão comentadas**.
* No [server.js:57-61](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L57-L61), o servidor instancia o cliente Supabase utilizando a **`SUPABASE_KEY` (chave `service_role`)**, que por definição do Supabase **bypassa todo e qualquer RLS**.
* **Garantia de Isolamento:** O isolamento depende 100% da integridade do código backend Express, que deve aplicar manualmente `.eq('tenant_id', req.tenant.id)` em cada consulta. **Não existem testes automatizados garantindo que um tenant não consiga acessar dados de outro.**

### 3.4 Buckets de Storage
* Bucket: `tenant-storage` (privado).
* Estrutura de pastas:
  * `{tenant_id}/certificados/{filename}` $\rightarrow$ Arquivo `.pfx` original do cliente.
  * `{tenant_id}/guias/{guide_id}.html` ou `.pdf` $\rightarrow$ Documento visual oficial da guia.
  * `{tenant_id}/nfe_xml/{chave}.xml` $\rightarrow$ XML assinado da NF-e original.
  * `{tenant_id}/danfe/{chave}.pdf` $\rightarrow$ DANFE gerado.
  * `{tenant_id}/remessas/{batch_id}_remessa.txt` $\rightarrow$ Arquivo CNAB 240.

---

## 4. Autenticação e Cadastro

* **Cadastro de Assinante:**  
  Endpoint `/api/auth/register` ([server.js:174](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L174)). Cria o usuário via `supabase.auth.admin.createUser` com confirmação de email automática ativada (`email_confirm: true`), cria registro em `tenants` e vincula o perfil em `profiles`.
* **Login e Sessão:**  
  Endpoint `/api/auth/login` ([server.js:236](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L236)). Cria cliente temporário para validar login, emite cookie `sb_access_token` com duração de 7 dias (`httpOnly: true`, `sameSite: 'lax'`) e retorna o token JWT para o front-end gravar no `localStorage`.
* **Recuperação de Senha:**  
  Não há rota pública de "Esqueci minha senha" implementada no backend. Apenas administradores conseguem resetar senhas pela rota protegida `/api/admin/users/reset-password` ([server.js:1827](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L1827)).
* **Planos e Limites de Emissão:**  
  Tabela de limites declarada em [server.js:76-83](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L76-L83):
  * `trial`: 10 guias/mês.
  * `starter`: 100 guias/mês.
  * `pro`: 500 guias/mês.
  * `advanced`: 1.500 guias/mês.
  A validação é feita antes de processar qualquer lote em [server.js:410-435](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L410-L435), somando a quantidade de guias já emitidas no mês calendário corrente.

---

## 5. Integrações

| Integração | O que está implementado | O que falta / Limitações | Onde ficam credenciais | Endpoints externos chamados |
| :--- | :--- | :--- | :--- | :--- |
| **Linx Microvix** | Consulta XMLs de NF-e via comando `B2CConsultaNFe` ([microvix_service.js:13](file:///c:/Users/Roberto/Desktop/Web_Services/services/microvix_service.js#L13)) | Paginação por timestamp básica; não trata reemissão ou cancelamento | Criptografadas no DB (`tenants.microvix_*`) | `https://webapi.microvix.com.br/1.0/api/integracao` |
| **Olist Vnda** | Listagem de pedidos via API v2 ([vnda_service.js:8](file:///c:/Users/Roberto/Desktop/Web_Services/services/vnda_service.js#L8)) | Enriquecimento básico de canal/tracking; não há webhook reativo | Criptografadas no DB (`tenants.vnda_*`) | `https://api.vnda.com.br/api/v2/orders` |
| **Bling / Tiny / Omie** | Conectores REST para busca de NF-es emitidas e download de XML ([erp_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/erp_service.js)) | Bling v3 e Tiny v2 implementados; Omie básico. Sem webhooks | Criptografadas no DB (`tenants.erp_*`) | `api.bling.com.br`, `api.tiny.com.br`, `app.omie.com.br` |
| **Portal GNRE (PE)** | Lote SOAP v2.00 com mTLS para emissão e consulta ([gnre_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/gnre_service.js)) | Não suporta emissão com FCP em guia separada | Certificado A1 do tenant | `www.gnre.pe.gov.br` / `www.testegnre.pe.gov.br` |
| **SEFAZ-ES (DUA-e)** | Emissão SOAP 1.2 com mTLS ([dua_es_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/dua_es_service.js)) | Limitado aos municípios mapeados na tabela estática | Certificado A1 do tenant | `app.sefaz.es.gov.br/WsDua/DuaService.asmx` |
| **Itaú SISPAG (CNAB)**| Geração de arquivo texto de remessa e parser de retorno `.RET` | Totalmente offline / via arquivo; não é API direta | Dados bancários em `tenants` | Nenhum (transferência de arquivos manuais) |
| **Asaas** | **NADA IMPLEMENTADO.** Não há nenhuma linha de código, rota ou chave para Asaas no projeto atual | Falta integração completa do "Pague Contas", webhooks e conciliação | Não configurado | Não aplicável |

---

## 6. Certificado Digital A1

### 6.1 Como é Tratado
* **Upload:** O cliente envia o arquivo `.pfx` e digita a senha no painel de perfil.
* **Armazenamento do Arquivo:** Salvo no bucket `tenant-storage` do Supabase ([server.js:345](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L345)).
* **Criptografia da Senha:** A senha é cifrada usando `crypto.createCipheriv('aes-256-cbc', secretKey, iv)` ([server.js:92-98](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L92-L98)) com IV aleatório de 16 bytes e armazenada como string `iv_hex:cipher_hex` na coluna `pfx_passphrase_encrypted`.
* **Abertura em Memória:** Quando o lote vai ser emitido, o servidor baixa o buffer do `.pfx` do Storage e decifra a senha em RAM ([server.js:735-746](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L735-L746) e [server.js:2710-2715](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2710-L2715)), instanciando `new https.Agent({ pfx: pfxBuffer, passphrase })` para a chamada mTLS.

### 6.2 Riscos Críticos Identificados
1. **Arquivo PFX em Repouso Sem Criptografia Adicional:** O arquivo `.pfx` binário é gravado puro no Supabase Storage. Embora o bucket seja configurado como privado, qualquer credencial comprometida do Supabase (ou colaborador com acesso ao dashboard do Supabase) tem acesso direto ao download do certificado do cliente.
2. **Criptografia da Senha em AES-256-CBC Sem Autenticação (Falta GCM):** O modo CBC não oferece integridade autenticada contra ataques de modificação de texto cifrado (Padding Oracle). O padrão moderno para dados sigilosos é **AES-256-GCM**.
3. **Chave Mestra Estática:** A derivação da chave usa `ENCRYPTION_KEY` de `.env` diretamente (`crypto.createHash('sha256').update(keyStr).digest()`). Se a variável de ambiente for perdida, todos os certificados cadastrados tornam-se irrecuperáveis e exigem novo upload pelo cliente.

---

## 7. Front-End

### 7.1 Estado das Páginas
* **Páginas Públicas (Design Novo expedi HUB):**
  * [index.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/index.html), [login.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/login.html), [register.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/register.html), [plans.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/plans.html).
  * Estilizadas pelo [css/expedi.css](file:///c:/Users/Roberto/Desktop/Web_Services/public/css/expedi.css) (tema claro `#F5F7FA`, navy `#111F33`, Inter, cards brancos).
  * Conectadas ao backend através da ponte [js/auth-bridge.js](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/auth-bridge.js).
* **Painel Interno (Design Antigo Apex):**
  * [dashboard.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/dashboard.html), [profile.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/profile.html), [bi.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/bi.html), [admin.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/admin.html).
  * Utilizam o [css/style.css](file:///c:/Users/Roberto/Desktop/Web_Services/public/css/style.css) legado (fundo escuro `#0b0f19`, cards navy, visual totalmente divergente do Figma).

### 7.2 Auditoria de Dados Falsos, Fixos ou Inventados no Código
Durante a inspeção estática detalhada, foram localizadas as seguintes manipulações artificiais de dados:

1. **Total do Pedido Fabricado ([public/js/dashboard.js:820](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/dashboard.js#L820)):**
   ```javascript
   const pedidoTotal = (difalVal > 0 ? (difalVal * 5.8 + 49.9).toFixed(2) : '189,90').replace('.', ',');
   ```
   *Gravidade: Alta.* O valor do pedido na tabela é uma fórmula matemática inventada que multiplica o imposto por 5,8 e soma R$ 49,90. Num sistema fiscal, o operador lê um total comercial falso.
2. **Canal de Vendas Inventado ([public/js/dashboard.js:804](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/dashboard.js#L804)):**
   ```javascript
   if (rawCarrier.includes('CORREIOS')) canal = 'Mercado Livre';
   ```
   *Gravidade: Média.* O canal do pedido (ex: Mercado Livre) é inferido arbitrariamente caso a transportadora seja Correios.
3. **Cidade de Destino Fixada na Capital ([public/js/dashboard.js:811-817](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/dashboard.js#L811-L817)):**
   Existe um mapa fixo `UF -> Capital` (`'SP': 'São Paulo'`, `'RJ': 'Rio de Janeiro'`, `'MG': 'Belo Horizonte'`). Se a nota for para o interior de MG, o dashboard exibe "Belo Horizonte".
4. **Protocolo SEFAZ Sintético ([services/danfe_service.js:39-42](file:///c:/Users/Roberto/Desktop/Web_Services/services/danfe_service.js#L39-L42)):**
   Se o XML enviado não tiver o nó de protocolo `<nfeProc>`, o serviço fabrica em tempo de execução um protocolo falso:
   `<nProt>000000000000000</nProt><digVal>PROT_AUTO</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>`.
5. **Dados de Empresa Hardcoded ([services/print_service.js:49-54](file:///c:/Users/Roberto/Desktop/Web_Services/services/print_service.js#L49-L54)):**
   Fallback com dados fixos da loja piloto caso o tenant não tenha os campos preenchidos:
   `CNPJ: '10436619000105'` e `Razão Social: 'LALUA COMERCIO DE MODAS EIRELI'`.

---

## 8. Estado Real do Produto

| Funcionalidade | Status Real | O que existe | O que falta / Divergência |
| :--- | :--- | :--- | :--- |
| **Emissão SEFAZ-ES (DUA-e)** | **Funciona de ponta a ponta** | SOAP 1.2, mTLS com A1, PDF gerado | Falta validação de status de cancelamento prévio |
| **Emissão Portal GNRE Nacional** | **Funciona de ponta a ponta** | SOAP v2.00, mTLS, consulta de recibo | Não trata FCP em guia separada por UF |
| **Lote XML São Paulo (SP)** | **Parcial** | Gera XML de lote para download | Exige importação manual no site da SEFAZ-SP |
| **Remessa Bancária CNAB 240** | **Funciona de ponta a ponta** | Padrão Itaú SISPAG gerado e validado | Pagamento por arquivo/internet banking, não é online |
| **Retorno Bancário (.RET)** | **Funciona de ponta a ponta** | Parser lê arquivo de retorno e baixa guias | Processo manual de upload do arquivo |
| **Romaneio da Coleta** | **Parcial** | Gera relatório por transportadora | Não valida se a guia foi paga antes de listar a nota |
| **Upload de XML de NF-e** | **Funciona de ponta a ponta** | Upload múltiplo e extração de dados | Falha se a nota não tiver a tag `<vICMSUFDest>` |
| **Integração Linx Microvix** | **Funciona de ponta a ponta** | Consulta B2CConsultaNFe e baixa XMLs | Sem detecção de notas canceladas na origem |
| **Integração Olist Vnda** | **Parcial** | Lista pedidos via API v2 | Não sincroniza automaticamente via webhook |
| **Integração Bling / Tiny / Omie** | **Parcial** | Baixa XMLs por data via API | Sem mapeamento de status de transporte |
| **Cálculo de DIFAL** | **Não existe** | Extrai valor já calculado do XML | Não calcula alíquotas, base simples/dupla nem FCP |
| **Multi-Tenant** | **Parcial** | Isolamento por `tenant_id` em código | RLS desligado no Supabase; sem testes de isolamento |
| **Planos e Limites** | **Funciona de ponta a ponta** | Bloqueio mensal por cota de guias | Sem gateway de pagamento recorrente (Stripe/Asaas) |
| **Relatórios e BI** | **Parcial** | Endpoints de agregação e exportação CSV | Interface visual escura e com métricas simuladas |
| **Portão Fiscal (Bloqueio sem guia paga)** | **Não existe** | Não há conceito de liberação por nota | Nota sai no romaneio mesmo com guia apenas gerada |
| **Pagamento via Asaas** | **Não existe** | Nenhuma linha de código ou conector | Deve ser construído do zero na Fase 3 |

---

## 9. Riscos e Dívidas Técnicas

1. **Risco de Duplicidade Fiscal e Bancária (Severidade Crítica):**  
   Não há índice único ou verificação de idempotência no banco de dados para a combinação `(chave_nfe, tipo_guia)`. Se o operador clicar duas vezes ou reenviar um lote, o sistema pode gerar outra guia na SEFAZ e incluir duas vezes a mesma linha no arquivo de remessa bancária CNAB.
2. **Incompatibilidade Arquitetural da Vercel com Agendador Automático:**  
   O arquivo [server.js:2950-2956](file:///c:/Users/Roberto/Desktop/Web_Services/server.js#L2950-L2956) instancia um `setInterval` em memória para rodar a sincronização a cada 30 minutos. Em ambiente Serverless (Vercel), a função é congelada/destruída após responder a requisição HTTP. **O agendador automático não executa em produção na Vercel.** É necessário utilizar Vercel Cron Jobs chamando um endpoint autenticado ou um worker dedicado.
3. **Desconexão entre o DDL do Banco ([schema.sql](file:///c:/Users/Roberto/Desktop/Web_Services/schema.sql)) e o Código:**  
   Colunas cruciais de integração (`microvix_*`, `vnda_*`, `erp_*`) não estão no script SQL de migração. Se o banco for recriado a partir do `schema.sql`, o backend quebrará de imediato com erro de SQL (`column does not exist`).
4. **Armazenamento de Dados Pessoais (LGPD):**  
   CPFs e nomes completos de pessoas físicas (destinatários das compras) são extraídos do XML e mantidos em logs e respostas JSON sem mascaramento consistente ou política de expiração.
5. **Contradições Comerciais da Landing Page:**  
   A landing page comercial promete "apurar DIFAL e calcular o imposto", enquanto o backend apenas extrai valores pré-calculados pelo emissor. Se um cliente emitir notas sem a tag de partilha preenchida, o sistema rejeitará os XMLs.

---

## 10. Pontos de Encaixe Para o Novo Fluxo (`FLUXO_COMPLETO_expedi.md`)

Confronto detalhado entre as 10 etapas do novo fluxo e a base de código atual:

| Etapa Novo Fluxo | Onde no código atual se encaixaria | O que já existe e pode ser reaproveitado | O que precisa ser criado do zero | Conflitos com o código atual |
| :--- | :--- | :--- | :--- | :--- |
| **E1 — Entrada da NF-e** | `services/sync_service.js:39` e `server.js:400` | Parser de XML ([parser_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/parser_service.js)), integração Linx Microvix ([microvix_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/microvix_service.js)) | Criação da tabela dedicada `nfe` e verificação de duplicidade por chave | Hoje o sistema não grava a NF-e em tabela própria antes de criar o lote; agrupa tudo direto no lote |
| **E2 — Cálculo do DIFAL** | Novo módulo: `services/tax_service.js` | Extração de destinatário, emitente e valores básicos | Motor de cálculo de alíquotas por UF, tabela versionada com vigência e tratamento de `SEM_GUIA` para SP $\rightarrow$ SP | **Conflito total:** hoje o código exige que o XML já venha com `<vICMSUFDest>` calculado |
| **E3 — Emissão da Guia** | `services/gnre_service.js` e `services/dua_es_service.js` | Chamadas SOAP mTLS para Portal GNRE e SEFAZ-ES | Tratamento de estados na nova máquina de estados (`EMITIDA`, `REJEITADA_SEFAZ`) | Hoje os erros SEFAZ ficam em texto livre na tabela `batches`, sem catalogação estruturada |
| **E4 — Conferência Automática** | Novo middleware/job em `services/conference_service.js` | Formatação de código de barras e linha digitável em [cnab_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/cnab_service.js) | Checklist dos 9 itens (conferência de valor, vencimento, não-cancelamento, dígito verificador) | Não existe nenhum passo de conferência hoje; a guia emitida vai direto para a remessa |
| **E5 — Montagem do Lote** | `server.js:400` (refatorar de upload para montagem de guias conferidas) | Estrutura de agrupamento por lote | Seleção de guias com estado `CONFERIDA`, corte de horário e cálculo de totais por UF | Atualmente o lote é criado no momento do upload do arquivo, e não a partir de guias prontas |
| **E6 — Alçada e Aprovação** | Novo módulo: `services/approval_service.js` | Validação de permissões em `server.js` | Tabela `politica_alcada`, cálculo de hash de assinatura do lote, travas de segregação de funções | Hoje qualquer usuário logado clica em "Autorizar Pagamento" sem alçada ou MFA |
| **E7 — Pagamento via Asaas** | Novo conector: `services/asaas_service.js` | Tratamento de linha digitável e código de barras | Integração REST do Asaas "Pague Contas", fila de pagamento, chave de idempotência bancária | **Inexistente hoje:** pagamentos só ocorrem via download de arquivo CNAB offline |
| **E8 — Confirmação e Comprovante**| Novo endpoint: `POST /api/webhooks/asaas` | Upload para o Storage bucket em `server.js` | Webhook receiver com validação de assinatura, download automático do PDF de comprovante e vínculo na guia | Não existe recebimento de webhooks nem tabela de comprovantes de pagamento |
| **E9 — Liberação e Combo** | `server.js:1115` (`/api/expedicao/romaneio`) e `services/print_service.js` | Geração de PDF e mesclagem intercalada ([print_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/print_service.js)) | **Portão Fiscal:** bloquear notas sem guia `COMPROVADA` ou `SEM_GUIA`. Combo triplo [Romaneio + Guia + Comprovante] | **Conflito grave:** o romaneio atual lista qualquer nota que teve guia gerada, independente de pagamento |
| **E10 — Conciliação e Fechamento** | `services/closing_service.js` e `server.js:1915` | Leitura de extrato e Asaas | Cruzamento quádruplo (NF × Guia × Asaas × Doca), Relatório Executivo PDF, Planilha CSV UTF-8 BOM e Pacote ZIP para Auditoria | **100% Implementado:** Engine de fechamento ativo com hash de integridade SHA-256 e download via dashboard |

---

## 11. Status de Implementação das Etapas do Portão Fiscal (expedi HUB)

Todas as etapas fundamentais da esteira (E1 a E10) foram desenvolvidas, testadas e homologadas com sucesso:

1. **Etapa 1 — Captação Automática na Fonte (Linx Microvix + Olist Vnda):**
   - SOAP B2CConsultaNFe ativo resgatando dados fiscais e pedido (`xPed`).
   - Vnda API v2 (`/api/v2/orders/:code`) sem erro HTTP 500.
   - Mapeamento preciso de transportadoras: Total Express, Correios, MT Log, Jadlog, Loggi.
   - Validado via `scratch/test_etapa1_homologacao.js`.

2. **Etapa 2 — Módulo Asaas & Autorização do Responsável:**
   - Conector Asaas v3 Pague Contas com estrita idempotência (`externalReference = "guia_${id}"` e travas de banco).
   - Tela PWA leve e mobile-first para a responsável aprovar no celular ([public/aprovar.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/aprovar.html)).
   - Webhook oficial `/api/webhooks/asaas` para confirmação de liquidação (`BILL_PAID`).
   - Validado via `scratch/test_etapa2_asaas.js`.

3. **Etapa 3 — Combo Completo de Expedição (Romaneio + DANFE + GNRE + Asaas):**
   - Romaneio oficial em PDF A4 Paisagem com vistos do motorista e expedição (`services/print_service.js`).
   - Combo 3-em-1 / 4-em-1 unificado por transportadora (`GET /api/expedicao/combo/:batchId`).
   - Validado via `scratch/test_etapa3_combo.js`.

4. **Etapa 4 — Portão Fiscal na Doca, Bipagem e Liberação Nota a Nota:**
   - Bipador de código de barras na doca com validação em tempo real (🟢 Liberado vs 🔴 Bloqueado).
   - Liberação nota a nota avulsa no Asaas (`autorizarPagamentoGuiaAvulsa`).
   - Configurações privadas de notificações da diretoria em `public/profile.html`.
   - Validado via `scratch/test_etapa4_e2e.js`.

5. **Etapa 10 — Fechamento Contábil, Reconciliação Bancária & Pacote de Auditoria (.ZIP):**
   - Engine de conciliação quádrupla e detecção de divergências ([services/closing_service.js](file:///c:/Users/Roberto/Desktop/Web_Services/services/closing_service.js)).
   - Geração de Relatório Executivo Oficial para Diretoria e Contabilidade em PDF (`GET /api/fechamento/relatorio-pdf`).
   - Exportação de Planilha de Conciliação em CSV com UTF-8 BOM e delimitador `;` compatível com Excel BR (`GET /api/fechamento/planilha-csv`).
   - Empacotador automático de Auditoria em `.ZIP` com XMLs das notas, comprovantes bancários Asaas, relatório PDF e planilha CSV (`GET /api/fechamento/pacote-zip`).
   - Modal corporativo de Fechamento Contábil integrado ao [public/dashboard.html](file:///c:/Users/Roberto/Desktop/Web_Services/public/dashboard.html) com cálculo de hash SHA-256 e download imediato.
   - Validado via `scratch/test_etapa10_fechamento.js` e suite integral `scratch/audit_suite_e1_to_e9.js` (21/21 testes aprovados).

Consulte o manual técnico e operacional detalhado em:
👉 **[MANUAL_PORTAO_FISCAL_EXPEDICAO.md](file:///c:/Users/Roberto/Desktop/Web_Services/MANUAL_PORTAO_FISCAL_EXPEDICAO.md)**

---
*Relatório atualizado e homologado na raiz como `PANORAMA_PROJETO.md`.*
