// ============================================================== //
// MÓDULO: DOCA DE CARGAS, BIPAGEM & TEMPO REAL (SSE)              //
// ============================================================== //

function formatarDataEmissaoDoca(g) {
    let raw = g.emission_date || g.nf_issue_date || g.created_at || '';
    if (!raw && g.chave_nfe && g.chave_nfe.length === 44) {
        const aa = g.chave_nfe.substring(2, 4);
        const mm = g.chave_nfe.substring(4, 6);
        return { texto: `${mm}/20${aa}`, pill: `Emissão ${mm}/${aa}`, corPill: 'time-ok' };
    }

    if (!raw) {
        return { texto: 'Data N/D', pill: 'Sem data', corPill: 'time-warn' };
    }

    try {
        const d = new Date(raw);
        if (isNaN(d.getTime())) {
            if (raw.length >= 10 && raw.includes('-')) {
                const [ano, mes, dia] = raw.substring(0, 10).split('-');
                return { texto: `${dia}/${mes}/${ano}`, pill: `Emissão ${dia}/${mes}`, corPill: 'time-ok' };
            }
            return { texto: raw.substring(0, 10), pill: '', corPill: 'time-ok' };
        }

        const hojeObj = new Date();
        const hojeIso = hojeObj.toISOString().substring(0, 10);
        const dataIso = d.toISOString().substring(0, 10);
        const dia = String(d.getDate()).padStart(2, '0');
        const mes = String(d.getMonth() + 1).padStart(2, '0');

        if (dataIso === hojeIso) {
            return { texto: `${dia}/${mes} (Hoje)`, pill: 'Emitida hoje', corPill: 'time-ok' };
        }

        const diffDias = Math.max(0, Math.round((hojeObj.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)));
        let pillTxt = '';
        if (g.is_paga || g.paid_at) {
            pillTxt = 'Pago';
        } else if (diffDias === 0) {
            pillTxt = 'Hoje';
        } else if (diffDias === 1) {
            pillTxt = 'Ontem';
        } else {
            pillTxt = `${diffDias}d na doca`;
        }

        return { texto: `${dia}/${mes}`, pill: pillTxt, corPill: (!g.is_paga && diffDias > 3) ? 'time-warn' : 'time-ok' };
    } catch (e) {
        return { texto: 'Data N/D', pill: '', corPill: 'time-ok' };
    }
}
window.formatarDataEmissaoDoca = formatarDataEmissaoDoca;

// public/js/dashboard.js
// Lógica do Painel de Faturamento e Processamento de Lotes

let selectedFiles = [];
let pollingInterval = null;


