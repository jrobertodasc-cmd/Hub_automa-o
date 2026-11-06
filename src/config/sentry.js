const Sentry = require('@sentry/node');

/**
 * Módulo de Observabilidade & Monitoramento em Tempo Real (Sentry v11)
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
            tracesSampleRate: 1.0
        });

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
    if (isSentryInitialized && typeof Sentry.setupExpressErrorHandler === 'function') {
        Sentry.setupExpressErrorHandler(app);
    }
}

module.exports = {
    initSentry,
    captureException,
    captureMessage,
    setupSentryErrorHandler,
    Sentry
};
