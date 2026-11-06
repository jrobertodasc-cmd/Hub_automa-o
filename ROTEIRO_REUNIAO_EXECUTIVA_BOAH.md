# 🎯 ROTEIRO EXECUTIVO DE APRESENTAÇÃO: expedi HUB para a BOAH
**Público-alvo:** Coordenadora de E-Commerce & Diretoria de Operações da BOAH  
**Duração Estimada:** 15 a 20 minutos  
**Objetivo da Reunião:** Validar o piloto operacional do expedi HUB na BOAH como cliente âncora, demonstrando como a plataforma resolve o gargalo de retenção de mercadorias na SEFAZ, automatiza a conciliação bancária de guias e acelera a expedição dos pedidos da loja virtual (VNDA/Linx).

---

## 🕒 CRONOGRAMA DA APRESENTAÇÃO (15 MINUTOS)

| Minuto | Etapa | Foco da Conversa |
| :---: | :--- | :--- |
| **00 - 03** | **1. Abertura & Alinhamento de Dores** | O custo oculto do DIFAL retido e a fricção operacional na doca. |
| **03 - 08** | **2. Demonstração Prática (Dados Reais da BOAH)** | Cockpit Executivo com os 43 pedidos reais, GMV e ranking de vendas. |
| **08 - 12** | **3. O Fluxo de Expedição em 1 Clique** | VNDA ➔ GNRE ➔ Pagamento Asaas ➔ Bipagem ➔ Total Express. |
| **12 - 15** | **4. Segurança, LGPD & Próximos Passos** | Certificado Digital A1 seguro, SLA 99.5% e início do piloto sem risco. |

---

## 🎙️ GUIA DE FALA PASSO A PASSO

### FASE 1: ABERTURA (Minutos 0 a 3) — O Problema que Dói no Dia a Dia

> *"Olá [Nome da Coordenadora], obrigado pelo tempo. Sei que sua prioridade número um é colocar os pedidos na rua o mais rápido possível e garantir que as clientes da BOAH recebam suas peças no prazo prometido.*
>
> *Hoje, todo e-commerce de moda com faturamento relevante no Brasil enfrenta o mesmo pesadelo fiscal e logístico:*
> 1. *Emitir guias de DIFAL (GNRE/DARE) estado por estado manualmente no site do governo consome horas preciosas da equipe.*
> 2. *Se uma guia atrasa ou não é paga no mesmo dia, o caminhão da transportadora (Total Express) não pode carregar, ou a mercadoria fica retida no posto fiscal de fronteira.*
> 3. *A diretoria e o financeiro não têm visibilidade em tempo real de quanto foi pago de imposto interestadual para cada transportadora.*
>
> *Criamos o **expedi HUB** exatamente para eliminar esse atrito: conectar a loja VNDA, o ERP Linx Microvix e a Total Express em um fluxo 100% automatizado, onde o DIFAL é apurado, liquidado e liberado para embarque em menos de 3 minutos."*

---

### FASE 2: DEMONSTRAÇÃO PRÁTICA (Minutos 3 a 8) — Dados Reais da BOAH na Tela

*(Abra o Dashboard do expedi HUB na tela logado como BOAH)*

> *"Para você ver o poder do sistema, não trouxemos slides nem dados fictícios. Esta tela já está conectada à API oficial da BOAH na VNDA e ao Linx Microvix:*
>
> * **1. Painel 360° em Tempo Real:**
>   * *Aqui você visualiza os **43 pedidos reais** recebidos recentemente, totalizando o GMV consolidado do período.*
>   * *O sistema separa automaticamente a taxa de cancelamento e de aprovação, calculando a margem de contribuição líquida (descontando CMV estimado, DIFAL interestadual e taxas de gateway).*
>
> * **2. Inteligência Comercial de Vendedoras (Social Selling):**
>   * *Olhe este gráfico: o expedi HUB reconhece os cupons de consultoras (como o da **Passy**, que lidera as vendas com ticket médio expressivo) e separa dos cupons institucionais da marca e da sócia (**Mila**).*
>   * *Sua equipe comercial não precisa mais perder horas no final do mês calculando comissões no Excel.*
>
> * **3. Heatmap Interestadual:**
>   * *Aqui vemos a distribuição geográfica dos despachos: São Paulo, Rio de Janeiro e Minas Gerais lideram as saídas, permitindo planejar a logística com a Total Express antecipadamente."*

