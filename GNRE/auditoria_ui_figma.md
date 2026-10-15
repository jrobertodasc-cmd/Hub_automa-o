# Auditoria UI/UX — Figma "expedi HUB" vs. implementação

O arquivo Figma tem **4 telas** (lidas via API REST do Figma com o seu token):

| Frame | ID | Implementado? |
|---|---|---|
| Hub logístico e fiscal (dashboard) | `2:1714` | Parcial, com divergências graves |
| Login — expedi HUB | `12:53` | **Não.** `login.html` continua no layout antigo |
| Cadastro — expedi HUB | `14:127` | **Não.** `register.html` continua no layout antigo |
| Planos — expedi HUB | `14:226` | **Não.** `plans.html` continua no layout antigo |

> [!IMPORTANT]
> A mensagem anterior falava em "100% de paridade visual e funcional". Isso não procede: só o dashboard foi trabalhado, e mesmo ele não bate com o Figma.

---

## 1. Problemas sistêmicos (afetam todas as telas)

| # | Problema | Figma | Implementado |
|---|---|---|---|
| S1 | **Tema** | Claro: fundo `#F5F7FA`, cards brancos, texto `#182536`. Só a sidebar/painel lateral é navy `#111F33` | Tudo escuro (fundo quase preto, cards navy) |
| S2 | **Marca** | Logo **"expedi"** + selo "HUB" | "Apex HUB" / "Apex GNRE SaaS" |
| S3 | **Tipografia** | Inter (pesos 400/500/600/700, títulos 400 em 27–29px) | Outfit, com títulos em negrito pesado |
| S4 | **Cor primária** | Azul `#2563EB` | Login/cadastro/planos usam gradiente roxo/índigo |

## 2. Dashboard (`2:1714`)

````carousel
![Figma — referência](C:/Users/Roberto/.gemini/antigravity-ide/brain/da072807-59b8-4f5b-bd2a-9aa3617e2903/figma_dashboard.png)
<!-- slide -->
![Implementado](C:/Users/Roberto/.gemini/antigravity-ide/brain/da072807-59b8-4f5b-bd2a-9aa3617e2903/dashboard_overview_1792008517210.png)
````

