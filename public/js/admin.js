// public/js/admin.js
// Master Executive Console (SuperAdmin) - expedi HUB SaaS v2.4.0

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
    if (tipo === 'error') {
        toast.style.background = '#EF4444';
        toast.style.color = '#FFFFFF';
    } else if (tipo === 'success') {
        toast.style.background = '#10B981';
        toast.style.color = '#FFFFFF';
    } else {
        toast.style.background = '#1E293B';
        toast.style.color = '#F8FAFC';
    }

    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 3800);
}

// ==========================================
// BOOTSTRAP & VALIDAÇÃO DE ACESSO MASTER
// ==========================================
async function verificarSessaoSuperAdmin() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            window.location.href = '/login.html?redirect=/admin.html';
            return false;
        }

        const data = await res.json();
        const role = (data.profile?.role || '').toLowerCase();
        const isAdmin = !!data.profile?.is_admin;

        if (role !== 'superadmin' && !isAdmin) {
            alert('Acesso Restrito: Este painel exige privilégios de SuperAdmin Master. Redirecionando para o cockpit...');
            window.location.href = '/dashboard.html';
            return false;
        }

        return true;
    } catch (e) {
        window.location.href = '/login.html?redirect=/admin.html';
        return false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const isAuthed = await verificarSessaoSuperAdmin();
    if (!isAuthed) return;

    await Promise.all([
        carregarMetricas(),
        carregarEmpresas(),
        carregarUsuarios(),
        carregarAuditoria()
    ]);
});

