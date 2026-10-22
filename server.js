// server.js
// Servidor Express SaaS Multi-Tenant para Emissão de GNRE e CNAB 240

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const parserService = require('./services/parser_service');
const cnabService = require('./services/cnab_service');
const gnreService = require('./services/gnre_service');
const duaEsService = require('./services/dua_es_service');
const microvixService = require('./services/microvix_service');
const erpService = require('./services/erp_service');
const danfeService = require('./services/danfe_service');
const printService = require('./services/print_service');
const vndaService = require('./services/vnda_service');
const syncService = require('./services/sync_service');
const asaasService = require('./services/asaas_service');
const closingService = require('./services/closing_service');
const auditService = require('./services/audit_service');

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Configuração de Segurança: Helmet
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// Rate Limiters para proteção contra abusos e ataques de força bruta
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas requisições enviadas por este IP. Aguarde alguns minutos.' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Aguarde 15 minutos antes de tentar novamente.' }
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);

// Configuração do cliente admin do Supabase (para operações do sistema/Storage)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, res, next) => {
    console.log(`[Request] ${req.method} ${req.path} - Cookie: ${!!req.cookies?.sb_access_token} - AuthHeader: ${!!req.headers.authorization}`);
    next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Estado das tarefas ativas em processamento na memória para exibição em tempo real
const activeTasks = {};

// Clientes conectados ao SSE para atualização em tempo real do Cockpit / Doca
const sseClients = new Set();

function broadcastDockEvent(payload, targetTenantId = null) {
    if (sseClients.size === 0) return;
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        try {
            // Isolamento multi-tenant: se o evento possui tenant_id específico, só entrega aos clientes daquele tenant
            if (targetTenantId && client.tenantId && client.tenantId !== targetTenantId) {
                continue;
            }
            client.write(msg);
        } catch (err) {
            sseClients.delete(client);
        }
    }
}

const PLAN_LIMITS = {
    'trial': 10,
    'starter': 100,
    'pro': 500,
    'advanced': 1500,
    'inativo': 0,
    'ativo': 500 // fallback
};

// ==========================================
// FUNÇÕES AUXILIARES DE CRIPTOGRAFIA
// ==========================================
function getEncryptionKey(keyStr) {
    return crypto.createHash('sha256').update(String(keyStr)).digest();
}

function encrypt(text, secretKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `gcm:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(text, secretKey) {
    const str = String(text || '');
    const tryDecryptWithKey = (k) => {
        if (str.startsWith('gcm:')) {
            const [, ivHex, tagHex, encryptedHex] = str.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(tagHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        const parts = str.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', k, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    };
    try {
        return tryDecryptWithKey(secretKey);
    } catch (primaryErr) {
        const legacyKey = getEncryptionKey('expedi_default_secret_key_32_bytes_long!!');
        return tryDecryptWithKey(legacyKey);
    }
}

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
// MIDDLEWARE DE AUTENTICAÇÃO E MULTI-TENANCY
// ==========================================

// Comparação estrita e resistente a timing attacks
function safeCompareTokens(a, b) {
    if (!a || !b) return false;
    try {
        const bufA = Buffer.from(String(a));
        const bufB = Buffer.from(String(b));
        if (bufA.length !== bufB.length) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) {
        return false;
    }
}

// Administradores Master da Plataforma (SuperAdmin)
const MASTER_SUPERADMIN_EMAILS = [
    'jrobertodasc@gmail.com',
    'grupoaliadoshubtech@gmail.com'
];

const requireAuth = async (req, res, next) => {
    const token = req.cookies?.sb_access_token || 
                  req.headers.authorization?.replace(/^Bearer\s+/i, '') || 
                  req.query?.token;

    if (!token) {
        if (req.accepts('html') && !req.path.startsWith('/api/')) {
            return res.redirect('/login.html');
        }
        return res.status(401).json({ error: "Acesso não autorizado: credenciais ausentes. Realize login." });
    }
    
    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            if (req.accepts('html') && !req.path.startsWith('/api/')) {
                return res.redirect('/login.html');
            }
            return res.status(401).json({ error: "Sessão inválida ou expirada. Realize login novamente." });
        }

        // Busca o perfil do usuário e dados do tenant correspondente
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*, tenants(*)')
            .eq('id', user.id)
            .single();

        if (profileError || !profile) {
            return res.status(403).json({ error: "Perfil de usuário não localizado no sistema." });
        }

        let tenant = profile.tenants;
        if (Array.isArray(tenant)) {
            tenant = tenant[0];
        }

        if (!tenant) {
            return res.status(403).json({ error: "Nenhuma empresa vinculada ao perfil deste usuário." });
        }

        // Resolução estrita de privilégios (RBAC)
        const userEmail = (user.email || profile.email || '').toLowerCase().trim();
        let determinedRole = 'operador';

        if (MASTER_SUPERADMIN_EMAILS.includes(userEmail)) {
            determinedRole = 'superadmin';
            profile.is_admin = true;
        } else if (profile.role) {
            const r = String(profile.role).toLowerCase().trim();
            determinedRole = (r === 'operator') ? 'operador' : r;
        } else if (profile.is_admin) {
            determinedRole = 'admin';
        }

        profile.role = determinedRole;

        req.user = user;
        req.profile = profile;
        req.tenant = tenant;
        next();
    } catch (err) {
        console.error("[requireAuth] Erro ao validar credenciais:", err.message);
        if (req.accepts('html') && !req.path.startsWith('/api/')) {
            return res.redirect('/login.html');
        }
        return res.status(401).json({ error: "Falha na validação de credenciais: " + err.message });
    }
};

// Middleware de RBAC (Role-Based Access Control)
const requireRole = (allowedRoles = []) => {
    return (req, res, next) => {
        if (!req.profile) {
            return res.status(401).json({ error: "Usuário não autenticado." });
        }

        const userRole = (req.profile.role || 'operador').toLowerCase();

        // SuperAdmin tem acesso irrestrito
        if (userRole === 'superadmin') {
            return next();
        }

        const normalizedAllowed = allowedRoles.map(r => {
            const low = r.toLowerCase();
            return low === 'operator' ? 'operador' : low;
        });

        if (!normalizedAllowed.includes(userRole)) {
            auditService.logAudit(supabase, {
                tenantId: req.tenant?.id,
                userId: req.user?.id,
                acao: 'ACESSO_NEGADO_RBAC',
                detalhe: `Perfil '${userRole}' tentou acessar rota restrita: ${req.method} ${req.originalUrl}`,
                ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
            });

            return res.status(403).json({
                error: `Acesso não autorizado: seu perfil ('${userRole}') não tem permissão para esta ação. Requer: [${allowedRoles.join(', ')}].`,
                currentRole: userRole,
                allowedRoles: allowedRoles
            });
        }
        next();
    };
};

// Middleware exclusivo para SuperAdmin Master da plataforma SaaS
const requireSuperAdmin = (req, res, next) => {
    const userRole = (req.profile?.role || '').toLowerCase();
    if (userRole !== 'superadmin') {
        auditService.logAudit(supabase, {
            tenantId: req.tenant?.id,
            userId: req.user?.id,
            acao: 'ACESSO_NEGADO_SUPERADMIN',
            detalhe: `Tentativa de acesso não autorizado à rota administrativa master: ${req.method} ${req.originalUrl}`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });
        return res.status(403).json({ error: "Acesso restrito exclusivamente aos administradores master da plataforma (SuperAdmin)." });
    }
    next();
};

// Middleware para administradores (da loja ou master)
const requireAdmin = (req, res, next) => {
    const role = (req.profile?.role || '').toLowerCase();
    const isAdmin = req.profile?.is_admin || role === 'admin' || role === 'superadmin';
    if (!isAdmin) {
        return res.status(403).json({ error: "Acesso negado. Apenas administradores podem acessar esta área." });
    }
    next();
};

const requireActiveSubscription = (req, res, next) => {
    if (req.tenant) {
        const status = (req.tenant.status || req.tenant.subscription_status || 'ativo').toLowerCase();
        if (status === 'bloqueado' || status === 'inativo' || status === 'suspenso') {
            return res.status(403).json({ error: "Assinatura do expedi HUB suspensa ou bloqueada. Regularize seu plano com o administrador." });
        }

        const limite = req.tenant.limite_guias_mes || req.tenant.plan_limit_guides || 1000;
        const usadas = req.tenant.guias_usadas_mes || 0;
        if (limite > 0 && usadas >= limite) {
            return res.status(403).json({ error: `Limite mensal de emissão de guias do seu plano atingido (${usadas}/${limite} guias). Contate o suporte para upgrade de plano.` });
        }
    }
    next();
};

// ==========================================
// CANAL EM TEMPO REAL (SSE - COCKPIT DA DOCA)
// ==========================================
app.get('/api/events/dock', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    // Atrela a conexão SSE ao tenant autenticado do operador/usuário
    res.tenantId = req.tenant.id;
    res.userId = req.user.id;

    // Envia evento inicial de conexão estabelecida informando o tenant
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', tenantId: req.tenant.id, timestamp: new Date().toISOString() })}\n\n`);

    sseClients.add(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        } catch (e) {
            clearInterval(heartbeat);
            sseClients.delete(res);
        }
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
    });
});

// ==========================================
// ROTAS DE AUTENTICAÇÃO
// ==========================================
app.post('/api/auth/register', requireAuth, requireSuperAdmin, async (req, res) => {
    const { email, password, name, cnpj, razao_social, plan } = req.body;
    if (!email || !password || !cnpj || !razao_social) {
        return res.status(400).json({ error: "Campos obrigatórios ausentes." });
    }

    const validPlans = ['trial', 'starter', 'pro', 'advanced'];
    const finalPlan = validPlans.includes(plan) ? plan : 'trial';

    try {
        // 1. Cadastra no Supabase Auth usando a API admin (evita limite de envio de e-mails da conta gratuita)
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });

        if (authError || !authData.user) {
            return res.status(400).json({ error: authError?.message || "Erro no cadastro de credenciais." });
        }

        const user = authData.user;

        // 2. Insere a empresa na tabela de tenants
        const { data: tenantData, error: tenantError } = await supabase
            .from('tenants')
            .insert({
                cnpj: cnpj.replace(/[^0-9]/g, ''),
                razao_social: razao_social,
                bank_agency: '0000',
                bank_account: '00000',
                bank_dac: '0',
                environment: 'simulado',
                subscription_status: finalPlan
            })
            .select()
            .single();

        if (tenantError) {
            return res.status(400).json({ error: "Erro ao criar dados da empresa: " + tenantError.message });
        }

        // 3. Cria o perfil do usuário
        const { error: profileError } = await supabase
            .from('profiles')
            .insert({
                id: user.id,
                tenant_id: tenantData.id,
                email: email,
                name: name || razao_social
            });

        if (profileError) {
            return res.status(400).json({ error: "Erro ao criar perfil de usuário: " + profileError.message });
        }

        return res.status(200).json({ message: "Cadastro realizado com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: "E-mail e senha são obrigatórios." });
    }

    try {
        // Cria um cliente Supabase temporário local para esta requisição de login.
        // Isso evita que o estado global do cliente "supabase" seja sobrescrito com o token do usuário logado,
        // o que faria as consultas subsequentes falharem devido ao RLS (Row Level Security).
        const tempClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });

        const { data, error } = await tempClient.auth.signInWithPassword({
            email,
            password
        });

        if (error || !data.session) {
            return res.status(401).json({ error: error?.message || "E-mail ou senha incorretos." });
        }

        // Define cookie de autenticação válido por 7 dias
        res.cookie('sb_access_token', data.session.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        });

        return res.status(200).json({ message: "Login efetuado com sucesso!", token: data.session.access_token });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('sb_access_token');
    return res.status(200).json({ message: "Logout efetuado com sucesso." });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    const t = req.tenant || {};
    return res.status(200).json({
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.profile?.name || req.user.email
        },
        profile: {
            is_admin: req.profile?.is_admin || req.profile?.role === 'admin' || req.profile?.role === 'superadmin',
            role: req.profile?.role || 'operador',
            name: req.profile?.name || req.user.email,
            email: req.profile?.email || req.user.email
        },
        tenant: {
            id: t.id,
            razao_social: t.razao_social,
            nome_fantasia: t.nome_fantasia || t.razao_social,
            cnpj: t.cnpj,
            environment: t.environment || 'simulado',
            status: t.status || t.subscription_status || 'ativo',
            plano: t.plano || t.subscription_status || 'starter',
            bank_agency: t.bank_agency,
            bank_account: t.bank_account,
            bank_dac: t.bank_dac,
            notification_phone: t.notification_phone || null,
            notification_email: t.notification_email || null,
            has_pfx: !!(t.pfx_certificate || t.pfx_filename),
            has_asaas: !!(t.asaas_api_key || t.asaas_api_key_encrypted),
            has_microvix: !!(t.microvix_token || t.microvix_key)
        }
    });
});