**Alta severidade**
- **D1. Dados inventados na tabela** ([dashboard.js](file:///c:/Users/Roberto/Desktop/Web_Services/public/js/dashboard.js)): a coluna "Total" é calculada como `DIFAL × 5,8 + 49,9`; o "Canal" vem da transportadora (Correios → "Mercado Livre"); a cidade vem de um mapa fixo (UF → capital); "Pagamento aprovado" e "Consumidor final" estão fixos no código. Num sistema fiscal isso é perigoso: o operador lê valores que parecem reais e não são.
- **D2. KPIs, abas e paginação começam com valores fixos** (248 / 186 / 224 / R$ 2.846,32 / "1 2 3 … 42"), mesmo com a tabela vazia ("Nenhum lote enviado ainda").
- **D3. Banner de alerta**: no Figma é uma faixa âmbar clara de uma linha com o link "Revisar pendências →". Na implementação virou "Autorizar Emissão na SEFAZ" + "Descartar", e o texto "8 divergências / 4 rejeições" é fixo e aparece mesmo sem lote.
- **D4. Barra de ações extra** (Imprimir intercaladas, Romaneio, Banco, CNAB, .RET, ZIP) fica entre os filtros e a tabela. Ela não existe no Figma e polui a hierarquia. Além disso, "Mais filtros" só mostra/esconde essa barra, ou seja, não abre filtro nenhum.

**Média severidade**
- **D5.** Badges NF-e: no Figma são pills com fundo (`#EAF7F0`/`#FDEEEE`); aqui é só ponto + texto. Expedição: "Pronto para envio" é azul no Figma (`#EDF3FF`), aqui está verde.
- **D6.** Ações da linha: no Figma é um menu `⋯`; aqui são 3 ícones emoji (📄🧾📥).
- **D7.** O status do topo mostra "Vnda: Internal Server Error" em verde. Erro exibido com cor de sucesso.
- **D8.** A sidebar não acompanha a página: o fundo para em ~900px de altura (dá para ver a emenda no screenshot).
- **D9.** Faltam no Figma, mas não aqui: ícones nos KPIs, botões "Integrações"/"Configurações" isolados, card "Ambiente demonstrativo" na sidebar. Sobram aqui, sem existir no Figma: "Administração", "Sair", "Relatórios & BI", a seção de ingestão e o histórico.

## 3. Login (`12:53`)

````carousel
![Figma — Login](C:/Users/Roberto/.gemini/antigravity-ide/brain/da072807-59b8-4f5b-bd2a-9aa3617e2903/figma_login.png)
<!-- slide -->
![Implementado — Login](C:/Users/Roberto/.gemini/antigravity-ide/brain/da072807-59b8-4f5b-bd2a-9aa3617e2903/login_page_1792005636597.png)
````

Faltam: layout em 2 colunas (painel navy de 540px com headline + 3 benefícios), eyebrow "ACESSE SEU HUB", "Mostrar" senha, "Lembrar acesso", "Esqueci minha senha", "Central de ajuda", rodapé (© / Privacidade / Termos).
**Decisão de produto:** o Figma diz *"Primeiro acesso? Solicite um convite ao administrador"*, ou seja, sem link de autocadastro. Hoje o login tem "Cadastre sua empresa".

## 4. Cadastro (`14:127`)

````carousel
![Figma — Cadastro](C:/Users/Roberto/.gemini/antigravity-ide/brain/da072807-59b8-4f5b-bd2a-9aa3617e2903/figma_cadastro.png)
<!-- slide -->
![Implementado — Cadastro](C:/Users/Roberto/.gemini/antigravity-ide/brain/da072807-59b8-4f5b-bd2a-9aa3617e2903/register_scrolled_1792005476476.png)
````

Faltam: o mesmo painel lateral, os campos Empresa e CNPJ lado a lado (com máscara `00.000.000/0000-00`), **Confirmar senha**, regra "mín. 8 caracteres, letras e números", checkbox de **Termos/Privacidade**.
Sobra: o seletor "Plano de assinatura" dentro do formulário. No Figma, o plano é escolhido na tela de Planos.

## 5. Planos (`14:226`)

![Figma — Planos](C:/Users/Roberto/.gemini/antigravity-ide/brain/da072807-59b8-4f5b-bd2a-9aa3617e2903/figma_planos.png)

O `plans.html` atual é escuro, tem uma faixa diagonal roxa "RECOMENDADO" e outros planos/preços. O Figma pede: header navy com "Planos / Já tem uma conta? / Entrar", alternador **Mensal | Anual (Economize 15%)**, 3 cards **Essencial R$149 / Profissional R$399 (recomendado, faixa azul no topo) / Escala R$899**, 7 itens por card, nota de rodapé, seção de FAQ com 3 colunas e rodapé.

---

## 6. Efeitos colaterais da sessão anterior (atenção)

> [!WARNING]
> **Conta de teste criada no Supabase real.** Na verificação, o agente de browser preencheu e enviou o formulário de cadastro com `marina@aurorastore.com.br` / CNPJ `45.987.123/0001-99` / "Aurora Store LTDA". O dashboard agora mostra esse tenant. **Ele precisa ser removido.** Não apaguei nada sem a sua autorização.

> [!NOTE]
> O token do Figma ficou no `.env`, que está no `.gitignore` (não vai para o GitHub). Mesmo assim, como ele foi colado no chat, recomendo revogá-lo no Figma quando terminarmos.

---

## 7. Plano de correção proposto

1. **Design tokens claros** no `style.css`: variáveis `--bg #F5F7FA`, `--surface #FFF`, `--navy #111F33`, `--primary #2563EB`, Inter, e marca "expedi HUB".
2. **Login** e **Cadastro** refeitos com um painel lateral compartilhado, mantendo a lógica atual de `auth.js` (Supabase) e adicionando confirmação de senha, termos e máscara de CNPJ.
3. **Planos** refeito com o alternador Mensal/Anual e o FAQ.
4. **Dashboard** em tema claro. Remover os dados fabricados: mostrar "—" quando o dado não existir, KPIs/abas/paginação vindos do lote real, menu `⋯` com Guia / DANFE / XML / CNAB, e a barra de doca movida para dentro do menu "Ações do lote".
5. Verificação visual tela a tela contra os PNGs do Figma, **sem enviar formulários reais**.
