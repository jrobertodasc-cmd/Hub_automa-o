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

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Verifica login e carrega cabeçalho/empresa
    await carregarDadosDashboard();

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
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            localStorage.removeItem('sb_access_token');
            window.location.href = '/login.html';
            return;
        }

        const data = await res.json();
        const tenant = Array.isArray(data.tenant) ? data.tenant[0] : data.tenant;
        
        const tenantName = (tenant && tenant.name) || data.user.name || 'Aurora Store';
        const tenantEl = document.getElementById('tenant-name');
        if (tenantEl) tenantEl.textContent = tenantName;

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
        const authPaymentBtn = document.getElementById('btn-authorize-payment');

        if (!detailsSection || !guidesBody) return;

        if (batch.status === 'cancelado') {
            if (approvalBanner) approvalBanner.classList.add('d-none');
            detailsSection.classList.add('d-none');
            return;
        }

        window.activeBatchId = batch.id;
        window.activeBatch = batch;
        window.currentBatchGuides = batch.guides || [];

        // Exibe a barra de ações e tabela
        detailsSection.classList.remove('d-none');

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
                        authPaymentBtn.innerHTML = `💳 Re-gerar CNAB 240`;
                    } else {
                        authPaymentBtn.innerHTML = `💳 Autorizar Pagamento Bancário (CNAB 240)`;
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

        // Aplica os filtros iniciais e renderiza a tabela
        aplicarFiltrosTabela();

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
function atualizarKpisDoLote(batch, guides) {
    const kpiVolumes = document.getElementById('kpi-volumes');
    const kpiVolumesSub = document.getElementById('kpi-volumes-sub');
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
    if (badgeTotalPedidos) badgeTotalPedidos.textContent = `${totalVolumes} pedidos`;
    if (navCountPedidos) navCountPedidos.textContent = totalVolumes;

    // Prontos para expedição (guias autorizadas com PDF ou isentas)
    const prontos = (guides || []).filter(g => (g.storage_path || g.uf === 'SP')).length;
    if (kpiReadyVal) kpiReadyVal.textContent = prontos;
    if (kpiReadyPill && totalVolumes > 0) {
        const perc = Math.round((prontos / totalVolumes) * 100);
        kpiReadyPill.textContent = `${perc}% dos pedidos`;
    }

    // NF-e autorizadas
    const autorizadas = (guides || []).filter(g => g.status !== 'rejeitada' && g.status !== 'erro').length;
    if (kpiStatus) {
        kpiStatus.textContent = autorizadas;
        kpiStatus.style.color = '#34d399';
    }

    // Total DIFAL
    const totalDifal = (guides || []).reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
    if (kpiDifal) kpiDifal.textContent = `R$ ${totalDifal.toFixed(2).replace('.', ',')}`;

    // UFs distintas
    const ufsDistintas = new Set((guides || []).map(g => g.uf).filter(Boolean));
    if (kpiDifalSub) {
        kpiDifalSub.textContent = `Apuração interestadual · ${ufsDistintas.size || 1} UF(s)`;
    }

    // Pendências
    const pendencias = (guides || []).filter(g => !g.barcode || g.status === 'pendente').length;
    if (navCountPendencias) navCountPendencias.textContent = pendencias;

    // Abas de contagem
    const tabCountTodos = document.getElementById('tab-count-todos');
    const tabCountExpedir = document.getElementById('tab-count-expedir');
    const tabCountPendencias = document.getElementById('tab-count-pendencias');
    const tabCountExpedidos = document.getElementById('tab-count-expedidos');

    if (tabCountTodos) tabCountTodos.textContent = totalVolumes;
    if (tabCountExpedir) tabCountExpedir.textContent = prontos;
    if (tabCountPendencias) tabCountPendencias.textContent = pendencias;
    if (tabCountExpedidos) tabCountExpedidos.textContent = totalVolumes - prontos > 0 ? (totalVolumes - prontos) : 0;

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
        guidesBody.innerHTML = `<tr><td colspan="9" class="text-center" style="color: var(--text-secondary); padding: 36px;">Nenhum pedido encontrado com os filtros selecionados.</td></tr>`;
        atualizarControlesPaginacao(0, 0, 0);
        return;
    }

    const total = guias.length;
    const maxPagina = Math.max(1, Math.ceil(total / window.itensPorPagina));
    if (window.paginaAtualTabela > maxPagina) window.paginaAtualTabela = maxPagina;

    const inicio = (window.paginaAtualTabela - 1) * window.itensPorPagina;
    const fim = Math.min(inicio + window.itensPorPagina, total);
    const guiasPaginadas = guias.slice(inicio, fim);

    const isLoteAguardando = (window.activeBatch && window.activeBatch.status === 'aguardando_aprovacao');

    guidesBody.innerHTML = guiasPaginadas.map(g => {
        const isPdf = g.storage_path && g.storage_path.toLowerCase().endsWith('.pdf');
        const isSp = (g.uf === 'SP' || g.barcode === 'IMPORTAR_NO_SEFAZ_SP');
        const isSelected = window.selectedGuideIds.has(g.id);

        // 1. Canal do pedido (Shopify, Mercado Livre, etc.)
        let canal = 'Shopify';
        const rawCarrier = (g.carrier_name || 'OUTROS').toUpperCase();
        if (rawCarrier.includes('CORREIOS')) canal = 'Mercado Livre';
        else if (rawCarrier.includes('TOTAL')) canal = 'Shopify';
        else if (rawCarrier.includes('JADLOG')) canal = 'Amazon';
        else if (g.customer_name && g.customer_name.length > 20) canal = 'Vnda';

        // 2. Destino (Cidade e UF)
        const cidadesMock = {
            'SP': 'São Paulo', 'RJ': 'Rio de Janeiro', 'MG': 'Belo Horizonte',
            'PR': 'Curitiba', 'BA': 'Salvador', 'RS': 'Porto Alegre',
            'SC': 'Florianópolis', 'DF': 'Brasília', 'PE': 'Recife',
            'MA': 'São Luís', 'RN': 'Natal', 'MS': 'Campo Grande'
        };
        const cidade = cidadesMock[g.uf] || g.uf;

        // 3. Valor Total do Pedido (Base DIFAL aproximada ou valor do DIFAL * 5)
        const difalVal = parseFloat(g.value || 0);
        const pedidoTotal = (difalVal > 0 ? (difalVal * 5.8 + 49.9).toFixed(2) : '189,90').replace('.', ',');

        // 4. Status NF-e (Autorizada, Rejeitada, Processando)
        let nfeStatusHtml = '';
        if (isLoteAguardando) {
            nfeStatusHtml = `
                <div class="figma-nfe-status nfe-processando">
                    <span class="figma-nfe-dot"></span>
                    <span>Processando</span>
                </div>
                <div style="font-size: 10.5px; color: #697789;">Enviada à SEFAZ</div>
            `;
        } else if (g.status === 'rejeitada' || g.status === 'erro') {
            nfeStatusHtml = `
                <div class="figma-nfe-status nfe-rejeitada">
                    <span class="figma-nfe-dot"></span>
                    <span>Rejeitada</span>
                </div>
                <div style="font-size: 10.5px; color: #f87171;">Rejeição · Revisar</div>
            `;
        } else {
            nfeStatusHtml = `
                <div class="figma-nfe-status nfe-autorizada">
                    <span class="figma-nfe-dot"></span>
                    <span>Autorizada</span>
                </div>
                <div style="font-size: 10.5px; color: #697789;">NF-e 000.${String(g.nf_number).padStart(6, '0')}</div>
            `;
        }

        // 5. DIFAL / Guia
        let difalHtml = '';
        if (isSp) {
            difalHtml = `
                <div style="font-weight: 500; color: #697789;">—</div>
                <div style="font-size: 10.5px; color: #697789;">Não se aplica</div>
            `;
        } else if (g.status === 'liquidada' || g.status === 'baixada' || g.status === 'pago') {
            difalHtml = `
                <div style="font-weight: 600; color: #fff;">R$ ${difalVal.toFixed(2).replace('.', ',')}</div>
                <div style="font-size: 10.5px; color: #10b981;">Recolhida</div>
            `;
        } else if (g.barcode || g.storage_path) {
            difalHtml = `
                <div style="font-weight: 600; color: #fff;">R$ ${difalVal.toFixed(2).replace('.', ',')}</div>
                <div style="font-size: 10.5px; color: #38bdf8;">Guia gerada</div>
            `;
        } else {
            difalHtml = `
                <div style="font-weight: 600; color: #fbbf24;">R$ ${difalVal.toFixed(2).replace('.', ',')}</div>
                <div style="font-size: 10.5px; color: #fbbf24;">Aguardando NF-e</div>
            `;
        }

        // 6. Transportadora e Serviço
        let transpNome = g.carrier_name || 'Jadlog';
        let servico = 'Package';
        if (rawCarrier.includes('CORREIOS')) servico = g.uf === 'SP' ? 'SEDEX' : 'PAC';
        else if (rawCarrier.includes('TOTAL')) servico = 'Express Standard';
        else if (rawCarrier.includes('LOGGI')) servico = 'Entrega nacional';

        // 7. Status Expedição
        let expClass = 'badge-exp-pronto';
        let expTexto = 'Pronto para envio';
        if (g.status === 'rejeitada' || g.status === 'erro') {
            expClass = 'badge-exp-bloqueado';
            expTexto = 'Bloqueado fiscal';
        } else if (isLoteAguardando || (!g.storage_path && !isSp)) {
            expClass = 'badge-exp-separacao';
            expTexto = 'Em separação';
        } else if (g.status === 'liquidada' || g.status === 'baixada') {
            expClass = 'badge-exp-expedido';
            expTexto = 'Expedido';
        }

        // 8. Botões de Ações Rápidas
        let actionsHtml = `<div style="display: inline-flex; gap: 4px; justify-content: flex-end;">`;
        if (g.storage_path) {
            actionsHtml += `<a href="/api/guide/download/${g.id}" target="_blank" class="p-btn" title="Baixar Guia PDF" style="text-decoration: none;">📄</a>`;
        }
        actionsHtml += `<a href="/api/guide/danfe/${g.id}" target="_blank" class="p-btn" title="Ver DANFE" style="text-decoration: none;">🧾</a>`;
        actionsHtml += `<a href="/api/guide/nfe-xml/${g.id}" target="_blank" class="p-btn" title="Baixar XML" style="text-decoration: none;">📥</a>`;
        actionsHtml += `</div>`;

        const clienteNome = g.customer_name ? escapeHtml(g.customer_name) : 'Consumidor Final';

        return `
            <tr>
                <td style="text-align: center;">
                    <input type="checkbox" class="row-guide-checkbox" data-id="${g.id}" ${isSelected ? 'checked' : ''} onchange="toggleSelectRow('${g.id}', this)" style="cursor: pointer; accent-color: #2563eb;">
                </td>
                <td>
                    <div style="display: flex; align-items: center;">
                        <strong style="color: #fff; font-size: 12.5px;">#${escapeHtml(g.nf_number)}</strong>
                        <span class="canal-tag">${canal}</span>
                    </div>
                    <div style="font-size: 11px; color: #9eacc0; margin-top: 2px;">${clienteNome}</div>
                </td>
                <td>
                    <div style="font-size: 12px; font-weight: 500; color: #fff;">${cidade}</div>
                    <div style="font-size: 10.5px; color: #697789;">${escapeHtml(g.uf)} · Consumidor final</div>
                </td>
                <td>
                    <div style="font-size: 12px; font-weight: 600; color: #fff;">R$ ${pedidoTotal}</div>
                    <div style="font-size: 10.5px; color: #10b981;">Pagamento aprovado</div>
                </td>
                <td>${nfeStatusHtml}</td>
                <td>${difalHtml}</td>
                <td>
                    <div style="font-size: 12px; font-weight: 600; color: #fff;">${escapeHtml(transpNome)}</div>
                    <div style="font-size: 10.5px; color: #697789;">${servico}</div>
                </td>
                <td><span class="${expClass}">${expTexto}</span></td>
                <td style="text-align: right;">${actionsHtml}</td>
            </tr>
        `;
    }).join('');

    atualizarControlesPaginacao(inicio + 1, fim, total);
    atualizarContadorSelecao();
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

        // Dispara o download automático do arquivo remessa.txt
        const link = document.createElement('a');
        link.href = `/api/remessa/download/${window.activeBatchId}?banco=${banco}`;
        link.download = `remessa_${banco.toUpperCase()}_lote_${window.activeBatchId.substring(0, 8)}.txt`;
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

// Expõe funções no escopo global para o HTML
window.abrirModalAutorizacaoEmissao = abrirModalAutorizacaoEmissao;
window.fecharModalAutorizacaoEmissao = fecharModalAutorizacaoEmissao;
window.confirmarAutorizacaoEmissao = confirmarAutorizacaoEmissao;
window.descartarLoteAtual = descartarLoteAtual;
window.abrirModalAutorizacaoPagamento = abrirModalAutorizacaoPagamento;
window.fecharModalAutorizacaoPagamento = fecharModalAutorizacaoPagamento;
window.confirmarAutorizacaoPagamento = confirmarAutorizacaoPagamento;
window.carregarDetalhesLote = carregarDetalhesLote;
window.toggleSelectAll = toggleSelectAll;
window.toggleSelectRow = toggleSelectRow;
window.mudarPaginaTabela = mudarPaginaTabela;
window.irParaPagina = irParaPagina;
window.toggleMaisFiltros = toggleMaisFiltros;
window.imprimirGuiasLoteIntercaladas = imprimirGuiasLoteIntercaladas;

