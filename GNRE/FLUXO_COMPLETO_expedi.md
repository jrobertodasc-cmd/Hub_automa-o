# expedi HUB — Especificação do fluxo "Portão fiscal de DIFAL"

Versão 1.0 — 15/10/2026. Documento para guiar a implementação por agentes de IA e pessoas.
Status: desenho aprovado em conversa, **nada aqui foi implementado ainda** além das telas estáticas (login, cadastro, planos, dashboard, landing).

---

## 0. Regras para quem for implementar (leia primeiro)

1. **Nunca inventar dado.** Valor, status, contagem ou nome que não vier do backend aparece como "—". Nada de números fixos, cálculos "de enfeite" ou textos de exemplo no código de produção.
2. **Nunca enviar formulário nem criar registro no Supabase de produção para testar.** Usar um projeto de desenvolvimento separado. (Já houve um tenant de teste criado em produção por engano.)
3. **Dinheiro é sempre idempotente.** Nenhum pagamento é enviado duas vezes por causa de retry, clique duplo ou reprocessamento. Ver seção 10.
4. **Não guardar nem imprimir segredos** (chave do Asaas, certificado A1, senha do certificado, token do Figma) em log, chat, commit ou front-end.
5. **Itens marcados "A CONFIRMAR" não foram verificados.** Não assumir que funcionam; testar antes e registrar o resultado.
6. Em caso de dúvida de regra fiscal, **parar e perguntar**. O responsável não é contador; a regra final é validada pela contabilidade da empresa.

---

## 1. Objetivo e princípio central

Eliminar o gargalo do DIFAL no e-commerce B2C. O problema real, vivido na operação, não é "gerar guia": é a **mercadoria sair sem a guia paga e o comprovante e ser barrada no posto fiscal**.

**Princípio:** a NF-e só é liberada para coleta quando a guia estiver **paga e comprovada** (ou quando não houver guia devida). Quem prepara o pagamento não é quem o autoriza. A expedição nunca espera o dia fechar: libera nota a nota.

---

## 2. Contexto operacional (cliente piloto)

- Empresa piloto: loja de moda, e-commerce operado em outro bairro, dentro de uma loja física.
- Sistemas: ERP Linx Microvix, Olist (captura de vendas), Vnda (loja), Pagar.me (gateway). NF-e emitida pelo Link. O hub já integra via API B2C do Link e com o Olist. Integração com Asaas é nova.
- Problema atual: DIFAL era paga **semanalmente**; a transportadora levava a carga sem guia; o posto fiscal barrava; a Total Express emitia e pagava a guia na hora, a empresa reembolsava, **e a empresa pagava a mesma DIFAL de novo** (pagamento duplicado).
- Transportadoras no piloto: Correios e Total Express.
- Bancos: conta da empresa no Itaú (fluxo normal de despesas e receitas, burocrática). **Asaas será conta exclusiva para o DIFAL.** O Itaú só abastece o saldo do Asaas.

---

## 3. Atores e permissões

| Ator | Quem | Pode | Não pode |
|---|---|---|---|
| Financeiro (contas a pagar) | Prepara pagamentos | Ver todas as guias, montar e enviar o lote do dia, resolver divergências, importar/ver extrato, pedir abastecimento, exportar fechamento | Aprovar o próprio lote, editar valor de guia já conferida sem justificativa |
| Expedição (time online) | Monta a coleta | Ver status por nota, gerar e imprimir o combo da transportadora, registrar coleta | Pagar, aprovar, editar guia |
| Dona (aprovadora) | Autoriza | Aprovar/reprovar lote, definir alçada, pausar todos os pagamentos | Editar guia ou lote |
| Admin técnico | Configura | Integrações, certificados, usuários, políticas | Aprovar pagamento (a menos que também seja a dona, com registro) |

Regra de segregação: **o usuário que cria/edita o lote não pode ser o mesmo que aprova.** O sistema deve bloquear isso.

---

## 4. Glossário