// ==========================================
// ATUALIZAÇÃO EM TEMPO REAL NA DOCA (SSE + POLLING REDUNDANTE)
// ==========================================
function iniciarSSEAtualizacaoDoca() {
    try {
        const token = localStorage.getItem('sb_access_token');
        if (!token) {
            console.log("[SSE Doca] Aguardando autenticação para conectar canal em tempo real.");
            return;
        }

        if (!window.EventSource) {
            console.warn("[SSE Doca] Navegador sem suporte nativo a EventSource. Usando polling de fallback.");
            setInterval(carregarCargasDocaReais, 15000);
            return;
        }

        const sseUrl = `/api/events/dock?token=${encodeURIComponent(token)}`;
        const evtSource = new EventSource(sseUrl);

        evtSource.onmessage = function(event) {
            try {
                if (!event.data || event.data.startsWith(':')) return; // ignorar heartbeat keepalive
                const data = JSON.parse(event.data);
                console.log("[SSE Doca] Evento em tempo real recebido:", data);

                                if (data.type === 'GUIA_PAGA' || data.type === 'GUIA_ERRO' || data.type === 'LOTE_ATUALIZADO' || data.type === 'AUTO_SYNC_CONCLUIDO') {
                    // Atualiza Cockpit da doca, remessa e BI instantaneamente sem F5
                    if (typeof carregarPainelUnificadoDifal === 'function') {
                        carregarPainelUnificadoDifal(false);
                    }
                    if (typeof carregarCargasDocaReais === 'function') {
                        carregarCargasDocaReais();
                    }
                    if (typeof carregarResumoRemessaAoVivo === 'function') {
                        carregarResumoRemessaAoVivo();
                    }
                    if (typeof carregarDadosBI === 'function') {
                        carregarDadosBI();
                    }
                    if (typeof carregarStatusSync === 'function') {
                        carregarStatusSync();
                    }
                    if (typeof carregarCockpit360 === 'function' && document.getElementById('secao-view-ecommerce')?.style.display !== 'none') {
                        carregarCockpit360();
                    }
                    if (window.activeBatchId && typeof carregarDetalhesLote === 'function') {
                        carregarDetalhesLote(window.activeBatchId);
                    }
                    if (data.type === 'GUIA_PAGA') {
                        if (typeof showToast === 'function') {
                            showToast(`✓ NF-e ${data.nf} LIBERADA! Semáforo atualizado na doca.`, 'success');
                        }
                    } else if (data.type === 'GUIA_ERRO') {
                        if (typeof showToast === 'function') {
                            showToast(`✕ Falha no pagamento da NF-e ${data.nf}: ${data.motivo || 'Erro'}`, 'error');
                        }
                    }
                }
            } catch (err) {
                console.warn("[SSE Doca] Erro ao interpretar evento:", err);
            }
        };

        let sseErrorCount = 0;
        evtSource.onerror = function() {
            sseErrorCount++;
            if (sseErrorCount > 3) {
                console.warn("[SSE Doca] Limite de tentativas SSE atingido. Pausando reconexão.");
                evtSource.close();
            } else {
                console.warn("[SSE Doca] Conexão SSE instável. O navegador tentará reconectar automaticamente.");
            }
        };

        // Polling leve complementar a cada 20 segundos para garantir consistência
        setInterval(() => {
            if (typeof carregarCargasDocaReais === 'function') {
                carregarCargasDocaReais();
            }
        }, 20000);

    } catch (e) {
        console.warn("[SSE Doca] Falha ao iniciar SSE:", e);
        setInterval(carregarCargasDocaReais, 15000);
    }
}



