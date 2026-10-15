// public/js/profile.js
// Lógica da Página de Configuração de Empresa e Certificado

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Verifica login e carrega dados atuais
    await carregarDados();

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

    // 8. Lógica do Formulário Olist Vnda (Boah)
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
        
        // Preenche campos cadastrais/bancários
        document.getElementById('cnpj').value = (tenant && tenant.cnpj) || '';
        document.getElementById('razao_social').value = (tenant && tenant.razao_social) || '';
        document.getElementById('bank_agency').value = (tenant && tenant.bank_agency) || '';
        document.getElementById('bank_account').value = (tenant && tenant.bank_account) || '';
        document.getElementById('bank_dac').value = (tenant && tenant.bank_dac) || '';
        document.getElementById('environment').value = (tenant && tenant.environment) || 'simulado';

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
                        ? `<span style="color: var(--success); font-weight: 600;">✔ Conectado (www.boah.com.br)</span>`
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

        if (data.profile && data.profile.is_admin) {
            const adminLink = document.getElementById('admin-nav-link');
            if (adminLink) adminLink.classList.remove('d-none');
        }
    } catch (e) {
        showToast("Erro ao carregar dados do assinante: " + e.message, 'error');
    }
}