- **Guia:** documento de arrecadação (GNRE, DUA-e do ES ou lote XML de SP) vinculado a uma NF-e.
- **Conferência:** validação automática da guia antes de qualquer pessoa.
- **Alçada:** limites que a dona define para aprovação automática por regra.
- **Lote de pagamento:** conjunto de guias do dia enviadas para aprovação.
- **Combo:** pacote entregue à transportadora = romaneio + guias + comprovantes, por transportadora.
- **Conciliação:** cruzamento NF-e × guia × pagamento × extrato.
- **Portão fiscal:** regra que impede nota sem guia paga de entrar no combo.

---

## 5. Máquina de estados da guia

Uma guia por (chave da NF-e + tipo de guia). Tipos possíveis: DIFAL, FCP (se a UF exigir guia separada — A CONFIRMAR por UF).

| Estado | Significado | Próximos estados |
|---|---|---|
| `CALCULADA` | Valor apurado a partir do XML | `EMITIDA`, `REJEITADA_SEFAZ`, `SEM_GUIA` |
| `SEM_GUIA` | Operação sem guia devida (ex.: intraestadual SP) | final (nota liberável) |
| `EMITIDA` | Guia gerada no órgão, com linha digitável e PDF | `EM_CONFERENCIA` |
| `REJEITADA_SEFAZ` | Órgão recusou; motivo gravado | `CALCULADA` (após correção) |
| `EM_CONFERENCIA` | Rodando as regras da seção 8 | `CONFERIDA`, `DIVERGENTE` |
| `DIVERGENTE` | Falhou em alguma regra | `CONFERIDA` (após revisão do financeiro), `CANCELADA` |
| `CONFERIDA` | Pronta para entrar em lote | `NO_LOTE` |
| `NO_LOTE` | Incluída no lote do dia | `AGUARDANDO_APROVACAO` |
| `AGUARDANDO_APROVACAO` | Lote enviado à dona (ou dentro da alçada) | `APROVADA`, `REPROVADA` |
| `REPROVADA` | Dona recusou | `DIVERGENTE` ou `CANCELADA` |
| `APROVADA` | Autorizada para pagamento | `PAGAMENTO_ENVIADO` |
| `PAGAMENTO_ENVIADO` | Enviada ao Asaas, aguardando confirmação | `PAGA`, `FALHA_PAGAMENTO` |
| `FALHA_PAGAMENTO` | Recusada/erro; **não repetir sem consultar status** | `APROVADA` (nova tentativa manual), `DIVERGENTE` |
| `PAGA` | Asaas confirmou pagamento | `COMPROVADA` |
| `PAGA_POR_TERCEIRO` | Transportadora ou outro já pagou | `COMPROVADA` (com anexo) e entra em lista de reembolso |
| `COMPROVADA` | Comprovante baixado e vinculado | final (nota liberável) |
| `CANCELADA` | Cancelada (NF-e cancelada, duplicada, etc.) | final |

Toda transição grava evento (quem, quando, de qual estado para qual, motivo).

---

## 6. Regra de liberação da nota (o portão)

Uma NF-e está **LIBERADA_PARA_COLETA** se, e somente se:
- NF-e `autorizada` e não cancelada; **e**
- todas as suas guias estão em `COMPROVADA` **ou** `SEM_GUIA`.

Qualquer outra situação = `BLOQUEADO_FISCAL`, com o motivo exibido ("guia aguardando aprovação", "pagamento em processamento", "divergência de valor"...).

A liberação é **por nota, em tempo real**. A expedição gera o combo a qualquer hora com o que já está liberado. Uma guia atrasada nunca trava as outras notas.

---

## 7. Fluxo ponta a ponta

### E1 — Entrada da NF-e
- **Origem:** API B2C do Link (principal), upload de XML (alternativa).
- **Regras:** validar XML (schema, chave de 44 dígitos, status autorizada), ignorar duplicata pela chave, extrair destinatário, UF, valores, itens, indicador de consumidor final e contribuinte.
- **Saída:** registro de NF-e. Dados de pessoa física (CPF) armazenados mascarados na interface.
- **Falhas:** XML inválido, NF-e cancelada, chave repetida → fila de pendências com motivo.

