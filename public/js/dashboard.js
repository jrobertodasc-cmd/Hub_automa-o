// ============================================================== //
// ORQUESTRADOR PRINCIPAL: EXPEDI HUB DASHBOARD                   //
// ============================================================== //

window._DIFAL_ABERTAS_FALLBACK = window._DIFAL_ABERTAS_FALLBACK || [];

// Telemetria & Monitoramento de Exceções do Frontend (Sentry Bridge)
(function initFrontendTelemetry() {
    let lastReportedTime = 0;
    function reportError(msg, stack) {
        const now = Date.now();
        if (now - lastReportedTime < 3000) return; // Limita a 1 reporte a cada 3s
        lastReportedTime = now;
        try {
            const tenantId = window.currentUserProfile?.tenant_id || localStorage.getItem('sb_tenant_id');
            navigator.sendBeacon?.('/api/telemetry/report', JSON.stringify({
                message: String(msg),
                stack: String(stack || ''),
                url: window.location.href,
                tenantId: tenantId
            })) || fetch('/api/telemetry/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: String(msg), stack: String(stack || ''), url: window.location.href, tenantId: tenantId }),
                keepalive: true
            }).catch(() => {});
        } catch {}
    }

    window.addEventListener('error', (event) => {
        reportError(event.message || event.error?.message, event.error?.stack);
    });

    window.addEventListener('unhandledrejection', (event) => {
        reportError(event.reason?.message || event.reason, event.reason?.stack);
    });
})();


function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

        // Assistente de Onboarding e Franquia de Assinatura SaaS
        if (typeof window.iniciarOnboardingDashboard === 'function') {
            window.iniciarOnboardingDashboard(tenant);
        }
    } catch (e) {
        showToast("Erro ao carregar dados do dashboard: " + e.message, 'error');
    }
}



document.addEventListener('DOMContentLoaded', async () => {
    // 1. Verifica login e carrega cabeçalho/empresa
    await carregarDadosDashboard();

    // 1.1 Carrega cargas reais da Doca da Linx Microvix
    await carregarCargasDocaReais();

    // 1.2 Inicia escuta em tempo real da Doca (SSE)
    iniciarSSEAtualizacaoDoca();

    // 1.25 Carrega resumo consolidado da Remessa Itaú em tempo real
    if (typeof carregarResumoRemessaAoVivo === 'function') {
        carregarResumoRemessaAoVivo();
    }

    // 1.3 Ativa a visualização principal do Figma (Início / Hub Operacional) por padrão
    const urlParams = new URLSearchParams(window.location.search);
    const abaAlvo = urlParams.get('aba') || (window.location.hash ? window.location.hash.replace('#', '') : 'hub');
    if (typeof navegarAbaPrincipal === 'function') {
        navegarAbaPrincipal(abaAlvo);
    }

    // 1.4 Carrega métricas de BI e sintoniza cards da tela inicial com Vnda
    if (typeof carregarDadosBI === 'function') {
        carregarDadosBI();
    }

    // 2. Carrega histórico de lotes
    await carregarHistoricoLotes();

    // 2.1 Carrega status do agendador automático
    await carregarStatusSync();

    // 2.15 Heartbeat Silencioso: auto-atualiza métricas em background a cada 60s sem travar o navegador
    setInterval(() => {
        try {
            if (typeof carregarDadosBI === 'function') carregarDadosBI();
            if (typeof carregarResumoRemessaAoVivo === 'function') carregarResumoRemessaAoVivo();
            if (typeof carregarStatusSync === 'function') carregarStatusSync();
        } catch (e) {
            console.debug('[Heartbeat] Sync silencioso:', e.message);
        }
    }, 60000);

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
