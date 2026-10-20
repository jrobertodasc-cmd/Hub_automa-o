# MANUAL COMPLETO DO PORTÃO FISCAL DE EXPEDIÇÃO (expedi HUB)
> **Solução de Automação de DIFAL, Liquidação Bancária Asaas e Liberação de Cargas na Doca**  
> *Cliente Piloto: Boah / Lalua Comércio de Modas Eireli (CNPJ: 10.436.619/0001-05)*  
> *Local de Operação: Shopping Barra — Salvador / BA*  
> *Última Atualização: 20 de Outubro de 2026*

---

## 1. Visão Geral & O Problema Resolvido

### O Problema Crônico Anterior
Nas operações de e-commerce de moda com vendas para fora do estado (consumidor final pessoa física), o recolhimento de **DIFAL** (ICMS Partilha Interestadual) sempre foi um gargalo crítico:
1. **Retenção de Caminhões na SEFAZ:** As notas fiscais eram emitidas pelo ERP (**Linx Microvix**), mas as guias de GNRE demoravam para ser pagas pelo financeiro (que gerava remessas semanais via CNAB 240). As caixas eram despachadas antes do pagamento bancário constar no sistema.
2. **Pagamentos em Duplicidade:** Ao passarem pelos postos fiscais de fronteira da SEFAZ (ex: RJ, MG, BA), os fiscais estaduais retinham o caminhão. A transportadora (**Total Express**, **MT Log**, etc.) pagava a guia no ato para liberar a carga e solicitava reembolso à empresa. Dias depois, o financeiro rodava a remessa bancária e pagava a **mesma guia novamente**, gerando descontrole de caixa e prejuízo.

### A Solução: expedi HUB (Portão Fiscal)
O sistema transforma o fluxo em um **Portão Fiscal Contínuo**:
- Nenhuma caixa entra no caminhão sem a certeza de que o tributo foi liquidado.
- A dona/responsável autoriza o pagamento em **1 clique pelo celular**.
- A liquidação é feita em **segundos via API Asaas** com autenticação bancária SISBACEN.
- A transportadora recebe o **Combo Completo de Expedição** (Romaneio + DANFE + GNRE + Comprovante Bancário Asaas) unificado por transportadora.

---