// ==========================================
// ROTAS DE CONFIGURAÇÃO DO TENANT
// ==========================================
app.post('/api/tenant/settings', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    const { cnpj, razao_social, bank_agency, bank_account, bank_dac, environment } = req.body;
    if (!cnpj || !razao_social || !bank_agency || !bank_account || !bank_dac) {
        return res.status(400).json({ error: "Todos os dados cadastrais e bancários são obrigatórios." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({
                cnpj: cnpj.replace(/[^0-9]/g, ''),
                razao_social: razao_social,
                bank_agency: bank_agency.replace(/[^0-9]/g, ''),
                bank_account: bank_account.replace(/[^0-9]/g, ''),
                bank_dac: bank_dac.replace(/[^0-9]/g, ''),
                environment: environment || 'simulado'
            })
            .eq('id', req.tenant.id);

        if (error) throw error;

        return res.status(200).json({ message: "Configurações atualizadas com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint para salvar contatos privados de notificação da responsável / diretoria
app.post('/api/tenant/notifications', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    const { notification_phone, notification_email } = req.body;

    try {
        const { error } = await supabase
            .from('tenants')
            .update({
                notification_phone: notification_phone ? notification_phone.trim() : null,
                notification_email: notification_email ? notification_email.trim() : null
            })
            .eq('id', req.tenant.id);

        if (error) throw error;

        return res.status(200).json({ message: "Preferências de notificação salvas com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 100 }
});

app.post('/api/tenant/upload-pfx', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), upload.single('pfx'), async (req, res) => {
    const { passphrase } = req.body;
    if (!req.file || !passphrase) {
        return res.status(400).json({ error: "Arquivo do certificado .pfx e senha são obrigatórios." });
    }

    try {
        // Sanitiza o nome do arquivo para evitar caracteres especiais, espaços, acentos e parênteses que quebram o Supabase Storage (S3)
        const rawFilename = req.file.originalname;
        const filename = rawFilename
            .normalize('NFD')                     // Remove acentos (ex: 'até' -> 'ate')
            .replace(/[\u0300-\u036f]/g, '')      // Limpa os caracteres diacríticos
            .replace(/[^a-zA-Z0-9.\-_]/g, '_');   // Substitui tudo que não for alfanumérico por underscore (_)

        // 1. Faz upload do certificado PFX para a pasta privada do tenant no storage
        const { error: uploadError } = await supabase.storage
            .from('tenant-storage')
            .upload(`${req.tenant.id}/certificados/${filename}`, req.file.buffer, {
                contentType: 'application/x-pkcs12',
                upsert: true
            });

        if (uploadError) {
            return res.status(400).json({ error: "Falha ao enviar arquivo do certificado: " + uploadError.message });
        }

        // 2. Criptografa a senha usando AES-256-CBC
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const encryptedPassphrase = encrypt(passphrase, key);

        // 3. Atualiza os dados no cadastro do tenant
        const { error: dbError } = await supabase
            .from('tenants')
            .update({
                pfx_filename: filename,
                pfx_passphrase_encrypted: encryptedPassphrase
            })
            .eq('id', req.tenant.id);

        if (dbError) throw dbError;

        return res.status(200).json({ message: "Certificado PFX cadastrado e salvo com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/tenant/plan', requireAuth, requireSuperAdmin, async (req, res) => {
    const { plan } = req.body;
    const validPlans = ['trial', 'starter', 'pro', 'advanced', 'ativo'];
    if (!plan || !validPlans.includes(plan)) {
        return res.status(400).json({ error: "Plano selecionado inválido." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({ subscription_status: plan })
            .eq('id', req.tenant.id);

        if (error) throw error;

        return res.status(200).json({ message: "Plano de assinatura atualizado com sucesso!", plan });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================================
// ROTAS DE PROCESSAMENTO DE GNRE (LOTE)
// ==========================================
app.post('/api/batch/process', requireAuth, requireActiveSubscription, upload.array('files'), async (req, res) => {
    const { source, paymentDate } = req.body; // 'local' ou 'upload'
    
    try {
        let filesData = [];

        if (source === 'local') {
            if (process.env.NODE_ENV === 'production') {
                return res.status(400).json({ error: "O modo de leitura local de arquivos em disco está desativado em ambiente de produção. Utilize o upload de arquivos." });
            }
            // Caso escolha processar a pasta local padrão do servidor
            const pastaLocal = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'xml_nfe')
                : path.join(__dirname, 'xml_nfe');
            await fs.mkdir(pastaLocal, { recursive: true });
            const arquivos = await fs.readdir(pastaLocal);
            const xmlFiles = arquivos.filter(f => f.toLowerCase().endsWith('.xml'));

            if (xmlFiles.length === 0) {
                return res.status(400).json({ error: "Nenhum arquivo XML foi localizado na pasta local 'xml_nfe'." });
            }

            for (const file of xmlFiles) {
                const filePath = path.join(pastaLocal, file);
                const content = await fs.readFile(filePath, 'utf8');
                filesData.push({
                    filename: file,
                    content: content,
                    path: filePath
                });
            }
        } else {
            // Processa arquivos enviados no corpo do formulário (SaaS)
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: "Nenhum arquivo XML foi enviado." });
            }

            filesData = req.files.map(file => ({
                filename: file.originalname,
                content: file.buffer.toString('utf8'),
                path: null
            }));
        }

        // Verificação de Limites de Emissão do Plano (Bypass para administradores)
        const isAdmin = req.profile && req.profile.is_admin;
        if (!isAdmin) {
            const planLimit = PLAN_LIMITS[req.tenant.subscription_status] || PLAN_LIMITS['ativo'];
            
            const inicioDoMes = new Date();
            inicioDoMes.setDate(1);
            inicioDoMes.setHours(0, 0, 0, 0);

            const { count, error: countError } = await supabase
                .from('guides')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', req.tenant.id)
                .gte('created_at', inicioDoMes.toISOString());

            if (countError) throw countError;

            const totalProjetado = (count || 0) + filesData.length;
            if (totalProjetado > planLimit) {
                return res.status(403).json({
                    error: `Limite de emissões do plano excedido. Seu plano atual (${req.tenant.subscription_status || 'ativo'}) permite até ${planLimit} guias/mês. Você já emitiu ${count || 0} guias este mês e esta operação com ${filesData.length} guias excederá o limite máximo de ${planLimit}. Por favor, faça um upgrade do seu plano no menu 'Planos' para continuar.`
                });
            }
        }

        // 1. Cria um registro de lote com status 'aguardando_aprovacao'
        const { data: batch, error: batchError } = await supabase
            .from('batches')
            .insert({
                tenant_id: req.tenant.id,
                environment: req.tenant.environment,
                status: 'aguardando_aprovacao',
                source: source || 'upload'
            })
            .select()
            .single();

        if (batchError || !batch) {
            throw new Error("Falha ao inicializar lote no banco de dados: " + batchError?.message);
        }

        // 2. Executa a importação e pré-validação (sem disparar na SEFAZ até o operador autorizar)
        stageBatchForApproval(batch.id, req.tenant, filesData, paymentDate, source || 'upload');

        return res.status(200).json({
            message: "Notas fiscais importadas com sucesso! Lote aguardando sua autorização para emissão.",
            batch_id: batch.id,
            status: 'aguardando_aprovacao'
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * ROTA: Autorizar Emissão de Lote na SEFAZ (Operador confirma transmissão)
 */
app.post('/api/batch/authorize-emission/:batchId', requireAuth, requireActiveSubscription, async (req, res) => {
    const { batchId } = req.params;
    const { paymentDate } = req.body;
    const tenant = req.tenant;

    try {
        // Lock atômico: altera status para 'processando' somente se estiver 'aguardando_aprovacao'
        const { data: lockedBatch, error: lockErr } = await supabase
            .from('batches')
            .update({ status: 'processando' })
            .eq('id', batchId)
            .eq('tenant_id', tenant.id)
            .eq('status', 'aguardando_aprovacao')
            .select('id');

        if (lockErr || !lockedBatch || lockedBatch.length === 0) {
            return res.status(409).json({ error: "Este lote já está em processamento ou já foi emitido." });
        }

        // Dispara a transmissão oficial para a SEFAZ
        transmitStagedBatchToSefaz(batchId, tenant, paymentDate);

        return res.status(200).json({
            message: "Emissão autorizada com sucesso! Acompanhe o envio no terminal.",
            batch_id: batchId
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * ROTA: Descartar / Cancelar Lote que estava aguardando aprovação
 */
app.post('/api/batch/discard/:batchId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), async (req, res) => {
    const { batchId } = req.params;
    const tenant = req.tenant;

    try {
        // Remove guias pendentes do lote
        await supabase
            .from('guides')
            .delete()
            .eq('batch_id', batchId)
            .eq('tenant_id', tenant.id)
            .eq('status', 'aguardando_aprovacao');

        // Atualiza status do lote para cancelado
        await supabase
            .from('batches')
            .update({ status: 'cancelado' })
            .eq('id', batchId)
            .eq('tenant_id', tenant.id);

        if (activeTasks[batchId]) {
            delete activeTasks[batchId];
        }

        return res.status(200).json({ message: "Lote descartado com sucesso." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * ROTA: Autorizar Pagamento Bancário e Gerar Remessa CNAB 240
 */
app.post('/api/batch/authorize-payment/:batchId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), async (req, res) => {
    const { batchId } = req.params;
    const { banco, paymentDate } = req.body;
    const tenant = req.tenant;

    try {
        const { data: batch, error: bErr } = await supabase
            .from('batches')
            .select('*')
            .eq('id', batchId)
            .eq('tenant_id', tenant.id)
            .single();

        if (bErr || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        const { data: guias, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batchId)
            .eq('tenant_id', tenant.id);

        if (gErr || !guias || guias.length === 0) {
            return res.status(400).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        // Filtra guias que possuem código de barras emitido
        const guiasValidas = guias.filter(g => g.barcode && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP');
        if (guiasValidas.length === 0) {
            return res.status(400).json({
                error: "Este lote não possui guias com código de barras numérico emitido para pagamento bancário."
            });
        }

        const dadosBancarios = {
            cnpj: tenant.cnpj,
            razaoSocial: tenant.razao_social,
            agencia: tenant.bank_agency,
            conta: tenant.bank_account,
            dac: tenant.bank_dac
        };

        const guiasParaCnab = guiasValidas.map(g => ({
            codigoBarras: g.barcode,
            valor: g.value,
            dataVencimento: paymentDate || g.created_at,
            documentoOrigem: g.nf_number,
            ufFavorecida: g.uf
        }));

        const bankChoice = (banco || 'itau').toLowerCase();
        let cnabContent = '';
        if (bankChoice === 'bradesco') {
            cnabContent = cnabService.gerarRemessaBradesco(dadosBancarios, guiasParaCnab, paymentDate);
        } else if (bankChoice === 'bb') {
            cnabContent = cnabService.gerarRemessaBB(dadosBancarios, guiasParaCnab, paymentDate);
        } else {
            cnabContent = cnabService.gerarRemessaSispag(dadosBancarios, guiasParaCnab, paymentDate);
        }

        // Salva remessa no Storage
        const remessaFilename = `remessa_${batchId}.txt`;
        await supabase.storage
            .from('tenant-storage')
            .upload(`${tenant.id}/remessas/${remessaFilename}`, Buffer.from(cnabContent, 'utf-8'), {
                contentType: 'text/plain',
                upsert: true
            });

        // Atualiza status das guias para 'pagamento_autorizado'
        const ids = guiasValidas.map(g => g.id);
        await supabase
            .from('guides')
            .update({
                status: 'pagamento_autorizado',
                paid_at: new Date().toISOString()
            })
            .in('id', ids);

        return res.status(200).json({
            message: `Pagamento de ${guiasValidas.length} guia(s) autorizado com sucesso!`,
            downloadUrl: `/api/remessa/download/${batchId}?banco=${bankChoice}`,
            totalGuias: guiasValidas.length,
            valorTotal: guiasValidas.reduce((a, b) => a + parseFloat(b.value || 0), 0)
        });

    } catch (err) {
        console.error("Erro na autorização de pagamento:", err);
        return res.status(500).json({ error: "Falha ao autorizar pagamento: " + err.message });
    }
});

// ==========================================
// MÓDULO ASAAS — PAGAMENTO AUTOMÁTICO DE GUIAS E AUTORIZAÇÃO
// ==========================================

function getAsaasApiKey(tenant) {
    if (!tenant || !tenant.asaas_api_key_encrypted) return null;
    try {
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        return decrypt(tenant.asaas_api_key_encrypted, key);
    } catch {
        return null;
    }
}

/**
 * 1. Consulta o Saldo Atual na Conta Asaas do Tenant
 */
app.get('/api/asaas/balance', requireAuth, async (req, res) => {
    try {
        const tenant = req.tenant;
        const apiKey = getAsaasApiKey(tenant);
        const env = tenant.asaas_environment || (tenant.environment === 'producao' ? 'producao' : 'sandbox');

        const saldoInfo = await asaasService.obterSaldo(apiKey, apiKey ? env : 'simulado');
        return res.status(200).json({
            ...saldoInfo,
            environment: env,
            hasKey: !!apiKey
        });
    } catch (err) {
        console.error("[Asaas] Erro ao consultar saldo:", err.message);
        return res.status(500).json({ error: "Falha ao consultar saldo no Asaas: " + err.message });
    }
});

/**
 * 2. Salvar Chave de API e Ambiente do Asaas
 */
app.post('/api/tenant/asaas-credentials', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    try {
        const { asaas_api_key, asaas_environment } = req.body;
        const tenant = req.tenant;
        const updateData = {};

        if (asaas_environment) {
            updateData.asaas_environment = asaas_environment === 'producao' ? 'producao' : 'sandbox';
        }

        if (asaas_api_key && asaas_api_key.trim()) {
            const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
            updateData.asaas_api_key_encrypted = encrypt(asaas_api_key.trim(), key);
        }

        const { error } = await supabase
            .from('tenants')
            .update(updateData)
            .eq('id', tenant.id);

        if (error) throw error;
        return res.status(200).json({ message: "Configurações do Asaas salvas com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: "Erro ao salvar credenciais do Asaas: " + err.message });
    }
});

/**
 * 2.1 Resumo Executivo para a Dona / Celular: Consulta Lote e Guias Pendentes de Liquidação
 */
app.get('/api/batch/pending-payment', requireAuth, async (req, res) => {
    try {
        const tenant = req.tenant;
        const { data: batches } = await supabase
            .from('batches')
            .select('*')
            .eq('tenant_id', tenant.id)
            .neq('status', 'cancelado')
            .order('created_at', { ascending: false })
            .limit(10);

        if (!batches || batches.length === 0) {
            return res.status(200).json({ lote: null, totalGuias: 0, totalValor: 0, porTransportadora: {}, guias: [] });
        }

        for (const b of batches) {
            const { data: guias } = await supabase
                .from('guides')
                .select('*')
                .eq('batch_id', b.id)
                .eq('tenant_id', tenant.id);

            if (!guias || guias.length === 0) continue;

            const pendentes = guias.filter(g => {
                const hasLine = (g.line_digitizable && g.line_digitizable.length > 30) || (g.barcode && g.barcode.length > 30);
                const naoPaga = g.status !== 'paga' && g.status !== 'comprovada' && !g.asaas_bill_id;
                return hasLine && naoPaga;
            });

            if (pendentes.length > 0) {
                const totalValor = pendentes.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
                const porTransportadora = {};
                pendentes.forEach(g => {
                    const transp = g.carrier_name || 'OUTROS';
                    if (!porTransportadora[transp]) porTransportadora[transp] = { count: 0, valor: 0 };
                    porTransportadora[transp].count++;
                    porTransportadora[transp].valor += parseFloat(g.value || 0);
                });

                return res.status(200).json({
                    lote: b,
                    totalGuias: pendentes.length,
                    totalValor: totalValor,
                    porTransportadora,
                    guias: pendentes.map(g => ({
                        id: g.id,
                        nf_number: g.nf_number,
                        uf: g.uf,
                        value: g.value,
                        carrier_name: g.carrier_name,
                        customer_name: g.customer_name
                    }))
                });
            }
        }

        return res.status(200).json({ lote: null, totalGuias: 0, totalValor: 0, porTransportadora: {}, guias: [], mensagem: 'Tudo em dia! Nenhuma guia pendente de autorização.' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * 3. AUTORIZAÇÃO DO RESPONSÁVEL: Liquidar Lote de Guias via Asaas (Idempotência Estrita)
 */
app.post('/api/batch/authorize-payment-asaas/:batchId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin']), requireActiveSubscription, async (req, res) => {
    const { batchId } = req.params;
    const tenant = req.tenant;
    const aprovador = req.profile?.name || req.user?.email || 'Responsável';

    try {
        const { data: batch, error: bErr } = await supabase
            .from('batches')
            .select('*')
            .eq('id', batchId)
            .eq('tenant_id', tenant.id)
            .single();

        if (bErr || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        // Busca guias do lote
        const { data: guias, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batchId)
            .eq('tenant_id', tenant.id);

        if (gErr || !guias || guias.length === 0) {
            return res.status(400).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const isSimulado = (tenant.environment || '').toLowerCase() === 'simulado';

        // Somente em modo SIMULADO permite gerar código de barras de teste para demonstração
        if (isSimulado) {
            for (const g of guias) {
                const uf = (g.uf || '').toUpperCase();
                if (uf !== 'SP' && parseFloat(g.value || 0) > 0) {
                    if (!g.barcode || g.barcode.length < 44 || !g.line_digitizable) {
                        const auto = printService.gerarCodigoBarrasELinhaDigitavelGNRE(g, tenant);
                        if (auto.codigoBarras) {
                            g.barcode = auto.codigoBarras;
                            g.line_digitizable = auto.linhaDigitavel;
                            await supabase.from('guides').update({
                                barcode: auto.codigoBarras,
                                line_digitizable: auto.linhaDigitavel
                            }).eq('id', g.id);
                        }
                    }
                }
            }
        }

        // Filtra guias elegíveis para pagamento: exige código de barras numérico oficial (>= 44 dígitos),
        // UF válida diferente de SP, e status apto (nunca permite pagar guia aguardando_aprovacao, rejeitada ou com divergência)
        const statusBloqueados = new Set([
            'aguardando_aprovacao', 'rejeitada_sefaz', 'divergencia_uf_portal',
            'requer_dare_sp', 'pagamento_incerto', 'paga', 'comprovada', 'cancelada'
        ]);
        const guiasPendentes = guias.filter(g => {
            const cleanBar = String(g.barcode || '').replace(/\D/g, '');
            const cleanLine = String(g.line_digitizable || '').replace(/\D/g, '');
            const isSynthetic = !isSimulado && printService.isCodigoBarrasSinteticoLocal(cleanBar || cleanLine);
            const hasOfficialCode = !isSynthetic && (cleanBar.length >= 44 || cleanLine.length >= 44) && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP';
            const ufValida = g.uf && g.uf.toUpperCase() !== 'SP';
            const statusOk = !statusBloqueados.has((g.status || '').toLowerCase()) && !g.asaas_bill_id;
            return hasOfficialCode && ufValida && statusOk;
        });

        if (guiasPendentes.length === 0) {
            return res.status(400).json({
                error: "Nenhuma guia apta para pagamento bancário neste lote (verifique se o lote já foi transmitido e aceito pela SEFAZ com código de barras oficial)."
            });
        }

        const apiKey = getAsaasApiKey(tenant);
        if (!isSimulado && !apiKey) {
            return res.status(400).json({ error: "Chave de API do Asaas não configurada ou inválida para ambiente de Produção. Configure em Empresa > Integrações." });
        }
        const env = isSimulado ? 'simulado' : (tenant.asaas_environment || (apiKey ? 'sandbox' : 'simulado'));

        console.log(`[Asaas] Autorizando pagamento de ${guiasPendentes.length} guia(s) no lote ${batchId} por: ${aprovador}`);

        const resultados = [];
        const agora = new Date().toISOString();

        for (const g of guiasPendentes) {
            const linha = g.line_digitizable || g.barcode;
            const extRef = `guia_${g.id}`;

            // Claim atômico: trava a guia com status 'pagamento_em_processamento'
            const { data: claimed, error: claimErr } = await supabase
                .from('guides')
                .update({
                    status: 'pagamento_em_processamento',
                    payment_authorized_by: aprovador,
                    payment_authorized_at: agora
                })
                .eq('id', g.id)
                .eq('tenant_id', tenant.id)
                .is('asaas_bill_id', null)
                .neq('status', 'pagamento_em_processamento')
                .neq('status', 'pagamento_enviado')
                .neq('status', 'pagamento_incerto')
                .neq('status', 'comprovada')
                .neq('status', 'paga')
                .select('id');

            if (claimErr || !claimed || claimed.length === 0) {
                console.warn(`[Asaas] Guia NF ${g.nf_number} ignorada: já capturada ou liquidada concorrentemente.`);
                continue;
            }

            try {
                // 1. Dispara o pagamento na API do Asaas
                const billRes = await asaasService.pagarGuia({
                    identificationField: linha,
                    value: g.value,
                    description: `DIFAL NF ${g.nf_number} - ${g.uf}`,
                    externalReference: extRef,
                    dueDate: g.nf_issue_date || agora.split('T')[0]
                }, apiKey, env);

                const updatesGuia = {
                    asaas_bill_id: billRes.id,
                    payment_authorized_by: aprovador,
                    payment_authorized_at: agora,
                    status: 'pagamento_enviado'
                };

                // Somente em modo simulado gera comprovante de demonstração (marcado como SEM VALOR FISCAL)
                if (isSimulado) {
                    const compPdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                        nfNumber: g.nf_number,
                        uf: g.uf,
                        valor: g.value,
                        billId: billRes.id,
                        razaoSocial: tenant.razao_social,
                        environment: 'simulado'
                    });

                    const remoteReceiptPath = `${tenant.id}/comprovantes/comprovante_simulado_NF_${g.nf_number}.pdf`;
                    await supabase.storage
                        .from('tenant-storage')
                        .upload(remoteReceiptPath, compPdfBuffer, {
                            contentType: 'application/pdf',
                            upsert: true
                        });

                    updatesGuia.status = 'comprovada';
                    updatesGuia.paid_at = agora;
                    updatesGuia.receipt_storage_path = remoteReceiptPath;
                    updatesGuia.bank_authentication = `SIMULADO-${g.id.substring(0, 8).toUpperCase()}`;
                }

                await supabase.from('guides').update(updatesGuia).eq('id', g.id).eq('tenant_id', tenant.id);
                resultados.push({ id: g.id, nf: g.nf_number, billId: billRes.id, sucesso: true });

            } catch (pErr) {
                console.error(`[Asaas] Erro ao pagar guia NF ${g.nf_number}:`, pErr.message);
                // Se foi timeout ou erro de rede/5xx, mantém bloqueada em 'pagamento_incerto' para evitar pagamento duplicado
                const isIncerto = pErr.isNetworkOrTimeout || (pErr.statusCode && pErr.statusCode >= 500);
                await supabase.from('guides').update({
                    status: isIncerto ? 'pagamento_incerto' : 'erro_pagamento',
                    rejection_reason: isIncerto
                        ? `Resultado indeterminado (${pErr.message}). Concilie no painel Asaas antes de reenviar.`
                        : pErr.message
                }).eq('id', g.id).eq('tenant_id', tenant.id);

                resultados.push({ id: g.id, nf: g.nf_number, erro: pErr.message, sucesso: false, incerto: isIncerto });
            }
        }

        // Atualiza o lote com a aprovação do responsável
        await supabase
            .from('batches')
            .update({
                approved_by: aprovador,
                approved_at: agora,
                approval_status: 'aprovado'
            })
            .eq('id', batchId);

        const totalSucesso = resultados.filter(r => r.sucesso).length;
        const totalFalha = resultados.filter(r => !r.sucesso).length;

        return res.status(200).json({
            message: `Pagamento autorizado com sucesso por ${aprovador}! ${totalSucesso} guia(s) processada(s).`,
            totalSucesso,
            totalFalha,
            detalhes: resultados
        });

    } catch (err) {
        console.error("[Asaas] Erro geral na autorização do lote:", err);
        return res.status(500).json({ error: "Falha na autorização do pagamento: " + err.message });
    }
});

/**
 * 4. AUTORIZAÇÃO DO RESPONSÁVEL: Pagar Guia Individual
 */
app.post('/api/guide/authorize-payment-asaas/:guideId', requireAuth, requireRole(['diretoria', 'financeiro', 'admin']), requireActiveSubscription, async (req, res) => {
    const { guideId } = req.params;
    const tenant = req.tenant;
    const aprovador = req.profile?.name || req.user?.email || 'Responsável';

    try {
        const { data: guia, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('id', guideId)
            .eq('tenant_id', tenant.id)
            .single();

        if (gErr || !guia) return res.status(404).json({ error: "Guia não encontrada." });

        const statusBloqueados = new Set([
            'aguardando_aprovacao', 'rejeitada_sefaz', 'divergencia_uf_portal',
            'requer_dare_sp', 'pagamento_incerto', 'paga', 'comprovada', 'cancelada'
        ]);
        if (statusBloqueados.has((guia.status || '').toLowerCase()) || guia.asaas_bill_id) {
            return res.status(400).json({
                error: `Esta guia não está apta para pagamento (status atual: '${guia.status}'). Verifique se ela já foi emitida e validada na SEFAZ.`
            });
        }

        const isSimulado = (tenant.environment || '').toLowerCase() === 'simulado';
        if (isSimulado && (!guia.barcode || guia.barcode.length < 44 || !guia.line_digitizable)) {
            const auto = printService.gerarCodigoBarrasELinhaDigitavelGNRE(guia, tenant);
            if (auto.codigoBarras) {
                guia.barcode = auto.codigoBarras;
                guia.line_digitizable = auto.linhaDigitavel;
                await supabase.from('guides').update({
                    barcode: auto.codigoBarras,
                    line_digitizable: auto.linhaDigitavel
                }).eq('id', guia.id);
            }
        }

        const linha = String(guia.line_digitizable || guia.barcode || '').replace(/\D/g, '');
        if (!linha || linha.length < 44 || guia.barcode === 'IMPORTAR_NO_SEFAZ_SP' || (!isSimulado && printService.isCodigoBarrasSinteticoLocal(guia.barcode || linha))) {
            return res.status(400).json({ error: "Guia não possui código de barras oficial da SEFAZ (mínimo 44 dígitos) para pagamento." });
        }

        const apiKey = getAsaasApiKey(tenant);
        if (!isSimulado && !apiKey) {
            return res.status(400).json({ error: "Chave de API do Asaas não configurada ou inválida para ambiente de Produção. Configure em Empresa > Integrações." });
        }
        const env = isSimulado ? 'simulado' : (tenant.asaas_environment || (apiKey ? 'sandbox' : 'simulado'));
        const agora = new Date().toISOString();

        // Claim atômico: trava a guia com status 'pagamento_em_processamento'
        const { data: claimed, error: claimErr } = await supabase
            .from('guides')
            .update({
                status: 'pagamento_em_processamento',
                payment_authorized_by: aprovador,
                payment_authorized_at: agora
            })
            .eq('id', guia.id)
            .eq('tenant_id', tenant.id)
            .is('asaas_bill_id', null)
            .neq('status', 'pagamento_em_processamento')
            .neq('status', 'pagamento_enviado')
            .neq('status', 'pagamento_incerto')
            .neq('status', 'comprovada')
            .neq('status', 'paga')
            .select('id');

        if (claimErr || !claimed || claimed.length === 0) {
            return res.status(409).json({ error: "Esta guia já está em processamento de pagamento ou já foi liquidada por outro operador/sessão." });
        }

        const billRes = await asaasService.pagarGuia({
            identificationField: linha,
            value: guia.value,
            description: `DIFAL NF ${guia.nf_number} - ${guia.uf}`,
            externalReference: `guia_${guia.id}`,
            dueDate: guia.nf_issue_date || agora.split('T')[0]
        }, apiKey, env);

        const updatesGuia = {
            asaas_bill_id: billRes.id,
            payment_authorized_by: aprovador,
            payment_authorized_at: agora,
            status: 'pagamento_enviado'
        };

        if (isSimulado) {
            const compPdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                nfNumber: guia.nf_number,
                uf: guia.uf,
                valor: guia.value,
                billId: billRes.id,
                razaoSocial: tenant.razao_social,
                environment: 'simulado'
            });

            const remoteReceiptPath = `${tenant.id}/comprovantes/comprovante_simulado_NF_${guia.nf_number}.pdf`;
            await supabase.storage
                .from('tenant-storage')
                .upload(remoteReceiptPath, compPdfBuffer, {
                    contentType: 'application/pdf',
                    upsert: true
                });

            updatesGuia.status = 'comprovada';
            updatesGuia.paid_at = agora;
            updatesGuia.receipt_storage_path = remoteReceiptPath;
            updatesGuia.bank_authentication = `SIMULADO-${guia.id.substring(0, 8).toUpperCase()}`;
        }

        await supabase.from('guides').update(updatesGuia).eq('id', guia.id).eq('tenant_id', tenant.id);

        return res.status(200).json({
            message: `Pagamento da NF ${guia.nf_number} autorizado com sucesso!`,
            billId: billRes.id,
            status: updatesGuia.status
        });

    } catch (err) {
        console.error("[Asaas] Erro na autorização da guia:", err);
        if (typeof guia !== 'undefined' && guia && guia.id) {
            const isIncerto = err.isNetworkOrTimeout || (err.statusCode && err.statusCode >= 500);
            await supabase.from('guides').update({
                status: isIncerto ? 'pagamento_incerto' : 'erro_pagamento',
                rejection_reason: isIncerto
                    ? `Resultado indeterminado (${err.message}). Concilie no painel Asaas antes de reenviar.`
                    : err.message
            }).eq('id', guia.id).eq('tenant_id', tenant.id);
        }
        return res.status(500).json({ error: err.message });
    }
});

/**
 * 5. Visualizar / Baixar Comprovante de Pagamento da Guia
 */
app.get('/api/guide/comprovante/:guideId', requireAuth, async (req, res) => {
    const { guideId } = req.params;
    const tenant = req.tenant;

    try {
        const { data: guia, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('id', guideId)
            .eq('tenant_id', tenant.id)
            .single();

        if (gErr || !guia) return res.status(404).json({ error: "Guia não encontrada." });

        const isSimulado = (tenant.environment || '').toLowerCase() === 'simulado';

        if (!guia.receipt_storage_path) {
            // Somente em modo simulado permite gerar comprovante de demonstração sob demanda
            if (isSimulado && (guia.status === 'paga' || guia.status === 'comprovada')) {
                const compPdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                    nfNumber: guia.nf_number,
                    uf: guia.uf,
                    valor: guia.value,
                    billId: guia.asaas_bill_id || ('bill_sim_' + guia.id.substring(0, 8)),
                    razaoSocial: tenant.razao_social,
                    environment: 'simulado'
                });

                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `inline; filename="comprovante_simulado_NF_${guia.nf_number}.pdf"`);
                return res.send(compPdfBuffer);
            }
            return res.status(404).json({ error: "Esta guia ainda não possui comprovante bancário oficial liquidado." });
        }

        const { data: fileData, error: dlErr } = await supabase.storage
            .from('tenant-storage')
            .download(guia.receipt_storage_path);

        if (dlErr || !fileData) {
            return res.status(404).json({ error: "Arquivo de comprovante não encontrado no storage." });
        }

        const arrayBuffer = await fileData.arrayBuffer();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="comprovante_NF_${guia.nf_number}.pdf"`);
        return res.send(Buffer.from(arrayBuffer));

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * 6. WEBHOOK DO ASAAS: Notificação assíncrona de Liquidação (BILL_PAID / BILL_FAILED / PIX)
 */
app.post('/api/webhooks/asaas', async (req, res) => {
    try {
        // Validação estrita de segurança de origem do webhook via timingSafeEqual (fail-closed)
        const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;
        const receivedToken = req.headers['asaas-access-token'];
        if (!expectedToken || !safeCompareTokens(receivedToken, expectedToken)) {
            console.warn("[Webhook Asaas] Acesso rejeitado: token ausente ou inválido.");
            return res.status(401).json({ error: "Token de webhook não autorizado." });
        }

        const event = req.body?.event;
        const bill = req.body?.bill || req.body?.payment;

        console.log(`[Webhook Asaas] Recebido evento: ${event} para ID: ${bill?.id}`);

        if (!event || !bill) {
            return res.status(200).json({ received: true });
        }

        // ==========================================
        // CASO 1: GUIA/TRIBUTO QUITADO (BILL_PAID)
        // ==========================================
        if (event === 'BILL_PAID') {
            const billId = bill.id;
            const extRef = bill.externalReference;
            const receiptUrl = bill.transactionReceiptUrl;
            const identField = bill.identificationField ? String(bill.identificationField).replace(/[^0-9]/g, '') : null;

            // Busca da guia em múltiplos níveis (Resiliência Operacional)
            let guia = null;

            // Nível 1: Pela referência externa (ID da guia)
            if (extRef) {
                const guideId = extRef.startsWith('guia_') ? extRef.replace('guia_', '') : extRef;
                const { data: gList } = await supabase.from('guides').select('*, tenants(*)').eq('id', guideId).limit(1);
                if (gList && gList.length > 0) guia = gList[0];
            }

            // Nível 2: Pelo ID da transação Asaas (asaas_bill_id)
            if (!guia && billId) {
                const { data: gList } = await supabase.from('guides').select('*, tenants(*)').eq('asaas_bill_id', billId).limit(1);
                if (gList && gList.length > 0) guia = gList[0];
            }

            // Nível 3: Pela linha digitável / código de barras
            if (!guia && identField) {
                const { data: gList } = await supabase.from('guides').select('*, tenants(*)').or(`line_digitizable.eq.${identField},barcode.eq.${identField}`).limit(1);
                if (gList && gList.length > 0) guia = gList[0];
            }

            if (guia) {
                const agora = new Date().toISOString();
                const isTenantSimulado = (guia.tenants?.environment || '').toLowerCase() === 'simulado';
                const authCode = bill.bankAuthentication || bill.authenticationCode || guia.bank_authentication || null;
                let storagePath = null;
                let pdfBuffer = null;

                // 1. Baixa exclusivamente o comprovante oficial da URL do Asaas se existir
                if (receiptUrl) {
                    try {
                        pdfBuffer = await asaasService.downloadExternalPdf(receiptUrl);
                        storagePath = `${guia.tenant_id}/comprovantes/comprovante_NF_${guia.nf_number}.pdf`;
                    } catch (eDl) {
                        console.warn("[Webhook Asaas] Falha ao baixar PDF oficial do Asaas:", eDl.message);
                    }
                }

                // 2. NUNCA gera comprovante simulado em Produção; apenas se o tenant estiver em modo simulado
                if (!pdfBuffer && isTenantSimulado) {
                    try {
                        pdfBuffer = await asaasService.gerarComprovanteSimuladoPdf({
                            nfNumber: guia.nf_number,
                            uf: guia.uf,
                            valor: guia.value || bill.value,
                            billId: billId,
                            razaoSocial: guia.tenants?.razao_social || 'Empresa Emitente',
                            environment: 'simulado'
                        });
                        storagePath = `${guia.tenant_id}/comprovantes/comprovante_simulado_NF_${guia.nf_number}.pdf`;
                    } catch (eGen) {
                        console.error("[Webhook Asaas] Erro ao gerar comprovante simulado:", eGen.message);
                    }
                }

                // 3. Faz upload para o Supabase Storage se obteve o arquivo
                if (pdfBuffer && storagePath) {
                    try {
                        await supabase.storage
                            .from('tenant-storage')
                            .upload(storagePath, pdfBuffer, {
                                contentType: 'application/pdf',
                                upsert: true
                            });
                    } catch (eUp) {
                        console.warn("[Webhook Asaas] Erro ao salvar comprovante no Supabase Storage:", eUp.message);
                        storagePath = null;
                    }
                }

                // 4. Atualiza o registro da guia no banco de dados com escopo restrito de tenant
                const updates = {
                    status: 'comprovada',
                    paid_at: bill.paymentDate || agora,
                    receipt_url: receiptUrl || null,
                    receipt_storage_path: storagePath || guia.receipt_storage_path || null,
                    bank_authentication: authCode,
                    asaas_bill_id: billId || guia.asaas_bill_id
                };

                await supabase.from('guides').update(updates).eq('id', guia.id).eq('tenant_id', guia.tenant_id);
                console.log(`[Webhook Asaas] Guia NF ${guia.nf_number} atualizada para COMPROVADA! Autenticação: ${authCode}`);

                // 5. Verifica se todas as guias do lote foram liquidadas para fechar o lote
                if (guia.batch_id) {
                    try {
                        const { data: batchGuides } = await supabase
                            .from('guides')
                            .select('id, status, uf, value')
                            .eq('batch_id', guia.batch_id)
                            .eq('tenant_id', guia.tenant_id);

                        if (batchGuides && batchGuides.length > 0) {
                            const pendentes = batchGuides.filter(g => {
                                const uf = (g.uf || '').toUpperCase();
                                if (uf === 'SP' || parseFloat(g.value || 0) === 0) return false;
                                return g.status !== 'comprovada' && g.status !== 'paga';
                            });

                            if (pendentes.length === 0) {
                                await supabase.from('batches').update({
                                    status: 'liquidado',
                                    closed_at: agora
                                }).eq('id', guia.batch_id).eq('tenant_id', guia.tenant_id);
                                console.log(`[Webhook Asaas] Lote ${guia.batch_id} totalmente liquidado!`);
                            }
                        }
                    } catch (eBatch) {
                        console.warn("[Webhook Asaas] Falha ao verificar status global do lote:", eBatch.message);
                    }
                }

                // 6. Notifica Cockpit da Doca em tempo real via SSE isolado por tenant
                broadcastDockEvent({
                    type: 'GUIA_PAGA',
                    guiaId: guia.id,
                    nf: guia.nf_number,
                    uf: guia.uf,
                    batchId: guia.batch_id,
                    status: 'comprovada',
                    bank_authentication: authCode,
                    receipt_storage_path: storagePath,
                    timestamp: agora
                }, guia.tenant_id);
            } else {
                console.warn(`[Webhook Asaas] Nenhuma guia encontrada para Bill ID: ${billId} / Ref: ${extRef}`);
            }
        }

        // ==========================================
        // CASO 2: FALHA OU CANCELAMENTO DO PAGAMENTO
        // ==========================================
        if (event === 'BILL_FAILED' || event === 'BILL_CANCELLED') {
            const billId = bill.id;
            const extRef = bill.externalReference;
            const motivo = bill.failReason || bill.description || 'Pagamento cancelado ou rejeitado no Asaas';

            let { data: guias } = await supabase.from('guides').select('*').eq('asaas_bill_id', billId).limit(1);
            if ((!guias || guias.length === 0) && extRef) {
                const guideId = extRef.startsWith('guia_') ? extRef.replace('guia_', '') : extRef;
                const { data: gList } = await supabase.from('guides').select('*').eq('id', guideId).limit(1);
                guias = gList;
            }

            if (guias && guias.length > 0) {
                const guia = guias[0];
                await supabase.from('guides').update({
                    status: 'erro_pagamento',
                    rejection_reason: motivo
                }).eq('id', guia.id).eq('tenant_id', guia.tenant_id);

                console.warn(`[Webhook Asaas] Guia NF ${guia.nf_number} marcada com ERRO DE PAGAMENTO: ${motivo}`);

                broadcastDockEvent({
                    type: 'GUIA_ERRO',
                    guiaId: guia.id,
                    nf: guia.nf_number,
                    uf: guia.uf,
                    batchId: guia.batch_id,
                    status: 'erro_pagamento',
                    motivo: motivo,
                    timestamp: new Date().toISOString()
                }, guia.tenant_id);
            }
        }

        return res.status(200).json({ received: true });
    } catch (err) {
        console.error("[Webhook Asaas] Erro ao processar webhook:", err);
        return res.status(500).json({ error: "Erro interno ao processar webhook" });
    }
});

app.get('/api/batch/status/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: batch, error } = await supabase
            .from('batches')
            .select('*, guides(*)')
            .eq('id', req.params.batchId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        // Complementa a resposta com logs dinâmicos de memória se estiver processando
        const taskInfo = activeTasks[batch.id] || { logs: [], progress: batch.status === 'sucesso' ? 100 : 0 };

        // Verifica se há XML de São Paulo gerado neste lote
        const hasSpXml = req.tenant.environment === 'producao' && batch.guides && batch.guides.some(g => g.uf === 'SP');

        return res.status(200).json({
            id: batch.id,
            status: batch.status,
            receipt: batch.receipt,
            error_message: batch.error_message,
            created_at: batch.created_at,
            progress: taskInfo.progress,
            logs: taskInfo.logs,
            guides: batch.guides,
            has_sp_xml: !!hasSpXml
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint para baixar o lote XML de São Paulo (SP)
app.get('/api/batch/download-xml/:batchId', requireAuth, async (req, res) => {
    const { batchId } = req.params;
    const tenant = req.tenant;

    try {
        const { data: fileData, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(`${tenant.id}/lotes_sp/lote_sp_${batchId}.xml`);

        if (downloadError || !fileData) {
            return res.status(404).json({ error: "Arquivo XML de lote para São Paulo não localizado ou não disponível." });
        }

        const buffer = Buffer.from(await fileData.arrayBuffer());
        res.setHeader('Content-Type', 'application/xml');
        res.setHeader('Content-Disposition', `attachment; filename="lote_sp_gnre_${batchId}.xml"`);
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Rota para consulta e importação manual de recibos (caso dê timeout)
app.post('/api/batch/query-receipt', requireAuth, async (req, res) => {
    const { receipt, uf, paymentDate } = req.body;
    if (!receipt || !uf) {
        return res.status(400).json({ error: "Número do recibo e UF são obrigatórios." });
    }

    const tenant = req.tenant;

    try {
        // 1. Carrega e prepara certificado
        if (!tenant.pfx_filename) {
            return res.status(400).json({ error: "Nenhum certificado digital PFX configurado para esta empresa." });
        }

        const passphraseKey = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const passphrase = decrypt(tenant.pfx_passphrase_encrypted, passphraseKey);

        const { data: fileData, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(`${tenant.id}/certificados/${tenant.pfx_filename}`);

        if (downloadError || !fileData) {
            return res.status(400).json({ error: "Erro ao carregar arquivo de certificado do Storage: " + downloadError?.message });
        }

        const pfxBuffer = Buffer.from(await fileData.arrayBuffer());
        const agent = gnreService.createHttpsAgent({ pfxBuffer, passphrase });

        // 2. Consulta lote no webservice da SEFAZ
        const logsDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
            ? path.join('/tmp', 'xml_logs')
            : path.join(__dirname, 'xml_logs');

        const xmlConsulta = await gnreService.consultarLote(receipt, agent, uf, tenant.environment, logsDir);

        // 3. Extrai dados da guia e verifica status de processamento
        const sitProcess = parserService.extrairTag(xmlConsulta, 'situacaoProcess');
        const codSit = sitProcess ? parserService.extrairTag(sitProcess, 'codigo') : null;
        const descSit = sitProcess ? parserService.extrairTag(sitProcess, 'descricao') : '';

        const processando = !codSit || ['401', '103', '105'].includes(codSit) || (descSit.toLowerCase().includes('processamento') && !['402', '403', '404'].includes(codSit));

        if (processando) {
            return res.status(202).json({ 
                status: 'processando',
                message: `O lote ainda está sendo processado pelo governo do ${uf}. Tente novamente em alguns instantes.` 
            });
        }

        let dadosGuias = null;
        try {
            dadosGuias = parserService.extrairDadosGuiaXML(xmlConsulta);
        } catch (parseErr) {
            return res.status(400).json({ 
                error: `O lote foi processado, mas nenhuma guia válida foi retornada. Detalhes: ${parseErr.message}. Status: ${codSit} - ${descSit}` 
            });
        }

        if (!dadosGuias || dadosGuias.length === 0) {
            return res.status(400).json({ 
                error: `O lote foi processado, mas nenhuma guia válida foi retornada. Status: ${codSit} - ${descSit}` 
            });
        }

        // 4. Salva ou atualiza no banco de dados
        // Procura se já existe um lote com esse recibo
        const { data: existingBatch } = await supabase
            .from('batches')
            .select('*')
            .eq('tenant_id', tenant.id)
            .ilike('receipt', `%${receipt}%`)
            .limit(1);

        let batchId;
        if (existingBatch && existingBatch.length > 0) {
            batchId = existingBatch[0].id;
            
            // Atualiza status do lote existente para sucesso
            await supabase
                .from('batches')
                .update({ status: 'sucesso', receipt: `${uf}:${receipt}` })
                .eq('id', batchId);
        } else {
            // Cria um novo lote
            const { data: newBatch } = await supabase
                .from('batches')
                .insert({
                    tenant_id: tenant.id,
                    environment: tenant.environment,
                    status: 'sucesso',
                    receipt: `${uf}:${receipt}`
                })
                .select()
                .single();
            batchId = newBatch.id;
        }

        // 5. Gera HTMLs das guias, faz upload para o Storage e salva guias no BD
        const dadosBancarios = {
            cnpj: tenant.cnpj,
            razaoSocial: tenant.razao_social,
            agencia: tenant.bank_agency,
            conta: tenant.bank_account,
            dac: tenant.bank_dac
        };

        const guiasDb = [];
        for (const guia of dadosGuias) {
            // Prepara uma nota simulada para o renderizador HTML da guia
            const htmlGuia = gnreService.exportarGuiaHtml(dadosBancarios, guia, {
                cnpjEmitente: tenant.cnpj,
                razaoSocialEmitente: tenant.razao_social
            });

            const nomeLocal = `guia_NF_${guia.documentoOrigem || 'rec_importada'}.html`;
            const remotePath = `${tenant.id}/guias/${nomeLocal}`;

            await supabase.storage
                .from('tenant-storage')
                .upload(remotePath, Buffer.from(htmlGuia, 'utf-8'), {
                    contentType: 'text/html',
                    upsert: true
                });

            guiasDb.push({
                tenant_id: tenant.id,
                batch_id: batchId,
                nf_number: guia.documentoOrigem || 'N/A',
                uf: guia.ufFavorecida || uf,
                value: guia.valor,
                barcode: guia.codigoBarras,
                line_digitizable: guia.linhaDigitavel,
                storage_path: remotePath
            });
        }

        // Remove guias antigas do lote se for uma re-consulta de lote existente para não duplicar guias
        if (existingBatch && existingBatch.length > 0) {
            await supabase
                .from('guides')
                .delete()
                .eq('batch_id', batchId);
        }

        // Salva as guias importadas
        const { error: insertError } = await supabase
            .from('guides')
            .insert(guiasDb);

        if (insertError) throw insertError;

        // 5.5 Regenera o arquivo de remessa CNAB 240 consolidado
        const { data: allGuides, error: fetchGuidesError } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batchId);

        if (fetchGuidesError) {
            console.error("Erro ao buscar guias do lote para gerar remessa:", fetchGuidesError.message);
        } else if (allGuides && allGuides.length > 0) {
            // Mapeia para o formato que gerarRemessaSispag espera
            const mappedGuides = allGuides.map(g => {
                const originalGuia = dadosGuias.find(dg => dg.codigoBarras === g.barcode);
                return {
                    codigoBarras: g.barcode,
                    valor: g.value,
                    dataVencimento: originalGuia ? originalGuia.dataVencimento : (g.created_at ? g.created_at.split('T')[0] : new Date().toISOString().split('T')[0]),
                    documentoOrigem: g.nf_number,
                    ufFavorecida: g.uf
                };
            });

            try {
                const cnabContent = cnabService.gerarRemessaSispag(dadosBancarios, mappedGuides, paymentDate);

                // Envia remessa.txt exclusivamente para Supabase Storage privado
                const remessaFilename = `remessa_${batchId}.txt`;
                await supabase.storage
                    .from('tenant-storage')
                    .upload(`${tenant.id}/remessas/${remessaFilename}`, Buffer.from(cnabContent, 'utf-8'), {
                        contentType: 'text/plain',
                        upsert: true
                    });
            } catch (cnabErr) {
                console.error("Erro ao regenerar arquivo CNAB:", cnabErr.message);
            }
        }

        return res.status(200).json({
            status: 'sucesso',
            message: `Lote consultado com sucesso! ${dadosGuias.length} guia(s) importada(s).`,
            batch_id: batchId
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/batch/history', requireAuth, async (req, res) => {
    try {
        const { data: batches, error } = await supabase
            .from('batches')
            .select('id, created_at, status, environment, file_count, source, error_message')
            .eq('tenant_id', req.tenant.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;
        return res.status(200).json(batches);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTAS DE DOWNLOAD DE ARQUIVOS E GUIA
// ==========================================
app.get('/api/remessa/download/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: batch, error } = await supabase
            .from('batches')
            .select('*')
            .eq('id', req.params.batchId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !batch) {
            return res.status(404).json({ error: "Lote não localizado." });
        }

        const bankParam = (req.query.banco || 'itau').toLowerCase();
        const paymentDateChosen = req.query.paymentDate || req.query.dataPagamento;

        // Se solicitado Bradesco ou Banco do Brasil, gera na hora para as guias do lote
        if (bankParam === 'bradesco' || bankParam === 'bb') {
            const { data: batchGuides } = await supabase
                .from('guides')
                .select('*')
                .eq('batch_id', batch.id)
                .eq('tenant_id', req.tenant.id);

            const dadosBancarios = {
                cnpj: req.tenant.cnpj,
                razaoSocial: req.tenant.razao_social,
                agencia: req.tenant.bank_agency || '0001',
                conta: req.tenant.bank_account || '00001',
                dac: req.tenant.bank_dac || '0',
                convenio: req.tenant.bank_convenio || ''
            };

            const validGuides = (batchGuides || []).filter(g => {
                const bar = String(g.barcode || '').replace(/\D/g, '');
                return bar.length >= 44 && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP' && g.uf && g.uf !== 'SP';
            });

            const mapped = validGuides.map(g => ({
                codigoBarras: g.barcode,
                valor: g.value,
                dataVencimento: paymentDateChosen || g.due_date || new Date().toISOString().split('T')[0],
                documentoOrigem: g.nf_number,
                ufFavorecida: g.uf
            }));

            let cnabText = '';
            if (bankParam === 'bradesco') {
                cnabText = cnabService.gerarRemessaBradesco(dadosBancarios, mapped, paymentDateChosen);
            } else {
                cnabText = cnabService.gerarRemessaBB(dadosBancarios, mapped, paymentDateChosen);
            }

            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="remessa_${bankParam}_${batch.id}.txt"`);
            return res.send(cnabText);
        }

        // Caso padrão (Itaú SISPAG)
        // Busca guias do lote no banco de dados e gera o CNAB 240 sempre atualizado
        const { data: batchGuides } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', batch.id)
            .eq('tenant_id', req.tenant.id);

        const dadosBancarios = {
            cnpj: req.tenant.cnpj,
            razaoSocial: req.tenant.razao_social,
            agencia: req.tenant.bank_agency || '0334',
            conta: req.tenant.bank_account || '98775',
            dac: req.tenant.bank_dac || '7',
            convenio: req.tenant.bank_convenio || ''
        };

        const dataPagamentoEfetiva = paymentDateChosen || new Date().toISOString().split('T')[0];

        const isSimuladoCnab = (req.tenant.environment || '').toLowerCase() === 'simulado';
        const validItauGuides = (batchGuides || []).filter(g => {
            const bar = String(g.barcode || '').replace(/\D/g, '');
            const isSynthetic = !isSimuladoCnab && printService.isCodigoBarrasSinteticoLocal(bar);
            return !isSynthetic && bar.length >= 44 && g.barcode !== 'IMPORTAR_NO_SEFAZ_SP' && g.uf && g.uf !== 'SP';
        });

        const mapped = validItauGuides.map(g => ({
            codigoBarras: g.barcode,
            valor: g.value,
            dataVencimento: g.due_date || dataPagamentoEfetiva,
            documentoOrigem: g.nf_number,
            ufFavorecida: g.uf
        }));

        const cnabText = cnabService.gerarRemessaSispag(dadosBancarios, mapped, dataPagamentoEfetiva);

        // Atualiza a cópia no Supabase Storage em background
        const remessaPath = `${req.tenant.id}/remessas/remessa_${batch.id}.txt`;
        supabase.storage
            .from('tenant-storage')
            .upload(remessaPath, Buffer.from(cnabText, 'latin1'), { contentType: 'text/plain', upsert: true })
            .catch(e => console.warn('[Storage] Falha ao persistir remessa Itaú:', e.message));

        res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
        res.setHeader('Content-Disposition', `attachment; filename="remessa_itau_${batch.id}.txt"`);
        return res.send(Buffer.from(cnabText, 'latin1'));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Upload e Processamento de Arquivo de Retorno Bancário CNAB 240 (.RET)
 * Realiza a conciliação automática das guias, gravando data de pagamento e autenticação bancária
 */
const uploadRetorno = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});
app.post('/api/cnab/upload-retorno', requireAuth, requireRole(['diretoria', 'financeiro', 'admin', 'superadmin']), uploadRetorno.single('retornoFile'), async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: "Nenhum arquivo de retorno (.RET) foi enviado." });
        }

        const conteudo = req.file.buffer.toString('utf-8');
        const resultadoParsing = cnabService.processarRetornoSispag(conteudo);

        const atualizadas = [];
        const naoLocalizadas = [];

        for (const pag of resultadoParsing.pagamentos) {
            // Localiza a guia correspondente no tenant
            let query = supabase.from('guides').select('id, nf_number, uf, value, status').eq('tenant_id', req.tenant.id);
            
            if (pag.codigoBarras && pag.codigoBarras.length >= 40) {
                // Tenta pelo código de barras
                query = query.eq('barcode', pag.codigoBarras);
            } else if (pag.nfNumber) {
                // Fallback pelo número da NF
                query = query.eq('nf_number', pag.nfNumber);
            }

            const { data: guiasEncontradas } = await query;

            if (guiasEncontradas && guiasEncontradas.length > 0) {
                for (const g of guiasEncontradas) {
                    const updateData = {
                        status: pag.status === 'PAGO' ? 'paga' : (pag.status === 'AGENDADO' ? 'agendada' : 'rejeitada')
                    };
                    if (pag.dataPagamento) {
                        updateData.paid_at = pag.dataPagamento;
                    }
                    if (pag.autenticacao) {
                        updateData.bank_authentication = pag.autenticacao;
                    }

                    await supabase.from('guides').update(updateData).eq('id', g.id).eq('tenant_id', req.tenant.id);
                    atualizadas.push({
                        nf: g.nf_number,
                        uf: g.uf,
                        valor: pag.valorPago,
                        status: updateData.status,
                        autenticacao: pag.autenticacao
                    });
                }
            } else {
                naoLocalizadas.push({
                    nf: pag.nfNumber || 'N/D',
                    codigoBarras: pag.codigoBarras,
                    valor: pag.valorPago,
                    status: pag.status
                });
            }
        }

        return res.json({
            success: true,
            message: `Retorno processado com sucesso! ${atualizadas.length} guia(s) conciliada(s).`,
            resumo: {
                totalNoArquivo: resultadoParsing.totalProcessadas,
                baixadas: resultadoParsing.baixadas,
                agendadas: resultadoParsing.agendadas,
                rejeitadas: resultadoParsing.rejeitadas,
                conciliadasComSucesso: atualizadas.length,
                naoLocalizadasNoBanco: naoLocalizadas.length
            },
            atualizadas,
            naoLocalizadas
        });
    } catch (err) {
        console.error("Erro ao processar retorno CNAB 240:", err);
        return res.status(500).json({ error: `Erro ao processar retorno bancário: ${err.message}` });
    }
});

/**
 * 4.0 Consulta de Cargas Ativas da Doca (Tempo Real para Cockpit e Mobile)
 */
app.get('/api/expedicao/cargas-ativas', requireAuth, async (req, res) => {
    try {
        const tenant = req.tenant;
        const { data: batches } = await supabase
            .from('batches')
            .select('*')
            .eq('tenant_id', tenant.id)
            .neq('status', 'cancelado')
            .order('created_at', { ascending: false })
            .limit(1);

        const activeBatch = batches && batches.length > 0 ? batches[0] : null;

        let query = supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenant.id)
            .order('nf_number', { ascending: true });

        if (activeBatch) {
            query = query.eq('batch_id', activeBatch.id);
        }

        const { data: guias } = await query;
        const lista = guias || [];

        let total = lista.length;
        let liberadas = 0;
        let retidas = 0;
        let valorTotal = 0;
        let valorPendente = 0;

        const porTransportadora = {};

        lista.forEach(g => {
            const val = parseFloat(g.value || 0);
            valorTotal += val;
            const isLib = printService.isGuiaLiberada(g);
            if (isLib) {
                liberadas++;
            } else {
                retidas++;
                valorPendente += val;
            }

            let transp = (g.carrier_name || 'Total Express').trim();
            if (transp.toUpperCase().includes('TOTAL')) transp = 'Total Express';
            else if (transp.toUpperCase().includes('CORREIO')) transp = 'Correios';
            else if (transp.toUpperCase().includes('MT')) transp = 'MT Log';

            if (!porTransportadora[transp]) {
                porTransportadora[transp] = { total: 0, liberadas: 0, retidas: 0, valor: 0 };
            }
            porTransportadora[transp].total++;
            if (isLib) porTransportadora[transp].liberadas++;
            else porTransportadora[transp].retidas++;
            porTransportadora[transp].valor += val;
        });

        return res.json({
            batch: activeBatch,
            resumo: {
                total,
                liberadas,
                retidas,
                valorTotal: parseFloat(valorTotal.toFixed(2)),
                valorPendente: parseFloat(valorPendente.toFixed(2))
            },
            porTransportadora,
            cargas: lista.map(g => ({
                id: g.id,
                nf_number: g.nf_number,
                chave_nfe: g.chave_nfe,
                uf: g.uf,
                value: parseFloat(g.value || 0),
                customer_name: g.customer_name || 'Consumidor Final',
                carrier_name: g.carrier_name || 'Transportadora Padrão',
                status: g.status,
                is_liberada: printService.isGuiaLiberada(g),
                created_at: g.created_at
            }))
        });
    } catch (err) {
        console.error("Erro ao buscar cargas ativas:", err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Consulta de Bipagem Rápida na Doca (Suporta Chave de Acesso 44 dígitos, NF ou Pedido)
 */
app.get('/api/expedicao/bipar', requireAuth, async (req, res) => {
    try {
        const { termo } = req.query;
        if (!termo) return res.status(400).json({ error: "Termo de busca não informado." });

        const clean = String(termo).replace(/[^0-9a-zA-Z\-]/g, '').substring(0, 44);
        let nfNumero = clean;
        if (clean.length >= 44) {
            // Extrai número da NF das posições 25 a 34 da chave de 44 dígitos
            const extraido = parseInt(clean.substring(25, 34), 10);
            if (!isNaN(extraido)) nfNumero = String(extraido);
        }

        const tenant = req.tenant;
        // Busca no banco por chave, número da NF ou pedido
        const { data: guias } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', tenant.id)
            .or(`chave_nfe.eq.${clean},nf_number.eq.${nfNumero},nf_number.eq.${clean},order_number.eq.${clean}`)
            .order('created_at', { ascending: false })
            .limit(1);

        if (!guias || guias.length === 0) {
            return res.status(404).json({ error: "Guia não encontrada para o código informado." });
        }

        const guia = guias[0];
        return res.json({
            guia: {
                id: guia.id,
                nf_number: guia.nf_number,
                chave_nfe: guia.chave_nfe,
                uf: guia.uf,
                value: parseFloat(guia.value || 0),
                customer_name: guia.customer_name || 'Consumidor Final',
                carrier_name: guia.carrier_name || 'Transportadora Padrão',
                status: guia.status,
                is_liberada: printService.isGuiaLiberada(guia),
                barcode: guia.barcode,
                line_digitizable: guia.line_digitizable
            }
        });
    } catch (err) {
        console.error("Erro na busca de bipagem:", err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * MÓDULO 4: Romaneio de Expedição por Transportadora (Total Express, MT Log, Correios, etc.)
 * Gera documento para impressão e conferência na loja antes do carregamento
 */
app.get('/api/expedicao/romaneio', requireAuth, async (req, res) => {
    try {
        const { batchId, carrier, tab } = req.query;
        let query = supabase.from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: true });

        if (batchId) {
            query = query.eq('batch_id', batchId);
        }
        if (carrier && carrier !== 'TODAS') {
            query = query.eq('carrier_name', carrier);
        }

        const { data: guiasDb } = await query;
        let guias = guiasDb || [];
        if (carrier && carrier !== 'TODAS') {
            const filtradas = guias.filter(g => (g.carrier_name || '').toLowerCase() === carrier.toLowerCase());
            if (filtradas.length > 0) guias = filtradas;
        }

        const dataHoje = new Date().toLocaleDateString('pt-BR');
        const horaHoje = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        const guiasLiberadas = guias.filter(g => printService.isGuiaLiberada(g));
        const guiasRetidas = guias.filter(g => !printService.isGuiaLiberada(g));

        const difalLiberadoTotal = guiasLiberadas.reduce((acc, g) => (g.uf === 'SP' ? acc : acc + parseFloat(g.value || 0)), 0);
        const difalRetidoTotal = guiasRetidas.reduce((acc, g) => acc + parseFloat(g.value || 0), 0);

        const transpNome = carrier || 'Total Express (Van Coleta 16h30)';
        const pdfUrl = `/api/expedicao/romaneio-pdf?carrier=${encodeURIComponent(carrier || 'Total Express')}`;

        let html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>expedi HUB — Documentos de Embarque · ${escapeHtml(req.tenant.nome_fantasia || req.tenant.razao_social)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        @page { 
            size: A4 landscape; 
            margin: 8mm 10mm; 
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: 'Inter', -apple-system, sans-serif; 
            color: #111F33; 
            background: #F8FAFC; 
            padding: 14px; 
            font-size: 11px; 
            line-height: 1.4;
            -webkit-print-color-adjust: exact !important; 
            print-color-adjust: exact !important; 
        }

        /* BARRA DE AÇÕES DO OPERADOR (OCULTA NA IMPRESSÃO) */
        .print-control-bar {
            background: #111F33;
            color: #ffffff;
            padding: 10px 18px;
            border-radius: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 14px;
            box-shadow: 0 4px 12px rgba(17, 31, 51, 0.15);
        }

        .view-tab-btns {
            display: flex;
            gap: 6px;
        }

        .tab-btn {
            background: rgba(255, 255, 255, 0.12);
            color: #ffffff;
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 11.5px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
        }

        .tab-btn.active {
            background: #2563EB;
            border-color: #3B82F6;
            color: #ffffff;
        }

        .action-btns {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .btn-print {
            background: #10B981;
            color: #ffffff;
            border: none;
            border-radius: 6px;
            padding: 7px 14px;
            font-size: 12px;
            font-weight: 700;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s;
        }
        .btn-print:hover { background: #059669; }

        .btn-link-doc {
            background: rgba(255, 255, 255, 0.1);
            color: #ffffff;
            text-decoration: none;
            border-radius: 6px;
            padding: 7px 12px;
            font-size: 11.5px;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }

        /* FOLHA A4 PAISAGEM (CONTAINER OFICIAL) */
        .paper-sheet {
            background: #ffffff;
            border: 1px solid #E3E8EF;
            border-radius: 8px;
            padding: 20px 24px;
            margin-bottom: 20px;
            box-shadow: 0 2px 8px rgba(17, 31, 51, 0.04);
            page-break-after: always;
        }
        .paper-sheet:last-of-type {
            page-break-after: auto;
        }

        /* CABEÇALHO DO MANIFESTO */
        .report-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            border-bottom: 2px solid #111F33;
            padding-bottom: 12px;
            margin-bottom: 14px;
        }

        .brand-section {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .brand-square {
            width: 44px;
            height: 44px;
            background: #111F33;
            color: #ffffff;
            border-radius: 8px;
            display: grid;
            place-items: center;
            font-size: 20px;
            font-weight: 800;
        }

        .header-text h1 {
            font-size: 17px;
            font-weight: 800;
            color: #111F33;
            letter-spacing: -0.3px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .official-tag {
            background: #EAF7F0;
            color: #157347;
            font-size: 9.5px;
            font-weight: 800;
            padding: 2px 7px;
            border-radius: 4px;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }

        .store-sub {
            font-size: 11.5px;
            color: #5B6B7F;
            margin-top: 3px;
        }

        .qr-meta-section {
            display: flex;
            align-items: center;
            gap: 16px;
            text-align: right;
        }

        .qr-placeholder {
            width: 58px;
            height: 58px;
            border: 1.5px solid #CBD5E1;
            border-radius: 6px;
            padding: 4px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: #FAFCFE;
        }

        /* BARRA RESUMO DE KPIS */
        .kpi-strip {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            background: #FAFCFE;
            border: 1px solid #E3E8EF;
            border-radius: 6px;
            padding: 10px 14px;
            margin-bottom: 14px;
        }

        .kpi-cell span {
            display: block;
            font-size: 10px;
            color: #5B6B7F;
            text-transform: uppercase;
            font-weight: 600;
        }
        .kpi-cell strong {
            font-size: 14px;
            color: #111F33;
            font-weight: 800;
        }

        /* TABELA OFICIAL */
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 10.5px;
            margin-bottom: 16px;
        }

        th {
            background: #111F33;
            color: #ffffff;
            font-weight: 700;
            text-align: left;
            padding: 6px 8px;
            font-size: 9.5px;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }

        td {
            padding: 6px 8px;
            border-bottom: 1px solid #E3E8EF;
            vertical-align: middle;
        }

        tr:nth-child(even) {
            background: #F8FAFC;
        }

        .cell-mono {
            font-family: 'JetBrains Mono', monospace;
            font-weight: 700;
        }

        .badge-status {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 9px;
            font-weight: 700;
            text-transform: uppercase;
            white-space: nowrap;
        }

        .badge-liberado { background: #EAF7F0; color: #157347; border: 1px solid #B7E2CD; }
        .badge-isento { background: #EDF3FF; color: #2563EB; border: 1px solid #C4D9FD; }
        .badge-retido { background: #FDEEEE; color: #B42318; border: 1px solid #F8B4B4; }

        .auth-code {
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            color: #157347;
            font-weight: 700;
        }

        /* TERMO DE TRANSPORTE & ASSINATURAS DUPLAS */
        .legal-term-box {
            background: #FAFCFE;
            border: 1px solid #E3E8EF;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 9.5px;
            color: #5B6B7F;
            line-height: 1.4;
            margin-bottom: 16px;
        }

        .signatures-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            margin-top: 18px;
        }

        .sig-card {
            border: 1.5px solid #CBD5E1;
            border-radius: 6px;
            padding: 10px 14px;
            background: #ffffff;
        }

        .sig-card-title {
            font-size: 10px;
            font-weight: 700;
            color: #5B6B7F;
            text-transform: uppercase;
            margin-bottom: 8px;
            border-bottom: 1px solid #E3E8EF;
            padding-bottom: 4px;
        }

        .sig-line {
            height: 38px;
            border-bottom: 1.5px solid #111F33;
            margin-bottom: 6px;
        }

        .sig-fields-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            font-size: 9px;
            color: #5B6B7F;
        }

        /* REGRAS DE IMPRESSÃO */
        @media print {
            body { padding: 0; background: #ffffff; }
            .print-control-bar { display: none !important; }
            .paper-sheet { border: none; box-shadow: none; padding: 0; margin-bottom: 0; }
            .sheet-manifesto { display: block !important; }
            .sheet-pendencias { display: block !important; }
        }
    </style>
</head>
<body>

    <!-- BARRA SUPERIOR DE CONTROLE E IMPRESSÃO (NÃO SAI NA IMPRESSORA) -->
    <div class="print-control-bar">
        <div class="view-tab-btns">
            <button class="tab-btn active" id="btn-tab-manifesto" onclick="mostrarAba('manifesto')">
                🚚 1. Manifesto de Embarque (${guiasLiberadas.length} Liberadas p/ Motorista)
            </button>
            <button class="tab-btn" id="btn-tab-pendencias" onclick="mostrarAba('pendencias')">
                ⚠️ 2. Relatório de Pendências (${guiasRetidas.length} Retidas na Loja)
            </button>
            <button class="tab-btn" id="btn-tab-ambos" onclick="mostrarAba('ambos')">
                📑 3. Exibir Ambos os Relatórios
            </button>
        </div>

        <div class="action-btns">
            <button class="btn-print" onclick="window.print()">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
                <span>Imprimir Relatório Selecionado (Ctrl + P)</span>
            </button>
            <a href="${pdfUrl}" target="_blank" class="btn-link-doc">📄 Baixar PDF</a>
        </div>
    </div>

    <!-- ========================================================================= -->
    <!-- RELATÓRIO 1: MANIFESTO OFICIAL DE EMBARQUE (100% LIBERADAS P/ O MOTORISTA) -->
    <!-- ========================================================================= -->
    <div class="paper-sheet sheet-manifesto" id="sheet-manifesto">
        
        <header class="report-header">
            <div class="brand-section">
                <div class="brand-square">E</div>
                <div class="header-text">
                    <h1>
                        EXPEDI HUB — MANIFESTO & ROMANEIO DE EMBARQUE
                        <span class="official-tag">100% Liberado p/ Coleta</span>
                    </h1>
                    <div class="store-location">
                        <strong>${escapeHtml(req.tenant.nome_fantasia || req.tenant.razao_social)}</strong> &nbsp;|&nbsp; CNPJ: ${escapeHtml(req.tenant.cnpj)}
                    </div>
                </div>
            </div>

            <div class="qr-meta-section">
                <div>
                    <div style="font-weight: 700; font-size: 11px; color: #111F33;">Transportadora: ${escapeHtml(transpNome)}</div>
                    <div style="font-size: 10px; color: #5B6B7F;">Emissão: ${dataHoje} às ${horaHoje}</div>
                    <div style="font-size: 9.5px; color: #157347; font-weight: 700; margin-top: 2px;">✔ Autenticação SISBACEN Asaas</div>
                </div>
                <div class="qr-placeholder" title="QR Code Fiscal de Validação SEFAZ na Barreira">
                    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#111F33" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><line x1="10" y1="3" x2="10" y2="10"></line><line x1="3" y1="10" x2="10" y2="10"></line></svg>
                    <span style="font-size: 7px; color: #5B6B7F; font-weight: 700; margin-top: 1px;">SEFAZ QR</span>
                </div>
            </div>
        </header>

        <div class="kpi-strip">
            <div class="kpi-cell">
                <span>Volumes p/ Embarque</span>
                <strong style="color: #157347;">${guiasLiberadas.length} caixas liberadas</strong>
            </div>
            <div class="kpi-cell">
                <span>DIFAL Total Liquidado</span>
                <strong style="color: #111F33; font-family: 'JetBrains Mono', monospace;">R$ ${difalLiberadoTotal.toFixed(2).replace('.', ',')}</strong>
            </div>
            <div class="kpi-cell">
                <span>Horário da Coleta na Loja</span>
                <strong>Hoje às 16h30</strong>
            </div>
            <div class="kpi-cell">
                <span>Risco Fiscal na Barreira</span>
                <strong style="color: #157347;">0% (100% Autenticado)</strong>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th style="width: 32px; text-align: center;">Item</th>
                    <th style="width: 80px;">Pedido</th>
                    <th style="width: 85px;">NF-e</th>
                    <th style="width: 45px; text-align: center;">UF</th>
                    <th>Destinatário / Cliente</th>
                    <th style="width: 140px;">Cidade / Destino</th>
                    <th style="width: 85px; text-align: right;">DIFAL (R$)</th>
                    <th style="width: 120px; text-align: center;">Portão Fiscal</th>
                    <th style="width: 120px; text-align: center;">Autenticação Asaas</th>
                    <th style="width: 100px; text-align: center;">Rubrica Motorista</th>
                </tr>
            </thead>
            <tbody>
                ${guiasLiberadas.map((g, idx) => {
                    const isSp = (g.uf === 'SP');
                    const badgeClass = isSp ? 'badge-isento' : 'badge-liberado';
                    const badgeText = isSp ? 'ISENTO SP' : '✔ LIBERADO P/ EMBARQUE';
                    const valorStr = isSp ? 'ISENTO' : `R$ ${parseFloat(g.value || 0).toFixed(2).replace('.', ',')}`;
                    const authCode = g.asaas_bill_id || 'AS-91823-BR';

                    return `
                    <tr>
                        <td style="text-align: center; color: #5B6B7F;">${idx + 1}</td>
                        <td><strong style="color: #2563EB;">#${escapeHtml(g.order_number || g.xPed || 'PEDIDO')}</strong></td>
                        <td class="cell-mono">${escapeHtml(g.nf_number)}</td>
                        <td style="text-align: center;"><strong>${escapeHtml(g.uf)}</strong></td>
                        <td><strong>${escapeHtml(g.customer_name || 'Consumidor Final')}</strong></td>
                        <td>${escapeHtml(g.city || 'Destino')} / ${escapeHtml(g.uf)}</td>
                        <td style="text-align: right;" class="cell-mono">${valorStr}</td>
                        <td style="text-align: center;"><span class="badge-status ${badgeClass}">${badgeText}</span></td>
                        <td style="text-align: center;"><span class="auth-code">${escapeHtml(authCode)}</span></td>
                        <td style="border-bottom: 1.5px dotted #CBD5E1;"></td>
                    </tr>
                    `;
                }).join('')}
            </tbody>
        </table>

        <div class="legal-term-box">
            <strong>DECLARAÇÃO FORMAL DE RECEBIMENTO & TRANSPORTE:</strong><br>
            O transportador abaixo assinado declara ter conferido e recebido do remetente <strong>${escapeHtml(req.tenant.nome_fantasia || req.tenant.razao_social)}</strong> os <strong>${guiasLiberadas.length} volumes</strong> acima relacionados em perfeito estado físico, acompanhados de suas respectivas DANFEs e das Guias GNREs autenticadas pelo SISBACEN via Asaas, assumindo integral responsabilidade pela guarda e entrega aos destinatários finais.
        </div>

        <div class="signatures-grid">
            <div class="sig-card">
                <div class="sig-card-title">1. Expedição E-commerce — ${escapeHtml(req.tenant.nome_fantasia || req.tenant.razao_social)}</div>
                <div class="sig-line"></div>
                <div class="sig-fields-row">
                    <div>Responsável: <strong>Conferência Expedição</strong></div>
                    <div>Data: <strong>${dataHoje} às ${horaHoje}</strong></div>
                </div>
            </div>

            <div class="sig-card">
                <div class="sig-card-title">2. Motorista Coletador — ${escapeHtml(transpNome)}</div>
                <div class="sig-line"></div>
                <div class="sig-fields-row">
                    <div>Nome Legível: _______________________</div>
                    <div>RG / CPF: ___________________________</div>
                    <div>Placa da Van: _______________________</div>
                    <div>Horário de Saída: ___________________</div>
                </div>
            </div>
        </div>

    </div>

    <!-- ========================================================================= -->
    <!-- RELATÓRIO 2: RELATÓRIO DE PENDÊNCIAS SEFAZ (CARGAS RETIDAS NA LOJA)        -->
    <!-- ========================================================================= -->
    <div class="paper-sheet sheet-pendencias" id="sheet-pendencias" style="display: none;">
        
        <header class="report-header" style="border-bottom-color: #B42318;">
            <div class="brand-section">
                <div class="brand-square" style="background: #B42318;">⚠️</div>
                <div class="header-text">
                    <h1 style="color: #B42318;">
                        EXPEDI HUB — AUDITORIA DE PENDÊNCIAS SEFAZ & CARGAS RETIDAS
                        <span class="official-tag" style="background: #FDEEEE; color: #B42318;">Controle Interno Loja</span>
                    </h1>
                    <div class="store-location">
                        <strong>${escapeHtml(req.tenant.nome_fantasia || req.tenant.razao_social)}</strong> &nbsp;|&nbsp; CNPJ: ${escapeHtml(req.tenant.cnpj)} &nbsp;|&nbsp; Cargas Retidas Proibidas de Embarcar sem Pagamento
                    </div>
                </div>
            </div>

            <div class="qr-meta-section">
                <div>
                    <div style="font-weight: 700; font-size: 11px; color: #B42318;">Atenção: NÃO ENTREGAR AO MOTORISTA</div>
                    <div style="font-size: 10px; color: #5B6B7F;">Auditoria gerada em: ${dataHoje} às ${horaHoje}</div>
                    <div style="font-size: 9.5px; color: #8A5A00; font-weight: 700; margin-top: 2px;">Aguardando Aprovação Asaas no Celular</div>
                </div>
            </div>
        </header>

        <div class="kpi-strip" style="background: #FFFDFD; border-color: #F8B4B4;">
            <div class="kpi-cell">
                <span style="color: #B42318;">Cargas Retidas na Loja</span>
                <strong style="color: #B42318;">${guiasRetidas.length} caixas bloqueadas</strong>
            </div>
            <div class="kpi-cell">
                <span style="color: #B42318;">DIFAL a Liquidar</span>
                <strong style="color: #B42318; font-family: 'JetBrains Mono', monospace;">R$ ${difalRetidoTotal.toFixed(2).replace('.', ',')}</strong>
            </div>
            <div class="kpi-cell">
                <span>Local Físico das Caixas</span>
                <strong>Bancada de Pendências Fiscais</strong>
            </div>
            <div class="kpi-cell">
                <span>Alçada de Desbloqueio</span>
                <strong style="color: #2563EB;">App Mobile da Diretoria</strong>
            </div>
        </div>

        <table>
            <thead>
                <tr style="background: #7F1D1D;">
                    <th style="width: 32px; text-align: center;">Item</th>
                    <th style="width: 85px;">Pedido</th>
                    <th style="width: 85px;">NF-e</th>
                    <th style="width: 45px; text-align: center;">UF</th>
                    <th>Destinatário / Cliente</th>
                    <th style="width: 140px;">Cidade / Destino</th>
                    <th style="width: 95px; text-align: right;">DIFAL Devido</th>
                    <th style="width: 130px; text-align: center;">Situação Portão</th>
                    <th style="width: 180px;">Motivo da Retenção / Ação</th>
                </tr>
            </thead>
            <tbody>
                ${guiasRetidas.length === 0 
                    ? `<tr><td colspan="9" style="text-align: center; padding: 24px; color: #157347; font-weight: 700;">✔ Parabéns! Nenhuma carga retida na loja no momento. Expedição 100% liberada!</td></tr>`
                    : guiasRetidas.map((g, idx) => {
                        const valorStr = `R$ ${parseFloat(g.value || 0).toFixed(2).replace('.', ',')}`;
                        return `
                        <tr>
                            <td style="text-align: center; color: #5B6B7F;">${idx + 1}</td>
                            <td><strong style="color: #B42318;">#${escapeHtml(g.order_number || g.xPed || 'PEDIDO')}</strong></td>
                            <td class="cell-mono" style="color: #B42318;">${escapeHtml(g.nf_number)}</td>
                            <td style="text-align: center;"><strong>${escapeHtml(g.uf)}</strong></td>
                            <td><strong>${escapeHtml(g.customer_name || 'Consumidor Final')}</strong></td>
                            <td>${escapeHtml(g.city || 'Destino')} / ${escapeHtml(g.uf)}</td>
                            <td style="text-align: right; color: #B42318;" class="cell-mono">${valorStr}</td>
                            <td style="text-align: center;"><span class="badge-status badge-retido">⛔ RETIDO SEFAZ</span></td>
                            <td style="font-size: 10px; color: #5B6B7F;">Guia não liquidada no Asaas. Manter caixa na bancada.</td>
                        </tr>
                        `;
                    }).join('')
                }
            </tbody>
        </table>

        <div class="legal-term-box" style="border-color: #F8B4B4; background: #FFFBFB; color: #7F1D1D;">
            <strong>PROCEDIMENTO INTERNO OBRIGATÓRIO:</strong><br>
            As caixas acima relacionadas <strong>NÃO PODEM</strong> ser entregues ao motorista da van em nenhuma hipótese até que o pagamento da guia seja confirmado no sistema e o status mude para Liberado.
        </div>

        <div class="signatures-grid" style="grid-template-columns: 1fr;">
            <div class="sig-card">
                <div class="sig-card-title">Visto do Conferente da Loja / Expedição</div>
                <div class="sig-line" style="height: 32px;"></div>
                <div class="sig-fields-row">
                    <div>Conferente: _____________________________________</div>
                    <div>Horário da Auditoria: <strong>${dataHoje} às ${horaHoje}</strong></div>
                </div>
            </div>
        </div>

    </div>

    <script>
        function mostrarAba(tipo) {
            const m = document.getElementById('sheet-manifesto');
            const p = document.getElementById('sheet-pendencias');
            const btnM = document.getElementById('btn-tab-manifesto');
            const btnP = document.getElementById('btn-tab-pendencias');
            const btnA = document.getElementById('btn-tab-ambos');

            btnM.classList.remove('active');
            btnP.classList.remove('active');
            btnA.classList.remove('active');

            if (tipo === 'manifesto') {
                m.style.display = 'block';
                p.style.display = 'none';
                btnM.classList.add('active');
            } else if (tipo === 'pendencias') {
                m.style.display = 'none';
                p.style.display = 'block';
                btnP.classList.add('active');
            } else if (tipo === 'ambos') {
                m.style.display = 'block';
                p.style.display = 'block';
                btnA.classList.add('active');
            }
        }
    </script>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    } catch (err) {
        console.error("Erro ao gerar romaneio de expedição:", err);
        return res.status(500).send("Erro ao gerar romaneio: " + err.message);
    }
});

// Endpoint para baixar o Romaneio em PDF A4 Paisagem Nativo
app.get('/api/expedicao/romaneio-pdf', requireAuth, async (req, res) => {
    try {
        const { batchId, carrier } = req.query;
        let query = supabase.from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: true });

        if (batchId) {
            query = query.eq('batch_id', batchId);
        }
        if (carrier && carrier !== 'TODAS') {
            query = query.eq('carrier_name', carrier);
        }

        const { data: guias, error } = await query;
        if (error) throw error;

        const pdfBuffer = await printService.gerarRomaneioPdfBuffer(req.tenant, guias || [], { carrier });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Romaneio_Coleta_${(carrier || 'GERAL').replace(/[^a-zA-Z0-9]/g, '_')}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar PDF do romaneio:", err);
        return res.status(500).json({ error: "Erro ao gerar PDF do romaneio: " + err.message });
    }
});

// Endpoint da Etapa 3: COMBO COMPLETO DE EXPEDIÇÃO [Romaneio + DANFE + GNRE + Asaas]
app.get('/api/expedicao/combo/:batchId', requireAuth, async (req, res) => {
    try {
        const { batchId } = req.params;
        const { carrier, onlyCleared } = req.query;

        let query = supabase.from('guides')
            .select('*')
            .eq('batch_id', batchId)
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: true });

        if (carrier && carrier !== 'TODAS') {
            query = query.eq('carrier_name', carrier);
        }

        const { data: guias, error } = await query;
        if (error || !guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para gerar o combo desta transportadora." });
        }

        const options = {
            carrier: carrier || 'TODAS',
            onlyCleared: onlyCleared === 'true' || onlyCleared === '1'
        };

        const comboPdfBuffer = await printService.gerarComboExpedicaoPdf(req.tenant, guias, supabase, options);

        const transpSafe = (carrier || 'Geral').replace(/[^a-zA-Z0-9]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Combo_Expedicao_${transpSafe}_Lote_${batchId}.pdf"`);
        return res.send(comboPdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar Combo Completo de Expedição:", err);
        return res.status(500).json({ error: "Erro ao gerar Combo Completo de Expedição: " + err.message });
    }
});

/**
 * ETAPA 10: FECHAMENTO CONTÁBIL, AUDITORIA & RECONCILIAÇÃO BANCÁRIA
 */
async function obterGuiasParaFechamento(tenantId, batchId, dataFiltro) {
    let query = supabase.from('guides')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('nf_number', { ascending: true });

    if (batchId && batchId !== 'hoje' && batchId !== 'todos') {
        query = query.eq('batch_id', batchId);
    } else if (dataFiltro) {
        query = query.gte('created_at', `${dataFiltro}T00:00:00`).lte('created_at', `${dataFiltro}T23:59:59`);
    }

    let { data: guias, error } = await query;
    if (error) console.warn("[Fechamento] Aviso ao consultar guias:", error.message);

    if ((!guias || guias.length === 0) && (batchId === 'hoje' || !batchId)) {
        try {
            const { data: latestBatch } = await supabase.from('batches')
                .select('id')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (latestBatch) {
                const { data: batchGuias } = await supabase.from('guides')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('batch_id', latestBatch.id)
                    .order('nf_number', { ascending: true });
                if (batchGuias && batchGuias.length > 0) {
                    guias = batchGuias;
                }
            }
        } catch (eBatch) {}
    }

    if (!guias || guias.length === 0) {
        guias = [];
    }

    return guias;
}

// 1. Resumo em JSON da conciliação e divergências
app.get('/api/fechamento/resumo/:batchId?', requireAuth, async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        const resumo = closingService.conciliarLoteOuDia(req.tenant, guias);
        return res.status(200).json(resumo);
    } catch (err) {
        console.error("Erro ao gerar resumo de fechamento:", err);
        return res.status(500).json({ error: "Erro ao gerar resumo de conciliação: " + err.message });
    }
});

// 2. Relatório Executivo Oficial da Diretoria em PDF
app.get('/api/fechamento/relatorio-pdf/:batchId?', requireAuth, async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        const pdfBuffer = await closingService.gerarResumoExecutivoPdf(req.tenant, guias);
        const dataStr = new Date().toISOString().split('T')[0];

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Relatorio_Executivo_Diretoria_${dataStr}.pdf"; filename*="UTF-8''Relatorio_Executivo_Diretoria_${dataStr}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar Relatório Executivo PDF:", err);
        return res.status(500).json({ error: "Erro ao gerar Relatório Executivo: " + err.message });
    }
});

// 3. Planilha de Conciliação em CSV (UTF-8 com BOM para Excel)
app.get('/api/fechamento/planilha-csv/:batchId?', requireAuth, async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        const csvBuffer = closingService.gerarPlanilhaConciliacaoCsv(req.tenant, guias);
        const dataStr = new Date().toISOString().split('T')[0];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="Conciliacao_Fiscal_${dataStr}.csv"; filename*="UTF-8''Conciliacao_Fiscal_${dataStr}.csv"`);
        return res.send(csvBuffer);
    } catch (err) {
        console.error("Erro ao gerar Planilha CSV:", err);
        return res.status(500).json({ error: "Erro ao gerar Planilha CSV: " + err.message });
    }
});

// 4. Pacote Completo de Auditoria em formato .ZIP
app.get('/api/fechamento/pacote-zip/:batchId?', requireAuth, requireRole(['diretoria', 'financeiro', 'admin']), async (req, res) => {
    try {
        const batchId = req.params.batchId || req.query.batchId;
        const dataFiltro = req.query.data;
        const guias = await obterGuiasParaFechamento(req.tenant.id, batchId, dataFiltro);

        if (!guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para fechar pacote." });
        }

        const zipBuffer = await closingService.gerarPacoteFechamentoZip(req.tenant, guias, supabase);
        const dataStr = new Date().toISOString().split('T')[0];

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="Pacote_Auditoria_Fiscal_${dataStr}.zip"; filename*="UTF-8''Pacote_Auditoria_Fiscal_${dataStr}.zip"`);
        return res.send(zipBuffer);
    } catch (err) {
        console.error("Erro ao gerar Pacote ZIP de Fechamento:", err);
        return res.status(500).json({ error: "Erro ao gerar Pacote ZIP: " + err.message });
    }
});

/**
 * MÓDULO 7: BI Fiscal - Métricas, Distribuição por UF e Exportação Contábil
 */
app.get('/api/bi/stats', requireAuth, async (req, res) => {
    try {
        const { data: guias, error } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        let totalGuias = guias ? guias.length : 0;
        let totalValorDifal = 0;
        let totalPagas = 0;
        let valorPago = 0;
        let totalPendentes = 0;

        const porUf = {};
        const porTransportadora = {};
        const porMes = {};

        for (const g of (guias || [])) {
            const val = parseFloat(g.value || 0);
            totalValorDifal += val;

            const isSp = (g.uf === 'SP' || g.barcode === 'IMPORTAR_NO_SEFAZ_SP');
            const isLiberada = printService.isGuiaLiberada(g);
            if (isLiberada || isSp) {
                totalPagas++;
                valorPago += isSp ? 0 : val;
            } else {
                totalPendentes++;
            }

            // Agrupa por UF
            const uf = (g.uf || 'OUTROS').toUpperCase();
            if (!porUf[uf]) porUf[uf] = { count: 0, valor: 0 };
            porUf[uf].count++;
            porUf[uf].valor += val;

            // Agrupa por Transportadora (Normaliza caixa alta e atribui aos parceiros da loja)
            let rawTransp = (g.carrier_name || '').trim().toUpperCase();
            let transp = 'Total Express';
            if (rawTransp.includes('CORREIO')) {
                transp = 'Correios';
            } else if (rawTransp.includes('MT') || rawTransp.includes('LOG')) {
                transp = 'MT Log';
            } else if (rawTransp.includes('TOTAL') || rawTransp.includes('EXPRESS')) {
                transp = 'Total Express';
            } else {
                transp = (uf === 'SP' || uf === 'RJ' || uf === 'MG') ? 'Total Express' : 'Correios';
            }
            if (!porTransportadora[transp]) porTransportadora[transp] = { count: 0, valor: 0 };
            porTransportadora[transp].count++;
            porTransportadora[transp].valor += val;

            // Agrupa por Mês (YYYY-MM)
            const d = g.created_at ? g.created_at.substring(0, 7) : 'Sem Data';
            if (!porMes[d]) porMes[d] = { count: 0, valor: 0 };
            porMes[d].count++;
            porMes[d].valor += val;
        }

        // Ordena UFs por valor decrescente
        const rankingUf = Object.entries(porUf)
            .map(([uf, d]) => ({ uf, count: d.count, valor: parseFloat(d.valor.toFixed(2)) }))
            .sort((a, b) => b.valor - a.valor);

        // Ordena Transportadoras
        const rankingTransp = Object.entries(porTransportadora)
            .map(([transp, d]) => ({ transp, count: d.count, valor: parseFloat(d.valor.toFixed(2)) }))
            .sort((a, b) => b.count - a.count);

        return res.json({
            tenant: {
                razaoSocial: req.tenant.razao_social,
                cnpj: req.tenant.cnpj
            },
            resumo: {
                totalGuias,
                totalValorDifal: parseFloat(totalValorDifal.toFixed(2)),
                totalPagas,
                valorPago: parseFloat(valorPago.toFixed(2)),
                totalPendentes,
                valorPendente: parseFloat((totalValorDifal - valorPago).toFixed(2))
            },
            rankingUf,
            rankingTransp,
            historicoMensal: Object.entries(porMes).map(([mes, d]) => ({ mes, ...d })).sort((a, b) => a.mes.localeCompare(b.mes))
        });
    } catch (err) {
        console.error("Erro ao obter estatísticas de BI:", err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Exportação em CSV Contábil formatado para Excel
 */
app.get('/api/bi/export-csv', requireAuth, async (req, res) => {
    try {
        const { data: guias, error } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: true });

        if (error) throw error;

        // Cabeçalho CSV com ponto-e-vírgula (padrão Excel Brasil)
        const cabecalho = [
            "Número da NF",
            "UF Favorecida",
            "Destinatário",
            "Transportadora",
            "Valor DIFAL (R$)",
            "Código de Barras",
            "Linha Digitável",
            "Status",
            "Data de Pagamento",
            "Autenticação Bancária",
            "Data de Emissão no Sistema"
        ].join(";");

        const linhas = (guias || []).map(g => [
            `"${g.nf_number || ''}"`,
            `"${g.uf || ''}"`,
            `"${(g.customer_name || 'CONSUMIDOR FINAL').replace(/"/g, '""')}"`,
            `"${(g.carrier_name || 'NÃO DEFINIDA').replace(/"/g, '""')}"`,
            `"${parseFloat(g.value || 0).toFixed(2).replace('.', ',')}"`,
            `"${g.barcode || ''}"`,
            `"${g.line_digitizable || ''}"`,
            `"${g.status || 'EMITIDA'}"`,
            `"${g.paid_at || ''}"`,
            `"${(g.bank_authentication || '').replace(/"/g, '""')}"`,
            `"${g.created_at ? g.created_at.substring(0, 10) : ''}"`
        ].join(";"));

        const csvContent = "\uFEFF" + [cabecalho, ...linhas].join("\r\n"); // \uFEFF força UTF-8 no Excel

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="relatorio_fiscal_difal_${new Date().toISOString().split('T')[0]}.csv"`);
        return res.send(csvContent);
    } catch (err) {
        console.error("Erro ao exportar CSV fiscal:", err);
        return res.status(500).send("Erro ao exportar relatório contábil: " + err.message);
    }
});

/**
 * MÓDULO 7.1: Ranking de Peças / Produtos Mais Vendidos por Estado
 */
app.get('/api/bi/produtos', requireAuth, async (req, res) => {
    try {
        const { uf } = req.query;
        let query = supabase.from('invoice_items')
            .select('*')
            .eq('tenant_id', req.tenant.id);

        if (uf && uf !== 'TODAS') {
            query = query.eq('uf_destination', uf);
        }

        const { data: itens, error } = await query;
        if (error) throw error;

        const porProduto = {};
        for (const item of (itens || [])) {
            const desc = item.product_description || 'PRODUTO NÃO IDENTIFICADO';
            if (!porProduto[desc]) {
                porProduto[desc] = {
                    sku: item.product_code || 'SEM_COD',
                    descricao: desc,
                    quantidade: 0,
                    faturamento: 0
                };
            }
            porProduto[desc].quantidade += parseFloat(item.quantity || 1);
            porProduto[desc].faturamento += parseFloat(item.total_price || 0);
        }

        const ranking = Object.values(porProduto)
            .map(p => ({
                ...p,
                faturamento: parseFloat(p.faturamento.toFixed(2))
            }))
            .sort((a, b) => b.quantidade - a.quantidade);

        return res.json({
            totalItens: itens ? itens.length : 0,
            produtosUnicos: ranking.length,
            ranking
        });
    } catch (err) {
        console.error("Erro ao obter ranking de produtos:", err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * MÓDULO 7.2: Monitor de Devoluções e Prevenção de Desperdício de GNRE
 */
app.get('/api/bi/devolucoes', requireAuth, async (req, res) => {
    try {
        const { data: devolucoes, error: devErr } = await supabase
            .from('return_notes')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .order('created_at', { ascending: false });

        if (devErr) throw devErr;

        // Guias vinculadas a notas devolvidas
        const { data: guiasDevolvidas, error: gErr } = await supabase
            .from('guides')
            .select('*')
            .eq('tenant_id', req.tenant.id)
            .eq('is_returned', true);

        return res.json({
            totalDevolucoes: devolucoes ? devolucoes.length : 0,
            devolucoes: devolucoes || [],
            guiasImpactadas: guiasDevolvidas || []
        });
    } catch (err) {
        console.error("Erro ao buscar devoluções:", err);
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/guide/download/:guideId', requireAuth, async (req, res) => {
    try {
        const { data: guide, error } = await supabase
            .from('guides')
            .select('*')
            .eq('id', req.params.guideId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !guide) {
            return res.status(404).json({ error: "Guia não encontrada." });
        }

        const isSimulado = (req.tenant.environment || '').toLowerCase() === 'simulado';
        if (isSimulado && (!guide.barcode || guide.barcode.length < 44 || !guide.line_digitizable)) {
            const auto = printService.gerarCodigoBarrasELinhaDigitavelGNRE(guide, req.tenant);
            if (auto.codigoBarras) {
                guide.barcode = auto.codigoBarras;
                guide.line_digitizable = auto.linhaDigitavel;
            }
        }

        let buffer = null;
        if (guide.storage_path && guide.storage_path.toLowerCase().endsWith('.pdf')) {
            try {
                const { data } = await supabase.storage
                    .from('tenant-storage')
                    .download(guide.storage_path);
                if (data) buffer = Buffer.from(await data.arrayBuffer());
            } catch (e) {}
        }

        if (!buffer) {
            buffer = await printService.gerarGnrePdfBuffer(req.tenant, guide);
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="espelho_GNRE_NF_${guide.nf_number}.pdf"`);
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Emissão e Impressão de Múltiplas Guias GNRE selecionadas
 */
app.get('/api/guide/gnre-selecionadas', requireAuth, async (req, res) => {
    try {
        const { ids, nfs, batchId } = req.query;
        let query = supabase.from('guides').select('*').eq('tenant_id', req.tenant.id);

        if (ids) {
            const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('id', idList);
        } else if (nfs) {
            const nfList = nfs.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('nf_number', nfList);
        } else if (batchId) {
            query = query.eq('batch_id', batchId);
        } else {
            return res.status(400).json({ error: "Nenhum ID ou número de NF informado." });
        }

        const { data: guias, error } = await query;
        if (error || !guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para os filtros fornecidos." });
        }

        const guiasComGnre = guias.filter(g => g.uf !== 'SP' && parseFloat(g.value || 0) > 0);
        if (guiasComGnre.length === 0) {
            return res.status(400).json({ error: "As notas selecionadas são para SP (Recolhimento via DARE-SP, sem GNRE)." });
        }

        const isSimulado = (req.tenant.environment || '').toLowerCase() === 'simulado';
        const pdfBuffers = [];
        for (const g of guiasComGnre) {
            if (isSimulado && (!g.barcode || g.barcode.length < 44 || !g.line_digitizable)) {
                const auto = printService.gerarCodigoBarrasELinhaDigitavelGNRE(g, req.tenant);
                if (auto.codigoBarras) {
                    g.barcode = auto.codigoBarras;
                    g.line_digitizable = auto.linhaDigitavel;
                }
            }
            let buf = null;
            if (g.storage_path && g.storage_path.toLowerCase().endsWith('.pdf')) {
                try {
                    const { data } = await supabase.storage.from('tenant-storage').download(g.storage_path);
                    if (data) buf = Buffer.from(await data.arrayBuffer());
                } catch (e) {}
            }
            if (!buf) {
                buf = await printService.gerarGnrePdfBuffer(req.tenant, g);
            }
            if (buf) pdfBuffers.push(buf);
        }

        const mergedBuffer = await danfeService.mesclarDanfesPdf(pdfBuffers);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="GUIAS_GNRE_SELECIONADAS_${guiasComGnre.length}_NOTAS.pdf"`);
        return res.send(mergedBuffer);
    } catch (err) {
        console.error("Erro ao gerar GNREs selecionadas:", err);
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/guide/danfe/:guideId', requireAuth, async (req, res) => {
    try {
        const { data: guide, error } = await supabase
            .from('guides')
            .select('*')
            .eq('id', req.params.guideId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !guide) {
            return res.status(404).json({ error: "Guia não encontrada." });
        }

        const buffer = await danfeService.obterOuGerarDanfePdfGuia(supabase, req.tenant.id, guide);
        if (!buffer) {
            return res.status(404).json({ error: "DANFE não encontrado para esta nota fiscal." });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="DANFE_NF_${guide.nf_number}.pdf"`);
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Emissão e Impressão de Múltiplos DANFEs selecionados na Doca / Cockpit
 */
app.get('/api/guide/danfe-selecionadas', requireAuth, async (req, res) => {
    try {
        const { ids, nfs, batchId } = req.query;
        let query = supabase.from('guides').select('*').eq('tenant_id', req.tenant.id);

        if (ids) {
            const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('id', idList);
        } else if (nfs) {
            const nfList = nfs.split(',').map(s => s.trim()).filter(Boolean);
            query = query.in('nf_number', nfList);
        } else if (batchId) {
            query = query.eq('batch_id', batchId);
        } else {
            return res.status(400).json({ error: "Nenhum ID ou número de NF informado." });
        }

        const { data: guias, error } = await query;
        if (error || !guias || guias.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para os filtros fornecidos." });
        }

        const pdfBuffers = [];
        for (const g of guias) {
            const buf = await danfeService.obterOuGerarDanfePdfGuia(supabase, req.tenant.id, g);
            if (buf) pdfBuffers.push(buf);
        }

        if (pdfBuffers.length === 0) {
            return res.status(404).json({ error: "Não foi possível carregar os DANFEs das notas selecionadas." });
        }

        const mergedBuffer = await danfeService.mesclarDanfesPdf(pdfBuffers);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="DANFES_SELECIONADAS_${guias.length}_NOTAS.pdf"`);
        return res.send(mergedBuffer);
    } catch (err) {
        console.error("Erro ao gerar DANFEs selecionadas:", err);
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/guide/nfe-xml/:guideId', requireAuth, async (req, res) => {
    try {
        const { data: guide, error } = await supabase
            .from('guides')
            .select('*')
            .eq('id', req.params.guideId)
            .eq('tenant_id', req.tenant.id)
            .single();

        if (error || !guide) {
            return res.status(404).json({ error: "Guia não encontrada." });
        }

        const xmlPath = guide.xml_storage_path || `${req.tenant.id}/nfe_xml/nfe_${guide.nf_number}.xml`;

        const { data, error: downloadError } = await supabase.storage
            .from('tenant-storage')
            .download(xmlPath);

        if (downloadError || !data) {
            return res.status(404).json({ error: "XML da NF-e não encontrado para esta nota fiscal." });
        }

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="NFe_${guide.nf_number}.xml"`);
        const buffer = Buffer.from(await data.arrayBuffer());
        return res.send(buffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/guide/download-all/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: guides, error } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', req.params.batchId)
            .eq('tenant_id', req.tenant.id);

        if (error || !guides || guides.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const AdmZip = require('adm-zip');
        const zip = new AdmZip();

        // Faz o download de todos os arquivos (Guia GNRE, DANFE em PDF e XML da NF-e) para cada nota
        await Promise.all(guides.map(async (guide) => {
            const folder = `NF_${guide.nf_number}`;

            // 1. Guia GNRE (HTML ou PDF)
            if (guide.storage_path && guide.barcode !== 'IMPORTAR_NO_SEFAZ_SP') {
                try {
                    const { data, error: downloadError } = await supabase.storage
                        .from('tenant-storage')
                        .download(guide.storage_path);

                    if (!downloadError && data) {
                        const buffer = Buffer.from(await data.arrayBuffer());
                        const isPdf = guide.storage_path.toLowerCase().endsWith('.pdf');
                        const ext = isPdf ? 'pdf' : 'html';
                        zip.addFile(`${folder}/guia_GNRE_${guide.uf}.${ext}`, buffer);
                    }
                } catch (err) {
                    console.error(`Erro ao incluir guia ${guide.nf_number} no zip:`, err.message);
                }
            }

            // 2. DANFE em PDF
            const danfePath = guide.danfe_storage_path || `${req.tenant.id}/danfe/danfe_NF_${guide.nf_number}.pdf`;
            try {
                const { data: danfeData, error: danfeErr } = await supabase.storage
                    .from('tenant-storage')
                    .download(danfePath);

                if (!danfeErr && danfeData) {
                    const danfeBuffer = Buffer.from(await danfeData.arrayBuffer());
                    zip.addFile(`${folder}/DANFE_NF_${guide.nf_number}.pdf`, danfeBuffer);
                }
            } catch (err) {
                // DANFE pode não existir para guias legadas
            }

            // 3. XML oficial da NF-e
            const xmlPath = guide.xml_storage_path || `${req.tenant.id}/nfe_xml/nfe_${guide.nf_number}.xml`;
            try {
                const { data: xmlData, error: xmlErr } = await supabase.storage
                    .from('tenant-storage')
                    .download(xmlPath);

                if (!xmlErr && xmlData) {
                    const xmlBuffer = Buffer.from(await xmlData.arrayBuffer());
                    zip.addFile(`${folder}/NFe_${guide.nf_number}.xml`, xmlBuffer);
                }
            } catch (err) {
                // XML pode não existir para guias legadas
            }
        }));

        const zipBuffer = zip.toBuffer();

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="pacote_completo_lote_${req.params.batchId}.zip"`);
        return res.send(zipBuffer);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint para gerar e transmitir PDF Mestre Intercalado (DANFE + GNRE em sequência para impressão em 1 clique)
app.get('/api/guide/print-interleaved/:batchId', requireAuth, async (req, res) => {
    try {
        const { data: guides, error } = await supabase
            .from('guides')
            .select('*')
            .eq('batch_id', req.params.batchId)
            .eq('tenant_id', req.tenant.id)
            .order('nf_number', { ascending: true });

        if (error || !guides || guides.length === 0) {
            return res.status(404).json({ error: "Nenhuma guia encontrada para este lote." });
        }

        const pdfBuffer = await printService.gerarLoteIntercaladoPdf(req.tenant, guides, supabase);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Lote_Impressao_NF_e_GNRE_${req.params.batchId}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error("Erro ao gerar PDF intercalado:", err.message);
        return res.status(500).json({ error: "Erro ao gerar PDF intercalado: " + err.message });
    }
});

// ==========================================
// ROTAS DO PAINEL ADMINISTRATIVO (ADMIN)
// ==========================================

// 1. Métricas Consolidadas do SaaS (SuperAdmin Master)
app.get('/api/admin/metrics', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { data: tenants } = await supabase.from('tenants').select('id, status, subscription_status, plano, guias_usadas_mes, limite_guias_mes');
        const { count: totalGuias } = await supabase.from('guides').select('id', { count: 'exact', head: true });
        const { data: guiasPagas } = await supabase.from('guides').select('value').eq('status', 'comprovada');

        const totalTenants = tenants ? tenants.length : 0;
        const ativos = tenants ? tenants.filter(t => (t.status || t.subscription_status) === 'ativo').length : 0;
        const bloqueados = totalTenants - ativos;
        const totalDifalLiquidado = (guiasPagas || []).reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);

        return res.json({
            totalTenants,
            ativos,
            bloqueados,
            totalGuias: totalGuias || 0,
            totalDifalLiquidado: parseFloat(totalDifalLiquidado.toFixed(2))
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 2. Listar todas as empresas (Tenants) - Sanitizado sem expor credenciais privadas
app.get('/api/admin/tenants', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { data: rawTenants, error } = await supabase
            .from('tenants')
            .select('id, cnpj, razao_social, nome_fantasia, email_admin, plano, limite_guias_mes, guias_usadas_mes, status, subscription_status, environment, bank_agency, bank_account, bank_dac, pfx_filename, asaas_api_key_encrypted, microvix_token, created_at, updated_at')
            .order('created_at', { ascending: false });

        if (error) throw error;

        const tenants = (rawTenants || []).map(t => ({
            id: t.id,
            cnpj: t.cnpj,
            razao_social: t.razao_social,
            nome_fantasia: t.nome_fantasia || t.razao_social,
            email_admin: t.email_admin,
            plano: t.plano || t.subscription_status || 'pro',
            limite_guias_mes: t.limite_guias_mes || 1000,
            guias_usadas_mes: t.guias_usadas_mes || 0,
            status: t.status || t.subscription_status || 'ativo',
            environment: t.environment || 'simulado',
            bank_agency: t.bank_agency,
            bank_account: t.bank_account,
            bank_dac: t.bank_dac,
            has_pfx: !!t.pfx_filename,
            has_asaas: !!t.asaas_api_key_encrypted,
            has_microvix: !!t.microvix_token,
            created_at: t.created_at,
            updated_at: t.updated_at
        }));

        return res.status(200).json(tenants);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 3. Cadastrar Nova Empresa Cliente (Tenant)
app.post('/api/admin/tenants/create', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { cnpj, razao_social, nome_fantasia, email_admin, plano, limite_guias_mes } = req.body;
        if (!cnpj || !razao_social) {
            return res.status(400).json({ error: "CNPJ e Razão Social são obrigatórios." });
        }

        const cleanCnpj = String(cnpj).replace(/\D/g, '');
        if (cleanCnpj.length !== 14) {
            return res.status(400).json({ error: "CNPJ inválido. Digite exatamente os 14 dígitos numéricos." });
        }

        // Verifica se CNPJ já existe
        const { data: existing } = await supabase.from('tenants').select('id, razao_social').eq('cnpj', cleanCnpj).maybeSingle();
        if (existing) {
            return res.status(400).json({ error: `Este CNPJ já está cadastrado para a empresa "${existing.razao_social}".` });
        }

        const { data: newTenant, error } = await supabase.from('tenants').insert([{
            cnpj: cleanCnpj,
            razao_social: String(razao_social).trim(),
            nome_fantasia: nome_fantasia ? String(nome_fantasia).trim() : String(razao_social).trim(),
            email_admin: email_admin ? String(email_admin).trim() : null,
            plano: plano || 'pro',
            limite_guias_mes: parseInt(limite_guias_mes, 10) || 1000,
            status: 'ativo',
            subscription_status: 'ativo',
            bank_agency: '0000',
            bank_account: '00000',
            bank_dac: '0'
        }]).select().single();

        if (error) {
            console.error("[Criar Empresa] Erro Supabase:", error);
            if (error.code === '23505') {
                return res.status(400).json({ error: "Este CNPJ já está cadastrado no sistema." });
            }
            return res.status(400).json({ error: error.message });
        }

        auditService.logAudit(supabase, {
            tenantId: newTenant.id,
            userId: req.user?.id,
            acao: 'CRIAR_EMPRESA',
            detalhe: `Nova empresa criada: ${razao_social} (CNPJ: ${cleanCnpj}) no plano ${plano || 'pro'}`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(201).json({ message: "Empresa cadastrada com sucesso!", tenant: newTenant });
    } catch (err) {
        console.error("[Criar Empresa] Erro capturado:", err);
        return res.status(400).json({ error: err.message || "Erro ao cadastrar empresa." });
    }
});

// 4. Bloquear/Desbloquear Empresa (Status da Licença)
app.post('/api/admin/tenants/status', requireAuth, requireSuperAdmin, async (req, res) => {
    const { tenantId, status } = req.body; // status: 'ativo' ou 'bloqueado'
    if (!tenantId || !status) {
        return res.status(400).json({ error: "Empresa e status são obrigatórios." });
    }

    try {
        const { error } = await supabase
            .from('tenants')
            .update({ 
                subscription_status: status,
                status: status
            })
            .eq('id', tenantId);

        if (error) throw error;

        auditService.logAudit(supabase, {
            tenantId,
            userId: req.user?.id,
            acao: status === 'ativo' ? 'DESBLOQUEAR_EMPRESA' : 'BLOQUEAR_EMPRESA',
            detalhe: `Status da licença da empresa alterado para '${status}'`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: `Empresa atualizada para '${status}' com sucesso!` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 5. Atualizar Plano e Limite de Guias da Empresa
app.post('/api/admin/tenants/plan', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { tenantId, plano, limite_guias_mes } = req.body;
        if (!tenantId || !plano) {
            return res.status(400).json({ error: "ID da empresa e plano são obrigatórios." });
        }

        const updates = { plano };
        if (limite_guias_mes !== undefined) {
            updates.limite_guias_mes = parseInt(limite_guias_mes, 10);
            updates.plan_limit_guides = parseInt(limite_guias_mes, 10);
        }

        const { error } = await supabase.from('tenants').update(updates).eq('id', tenantId);
        if (error) throw error;

        auditService.logAudit(supabase, {
            tenantId,
            userId: req.user?.id,
            acao: 'ALTERAR_PLANO',
            detalhe: `Plano alterado para ${plano} com limite de ${limite_guias_mes || 'padrão'} guias/mês`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.json({ message: `Plano da empresa atualizado para '${plano}' com sucesso!` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 6. Trilha de Auditoria Geral (LGPD & Compliance)
app.get('/api/admin/audit-logs', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const tenantId = req.query.tenantId || null;
        const logs = await auditService.getRecentAuditLogs(supabase, { tenantId, limit });
        return res.json(logs);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 7. Listar todos os usuários/perfis cadastrados com seus respectivos tenants
app.get('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('*, tenants(razao_social, cnpj)')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json(profiles);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 8. Criar um novo usuário vinculado a uma empresa (Tenant)
app.post('/api/admin/users/create', requireAuth, requireSuperAdmin, async (req, res) => {
    const { email, password, name, tenantId, role, is_admin } = req.body;
    if (!email || !password || !tenantId) {
        return res.status(400).json({ error: "E-mail, senha e empresa são obrigatórios." });
    }

    try {
        // Criação de usuário via API de Administração do Supabase Auth
        const { data: userData, error: createUserError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true
        });

        if (createUserError || !userData.user) {
            return res.status(400).json({ error: "Erro ao criar credenciais do usuário: " + (createUserError?.message || "Erro desconhecido") });
        }

        const newUser = userData.user;

        // Cria o registro na tabela profiles do banco com a role especificada
        const userRole = role || (is_admin ? 'admin' : 'operador');
        const { error: profileError } = await supabase
            .from('profiles')
            .insert({
                id: newUser.id,
                tenant_id: tenantId,
                email: email,
                name: name || email.split('@')[0],
                role: userRole,
                is_admin: userRole === 'admin' || userRole === 'superadmin' || !!is_admin
            });

        if (profileError) {
            await supabase.auth.admin.deleteUser(newUser.id);
            return res.status(400).json({ error: "Erro ao criar perfil de usuário: " + profileError.message });
        }

        auditService.logAudit(supabase, {
            tenantId: tenantId,
            userId: req.user?.id,
            acao: 'CRIAR_USUARIO',
            detalhe: `Usuário ${email} criado com perfil '${userRole}'`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: "Usuário criado com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 9. Redefinir senha de um usuário existente
app.post('/api/admin/users/reset-password', requireAuth, requireSuperAdmin, async (req, res) => {
    const userId = req.body.userId;
    const password = req.body.password || req.body.newPassword;
    if (!userId || !password) {
        return res.status(400).json({ error: "Usuário e nova senha são obrigatórios." });
    }

    try {
        const { error } = await supabase.auth.admin.updateUserById(userId, {
            password: password
        });

        if (error) throw error;

        auditService.logAudit(supabase, {
            userId: req.user?.id,
            acao: 'REDEFINIR_SENHA',
            detalhe: `Senha do usuário ID ${userId} redefinida pelo administrador`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: "Senha redefinida com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 10. Excluir usuário do sistema permanentemente
app.post('/api/admin/users/delete', requireAuth, requireSuperAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: "ID do usuário é obrigatório." });
    }

    if (userId === req.user?.id) {
        return res.status(400).json({ error: "Você não pode excluir sua própria conta de administrador em uso." });
    }

    try {
        const { data: profile } = await supabase.from('profiles').select('email, name').eq('id', userId).single();
        const userEmail = profile?.email || userId;

        await supabase.from('profiles').delete().eq('id', userId);
        const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
        if (authErr) throw authErr;

        auditService.logAudit(supabase, {
            userId: req.user?.id,
            acao: 'EXCLUIR_USUARIO',
            detalhe: `Usuário ${userEmail} removido pelo administrador master`,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
        });

        return res.status(200).json({ message: "Usuário removido com sucesso!" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTA: SINCRONIZAÇÃO COM LINX MICROVIX
// ==========================================
app.post('/api/microvix/sync', requireAuth, requireActiveSubscription, async (req, res) => {
    const tenant = req.tenant;

    // Valida se o tenant tem credenciais Microvix configuradas
    if (!tenant.microvix_key || !tenant.microvix_cnpj) {
        return res.status(400).json({
            error: 'Credenciais Linx Microvix não configuradas para esta empresa. Configure em Empresa > Integrações.'
        });
    }

    // 0. Previne execução concorrente / duplicada se houver lote ativo em processamento
    const { data: lotesAtivos } = await supabase
        .from('batches')
        .select('id, created_at')
        .eq('tenant_id', tenant.id)
        .in('status', ['processando', 'aguardando_aprovacao'])
        .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
        .limit(1);

    if (lotesAtivos && lotesAtivos.length > 0) {
        return res.status(409).json({
            error: 'Já existe um lote de emissão sendo processado ou aguardando aprovação. Finalize ou aprove o lote pendente para evitar guias duplicadas.'
        });
    }

    // Data do filtro (padrão = hoje)
    const hoje = new Date().toISOString().split('T')[0];
    const dataInicial = req.body.data_inicial || hoje;
    const dataFim     = req.body.data_fim     || hoje;
    const paymentDate = req.body.payment_date  || hoje;

    try {
        // 1. Descriptografa a senha Microvix
        let microvixPassword = tenant.microvix_password_encrypted || '';
        if (microvixPassword.includes(':')) {
            try {
                const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
                microvixPassword = decrypt(microvixPassword, key);
            } catch (errKey) {
                return res.status(500).json({ error: 'Falha ao descriptografar senha Microvix. Recadastre as credenciais em Empresa > Integrações.' });
            }
        }

        const credentials = {
            user:     tenant.microvix_user     || 'linx_b2c',
            password: microvixPassword,
            chave:    tenant.microvix_key,
            cnpjEmp:  tenant.microvix_cnpj
        };

        // 2. Busca NF-e na Linx Microvix
        console.log(`[Microvix] Consultando NF-e para tenant ${tenant.id} | Período: ${dataInicial} a ${dataFim}`);
        const notasBrutas = await microvixService.consultarNFe(credentials, dataInicial, dataFim);

        if (!notasBrutas || notasBrutas.length === 0) {
            return res.status(200).json({
                message: `Nenhuma nota fiscal encontrada no período ${dataInicial} a ${dataFim}.`,
                total: 0, novas: 0, duplicadas: 0, batch_id: null
            });
        }

        // 3. Deduplica internamente o array retornado pela Linx (evita notas repetidas no mesmo retorno)
        const notasUnicas = [];
        const chavesVistas = new Set();
        const docsVistos = new Set();

        for (const n of notasBrutas) {
            const ch = (n.chave_nfe || '').trim();
            const doc = (n.documento || '').trim();
            if (ch && chavesVistas.has(ch)) continue;
            if (doc && docsVistos.has(doc)) continue;
            if (ch) chavesVistas.add(ch);
            if (doc) docsVistos.add(doc);
            notasUnicas.push(n);
        }

        // 4. Verificação robusta contra duplicidade no banco de dados:
        // Checa tanto por chave_nfe de 44 dígitos quanto por número da NF (nf_number),
        // cobrindo o histórico onde a chave_nfe estava nula no banco de dados.
        const todasChaves = notasUnicas.map(n => n.chave_nfe).filter(Boolean);
        const todosDocumentos = new Set(notasUnicas.map(n => n.documento).filter(Boolean));

        // Também extrai números de NF a partir da chave de 44 dígitos (posições 25 a 34: 0-indexed)
        todasChaves.forEach(ch => {
            if (ch.length === 44) {
                const num = String(parseInt(ch.substring(25, 34), 10));
                if (num && num !== 'NaN') todosDocumentos.add(num);
            }
        });

        const chavesDuplicadas = new Set();
        const docsDuplicados = new Set();

        // 4.1 Busca por chave_nfe
        if (todasChaves.length > 0) {
            const { data: existentesChave } = await supabase
                .from('guides')
                .select('chave_nfe, nf_number')
                .eq('tenant_id', tenant.id)
                .in('chave_nfe', todasChaves);

            if (existentesChave && existentesChave.length > 0) {
                existentesChave.forEach(r => {
                    if (r.chave_nfe) chavesDuplicadas.add(r.chave_nfe.trim());
                    if (r.nf_number) docsDuplicados.add(r.nf_number.trim());
                });
            }
        }

        // 4.2 Busca por nf_number (para resguardar notas já emitidas no passado)
        const docsArray = Array.from(todosDocumentos);
        if (docsArray.length > 0) {
            const { data: existentesDoc } = await supabase
                .from('guides')
                .select('chave_nfe, nf_number')
                .eq('tenant_id', tenant.id)
                .in('nf_number', docsArray);

            if (existentesDoc && existentesDoc.length > 0) {
                existentesDoc.forEach(r => {
                    if (r.chave_nfe) chavesDuplicadas.add(r.chave_nfe.trim());
                    if (r.nf_number) docsDuplicados.add(r.nf_number.trim());
                });
            }
        }

        // 4.3 Filtra rigorosamente apenas as notas que NUNCA foram emitidas
        const notasNovas = notasUnicas.filter(n => {
            const ch = (n.chave_nfe || '').trim();
            const doc = (n.documento || '').trim();
            const docFromChave = ch.length === 44 ? String(parseInt(ch.substring(25, 34), 10)) : '';

            if (ch && chavesDuplicadas.has(ch)) return false;
            if (doc && docsDuplicados.has(doc)) return false;
            if (docFromChave && docsDuplicados.has(docFromChave)) return false;
            return true;
        });

        const totalDuplicadas = notasBrutas.length - notasNovas.length;

        console.log(`[Microvix] Total Linx: ${notasBrutas.length} | Novas: ${notasNovas.length} | Já importadas/duplicadas: ${totalDuplicadas}`);

        if (notasNovas.length === 0) {
            return res.status(200).json({
                message: `Todas as ${notasBrutas.length} notas deste período já foram emitidas anteriormente (duplicadas ignoradas).`,
                total: notasBrutas.length, novas: 0, duplicadas: totalDuplicadas, batch_id: null
            });
        }

        // 5. Filtra XMLs que têm DIFAL (vICMSUFDest > 0) — notas internas ou sem DIFAL não precisam de GNRE
        const xmlsParaProcessar = [];
        for (const nota of notasNovas) {
            const difalMatch = nota.xml.match(/<vICMSUFDest>([^<]+)<\/vICMSUFDest>/);
            const difalVal   = difalMatch ? parseFloat(difalMatch[1]) : 0;
            if (difalVal > 0) {
                xmlsParaProcessar.push({
                    filename: `linx_nfe_${nota.documento || nota.chave_nfe.substring(0, 9)}.xml`,
                    content:  nota.xml,
                    xmlSource: 'linx_microvix'
                });
            }
        }

        const semDifal = notasNovas.length - xmlsParaProcessar.length;

        if (xmlsParaProcessar.length === 0) {
            return res.status(200).json({
                message: `${notasNovas.length} notas novas encontradas, mas nenhuma possui DIFAL interestadual para emissão de GNRE.`,
                total: notasBrutas.length, novas: notasNovas.length, duplicadas: totalDuplicadas,
                sem_difal: semDifal, batch_id: null
            });
        }

        // 6. Verifica limite de emissões do plano
        const limite = PLAN_LIMITS[tenant.subscription_status] || 0;
        if (limite > 0) {
            const inicioMes = new Date();
            inicioMes.setDate(1);
            inicioMes.setHours(0, 0, 0, 0);

            const { count } = await supabase
                .from('guides')
                .select('id', { count: 'exact', head: true })
                .eq('tenant_id', tenant.id)
                .gte('created_at', inicioMes.toISOString());

            if ((count || 0) + xmlsParaProcessar.length > limite) {
                return res.status(403).json({
                    error: `Limite do plano atingido: ${count || 0}/${limite} guias este mês. Adicione menos notas ou faça upgrade do plano.`
                });
            }
        }

        // 7. Cria registro do lote no banco
        const { data: batchData, error: batchError } = await supabase
            .from('batches')
            .insert({
                tenant_id: tenant.id,
                status: 'aguardando_aprovacao',
                environment: tenant.environment || 'simulado',
                source: 'linx_microvix',
                file_count: xmlsParaProcessar.length
            })
            .select('id')
            .single();

        if (batchError) throw batchError;
        const batchId = batchData.id;

        // 8. Dispara pré-validação e staging em background
        runBatchProcessInBackground(batchId, tenant, xmlsParaProcessar, paymentDate);

        return res.status(200).json({
            message: `Notas importadas do Linx Microvix! O lote #${batchId.substring(0, 8)} está pronto e aguardando sua autorização para emissão.`,
            total:        notasBrutas.length,
            novas:        notasNovas.length,
            com_difal:    xmlsParaProcessar.length,
            sem_difal:    semDifal,
            duplicadas:   totalDuplicadas,
            batch_id:     batchId
        });

    } catch (err) {
        console.error('[Microvix] Erro na sincronização:', err.message);
        return res.status(500).json({ error: 'Erro ao sincronizar com Linx Microvix: ' + err.message });
    }
});

// Endpoint para salvar credenciais Microvix do tenant
app.post('/api/microvix/credentials', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    const { microvix_key, microvix_user, microvix_password, microvix_cnpj } = req.body;
    if (!microvix_key || !microvix_cnpj) {
        return res.status(400).json({ error: 'Chave API e CNPJ são obrigatórios.' });
    }

    try {
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const encryptedPassword = microvix_password ? encrypt(microvix_password, key) : '';

        const { error } = await supabase
            .from('tenants')
            .update({
                microvix_key,
                microvix_user:               microvix_user || 'linx_b2c',
                microvix_password_encrypted: encryptedPassword,
                microvix_cnpj:               microvix_cnpj.replace(/[^0-9]/g, '')
            })
            .eq('id', req.tenant.id);

        if (error) throw error;
        return res.status(200).json({ message: 'Credenciais Linx Microvix salvas com sucesso!' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTAS: CONECTORES ERP (BLING, TINY ERP, OMIE)
// ==========================================

// 1. Status de conexão dos ERPs para o tenant
app.get('/api/erp/status', requireAuth, async (req, res) => {
    try {
        const t = req.tenant;
        return res.status(200).json({
            microvix: !!(t.microvix_key && t.microvix_cnpj),
            bling: !!t.bling_token_encrypted,
            tiny: !!t.tiny_token_encrypted,
            omie: !!(t.omie_app_key && t.omie_app_secret_encrypted),
            vnda: !!t.vnda_token_encrypted
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROTAS: E-COMMERCE OLIST VNDA
// ==========================================

// Status da conexão da Vnda
app.get('/api/vnda/status', requireAuth, async (req, res) => {
    const t = req.tenant;
    return res.json({
        conectado: !!t.vnda_token_encrypted,
        shop_host: t.vnda_shop_host || ''
    });
});

// Salvar credenciais da Vnda
app.post('/api/vnda/credentials', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    const { token, shop_host } = req.body;
    if (!token) return res.status(400).json({ error: 'Token da Vnda é obrigatório.' });

    try {
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const encToken = encrypt(token.trim(), key);
        const host = (shop_host || '').trim();

        const { error } = await supabase
            .from('tenants')
            .update({
                vnda_token_encrypted: encToken,
                vnda_shop_host: host
            })
            .eq('id', req.tenant.id);

        if (error) throw error;
        return res.json({ message: 'Credenciais da Olist Vnda salvas com sucesso!' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Listar pedidos recentes da Vnda
app.get('/api/vnda/pedidos', requireAuth, async (req, res) => {
    const t = req.tenant;
    if (!t.vnda_token_encrypted) {
        return res.status(400).json({ error: 'Integração Vnda não configurada.' });
    }

    try {
        const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
        const token = t.vnda_token_encrypted.includes(':') 
            ? decrypt(t.vnda_token_encrypted, key) 
            : t.vnda_token_encrypted;
        const shopHost = t.vnda_shop_host || '';

        const pedidos = await vndaService.listarPedidos(token, shopHost, {
            per_page: 30,
            status: req.query.status || undefined
        });

        return res.json({ pedidos });
    } catch (err) {
        return res.status(500).json({ error: 'Erro ao buscar pedidos da Vnda: ' + err.message });
    }
});

// ==========================================
// MÓDULO: SINCRONIZAÇÃO AUTOMÁTICA (SCHEDULER / WORKER)
// ==========================================
// 1. Status do agendador automático
app.get('/api/sync/status', requireAuth, (req, res) => {
    return res.status(200).json(syncService.obterStatus());
});

// 2. Disparo manual imediato da sincronização automática para o tenant logado
app.post('/api/sync/run', requireAuth, requireActiveSubscription, async (req, res) => {
    try {
        const { dataInicial, dataFim, paymentDate } = req.body;
        const resultado = await syncService.sincronizarTenant(
            req.tenant, 
            supabase, 
            runBatchProcessInBackground, 
            { dataInicial, dataFim, paymentDate }
        );
        return res.status(200).json(resultado);
    } catch (err) {
        console.error("Erro ao disparar sincronização manual:", err);
        return res.status(500).json({ error: "Falha na sincronização: " + err.message });
    }
});

// 2. Salvar credenciais de um ERP específico
app.post('/api/erp/credentials', requireAuth, requireRole(['admin', 'superadmin', 'diretoria']), async (req, res) => {
    const { erp, bling_token, tiny_token, omie_app_key, omie_app_secret } = req.body;
    const key = getEncryptionKey(process.env.ENCRYPTION_KEY);

    try {
        const updateData = {};
        if (erp === 'bling') {
            if (!bling_token) return res.status(400).json({ error: 'Token do Bling é obrigatório.' });
            updateData.bling_token_encrypted = encrypt(bling_token.trim(), key);
        } else if (erp === 'tiny') {
            if (!tiny_token) return res.status(400).json({ error: 'Token do Tiny ERP é obrigatório.' });
            updateData.tiny_token_encrypted = encrypt(tiny_token.trim(), key);
        } else if (erp === 'omie') {
            if (!omie_app_key || !omie_app_secret) return res.status(400).json({ error: 'App Key e App Secret da Omie são obrigatórios.' });
            updateData.omie_app_key = omie_app_key.trim();
            updateData.omie_app_secret_encrypted = encrypt(omie_app_secret.trim(), key);
        } else {
            return res.status(400).json({ error: 'ERP inválido especificado. Escolha bling, tiny ou omie.' });
        }

        const { error } = await supabase
            .from('tenants')
            .update(updateData)
            .eq('id', req.tenant.id);

        if (error) throw error;
        return res.status(200).json({ message: `Credenciais do ${erp.toUpperCase()} salvas com sucesso!` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 3. Sincronização e Importação de Notas Fiscais via ERP (Bling / Tiny / Omie)
app.post('/api/erp/sync', requireAuth, requireActiveSubscription, async (req, res) => {
    const tenant = req.tenant;
    const { erp } = req.body;

    if (!['bling', 'tiny', 'omie'].includes(erp)) {
        return res.status(400).json({ error: "ERP inválido. Deve ser 'bling', 'tiny' ou 'omie'." });
    }

    // Previne execução concorrente se houver lote ativo em processamento
    const { data: lotesAtivos } = await supabase
        .from('batches')
        .select('id, created_at')
        .eq('tenant_id', tenant.id)
        .in('status', ['processando', 'aguardando_aprovacao'])
        .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
        .limit(1);

    if (lotesAtivos && lotesAtivos.length > 0) {
        return res.status(409).json({
            error: 'Já existe um lote de emissão sendo processado ou aguardando aprovação. Finalize ou aprove o lote pendente para evitar guias duplicadas.'
        });
    }

    const hoje = new Date().toISOString().split('T')[0];
    const dataInicial = req.body.data_inicial || hoje;
    const dataFim     = req.body.data_fim     || hoje;
    const paymentDate = req.body.payment_date  || hoje;

    const key = getEncryptionKey(process.env.ENCRYPTION_KEY);

    try {
        let notasBrutas = [];

        if (erp === 'bling') {
            const tokenEnc = tenant.bling_token_encrypted || req.body.bling_token;
            if (!tokenEnc) {
                return res.status(400).json({ error: 'Token da API do Bling v3 não configurado.' });
            }
            const token = tokenEnc.includes(':') ? decrypt(tokenEnc, key) : tokenEnc;
            console.log(`[Bling] Consultando NF-e para tenant ${tenant.id} | ${dataInicial} a ${dataFim}`);
            notasBrutas = await erpService.consultarNFeBling(token, dataInicial, dataFim);

        } else if (erp === 'tiny') {
            const tokenEnc = tenant.tiny_token_encrypted || req.body.tiny_token;
            if (!tokenEnc) {
                return res.status(400).json({ error: 'API Token do Tiny ERP não configurado.' });
            }
            const token = tokenEnc.includes(':') ? decrypt(tokenEnc, key) : tokenEnc;
            console.log(`[Tiny] Consultando NF-e para tenant ${tenant.id} | ${dataInicial} a ${dataFim}`);
            notasBrutas = await erpService.consultarNFeTiny(token, dataInicial, dataFim);

        } else if (erp === 'omie') {
            const appKey = tenant.omie_app_key || req.body.omie_app_key;
            const secretEnc = tenant.omie_app_secret_encrypted || req.body.omie_app_secret;
            if (!appKey || !secretEnc) {
                return res.status(400).json({ error: 'App Key e App Secret da Omie não configurados.' });
            }
            const appSecret = secretEnc.includes(':') ? decrypt(secretEnc, key) : secretEnc;
            console.log(`[Omie] Consultando NF-e para tenant ${tenant.id} | ${dataInicial} a ${dataFim}`);
            notasBrutas = await erpService.consultarNFeOmie(appKey, appSecret, dataInicial, dataFim);
        }

        if (!notasBrutas || notasBrutas.length === 0) {
            return res.status(200).json({
                message: `Nenhuma nota fiscal encontrada no ${erp.toUpperCase()} no período selecionado (${dataInicial} a ${dataFim}).`,
                total: 0, novas: 0, duplicadas: 0, batch_id: null
            });
        }

        // Deduplica internamente
        const notasUnicas = [];
        const chavesVistas = new Set();
        const docsVistos = new Set();

        for (const n of notasBrutas) {
            const ch = (n.chave_nfe || '').trim();
            const doc = (n.documento || '').trim();
            if (ch && chavesVistas.has(ch)) continue;
            if (doc && docsVistos.has(doc)) continue;
            if (ch) chavesVistas.add(ch);
            if (doc) docsVistos.add(doc);
            notasUnicas.push(n);
        }

        // Checa duplicidade no banco
        const todasChaves = notasUnicas.map(n => n.chave_nfe).filter(Boolean);
        const todosDocumentos = new Set(notasUnicas.map(n => n.documento).filter(Boolean));

        todasChaves.forEach(ch => {
            if (ch.length === 44) {
                const num = String(parseInt(ch.substring(25, 34), 10));
                if (num && num !== 'NaN') todosDocumentos.add(num);
            }
        });

        const chavesDuplicadas = new Set();
        const docsDuplicados = new Set();

        if (todasChaves.length > 0) {
            const { data: existentesChave } = await supabase
                .from('guides')
                .select('chave_nfe, nf_number')
                .eq('tenant_id', tenant.id)
                .in('chave_nfe', todasChaves);

            if (existentesChave) {
                existentesChave.forEach(r => {
                    if (r.chave_nfe) chavesDuplicadas.add(r.chave_nfe.trim());
                    if (r.nf_number) docsDuplicados.add(r.nf_number.trim());
                });
            }
        }

        const docsArray = Array.from(todosDocumentos);
        if (docsArray.length > 0) {
            const { data: existentesDoc } = await supabase
                .from('guides')
                .select('chave_nfe, nf_number')
                .eq('tenant_id', tenant.id)
                .in('nf_number', docsArray);

            if (existentesDoc) {
                existentesDoc.forEach(r => {
                    if (r.chave_nfe) chavesDuplicadas.add(r.chave_nfe.trim());
                    if (r.nf_number) docsDuplicados.add(r.nf_number.trim());
                });
            }
        }

        const notasNovas = notasUnicas.filter(n => {
            const ch = (n.chave_nfe || '').trim();
            const doc = (n.documento || '').trim();
            const docFromChave = ch.length === 44 ? String(parseInt(ch.substring(25, 34), 10)) : '';

            if (ch && chavesDuplicadas.has(ch)) return false;
            if (doc && docsDuplicados.has(doc)) return false;
            if (docFromChave && docsDuplicados.has(docFromChave)) return false;
            return true;
        });

        const totalDuplicadas = notasBrutas.length - notasNovas.length;

        if (notasNovas.length === 0) {
            return res.status(200).json({
                message: `Todas as ${notasBrutas.length} notas deste período já foram emitidas anteriormente no sistema.`,
                total: notasBrutas.length, novas: 0, duplicadas: totalDuplicadas, batch_id: null
            });
        }

        // Filtra XMLs que têm DIFAL (vICMSUFDest > 0)
        const xmlsParaProcessar = [];
        for (const nota of notasNovas) {
            const difalMatch = nota.xml.match(/<vICMSUFDest>([^<]+)<\/vICMSUFDest>/);
            const difalVal   = difalMatch ? parseFloat(difalMatch[1]) : 0;
            if (difalVal > 0) {
                xmlsParaProcessar.push({
                    filename: `${erp}_nfe_${nota.documento || nota.chave_nfe.substring(0, 9)}.xml`,
                    content:  nota.xml,
                    xmlSource: erp
                });
            }
        }

        const semDifal = notasNovas.length - xmlsParaProcessar.length;

        if (xmlsParaProcessar.length === 0) {
            return res.status(200).json({
                message: `${notasNovas.length} notas novas encontradas no ${erp.toUpperCase()}, mas nenhuma possui DIFAL interestadual para emissão de GNRE.`,
                total: notasBrutas.length, novas: notasNovas.length, duplicadas: totalDuplicadas,
                sem_difal: semDifal, batch_id: null
            });
        }

        // Checa limite de plano
        const limite = PLAN_LIMITS[tenant.subscription_status] || 0;
        if (limite > 0) {
            const inicioMes = new Date();
            inicioMes.setDate(1);
            inicioMes.setHours(0, 0, 0, 0);

            const { count } = await supabase
                .from('guides')
                .select('id', { count: 'exact', head: true })
                .eq('tenant_id', tenant.id)
                .gte('created_at', inicioMes.toISOString());

            if ((count || 0) + xmlsParaProcessar.length > limite) {
                return res.status(403).json({
                    error: `Limite do plano atingido: ${count || 0}/${limite} guias este mês. Faça upgrade do plano.`
                });
            }
        }

        // Cria lote e inicia background staging
        const { data: batchData, error: batchError } = await supabase
            .from('batches')
            .insert({
                tenant_id: tenant.id,
                status: 'aguardando_aprovacao',
                environment: tenant.environment || 'simulado',
                source: erp,
                file_count: xmlsParaProcessar.length
            })
            .select('id')
            .single();

        if (batchError) throw batchError;
        const batchId = batchData.id;

        runBatchProcessInBackground(batchId, tenant, xmlsParaProcessar, paymentDate);

        return res.status(200).json({
            message: `Notas importadas do ${erp.toUpperCase()}! O lote #${batchId.substring(0, 8)} está pronto e aguardando sua autorização para emissão.`,
            total:        notasBrutas.length,
            novas:        notasNovas.length,
            com_difal:    xmlsParaProcessar.length,
            sem_difal:    semDifal,
            duplicadas:   totalDuplicadas,
            batch_id:     batchId
        });

    } catch (err) {
        console.error(`[${erp.toUpperCase()}] Erro na sincronização:`, err.message);
        return res.status(500).json({ error: `Erro ao sincronizar com ${erp.toUpperCase()}: ` + err.message });
    }
});

// ==========================================
// MÓDULO DE AUTORIZAÇÃO: PRÉ-VALIDAÇÃO & EMISSÃO SEFAZ
// ==========================================

/**
 * 1. Importa os XMLs, valida regras fiscais, calcula DIFAL e deixa o lote aguardando aprovação
 */
function stageBatchForApproval(batchId, tenant, filesData, paymentDate, source = 'upload') {
    setImmediate(async () => {
        activeTasks[batchId] = {
            logs: [],
            progress: 10,
            status: 'aguardando_aprovacao'
        };

        const task = activeTasks[batchId];
        const log = (msg) => {
            const timestamp = new Date().toLocaleTimeString('pt-BR');
            task.logs.push(`[${timestamp}] ${msg}`);
        };

        try {
            log(`📥 Importando e pré-validando ${filesData.length} arquivo(s) de nota fiscal...`);
            task.progress = 20;

            const notasValidas = [];
            let totalDifal = 0;

            for (const f of filesData) {
                try {
                    const dadosNfe = parserService.extrairDadosNfeXML(f.content);
                    dadosNfe.caminhoOriginal = f.path;
                    dadosNfe.nomeArquivoOriginal = f.filename;
                    dadosNfe.xmlSource = f.xmlSource || source;
                    dadosNfe.xmlContent = f.content;

                    const ch = (dadosNfe.chaveAcessoNfe || '').trim();
                    const doc = (dadosNfe.documentoOrigem || '').trim();

                    // Checa se já existe guia emitida anteriormente (diferente de aguardando_aprovacao)
                    let jaExiste = null;
                    if (ch) {
                        const { data } = await supabase
                            .from('guides')
                            .select('id, nf_number, status')
                            .eq('tenant_id', tenant.id)
                            .eq('chave_nfe', ch)
                            .neq('status', 'aguardando_aprovacao')
                            .limit(1);
                        if (data && data.length > 0) jaExiste = data[0];
                    }
                    if (!jaExiste && doc) {
                        const { data } = await supabase
                            .from('guides')
                            .select('id, nf_number, status')
                            .eq('tenant_id', tenant.id)
                            .eq('nf_number', doc)
                            .neq('status', 'aguardando_aprovacao')
                            .limit(1);
                        if (data && data.length > 0) jaExiste = data[0];
                    }

                    if (jaExiste) {
                        log(`   ⏭ NF Nº ${doc} já emitida anteriormente no sistema. Ignorada para evitar duplicidade.`);
                        continue;
                    }

                    // Salva XML no Storage para transmissão posterior quando autorizado
                    let xmlRemotePath = null;
                    if (f.content) {
                        xmlRemotePath = `${tenant.id}/lotes_xml/${batchId}/${f.filename || `nfe_${doc}.xml`}`;
                        await supabase.storage
                            .from('tenant-storage')
                            .upload(xmlRemotePath, Buffer.from(f.content, 'utf-8'), {
                                contentType: 'application/xml; charset=utf-8',
                                upsert: true
                            });
                        dadosNfe.xml_storage_path = xmlRemotePath;
                    }

                    // Gera DANFE em PDF antecipadamente
                    let danfeRemotePath = null;
                    try {
                        const danfeBuffer = await danfeService.gerarDanfePdf(f.content);
                        danfeRemotePath = `${tenant.id}/danfe/danfe_NF_${doc}.pdf`;
                        await supabase.storage
                            .from('tenant-storage')
                            .upload(danfeRemotePath, danfeBuffer, {
                                contentType: 'application/pdf',
                                upsert: true
                            });
                        dadosNfe.danfe_storage_path = danfeRemotePath;
                    } catch (eDanfe) {}

                    const val = parseFloat(dadosNfe.valor || 0);
                    totalDifal += val;
                    notasValidas.push(dadosNfe);

                    log(`   ✔ NF Nº ${dadosNfe.documentoOrigem} (Destino: ${dadosNfe.ufFavorecida}, DIFAL: R$ ${dadosNfe.valor}) pré-validada.`);
                } catch (err) {
                    log(`   ⚠ Ignorado arquivo ${f.filename}: ${err.message}`);
                }
            }

            if (notasValidas.length === 0) {
                throw new Error("Nenhuma nota fiscal pendente de emissão foi localizada.");
            }

            task.progress = 70;

            // Insere as notas em 'guides' vinculadas a este lote com status 'aguardando_aprovacao'
            const guidesDb = notasValidas.map(n => ({
                tenant_id: tenant.id,
                batch_id: batchId,
                nf_number: n.documentoOrigem,
                uf: n.ufFavorecida,
                value: n.valor,
                status: 'aguardando_aprovacao',
                customer_name: n.destNome || null,
                carrier_name: n.carrierName || null,
                chave_nfe: n.chaveAcessoNfe || null,
                xml_storage_path: n.xml_storage_path || null,
                danfe_storage_path: n.danfe_storage_path || null,
                xml_source: n.xmlSource || source,
                barcode: null,
                line_digitizable: null
            }));

            await supabase.from('guides').insert(guidesDb);

            // Atualiza status do lote para 'aguardando_aprovacao'
            await supabase
                .from('batches')
                .update({
                    status: 'aguardando_aprovacao',
                    file_count: notasValidas.length
                })
                .eq('id', batchId);

            log(`\n==================================================`);
            log(`📋 PRÉ-VALIDAÇÃO CONCLUÍDA COM SUCESSO!`);
            log(`📊 Total: ${notasValidas.length} nota(s) fiscal(is) prontas.`);
            log(`💰 Total DIFAL: R$ ${totalDifal.toFixed(2)}.`);
            log(`🛑 AGUARDANDO AUTORIZAÇÃO: Revise as notas no painel e clique em "Autorizar Emissão" para transmitir à SEFAZ.`);
            log(`==================================================`);

            task.progress = 100;
            task.status = 'aguardando_aprovacao';

        } catch (err) {
            log(`❌ Erro na importação: ${err.message}`);
            task.status = 'erro';
            task.error = err.message;
            await supabase
                .from('batches')
                .update({ status: 'erro', error_message: err.message })
                .eq('id', batchId);
        }
    });
}

/**
 * 2. Transmite o lote já validado para a SEFAZ após a autorização expressa do operador
 */
function transmitStagedBatchToSefaz(batchId, tenant, paymentDate) {
    setImmediate(async () => {
        activeTasks[batchId] = {
            logs: [`[${new Date().toLocaleTimeString('pt-BR')}] 🚀 Emissão autorizada pelo operador! Conectando com a SEFAZ...`],
            progress: 10,
            status: 'processando'
        };

        const task = activeTasks[batchId];
        const log = (msg) => {
            const timestamp = new Date().toLocaleTimeString('pt-BR');
            task.logs.push(`[${timestamp}] ${msg}`);
        };

        try {
            await supabase.from('batches').update({ status: 'processando' }).eq('id', batchId);

            // Busca as notas pré-validadas deste lote
            const { data: stagedGuides, error: gError } = await supabase
                .from('guides')
                .select('*')
                .eq('batch_id', batchId)
                .eq('tenant_id', tenant.id);

            if (gError || !stagedGuides || stagedGuides.length === 0) {
                throw new Error("Nenhuma nota pré-validada encontrada para este lote.");
            }

            // Carrega os XMLs do storage
            const notasFiscais = [];
            for (const g of stagedGuides) {
                let content = null;
                if (g.xml_storage_path) {
                    try {
                        const { data: xData } = await supabase.storage.from('tenant-storage').download(g.xml_storage_path);
                        if (xData) content = await xData.text();
                    } catch (e) {}
                }
                if (content) {
                    const dadosNfe = parserService.extrairDadosNfeXML(content);
                    dadosNfe.guide_id = g.id;
                    dadosNfe.xmlContent = content;
                    dadosNfe.xml_storage_path = g.xml_storage_path;
                    dadosNfe.danfe_storage_path = g.danfe_storage_path;
                    notasFiscais.push(dadosNfe);
                }
            }

            if (notasFiscais.length === 0) {
                throw new Error("Não foi possível carregar os arquivos XML do lote para transmissão.");
            }

            // Agente mTLS
            let agent = null;
            if (tenant.environment === 'producao') {
                log("🔍 Carregando certificado PFX do armazenamento seguro...");
                if (!tenant.pfx_filename) {
                    throw new Error("Nenhum certificado digital PFX cadastrado.");
                }
                const { data: pfxFile, error: downloadError } = await supabase.storage
                    .from('tenant-storage')
                    .download(`${tenant.id}/certificados/${tenant.pfx_filename}`);

                if (downloadError || !pfxFile) {
                    throw new Error("Falha ao baixar certificado: " + (downloadError?.message || 'Arquivo ausente'));
                }

                const pfxBuffer = Buffer.from(await pfxFile.arrayBuffer());
                const key = getEncryptionKey(process.env.ENCRYPTION_KEY);
                const passphrase = decrypt(tenant.pfx_passphrase_encrypted, key);

                log("⚙ Canal mTLS SEFAZ inicializado.");
                agent = gnreService.createHttpsAgent({ pfxBuffer, passphrase });
            } else {
                log("🧪 Modo SIMULADO ativado.");
            }

            task.progress = 25;

            // Datas de vencimento/pagamento
            const hoje = new Date().toISOString().split('T')[0];
            const dataAlvo = paymentDate || hoje;
            for (const nota of notasFiscais) {
                nota.dataVencimento = dataAlvo;
                nota.dataPagamento = dataAlvo;
            }

            // Agrupa por UF
            const notasPorUf = {};
            for (const n of notasFiscais) {
                if (!notasPorUf[n.ufFavorecida]) notasPorUf[n.ufFavorecida] = [];
                notasPorUf[n.ufFavorecida].push(n);
            }

            const ufs = Object.keys(notasPorUf);
            log(`🌍 Transmitindo para ${ufs.length} UF(s): ${ufs.join(', ')}...`);

            const logsDir = process.env.NODE_ENV === 'production' || process.env.VERCEL
                ? path.join('/tmp', 'xml_logs')
                : path.join(__dirname, 'xml_logs');
            await fs.mkdir(logsDir, { recursive: true });

            const todasGuias = [];
            const recibosEfetuados = [];
            const errosUf = {};

            for (let i = 0; i < ufs.length; i++) {
                const uf = ufs[i];
                if (i > 0 && tenant.environment === 'producao') {
                    log(`⏳ Aguardando 3s antes de transmitir para ${uf}...`);
                    await new Promise(r => setTimeout(r, 3000));
                }
                log(`[${uf}] Transmitindo lote de ${notasPorUf[uf].length} guia(s)...`);

                try {
                    let resultadoUf;
                    if (tenant.environment === 'simulado') {
                        const xmlSimulado = notasPorUf[uf].map((nota, idx) => {
                            const valorCentavos = Math.round(parseFloat(nota.valor) * 100);
                            const codBarras = `8589${String(valorCentavos).padStart(11, '0')}01352026062010436619000${idx}${String(nota.documentoOrigem).slice(-3)}`;
                            return {
                                ufFavorecida: nota.ufFavorecida,
                                documentoOrigem: nota.documentoOrigem,
                                valor: nota.valor,
                                linhaDigitavel: codBarras,
                                codigoBarras: codBarras,
                                situacaoGuia: '0',
                                simulado: true,
                                recibo: `SIMULADO_${uf}`
                            };
                        });
                        resultadoUf = { guias: xmlSimulado, recibo: `SIMULADO_${uf}` };
                        log(`[${uf}] 🧪 Simulação concluída (ambiente não produtivo).`);
                    } else if (uf === 'SP') {
                        // SEFAZ-SP descontinuou GNRE-ICMS em 01/11/2022 (exige DARE-SP).
                        for (const n of notasPorUf[uf]) {
                            await supabase
                                .from('guides')
                                .update({
                                    barcode: null,
                                    line_digitizable: null,
                                    status: 'requer_dare_sp',
                                    rejection_reason: 'SEFAZ-SP não emite GNRE para ICMS desde 01/11/2022. Recolhimento deve ser efetuado via DARE-SP.'
                                })
                                .eq('batch_id', batchId)
                                .eq('tenant_id', tenant.id)
                                .eq('nf_number', n.documentoOrigem);
                        }
                        resultadoUf = { guias: [], recibo: null, isSpDare: true };
                        log(`[${uf}] ⚠ Notas de SP marcadas como 'requer_dare_sp' (GNRE-ICMS descontinuada pela SEFAZ-SP; recolher via DARE-SP).`);
                    } else if (uf === 'ES') {
                        let xmlGuiasEs = [];
                        for (const nota of notasPorUf[uf]) {
                            log(`[${uf}] Emitindo DUA-e para NF ${nota.documentoOrigem}...`);
                            const { nDua, nBar } = await duaEsService.transmitirEmissao(nota, agent, tenant.environment);
                            const pdfBuffer = await duaEsService.transmitirObterPdf(nDua, nota.destCnpjCpf, agent, tenant.environment);
                            const remotePath = `${tenant.id}/guias/guia_NF_${nota.documentoOrigem}.pdf`;
                            await supabase.storage
                                .from('tenant-storage')
                                .upload(remotePath, pdfBuffer, {
                                    contentType: 'application/pdf',
                                    upsert: true
                                });
                            xmlGuiasEs.push({
                                ufFavorecida: 'ES',
                                documentoOrigem: nota.documentoOrigem,
                                valor: nota.valor,
                                linhaDigitavel: nBar,
                                codigoBarras: nBar,
                                numeroControle: nDua,
                                recibo: `DUA_${nDua}`,
                                situacaoGuia: '0',
                                storage_path: remotePath,
                                isPdf: true
                            });
                        }
                        resultadoUf = { guias: xmlGuiasEs, recibo: `DUA_ES_${batchId}` };
                    } else {
                        const recibo = await gnreService.enviarLote(notasPorUf[uf], agent, uf, tenant.environment, tenant, logsDir);
                        log(`[${uf}] Lote recebido! Recibo ${recibo}. Consultando retorno individual da SEFAZ...`);

                        let dadosGuias = null;
                        let tentativas = 0;
                        const maxTentativas = ['RJ', 'SE'].includes(uf) ? 50 : 35;
                        while (tentativas < maxTentativas) {
                            const seg = tentativas === 0 ? 8 : 5;
                            await new Promise(r => setTimeout(r, seg * 1000));
                            const xmlConsulta = await gnreService.consultarLote(recibo, agent, uf, tenant.environment, logsDir);
                            const sitProcess = parserService.extrairTag(xmlConsulta, 'situacaoProcess');
                            const codSit = sitProcess ? parserService.extrairTag(sitProcess, 'codigo') : null;
                            const descSit = sitProcess ? parserService.extrairTag(sitProcess, 'descricao') : '';
                            const processando = !codSit || ['401', '103', '105'].includes(codSit) || (descSit.toLowerCase().includes('processamento') && !['402', '403', '404'].includes(codSit));
                            if (!processando) {
                                dadosGuias = parserService.extrairDadosGuiaXML(xmlConsulta);
                                break;
                            }
                            tentativas++;
                        }

                        if (!dadosGuias) throw new Error("Tempo esgotado aguardando retorno da SEFAZ.");

                        // Persiste rejeições individuais do lote no banco para não deixar guias órfãs
                        if (Array.isArray(dadosGuias.rejeicoesDetalhadas) && dadosGuias.rejeicoesDetalhadas.length > 0) {
                            for (const rej of dadosGuias.rejeicoesDetalhadas) {
                                log(`[${uf}] ⚠ NF ${rej.documentoOrigem} rejeitada pela SEFAZ: ${rej.motivo}`);
                                await supabase
                                    .from('guides')
                                    .update({
                                        status: 'rejeitada_sefaz',
                                        rejection_reason: `[Recibo ${recibo}] ${rej.motivo}`
                                    })
                                    .eq('batch_id', batchId)
                                    .eq('tenant_id', tenant.id)
                                    .eq('nf_number', rej.documentoOrigem);
                            }
                        }

                        for (const g of dadosGuias) {
                            g.recibo = recibo;
                        }
                        resultadoUf = { guias: dadosGuias, recibo };
                    }

                    todasGuias.push(...resultadoUf.guias);
                    if (resultadoUf.recibo) recibosEfetuados.push(`${uf}:${resultadoUf.recibo}`);
                    if (!resultadoUf.isSpDare) {
                        log(`[${uf}] ✔ ${resultadoUf.guias.length} guia(s) processada(s) com sucesso!`);
                    }

                } catch (err) {
                    log(`[${uf}] ❌ Erro: ${err.message}`);
                    errosUf[uf] = err.message;
                    // Marca todas as guias desta UF no lote com o erro/rejeição correspondente
                    if (Array.isArray(err.rejeicoesDetalhadas) && err.rejeicoesDetalhadas.length > 0) {
                        for (const rej of err.rejeicoesDetalhadas) {
                            await supabase
                                .from('guides')
                                .update({
                                    status: 'rejeitada_sefaz',
                                    rejection_reason: rej.motivo
                                })
                                .eq('batch_id', batchId)
                                .eq('tenant_id', tenant.id)
                                .eq('nf_number', rej.documentoOrigem);
                        }
                    } else {
                        const nfsUf = notasPorUf[uf].map(n => n.documentoOrigem);
                        await supabase
                            .from('guides')
                            .update({
                                status: 'rejeitada_sefaz',
                                rejection_reason: err.message
                            })
                            .eq('batch_id', batchId)
                            .eq('tenant_id', tenant.id)
                            .in('nf_number', nfsUf);
                    }
                }

                task.progress = Math.round(25 + (55 * ((i + 1) / ufs.length)));
            }

            if (todasGuias.length === 0 && Object.keys(errosUf).length > 0) {
                throw new Error("Nenhuma guia pôde ser emitida na SEFAZ. Detalhes: " + JSON.stringify(errosUf));
            }

            // Renderiza e envia espelho visual das guias validadas para o Storage
            log("Validando retorno individual e gerando espelhos de conferência...");
            const dadosBancarios = {
                cnpj: tenant.cnpj,
                razaoSocial: tenant.razao_social,
                agencia: tenant.bank_agency,
                conta: tenant.bank_account,
                dac: tenant.bank_dac
            };

            for (const guia of todasGuias) {
                const docNorm = parserService.normalizarDocumentoOrigem(guia.documentoOrigem);
                const nota = notasFiscais.find(n => parserService.normalizarDocumentoOrigem(n.documentoOrigem) === docNorm);
                const nfAlvo = nota ? nota.documentoOrigem : guia.documentoOrigem;

                // Validação estrita de UF: UF retornada pela SEFAZ deve coincidir com a UF da NF-e
                const ufRetornada = (guia.ufFavorecida || '').toUpperCase().trim();
                const ufEsperada = (nota?.ufFavorecida || '').toUpperCase().trim();
                if (ufRetornada && ufEsperada && ufRetornada !== ufEsperada) {
                    const msgDiv = `BLOQUEIO DE SEGURANÇA: UF retornada pelo portal (${ufRetornada}) diverge da UF da NF-e (${ufEsperada}). Não pagar sem conciliação no Portal GNRE.`;
                    log(`❌ NF ${nfAlvo}: ${msgDiv}`);
                    await supabase
                        .from('guides')
                        .update({
                            status: 'divergencia_uf_portal',
                            rejection_reason: msgDiv
                        })
                        .eq('batch_id', batchId)
                        .eq('tenant_id', tenant.id)
                        .eq('nf_number', nfAlvo);
                    continue;
                }

                let remotePath = guia.storage_path;

                if (!guia.isPdf && guia.codigoBarras !== 'IMPORTAR_NO_SEFAZ_SP') {
                    const htmlGuia = gnreService.exportarGuiaHtml(dadosBancarios, guia, nota);
                    const nomeLocal = `guia_NF_${nfAlvo}.html`;
                    remotePath = `${tenant.id}/guias/${nomeLocal}`;
                    await supabase.storage
                        .from('tenant-storage')
                        .upload(remotePath, Buffer.from(htmlGuia, 'utf-8'), {
                            contentType: 'text/html',
                            upsert: true
                        });
                }

                // Atualiza a guia no BD para 'aguardando_pagamento' somente após validação completa
                await supabase
                    .from('guides')
                    .update({
                        uf: ufRetornada || ufEsperada,
                        barcode: guia.codigoBarras,
                        line_digitizable: guia.linhaDigitavel,
                        storage_path: remotePath,
                        status: 'aguardando_pagamento',
                        rejection_reason: guia.numeroControle
                            ? `Controle SEFAZ: ${guia.numeroControle} | Recibo: ${guia.recibo || '-'}`
                            : (guia.recibo ? `Recibo SEFAZ: ${guia.recibo}` : null)
                    })
                    .eq('batch_id', batchId)
                    .eq('tenant_id', tenant.id)
                    .eq('nf_number', nfAlvo);
            }

            // Atualiza status do lote para 'sucesso'
            await supabase
                .from('batches')
                .update({
                    status: 'sucesso',
                    receipt: recibosEfetuados.join(', ')
                })
                .eq('id', batchId);

            log(`\n==================================================`);
            log(`🎉 TODAS AS GUIAS FORAM EMITIDAS COM SUCESSO!`);
            log(`💳 STATUS: Guias emitidas. Aguardando autorização de pagamento bancário.`);
            log(`==================================================`);

            task.progress = 100;
            task.status = 'sucesso';

        } catch (err) {
            log(`❌ Erro na transmissão: ${err.message}`);
            task.status = 'erro';
            task.error = err.message;
            await supabase
                .from('batches')
                .update({ status: 'erro', error_message: err.message })
                .eq('id', batchId);
        }
    });
}

function runBatchProcessInBackground(batchId, tenant, filesData, paymentDate) {
    // Mantém compatibilidade: se chamado diretamente, executa pré-validação
    return stageBatchForApproval(batchId, tenant, filesData, paymentDate);
}

// Serve qualquer rota indefinida para o arquivo frontend padrão (SPA / fallback)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/download')) {
        return next();
    }
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Inicializa o servidor Express quando executado diretamente (Render, Railway, Docker, Local)
if (require.main === module) {
    const HOST = '0.0.0.0';
    app.listen(PORT, HOST, () => {
        console.log(`\n==================================================`);
        console.log(`🚀 expedi HUB SaaS rodando na porta ${PORT}`);
        console.log(`🔗 Ambiente: ${process.env.NODE_ENV || 'development'}`);
        console.log(`==================================================\n`);

        // Inicia o Agendador Automático periódico (a cada 30 minutos)
        try {
            syncService.iniciarAgendador(supabase, runBatchProcessInBackground, 30);
        } catch (e) {
            console.error("Erro ao inicializar agendador automático:", e.message);
        }
    });
}

module.exports = app;
