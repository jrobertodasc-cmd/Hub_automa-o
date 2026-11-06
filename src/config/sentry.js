const Sentry = require('@sentry/node');

/**
 * Módulo de Observabilidade & Monitoramento em Tempo Real (Sentry)
 * expedi HUB Enterprise
 */

let isSentryInitialized = false;

function initSentry(app) {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
        console.log('[Observabilidade] SENTRY_DSN não definido. Monitoramento operando em modo fallback de log.');
        return;
    }

    try {
        Sentry.init({
            dsn: dsn,
            environment: process.env.NODE_ENV || 'production',
            tracesSampleRate: 1.0,
            integrations: [
                // Adiciona tracing automático para Express
                new Sentry.Integrations.Http({ tracing: true }),
                new Sentry.Integrations.Express({ app })
            ]
        });

        // RequestHandler cria um escopo separado para cada requisição
        app.use(Sentry.Handlers.requestHandler());
        // TracingHandler cria traces de performance para cada endpoint
        app.use(Sentry.Handlers.tracingHandler());

        isSentryInitialized = true;
        console.log('✓ [Observabilidade] Sentry inicializado com sucesso para captura de exceções em tempo real.');
    } catch (err) {
        console.warn('[Observabilidade] Falha ao inicializar SDK do Sentry:', err.message);
    }
}

function captureException(err, context = {}) {
    if (isSentryInitialized) {
        Sentry.withScope((scope) => {
            if (context.tenant) {
                scope.setTag('tenant_id', context.tenant.id || context.tenant);
                scope.setUser({ id: context.tenant.id, username: context.tenant.name });
            }
            if (context.tags) {
                Object.entries(context.tags).forEach(([k, v]) => scope.setTag(k, v));
            }
            if (context.extra) {
                scope.setExtras(context.extra);
            }
            Sentry.captureException(err);
        });
    } else {
        console.error('[ERRO CAPTURADO]', err.message, context);
    }
}

function captureMessage(msg, level = 'info', context = {}) {
    if (isSentryInitialized) {
        Sentry.withScope((scope) => {
            if (context.tenant) scope.setTag('tenant_id', context.tenant.id);
            scope.setLevel(level);
            Sentry.captureMessage(msg);
        });
    } else {
        console.log(`[LOG ${level.toUpperCase()}]`, msg, context);
    }
}

function setupSentryErrorHandler(app) {
    if (isSentryInitialized) {
        // O error handler do Sentry DEVE vir antes de qualquer outro error middleware
        app.use(Sentry.Handlers.errorHandler());
    }
}

module.exports = {
    initSentry,
    captureException,
    captureMessage,
    setupSentryErrorHandler,
    Sentry
};