### E2 — Cálculo do DIFAL
- **Regras:** alíquota interna da UF de destino, interestadual, base simples ou dupla conforme UF, FCP, particularidades por UF/produto. Tabela de regras por UF **versionada e com data de vigência**.
- **Saída:** guia em `CALCULADA` com memória de cálculo guardada.
- **Falhas:** UF/produto sem regra → `DIVERGENTE` com motivo, nunca "chutar".

### E3 — Emissão da guia
- **Canais:** DUA-e (ES), Portal GNRE (demais UFs integradas), lote XML (SP, importação manual no Posto Fiscal).
- **Saída:** `EMITIDA` com linha digitável, código de barras, vencimento, PDF oficial armazenado.
- **Falhas:** rejeição do órgão → `REJEITADA_SEFAZ` com código e mensagem. **Não alterar data/competência automaticamente.** Qualquer ajuste é manual, com aviso e registro (decisão com a contabilidade).

### E4 — Conferência automática
Ver seção 8. Resultado: `CONFERIDA` ou `DIVERGENTE`.

### E5 — Montagem do lote (financeiro)
- O hub **monta o lote sozinho** com as guias `CONFERIDA` do dia, agrupado por UF, com total e quantidade.
- O financeiro revisa, pode retirar guias (com motivo) e **envia para aprovação**.
- Guias conferidas depois do corte entram no lote do dia seguinte e isso fica visível na nota.

### E6 — Alçada e aprovação
Ver seção 9.

### E7 — Pagamento
Ver seção 10. Só ocorre após `APROVADA`.

### E8 — Confirmação e comprovante
- Webhook do Asaas confirma → `PAGA`.
- Hub baixa/gera o comprovante e vincula à guia e à NF-e → `COMPROVADA`.
- Se a confirmação não chegar no prazo, **consultar o status por API** antes de qualquer ação.

### E9 — Liberação e combo
Ver seções 6 e 12.

### E10 — Conciliação e fechamento
Ver seção 11.

---

## 8. Conferência automática (checklist)

Todas devem passar. Qualquer falha → `DIVERGENTE` com o motivo exato.

1. Valor da guia = DIFAL calculado do XML (tolerância: zero ou centavos, parâmetro configurável).
2. UF do favorecido e código de receita corretos para a UF.
3. Vencimento e competência coerentes; guia não vencida.
4. NF-e autorizada e **não cancelada** no momento da conferência (reconsultar).
5. Não existe outra guia ou pagamento para a mesma chave de NF-e e tipo (inclusive `PAGA_POR_TERCEIRO`).
6. Operação não é intraestadual sem DIFAL (SP → SP vira `SEM_GUIA`).
7. Linha digitável válida (dígitos verificadores) e coerente com o valor.
8. Destinatário é consumidor final e dados mínimos presentes.
9. Valor individual não é anomalia estatística (ex.: muito acima da mediana da UF) → marcar para revisão, não bloquear.

---

## 9. Alçada e aprovação

**Princípio:** a dona define regras uma vez; o hub aplica. Aprovar guia por guia vira rotina cega e gargalo.

### Parâmetros (configurados pela dona, valores dela)
- `valor_max_por_guia`
- `valor_max_total_dia`
- UFs permitidas para aprovação automática
- Exigir aprovação manual sempre acima do limite, para UF nova, para guia com alerta de anomalia, ou para primeira guia de uma NF-e re-emitida.

### Fluxo
- Lote com **todas** as guias `CONFERIDA`, dentro dos limites → pode seguir por **regra pré-autorizada** (aprovação registrada como "automática por política vX").
- Lote fora dos limites ou com alerta → **aprovação manual da dona**.
- A dona recebe resumo: quantidade de guias, total por UF, conferência ok, alertas. Ação: **Aprovar lote** / **Reprovar** (com motivo) / **Aprovar parcial** (selecionando guias).