// ==========================================
// 1. CARREGAMENTO DE MÉTRICAS & DADOS
// ==========================================
async function carregarMetricas() {
    try {
        const res = await fetch('/api/admin/metrics');
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Falha ao carregar métricas.');
        }
        const data = await res.json();

        const elTenants = document.getElementById('metric-tenants-total');
        const elTenantsSub = document.getElementById('metric-tenants-sub');
        const elGuias = document.getElementById('metric-guias-total');
        const elDifal = document.getElementById('metric-difal-total');

        if (elTenants) elTenants.textContent = data.totalTenants ?? 0;
        if (elTenantsSub) elTenantsSub.textContent = `${data.ativos ?? 0} ativas · ${data.bloqueados ?? 0} suspensas`;
        if (elGuias) elGuias.textContent = (data.totalGuias ?? 0).toLocaleString('pt-BR');
        if (elDifal) elDifal.textContent = `R$ ${(data.totalDifalLiquidado ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

    } catch (e) {
        console.warn("[Admin Console] Métricas:", e.message);
    }
}

async function carregarEmpresas() {
    const tbody = document.getElementById('tenants-table-body');
    try {
        const res = await fetch('/api/admin/tenants');
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Erro ao carregar lista de empresas.');
        }
        const data = await res.json();
        allTenants = data || [];

        if (!tbody) return;

        if (allTenants.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 50px;">
                        <div style="font-size: 15px; font-weight: 600; color: #fff; margin-bottom: 6px;">Nenhuma empresa cliente cadastrada ainda.</div>
                        <p style="font-size: 13px; margin-bottom: 16px;">Cadastre seu primeiro assinante para gerar credenciais e licença.</p>
                        <button class="btn-primary-glow" onclick="abrirModalCriarEmpresa()">+ Cadastrar Primeira Empresa</button>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = allTenants.map(t => {
            const status = (t.status || t.subscription_status || 'ativo').toLowerCase();
            const isAtivo = status === 'ativo';
            const statusBadge = isAtivo 
                ? `<span class="badge badge-active"><span class="pulse-dot"></span> ATIVA</span>`
                : `<span class="badge badge-blocked">SUSPENSA</span>`;

            const plano = (t.plano || 'pro').toLowerCase();
            const planoBadge = `<span class="badge badge-plan-${plano}">${plano.toUpperCase()}</span>`;

            const limite = t.limite_guias_mes || t.plan_limit_guides || 1000;
            const usadas = t.guias_usadas_mes || 0;
            const pct = limite > 0 ? Math.min(100, Math.round((usadas / limite) * 100)) : 0;
            const barColor = pct > 90 ? '#EF4444' : pct > 70 ? '#F59E0B' : '#3B82F6';

            const toggleActionText = isAtivo ? 'Bloquear' : 'Reativar';
            const toggleActionClass = isAtivo ? 'btn-table-danger' : 'btn-table';
            const novoStatus = isAtivo ? 'bloqueado' : 'ativo';

            return `
                <tr>
                    <td>
                        <div style="font-weight: 700; color: #fff; font-size: 14px;">${escapeHtml(t.razao_social || 'Sem Razão Social')}</div>
                        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                            ${t.nome_fantasia ? escapeHtml(t.nome_fantasia) + ' · ' : ''}
                            ${t.email_admin ? escapeHtml(t.email_admin) : 'Sem e-mail cadastrado'}
                        </div>
                    </td>
                    <td>
                        <span class="mono" style="color: #94A3B8;">${escapeHtml(formatarCnpj(t.cnpj))}</span>
                    </td>
                    <td>${planoBadge}</td>
                    <td>
                        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; color: #E2E8F0; margin-bottom: 5px;">
                            <span>${usadas} / ${limite} NFs</span>
                            <span style="color: var(--text-muted);">${pct}%</span>
                        </div>
                        <div style="width: 140px; height: 5px; background: rgba(255,255,255,0.08); border-radius: 999px; overflow: hidden;">
                            <div style="width: ${pct}%; height: 100%; background: ${barColor}; transition: width 0.3s;"></div>
                        </div>
                    </td>
                    <td>${statusBadge}</td>
                    <td>
                        <div class="action-group">
                            <button class="btn-table" onclick="abrirModalAlterarPlano('${escapeHtml(t.id)}', '${escapeHtml(t.razao_social)}', '${plano}', ${limite})">Editar Plano</button>
                            <button class="btn-table ${toggleActionClass}" onclick="alternarStatusEmpresa('${escapeHtml(t.id)}', '${novoStatus}')">${toggleActionText}</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        // Atualiza seletor de empresas no modal de usuários
        const selectTenant = document.getElementById('user-tenant');
        if (selectTenant) {
            selectTenant.innerHTML = allTenants.map(t => `
                <option value="${escapeHtml(t.id)}">${escapeHtml(t.razao_social)} (CNPJ: ${escapeHtml(t.cnpj)})</option>
            `).join('');
        }

    } catch (e) {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #EF4444; padding: 30px;">${escapeHtml(e.message)}</td></tr>`;
        }
        showToast(e.message, 'error');
    }
}

async function carregarUsuarios() {
    const tbody = document.getElementById('users-table-body');
    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Erro ao carregar usuários.');
        }
        const data = await res.json();
        allUsers = data || [];

        if (!tbody) return;

        if (allUsers.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 40px;">Nenhum usuário cadastrado.</td></tr>`;
            return;
        }

        tbody.innerHTML = allUsers.map(u => {
            const role = (u.role || (u.is_admin ? 'admin' : 'operador')).toLowerCase();
            let roleBadge = '';
            if (role === 'superadmin') roleBadge = '<span class="badge badge-plan-enterprise">SuperAdmin Master</span>';
            else if (role === 'admin') roleBadge = '<span class="badge badge-plan-starter">Admin da Loja</span>';
            else if (role === 'diretoria' || role === 'financeiro') roleBadge = '<span class="badge badge-plan-pro">Diretoria / Fin.</span>';
            else roleBadge = '<span class="badge badge-plan-trial">Operador de Doca</span>';

            const empresaNome = u.tenants ? u.tenants.razao_social : 'Acesso Global';

            return `
                <tr>
                    <td>
                        <div style="font-weight: 700; color: #fff;">${escapeHtml(u.name || 'Sem Nome')}</div>
                    </td>
                    <td>
                        <span class="mono" style="color: #94A3B8;">${escapeHtml(u.email)}</span>
                    </td>
                    <td>
                        <span style="color: #E2E8F0; font-weight: 500;">${escapeHtml(empresaNome)}</span>
                    </td>
                    <td>${roleBadge}</td>
                    <td>
                        <div class="action-group">
                            <button class="btn-table" onclick="abrirModalResetSenha('${escapeHtml(u.id)}', '${escapeHtml(u.email)}')">Redefinir Senha</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #EF4444; padding: 30px;">${escapeHtml(e.message)}</td></tr>`;
        }
        showToast(e.message, 'error');
    }
}

