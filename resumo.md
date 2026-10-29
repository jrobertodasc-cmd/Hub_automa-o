# Resumo do Projeto · EXPEDI HUB (BOAH)

**Data de Atualização:** 29 de outubro de 2026  
**Cliente:** BOAH (`10.436.619/0001-05`)  
**Repositório:** `https://github.com/jrobertodasc-cmd/Hub_automa-o`  
**Produção (Render):** `https://expedihub.onrender.com/dashboard.html`  
**Figma Oficial:** `MXOo80UTpyfCmDo6EF9Nr0`  

---

## 1. Ajustes Críticos e Fidelidade ao Figma (1:1 Pixel-Perfect)

### A. Fluxo de Entrada Corrigido (Landing Page)
- **Problema resolvido:** O sistema entrava compulsoriamente na tela de Expedição (`cargas`).
- **Comportamento atual:** O carregamento inicial abre **obrigatoriamente na tela de Início (`hub`)** (`Node 2:9415` - Módulos Operacionais). A tela de expedição só abre quando o operador clica intencionalmente nela.

### B. Módulo Expedição & SEFAZ (`Node 2:10037`)
- **Estação de Bipagem Laser Split:** Divisão exata 68% (leitor óptico hands-free com foco glow azul, cursor pulsante e badge `ENTER`) e 32% (leituras recentes com timestamp e transportadora).
- **Banner de Prioridade Fiscal:** Notificação âmbar destacada de 5 guias GNRE pendentes (R$ 403,36) com botão direto de emissão na SEFAZ.
- **Barra de Sincronização:** Ações para Total Express, Linx Microvix e Remessa Itaú SISPAG.
- **Abas Underline:** Navegação limpa entre `Pendentes & Retidas (5)`, `Prontas para Coleta (0)` e `Todas as Cargas (9)`.
- **Tabela Operacional com Badge e Cores Oficiais:**
  - Headers `#16233A`, linhas `#111B2E`, seleção sólida `#172F54`.
  - Botão de ação direta `Emitir SEFAZ` em azul elétrico `#3B82F6` com texto contrastante `#0B1220`.
  - Barra flutuante de ações em lote inferior (`dock-bulk-bar-figma`).

### C. Módulo E-commerce 360° (`Node 2:9639`)
- **Cabeçalho & Filtros:** Título com badge `VNDA + LINX LIVE`, ações de exportação CSV e sincronização VNDA.
- **Barra de KPIs Superiores (5 cartões):**
  - Faturamento Total (R$ 3.222,60), DIFAL Estimado (R$ 403,36), Vendas Realizadas (9), Peças Faturadas (11), Devoluções & Trocas (0). Tipografia `JetBrains Mono 24px`.
- **Controles Segmentados e Destinos:** Seletores de período e chips de estado (`ND`, `RJ`, `MG`, `AL`, `SP`).
- **Grade 3x2 de Pedidos da BOAH:**
  - Cards com miniaturas de fotos reais da coleção BOAH (`/images/figma_*.png`).
  - Badges de situação fiscal e expedição (`A pagar`, `Não paga`, `Sem DIFAL`).

