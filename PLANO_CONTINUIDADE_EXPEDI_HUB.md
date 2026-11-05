# 📋 PLANO DE CONTINUIDADE OPERACIONAL: expedi HUB (v2.0)
### Documento de Transição e Próximos Passos para Retomada

**Data de Registro:** 05/11/2026 • 17:40  
**Ambiente:** Windows • Node.js v26.13.0 • Supabase PostgreSQL • Render Production  
**Repositório:** `jrobertodasc-cmd/Hub_automa-o` (Branch: `main`)  
**Último Commit:** `2d64e14` (Sincronizado e implantado com sucesso no Render)

---

## 1. ORDEM ESTRATÉGICA DE EXECUÇÃO DEFINIDA PELO USUÁRIO

Para garantir que a apresentação à coordenação da BOAH ocorra somente quando o sistema estiver 100% lapidado, a ordem mandatória de execução é:

```
┌─────────────────────────────────────────────────────────────┐
│ 1º LUGAR: OPÇÃO 2 — Modularização Total do Backend (src/)   │
│ 2º LUGAR: OPÇÃO 3 — Simulação Real de Teste Ponta a Ponta   │
│ 3º LUGAR: OPÇÃO 1 — Roteiro Executivo da Reunião com a BOAH │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. STATUS ATUAL CONCLUÍDO E HOMOLOGADO HOJE

### A. Isolamento Multi-Tenant & Higienização de Dados:
- [x] Removidos 100% dos dados mockados, GMVs inventados, vendedoras fictícias (Bruna, Camila) e fallbacks globais de `server.js`.
- [x] Credenciais da Total Express e Linx Microvix isoladas por tenant. Conta histórica da BOAH e da Holding mantidas intactas.
- [x] 14 consultas PostgREST no Supabase travadas com filtro estrito `.eq('tenant_id', tenant.id)`.

### B. Arquitetura Modular (`src/`):
- [x] `src/config/constants.js` — Limites de planos (`PLAN_LIMITS`), CNPJs oficiais e lista de SuperAdmins.
- [x] `src/config/supabase.js` — Cliente Supabase único e desacoplado.
- [x] `src/utils/crypto.js` — Criptografia AES-256-GCM e comparação timing-safe.
- [x] `src/utils/events.js` — Barramento SSE isolado por tenant para Cockpit da Doca.
- [x] `src/middlewares/auth.js` — Middlewares de autenticação, RBAC e limites de franquia SaaS.
- [x] `src/middlewares/rateLimiter.js` — Proteção contra abuso e força bruta no login.
- [x] `src/middlewares/upload.js` — Instância do Multer centralizada em memória.
- [x] `services/comercial_service.js` — Gestão comercial, cupons e classificação de vendedoras.
- [x] `src/routes/auth.routes.js` — Cadastro público rate-limited, login, logout e sessão (`/api/auth/*`).
- [x] `src/routes/tenant.routes.js` — Configurações fiscais, upload A1 e regras comerciais (`/api/tenant/*`).
- [x] `src/routes/billing.routes.js` — Planos, status de consumo e checkout autônomo (`/api/billing/*`).
- [x] `src/routes/webhooks.routes.js` — Webhooks Asaas multi-tenant (Pague Contas + Assinaturas).

### C. Experiência de Onboarding e Conformidade Legal:
- [x] **Widget de Franquia no Dashboard:** Barra de progresso visual de guias emitidas / limite do plano no topo do Dashboard.
- [x] **Assistente de Onboarding:** Checklist de primeiro acesso de 4 passos (`public/js/onboarding.js` e banner dinâmico em `public/dashboard.html`).
- [x] **Termos de Uso e DPA (LGPD):** Páginas publicadas no ar em [`/terms.html`](https://expedihub.onrender.com/terms.html) e [`/privacy.html`](https://expedihub.onrender.com/privacy.html), com aceite obrigatório em [`/register.html`](https://expedihub.onrender.com/register.html).

### D. Bateria de Testes Automatizados (100% Aprovada):
```bash
npm test
```
* `tests/isolamento.test.js`: 45 asserções aprovadas (multi-tenancy, proteção BOAH, ranking Linx, DIFAL, lotes).
* `tests/total_express.test.js`: 2 asserções aprovadas (isolamento de credenciais da transportadora).
* `tests/billing_and_routes.test.js`: 13 asserções aprovadas (planos, upgrade, cadastro público, webhook de assinatura).

---

## 3. ROTEIRO DE TRABALHO PARA AMANHÃ

### 🎯 PASSO 1: Concluir a Modularização Total do Backend (Opção 2)
Extrair as rotas restantes de `server.js` para pastas modulares em `src/routes/`:
1. **`src/routes/difal.routes.js`**:
   - `GET /api/difal/painel-unificado` (Marco zero de guias pagas vs em aberto)
   - `POST /api/difal/baixar-guia`
   - `GET /api/difal/exportar-csv`
   - `GET /api/difal/danfe/:nf`
2. **`src/routes/bi.routes.js`**:
   - `GET /api/bi/metrics` (GMV real VNDA, canais, ranking de vendedoras)
   - `GET /api/relatorios/analitico-difal`
   - `GET /api/relatorios/vendas-periodo`
   - `GET /api/bi/stats`
   - `GET /api/bi/export-csv`
3. **`src/routes/batch.routes.js`**:
   - `POST /api/batch/process`
   - `POST /api/batch/authorize-emission/:batchId`
   - `POST /api/batch/authorize-payment-asaas/:batchId`
   - `GET /api/batch/status/:batchId`
   - `GET /api/batch/history`
4. **`src/routes/expedicao.routes.js`**:
   - `GET /api/expedicao/cargas-ativas`
   - `GET /api/expedicao/bipar`
   - `GET /api/expedicao/romaneio`
   - `GET /api/expedicao/romaneio-pdf`
   - Endpoints da Total Express (`/api/total-express/*`)
5. **`src/routes/admin.routes.js`**:
   - Endpoints de gestão master da plataforma (`/api/admin/*`)

*Meta:* Deixar o `server.js` como um entry-point ultra enxuto (< 300 linhas), contendo apenas inicialização do Express, middlewares globais e montagem das rotas.

---

### 🎯 PASSO 2: Simulação Completa do Fluxo Real Ponta a Ponta (Opção 3)
Ensaio operacional com dados reais:
1. Puxar pedido real da VNDA via script de teste.
2. Gerar o XML e processar o lote de teste.
3. Simular a liquidação Asaas e conferência de comprovante no Supabase Storage.
4. Bipar a carga no Cockpit da Doca e gerar o Romaneio em PDF.
5. Confirmar que a experiência do usuário transcorre sem nenhum erro no console ou na tela.

---

### 🎯 PASSO 3: Roteiro Executivo & Estratégico da Reunião com a BOAH (Opção 1)
Com o sistema 100% blindado e ensaiado:
1. Montar a apresentação executiva de 15 minutos em tópicos objetivos para a coordenadora.
2. Mapear as perguntas difíceis que a coordenação pode fazer (segurança, custo de guias, contingência de SEFAZ fora do ar) e as respostas prontas.
3. Definir a proposta comercial piloto (ex: 30 dias de uso assistido sem custo de setup).

---

## 4. COMANDOS ÚTEIS PARA RETOMADA AMANHÃ

```bash
# 1. Verificar integridade dos testes automatizados
npm test

# 2. Verificar conexão com os ambientes reais (Supabase e VNDA ao vivo)
node tests/verificar_ambiente_real.js

# 3. Iniciar servidor localmente (se necessário para inspeção)
npm start
```

---
*expedi HUB v2.0 — Operação Âncora BOAH & Arquitetura SaaS Enterprise*