### Travas
- **Assinatura do lote:** hash do conteúdo (guias, valores, favorecidos). **Se qualquer item mudar após a aprovação, a aprovação é invalidada** e precisa ser refeita.
- Confirmação forte para aprovar: segundo fator (app autenticador ou biometria do dispositivo), não só login.
- Aprovação expira (ex.: ao fim do dia útil do lote). Prazo configurável.
- Segregação: quem montou o lote não aprova.
- **Botão de pausa global:** a dona suspende todos os pagamentos; o hub não envia nada ao Asaas enquanto pausado.

---

## 10. Pagamento via Asaas (conta exclusiva do DIFAL)

### O que se sabe (documentação do Asaas consultada)
- Existe o recurso "Pague Contas": pagamento de boleto pela API, enviando a **linha digitável**; o Asaas interpreta valor, vencimento e emissor.
- Pode ser imediato (respeitando horário e dias úteis) ou agendado (`scheduleDate`).
- Acompanhamento por consulta (`/v3/bill`) e por webhooks. Há simulação (`/bill/simulate`).
- A documentação avisa que o comportamento varia por tipo de boleto (vencido, consumo, imposto...).

### **A CONFIRMAR antes de construir o fluxo automático**
1. A guia GNRE/DUA-e é aceita pelo Pague Contas com a linha digitável? (arrecadação de tributo pode ter regras próprias)
2. Limites diários e horários da conta; necessidade de habilitar a funcionalidade.
3. O comprovante do Asaas é aceito pelo posto fiscal? Qual formato/endpoint entrega o comprovante?
4. Existe aprovação adicional exigida pelo Asaas para pagamentos via API?
5. Para cada UF: a guia pode ser paga por qualquer banco, sem restrição de favorecido?

**Plano B se algo falhar:** o financeiro paga manualmente (ou por CNAB no Itaú) e o hub recebe o comprovante de volta por upload, mantendo o portão fiscal.

### Regras de segurança do pagamento
- **Idempotência:** chave única = (chave NF-e + tipo de guia). Uma tentativa de pagamento por guia. Reenvio só após consultar o status no Asaas e confirmar que **não** existe pagamento.
- **Conferência no momento do envio:** reconferir valor da linha digitável × guia × aprovação, e a assinatura do lote.
- **Saldo:** antes de enviar, checar saldo disponível; se insuficiente, não enviar parcialmente sem regra definida; alertar o financeiro.
- **Janela:** envio em horário fixo (configurável) antes do corte de coleta; respeitar horário bancário.
- **Chave de API:** só no servidor, com restrição de IP, permissões mínimas, rotacionável. Nunca no front-end.
- **Reconciliação do webhook:** webhooks podem repetir ou atrasar. Processar de forma idempotente e confirmar por consulta.
- **Falhas:** recusa, saldo insuficiente, timeout → `FALHA_PAGAMENTO`, alerta ao financeiro, nota continua bloqueada. **Proibido retry automático cego.**

---

## 11. Conciliação diária

**Fontes:** guias (hub), pagamentos (Asaas, webhook + consulta), extrato do Asaas (API/arquivo), NF-e (XML).

**Cruzamento:** NF-e × guia × pagamento × linha do extrato.

**Divergências a sinalizar:**
1. Guia sem pagamento (aprovada e não paga).
2. Pagamento sem guia (saída no extrato sem NF-e correspondente) — anomalia crítica.
3. Valor pago diferente do valor da guia.
4. Pagamento duplicado para a mesma chave.
5. Guia paga por terceiro (transportadora) → lista de **reembolso**, sem pagar de novo.
6. Guia paga sem comprovante vinculado.
7. Saldo do Asaas ≠ saldo esperado (entradas de abastecimento − pagamentos).

**Fechamento:** o dia só fecha com divergências zeradas ou justificadas (justificativa + quem). Fecha → gera o **pacote de fechamento**.

