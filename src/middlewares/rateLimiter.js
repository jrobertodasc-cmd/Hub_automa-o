// src/middlewares/rateLimiter.js
// Rate limiters para proteção contra abusos e ataques de força bruta

const rateLimit = require('express-rate-limit');

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

module.exports = {
    apiLimiter,
    authLimiter
};
