# MANUAL COMPLETO DO PORTÃO FISCAL DE EXPEDIÇÃO (expedi HUB)
> **Solução de Automação de DIFAL, Liquidação Bancária Asaas e Liberação de Cargas na Doca**  
> *Cliente Piloto: Boah / Lalua Comércio de Modas Eireli (CNPJ: 10.436.619/0001-05)*

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

## 2. As 4 Etapas Implementadas no Sistema

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 FLUXO OPERACIONAL COMPLETO                              │
│                                                                                        │
│  [1. Captação Linx/Vnda] ──► [2. Aprovação Mobile] ──► [3. Combo PDF] ──► [4. Doca]   │
│   Captura NF-e SOAP B2C       Dona aprova no celular   Romaneio + DANFE   Bipagem na   │
│   e Transportadora Vnda       Débito Asaas em segundos  + GNRE + Asaas    caixa e carga│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Etapa 1: Captação Automática na Fonte (Linx Microvix + Olist Vnda)
- **Serviços:** [`services/microvix_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/microvix_service.js), [`services/vnda_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/vnda_service.js) e [`services/sync_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/sync_service.js).
- **O que faz:**
  - Consulta faturamento B2C via SOAP `B2CConsultaNFe` no Linx Microvix resgatando Chave de Acesso, UF de destino, `<vICMSUFDest>` e o número do pedido (`xPed`).
  - Consulta a API v2 da Olist Vnda (`/api/v2/orders/:code`) sem erros de ordenação (HTTP 500 corrigido).
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

### Etapa 3: Combo Completo de Expedição (Romaneio + DANFE + GNRE + Asaas)
- **Serviço:** [`services/print_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/print_service.js).
- **Rotas:** 
  - `GET /api/expedicao/romaneio` (HTML interativo para visualização e impressão).
  - `GET /api/expedicao/romaneio-pdf` (PDF A4 Paisagem oficial).
  - `GET /api/expedicao/combo/:batchId?carrier=TOTAL%20EXPRESS` (Pacote documental 3-em-1).
- **O que faz:**
  - Gera o **Romaneio Oficial da Transportadora em A4 Paisagem**, contendo:
    - Identificação corporativa da empresa e da transportadora;
    - Indicadores do Portão Fiscal (Total de Volumes, Liberados, Retidos e Total DIFAL);
    - Tabela completa (Item, Pedido, NF, Destinatário, UF, DIFAL, Status Fiscal, Autenticação Bancária e espaço para visto do motorista);
    - Assinatura da Expedição e do Motorista Coletador (com RG e Placa).
  - Unifica no mesmo PDF para cada nota fiscal: **Folha do Romaneio + DANFE + Guia GNRE + Comprovante Oficial Asaas**.
- **Resultado:** O caminhão viaja com a pasta completa e documentação indiscutível para a SEFAZ.

---

### Etapa 4: Interface Final do Portão Fiscal na Doca & Bipagem de Caixas
- **Frontends:** [`public/dashboard.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/dashboard.html), [`public/js/dashboard.js`](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/dashboard.js), [`public/profile.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/profile.html).
- **O que faz:**
  - **Bipador de Caixas na Doca:** O operador aponta o leitor de código de barras para a caixa (lendo a DANFE ou o Pedido) e pressiona `ENTER`.
  - **Modal Instantâneo do Portão Fiscal:**
    - 🟢 **LIBERADO PARA EMBARQUE:** Borda verde, comprovando quitação bancária (ou isenção SP). Pode carregar no caminhão.
    - 🔴 **RETIDO NA DOCA — NÃO EMBARCAR:** Alerta vermelho bloqueando a carga se houver DIFAL pendente de pagamento.
  - **Liberação Nota a Nota (`⚡ Pagar`):** Botão direto na linha da tabela da doca para liquidar uma remessa urgente no Asaas sem precisar processar o lote inteiro.
  - **Configurações Privadas de Notificação:** Card seguro na tela de Perfil para cadastrar o WhatsApp/e-mail da responsável com total privacidade.

---

## 3. Guia Operacional do Dia a Dia (Como a Empresa Usa)

### A. Para a Diretoria / Financeiro (No Celular)
1. A responsável abre o link **`/aprovar.html`** no navegador do celular (pode clicar em *"Adicionar à tela inicial"* para criar o ícone de aplicativo).
2. A tela exibe o saldo disponível no Asaas e as guias que a expedição preparou.
3. A responsável confere o valor total e toca em **"⚡ Autorizar Pagamento via Asaas"**.
4. Pronto! O débito é efetuado e as notas são liberadas no galpão imediatamente.

