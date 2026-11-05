// public/js/onboarding.js
// Assistente de Onboarding (Primeiro Acesso) e Monitoramento de Consumo de Franquia SaaS

(function() {
    let currentTenant = null;

    async function carregarBillingStatus() {
        try {
            const res = await fetch('/api/billing/status');
            if (!res.ok) return;
            const data = await res.json();

            const planBadge = document.getElementById('saas-plan-badge');
            const planUsage = document.getElementById('saas-plan-usage');
            const progressBar = document.getElementById('saas-plan-progress-bar');

            if (planBadge) {
                const planName = data.planDetails?.name || (data.plan ? data.plan.toUpperCase() : 'TRIAL');
                planBadge.textContent = `Plano ${planName}`;
            }

            if (planUsage && data.usage) {
                const { guidesUsed, guidesLimit, percentage } = data.usage;
                planUsage.textContent = `${guidesUsed} de ${guidesLimit} guias (${percentage}%)`;

                if (progressBar) {
                    progressBar.style.width = `${Math.min(100, percentage)}%`;
                    if (percentage >= 90) {
                        progressBar.style.background = '#EF4444'; // Vermelho (alerta)
                    } else if (percentage >= 75) {
                        progressBar.style.background = '#F59E0B'; // Âmbar (atenção)
                    } else {
                        progressBar.style.background = '#10B981'; // Verde (saudável)
                    }
                }
            }
        } catch (e) {
            console.warn('[Billing Widget] Erro ao carregar status:', e.message);
        }
    }

    function verificarOnboarding(tenant) {
        currentTenant = tenant;
        const banner = document.getElementById('onboarding-wizard-banner');
        if (!banner || !tenant) return;

        // Se o lojista já dispensou o onboarding nesta sessão ou já completou tudo
        const dismissed = localStorage.getItem('expedi_onboarding_dismissed_' + tenant.id);
        const hasPfx = !!tenant.has_pfx;
        const hasErp = !!(tenant.has_microvix || tenant.has_vnda);

        // Se já possui certificado e ERP, o setup essencial está concluído
        if (hasPfx && hasErp) {
            banner.style.display = 'none';
            return;
        }

        if (dismissed === 'true') {
            banner.style.display = 'none';
            return;
        }

        // Atualiza os indicadores de cada etapa no banner
        const stepCnpj = document.getElementById('step-cnpj-check');
        const stepPfx = document.getElementById('step-pfx-check');
        const stepErp = document.getElementById('step-erp-check');

        if (stepCnpj) {
            stepCnpj.innerHTML = tenant.cnpj ? '✔' : '○';
            stepCnpj.style.color = tenant.cnpj ? '#10B981' : '#94A3B8';
        }

        if (stepPfx) {
            stepPfx.innerHTML = hasPfx ? '✔' : '○';
            stepPfx.style.color = hasPfx ? '#10B981' : '#F59E0B';
        }

        if (stepErp) {
            stepErp.innerHTML = hasErp ? '✔' : '○';
            stepErp.style.color = hasErp ? '#10B981' : '#F59E0B';
        }

        banner.style.display = 'block';
    }

    window.dispensarOnboarding = function() {
        const banner = document.getElementById('onboarding-wizard-banner');
        if (banner) banner.style.display = 'none';
        if (currentTenant) {
            localStorage.setItem('expedi_onboarding_dismissed_' + currentTenant.id, 'true');
        }
    };

    window.abrirWizardModal = function(step = 1) {
        window.location.href = '/profile.html?step=' + step;
    };

    window.iniciarOnboardingDashboard = function(tenant) {
        carregarBillingStatus();
        verificarOnboarding(tenant);
    };

    document.addEventListener('DOMContentLoaded', () => {
        carregarBillingStatus();
    });
})();
