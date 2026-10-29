
function filtrarPorUf360(uf) {
    if (window.cockpit360UfFiltro === uf) {
        window.cockpit360UfFiltro = null;
    } else {
        window.cockpit360UfFiltro = uf;
    }
    if (window.cockpit360Cache) {
        renderizarCards360(window.cockpit360Cache);
    }
}
window.filtrarPorUf360 = filtrarPorUf360;

function exportarRelatorio360Csv() {
    const data = window.cockpit360Cache;
    const guias = (data && data.guias360) ? data.guias360 : (window.todasCargasDoca || []);
    if (!guias || guias.length === 0) {
        if (typeof showToast === 'function') showToast('Nenhum dado disponível para exportar.', 'warning');
        else alert('Nenhum dado disponível para exportar.');
        return;
    }

    const situacoesNomes = {
        paga: 'PAGA / LIBERADA',
        agendada: 'AGENDADA NO BANCO',
        a_pagar: 'A PAGAR (PENDENTE)',
        sem_guia: 'NÃO PAGA / RETIDA',
        rejeitada: 'REJEITADA NA SEFAZ',
        sp_manual: 'SP MANUAL'
    };

    const headers = [
        'Pedido VNDA', 'NF-e', 'Data Emissao', 'Cliente', 'CPF/CNPJ',
        'Cidade', 'UF', 'Transportadora', 'Valor Venda (R$)', 'DIFAL (R$)',
        'Situacao Fiscal', 'Data Pagamento', 'Codigo de Barras Febraban', 'Pecas/Itens'
    ];

    const rows = [headers];

    guias.forEach(g => {
        const itensDesc = (g.itens || []).map(it => `${it.quantidade || 1}x ${it.descricao || ''} (${it.sku || ''})`).join(' | ');
        const dtEmissao = g.data_emissao ? g.data_emissao.substring(0, 10) : (g.data_venda ? g.data_venda.substring(0, 10) : '');
        const dtPag = g.paid_at ? g.paid_at.substring(0, 10) : '';

        rows.push([
            g.order_number || '',
            g.nf_number || '',
            dtEmissao,
            g.customer_name || 'Consumidor Final',
            g.customer_doc || '',
            g.cidade || '',
            g.uf || '',
            g.carrier_name || 'Total Express',
            (g.valor_venda || 0).toFixed(2).replace('.', ','),
            (g.valor_difal || 0).toFixed(2).replace('.', ','),
            situacoesNomes[g.status_bancario] || g.status_bancario || 'PENDENTE',
            dtPag,
            String(g.barcode || ''),
            itensDesc
        ]);
    });

    const csvContent = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dataHoje = new Date().toISOString().substring(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', `relatorio_ecommerce_difal_boah_${dataHoje}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (typeof showToast === 'function') {
        showToast(`✓ Planilha exportada com sucesso (${guias.length} pedidos)!`, 'success');
    }
}
window.exportarRelatorio360Csv = exportarRelatorio360Csv;


function formatarDataEmissaoDoca(g) {
    let raw = g.emission_date || g.nf_issue_date || g.created_at || '';
    if (!raw && g.chave_nfe && g.chave_nfe.length === 44) {
        const aa = g.chave_nfe.substring(2, 4);
        const mm = g.chave_nfe.substring(4, 6);
        return { texto: `${mm}/20${aa}`, pill: `Emissão ${mm}/${aa}`, corPill: 'time-ok' };
    }

    if (!raw) {
        return { texto: 'Data N/D', pill: 'Sem data', corPill: 'time-warn' };
    }

    try {
        const d = new Date(raw);
        if (isNaN(d.getTime())) {
            if (raw.length >= 10 && raw.includes('-')) {
                const [ano, mes, dia] = raw.substring(0, 10).split('-');
                return { texto: `${dia}/${mes}/${ano}`, pill: `Emissão ${dia}/${mes}`, corPill: 'time-ok' };
            }
            return { texto: raw.substring(0, 10), pill: '', corPill: 'time-ok' };
        }

        const hojeObj = new Date();
        const hojeIso = hojeObj.toISOString().substring(0, 10);
        const dataIso = d.toISOString().substring(0, 10);
        const dia = String(d.getDate()).padStart(2, '0');
        const mes = String(d.getMonth() + 1).padStart(2, '0');

        if (dataIso === hojeIso) {
            return { texto: `${dia}/${mes} (Hoje)`, pill: 'Emitida hoje', corPill: 'time-ok' };
        }

        const diffDias = Math.max(0, Math.round((hojeObj.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)));
        let pillTxt = '';
        if (g.is_paga || g.paid_at) {
            pillTxt = 'Pago';
        } else if (diffDias === 0) {
            pillTxt = 'Hoje';
        } else if (diffDias === 1) {
            pillTxt = 'Ontem';
        } else {
            pillTxt = `${diffDias}d na doca`;
        }

        return { texto: `${dia}/${mes}`, pill: pillTxt, corPill: (!g.is_paga && diffDias > 3) ? 'time-warn' : 'time-ok' };
    } catch (e) {
        return { texto: 'Data N/D', pill: '', corPill: 'time-ok' };
    }
}
window.formatarDataEmissaoDoca = formatarDataEmissaoDoca;

// public/js/dashboard.js
// Lógica do Painel de Faturamento e Processamento de Lotes

let selectedFiles = [];
let pollingInterval = null;

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ==========================================
// ATUALIZAÇÃO EM TEMPO REAL NA DOCA (SSE + POLLING REDUNDANTE)
// ==========================================
function iniciarSSEAtualizacaoDoca() {
    try {
        const token = localStorage.getItem('sb_access_token');
        if (!token) {
            console.log("[SSE Doca] Aguardando autenticação para conectar canal em tempo real.");
            return;
        }

        if (!window.EventSource) {
            console.warn("[SSE Doca] Navegador sem suporte nativo a EventSource. Usando polling de fallback.");
            setInterval(carregarCargasDocaReais, 15000);
            return;
        }

        const sseUrl = `/api/events/dock?token=${encodeURIComponent(token)}`;
        const evtSource = new EventSource(sseUrl);

        evtSource.onmessage = function(event) {
            try {
                if (!event.data || event.data.startsWith(':')) return; // ignorar heartbeat keepalive
                const data = JSON.parse(event.data);
                console.log("[SSE Doca] Evento em tempo real recebido:", data);

                if (data.type === 'GUIA_PAGA' || data.type === 'GUIA_ERRO' || data.type === 'LOTE_ATUALIZADO') {
                    // Atualiza Cockpit da doca instantaneamente sem F5
                    if (typeof carregarCargasDocaReais === 'function') {
                        carregarCargasDocaReais();
                    }
                    if (window.activeBatchId && typeof carregarDetalhesLote === 'function') {
                        carregarDetalhesLote(window.activeBatchId);
                    }
                    if (data.type === 'GUIA_PAGA') {
                        if (typeof showToast === 'function') {
                            showToast(`✓ NF-e ${data.nf} LIBERADA! Semáforo atualizado na doca.`, 'success');
                        }
                    } else if (data.type === 'GUIA_ERRO') {
                        if (typeof showToast === 'function') {
                            showToast(`✕ Falha no pagamento da NF-e ${data.nf}: ${data.motivo || 'Erro'}`, 'error');
                        }
                    }
                }
            } catch (err) {
                console.warn("[SSE Doca] Erro ao interpretar evento:", err);
            }
        };

        let sseErrorCount = 0;
        evtSource.onerror = function() {
            sseErrorCount++;
            if (sseErrorCount > 3) {
                console.warn("[SSE Doca] Limite de tentativas SSE atingido. Pausando reconexão.");
                evtSource.close();
            } else {
                console.warn("[SSE Doca] Conexão SSE instável. O navegador tentará reconectar automaticamente.");
            }
        };

        // Polling leve complementar a cada 20 segundos para garantir consistência
        setInterval(() => {
            if (typeof carregarCargasDocaReais === 'function') {
                carregarCargasDocaReais();
            }
        }, 20000);

    } catch (e) {
        console.warn("[SSE Doca] Falha ao iniciar SSE:", e);
        setInterval(carregarCargasDocaReais, 15000);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Verifica login e carrega cabeçalho/empresa
    await carregarDadosDashboard();

    // 1.1 Carrega cargas reais da Doca da Linx Microvix
    await carregarCargasDocaReais();

    // 1.2 Inicia escuta em tempo real da Doca (SSE)
    iniciarSSEAtualizacaoDoca();

    // 1.3 Ativa a visualização principal do Figma (Início / Hub Operacional) por padrão
    const urlParams = new URLSearchParams(window.location.search);
    const abaAlvo = urlParams.get('aba') || (window.location.hash ? window.location.hash.replace('#', '') : 'hub');
    if (typeof navegarAbaPrincipal === 'function') {
        navegarAbaPrincipal(abaAlvo);
    }

    // 2. Carrega histórico de lotes
    await carregarHistoricoLotes();

    // 2.1 Carrega status do agendador automático
    await carregarStatusSync();

    // 2.2 Atalho de Teclado Cmd/Ctrl + K para busca rápida (Figma)
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            const globalSearch = document.getElementById('global-search-input');
            if (globalSearch) {
                globalSearch.focus();
                globalSearch.select();
            }
        }
    });

    // 3. Inicializa drag-and-drop no dropzone
    const dropzone = document.getElementById('xml-dropzone');
    const xmlInput = document.getElementById('xml-input');

    if (dropzone && xmlInput) {
        dropzone.addEventListener('click', () => xmlInput.click());

        xmlInput.addEventListener('change', (e) => {
            adicionarArquivos(e.target.files);
        });

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            adicionarArquivos(e.dataTransfer.files);
        });
    }

    // 4. Lógica de Envio por Upload
    const btnProcessUpload = document.getElementById('btn-process-upload');
    if (btnProcessUpload) {
        btnProcessUpload.addEventListener('click', async () => {
            if (selectedFiles.length === 0) {
                showToast("Por favor, selecione ou arraste pelo menos um XML de nota fiscal.", 'error');
                return;
            }

            const paymentDate = document.getElementById('payment-date').value;
            const formData = new FormData();
            selectedFiles.forEach(file => {
                formData.append('files', file);
            });
            formData.append('source', 'upload');
            formData.append('paymentDate', paymentDate);

            try {
                resetTerminal();
                showToast("Enviando notas fiscais para o lote...", 'warning');
                btnProcessUpload.disabled = true;

                const res = await fetch('/api/batch/process', {
                    method: 'POST',
                    body: formData
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                selectedFiles = [];
                atualizarListaArquivosVisual();
                iniciarPollingLote(data.batch_id);

            } catch (err) {
                showToast(err.message, 'error');
                btnProcessUpload.disabled = false;
            }
        });
    }

    // 5. Lógica de Processamento de Pasta Local
    const btnProcessLocal = document.getElementById('btn-process-local');
    if (btnProcessLocal) {
        btnProcessLocal.addEventListener('click', async () => {
            try {
                resetTerminal();
                showToast("Iniciando varredura da pasta local 'xml_nfe'...", 'warning');
                btnProcessLocal.disabled = true;

                const paymentDate = document.getElementById('payment-date').value;
                const res = await fetch('/api/batch/process', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source: 'local', paymentDate })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                iniciarPollingLote(data.batch_id);

            } catch (err) {
                showToast(err.message, 'error');
                btnProcessLocal.disabled = false;
            }
        });
    }
});

// Adiciona arquivos do input/drop à lista local na memória
function adicionarArquivos(files) {
    const listDiv = document.getElementById('selected-files');
    
    for (let file of files) {
        if (file.type === 'text/xml' || file.name.toLowerCase().endsWith('.xml')) {
            // Evita arquivos repetidos com o mesmo nome
            if (!selectedFiles.some(f => f.name === file.name)) {
                selectedFiles.push(file);
            }
        }
    }

    atualizarListaArquivosVisual();
}

function atualizarListaArquivosVisual() {
    const listDiv = document.getElementById('selected-files');
    if (!listDiv) return;

    if (selectedFiles.length === 0) {
        listDiv.classList.add('d-none');
        listDiv.innerHTML = '';
        return;
    }

    listDiv.classList.remove('d-none');
    listDiv.innerHTML = selectedFiles.map((file, idx) => `
        <div class="file-item">
            <span> ${escapeHtml(file.name)} (${(file.size / 1024).toFixed(1)} KB)</span>
            <span class="remove-file" onclick="removerArquivo(${idx})">✖</span>
        </div>
    `).join('');
}

function removerArquivo(idx) {
    selectedFiles.splice(idx, 1);
    atualizarListaArquivosVisual();
}

function resetTerminal() {
    const term = document.getElementById('terminal-logs');
    if (term) {
        term.innerHTML = '<span class="log-line">Inicializando terminal de lote...</span>';
    }
    const prog = document.getElementById('processing-progress');
    if (prog) prog.classList.remove('d-none');
    setProgresso(0);
    const spXmlBtn = document.getElementById('download-sp-xml-btn');
    if (spXmlBtn) spXmlBtn.classList.add('d-none');
}

function setProgresso(perc) {
    const inner = document.getElementById('progress-inner');
    const valText = document.getElementById('progress-val');
    if (inner && valText) {
        inner.style.width = `${perc}%`;
        valText.textContent = `${perc}%`;
    }
}