### B. Para o Operador da Expedição / Doca (No Computador do Galpão)
1. Quando as caixas estiverem prontas na doca, o operador acessa o Painel (**`/dashboard.html`**).
2. **Conferência das Caixas (Bipagem):**
   - O operador clica no campo de busca/bipagem no topo da tabela.
   - Bipa o código de barras da DANFE (os 44 dígitos) colada na caixa (ou digita a NF e aperta `ENTER`).
   - O sistema mostra:
     - 🟢 **VERDE:** O operador joga a caixa no caminhão e aperta `ENTER` para bipar a próxima.
     - 🔴 **VERMELHO:** A caixa fica separada no chão da doca. Não entra no veículo.
3. **Impressão do Pacote da Transportadora:**
   - Com o caminhão pronto, o operador seleciona a transportadora no filtro (ex: `TOTAL EXPRESS`) e clica em **`📦 Combo Expedição (3 em 1)`**.
   - A impressora emite o maço de documentos: o Romaneio de Coleta para o motorista assinar + todas as DANFEs, Guias e Comprovantes Asaas.
   - O operador entrega o maço na mão do motorista e libera o caminhão.

---

## 4. Referência Técnica de Rotas da API

| Método | Rota | Autenticação | Descrição |
|---|---|:---:|---|
| `GET` | `/api/expedicao/romaneio` | Sim | Visualização HTML profissional do romaneio em paisagem para impressão |
| `GET` | `/api/expedicao/romaneio-pdf` | Sim | Download direto do PDF A4 Paisagem do romaneio |
| `GET` | `/api/expedicao/combo/:batchId` | Sim | Download do PDF unificado (Romaneio + DANFE + GNRE + Asaas) |
| `POST` | `/api/guide/authorize-payment-asaas/:guideId` | Sim | Liquidação/autorização imediata de uma única nota avulsa no Asaas |
| `POST` | `/api/batch/authorize-payment-asaas/:batchId` | Sim | Liquidação/autorização do lote completo no Asaas |
| `GET` | `/api/guide/comprovante/:guideId` | Sim | Download/visualização do comprovante oficial de quitação Asaas |
| `POST` | `/api/tenant/notifications` | Sim | Salva WhatsApp e e-mail privados da responsável para alertas |
| `POST` | `/api/tenant/asaas-credentials` | Sim | Salva com criptografia AES-256 a API Key e ambiente do Asaas |
| `POST` | `/api/webhooks/asaas` | Não (Público Asaas) | Receptor de confirmação de liquidação bancária (`BILL_PAID`) |

---

## 5. Estrutura do Banco de Dados (Supabase)

### Tabela `tenants`
- `asaas_api_key_encrypted` (`TEXT`): Chave de API protegida com AES-256-CBC.
- `asaas_environment` (`VARCHAR(20)`): `'sandbox'` ou `'producao'`.
- `notification_phone` (`VARCHAR(50)`): WhatsApp/celular privado da responsável.
- `notification_email` (`VARCHAR(255)`): E-mail para alertas financeiros.

### Tabela `guides`
- `asaas_bill_id` (`VARCHAR(100)`): ID da transação no Asaas (Pague Contas).
- `receipt_url` (`TEXT`): Link oficial do comprovante bancário no Asaas.
- `receipt_storage_path` (`TEXT`): Caminho do PDF do comprovante no Supabase Storage.
- `payment_authorized_by` (`VARCHAR(255)`): E-mail do usuário que aprovou o débito.
- `payment_authorized_at` (`TIMESTAMPTZ`): Data e hora exatas da aprovação.

### Tabela `batches`
- `approval_status` (`VARCHAR(50)`): `'pendente'`, `'autorizado'`, `'rejeitado'`.
- `approved_by` (`VARCHAR(255)`): Responsável pela autorização do lote.
- `approved_at` (`TIMESTAMPTZ`): Timestamp da autorização.

---

## 6. Scripts de Teste e Validação (Pasta `scratch/`)

Para auditar ou homologar qualquer parte do sistema via terminal:
- `node scratch/test_etapa1_homologacao.js`: Testa captação real na Linx Microvix e na Olist Vnda.
- `node scratch/test_etapa2_asaas.js`: Valida saldo, pagamento simulado e geração de comprovante Asaas.
- `node scratch/test_etapa3_combo.js`: Gera o Romaneio em A4 Paisagem e o Combo 3-em-1 em PDF para validação visual.
- `node scratch/test_etapa4_e2e.js`: Executa o teste ponta a ponta de todas as etapas integradas.

---
*Manual técnico e operacional gerado para a esteira do expedi HUB / Antigravity.*