async function carregarAuditoria() {
    const tbody = document.getElementById('audit-table-body');
    try {
        const res = await fetch('/api/admin/audit-logs?limit=40');
        if (!res.ok) return;
        const logs = await res.json();

        if (!tbody) return;

        if (!logs || logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 40px;">Nenhum registro de auditoria gravado.</td></tr>`;
            return;
        }

        tbody.innerHTML = logs.map(l => {
            const dataFmt = new Date(l.created_at).toLocaleString('pt-BR');
            const empresaNome = l.tenants?.razao_social || 'Cluster Global';

            return `
                <tr>
                    <td class="mono" style="color: var(--text-muted); font-size: 12px; white-space: nowrap;">${dataFmt}</td>
                    <td>
                        <span class="badge badge-plan-pro">${escapeHtml(l.acao || 'OPERACAO')}</span>
                    </td>
                    <td style="color: #fff; font-weight: 500;">${escapeHtml(empresaNome)}</td>
                    <td style="color: var(--text-secondary); max-width: 450px;">${escapeHtml(l.detalhe || '-')}</td>
                    <td class="mono" style="color: var(--text-muted); font-size: 11.5px;">${escapeHtml(l.ip_address || '127.0.0.1')}</td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        console.warn("[Admin Console] Auditoria:", e.message);
    }
}

// Formatação auxiliar de CNPJ
function formatarCnpj(cnpj) {
    if (!cnpj) return '-';
    const c = String(cnpj).replace(/\D/g, '');
    if (c.length === 14) {
        return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    }
    return cnpj;
}

// ==========================================
// 2. AÇÕES DE GESTÃO (TENANTS & USERS)
// ==========================================
async function alternarStatusEmpresa(tenantId, novoStatus) {
    const confirmMsg = novoStatus === 'bloqueado'
        ? "Tem certeza que deseja SUSPENDER esta empresa? Os operadores não conseguirão faturar até a reativação."
        : "Reativar a licença operacional desta empresa?";

    if (!confirm(confirmMsg)) return;

    try {
        const res = await fetch('/api/admin/tenants/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId, status: novoStatus })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Erro ao atualizar status da empresa.");

        showToast(data.message || "Status da empresa atualizado!", 'success');
        await carregarEmpresas();
        await carregarMetricas();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function abrirModalAlterarPlano(tenantId, razaoSocial, planoAtual, limiteAtual) {
    document.getElementById('edit-plano-tenant-id').value = tenantId;
    document.getElementById('edit-plano-nome').textContent = razaoSocial;
    document.getElementById('edit-plano-tipo').value = planoAtual;
    document.getElementById('edit-plano-limite').value = limiteAtual;
    document.getElementById('modal-alterar-plano').classList.add('active');
}

function fecharModalAlterarPlano() {
    document.getElementById('modal-alterar-plano').classList.remove('active');
}

function ajustarLimiteEditPlano() {
    const tipo = document.getElementById('edit-plano-tipo').value;
    const inputLimite = document.getElementById('edit-plano-limite');
    if (tipo === 'trial') inputLimite.value = 50;
    else if (tipo === 'starter') inputLimite.value = 300;
    else if (tipo === 'pro') inputLimite.value = 1500;
    else if (tipo === 'enterprise') inputLimite.value = 10000;
}

async function salvarAlteracaoPlano(e) {
    e.preventDefault();
    const tenantId = document.getElementById('edit-plano-tenant-id').value;
    const plano = document.getElementById('edit-plano-tipo').value;
    const limite = document.getElementById('edit-plano-limite').value;

    try {
        const res = await fetch('/api/admin/tenants/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenantId, plano, limite_guias_mes: limite })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Erro ao atualizar plano.");

        showToast("Assinatura atualizada com sucesso!", 'success');
        fecharModalAlterarPlano();
        await carregarEmpresas();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function abrirModalCriarEmpresa() {
    document.getElementById('form-criar-empresa').reset();
    ajustarLimitePadraoPlano();
    document.getElementById('modal-criar-empresa').classList.add('active');
}

function fecharModalCriarEmpresa() {
    document.getElementById('modal-criar-empresa').classList.remove('active');
}

function ajustarLimitePadraoPlano() {
    const plano = document.getElementById('empresa-plano').value;
    const inputLimite = document.getElementById('empresa-limite');
    if (plano === 'trial') inputLimite.value = 50;
    else if (plano === 'starter') inputLimite.value = 300;
    else if (plano === 'pro') inputLimite.value = 1500;
    else if (plano === 'enterprise') inputLimite.value = 10000;
}

async function salvarNovaEmpresa(e) {
    e.preventDefault();
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
        if (!res.ok) throw new Error(data.error || "Erro ao cadastrar empresa.");

        showToast("Empresa cadastrada com sucesso!", 'success');
        fecharModalCriarEmpresa();
        await carregarEmpresas();
        await carregarMetricas();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function abrirModalCriarUsuario() {
    document.getElementById('form-criar-usuario').reset();
    document.getElementById('modal-criar-usuario').classList.add('active');
}

function fecharModalCriarUsuario() {
    document.getElementById('modal-criar-usuario').classList.remove('active');
}

async function salvarNovoUsuario(e) {
    e.preventDefault();
    const name = document.getElementById('user-nome').value;
    const email = document.getElementById('user-email').value;
    const password = document.getElementById('user-senha').value;
    const tenant_id = document.getElementById('user-tenant').value;
    const role = document.getElementById('user-role').value;

    try {
        const res = await fetch('/api/admin/users/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password, tenant_id, role })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Erro ao criar usuário.");

        showToast("Usuário cadastrado com sucesso!", 'success');
        fecharModalCriarUsuario();
        await carregarUsuarios();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function abrirModalResetSenha(userId, email) {
    document.getElementById('reset-user-id').value = userId;
    document.getElementById('reset-user-email-display').textContent = email;
    document.getElementById('reset-nova-senha').value = '';
    document.getElementById('modal-reset-senha').classList.add('active');
}

function fecharModalResetSenha() {
    document.getElementById('modal-reset-senha').classList.remove('active');
}

async function salvarResetSenha(e) {
    e.preventDefault();
    const userId = document.getElementById('reset-user-id').value;
    const newPassword = document.getElementById('reset-nova-senha').value;

    try {
        const res = await fetch('/api/admin/users/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, newPassword })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Erro ao redefinir senha.");

        showToast("Nova senha cadastrada com sucesso!", 'success');
        fecharModalResetSenha();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function trocarAbaAdmin(aba) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

    const btn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick')?.includes(aba));
    if (btn) btn.classList.add('active');

    const pane = document.getElementById(`tab-${aba}`);
    if (pane) pane.classList.add('active');
}

async function logoutAdmin() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
        // Fallback
    }
    localStorage.removeItem('sb_access_token');
    document.cookie = 'sb_access_token=; Max-Age=0; path=/;';
    window.location.href = '/login.html';
}