**Pacote de fechamento (para o financeiro enviar ao coordenador):**
- extrato do Asaas do dia (arquivo);
- todos os XMLs do dia (um .zip);
- planilha de conciliação (NF-e, UF, guia, valor, pagamento, comprovante, status, divergência);
- resumo (totais por UF, quantidade, divergências, reembolsos pendentes).

---

## 12. Combo da transportadora

**Conteúdo (um PDF/pacote por transportadora):**
1. **Romaneio** (cabeçalho com número único, data/hora, empresa, transportadora, total de volumes, QR code).
2. **Guias** em PDF, na **mesma ordem** dos itens do romaneio.
3. **Comprovantes** de pagamento, na mesma ordem.
4. Campos de assinatura: responsável pela expedição e motorista/coletador.

**Regras:**
- Só entram notas `LIBERADA_PARA_COLETA`.
- Coluna de status da guia com **três estados distintos**: guia gerada, paga, comprovante anexado. "Guia anexada" sozinho não prova pagamento.
- Destinatário sempre com nome (ou iniciais) e CPF mascarado; nada de "CONSUMIDOR FINAL" genérico.
- Cabeçalho da tabela repetido corretamente a cada página (sem emendar na última linha).
- Total do romaneio = **soma apenas do DIFAL devido**. Notas `SEM_GUIA` não somam e aparecem com rótulo próprio. (Ver Anexo A.)
- QR code do romaneio leva a uma página que registra a **coleta** (quem, quando, quantidade de volumes). Coleta registrada fecha o romaneio.
- Gerar o combo é ação da expedição, a qualquer hora, sem depender do financeiro. Combos adicionais no mesmo dia geram novo número, só com notas ainda não coletadas.

---

## 13. Abastecimento do saldo do Asaas

- O Itaú segue o fluxo normal da empresa, com a aprovação habitual da dona no banco. **O hub não toca no Itaú.**
- O hub calcula **saldo necessário** = guias aprovadas ou a aprovar nos próximos dias úteis + margem configurável, e mostra ao lado do **saldo atual** do Asaas.
- Quando saldo atual < saldo necessário → alerta ao financeiro, com o valor sugerido de transferência.
- O financeiro pede a transferência no Itaú (processo normal). Ao entrar no Asaas, o hub registra o **abastecimento** e cruza a saída do extrato do Itaú (informada/importada) com a entrada do Asaas.
- Objetivo: poucos abastecimentos por semana, com margem, não um por dia.
- Saldo da conta Asaas deve permanecer enxuto: ele é também um teto de segurança.

---

## 14. Rotina diária (exemplo — horários são ilustrativos, definir com a operação)

| Momento | Expedição | Financeiro | Dona |
|---|---|---|---|
| Contínuo | Vê status por nota; gera combo do que está liberado | Resolve divergências | — |
| Manhã | Primeiro combo do dia | Revisa o lote montado pelo hub | Recebe aviso do lote |
| Corte de aprovação | Segue com o que está liberado | Envia o lote para aprovação | Aprova (ou regra pré-autorizada aplica) |
| Após aprovação | Novas notas entram no combo conforme liberam | Acompanha confirmações do Asaas | — |
| Fim do dia | Combo final | Recebe conciliação pronta, fecha o dia, envia pacote ao coordenador | Vê resumo do dia |

Notas emitidas após o corte entram no lote do dia seguinte e mostram esse status na nota.

---

## 15. Telas (escopo)

Identidade visual e tokens: ver `css/style.css` (tema claro, navy `#111F33`, azul `#2563EB`, Inter). Status usam verde/âmbar/vermelho **apenas** para significado.

### S1 — Fila do financeiro (desktop)
- Cabeçalho com saldo atual do Asaas, saldo necessário, botão de pausa (se perfil permitir).
- Abas: A conferir · Divergentes · Prontas para lote · No lote · Pagas sem comprovante · Reembolsos.
- Tabela: NF-e, destinatário, UF, valor, estado da guia, motivo da divergência, ação.
- Painel do lote do dia: total por UF, quantidade, alertas, botão **Enviar para aprovação**.
- Ação de revisão de divergência com justificativa obrigatória.

