// Garante que a Total Express nao usa credenciais de outro cliente.
process.env.TOTAL_EXPRESS_ENABLED = 'true';
process.env.TOTAL_EXPRESS_USER = 'plataforma_user';
process.env.TOTAL_EXPRESS_PASSWORD = 'plataforma_pass';
const svc = require('../services/total_express_service.js');
(async () => {
  let fails = 0;
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  // sem credenciais explicitas: NAO pode usar a conta da plataforma
  try { await svc.consultarStatusEntrega({ notasFiscais: ['1'] }, {}); ok(false, 'sem credenciais deveria falhar'); }
  catch (e) { ok(/não configuradas/.test(e.message), 'servico recusa tenant sem credenciais proprias: ' + e.message); }
  // com credenciais explicitas: passa da validacao (falha depois, por rede, em outro ponto)
  try { await svc.consultarStatusEntrega({ notasFiscais: ['1'] }, { user: 'u', password: 'p' }); }
  catch (e) { ok(!/não configuradas/.test(e.message), 'com credenciais proprias passa da validacao (erro posterior: ' + String(e.message).slice(0, 40) + ')'); }
  console.log(fails ? fails + ' FALHA(S)' : 'OK');
  process.exit(fails ? 1 : 0);
})();