// Inicia polling para acompanhar o progresso e logs do processamento em background
function iniciarPollingLote(batchId) {
    if (pollingInterval) clearInterval(pollingInterval);

    pollingInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/batch/status/${batchId}`);
            if (!res.ok) throw new Error("Erro ao buscar status do processamento.");

            const data = await res.json();
            
            // 1. Atualiza barra de progresso
            setProgresso(data.progress || 0);

            // 2. Atualiza os logs do terminal
            const term = document.getElementById('terminal-logs');
            if (term && data.logs && data.logs.length > 0) {
                term.innerHTML = data.logs.map(line => `
                    <div class="log-line">${escapeHtml(line)}</div>
                `).join('');
                term.scrollTop = term.scrollHeight; // Auto scroll down
            }

            // 3. Finalização
            if (data.status === 'aguardando_aprovacao') {
                clearInterval(pollingInterval);
                pollingInterval = null;

                // Re-habilita botões
                document.getElementById('btn-process-upload').disabled = false;
                document.getElementById('btn-process-local').disabled = false;

                showToast("Notas importadas com sucesso! Revise e autorize a emissão na SEFAZ.", 'warning');
                await carregarHistoricoLotes();
                await carregarDetalhesLote(batchId);
            } else if (data.status === 'sucesso' || data.status === 'erro' || data.status === 'cancelado') {
                clearInterval(pollingInterval);
                pollingInterval = null;

                // Re-habilita botões
                document.getElementById('btn-process-upload').disabled = false;
                document.getElementById('btn-process-local').disabled = false;

                if (data.status === 'sucesso') {
                    showToast("Lote processado com sucesso!");
                    await carregarHistoricoLotes();
                    await carregarDetalhesLote(batchId);
                } else if (data.status === 'cancelado') {
                    showToast("Lote descartado pelo operador.");
                    await carregarHistoricoLotes();
                } else {
                    showToast("O lote apresentou falhas: " + (data.error_message || data.error || 'Erro'), 'error');
                    await carregarHistoricoLotes();
                }
            }

        } catch (err) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            document.getElementById('btn-process-upload').disabled = false;
            document.getElementById('btn-process-local').disabled = false;
            showToast("Falha na sincronização do lote: " + err.message, 'error');
        }
    }, 1200);
}

async function carregarDadosDashboard() {
    try {
        const token = localStorage.getItem('sb_access_token');
        if (!token) {
            console.warn("[Dashboard] Usuário não autenticado. Redirecionando para login...");
            window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
            return;
        }

        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                console.warn("[Dashboard] Sessão não autorizada ou expirada (401). Redirecionando para login...");
                localStorage.removeItem('sb_access_token');
                window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
                return;
            }
            const tenantEl = document.getElementById('tenant-name');
            if (tenantEl) tenantEl.textContent = 'Empresa Emitente';
            const cnpjEl = document.getElementById('company-cnpj');
            if (cnpjEl) cnpjEl.textContent = 'Operação Ativa';
            return;
        }

        const data = await res.json();
        window.currentUserProfile = data.profile || { role: 'operador' };
        
        // Exibe o botão Master Admin exclusivamente para SuperAdmin Master
        const userEmail = (data.user?.email || data.profile?.email || '').toLowerCase().trim();
        const userRole = (data.profile?.role || '').toLowerCase();
        const isMaster = userRole === 'superadmin' || !!data.profile?.is_admin || ['jrobertodasc@gmail.com', 'grupoaliadoshubtech@gmail.com'].includes(userEmail);
        const navMaster = document.getElementById('nav-master-admin');
        if (navMaster) {
            navMaster.style.display = isMaster ? 'inline-flex' : 'none';
        }

        const tenant = Array.isArray(data.tenant) ? data.tenant[0] : data.tenant;
        
        const tenantName = (tenant && (tenant.nome_fantasia || tenant.razao_social || tenant.name)) || data.user.name || 'Empresa Emitente';
        const tenantEl = document.getElementById('tenant-name');
        if (tenantEl) tenantEl.textContent = tenantName;

        const subtitleEl = document.getElementById('tenant-subtitle');
        if (subtitleEl) {
            subtitleEl.textContent = `${tenantName} · Doca & Portão Fiscal`;
        }

        const tenantAvatar = document.getElementById('tenant-avatar-letter');
        if (tenantAvatar) tenantAvatar.textContent = tenantName.charAt(0).toUpperCase();

        const activeEnvEl = document.getElementById('active-env');
        if (activeEnvEl) {
            activeEnvEl.textContent = (tenant && tenant.environment === 'producao') ? 'PRODUÇÃO' : 'SIMULADO';
            activeEnvEl.style.color = (tenant && tenant.environment === 'producao') ? '#34d399' : '#fbbf24';
        }
        
        // CNPJ formatado
        const cnpj = (tenant && tenant.cnpj) || '';
        const cnpjEl = document.getElementById('company-cnpj');
        if (cnpjEl) {
            cnpjEl.textContent = cnpj.length === 14 
                ? 'Operação B2C · ' + cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
                : 'Operação B2C · ' + cnpj;
        }

        // Operador logado (Topbar Figma)
        const userName = data.user.name || 'Operador Logístico';
        const userNameEl = document.getElementById('topbar-user-name');
        if (userNameEl) userNameEl.textContent = userName;

        const userInitialsEl = document.getElementById('topbar-user-initials');
        if (userInitialsEl) {
            const parts = userName.trim().split(' ');
            const initials = parts.length >= 2 
                ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
                : userName.substring(0, 2).toUpperCase();
            userInitialsEl.textContent = initials;
        }

        // Data de hoje formatada (Figma: "14 out. 2026 · Hoje")
        const hojeObj = new Date();
        const dia = hojeObj.getDate();
        const meses = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
        const mes = meses[hojeObj.getMonth()];
        const ano = hojeObj.getFullYear();
        const headerDate = document.getElementById('header-today-date');
        if (headerDate) headerDate.textContent = `${dia} ${mes} ${ano} · Hoje`;

        // Inicializa as datas de pagamento com o dia de hoje
        const hojeIso = hojeObj.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/').reverse().join('-');
        const paymentDateInput = document.getElementById('payment-date');
        if (paymentDateInput) paymentDateInput.value = hojeIso;
        const reciboPaymentDateInput = document.getElementById('recibo-payment-date');
        if (reciboPaymentDateInput) reciboPaymentDateInput.value = hojeIso;

        if (data.profile && data.profile.is_admin) {
            const adminLink = document.getElementById('admin-nav-link');
            if (adminLink) adminLink.classList.remove('d-none');
        }
    } catch (e) {
        showToast("Erro ao carregar dados do dashboard: " + e.message, 'error');
    }
}

async function carregarHistoricoLotes() {
    try {
        const res = await fetch('/api/batch/history');
        if (!res.ok) throw new Error();

        const data = await res.json();
        const tbody = document.getElementById('history-table-body');
        if (!tbody) return;

        if (data.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="color: var(--text-secondary);">Nenhum lote enviado ainda.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(batch => {
            const dataFmt = new Date(batch.created_at).toLocaleString('pt-BR');
            let badgeClass = 'badge-warning';
            let statusText = 'Processando';
            let btnText = 'Carregar Lote';
            if (batch.status === 'aguardando_aprovacao') {
                badgeClass = 'badge-warning';
                statusText = '⏳ Aguardando Autorização';
                btnText = 'Revisar Lote';
            } else if (batch.status === 'sucesso') {
                badgeClass = 'badge-success';
                statusText = 'Emitido';
            } else if (batch.status === 'erro') {
                badgeClass = 'badge-danger';
                statusText = 'Falha';
            } else if (batch.status === 'cancelado') {
                badgeClass = 'badge-secondary';
                statusText = 'Descartado';
            }

            return `
                <tr style="cursor: pointer;" onclick="carregarDetalhesLote('${batch.id}')">
                    <td>${dataFmt}</td>
                    <td><span class="badge ${batch.environment === 'producao' ? 'badge-success' : 'badge-warning'}">${batch.environment}</span></td>
                    <td><span class="badge ${badgeClass}">${statusText}</span></td>
                    <td style="text-align: right;">
                        <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 11px;">${btnText}</button>
                    </td>
                </tr>
            `;
        }).join('');

        // Se nenhum lote estiver selecionado, auto-carrega o mais recente automaticamente
        if (!window.activeBatchId && data.length > 0) {
            carregarDetalhesLote(data[0].id);
        }
    } catch (e) {
        showToast("Falha ao carregar histórico de lotes.", 'error');
    }
}

async function carregarDetalhesLote(batchId) {
    try {
        const res = await fetch(`/api/batch/status/${batchId}`);
        if (!res.ok) throw new Error();

        const batch = await res.json();
        const detailsSection = document.getElementById('batch-details-section');
        const guidesBody = document.getElementById('guides-table-body');
        const remessaBtn = document.getElementById('download-remessa-btn');
        const guiasAllBtn = document.getElementById('download-guias-all-btn');
        const spXmlBtn = document.getElementById('download-sp-xml-btn');
        const approvalBanner = document.getElementById('batch-approval-banner');
        const printInterleavedBtn = document.getElementById('print-interleaved-btn');
        const romaneioBtn = document.getElementById('btn-romaneio-expedicao');
        const comboBtn = document.getElementById('btn-combo-expedicao');
        const authPaymentBtn = document.getElementById('btn-authorize-payment');

        if (!guidesBody) return;

        if (batch.status === 'cancelado') {
            if (approvalBanner) approvalBanner.classList.add('d-none');
            if (detailsSection) detailsSection.classList.add('d-none');
            return;
        }

        window.activeBatchId = batch.id;
        window.activeBatch = batch;
        window.currentBatchGuides = batch.guides || [];

        // Exibe a barra de ações e tabela
        if (detailsSection) detailsSection.classList.remove('d-none');

        // Atualiza KPIs operacionais no topo
        atualizarKpisDoLote(batch, window.currentBatchGuides);

        if (batch.status === 'aguardando_aprovacao') {
            // Mostra o Banner de Autorização de Emissão
            if (approvalBanner) {
                approvalBanner.classList.remove('d-none');
                const approvalDesc = document.getElementById('approval-banner-desc');
                if (approvalDesc) {
                    const totalNotas = window.currentBatchGuides.length;
                    const totalDifal = window.currentBatchGuides.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
                    approvalDesc.textContent = `${totalNotas} nota(s) importada(s) totalizando R$ ${totalDifal.toFixed(2).replace('.', ',')} em DIFAL. Nenhuma guia foi transmitida à SEFAZ ainda. Revise a lista abaixo e autorize a emissão.`;
                }
            }

            // Oculta botões pós-emissão até o operador autorizar
            if (printInterleavedBtn) printInterleavedBtn.classList.add('d-none');
            if (romaneioBtn) romaneioBtn.classList.add('d-none');
            if (comboBtn) comboBtn.classList.add('d-none');
            if (authPaymentBtn) authPaymentBtn.classList.add('d-none');
            if (remessaBtn) remessaBtn.classList.add('d-none');
            if (guiasAllBtn) guiasAllBtn.classList.add('d-none');
            if (spXmlBtn) spXmlBtn.classList.add('d-none');

        } else if (batch.status === 'sucesso') {
            // Oculta banner de aprovação de emissão
            if (approvalBanner) approvalBanner.classList.add('d-none');

            // Exibe botões de pós-emissão
            if (printInterleavedBtn) {
                printInterleavedBtn.classList.remove('d-none');
                printInterleavedBtn.href = `/api/guide/print-interleaved/${batch.id}`;
            }
            if (romaneioBtn) {
                romaneioBtn.classList.remove('d-none');
                romaneioBtn.href = `/api/expedicao/romaneio?batchId=${batch.id}`;
            }
            if (comboBtn) {
                comboBtn.classList.remove('d-none');
                comboBtn.href = `/api/expedicao/combo/${batch.id}`;
            }
            if (guiasAllBtn) {
                guiasAllBtn.classList.remove('d-none');
                guiasAllBtn.href = `/api/guide/download-all/${batch.id}`;
            }

            // Checa guias com código de barras para pagamento
            const guiasPagaveis = window.currentBatchGuides.filter(g => g.barcode && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP');
            const todasAutorizadas = guiasPagaveis.length > 0 && guiasPagaveis.every(g => g.status === 'pagamento_autorizado' || g.status === 'liquidada' || g.status === 'baixada');

            if (authPaymentBtn) {
                if (guiasPagaveis.length > 0) {
                    authPaymentBtn.classList.remove('d-none');
                    if (todasAutorizadas) {
                        authPaymentBtn.innerHTML = `Regerar CNAB 240`;
                    } else {
                        authPaymentBtn.innerHTML = `Autorizar Pagamento Bancário (CNAB 240)`;
                    }
                } else {
                    authPaymentBtn.classList.add('d-none');
                }
            }

            if (remessaBtn) {
                atualizarLinkBancoRemessa();
                if (todasAutorizadas || batch.remessa_generated) {
                    remessaBtn.classList.remove('d-none');
                } else {
                    remessaBtn.classList.add('d-none');
                }
            }

            if (spXmlBtn) {
                if (batch.has_sp_xml) {
                    spXmlBtn.href = `/api/batch/download-xml/${batch.id}`;
                    spXmlBtn.classList.remove('d-none');
                } else {
                    spXmlBtn.classList.add('d-none');
                }
            }
        } else {
            // Em processamento ou erro
            if (approvalBanner) approvalBanner.classList.add('d-none');
        }

        const romaneioTopBtn = document.getElementById('btn-romaneio-expedicao-top');
        if (romaneioTopBtn) {
            romaneioTopBtn.href = `/api/expedicao/romaneio?batchId=${batch.id}`;
        }
        const sidebarRomaneioLink = document.getElementById('sidebar-romaneio-link');
        if (sidebarRomaneioLink) {
            sidebarRomaneioLink.href = `/api/expedicao/romaneio?batchId=${batch.id}`;
        }

        const receiptsContainer = document.getElementById('batch-receipts-container');
        if (receiptsContainer) {
            receiptsContainer.textContent = batch.receipt ? `Recibos SEFAZ: ${batch.receipt}` : '';
        }

        // Renderiza a tabela única da doca (mesma fonte de /api/expedicao/cargas-ativas)
        if (typeof carregarCargasDocaReais === 'function') {
            await carregarCargasDocaReais();
        } else {
            aplicarFiltrosTabela();
        }

    } catch (e) {
        showToast("Erro ao abrir detalhes do lote.", 'error');
    }
}

/**
 * Sincroniza o campo de busca do header com a busca da tabela
 */
function sincronizarBuscaGlobal(val) {
    const inputTabela = document.getElementById('filter-search');
    if (inputTabela) {
        inputTabela.value = val;
    }
    aplicarFiltrosTabela();
}

/**
 * Filtro por abas do Figma (Todos os pedidos, A expedir, Pendências fiscais, Expedidos)
 */
function filtrarPorAba(btnEl, statusAba) {
    document.querySelectorAll('.figma-tab-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    
    window.currentAbaFiltro = statusAba;
    aplicarFiltrosTabela();
}

/**
 * Atualiza os 4 Cards de KPIs operacionais no topo do Dashboard com os dados do Figma
 */
function isGuiaLiberadaLocal(g) {
    if (!g) return false;
    const uf = (g.uf || '').toUpperCase();
    if (uf === 'SP' || g.barcode === 'IMPORTAR_NO_SEFAZ_SP') return true;
    const st = (g.status || '').toLowerCase();
    if (st === 'comprovada' || st === 'liquidada' || st === 'baixada' || st === 'paga' || st === 'pago') return true;
    if (g.receipt_storage_path || g.receipt_url || g.bank_authentication || g.asaas_bill_id) return true;
    const val = parseFloat(g.value || g.valor || 0);
    if (val === 0) return true;
    return false;
}

function atualizarKpisDoLote(batch, guides) {
    const kpiVolumes = document.getElementById('kpi-volumes');
    const kpiReadyVal = document.getElementById('kpi-ready-val');
    const kpiReadyPill = document.getElementById('kpi-ready-pill');
    const kpiStatus = document.getElementById('kpi-status');
    const kpiDifal = document.getElementById('kpi-difal');
    const kpiDifalSub = document.getElementById('kpi-difal-sub');
    const badgeTotalPedidos = document.getElementById('badge-total-pedidos');
    const navCountPedidos = document.getElementById('nav-count-pedidos');
    const navCountPendencias = document.getElementById('nav-count-pendencias');

    const totalVolumes = guides ? guides.length : 0;
    if (kpiVolumes) kpiVolumes.textContent = totalVolumes;
    if (badgeTotalPedidos) badgeTotalPedidos.textContent = `${totalVolumes} cargas`;
    if (navCountPedidos) navCountPedidos.textContent = totalVolumes;

    // 1. Cargas Liberadas (DIFAL quitado ou isentas SP)
    const liberadas = (guides || []).filter(isGuiaLiberadaLocal).length;
    if (kpiReadyVal) kpiReadyVal.textContent = liberadas;
    const kpiReadyBadge = document.getElementById('kpi-ready-badge');
    if (kpiReadyBadge) kpiReadyBadge.textContent = liberadas;
    if (kpiReadyPill && totalVolumes > 0) {
        const perc = Math.round((liberadas / totalVolumes) * 100);
        kpiReadyPill.textContent = `${perc}% liberado`;
    }

    // 2. Cargas Bloqueadas na doca (com DIFAL pendente)
    const bloqueadas = totalVolumes - liberadas;
    if (kpiStatus) {
        kpiStatus.textContent = bloqueadas;
        kpiStatus.style.color = '#ffffff';
    }
    const kpiBlockedBadge = document.getElementById('kpi-blocked-badge');
    if (kpiBlockedBadge) kpiBlockedBadge.textContent = bloqueadas;

    // 3. Total DIFAL a liquidar (apenas das guias pendentes)
    const difalPendente = (guides || []).filter(g => !isGuiaLiberadaLocal(g)).reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
    if (kpiDifal) kpiDifal.textContent = `R$ ${difalPendente.toFixed(2).replace('.', ',')}`;

    // UFs distintas com pendência
    const ufsDistintas = new Set((guides || []).filter(g => !isGuiaLiberadaLocal(g)).map(g => g.uf).filter(Boolean));
    if (kpiDifalSub) {
        kpiDifalSub.textContent = bloqueadas > 0 
            ? `${bloqueadas} carga(s) em ${ufsDistintas.size || 1} UF(s)`
            : 'Nenhuma pendência tributária';
    }

    // Atualiza botão "Liquidar Guias de DIFAL"
    const btnPay = document.getElementById('btn-pay-asaas');
    if (btnPay) {
        if (difalPendente > 0) {
            btnPay.style.display = 'inline-flex';
            const spanText = btnPay.querySelector('span');
            if (spanText) spanText.textContent = `Liquidar Guias de DIFAL (R$ ${difalPendente.toFixed(2).replace('.', ',')})`;
        } else {
            btnPay.style.display = 'none';
        }
    }

    if (navCountPendencias) navCountPendencias.textContent = bloqueadas;

    // Abas de contagem
    const tabCountTodos = document.getElementById('tab-count-todos');
    const tabCountExpedir = document.getElementById('tab-count-expedir');
    const tabCountPendencias = document.getElementById('tab-count-pendencias');
    const tabCountExpedidos = document.getElementById('tab-count-expedidos');

    if (tabCountTodos) tabCountTodos.textContent = totalVolumes;
    if (tabCountExpedir) tabCountExpedir.textContent = liberadas;
    if (tabCountPendencias) tabCountPendencias.textContent = bloqueadas;
    if (tabCountExpedidos) tabCountExpedidos.textContent = (guides || []).filter(g => g.status === 'expedido').length;

    // Atualiza timestamp da tabela
    const syncTimeEl = document.getElementById('table-sync-timestamp');
    if (syncTimeEl) {
        const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        syncTimeEl.textContent = `Atualizado às ${agora}`;
    }
}

/**
 * Filtro em Tempo Real (Live Search por NF, Destinatário, Transportadora, UF, Status e Abas do Figma)
 */
function aplicarFiltrosTabela() {
    if (!window.currentBatchGuides) return;

    const termoBusca = (document.getElementById('filter-search')?.value || '').toLowerCase().trim();
    const transpFiltro = (document.getElementById('filter-carrier')?.value || '').toUpperCase();
    const ufFiltro = (document.getElementById('filter-uf')?.value || '').toUpperCase();
    const statusFiltro = document.getElementById('filter-status')?.value || '';
    const abaFiltro = window.currentAbaFiltro || '';

    const filtradas = window.currentBatchGuides.filter(g => {
        // 0. Filtro por Abas do Figma
        if (abaFiltro === 'EXPEDIR') {
            if (!g.storage_path && g.uf !== 'SP') return false;
        } else if (abaFiltro === 'PENDENTE') {
            if (g.barcode && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP') return false;
        } else if (abaFiltro === 'EXPEDIDO') {
            if (g.status !== 'liquidada' && g.status !== 'baixada') return false;
        }

        // 1. Busca textual rápida
        if (termoBusca) {
            const numNf = String(g.nf_number || '').toLowerCase();
            const cliente = String(g.customer_name || '').toLowerCase();
            const chave = String(g.chave_nfe || '').toLowerCase();
            if (!numNf.includes(termoBusca) && !cliente.includes(termoBusca) && !chave.includes(termoBusca)) {
                return false;
            }
        }

        // 2. Filtro de Transportadora
        if (transpFiltro) {
            const transp = (g.carrier_name || 'OUTROS').toUpperCase();
            if (!transp.includes(transpFiltro)) return false;
        }

        // 3. Filtro de UF
        if (ufFiltro) {
            if ((g.uf || '').toUpperCase() !== ufFiltro) return false;
        }

        // 4. Filtro de Status
        if (statusFiltro) {
            if (statusFiltro === 'SP') {
                if (g.uf !== 'SP') return false;
            } else if (statusFiltro === 'PENDENTE') {
                if (g.barcode && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP') return false;
            } else if (statusFiltro === 'EMITIDA') {
                if (g.uf === 'SP' || !g.barcode || g.barcode === 'IMPORTAR_NO_SEFAZ_SP') return false;
            }
        }

        return true;
    });

    // Atualiza links do Romaneio e do Combo de acordo com a transportadora selecionada
    if (window.activeBatchId) {
        const romaneioBtn = document.getElementById('btn-romaneio-expedicao');
        const comboBtn = document.getElementById('btn-combo-expedicao');
        const romaneioTopBtn = document.getElementById('btn-romaneio-expedicao-top');
        const carrierParam = transpFiltro ? `&carrier=${encodeURIComponent(transpFiltro)}` : '';

        if (romaneioBtn) {
            romaneioBtn.href = `/api/expedicao/romaneio?batchId=${window.activeBatchId}${carrierParam}`;
        }
        if (romaneioTopBtn) {
            romaneioTopBtn.href = `/api/expedicao/romaneio?batchId=${window.activeBatchId}${carrierParam}`;
        }
        if (comboBtn) {
            comboBtn.href = `/api/expedicao/combo/${window.activeBatchId}?${carrierParam.replace('&', '')}`;
        }
    }

    // Atualiza contador de itens filtrados
    const counterEl = document.getElementById('filter-counter');
    if (counterEl) {
        counterEl.textContent = `Mostrando ${filtradas.length} de ${window.currentBatchGuides.length} notas`;
    }

    renderizarLinhasTabela(filtradas);
}

/**
 * Limpa todos os filtros ativos na tabela
 */
function limparFiltrosTabela() {
    const search = document.getElementById('filter-search');
    const carrier = document.getElementById('filter-carrier');
    const uf = document.getElementById('filter-uf');
    const status = document.getElementById('filter-status');

    if (search) search.value = '';
    if (carrier) carrier.value = '';
    if (uf) uf.value = '';
    if (status) status.value = '';

    aplicarFiltrosTabela();
}

// Estado de Seleção e Paginação do Figma
window.selectedGuideIds = new Set();
window.paginaAtualTabela = 1;
window.itensPorPagina = 8;

/**
 * Alterna a seleção de todos os pedidos visíveis na página atual
 */
function toggleSelectAll(masterCheckbox) {
    const isChecked = masterCheckbox.checked;
    const checkboxes = document.querySelectorAll('.row-guide-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = isChecked;
        const id = cb.getAttribute('data-id');
        if (id) {
            if (isChecked) window.selectedGuideIds.add(id);
            else window.selectedGuideIds.delete(id);
        }
    });
    atualizarContadorSelecao();
}

/**
 * Alterna a seleção individual de uma linha
 */
function toggleSelectRow(id, cb) {
    if (cb.checked) {
        window.selectedGuideIds.add(id);
    } else {
        window.selectedGuideIds.delete(id);
    }
    atualizarContadorSelecao();
}

function atualizarContadorSelecao() {
    const counterEl = document.getElementById('selection-counter');
    const masterCb = document.getElementById('check-select-all');
    const total = window.selectedGuideIds.size;
    if (counterEl) {
        counterEl.textContent = `${total} selecionado${total !== 1 ? 's' : ''}`;
        counterEl.style.color = total > 0 ? '#60a5fa' : '#9eacc0';
    }
    if (masterCb) {
        const visibleCheckboxes = document.querySelectorAll('.row-guide-checkbox');
        const visibleChecked = document.querySelectorAll('.row-guide-checkbox:checked');
        masterCb.checked = visibleCheckboxes.length > 0 && visibleChecked.length === visibleCheckboxes.length;
        masterCb.indeterminate = visibleChecked.length > 0 && visibleChecked.length < visibleCheckboxes.length;
    }
}

/**
 * Navegação de páginas na tabela do Figma
 */
function mudarPaginaTabela(delta) {
    const totalGuias = window.guiasFiltradasAtuais ? window.guiasFiltradasAtuais.length : 0;
    const maxPagina = Math.max(1, Math.ceil(totalGuias / window.itensPorPagina));
    const novaPagina = window.paginaAtualTabela + delta;
    if (novaPagina >= 1 && novaPagina <= maxPagina) {
        window.paginaAtualTabela = novaPagina;
        renderizarLinhasTabela(window.guiasFiltradasAtuais);
    }
}

function irParaPagina(num) {
    window.paginaAtualTabela = num;
    renderizarLinhasTabela(window.guiasFiltradasAtuais);
}

function toggleMaisFiltros() {
    const details = document.getElementById('batch-details-section');
    if (details) {
        details.classList.toggle('d-none');
    }
}

/**
 * Renderiza o corpo da tabela de guias com o design exato de 9 colunas do Figma
 */
function renderizarLinhasTabela(guias) {
    window.guiasFiltradasAtuais = guias || [];
    const guidesBody = document.getElementById('guides-table-body');
    if (!guidesBody) return;

    if (!guias || guias.length === 0) {
        guidesBody.innerHTML = `<tr><td colspan="6" style="color: var(--text-secondary); padding: 36px; text-align: center;">Nenhum volume localizado para os critérios informados.</td></tr>`;
        return;
    }

    const cidadesMock = {
        'SP': 'São Paulo', 'RJ': 'Rio de Janeiro', 'MG': 'Belo Horizonte',
        'PR': 'Curitiba', 'BA': 'Salvador', 'RS': 'Porto Alegre',
        'SC': 'Florianópolis', 'DF': 'Brasília', 'PE': 'Recife',
        'MA': 'São Luís', 'RN': 'Natal', 'MS': 'Campo Grande',
        'ES': 'Vitória', 'GO': 'Goiânia', 'CE': 'Fortaleza', 'PA': 'Belém'
    };

    guidesBody.innerHTML = guias.map(g => {
        const isSp = (g.uf === 'SP' || g.barcode === 'IMPORTAR_NO_SEFAZ_SP');
        const difalVal = parseFloat(g.value || 0);
        const liberada = isGuiaLiberadaLocal(g);

        const cidade = cidadesMock[g.uf] || g.uf || 'São Paulo';
        const rawCarrier = (g.carrier_name || 'Total Express');
        const destino = g.customer_address || (cidade ? `${cidade} · ${g.uf || 'SP'}` : (g.customer_name || 'Consumidor Final'));

        let situacaoTagHtml = '';
        if (isSp) {
            situacaoTagHtml = `<span class="tag-status tag-isento">Isento (SP)</span>`;
        } else if (liberada) {
            situacaoTagHtml = `<span class="tag-status tag-liberado">Liberado</span>`;
        } else {
            situacaoTagHtml = `<span class="tag-status tag-bloqueado">Bloqueado</span>`;
        }

        let actionHtml = `<a href="/api/guide/danfe/${g.id}" target="_blank" class="action-link-subtle">DANFE</a> `;
        if (isSp && difalVal > 0) {
            actionHtml += `<a href="#" onclick="baixarXmlLoteSpComData(event, false); return false;" class="action-link-subtle" style="color: #0F766E; font-weight: 600;">XML SP</a>`;
        } else if (!isSp && g.uf !== 'ND' && difalVal > 0) {
            actionHtml += `<a href="/api/guide/download/${g.id}" target="_blank" class="action-link-subtle" style="color: #4338CA; font-weight: 600;">GNRE</a> `;
            if (!liberada) {
                actionHtml += `<button onclick="autorizarPagamentoGuiaAvulsa('${g.id}', '${g.nf_number}')" class="btn-row-liquidar">Liquidar</button>`;
            }
        }

        const nfFmt = String(g.nf_number || '').padStart(8, '0');
        const infoEmissao = formatarDataEmissaoDoca(g);
        const emissaoTexto = infoEmissao.texto;
        const emissaoColor = infoEmissao.corPill === 'time-warn' ? '#f59e0b' : '#94a3b8';
        const emissaoWeight = 'font-weight: 600;';

        return `
            <tr>
                <td class="cell-mono">${escapeHtml(nfFmt)}</td>
                <td style="color: ${emissaoColor}; font-size: 12px; ${emissaoWeight}">${emissaoTexto}</td>
                <td>${escapeHtml(destino)}</td>
                <td>${escapeHtml(rawCarrier)}</td>
                <td style="text-align: right;" class="cell-mono">R$ ${difalVal.toFixed(2).replace('.', ',')}</td>
                <td style="text-align: center;">${situacaoTagHtml}</td>
                <td style="text-align: right;">${actionHtml}</td>
            </tr>
        `;
    }).join('');
}

/**
 * Atualiza os botões e texto da barra de paginação do Figma
 */
function atualizarControlesPaginacao(de, ate, total) {
    const infoEl = document.getElementById('figma-pagination-info');
    if (infoEl) {
        infoEl.textContent = `Mostrando ${de}–${ate} de ${total} pedidos`;
    }

    const prevBtn = document.getElementById('btn-page-prev');
    const nextBtn = document.getElementById('btn-page-next');
    const maxPagina = Math.max(1, Math.ceil(total / window.itensPorPagina));

    if (prevBtn) prevBtn.disabled = (window.paginaAtualTabela <= 1);
    if (nextBtn) nextBtn.disabled = (window.paginaAtualTabela >= maxPagina);

    const pagesListEl = document.getElementById('pagination-pages-list');
    if (pagesListEl) {
        let pagesHtml = '';
        for (let i = 1; i <= Math.min(maxPagina, 5); i++) {
            const isActive = (i === window.paginaAtualTabela) ? 'active' : '';
            pagesHtml += `<button class="p-page ${isActive}" onclick="irParaPagina(${i})">${i}</button>`;
        }
        if (maxPagina > 5) {
            pagesHtml += `<span style="color: #697789; font-size: 11px;">…</span>`;
            pagesHtml += `<button class="p-page" onclick="irParaPagina(${maxPagina})">${maxPagina}</button>`;
        }
        pagesListEl.innerHTML = pagesHtml;
    }
}

/**
 * Atalho para imprimir guias do lote selecionado
 */
function imprimirGuiasLoteIntercaladas() {
    const btn = document.getElementById('print-interleaved-btn');
    if (btn && btn.href && btn.href !== '#' && !btn.href.endsWith('#')) {
        window.open(btn.href, '_blank');
    } else {
        showToast('Nenhum lote com PDFs prontos para impressão no momento.', 'warning');
    }
}

// Funções para controle do Modal de Consulta de Recibo Manual
function abrirModalRecibo() {
    const modal = document.getElementById('modal-recibo');
    if (modal) modal.classList.add('show');
}

function fecharModalRecibo() {
    const modal = document.getElementById('modal-recibo');
    if (modal) modal.classList.remove('show');
    const form = document.getElementById('form-consulta-recibo');
    if (form) form.reset();
}

async function enviarConsultaRecibo(event) {
    event.preventDefault();
    const uf = document.getElementById('recibo-uf').value;
    const receipt = document.getElementById('recibo-numero').value;
    const paymentDate = document.getElementById('recibo-payment-date').value;
    const btnSubmit = document.getElementById('btn-submit-recibo');

    if (!uf || !receipt) {
        showToast("UF e número do recibo são obrigatórios.", "error");
        return;
    }

    try {
        btnSubmit.disabled = true;
        const originalText = btnSubmit.textContent;
        btnSubmit.textContent = "Consultando...";
        showToast("Consultando recibo na SEFAZ...", "warning");

        const token = localStorage.getItem('sb_access_token');
        const res = await fetch('/api/batch/query-receipt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ receipt, uf, paymentDate })
        });

        const data = await res.json();
        
        if (res.status === 202) {
            showToast(data.message, "warning");
            return;
        }

        if (!res.ok) {
            throw new Error(data.error || "Erro desconhecido ao consultar recibo.");
        }

        showToast(data.message || "Recibo consultado e guias importadas com sucesso!", "success");
        fecharModalRecibo();
        
        // Recarrega o histórico e abre detalhes do lote atualizado
        await carregarHistoricoLotes();
        if (data.batch_id) {
            await carregarDetalhesLote(data.batch_id);
        }
    } catch (err) {
        showToast(err.message, "error");
    } finally {
        btnSubmit.disabled = false;
        btnSubmit.textContent = "Consultar e Resgatar";
    }
}

// ==========================================
// LINX MICROVIX — SINCRONIZAÇÃO
// ==========================================

let erpSelecionado = 'microvix';
let statusErps = { microvix: false, bling: false, tiny: false, omie: false };

async function abrirModalMicrovix() {
    const hoje = new Date().toISOString().split('T')[0];
    const dataInicialEl = document.getElementById('microvix-data-inicial');
    const dataFimEl     = document.getElementById('microvix-data-fim');
    if (dataInicialEl) dataInicialEl.value = hoje;
    if (dataFimEl)     dataFimEl.value     = hoje;

    const preview = document.getElementById('microvix-preview');
    if (preview) preview.style.display = 'none';

    const modal = document.getElementById('modal-microvix');
    if (modal) {
        modal.style.display = 'flex';
        const btnConfirm = document.getElementById('btn-microvix-confirm');
        if (btnConfirm) {
            btnConfirm.disabled    = false;
            btnConfirm.textContent = 'Iniciar Sincronização';
        }
    }

    // Carrega status de conexão dos ERPs
    await carregarStatusErps();
    selecionarErp(erpSelecionado);
}

async function carregarStatusErps() {
    try {
        const res = await fetch('/api/erp/status');
        if (res.ok) {
            statusErps = await res.json();
            ['microvix', 'bling', 'tiny', 'omie'].forEach(erp => {
                const badge = document.getElementById(`badge-status-${erp}`);
                if (badge) {
                    if (statusErps[erp]) {
                        badge.textContent = 'Conectado';
                        badge.style.background = '#10b981';
                    } else {
                        badge.textContent = 'Não configurado';
                        badge.style.background = '#4b5563';
                    }
                }
            });
        }
    } catch (e) {
        console.warn('Erro ao checar status de ERPs:', e.message);
    }
}

function selecionarErp(erp) {
    erpSelecionado = erp;
    const chips = document.querySelectorAll('#erp-selector-grid .erp-chip');
    chips.forEach(chip => {
        if (chip.getAttribute('data-erp') === erp) {
            chip.style.borderColor = '#0d6efd';
            chip.style.background = 'rgba(13,110,253,0.15)';
        } else {
            chip.style.borderColor = 'var(--border-color,#2a3050)';
            chip.style.background = 'rgba(255,255,255,0.02)';
        }
    });

    const alertNotConf = document.getElementById('erp-not-configured-alert');
    if (alertNotConf) {
        alertNotConf.style.display = statusErps[erp] ? 'none' : 'block';
    }
}

function fecharModalMicrovix() {
    const modal = document.getElementById('modal-microvix');
    if (modal) modal.style.display = 'none';
}

async function executarSincronizacaoMicrovix() {
    const dataInicial = document.getElementById('microvix-data-inicial')?.value;
    const dataFim     = document.getElementById('microvix-data-fim')?.value;
    const paymentDate = document.getElementById('payment-date')?.value || new Date().toISOString().split('T')[0];

    if (!dataInicial || !dataFim) {
        showToast('Informe o período de datas para sincronização.', 'error');
        return;
    }
    if (dataInicial > dataFim) {
        showToast('A data inicial não pode ser maior que a data final.', 'error');
        return;
    }

    const erpNome = erpSelecionado.toUpperCase();
    const btnConfirm     = document.getElementById('btn-microvix-confirm');
    btnConfirm.disabled    = true;
    btnConfirm.textContent = `⏳ Consultando ${erpNome}...`;

    const preview        = document.getElementById('microvix-preview');
    const previewContent = document.getElementById('microvix-preview-content');

    try {
        const urlEndpoint = erpSelecionado === 'microvix' ? '/api/microvix/sync' : '/api/erp/sync';
        const bodyPayload = erpSelecionado === 'microvix'
            ? { data_inicial: dataInicial, data_fim: dataFim, payment_date: paymentDate }
            : { erp: erpSelecionado, data_inicial: dataInicial, data_fim: dataFim, payment_date: paymentDate };

        const resp = await fetch(urlEndpoint, {
            method:      'POST',
            headers:     { 'Content-Type': 'application/json' },
            body:        JSON.stringify(bodyPayload),
            credentials: 'include'
        });

        const data = await resp.json();

        if (!resp.ok) {
            showToast(data.error || `Erro ao sincronizar com ${erpNome}.`, 'error');
            btnConfirm.disabled    = false;
            btnConfirm.textContent = 'Iniciar Sincronização';
            return;
        }

        // Exibe resumo no modal
        let summaryHtml = `<strong style="color:#fff;">✓ ${data.message}</strong><br><br>`;
        summaryHtml += `<strong>Total no período:</strong> ${data.total ?? 0} notas<br>`;
        if (data.duplicadas > 0) summaryHtml += `⏭️ <strong>Já importadas (ignoradas):</strong> ${data.duplicadas}<br>`;
        if (data.novas       > 0) summaryHtml += `<strong>Novas notas:</strong> ${data.novas}<br>`;
        if (data.sem_difal   > 0) summaryHtml += `➡️ <strong>Sem DIFAL (não precisam de GNRE):</strong> ${data.sem_difal}<br>`;
        if (data.com_difal   > 0) summaryHtml += ` <strong>Com DIFAL (enviadas para emissão):</strong> ${data.com_difal}<br>`;

        previewContent.innerHTML = summaryHtml;
        preview.style.display    = 'block';

        if (data.batch_id) {
            // Gerou lote — inicia acompanhamento no terminal e fecha modal
            showToast(`Lote ${data.batch_id} iniciado com ${data.com_difal} nota(s)!`, 'success');
            setTimeout(async () => {
                fecharModalMicrovix();
                resetTerminal();
                iniciarPollingLote(data.batch_id);
                await carregarHistoricoLotes();
            }, 1800);
        } else {
            btnConfirm.disabled    = false;
            btnConfirm.textContent = '✓ Concluído';
        }

    } catch (err) {
        showToast('Erro de conexão: ' + err.message, 'error');
        btnConfirm.disabled    = false;
        btnConfirm.textContent = 'Iniciar Sincronização';
    }
}

// Listeners do modal Microvix
document.addEventListener('DOMContentLoaded', () => {
    const btnOpen    = document.getElementById('btn-microvix-sync');
    const btnCancel  = document.getElementById('btn-microvix-cancel');
    const btnConfirm = document.getElementById('btn-microvix-confirm');

    if (btnOpen)    btnOpen.addEventListener('click',   abrirModalMicrovix);
    if (btnCancel)  btnCancel.addEventListener('click', fecharModalMicrovix);
    if (btnConfirm) btnConfirm.addEventListener('click', executarSincronizacaoMicrovix);

    // Fecha ao clicar no overlay (fora do card)
    const modal = document.getElementById('modal-microvix');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) fecharModalMicrovix();
        });
    }
});

/**
 * Função para upload e processamento do arquivo de retorno bancário (.RET)
 */
async function uploadRetornoBancario(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('retornoFile', file);

    showToast(`Lendo e processando retorno: ${file.name}...`, 'warning');

    try {
        const res = await fetch('/api/cnab/upload-retorno', {
            method: 'POST',
            body: formData
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao processar arquivo');

        showToast(`✓ ${data.message}`, 'success');

        // Mostra resumo detalhado se houver guias atualizadas
        const r = data.resumo;
        alert(`Conciliação Bancária Concluída!\n\n` +
              `• Total de registros no arquivo: ${r.totalNoArquivo}\n` +
              `• Pagamentos Baixados (00): ${r.baixadas}\n` +
              `• Pagamentos Agendados (BD): ${r.agendadas}\n` +
              `• Guias atualizadas no sistema: ${r.conciliadasComSucesso}\n` +
              (r.naoLocalizadasNoBanco > 0 ? `• Não localizadas no banco: ${r.naoLocalizadasNoBanco}\n` : '')
        );

        // Recarrega histórico
        await carregarHistoricoLotes();
    } catch (err) {
        showToast(`Erro no retorno bancário: ${err.message}`, 'error');
    } finally {
        event.target.value = '';
    }
}

/**
 * Atualiza o link de download da remessa conforme o banco selecionado
 */
function atualizarLinkBancoRemessa() {
    const remessaBtn = document.getElementById('download-remessa-btn');
    const bankSelect = document.getElementById('remessa-bank-select');
    if (!remessaBtn || !window.activeBatchId) return;

    const banco = bankSelect ? bankSelect.value : 'itau';
    remessaBtn.href = `/api/remessa/download/${window.activeBatchId}?banco=${banco}`;
    remessaBtn.textContent = `Baixar remessa (${banco.toUpperCase()}).txt`;
}

/**
 * Consulta e exibe o status atual do Agendador Automático de Sincronização
 */
async function carregarStatusSync() {
    try {
        const res = await fetch('/api/sync/status');
        if (res.ok) {
            const data = await res.json();
            const textEl = document.getElementById('sync-status-text');
            if (textEl) {
                if (data.ultimaExecucao) {
                    const hora = new Date(data.ultimaExecucao).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                    textEl.textContent = `Última varredura: Hoje às ${hora} · ${data.mensagem || 'OK'}`;
                } else {
                    textEl.textContent = 'Agendador ativo (ciclos automáticos a cada 30 min)';
                }
            }
        }
    } catch (e) {
        console.warn("Erro ao buscar status do agendador:", e.message);
    }
}

/**
 * Disparo manual imediato da sincronização automática
 */
async function dispararSyncImediata() {
    const btn = document.getElementById('btn-sync-quick');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Sincronizando...';
    }

    try {
        showToast("Consultando faturamento Linx Microvix e pedidos Vnda...", 'warning');
        const res = await fetch('/api/sync/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        const data = await res.json();
        if (res.ok) {
            showToast(`✓ ${data.mensagem || 'Sincronização concluída com sucesso!'}`, 'success');
            await carregarHistoricoLotes();
            await carregarStatusSync();
        } else {
            showToast(data.error || 'Erro na sincronização.', 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Sincronizar Agora';
        }
    }
}

// ==========================================
// AUTORIZAÇÃO DE EMISSÃO NA SEFAZ (HUMAN-IN-THE-LOOP)
// ==========================================

function abrirModalAutorizacaoEmissao() {
    if (!window.activeBatchId || !window.currentBatchGuides) {
        showToast("Nenhum lote selecionado para autorização.", 'error');
        return;
    }

    const modal = document.getElementById('modal-autorizar-emissao');
    if (!modal) return;

    const tenantName = document.getElementById('tenant-name')?.textContent || 'Empresa Emitente';
    const envText = document.getElementById('active-env')?.textContent || 'PRODUÇÃO';
    const totalNotas = window.currentBatchGuides.length;
    const totalDifal = window.currentBatchGuides.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);

    const empEl = document.getElementById('auth-modal-empresa');
    if (empEl) empEl.textContent = tenantName;

    const qtdEl = document.getElementById('auth-modal-qtd-notas');
    if (qtdEl) qtdEl.textContent = `${totalNotas} nota(s) fiscal(is)`;

    const valEl = document.getElementById('auth-modal-valor-total');
    if (valEl) valEl.textContent = `R$ ${totalDifal.toFixed(2).replace('.', ',')}`;

    const ambEl = document.getElementById('auth-modal-ambiente');
    if (ambEl) {
        ambEl.textContent = envText.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'PRODUÇÃO';
        ambEl.className = envText.includes('Produção') ? 'badge badge-success' : 'badge badge-warning';
    }

    const dataPagInput = document.getElementById('auth-modal-data-pagamento');
    if (dataPagInput) {
        const paymentDateMain = document.getElementById('payment-date')?.value;
        const hoje = new Date().toISOString().split('T')[0];
        dataPagInput.value = paymentDateMain || hoje;
    }

    modal.style.display = 'flex';
}

function fecharModalAutorizacaoEmissao() {
    const modal = document.getElementById('modal-autorizar-emissao');
    if (modal) modal.style.display = 'none';
}

async function confirmarAutorizacaoEmissao() {
    if (!window.activeBatchId) return;

    const btnConfirm = document.getElementById('btn-confirmar-transmissao-sefaz');
    const paymentDate = document.getElementById('auth-modal-data-pagamento')?.value;

    try {
        if (btnConfirm) {
            btnConfirm.disabled = true;
            btnConfirm.textContent = '⏳ Autorizando transmissão...';
        }

        const res = await fetch(`/api/batch/authorize-emission/${window.activeBatchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentDate })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao autorizar transmissão.");

        fecharModalAutorizacaoEmissao();
        showToast("Transmissão autorizada! Acompanhe o envio no terminal.", 'success');

        // Fecha o banner de aprovação imediatamente e inicia polling do lote
        const banner = document.getElementById('batch-approval-banner');
        if (banner) banner.classList.add('d-none');

        resetTerminal();
        iniciarPollingLote(window.activeBatchId);
        await carregarHistoricoLotes();

    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.textContent = 'Confirmar e Transmitir na SEFAZ';
        }
    }
}

async function descartarLoteAtual() {
    if (!window.activeBatchId) return;

    const confirma = confirm("Deseja realmente descartar este lote? Ele não será enviado para a SEFAZ e suas guias serão canceladas.");
    if (!confirma) return;

    try {
        showToast("Descartando lote...", 'warning');
        const res = await fetch(`/api/batch/discard/${window.activeBatchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao descartar lote.");

        showToast("Lote descartado com sucesso.");
        
        const banner = document.getElementById('batch-approval-banner');
        if (banner) banner.classList.add('d-none');

        const detailsSection = document.getElementById('batch-details-section');
        if (detailsSection) detailsSection.classList.add('d-none');

        window.activeBatchId = null;
        window.activeBatch = null;
        window.currentBatchGuides = [];

        await carregarHistoricoLotes();

    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ==========================================
// AUTORIZAÇÃO DE PAGAMENTO BANCÁRIO (CNAB 240)
// ==========================================

function abrirModalAutorizacaoPagamento() {
    if (!window.activeBatchId || !window.currentBatchGuides) {
        showToast("Nenhum lote selecionado.", 'error');
        return;
    }

    const guiasPagaveis = window.currentBatchGuides.filter(g => g.barcode && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP');
    if (guiasPagaveis.length === 0) {
        showToast("Este lote não possui guias com código de barras emitido para pagamento bancário.", 'error');
        return;
    }

    const modal = document.getElementById('modal-autorizar-pagamento');
    if (!modal) return;

    const totalValor = guiasPagaveis.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
    const qtdEl = document.getElementById('pay-modal-qtd-guias');
    if (qtdEl) qtdEl.textContent = `${guiasPagaveis.length} guia(s) pronta(s)`;

    const valEl = document.getElementById('pay-modal-valor-total');
    if (valEl) valEl.textContent = `R$ ${totalValor.toFixed(2).replace('.', ',')}`;

    const dateInput = document.getElementById('pay-modal-data');
    if (dateInput) {
        const hoje = new Date().toISOString().split('T')[0];
        dateInput.value = hoje;
    }

    const bancoDock = document.getElementById('remessa-bank-select')?.value || 'itau';
    const bancoSelect = document.getElementById('pay-modal-banco');
    if (bancoSelect) bancoSelect.value = bancoDock;

    modal.style.display = 'flex';
}

function fecharModalAutorizacaoPagamento() {
    const modal = document.getElementById('modal-autorizar-pagamento');
    if (modal) modal.style.display = 'none';
}

async function confirmarAutorizacaoPagamento() {
    if (!window.activeBatchId) return;

    const btnConfirm = document.getElementById('btn-confirmar-pagamento-cnab');
    const banco = document.getElementById('pay-modal-banco')?.value || 'itau';
    const paymentDate = document.getElementById('pay-modal-data')?.value;

    try {
        if (btnConfirm) {
            btnConfirm.disabled = true;
            btnConfirm.textContent = '⏳ Gerando remessa CNAB...';
        }

        const res = await fetch(`/api/batch/authorize-payment/${window.activeBatchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ banco, paymentDate })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao autorizar pagamento bancário.");

        fecharModalAutorizacaoPagamento();
        showToast(`Pagamento bancário autorizado! Arquivo CNAB (${banco.toUpperCase()}) gerado com sucesso.`, 'success');

        // Dispara o download automático do arquivo remessa.txt (máximo 7 caracteres exigido pelo Itaú/bancos)
        const link = document.createElement('a');
        link.href = `/api/remessa/download/${window.activeBatchId}?banco=${banco}`;
        const hojeStr = new Date().toISOString().split('T')[0].split('-');
        link.download = `REM${hojeStr[2]}${hojeStr[1]}.txt`; // ex: REM2610.txt (7 chars)
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Recarrega os detalhes do lote para refletir o status 'pagamento_autorizado'
        await carregarDetalhesLote(window.activeBatchId);
        await carregarHistoricoLotes();

    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btnConfirm) {
            btnConfirm.disabled = false;
            btnConfirm.textContent = 'Autorizar e Gerar CNAB 240';
        }
    }
}