### S2 — Aprovação da dona (**mobile first**)
- Resumo: quantidade, total, total por UF, conferência ok, alertas em destaque.
- Botões grandes: **Aprovar lote**, **Reprovar**, **Aprovar parcial**.
- Confirmação forte antes de concluir. Mostrar a assinatura/versão do lote.
- Indicar claramente se está dentro ou fora da alçada.
- Tela de alçada: editar limites, UFs, expiração. Botão **Pausar todos os pagamentos**.

### S3 — Combo da expedição
- Lista por transportadora: notas liberadas × bloqueadas (com motivo).
- Botão **Gerar combo**; baixar PDF; histórico de combos do dia; coletas registradas.
- Nenhum botão de pagar ou aprovar.

### S4 — Fechamento e conciliação
- Divergências abertas, com justificativa.
- Botão **Fechar dia** e **Baixar pacote de fechamento**.
- Lista de reembolso a transportadoras.

### S5 — Abastecimento
- Saldo atual × necessário, histórico de abastecimentos e conciliação com o Itaú.

### S6 — Pendências
- Todas as exceções em um só lugar, com responsável e prazo.

### Dashboard
- KPIs reais: notas liberadas hoje, bloqueadas, guias pagas, guias pendentes, saldo. Cards de DIFAL por UF, próximas coletas, status do lote.

---

## 16. Modelo de dados (sugestão — validar com o schema existente)

Todas as tabelas com `tenant_id` e RLS por tenant. Timestamps e autor em todas.

- `tenants`, `users` (papel: financeiro, expedicao, dona, admin)
- `nfe` (chave, numero, serie, destinatario, uf_destino, valor_total, status, xml_path, emitida_em)
- `guia` (id, nfe_id, tipo, uf, valor, estado, linha_digitavel, codigo_barras, vencimento, competencia, pdf_path, comprovante_path, idempotency_key **UNIQUE**, motivo_divergencia)
- `guia_evento` (guia_id, de, para, ator, motivo, criado_em) — **imutável**
- `politica_alcada` (tenant_id, versao, valor_max_guia, valor_max_dia, ufs_auto, expira_em, vigente)
- `lote_pagamento` (id, data, estado, total, qtd, assinatura_hash, montado_por)
- `lote_item` (lote_id, guia_id, valor_no_momento)
- `aprovacao` (lote_id, aprovador, tipo: manual|politica, politica_versao, decisao, motivo, mfa_ok, assinatura_hash, criado_em)
- `pagamento` (id, guia_id, asaas_id, idempotency_key **UNIQUE**, status, valor, enviado_em, confirmado_em, erro)
- `extrato_item` (origem: asaas|itau, data, valor, descricao, chave_ref, conciliado_com)
- `conciliacao_item` (dia, tipo_divergencia, referencia, justificativa, resolvido_por)
- `fechamento_dia` (data, fechado_por, pacote_path)
- `combo` (id, numero, transportadora, gerado_por, gerado_em, pdf_path, coletado_em, qtd_volumes)
- `combo_item` (combo_id, nfe_id, ordem)
- `abastecimento` (valor, origem, data, extrato_itau_ref, extrato_asaas_ref)
- `audit_log` (ator, acao, entidade, detalhes, ip, dispositivo, criado_em) — **append-only**
- `config_integracao` (credenciais criptografadas, **nunca em texto**)

Regra de integridade: `guia.idempotency_key` e `pagamento.idempotency_key` com índice único para impedir duplicidade no nível do banco.

---

## 17. Eventos, webhooks e jobs