### D. Performance e Cache
- Cache-busters de scripts e folhas de estilo atualizados para `v=20261029_1045` em [`public/dashboard.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/dashboard.html).

### E. Refinamento de Usabilidade dos Cards (`Node 2:9415`)
- Os 6 cards operacionais agora são **100% clicáveis em toda a sua área**.
- Adicionado efeito de hover com elevação suave (`transform: translateY(-3px)`), borda de destaque azul (`#3B82F6`), sombra aprimorada e animação na seta superior `↗` e no texto de ação.
- Elimina a necessidade de mirar estritamente no pequeno link do rodapé.

### F. Redesign Fashion Atelier do Card E-commerce 360°
- **Remoção de "Acessar":** Substituído o link antigo "Acessar pedidos →" por uma barra editorial refinada com o título `Grade de Pedidos & Faturamento` e status `VNDA · Linx →`.
- **Lookbook Editorial BOAH:** Exibição elegante em galeria de 3 peças reais da coleção BOAH (Vestido Linho, Blazer Alfaiataria e Resort Terracota) com badges minimalistas translúcidos e hover micro-interativo.
- **Identidade Fashion:** Gradiente sutil em tons champanhe/lavanda sobre o navy operacional, badge editorial `BOAH` e métricas integradas em destaque tipográfico.

### G. Padronização Fashion dos Cards Internos e Modal Dossiê 360°
- **Tarja de Metadados Operacionais nos Cards Internos:** Eliminada a colisão de textos entre NF e Pedido. Agora organizado em 4 colunas estéticas: `PEDIDO #` (lavanda), `NF-E`, `ETIQUETA` (azul) e `EMISSÃO`.
- **Botões e Ações:** Eliminado o botão quebrado `[ . ]` com ponto cinza. O card agora é 100% clicável em toda a sua área para abrir o Dossiê 360°, mantendo no rodapé apenas a ação operacional direta (`Emitir SEFAZ` ou `DANFE`).
- **Modal Dossiê Dark Fashion Luxury:** O pop-up que era branco foi 100% convertido para o design dark da BOAH (`#0E1626`), com cards internos `#142037`, tipografia `JetBrains Mono` dourada/verde para valores, código de barras com botão `Copiar` e botões de ação para DANFE e Guia SEFAZ.

### H. Barra de Rolagem Slim Dark e Impressão de Etiqueta Total Express
- **Barra de Rolagem Customizada Ultra-Fina:** Eliminada a barra de rolagem cinza grossa nativa do Windows (16px com setas). Implementada scrollbar slim dark luxury de 5px (`::-webkit-scrollbar` e `scrollbar-width: thin`), trilha transparente e polegar `#243552` com hover em azul `#38BDF8`, harmonizada perfeitamente no pop-up `#modal-pagamento-360` e em toda a aplicação.
- **Botão de Impressão de Etiqueta Total Express:**
  - Adicionado botão dedicado de destaque `Imprimir Etiqueta Total` no rodapé do modal 360°, com ícone de impressora e abertura direta da etiqueta térmica da Total Express via `/api/total-express/etiqueta/:guideId`.
  - Adicionado botão de atalho rápido `Imprimir` ao lado do código de rastreio na caixa de Transportadora do dossiê.
  - Implementada função de suporte `imprimirEtiquetaModalAtual()` no JS com verificação de transportadora (Total Express / Correios).

### I. Simplificação Minimalista do Card de Pedidos
- **Remoção do Botão "Dossiê ↗":** Como o card possui área de clique integral com efeito de hover suave (`cursor: pointer`), o botão explícito "Dossiê ↗" foi retirado do rodapé.
- **Foco Operacional:** O rodapé do card agora exibe de forma limpa apenas o status da GNRE e o botão prioritário `Emitir SEFAZ` (ou `DANFE`), eliminando ruído visual.

### J. Modernização Executiva do Cockpit E-commerce 360° (BOAH Fashion Atelier)
- **Identidade e Nomes Específicos de Moda & Fiscal (Fim dos Nomes Genéricos):**
  - **Cabeçalho:** Subtítulo refinado para *"Conciliação omnichannel em tempo real: catálogo de moda, checkout e liquidação fiscal de DIFAL"*, acompanhado das tags pulsantes `VNDA · LINX OMNICHANNEL` e `BOAH ATELIER`.
  - **Ações:** `Exportar Relatório (.csv)` e `Sincronizar VNDA & Linx` com efeito visual de destaque luminoso.
  - **5 Cards de Indicadores (KPIs Executivos):**
    1. *Faturamento* ➔ `FATURAMENTO BRUTO · GMV` [VNDA LIVE] com friso superior azul elétrico.
    2. *Total DIFAL* ➔ `PARTILHA FISCAL · DIFAL` [SEFAZ] com friso superior âmbar/ouro.
    3. *Pedidos faturados* ➔ `PEDIDOS CONCILIADOS` [EXPEDIÇÃO] com friso superior lavanda.
    4. *Peças vendidas* ➔ `VOLUME DE PEÇAS` [ATELIER] com friso superior esmeralda.
    5. *Radar de devoluções* ➔ `LOGÍSTICA REVERSA · SAC` [100% REGULAR] com friso superior ciano.
  - **Filtros e Controles Segmentados:**
    - Períodos: `Mês Vigente (Out/26)`, `Coleção Set/26`, `Arquivo Geral`.
    - Situação DIFAL: `Visão Global`, `• Liquidadas`, `• A Pagar`, `• Pendências Fiscais`, `• Isentas / Sem DIFAL` com contadores em pílulas dinâmicas.
    - Busca moderna com atalho `⌘K` e placeholder de busca especializado em moda/fiscal.
    - Agrupamento visual: `Por Pedido` e `Por Cliente` com ícones vetoriais.
  - **Integridade da Marca:** Logo `expedi HUB` e marca principal estritamente preservadas sem alterações.
- **Cache-Buster:** Atualizado para `v=20261029_1130` em scripts e folhas de estilo.

### K. Correção do Handler de Impressão de Etiqueta (`ReferenceError: imprimirEtiquetaModalAtual`)
- **Problema diagnosticado:** O botão de impressão de etiqueta chamava `imprimirEtiquetaModalAtual()`, porém a declaração da função não havia sido registrada no escopo global de `dashboard.js`.
- **Solução implementada:** Definida e exportada formalmente a função `imprimirEtiquetaModalAtual` em `window.imprimirEtiquetaModalAtual`:
  - Recupera a guia ativa do dossiê (`window.guiaDossieModalAtiva`).
  - Detecta a transportadora (Total Express vs Correios).
  - Emite notificação toast ao operador e aciona `window.open` diretamente para o endpoint `/api/total-express/etiqueta/:guideId`.
  - Testado via Playwright com 0 erros no console (`PAGE_ERRORS: []`).
- **Cache-Buster:** Atualizado para `v=20261029_1140`.

### L. Desobstrução da Topbar & Navegação por Cartões com Atalhos Inteligentes
- **Eliminação de Botões Redundantes no Cabeçalho:**
  - Removidos da barra superior os 4 botões de módulos (`Expedição & SEFAZ 5`, `E-commerce 360°`, `Remessa Itaú`, `Relatórios`).
  - A barra superior agora mantém apenas a identidade visual limpa: Logo `expedi HUB` + Empresa `BOAH ⌄` + Botão minimalista `Início · Módulos` à esquerda, e `Conexão Fiscal Online` + Perfil do Operador à direita.
- **Atalhos Operacionais Cruzados Diretamente nos Cartões da Tela Inicial:**
  - **No Cartão E-commerce 360°:** Inserido atalho direto `Expedição (5) ↗` no rodapé.
  - **No Cartão Expedição Operacional:** Inserido atalho direto `Remessa Itaú ↗` no rodapé.
  - **No Cartão Tesouraria Itaú:** Inserido atalho direto `Relatórios ↗` no rodapé.
  - Todos os cartões continuam 100% clicáveis em sua área integral, com suporte à propagação controlada nos botões de atalho (`event.stopPropagation()`).
- **Cache-Buster:** Atualizado para `v=20261029_1150`.

### M. Tratamento e Humanização de Destinos "ND / ND" (Não Definido)
- **Origem e Significado:** No banco de dados, `ND` representa **"Não Definido / Não Disponível"**. Ocorre em notas fiscais emitidas para Consumidor Final (venda presencial de balcão) ou cadastradas sem o XML da NF-e vinculado (sem as tags `<dest><enderDest><xMun>` e `<UF>`).
- **Tratamento no Front-end:** Em vez de exibir a sigla técnica crua `ND / ND`, o sistema agora formata elegantemente como:
  - No Dossiê/Pop-up: `"Não informado (Consumidor Final)"` quando cidade e UF estiverem ausentes.
  - Nos Cards de Pedido: `"Destino não informado"`.
  - Se apenas a UF for conhecida, exibe a UF limpa sem duplicidade.
- **Cache-Buster:** Atualizado para `v=20261029_1200`.

---

## 2. Status do Deploy

- Arquivos versionados:
  - `public/css/expedi-theme-clean.css`
  - `public/dashboard.html`
  - `public/js/dashboard.js`
  - `resumo.md`

---

## Seção 39: Evolução Estratégica do Cockpit: BI 360°, Heatmap por UF, Central de Relatórios 2.0 e Modal de Remessa CNAB 240

### 1. Contexto e Motivação
- A aba de "Liquidação Bancária do Lote" ocupava desnecessariamente uma tela inteira e se repetia no Hub principal.
- Com a futura integração direta via API do Asaas para pagamentos via Pix e débito direto sem arquivos manuais, a geração e o retorno de remessa CNAB 240 (Itaú SISPAG) foram transformados em um **Modal de Ação Rápida** (`#modal-remessa-bancaria`).
- O espaço analítico foi completamente reestruturado para hospedar o **Cockpit Executivo & BI 360°**, com dados e gráficos interativos reais em Chart.js e um **Mapa de Calor Interestadual (Heatmap por UF)**.
- A **Central de Relatórios** foi evoluída para uma suíte de controladoria com 3 abas operacionais (DIFAL nota a nota, Romaneios/Manifestos A4 e Fechamento Contábil).

### 2. Principais Implementações

#### A. Modal Operacional de Remessa Bancária Itaú SISPAG (CNAB 240)
- **Localização:** Modal de ação rápida flutuante acessível via 1 clique no Card 5 do Hub e no atalho do Card de Expedição.
- **Funcionalidades:**
  - Resumo imediato do lote ativo (91 guias auditadas, total R$ 4.020,42, agência 0334 conta 98775-7 LALUA).
  - Seletor de data de pagamento/vencimento das guias.
  - Download imediato da remessa `.TXT` para o SISPAG.
  - Dropzone de conciliação do arquivo de Retorno `.RET` com baixa instantânea na doca.
  - Preparado para chaveamento com a API do Asaas.

#### B. Cockpit Executivo & BI 360° (`secao-view-dashboard`)
- **KPIs em Tempo Real:** Faturamento bruto estimado, total acumulado de DIFAL, índice de liberação de cargas e SLA médio da doca (2h 18min).
- **Curva Financeira (Chart.js):** Gráfico misto de barras (vendas brutas) e linha (curva de DIFAL) por data de emissão com eixos duplos.
- **Divisão de Transportadoras (Chart.js):** Gráfico tipo rosca (*doughnut*) com proporção de volumes e índice de entrega entre Total Express e Correios.
- **Mapa de Calor Geográfico por UF (Heatmap Brasil):**
  - Cards térmicos graduados com gradientes de calor (vermelho, âmbar e azul) conforme concentração de faturamento e DIFAL (RJ, MG, AL, SP, etc.).
  - Tabela analítica completa com ranking estadual, percentual de cargas liberadas e carga tributária efetiva.
- **Funil de Throughput da Doca:** Acompanhamento das 5 etapas operacionais: Venda VNDA -> NF-e Linx -> DIFAL -> Remessa Itaú -> Expedição Física.

#### C. Central de Relatórios 2.0 (`secao-view-relatorios`)
- **Tab 1 - Analítico de DIFAL (Nota a Nota):**
  - Tabela completa nota a nota com Nº da NF-e, série, data de emissão, nome do cliente, UF destino, transportadora, valor da venda e valor do DIFAL.
  - Filtros dinâmicos por UF e busca textual por número, chave ou cliente.
  - Exportação direta em Excel (`.CSV`) estruturado para controladoria.
- **Tab 2 - Manifestos & Romaneios Rodoviários (A4):**
  - Emissão de romaneio de carga para conferência e assinatura do motorista (Total Express e Correios).
- **Tab 3 - Fechamento Contábil Mensal:**
  - Download consolidado de pacote ZIP com XMLs da SEFAZ SP e guias eletrônicas para envio à contabilidade.
  - Extrato de conciliação bancária do Itaú SISPAG em CSV.

#### D. Endpoints no Backend (`server.js`)
- `GET /api/bi/metrics`: Agregação de faturamento, curvas de DIFAL, timeline e heatmap por UF a partir da tabela `guides`.
- `GET /api/relatorios/analitico-difal`: Consulta paginada/filtrada por UF e período para a tabela do relatório.

---

---

## Seção 40: Trava Operacional de Segurança: API da Total Express Temporariamente Pausada

### 1. Motivação Operacional
- Durante os testes de geração de etiquetas e despacho, o conector da Total Express (`/v1/coleta/smartlabel/registrar`) registrou pedidos em ambiente de produção, acionando a visita física de vans de coleta da Total Express na loja/CD.
- A pedido do operador, a integração direta com a API da Total Express foi **temporariamente suspensa** para evitar qualquer chamada externa até o alinhamento com a equipe de e-commerce na próxima semana.

### 2. Medidas de Bloqueio Implementadas
1. **Trava no Conector (`services/total_express_service.js`):**
   - Criada flag mestre `TOTAL_EXPRESS_API_ENABLED = process.env.TOTAL_EXPRESS_ENABLED === 'true'` (padrão: `false`).
   - Interceptação de `registrarEncomendaSmartLabel`: qualquer tentativa de envio é bloqueada internamente com aviso no log do servidor e retorna simulação segura (`awb: SIM_...`, sem requisições HTTPS para a Total Express).
   - Interceptação de `consultarStatusEntrega`: tracking externo desativado.
2. **Guarda nas Rotas do Servidor (`server.js`):**
   - `/api/total-express/despachar/:guideId`: intercepta e retorna status de modo simulado/pausado.
   - `/api/total-express/sync-tracking-batch`: cancela o envio em lote sem chamadas de rede.
   - `/api/total-express/tracking`: retorna lista vazia segura.
3. **Desativação do Polling no Front-end (`public/js/dashboard.js`):**
   - Interrompido o intervalo de 45 segundos (`_intervaloFullTimeTotal`) e a rotina `sincronizarRastreioTotalDoca()`.
4. **Procedimento para Reativação (Próxima Semana):**
   - Bastará configurar a variável de ambiente `TOTAL_EXPRESS_ENABLED=true` no painel da Render ou no arquivo `.env`.