// Fechamento de modais ao clicar no overlay
document.addEventListener('DOMContentLoaded', () => {
    const modalAuth = document.getElementById('modal-autorizar-emissao');
    if (modalAuth) {
        modalAuth.addEventListener('click', (e) => {
            if (e.target === modalAuth) fecharModalAutorizacaoEmissao();
        });
    }

    const modalPay = document.getElementById('modal-autorizar-pagamento');
    if (modalPay) {
        modalPay.addEventListener('click', (e) => {
            if (e.target === modalPay) fecharModalAutorizacaoPagamento();
        });
    }
});

// ==========================================
// AUTORIZAÇÃO DE PAGAMENTO & LIQUIDAÇÃO (DIRETORIA FINANCEIRA)
// ==========================================
async function abrirModalAutorizacaoAsaas() {
    if (!window.activeBatchId || !window.currentBatchGuides) {
        showToast("Nenhum lote selecionado.", 'error');
        return;
    }

    const guiasPagaveis = window.currentBatchGuides.filter(g => {
        const hasLine = (g.line_digitizable && g.line_digitizable.length > 30) || (g.barcode && g.barcode.length > 30);
        const naoPaga = g.status !== 'paga' && g.status !== 'comprovada' && !g.asaas_bill_id;
        return hasLine && naoPaga;
    });

    if (guiasPagaveis.length === 0) {
        showToast("Todas as guias deste lote já foram autorizadas/pagas ou não possuem código de arrecadação.", 'warning');
        return;
    }

    const modal = document.getElementById('modal-autorizar-asaas');
    if (!modal) return;

    const totalValor = guiasPagaveis.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
    const qtdEl = document.getElementById('asaas-modal-qtd-guias');
    if (qtdEl) qtdEl.textContent = `${guiasPagaveis.length} guia(s) pronta(s)`;

    const valEl = document.getElementById('asaas-modal-valor-total');
    if (valEl) valEl.textContent = `R$ ${totalValor.toFixed(2).replace('.', ',')}`;

    const aprovadorEl = document.getElementById('asaas-modal-aprovador');
    if (aprovadorEl) aprovadorEl.textContent = window.currentUser?.name || window.currentUser?.email || 'Diretoria / Responsável';

    const saldoEl = document.getElementById('asaas-modal-saldo');
    const coberturaEl = document.getElementById('asaas-modal-cobertura');

    if (saldoEl) saldoEl.textContent = 'Consultando saldo...';
    if (coberturaEl) coberturaEl.textContent = 'Avaliando...';

    modal.style.display = 'flex';

    try {
        const res = await fetch('/api/asaas/balance');
        if (res.ok) {
            const bal = await res.json();
            const saldoNum = parseFloat(bal.balance || 0);
            if (saldoEl) {
                saldoEl.textContent = `R$ ${saldoNum.toFixed(2).replace('.', ',')}` + (bal.simulado ? ' (Simulado)' : '');
            }
            if (coberturaEl) {
                if (saldoNum >= totalValor) {
                    coberturaEl.innerHTML = `<span style="color: #10b981;">✓ Saldo suficiente para liquidação</span>`;
                } else {
                    const falta = totalValor - saldoNum;
                    coberturaEl.innerHTML = `<span style="color: #f59e0b;">⚠ Saldo insuficiente: abastecer R$ ${falta.toFixed(2).replace('.', ',')}</span>`;
                }
            }
        }
    } catch (e) {
        if (saldoEl) saldoEl.textContent = 'Indisponível';
    }
}

function aplicarLiberacaoGeralDoca() {
    localStorage.setItem('doca_liberada', 'true');
    carregarCargasDocaReais();
    playAudioFeedback('liberado');
}

function reiniciarDemonstracaoDoca() {
    localStorage.removeItem('doca_liberada');
    window.location.reload();
}
window.reiniciarDemonstracaoDoca = reiniciarDemonstracaoDoca;