- Webhook Asaas → fila → processamento idempotente → atualiza `pagamento`/`guia` → dispara E8.
- Job de **conferência** (ao emitir a guia e antes do envio do pagamento).
- Job de **montagem do lote** (horário configurável).
- Job de **envio de pagamentos** (janela configurável; respeita pausa global).
- Job de **reconsulta de status** de pagamentos pendentes além do prazo.
- Job de **expiração de aprovação**.
- Job de **conciliação** (diário) e de **saldo necessário** (a cada hora útil).
- Todos os jobs com travas contra execução concorrente e logs sem dados sensíveis.

---

## 18. Segurança e auditoria

- Certificado A1: armazenado criptografado, preferencialmente com **AES-256-GCM** e chave fora do banco (cofre/KMS); senha do certificado nunca em texto; acesso mínimo; possibilidade de remoção pelo cliente. Não afirmar na landing garantias que não possam ser provadas.
- Segregação de funções (seção 3) aplicada **no backend**, não só na interface.
- MFA obrigatório para aprovar pagamento e para alterar alçada, chave do Asaas ou pausa.
- Chaves de API com restrição de IP e permissão mínima; rotação periódica.
- RLS em todas as tabelas; testes de isolamento entre tenants.
- Auditoria append-only de toda decisão com valor: quem, quando, dispositivo, IP, o que mudou.
- Dados pessoais (CPF, endereço) mínimos e mascarados na interface; retenção definida (LGPD).
- Ambiente de desenvolvimento separado do de produção; nenhum dado real em testes.

---

## 19. Erros e exceções

| Situação | Comportamento |
|---|---|
| NF-e cancelada depois da guia emitida | Guia → `CANCELADA`; se já paga, entra em lista de ajuste/estorno e alerta ao financeiro |
| SEFAZ/Portal fora do ar | Fila com retentativas espaçadas; nota continua bloqueada com motivo |
| Rejeição do órgão | `REJEITADA_SEFAZ` com motivo; correção manual; nunca alterar competência automaticamente |
| Divergência de valor | `DIVERGENTE`; financeiro revisa com justificativa |
| Saldo insuficiente | Não envia; alerta; nota bloqueada |
| Pagamento recusado | `FALHA_PAGAMENTO`; consultar status antes de nova tentativa |
| Webhook não chegou | Reconsulta por API; só então decide |
| Webhook duplicado | Ignorado por idempotência |
| Guia paga pela transportadora | `PAGA_POR_TERCEIRO`, sem novo pagamento, entra em reembolso |
| Aprovação expirada | Volta para `AGUARDANDO_APROVACAO`; nova aprovação |
| Item do lote alterado após aprovar | Aprovação invalidada |
| Pausa global ativada | Nenhum pagamento enviado; lote fica retido; alerta ao financeiro |
| Cliente sem certificado A1 | Só ambiente simulado |

---

## 20. Notificações

- **Dona:** lote pronto para aprovar; lote fora da alçada; pagamento com falha; divergência crítica (pagamento sem guia).
- **Financeiro:** divergência nova; saldo abaixo do necessário; falha de pagamento; dia com pendências; reembolso aberto.
- **Expedição:** nota liberada (opcional); nota bloqueada há muito tempo; combo disponível.
- Canais: e-mail e push/WhatsApp (definir). Mensagens com valores e identificação **mínimos**, sem dados pessoais do consumidor.

---

## 21. Métricas de sucesso

- % de notas liberadas antes do horário de coleta.
- Nº de cargas barradas no posto fiscal por falta de guia (**meta: zero**).
- Nº de guias pagas em duplicidade (**meta: zero**).
- Tempo entre guia emitida e guia comprovada.
- Tempo do financeiro por lote (antes × depois).
- Valor de reembolsos a transportadoras (meta: tender a zero).
- Divergências por 100 guias.

---

## 22. Decisões em aberto e riscos

**Decisões do dono do produto / cliente**
1. Valores da alçada (por guia e por dia) e prazo de expiração da aprovação.
2. Horários de corte de aprovação, de envio de pagamento e de coleta, com cada transportadora.
3. Canal de notificação da dona (e-mail, push, WhatsApp).
4. Aprovação diária obrigatória ou apenas acima do limite.
5. Nome final do produto e validação no INPI (domínio, redes).
6. Modelo de acesso: só convite, cadastro aberto, ou ambos.

