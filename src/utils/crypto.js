// src/utils/crypto.js
// Utilitários de criptografia simétrica AES-256 e segurança temporal

const crypto = require('crypto');

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
        try {
            const legacyKey1 = getEncryptionKey('d7b5f12a893e4b0c7a6d9f8e5c3b2a10');
            return tryDecryptWithKey(legacyKey1);
        } catch {
            const legacyKey2 = getEncryptionKey('expedi_default_secret_key_32_bytes_long!!');
            return tryDecryptWithKey(legacyKey2);
        }
    }
}

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

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = {
    getEncryptionKey,
    encrypt,
    decrypt,
    safeCompareTokens,
    escapeHtml
};