---

### FASE 3: O FLUXO EM 1 CLIQUE NA DOCA (Minutos 8 a 12) — O "Momento Uau"

*(Demonstre o fluxo operacional no menu "Doca de Expedição")*

> *"Agora imagine o dia a dia do seu operador na expedição:*
>
> 1. *Quando a nota sai do faturamento, o expedi HUB já pré-valida a NF-e e identifica se precisa de GNRE (para estados com DIFAL) ou DARE-SP.*
> 2. *Com **um único clique** em 'Autorizar Emissão', o sistema transmite o lote à SEFAZ de todos os estados simultaneamente.*
> 3. *Em vez de digitar código de barras por código de barras no Internet Banking, a plataforma se conecta à conta Asaas e liquida o lote inteiro com conciliação automática e autenticação bancária instantânea.*
> 4. *O operador bipar o pacote com o leitor de código de barras: a tela acende em verde instantaneamente — **'LIBERADA PARA EMBARQUE'**.*
> 5. *A etiqueta térmica 10x15cm da Total Express é gerada com a rota exata (ex: `BHZ-L-MG`) e o Romaneio de Coleta sai pronto em PDF para o motorista assinar.*
>
> *O resultado prático: zero pedidos parados na doca por pendência de imposto e redução de até 80% do tempo de despacho."*

---

### FASE 4: SEGURANÇA, LGPD & PROPOSTA DO PILOTO (Minutos 12 a 15)

> *"Como lidamos com notas fiscais e dados de clientes da marca, a conformidade é prioridade absoluta:*
>
> * **Segurança de Nível Bancário:** O Certificado Digital A1 da BOAH fica guardado em cofre criptografado com chave mestra AES-256-GCM. Ninguém tem acesso físico ao arquivo.
> * **Conformidade LGPD:** O expedi HUB atua estritamente como Operador de dados conforme a Lei 13.709/2018, com Termos de Uso e DPA (Data Processing Agreement) assinados eletronicamente.
> * **SLA de 99.5%:** Infraestrutura cloud escalável no Render com banco PostgreSQL Supabase de alta disponibilidade.
>
> ### 🎁 Nossa Proposta para a BOAH:
> *Queremos que a BOAH seja nosso **cliente âncora e parceiro estratégico**.*
> * *Oferecemos **30 dias de piloto gratuito com franquia liberada**.*
> * *Acompanharemos a expedição de perto nos primeiros 5 dias com suporte direto no WhatsApp para garantir que a equipe se adapte sem nenhum atrito.*
> * *Ao final dos 30 dias, se o ganho de velocidade e a redução de erros forem comprovados, formalizamos o plano Pro SaaS com condições especiais de pioneirismo.*
>
> *Podemos ativar o piloto para começar a rodar já nesta próxima semana?"*

---

## ❓ FAQ & RESPOSTAS PARA POSSÍVEIS OBJEÇÕES

| Objeção da Coordenadora | Como Responder com Segurança |
| :--- | :--- |
| **"E se a SEFAZ de algum estado estiver fora do ar ou lenta?"** | *"O expedi HUB possui monitor de contingência com reprocessamento assíncrono em fila (BullMQ). Se a SEFAZ do RJ ou RS oscilar, o sistema reenvia automaticamente a cada 5 segundos sem travar a tela do operador."* |
| **"E as notas de São Paulo, que exigem DARE-SP?"** | *"Para SP, o sistema gera o XML no layout específico do portal da Fazenda de SP para importação em lote e já possui o conversor automático de arquivos .ZIP de DAREs, que vincula os códigos de barra às notas em 1 segundo."* |
| **"Minha equipe vai precisar de muito treinamento?"** | *"Não. O sistema foi desenhado para ser intuitivo. Se a pessoa sabe ler um código de barras com a pistola leitora, ela já sabe operar a doca do expedi HUB. Disponibilizamos também um Wizard de primeiros passos em 4 etapas."* |
| **"Preciso envolver o time de TI da BOAH para instalar algo?"** | *"Zero instalação. O sistema é 100% web (SaaS na nuvem). Funciona em qualquer navegador de computador, tablet ou celular conectado à internet."* |