**Itens a verificar tecnicamente**
1. Pagamento da GNRE/DUA-e via Pague Contas (seção 10).
2. Comprovante: formato, endpoint e aceitação pelo posto fiscal.
3. Regra de FCP separado por UF e de guia por NF-e × consolidada por UF.
4. Extrato do Asaas por API: campos disponíveis e fechamento diário.
5. Como o Link/Olist expõem o cancelamento de NF-e (evento ou consulta).
6. Padrão de CNAB do Itaú SISPAG já implementado: reaproveitar como alternativa de pagamento.

**Riscos**
- Regra fiscal por UF muda; manter tabela versionada e processo de atualização.
- Custódia de certificado A1 de terceiros: risco de segurança e de responsabilidade.
- Dependência de APIs de terceiros (Asaas, GNRE, Link, Olist).
- Prometer na landing o bloqueio automático antes de ele existir.

**Validação contábil necessária:** tratamento de competência/data em guias rejeitadas, lançamento das transferências entre contas próprias e do DIFAL pago, e valor de SP (Anexo A).

---

## 23. Plano em fases e critérios de aceite

### Fase 0 — Panorama (antes de qualquer código)
Mapear o que já existe (ver `PROMPT_PANORAMA_OPUS.md`). Entregável: relatório de estado real, sem suposições.

### Fase 1 — Portão fiscal sem pagamento automático
- Máquina de estados da guia + eventos + auditoria.
- Conferência automática (seção 8).
- Estado da nota (liberada/bloqueada) e combo com os três status de guia.
- Pagamento ainda manual (CNAB ou financeiro) com **upload do comprovante**.
- **Aceite:** nenhuma nota entra no combo sem guia `COMPROVADA` ou `SEM_GUIA`; cada transição auditada; dados sempre reais, sem fixos.

### Fase 2 — Lote e aprovação
- Montagem do lote, assinatura (hash), alçada, aprovação da dona no celular com MFA, pausa global.
- **Aceite:** alterar um item após aprovar invalida a aprovação; quem monta não aprova.

### Fase 3 — Pagamento pelo Asaas
- Só após confirmar os itens da seção 10.
- Envio idempotente, webhook, reconsulta, saldo e abastecimento.
- **Aceite:** teste de reenvio/duplo clique/webhook duplicado não gera segundo pagamento; falha nunca faz retry cego.

### Fase 4 — Conciliação e fechamento
- Cruzamento diário, divergências, reembolsos, pacote de fechamento.
- **Aceite:** o financeiro envia o pacote ao coordenador sem montar nada à mão.

### Fase 5 — Produto vendável
- Multi-cliente, planos e cobrança, landing alinhada ao que existe de fato, termos e política de privacidade, revisão de segurança do certificado.

---

## Anexo A — Observações do romaneio de 14/10/2026 (cliente piloto)

- 53 notas, 2 transportadoras: Correios (23 volumes, total impresso R$ 1.305,25) e Total Express (30 volumes, total impresso R$ 1.171,18). **Os totais por transportadora conferem com a soma das linhas.**
- **18 notas** são "ISENTO / SP" (3 Correios, 15 Total Express) e somam **R$ 730,52** na coluna DIFAL. Esse valor está sendo **incluído** nos totais impressos.
- Sem as notas de SP: **35 guias, R$ 1.745,91** (DIFAL realmente devido), contra R$ 2.476,43 impressos.
- **Pendência:** confirmar com a contabilidade o que é o valor mostrado nas linhas de SP (se não é DIFAL, a coluna precisa de outro nome; se é erro de soma, o total está inflado).
- Problemas de layout do documento atual: "guia anexada" não prova pagamento; vários destinatários como "CONSUMIDOR FINAL" sem identificação; sem número único de romaneio nem QR code; cabeçalho da tabela emendando na última linha ao quebrar de página.