## 2. As Etapas Operacionais Implementadas

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    FLUXO OPERACIONAL COMPLETO                                    │
│                                                                                                  │
│ [1. Captação Linx/Vnda] ──► [2. Aprovação Mobile] ──► [3. DANFE + GNRE Febraban] ──► [4. Doca]   │
│  Captura NF-e SOAP B2C       Dona aprova no celular   DANFE Code 128C + GNRE ITF    Bipagem na   │
│  e Transportadora Vnda       Débito Asaas em segundos  com Linha Digitável e SISBACEN caixa e carga│
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Etapa 1: Captação Automática na Fonte (Linx Microvix + Olist Vnda)
- **Serviços:** [`services/microvix_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/microvix_service.js), [`services/vnda_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/vnda_service.js) e [`services/sync_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/sync_service.js).
- **O que faz:**
  - Consulta faturamento B2C via SOAP `B2CConsultaNFe` no Linx Microvix resgatando Chave de Acesso, UF de destino, `<vICMSUFDest>` e o número do pedido (`xPed`).
  - Consulta a API v2 da Olist Vnda (`/api/v2/orders/:code`).
  - Mapeia com precisão o transportador contratado pelo cliente no checkout: **TOTAL EXPRESS**, **CORREIOS**, **MT LOG**, **JADLOG**, **LOGGI**.
- **Resultado:** O sistema sabe exatamente para qual transportadora cada nota fiscal deve ser entregue.

---

### Etapa 2: Módulo Asaas & Autorização do Responsável
- **Serviço:** [`services/asaas_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/asaas_service.js).
- **Tela Mobile da Dona:** [`public/aprovar.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/aprovar.html).
- **O que faz:**
  - Integração com a API v3 do Asaas (**Pague Contas de Tributos** - `/v3/bill`).
  - **Idempotência Estrita:** Bloqueio no banco de dados e envio de `externalReference: "guia_${id}"`, impedindo qualquer tentativa de pagamento duplo da mesma guia.
  - Tela PWA adaptada para celular, com visual limpo, saldo da conta Asaas, total a pagar discriminado por transportadora e botão de aprovação em 1 toque.
  - Webhook oficial (`POST /api/webhooks/asaas`) para confirmação em tempo real de liquidação (`BILL_PAID`), fazendo o download automático do PDF do comprovante para o Supabase Storage.
- **Resultado:** A dona aprova de onde estiver em segundos; a liquidação é instantânea e gera comprovante com autenticação bancária.

---

### Etapa 3: Emissão de DANFE Simplificada e GNRE Febraban
- **Serviços:** [`services/danfe_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/danfe_service.js) e [`services/print_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/print_service.js).
- **DANFE Simplificada Oficial em PDF (A4):**
  - Gerada com código de barras **Code 128C** da Chave de Acesso de 44 dígitos.
  - Dados completos do emitente Lalua / Boah Shopping Barra, dados do destinatário, transportadora e produtos da nota.
  - Impressão individual em `/api/guide/danfe/:guideId` e em lote concatenado em `/api/guide/danfe-selecionadas`.
- **Guia GNRE Febraban Segmento 8 Oficial (A4):**
  - Gerada com o código de barras **Interleaved 2 of 5 (ITF)** de 44 posições e a linha digitável oficial de 48 posições calculada via **Módulo 10**.
  - Receita `100102` (DIFAL Consumidor Final) com código IBGE da UF de destino (`RJ = 0033`, `PE = 0026`, `AL = 0027`, etc.).
  - Exibe o **Código de Autenticação Bancária** (`AS-XXXXXXXX-BR`) em verde quando liberada e chancela mecânica no rodapé para controle nos postos fiscais de fronteira.
  - Impressão individual em `/api/guide/download/:guideId` e em lote concatenado em `/api/guide/gnre-selecionadas`.
- **Regra de Isenção de SP:**
  - Notas com destino a São Paulo não geram GNRE avulsa por força de Convênio ICMS (recolhimento unificado mensal pelo remetente). O Cockpit marca automaticamente as notas de SP como isentas/liberadas.

---

### Etapa 4: Interface Final do Portão Fiscal na Doca & Bipagem de Caixas
- **Frontends:** [`public/dashboard.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/dashboard.html), [`public/js/dashboard.js`](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/dashboard.js), [`public/aprovar.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/aprovar.html).
- **O que faz:**
  - **Bipador Laser de Caixas na Doca:** O operador aponta o leitor de código de barras para a caixa (lendo a DANFE de 44 dígitos) e pressiona `ENTER`.
  - **Modal Semafórico do Portão Fiscal:**
    - 🟢 **CARGA LIBERADA PARA EMBARQUE:** Borda verde, som harmônico em Fá Maior (`523Hz` + `659Hz` + `784Hz`), comprovando quitação bancária Asaas (ou isenção de SP).
    - 🔴 **CARGA RETIDA NA DOCA — PENDÊNCIA SEFAZ:** Alerta sonoro grave dissonante (`180Hz` + `135Hz`) e escudo SEFAZ, indicando DIFAL interestadual pendente.
  - **Segregação de Alçada Financeira:** O operador na doca **não possui poder para debitar a conta da empresa**. Ao se deparar com uma retenção, ele clica em `"Separar Caixa na Doca & Continuar Bipagem"` e `"Solicitar Liberação à Diretoria no App"`. O débito é feito exclusivamente pela dona em seu smartphone.
  - **Filtros por Data de Emissão e Situação:** Filtros rápidos `[Todas as Datas]`, `[Ontem]` e `[Hoje]`, além de abas para `[Na Doca]`, `[🔴 Bloqueadas]`, `[🟢 Liberadas]` e `[🚚 Já Despachadas]`.
  - **Emissão e Impressão em Lote:** Seleção múltipla via checkboxes na tabela para imprimir em lote todas as DANFEs e GNREs com um único clique.
  - **Gestão de Cargas Despachadas:** Botão `[🚚 Registrar Coleta (Despachar)]` para conferência final da transportadora e assinatura do Romaneio Oficial.
  - **Gestão de Devoluções & Crédito DIFAL:** Modal para vincular NF-e de entrada emitida no Linx quando o consumidor devolve a mercadoria, estornando e compensando o crédito fiscal para evitar bitributação.

---

## 3. Guia Operacional do Dia a Dia

### A. Para a Diretoria / Financeiro (No Celular)
1. A dona abre o link **`/aprovar.html`** no navegador do celular (ou ícone PWA na tela inicial).
2. A tela exibe o totalizador de volumes aguardando liberação na doca discriminado por transportadora (Total Express, Correios, MT Log).
3. A dona confere o resumo e clica em **"Deslize para Confirmar"** ou aprova individualmente a transportadora desejada.
4. O Asaas liquida as guias e o status na doca muda para liberado instantaneamente.

### B. Para o Operador da Expedição / Doca (No Computador da Loja - Shopping Barra)
1. O operador acessa o Cockpit do Portão Fiscal (**`/dashboard.html`**).
2. **Conferência das Caixas (Bipagem):**
   - O operador clica no campo de busca/bipagem no topo da tabela.
   - Bipa a etiqueta da DANFE colada na caixa (44 dígitos) e aperta `ENTER`.
   - O sistema emite o feedback sonoro e visual (Verde para embarque, Vermelho para retenção).
3. **Emissão de Documentos de Embarque:**
   - O operador seleciona as caixas liberadas e clica em **`Imprimir DANFE`** ou **`Imprimir GNRE`** para obter o PDF consolidado.
   - Clica em **`Documentos de Embarque`** para gerar o Romaneio Oficial A4 Paisagem.
4. **Registro da Coleta da Transportadora:**
   - Quando o caminhão terminar de ser carregado e o motorista assinar o Romaneio, o operador clica em **`Registrar Coleta (Despachar)`**.
   - As cargas saem do pátio ativo e vão para o histórico de despachadas.

---

## 4. Referência Técnica de Rotas da API

| Método | Rota | Autenticação | Descrição |
|---|---|:---:|---|
| `GET` | `/api/expedicao/cargas-ativas` | Sim | Lista todas as cargas do lote com status de liberação na doca |
| `GET` | `/api/guide/danfe/:guideId` | Sim | Download/visualização da DANFE Simplificada avulsa (PDF) |
| `GET` | `/api/guide/danfe-selecionadas` | Sim | Download de múltiplas DANFEs mescladas em PDF único |
| `GET` | `/api/guide/download/:guideId` | Sim | Download/visualização da Guia GNRE oficial com barcode Febraban ITF |
| `GET` | `/api/guide/gnre-selecionadas` | Sim | Download de múltiplas GNREs mescladas em PDF único |
| `GET` | `/api/expedicao/romaneio` | Sim | Visualização HTML profissional do Romaneio de Expedição em paisagem |
| `GET` | `/api/expedicao/romaneio-pdf` | Sim | Download direto do PDF A4 Paisagem do Romaneio oficial |
| `POST` | `/api/batch/authorize-payment-asaas/:batchId` | Sim | Liquidação/autorização do lote completo no Asaas via app mobile |
| `POST` | `/api/guide/authorize-payment-asaas/:guideId` | Sim | Liquidação/autorização imediata de uma única nota avulsa no Asaas |
| `POST` | `/api/webhooks/asaas` | Não (Público Asaas) | Webhook receptor de confirmação de liquidação bancária (`BILL_PAID`) |
| `GET` | `/api/fechamento/pacote-zip/hoje` | Sim | Pacote contábil diário em ZIP (XMLs, DANFEs, Comprovantes, CSV) |

---

## 5. Estrutura do Banco de Dados (Supabase)

O DDL completo e atualizado está disponível no arquivo [`schema.sql`](file:///c:/Users/Roberto/Desktop/Web_Services/schema.sql).

### Principais Colunas da Tabela `guides`:
- `barcode` (`VARCHAR(48)`): Código de barras Febraban Segmento 8 (44 dígitos).
- `line_digitizable` (`VARCHAR(60)`): Linha digitável oficial (48 dígitos com DVs de bloco).
- `bank_authentication` (`VARCHAR(100)`): Código de autenticação bancária SISBACEN / Asaas.
- `status` (`VARCHAR(30)`): `'aguardando_aprovacao'`, `'pagamento_enviado'`, `'comprovada'`, `'paga'`.
- `danfe_storage_path` (`TEXT`): Caminho do PDF da DANFE no Supabase Storage.
- `storage_path` (`TEXT`): Caminho do PDF da Guia GNRE no Supabase Storage.
- `receipt_storage_path` (`TEXT`): Caminho do comprovante de pagamento no Supabase Storage.
- `carrier_name` (`VARCHAR(100)`): Transportadora (Total Express, Correios, MT Log).

---

*Manual técnico e operacional da esteira do expedi HUB / Antigravity.*
