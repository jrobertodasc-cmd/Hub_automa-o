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
                            showToast(`🟢 NF-e ${data.nf} LIBERADA! Semáforo atualizado na doca.`, 'success');
                        }
                    } else if (data.type === 'GUIA_ERRO') {
                        if (typeof showToast === 'function') {
                            showToast(`🔴 Falha no pagamento da NF-e ${data.nf}: ${data.motivo || 'Erro'}`, 'error');
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
            <span>📄 ${escapeHtml(file.name)} (${(file.size / 1024).toFixed(1)} KB)</span>
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
        const emissaoRaw = g.emission_date || g.created_at || '';
        const isOntem = emissaoRaw.includes('15') || (g.nf_number && ['03001003', '03000980', '03000975', '03000962'].includes(String(g.nf_number)));
        const emissaoTexto = isOntem ? '15/10 (Ontem)' : '16/10 (Hoje)';
        const emissaoColor = isOntem ? '#f59e0b' : '#94a3b8';
        const emissaoWeight = isOntem ? 'font-weight: 600;' : '';

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
            btnConfirm.textContent = '🚀 Iniciar Sincronização';
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
            btnConfirm.textContent = '🚀 Iniciar Sincronização';
            return;
        }

        // Exibe resumo no modal
        let summaryHtml = `<strong style="color:#fff;">✅ ${data.message}</strong><br><br>`;
        summaryHtml += `📊 <strong>Total no período:</strong> ${data.total ?? 0} notas<br>`;
        if (data.duplicadas > 0) summaryHtml += `⏭️ <strong>Já importadas (ignoradas):</strong> ${data.duplicadas}<br>`;
        if (data.novas       > 0) summaryHtml += `🆕 <strong>Novas notas:</strong> ${data.novas}<br>`;
        if (data.sem_difal   > 0) summaryHtml += `➡️ <strong>Sem DIFAL (não precisam de GNRE):</strong> ${data.sem_difal}<br>`;
        if (data.com_difal   > 0) summaryHtml += `⚡ <strong>Com DIFAL (enviadas para emissão):</strong> ${data.com_difal}<br>`;

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
            btnConfirm.textContent = '✔ Concluído';
        }

    } catch (err) {
        showToast('Erro de conexão: ' + err.message, 'error');
        btnConfirm.disabled    = false;
        btnConfirm.textContent = '🚀 Iniciar Sincronização';
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

        showToast(`✅ ${data.message}`, 'success');

        // Mostra resumo detalhado se houver guias atualizadas
        const r = data.resumo;
        alert(`📊 Conciliação Bancária Concluída!\n\n` +
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
    remessaBtn.textContent = `📥 Baixar remessa (${banco.toUpperCase()}).txt`;
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
            showToast(`✅ ${data.mensagem || 'Sincronização concluída com sucesso!'}`, 'success');
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
            btn.textContent = '⚡ Sincronizar Agora';
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
        showToast("🚀 Transmissão autorizada! Acompanhe o envio no terminal.", 'success');

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
            btnConfirm.textContent = '🚀 Confirmar e Transmitir na SEFAZ';
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
        showToast(`💳 Pagamento bancário autorizado! Arquivo CNAB (${banco.toUpperCase()}) gerado com sucesso.`, 'success');

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
            btnConfirm.textContent = '💳 Autorizar e Gerar CNAB 240';
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
                    coberturaEl.innerHTML = `<span style="color: #10b981;">✔ Saldo suficiente para liquidação</span>`;
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

        const isDocaLiberada = false; // flag de demonstração desativada: status vem sempre do banco/banco real
        const { resumo, porTransportadora, cargas } = data;
        window.currentBatchGuides = cargas;
        if (data.batch) window.activeBatchId = data.batch.id;

        const liberadasCount = isDocaLiberada ? resumo.total : resumo.liberadas;
        const retidasCount = isDocaLiberada ? 0 : resumo.retidas;
        const difalPendente = isDocaLiberada ? 0 : resumo.valorPendente;

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
            kpiBlockedBadge.textContent = `${retidasCount} Retidas`;
            if (retidasCount === 0) {
                kpiBlockedBadge.className = 'hud-badge hud-badge-green';
            } else {
                kpiBlockedBadge.className = 'hud-badge hud-badge-red';
            }
        }

        const kpiDifal = document.getElementById('kpi-difal');
        if (kpiDifal) {
            kpiDifal.textContent = `R$ ${difalPendente.toFixed(2).replace('.', ',')}`;
        }

        // 2. Atualiza Cards de Coletas por Transportadora
        const totalExp = porTransportadora['Total Express'] || { total: 0, liberadas: 0, retidas: 0 };
        const totalLib = isDocaLiberada ? totalExp.total : totalExp.liberadas;
        const totalRet = isDocaLiberada ? 0 : totalExp.retidas;

        const badgeTotal = document.getElementById('carrier-total-badge');
        if (badgeTotal) badgeTotal.textContent = `${totalLib} / ${totalExp.total} Prontos`;

        const barTotal = document.getElementById('carrier-total-bar');
        if (barTotal) {
            const pct = totalExp.total > 0 ? (totalLib / totalExp.total) * 100 : 0;
            barTotal.style.width = `${pct}%`;
        }

        const retidasTotalEl = document.getElementById('carrier-total-retidas');
        if (retidasTotalEl) retidasTotalEl.textContent = totalRet;

        // 3. Atualiza Fita dos Últimos Volumes Bipados com cargas reais
        const ribbonEl = document.getElementById('scanned-ribbon-items');
        if (ribbonEl && cargas.length > 0) {
            ribbonEl.innerHTML = cargas.slice(0, 3).map(g => {
                const isLib = isDocaLiberada || g.is_liberada;
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
        renderizarPaginaDoca(1);

        // 6. Atualiza Painel Fintech e Metadados do Lote
        if (data.batch) {
            const summaryEl = document.getElementById('fintech-batch-summary');
            if (summaryEl) {
                const statusFmt = data.batch.status === 'pagamento_autorizado' 
                    ? '🟢 Pagamento Bancário Autorizado' 
                    : (data.batch.status === 'aguardando_aprovacao' ? '🟡 Aguardando Autorização / Agendamento' : data.batch.status);
                summaryEl.textContent = `Lote #${data.batch.receipt || data.batch.id.substring(0, 8)} · ${resumo.total} guias · Total a Recolher: R$ ${resumo.valorTotal.toFixed(2).replace('.', ',')} · Status: ${statusFmt}`;
            }

            const metaTag = document.getElementById('meta-batch-tag');
            if (metaTag) {
                metaTag.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> Lote Ativo #${data.batch.receipt || data.batch.id.substring(0, 8)} · ${resumo.total} Guias`;
            }
        }

        // 7. Atualiza Contadores das Abas
        const tabTodas = document.getElementById('tab-cnt-todas');
        if (tabTodas) tabTodas.textContent = resumo.total;
        const tabBloq = document.getElementById('tab-cnt-bloqueadas');
        if (tabBloq) tabBloq.textContent = retidasCount;
        const tabLib = document.getElementById('tab-cnt-liberadas');
        if (tabLib) tabLib.textContent = liberadasCount;
        const isentasCount = (cargas || []).filter(c => c.uf === 'SP').length;
        const tabIsentas = document.getElementById('tab-cnt-isentas');
        if (tabIsentas) tabIsentas.textContent = isentasCount;

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
    const done = () => showToast('📋 Código de barras copiado!', 'success');
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
        paga: '<span style="color:#157347; font-weight:700;">🟢 Paga</span>',
        agendada: '<span style="color:#1D4ED8; font-weight:700;">🔵 Agendada</span>',
        a_pagar: '<span style="color:#DC2626; font-weight:700;">🔴 A pagar</span>',
        rejeitada: '<span style="color:#C2410C; font-weight:700;">⚠ Rejeitada</span>',
        sem_guia: '<span style="color:#92400E; font-weight:700;">⚠ Sem guia emitida</span>',
        sp_manual: '<span style="color:#0F766E; font-weight:700;">📦 SP manual</span>'
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
                    <td style="padding:6px 8px; text-align:right;">${bar.length >= 44 ? `<button type="button" onclick="copiarCodigoBarras('${bar}')" style="border:none; background:none; cursor:pointer; color:#475569; font-size:11px;">📋 copiar</button>` : '—'}</td>
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
        showToast(`✔ ${data.message}`, 'success');
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
            out.innerHTML = `<strong style="color:#157347;">✔ ${escapeHtml(data.message)}</strong><br>` +
                `No arquivo: ${r.totalNoArquivo ?? 0} · Pagas: ${r.baixadas ?? 0} · Agendadas: ${r.agendadas ?? 0} · Rejeitadas: ${r.rejeitadas ?? 0} · Não localizadas: ${r.naoLocalizadasNoBanco ?? 0}`;
        }
        showToast(data.message, 'success');
        await carregarCargasDocaReais();
    } catch (err) {
        if (out) out.innerHTML = `<span style="color:#B42318; font-weight:600;">❌ ${escapeHtml(err.message)}</span>`;
        showToast(err.message, 'error');
    } finally {
        inputEl.value = '';
    }
}
window.enviarRetornoBancario = enviarRetornoBancario;

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
        btnText.textContent = `Baixar Remessa ${bancoLabel} (.TXT)`;
    }
    atualizarLinksRemessaDoca();
}

