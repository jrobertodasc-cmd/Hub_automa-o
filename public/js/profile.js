// public/js/profile.js
// Lógica da Página de Configuração de Empresa e Certificado

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Verifica login e carrega dados atuais
    await carregarDados();
    await carregarConfigComercial();
    inicializarEventosComercial();

    // 2. Lógica do Formulário de Configurações Cadastrais
    const settingsForm = document.getElementById('settings-form');
    if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const cnpj = document.getElementById('cnpj').value;
            const razao_social = document.getElementById('razao_social').value;
            const bank_agency = document.getElementById('bank_agency').value;
            const bank_account = document.getElementById('bank_account').value;
            const bank_dac = document.getElementById('bank_dac').value;
            const environment = document.getElementById('environment').value;

            try {
                const res = await fetch('/api/tenant/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cnpj, razao_social, bank_agency, bank_account, bank_dac, environment })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Configurações salvas com sucesso!");
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 3. Lógica do Upload de Certificado PFX
    const pfxForm = document.getElementById('pfx-form');
    if (pfxForm) {
        pfxForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const fileInput = document.getElementById('pfx-file');
            const passphrase = document.getElementById('passphrase').value;

            if (!fileInput.files[0] || !passphrase) {
                showToast("Selecione o arquivo .pfx e digite a senha.", 'error');
                return;
            }

            const formData = new FormData();
            formData.append('pfx', fileInput.files[0]);
            formData.append('passphrase', passphrase);

            try {
                showToast("Fazendo upload do certificado...", 'warning');
                const res = await fetch('/api/tenant/upload-pfx', {
                    method: 'POST',
                    body: formData
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Certificado digital salvo com sucesso!");
                document.getElementById('passphrase').value = '';
                fileInput.value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 4. Lógica do Formulário de Integração Linx Microvix
    const microvixForm = document.getElementById('microvix-form');
    if (microvixForm) {
        microvixForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const microvix_key = document.getElementById('microvix_key').value.trim();
            const microvix_cnpj = document.getElementById('microvix_cnpj').value.trim();
            const microvix_user = document.getElementById('microvix_user').value.trim();
            const microvix_password = document.getElementById('microvix_password').value;

            try {
                showToast("Salvando credenciais Linx Microvix...", 'warning');
                const res = await fetch('/api/microvix/credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        microvix_key,
                        microvix_cnpj,
                        microvix_user,
                        microvix_password
                    })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Credenciais Linx Microvix salvas com sucesso!");
                document.getElementById('microvix_password').value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 5. Lógica do Formulário Bling ERP
    const blingForm = document.getElementById('bling-form');
    if (blingForm) {
        blingForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const bling_token = document.getElementById('bling_token').value.trim();
            try {
                showToast("Salvando credenciais do Bling...", 'warning');
                const res = await fetch('/api/erp/credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ erp: 'bling', bling_token })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                showToast("Credenciais do Bling salvas com sucesso!");
                document.getElementById('bling_token').value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 6. Lógica do Formulário Tiny ERP
    const tinyForm = document.getElementById('tiny-form');
    if (tinyForm) {
        tinyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const tiny_token = document.getElementById('tiny_token').value.trim();
            try {
                showToast("Salvando credenciais do Tiny ERP...", 'warning');
                const res = await fetch('/api/erp/credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ erp: 'tiny', tiny_token })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                showToast("Credenciais do Tiny ERP salvas com sucesso!");
                document.getElementById('tiny_token').value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 7. Lógica do Formulário Omie ERP
    const omieForm = document.getElementById('omie-form');
    if (omieForm) {
        omieForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const omie_app_key = document.getElementById('omie_app_key').value.trim();
            const omie_app_secret = document.getElementById('omie_app_secret').value.trim();
            try {
                showToast("Salvando credenciais da Omie...", 'warning');
                const res = await fetch('/api/erp/credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ erp: 'omie', omie_app_key, omie_app_secret })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                showToast("Credenciais da Omie salvas com sucesso!");
                document.getElementById('omie_app_secret').value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 8. Lógica do Formulário Olist Vnda
    const vndaForm = document.getElementById('vnda-form');
    if (vndaForm) {
        vndaForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const token = document.getElementById('vnda_token').value.trim();
            const shop_host = document.getElementById('vnda_shop_host').value.trim();
            try {
                showToast("Conectando à Olist Vnda...", 'warning');
                const res = await fetch('/api/vnda/credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, shop_host })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                showToast("Conexão com a Olist Vnda estabelecida com sucesso!");
                document.getElementById('vnda_token').value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 9. Lógica do Formulário Conta Digital Asaas
    const asaasForm = document.getElementById('asaas-form');
    if (asaasForm) {
        asaasForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const asaas_api_key = document.getElementById('asaas_api_key').value.trim();
            const asaas_environment = document.getElementById('asaas_environment').value;

            try {
                showToast("Salvando configurações do Asaas...", 'warning');
                const res = await fetch('/api/tenant/asaas-credentials', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asaas_api_key, asaas_environment })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Configurações do Asaas salvas com sucesso!");
                document.getElementById('asaas_api_key').value = '';
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    // 10. Lógica do Formulário de Notificações da Diretoria
    const notificationForm = document.getElementById('notification-form');
    if (notificationForm) {
        notificationForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const notification_phone = document.getElementById('notification_phone').value.trim();
            const notification_email = document.getElementById('notification_email').value.trim();

            try {
                showToast("Salvando preferências de notificação...", 'warning');
                const res = await fetch('/api/tenant/notifications', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ notification_phone, notification_email })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast("Preferências de notificação salvas com sucesso!");
                await carregarDados();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }
});

async function carregarDados() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            // Se o token falhar ou expirar, manda pro login
            localStorage.removeItem('sb_access_token');
            window.location.href = '/login.html';
            return;
        }

        const data = await res.json();
        const tenant = Array.isArray(data.tenant) ? data.tenant[0] : data.tenant;

        if (tenant) {
            const subtitleEl = document.getElementById('profile-subtitle');
            if (subtitleEl) {
                subtitleEl.textContent = `${tenant.nome_fantasia || tenant.razao_social || 'Empresa'} · Configurações`;
            }
            const badgeAmb = document.getElementById('badge-ambiente');
            if (badgeAmb) {
                badgeAmb.textContent = tenant.environment === 'producao' ? 'Produção Real' : 'Homologação';
            }
        }
        
        // Preenche campos cadastrais/bancários
        document.getElementById('cnpj').value = (tenant && tenant.cnpj) || '';
        document.getElementById('razao_social').value = (tenant && tenant.razao_social) || '';
        document.getElementById('bank_agency').value = (tenant && tenant.bank_agency) || '';
        document.getElementById('bank_account').value = (tenant && tenant.bank_account) || '';
        document.getElementById('bank_dac').value = (tenant && tenant.bank_dac) || '';
        document.getElementById('environment').value = (tenant && tenant.environment) || 'simulado';

        // Preenche campos de notificação da diretoria
        const phoneInput = document.getElementById('notification_phone');
        if (phoneInput) phoneInput.value = (tenant && tenant.notification_phone) || '';
        const emailInput = document.getElementById('notification_email');
        if (emailInput) emailInput.value = (tenant && tenant.notification_email) || '';
        const notifStatus = document.getElementById('notification-status');
        if (notifStatus) {
            if (tenant && (tenant.notification_phone || tenant.notification_email)) {
                notifStatus.innerHTML = `<span style="color: var(--success); font-weight: 600;">✔ Notificações Ativas</span>`;
            } else {
                notifStatus.innerHTML = `<span style="color: var(--text-secondary);">Configuração opcional</span>`;
            }
        }

        // Preenche status do certificado digital PFX
        const pfxStatus = document.getElementById('pfx-status');
        if (pfxStatus) {
            if (tenant && tenant.pfx_filename) {
                pfxStatus.innerHTML = `<span style="color: var(--success);">✔ Certificado Ativo:</span> <strong>${tenant.pfx_filename}</strong>`;
            } else {
                pfxStatus.innerHTML = `<span style="color: var(--danger);">⚠ Nenhum certificado digital PFX cadastrado.</span>`;
            }
        }

        // Preenche campos da Linx Microvix
        const keyEl = document.getElementById('microvix_key');
        const cnpjEl = document.getElementById('microvix_cnpj');
        const userEl = document.getElementById('microvix_user');
        const statusEl = document.getElementById('microvix-status');

        if (keyEl && tenant) keyEl.value = tenant.microvix_key || '';
        if (cnpjEl && tenant) cnpjEl.value = tenant.microvix_cnpj || tenant.cnpj || '';
        if (userEl && tenant) userEl.value = tenant.microvix_user || 'linx_b2c';

        if (statusEl) {
            if (tenant && tenant.microvix_key && tenant.microvix_cnpj) {
                statusEl.innerHTML = `<span style="color: var(--success); font-weight: 600;">✔ Integração Configurada</span>`;
            } else {
                statusEl.innerHTML = `<span style="color: var(--warning);">⚠ Integração não configurada</span>`;
            }
        }

        // Carrega status dos novos ERPs
        try {
            const erpRes = await fetch('/api/erp/status');
            if (erpRes.ok) {
                const erpStatus = await erpRes.json();
                const bStatus = document.getElementById('bling-status');
                const tStatus = document.getElementById('tiny-status');
                const oStatus = document.getElementById('omie-status');

                if (bStatus) {
                    bStatus.innerHTML = erpStatus.bling
                        ? `<span style="color: var(--success); font-weight: 600;">✔ Conectado</span>`
                        : `<span style="color: var(--warning);">⚠ Não configurado</span>`;
                }
                if (tStatus) {
                    tStatus.innerHTML = erpStatus.tiny
                        ? `<span style="color: var(--success); font-weight: 600;">✔ Conectado</span>`
                        : `<span style="color: var(--warning);">⚠ Não configurado</span>`;
                }
                if (oStatus) {
                    oStatus.innerHTML = erpStatus.omie
                        ? `<span style="color: var(--success); font-weight: 600;">✔ Conectado</span>`
                        : `<span style="color: var(--warning);">⚠ Não configurado</span>`;
                }
                const vStatus = document.getElementById('vnda-status');
                if (vStatus) {
                    vStatus.innerHTML = erpStatus.vnda
                        ? `<span style="color: var(--success); font-weight: 600;">✔ Conectado (${tenant?.vnda_shop_host || 'Ativo'})</span>`
                        : `<span style="color: var(--warning);">⚠ Não configurado</span>`;
                }
                if (tenant && tenant.omie_app_key) {
                    const omieKeyInput = document.getElementById('omie_app_key');
                    if (omieKeyInput) omieKeyInput.value = tenant.omie_app_key;
                }
                if (tenant && tenant.vnda_shop_host) {
                    const hostInput = document.getElementById('vnda_shop_host');
                    if (hostInput) hostInput.value = tenant.vnda_shop_host;
                }
            }
        } catch (erpErr) {
            console.warn("Erro ao buscar status ERPs:", erpErr.message);
        }

        // Preenche campos e saldo Asaas
        const webhookUrlEl = document.getElementById('asaas-webhook-url');
        if (webhookUrlEl) {
            webhookUrlEl.innerText = window.location.origin + '/api/webhooks/asaas';
        }

        const asaasEnvSelect = document.getElementById('asaas_environment');
        if (asaasEnvSelect && tenant && tenant.asaas_environment) {
            asaasEnvSelect.value = tenant.asaas_environment;
        }

        const asaasBadge = document.getElementById('asaas-balance-badge');
        const asaasStatus = document.getElementById('asaas-status');
        try {
            const balanceRes = await fetch('/api/asaas/balance');
            if (balanceRes.ok) {
                const bal = await balanceRes.json();
                if (asaasBadge) {
                    const prefix = bal.simulado ? 'Saldo Simulado: ' : 'Saldo em Conta: ';
                    asaasBadge.innerText = prefix + 'R$ ' + parseFloat(bal.balance || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    asaasBadge.style.background = bal.simulado ? 'rgba(59, 130, 246, 0.15)' : 'rgba(16, 185, 129, 0.15)';
                    asaasBadge.style.color = bal.simulado ? '#3b82f6' : '#10b981';
                }
                if (asaasStatus) {
                    asaasStatus.innerHTML = bal.hasKey 
                        ? `<span style="color: var(--success); font-weight: 600;">✔ Chave Ativa (${bal.environment.toUpperCase()})</span>`
                        : `<span style="color: var(--warning);">⚠ Chave não cadastrada (Modo Simulado Ativo)</span>`;
                }
            }
        } catch (bErr) {
            if (asaasBadge) asaasBadge.innerText = 'Saldo Indisponível';
        }

        if (data.profile && data.profile.is_admin) {
            const adminLink = document.getElementById('admin-nav-link');
            if (adminLink) adminLink.classList.remove('d-none');
        }
    } catch (e) {
        showToast("Erro ao carregar dados do assinante: " + e.message, 'error');
    }
}


// ==========================================
// MÓDULO: CONFIGURAÇÕES COMERCIAIS & SOCIAL SELLING
// ==========================================
function renderAliasRow(alias = {}) {
    const container = document.getElementById('aliases-container');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'alias-item-row';
    row.style = 'display: grid; grid-template-columns: 2fr 2fr 1fr 1fr auto; gap: 8px; align-items: center; background: #f8fafc; padding: 8px 12px; border: 1px solid var(--border-line); border-radius: 6px;';
    
    const termosVal = (alias.termos || []).join(', ');
    const nomeVal = alias.nome || '';
    const codVal = alias.codigoLinx || '';
    const ocultarVal = alias.ocultarNoRanking ? 'checked' : '';

    row.innerHTML = `
        <div>
            <input type="text" class="form-input alias-nome" placeholder="Nome Vendedora" value="${nomeVal}" style="padding: 6px 10px; font-size: 12px;" required>
        </div>
        <div>
            <input type="text" class="form-input alias-termos" placeholder="Termos/Cupons (ex: MILA, MILA15)" value="${termosVal}" style="padding: 6px 10px; font-size: 12px;" required>
        </div>
        <div>
            <input type="text" class="form-input alias-cod" placeholder="Cód Linx" value="${codVal}" style="padding: 6px 10px; font-size: 12px;">
        </div>
        <div style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary);">
            <input type="checkbox" class="alias-ocultar" ${ocultarVal}>
            <label>Ocultar Ranking</label>
        </div>
        <div>
            <button type="button" class="btn-action secondary" onclick="this.closest('.alias-item-row').remove()" style="padding: 4px 8px; font-size: 12px; color: #ef4444; border-color: #fca5a5;">✕</button>
        </div>
    `;
    container.appendChild(row);
}

function renderTipoCupomRow(tipo = {}) {
    const container = document.getElementById('tipos-cupom-container');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'tipo-cupom-row';
    row.style = 'display: grid; grid-template-columns: 2fr 2fr 1fr auto; gap: 8px; align-items: center; background: #f8fafc; padding: 8px 12px; border: 1px solid var(--border-line); border-radius: 6px;';

    const termosVal = (tipo.termos || []).join(', ');
    const tipoVal = tipo.tipo || '';
    const badgeVal = tipo.badge || '';

    row.innerHTML = `
        <div>
            <input type="text" class="form-input tipo-termos" placeholder="Termos gatilho (ex: BEMVINDA, NOVO)" value="${termosVal}" style="padding: 6px 10px; font-size: 12px;" required>
        </div>
        <div>
            <input type="text" class="form-input tipo-nome" placeholder="Nome Categoria (ex: 1ª Compra)" value="${tipoVal}" style="padding: 6px 10px; font-size: 12px;" required>
        </div>
        <div>
            <input type="text" class="form-input tipo-badge" placeholder="Badge" value="${badgeVal}" style="padding: 6px 10px; font-size: 12px;">
        </div>
        <div>
            <button type="button" class="btn-action secondary" onclick="this.closest('.tipo-cupom-row').remove()" style="padding: 4px 8px; font-size: 12px; color: #ef4444; border-color: #fca5a5;">✕</button>
        </div>
    `;
    container.appendChild(row);
}

async function carregarConfigComercial() {
    try {
        const res = await fetch('/api/tenant/comercial-config');
        if (!res.ok) return;
        const data = await res.json();
        const cfg = data.config || {};
        
        const badgeEl = document.getElementById('comercial-status-badge');
        if (badgeEl) {
            badgeEl.innerText = data.personalizada ? 'Personalizada' : 'Padrão Ativo';
            badgeEl.className = data.personalizada ? 'badge success' : 'badge info';
        }

        const cuponsEl = document.getElementById('comercial_cupons_inst');
        if (cuponsEl) {
            cuponsEl.value = (cfg.cuponsInstitucionais || []).join(', ');
        }

        const vendaOnlineEl = document.getElementById('comercial_venda_online');
        if (vendaOnlineEl) {
            vendaOnlineEl.value = cfg.codigoVendaOnline || '';
        }

        const aliasContainer = document.getElementById('aliases-container');
        if (aliasContainer) {
            aliasContainer.innerHTML = '';
            (cfg.aliasesVendedora || []).forEach(a => renderAliasRow(a));
        }

        const tiposContainer = document.getElementById('tipos-cupom-container');
        if (tiposContainer) {
            tiposContainer.innerHTML = '';
            (cfg.tiposCupom || []).forEach(t => renderTipoCupomRow(t));
        }
    } catch (e) {
        console.warn('Aviso ao carregar config comercial:', e);
    }
}

function inicializarEventosComercial() {
    const btnAddAlias = document.getElementById('btn-add-alias');
    if (btnAddAlias) {
        btnAddAlias.addEventListener('click', () => renderAliasRow());
    }

    const btnAddTipo = document.getElementById('btn-add-tipo-cupom');
    if (btnAddTipo) {
        btnAddTipo.addEventListener('click', () => renderTipoCupomRow());
    }

    const form = document.getElementById('comercial-config-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const cuponsRaw = (document.getElementById('comercial_cupons_inst')?.value || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            const codigoVendaOnline = document.getElementById('comercial_venda_online')?.value?.trim() || null;

            const aliasesVendedora = [];
            document.querySelectorAll('.alias-item-row').forEach(row => {
                const nome = row.querySelector('.alias-nome')?.value?.trim();
                const termos = (row.querySelector('.alias-termos')?.value || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                const codigoLinx = row.querySelector('.alias-cod')?.value?.trim() || null;
                const ocultarNoRanking = !!row.querySelector('.alias-ocultar')?.checked;
                if (nome && termos.length > 0) {
                    aliasesVendedora.push({ nome, termos, codigoLinx, ocultarNoRanking });
                }
            });

            const tiposCupom = [];
            document.querySelectorAll('.tipo-cupom-row').forEach(row => {
                const tipo = row.querySelector('.tipo-nome')?.value?.trim();
                const termos = (row.querySelector('.tipo-termos')?.value || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                const badge = row.querySelector('.tipo-badge')?.value?.trim() || 'Campanha';
                if (tipo && termos.length > 0) {
                    tiposCupom.push({ tipo, termos, badge });
                }
            });

            try {
                showToast("Salvando configurações comerciais...", "warning");
                const res = await fetch('/api/tenant/comercial-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cuponsInstitucionais: cuponsRaw,
                        codigoVendaOnline,
                        aliasesVendedora,
                        tiposCupom
                    })
                });
                const resp = await res.json();
                if (!res.ok) throw new Error(resp.error || "Erro ao salvar.");
                showToast("Configurações comerciais salvas com sucesso!");
                await carregarConfigComercial();
            } catch (err) {
                showToast(err.message, "error");
            }
        });
    }
}