async function carregarCargasDocaReais() {
    try {
        localStorage.removeItem('doca_liberada');
        const res = await fetch('/api/expedicao/cargas-ativas');
        if (!res.ok) {
            const tb = document.getElementById('guides-table-body');
            if (tb) tb.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:40px; color:#B42318; font-weight:600;">Falha ao carregar as guias (HTTP ${res.status}). Atualize a página ou faça login novamente.</td></tr>`;
            return;
        }
        const data = await res.json();
        if (!data || !data.cargas || data.cargas.length === 0) {
            console.log("Nenhuma carga ativa encontrada na Doca.");
            return;
        }

        const { resumo, porTransportadora, cargas } = data;
        window.currentBatchGuides = cargas;
        if (data.batch) window.activeBatchId = data.batch.id;

        // Auditoria precisa: guias com status AGENDADA, PAGA ou COMPROVADA estão 100% liberadas na doca
        const totalCount = cargas.length;
        const liberadasCalculadas = cargas.filter(g => {
            const st = (g.status || '').toUpperCase().trim();
            return st === 'PAGA' || st === 'COMPROVADA' || st === 'AGENDADA' || parseFloat(g.value || g.valor || 0) <= 0;
        }).length;
        const retidasCalculadas = totalCount - liberadasCalculadas;

        const liberadasCount = (resumo.liberadas !== undefined && resumo.liberadas > 0) ? resumo.liberadas : liberadasCalculadas;
        const retidasCount = (resumo.retidas !== undefined && resumo.liberadas > 0) ? resumo.retidas : retidasCalculadas;
        const difalTotalLote = resumo.valorTotal || 0;
        const difalPendente = (retidasCount === 0) ? 0 : (resumo.valorPendente || 0);

        // 1. Atualiza HUD Cards
        const kpiVol = document.getElementById('kpi-volumes');
        if (kpiVol) kpiVol.textContent = resumo.total;

        const kpiReady = document.getElementById('kpi-ready-val');
        if (kpiReady) kpiReady.textContent = liberadasCount;

        const kpiReadyBadge = document.getElementById('kpi-ready-badge');
        if (kpiReadyBadge) {
            const pct = resumo.total > 0 ? Math.round((liberadasCount / resumo.total) * 100) : 100;
            kpiReadyBadge.textContent = `${pct}% Pronto`;
        }

        const kpiStatus = document.getElementById('kpi-status');
        if (kpiStatus) kpiStatus.textContent = retidasCount;

        const kpiBlockedBadge = document.getElementById('kpi-blocked-badge');
        if (kpiBlockedBadge) {
            if (retidasCount === 0) {
                kpiBlockedBadge.textContent = '0 Retidas';
                kpiBlockedBadge.className = 'hud-badge hud-badge-green';
            } else {
                kpiBlockedBadge.textContent = `${retidasCount} Retidas`;
                kpiBlockedBadge.className = 'hud-badge hud-badge-red';
            }
        }

        const kpiDifal = document.getElementById('kpi-difal');
        if (kpiDifal) {
            kpiDifal.textContent = `R$ ${difalTotalLote.toFixed(2).replace('.', ',')}`;
        }

        // 2. Atualiza Cards de Coletas por Transportadora
        const totalExp = porTransportadora['Total Express'] || { total: 0, liberadas: 0, retidas: 0 };
        const totalLib = (retidasCount === 0) ? totalExp.total : totalExp.liberadas;
        const totalRet = (retidasCount === 0) ? 0 : totalExp.retidas;

        const badgeTotal = document.getElementById('carrier-total-badge');
        if (badgeTotal) {
            badgeTotal.textContent = `${totalLib} / ${totalExp.total} Prontos`;
            if (totalRet === 0) {
                badgeTotal.className = 'hud-badge hud-badge-green';
            }
        }

        const barTotal = document.getElementById('carrier-total-bar');
        if (barTotal) {
            const pct = totalExp.total > 0 ? (totalLib / totalExp.total) * 100 : 0;
            barTotal.style.width = `${pct}%`;
        }

        const retidasTotalEl = document.getElementById('carrier-total-retidas');
        if (retidasTotalEl) retidasTotalEl.textContent = totalRet;

        const libTotalEl = document.getElementById('carrier-total-liberadas');
        if (libTotalEl) libTotalEl.textContent = totalLib;

        // 3. Mantém fita limpa até haver leitura óptica real nesta sessão
        renderizarFitaUltimosBipados();

        // 4. Salva cargas e renderiza a primeira página paginada
        window.todasCargasDoca = cargas;
        window.cargasFiltradasDoca = cargas;

        // Atualiza Hero e Badge da Navbar
        const badgeNav = document.getElementById('nav-badge-pendentes');
        if (badgeNav) badgeNav.textContent = resumo.naoPagas || 0;

        const heroPend = document.getElementById('hero-qtd-pendentes');
        if (heroPend) {
            const qtdEmitir = resumo.naoPagas || 0;
            const qtdEmitidasAPagar = resumo.pendentes || 0;
            const valEmitir = (resumo.valorNaoPagas || 0).toFixed(2).replace('.', ',');
            const valAPagar = (resumo.valorPendentes || 0).toFixed(2).replace('.', ',');
            if (qtdEmitir > 0) {
                heroPend.textContent = `${qtdEmitir} ${qtdEmitir === 1 ? 'guia a emitir' : 'guias a emitir'} (R$ ${valEmitir})` + (qtdEmitidasAPagar > 0 ? ` · ${qtdEmitidasAPagar} já emitida(s)` : '');
            } else if (qtdEmitidasAPagar > 0) {
                heroPend.textContent = `✓ Todas emitidas! ${qtdEmitidasAPagar} guia(s) a pagar no banco (R$ ${valAPagar})`;
            } else {
                heroPend.textContent = 'Nenhuma guia pendente de emissão na SEFAZ';
            }
        }

        const heroConc = document.getElementById('hero-qtd-conciliadas');
        if (heroConc) {
            const qtdLib = resumo.pagas !== undefined ? resumo.pagas : liberadasCount;
            heroConc.textContent = `${qtdLib} ${qtdLib === 1 ? 'carga liberada' : 'cargas liberadas'} p/ coleta · ${resumo.total || totalCount} notas no lote`;
        }

        // Atualiza barra dedicada de São Paulo (Lote XML + Retorno DARE .ZIP)
        const notasSp = (cargas || []).filter(c => (c.uf || '').toUpperCase() === 'SP');
        const notasSpSemDare = notasSp.filter(c => !c.is_paga && !c.is_pendente);
        const notasSpComDare = notasSp.filter(c => c.is_pendente);
        const spBar = document.getElementById('sp-lote-bar');
        const spResumo = document.getElementById('sp-bar-resumo');
        const spDateInput = document.getElementById('sp-xml-date-input');
        const btnTopSpLabel = document.getElementById('btn-top-lote-sp-label');

        const guiaComVenc = (cargas || []).find(c => c.due_date && /^\d{4}-\d{2}-\d{2}/.test(String(c.due_date)));
        if (guiaComVenc && !localStorage.getItem('expedihub_sefaz_payment_date')) {
            salvarDataSefazPreferida(String(guiaComVenc.due_date).substring(0, 10));
        }
        if (spDateInput && !spDateInput.value) {
            spDateInput.value = obterDataSefazPreferida();
        }
        if (btnTopSpLabel) {
            btnTopSpLabel.textContent = notasSp.length > 0 ? `Lote SP (${notasSp.length})` : 'Lote SP (XML)';
        }
        if (spBar) {
            if (notasSp.length > 0) {
                spBar.style.display = 'flex';
                const somaSp = notasSpSemDare.reduce((acc, g) => acc + (parseFloat(g.value) || 0), 0);
                if (spResumo) {
                    if (notasSpSemDare.length > 0) {
                        spResumo.textContent = `São Paulo: ${notasSpSemDare.length} nota(s) aguardando DARE-SP (R$ ${somaSp.toFixed(2).replace('.', ',')})` + (notasSpComDare.length > 0 ? ` · ${notasSpComDare.length} já pronta(s) p/ pagar` : '');
                    } else if (notasSpComDare.length > 0) {
                        spResumo.textContent = `São Paulo: ✓ ${notasSpComDare.length} DARE(s) importada(s) com código de barras (prontas para Remessa Itaú)`;
                    } else {
                        spResumo.textContent = `São Paulo: ✓ ${notasSp.length} nota(s) de SP já quitadas/conciliadas`;
                    }
                }
            } else {
                spBar.style.display = 'none';
            }
        }

        // Retoma automaticamente o monitor SEFAZ se o lote estiver processando agora no servidor
        if (data.batch && data.batch.status === 'processando') {
            atualizarPainelLiveSefaz({
                visivel: true,
                status: 'processando',
                progress: data.batch.live_progress || 20,
                logs: data.batch.live_logs || []
            });
            if (!pollingInterval) {
                iniciarPollingLote(data.batch.id);
            }
        }

        // Seleção inteligente da aba inicial (se o operador ainda não clicou manualmente em uma aba)
        if (!window.usuarioJaFiltrouManualmente) {
            let abaAlvo = 'TODAS';
            let idBtnAlvo = 'tab-btn-todas';
            if ((resumo.naoPagas || 0) > 0) {
                abaAlvo = 'NAO_PAGAS';
                idBtnAlvo = 'tab-btn-nao-pagas';
            } else if ((resumo.pendentes || 0) > 0) {
                abaAlvo = 'PENDENTES';
                idBtnAlvo = 'tab-btn-pendentes';
            }
            filtroSituacaoAtivo = abaAlvo;
            const btnAlvo = document.getElementById(idBtnAlvo);
            if (btnAlvo && btnAlvo.parentElement) {
                btnAlvo.parentElement.querySelectorAll('.segmented-option-figma, .dock-underline-tab, .dock-tab-btn').forEach(b => b.classList.remove('active'));
                btnAlvo.classList.add('active');
            }
        }

        aplicarFiltrosRapidos();
        renderizarPaginaDoca(1);

        atualizarBotaoHeroDoca();
        if (typeof atualizarInterfaceRemessaViva === 'function') {
            atualizarInterfaceRemessaViva(data.remessa, data.batch, resumo);
        }

        // 6. Atualiza Painel Fintech e Metadados do Lote com formato limpo e dados reais
        if (data.batch) {
            const cleanReceipt = (data.remessa && data.remessa.codigoRemessa)
                ? data.remessa.codigoRemessa
                : (data.batch.id ? data.batch.id.substring(0, 8).toUpperCase() : 'LOTE');

            const summaryEl = document.getElementById('fintech-batch-summary');
            if (summaryEl) {
                const qtdRem = data.remessa ? data.remessa.qtdGuias : (resumo.pendentes || 0);
                const valRem = data.remessa ? data.remessa.valorTotal : (resumo.valorPendentes || 0);
                summaryEl.textContent = `Remessa #${cleanReceipt} · ${qtdRem} guia(s) na remessa (R$ ${valRem.toFixed(2).replace('.', ',')}) · Lote total: ${resumo.total} notas`;
            }

            const metaTag = document.getElementById('meta-batch-tag');
            if (metaTag) {
                const qtdRem = data.remessa ? data.remessa.qtdGuias : (resumo.pendentes || 0);
                metaTag.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg> Remessa #${cleanReceipt} · ${qtdRem} Guia(s) CNAB 240`;
            }
        }

        // 7. Atualiza Grid de Distribuição Fiscal por UF
        const ufGrid = document.getElementById('uf-distribution-grid');
        if (ufGrid && cargas.length > 0) {
            const porUf = {};
            cargas.forEach(g => {
                const uf = (g.uf || 'SP').toUpperCase().trim();
                if (!porUf[uf]) porUf[uf] = { count: 0, valor: 0 };
                porUf[uf].count++;
                porUf[uf].valor += parseFloat(g.value || g.valor || 0);
            });
            const ufsOrdenadas = Object.keys(porUf).sort((a, b) => porUf[b].valor - porUf[a].valor);
            ufGrid.innerHTML = ufsOrdenadas.map(uf => `
                <div class="uf-card-pill">
                    <div class="uf-card-top">
                        <span class="uf-badge">${uf}</span>
                        <span class="uf-tag-status">${uf === 'SP' ? 'DARE SP' : 'GNRE'}</span>
                    </div>
                    <div class="uf-card-val">R$ ${porUf[uf].valor.toFixed(2).replace('.', ',')}</div>
                    <div class="uf-card-count">${porUf[uf].count} ${porUf[uf].count === 1 ? 'guia' : 'guias'} · 🟢 Agendada</div>
                </div>
            `).join('');
        }

        // 7. Salva resumo e atualiza Contadores das 3 Abas Operacionais
        window.currentResumoLote = resumo;

        const tabTodas = document.getElementById('tab-cnt-todas');
        if (tabTodas) tabTodas.textContent = resumo.total;

        const tabPagas = document.getElementById('tab-cnt-pagas');
        if (tabPagas) tabPagas.textContent = resumo.pagas !== undefined ? resumo.pagas : liberadasCount;

        const tabPend = document.getElementById('tab-cnt-pendentes');
        if (tabPend) tabPend.textContent = resumo.pendentes !== undefined ? resumo.pendentes : (resumo.retidas || 0);

        const tabNaoPagas = document.getElementById('tab-cnt-nao-pagas');
        if (tabNaoPagas) tabNaoPagas.textContent = resumo.naoPagas !== undefined ? resumo.naoPagas : 0;

        // IDs legados para retrocompatibilidade
        const tabBloq = document.getElementById('tab-cnt-bloqueadas');
        if (tabBloq) tabBloq.textContent = resumo.naoPagas !== undefined ? resumo.naoPagas : retidasCount;
        const tabLib = document.getElementById('tab-cnt-liberadas');
        if (tabLib) tabLib.textContent = resumo.pagas !== undefined ? resumo.pagas : liberadasCount;
        const isentasCount = (cargas || []).filter(c => c.uf === 'SP').length;
        const tabIsentas = document.getElementById('tab-cnt-isentas');
        if (tabIsentas) tabIsentas.textContent = isentasCount;

        // Atualiza links e trava anti-duplicidade da Tesouraria
        atualizarLinksRemessaDoca();

        // Inicializa controles de data do painel fintech
        inicializarPainelFintechDoca();

        // Atualiza modal de conciliação se estiver aberto
        if (typeof renderizarConciliacao === 'function') renderizarConciliacao();

    } catch (e) {
        console.error("Erro ao carregar cargas reais da doca:", e);
        const tb = document.getElementById('guides-table-body');
        if (tb) tb.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:40px; color:#B42318; font-weight:600;">Erro ao exibir as guias: ${escapeHtml(e.message || String(e))}</td></tr>`;
    }
}
window.carregarCargasDocaReais = carregarCargasDocaReais;