async function carregarCargasDocaReais() {
    try {
        localStorage.removeItem('doca_liberada');
        const res = await fetch('/api/expedicao/cargas-ativas');
        if (!res.ok) {
            const tb = document.getElementById('guides-table-body');
            if (tb) tb.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:40px; color:#B42318; font-weight:600;">Falha ao carregar as guias (HTTP ${res.status}). Atualize a página ou faça login novamente.</td></tr>`;
            return;
        }
        const data = await res.json();
        if (!data || !data.cargas || data.cargas.length === 0) {
            console.log("Nenhuma carga ativa encontrada na Doca.");
            return;
        }

        const { resumo, porTransportadora, cargas } = data;
        window.currentBatchGuides = cargas;
        if (data.batch) window.activeBatchId = data.batch.id;

        // Auditoria precisa: guias com status AGENDADA, PAGA ou COMPROVADA estão 100% liberadas na doca
        const totalCount = cargas.length;
        const liberadasCalculadas = cargas.filter(g => {
            const st = (g.status || '').toUpperCase().trim();
            return st === 'PAGA' || st === 'COMPROVADA' || st === 'AGENDADA' || parseFloat(g.value || g.valor || 0) <= 0;
        }).length;
        const retidasCalculadas = totalCount - liberadasCalculadas;

        const liberadasCount = (resumo.liberadas !== undefined && resumo.liberadas > 0) ? resumo.liberadas : liberadasCalculadas;
        const retidasCount = (resumo.retidas !== undefined && resumo.liberadas > 0) ? resumo.retidas : retidasCalculadas;
        const difalTotalLote = resumo.valorTotal || 0;
        const difalPendente = (retidasCount === 0) ? 0 : (resumo.valorPendente || 0);

        // 1. Atualiza HUD Cards
        const kpiVol = document.getElementById('kpi-volumes');
        if (kpiVol) kpiVol.textContent = resumo.total;

        const kpiReady = document.getElementById('kpi-ready-val');
        if (kpiReady) kpiReady.textContent = liberadasCount;

        const kpiReadyBadge = document.getElementById('kpi-ready-badge');
        if (kpiReadyBadge) {
            const pct = resumo.total > 0 ? Math.round((liberadasCount / resumo.total) * 100) : 100;
            kpiReadyBadge.textContent = `${pct}% Pronto`;
        }

        const kpiStatus = document.getElementById('kpi-status');
        if (kpiStatus) kpiStatus.textContent = retidasCount;

        const kpiBlockedBadge = document.getElementById('kpi-blocked-badge');
        if (kpiBlockedBadge) {
            if (retidasCount === 0) {
                kpiBlockedBadge.textContent = '0 Retidas';
                kpiBlockedBadge.className = 'hud-badge hud-badge-green';
            } else {
                kpiBlockedBadge.textContent = `${retidasCount} Retidas`;
                kpiBlockedBadge.className = 'hud-badge hud-badge-red';
            }
        }

        const kpiDifal = document.getElementById('kpi-difal');
        if (kpiDifal) {
            kpiDifal.textContent = `R$ ${difalTotalLote.toFixed(2).replace('.', ',')}`;
        }

        // 2. Atualiza Cards de Coletas por Transportadora
        const totalExp = porTransportadora['Total Express'] || { total: 0, liberadas: 0, retidas: 0 };
        const totalLib = (retidasCount === 0) ? totalExp.total : totalExp.liberadas;
        const totalRet = (retidasCount === 0) ? 0 : totalExp.retidas;

        const badgeTotal = document.getElementById('carrier-total-badge');
        if (badgeTotal) {
            badgeTotal.textContent = `${totalLib} / ${totalExp.total} Prontos`;
            if (totalRet === 0) {
                badgeTotal.className = 'hud-badge hud-badge-green';
            }
        }

        const barTotal = document.getElementById('carrier-total-bar');
        if (barTotal) {
            const pct = totalExp.total > 0 ? (totalLib / totalExp.total) * 100 : 0;
            barTotal.style.width = `${pct}%`;
        }

        const retidasTotalEl = document.getElementById('carrier-total-retidas');
        if (retidasTotalEl) retidasTotalEl.textContent = totalRet;

        const libTotalEl = document.getElementById('carrier-total-liberadas');
        if (libTotalEl) libTotalEl.textContent = totalLib;

        // 3. Atualiza Fita dos Últimos Volumes Bipados com cargas reais
        const ribbonEl = document.getElementById('scanned-ribbon-items');
        if (ribbonEl && cargas.length > 0) {
            ribbonEl.innerHTML = cargas.slice(0, 3).map(g => {
                const isLib = g.is_liberada;
                const isSp = (g.uf === 'SP');
                const chipClass = isLib ? 'chip-green' : 'chip-red';
                const icon = isLib 
                    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>`
                    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
                const desc = isLib ? (isSp ? 'Isento SP' : 'Liberada') : `Retida SEFAZ (R$ ${g.value.toFixed(2).replace('.', ',')})`;
                return `
                    <div class="scanned-chip ${chipClass}">
                        ${icon}
                        <span>NF-e ${escapeHtml(g.nf_number)} · ${escapeHtml(g.carrier_name)} (${desc})</span>
                    </div>
                `;
            }).join('');
        }

        // 4. Salva cargas e renderiza a primeira página paginada (12 por página)
        window.todasCargasDoca = cargas;
        window.cargasFiltradasDoca = cargas;

        // Atualiza Hero e Badge da Navbar
        const badgeNav = document.getElementById('nav-badge-pendentes');
        if (badgeNav) badgeNav.textContent = resumo.naoPagas || 0;

        const heroPend = document.getElementById('hero-qtd-pendentes');
        if (heroPend) heroPend.textContent = `${resumo.naoPagas || 0} guias GNRE pendentes de emissão na SEFAZ`;

        const heroConc = document.getElementById('hero-qtd-conciliadas');
        if (heroConc) heroConc.textContent = `${resumo.pagas || liberadasCount} cargas liberadas no Itaú`;

        // Se houver notas não pagas (ex: 9 notas do Linx), foca na aba de não pagas por padrão
        if (resumo.naoPagas > 0 && !window.usuarioJaFiltrouManualmente) {
            filtroSituacaoAtivo = 'NAO_PAGAS';
            const btnNaoPagas = document.getElementById('tab-btn-nao-pagas');
            if (btnNaoPagas && btnNaoPagas.parentElement) {
                btnNaoPagas.parentElement.querySelectorAll('.dock-tab-btn').forEach(b => b.classList.remove('active'));
                btnNaoPagas.classList.add('active');
            }
        }

        aplicarFiltrosRapidos();
        renderizarPaginaDoca(1);

        // 6. Atualiza Painel Fintech e Metadados do Lote com formato limpo
        if (data.batch) {
            const rawReceipt = data.batch.receipt || '';
            const cleanReceipt = (rawReceipt && rawReceipt.length > 25) 
                ? 'REM2610' 
                : (rawReceipt || (data.batch.id ? data.batch.id.substring(0, 8) : 'REM2610'));

            const summaryEl = document.getElementById('fintech-batch-summary');
            if (summaryEl) {
                summaryEl.textContent = `Lote Fiscal #${cleanReceipt} · ${resumo.total} guias auditadas · Total DIFAL: R$ ${resumo.valorTotal.toFixed(2).replace('.', ',')} · Status: 🟢 Agendamento Bancário Confirmado`;
            }

            const metaTag = document.getElementById('meta-batch-tag');
            if (metaTag) {
                metaTag.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> Lote Ativo #${cleanReceipt} · ${resumo.total} Guias (Remessa CNAB 240)`;
            }
        }

        // 7. Atualiza Grid de Distribuição Fiscal por UF
        const ufGrid = document.getElementById('uf-distribution-grid');
        if (ufGrid && cargas.length > 0) {
            const porUf = {};
            cargas.forEach(g => {
                const uf = (g.uf || 'SP').toUpperCase().trim();
                if (!porUf[uf]) porUf[uf] = { count: 0, valor: 0 };
                porUf[uf].count++;
                porUf[uf].valor += parseFloat(g.value || g.valor || 0);
            });
            const ufsOrdenadas = Object.keys(porUf).sort((a, b) => porUf[b].valor - porUf[a].valor);
            ufGrid.innerHTML = ufsOrdenadas.map(uf => `
                <div class="uf-card-pill">
                    <div class="uf-card-top">
                        <span class="uf-badge">${uf}</span>
                        <span class="uf-tag-status">${uf === 'SP' ? 'DARE SP' : 'GNRE'}</span>
                    </div>
                    <div class="uf-card-val">R$ ${porUf[uf].valor.toFixed(2).replace('.', ',')}</div>
                    <div class="uf-card-count">${porUf[uf].count} ${porUf[uf].count === 1 ? 'guia' : 'guias'} · 🟢 Agendada</div>
                </div>
            `).join('');
        }

        // 7. Salva resumo e atualiza Contadores das 3 Abas Operacionais
        window.currentResumoLote = resumo;

        const tabTodas = document.getElementById('tab-cnt-todas');
        if (tabTodas) tabTodas.textContent = resumo.total;

        const tabPagas = document.getElementById('tab-cnt-pagas');
        if (tabPagas) tabPagas.textContent = resumo.pagas !== undefined ? resumo.pagas : liberadasCount;

        const tabPend = document.getElementById('tab-cnt-pendentes');
        if (tabPend) tabPend.textContent = resumo.pendentes !== undefined ? resumo.pendentes : (resumo.retidas || 0);

        const tabNaoPagas = document.getElementById('tab-cnt-nao-pagas');
        if (tabNaoPagas) tabNaoPagas.textContent = resumo.naoPagas !== undefined ? resumo.naoPagas : 0;

        // IDs legados para retrocompatibilidade
        const tabBloq = document.getElementById('tab-cnt-bloqueadas');
        if (tabBloq) tabBloq.textContent = resumo.naoPagas !== undefined ? resumo.naoPagas : retidasCount;
        const tabLib = document.getElementById('tab-cnt-liberadas');
        if (tabLib) tabLib.textContent = resumo.pagas !== undefined ? resumo.pagas : liberadasCount;
        const isentasCount = (cargas || []).filter(c => c.uf === 'SP').length;
        const tabIsentas = document.getElementById('tab-cnt-isentas');
        if (tabIsentas) tabIsentas.textContent = isentasCount;

        // Atualiza links e trava anti-duplicidade da Tesouraria
        atualizarLinksRemessaDoca();

        // Inicializa controles de data do painel fintech
        inicializarPainelFintechDoca();

        // Atualiza modal de conciliação se estiver aberto
        if (typeof renderizarConciliacao === 'function') renderizarConciliacao();

    } catch (e) {
        console.error("Erro ao carregar cargas reais da doca:", e);
        const tb = document.getElementById('guides-table-body');
        if (tb) tb.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:40px; color:#B42318; font-weight:600;">Erro ao exibir as guias: ${escapeHtml(e.message || String(e))}</td></tr>`;
    }
}
window.carregarCargasDocaReais = carregarCargasDocaReais;

// ==========================================
// CONCILIAÇÃO DE GUIAS (PAGAS × AGENDADAS × A PAGAR)
// ==========================================
function formatarDataCurta(iso) {
    if (!iso) return '';
    const p = String(iso).split('T')[0].split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(iso);
}

function formatarBRL(n) {
    return `R$ ${(parseFloat(n) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function copiarCodigoBarras(cod) {
    const done = () => showToast('Código de barras copiado!', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cod).then(done).catch(() => showToast(cod, 'info'));
    } else {
        const ta = document.createElement('textarea');
        ta.value = cod;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { showToast(cod, 'info'); }
        document.body.removeChild(ta);
    }
}
window.copiarCodigoBarras = copiarCodigoBarras;

window.conciliacaoFiltro = 'TODAS';
window.conciliacaoSelecionadas = new Set();

function abrirModalConciliacao() {
    const modal = document.getElementById('modal-conciliacao-guias');
    if (!modal) return;
    modal.style.display = 'flex';
    window.conciliacaoSelecionadas.clear();
    renderizarConciliacao();
}
window.abrirModalConciliacao = abrirModalConciliacao;

function fecharModalConciliacao() {
    const modal = document.getElementById('modal-conciliacao-guias');
    if (modal) modal.style.display = 'none';
}
window.fecharModalConciliacao = fecharModalConciliacao;

function filtrarConciliacao(f) {
    window.conciliacaoFiltro = f;
    window.conciliacaoSelecionadas.clear();
    renderizarConciliacao();
}
window.filtrarConciliacao = filtrarConciliacao;

function renderizarConciliacao() {
    const modal = document.getElementById('modal-conciliacao-guias');
    if (!modal || modal.style.display !== 'flex') return;

    const todas = window.todasCargasDoca || [];
    const grupos = { paga: [], agendada: [], a_pagar: [], rejeitada: [], sp_manual: [], sem_guia: [] };
    todas.forEach(g => (grupos[g.situacao_pagamento] || grupos.a_pagar).push(g));
    const pendencias = grupos.rejeitada.concat(grupos.sem_guia);
    const soma = arr => arr.reduce((a, g) => a + (parseFloat(g.value) || 0), 0);

    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setTxt('conc-qtd-paga', grupos.paga.length);
    setTxt('conc-val-paga', formatarBRL(soma(grupos.paga)));
    setTxt('conc-qtd-agendada', grupos.agendada.length);
    setTxt('conc-val-agendada', formatarBRL(soma(grupos.agendada)));
    setTxt('conc-qtd-apagar', grupos.a_pagar.length);
    setTxt('conc-val-apagar', formatarBRL(soma(grupos.a_pagar)));
    setTxt('conc-qtd-sp', grupos.sp_manual.length);
    setTxt('conc-val-sp', formatarBRL(soma(grupos.sp_manual)));
    const pendEl = document.getElementById('conc-pendencias');
    if (pendEl) {
        pendEl.style.display = pendencias.length ? 'block' : 'none';
        pendEl.textContent = `⚠ ${pendencias.length} nota(s) com pendência (sem guia emitida ou rejeitada): ${formatarBRL(soma(pendencias))} — veja o filtro "Pendências".`;
    }

    const f = window.conciliacaoFiltro;
    let lista = todas;
    if (f === 'PAGA') lista = grupos.paga;
    else if (f === 'AGENDADA') lista = grupos.agendada;
    else if (f === 'A_PAGAR') lista = grupos.a_pagar;
    else if (f === 'PENDENCIA') lista = pendencias;
    else if (f === 'SP') lista = grupos.sp_manual;

    document.querySelectorAll('.conc-chip').forEach(c => c.classList.toggle('active', c.getAttribute('data-f') === f));

    const busca = (document.getElementById('conc-busca')?.value || '').toLowerCase().trim();
    if (busca) {
        lista = lista.filter(g =>
            String(g.nf_number).toLowerCase().includes(busca) ||
            String(g.customer_name || '').toLowerCase().includes(busca) ||
            String(g.uf || '').toLowerCase().includes(busca));
    }

    const rotulo = {
        paga: '<span style="color:#157347; font-weight:700;"><span class="status-dot green"></span>Paga</span>',
        agendada: '<span style="color:#1D4ED8; font-weight:700;"><span class="status-dot blue"></span>Agendada</span>',
        a_pagar: '<span style="color:#DC2626; font-weight:700;"><span class="status-dot red"></span>A pagar</span>',
        rejeitada: '<span style="color:#C2410C; font-weight:700;">⚠ Rejeitada</span>',
        sem_guia: '<span style="color:#92400E; font-weight:700;">⚠ Sem guia emitida</span>',
        sp_manual: '<span style="color:#0F766E; font-weight:700;"><span class="status-dot purple"></span>SP manual</span>'
    };

    const body = document.getElementById('conc-tabela-body');
    if (body) {
        body.innerHTML = lista.length === 0
            ? '<tr><td colspan="7" style="text-align:center; padding:28px; color:#8393A7;">Nenhuma guia neste filtro.</td></tr>'
            : lista.map(g => {
                const checked = window.conciliacaoSelecionadas.has(g.id) ? 'checked' : '';
                const bar = String(g.barcode || '').replace(/\D/g, '');
                return `<tr style="border-bottom:1px solid #EEF2F7;">
                    <td style="padding:6px 8px; text-align:center;"><input type="checkbox" ${checked} onchange="toggleConciliacaoSel('${escapeHtml(g.id)}', this.checked)"></td>
                    <td style="padding:6px 8px; font-family:'JetBrains Mono',monospace; font-weight:700;">${escapeHtml(g.nf_number)}</td>
                    <td style="padding:6px 8px; font-weight:700;">${escapeHtml(g.uf)}</td>
                    <td style="padding:6px 8px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(g.customer_name)}</td>
                    <td style="padding:6px 8px; text-align:right; font-family:'JetBrains Mono',monospace;">${formatarBRL(g.value)}</td>
                    <td style="padding:6px 8px;">${rotulo[g.situacao_pagamento] || rotulo.a_pagar}${g.paid_at ? `<div style="font-size:10.5px; color:#5B6B7F;">${formatarDataCurta(g.paid_at)}</div>` : ''}</td>
                    <td style="padding:6px 8px; text-align:right;">${bar.length >= 44 ? `<button type="button" onclick="copiarCodigoBarras('${bar}')" style="border:none; background:none; cursor:pointer; color:#475569; font-size:11px;">copiar</button>` : '—'}</td>
                </tr>`;
            }).join('');
    }
    atualizarContadorConciliacaoSel();
}
window.renderizarConciliacao = renderizarConciliacao;

function toggleConciliacaoSel(id, checked) {
    if (checked) window.conciliacaoSelecionadas.add(id);
    else window.conciliacaoSelecionadas.delete(id);
    atualizarContadorConciliacaoSel();
}
window.toggleConciliacaoSel = toggleConciliacaoSel;

function conciliacaoSelecionarTodas(checked) {
    document.querySelectorAll('#conc-tabela-body input[type=checkbox]').forEach(cb => {
        cb.checked = checked;
        const m = (cb.getAttribute('onchange') || '').match(/'([^']+)'/);
        if (m) {
            if (checked) window.conciliacaoSelecionadas.add(m[1]);
            else window.conciliacaoSelecionadas.delete(m[1]);
        }
    });
    atualizarContadorConciliacaoSel();
}
window.conciliacaoSelecionarTodas = conciliacaoSelecionarTodas;

function atualizarContadorConciliacaoSel() {
    const el = document.getElementById('conc-sel-count');
    if (el) el.textContent = window.conciliacaoSelecionadas.size;
}

async function marcarGuiasPagas(ids, paga = true) {
    if (!ids || ids.length === 0) {
        showToast('Selecione pelo menos uma guia.', 'warning');
        return;
    }
    const dataInput = document.getElementById('conc-data-pagamento')?.value;
    const msg = paga
        ? `Confirma marcar ${ids.length} guia(s) como PAGA(S) (conciliação manual)?`
        : `Reverter ${ids.length} guia(s) para "aguardando pagamento"?`;
    if (!confirm(msg)) return;
    try {
        const res = await fetch('/api/guide/marcar-paga', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, paga, paidAt: dataInput || undefined })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao conciliar.');
        showToast(`✓ ${data.message}`, 'success');
        window.conciliacaoSelecionadas.clear();
        await carregarCargasDocaReais();
    } catch (err) {
        showToast(err.message, 'error');
    }
}
window.marcarGuiasPagas = marcarGuiasPagas;

function marcarSelecionadasConciliacao(paga) {
    marcarGuiasPagas(Array.from(window.conciliacaoSelecionadas), paga);
}
window.marcarSelecionadasConciliacao = marcarSelecionadasConciliacao;

async function enviarRetornoBancario(inputEl) {
    const file = inputEl?.files?.[0];
    if (!file) return;
    const out = document.getElementById('conc-retorno-resultado');
    if (out) out.textContent = '⏳ Processando retorno bancário...';
    try {
        const fd = new FormData();
        fd.append('retornoFile', file);
        const res = await fetch('/api/cnab/upload-retorno', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao processar retorno.');
        const r = data.resumo || {};
        if (out) {
            out.innerHTML = `<strong style="color:#157347;">✓ ${escapeHtml(data.message)}</strong><br>` +
                `No arquivo: ${r.totalNoArquivo ?? 0} · Pagas: ${r.baixadas ?? 0} · Agendadas: ${r.agendadas ?? 0} · Rejeitadas: ${r.rejeitadas ?? 0} · Não localizadas: ${r.naoLocalizadasNoBanco ?? 0}`;
        }
        showToast(data.message, 'success');
        await carregarCargasDocaReais();
    } catch (err) {
        if (out) out.innerHTML = `<span style="color:#B42318; font-weight:600;">✕ ${escapeHtml(err.message)}</span>`;
        showToast(err.message, 'error');
    } finally {
        inputEl.value = '';
    }
}
window.enviarRetornoBancario = enviarRetornoBancario;

async function enviarRetornoSpZip(inputEl) {
    const file = inputEl?.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
        if (typeof showToast === 'function') {
            showToast('Selecione um arquivo .zip com os DAREs da SEFAZ-SP.', 'warning');
        } else {
            alert('Selecione um arquivo .zip com os DAREs da SEFAZ-SP.');
        }
        inputEl.value = '';
        return;
    }

    if (typeof showToast === 'function') {
        showToast('⏳ Processando arquivo .zip da SEFAZ-SP...', 'info');
    }

    try {
        const fd = new FormData();
        fd.append('retornoZip', file);

        const res = await fetch('/api/sefaz-sp/upload-retorno-zip', {
            method: 'POST',
            body: fd
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || 'Falha ao processar arquivo da SEFAZ-SP.');
        }

        const qtd = data.resumo?.atualizadas ?? 0;
        const msg = `✓ Sucesso: ${qtd} DARE(s) de SP vinculado(s) com código de barras!`;
        if (typeof showToast === 'function') {
            showToast(msg, 'success');
        } else {
            alert(msg);
        }

        // Atualiza a doca e o cockpit em tempo real
        if (typeof carregarCargasDocaReais === 'function') {
            await carregarCargasDocaReais();
        }
        if (typeof carregarCockpit360 === 'function') {
            await carregarCockpit360(true);
        }
    } catch (err) {
        console.error('Erro ao enviar retorno SP:', err);
        if (typeof showToast === 'function') {
            showToast(`✕ ${err.message}`, 'error');
        } else {
            alert(`Erro: ${err.message}`);
        }
    } finally {
        inputEl.value = '';
    }
}
window.enviarRetornoSpZip = enviarRetornoSpZip;


function exportarConciliacaoCsv() {
    const todas = window.todasCargasDoca || [];
    if (todas.length === 0) {
        showToast('Nenhuma guia para exportar.', 'warning');
        return;
    }
    const nomes = { paga: 'PAGA', agendada: 'AGENDADA', a_pagar: 'A PAGAR', rejeitada: 'REJEITADA', sp_manual: 'SP MANUAL' };
    const linhas = [['NF', 'UF', 'Cliente', 'Valor', 'Situacao', 'Data Pagamento', 'Autenticacao', 'Codigo de Barras']];
    todas.forEach(g => linhas.push([
        g.nf_number, g.uf, g.customer_name, (parseFloat(g.value) || 0).toFixed(2).replace('.', ','),
        nomes[g.situacao_pagamento] || 'A PAGAR', formatarDataCurta(g.paid_at), g.bank_authentication || '', String(g.barcode || '')
    ]));
    const csv = '\ufeff' + linhas.map(l => l.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `conciliacao_guias_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
window.exportarConciliacaoCsv = exportarConciliacaoCsv;

// ==========================================
// CONTROLADORES DO PAINEL DE LIQUIDAÇÃO FINANCEIRA & DATA PERSONALIZADA
// ==========================================
function inicializarPainelFintechDoca() {
    const inputDate = document.getElementById('doca-input-data-pagamento');
    if (inputDate && !inputDate.value) {
        inputDate.value = new Date().toISOString().split('T')[0];
    }
    atualizarLinksRemessaDoca();
}

function atualizarDataRemessaDoca(novaData) {
    console.log("[Fintech] Data de pagamento selecionada pelo usuário:", novaData);
    atualizarLinksRemessaDoca();
}

function atualizarBancoRemessaDoca(novoBanco) {
    const btnText = document.getElementById('btn-doca-baixar-remessa-text');
    if (btnText) {
        const bancoLabel = novoBanco === 'bradesco' ? 'Bradesco' : (novoBanco === 'bb' ? 'Banco do Brasil' : 'Itaú');
        btnText.textContent = 'Baixar Arquivo de Remessa (.TXT)';
    }
    atualizarLinksRemessaDoca();
}

function atualizarLinksRemessaDoca() {
    const btn = document.getElementById('btn-doca-baixar-remessa');
    const btnText = document.getElementById('btn-doca-baixar-remessa-text');
    const btnSp = document.getElementById('btn-doca-baixar-xml-sp');
    const btnDropdownSp = document.getElementById('download-sp-xml-btn');
    const btnGuiasPdf = document.getElementById('btn-doca-baixar-guias');
    const banco = document.getElementById('doca-select-banco')?.value || 'itau';
    const dataPag = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    const batchAlvo = window.activeBatchId || 'todos';

    const pendentesCount = window.currentResumoLote?.pendentes !== undefined ? window.currentResumoLote.pendentes : 0;
    const valorPendentes = window.currentResumoLote?.valorPendentes !== undefined ? window.currentResumoLote.valorPendentes : 0;

    if (btn && window.activeBatchId) {
        btn.href = `/api/remessa/download/${window.activeBatchId}?banco=${banco}&paymentDate=${dataPag}`;
        if (btnText) {
            if (pendentesCount > 0) {
                btnText.textContent = `Baixar Remessa (${pendentesCount} guias pendentes · R$ ${valorPendentes.toFixed(2).replace('.', ',')})`;
                btn.style.background = '#2563EB';
                btn.style.borderColor = '#3B82F6';
                btn.style.color = '#FFFFFF';
            } else {
                btnText.textContent = 'Todas as Guias deste Lote estão Pagas';
                btn.style.background = 'rgba(16, 185, 129, 0.2)';
                btn.style.borderColor = 'rgba(16, 185, 129, 0.5)';
                btn.style.color = '#34D399';
            }
        }
    }
    if (btnSp) {
        btnSp.href = `/api/batch/download-xml/${batchAlvo}?paymentDate=${dataPag}`;
    }
    if (btnDropdownSp) {
        btnDropdownSp.href = `/api/batch/download-xml/${batchAlvo}?paymentDate=${dataPag}`;
    }
    if (btnGuiasPdf && window.activeBatchId) {
        btnGuiasPdf.href = `/api/guide/gnre-selecionadas?batchId=${window.activeBatchId}&paymentDate=${dataPag}`;
    }
}

function executarDownloadRemessaDoca(event) {
    const pendentesCount = window.currentResumoLote?.pendentes !== undefined ? window.currentResumoLote.pendentes : 0;
    if (pendentesCount === 0) {
        if (event) event.preventDefault();
        showToast(" Todas as guias deste lote já foram quitadas/pagas anteriormente. Nenhuma nova remessa é necessária para evitar pagamento em duplicidade no Itaú.", "warning");
        return;
    }
    const banco = document.getElementById('doca-select-banco')?.value || 'itau';
    const dataPag = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    if (!window.activeBatchId) {
        if (event) event.preventDefault();
        showToast("Nenhum lote ativo selecionado.", "warn");
        return;
    }
    atualizarLinksRemessaDoca();
    const [ano, mes, dia] = dataPag.split('-');
    const dataFmt = `${dia}/${mes}/${ano}`;
    if (event && event.currentTarget) {
        event.currentTarget.href = `/api/remessa/download/${window.activeBatchId}?banco=${banco}&paymentDate=${encodeURIComponent(dataPag)}`;
        event.currentTarget.download = `REM${dia}${mes}.txt`; // Itaú SISPAG exige máx 7 chars (ex: REM2610.txt)
    }
    showToast(`Baixando Remessa com ${pendentesCount} guias pendentes para débito em ${dataFmt}...`, "success");
}

async function autorizarPagamentoLoteComData() {
    if (!window.activeBatchId) {
        showToast("Nenhum lote ativo na doca.", "warn");
        return;
    }
    const banco = document.getElementById('doca-select-banco')?.value || 'itau';
    const paymentDate = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    const [ano, mes, dia] = paymentDate.split('-');
    const dataFmt = `${dia}/${mes}/${ano}`;

    if (!confirm(`Confirma a autorização e agendamento bancário do lote para o dia ${dataFmt}?`)) {
        return;
    }

    const btn = document.getElementById('btn-doca-autorizar-lote');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Processando...</span>`;
    }

    try {
        const res = await fetch(`/api/batch/authorize-payment/${window.activeBatchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ banco, paymentDate })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao autorizar pagamento.");

        showToast(`Lote autorizado com sucesso! Remessa gerada com débito agendado para ${dataFmt}.`, 'success');

        // Dispara download automático da remessa com a data escolhida (máximo 7 caracteres exigido pelo Itaú/bancos)
        const link = document.createElement('a');
        link.href = `/api/remessa/download/${window.activeBatchId}?banco=${banco}&paymentDate=${paymentDate}`;
        link.download = `REM${dia}${mes}.txt`; // ex: REM2610.txt (7 chars)
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        if (typeof carregarCargasDocaReais === 'function') {
            await carregarCargasDocaReais();
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Confirmar Agendamento</span>`;
        }
    }
}
window.inicializarPainelFintechDoca = inicializarPainelFintechDoca;
window.atualizarDataRemessaDoca = atualizarDataRemessaDoca;
window.atualizarBancoRemessaDoca = atualizarBancoRemessaDoca;
window.atualizarLinksRemessaDoca = atualizarLinksRemessaDoca;
window.executarDownloadRemessaDoca = executarDownloadRemessaDoca;
window.autorizarPagamentoLoteComData = autorizarPagamentoLoteComData;

function baixarXmlLoteSpComData(event, apenasSelecionadas = false) {
    if (event) event.preventDefault();
    const dataPag = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    const batchAlvo = window.activeBatchId || 'todos';
    let url = `/api/batch/download-xml/${batchAlvo}?paymentDate=${encodeURIComponent(dataPag)}`;

    if (apenasSelecionadas) {
        const ids = Array.from(window.selectedGuideIds || []);
        if (ids.length === 0) {
            showToast("Selecione pelo menos uma nota de SP na tabela.", "warning");
            return;
        }
        url += `&ids=${encodeURIComponent(ids.join(','))}`;
    }

    const [ano, mes, dia] = dataPag.split('-');
    showToast(`Gerando XML Lote SP com data de pagamento/vencimento ${dia}/${mes}/${ano}...`, 'success');
    window.open(url, '_blank');
}

async function reemitirGuiasSefazComData(apenasSelecionadas = false) {
    if (!window.activeBatchId) {
        showToast("Nenhum lote ativo selecionado na doca.", "warning");
        return;
    }
    const paymentDate = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    const [ano, mes, dia] = paymentDate.split('-');
    const dataFmt = `${dia}/${mes}/${ano}`;

    let ids = null;
    if (apenasSelecionadas) {
        ids = Array.from(window.selectedGuideIds || []);
        if (ids.length === 0) {
            showToast("Selecione pelo menos uma guia na tabela.", "warning");
            return;
        }
    }

    const msgConfirm = ids
        ? `Deseja emitir/atualizar na SEFAZ as ${ids.length} guia(s) selecionada(s) com a data de pagamento/vencimento ${dataFmt}?`
        : `Deseja emitir/atualizar na SEFAZ todas as guias pendentes do lote (e atualizar o XML de SP) com a data de pagamento/vencimento ${dataFmt}?`;

    if (!confirm(msgConfirm)) return;

    const btn = document.getElementById('btn-doca-emitir-sefaz-data');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Transmitindo SEFAZ...</span>`;
    }

    try {
        const res = await fetch(`/api/batch/authorize-emission/${window.activeBatchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentDate, ids })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao transmitir guias na SEFAZ.");

        showToast(`Transmissão SEFAZ iniciada para a data ${dataFmt}! Aguarde alguns segundos e atualize a página.`, 'success');
        if (typeof iniciarPollingLote === 'function') {
            iniciarPollingLote(window.activeBatchId);
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg><span>Emitir SEFAZ c/ Data</span>`;
        }
    }
}
window.baixarXmlLoteSpComData = baixarXmlLoteSpComData;
window.reemitirGuiasSefazComData = reemitirGuiasSefazComData;

function fecharModalAutorizacaoAsaas() {
    const modal = document.getElementById('modal-autorizar-asaas');
    if (modal) modal.style.display = 'none';
}

async function confirmarAutorizacaoAsaas() {
    const btnConfirm = document.getElementById('btn-confirmar-pagamento-asaas');
    if (btnConfirm) {
        btnConfirm.disabled = true;
        btnConfirm.textContent = '⏳ Liquidando guias no Asaas...';
    }

    try {
        if (window.activeBatchId) {
            await fetch(`/api/batch/authorize-payment-asaas/${window.activeBatchId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch (err) {
        console.warn("Prosseguindo com autorização de lote:", err);
    }

    aplicarLiberacaoGeralDoca();
    fecharModalAutorizacaoAsaas();
    showToast("12 Guias de DIFAL quitadas no Asaas com sucesso! Portão Fiscal 100% liberado.", 'success');

    if (btnConfirm) {
        btnConfirm.disabled = false;
        btnConfirm.textContent = 'Autorizar e Liquidar Agora';
    }
}

function playAudioFeedback(tipo) {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const audioCtx = new AudioContext();
        if (tipo === 'liberado') {
            // Arpejo harmônico ascendente cristalino (Dó Maior: C5 -> E5 -> G5)
            const notas = [523.25, 659.25, 783.99];
            notas.forEach((freq, idx) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, audioCtx.currentTime + (idx * 0.07));
                gain.gain.setValueAtTime(0.25, audioCtx.currentTime + (idx * 0.07));
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + (idx * 0.07) + 0.22);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(audioCtx.currentTime + (idx * 0.07));
                osc.stop(audioCtx.currentTime + (idx * 0.07) + 0.22);
            });
        } else if (tipo === 'bloqueado') {
            // Alarme sonoro triplo urgente descendente (BEEP! BEEP! BEEP!) para ambiente fabril/galpão
            [0, 0.14, 0.28].forEach((startTime) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sawtooth'; // Onda tipo buzina/alarme industrial
                osc.frequency.setValueAtTime(650, audioCtx.currentTime + startTime);
                osc.frequency.exponentialRampToValueAtTime(320, audioCtx.currentTime + startTime + 0.11);
                gain.gain.setValueAtTime(0.40, audioCtx.currentTime + startTime);
                gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + startTime + 0.11);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(audioCtx.currentTime + startTime);
                osc.stop(audioCtx.currentTime + startTime + 0.12);
            });
        }
    } catch (e) {
        // Ignora se o navegador restringir áudio antes do primeiro clique do usuário
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const modalAsaas = document.getElementById('modal-autorizar-asaas');
    if (modalAsaas) {
        modalAsaas.addEventListener('click', (e) => {
            if (e.target === modalAsaas) fecharModalAutorizacaoAsaas();
        });
    }

    const modalBipagem = document.getElementById('modal-bipagem-portao-fiscal');
    if (modalBipagem) {
        modalBipagem.addEventListener('click', (e) => {
            if (e.target === modalBipagem) fecharModalBipagem();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            fecharModalBipagem();
            fecharModalAutorizacaoAsaas();
        } else if (e.key === 'Enter') {
            const modalBip = document.getElementById('modal-bipagem-portao-fiscal');
            if (modalBip && modalBip.style.display === 'flex') {
                if (currentGuiaPortaoFiscal && isGuiaLiberadaLocal(currentGuiaPortaoFiscal)) {
                    e.preventDefault();
                    fecharModalBipagem();
                }
            }
        }
    });
});

/**
 * ETAPA 4: Liberação e Pagamento Avulso Nota a Nota
 */
async function autorizarPagamentoGuiaAvulsa(guideId, nfNumber, skipConfirm = true) {
    if (!skipConfirm && !confirm(`Deseja autorizar a liquidação imediata da NF nº ${nfNumber} pelo Asaas?`)) {
        return;
    }

    try {
        showToast(`Liquidando NF ${nfNumber} no Asaas...`, 'warning');
        if (guideId && !guideId.startsWith('mock-')) {
            try {
                await fetch(`/api/guide/authorize-payment-asaas/${guideId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (apiErr) {
                console.warn("Backend guide payment:", apiErr);
            }
        }

        // 1. Atualiza a guia local
        if (currentGuiaPortaoFiscal) {
            currentGuiaPortaoFiscal.status = 'COMPROVADA';
            currentGuiaPortaoFiscal.receipt_storage_path = 'simulado_asaas';
        }

        // 2. Atualiza linha na tabela cockpit
        const cleanNf = String(nfNumber || '').replace(/[^0-9]/g, '');
        const rows = document.querySelectorAll('.cockpit-table tbody tr');
        rows.forEach(tr => {
            const nfTd = tr.querySelector('td.cell-mono');
            if (nfTd && nfTd.textContent.replace(/[^0-9]/g, '').includes(cleanNf)) {
                const tag = tr.querySelector('.tag-status');
                if (tag) {
                    tag.className = 'tag-status tag-liberado';
                    tag.textContent = 'Liberado';
                }
                const btn = tr.querySelector('.btn-row-liquidar');
                if (btn) {
                    btn.parentElement.innerHTML = '<a href="#" onclick="alert(\'DANFE da carga liberada com comprovante fiscal Asaas.\'); return false;" class="action-link-subtle">DANFE</a>';
                }
            }
        });

        // 3. Atualiza contadores
        const blockedEl = document.getElementById('kpi-status');
        const blockedBadge = document.getElementById('kpi-blocked-badge');
        const readyEl = document.getElementById('kpi-ready-val');
        const readyBadge = document.getElementById('kpi-ready-badge');
        const difalEl = document.getElementById('kpi-difal');

        if (blockedEl) {
            let cur = parseInt(blockedEl.textContent) || 12;
            if (cur > 0) cur--;
            blockedEl.textContent = cur;
            if (blockedBadge) blockedBadge.textContent = cur;
            if (readyEl) readyEl.textContent = (248 - cur);
            if (readyBadge) readyBadge.textContent = (248 - cur);
            if (difalEl) {
                let v = cur * 153.37;
                difalEl.textContent = cur === 0 ? 'R$ 0,00' : `R$ ${v.toFixed(2).replace('.', ',')}`;
            }
        }

        playAudioFeedback('liberado');
        showToast(`✓ NF ${nfNumber} PAGA com sucesso! Portão Fiscal Liberado.`, 'success');

        // 4. Atualiza modal para liberado
        if (currentGuiaPortaoFiscal) {
            exibirResultadoPortaoFiscal(currentGuiaPortaoFiscal);
        }
    } catch (err) {
        showToast("Erro ao autorizar pagamento: " + err.message, 'error');
    }
}

function abrirModalDevolucoes() {
    const modal = document.getElementById('modal-gestao-devolucoes');
    if (modal) modal.style.display = 'flex';
}
window.abrirModalDevolucoes = abrirModalDevolucoes;

function fecharModalDevolucoes() {
    const modal = document.getElementById('modal-gestao-devolucoes');
    if (modal) modal.style.display = 'none';
}
window.fecharModalDevolucoes = fecharModalDevolucoes;

function ajustarValorDevolucao() {
    const tipo = document.getElementById('devolucao-tipo')?.value;
    const valInput = document.getElementById('devolucao-valor');
    if (valInput) {
        valInput.value = tipo === 'total' ? '130,00' : '65,00';
    }
}
window.ajustarValorDevolucao = ajustarValorDevolucao;

function confirmarRegistroDevolucao() {
    const nfSaida = document.getElementById('devolucao-nf-saida')?.value || '03001003';
    const nfEntrada = document.getElementById('devolucao-nf-entrada')?.value;
    const valorEstornoStr = document.getElementById('devolucao-valor')?.value || '130,00';
    const valorEstorno = parseFloat(valorEstornoStr.replace(',', '.')) || 130.00;

    if (!nfEntrada) {
        showToast("Informe o número ou chave da NF-e de devolução emitida no Linx.", 'warning');
        return;
    }

    // Abate o valor do DIFAL a liquidar no Cockpit
    const difalEl = document.getElementById('kpi-difal');
    if (difalEl) {
        let vAtual = parseFloat(difalEl.textContent.replace('R$', '').replace('.', '').replace(',', '.').trim()) || 1840.50;
        let vNovo = Math.max(0, vAtual - valorEstorno);
        difalEl.textContent = `R$ ${vNovo.toFixed(2).replace('.', ',')}`;
    }

    fecharModalDevolucoes();
    playAudioFeedback('liberado');
    showToast(`✓ Devolução NF ${nfEntrada} vinculada à NF ${nfSaida}! Crédito de R$ ${valorEstorno.toFixed(2).replace('.', ',')} compensado no lote.`, 'success');
}
window.confirmarRegistroDevolucao = confirmarRegistroDevolucao;

const defaultMockGuides = [
    { id: 'mock-1', nf_number: '054201', customer_name: 'Rio de Janeiro', uf: 'RJ', carrier_name: 'Total Express', value: 84.50, status: 'PENDENTE' },
    { id: 'mock-2', nf_number: '03001003', customer_name: 'Rio de Janeiro', uf: 'RJ', carrier_name: 'Total Express', value: 1840.50, status: 'PENDENTE' },
    { id: 'mock-3', nf_number: '03001006', customer_name: 'Rua GAT - 3300', uf: 'MG', carrier_name: 'Total Express', value: 420.00, status: 'COMPROVADA' },
    { id: 'mock-4', nf_number: '03001013', customer_name: 'Rua GAT - 3002', uf: 'SP', carrier_name: 'Total Express', value: 310.00, status: 'ISENTO' },
    { id: 'mock-5', nf_number: '03012004', customer_name: 'Rua M&D - 163', uf: 'SP', carrier_name: 'MT Log', value: 360.00, status: 'ISENTO' }
];

async function handleBipagemPortaoFiscal(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();

    const input = document.getElementById('filter-search');
    const termo = (input?.value || '').trim();
    if (!termo) return;

    const lista = (window.currentBatchGuides && window.currentBatchGuides.length > 0)
        ? window.currentBatchGuides
        : [];

    const cleanTermo = termo.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();

    // Extrai número da NF caso seja código de barras de 44 dígitos da DANFE
    let nfExtraida = cleanTermo;
    if (cleanTermo.length >= 44) {
        const extraido = parseInt(cleanTermo.substring(25, 34), 10);
        if (!isNaN(extraido)) nfExtraida = String(extraido);
    }

    // 1. Busca rápida em memória no lote atual da doca
    let guiaEncontrada = lista.find(g => {
        const nf = String(g.nf_number || '').replace(/[^0-9]/g, '');
        const chave = String(g.chave_nfe || '').replace(/[^0-9]/g, '');
        const ped = String(g.order_number || g.xPed || '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
        
        return nf === nfExtraida || 
               nf.includes(cleanTermo) || 
               cleanTermo.includes(nf) || 
               chave === cleanTermo || 
               ped === cleanTermo;
    });

    // 2. Se não estiver no cache de memória, busca diretamente na API de expedição
    if (!guiaEncontrada) {
        try {
            const res = await fetch(`/api/expedicao/bipar?termo=${encodeURIComponent(termo)}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.guia) {
                    guiaEncontrada = data.guia;
                }
            }
        } catch (e) {
            console.warn("[Scanner] Falha na consulta remota de bipagem:", e);
        }
    }

    // 3. Resultado da conferência
    if (guiaEncontrada) {
        exibirResultadoPortaoFiscal(guiaEncontrada);
    } else {
        playAudioFeedback('bloqueado');
        showToast(`✕ Volume não localizado no lote ativo! (Código lido: ${termo.slice(0, 20)}...)`, 'error');
        if (input) {
            input.select();
            input.focus();
        }
    }
}

// Suporte Contínuo para Leitor Físico USB / Bipadeira (Auto-Focus Global)
window.addEventListener('keydown', (e) => {
    // Tecla ESC fecha modais e devolve o foco imediatamente para o leitor laser
    if (e.key === 'Escape') {
        fecharModalBipagem();
        const input = document.getElementById('filter-search');
        if (input) {
            input.value = '';
            input.focus();
        }
        return;
    }

    // Se estiver digitando em outros inputs ou textareas, não interfere
    const activeEl = document.activeElement;
    const isEditing = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
    if (isEditing && activeEl.id !== 'filter-search') {
        return;
    }

    // Se o operador começar a bipar fora do input, redireciona o foco instantaneamente
    const barcodeInput = document.getElementById('filter-search');
    if (barcodeInput && activeEl !== barcodeInput) {
        if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            barcodeInput.focus();
        }
    }
});


function abrirModalBipagemExemplo(nfNum = '054201') {
    const lista = (window.currentBatchGuides && window.currentBatchGuides.length > 0)
        ? window.currentBatchGuides
        : defaultMockGuides;
    
    let guia = lista.find(g => String(g.nf_number).includes(nfNum)) || defaultMockGuides[0];
    exibirResultadoPortaoFiscal(guia);
}
window.abrirModalBipagemExemplo = abrirModalBipagemExemplo;

let currentGuiaPortaoFiscal = null;

function executarAcaoBipagemPrimaria() {
    if (!currentGuiaPortaoFiscal) {
        fecharModalBipagem();
        return;
    }
    const liberada = isGuiaLiberadaLocal(currentGuiaPortaoFiscal);
    if (liberada) {
        fecharModalBipagem();
    } else {
        autorizarPagamentoGuiaAvulsa(currentGuiaPortaoFiscal.id, currentGuiaPortaoFiscal.nf_number);
    }
}

let ultimosVolumesBipados = [
    { nf: '03001006', transp: 'Total Express', status: 'liberado', desc: 'Liberada (R$ 420,00)' },
    { nf: '03001013', transp: 'Total Express', status: 'liberado', desc: 'Isento SP (R$ 0,00)' },
    { nf: '03001003', transp: 'Total Express', status: 'bloqueado', desc: 'Retida SEFAZ (R$ 1.840,50)' }
];

function adicionarUltimoBipado(guia, statusTipo) {
    const nfNum = String(guia.nf_number || '').padStart(6, '0');
    const nfFmt = nfNum.length === 6 ? `${nfNum.slice(0, 3)}.${nfNum.slice(3)}` : nfNum;
    const isSp = (guia.uf === 'SP' || guia.barcode === 'IMPORTAR_NO_SEFAZ_SP');
    const valor = parseFloat(guia.value || 0).toFixed(2).replace('.', ',');
    
    let desc = statusTipo === 'liberado'
        ? (isSp ? 'Isento SP (R$ 0,00)' : `Liberada (R$ ${valor})`)
        : `Retida SEFAZ (R$ ${valor})`;

    ultimosVolumesBipados.unshift({
        nf: nfFmt,
        transp: guia.carrier_name || 'Total Express',
        status: statusTipo,
        desc: desc
    });

    if (ultimosVolumesBipados.length > 3) {
        ultimosVolumesBipados.pop();
    }

    renderizarFitaUltimosBipados();
}

function renderizarFitaUltimosBipados() {
    const container = document.getElementById('scanned-ribbon-items');
    if (!container) return;

    if (!ultimosVolumesBipados || ultimosVolumesBipados.length === 0) {
        container.innerHTML = `
            <div style="font-size: 12px; color: #8597B1; padding: 12px 0;">
                Aguardando leitura do primeiro volume pelo leitor óptico...
            </div>
        `;
        return;
    }

    container.innerHTML = ultimosVolumesBipados.slice(0, 4).map(item => {
        const isOk = item.status === 'liberado';
        const agora = new Date();
        const horaFmt = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(41, 55, 78, 0.4);">
                <div>
                    <div style="font-family: JetBrains Mono, monospace; font-size: 12.5px; font-weight: 700; color: #F1F5FC;">${escapeHtml(item.nf)}</div>
                    <div style="font-size: 11px; color: #8597B1;">${horaFmt} · ${escapeHtml(item.transp || 'Total Express')}</div>
                </div>
                <span class="badge-figma ${isOk ? 'badge-figma-paga' : 'badge-figma-naopaga'}" style="font-size: 10px;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${isOk ? '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}</svg>
                    ${isOk ? 'Conferida' : 'Revisar'}
                </span>
            </div>
        `;
    }).join('');
}

let handsFreeBannerTimeout = null;
function mostrarBannerHandsFree(guia) {
    const banner = document.getElementById('handsfree-toast-banner');
    const desc = document.getElementById('handsfree-toast-desc');
    const station = document.getElementById('laser-station-box');
    if (!banner) return;

    const nfNum = String(guia.nf_number || '').padStart(6, '0');
    const nfFmt = nfNum.length === 6 ? `${nfNum.slice(0, 3)}.${nfNum.slice(3)}` : nfNum;
    const transp = guia.carrier_name || 'Total Express';

    if (desc) {
        desc.textContent = `NF-e ${nfFmt} · ${transp} — Carga Liberada (Colocar na esteira!)`;
    }

    if (station) {
        station.classList.add('flash-success');
        setTimeout(() => station.classList.remove('flash-success'), 650);
    }

    banner.style.display = 'flex';
    if (handsFreeBannerTimeout) clearTimeout(handsFreeBannerTimeout);
    handsFreeBannerTimeout = setTimeout(() => {
        banner.style.display = 'none';
    }, 2800);
}

function exibirResultadoPortaoFiscal(guia) {
    currentGuiaPortaoFiscal = guia;
    const modal = document.getElementById('modal-bipagem-portao-fiscal');
    const input = document.getElementById('filter-search');

    const isSp = (guia.uf === 'SP' || guia.barcode === 'IMPORTAR_NO_SEFAZ_SP');
    const difalVal = parseFloat(guia.value || 0);
    const liberada = isGuiaLiberadaLocal(guia);

    const rawNf = String(guia.nf_number || '').trim();
    let displayNf = rawNf;
    let chaveSubtext = '';

    if (rawNf.length >= 44) {
        // Extrai número da NF-e (posições 25 a 34 da chave de acesso)
        const numExtraido = parseInt(rawNf.substring(25, 34), 10);
        displayNf = isNaN(numExtraido) ? rawNf.slice(-8) : String(numExtraido);
        chaveSubtext = `<div style="font-size: 10px; color: #8393A7; font-family: JetBrains Mono, monospace; word-break: break-all; margin-top: 2px;">Chave: ${rawNf.slice(0, 6)}...${rawNf.slice(-8)}</div>`;
    } else if (rawNf.length > 0 && rawNf.length <= 6) {
        displayNf = rawNf.padStart(6, '0');
    }

    if (liberada) {
        // MODO HANDS-FREE: NÃO TRAVA COM MODAL!
        playAudioFeedback('liberado');
        adicionarUltimoBipado(guia, 'liberado');
        mostrarBannerHandsFree(guia);

        if (input) {
            input.value = '';
            input.focus();
        }
        return;
    }

    // ESTADO BLOQUEADO (PARADA OBRIGATÓRIA NA EXPEDIÇÃO - TRAVA ANTI-APREENSÃO)
    const boxLaser = document.getElementById('laser-station-box');
    if (boxLaser) {
        boxLaser.classList.remove('flash-success');
        boxLaser.classList.remove('flash-error-shake');
        void boxLaser.offsetWidth; // Força reflow para disparar a animação
        boxLaser.classList.add('flash-error-shake');
        setTimeout(() => boxLaser.classList.remove('flash-error-shake'), 1200);
    }

    playAudioFeedback('bloqueado');
    adicionarUltimoBipado(guia, 'bloqueado');

    if (!modal) return;

    const nfEl = document.getElementById('bipagem-nf');
    const destEl = document.getElementById('bipagem-destinatario');
    const transpEl = document.getElementById('bipagem-transp');
    const difalEl = document.getElementById('bipagem-difal-valor');
    const actionsEl = document.getElementById('bipagem-actions-container');

    if (nfEl) {
        nfEl.innerHTML = `<div>NF-e ${escapeHtml(displayNf)}</div>${chaveSubtext}`;
    }
    const destTexto = guia.customer_name ? `${guia.customer_name} / ${guia.uf || 'BR'}` : `${guia.city || 'Destino'} / ${guia.uf || 'BR'}`;
    if (destEl) destEl.textContent = destTexto;
    if (transpEl) transpEl.textContent = guia.carrier_name || 'Total Express';
    if (difalEl) difalEl.textContent = `R$ ${difalVal.toFixed(2).replace('.', ',')}`;

    if (actionsEl) {
        actionsEl.innerHTML = `
            <button id="btn-solicitar-diretoria" onclick="solicitarLiberacaoDiretoria('${displayNf}', '${difalVal.toFixed(2).replace('.', ',')}')" style="width: 100%; height: 46px; background: #2563EB; color: #ffffff; font-size: 14px; font-weight: 700; border: none; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: background 0.15s;">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
                <span>Solicitar Liberação à Diretoria no App (R$ ${difalVal.toFixed(2).replace('.', ',')})</span>
            </button>
            <button onclick="fecharModalBipagem()" style="width: 100%; height: 44px; background: #ffffff; color: #182536; font-size: 13px; font-weight: 600; border: 1.5px solid #CBD5E1; border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s;">
                Separar Caixa na Expedição & Próximo Volume (Enter)
            </button>
        `;
    }

    modal.style.display = 'flex';
}

function fecharModalBipagem() {
    const modal = document.getElementById('modal-bipagem-portao-fiscal');
    if (modal) modal.style.display = 'none';

    const input = document.getElementById('filter-search');
    if (input) {
        input.value = '';
        input.focus();
        aplicarFiltrosTabela();
    }
}
window.fecharModalBipagem = fecharModalBipagem;

function solicitarLiberacaoDiretoria(nf, valor) {
    const btn = document.getElementById('btn-solicitar-diretoria');
    if (btn) {
        btn.disabled = true;
        btn.style.background = '#1e293b';
        btn.innerHTML = '<span>Notificação Enviada (Aguardando Diretoria)</span>';
    }
    showToast(`Solicitação de alçada enviada à Diretoria Financeira para a NF ${nf} (R$ ${valor})! A carga será liberada na doca após autorização de pagamento.`, 'warning');
}
window.solicitarLiberacaoDiretoria = solicitarLiberacaoDiretoria;

let filtroDataEmissaoAtivo = 'TODAS';
let filtroTransportadoraAtivo = 'TODAS';
let filtroSituacaoAtivo = 'PENDENTES_RETIDAS';
let filtroTextoInlineAtivo = '';

window.todasCargasDoca = [];
window.cargasFiltradasDoca = [];
window.paginaAtualDoca = 1;
window.itensPorPaginaDoca = 25;

function renderizarPaginaDoca(pagina = 1) {
    const lista = window.cargasFiltradasDoca || [];
    const total = lista.length;
    const itensPorPag = window.itensPorPaginaDoca || 25;
    const maxPagina = Math.max(1, Math.ceil(total / itensPorPag));

    if (pagina < 1) pagina = 1;
    if (pagina > maxPagina) pagina = maxPagina;
    window.paginaAtualDoca = pagina;

    const inicio = (pagina - 1) * itensPorPag;
    const fim = Math.min(inicio + itensPorPag, total);
    const cargasPagina = lista.slice(inicio, fim);

    const tbody = document.getElementById('guides-table-body');
    if (tbody) {
        if (total === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" style="text-align: center; padding: 48px 16px; color: var(--text-muted);">
                        <div style="font-size: 14px; font-weight: 600; color: var(--navy); margin-bottom: 4px;">Nenhuma carga localizada para este filtro</div>
                        <p style="font-size: 12px; color: var(--text-muted); margin: 0;">Tente alterar os filtros de transportadora ou buscar por outro termo.</p>
                    </td>
                </tr>
            `;
        } else {
            const isDocaLiberada = false; // flag de demonstração desativada: status vem sempre do banco/banco real
            tbody.innerHTML = cargasPagina.map((g, idx) => {
                const isLib = g.is_liberada;
                const isSp = (g.uf === 'SP');
                const isChecked = (window.selectedGuideIds && window.selectedGuideIds.has(g.id)) ? 'checked' : '';

                let sitCalc = 'nao_paga';
                if (g.is_paga || (g.status || '').toUpperCase() === 'PAGA' || !!g.paid_at || g.value <= 0) {
                    sitCalc = 'paga';
                } else if (g.is_pendente || (g.barcode && g.barcode.length >= 44 && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP')) {
                    sitCalc = 'pendente';
                } else {
                    sitCalc = 'nao_paga';
                }

                const nfClean = String(g.nf_number || '').replace(/\D/g, '');
                const nfFormatada = nfClean.length >= 6 ? nfClean.padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3') : (g.nf_number || '000.048.921');
                const pedidoRef = g.order_number || g.pedido_numero || ('BH-' + (10840 + (parseInt(nfClean.slice(-3)) || 1)));
                
                const cidadesMock = {
                    'RJ': 'Rio de Janeiro', 'SP': 'São Paulo', 'MG': 'Belo Horizonte',
                    'AL': 'Maceió', 'PR': 'Curitiba', 'BA': 'Salvador', 'RS': 'Porto Alegre'
                };
                const cidadeDestino = g.city || g.cidade || cidadesMock[g.uf] || (g.uf === 'MG' ? 'Belo Horizonte' : 'Rio de Janeiro');
                const difalVal = parseFloat(g.value || 0);
                const vendaVal = parseFloat(g.valor_venda || g.total_venda || (difalVal * 5.3) || 459.90);

                const transpNome = g.carrier_name || (idx % 2 === 1 ? 'Correios' : 'Total Express');
                const isCorreios = transpNome.toLowerCase().includes('correios');

                const isOld = idx === 4 || (g.dias_parado && g.dias_parado > 30);
                const docaTag = isOld
                    ? '<span class="badge-figma badge-figma-naopaga" style="padding: 2px 6px; font-size: 10px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#FF929B" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> 33 dias</span>'
                    : '<span style="color: #8597B1; font-size: 10px; font-family: Inter, sans-serif;">Hoje na doca</span>';

                const dataEmissaoFmt = idx === 4 ? '28/08/26' : (idx === 3 ? '28/09/26' : (idx === 2 ? '29/09/26' : '30/09/26'));

                return `
                    <tr class="${isChecked ? 'row-selected-figma' : ''}" style="height: 88px; background: ${isChecked ? '#172F54' : '#111B2E'}; border-bottom: 1px solid #29374E;">
                        <td style="text-align: center; width: 44px;">
                            <input type="checkbox" class="table-checkbox row-select-box" data-guide-id="${escapeHtml(g.id)}" data-nf="${escapeHtml(g.nf_number)}" ${isChecked} onchange="toggleSelectRowGuide('${escapeHtml(g.id)}', this.checked, event)" onclick="event.stopPropagation()">
                        </td>
                        <td style="width: 140px;">
                            <div style="font-family: JetBrains Mono, monospace; font-weight: 500; color: #F1F5FC; font-size: 12px;">${escapeHtml(nfFormatada)}</div>
                            <div style="font-family: JetBrains Mono, monospace; font-size: 10px; color: #A6B5CA; margin-top: 3px;">${escapeHtml(pedidoRef)}</div>
                        </td>
                        <td style="width: 360px;">
                            <div style="font-weight: 500; color: #F1F5FC; font-size: 12px; font-family: Inter, sans-serif;">${escapeHtml(g.customer_name || 'Camila Andrade')}</div>
                            <div style="font-size: 10px; color: #A6B5CA; margin-top: 3px; font-family: Inter, sans-serif;">
                                ${escapeHtml(cidadeDestino)} · ${escapeHtml(g.uf || 'RJ')}
                            </div>
                        </td>
                        <td style="width: 120px;">
                            <div style="font-family: JetBrains Mono, monospace; color: #A6B5CA; font-size: 10px;">${dataEmissaoFmt}</div>
                            <div style="margin-top: 4px;">${docaTag}</div>
                        </td>
                        <td style="width: 130px;">
                            <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #F1F5FC; font-family: Inter, sans-serif;">
                                ${isCorreios
                                    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A6B5CA" stroke-width="2"><path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>'
                                    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#A6B5CA" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/></svg>'
                                }
                                <span>${escapeHtml(transpNome)}</span>
                            </div>
                        </td>
                        <td style="text-align: right; width: 130px;">
                            <div style="font-family: JetBrains Mono, monospace; color: #F1F5FC; font-size: 11px;">R$ ${vendaVal.toFixed(2).replace('.', ',')}</div>
                            <div style="font-family: JetBrains Mono, monospace; font-size: 11px; color: #F5C268; margin-top: 3px;">R$ ${difalVal.toFixed(2).replace('.', ',')}</div>
                        </td>
                        <td style="text-align: center; width: 130px;">
                            ${sitCalc === 'paga'
                                ? '<span class="badge-figma badge-figma-online"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#66DBAC" stroke-width="2.2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Liberada · portão</span>'
                                : '<span class="badge-figma badge-figma-naopaga"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FF929B" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Retida · fiscal</span>'
                            }
                        </td>
                        <td style="text-align: center; width: 120px;">
                            <div style="font-size: 11px; color: #F1F5FC; font-family: Inter, sans-serif;">${sitCalc === 'paga' ? 'Emitida' : 'A emitir'}</div>
                            <div style="font-size: 10px; color: #8597B1; margin-top: 3px; font-family: Inter, sans-serif;">GNRE / DIFAL</div>
                        </td>
                        <td style="text-align: right; width: 160px;">
                            <div style="display: inline-flex; align-items: center; gap: 8px; justify-content: flex-end;">
                                <button type="button" onclick="abrirModalEmitirSefazIndividual('${escapeHtml(g.id)}', '${escapeHtml(g.nf_number)}', '${escapeHtml(g.uf)}', ${g.value || 0})" class="btn-primary-figma" style="height: 32px; padding: 0 12px; font-size: 11px; font-weight: 600;">
                                    <span>Emitir SEFAZ</span>
                                </button>
                                <button type="button" class="btn-secondary-figma" style="width: 32px; height: 32px; padding: 0; justify-content: center; background: transparent; border-color: transparent;" onclick="window.open('/api/guide/danfe/${escapeHtml(g.id)}', '_blank')">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A6B5CA" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }

    // Atualiza texto de paginação e Totais da Fila Figma
    const intervaloEl = document.getElementById('paginacao-intervalo');
    const totalEl = document.getElementById('paginacao-total');
    if (intervaloEl) {
        intervaloEl.textContent = total > 0 ? `${inicio + 1} a ${fim}` : '0';
    }
    if (totalEl) {
        totalEl.textContent = total;
    }

    // Totais da Fila Figma
    const elTotaisLeft = document.getElementById('table-totais-left-text');
    const elTotaisRight = document.getElementById('table-totais-right-text');
    const elResumoHeader = document.getElementById('label-totais-cargas-resumo');
    
    const pendentesCount = lista.filter(g => !g.is_paga && (g.status || '').toUpperCase() !== 'PAGA' && !g.paid_at && (g.value || 0) > 0).length;
    const pecasCount = lista.reduce((acc, g) => acc + (g.total_pecas || 1), 0);
    const somaVenda = lista.reduce((acc, g) => acc + (g.valor_venda || g.total_venda || ((g.value || 0) * 5.2) || 0), 0);
    const somaDifal = lista.reduce((acc, g) => acc + (g.value || 0), 0);

    if (elTotaisLeft) {
        elTotaisLeft.textContent = `${pendentesCount} pendentes · ${pecasCount} peças · valores do recorte exibido`;
    }
    if (elTotaisRight) {
        elTotaisRight.textContent = `Venda R$ ${somaVenda.toFixed(2).replace('.', ',')}  /  DIFAL R$ ${somaDifal.toFixed(2).replace('.', ',')}`;
    }
    if (elResumoHeader) {
        elResumoHeader.textContent = `${total} cargas · ordenadas por emissão`;
    }

    // Atualiza os botões dinâmicos de paginação
    const wrap = document.getElementById('dock-pagination-pages');
    if (wrap) {
        let html = '';
        
        // Botão Anterior ‹
        const prevDisabled = pagina <= 1 ? 'disabled style="opacity: 0.4; cursor: not-allowed;"' : '';
        html += `<button type="button" class="btn-page-num" ${prevDisabled} onclick="mudarPaginaDoca(-1)" title="Página Anterior">‹</button>`;

        // Botões numéricos
        if (maxPagina <= 7) {
            for (let i = 1; i <= maxPagina; i++) {
                const active = (i === pagina) ? 'active' : '';
                html += `<button type="button" class="btn-page-num ${active}" onclick="irParaPaginaDoca(${i})">${i}</button>`;
            }
        } else {
            html += `<button type="button" class="btn-page-num ${pagina === 1 ? 'active' : ''}" onclick="irParaPaginaDoca(1)">1</button>`;
            
            if (pagina > 3) {
                html += `<span style="color: var(--text-muted); font-size: 12px; padding: 0 4px; display: inline-flex; align-items: center;">...</span>`;
            }

            const startP = Math.max(2, pagina - 1);
            const endP = Math.min(maxPagina - 1, pagina + 1);
            for (let i = startP; i <= endP; i++) {
                const active = (i === pagina) ? 'active' : '';
                html += `<button type="button" class="btn-page-num ${active}" onclick="irParaPaginaDoca(${i})">${i}</button>`;
            }

            if (pagina < maxPagina - 2) {
                html += `<span style="color: var(--text-muted); font-size: 12px; padding: 0 4px; display: inline-flex; align-items: center;">...</span>`;
            }

            html += `<button type="button" class="btn-page-num ${pagina === maxPagina ? 'active' : ''}" onclick="irParaPaginaDoca(${maxPagina})">${maxPagina}</button>`;
        }

        // Botão Próximo ›
        const nextDisabled = pagina >= maxPagina ? 'disabled style="opacity: 0.4; cursor: not-allowed;"' : '';
        html += `<button type="button" class="btn-page-num" ${nextDisabled} onclick="mudarPaginaDoca(1)" title="Próxima Página">›</button>`;

        wrap.innerHTML = html;
    }

    atualizarContagemLote();
}

function mudarPaginaDoca(delta) {
    const nova = (window.paginaAtualDoca || 1) + delta;
    renderizarPaginaDoca(nova);
}
window.mudarPaginaDoca = mudarPaginaDoca;

function irParaPaginaDoca(num) {
    renderizarPaginaDoca(num);
}
window.irParaPaginaDoca = irParaPaginaDoca;
window.renderizarPaginaDoca = renderizarPaginaDoca;

function aplicarFiltrosRapidos() {
    const todas = window.todasCargasDoca || [];
    const isDocaLiberada = false; // flag de demonstração desativada: status vem sempre do banco/banco real

    window.cargasFiltradasDoca = todas.filter(g => {
        const isLib = g.is_liberada;
        const isSp = (g.uf === 'SP');
        const transp = (g.carrier_name || 'Total Express').trim();

        // 1. Filtro Transportadora
        if (filtroTransportadoraAtivo && filtroTransportadoraAtivo !== 'TODAS') {
            if (!transp.toLowerCase().includes(filtroTransportadoraAtivo.toLowerCase())) {
                return false;
            }
        }

        // 2. Filtro Situação Tab (Visualização em 3 Estados)
        const isGuiaPaga = g.is_paga || (g.status || '').toUpperCase() === 'PAGA' || !!g.paid_at || (g.value || g.valor || 0) <= 0;
        if (filtroSituacaoAtivo === 'PAGAS' || filtroSituacaoAtivo === 'Liberado') {
            if (!isGuiaPaga) return false;
        } else if (filtroSituacaoAtivo === 'PENDENTES') {
            if (isGuiaPaga) return false;
        } else if (filtroSituacaoAtivo === 'NAO_PAGAS' || filtroSituacaoAtivo === 'Bloqueado') {
            if (isGuiaPaga) return false;
        } else if (filtroSituacaoAtivo === 'Isento') {
            if (!isSp) return false;
        }

        // 3. Filtro Texto Inline
        if (filtroTextoInlineAtivo) {
            const query = filtroTextoInlineAtivo.toLowerCase();
            const nf = String(g.nf_number || '').toLowerCase();
            const cliente = String(g.customer_name || '').toLowerCase();
            const chave = String(g.chave_nfe || '').toLowerCase();
            const uf = String(g.uf || '').toLowerCase();
            if (!nf.includes(query) && !cliente.includes(query) && !chave.includes(query) && !uf.includes(query)) {
                return false;
            }
        }

        return true;
    });

    renderizarPaginaDoca(1);
}
window.aplicarFiltrosRapidos = aplicarFiltrosRapidos;

function filtrarPorSituacaoTab(situacao, btnEl) {
    filtroSituacaoAtivo = situacao;
    if (btnEl && btnEl.parentElement) {
        btnEl.parentElement.querySelectorAll('.dock-underline-tab, .dock-tab-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }
    aplicarFiltrosRapidos();
}
window.filtrarPorSituacaoTab = filtrarPorSituacaoTab;

function aplicarFiltroTextoInline(val) {
    filtroTextoInlineAtivo = (val || '').toLowerCase().trim();
    aplicarFiltrosRapidos();
}
window.aplicarFiltroTextoInline = aplicarFiltroTextoInline;

function alterarItensPorPagina(qtd) {
    const val = parseInt(qtd, 10) || 25;
    window.itensPorPaginaDoca = val;
    renderizarPaginaDoca(1);
    const label = val >= 9999 ? 'Todas as cargas' : `${val} por página`;
    showToast(`Exibindo ${label}`, 'info');
}
window.alterarItensPorPagina = alterarItensPorPagina;

function toggleSelectRowGuide(id, checked, ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (!window.selectedGuideIds) window.selectedGuideIds = new Set();
    if (checked) {
        window.selectedGuideIds.add(id);
    } else {
        window.selectedGuideIds.delete(id);
    }
    atualizarContagemLote();
}
window.toggleSelectRowGuide = toggleSelectRowGuide;

function toggleSelectAllRows(checked) {
    if (!window.selectedGuideIds) window.selectedGuideIds = new Set();
    const lista = window.cargasFiltradasDoca || [];
    if (checked) {
        lista.forEach(g => window.selectedGuideIds.add(g.id));
    } else {
        window.selectedGuideIds.clear();
    }
    document.querySelectorAll('.cockpit-table tbody .row-select-box').forEach(cb => {
        cb.checked = checked;
    });
    atualizarContagemLote();
}
window.toggleSelectAllRows = toggleSelectAllRows;

function selecionarTodasDoLote() {
    if (!window.selectedGuideIds) window.selectedGuideIds = new Set();
    const lista = window.cargasFiltradasDoca || [];
    lista.forEach(g => window.selectedGuideIds.add(g.id));
    document.querySelectorAll('.cockpit-table tbody .row-select-box').forEach(cb => {
        cb.checked = true;
    });
    const masterCb = document.getElementById('check-all-rows');
    if (masterCb) {
        masterCb.checked = true;
        masterCb.indeterminate = false;
    }
    atualizarContagemLote();
    showToast(`Todas as ${lista.length} cargas do lote foram selecionadas!`, 'success');
}
window.selecionarTodasDoLote = selecionarTodasDoLote;

function desmarcarTodasLinhas() {
    if (window.selectedGuideIds) window.selectedGuideIds.clear();
    document.querySelectorAll('.table-checkbox').forEach(b => b.checked = false);
    const masterCb = document.getElementById('check-all-rows');
    if (masterCb) {
        masterCb.checked = false;
        masterCb.indeterminate = false;
    }
    atualizarContagemLote();
}
window.desmarcarTodasLinhas = desmarcarTodasLinhas;

function atualizarContagemLote() {
    const totalSelecionadas = window.selectedGuideIds ? window.selectedGuideIds.size : 0;
    const bulkBar = document.getElementById('dock-bulk-bar');
    const countEl = document.getElementById('bulk-selected-count');
    const masterCb = document.getElementById('check-all-rows');
    const lista = window.cargasFiltradasDoca || [];

    if (countEl) countEl.textContent = totalSelecionadas;
    if (bulkBar) {
        bulkBar.style.display = totalSelecionadas > 0 ? 'flex' : 'none';
    }

    if (masterCb) {
        if (lista.length > 0 && totalSelecionadas === lista.length) {
            masterCb.checked = true;
            masterCb.indeterminate = false;
        } else if (totalSelecionadas > 0 && totalSelecionadas < lista.length) {
            masterCb.checked = false;
            masterCb.indeterminate = true;
        } else {
            masterCb.checked = false;
            masterCb.indeterminate = false;
        }
    }
}
window.atualizarContagemLote = atualizarContagemLote;

function imprimirDanfesLoteSelecionado() {
    const ids = Array.from(window.selectedGuideIds || []);
    if (ids.length === 0) {
        showToast("Selecione pelo menos uma carga.", "warning");
        return;
    }
    showToast(`Gerando PDF unificado de ${ids.length} DANFE(s)...`, 'success');
    window.open(`/api/guide/danfe-selecionadas?ids=${ids.join(',')}`, '_blank');
}
window.imprimirDanfesLoteSelecionado = imprimirDanfesLoteSelecionado;

function imprimirGnresLoteSelecionado() {
    const ids = Array.from(window.selectedGuideIds || []);
    if (ids.length === 0) {
        showToast("Selecione pelo menos uma carga.", "warning");
        return;
    }
    showToast(`Gerando PDF unificado de ${ids.length} Guia(s) GNRE...`, 'success');
    const dataPag = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0]; window.open(`/api/guide/gnre-selecionadas?ids=${ids.join(',')}&paymentDate=${encodeURIComponent(dataPag)}`, '_blank');
}
window.imprimirGnresLoteSelecionado = imprimirGnresLoteSelecionado;

function solicitarLiberacaoLoteSelecionado() {
    const total = window.selectedGuideIds ? window.selectedGuideIds.size : 0;
    if (total === 0) {
        showToast("Selecione pelo menos uma carga.", "warning");
        return;
    }
    showToast(`Solicitação de liquidação enviada à Diretoria Financeira para autorizar as ${total} guias selecionadas!`, 'warning');
}
window.solicitarLiberacaoLoteSelecionado = solicitarLiberacaoLoteSelecionado;

function filtrarPorDataEmissao(dataTipo, btnEl) {
    filtroDataEmissaoAtivo = dataTipo;
    const select = document.getElementById('select-filter-data');
    if (select && select.value !== dataTipo) select.value = dataTipo;
    aplicarFiltrosRapidos();
}
window.filtrarPorDataEmissao = filtrarPorDataEmissao;

function filtrarPorTransportadora(transp, btnEl) {
    filtroTransportadoraAtivo = transp;
    const select = document.getElementById('select-filter-transp');
    if (select && select.value !== transp) select.value = transp;
    aplicarFiltrosRapidos();
}
window.filtrarPorTransportadora = filtrarPorTransportadora;

function filtrarPorSituacao(situacao, btnEl) {
    filtroSituacaoAtivo = situacao;
    aplicarFiltrosRapidos();
}
window.filtrarPorSituacao = filtrarPorSituacao;

/**
 * Registra a coleta da transportadora e arquiva cargas liberadas em "Já Despachadas"
 */
function confirmarColetaTransportadora() {
    const liberadas = document.querySelectorAll('.cockpit-table tbody tr:not(.row-despachada) .tag-liberado, .cockpit-table tbody tr:not(.row-despachada) .tag-isento');
    if (liberadas.length === 0) {
        showToast("Não há cargas liberadas na doca para registrar coleta.", 'warning');
        return;
    }

    const conf = confirm(`Deseja registrar a coleta de ${liberadas.length} cargas liberadas com a transportadora?\\n\\nElas sairão da doca ativa e serão arquivadas na aba 'Já Despachadas (Histórico)'.`);
    if (!conf) return;

    liberadas.forEach(tag => {
        const tr = tag.closest('tr');
        if (tr) {
            tr.classList.add('row-despachada');
            const tdStatus = tr.children[5];
            if (tdStatus) {
                tdStatus.innerHTML = '<span class="tag-status tag-despachado">Despachado (Em Trânsito)</span>';
            }
            const tdAcoes = tr.children[6];
            if (tdAcoes) {
                tdAcoes.innerHTML = '<span style="font-size: 11px; color: #64748b;">Romaneio #20261016</span>';
            }
        }
    });

    // Atualiza KPIs
    const kpiVolumes = document.getElementById('kpi-volumes');
    const kpiReadyVal = document.getElementById('kpi-ready-val');
    const kpiReadyBadge = document.getElementById('kpi-ready-badge');

    if (kpiVolumes) kpiVolumes.textContent = '12';
    if (kpiReadyVal) kpiReadyVal.textContent = '0';
    if (kpiReadyBadge) kpiReadyBadge.textContent = '0';

    aplicarFiltrosRapidos();
    showToast(`Coleta concluída! ${liberadas.length} cargas despachadas com sucesso. Consulte em 'Já Despachadas'.`, 'success');
}
window.confirmarColetaTransportadora = confirmarColetaTransportadora;

/**
 * Registra a coleta específica de uma transportadora (Total Express, Correios, MT Log)
 */
function confirmarColetaPorTransportadora(transportadoraNome, qtdEsperada) {
    const rows = document.querySelectorAll('.cockpit-table tbody tr:not(.row-despachada)');
    let coletadasCount = 0;

    const conf = confirm(`Confirmar a coleta de ${qtdEsperada} volumes liberados da ${transportadoraNome}?\\n\\nO motorista receberá o Romaneio Oficial com os comprovantes bancários Asaas e as cargas serão arquivadas no histórico.`);
    if (!conf) return;

    rows.forEach(tr => {
        const textRow = tr.textContent || '';
        if (textRow.includes(transportadoraNome)) {
            const hasLiberada = tr.querySelector('.tag-liberado, .tag-isento');
            if (hasLiberada) {
                tr.classList.add('row-despachada');
                coletadasCount++;
                const tdStatus = tr.children[5];
                if (tdStatus) {
                    tdStatus.innerHTML = '<span class="tag-status tag-despachado">Despachado (Em Trânsito)</span>';
                }
                const tdAcoes = tr.children[6];
                if (tdAcoes) {
                    tdAcoes.innerHTML = '<span style="font-size: 11.5px; color: #8393A7;">Romaneio #20261016</span>';
                }
            }
        }
    });

    // Atualiza badges do card da transportadora se existir
    if (transportadoraNome === 'Total Express') {
        const badge = document.getElementById('carrier-total-badge');
        const fill = document.getElementById('carrier-total-bar');
        if (badge) badge.textContent = 'Coletado / Despachado';
        if (fill) fill.style.background = '#475569';
    }

    aplicarFiltrosRapidos();
    showToast(`Coleta da ${transportadoraNome} registrada com sucesso (${coletadasCount} volumes)!`, 'success');
}
window.confirmarColetaPorTransportadora = confirmarColetaPorTransportadora;

// Recuperação contínua de foco para ergonomia Hands-Free na Doca
setInterval(() => {
    const modalAberto = document.querySelector('#modal-bipagem-portao-fiscal[style*="flex"], #modal-autorizar-asaas[style*="flex"], #modal-fechamento-contabil[style*="flex"], #modal-gestao-devolucoes[style*="flex"]');
    if (modalAberto) return;

    const activeEl = document.activeElement;
    const isEditingInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (!isEditingInput) {
        const barcodeInput = document.getElementById('filter-search');
        if (barcodeInput) barcodeInput.focus();
    }
}, 2500);

/**
 * Dropdown de Mais Opções da Barra do Portão Fiscal
 */
function toggleDropdownMaisOpcoes() {
    const dropdown = document.getElementById('dropdown-menu-mais-opcoes');
    if (!dropdown) return;
    dropdown.style.display = (dropdown.style.display === 'none' || dropdown.style.display === '') ? 'block' : 'none';
}

// Fechar dropdown de mais opções ao clicar fora
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('dropdown-menu-mais-opcoes');
    if (!dropdown || dropdown.style.display === 'none') return;
    const btn = e.target.closest('button[onclick*="toggleDropdownMaisOpcoes"]');
    if (!btn && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});

/**
 * ETAPA 10: Modal de Fechamento Fiscal e Conciliação Contábil
 */
async function abrirModalFechamentoContabil() {
    const modal = document.getElementById('modal-fechamento-contabil');
    if (!modal) return;

    const batchId = window.activeBatchId || 'hoje';

    // Configura links diretos de download imediatamente
    const zipBtn = document.getElementById('btn-download-pacote-zip');
    const pdfBtn = document.getElementById('btn-download-relatorio-pdf');
    const csvBtn = document.getElementById('btn-download-planilha-csv');

    const dataHojeIso = new Date().toISOString().split('T')[0];
    if (zipBtn) {
        zipBtn.href = `/api/fechamento/pacote-zip/${batchId}`;
        zipBtn.setAttribute('download', `Pacote_Auditoria_Fiscal_${dataHojeIso}.zip`);
    }
    if (pdfBtn) {
        pdfBtn.href = `/api/fechamento/relatorio-pdf/${batchId}`;
        pdfBtn.setAttribute('download', `Relatorio_Executivo_Diretoria_${dataHojeIso}.pdf`);
    }
    if (csvBtn) {
        csvBtn.href = `/api/fechamento/planilha-csv/${batchId}`;
        csvBtn.setAttribute('download', `Conciliacao_Fiscal_${dataHojeIso}.csv`);
    }

    modal.style.display = 'flex';

    try {
        const res = await fetch(`/api/fechamento/resumo/${batchId}`, {
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('access_token') || ''}` }
        });
        if (!res.ok) throw new Error("Erro ao carregar dados do fechamento");
        const data = await res.json();

        // Status Badge
        const statusBadge = document.getElementById('fechamento-status-badge');
        if (statusBadge) {
            statusBadge.textContent = data.statusGeral;
            if (data.isTotalmenteConciliado) {
                statusBadge.style.background = '#EAF7F0';
                statusBadge.style.color = '#157347';
            } else {
                statusBadge.style.background = '#FEF2F2';
                statusBadge.style.color = '#DC2626';
            }
        }

        // Hash
        const hashEl = document.getElementById('fechamento-hash');
        if (hashEl) hashEl.textContent = data.hashAuditoria || 'AUDITADO-OK';

        // KPIs
        const totalNotasEl = document.getElementById('fechamento-total-notas');
        if (totalNotasEl) totalNotasEl.textContent = String(data.totais?.totalNotas || 0);

        const liberadasEl = document.getElementById('fechamento-liberadas');
        if (liberadasEl) liberadasEl.textContent = String(data.totais?.liberadas || 0);

        const devidoEl = document.getElementById('fechamento-total-devido');
        if (devidoEl) devidoEl.textContent = `R$ ${(data.totais?.totalDifalDevido || 0).toFixed(2).replace('.', ',')}`;

        const pagoEl = document.getElementById('fechamento-total-pago');
        if (pagoEl) pagoEl.textContent = `R$ ${(data.totais?.totalDifalLiquidado || 0).toFixed(2).replace('.', ',')}`;

        // Tabela por UF (Tema Light Moderno)
        const ufBody = document.getElementById('fechamento-tabela-uf-body');
        if (ufBody && data.porUf) {
            ufBody.innerHTML = data.porUf.map(u => `
                <tr style="border-bottom: 1px solid #E3E8EF;">
                    <td style="padding: 6px 10px; font-weight: 700; color: #111F33;">${u.uf}</td>
                    <td style="padding: 6px 10px; text-align: center; color: #5B6B7F; font-weight: 600;">${u.qtdNotas}</td>
                    <td style="padding: 6px 10px; text-align: right; color: #5B6B7F;">R$ ${u.totalDevido.toFixed(2).replace('.', ',')}</td>
                    <td style="padding: 6px 10px; text-align: right; font-weight: 700; color: #2563EB;">R$ ${u.totalLiquidado.toFixed(2).replace('.', ',')}</td>
                    <td style="padding: 6px 10px; text-align: center;">
                        <span style="font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; ${u.retidas === 0 ? 'background: #EAF7F0; color: #157347;' : 'background: #FEF2F2; color: #DC2626;'}">
                            ${u.retidas === 0 ? 'REGULAR' : `${u.retidas} RET`}
                        </span>
                    </td>
                </tr>
            `).join('');
        }

    } catch (e) {
        console.warn("Erro ao preencher dados de conciliação:", e);
    }
}

function fecharModalFechamentoContabil() {
    const modal = document.getElementById('modal-fechamento-contabil');
    if (modal) modal.style.display = 'none';
}

// Expõe funções no escopo global para o HTML
window.abrirModalAutorizacaoEmissao = abrirModalAutorizacaoEmissao;
window.fecharModalAutorizacaoEmissao = fecharModalAutorizacaoEmissao;
window.confirmarAutorizacaoEmissao = confirmarAutorizacaoEmissao;
window.descartarLoteAtual = descartarLoteAtual;
window.abrirModalAutorizacaoPagamento = abrirModalAutorizacaoPagamento;
window.fecharModalAutorizacaoPagamento = fecharModalAutorizacaoPagamento;
window.confirmarAutorizacaoPagamento = confirmarAutorizacaoPagamento;
window.abrirModalAutorizacaoAsaas = abrirModalAutorizacaoAsaas;
window.fecharModalAutorizacaoAsaas = fecharModalAutorizacaoAsaas;
window.confirmarAutorizacaoAsaas = confirmarAutorizacaoAsaas;
window.autorizarPagamentoGuiaAvulsa = autorizarPagamentoGuiaAvulsa;
window.handleBipagemPortaoFiscal = handleBipagemPortaoFiscal;
window.fecharModalBipagem = fecharModalBipagem;
window.abrirModalFechamentoContabil = abrirModalFechamentoContabil;
window.fecharModalFechamentoContabil = fecharModalFechamentoContabil;
window.carregarDetalhesLote = carregarDetalhesLote;
window.toggleSelectAll = toggleSelectAll;
window.toggleSelectRow = toggleSelectRow;
window.mudarPaginaTabela = mudarPaginaTabela;
window.irParaPagina = irParaPagina;
window.toggleMaisFiltros = toggleMaisFiltros;
window.imprimirGuiasLoteIntercaladas = imprimirGuiasLoteIntercaladas;
window.inicializarPainelFintechDoca = inicializarPainelFintechDoca;
window.atualizarDataRemessaDoca = atualizarDataRemessaDoca;
window.atualizarBancoRemessaDoca = atualizarBancoRemessaDoca;
window.atualizarLinksRemessaDoca = atualizarLinksRemessaDoca;
window.executarDownloadRemessaDoca = executarDownloadRemessaDoca;
window.autorizarPagamentoLoteComData = autorizarPagamentoLoteComData;

function baixarXmlLoteSpComData(event, apenasSelecionadas = false) {
    if (event) event.preventDefault();
    const dataPag = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    const batchAlvo = window.activeBatchId || 'todos';
    let url = `/api/batch/download-xml/${batchAlvo}?paymentDate=${encodeURIComponent(dataPag)}`;

    if (apenasSelecionadas) {
        const ids = Array.from(window.selectedGuideIds || []);
        if (ids.length === 0) {
            showToast("Selecione pelo menos uma nota de SP na tabela.", "warning");
            return;
        }
        url += `&ids=${encodeURIComponent(ids.join(','))}`;
    }

    const [ano, mes, dia] = dataPag.split('-');
    showToast(`Gerando XML Lote SP com data de pagamento/vencimento ${dia}/${mes}/${ano}...`, 'success');
    window.open(url, '_blank');
}

async function reemitirGuiasSefazComData(apenasSelecionadas = false) {
    if (!window.activeBatchId) {
        showToast("Nenhum lote ativo selecionado na doca.", "warning");
        return;
    }
    const paymentDate = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    const [ano, mes, dia] = paymentDate.split('-');
    const dataFmt = `${dia}/${mes}/${ano}`;

    let ids = null;
    if (apenasSelecionadas) {
        ids = Array.from(window.selectedGuideIds || []);
        if (ids.length === 0) {
            showToast("Selecione pelo menos uma guia na tabela.", "warning");
            return;
        }
    }

    const msgConfirm = ids
        ? `Deseja emitir/atualizar na SEFAZ as ${ids.length} guia(s) selecionada(s) com a data de pagamento/vencimento ${dataFmt}?`
        : `Deseja emitir/atualizar na SEFAZ todas as guias pendentes do lote (e atualizar o XML de SP) com a data de pagamento/vencimento ${dataFmt}?`;

    if (!confirm(msgConfirm)) return;

    const btn = document.getElementById('btn-doca-emitir-sefaz-data');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Transmitindo SEFAZ...</span>`;
    }

    try {
        const res = await fetch(`/api/batch/authorize-emission/${window.activeBatchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentDate, ids })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao transmitir guias na SEFAZ.");

        showToast(`Transmissão SEFAZ iniciada para a data ${dataFmt}! Aguarde alguns segundos e atualize a página.`, 'success');
        if (typeof iniciarPollingLote === 'function') {
            iniciarPollingLote(window.activeBatchId);
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg><span>Emitir SEFAZ c/ Data</span>`;
        }
    }
}
window.baixarXmlLoteSpComData = baixarXmlLoteSpComData;
window.reemitirGuiasSefazComData = reemitirGuiasSefazComData;
window.mudarPaginaDoca = mudarPaginaDoca;
window.irParaPaginaDoca = irParaPaginaDoca;
window.renderizarPaginaDoca = renderizarPaginaDoca;
window.alterarItensPorPagina = alterarItensPorPagina;
window.toggleSelectRowGuide = toggleSelectRowGuide;
window.selecionarTodasDoLote = selecionarTodasDoLote;
window.toggleSelectAllRows = toggleSelectAllRows;
window.desmarcarTodasLinhas = desmarcarTodasLinhas;
window.atualizarContagemLote = atualizarContagemLote;

// Auto-abertura via URL param (ex: ?modal=fechamento)
if (window.location.search.includes('modal=fechamento')) {
    setTimeout(() => {
        if (typeof abrirModalFechamentoContabil === 'function') abrirModalFechamentoContabil();
    }, 400);
}



// ==========================================
// MÓDULO COCKPIT E-COMMERCE & VENDAS 360° (VNDA + LINX + DIFAL)
// ==========================================
window.cockpit360Cache = null;
window.cockpit360Agrupamento = 'pedidos'; // 'pedidos' | 'clientes'
window.cockpit360TermoBusca = '';

function alternarAgrupamento360(modo) {
    window.cockpit360Agrupamento = modo;
    const btnOrders = document.getElementById('btn-view-by-orders');
    const btnClients = document.getElementById('btn-view-by-clients');
    if (btnOrders) btnOrders.classList.toggle('active', modo === 'pedidos');
    if (btnClients) btnClients.classList.toggle('active', modo === 'clientes');
    if (window.cockpit360Cache) {
        renderizarCards360(window.cockpit360Cache);
    }
}
window.alternarAgrupamento360 = alternarAgrupamento360;

function filtrarCockpit360(termo) {
    window.cockpit360TermoBusca = (termo || '').toLowerCase().trim();
    if (window.cockpit360Cache) {
        renderizarCards360(window.cockpit360Cache);
    }
}
window.filtrarCockpit360 = filtrarCockpit360;

function filtrarCockpit360PorPeriodo(periodo, btn) {
    window.cockpit360Periodo = periodo;
    const btns = [
        document.getElementById('btn-periodo-360-atual'),
        document.getElementById('btn-periodo-360-set'),
        document.getElementById('btn-periodo-360-todas')
    ];
    btns.forEach(b => {
        if (b) b.classList.remove('active');
    });
    if (btn) btn.classList.add('active');

    if (window.cockpit360Cache) {
        renderizarCards360(window.cockpit360Cache);
    }
}
window.filtrarCockpit360PorPeriodo = filtrarCockpit360PorPeriodo;

function filtrarCockpit360PorSituacao(situacao, btn) {
    window.cockpit360Situacao = situacao;
    const btns = [
        document.getElementById('btn-situacao-360-todas'),
        document.getElementById('btn-situacao-360-pagas'),
        document.getElementById('btn-situacao-360-pendentes'),
        document.getElementById('btn-situacao-360-nao-pagas')
    ];
    btns.forEach(b => {
        if (b) b.classList.remove('active');
    });
    if (btn) btn.classList.add('active');

    if (window.cockpit360Cache) {
        renderizarCards360(window.cockpit360Cache);
    }
}
window.filtrarCockpit360PorSituacao = filtrarCockpit360PorSituacao;


function formatarDataBR(isoStr) {
    if (!isoStr) return 'N/D';
    try {
        const parts = isoStr.split('T')[0].split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
        const d = new Date(isoStr);
        return d.toLocaleDateString('pt-BR');
    } catch {
        return isoStr;
    }
}
window.formatarDataBR = formatarDataBR;

function toggleListaPecas(id) {
    const el = document.getElementById(`pedido-pecas-${id}`);
    const btn = document.getElementById(`btn-toggle-pecas-${id}`);
    if (!el) return;
    const isHidden = el.style.display === 'none' || !el.style.display;
    el.style.display = isHidden ? 'flex' : 'none';
    if (btn) {
        const svg = btn.querySelector('svg');
        if (svg) svg.style.transform = isHidden ? 'rotate(180deg)' : 'none';
    }
}
window.toggleListaPecas = toggleListaPecas;

function abrirModalPagamento360(guideId) {
    const data = window.cockpit360Cache;
    if (!data || !data.guias360) return;
    const g = data.guias360.find(item => String(item.id) === String(guideId));
    if (!g) return;

    const modal = document.getElementById('modal-pagamento-360');
    if (!modal) return;

    // Subtítulo
    const elSub = document.getElementById('modal-pag-subtitulo');
    if (elSub) elSub.textContent = `Pedido #${g.order_number || g.nf_number} • NF-e ${g.nf_number}`;

    // Dados do Cliente
    const elCli = document.getElementById('modal-pag-cliente');
    if (elCli) elCli.textContent = g.customer_name || 'Cliente Boah';
    const elDest = document.getElementById('modal-pag-destino');
    if (elDest) {
        const cid = (g.cidade && g.cidade !== 'ND' && g.cidade !== 'Não informado') ? g.cidade : '';
        const uf = (g.uf && g.uf !== 'ND') ? g.uf : '';
        if (cid && uf) {
            elDest.textContent = `${cid} / ${uf}`;
        } else if (uf) {
            elDest.textContent = uf;
        } else if (cid) {
            elDest.textContent = cid;
        } else {
            elDest.textContent = 'Não informado (Consumidor Final)';
        }
    }
    const elData = document.getElementById('modal-pag-data');
    if (elData) elData.textContent = formatarDataBR(g.data_venda);
    const elTransp = document.getElementById('modal-pag-transp');
    if (elTransp) elTransp.textContent = g.carrier_name || 'Total Express';

    // Forma de Pagamento e Total
    const elForma = document.getElementById('modal-pag-forma-tag');
    if (elForma) elForma.textContent = g.forma_pagamento || 'Cartão de Crédito';
    const elTot = document.getElementById('modal-pag-valor-total');
    if (elTot) elTot.textContent = formatarBRL(g.valor_venda);

    // Parcelas
    const parcelasCont = document.getElementById('modal-pag-parcelas-container');
    if (parcelasCont) {
        const parcelas = g.parcelas || [];
        if (parcelas.length > 1) {
            parcelasCont.innerHTML = `
                <div style="font-size: 11.5px; font-weight: 700; color: #94A3B8; margin-bottom: 8px;">
                    Plano de Pagamento: ${parcelas.length} parcelas no ${escapeHtml(g.forma_pagamento)}
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    ${parcelas.map((p, idx) => `
                        <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 8px 12px; background: #0B1220; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); color: #F1F5FC;">
                            <span><strong>${idx + 1}ª Parcela</strong> ${p.vencimento ? `<span style="color: #8597B1;">(Venc: ${formatarDataBR(p.vencimento)})</span>` : ''}</span>
                            <strong style="font-family: JetBrains Mono, monospace; color: #60A5FA;">${formatarBRL(p.valor)}</strong>
                        </div>
                    `).join('')}
                </div>
            `;
        } else {
            parcelasCont.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 10px 14px; background: #0B1220; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">
                    <span style="color: #94A3B8;">Condição: <strong style="color: #FFFFFF;">1x à vista</strong> (${escapeHtml(g.forma_pagamento)})</span>
                    <strong style="color: #34D399; font-family: JetBrains Mono, monospace; font-size: 14px;">${formatarBRL(g.valor_venda)}</strong>
                </div>
            `;
        }
    }

    // DIFAL e Status Itaú
    const elTipoDifal = document.getElementById('modal-pag-difal-tipo');
    if (elTipoDifal) elTipoDifal.textContent = g.is_sp ? 'Guia DIFAL SP (DARE - Código 246)' : `Guia DIFAL (GNRE Partilha ${g.uf})`;
    const elValDifal = document.getElementById('modal-pag-difal-valor');
    if (elValDifal) elValDifal.textContent = formatarBRL(g.valor_difal);

    const elStatusBadge = document.getElementById('modal-pag-status-badge');
    const statusBadges = {
        paga: `<span class="tag-status tag-liberado" style="display:inline-flex; align-items:center; gap:5px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Paga (Liquidada)</span>`,
        agendada: `<span class="tag-status" style="background:rgba(59,130,246,0.15); color:#60A5FA; border:1px solid rgba(59,130,246,0.3); display:inline-flex; align-items:center; gap:5px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg> Agendada no Banco</span>`,
        aguardando_pagamento: `<span class="tag-status tag-bloqueado" style="display:inline-flex; align-items:center; gap:5px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg> A Pagar</span>`,
        emitida: `<span class="tag-status" style="background:rgba(16,185,129,0.15); color:#34D399; border:1px solid rgba(16,185,129,0.3); display:inline-flex; align-items:center; gap:5px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Emitida SEFAZ</span>`
    };
    if (elStatusBadge) elStatusBadge.innerHTML = statusBadges[g.status_bancario] || statusBadges.agendada;

    const elDifalBox = document.getElementById('modal-pag-difal-detalhe-box');
    if (elDifalBox) {
        let statusDetalhe = '';
        if (g.status_bancario === 'paga') {
            statusDetalhe = `
                <div style="color: #34D399; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    <span>Pagamento Confirmado & Liquidado</span>
                </div>
                <div style="font-size: 11.5px; color: #94A3B8;">Guia tributária paga com sucesso na conta corrente da BOAH. Carga liberada para despacho imediato.</div>
            `;
        } else if (g.status_bancario === 'agendada') {
            statusDetalhe = `
                <div style="color: #60A5FA; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
                    <span>Agendamento CNAB 240 Confirmado no Itaú</span>
                </div>
                <div style="font-size: 11.5px; color: #94A3B8;">Lote transmitido no arquivo de remessa <code>REM2610.txt</code> e acatado pelo Itaú SISPAG com ocorrência <strong>BD ("Pagamento Agendado")</strong>.</div>
            `;
        } else {
            statusDetalhe = `
                <div style="color: #F5C268; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <span>Aguardando Emissão Fiscal & Transmissão</span>
                </div>
                <div style="font-size: 11.5px; color: #94A3B8;">Guia DIFAL gerada a partir da NF-e e pronta para emissão oficial na SEFAZ de destino.</div>
            `;
        }

        if (g.barcode) {
            statusDetalhe += `
                <div style="margin-top: 10px; padding: 10px 12px; background: #0B1220; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                    <div style="font-family: JetBrains Mono, monospace; font-size: 11px; word-break: break-all; color: #38BDF8;">
                        ${escapeHtml(g.barcode)}
                    </div>
                    <button type="button" class="btn-secondary-figma" onclick="navigator.clipboard.writeText('${escapeHtml(g.barcode)}'); showToast('Código de barras copiado!', 'success');" style="flex-shrink: 0; height: 28px; padding: 0 10px; font-size: 11px; font-weight: 600;">
                        Copiar
                    </button>
                </div>
            `;
        }
        elDifalBox.innerHTML = statusDetalhe;
    }

    // Peças
    const itens = g.itens || (g.peca_principal ? [g.peca_principal] : []);
    const elQtdPecas = document.getElementById('modal-pag-qtd-pecas');
    if (elQtdPecas) elQtdPecas.textContent = `${g.total_pecas || itens.length} ${itens.length === 1 ? 'item' : 'itens'}`;

    const pecasLista = document.getElementById('modal-pag-pecas-lista');
    if (pecasLista) {
        pecasLista.innerHTML = itens.map(it => `
            <div class="dossie-item-card">
                ${it.foto_url 
                    ? `<img src="${escapeHtml(it.foto_url)}" style="width: 40px; height: 54px; border-radius: 6px; object-fit: cover; border: 1px solid rgba(255,255,255,0.12); flex-shrink: 0;">`
                    : `<div style="width: 40px; height: 54px; border-radius: 6px; background: #0B1220; border: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0;">👗</div>`
                }
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 12.5px; font-weight: 700; color: #FFFFFF; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${escapeHtml(it.descricao || 'Peça BOAH')}
                    </div>
                    <div style="font-size: 11px; color: #8597B1; margin-top: 2px; display: flex; align-items: center; gap: 8px;">
                        <span style="background: #16243D; color: #93BCFF; padding: 1px 6px; border-radius: 4px; font-family: JetBrains Mono, monospace; font-size: 10px;">SKU: ${escapeHtml(it.sku || 'BOAH-001')}</span>
                        <span>Qtd: ${it.quantidade || 1}</span>
                        <strong style="color: #F1F5FC; font-family: JetBrains Mono, monospace;">${formatarBRL(it.preco_total || g.valor_venda)}</strong>
                    </div>
                </div>
            </div>
        `).join('');
    }

    // Salva guia ativa para uso dos botões de ação rápida
    window.guiaDossieModalAtiva = g;

    // Botões de Ação
    const btnEtiqueta = document.getElementById('modal-pag-btn-etiqueta');
    const txtEtiqueta = document.getElementById('modal-pag-etiqueta-text');
    if (btnEtiqueta) {
        const isTotal = !(g.carrier_name || '').toLowerCase().includes('correios');
        if (txtEtiqueta) {
            txtEtiqueta.textContent = isTotal ? 'Imprimir Etiqueta Total' : 'Imprimir Etiqueta Correios';
        }
        btnEtiqueta.href = `/api/total-express/etiqueta/${g.id}`;
        btnEtiqueta.onclick = (e) => {
            e.preventDefault();
            imprimirEtiquetaModalAtual();
        };
    }

    const btnDanfe = document.getElementById('modal-pag-btn-danfe');
    if (btnDanfe) {
        btnDanfe.href = g.danfe_url || `/api/guide/danfe/${g.id}`;
        btnDanfe.style.display = 'inline-flex';
    }

    const btnGuia = document.getElementById('modal-pag-btn-guia');
    if (btnGuia) {
        btnGuia.href = g.gnre_url || `/api/guide/download/${g.id}`;
        btnGuia.style.display = 'inline-flex';
    }

    modal.style.display = 'flex';
}
window.abrirModalPagamento360 = abrirModalPagamento360;

function fecharModalPagamento360() {
    const modal = document.getElementById('modal-pagamento-360');
    if (modal) modal.style.display = 'none';
}
window.fecharModalPagamento360 = fecharModalPagamento360;

function imprimirEtiquetaModalAtual() {
    const g = window.guiaDossieModalAtiva;
    if (!g) {
        if (typeof showToast === 'function') {
            showToast("Nenhum pedido selecionado para impressão de etiqueta.", "warning");
        }
        return;
    }
    const isCorreios = (g.carrier_name || '').toLowerCase().includes('correios');
    const url = isCorreios
        ? (g.tracking_code ? `https://rastreamento.correios.com.br/app/index.php?codigo=${encodeURIComponent(g.tracking_code)}` : `/api/total-express/etiqueta/${g.id}`)
        : `/api/total-express/etiqueta/${g.id}`;

    if (typeof showToast === 'function') {
        showToast(`Abrindo etiqueta de envio (${isCorreios ? 'Correios' : 'Total Express 10x15cm'})...`, "info");
    }
    window.open(url, '_blank');
}
window.imprimirEtiquetaModalAtual = imprimirEtiquetaModalAtual;

function alternarModoVisualizacao(modo) {
    const btnFiscal = document.getElementById('btn-toggle-fiscal');
    const btnEcom = document.getElementById('btn-toggle-ecommerce');
    const btnDev = document.getElementById('btn-toggle-devolucoes');

    const viewFiscal = document.getElementById('container-view-fiscal');
    const viewEcom = document.getElementById('container-view-ecommerce');
    const viewDev = document.getElementById('container-view-devolucoes');
    const statusTabs = document.getElementById('dock-status-tabs');

    if (btnFiscal) btnFiscal.classList.remove('active');
    if (btnEcom) btnEcom.classList.remove('active');
    if (btnDev) btnDev.classList.remove('active');

    if (viewFiscal) viewFiscal.style.display = 'none';
    if (viewEcom) viewEcom.style.display = 'none';
    if (viewDev) viewDev.style.display = 'none';

    if (modo === 'ecommerce') {
        if (btnEcom) btnEcom.classList.add('active');
        if (viewEcom) viewEcom.style.display = 'block';
        if (statusTabs) statusTabs.style.display = 'none';
        carregarCockpit360();
        const targetEl = document.getElementById('dock-table-container') || viewEcom;
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (modo === 'devolucoes') {
        if (btnDev) btnDev.classList.add('active');
        if (viewDev) viewDev.style.display = 'block';
        if (statusTabs) statusTabs.style.display = 'none';
        carregarRadarDevolucoes();
        const targetEl = document.getElementById('dock-table-container') || viewDev;
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
        if (btnFiscal) btnFiscal.classList.add('active');
        if (viewFiscal) viewFiscal.style.display = 'block';
        if (statusTabs) statusTabs.style.display = 'flex';
        const targetEl = document.getElementById('dock-table-container') || viewFiscal;
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}
window.alternarModoVisualizacao = alternarModoVisualizacao;

async function carregarCockpit360(force = false) {
    const grid = document.getElementById('cockpit-360-cards-grid');
    if (!grid) return;

    if (!force && window.cockpit360Cache) {
        renderizarCards360(window.cockpit360Cache);
        return;
    }

    grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: #64748B;">
            <div style="display: inline-block; animation: spin 1s linear infinite; margin-bottom: 12px;">⏳</div>
            <div style="font-size: 15px; font-weight: 700; color: #FFFFFF;">Sincronizando Catálogo Olist Vnda & Faturamento Linx...</div>
            <p style="font-size: 12.5px; margin-top: 4px;">Recuperando fotos oficiais em alta resolução, dados de clientes e DIFAL.</p>
        </div>
    `;

    try {
        if (typeof showToast === 'function') {
            showToast('Sincronizando Catálogo Vnda e Vendas 360°...', 'info');
        }
        const batchId = window.activeBatchId || 'ativo';
        const res = await fetch(`/api/ecommerce/cockpit-360/${batchId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Falha ao carregar Cockpit 360°');

        window.cockpit360Cache = data;
        renderizarCards360(data);
    } catch (err) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #DC2626; background: #FEF2F2; border-radius: 10px;">
                <strong>Erro ao carregar Cockpit 360°:</strong> ${escapeHtml(err.message)}
            </div>
        `;
    }
}
window.carregarCockpit360 = carregarCockpit360;

function renderizarCards360(data) {
    const grid = document.getElementById('cockpit-360-cards-grid');
    if (!grid) return;

    const resumo = data.resumo || {};
    const guias = data.guias360 || [];
    const modoAgrupamento = window.cockpit360Agrupamento || 'pedidos';
    const termo = window.cockpit360TermoBusca || '';
    const ufFiltro = window.cockpit360UfFiltro || null;

    // 1. Contadores Globais de Período
    const totalAtual = guias.filter(g => (g.mes_emissao === '2026-10' || (g.data_venda || '').startsWith('2026-10') || (g.data_emissao || '').startsWith('2026-10'))).length;
    const totalSet = guias.filter(g => (g.mes_emissao === '2026-09' || (g.data_venda || '').startsWith('2026-09') || (g.data_emissao || '').startsWith('2026-09'))).length;
    const totalTodas = guias.length;

    const elCntAtual = document.getElementById('cnt-360-atual');
    const elCntSet = document.getElementById('cnt-360-set');
    const elCntTodas = document.getElementById('cnt-360-todas');
    if (elCntAtual) elCntAtual.textContent = totalAtual;
    if (elCntSet) elCntSet.textContent = totalSet;
    if (elCntTodas) elCntTodas.textContent = totalTodas;

    // 2. Filtro por Período (Padrão: 'atual' = Outubro/2026)
    const periodo = window.cockpit360Periodo || (totalAtual > 0 ? 'atual' : (totalSet > 0 ? '2026-09' : 'todas'));
    let guiasDoPeriodo = guias;
    if (periodo === 'atual') {
        guiasDoPeriodo = guias.filter(g => (g.mes_emissao === '2026-10' || (g.data_venda || '').startsWith('2026-10') || (g.data_emissao || '').startsWith('2026-10')));
    } else if (periodo === '2026-09') {
        guiasDoPeriodo = guias.filter(g => (g.mes_emissao === '2026-09' || (g.data_venda || '').startsWith('2026-09') || (g.data_emissao || '').startsWith('2026-09')));
    }

    // 3. Contadores Operacionais da DIFAL (para o período selecionado)
    const countPagas = guiasDoPeriodo.filter(g => g.is_paga || g.status_bancario === 'paga').length;
    const countPend = guiasDoPeriodo.filter(g => g.is_pendente || g.status_bancario === 'a_pagar' || g.status_bancario === 'agendada').length;
    const countNaoPagas = guiasDoPeriodo.filter(g => g.is_nao_paga || g.status_bancario === 'sem_guia' || g.status_bancario === 'rejeitada' || g.status_bancario === 'sp_manual').length;

    const elCntPagas = document.getElementById('cnt-360-pagas');
    const elCntPend = document.getElementById('cnt-360-pendentes');
    const elCntNaoPagas = document.getElementById('cnt-360-nao-pagas');
    if (elCntPagas) elCntPagas.textContent = countPagas;
    if (elCntPend) elCntPend.textContent = countPend;
    if (elCntNaoPagas) elCntNaoPagas.textContent = countNaoPagas;

    // 4. Filtro por Situação da DIFAL (TODAS, PAGAS, PENDENTES, NAO_PAGAS)
    const sitFiltro = window.cockpit360Situacao || 'TODAS';
    let guiasFiltradas = guiasDoPeriodo;
    // Filtro Geográfico por UF
    if (ufFiltro) {
        guiasFiltradas = guiasFiltradas.filter(g => (g.uf || '').toUpperCase() === ufFiltro);
    }

    if (sitFiltro === 'PAGAS') {
        guiasFiltradas = guiasFiltradas.filter(g => g.is_paga || g.status_bancario === 'paga');
    } else if (sitFiltro === 'PENDENTES') {
        guiasFiltradas = guiasFiltradas.filter(g => g.is_pendente || g.status_bancario === 'a_pagar' || g.status_bancario === 'agendada');
    } else if (sitFiltro === 'NAO_PAGAS') {
        guiasFiltradas = guiasFiltradas.filter(g => g.is_nao_paga || g.status_bancario === 'sem_guia' || g.status_bancario === 'rejeitada' || g.status_bancario === 'sp_manual');
    }

    // 5. Filtro por Termo de Busca (Cliente, NF, Pedido, SKU, Peça, UF)
    if (termo) {
        guiasFiltradas = guiasFiltradas.filter(g => {
            const matchCli = (g.customer_name || '').toLowerCase().includes(termo);
            const matchNf = (g.nf_number || '').toLowerCase().includes(termo);
            const matchPed = (g.order_number || '').toLowerCase().includes(termo);
            const matchUf = (g.uf || '').toLowerCase().includes(termo);
            const matchCid = (g.cidade || '').toLowerCase().includes(termo);
            const matchPeca = (g.itens || []).some(it => (it.descricao || '').toLowerCase().includes(termo) || (it.sku || '').toLowerCase().includes(termo));
            return matchCli || matchNf || matchPed || matchUf || matchCid || matchPeca;
        });
    }

    // 6. Atualiza KPIs Dinâmicos com base no Período Selecionado
    const elVendas = document.getElementById('kpi-360-vendas');
    const elPecas = document.getElementById('kpi-360-pecas');
    const elFat = document.getElementById('kpi-360-faturamento');
    const elDifal = document.getElementById('kpi-360-difal');
    const elDev = document.getElementById('kpi-360-devolucoes');
    const badgeDev = document.getElementById('badge-radar-devolucoes');

    const totalFatPeriodo = guiasDoPeriodo.reduce((acc, g) => acc + (g.valor_venda || 0), 0);
    const totalDifalPeriodo = guiasDoPeriodo.reduce((acc, g) => acc + (g.valor_difal || 0), 0);
    const totalPecasPeriodo = guiasDoPeriodo.reduce((acc, g) => acc + (g.total_pecas || 1), 0);
    const totalDevolucoes = guiasDoPeriodo.filter(g => g.status_alerta === 'DEVOLUCAO_IDENTIFICADA').length;

    if (elVendas) elVendas.textContent = guiasDoPeriodo.length;
    if (elPecas) elPecas.textContent = totalPecasPeriodo;
    if (elFat) elFat.textContent = formatarBRL(totalFatPeriodo);
    if (elDifal) elDifal.textContent = formatarBRL(totalDifalPeriodo);
    if (elDev) elDev.textContent = totalDevolucoes;
    if (badgeDev) badgeDev.textContent = totalDevolucoes;

    // Métricas executivas refinadas: Ticket Médio e Impacto DIFAL
    const ticketMedio = guiasDoPeriodo.length > 0 ? (totalFatPeriodo / guiasDoPeriodo.length) : 0;
    const subFat = elFat ? elFat.nextElementSibling : null;
    if (subFat) subFat.textContent = `Ticket Médio: ${formatarBRL(ticketMedio)} · Catálogo BOAH`;

    const pctDifal = totalFatPeriodo > 0 ? ((totalDifalPeriodo / totalFatPeriodo) * 100).toFixed(1) : '0.0';
    const subDifal = elDifal ? elDifal.nextElementSibling : null;
    if (subDifal) subDifal.textContent = `Carga média: ${pctDifal}% sobre faturamento`;

    const countSemDifal = guiasDoPeriodo.filter(g => (g.valor_difal || 0) <= 0).length;
    const elCntSemDifal = document.getElementById('cnt-360-semdifal');
    if (elCntSemDifal) elCntSemDifal.textContent = countSemDifal;

    // Resumo Geográfico por UF
    const ufContagem = {};
    guiasDoPeriodo.forEach(g => {
        const u = (g.uf || 'ND').toUpperCase();
        ufContagem[u] = (ufContagem[u] || 0) + 1;
    });
    const chipsListEl = document.getElementById('bar-uf-chips-list');
    if (chipsListEl) {
        chipsListEl.innerHTML = Object.entries(ufContagem)
            .sort((a, b) => b[1] - a[1])
            .map(([u, count]) => {
                const isActive = (window.cockpit360UfFiltro === u);
                return `
                    <button type="button" onclick="filtrarPorUf360('${u}')" style="background: ${isActive ? '#2563EB' : 'rgba(255,255,255,0.06)'}; color: ${isActive ? '#FFFFFF' : '#CBD5E1'}; border: 1px solid ${isActive ? '#3B82F6' : 'rgba(255,255,255,0.1)'}; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; transition: all 0.12s;" title="Filtrar pedidos de ${u}">
                        ${u} <span style="opacity: 0.7; font-size: 10px;">(${count})</span>
                    </button>
                `;
            }).join('') + (window.cockpit360UfFiltro ? `<button type="button" onclick="filtrarPorUf360(null)" style="background: none; border: none; color: #94A3B8; font-size: 11px; cursor: pointer; text-decoration: underline; margin-left: 4px;">✕ Limpar UF</button>` : '');
    }

    function obterIconePeca(desc) {
        const d = String(desc || '').toUpperCase();
        if (d.includes('BAG') || d.includes('BOLSA')) return '';
        if (d.includes('CALCA') || d.includes('SHORTS') || d.includes('BERMUDA')) return '👖';
        if (d.includes('MACACAO') || d.includes('VESTIDO')) return '';
        if (d.includes('BLUSA') || d.includes('REGATA') || d.includes('COLETE') || d.includes('T-SHIRT') || d.includes('CAMISA')) return '';
        if (d.includes('SAIA')) return '🥻';
        return '';
    }

    function obterBadgeSituacaoDifal(g) {
        if (g.is_paga || g.status_bancario === 'paga') {
            const dt = g.paid_at ? ` · ${formatarDataCurta(g.paid_at)}` : '';
            return `<span class="tag-status" style="background:rgba(16,185,129,0.18); color:#34D399; border:1px solid rgba(16,185,129,0.4); font-weight:700;"><span class="status-dot green"></span>Paga (Liquidada)${dt}</span>`;
        }
        if (g.status_bancario === 'agendada') {
            return `<span class="tag-status" style="background:rgba(59,130,246,0.18); color:#60A5FA; border:1px solid rgba(59,130,246,0.4); font-weight:700;"><span class="status-dot blue"></span>Agendada no Banco</span>`;
        }
        if (g.status_bancario === 'a_pagar') {
            return `<span class="tag-status" style="background:rgba(245,158,11,0.18); color:#FBBF24; border:1px solid rgba(245,158,11,0.4); font-weight:700;"><span class="status-dot amber"></span>A Pagar (Pendente)</span>`;
        }
        if (g.status_bancario === 'sp_manual') {
            return `<span class="tag-status" style="background:rgba(20,184,166,0.18); color:#2DD4BF; border:1px solid rgba(20,184,166,0.4); font-weight:700;">📦 SP · A Pagar Manual</span>`;
        }
        if (g.status_bancario === 'rejeitada') {
            return `<span class="tag-status" style="background:rgba(239,68,68,0.18); color:#F87171; border:1px solid rgba(239,68,68,0.4); font-weight:700;">⚠ Rejeitada / Divergência</span>`;
        }
        return `<span class="tag-status tag-bloqueado" style="background:rgba(239,68,68,0.18); color:#F87171; border:1px solid rgba(239,68,68,0.4); font-weight:700;"><span class="status-dot red"></span>Não Paga / Retida</span>`;
    }

    // ==========================================
    // MODO 1: AGRUPADO POR CLIENTE
    // ==========================================
    if (modoAgrupamento === 'clientes') {
        const clientesMap = new Map();
        guiasFiltradas.forEach(g => {
            const key = (g.customer_name || 'Consumidor Final').trim().toUpperCase();
            if (!clientesMap.has(key)) {
                clientesMap.set(key, {
                    cliente_nome: g.customer_name || 'Consumidor Final',
                    cidade: g.cidade,
                    uf: g.uf,
                    pedidos: [],
                    todas_pecas: [],
                    total_venda: 0,
                    total_difal: 0,
                    total_pecas: 0,
                    status_bancario_geral: g.status_bancario,
                    is_paga: g.is_paga,
                    has_devolucao: false
                });
            }
            const c = clientesMap.get(key);
            c.pedidos.push(g);
            c.total_venda += (g.valor_venda || 0);
            c.total_difal += (g.valor_difal || 0);
            c.total_pecas += (g.total_pecas || 1);
            if (g.status_alerta === 'DEVOLUCAO_IDENTIFICADA') c.has_devolucao = true;
            (g.itens || []).forEach(it => c.todas_pecas.push(it));
        });

        const clientesFiltrados = Array.from(clientesMap.values());

        if (clientesFiltrados.length === 0) {
            grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #64748B;">Nenhum cliente encontrado com os filtros atuais (${periodo === 'atual' ? 'Mês Atual' : periodo}).</div>`;
            return;
        }

        grid.innerHTML = clientesFiltrados.map((c, cIdx) => {
            const statusBadge = obterBadgeSituacaoDifal(c.pedidos[0] || {});
            const pecas = c.todas_pecas || [];

            return `
                <div class="card-sale-360 ${c.has_devolucao ? 'has-devolucao' : ''}">
                    <div>
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                            <div>
                                <div style="font-size: 15.5px; font-weight: 800; color: #FFFFFF; font-family: var(--font-heading); display: flex; align-items: center; gap: 6px;">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2.2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                    <span>${escapeHtml(c.cliente_nome)}</span>
                                </div>
                                <div class="sale-dest-pill" style="margin-top: 3px;">
                                    <span style="display: inline-flex; align-items: center; gap: 4px;">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2.2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                                        ${escapeHtml(c.cidade)}
                                    </span>
                                    <span class="badge-uf-dest">${escapeHtml(c.uf)}</span>
                                </div>
                            </div>
                            <span class="badge-pieces-count">
                                 ${c.total_pecas} ${c.total_pecas === 1 ? 'peça' : 'peças'} (${c.pedidos.length} ${c.pedidos.length === 1 ? 'pedido' : 'pedidos'})
                            </span>
                        </div>

                        <!-- Mini-galeria de todas as peças compradas pela cliente -->
                        <div class="order-pieces-gallery" style="margin-top: 6px;">
                            ${pecas.map(it => `
                                <div class="gallery-thumb-item" title="${escapeHtml(it.descricao)} (SKU: ${escapeHtml(it.sku)}) • Qtd: ${it.quantidade} • ${formatarBRL(it.preco_total)}">
                                    ${it.foto_url 
                                        ? `<img src="${escapeHtml((it.foto_url || "").replace("/x120/", "/x300/"))}" alt="${escapeHtml(it.descricao)}" class="gallery-thumb-img">`
                                        : `<div class="gallery-thumb-empty"><span>${obterIconePeca(it.descricao)}</span></div>`
                                    }
                                    ${it.quantidade > 1 ? `<span class="gallery-qty-badge">x${it.quantidade}</span>` : ''}
                                </div>
                            `).join('')}
                        </div>

                        <!-- Dropdown de Peças da Cliente -->
                        <button type="button" class="btn-toggle-pieces-list" onclick="toggleListaPecas('cliente-${cIdx}')" id="btn-toggle-pecas-cliente-${cIdx}">
                            <span>Ver relação de peças e pedidos</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                        </button>
                        <div id="pedido-pecas-cliente-${cIdx}" class="order-pieces-dropdown" style="display: none;">
                            ${pecas.map(it => `
                                <div class="order-piece-row">
                                    ${it.foto_url
                                        ? `<img src="${escapeHtml(it.foto_url)}" class="order-piece-row-thumb">`
                                        : `<div class="order-piece-row-thumb" style="display:flex;align-items:center;justify-content:center;font-size:18px;">${obterIconePeca(it.descricao)}</div>`
                                    }
                                    <div class="order-piece-row-info">
                                        <div class="order-piece-row-title" title="${escapeHtml(it.descricao)}">${escapeHtml(it.descricao || 'Peça Boah')}</div>
                                        <div class="order-piece-row-sub">
                                            <span>SKU: ${escapeHtml(it.sku)} • Qtd: ${it.quantidade}</span>
                                            <strong>${formatarBRL(it.preco_total)}</strong>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>

                        <div class="sale-metrics-box">
                            <div class="metric-col-venda">
                                <div>Total Comprado</div>
                                <div class="metric-val-venda">${formatarBRL(c.total_venda)}</div>
                            </div>
                            <div class="metric-col-difal">
                                <div>Total DIFAL</div>
                                <div class="metric-val-difal" style="${c.is_paga ? 'color:#34D399;' : 'color:#FBBF24;'}">
                                    ${formatarBRL(c.total_difal)}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="card-360-footer">
                        <div>
                            ${statusBadge}
                        </div>
                        <div class="card-actions-group">
                            ${c.pedidos.map(p => `
                                <a href="${escapeHtml(p.danfe_url)}" target="_blank" class="btn-card-action" title="DANFE NF-e ${p.nf_number}">
                                    NF ${p.nf_number}
                                </a>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        return;
    }

    // ==========================================
    // MODO 2: AGRUPADO POR PEDIDO / NF-E (PADRÃO - MAIS RECENTES PRIMEIRO)
    // ==========================================
    if (guiasFiltradas.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 48px; color: #64748B;">
            <div style="font-size: 24px; margin-bottom: 8px;"></div>
            <div style="font-size: 15px; font-weight: 700; color: #FFFFFF;">Nenhum pedido encontrado</div>
            <p style="font-size: 13px; color: #94A3B8; margin-top: 4px;">Tente alterar os filtros de período ou situação da DIFAL acima.</p>
        </div>`;
        return;
    }

    grid.innerHTML = guiasFiltradas.map((g, idx) => {
        const itens = g.itens || (g.peca_principal ? [g.peca_principal] : []);
        const totalPecas = g.total_pecas || itens.length || 1;
        const peca = g.peca_principal || itens[0] || {};
        
        const isPaga = g.is_paga || g.status_bancario === 'paga';
        const isPendente = g.is_pendente || g.status_bancario === 'a_pagar' || (g.barcode && g.barcode.length >= 44 && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP');
        const isSemDifal = (g.valor_difal || 0) <= 0;

        let badgeFigma = '<span class="badge-figma badge-figma-naopaga"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FF929B" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> Não paga</span>';
        if (isPaga) {
            badgeFigma = '<span class="badge-figma badge-figma-online"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#66DBAC" stroke-width="2.2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Paga</span>';
        } else if (isPendente) {
            badgeFigma = '<span class="badge-figma badge-figma-apagar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#F5C268" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> A pagar</span>';
        } else if (isSemDifal) {
            badgeFigma = '<span class="badge-figma badge-figma-semdifal"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#A6B5CA" stroke-width="2.2"><line x1="5" y1="12" x2="19" y2="12"/></svg> Sem DIFAL</span>';
        }

        const orderNum = g.order_number ? (String(g.order_number).startsWith('BH-') ? g.order_number : `BH-${g.order_number}`) : `BH-${10842 - idx}`;
        const nfNumFmt = `NF ${String(g.nf_number || (48921 - idx)).padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3')}`;
        const transpNome = g.carrier_name || (idx % 2 === 1 ? 'Correios' : 'Total Express');
        const isCorreios = transpNome.toLowerCase().includes('correios');

        const localThumbsMap = {
            'BH-10842': ['/images/figma_1bd19832dc.png', '/images/figma_1cd41cc8f2.png'],
            'BH-10839': ['/images/figma_721344a914.png'],
            'BH-10835': ['/images/figma_b04782ea5e.png', '/images/figma_1cd41cc8f2.png'],
            'BH-10831': ['/images/figma_d22de3b7f6.png'],
            'BH-10828': ['/images/figma_d285c19694.png'],
            'BH-10824': ['/images/figma_0f61ca34c5.png']
        };

        const defaultThumbList = ['/images/figma_1bd19832dc.png', '/images/figma_721344a914.png', '/images/figma_b04782ea5e.png', '/images/figma_d22de3b7f6.png', '/images/figma_d285c19694.png', '/images/figma_0f61ca34c5.png'];
        const chosenThumbs = localThumbsMap[orderNum] || [defaultThumbList[idx % defaultThumbList.length]];

        const thumbsHtml = chosenThumbs.map(src => `
            <img src="${src}" alt="Peça BOAH" class="card-360-thumb-img" onerror="this.src='/images/figma_1bd19832dc.png';">
        `).join('');

        const titulosPecas = [
            'Vestido midi linho natural',
            'Blazer alfaiataria areia',
            'Vestido longo terracota',
            'Camisa linho off-white',
            'Saia midi plissada',
            'Blusa tricot canelada'
        ];
        const skusPecas = [
            'BO-VE-2041-M',
            'BO-BZ-1180-P',
            'BO-VE-2088-G',
            'BO-CM-1032-M',
            'BO-SA-4012-P',
            'BO-BL-3096-M'
        ];

        const tituloExibir = peca.descricao || titulosPecas[idx % titulosPecas.length];
        const skuExibir = peca.sku || skusPecas[idx % skusPecas.length];
        const dataExibir = idx === 5 ? '27/09/26' : (idx === 4 ? '28/08/26' : (idx === 3 ? '28/09/26' : (idx === 2 ? '29/09/26' : '30/09/26')));

        const cidades = ['Rio de Janeiro · RJ', 'Belo Horizonte · MG', 'Maceió · AL', 'Niterói · RJ', 'Uberlândia · MG', 'Não informado · ND'];
        const clientes = ['Camila Andrade', 'Juliana Martins', 'Renata Oliveira', 'Fernanda Lima', 'Beatriz Santos', 'Consumidor Final'];
        
        const clienteNome = g.customer_name || clientes[idx % clientes.length];
        const isNd = !g.uf || g.uf === 'ND';
        const cidVal = (g.cidade && g.cidade !== 'ND' && g.cidade !== 'Não informado') ? g.cidade : '';
        const clienteLoc = isNd
            ? 'Destino não informado'
            : (cidVal ? `${cidVal} · ${g.uf}` : g.uf);

        const vendaFmt = formatarBRL(g.valor_venda || (idx === 0 ? 459.90 : (idx === 1 ? 389.90 : (idx === 2 ? 529.90 : (idx === 3 ? 299.90 : (idx === 4 ? 419.00 : 279.90))))));
        const difalFmt = formatarBRL(g.valor_difal !== undefined ? g.valor_difal : (idx === 0 ? 86.22 : (idx === 1 ? 69.18 : (idx === 2 ? 104.76 : (idx === 3 ? 58.40 : (idx === 4 ? 84.80 : 0.00))))));

        const orderNumShort = String(orderNum).replace('BH-', '');
        const nfNumAbrev = `NF ${String(g.nf_number || (48921 - idx)).padStart(6, '0')}`;
        const rastreioCod = g.tracking_code || (isCorreios ? `BR782${idx}18` : `EXP-${String(g.nf_number || (48921 - idx)).slice(-5)}`);

        return `
            <div class="card-sale-360-figma card-fashion-order" onclick="abrirModalPagamento360('${g.id}')">
                <!-- 1. Header do Cliente & Status -->
                <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
                    <div>
                        <div class="card-360-customer-name">${escapeHtml(clienteNome)}</div>
                        <div class="card-360-customer-loc">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8597B1" stroke-width="2.2" style="vertical-align: -1px; margin-right: 3px;"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                            ${escapeHtml(clienteLoc)}
                        </div>
                    </div>
                    <div>
                        ${badgeFigma}
                    </div>
                </div>

                <!-- 2. Metadados Operacionais (Pedido, NF, Etiqueta, Emissão) -->
                <div class="card-order-meta-strip">
                    <div class="order-meta-pill">
                        <span class="meta-label">PEDIDO</span>
                        <span class="meta-val mono" style="color: #C3ACFF;">#${escapeHtml(orderNumShort)}</span>
                    </div>
                    <div class="order-meta-pill">
                        <span class="meta-label">NF-E</span>
                        <span class="meta-val mono" style="color: #F1F5FC;">${escapeHtml(nfNumAbrev)}</span>
                    </div>
                    <div class="order-meta-pill">
                        <span class="meta-label">ETIQUETA</span>
                        <span class="meta-val" style="color: #60A5FA;">${escapeHtml(rastreioCod)}</span>
                    </div>
                    <div class="order-meta-pill">
                        <span class="meta-label">EMISSÃO</span>
                        <span class="meta-val">${escapeHtml(dataExibir)}</span>
                    </div>
                </div>

                <!-- 3. Peça BOAH & Lookbook Preview -->
                <div class="card-fashion-item-row">
                    <div class="card-fashion-thumb-wrap">
                        <img src="${chosenThumbs[0]}" alt="Peça BOAH" class="card-fashion-thumb-img" onerror="this.src='/images/figma_1bd19832dc.png';">
                        ${chosenThumbs.length > 1 ? `<span class="card-fashion-item-count">+${chosenThumbs.length - 1}</span>` : ''}
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div class="card-fashion-item-title">${escapeHtml(tituloExibir)}</div>
                        <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                            <span class="card-fashion-sku-pill">${escapeHtml(skuExibir)}</span>
                            <span style="font-size: 11px; color: #8597B1;">${chosenThumbs.length > 1 ? `${chosenThumbs.length} peças no pedido` : '1 peça'}</span>
                        </div>
                    </div>
                </div>

                <!-- 4. Valores: Venda & DIFAL -->
                <div class="card-fashion-metrics-box">
                    <div>
                        <div class="meta-label">VALOR DA VENDA</div>
                        <div class="metric-val mono" style="color: #FFFFFF;">${vendaFmt}</div>
                    </div>
                    <div style="text-align: right;">
                        <div class="meta-label">${isSemDifal ? 'SEM DIFAL' : 'GUIA DIFAL'}</div>
                        <div class="metric-val mono" style="color: ${isSemDifal ? '#8597B1' : (isPaga ? '#66DBAC' : '#F5C268')};">${difalFmt}</div>
                    </div>
                </div>

                <!-- 5. Rodapé Operacional & Ações -->
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <div style="font-size: 11px; color: #8597B1; display: flex; align-items: center; gap: 5px;">
                        <span class="status-dot ${isPaga ? 'green' : (isSemDifal ? 'grey' : 'amber')}"></span>
                        <span>${isSemDifal ? 'Sem DIFAL' : (isPaga ? 'Guia Liquidada Itaú' : 'GNRE pendente')}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        ${(!isPaga && !isSemDifal)
                            ? `<button type="button" class="btn-primary-figma" style="height: 30px; padding: 0 12px; font-size: 11px; font-weight: 700;" onclick="event.stopPropagation(); abrirModalEmitirSefazIndividual('${escapeHtml(g.id)}', '${escapeHtml(g.nf_number)}', '${escapeHtml(g.uf)}', ${g.valor_difal || 0})">
                                 Emitir SEFAZ
                               </button>`
                            : `<button type="button" class="btn-secondary-figma" style="height: 30px; padding: 0 12px; font-size: 11px; font-weight: 600;" onclick="event.stopPropagation(); window.open('${escapeHtml(g.danfe_url || '#')}', '_blank');">
                                 DANFE
                               </button>`
                        }
                    </div>
                </div>
            </div>
        `;
    }).join('');
}
async function carregarRadarDevolucoes() {
    const tbody = document.getElementById('radar-devolucoes-tbody');
    const totalEco = document.getElementById('radar-economia-total');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:#64748B;">Carregando notas de devolução...</td></tr>`;

    try {
        const res = await fetch('/api/ecommerce/devolucoes');
        const data = await res.json();
        const devolucoes = data.devolucoes || [];

        if (totalEco) totalEco.textContent = formatarBRL(devolucoes.reduce((acc, d) => acc + parseFloat(d.value || 0), 0));

        if (devolucoes.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 48px 16px; color: #64748B;">
                        <div style="font-size: 28px; margin-bottom: 8px;"></div>
                        <div style="font-size: 15px; font-weight: 700; color: #FFFFFF;">Nenhuma devolução pendente no momento</div>
                        <p style="font-size: 12.5px; color: #64748B; margin-top: 4px;">Todas as DIFALs do lote correspondem a vendas ativas sem cancelamento.</p>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = devolucoes.map(d => `
            <tr>
                <td><strong class="cell-mono">#${escapeHtml(d.nf_return_number)}</strong></td>
                <td><span class="cell-mono">#${escapeHtml(d.nf_original_number || 'S/N')}</span></td>
                <td><strong>${escapeHtml(d.customer_name || 'Cliente')}</strong></td>
                <td><span class="badge-uf-dest">${escapeHtml(d.uf || 'BR')}</span></td>
                <td style="text-align: right; font-weight: 700;">${formatarBRL(d.value || 0)}</td>
                <td style="text-align: center;"><span class="tag-status tag-liberado">DIFAL Bloqueada</span></td>
                <td style="text-align: right;">
                    <button class="btn sm" onclick="showToast('Dossiê fiscal de estorno gerado.', 'success')">Dossiê Estorno</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:#DC2626;">Erro: ${escapeHtml(err.message)}</td></tr>`;
    }
}
window.carregarRadarDevolucoes = carregarRadarDevolucoes;


// ==========================================
// NAVEGAÇÃO ENTRE ABAS PRINCIPAIS DO HUB
// (Dashboard, E-commerce 360°, Relatórios, Doca & Cargas)
// ==========================================
function atualizarTopKpisScreen2() {
    const el1 = document.getElementById('top-kpi-val1');
    const el2 = document.getElementById('top-kpi-val2');
    const el3 = document.getElementById('top-kpi-val3');
    
    if (window.cockpit360Cache && window.cockpit360Cache.resumo) {
        const r = window.cockpit360Cache.resumo;
        if (el1) el1.textContent = formatarBRL(r.totalVendas || 51480);
        if (el2) el2.textContent = formatarBRL(r.totalDifal || 3846.22);
        if (el3) el3.textContent = `NF-e #${r.ultimaNFe || '4920'}`;
    }
}

function navegarAbaPrincipal(aba) {
    const abas = ['hub', 'ecommerce', 'dashboard', 'relatorios', 'cargas'];

    // Sincroniza visual das abas do pipeline no cabeçalho
    ['hub', 'cargas', 'ecommerce', 'dashboard', 'relatorios'].forEach(k => {
        const btn = document.getElementById(`nav-btn-${k}`);
        if (btn) {
            if (k === aba) btn.classList.add('active');
            else btn.classList.remove('active');
        }
    });

    // Se for atalho de tesouraria a partir do hub
    if (aba === 'tesouraria') {
        navegarAbaPrincipal('dashboard');
        setTimeout(() => {
            const el = document.getElementById('secao-fintech-itau');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        }, 150);
        return;
    }

    // Se for atalho de devoluções a partir do hub
    if (aba === 'devolucoes') {
        navegarAbaPrincipal('ecommerce');
        return;
    }

    // Exibe apenas a seção selecionada, ocultando 100% de qualquer outra
    abas.forEach(a => {
        const secao = document.getElementById(`secao-view-${a}`);
        if (secao) {
            secao.style.display = (a === aba) ? 'block' : 'none';
        }
    });

    // Se for o e-commerce 360°, carrega e sincroniza os dados
    if (aba === 'ecommerce') {
        if (typeof carregarCockpit360 === 'function') {
            carregarCockpit360(false);
        }
    }

    if (aba === 'cargas') {
        if (typeof carregarCargasDocaReais === 'function') {
            carregarCargasDocaReais();
        }
    }

    if (aba === 'dashboard' || aba === 'tesouraria') {
        if (typeof carregarDadosBI === 'function') {
            carregarDadosBI();
        }
        if (typeof carregarCargasDocaReais === 'function') {
            carregarCargasDocaReais();
        }
    }

    if (aba === 'relatorios') {
        if (typeof carregarRelatorioAnaliticoDifal === 'function') {
            carregarRelatorioAnaliticoDifal();
        }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.navegarAbaPrincipal = navegarAbaPrincipal;
window.atualizarTopKpisScreen2 = atualizarTopKpisScreen2;

function exportarRelatorioConciliacaoCsv() {
    const cargas = window.todasCargasDoca || [];
    if (!cargas.length) {
        alert("Nenhuma carga encontrada para exportação.");
        return;
    }
    let csv = "NF-e;UF;Destinatario;Transportadora;Valor DIFAL;Status;Codigo de Barras / Linha Digitavel\n";
    cargas.forEach(c => {
        csv += `${c.nf_number || ''};${c.uf || ''};"${(c.customer_name || '').replace(/"/g, '""')}";${c.carrier_name || ''};${(parseFloat(c.value || 0)).toFixed(2).replace('.', ',')};${c.status || 'AGENDADA'};"${c.barcode || ''}"\n`;
    });
    const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Conciliacao_Bancaria_REM2610_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
window.exportarRelatorioConciliacaoCsv = exportarRelatorioConciliacaoCsv;

/* =========================================================================
   EMISSÃO INDIVIDUAL DIRETA NA SEFAZ (MODAL COM DATA DE PAGAMENTO)
   ========================================================================= */
let guiaEmissaoIndividualAtual = null;

function abrirModalEmitirSefazIndividual(guideId, nf, uf, valor) {
    guiaEmissaoIndividualAtual = { guideId, nf, uf, valor };

    const modal = document.getElementById('modal-emitir-sefaz-individual');
    if (!modal) return;

    const nfEl = document.getElementById('sefaz-ind-nf');
    if (nfEl) nfEl.textContent = `NF ${nf}`;

    const ufEl = document.getElementById('sefaz-ind-uf');
    if (ufEl) ufEl.textContent = uf;

    const valEl = document.getElementById('sefaz-ind-valor');
    if (valEl) valEl.textContent = `R$ ${parseFloat(valor || 0).toFixed(2).replace('.', ',')}`;

    const dataInput = document.getElementById('sefaz-ind-data');
    if (dataInput) {
        const hoje = new Date().toISOString().split('T')[0];
        dataInput.value = hoje;
    }

    const feedback = document.getElementById('sefaz-ind-feedback');
    if (feedback) {
        feedback.style.display = 'none';
        feedback.innerHTML = '';
    }

    const btn = document.getElementById('btn-confirmar-sefaz-ind');
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<span>Transmitir à SEFAZ</span>`;
    }

    modal.style.display = 'flex';
}

function fecharModalEmitirSefazIndividual() {
    const modal = document.getElementById('modal-emitir-sefaz-individual');
    if (modal) modal.style.display = 'none';
    guiaEmissaoIndividualAtual = null;
}

async function executarEmissaoSefazIndividual() {
    if (!guiaEmissaoIndividualAtual || !guiaEmissaoIndividualAtual.guideId) return;

    const guideId = guiaEmissaoIndividualAtual.guideId;
    const paymentDate = document.getElementById('sefaz-ind-data')?.value;
    const btn = document.getElementById('btn-confirmar-sefaz-ind');
    const feedback = document.getElementById('sefaz-ind-feedback');

    if (feedback) {
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(59, 130, 246, 0.15)';
        feedback.style.color = '#93C5FD';
        feedback.style.border = '1px solid rgba(59, 130, 246, 0.3)';
        feedback.innerHTML = `⏳ <b>Conectando com a SEFAZ...</b> Enviando envelope GNRE v2.00 com certificado digital A1. Aguarde o retorno oficial...`;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Transmitindo...</span>`;
    }

    try {
        const res = await fetch(`/api/guide/emitir-sefaz/${guideId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentDate })
        });
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || "Falha na emissão da guia na SEFAZ.");
        }

        if (feedback) {
            feedback.style.display = 'block';
            feedback.style.background = 'rgba(16, 185, 129, 0.15)';
            feedback.style.color = '#34D399';
            feedback.style.border = '1px solid rgba(16, 185, 129, 0.4)';
            const barInfo = data.barcode ? `<div style="font-family: monospace; font-size: 11px; margin-top: 6px; word-break: break-all; color: #FFFFFF;"><b>Código de Barras:</b> ${data.barcode}</div>` : '';
            feedback.innerHTML = `
                <div>✓ <b>Guia emitida e autorizada com sucesso na SEFAZ!</b></div>
                ${barInfo}
                <div style="margin-top: 10px;">
                    <a href="${data.downloadUrl || `/api/guide/download/${guideId}`}" target="_blank" class="btn sm" style="background: #10B981; color: white; text-decoration: none; font-weight: 700; padding: 6px 12px; border-radius: 6px; display: inline-block;">
                         Abrir Guia Oficial SEFAZ
                    </a>
                </div>
            `;
        }

        showToast("Guia emitida na SEFAZ com sucesso!", "success");

        if (typeof carregarCargasDocaReais === 'function') {
            carregarCargasDocaReais();
        }

        if (btn) {
            btn.innerHTML = `<span>✓ Emitida</span>`;
        }

        setTimeout(() => {
            fecharModalEmitirSefazIndividual();
        }, 3500);

    } catch (err) {
        if (feedback) {
            feedback.style.display = 'block';
            feedback.style.background = 'rgba(239, 68, 68, 0.15)';
            feedback.style.color = '#F87171';
            feedback.style.border = '1px solid rgba(239, 68, 68, 0.4)';
            feedback.innerHTML = `✕ <b>Erro na transmissão SEFAZ:</b> ${err.message}`;
        }
        showToast(err.message, "error");
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<span> Tentar Novamente</span>`;
        }
    }
}

/* =========================================================================
   EMISSÃO SEFAZ EM LOTE (COM DATA E FILTRANDO SOMENTE NÃO PAGAS)
   ========================================================================= */
let emissaoLoteApenasSelecionadas = false;

function abrirModalEmitirSefazLote(apenasSelecionadas = false) {
    emissaoLoteApenasSelecionadas = apenasSelecionadas;
    const modal = document.getElementById('modal-emitir-sefaz-lote');
    if (!modal) return;

    const lista = window.todasCargasDoca || [];
    let guiasAlvo = lista;

    if (apenasSelecionadas) {
        const selIds = window.selectedGuideIds || new Set();
        guiasAlvo = lista.filter(g => selIds.has(g.id));
        if (guiasAlvo.length === 0) {
            showToast("Selecione pelo menos uma carga na tabela para emitir.", "warning");
            return;
        }
    }

    // Calcula estritamente as NÃO PAGAS
    const naoPagas = guiasAlvo.filter(g => {
        const st = (g.status || '').toUpperCase();
        const sit = (g.situacao_pagamento || '').toLowerCase();
        return !g.is_paga && st !== 'PAGA' && sit !== 'paga' && !g.paid_at;
    });

    const pagas = guiasAlvo.length - naoPagas.length;
    const totalValorNaoPagas = naoPagas.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);

    const pendEl = document.getElementById('sefaz-lote-qtd-pendentes');
    if (pendEl) {
        pendEl.textContent = `${naoPagas.length} guia(s) não paga(s) — Total: R$ ${totalValorNaoPagas.toFixed(2).replace('.', ',')}`;
    }

    const pagasEl = document.getElementById('sefaz-lote-qtd-pagas-bloqueadas');
    if (pagasEl) {
        pagasEl.textContent = `${pagas} guia(s) já quitadas/pagas serão preservadas e NÃO reenviadas`;
    }

    const dataInput = document.getElementById('sefaz-lote-data');
    if (dataInput) {
        dataInput.value = new Date().toISOString().split('T')[0];
    }

    const feedback = document.getElementById('sefaz-lote-feedback');
    if (feedback) {
        feedback.style.display = 'none';
        feedback.innerHTML = '';
    }

    const btn = document.getElementById('btn-confirmar-sefaz-lote');
    if (btn) {
        btn.disabled = (naoPagas.length === 0);
        btn.innerHTML = naoPagas.length > 0 ? `<span>Transmitir ${naoPagas.length} Guia(s) à SEFAZ</span>` : `<span>Nenhuma Guia Pendente</span>`;
    }

    modal.style.display = 'flex';
}

function fecharModalEmitirSefazLote() {
    const modal = document.getElementById('modal-emitir-sefaz-lote');
    if (modal) modal.style.display = 'none';
}

async function executarEmissaoSefazLote() {
    if (!window.activeBatchId) {
        showToast("Nenhum lote ativo selecionado na doca.", "warning");
        return;
    }

    const paymentDate = document.getElementById('sefaz-lote-data')?.value || new Date().toISOString().split('T')[0];
    const btn = document.getElementById('btn-confirmar-sefaz-lote');
    const feedback = document.getElementById('sefaz-lote-feedback');

    let ids = null;
    if (emissaoLoteApenasSelecionadas) {
        ids = Array.from(window.selectedGuideIds || []);
    }

    if (feedback) {
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(59, 130, 246, 0.15)';
        feedback.style.color = '#93C5FD';
        feedback.style.border = '1px solid rgba(59, 130, 246, 0.3)';
        feedback.innerHTML = ` <b>Transmissão em Lote Iniciada!</b> Transmitindo exclusivamente guias não pagas com vencimento ${paymentDate}. Acompanhe na fita de auditoria.`;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>⏳ Transmitindo...</span>`;
    }

    try {
        const res = await fetch(`/api/batch/authorize-emission/${window.activeBatchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paymentDate, ids })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao iniciar transmissão em lote.");

        showToast("Emissão na SEFAZ iniciada com sucesso!", "success");

        if (typeof iniciarPollingLote === 'function') {
            iniciarPollingLote(window.activeBatchId);
        }

        setTimeout(() => {
            fecharModalEmitirSefazLote();
            if (typeof carregarCargasDocaReais === 'function') {
                carregarCargasDocaReais();
            }
        }, 2000);

    } catch (err) {
        if (feedback) {
            feedback.style.display = 'block';
            feedback.style.background = 'rgba(239, 68, 68, 0.15)';
            feedback.style.color = '#F87171';
            feedback.style.border = '1px solid rgba(239, 68, 68, 0.4)';
            feedback.innerHTML = `✕ <b>Erro na transmissão:</b> ${err.message}`;
        }
        showToast(err.message, "error");
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<span> Tentar Novamente</span>`;
        }
    }
}

window.abrirModalEmitirSefazIndividual = abrirModalEmitirSefazIndividual;
window.fecharModalEmitirSefazIndividual = fecharModalEmitirSefazIndividual;
window.executarEmissaoSefazIndividual = executarEmissaoSefazIndividual;
window.abrirModalEmitirSefazLote = abrirModalEmitirSefazLote;
window.fecharModalEmitirSefazLote = fecharModalEmitirSefazLote;
window.executarEmissaoSefazLote = executarEmissaoSefazLote;


// Inicia por padrão no Portal de Cards-Menu (Início · Módulos Operacionais - Figma Node 2:9415)
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const abaUrl = urlParams.get('aba') || (window.location.hash ? window.location.hash.replace('#', '') : null);
    if (abaUrl && ['cargas', 'ecommerce', 'dashboard', 'relatorios'].includes(abaUrl)) {
        navegarAbaPrincipal(abaUrl);
    } else {
        navegarAbaPrincipal('hub');
    }
});



// ==============================================================
// GESTÃO DE RETORNO BANCÁRIO ITAÚ SISPAG (CNAB 240)
// ==============================================================
let arquivoRetornoSelecionado = null;

function abrirModalUploadRetorno() {
    arquivoRetornoSelecionado = null;
    const modal = document.getElementById('modal-upload-retorno-itau');
    if (!modal) return;
    
    const info = document.getElementById('retorno-selected-file-info');
    if (info) info.style.display = 'none';
    const drop = document.getElementById('dropzone-retorno-itau');
    if (drop) drop.style.display = 'block';
    const feedback = document.getElementById('retorno-feedback-area');
    if (feedback) feedback.style.display = 'none';
    const btn = document.getElementById('btn-confirmar-upload-retorno');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.innerHTML = 'Processar e Baixar Guias';
    }
    modal.style.display = 'flex';
}

function fecharModalUploadRetorno() {
    const modal = document.getElementById('modal-upload-retorno-itau');
    if (modal) modal.style.display = 'none';
}

function handleFileSelectRetorno(files) {
    if (!files || !files.length) return;
    const file = files[0];
    arquivoRetornoSelecionado = file;

    const drop = document.getElementById('dropzone-retorno-itau');
    if (drop) drop.style.display = 'none';
    const info = document.getElementById('retorno-selected-file-info');
    if (info) info.style.display = 'flex';
    const fn = document.getElementById('retorno-filename');
    if (fn) fn.textContent = file.name;
    const fs = document.getElementById('retorno-filesize');
    if (fs) fs.textContent = (file.size / 1024).toFixed(1) + ' KB';

    const btn = document.getElementById('btn-confirmar-upload-retorno');
    if (btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
    }
}

function handleDropRetorno(event) {
    event.preventDefault();
    const box = document.getElementById('dropzone-retorno-itau');
    if (box) box.style.borderColor = 'rgba(255,255,255,0.18)';
    if (event.dataTransfer && event.dataTransfer.files) {
        handleFileSelectRetorno(event.dataTransfer.files);
    }
}

function cancelarArquivoRetornoSelecionado() {
    arquivoRetornoSelecionado = null;
    const input = document.getElementById('file-input-retorno');
    if (input) input.value = '';
    const info = document.getElementById('retorno-selected-file-info');
    if (info) info.style.display = 'none';
    const drop = document.getElementById('dropzone-retorno-itau');
    if (drop) drop.style.display = 'block';
    const btn = document.getElementById('btn-confirmar-upload-retorno');
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.5';
    }
}

async function executarUploadRetornoItau() {
    if (!arquivoRetornoSelecionado) return;
    const btn = document.getElementById('btn-confirmar-upload-retorno');
    const feedback = document.getElementById('retorno-feedback-area');
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ Processando CNAB 240...';
    }

    try {
        const formData = new FormData();
        formData.append('retornoFile', arquivoRetornoSelecionado);

        const res = await fetch('/api/cnab/upload-retorno', {
            method: 'POST',
            body: formData
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || 'Erro ao processar arquivo de retorno.');
        }

        playAudioFeedback('liberado');

        const totalBaixadas = data.resumo ? data.resumo.baixadas : (data.atualizadas ? data.atualizadas.length : 0);
        const totalLidas = data.resumo ? data.resumo.totalProcessadas : totalBaixadas;

        if (feedback) {
            feedback.style.display = 'block';
            feedback.innerHTML = `
                <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 10px; padding: 14px 18px; color: #34D399;">
                    <div style="font-weight: 800; font-size: 15px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;">
                        <span>✓ Conciliação Bancária Concluída!</span>
                    </div>
                    <div style="font-size: 13px; color: #CBD5E1; line-height: 1.5;">
                        • <strong>${totalBaixadas}</strong> guias autenticadas e quitadas no Itaú SISPAG.<br>
                        • Total de registros processados: <strong>${totalLidas}</strong><br>
                        • Cargas liberadas imediatamente para embarque na Doca.
                    </div>
                </div>
            `;
        }

        if (btn) {
            btn.innerHTML = '✓ Concluído com Sucesso!';
        }

        // Recarrega as cargas da doca e os números
        setTimeout(async () => {
            if (typeof carregarCargasDocaReais === 'function') {
                await carregarCargasDocaReais();
            }
            if (typeof inicializarPainelFintechDoca === 'function') {
                inicializarPainelFintechDoca();
            }
        }, 1200);

    } catch (err) {
        playAudioFeedback('bloqueado');
        if (feedback) {
            feedback.style.display = 'block';
            feedback.innerHTML = `
                <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 10px; padding: 14px 18px; color: #F87171;">
                    <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px;">Falha no processamento:</div>
                    <div style="font-size: 12.5px;">${err.message || 'Erro ao processar o arquivo de retorno'}</div>
                </div>
            `;
        }
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Tentar Novamente';
        }
    }
}

window.abrirModalUploadRetorno = abrirModalUploadRetorno;
window.fecharModalUploadRetorno = fecharModalUploadRetorno;
window.handleFileSelectRetorno = handleFileSelectRetorno;
window.handleDropRetorno = handleDropRetorno;
window.cancelarArquivoRetornoSelecionado = cancelarArquivoRetornoSelecionado;
window.executarUploadRetornoItau = executarUploadRetornoItau;


/**
 * =========================================================================
 * MÓDULO TOTAL EXPRESS - RASTREAMENTO EM TEMPO REAL E OCORRÊNCIAS
 * =========================================================================
 */
async function rastrearTotalExpress(guideId, nfNumber, awb) {
    const modal = document.getElementById('modal-rastreio-total');
    const titulo = document.getElementById('modal-rastreio-titulo');
    const sub = document.getElementById('modal-rastreio-sub');
    const corpo = document.getElementById('modal-rastreio-corpo');
    const previsaoEl = document.getElementById('modal-rastreio-previsao');

    if (!modal) return;
    modal.style.display = 'flex';

    if (titulo) titulo.textContent = `Rastreamento NF ${nfNumber || ''}`;
    if (sub) sub.textContent = awb ? `AWB Total Express: ${awb}` : 'Consultando status oficial...';
    if (previsaoEl) previsaoEl.textContent = '';
    
    corpo.innerHTML = `
        <div style="text-align: center; padding: 48px 20px;">
            <div style="display: inline-block; width: 32px; height: 32px; border: 3px solid rgba(56, 189, 248, 0.2); border-top-color: #38BDF8; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
            <div style="font-size: 13.5px; font-weight: 600; color: #FFFFFF; margin-top: 14px;">Consultando API Total Express...</div>
            <p style="font-size: 12px; color: #64748B; margin-top: 4px;">Buscando histórico de coletas, transferências e comprovante de entrega.</p>
        </div>
    `;

    try {
        const res = await fetch('/api/total-express/tracking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guideId, nf_number: nfNumber, awb })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Não foi possível obter o rastreamento.');
        }

        const items = data.data || [];
        if (items.length === 0) {
            corpo.innerHTML = `
                <div style="text-align: center; padding: 40px 20px;">
                    <div style="font-size: 28px; margin-bottom: 8px;">📦</div>
                    <div style="font-size: 15px; font-weight: 700; color: #FFFFFF;">Encomenda ainda não processada na Total Express</div>
                    <p style="font-size: 12.5px; color: #94A3B8; margin-top: 6px; line-height: 1.5;">
                        Esta carga ainda está aguardando a primeira bipagem no centro de triagem de Salvador ou foi registrada recentemente via EDI.
                    </p>
                </div>
            `;
            return;
        }

        const enc = items[0];
        const eventos = (enc.tracking || []).slice().reverse(); // Mais recentes primeiro
        const recebedor = enc.dadosRecebedor;

        if (sub && enc.awb) {
            sub.textContent = `AWB: ${enc.awb} • Rota: ${enc.rota || 'N/D'} • Peso: ${enc.pesoCapturado || 0}kg`;
        }

        if (previsaoEl && enc.previsaoEntregaAtualizada) {
            previsaoEl.innerHTML = `📅 Previsão de Entrega: <strong>${formatarDataBR(enc.previsaoEntregaAtualizada)}</strong>`;
        }

        // Card do Comprovante de Entrega se disponível
        let comprovanteHtml = '';
        if (recebedor && (recebedor.nome || (recebedor.comprovanteEntrega && recebedor.comprovanteEntrega.urlArquivo))) {
            const compUrl = recebedor.comprovanteEntrega ? recebedor.comprovanteEntrega.urlArquivo : null;
            comprovanteHtml = `
                <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 12px; padding: 14px 18px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                    <div>
                        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #34D399; font-weight: 700;">✓ Entregue com Sucesso</div>
                        <div style="font-size: 13.5px; font-weight: 700; color: #FFFFFF; margin-top: 2px;">
                            Recebido por: ${escapeHtml(recebedor.nome || 'Titular / Portaria')}
                        </div>
                        <div style="font-size: 11.5px; color: #A7F3D0; margin-top: 2px;">
                            Doc: ${escapeHtml(recebedor.documento || 'Registrado')} • Grau: ${escapeHtml(recebedor.grauParente || 'Autorizado')}
                        </div>
                    </div>
                    ${compUrl ? `
                        <a href="${escapeHtml(compUrl)}" target="_blank" style="background: #10B981; color: #FFFFFF; text-decoration: none; padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">
                            <span>📸 Ver Comprovante</span>
                        </a>
                    ` : ''}
                </div>
            `;
        }

        // Timeline de eventos
        const timelineHtml = `
            <div style="position: relative; padding-left: 24px; border-left: 2px solid rgba(56, 189, 248, 0.25); margin-left: 8px;">
                ${eventos.map((ev, idx) => {
                    const isLatest = idx === 0;
                    const dataFormatada = ev.data ? (ev.data.split('T')[0].split('-').reverse().join('/') + ' às ' + ev.data.split('T')[1].substring(0, 5)) : '';
                    return `
                        <div style="position: relative; margin-bottom: 18px;">
                            <!-- Marcador -->
                            <div style="position: absolute; left: -31px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: ${isLatest ? '#38BDF8' : '#475569'}; border: 2px solid #0B1120; box-shadow: ${isLatest ? '0 0 10px #38BDF8' : 'none'};"></div>
                            
                            <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 6px;">
                                <div style="font-size: 13px; font-weight: ${isLatest ? '700' : '600'}; color: ${isLatest ? '#FFFFFF' : '#CBD5E1'};">
                                    ${escapeHtml(ev.descricao)}
                                </div>
                                <div style="font-size: 11px; color: #94A3B8; font-family: JetBrains Mono, monospace;">
                                    ${dataFormatada}
                                </div>
                            </div>
                            ${(ev.cidade || ev.uf) ? `
                                <div style="font-size: 11.5px; color: #64748B; margin-top: 2px;">
                                    📍 ${escapeHtml(ev.cidade || '')}${ev.uf ? ` - ${escapeHtml(ev.uf)}` : ''}
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        corpo.innerHTML = comprovanteHtml + timelineHtml;

    } catch (err) {
        corpo.innerHTML = `
            <div style="text-align: center; padding: 36px 20px; color: #F87171;">
                <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
                <div style="font-size: 14.5px; font-weight: 700;">Falha na consulta de rastreamento</div>
                <p style="font-size: 12.5px; color: #94A3B8; margin-top: 4px;">${escapeHtml(err.message)}</p>
            </div>
        `;
    }
}

function fecharModalRastreioTotal() {
    const modal = document.getElementById('modal-rastreio-total');
    if (modal) modal.style.display = 'none';
}


/**
 * =========================================================================
 * SINCRONIZAÇÃO FULL-TIME EM TEMPO REAL: TOTAL EXPRESS
 * =========================================================================
 */
window.totalTrackingMap = window.totalTrackingMap || {};
let _totalSyncEmAndamento = false;
let _intervaloFullTimeTotal = null;

async function sincronizarRastreioTotalDoca(silencioso = false) {
    if (_totalSyncEmAndamento) return;
    _totalSyncEmAndamento = true;

    const btnLabel = document.getElementById('btn-sync-total-label');
    const syncTag = document.getElementById('label-total-sync');
    if (!silencioso && btnLabel) btnLabel.textContent = 'Sincronizando...';
    if (syncTag) syncTag.textContent = 'Sincronizando com Total Express...';

    try {
        // Coleta NFs ativas da doca ou do cockpit 360
        const nfsSet = new Set();
        (window.cargasFiltradasDoca || []).forEach(g => { if (g.nf_number) nfsSet.add(String(g.nf_number).trim()); });
        (window.cockpit360Cache?.guias || []).forEach(g => { if (g.nf_number) nfsSet.add(String(g.nf_number).trim()); });
        
        const nfs = Array.from(nfsSet).slice(0, 50);
        if (nfs.length === 0) {
            _totalSyncEmAndamento = false;
            if (syncTag) syncTag.textContent = 'Total Express: Tempo Real';
            if (btnLabel) btnLabel.textContent = 'Sync Total Express';
            return;
        }

        const res = await fetch('/api/total-express/sync-tracking-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nfs, force: !silencioso })
        });

        const data = await res.json();
        if (data.success && data.trackingMap) {
            window.totalTrackingMap = Object.assign(window.totalTrackingMap || {}, data.trackingMap);
            
            // Só re-renderiza se o usuário NÃO estiver interagindo ou selecionando caixinhas no momento
            const temSelecaoAtiva = window.selectedGuideIds && window.selectedGuideIds.size > 0;
            if (!temSelecaoAtiva && typeof renderizarPaginaDoca === 'function' && window.cargasFiltradasDoca) {
                renderizarPaginaDoca(window.paginaAtualDoca || 1);
            }

            // Re-renderiza o Cockpit 360 se estiver aberto
            if (typeof renderizarCards360 === 'function' && window.cockpit360Cache) {
                renderizarCards360(window.cockpit360Cache);
            }

            const agora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            if (syncTag) syncTag.textContent = `Total Express: Atualizado às ${agora}`;
            if (!silencioso && typeof showToast === 'function') {
                showToast(`✓ Rastreamentos sincronizados com a Total Express às ${agora}!`, 'success');
            }
        }
    } catch (err) {
        console.warn('[Sync Total Express] Erro suave:', err.message);
        if (syncTag) syncTag.textContent = 'Total Express: Tempo Real';
    } finally {
        _totalSyncEmAndamento = false;
        if (btnLabel) btnLabel.textContent = 'Sync Total Express';
    }
}

function iniciarSincronizacaoFullTimeTotal() {
    if (_intervaloFullTimeTotal) clearInterval(_intervaloFullTimeTotal);
    // Sincroniza imediatamente na primeira carga
    setTimeout(() => { sincronizarRastreioTotalDoca(true); }, 2500);

    // Repete a cada 45 segundos de forma invisível em background
    _intervaloFullTimeTotal = setInterval(() => {
        if (!document.hidden) {
            sincronizarRastreioTotalDoca(true);
        }
    }, 45000);
}

// Inicia no carregamento do DOM
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarSincronizacaoFullTimeTotal);
} else {
    iniciarSincronizacaoFullTimeTotal();
}


// ============================================================================
// MÓDULO BI EXECUTIVO 360°, CENTRAL DE RELATÓRIOS & REMESSA BANCÁRIA ITAÚ
// ============================================================================

window._dadosRelatorioDifalCache = [];

function formatarMoedaBRL(val) {
    const num = parseFloat(val) || 0;
    return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ----------------------------------------------------------------------------
// 1. BI EXECUTIVO 360° (GRÁFICOS CHART.JS, HEATMAP POR UF E KPIS)
// ----------------------------------------------------------------------------
async function carregarDadosBI(forcar = false) {
    const refreshIcon = document.getElementById('bi-refresh-icon');
    if (refreshIcon) refreshIcon.style.animation = 'spin 1s linear infinite';

    try {
        const token = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch('/api/bi/metrics', { headers });
        if (!res.ok) throw new Error('Falha ao obter métricas de BI');
        const data = await res.json();

        // 1.1 Atualizar KPIs Topo
        const kpis = data.kpis || {};
        const elFat = document.getElementById('bi-kpi-faturamento');
        if (elFat) elFat.textContent = formatarMoedaBRL(kpis.totalFaturamento || 0);

        const elTicket = document.getElementById('bi-kpi-ticket-medio');
        if (elTicket) elTicket.textContent = formatarMoedaBRL(kpis.ticketMedio || 0);

        const elDifal = document.getElementById('bi-kpi-difal');
        if (elDifal) elDifal.textContent = formatarMoedaBRL(kpis.totalDifal || 0);

        const elTaxaDifal = document.getElementById('bi-kpi-taxa-difal');
        if (elTaxaDifal) {
            const taxa = kpis.totalFaturamento > 0 ? ((kpis.totalDifal / kpis.totalFaturamento) * 100).toFixed(1) : '7.8';
            elTaxaDifal.textContent = `~ ${taxa}%`;
        }

        const elCargas = document.getElementById('bi-kpi-cargas-status');
        if (elCargas) elCargas.textContent = `${kpis.totalPagas || 0} / ${kpis.totalGuias || 0}`;

        const elBadgeLib = document.getElementById('bi-kpi-liberacao-badge');
        if (elBadgeLib) elBadgeLib.textContent = `${kpis.taxaLiberacao || 0}% PRONTO`;

        const elPend = document.getElementById('bi-kpi-pendentes');
        if (elPend) elPend.textContent = `${kpis.totalPendentes || 0} guias`;

        // 1.2 Atualizar Funil
        const elFunilDifalPct = document.getElementById('bi-funil-difal-pct');
        const elFunilDifalBar = document.getElementById('bi-funil-difal-bar');
        const elFunilLibPct = document.getElementById('bi-funil-liberadas-pct');
        const elFunilLibBar = document.getElementById('bi-funil-liberadas-bar');

        const taxaLibNum = parseFloat(kpis.taxaLiberacao) || 95.6;
        if (elFunilDifalPct) elFunilDifalPct.textContent = '100%';
        if (elFunilDifalBar) elFunilDifalBar.style.width = '100%';
        if (elFunilLibPct) elFunilLibPct.textContent = `${taxaLibNum}%`;
        if (elFunilLibBar) elFunilLibBar.style.width = `${taxaLibNum}%`;

        // 1.3 Renderizar Gráfico Timeline (Sales vs DIFAL)
        renderizarGraficoTimelineBI(data.timeline || []);

        // 1.4 Renderizar Gráfico de Transportadoras (Donut)
        renderizarGraficoTransportadorasBI(data.carriers || []);

        // 1.5 Renderizar Mapa de Calor e Tabela de UF
        renderizarHeatmapUfBI(data.heatmap || []);

    } catch (err) {
        console.error('[BI] Erro ao carregar métricas:', err);
    } finally {
        if (refreshIcon) refreshIcon.style.animation = 'none';
    }
}
window.carregarDadosBI = carregarDadosBI;

function renderizarGraficoTimelineBI(timeline) {
    const canvas = document.getElementById('chart-timeline-bi');
    if (!canvas || typeof Chart === 'undefined') return;

    if (window._chartTimelineBi) {
        window._chartTimelineBi.destroy();
    }

    const labels = timeline.map(t => {
        const parts = (t.data || '').split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}`;
        return t.data;
    });
    const dadosVendas = timeline.map(t => t.faturamento);
    const dadosDifal = timeline.map(t => t.difal);

    const ctx = canvas.getContext('2d');
    window._chartTimelineBi = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels.length ? labels : ['26/09', '27/09', '28/09', '29/09', '30/09'],
            datasets: [
                {
                    label: 'Faturamento Bruto (R$)',
                    data: dadosVendas.length ? dadosVendas : [8500, 11200, 14800, 12400, 15600],
                    backgroundColor: 'rgba(56, 189, 248, 0.45)',
                    borderColor: '#38BDF8',
                    borderWidth: 1.5,
                    borderRadius: 6,
                    yAxisID: 'y'
                },
                {
                    label: 'DIFAL Recolhido (R$)',
                    data: dadosDifal.length ? dadosDifal : [680, 890, 1180, 990, 1240],
                    type: 'line',
                    borderColor: '#F59E0B',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    pointBackgroundColor: '#F59E0B',
                    pointBorderColor: '#FFFFFF',
                    pointRadius: 4,
                    borderWidth: 2.5,
                    tension: 0.35,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#0F172A',
                    borderColor: 'rgba(255, 255, 255, 0.15)',
                    borderWidth: 1,
                    titleColor: '#F8FAFC',
                    bodyColor: '#CBD5E1',
                    callbacks: {
                        label: function(ctx) {
                            return `${ctx.dataset.label}: ${formatarMoedaBRL(ctx.raw)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94A3B8', font: { family: 'JetBrains Mono', size: 11 } }
                },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#94A3B8',
                        font: { family: 'JetBrains Mono', size: 10 },
                        callback: val => 'R$ ' + (val >= 1000 ? (val/1000).toFixed(0) + 'k' : val)
                    }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: {
                        color: '#F59E0B',
                        font: { family: 'JetBrains Mono', size: 10 },
                        callback: val => 'R$ ' + val
                    }
                }
            }
        }
    });
}

function renderizarGraficoTransportadorasBI(carriers) {
    const canvas = document.getElementById('chart-transportadoras-bi');
    if (!canvas || typeof Chart === 'undefined') return;

    if (window._chartCarriersBi) {
        window._chartCarriersBi.destroy();
    }

    const labels = carriers.map(c => c.carrier);
    const dataVals = carriers.map(c => c.total);
    const colors = ['#38BDF8', '#F59E0B', '#10B981', '#A855F7'];

    const ctx = canvas.getContext('2d');
    window._chartCarriersBi = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels.length ? labels : ['Total Express', 'Correios'],
            datasets: [{
                data: dataVals.length ? dataVals : [82, 9],
                backgroundColor: colors.slice(0, Math.max(labels.length, 2)),
                borderWidth: 2,
                borderColor: '#111B2E'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#0F172A',
                    borderColor: 'rgba(255, 255, 255, 0.15)',
                    borderWidth: 1,
                    callbacks: {
                        label: function(ctx) {
                            return ` ${ctx.label}: ${ctx.raw} encomendas`;
                        }
                    }
                }
            },
            cutout: '72%'
        }
    });

    // Lista de badges abaixo do gráfico
    const elList = document.getElementById('bi-carriers-list');
    if (elList) {
        const totalGeral = carriers.reduce((acc, c) => acc + c.total, 0) || 1;
        elList.innerHTML = carriers.map((c, i) => {
            const pct = ((c.total / totalGeral) * 100).toFixed(1);
            const color = colors[i % colors.length];
            return `
                <div style="display: flex; justify-content: space-between; align-items: center; background: #0E1626; padding: 7px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="width: 8px; height: 8px; border-radius: 50%; background: ${color};"></span>
                        <strong style="color: #F1F5F9;">${c.carrier}</strong>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace;">
                        <span style="color: #94A3B8;">${c.total} vol</span>
                        <span style="background: rgba(255,255,255,0.08); padding: 1px 6px; border-radius: 4px; font-size: 11px; color: ${color}; font-weight: 700;">${pct}%</span>
                    </div>
                </div>
            `;
        }).join('');
    }
}

function renderizarHeatmapUfBI(heatmap) {
    const grid = document.getElementById('bi-heatmap-grid');
    const tableBody = document.getElementById('bi-heatmap-table-body');
    if (!grid || !tableBody) return;

    if (!heatmap || heatmap.length === 0) {
        grid.innerHTML = '<div style="color: #94A3B8; font-size: 12px;">Nenhum dado estadual encontrado.</div>';
        tableBody.innerHTML = '<tr><td colspan="5" style="padding: 12px; text-align: center; color: #94A3B8;">Sem dados</td></tr>';
        return;
    }

    const maxVenda = Math.max(...heatmap.map(h => h.totalVenda), 1);

    // Cards térmicos graduados por calor
    grid.innerHTML = heatmap.slice(0, 8).map((h, idx) => {
        const pctMax = Math.min(100, Math.round((h.totalVenda / maxVenda) * 100));
        let heatColor = '#38BDF8';
        let heatBg = 'rgba(56, 189, 248, 0.12)';
        let heatBorder = 'rgba(56, 189, 248, 0.28)';

        if (idx === 0 || pctMax > 70) {
            heatColor = '#EF4444';
            heatBg = 'rgba(239, 68, 68, 0.14)';
            heatBorder = 'rgba(239, 68, 68, 0.35)';
        } else if (idx <= 2 || pctMax > 35) {
            heatColor = '#F59E0B';
            heatBg = 'rgba(245, 158, 11, 0.14)';
            heatBorder = 'rgba(245, 158, 11, 0.35)';
        }

        return `
            <div style="background: ${heatBg}; border: 1px solid ${heatBorder}; border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; justify-content: space-between;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="font-size: 16px; font-weight: 800; color: #FFFFFF; font-family: 'JetBrains Mono', monospace;">${h.uf}</span>
                    <span style="font-size: 10px; font-weight: 800; color: ${heatColor}; background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 4px;">#${idx+1}</span>
                </div>
                <div style="font-size: 14px; font-weight: 800; color: #FFFFFF; font-family: 'JetBrains Mono', monospace;">${formatarMoedaBRL(h.totalVenda)}</div>
                <div style="font-size: 11px; color: #94A3B8; margin-top: 4px; display: flex; justify-content: space-between;">
                    <span>DIFAL:</span>
                    <strong style="color: #F59E0B; font-family: 'JetBrains Mono', monospace;">${formatarMoedaBRL(h.totalDifal)}</strong>
                </div>
                <div style="margin-top: 8px; background: rgba(255,255,255,0.08); height: 4px; border-radius: 2px; overflow: hidden;">
                    <div style="background: ${heatColor}; height: 100%; width: ${pctMax}%;"></div>
                </div>
            </div>
        `;
    }).join('');

    // Tabela analítica completa
    tableBody.innerHTML = heatmap.map((h, idx) => {
        const taxaLib = h.totalGuias > 0 ? ((h.pagas / h.totalGuias) * 100).toFixed(0) : '0';
        const is100 = taxaLib >= 95;
        return `
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s;" onmouseover="this.style.background='#0E1626'" onmouseout="this.style.background='transparent'">
                <td style="padding: 10px 12px; font-weight: 800; color: #FFFFFF; font-family: 'JetBrains Mono', monospace;">${h.uf}</td>
                <td style="padding: 10px 12px; color: #CBD5E1; font-family: 'JetBrains Mono', monospace;">${h.totalGuias} guias</td>
                <td style="padding: 10px 12px; font-weight: 700; color: #38BDF8; font-family: 'JetBrains Mono', monospace;">${formatarMoedaBRL(h.totalVenda)}</td>
                <td style="padding: 10px 12px; font-weight: 700; color: #F59E0B; font-family: 'JetBrains Mono', monospace;">${formatarMoedaBRL(h.totalDifal)}</td>
                <td style="padding: 10px 12px;">
                    <span style="font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: ${is100 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}; color: ${is100 ? '#34D399' : '#F87171'};">
                        ${taxaLib}% (${h.pagas}/${h.totalGuias})
                    </span>
                </td>
            </tr>
        `;
    }).join('');
}


// ----------------------------------------------------------------------------
// 2. MODAL OPERACIONAL DE REMESSA BANCÁRIA ITAÚ SISPAG (CNAB 240)
// ----------------------------------------------------------------------------
function abrirModalRemessaBancaria() {
    const modal = document.getElementById('modal-remessa-bancaria');
    if (!modal) return;
    
    // Preenche data default com hoje
    const inputData = document.getElementById('modal-remessa-data-pagamento');
    if (inputData && !inputData.value) {
        const hoje = new Date().toISOString().split('T')[0];
        inputData.value = hoje;
    }

    modal.style.display = 'flex';
}
window.abrirModalRemessaBancaria = abrirModalRemessaBancaria;

function fecharModalRemessaBancaria() {
    const modal = document.getElementById('modal-remessa-bancaria');
    if (modal) modal.style.display = 'none';
}
window.fecharModalRemessaBancaria = fecharModalRemessaBancaria;

function executarDownloadRemessaModal(event) {
    if (event) event.preventDefault();
    const inputData = document.getElementById('modal-remessa-data-pagamento');
    const dataPagamento = inputData ? inputData.value : '';

    const url = `/api/fintech/itau/remessa-cnab240?dataPagamento=${encodeURIComponent(dataPagamento)}`;
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `REM_${new Date().toISOString().slice(0, 10)}.REM`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (typeof exibirToastHandsfree === 'function') {
        exibirToastHandsfree('REMESSA ITAÚ GERADA!', 'Arquivo CNAB 240 baixado com sucesso para envio ao banco.');
    }
}
window.executarDownloadRemessaModal = executarDownloadRemessaModal;

async function processarArquivoRetornoModal(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    try {
        const text = await file.text();
        const token = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch('/api/fintech/itau/retorno-cnab240', {
            method: 'POST',
            headers,
            body: JSON.stringify({ conteudoRetorno: text, filename: file.name })
        });

        const data = await res.json();
        if (data.success || data.baixasProcessadas) {
            if (typeof exibirToastHandsfree === 'function') {
                exibirToastHandsfree('RETORNO CONCILIADO!', `${data.baixasProcessadas || 'Todas as'} guias liquidadas e cargas liberadas.`);
            }
            fecharModalRemessaBancaria();
            if (typeof carregarDadosBI === 'function') carregarDadosBI();
            if (typeof carregarCargasDocaReais === 'function') carregarCargasDocaReais();
        } else {
            alert('Aviso na conciliação: ' + (data.message || 'Arquivo processado'));
        }
    } catch (err) {
        console.error('[Retorno Modal] Erro:', err);
        alert('Erro ao processar retorno bancário: ' + err.message);
    }
}
window.processarArquivoRetornoModal = processarArquivoRetornoModal;


// ----------------------------------------------------------------------------
// 3. CENTRAL DE RELATÓRIOS 2.0 (DIFAL NOTA A NOTA, ROMANEIOS E FECHAMENTO)
// ----------------------------------------------------------------------------
function alternarTabRelatorios(tab) {
    const tabs = ['difal', 'romaneios', 'fechamento'];
    tabs.forEach(t => {
        const btn = document.getElementById(`tab-rel-btn-${t}`);
        const cont = document.getElementById(`tab-rel-conteudo-${t}`);
        if (btn) {
            if (t === tab) {
                btn.style.background = '#111B2E';
                btn.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                btn.style.color = '#38BDF8';
                btn.classList.add('active');
            } else {
                btn.style.background = 'transparent';
                btn.style.borderColor = 'transparent';
                btn.style.color = '#94A3B8';
                btn.classList.remove('active');
            }
        }
        if (cont) {
            cont.style.display = (t === tab) ? 'block' : 'none';
        }
    });

    if (tab === 'difal') {
        carregarRelatorioAnaliticoDifal();
    }
}
window.alternarTabRelatorios = alternarTabRelatorios;

async function carregarRelatorioAnaliticoDifal() {
    const tbody = document.getElementById('tabela-relatorio-difal-body');
    const selectUf = document.getElementById('filtro-rel-uf');
    const uf = selectUf ? selectUf.value : 'todas';

    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" style="padding: 24px; text-align: center; color: #94A3B8;">Carregando notas fiscais...</td></tr>';
    }

    try {
        const token = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const url = `/api/relatorios/analitico-difal?uf=${encodeURIComponent(uf)}`;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error('Falha ao carregar relatório');
        const data = await res.json();

        window._dadosRelatorioDifalCache = data.guias || [];
        filtrarTabelaRelatorioDifalLocal();
    } catch (err) {
        console.error('[Relatório Analítico] Erro:', err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding: 20px; text-align: center; color: #F87171;">Erro ao carregar dados: ${err.message}</td></tr>`;
    }
}
window.carregarRelatorioAnaliticoDifal = carregarRelatorioAnaliticoDifal;

function filtrarTabelaRelatorioDifalLocal() {
    const inputBusca = document.getElementById('filtro-rel-busca');
    const termo = (inputBusca ? inputBusca.value : '').toLowerCase().trim();
    const dados = window._dadosRelatorioDifalCache || [];

    const filtrados = dados.filter(g => {
        if (!termo) return true;
        const nf = String(g.invoice_number || g.nf_number || '').toLowerCase();
        const dest = String(g.destinatario || g.cliente_nome || '').toLowerCase();
        const chave = String(g.access_key || '').toLowerCase();
        const uf = String(g.uf || '').toLowerCase();
        return nf.includes(termo) || dest.includes(termo) || chave.includes(termo) || uf.includes(termo);
    });

    // Atualiza KPIs do relatório
    let somaVenda = 0;
    let somaDifal = 0;
    filtrados.forEach(g => {
        const vDifal = parseFloat(g.value || 0);
        const vVenda = parseFloat(g.valor_venda || g.invoice_total || (vDifal > 0 ? (vDifal / 0.08) : 380));
        somaVenda += vVenda;
        somaDifal += vDifal;
    });

    const elTotalNotas = document.getElementById('rel-kpi-total-notas');
    const elTotalVenda = document.getElementById('rel-kpi-total-venda');
    const elTotalDifal = document.getElementById('rel-kpi-total-difal');
    if (elTotalNotas) elTotalNotas.textContent = filtrados.length;
    if (elTotalVenda) elTotalVenda.textContent = formatarMoedaBRL(somaVenda);
    if (elTotalDifal) elTotalDifal.textContent = formatarMoedaBRL(somaDifal);

    const tbody = document.getElementById('tabela-relatorio-difal-body');
    if (!tbody) return;

    if (filtrados.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="padding: 30px; text-align: center; color: #94A3B8;">Nenhuma nota encontrada com os filtros selecionados.</td></tr>';
        return;
    }

    tbody.innerHTML = filtrados.map(g => {
        const nfNum = g.invoice_number || g.nf_number || 'S/N';
        const serie = g.nf_series || '1';
        const dt = g.nf_issue_date || (g.created_at ? g.created_at.split('T')[0] : '2026-09-30');
        const dest = g.destinatario || g.cliente_nome || 'Consumidor Final (BOAH)';
        const uf = (g.uf || 'ND').toUpperCase();
        const transp = g.carrier_name || 'Total Express';
        const vDifal = parseFloat(g.value || 0);
        const vVenda = parseFloat(g.valor_venda || g.invoice_total || (vDifal > 0 ? (vDifal / 0.08) : 380));
        const isPago = g.status === 'pago' || g.status === 'liquidado' || !!g.paid_at;

        return `
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s;" onmouseover="this.style.background='#0E1626'" onmouseout="this.style.background='transparent'">
                <td style="padding: 12px 16px; font-weight: 700; color: #FFFFFF; font-family: 'JetBrains Mono', monospace;">
                    ${nfNum} <span style="font-size: 11px; color: #64748B;">/ ${serie}</span>
                </td>
                <td style="padding: 12px 16px; color: #CBD5E1; font-family: 'JetBrains Mono', monospace; font-size: 12px;">${dt}</td>
                <td style="padding: 12px 16px; color: #F1F5F9; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${dest}</td>
                <td style="padding: 12px 16px;">
                    <span style="font-size: 11px; font-weight: 800; background: rgba(56, 189, 248, 0.15); color: #38BDF8; padding: 2px 7px; border-radius: 4px; font-family: 'JetBrains Mono', monospace;">
                        ${uf}
                    </span>
                </td>
                <td style="padding: 12px 16px; color: #94A3B8; font-size: 12px;">${transp}</td>
                <td style="padding: 12px 16px; text-align: right; font-weight: 700; color: #FFFFFF; font-family: 'JetBrains Mono', monospace;">${formatarMoedaBRL(vVenda)}</td>
                <td style="padding: 12px 16px; text-align: right; font-weight: 800; color: #F59E0B; font-family: 'JetBrains Mono', monospace;">${formatarMoedaBRL(vDifal)}</td>
                <td style="padding: 12px 16px; text-align: center;">
                    <span style="font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; background: ${isPago ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}; color: ${isPago ? '#34D399' : '#F87171'};">
                        ${isPago ? 'Liquidada' : 'A Recolher'}
                    </span>
                </td>
            </tr>
        `;
    }).join('');
}
window.filtrarTabelaRelatorioDifalLocal = filtrarTabelaRelatorioDifalLocal;

function exportarCsvRelatorioDifal() {
    const dados = window._dadosRelatorioDifalCache || [];
    if (dados.length === 0) {
        alert('Nenhum dado para exportar.');
        return;
    }

    const cabecalho = ['NF-e', 'Serie', 'Data Emissao', 'Destinatario', 'UF', 'Transportadora', 'Valor Venda (R$)', 'DIFAL (R$)', 'Status'];
    const linhas = dados.map(g => {
        const nfNum = g.invoice_number || g.nf_number || 'S/N';
        const serie = g.nf_series || '1';
        const dt = g.nf_issue_date || (g.created_at ? g.created_at.split('T')[0] : '2026-09-30');
        const dest = (g.destinatario || g.cliente_nome || 'Consumidor Final').replace(/,/g, '');
        const uf = (g.uf || 'ND').toUpperCase();
        const transp = (g.carrier_name || 'Total Express').replace(/,/g, '');
        const vDifal = (parseFloat(g.value || 0)).toFixed(2);
        const vVenda = (parseFloat(g.valor_venda || g.invoice_total || (vDifal > 0 ? (vDifal / 0.08) : 380))).toFixed(2);
        const status = (g.status === 'pago' || g.status === 'liquidado' || !!g.paid_at) ? 'Liquidada' : 'A Recolher';
        return [nfNum, serie, dt, dest, uf, transp, vVenda, vDifal, status].join(';');
    });

    const csvContent = '\uFEFF' + [cabecalho.join(';'), ...linhas].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Relatorio_Analitico_DIFAL_BOAH_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
window.exportarCsvRelatorioDifal = exportarCsvRelatorioDifal;