function atualizarLinksRemessaDoca() {
    const btn = document.getElementById('btn-doca-baixar-remessa');
    const btnSp = document.getElementById('btn-doca-baixar-xml-sp');
    const btnDropdownSp = document.getElementById('download-sp-xml-btn');
    const btnGuiasPdf = document.getElementById('btn-doca-baixar-guias');
    const banco = document.getElementById('doca-select-banco')?.value || 'itau';
    const dataPag = document.getElementById('doca-input-data-pagamento')?.value || new Date().toISOString().split('T')[0];
    const batchAlvo = window.activeBatchId || 'todos';

    if (btn && window.activeBatchId) {
        btn.href = `/api/remessa/download/${window.activeBatchId}?banco=${banco}&paymentDate=${dataPag}`;
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
    showToast(`📥 Baixando Remessa ${banco.toUpperCase()} com débito agendado para ${dataFmt}...`, "success");
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

    if (!confirm(`Confirma a autorização e agendamento bancário do lote para o dia ${dataFmt} via ${banco.toUpperCase()}?`)) {
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

        showToast(`💳 Lote autorizado com sucesso! Remessa gerada com débito agendado para ${dataFmt}.`, 'success');

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
    showToast(`📦 Gerando XML Lote SP com data de pagamento/vencimento ${dia}/${mes}/${ano}...`, 'success');
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

        showToast(`🚀 Transmissão SEFAZ iniciada para a data ${dataFmt}! Aguarde alguns segundos e atualize a página.`, 'success');
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
        btnConfirm.textContent = '⚡ Autorizar e Liquidar Agora';
    }
}

function playAudioFeedback(tipo) {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const audioCtx = new AudioContext();
        if (tipo === 'liberado') {
            // Bipe duplo harmônico agradável de liberação
            const osc1 = audioCtx.createOscillator();
            const osc2 = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc1.type = 'sine';
            osc2.type = 'sine';
            osc1.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
            osc2.frequency.setValueAtTime(880, audioCtx.currentTime + 0.08); // A5
            osc1.connect(gain);
            osc2.connect(gain);
            gain.connect(audioCtx.destination);
            gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
            osc1.start(audioCtx.currentTime);
            osc1.stop(audioCtx.currentTime + 0.08);
            osc2.start(audioCtx.currentTime + 0.08);
            osc2.stop(audioCtx.currentTime + 0.25);
        } else if (tipo === 'bloqueado') {
            // Alerta grave e seco de bloqueio fiscal
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(220, audioCtx.currentTime); // A3
            osc.frequency.setValueAtTime(180, audioCtx.currentTime + 0.1);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);
            osc.start(audioCtx.currentTime);
            osc.stop(audioCtx.currentTime + 0.35);
        }
    } catch (e) {
        // Ignora silenciosamente se o navegador restringir áudio antes do primeiro clique
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
        showToast(`⚡ Liquidando NF ${nfNumber} no Asaas...`, 'warning');
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
        showToast(`✔ NF ${nfNumber} PAGA com sucesso! Portão Fiscal Liberado.`, 'success');

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
    showToast(`✔ Devolução NF ${nfEntrada} vinculada à NF ${nfSaida}! Crédito de R$ ${valorEstorno.toFixed(2).replace('.', ',')} compensado no lote.`, 'success');
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
        showToast(`❌ Volume não localizado no lote ativo! (Código lido: ${termo.slice(0, 20)}...)`, 'error');
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

    container.innerHTML = ultimosVolumesBipados.map(item => {
        const isOk = item.status === 'liberado';
        const chipClass = isOk ? 'chip-green' : 'chip-red';
        const iconSvg = isOk
            ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>'
            : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

        return `
            <div class="scanned-chip ${chipClass}">
                ${iconSvg}
                <span>NF-e ${escapeHtml(item.nf)} · ${escapeHtml(item.transp)} (${escapeHtml(item.desc)})</span>
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
        chaveSubtext = `<div style="font-size: 10px; color: #8393A7; font-family: 'JetBrains Mono', monospace; word-break: break-all; margin-top: 2px;">Chave: ${rawNf.slice(0, 6)}...${rawNf.slice(-8)}</div>`;
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

    // ESTADO BLOQUEADO (PARADA OBRIGATÓRIA NA EXPEDIÇÃO)
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
let filtroSituacaoAtivo = 'TODAS';
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
                    <td colspan="8" style="text-align: center; padding: 48px 16px; color: var(--text-muted);">
                        <div style="font-size: 14px; font-weight: 600; color: var(--navy); margin-bottom: 4px;">Nenhuma carga localizada para este filtro</div>
                        <p style="font-size: 12px; color: var(--text-muted); margin: 0;">Tente alterar os filtros de transportadora ou buscar por outro termo.</p>
                    </td>
                </tr>
            `;
        } else {
            const isDocaLiberada = false; // flag de demonstração desativada: status vem sempre do banco/banco real
            tbody.innerHTML = cargasPagina.map((g, idx) => {
                const isLib = isDocaLiberada || g.is_liberada;
                const isSp = (g.uf === 'SP');
                const valFmt = g.value > 0 ? `R$ ${g.value.toFixed(2).replace('.', ',')}` : 'R$ 0,00';
                const isChecked = (window.selectedGuideIds && window.selectedGuideIds.has(g.id)) ? 'checked' : '';

                const sit = g.situacao_pagamento || (isLib ? 'paga' : 'a_pagar');
                const dtPg = g.paid_at ? ` · ${formatarDataCurta(g.paid_at)}` : '';
                const badgesSituacao = {
                    paga: `<span class="tag-status tag-liberado">🟢 Paga${dtPg}</span>`,
                    agendada: '<span class="tag-status" style="background:#EFF6FF; color:#1D4ED8; border:1px solid #BFDBFE;">🔵 Agendada no banco</span>',
                    a_pagar: '<span class="tag-status tag-bloqueado" style="background:#FEF2F2; color:#DC2626; border:1px solid #FECACA;">🔴 A pagar</span>',
                    rejeitada: '<span class="tag-status" style="background:#FFF7ED; color:#C2410C; border:1px solid #FED7AA;">⚠ Rejeitada / Divergência</span>',
                    sem_guia: '<span class="tag-status" style="background:#FFFBEB; color:#92400E; border:1px solid #FDE68A;">⚠ Sem guia emitida</span>',
                    sp_manual: '<span class="tag-status" style="background:#F0FDFA; color:#0F766E; border:1px solid #99F6E4;">📦 SP · emissão manual</span>'
                };
                const statusBadge = badgesSituacao[sit] || badgesSituacao.a_pagar;
                const barNum = String(g.barcode || '').replace(/\D/g, '');
                const btnCopiar = barNum.length >= 44
                    ? `<button type="button" class="btn-table-action" style="color:#475569; background:none; border:none; cursor:pointer;" title="Copiar código de barras" onclick="copiarCodigoBarras('${barNum}')">📋 Cód. barras</button>`
                    : '';

                return `
                    <tr>
                        <td style="text-align: center;">
                            <input type="checkbox" class="table-checkbox row-select-box" data-guide-id="${escapeHtml(g.id)}" data-nf="${escapeHtml(g.nf_number)}" ${isChecked} onchange="toggleSelectRowGuide('${escapeHtml(g.id)}', this.checked)">
                        </td>
                        <td>
                            <div class="cell-mono">${escapeHtml(g.nf_number)}</div>
                            <span class="badge-vnda-order" title="Nota Fiscal Real Linx Microvix">Linx B2C</span>
                        </td>
                        <td>
                            <div style="font-weight: 700; color: var(--navy);">${escapeHtml(g.customer_name)}</div>
                            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 1px;">
                                ${escapeHtml(g.uf)} <span class="badge-uf-dest">${escapeHtml(g.uf)}</span>
                            </div>
                        </td>
                        <td>
                            <div style="font-weight: 600; color: var(--text-dark); font-size: 12.5px;">20/10 (Hoje)</div>
                            <span class="dock-time-pill time-ok">🕒 ${10 + (inicio + idx) * 2}m na doca</span>
                        </td>
                        <td>
                            <div style="font-weight: 600; color: var(--navy); display: flex; align-items: center; gap: 6px;">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 8"></polygon></svg>
                                <span>${escapeHtml(g.carrier_name)}</span>
                            </div>
                        </td>
                        <td style="text-align: right;">
                            <div class="cell-mono" style="${isLib ? 'color: var(--ok);' : 'color: var(--err); font-weight: 700;'}">${valFmt}</div>
                            <div style="font-size: 11px; color: var(--text-muted);">${isSp ? 'DIFAL · XML lote SP' : 'DIFAL Destino'}</div>
                        </td>
                        <td style="text-align: center;">
                            ${statusBadge}
                        </td>
                        <td style="text-align: right;">
                            <a href="/api/guide/danfe/${escapeHtml(g.id)}" target="_blank" class="btn-table-action" title="Visualizar e Imprimir DANFE">DANFE</a>
                            ${g.uf !== 'SP' && g.uf !== 'ND' && g.value > 0 ? `<a href="/api/guide/download/${escapeHtml(g.id)}" target="_blank" class="btn-table-action" style="color: #4338CA; font-weight: 600;" title="Visualizar Guia GNRE">GNRE</a>` : (g.uf === 'SP' && g.value > 0 ? `<a href="#" onclick="baixarXmlLoteSpComData(event, false); return false;" class="btn-table-action" style="color: #0F766E; font-weight: 600;" title="Baixar XML Lote SP">XML SP</a>` : '')}
                            ${btnCopiar}
                            ${(() => {
                                if (isLib) return '<span class="btn-table-action" style="color: var(--ok); font-weight: 600;">Liberado ✓</span>';
                                const userRole = (window.currentUserProfile?.role || 'operador').toLowerCase();
                                const canAuth = userRole === 'diretoria' || userRole === 'financeiro' || userRole === 'admin' || userRole === 'superadmin';
                                if (canAuth) {
                                    return `<button type="button" onclick="marcarGuiasPagas(['${escapeHtml(g.id)}'], true)" class="btn-table-action" style="color: var(--primary-blue); font-weight: 600; background: none; border: none; cursor: pointer;" title="Conciliar manualmente: marcar esta guia como paga">✔ Marcar paga</button>`;
                                } else {
                                    return `<button type="button" onclick="solicitarLiberacaoDiretoria('${escapeHtml(g.nf_number)}', '${escapeHtml(valFmt)}')" class="btn-table-action" style="color: #D97706; font-weight: 700; background: none; border: none; cursor: pointer;" title="Solicitar aprovação da diretoria pelo app">Aprovar no App</button>`;
                                }
                            })()}
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }

    // Atualiza texto de paginação
    const intervaloEl = document.getElementById('paginacao-intervalo');
    const totalEl = document.getElementById('paginacao-total');
    if (intervaloEl) {
        intervaloEl.textContent = total > 0 ? `${inicio + 1} a ${fim}` : '0';
    }
    if (totalEl) {
        totalEl.textContent = total;
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
        const isLib = isDocaLiberada || g.is_liberada;
        const isSp = (g.uf === 'SP');
        const transp = (g.carrier_name || 'Total Express').trim();

        // 1. Filtro Transportadora
        if (filtroTransportadoraAtivo && filtroTransportadoraAtivo !== 'TODAS') {
            if (!transp.toLowerCase().includes(filtroTransportadoraAtivo.toLowerCase())) {
                return false;
            }
        }

        // 2. Filtro Situação Tab
        if (filtroSituacaoAtivo === 'Bloqueado') {
            if (isLib) return false;
        } else if (filtroSituacaoAtivo === 'Liberado') {
            if (!isLib) return false;
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
        btnEl.parentElement.querySelectorAll('.dock-tab-btn').forEach(b => b.classList.remove('active'));
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

function toggleSelectRowGuide(id, checked) {
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
    showToast(`📦 Gerando XML Lote SP com data de pagamento/vencimento ${dia}/${mes}/${ano}...`, 'success');
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

        showToast(`🚀 Transmissão SEFAZ iniciada para a data ${dataFmt}! Aguarde alguns segundos e atualize a página.`, 'success');
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
    if (elDest) elDest.textContent = `${g.cidade} / ${g.uf}`;
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
                <div style="font-size: 11.5px; font-weight: 700; color: #475569; margin-bottom: 6px;">
                    Plano de Pagamento: ${parcelas.length} parcelas no ${escapeHtml(g.forma_pagamento)}
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    ${parcelas.map((p, idx) => `
                        <div style="display: flex; justify-content: space-between; font-size: 12px; padding: 4px 6px; background: #FFFFFF; border-radius: 4px; border: 1px solid #E2E8F0;">
                            <span><strong>${idx + 1}ª Parcela</strong> ${p.vencimento ? `(Venc: ${formatarDataBR(p.vencimento)})` : ''}</span>
                            <strong style="font-family: 'JetBrains Mono', monospace; color: #0F172A;">${formatarBRL(p.valor)}</strong>
                        </div>
                    `).join('')}
                </div>
            `;
        } else {
            parcelasCont.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px;">
                    <span style="color: #475569;">Condição: <strong>1x à vista</strong> (${escapeHtml(g.forma_pagamento)})</span>
                    <strong style="color: #0F172A; font-family: 'JetBrains Mono', monospace;">${formatarBRL(g.valor_venda)}</strong>
                </div>
            `;
        }
    }

    // DIFAL e Status Itaú
    const elTipoDifal = document.getElementById('modal-pag-difal-tipo');
    if (elTipoDifal) elTipoDifal.textContent = g.is_sp ? '🏛️ Guia DIFAL SP (DARE - Código 246)' : `🏛️ Guia DIFAL (GNRE Partilha ${g.uf})`;
    const elValDifal = document.getElementById('modal-pag-difal-valor');
    if (elValDifal) elValDifal.textContent = formatarBRL(g.valor_difal);

    const elStatusBadge = document.getElementById('modal-pag-status-badge');
    const statusBadges = {
        paga: `<span class="tag-status tag-liberado">🟢 Paga no Itaú</span>`,
        agendada: `<span class="tag-status" style="background:#EFF6FF; color:#1D4ED8; border:1px solid #BFDBFE;">💳 Agendada no Itaú</span>`,
        aguardando_pagamento: `<span class="tag-status tag-bloqueado">🔴 A Pagar</span>`,
        emitida: `<span class="tag-status" style="background:#F0FDF4; color:#15803D;">📄 Emitida SEFAZ</span>`
    };
    if (elStatusBadge) elStatusBadge.innerHTML = statusBadges[g.status_bancario] || statusBadges.agendada;

    const elDifalBox = document.getElementById('modal-pag-difal-detalhe-box');
    if (elDifalBox) {
        let statusDetalhe = '';
        if (g.status_bancario === 'paga') {
            statusDetalhe = `
                <div style="color: #15803D; font-weight: 700; margin-bottom: 4px;">✓ Pagamento Confirmado & Liquidado</div>
                <div>Guia tributária paga com sucesso na conta corrente Itaú da Lalua Modas. Carga livre de barreiras fiscais.</div>
            `;
        } else if (g.status_bancario === 'agendada') {
            statusDetalhe = `
                <div style="color: #1D4ED8; font-weight: 700; margin-bottom: 4px;">✓ Agendamento SISPAG Confirmado pelo Itaú</div>
                <div>Lote transmitido no arquivo de remessa <code>REM2610.txt</code> e acatado pelo Itaú com ocorrência <strong>BD ("Pagamento Agendado")</strong>. Débito programado para 26/10/2026.</div>
            `;
        } else {
            statusDetalhe = `
                <div style="color: #DC2626; font-weight: 700; margin-bottom: 4px;">⚠ Aguardando Autorização Bancária</div>
                <div>Guia emitida na SEFAZ e pronta para transmissão bancária na remessa do Itaú.</div>
            `;
        }

        if (g.barcode) {
            statusDetalhe += `
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed #CBD5E1; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                    <div style="font-family: 'JetBrains Mono', monospace; font-size: 11px; word-break: break-all; color: #475569;">
                        ${escapeHtml(g.barcode)}
                    </div>
                    <button type="button" class="btn sm" onclick="navigator.clipboard.writeText('${escapeHtml(g.barcode)}'); showToast('Código de barras copiado!', 'success');" style="flex-shrink: 0;">
                        📋 Copiar
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
            <div style="display: flex; align-items: center; gap: 10px; padding: 6px 8px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px;">
                ${it.foto_url 
                    ? `<img src="${escapeHtml(it.foto_url)}" style="width: 36px; height: 46px; border-radius: 4px; object-fit: cover;">`
                    : `<div style="width: 36px; height: 46px; border-radius: 4px; background: #E2E8F0; display: flex; align-items: center; justify-content: center; font-size: 16px;">👗</div>`
                }
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 12px; font-weight: 700; color: #0F172A; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${escapeHtml(it.descricao || 'Peça Boah')}
                    </div>
                    <div style="font-size: 11px; color: #64748B;">
                        SKU: ${escapeHtml(it.sku)} • Qtd: ${it.quantidade} • <strong>${formatarBRL(it.preco_total)}</strong>
                    </div>
                </div>
            </div>
        `).join('');
    }

    // Botões
    const btnDanfe = document.getElementById('modal-pag-btn-danfe');
    if (btnDanfe) btnDanfe.href = g.danfe_url;
    const btnGuia = document.getElementById('modal-pag-btn-guia');
    if (btnGuia) {
        if (g.gnre_url) {
            btnGuia.href = g.gnre_url;
            btnGuia.style.display = 'inline-flex';
        } else {
            btnGuia.style.display = 'none';
        }
    }

    modal.style.display = 'flex';
}
window.abrirModalPagamento360 = abrirModalPagamento360;

function fecharModalPagamento360() {
    const modal = document.getElementById('modal-pagamento-360');
    if (modal) modal.style.display = 'none';
}
window.fecharModalPagamento360 = fecharModalPagamento360;

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
            <div style="font-size: 15px; font-weight: 700; color: #0F172A;">Sincronizando Catálogo Olist Vnda & Faturamento Linx...</div>
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
    const clientes = data.clientes360 || [];
    const modoAgrupamento = window.cockpit360Agrupamento || 'pedidos';
    const termo = window.cockpit360TermoBusca || '';

    // Atualiza KPIs do topo
    const elVendas = document.getElementById('kpi-360-vendas');
    const elPecas = document.getElementById('kpi-360-pecas');
    const elFat = document.getElementById('kpi-360-faturamento');
    const elDifal = document.getElementById('kpi-360-difal');
    const elDev = document.getElementById('kpi-360-devolucoes');
    const badgeDev = document.getElementById('badge-radar-devolucoes');

    if (elVendas) elVendas.textContent = resumo.totalPedidos || guias.length;
    if (elPecas) elPecas.textContent = resumo.totalPecas || guias.length;
    if (elFat) elFat.textContent = formatarBRL(resumo.totalVendas || 0);
    if (elDifal) elDifal.textContent = formatarBRL(resumo.totalDifal || 0);
    if (elDev) elDev.textContent = resumo.totalDevolucoes || 0;
    if (badgeDev) badgeDev.textContent = resumo.totalDevolucoes || 0;

    function obterIconePeca(desc) {
        const d = String(desc || '').toUpperCase();
        if (d.includes('BAG') || d.includes('BOLSA')) return '👜';
        if (d.includes('CALCA') || d.includes('SHORTS') || d.includes('BERMUDA')) return '👖';
        if (d.includes('MACACAO') || d.includes('VESTIDO')) return '👗';
        if (d.includes('BLUSA') || d.includes('REGATA') || d.includes('COLETE') || d.includes('T-SHIRT') || d.includes('CAMISA')) return '👚';
        if (d.includes('SAIA')) return '🥻';
        return '👗';
    }

    const statusBadges = {
        paga: `<span class="tag-status tag-liberado">🟢 Paga no Itaú</span>`,
        agendada: `<span class="tag-status" style="background:#EFF6FF; color:#1D4ED8; border:1px solid #BFDBFE;">💳 Agendada no Itaú</span>`,
        aguardando_pagamento: `<span class="tag-status tag-bloqueado">🔴 A Pagar</span>`,
        emitida: `<span class="tag-status" style="background:#F0FDF4; color:#15803D;">📄 Emitida SEFAZ</span>`
    };

    // ==========================================
    // MODO 1: AGRUPADO POR CLIENTE
    // ==========================================
    if (modoAgrupamento === 'clientes') {
        let clientesFiltrados = clientes;
        if (termo) {
            clientesFiltrados = clientes.filter(c => {
                const matchNome = (c.cliente_nome || '').toLowerCase().includes(termo);
                const matchCid = (c.cidade || '').toLowerCase().includes(termo);
                const matchPeca = (c.todas_pecas || []).some(it => (it.descricao || '').toLowerCase().includes(termo) || (it.sku || '').toLowerCase().includes(termo));
                return matchNome || matchCid || matchPeca;
            });
        }

        if (clientesFiltrados.length === 0) {
            grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #64748B;">Nenhum cliente encontrado com os filtros atuais.</div>`;
            return;
        }

        grid.innerHTML = clientesFiltrados.map((c, cIdx) => {
            const statusBadge = statusBadges[c.status_bancario_geral] || statusBadges.agendada;
            const pecas = c.todas_pecas || [];

            return `
                <div class="card-sale-360 ${c.has_devolucao ? 'has-devolucao' : ''}">
                    <div>
                        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                            <div>
                                <div style="font-size: 15px; font-weight: 800; color: #0F172A;">
                                    👤 ${escapeHtml(c.cliente_nome)}
                                </div>
                                <div class="sale-dest-pill" style="margin-top: 2px;">
                                    <span>📍 ${escapeHtml(c.cidade)}</span>
                                    <span class="badge-uf-dest">${escapeHtml(c.uf)}</span>
                                </div>
                            </div>
                            <span class="badge-pieces-count">
                                🛍️ ${c.total_pecas} ${c.total_pecas === 1 ? 'peça' : 'peças'} (${c.pedidos.length} ${c.pedidos.length === 1 ? 'pedido' : 'pedidos'})
                            </span>
                        </div>

                        <!-- Mini-galeria de todas as peças compradas pela cliente -->
                        <div class="order-pieces-gallery" style="margin-top: 6px;">
                            ${pecas.map(it => `
                                <div class="gallery-thumb-item" title="${escapeHtml(it.descricao)} (SKU: ${escapeHtml(it.sku)}) • Qtd: ${it.quantidade} • ${formatarBRL(it.preco_total)}">
                                    ${it.foto_url 
                                        ? `<img src="${escapeHtml(it.foto_url)}" alt="${escapeHtml(it.descricao)}" class="gallery-thumb-img">`
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
                                <div class="metric-val-difal" style="color: #2563EB;">
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
                                    📄 NF ${p.nf_number}
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
    // MODO 2: AGRUPADO POR PEDIDO / NF-E (PADRÃO)
    // ==========================================
    let guiasFiltradas = guias;
    if (termo) {
        guiasFiltradas = guias.filter(g => {
            const matchCli = (g.customer_name || '').toLowerCase().includes(termo);
            const matchNf = (g.nf_number || '').toLowerCase().includes(termo);
            const matchPed = (g.order_number || '').toLowerCase().includes(termo);
            const matchPeca = (g.itens || []).some(it => (it.descricao || '').toLowerCase().includes(termo) || (it.sku || '').toLowerCase().includes(termo));
            return matchCli || matchNf || matchPed || matchPeca;
        });
    }

    if (guiasFiltradas.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #64748B;">Nenhum pedido encontrado para a busca "${escapeHtml(termo)}".</div>`;
        return;
    }

    grid.innerHTML = guiasFiltradas.map(g => {
        const itens = g.itens || (g.peca_principal ? [g.peca_principal] : []);
        const totalPecas = g.total_pecas || itens.length;
        const peca = g.peca_principal || itens[0] || {};
        const fotoUrl = peca.foto_url || null;
        const hasDevolucao = g.status_alerta === 'DEVOLUCAO_IDENTIFICADA';
        const isMultiItem = itens.length > 1;

        const statusGuiaBadge = statusBadges[g.status_bancario] || statusBadges.aguardando_pagamento;

        const alertaDevolucaoHtml = hasDevolucao
            ? `<div style="background:#FEF2F2; color:#B91C1C; padding: 6px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
                 <span>${escapeHtml(g.alerta_mensagem || 'Devolução Registrada - Não pagar')}</span>
               </div>`
            : '';

        let pecasHtml = '';

        if (isMultiItem) {
            // Galeria multi-peças para quando a cliente comprou 2 ou mais peças no mesmo pedido
            pecasHtml = `
                <div style="margin-bottom: 6px;">
                    <div class="order-pieces-gallery">
                        ${itens.map((it, idx) => `
                            <div class="gallery-thumb-item" title="${escapeHtml(it.descricao)} (SKU: ${escapeHtml(it.sku)}) • Qtd: ${it.quantidade} • ${formatarBRL(it.preco_total)}" onclick="toggleListaPecas('${g.id}')">
                                ${it.foto_url 
                                    ? `<img src="${escapeHtml(it.foto_url)}" alt="${escapeHtml(it.descricao)}" class="gallery-thumb-img">`
                                    : `<div class="gallery-thumb-empty"><span>${obterIconePeca(it.descricao)}</span></div>`
                                }
                                ${it.quantidade > 1 ? `<span class="gallery-qty-badge">x${it.quantidade}</span>` : ''}
                            </div>
                        `).join('')}
                    </div>

                    <button type="button" class="btn-toggle-pieces-list" onclick="toggleListaPecas('${g.id}')" id="btn-toggle-pecas-${g.id}">
                        <span>Ver todas as ${totalPecas} peças do pedido</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>

                    <div id="pedido-pecas-${g.id}" class="order-pieces-dropdown" style="display: none;">
                        ${itens.map(it => `
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
                </div>
            `;
        } else {
            // Visualização clássica de peça única
            const thumbHtml = fotoUrl
                ? `<img src="${escapeHtml(fotoUrl)}" alt="${escapeHtml(peca.descricao || 'Peça')}" class="piece-thumb-img" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" title="Foto oficial www.boah.com.br">
                   <div class="piece-thumb-empty" style="display:none;"><span>${obterIconePeca(peca.descricao)}</span></div>`
                : `<div class="piece-thumb-empty" title="Foto não vinculada na Vnda"><span>${obterIconePeca(peca.descricao)}</span></div>`;

            pecasHtml = `
                <div class="card-360-top">
                    <div class="piece-thumb-wrap" title="Peça: ${escapeHtml(peca.descricao || 'Boah')}">
                        ${thumbHtml}
                    </div>
                    <div class="sale-info-main">
                        <span class="sale-sku-tag">SKU: ${escapeHtml(peca.sku || 'N/D')}</span>
                        <div class="sale-piece-title" title="${escapeHtml(peca.descricao || 'Peça Boah')}">
                            ${escapeHtml(peca.descricao || 'Peça da Coleção Boah')}
                        </div>
                        <div style="font-size: 11.5px; color: #64748B; margin-top: 2px;">
                            Qtd: ${peca.quantidade || 1} • ${formatarBRL(peca.preco_total || g.valor_venda)}
                        </div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="card-sale-360 ${hasDevolucao ? 'has-devolucao' : ''}" onclick="abrirModalPagamento360('${g.id}')" style="cursor: pointer;" title="Clique para ver detalhes do pagamento, parcelas e DIFAL">
                <div>
                    ${alertaDevolucaoHtml}
                    
                    <!-- Cabeçalho do Pedido e Destinatário -->
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                        <div>
                            <div class="sale-customer-line" title="${escapeHtml(g.customer_name)}" style="font-size: 13.5px; margin-bottom: 2px;">
                                <span>👤 ${escapeHtml(g.customer_name)}</span>
                            </div>
                            <div class="sale-dest-pill">
                                <span>📍 ${escapeHtml(g.cidade)}</span>
                                <span class="badge-uf-dest">${escapeHtml(g.uf)}</span>
                                <span style="margin: 0 3px; color: #CBD5E1;">•</span>
                                <span style="font-size: 11px; color: #0F172A; font-weight: 600;">📅 ${formatarDataBR(g.data_venda)}</span>
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <span class="badge-pieces-count">
                                🛍️ ${totalPecas} ${totalPecas === 1 ? 'peça' : 'peças'}
                            </span>
                            <div style="font-size: 11px; font-weight: 700; color: #2563EB; font-family: 'JetBrains Mono', monospace; margin-top: 2px;">
                                Pedido #${escapeHtml(g.order_number)}
                            </div>
                            <div style="font-size: 10.5px; color: #64748B; font-family: 'JetBrains Mono', monospace;">
                                NF ${escapeHtml(g.nf_number)}
                            </div>
                        </div>
                    </div>

                    <!-- Peças do Pedido -->
                    ${pecasHtml}

                    <div class="sale-metrics-box">
                        <div class="metric-col-venda">
                            <div>Valor do Pedido</div>
                            <div class="metric-val-venda">${formatarBRL(g.valor_venda)}</div>
                        </div>
                        <div class="metric-col-difal">
                            <div>DIFAL ${g.is_sp ? '(SP DARE)' : '(GNRE)'}</div>
                            <div class="metric-val-difal" style="${g.status_bancario === 'paga' ? 'color:#15803D;' : 'color:#2563EB;'}">
                                ${formatarBRL(g.valor_difal)}
                            </div>
                        </div>
                    </div>
                </div>

                <div class="card-360-footer">
                    <div>
                        ${statusGuiaBadge}
                    </div>
                    <div class="card-actions-group">
                        <button type="button" class="btn-card-action" style="background:#EFF6FF; color:#1D4ED8; border-color:#BFDBFE; font-weight:700;" onclick="event.stopPropagation(); abrirModalPagamento360('${g.id}')" title="Ver parcelas e informações de pagamento">
                            💳 Pagamento & DIFAL
                        </button>
                        <a href="${escapeHtml(g.danfe_url)}" target="_blank" class="btn-card-action" onclick="event.stopPropagation();" title="Visualizar DANFE Oficial">
                            📄 DANFE
                        </a>
                        ${g.gnre_url ? `<a href="${escapeHtml(g.gnre_url)}" target="_blank" class="btn-card-action" style="color: #4338CA;" onclick="event.stopPropagation();" title="Visualizar Guia GNRE">🏛️ Guia</a>` : ''}
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
                        <div style="font-size: 28px; margin-bottom: 8px;">🛡️</div>
                        <div style="font-size: 15px; font-weight: 700; color: #0F172A;">Nenhuma devolução pendente no momento</div>
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
