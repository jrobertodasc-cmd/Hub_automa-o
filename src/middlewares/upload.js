// src/middlewares/upload.js
// Configuração do Multer para processamento de arquivos em memória

const multer = require('multer');

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 100 }
});

module.exports = upload;
