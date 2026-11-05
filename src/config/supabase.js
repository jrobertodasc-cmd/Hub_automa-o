// src/config/supabase.js
// Cliente administrativo Supabase

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    if (process.env.NODE_ENV !== 'test') {
        console.warn('[Supabase Config] Alerta: SUPABASE_URL ou SUPABASE_KEY não configurados no ambiente.');
    }
}

const supabase = createClient(supabaseUrl || 'http://localhost:54321', supabaseKey || 'fake-key', {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

module.exports = supabase;
