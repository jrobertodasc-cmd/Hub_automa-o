# Prompt para o Opus — panorama do projeto (cole tudo abaixo)

---

Preciso de um **panorama técnico fiel** do projeto atual (webservice + painel), para que outra IA e eu possamos planejar a evolução sem suposições.

## Regras
- **Somente leitura.** Não altere arquivos, não rode testes que criem dados, **não envie formulários nem chame APIs reais** (Supabase de produção, GNRE, DUA-e, Link, Olist, Asaas).
- **Não imprima segredos.** Quando encontrar chaves, tokens, senhas ou certificados, informe apenas **onde estão** e o **nome** da variável (ex.: `ASAAS_API_KEY` em `.env`), nunca o valor.
- **Seja honesto sobre o que é real e o que é simulado.** Se algo for dado fixo, mock, valor calculado de enfeite ou trecho incompleto, diga explicitamente. Se não tiver certeza, escreva "não verificado".
- Cite **arquivo e função/linha** para cada afirmação importante.
- Entregue o resultado em um único arquivo `PANORAMA_PROJETO.md` na raiz.

## O que quero no relatório

### 1. Visão geral
- Stack (linguagens, frameworks, versões), como roda local e em produção, estrutura de pastas comentada.

### 2. Backend / webservice
- Lista de **rotas/endpoints** (método, caminho, o que faz, autenticação exigida).
- Módulos de negócio: cálculo de DIFAL, emissão de guia (DUA-e/ES, Portal GNRE, lote XML de SP), geração de CNAB 240 (Itaú SISPAG), geração de romaneio, leitura de XML da NF-e.
- Como funciona o cálculo do DIFAL: de onde vêm as alíquotas por UF, base simples/dupla, FCP; se há versionamento/vigência; como UFs sem regra são tratadas.
- Jobs, filas, tarefas agendadas, processamento assíncrono (se existir).
- Tratamento de erros, retentativas e idempotência hoje (existe? onde? há risco de emitir guia duplicada?).

### 3. Banco de dados (Supabase)
- **Todas as tabelas** com colunas e tipos, chaves, índices, relacionamentos e **políticas RLS**.
- Buckets de Storage e o que guardam.
- Como o isolamento entre clientes (tenants) é garantido e se há testes disso.
- Migrações: onde estão e se refletem o banco real.

### 4. Autenticação e cadastro
- Fluxo de login, cadastro, sessão, recuperação de senha, papéis/perfis (se houver), planos e limites de uso.
- Como o plano/trial é aplicado (limite de guias).

### 5. Integrações
Para cada uma (Link/Linx Microvix API B2C, Olist, GNRE, DUA-e ES, Supabase, e Asaas se já existir algo): o que está implementado, o que falta, como autentica, onde ficam as credenciais, quais endpoints externos são chamados e se há ambiente de homologação separado.

### 6. Certificado digital A1
- Como é recebido, armazenado, criptografado (algoritmo, modo, onde fica a chave), como a senha é tratada, em que momento é aberto em memória, quem tem acesso. Aponte **qualquer risco** que você enxergue.

### 7. Front-end
- Páginas existentes e o que cada uma faz, scripts/CSS, de onde vêm os dados de cada tela.
- **Lista de tudo que está fixo, falso ou inventado** na interface (números, textos, mapas fixos, fórmulas que simulam dados).
- O que mudou recentemente para o novo design (tema claro, marca "expedi HUB") e o que ainda está no layout antigo ("Apex").

### 8. Estado real do produto
Uma tabela **funcionalidade × status** (Funciona de ponta a ponta / Parcial / Só no front / Não existe / Não verificado), cobrindo:
emissão ES, emissão GNRE, lote SP, CNAB, romaneio, upload de XML, integração Link, integração Olist, cálculo de DIFAL, multi-tenant, planos, relatórios, histórico.

### 9. Riscos e dívidas técnicas
- Segurança, duplicidade de guia/pagamento, falta de auditoria, dados sensíveis em log, ausência de testes, pontos frágeis.
- Qualquer coisa no código que contradiga o que a landing page promete.

### 10. Pontos de encaixe para o novo fluxo
Veja o documento `FLUXO_COMPLETO_expedi.md`. Diga, para cada etapa (E1 a E10), **onde no código atual ela se encaixaria**, o que já existe que posso reaproveitar e o que precisa ser criado do zero. Liste também **conflitos** entre o fluxo desenhado e o que o código faz hoje.

## Formato
Português, direto, sem enrolação. Tabelas onde ajudar. No final, uma seção **"O que eu não consegui verificar"** com tudo que ficou em aberto.
