// public/js/admin.js
// Lógica do Painel Administrativo Master (SuperAdmin) - expedi HUB SaaS

let allTenants = [];
let allUsers = [];

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showToast(msg, tipo = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    if (tipo === 'error') toast.style.background = '#EF4444';
    else if (tipo === 'success') toast.style.background = '#10B981';
    else toast.style.background = '#0F172A';

    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 3500);
}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Carrega métricas SaaS globais
    await carregarMetricas();

    // 2. Carrega lista de empresas (Tenants)
    await carregarEmpresas();

    // 3. Carrega lista de usuários
    await carregarUsuarios();

    // 4. Carrega registros de auditoria
    await carregarAuditoria();
});

// ==========================================
// 1. CARREGAMENTO DE DADOS
// ==========================================

async function carregarMetricas() {
    try {
        const res = await fetch('/api/admin/metrics');
        if (!res.ok) return;
        const data = await res.json();

        const elTenants = document.getElementById('metric-tenants-total');
        const elTenantsSub = document.getElementById('metric-tenants-sub');
        const elGuias = document.getElementById('metric-guias-total');
        const elDifal = document.getElementById('metric-difal-total');

        if (elTenants) elTenants.textContent = data.totalTenants;
        if (elTenantsSub) elTenantsSub.textContent = `${data.ativos} ativas · ${data.bloqueados} bloqueadas`;
        if (elGuias) elGuias.textContent = data.totalGuias.toLocaleString('pt-BR');
        if (elDifal) elDifal.textContent = `R$ ${data.totalDifalLiquidado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

    } catch (e) {
        console.warn("Erro ao carregar métricas SaaS:", e);
    }
}

async function carregarEmpresas() {
    try {
        const res = await fetch('/api/admin/tenants');
        if (!res.ok) throw new Error("Erro ao carregar lista de empresas.");
        const data = await res.json();
        allTenants = data || [];

        // Atualiza tabela
        const tbody = document.getElementById('tenants-table-body');
        if (!tbody) return;

        if (allTenants.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">Nenhuma empresa cadastrada.</td></tr>`;
            return;
        }

        tbody.innerHTML = allTenants.map(t => {
            const status = (t.status || t.subscription_status || 'ativo').toLowerCase();
            const isAtivo = status === 'ativo';
            const statusBadge = isAtivo 
                ? `<span class="badge-status status-active">🟢 Ativa</span>`
                : `<span class="badge-status status-blocked">🔴 Bloqueada</span>`;

            const plano = (t.plano || 'pro').toLowerCase();
            const planoBadge = `<span class="badge-plan plan-${plano}">${plano.toUpperCase()}</span>`;

            const limite = t.limite_guias_mes || t.plan_limit_guides || 1000;
            const usadas = t.guias_usadas_mes || 0;
            const pct = limite > 0 ? Math.min(100, Math.round((usadas / limite) * 100)) : 0;

            const toggleActionText = isAtivo ? 'Bloquear' : 'Desbloquear';
            const toggleActionClass = isAtivo ? 'btn-sm-danger' : 'btn-sm-success';
            const novoStatus = isAtivo ? 'bloqueado' : 'ativo';

            return `
                <tr>
                    <td>
                        <div class="cell-company">${escapeHtml(t.razao_social || 'Sem Razão Social')}</div>
                        <div class="cell-sub">CNPJ: ${escapeHtml(t.cnpj || '-')} ${t.nome_fantasia ? '· ' + escapeHtml(t.nome_fantasia) : ''}</div>
                    </td>
                    <td>${planoBadge}</td>
                    <td>
                        <div style="font-size: 12.5px; font-weight: 700; color: var(--navy-dark);">${usadas} / ${limite} guias</div>
                        <div style="width: 120px; height: 5px; background: #E2E8F0; border-radius: 3px; margin-top: 4px; overflow: hidden;">
                            <div style="width: ${pct}%; height: 100%; background: ${pct > 90 ? '#EF4444' : '#2563EB'};"></div>
                        </div>
                    </td>
                    <td>${statusBadge}</td>
                    <td style="text-align: right;">
                        <button class="btn-sm" onclick="abrirModalAlterarPlano('${escapeHtml(t.id)}', '${escapeHtml(t.razao_social)}', '${plano}', ${limite})">⚡ Plano</button>
                        <button class="btn-sm ${toggleActionClass}" onclick="alternarStatusEmpresa('${escapeHtml(t.id)}', '${novoStatus}')">${toggleActionText}</button>
                    </td>
                </tr>
            `;
        }).join('');

        // Popula select de empresas no modal de criar usuário
        const selectTenant = document.getElementById('user-tenant');
        if (selectTenant) {
            selectTenant.innerHTML = allTenants.map(t => `
                <option value="${escapeHtml(t.id)}">${escapeHtml(t.razao_social)} (CNPJ: ${escapeHtml(t.cnpj)})</option>
            `).join('');
        }

    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function carregarUsuarios() {
    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) throw new Error("Erro ao carregar usuários.");
        const data = await res.json();
        allUsers = data || [];

        const tbody = document.getElementById('users-table-body');
        if (!tbody) return;

        if (allUsers.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">Nenhum usuário cadastrado.</td></tr>`;
            return;
        }

        tbody.innerHTML = allUsers.map(u => {
            const role = (u.role || (u.is_admin ? 'admin' : 'operador')).toLowerCase();
            let roleBadge = '';
            if (role === 'superadmin') roleBadge = '<span class="badge-role role-superadmin">👑 SuperAdmin Master</span>';
            else if (role === 'admin') roleBadge = '<span class="badge-role role-admin">🛡️ Admin Loja</span>';
            else if (role === 'diretoria' || role === 'financeiro') roleBadge = '<span class="badge-role role-diretoria">💼 Diretoria / Fin.</span>';
            else roleBadge = '<span class="badge-role role-operador">📦 Operador Doca</span>';

            const empresaNome = u.tenants ? u.tenants.razao_social : 'Global / Sem Vínculo';

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--navy-dark);">${escapeHtml(u.name || '-')}</td>
                    <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-muted);">${escapeHtml(u.email)}</td>
                    <td>${escapeHtml(empresaNome)}</td>
                    <td>${roleBadge}</td>
                    <td style="text-align: right;">
                        <button class="btn-sm" onclick="abrirModalResetSenha('${escapeHtml(u.id)}', '${escapeHtml(u.email)}')">🔑 Nova Senha</button>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function carregarAuditoria() {
    try {
        const res = await fetch('/api/admin/audit-logs?limit=40');
        if (!res.ok) return;
        const logs = await res.json();

        const tbody = document.getElementById('audit-table-body');
        if (!tbody) return;

        if (!logs || logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">Nenhum registro de auditoria encontrado.</td></tr>`;
            return;
        }

        tbody.innerHTML = logs.map(l => {
            const dataFmt = new Date(l.created_at).toLocaleString('pt-BR');
            const empresaNome = l.tenants?.razao_social || 'Sistema Geral';

            return `
                <tr>
                    <td style="font-size: 12px; color: var(--text-muted); white-space: nowrap;">${dataFmt}</td>
                    <td><span class="badge-plan plan-starter" style="font-size: 10px;">${escapeHtml(l.acao)}</span></td>
                    <td style="font-size: 12px; font-weight: 600;">${escapeHtml(empresaNome)}</td>
                    <td style="font-size: 12px; color: #475569; max-width: 400px; word-break: break-word;">${escapeHtml(l.detalhe || '-')}</td>
                    <td style="font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--text-muted);">${escapeHtml(l.ip_address || '127.0.0.1')}</td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        console.warn("Erro ao carregar auditoria:", e);
    }
}

// ==========================================
// 2. AÇÕES DE GESTÃO (TENANTS & USERS)
// ==========================================

async function alternarStatusEmpresa(tenantId, novoStatus) {
    const acaoTxt = novoStatus === 'ativo' ? 'DESBLOQUEAR' : 'BLOQUEAR';
    if (!confirm(`Deseja realmente ${acaoTxt} a licença desta empresa?`)) return;

    try {
        const res = await fetch('/api/admin/tenants/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId, status: novoStatus })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast(data.message, 'success');
        await carregarEmpresas();
        await carregarMetricas();
        await carregarAuditoria();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function abrirModalAlterarPlano(tenantId, razaoSocial, planoAtual, limiteAtual) {
    document.getElementById('edit-plano-tenant-id').value = tenantId;
    document.getElementById('edit-plano-nome').textContent = razaoSocial;
    document.getElementById('edit-plano-tipo').value = planoAtual;
    document.getElementById('edit-plano-limite').value = limiteAtual;
    document.getElementById('modal-alterar-plano').style.display = 'flex';
}

function fecharModalAlterarPlano() {
    document.getElementById('modal-alterar-plano').style.display = 'none';
}

function ajustarLimiteEditPlano() {
    const plano = document.getElementById('edit-plano-tipo').value;
    const inputLimite = document.getElementById('edit-plano-limite');
    if (plano === 'trial') inputLimite.value = 50;
    else if (plano === 'starter') inputLimite.value = 300;
    else if (plano === 'pro') inputLimite.value = 1500;
    else if (plano === 'enterprise') inputLimite.value = 10000;
}

async function salvarAlteracaoPlano(event) {
    event.preventDefault();
    const tenantId = document.getElementById('edit-plano-tenant-id').value;
    const plano = document.getElementById('edit-plano-tipo').value;
    const limite_guias_mes = document.getElementById('edit-plano-limite').value;

    try {
        const res = await fetch('/api/admin/tenants/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId, plano, limite_guias_mes })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast(data.message, 'success');
        fecharModalAlterarPlano();
        await carregarEmpresas();
        await carregarAuditoria();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function abrirModalCriarEmpresa() {
    document.getElementById('modal-criar-empresa').style.display = 'flex';
}

function fecharModalCriarEmpresa() {
    document.getElementById('modal-criar-empresa').style.display = 'none';
    document.getElementById('form-criar-empresa').reset();
}

function ajustarLimitePadraoPlano() {
    const plano = document.getElementById('empresa-plano').value;
    const inputLimite = document.getElementById('empresa-limite');
    if (plano === 'trial') inputLimite.value = 50;
    else if (plano === 'starter') inputLimite.value = 300;
    else if (plano === 'pro') inputLimite.value = 1500;
    else if (plano === 'enterprise') inputLimite.value = 10000;
}

async function salvarNovaEmpresa(event) {
    event.preventDefault();
    const cnpj = document.getElementById('empresa-cnpj').value;
    const razao_social = document.getElementById('empresa-razao').value;
    const nome_fantasia = document.getElementById('empresa-fantasia').value;
    const email_admin = document.getElementById('empresa-email').value;
    const plano = document.getElementById('empresa-plano').value;
    const limite_guias_mes = document.getElementById('empresa-limite').value;

    try {
        const res = await fetch('/api/admin/tenants/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpj, razao_social, nome_fantasia, email_admin, plano, limite_guias_mes })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast("Empresa cadastrada e ativada com sucesso!", 'success');
        fecharModalCriarEmpresa();
        await carregarEmpresas();
        await carregarMetricas();
        await carregarAuditoria();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function abrirModalCriarUsuario() {
    document.getElementById('modal-criar-usuario').style.display = 'flex';
}

function fecharModalCriarUsuario() {
    document.getElementById('modal-criar-usuario').style.display = 'none';
    document.getElementById('form-criar-usuario').reset();
}

async function salvarNovoUsuario(event) {
    event.preventDefault();
    const name = document.getElementById('user-nome').value;
    const email = document.getElementById('user-email').value;
    const password = document.getElementById('user-senha').value;
    const tenantId = document.getElementById('user-tenant').value;
    const role = document.getElementById('user-role').value;

    try {
        const res = await fetch('/api/admin/users/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password, tenantId, role })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast("Usuário cadastrado com sucesso!", 'success');
        fecharModalCriarUsuario();
        await carregarUsuarios();
        await carregarAuditoria();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function abrirModalResetSenha(userId, email) {
    document.getElementById('reset-user-id').value = userId;
    document.getElementById('reset-user-email-display').textContent = email;
    document.getElementById('modal-reset-senha').style.display = 'flex';
}

function fecharModalResetSenha() {
    document.getElementById('modal-reset-senha').style.display = 'none';
    document.getElementById('form-reset-senha').reset();
}

async function salvarResetSenha(event) {
    event.preventDefault();
    const userId = document.getElementById('reset-user-id').value;
    const password = document.getElementById('reset-nova-senha').value;

    try {
        const res = await fetch('/api/admin/users/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast("Senha alterada com sucesso!", 'success');
        fecharModalResetSenha();
        await carregarAuditoria();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ==========================================
// 3. CONTROLE DE ABAS E LOGOUT
// ==========================================

function trocarAbaAdmin(aba) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));

    if (aba === 'tenants') {
        document.querySelectorAll('.tab-btn')[0].classList.add('active');
        document.getElementById('tab-tenants').classList.add('active');
    } else if (aba === 'users') {
        document.querySelectorAll('.tab-btn')[1].classList.add('active');
        document.getElementById('tab-users').classList.add('active');
    } else if (aba === 'audit') {
        document.querySelectorAll('.tab-btn')[2].classList.add('active');
        document.getElementById('tab-audit').classList.add('active');
        carregarAuditoria();
    }
}

function logout() {
    document.cookie = "sb_access_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;";
    localStorage.removeItem('sb_access_token');
    window.location.href = '/login.html';
}

window.trocarAbaAdmin = trocarAbaAdmin;
window.abrirModalCriarEmpresa = abrirModalCriarEmpresa;
window.fecharModalCriarEmpresa = fecharModalCriarEmpresa;
window.salvarNovaEmpresa = salvarNovaEmpresa;
window.abrirModalAlterarPlano = abrirModalAlterarPlano;
window.fecharModalAlterarPlano = fecharModalAlterarPlano;
window.ajustarLimiteEditPlano = ajustarLimiteEditPlano;
window.salvarAlteracaoPlano = salvarAlteracaoPlano;
window.abrirModalCriarUsuario = abrirModalCriarUsuario;
window.fecharModalCriarUsuario = fecharModalCriarUsuario;
window.salvarNovoUsuario = salvarNovoUsuario;
window.abrirModalResetSenha = abrirModalResetSenha;
window.fecharModalResetSenha = fecharModalResetSenha;
window.salvarResetSenha = salvarResetSenha;
window.alternarStatusEmpresa = alternarStatusEmpresa;
window.carregarAuditoria = carregarAuditoria;
window.logout = logout;
