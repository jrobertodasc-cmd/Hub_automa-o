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
- Cache-busters de scripts e folhas de estilo atualizados para `v=20261029_1000` em [`public/dashboard.html`](file:///c:/Users/Roberto/Desktop/Web_Services/public/dashboard.html).

---

## 2. Status do Deploy

- Arquivos versionados:
  - `public/css/expedi-theme-clean.css`
  - `public/dashboard.html`
  - `public/js/dashboard.js`
  - `resumo.md`
