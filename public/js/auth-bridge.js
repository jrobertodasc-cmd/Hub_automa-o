// public/js/auth-bridge.js
// Ponte de autenticação para as telas públicas do expedi HUB conectando ao backend SaaS

(function () {
    const validPlans = ['trial', 'starter', 'pro', 'advanced'];

    function getSelectedPlan() {
        try {
            const params = new URLSearchParams(window.location.search);
            const p = (params.get('plan') || '').toLowerCase();
            return validPlans.includes(p) ? p : 'trial';
        } catch (e) {
            return 'trial';
        }
    }

    window.expediAuth = {
        /**
         * Realiza login no backend
         * @param {string} email
         * @param {string} password
         * @param {boolean} remember - Não existe no backend (ignorado de forma segura)
         */
        async login(email, password, remember) {
            // Nota: o campo 'remember' não existe no backend (/api/auth/login utiliza sessão com cookie de 7 dias)
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'E-mail ou senha incorretos.');
            }

            if (data.token) {
                localStorage.setItem('sb_access_token', data.token);
            }

            const msgEl = document.getElementById('msg');
            if (msgEl) {
                msgEl.textContent = 'Login realizado com sucesso! Redirecionando...';
                msgEl.className = 'show';
                msgEl.style.background = 'var(--ok-bg, #EAF7F0)';
                msgEl.style.color = 'var(--ok, #157347)';
            }

            const urlParams = new URLSearchParams(window.location.search);
            const redirectTarget = urlParams.get('redirect') || '/dashboard.html';

            setTimeout(() => {
                window.location.href = redirectTarget;
            }, 800);

            return data;
        },

        /**
         * Realiza cadastro no backend
         * Mapeamento:
         * nome -> name
         * email -> email
         * password -> password
         * cnpj -> cnpj (o backend higieniza para dígitos)
         * empresa -> razao_social
         * plan -> query param ?plan= (trial, starter, pro, advanced)
         * @param {Object} dados
         */
        async register(dados) {
            const plan = getSelectedPlan();
            const payload = {
                name: dados.name || dados.nome || '',
                email: dados.email || '',
                password: dados.password || '',
                cnpj: dados.cnpj || '',
                razao_social: dados.razao_social || dados.empresa || '',
                plan: plan
            };

            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Falha no cadastramento.');
            }

            const msgEl = document.getElementById('msg');
            if (msgEl) {
                msgEl.textContent = 'Cadastro realizado com sucesso! Redirecionando...';
                msgEl.className = 'show';
                msgEl.style.background = 'var(--ok-bg, #EAF7F0)';
                msgEl.style.color = 'var(--ok, #157347)';
            }

            setTimeout(() => {
                window.location.href = '/login.html';
            }, 1200);

            return data;
        }
    };
})();
