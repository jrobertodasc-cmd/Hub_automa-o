# EXPEDI HUB — RESUMO EXECUTIVO & BRIEFING DE CONTINUIDADE

> **Data da Última Atualização:** 27 de Outubro de 2026 — 15:05 (Horário de Brasília)  
> **Repositório:** [https://github.com/jrobertodasc-cmd/Hub_automa-o](https://github.com/jrobertodasc-cmd/Hub_automa-o)  
> **Branch Ativo:** `main` (Deploy contínuo no Render: [expedihub.onrender.com](https://expedihub.onrender.com))  
> **Empresa Piloto:** Lalua Comércio de Modas Eireli (Boah) — CNPJ: `10.436.619/0001-05`  
> **Objetivo deste documento:** Ponto de ancoragem completo com a conclusão da conciliação bancária, blindagem anti-duplicidade, eliminação definitiva de prévias internas sem valor fiscal, adição da coluna de emissão individual direta na SEFAZ com modal de data de pagamento, transmissão em lote filtrando estritamente notas não pagas e conector oficial da Total Express Smart Label com geração de etiquetas térmicas 10x15cm.

---

## 1. Conquistas Recentes & Validações Críticas

### 1.1. Conector Oficial Total Express Smart Label & Etiquetas Térmicas 10x15cm
* **Serviço Implementado:** [`services/total_express_service.js`](file:///c:/Users/Roberto/Desktop/Web_Services/services/total_express_service.js).
* **Integração com API Smart Label:**
  * Endpoint oficial `https://apis.totalexpress.com.br/ics-edi-lv/v1/coleta/smartlabel/registrar` via Basic Auth Base64.
  * Montagem automática do payload com dados do remetente (Lalua `10.436.619/0001-05`), NF-e (número, série, chave de 44 dígitos, valor e CFOP) e destinatário completo.
  * Captura imediata do código de rastreio **AWB** e da **Rota Operacional** (ex: `(A)99-SAO-L-TZO-[999]`).
* **Gerador de Etiqueta Térmica 100mm x 150mm (PDFKit + bwip-js):**
  * Dimensões exatas de 10x15cm em pontos PDF (`[283.46, 425.20]`).
  * Inclui: Cabeçalho Total Express, Rota Operacional em destaque, Código de Barras Code 128 da AWB, Data Matrix 2D (25x25mm), dados completos do Destinatário, Código de Barras Code 128 do CEP e dados fiscais da NF-e e remetente.
* **Rotas Integradas no Backend:**
  * `POST /api/total-express/despachar/:guideId`: registra a encomenda e gera a etiqueta.
  * `GET /api/total-express/etiqueta/:guideId`: visualiza e imprime a etiqueta térmica em formato pronto para impressora Zebra/térmica.
  * Botão **"Etiqueta"** adicionado diretamente na coluna de Ações da Doca ao lado de DANFE.

### 1.2. Eliminação Definitiva da "Prévia Interna / Não Pagar"
* **Status:** **BANIDO TOTALMENTE DO SISTEMA.**
* No gerador de PDFs (`services/print_service.js`), foi removida a lógica de emitir espelhos simulados com faixa vermelha *"PRÉVIA INTERNA / DOCUMENTO SEM VALOR FISCAL / NÃO PAGAR"*.
* Se uma guia ainda não possui código de barras oficial retornado pela SEFAZ, o sistema recusa a geração de prévias fake e orienta o operador a realizar a emissão oficial via **"⚡ Emitir SEFAZ"**.
* Na rota `GET /api/guide/download/:guideId`, guias pendentes de retorno exibem tela informativa elegante com os dados da NF e instrução para emissão oficial com data de pagamento, impedindo que documentos inválidos circulem na expedição.

### 1.2. Coluna "Emissão SEFAZ" e Transmissão Individual com Pop-up de Data (`public/dashboard.html` / `dashboard.js` / `server.js`)
* **Coluna Exclusiva na Doca:** Adicionada a coluna **"Emissão SEFAZ"** na tabela de cargas, posicionada ao lado de Ações/DANFE.
* **Modal Individual de Data de Pagamento:**
  * Ao clicar no botão **"⚡ Emitir SEFAZ"**, abre um pop-up com os dados da NF (número, UF de destino, valor do tributo) e campo para escolha da **Data Prevista de Pagamento / Vencimento** (default: data atual).
  * O operador pode definir livremente a data (hoje, amanhã ou data programada).
* **Endpoint de Transmissão Direta (`POST /api/guide/emitir-sefaz/:guideId`):**
  * Dispara a transmissão em tempo real no WebService oficial (GNRE v2.00 / DUA-ES / XML Lote SP) utilizando o certificado digital A1 PFX do tenant.
  * Captura o código de barras Febraban oficial e a linha digitável retornados pela SEFAZ.
  * Atualiza o registro da guia no banco de dados, gera o espelho oficial e disponibiliza imediatamente o link **"🏛️ Guia Oficial"** e a opção de **"🔄 Reemitir"** (se precisar alterar vencimento).
  * Se a guia já estiver como `paga`, a reemissão é bloqueada automaticamente com aviso na tela para prevenir duplicidade.

### 1.3. Emissão em Lote na Barra Superior com Filtro Estrito de Não Pagas
* **Botão na Barra da Doca & Barra Flutuante:** `⚡ Emitir SEFAZ em Lote (c/ Data)`.
* **Modal de Transmissão em Lote:**
  * Exibe o resumo detalhado: calcula em tempo real quantas guias estão pendentes e quantas já foram pagas.
  * Garante que notas já quitadas (ex: as 87 guias pagas no Itaú) sejam **100% preservadas e ignoradas da transmissão**, sem nenhum risco de reemissão duplicada.
  * Permite selecionar a data de vencimento unificada para o lote pendente.
* **Backend Reforçado (`server.js`):**
  * O método `transmitStagedBatchToSefaz` ignora ativamente notas com `status = 'paga'`, `comprovada` ou `paid_at IS NOT NULL`, emitindo logs de auditoria claros na esteira de faturamento.

### 1.4. Conciliação Bancária Oficial Concluída e Zerada (27/10/2026)
* **Status:** **100% RESOLVIDO E BATIDO NO LINX MICROVIX.**
* **Extrato Bancário Itaú:** Lote de 87 guias (57 interestaduais + 30 DAREs SP) debitado em 26/10/2026 via remessa SISPAG (`REM2610.txt`) no valor total de **R$ 3.846,22**.
* **Resolução da Diferença de R$ 25,58 no Contas a Pagar:**
  * **Fatura Desmarcada Localizada:** NF `53890` (Fatura nº `461327 / 1`, vencimento 21/10/2026) no valor de **R$ 24,73** estava sem marcação na tela de baixa.
  * **Ajuste de Juros da SEFAZ-MA:** NF `53029` (Fatura nº `453164 / 1`) no valor base de R$ 64,52 foi debitada no banco por R$ 65,80 devido a juros de atraso da SEFAZ Maranhão. O juros no sistema foi atualizado de R$ 0,43 para R$ 1,28 (diferença de **R$ 0,85**).
  * **Fechamento:** $\text{R\$\ } 24,73 + \text{R\$\ } 0,85 = \mathbf{\text{R\$\ } 25,58}$. A diferença foi zerada e a baixa do lote autorizada com sucesso.

### 1.2. Blindagem Anti-Duplicidade no Backend (`server.js`)
* **Trava Sistêmica nas Rotas de Remessa (`/api/remessa/download/:batchId`):**
  * O gerador CNAB 240 (Itaú, Bradesco e Banco do Brasil) agora possui filtro rígido `situacaoPagamentoGuia(g) !== 'paga'`.
  * Guias já quitadas (`status = 'paga'`, `comprovada` ou com data de pagamento `paid_at`) são **automaticamente impedidas de entrar em novos arquivos de remessa**, eliminando qualquer risco de débito duplo na conta corrente.
  * Se o operador tentar gerar remessa para um lote 100% quitado, o sistema bloqueia e retorna aviso claro: *"Nenhuma guia pendente para pagamento. Todas as guias deste lote já foram liquidadas anteriormente."*
  * Guias exportadas para remessa registram status de processamento e auditoria com data/hora.

### 1.3. Visualização em 3 Estados na Doca e Tesouraria (`dashboard.html` / `dashboard.js`)
* **Abas Operacionais Diretas com Contadores em Tempo Real:**
  * `Todos no Lote`: contagem global de volumes e cargas.
  * `🟢 Pagas`: cargas 100% liberadas na doca, com guia liquidada no banco (badge verde esmeralda com data de quitação).
  * `🟡 Pendentes`: guias emitidas com código de barras/DARE válidos, aguardando inclusão na próxima remessa bancária sob demanda (badge âmbar).
  * `🔴 Não Pagas / Retidas`: notas fiscais com inconsistências fiscais (sem XML, sem código de barras ou rejeitadas na SEFAZ).
* **Botão Inteligente na Tesouraria:**
  * Se houver guias pendentes: exibe `Baixar Remessa (X guias pendentes · R$ Y)` em azul de ação primária.
  * Se o lote estiver 100% pago: exibe `✅ Todas as Guias deste Lote estão Pagas` em verde com trava de segurança anti-clique.

### 1.4. Cockpit E-commerce 360°: Emissões Atuais & DIFAL Sincronizada (`ecommerce_service.js` / `dashboard.js`)
* **Prioridade para Emissões Atuais (Outubro/2026):**
  * Ordenação corrigida no backend para **mais recentes primeiro** (`order('nf_issue_date', { ascending: false })` e `order('nf_number', { ascending: false })`). As notas de Outubro (NF 53895, 53894, 53893, etc.) agora aparecem imediatamente no topo da tela principal.
  * **Seletor de Período Integrado:**
    * `📅 Mês Atual (Out/26)`: Exibe apenas as 33 emissões de Outubro/2026 por padrão.
    * `📅 Set/2026`: Exibe as 57 emissões de Setembro/2026.
    * `📚 Histórico Completo`: Exibe as 91 emissões completas (Julho, Setembro, Outubro).
* **Sincronização Fidedigna da Situação DIFAL:**
  * Base de dados reconciliada com precisão cirúrgica:
    * **87 Guias Confirmadas como Pagas** (57 GNRE + 30 DARE SP = R$ 3.846,22 debitados no Itaú em 26/10). Exibem badge `🟢 Paga (Liquidada) · 26/10`.
    * **4 Guias Não Pagas Identificadas** (NF `53801`: R$ 27,06; NF `53567`: R$ 31,49; NF `53500`: R$ 66,75; NF `53336`: R$ 48,90 — soma de R$ 174,20 com dados de XML/código de barras pendentes). Exibem badge `🔴 Não Paga / Retida`.
  * Filtro rápido na barra de ferramentas por situação: `Todas as DIFALs`, `🟢 Pagas`, `🟡 A Pagar` e `🔴 Não Pagas / Retidas`.
  * Os KPIs do topo (Faturamento, Total DIFAL, Pedidos, Peças) reagem dinamicamente ao período selecionado.
* **Detecção de Novas Emissões no Linx Microvix:**
  * Identificadas 13 novas notas fiscais emitidas no Linx Microvix entre 22/10 e 26/10 (NF 53985 a 54033), sendo 5 notas com DIFAL interestadual (NF 53985: SP R$ 36,77; NF 53999: RJ R$ 34,78; NF 54010: AL R$ 27,86; NF 54011: RJ R$ 36,72; NF 54012: MG R$ 37,21) prontas para serem sincronizadas no próximo lote ativo sob demanda.

---

## 2. Fluxo Operacional Vigente (Sob Demanda via Itaú SISPAG)

Enquanto a funcionalidade da Asaas aguarda apresentação e homologação pela diretoria:
1. **Faturamento:** As notas são emitidas no ERP e importadas no Expedi Hub; as guias geradas entram automaticamente na aba **🟡 Pendentes**.
2. **Fechamento do Lote:** No momento do fechamento financeiro, o operador clica no botão de remessa e baixa o arquivo `REMddmm.txt` contendo **apenas** as guias que ainda não foram pagas.
3. **Liquidação Bancária:** O arquivo é transmitido no Itaú SISPAG; após o processamento, as guias migram automaticamente para **🟢 Pagas**, liberando as cargas para despacho imediato com os motoristas.

---

## 3. Estrutura Técnica e Integridade dos Arquivos
* **Rotas e Back-end:** [`server.js`](file:///c:/Users/Roberto/Desktop/Web_Services/server.js) — rotas operacionais ativas (`/api/remessa/download`, `/api/expedicao/cargas-ativas`, `/api/cnab/upload-retorno`).
* **Front-end Principal:** [`public/dashboard.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/dashboard.html) — interface Dark Luxury com as novas abas de estado e estilização de contadores.
* **Lógica e Interações:** [`public/js/dashboard.js`](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/dashboard.js) — filtros por situação (`PAGAS`, `PENDENTES`, `NAO_PAGAS`), contadores em tempo real e travas anti-duplicidade.
* **Estilos Oficiais:** [`public/css/expedi-theme-clean.css`](file:///c:/Users/Roberto/Desktop/Web_Services/public/css/expedi-theme-clean.css) — paleta executiva Dark Luxury.
* **Banco de Dados (Supabase):** Tabelas `guides`, `batches`, `tenants`, `invoice_items` sincronizadas com a produção.
