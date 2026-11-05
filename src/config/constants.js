// src/config/constants.js
// Constantes de negócio e configurações do expedi HUB

const PLAN_LIMITS = {
    'trial': 10,
    'starter': 100,
    'pro': 500,
    'advanced': 1500,
    'inativo': 0,
    'ativo': 500 // fallback
};

const HOLDING_CNPJ = '00000000000191';
const BOAH_CNPJ = '10436619000105';

const MASTER_SUPERADMIN_EMAILS = [
    'jrobertodasc@gmail.com',
    'grupoaliadoshubtech@gmail.com'
];

module.exports = {
    PLAN_LIMITS,
    HOLDING_CNPJ,
    BOAH_CNPJ,
    MASTER_SUPERADMIN_EMAILS
};
