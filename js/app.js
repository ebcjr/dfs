import { db, generateUUID } from './db.js';
import { fitWeibull, weibullQuantile, getTailProb, fitCurtis, curtisResidual, robustMAD, fitIncrementBuffer } from './stats.js';


// 1. ESTADO DA APLICACAO
// Mantemos na memoria apenas o minimo necessario. O volume grosso
// de dados fica no IndexedDB e e consultado sob demanda.
const appState = {
  campaign: null,
  currentPlotId: null,
  editingTreeId: null,
  selectedCat: null,
  sortOrder: 'logical', // 'logical', 'dap', 'ht', 'cat'
  covaDisplayMode: 'absolute', // 'relative' ou 'absolute'
  plotDataSource: 'atual'
};

const CATEGORIES = [
  { code: 1, label: 'Normal', key: 'normal' },
  { code: 0, label: 'Falha', key: 'falha' },
  { code: 9, label: 'Dominante', key: 'dominante' },
  { code: 2, label: 'Dominada', key: 'dominada' },
  { code: 7, label: 'Ponta seca', key: 'ponta_seca' },
  { code: 5, label: 'Torta', key: 'torta' },
  { code: 6, label: 'Bifurcada ac', key: 'bifurcada_acima' },
  { code: 4, label: 'Morta', key: 'morta' },
  { code: 8, label: 'Morta quebrada', key: 'mq' },
  { code: 3, label: 'Quebrada', key: 'quebrada' },
  { code: 10, label: 'Cancro', key: 'cancro' },
  { code: 11, label: 'Inclinada', key: 'inclinada' },
  { code: 12, label: 'Caida', key: 'caida' }
];

const DEAD_CATS = ['morta','mq','caida'];
const FALHA_CATS = ['falha'];
const ALIVE_CATS = ['normal', 'dominada', 'ponta_seca', 'torta', 'bifurcada_acima','inclinada' ,'cancro'];
const CURTIS_EXCLUDE = ['morta', 'falha', 'quebrada', 'torta','mq','inclinada','caida'];
const getNoMeasureCats = () => appState.campaign?.measureDead ? ['falha'] : ['falha', 'morta','mq'];

// 2. INICIALIZACAO E ROTEAMENTO
document.addEventListener('DOMContentLoaded', async () => {
  await initCampaign();
  setupEventDelegation();
  go('screen-home');
});

async function initCampaign() {
  const campaigns = await db.campaigns.toArray();
  if (campaigns.length === 0) {
    const defaultCampaign = { 
      name: 'Inventario Padrao', 
      year: new Date().getFullYear(),
      outlierSD: 2.0,
      measureDead: false
    };
    defaultCampaign.id = await db.campaigns.add(defaultCampaign);
    appState.campaign = defaultCampaign;
  } else {
    // Carrega a ultima campanha registrada
    appState.campaign = campaigns[campaigns.length - 1];
  }
}

function go(screenId) {
  const root = document.getElementById('app-root');
  
  // Injeta o esqueleto das telas se for a primeira carga
  if (!document.getElementById('screen-home')) {
    root.innerHTML = `
      <div class="screen" id="screen-home"></div>
      <div class="screen" id="screen-plot"></div>
      <div class="screen" id="screen-settings"></div>
    `;
  }

  // Alterna a visibilidade
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');

  // Direciona para o renderizador correto
  if (screenId === 'screen-home') renderHome();
  // As proximas telas serao implementadas nos proximos passos
  // if (screenId === 'screen-plot') renderPlot();
  // if (screenId === 'screen-settings') renderSettings();
}

// 3. TELA INICIAL (HOME) & OTIMIZACOES
async function renderHome() {
  const homeScreen = document.getElementById('screen-home');
  
  // Consultas assincronas no banco: nao travam a interface
  const totalPlots = await db.plots.count();
  const donePlots = await db.plots.where('status').equals('done').count();
  const allTrees = await db.trees.toArray(); 
  const flagCount = allTrees.reduce((acc, t) => acc + (t.flags ? t.flags.length : 0), 0);

  homeScreen.innerHTML = `
    <div class="topbar" style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div class="topbar-title">DendroFS 1.13 ebcjr</div>
        <div class="topbar-sub" id="home-campaign-name">${appState.campaign.name || 'Sem campanha'}</div>
      </div>
      
      <button class="btn" data-action="go-settings" style="width: auto; background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3); color: #fff; font-size: 13px; padding: 6px 14px; border-radius: 6px; font-weight: 500;">
        Projetos ⚙
      </button>

    </div>
    <div class="content">
      <div style="display: flex; gap: 8px; margin-bottom: 10px;">
        <div class="field" style="flex: 1; margin-bottom: 0;">
          <input type="text" id="search-input" placeholder="Buscar parcela, fazenda ou talhão...">
        </div>
        <button class="btn btn-primary" data-action="open-plot-form" style="width: auto; padding: 0 16px;">+ Parcela</button>
      </div>

      <div class="stats-bar">
        <div class="stat-box"><div class="stat-num">${totalPlots}</div><div class="stat-lbl">parcelas</div></div>
        <div class="stat-box"><div class="stat-num">${donePlots}</div><div class="stat-lbl">concluidas</div></div>
        <div class="stat-box"><div class="stat-num">${flagCount}</div><div class="stat-lbl">flags</div></div>
      </div>

      <div id="plot-list"></div>
      <div class="safe"></div>
    </div>

    <div class="modal-overlay hidden" id="modal-new-plot" style="z-index: 2000;">
      <div class="modal">
        <div class="modal-title">Nova Parcela</div>
        <div class="field"><label>Fazenda</label><input type="text" id="np-fazenda"></div>
        <div class="field-row">
          <div class="field"><label>Talhão</label><input type="text" id="np-talhao"></div>
          <div class="field"><label>ID Parcela</label><input type="text" id="np-numero"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Coord. X</label><input type="number" id="np-x" inputmode="decimal"></div>
          <div class="field"><label>Coord. Y</label><input type="number" id="np-y" inputmode="decimal"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Área Parcela (m²)</label><input type="number" id="np-area" inputmode="decimal"></div>
          <div class="field"><label>Rotação</label><input type="number" id="np-rotacao" inputmode="decimal"></div>
        </div>
        <div class="field-row" style="margin-top:14px">
          <button class="btn btn-secondary btn-sm" data-action="close-plot-form">Cancelar</button>
          <button class="btn btn-primary btn-sm" data-action="save-new-plot">Salvar</button>
        </div>
      </div>
    </div>
    
    <div class="modal-overlay hidden" id="modal-edit-coords" style="z-index: 2000;">
      <div class="modal">
        <div class="modal-title" id="mec-title">Editar Coordenadas</div>
        <input type="hidden" id="mec-plot-id">
        <div class="field-row">
          <div class="field"><label>Coord. X</label><input type="number" id="mec-x" inputmode="decimal"></div>
          <div class="field"><label>Coord. Y</label><input type="number" id="mec-y" inputmode="decimal"></div>
        </div>
        <div class="field-row" style="margin-top:14px">
          <button class="btn btn-secondary btn-sm" data-action="close-edit-coords">Cancelar</button>
          <button class="btn btn-primary btn-sm" data-action="save-edit-coords">Salvar</button>
        </div>
      </div>
    </div>
  `;

  // Reconecta o evento de busca com Debounce
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(async (e) => {
      await renderPlotList(e.target.value);
    }, 300)); // Aguarda 300ms apos a ultima tecla
  }

  await renderPlotList('');
}

async function renderPlotList(query = '') {
  const container = document.getElementById('plot-list');
  const q = query.toLowerCase().trim();
  
  let plots = await db.plots.toArray();
  
  if (q) {
    plots = plots.filter(p => 
      (p.numero + '').toLowerCase().includes(q) || 
      p.fazenda.toLowerCase().includes(q) || 
      p.talhao.toLowerCase().includes(q)
    );
  }

  if (plots.length === 0) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">🌿</div><div class="empty-text">Nenhuma parcela encontrada</div></div>';
    return;
  }

  // Varredura rápida de Histórico e Flags
  const trees = await db.trees.toArray();
  const history = await db.history.toArray();

  // Mapeia a quantidade de flags por parcela
  const flagsCount = {};
  trees.forEach(t => {
    if (t.flags && t.flags.length > 0) {
      flagsCount[t.plotId] = (flagsCount[t.plotId] || 0) + t.flags.length;
    }
  });

  // Identifica quais parcelas possuem histórico atrelado
  const hasHistory = new Set();
  history.forEach(h => hasHistory.add(h.plotId));

  const grouped = {};
  plots.forEach(p => {
    const f = p.fazenda || 'Sem Fazenda';
    const t = p.talhao || 'Sem Talhão';
    if (!grouped[f]) grouped[f] = {};
    if (!grouped[f][t]) grouped[f][t] = [];
    grouped[f][t].push(p);
  });

  const order = { active: 0, pending: 1, done: 2 };
  const fragment = document.createDocumentFragment();

  for (const fazenda in grouped) {
    const fazendaDetails = document.createElement('details');
    fazendaDetails.className = 'tree-details';
    fazendaDetails.open = true;
    fazendaDetails.innerHTML = `<summary class="tree-summary"><span class="tree-icon">▶</span> 🌳 ${fazenda}</summary><div class="tree-content"></div>`;
    
    const fazendaContent = fazendaDetails.querySelector('.tree-content');

    for (const talhao in grouped[fazenda]) {
      const talhaoDetails = document.createElement('details');
      talhaoDetails.className = 'tree-details tree-details-sub';
      talhaoDetails.open = true;
      talhaoDetails.innerHTML = `<summary class="tree-summary tree-summary-sub"><span class="tree-icon">▶</span> 📍 Talhão ${talhao}</summary><div class="tree-content tree-content-sub"></div>`;
      
      const talhaoContent = talhaoDetails.querySelector('.tree-content-sub');
      let talhaoPlots = grouped[fazenda][talhao];
      talhaoPlots.sort((a, b) => (order[a.status] || 1) - (order[b.status] || 1) || (a.numero + '').localeCompare(b.numero + ''));

      talhaoPlots.forEach(p => {
        const statusLabel = { pending: 'Pendente', active: 'Em andamento', done: 'Concluída' }[p.status] || 'Pendente';
        const badgeClass = { pending: 'badge-pending', active: 'badge-active', done: 'badge-done' }[p.status] || 'badge-pending';
        
        const plotDiv = document.createElement('div');
        plotDiv.className = 'plot-item';
        plotDiv.style.marginBottom = '8px';
        plotDiv.style.padding = '12px';
        plotDiv.dataset.action = 'open-plot';
        plotDiv.dataset.plotId = p.id;

        // Construção dos emblemas visuais da parcela
        const nFlags = flagsCount[p.id] || 0;
        const flagsHtml = nFlags > 0 ? `<span class="badge badge-warn" style="margin-right:6px; font-size:10px;">🚩 ${nFlags}</span>` : '';
        const histHtml = hasHistory.has(p.id) ? `<span title="Possui histórico" style="font-size:14px; margin-right:6px; opacity: 0.8;">🕒</span>` : '';

        // Injeção do HTML atualizado
        plotDiv.innerHTML = `
          <div class="plot-num" style="min-width: 45px">#${p.numero}</div>
          <div class="plot-info">
            <div class="plot-meta" style="margin-top:0">
              ${p.x != null && p.y != null ? `x: ${p.x}<br>y: ${p.y}` : 'Sem coordenadas'}
            </div>
          </div>
          <div class="plot-right" style="display:flex; align-items:center;">
            <button class="btn-icon" data-action="edit-plot-coords" data-plot-id="${p.id}" style="font-size:14px; margin-right:8px; padding:4px;" title="Editar Coordenadas">✏️</button>
            ${flagsHtml}
            ${histHtml}
            <span class="badge ${badgeClass}">${statusLabel}</span>
          </div>
        `;
        talhaoContent.appendChild(plotDiv);
      });

      fazendaContent.appendChild(talhaoDetails);
    }
    fragment.appendChild(fazendaDetails);
  }

  container.innerHTML = '';
  container.appendChild(fragment);
}

// 4. DELEGACAO DE EVENTOS & UTILITARIOS
function setupEventDelegation() {
  document.body.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    // Navegacao Principal
    if (action === 'go-settings') { go('screen-settings'); renderSettings(); } 
    else if (action === 'go-home') { go('screen-home'); renderHome(); } 
    
    // Acoes de Parcela
    else if (action === 'open-plot') {
      appState.currentPlotId = target.dataset.plotId;
      go('screen-plot');
      renderPlot();
    } 
    else if (action === 'close-plot') {
      await closePlot();
    }
    else if (action === 'show-gabarito') { await showGabarito(); }
    else if (action === 'close-gabarito') { document.getElementById('modal-gabarito').classList.add('hidden'); }
    else if (action === 'show-plot-info') { await showPlotInfo(); }
    else if (action === 'close-plot-info') {
      document.getElementById('modal-plot-info').classList.add('hidden'); }
    else if (action === 'open-plot-form') { openNewPlotForm(); }
    else if (action === 'close-plot-form') { document.getElementById('modal-new-plot').classList.add('hidden'); }
    else if (action === 'save-new-plot') { await saveNewPlot(); }
    else if (action === 'open-plot') {
      appState.currentPlotId = target.dataset.plotId;
      appState.plotDataSource = 'atual'; // RESET: Abre sempre na aba atual
      go('screen-plot');
      renderPlot();
    }
    else if (action === 'trigger-import-plots') { document.getElementById('import-plots-input').click(); } 
    else if (action === 'trigger-import-history') { document.getElementById('import-hist-input').click(); } 
    else if (action === 'trigger-import-backup') { document.getElementById('import-backup-input').click(); }
    
    // acoes de edicao de Coordenadas
    else if (action === 'edit-plot-coords') { openEditCoordsForm(target.dataset.plotId); }
    else if (action === 'close-edit-coords') { document.getElementById('modal-edit-coords').classList.add('hidden'); }
    else if (action === 'save-edit-coords') { await savePlotCoords(); }
    // acoes das abas da parcela
    else if (action === 'tab-atual') { appState.plotDataSource = 'atual'; await renderPlot(); }
    else if (action === 'tab-historico') { appState.plotDataSource = 'historico'; await renderPlot(); }
    // Acoes de arvore
    else if (action === 'open-tree-form') {
      const treeId = target.dataset.treeId || null;
      await openTreeForm(treeId);
    } 
    else if (action === 'close-tree-form') {
      document.getElementById('modal-tree').classList.add('hidden');
    } 
    else if (action === 'select-cat') { selectCat(target.dataset.catKey); } 
    else if (action === 'save-tree') { await saveTree('next-cova'); }
    else if (action === 'save-tree-fuste') { await saveTree('next-fuste'); }
    
    else if (action === 'delete-tree') { await deleteTree(); }
    else if (action === 'inc-fila') {
      const f = document.getElementById('t-fila');
      f.value = (parseInt(f.value) || 0) + 1;
    }
    else if (action === 'dec-fila') {
      const f = document.getElementById('t-fila');
      const val = (parseInt(f.value) || 0) - 1;
      f.value = val < 1 ? 1 : val;
    }
    
    // Acoes de Zoom
    else if (action === 'zoom-in') {
      appState.gabaritoZoom = (appState.gabaritoZoom || 1) + 0.25;
      await drawGabaritoMap();
    }
    else if (action === 'zoom-out') {
      appState.gabaritoZoom = Math.max(0.25, (appState.gabaritoZoom || 1) - 0.25);
      await drawGabaritoMap();
    }
    
    // Acoes de Configuracao
    else if (action === 'save-campaign') { saveCampaign(); } 
    else if (action === 'trigger-import-plots') { document.getElementById('import-plots-input').click(); } 
    else if (action === 'trigger-import-history') { document.getElementById('import-hist-input').click(); } 
    else if (action === 'wipe-data') { await wipeAllData(); }
    else if (action === 'find-dominants') { await findDominants(); }
    else if (action === 'validate-plot') { 
      showToast('Avaliando...');
      const result = await validateBiometrics(appState.currentPlotId);
      await refreshPlotData();
      const curtisInfo = result.curtisModel
        ? ` · Curtis R²=${result.curtisModel.r2.toFixed(2)} (n=${result.curtisModel.n})`
        : '';
      showToast(`${result.nFlags} flag(s) biométrica(s)${curtisInfo}`);
    }
    else if (action === 'save-campaign') { saveCampaign(); } 
    else if (action === 'export-data') { await exportData(); }
  });
  document.body.addEventListener('change', async (e) => {
    if (e.target.id === 'sort-trees') {
      appState.sortOrder = e.target.value;
      await refreshPlotData();
    } else if (e.target.id === 'display-cova') {
      appState.covaDisplayMode = e.target.value;
      await refreshPlotData();
    } else if (e.target.id === 't-inst') {
      toggleInstrument(e.target.value);
    }
    else if (e.target.id === 'gab-esp-x' || e.target.id === 'gab-esp-y') {
      await drawGabaritoMap(); 
    }
    else if (e.target.id === 'gab-source' || e.target.id === 'gab-esp-x' || e.target.id === 'gab-esp-y') {
      await drawGabaritoMap(); 
    }
  });
}

// Funcao de Debounce para nao travar a busca enquanto o usuario digita
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 5. UTILITARIOS GERAIS
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 2500);
}

function parseDateSafe(dateStr) {
  if (!dateStr) return null;
  let d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.getTime();
  
  const parts = dateStr.split(/[\s/:-]+/);
  if (parts.length >= 3) {
     d = new Date(parts[2], parts[1] - 1, parts[0], parts[3]||0, parts[4]||0, parts[5]||0);
     if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

async function handleImportBackup(e) {
  const file = e.target.files[0];
  if (!file) return;

  showToast('Processando restauração...');

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const lines = event.target.result.trim().split(/\r?\n/);
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = (k) => headers.indexOf(k);

      const plotsMap = new Map();
      const treesRows = [];
      const plotIdsInCsv = new Set();

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep);
        if (cols.length < 15) continue; 

        const fazenda = (cols[idx('fazenda')] || '').trim();
        const talhao = (cols[idx('talhao')] || '').trim();
        const parcela = (cols[idx('parcela')] || '').trim();

        if (!parcela) continue;

        // Reconstrói a chave biológica única da parcela
        const plotId = `${fazenda}-${talhao}-${parcela}`.toLowerCase().replace(/\s+/g, '');
        plotIdsInCsv.add(plotId);

        // Agrupa os metadados da parcela
        if (!plotsMap.has(plotId)) {
          plotsMap.set(plotId, {
            id: plotId,
            campaignId: appState.campaign?.id || 'restored-campaign',
            numero: parcela,
            fazenda: fazenda,
            talhao: talhao,
            x: parseNumber(cols[idx('x')]),
            y: parseNumber(cols[idx('y')]),
            rotacao: parseNumber(cols[idx('rotacao')]),
            area: parseNumber(cols[idx('area')]),
            tsFinalizacao: parseDateSafe(cols[idx('momentofinalizacao')]),
            status: 'active'
          });
        }

        // Agrupa as medidas da árvore
        treesRows.push({
          plotId: plotId,
          fila: parseInt(cols[idx('fila')]),
          cova: parseInt(cols[idx('cova')]),
          fuste: parseInt(cols[idx('fuste')]) || 1,
          inst: cols[idx('instrumento')] || 'dap',
          med1: parseNumber(cols[idx('medida_1')]),
          med2: parseNumber(cols[idx('medida_2')]),
          dap: parseNumber(cols[idx('dap')]),
          ht: parseNumber(cols[idx('ht')]),
          cat: cols[idx('categoria')],
          sync_status: cols[idx('sync_status')] || 'pending',
          tsDAP: parseDateSafe(cols[idx('momentomedicaodap')]),
          tsHT: parseDateSafe(cols[idx('momentomedicaoht')])
        });
      }

      // Busca as árvores que já existem no banco local para estas parcelas
      const treeLookup = new Map();
      for (const pId of plotIdsInCsv) {
        const existingInPlot = await db.trees.where('plotId').equals(pId).toArray();
        existingInPlot.forEach(t => {
          treeLookup.set(`${t.plotId}-${t.fila}-${t.cova}-${t.fuste}`, t);
        });
      }

      const treesToPut = [];
      
      // Mescla os dados: atualiza as existentes ou cria as novas
      treesRows.forEach(row => {
        const treeKey = `${row.plotId}-${row.fila}-${row.cova}-${row.fuste}`;
        const existing = treeLookup.get(treeKey);
        
        if (existing) {
          treesToPut.push({
            ...existing,
            ...row,
            id: existing.id // Trava o ID original interno do Dexie
          });
        } else {
          treesToPut.push({
            ...row,
            id: generateUUID(),
            ts: Date.now()
          });
        }
      });

      // Salva em lote usando o motor assíncrono do Dexie
      await db.plots.bulkPut(Array.from(plotsMap.values()));
      await db.trees.bulkPut(treesToPut);

      showToast(`Sucesso! ${plotsMap.size} parcelas restauradas.`);
      e.target.value = '';
      
      // Se estiver com uma parcela aberta, recarrega a tela para mostrar os dados injetados
      if (appState.currentPlotId) {
        await refreshPlotData();
      }
      
    } catch (err) {
      showToast('Erro ao restaurar backup. Verifique o CSV.');
      console.error(err);
    }
  };
  reader.readAsText(file);
}

function customConfirm(title, message, confirmText = 'Sim', cancelText = 'Cancelar') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '2000'; 
    overlay.style.alignItems = 'center'; 
    overlay.style.justifyContent = 'center';

    const box = document.createElement('div');
    box.className = 'card';
    box.style.width = '85%';
    box.style.maxWidth = '360px';
    box.style.margin = '0';
    box.style.padding = '20px';
    box.style.boxShadow = '0 10px 25px rgba(0,0,0,0.2)';

    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = title;
    titleEl.style.marginBottom = '12px';

    const msgEl = document.createElement('div');
    msgEl.style.fontSize = '14px';
    msgEl.style.color = 'var(--text2)';
    msgEl.style.marginBottom = '24px';
    msgEl.style.whiteSpace = 'pre-wrap';
    msgEl.textContent = message;

    const btnRow = document.createElement('div');
    btnRow.className = 'field-row';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-secondary btn-sm';
    btnCancel.textContent = cancelText;
    btnCancel.onclick = () => { document.body.removeChild(overlay); resolve(false); };

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'btn btn-primary btn-sm';
    btnConfirm.textContent = confirmText;
    btnConfirm.onclick = () => { document.body.removeChild(overlay); resolve(true); };

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnConfirm);
    box.appendChild(titleEl);
    box.appendChild(msgEl);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

function formatLocalTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => n.toString().padStart(2, '0');
  
  // Retorna no formato YYYY-MM-DD HH:MM:SS
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function openEditCoordsForm(plotId) {
  const plot = await db.plots.get(plotId);
  if (!plot) return;
  
  document.getElementById('mec-plot-id').value = plot.id;
  document.getElementById('mec-title').textContent = `Editar Coord. - Parcela ${plot.numero}`;
  document.getElementById('mec-x').value = plot.x != null ? plot.x : '';
  document.getElementById('mec-y').value = plot.y != null ? plot.y : '';
  
  document.getElementById('modal-edit-coords').classList.remove('hidden');
}

async function savePlotCoords() {
  const plotId = document.getElementById('mec-plot-id').value;
  const xRaw = document.getElementById('mec-x').value;
  const yRaw = document.getElementById('mec-y').value;
  
  // Converte para float lidando com virgula ou ponto
  const newX = xRaw !== '' ? parseFloat(xRaw.replace(',', '.')) : null;
  const newY = yRaw !== '' ? parseFloat(yRaw.replace(',', '.')) : null;

  await db.plots.update(plotId, {
    x: newX,
    y: newY
  });

  document.getElementById('modal-edit-coords').classList.add('hidden');
  showToast('Coordenadas atualizadas ✓');
  
  // Recarrega a lista preservando a busca atual
  await renderPlotList(document.getElementById('search-input').value);
}

function toggleInstrument(inst) {
  const wrapDap = document.getElementById('wrap-dap');
  const wrapFita = document.getElementById('wrap-fita');
  const wrapSuta = document.getElementById('wrap-suta');
  
  if(!wrapDap) return;

  wrapDap.classList.add('hidden');
  wrapFita.classList.add('hidden');
  wrapSuta.classList.add('hidden');
  wrapSuta.style.display = 'none';

  if (inst === 'dap') wrapDap.classList.remove('hidden');
  if (inst === 'fita') wrapFita.classList.remove('hidden');
  if (inst === 'suta') {
    wrapSuta.classList.remove('hidden');
    wrapSuta.style.display = 'flex'; // Mantem o grid lado a lado
  }
}

function parseNumber(val) {
  if (!val) return null;
  // Substitui virgula por ponto para
  const parsed = parseFloat(val.replace(',', '.'));
  return isNaN(parsed) ? null : parsed;
}

// 6. TELA DE CONFIGURACOES e IMPORTACAO
function renderSettings() {
  const screen = document.getElementById('screen-settings');
  const campaign = appState.campaign;

  screen.innerHTML = `
    <div class="topbar">
      <button class="btn-icon" data-action="go-home">←</button>
      <div class="topbar-title">Configurações</div>
    </div>
    <div class="content">
      <div class="sec">Campanha ativa</div>
      <div class="card">
        <div class="field">
          <label>Nome da campanha</label>
          <input type="text" id="cfg-campaign" value="${campaign.name || ''}" placeholder="ex: Inventário 2026">
        </div>
        <div class="field-row">
          <div class="field">
            <label>Ano de medição</label>
            <input type="number" id="cfg-year" value="${campaign.year || new Date().getFullYear()}" inputmode="numeric">
          </div>
        </div>
        <button class="btn btn-primary" data-action="save-campaign">Salvar</button>
      </div>

      <div class="sec">Importar parcelas</div>
      <div class="card">
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">CSV com colunas: <code>parcela,fazenda,talhao,x,y,rotacao,area</code></p>
        <div class="file-drop" data-action="trigger-import-plots">
          <div style="font-size:24px;margin-bottom:6px">📄</div>
          <div>Toque para importar CSV de parcelas</div>
        </div>
        <input type="file" id="import-plots-input" accept=".csv,.CSV" class="hidden">
      </div>

      <div class="sec">Importar histórico (ano anterior)</div>
      <div class="card">
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">CSV com colunas: <code>parcela,fazenda,talhao,fila,cova,fuste,dap,ht,categoria</code></p>
        <div class="file-drop" data-action="trigger-import-history">
          <div style="font-size:24px;margin-bottom:6px">📂</div>
          <div>Toque para importar histórico CSV</div>
        </div>
        <input type="file" id="import-hist-input" accept=".csv,.CSV" class="hidden">
      </div>
      
      <div class="sec">Restaurar Backup / Continuar Coleta</div>
      <div class="card">
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Importe o <b>CSV Exportado</b> por este app para retomar medições incompletas ou restaurar dados.</p>
        <div class="file-drop" data-action="trigger-import-backup">
          <div style="font-size:24px;margin-bottom:6px">🔄</div>
          <div>Toque para importar CSV Exportado</div>
        </div>
        <input type="file" id="import-backup-input" accept=".csv,.CSV" class="hidden">
      </div>
      
      <div class="sec">Exportar dados</div>
      <div class="card">
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Exporta todas as medições desta campanha como CSV.</p>
        <button class="btn btn-secondary" data-action="export-data">⬇ Exportar CSV de medições</button>
      </div>

      <div class="sec">Dados do Dispositivo</div>
      <div class="card">
        <button class="btn btn-danger" data-action="wipe-data">⚠ Apagar TODOS os dados</button>
      </div>
      <div class="safe"></div>
    </div>
  `;

  // Anexa os eventos de mudanca de arquivo diretamente apos renderizar
  document.getElementById('import-plots-input').addEventListener('change', handleImportPlots);
  document.getElementById('import-hist-input').addEventListener('change', handleImportHistory);
  document.getElementById('import-backup-input').addEventListener('change', handleImportBackup);
}

async function saveCampaign() {
  appState.campaign.name = document.getElementById('cfg-campaign').value.trim();
  appState.campaign.year = parseInt(document.getElementById('cfg-year').value) || new Date().getFullYear();
  
  await db.campaigns.put(appState.campaign);
  showToast('Campanha salva');
}

function openNewPlotForm() {
  document.getElementById('np-fazenda').value = '';
  document.getElementById('np-talhao').value = '';
  document.getElementById('np-numero').value = '';
  document.getElementById('np-area').value = '';
  document.getElementById('np-x').value = '';
  document.getElementById('np-y').value = '';
  document.getElementById('np-rotacao').value = '';
  document.getElementById('modal-new-plot').classList.remove('hidden');
}

async function saveNewPlot() {
  const fazenda = document.getElementById('np-fazenda').value.trim();
  const talhao = document.getElementById('np-talhao').value.trim();
  const numero = document.getElementById('np-numero').value.trim();
  const area = parseNumber(document.getElementById('np-area').value);
  const x = parseNumber(document.getElementById('np-x').value);
  const y = parseNumber(document.getElementById('np-y').value);
  const rotacao = parseNumber(document.getElementById('np-rotacao').value);

  if (!numero) return showToast('O número da parcela é obrigatório!');

  const compositeId = `${fazenda}-${talhao}-${numero}`.toLowerCase().replace(/\s+/g, '');
  
  const exists = await db.plots.get(compositeId);
  if (exists) return showToast('Esta parcela já está registrada!');

  await db.plots.add({
    id: compositeId,
    campaignId: appState.campaign.id,
    numero: numero,
    fazenda: fazenda,
    talhao: talhao,
    x: x,
    y: y,
    rotacao: rotacao,
    area: area,
    status: 'pending' // Estado inicial para forçar a triagem na home
  });

  document.getElementById('modal-new-plot').classList.add('hidden');
  showToast('Parcela criada com sucesso!');
  await renderPlotList(document.getElementById('search-input').value);
}

async function handleImportPlots(e) {
  const file = e.target.files[0];
  if (!file) return;

  const measureDead = await customConfirm(
    'Metodologia', 
    'Deseja registrar DAP/HT para árvores MORTAS nesta campanha?\n\n[Sim] = Exigir medição\n[Não] = Apenas categorizar',
    'Sim', 'Não'
  );
  appState.campaign.measureDead = measureDead;
  await db.campaigns.put(appState.campaign);

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const lines = event.target.result.trim().split(/\r?\n/);
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = (k) => headers.indexOf(k);

      const plotsToAdd = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep);
        if (cols.length < 2) continue;

        const numero = (cols[idx('parcela')] || cols[idx('id')] || '').trim();
        const fazenda = (cols[idx('fazenda')] || '').trim();
        const talhao = (cols[idx('talhao')] || '').trim();

        if (!numero) continue;

        // Chave composta unica para evitar duplicatas em reimportacoes
        const compositeId = `${fazenda}-${talhao}-${numero}`.toLowerCase().replace(/\s+/g, '');

        plotsToAdd.push({
          id: compositeId,
          campaignId: appState.campaign.id,
          numero: numero,
          fazenda: fazenda,
          talhao: talhao,
          x: parseNumber(cols[idx('x')]),
          y: parseNumber(cols[idx('y')]),
          rotacao: parseNumber(cols[idx('rotacao')]),
          area: parseNumber(cols[idx('area')]),
          status: 'pending'
        });
      }

      // Salva tudo no banco em lote
      await db.plots.bulkPut(plotsToAdd);
      showToast(`${plotsToAdd.length} parcelas importadas!`);
      e.target.value = '';
    } catch (err) {
      showToast('Erro ao importar CSV');
      console.error(err);
    }
  };
  reader.readAsText(file);
}

async function handleImportHistory(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const lines = event.target.result.trim().split(/\r?\n/);
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());
      const idx = (k) => headers.indexOf(k);

      const historyToAdd = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep);
        if (cols.length < 4) continue;

        const numeroStr = (cols[idx('parcela')] || cols[idx('parcela_id')] || '').trim();
        const fazenda = (cols[idx('fazenda')] || '').trim();
        const talhao = (cols[idx('talhao')] || '').trim();

        let targetPlotId = numeroStr;
        if (fazenda && talhao) {
          targetPlotId = `${fazenda}-${talhao}-${numeroStr}`.toLowerCase().replace(/\s+/g, '');
        }

        // Criando um ID único para a linha do histórico
        const fila = parseInt(cols[idx('fila')]) || 0;
        const cova = parseInt(cols[idx('cova')]) || 0;
        const fuste = parseInt(cols[idx('fuste')]) || 1;
        const historyId = `${targetPlotId}-${fila}-${cova}-${fuste}`;

        historyToAdd.push({
          id: historyId,
          plotId: targetPlotId,
          fila: fila,
          cova: cova,
          fuste: fuste,
          dap: parseNumber(cols[idx('dap')]),
          ht: parseNumber(cols[idx('ht')]),
          cat: (cols[idx('categoria')] || '').trim()
        });
      }

      await db.history.bulkPut(historyToAdd);
      showToast(`${historyToAdd.length} registros históricos importados!`);
      e.target.value = '';
    } catch (err) {
      showToast('Erro ao importar Histórico');
      console.error(err);
    }
  };
  reader.readAsText(file);
}

async function wipeAllData() {
  const step1 = await customConfirm('Atenção Crítica', 'Apagar TODOS os dados? Isso não pode ser desfeito.', 'Apagar', 'Cancelar');
  if (step1) {
    const step2 = await customConfirm('Tem certeza absoluta?', 'Você perderá todas as medições não exportadas.', 'Sim, apagar tudo', 'Cancelar');
    if (step2) {
      await db.plots.clear();
      await db.trees.clear();
      await db.history.clear();
      showToast('Banco de dados limpo.');
      go('screen-home');
    }
  }
}

// Traduz a Cova sequencial do banco para a Cova por fila visual
function buildCovaMap(trees) {
  const map = {};
  const filas = {};
  
  trees.forEach(t => {
    if (!filas[t.fila]) filas[t.fila] = new Set();
    filas[t.fila].add(t.cova);
  });
  
  for (const f in filas) {
    filas[f] = Array.from(filas[f]).sort((a,b) => a-b);
  }
  
  trees.forEach(t => {
    const sorted = filas[t.fila];
    map[t.id] = sorted ? sorted.indexOf(t.cova) + 1 : t.cova;
  });
  
  return { map, filasSeq: filas };
}

// ============================================================
// 7. TELA DA PARCELA & LISTA DE ARVORES
// ============================================================
async function renderPlot() {
  const plot = await db.plots.get(appState.currentPlotId);
  if (!plot) return go('screen-home');

  appState.plotDataSource = appState.plotDataSource || 'atual';
  const isHistory = appState.plotDataSource === 'historico';

  // Decide de qual banco de dados puxar a lista
  let trees = [];
  if (isHistory) {
    trees = await db.history.where('plotId').equals(plot.id).toArray();
  } else {
    trees = await db.trees.where('plotId').equals(plot.id).toArray();
  }
  
  trees.sort((a, b) => {
    if (appState.sortOrder === 'logical') {
      if (a.fila !== b.fila) return a.fila - b.fila;
      if (a.cova !== b.cova) return a.cova - b.cova;
      return a.fuste - b.fuste;
    } else if (appState.sortOrder === 'dap') {
      return (b.dap || 0) - (a.dap || 0);
    } else if (appState.sortOrder === 'ht') {
      return (b.ht || 0) - (a.ht || 0);
    } else if (appState.sortOrder === 'cat') {
      return (a.cat || '').localeCompare(b.cat || '');
    }
  });

  const htMedidas = trees.filter(t => t.ht != null).length;
  // O histórico não tem flags de consistência a serem resolvidas agora
  const totalPlotFlags = isHistory ? 0 : trees.reduce((acc, t) => acc + (t.flags ? t.flags.length : 0), 0);

  const screen = document.getElementById('screen-plot');
  
  screen.innerHTML = `
    <div class="topbar">
      <button class="btn-icon" data-action="go-home">←</button>
      <div style="flex:1">
        <div class="topbar-title">Parcela ${plot.numero}</div>
        <div class="topbar-sub">${plot.fazenda} · ${plot.talhao}</div>
      </div>
      <button class="btn-icon" data-action="show-plot-info" title="Info">ℹ</button>
    </div>
    <div class="content">

      <div style="display:flex; border-bottom:1px solid var(--border); margin-bottom:12px;">
        <div data-action="tab-atual" style="flex:1; text-align:center; padding:10px; cursor:pointer; font-weight:bold; font-size:14px; transition: 0.2s; ${!isHistory ? 'color:var(--green); border-bottom:2px solid var(--green);' : 'color:var(--text2);'}">Atual</div>
        <div data-action="tab-historico" style="flex:1; text-align:center; padding:10px; cursor:pointer; font-weight:bold; font-size:14px; transition: 0.2s; ${isHistory ? 'color:var(--amber); border-bottom:2px solid var(--amber);' : 'color:var(--text2);'}">Histórico</div>
      </div>

      <div class="stats-bar" style="margin-bottom:10px">
        <div class="stat-box"><div class="stat-num">${trees.length}</div><div class="stat-lbl">observações</div></div>
        <div class="stat-box"><div class="stat-num">${htMedidas}</div><div class="stat-lbl">HT medidas</div></div>
        <div class="stat-box"><div class="stat-num">${totalPlotFlags}</div><div class="stat-lbl">flags</div></div>
      </div>

      <div class="sec" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <span>Fustes</span>
        <div style="display: flex; gap: 4px;">
          <select id="display-cova" style="padding:4px; font-size:11px; border-color:var(--border); border-radius:4px; outline:none;">
            <option value="relative" ${appState.covaDisplayMode === 'absolute' ? '' : 'selected'}>Covas: Por fila</option>
            <option value="absolute" ${appState.covaDisplayMode === 'absolute' ? 'selected' : ''}>Covas: Sequencial</option>
          </select>
          <select id="sort-trees" style="padding:4px; font-size:11px; border-color:var(--border); border-radius:4px; outline:none;">
            <option value="logical" ${appState.sortOrder === 'logical' ? 'selected' : ''}>Ord: Fuste</option>
            <option value="dap" ${appState.sortOrder === 'dap' ? 'selected' : ''}>Ord: DAP</option>
            <option value="ht" ${appState.sortOrder === 'ht' ? 'selected' : ''}>Ord: HT</option>
            <option value="cat" ${appState.sortOrder === 'cat' ? 'selected' : ''}>Ord: Cat</option>
          </select>
        </div>
      </div>

      <div id="tree-list"></div>

      ${!isHistory ? `
        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; margin-top:12px">
          <button class="btn btn-primary" data-action="open-tree-form" style="grid-column: 1 / -1; padding: 12px; font-size: 16px;">+ Fuste</button>
          <button class="btn btn-secondary" data-action="find-dominants" style="border-color:var(--green); color:var(--green); font-size: 12px;">🔍 Doms</button>
          <button class="btn btn-secondary" data-action="validate-plot" style="border-color:var(--amber); color:var(--amber); font-size: 12px;">⚡ Validar</button>
          <button class="btn btn-secondary" data-action="show-gabarito" style="border-color:#3498db; color:#3498db; font-size: 12px;">🗺 Gabarito</button>
        </div>
      ` : `
        <div style="margin-top:12px">
          <button class="btn btn-secondary" data-action="show-gabarito" style="border-color:#3498db; color:#3498db; width:100%;">🗺 Ver no Gabarito</button>
        </div>
      `}

      <div style="margin-top:10px">
        <button class="btn btn-secondary" data-action="close-plot">Concluir parcela</button>
      </div>
      <div class="safe"></div>
    </div>
    
    <div class="modal-overlay hidden" id="modal-tree">
      <div class="modal" id="modal-tree-inner">
        
        <div class="modal-title" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span id="modal-tree-title-text" style="white-space:nowrap;">Novo Fuste</span>
            <span id="t-relative-cova" style="display:none; background:#ccc; color:#000; padding:2px 6px; border:1px solid #999; border-radius:2px; font-size:12px; font-weight:600; white-space:nowrap;"></span>
          </div>
          
          <div style="display:flex; align-items:center; gap:8px;">
            <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--text2); margin:0; cursor:pointer;">
              <input type="checkbox" id="t-central" style="width:14px; height:14px; accent-color:var(--green); cursor:pointer;">
              Centro
            </label>
            <select id="t-inst" style="font-size:11px; padding:4px; border:none; background:var(--bg); border-radius:4px; color:var(--text3); outline:none;">
              <option value="fita">Fita (CAP)</option>
              <option value="dap">DAP Padrão</option>
              <option value="suta">Suta (D1/D2)</option>
            </select>
          </div>
        </div>

        <div class="field-row3" style="display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 8px;">
          <div class="field">
            <label>Fila</label>
            <div style="display:flex; align-items:stretch; height:34px; border:1px solid var(--border); border-radius:4px; overflow:hidden;">
              <button data-action="dec-fila" style="width:32px; flex-shrink:0; background:#eef2f3; border:none; border-right:1px solid var(--border); color:var(--text1); font-weight:bold; font-size:16px; cursor:pointer; margin:0; padding:0;">-</button>
              
              <input type="number" id="t-fila" inputmode="numeric" min="1" style="border:none; border-radius:0; text-align:center; flex:1; min-width:0; margin:0; padding:0; outline:none; font-size:14px;">
              
              <button data-action="inc-fila" style="width:32px; flex-shrink:0; background:#eef2f3; border:none; border-left:1px solid var(--border); color:var(--text1); font-weight:bold; font-size:16px; cursor:pointer; margin:0; padding:0;">+</button>
            </div>
          </div>
          <div class="field"><label>Cova</label><input type="number" id="t-cova" inputmode="numeric" min="1" style="height:34px; width:100%; box-sizing:border-box;"></div>
          <div class="field"><label>Fuste</label><input type="number" id="t-fuste" inputmode="numeric" min="1" value="1" style="height:34px; width:100%; box-sizing:border-box;"></div>
        </div>
        
        <div class="field-row">
          <div class="field" id="wrap-dap">
            <label>DAP (cm)</label>
            <input type="number" id="t-dap" inputmode="decimal" step="0.1">
          </div>
          
          <div class="field hidden" id="wrap-fita">
            <label>CAP (cm)</label>
            <input type="number" id="t-cap" inputmode="decimal" step="0.1">
          </div>
          
          <div class="field hidden" id="wrap-suta" style="display:flex; gap:8px;">
            <div style="flex:1"><label>DAP 1</label><input type="number" id="t-dap1" inputmode="decimal" step="0.1"></div>
            <div style="flex:1"><label>DAP 2</label><input type="number" id="t-dap2" inputmode="decimal" step="0.1"></div>
          </div>
          
          <div class="field"><label>HT (m)</label><input type="number" id="t-ht" inputmode="decimal" step="0.1"></div>
        </div>

        <div class="field">
          <label>Categoria</label>
          <div class="cat-grid" id="cat-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;"></div>
        </div>
        <div class="field-row" style="margin-top:14px; display:flex; gap:8px;">
          <button class="btn btn-secondary btn-sm" data-action="close-tree-form" style="flex:1;">Cancelar</button>
          <button class="btn btn-primary btn-sm" id="btn-add-fuste" data-action="save-tree-fuste" style="flex:1; background:#2980b9; border-color:#2980b9; color:#fff;">+ Fuste</button>
          <button class="btn btn-primary btn-sm" id="btn-save-tree" data-action="save-tree" style="flex:1.5;">+ Cova</button>
        </div>
        <div id="modal-delete-btn" class="hidden" style="margin-top:8px">
          <button class="btn btn-danger btn-sm" data-action="delete-tree" style="width:100%">Excluir medição</button>
        </div>
      </div>
    </div>
    <div class="modal-overlay hidden" id="modal-plot-info">
      <div class="modal">
        <div class="modal-title">Info da parcela</div>
        <div id="plot-info-content"></div>
        <button class="btn btn-secondary btn-sm" data-action="close-plot-info" style="margin-top:14px">Fechar</button>
      </div>
    </div>
    <div class="modal-overlay hidden" id="modal-gabarito" style="z-index: 1500;">
      <div class="modal" style="width: 95%; max-width: 500px; height: 85vh; display: flex; flex-direction: column; padding: 12px;">
        
        <div class="modal-title" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px; font-size: 16px;">
          <span>Gabarito</span>
          <div style="display:flex; align-items:center; gap:6px;">
            <label style="font-size:12px; margin:0; color:var(--text2);">Fonte:</label>
            <select id="gab-source" style="padding:4px; font-size:12px; border-color:var(--border); border-radius:4px; outline:none; background:var(--bg);">
              <option value="atual">Atual</option>
              <option value="historico">Histórico</option>
            </select>
          </div>
        </div>
        
        <div class="field-row" style="margin-bottom: 8px;">
          <div class="field" style="margin-bottom:0;">
            <label style="font-size:11px;">X (m)</label>
            <input type="number" id="gab-esp-x" inputmode="decimal" step="0.1" value="3.15" style="padding:6px;">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label style="font-size:11px;">Y (m)</label>
            <input type="number" id="gab-esp-y" inputmode="decimal" step="0.1" style="padding:6px;">
          </div>
        </div>

        <div style="font-size: 10px; color: var(--text3); margin-bottom: 8px; text-align: center;">
          (Fila 1, Cova 1 no canto inferior esquerdo)
        </div>

        <div style="position: relative; flex: 1; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: #eef2f3;">
          
          <div style="position: absolute; right: 10px; top: 10px; display: flex; flex-direction: column; gap: 8px; z-index: 100;">
            <button class="btn-icon" data-action="zoom-in" style="background: white; box-shadow: 0 2px 5px rgba(0,0,0,0.2); width:32px; height:32px; border-radius:4px; font-size:18px; line-height:1; color:var(--text1);">+</button>
            <button class="btn-icon" data-action="zoom-out" style="background: white; box-shadow: 0 2px 5px rgba(0,0,0,0.2); width:32px; height:32px; border-radius:4px; font-size:18px; line-height:1; color:var(--text1);">-</button>
          </div>
          
          <div id="gabarito-container" style="width: 100%; height: 100%; overflow: auto; position: relative;">
            </div>
        </div>

        <div class="field-row" style="margin-top:14px">
          <button class="btn btn-secondary btn-sm" style="width: 100%" data-action="close-gabarito">Fechar</button>
        </div>
      </div>
    </div>
  `;

  // Renderiza a lista de arvores e a grade de categorias
  const { map: covaMap } = buildCovaMap(trees);
  renderTreeListHTML(trees, covaMap);
  buildCatGrid();

  // Atualiza o status da parcela se for a primeira vez abrindo
  if (plot.status === 'pending') {
    await db.plots.update(plot.id, { status: 'active' });
  }
}

async function refreshPlotData() {
  const isHistory = appState.plotDataSource === 'historico';
  let trees = [];
  
  if (isHistory) {
    trees = await db.history.where('plotId').equals(appState.currentPlotId).toArray();
  } else {
    trees = await db.trees.where('plotId').equals(appState.currentPlotId).toArray();
  }
  
  trees.sort((a, b) => {
    if (appState.sortOrder === 'logical') {
      if (a.fila !== b.fila) return a.fila - b.fila;
      if (a.cova !== b.cova) return a.cova - b.cova;
      return a.fuste - b.fuste;
    } else if (appState.sortOrder === 'dap') {
      return (b.dap || 0) - (a.dap || 0);
    } else if (appState.sortOrder === 'ht') {
      return (b.ht || 0) - (a.ht || 0);
    } else if (appState.sortOrder === 'cat') {
      return (a.cat || '').localeCompare(b.cat || '');
    }
  });

  const { map: covaMap } = buildCovaMap(trees);
  renderTreeListHTML(trees, covaMap);

  const htMedidas = trees.filter(t => t.ht != null).length;
  const totalPlotFlags = isHistory ? 0 : trees.reduce((acc, t) => acc + (t.flags ? t.flags.length : 0), 0);
  
  const statNums = document.querySelectorAll('#screen-plot .stat-num');
  if (statNums.length >= 3) {
    statNums[0].textContent = trees.length;
    statNums[1].textContent = htMedidas;
    statNums[2].textContent = totalPlotFlags;
  }
}
function renderTreeListHTML(trees, covaMap = {}) {
  const container = document.getElementById('tree-list');
  if (!container) return;
  if (trees.length === 0) {
    container.innerHTML = '<div class="empty"><div class="empty-text">Nenhum fuste registado</div></div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  
  // VERIFICA SE ESTAMOS NA ABA DO HISTÓRICO
  const isHistory = appState.plotDataSource === 'historico';

  trees.forEach(t => {
    const cat = CATEGORIES.find(c => c.key === t.cat);
    const item = document.createElement('div');
    item.className = `tree-item ${t.cat === 'dominante' ? 'dom-highlight' : ''}`;
    
    // Se NÃO for histórico, permite clicar. 
    // Se for histórico, bloqueia o clique (cursor normal).
    if (!isHistory) {
      item.dataset.action = 'open-tree-form';
      item.dataset.treeId = t.id;
      item.style.cursor = 'pointer';
    } else {
      item.style.cursor = 'default';
    }

    const flagsHtml = t.flags && t.flags.length 
      ? `<div class="tree-flags" style="margin-top:6px;">${t.flags.map(f => 
          `<span class="badge ${f.type === 'err' ? 'badge-err' : 'badge-warn'}" style="font-size:10px">${f.msg}</span>`
        ).join('')}</div>` : '';

    let dapDisplay = '';
    if (t.dap != null) {
      if (t.inst === 'fita' && t.med1 != null) {
        dapDisplay = `<span class="tree-val"><b>${t.med1.toFixed(1)}</b>cm (CAP) ➝ <b>${t.dap.toFixed(1)}</b>cm</span>`;
      } else if (t.inst === 'suta' && t.med1 != null && t.med2 != null) {
        dapDisplay = `<span class="tree-val"><b>${t.med1.toFixed(1)}|${t.med2.toFixed(1)}</b> (Suta) ➝ <b>${t.dap.toFixed(1)}</b>cm</span>`;
      } else {
        dapDisplay = `<span class="tree-val"><b>${t.dap.toFixed(1)}</b> cm</span>`;
      }
    }

    const relCova = covaMap[t.id] || t.cova;
    const displayCova = appState.covaDisplayMode === 'absolute' ? t.cova : relCova;
    
    const centralBadge = t.central ? '<span style="color:var(--amber); margin-left:4px;">📍</span>' : '';

    // A setinha '>' na penúltima linha só aparece se NÃO for histórico
    item.innerHTML = `
      <div class="tree-id">${t.fila}-${displayCova}-${t.fuste} ${centralBadge}</div>
      <div style="flex:1">
        <div class="tree-vals">
          ${dapDisplay}
          ${t.ht != null ? `<span class="tree-val"><b>${t.ht.toFixed(1)}</b> m</span>` : ''}
          <span class="tree-val">${cat ? cat.label : '?'}</span>
        </div>
        ${flagsHtml}
      </div>
      ${!isHistory ? '<span style="color:var(--text3);font-size:16px">›</span>' : ''}
    `;
    fragment.appendChild(item);
  });

  container.innerHTML = '';
  container.appendChild(fragment);
}
// 8. FORMULARIO DE ARVORE E SALVAMENTO
function buildCatGrid() {
  const grid = document.getElementById('cat-grid');
  if (!grid) return;
  grid.innerHTML = CATEGORIES.map(c => `
    <button class="cat-btn" data-cat-key="${c.key}" data-action="select-cat">
      <div class="cat-code">${c.code}</div>${c.label}
    </button>`).join('');
}

function selectCat(key) {
  appState.selectedCat = key;
  document.querySelectorAll('.cat-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.catKey === key);
  });

  const dapInput = document.getElementById('t-dap');
  const htInput = document.getElementById('t-ht');
  
  // Limpa os campos se for categoria que nao exige medicao
  if (getNoMeasureCats().includes(key)) {
    dapInput.value = '';
    htInput.value = '';
  }
}

async function openTreeForm(treeId) {
  appState.editingTreeId = treeId;
  appState.selectedCat = null;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('selected'));
  
  const deleteBtn = document.getElementById('modal-delete-btn');
  const btnFuste = document.getElementById('btn-add-fuste');
  const btnSave = document.getElementById('btn-save-tree');
  const relCovaBox = document.getElementById('t-relative-cova');

  if (treeId) {
    const t = await db.trees.get(treeId);
    if (!t) return;
    
    document.getElementById('modal-tree-title-text').textContent = 'Editar árvore';
    if (relCovaBox) {
      const trees = await db.trees.where('plotId').equals(appState.currentPlotId).toArray();
      const { map: covaMap } = buildCovaMap(trees);
      const relCova = covaMap[treeId] || t.cova;
      relCovaBox.textContent = `${relCova}ª cova da fila ${t.fila}`;
      relCovaBox.style.display = 'inline-block';
    }
    
    if (btnFuste) btnFuste.style.display = 'none';
    if (btnSave) btnSave.textContent = 'Salvar';

    document.getElementById('t-fila').value = t.fila;
    document.getElementById('t-cova').value = t.cova;
    document.getElementById('t-fuste').value = t.fuste;
    
    const inst = t.inst || 'dap';
    document.getElementById('t-inst').value = inst;
    if (typeof toggleInstrument === 'function') toggleInstrument(inst);
    
    document.getElementById('t-dap').value = (inst === 'dap' && t.dap != null) ? t.dap : '';
    if (document.getElementById('t-cap')) document.getElementById('t-cap').value = (inst === 'fita' && t.med1 != null) ? t.med1 : '';
    if (document.getElementById('t-dap1')) document.getElementById('t-dap1').value = (inst === 'suta' && t.med1 != null) ? t.med1 : '';
    if (document.getElementById('t-dap2')) document.getElementById('t-dap2').value = (inst === 'suta' && t.med2 != null) ? t.med2 : '';
    
    document.getElementById('t-ht').value = t.ht != null ? t.ht : '';
    if (document.getElementById('t-central')) document.getElementById('t-central').checked = !!t.central;
    
    selectCat(t.cat);
    if (deleteBtn) deleteBtn.classList.remove('hidden'); 
    
  } else {
    document.getElementById('modal-tree-title-text').textContent = 'Nova árvore';
    if (relCovaBox) relCovaBox.style.display = 'none';
    
    if (btnFuste) btnFuste.style.display = 'block';
    if (btnSave) btnSave.textContent = '+ Cova';

    const currInst = document.getElementById('t-inst').value || 'dap';
    if (typeof toggleInstrument === 'function') toggleInstrument(currInst);

    // MÁGICA: Puxa do banco a última posição física trabalhada
    const trees = await db.trees.where('plotId').equals(appState.currentPlotId).toArray();
    if (trees.length > 0) {
       trees.sort((a, b) => {
          if (a.fila !== b.fila) return b.fila - a.fila;
          if (a.cova !== b.cova) return b.cova - a.cova;
          return b.fuste - a.fuste;
       });
       const last = trees[0];
       document.getElementById('t-fila').value = last.fila;
       document.getElementById('t-cova').value = last.cova + 1;
    } else {
       document.getElementById('t-fila').value = '1';
       document.getElementById('t-cova').value = '1';
    }
    
    document.getElementById('t-fuste').value = '1';
    document.getElementById('t-dap').value = '';
    if (document.getElementById('t-cap')) document.getElementById('t-cap').value = '';
    if (document.getElementById('t-dap1')) document.getElementById('t-dap1').value = '';
    if (document.getElementById('t-dap2')) document.getElementById('t-dap2').value = '';
    document.getElementById('t-ht').value = '';
    if (document.getElementById('t-central')) document.getElementById('t-central').checked = false;
    
    if (deleteBtn) deleteBtn.classList.add('hidden'); 
  }
  
  document.getElementById('modal-tree').classList.remove('hidden');
}

async function deleteTree() {
  if (!appState.editingTreeId) return; 
  
  if (!confirm('Tem certeza que deseja excluir esta medição?')) return;
  
  await db.trees.delete(appState.editingTreeId);
  
  document.getElementById('modal-tree').classList.add('hidden');
  showToast('Medição excluída');
  
  // Padronizado: Roda apenas a validação leve ao excluir
  await validateHistory(appState.currentPlotId);
  
  await refreshPlotData();
}
async function saveTree(mode = 'next-cova') {
  const fila = parseInt(document.getElementById('t-fila').value);
  const cova = parseInt(document.getElementById('t-cova').value);
  const fuste = parseInt(document.getElementById('t-fuste').value) || 1;
  const cat = appState.selectedCat;
  const central = document.getElementById('t-central') ? document.getElementById('t-central').checked : false; 
  
  const inst = document.getElementById('t-inst').value;
  let dap = null, med1 = null, med2 = null;

  if (inst === 'dap') {
    const dapRaw = document.getElementById('t-dap').value;
    dap = dapRaw !== '' ? parseFloat(dapRaw.replace(',', '.')) : null;
  } else if (inst === 'fita') {
    const capRaw = document.getElementById('t-cap').value;
    med1 = capRaw !== '' ? parseFloat(capRaw.replace(',', '.')) : null;
    if (med1 != null) dap = med1 / Math.PI;
  } else if (inst === 'suta') {
    const d1Raw = document.getElementById('t-dap1').value;
    const d2Raw = document.getElementById('t-dap2').value;
    med1 = d1Raw !== '' ? parseFloat(d1Raw.replace(',', '.')) : null;
    med2 = d2Raw !== '' ? parseFloat(d2Raw.replace(',', '.')) : null;
    if (med1 != null && med2 != null) dap = (med1 + med2) / 2;
    else if (med1 != null) dap = med1;
    else if (med2 != null) dap = med2;
  }

  const htRaw = document.getElementById('t-ht').value;
  const ht = htRaw !== '' ? parseFloat(htRaw.replace(',', '.')) : null;

  if (!fila || !cova) return showToast('Informe fila e cova');
  if (!cat) return showToast('Selecione uma categoria');
  
  if (!getNoMeasureCats().includes(cat)) {
    if (inst === 'dap' && dap == null) return showToast('Informe o DAP');
    if (inst === 'fita' && med1 == null) return showToast('Informe o CAP');
    if (inst === 'suta' && (med1 == null || med2 == null)) return showToast('Informe DAP 1 e DAP 2');
  }

  let tsDAP = null;
  let tsHT = null;
  const now = Date.now();

  if (appState.editingTreeId) {
    const existingTree = await db.trees.get(appState.editingTreeId);
    if (existingTree) {
      tsDAP = existingTree.tsDAP || null;
      tsHT = existingTree.tsHT || null;
      if (dap != null && dap !== existingTree.dap) tsDAP = now;
      if (ht != null && ht !== existingTree.ht) tsHT = now;
    }
  } else {
    if (dap != null) tsDAP = now;
    if (ht != null) tsHT = now;
  }

  const treeData = {
    plotId: appState.currentPlotId,
    fila, cova, fuste, dap, ht, cat,
    inst, med1, med2, central, 
    sync_status: 'pending',
    tsDAP: tsDAP,
    tsHT: tsHT
  };

  if (appState.editingTreeId) {
    await db.trees.update(appState.editingTreeId, treeData);
    appState.editingTreeId = null;
    document.getElementById('modal-tree').classList.add('hidden');
  } else {
    const dup = await db.trees.where({plotId: appState.currentPlotId, fila: fila, cova: cova, fuste: fuste}).first();
    if (dup) return showToast('Fila-Cova-Fuste já registrado nesta parcela');
    
    treeData.id = generateUUID();
    await db.trees.add(treeData);

    // AVANÇO INTELIGENTE BASEADO NO BOTÃO CLICADO
    if (mode === 'next-fuste') {
      document.getElementById('t-fuste').value = fuste + 1;
    } else {
      document.getElementById('t-cova').value = cova + 1; 
      document.getElementById('t-fuste').value = 1;       
    }

    document.getElementById('t-dap').value = '';
    if (document.getElementById('t-cap')) document.getElementById('t-cap').value = '';
    if (document.getElementById('t-dap1')) document.getElementById('t-dap1').value = '';
    if (document.getElementById('t-dap2')) document.getElementById('t-dap2').value = '';
    document.getElementById('t-ht').value = '';
    if (document.getElementById('t-central')) document.getElementById('t-central').checked = false;         
    
    setTimeout(() => {
      if (inst === 'dap') { const f = document.getElementById('t-dap'); if(f) f.focus(); }
      if (inst === 'fita') { const f = document.getElementById('t-cap'); if(f) f.focus(); }
      if (inst === 'suta') { const f = document.getElementById('t-dap1'); if(f) f.focus(); }
    }, 100);
  }

  showToast('Salvo ✓');
  await validateHistory(appState.currentPlotId);
  
  await refreshPlotData();
}

async function findDominants() {
  const plot = await db.plots.get(appState.currentPlotId);
  if (!plot) return;
  
  // Assume 400m2 se a área não tiver sido fornecida no CSV de importação
  const area = plot.area || 400; 
  const nDom = Math.round(area / 100);
  
  let trees = await db.trees.where('plotId').equals(plot.id).toArray();
  
  // Filtra apenas arvores vivas que possuem medicao de DAP
  const alive = trees.filter(t => ALIVE_CATS.includes(t.cat) && t.dap != null);
  
  if (alive.length < nDom) {
    return showToast(`Existem apenas ${alive.length} fustes medidos. Meta é ${nDom}.`);
  }
  
  // Ordena decrescente pelo DAP
  alive.sort((a, b) => b.dap - a.dap);
  const topTrees = alive.slice(0, nDom);
  
  const daps = topTrees.map(t => t.dap.toFixed(1)).join('cm, ');
  const msg = `O cálculo exigiu ${nDom} dominantes (Área: ${area}m²).\n\nMaiores DAPs: ${daps}cm.\n\nDeseja alterar a categoria destes fustes para "Dominante"?`;
  
  const confirmed = await customConfirm('Confirmar Dominantes', msg);
  
  if (confirmed) {
    const updates = topTrees.map(t => db.trees.update(t.id, { cat: 'dominante' }));
    await Promise.all(updates);
    appState.sortOrder = 'dap'; 
    await refreshPlotData();
    
    showToast('Dominantes atualizadas!');
  }
}

async function closePlot() {
  await db.plots.update(appState.currentPlotId, { 
    status: 'done',
    tsFinalizacao: Date.now() // Registra o fechamento da parcela
  });
  showToast('Parcela concluída ✓');
  go('screen-home');
  renderHome();
}

// 9. VALIDAÇÃO DE DADOS (OUTLIERS E HISTÓRICO)

// Validacao historica — roda a cada saveTree()
// Apenas regras logicas + transicoes de categoria
async function validateHistory(plotId) {
  const trees   = await db.trees.where('plotId').equals(plotId).toArray();
  const history = await db.history.where('plotId').equals(plotId).toArray();
  const updates = [];

  for (const t of trees) {
    const flags = [...(t.flags || []).filter(f => f.source === 'biometric')];
    // ↑ preserva flags biométricas existentes, recalcula só as históricas

    const h = history.find(
      x => x.fila === t.fila && x.cova === t.cova && x.fuste === t.fuste
    );

    const noMeasure = getNoMeasureCats();
    if (noMeasure.includes(t.cat) && (t.dap != null || t.ht != null))
      flags.push({ type: 'warn', source: 'history', msg: `${t.cat.toUpperCase()} geralmente não tem medição` });
    if (t.dap != null && t.dap <= 0)
      flags.push({ type: 'err', source: 'history', msg: 'DAP inválido (≤ 0)' });
    if (t.ht != null && t.ht <= 0)
      flags.push({ type: 'err', source: 'history', msg: 'HT inválida (≤ 0)' });
    if (t.dap != null && t.dap > 80)
      flags.push({ type: 'warn', source: 'history', msg: 'DAP anormal (> 80 cm)' });
    if (t.ht != null && t.ht > 45)
      flags.push({ type: 'warn', source: 'history', msg: 'HT anormal (> 45 m)' });

    if (h) {
      if (DEAD_CATS.includes(h.cat)) {
        if (t.dap != null && h.dap != null && t.dap > h.dap)
          flags.push({ type: 'err', source: 'history', msg: 'Morta não pode crescer (DAP)' });
        if (t.ht != null && h.ht != null && t.ht > h.ht)
          flags.push({ type: 'err', source: 'history', msg: 'Morta não pode crescer (HT)' });
        if (!DEAD_CATS.includes(t.cat))
          flags.push({ type: 'err', source: 'history', msg: 'Ressurreição: era morta no ciclo anterior' });
      }
      if (FALHA_CATS.includes(h.cat) && !FALHA_CATS.includes(t.cat))
        flags.push({ type: 'err', source: 'history', msg: 'Era falha no ciclo anterior' });
      if (t.dap != null && h.dap != null && t.dap < h.dap)
        flags.push({ type: 'warn', source: 'history', msg: `DAP encolheu (era ${h.dap.toFixed(1)} cm)` });
      if (t.ht != null && h.ht != null && t.ht < h.ht)
        flags.push({ type: 'warn', source: 'history', msg: `HT encolheu (era ${h.ht.toFixed(1)} m)` });
      if (ALIVE_CATS.includes(h.cat) && FALHA_CATS.includes(t.cat))
        flags.push({ type: 'warn', source: 'history', msg: 'Era viva → virou falha?' });

      // Obrigatoriedade de HT em fustes medidos anteriormente
      if (h.ht != null && t.ht == null && !noMeasure.includes(t.cat)) {
        flags.push({ type: 'warn', source: 'history', msg: `Medir HT (histórico: ${h.ht.toFixed(1)} m)` });
      }
    }

    const oldStr = JSON.stringify(t.flags || []);
    const newStr = JSON.stringify(flags);
    if (oldStr !== newStr) updates.push({ id: t.id, changes: { flags } });
  }

  if (updates.length > 0)
    await Promise.all(updates.map(u => db.trees.update(u.id, u.changes)));
}

// Validacao biometrica — roda sob demanda (botao "Validar")
async function validateBiometrics(plotId) {
  const trees   = await db.trees.where('plotId').equals(plotId).toArray();
  const history = await db.history.where('plotId').equals(plotId).toArray();
  const outlierSD = 2;
  const updates = [];

  const isStatEligible = t =>
    (ALIVE_CATS.includes(t.cat) || t.cat === 'dominante') &&
    !CURTIS_EXCLUDE.includes(t.cat);

  const statPool   = trees.filter(isStatEligible);
  const dapPool    = statPool.map(t => t.dap).filter(v => v != null);
  const curtisPool = statPool.filter(t => t.dap != null && t.ht != null);

  const tailProb   = getTailProb(outlierSD);
  const weibullDap = fitWeibull(dapPool);
  const wBoundsDap = weibullDap ? {
    lower: weibullQuantile(tailProb,     weibullDap.k, weibullDap.lambda),
    upper: weibullQuantile(1 - tailProb, weibullDap.k, weibullDap.lambda),
  } : null;

  const incStats    = fitIncrementBuffer(statPool, history, ALIVE_CATS, outlierSD);
  const curtisModel = fitCurtis(curtisPool);
  const htPool      = curtisPool.map(t => t.ht);
  const madHt       = curtisModel ? null : robustMAD(htPool, outlierSD);

  for (const t of trees) {
    // Preserva flags históricas, substitui só as biométricas
    const flags = [...(t.flags || []).filter(f => f.source === 'history')];

    if (isStatEligible(t)) {

      // DAP
      if (t.dap != null) {
        const h = history.find(
          x => x.fila === t.fila && x.cova === t.cova && x.fuste === t.fuste
        );
        if (h && h.dap != null && incStats.valid) {
          const inc = t.dap - h.dap;
          if (inc > incStats.upperBound)
            flags.push({ type: 'warn', source: 'biometric', msg: `Super-crescimento (Δ=${inc.toFixed(1)} cm, máx.=${incStats.upperBound.toFixed(1)})` });
          else if (inc >= 0 && inc < incStats.lowerBound)
            flags.push({ type: 'warn', source: 'biometric', msg: `Sub-crescimento (Δ=${inc.toFixed(1)} cm, mín.=${incStats.lowerBound.toFixed(1)})` });
        } else if (wBoundsDap) {
          if (t.dap > wBoundsDap.upper)
            flags.push({ type: 'warn', source: 'biometric', msg: `DAP alto (Weibull > ${wBoundsDap.upper.toFixed(1)} cm)` });
          if (t.dap < wBoundsDap.lower)
            flags.push({ type: 'warn', source: 'biometric', msg: `DAP baixo (Weibull < ${wBoundsDap.lower.toFixed(1)} cm)` });
        }
      }

      // HT
      if (t.ht != null && t.dap != null) {
        if (curtisModel) {
          const looEntry = curtisModel.residuals.find(r => r.treeId === t.id);
          const threshold = outlierSD * curtisModel.looMAD;
          const resid = looEntry
            ? looEntry.eLoo
            : Math.log(t.ht) - (curtisModel.b0 + curtisModel.b1 / t.dap);
          if (Math.abs(resid) > threshold) {
            const htEsp = Math.exp(curtisModel.b0 + curtisModel.b1 / t.dap);
            flags.push({ type: 'warn', source: 'biometric', msg: `HT improvável p/ este DAP (esp.≈${htEsp.toFixed(1)} m, R²=${curtisModel.r2.toFixed(2)})` });
          }
        } else if (madHt) {
          if (t.ht > madHt.upper || t.ht < madHt.lower)
            flags.push({ type: 'warn', source: 'biometric', msg: `HT fora do intervalo esperado (${madHt.lower.toFixed(1)}–${madHt.upper.toFixed(1)} m)` });
        }
      }
    }

    const oldStr = JSON.stringify(t.flags || []);
    const newStr = JSON.stringify(flags);
    if (oldStr !== newStr) updates.push({ id: t.id, changes: { flags } });
  }

  if (updates.length > 0)
    await Promise.all(updates.map(u => db.trees.update(u.id, u.changes)));

  return {
    nFlags:      updates.length,
    curtisModel: curtisModel ? { r2: curtisModel.r2, n: curtisModel.n } : null,
    weibullDap:  weibullDap  ? { k: weibullDap.k }                      : null,
  };
}

async function exportData() {
  const trees = await db.trees.toArray();
  if (trees.length === 0) return showToast('Nenhuma medição para exportar');

  const plots = await db.plots.toArray();
  const plotMap = {};
  plots.forEach(p => plotMap[p.id] = p);

  // === dplyr-style: enriquecer -> ordenar ===
  const dados = trees
    .map(t => {
      const plot = plotMap[t.plotId] || {};
      return {
        ...t,
        fazenda: plot.fazenda || '',
        talhao: plot.talhao || '',
        parcela: plot.numero || t.plotId,
        x: plot.x,
        y: plot.y,
        rotacao: plot.rotacao,
        area: plot.area,
        tsFinalizacao: plot.tsFinalizacao
      };
    })
    .sort((a, b) => {
      const cmpFazenda = (a.fazenda || '').localeCompare(b.fazenda || '');
      if (cmpFazenda !== 0) return cmpFazenda;

      const cmpTalhao = (a.talhao || '').localeCompare(b.talhao || '');
      if (cmpTalhao !== 0) return cmpTalhao;

      const cmpParcela = String(a.parcela).localeCompare(String(b.parcela));
      if (cmpParcela !== 0) return cmpParcela;

      const cmpFila = (a.fila ?? 0) - (b.fila ?? 0);
      if (cmpFila !== 0) return cmpFila;

      const cmpCova = (a.cova ?? 0) - (b.cova ?? 0);
      if (cmpCova !== 0) return cmpCova;

      return (a.fuste ?? 0) - (b.fuste ?? 0);
    });

  // === header com parcela logo após fazenda/talhao ===
  const rows = [[
    'campanha', 'ano', 'fazenda', 'talhao', 'parcela',
    'x', 'y', 'rotacao', 'area',
    'fila', 'cova', 'fuste',
    'instrumento', 'medida_1', 'medida_2', 'dap', 'ht',
    'categoria', 'sync_status',
    'tsDAP', 'tsHT', 'tsFim'
  ].join(';')];

  dados.forEach(t => {
    const instStr = t.inst || 'dap';
    const m1Str = t.med1 != null ? t.med1.toString().replace('.', ',') : '';
    const m2Str = t.med2 != null ? t.med2.toString().replace('.', ',') : '';
    const dapStr = t.dap != null ? t.dap.toFixed(2).replace('.', ',') : '';
    const htStr = t.ht != null ? t.ht.toString().replace('.', ',') : '';

    const tsDapStr = formatLocalTime(t.tsDAP);
    const tsHtStr = formatLocalTime(t.tsHT);
    const tsFinStr = formatLocalTime(t.tsFinalizacao);

    rows.push([
      appState.campaign.name,
      appState.campaign.year,
      t.fazenda,
      t.talhao,
      t.parcela,
      t.x ? t.x.toString().replace('.', ',') : '',
      t.y ? t.y.toString().replace('.', ',') : '',
      t.rotacao ? t.rotacao.toString().replace('.', ',') : '',
      t.area ? t.area.toString().replace('.', ',') : '',
      t.fila, t.cova, t.fuste,
      instStr, m1Str, m2Str, dapStr, htStr, t.cat,
      t.sync_status, tsDapStr, tsHtStr, tsFinStr
    ].join(';'));
  });

  const csvContent = rows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `parcelas_${appState.campaign.name || 'export'}_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('CSV exportado ✓');
}
// 10. INFORMACOES DA PARCELA
async function showPlotInfo() {
  const plot = await db.plots.get(appState.currentPlotId);
  if (!plot) return;

  const infoRow = (label, val) => `<div><div class="card-label">${label}</div><div class="card-val">${val}</div></div>`;

  // 1. Busca os dados ATUAIS
  const trees = await db.trees.where('plotId').equals(plot.id).toArray();
  const alive = trees.filter(t => ALIVE_CATS.includes(t.cat) || t.cat === 'dominante');
  const dead = trees.filter(t => DEAD_CATS.includes(t.cat));
  const falha = trees.filter(t => FALHA_CATS.includes(t.cat));
  
  const uniqueCovas = new Set(trees.map(t => `${t.fila}-${t.cova}`)).size;
  const nFustes = alive.length + dead.length;
  const fustesPorCova = uniqueCovas > 0 ? (nFustes / uniqueCovas).toFixed(2) : '0.00';

  // 2. Busca os dados do HISTÓRICO
  const history = await db.history.where('plotId').equals(plot.id).toArray();
  let historyHtml = '';

  // Se houver dados da medição anterior, calcula as mesmas métricas
  if (history.length > 0) {
    const hAlive = history.filter(t => ALIVE_CATS.includes(t.cat) || t.cat === 'dominante');
    const hDead = history.filter(t => DEAD_CATS.includes(t.cat));
    const hFalha = history.filter(t => FALHA_CATS.includes(t.cat));
    
    const hUniqueCovas = new Set(history.map(t => `${t.fila}-${t.cova}`)).size;
    const hNFustes = hAlive.length + hDead.length;
    const hFustesPorCova = hUniqueCovas > 0 ? (hNFustes / hUniqueCovas).toFixed(2) : '0.00';

    historyHtml = `
      <div class="sec" style="margin-top: 20px; color: var(--amber);">Histórico (Medição Anterior)</div>
      <div class="card-row" style="flex-wrap:wrap;gap:16px; opacity: 0.85;">
        ${infoRow('Vivas', hAlive.length)}
        ${infoRow('Mortas', hDead.length)}
        ${infoRow('Falhas', hFalha.length)}
        ${infoRow('N covas', hUniqueCovas)}
      </div>
      <div class="divider"></div>
      <div class="card-row" style="flex-wrap:wrap;gap:16px; opacity: 0.85;">
        ${infoRow('N Fustes', hNFustes)}
        ${infoRow('Fustes/Cova', hFustesPorCova)}
      </div>
    `;
  }

  const content = document.getElementById('plot-info-content');
  if (!content) return;

  content.innerHTML = `
    <div class="card-row" style="flex-wrap:wrap;gap:16px">
      ${infoRow('Fazenda', plot.fazenda)}
      ${infoRow('Talhão', plot.talhao)}
      ${infoRow('X', plot.x || '—')}
      ${infoRow('Y', plot.y || '—')}
      ${infoRow('Rotação', plot.rotacao != null ? plot.rotacao + ' anos' : '—')}
      ${infoRow('Área', plot.area != null ? plot.area + ' m²' : '—')}
    </div>
    
    <div class="sec" style="margin-top: 20px; color: var(--green);">Medição Atual</div>
    <div class="card-row" style="flex-wrap:wrap;gap:16px">
      ${infoRow('Vivas', alive.length)}
      ${infoRow('Mortas', dead.length)}
      ${infoRow('Falhas', falha.length)}
      ${infoRow('N covas', uniqueCovas)}
    </div>
    <div class="divider"></div>
    <div class="card-row" style="flex-wrap:wrap;gap:16px">
      ${infoRow('N Fustes', nFustes)}
      ${infoRow('Fustes/Cova', fustesPorCova)}
    </div>

    ${historyHtml}
  `;

  document.getElementById('modal-plot-info').classList.remove('hidden');
}

// 11. GABARITO VISUAL DA PARCELA (ATUAL E HISTÓRICO)
async function showGabarito() {
  const plot = await db.plots.get(appState.currentPlotId);
  if (!plot) return;

  const trees = await db.trees.where('plotId').equals(plot.id).toArray();
  const uniqueCovas = new Set(trees.map(t => `${t.fila}-${t.cova}`)).size;
  const area = plot.area || 400; 
  const espX = 3.15; 
  
  let espY = uniqueCovas > 0 ? area / (uniqueCovas * espX) : 2.5; 
  if (espY < 1 || espY > 5) espY = 2.5; 

  document.getElementById('gab-esp-x').value = espX.toFixed(2);
  document.getElementById('gab-esp-y').value = espY.toFixed(2);
  document.getElementById('gab-source').value = 'atual'; 
  
  // Reseta o zoom para o padrão 1x ao abrir
  appState.gabaritoZoom = 1;

  document.getElementById('modal-gabarito').classList.remove('hidden');
  await drawGabaritoMap();
}

async function drawGabaritoMap() {
  const container = document.getElementById('gabarito-container');
  if (!container) return;

  const source = document.getElementById('gab-source').value;
  let trees = [];

  if (source === 'historico') {
    trees = await db.history.where('plotId').equals(appState.currentPlotId).toArray();
    if (trees.length === 0) {
      container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text3)">Nenhum histórico amarrado a esta parcela.</div>';
      return;
    }
  } else {
    trees = await db.trees.where('plotId').equals(appState.currentPlotId).toArray();
  }

  if (trees.length === 0) {
    container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text3)">Nenhuma árvore registrada.</div>';
    return;
  }

  const espX = parseFloat(document.getElementById('gab-esp-x').value) || 3.15;
  const espY = parseFloat(document.getElementById('gab-esp-y').value) || 2.5;
  
  const zoom = appState.gabaritoZoom || 1;
  const pxPerMeter = 20 * zoom; 
  const padding = 40 * zoom;
  const dotSize = Math.max(10, 16 * zoom);
  const fontSize = Math.max(7, 9 * zoom);

  container.innerHTML = '';

  // Usa o novo utilitário global para reaproveitar a matemática das covas
  const { map: covaMap, filasSeq } = buildCovaMap(trees);

  const totalFilas = Object.keys(filasSeq).length;
  let maxCovasInRow = 0;
  let minFila = Infinity;

  for (const f in filasSeq) {
    if (parseInt(f) < minFila) minFila = parseInt(f);
    if (filasSeq[f].length > maxCovasInRow) maxCovasInRow = filasSeq[f].length;
  }

  const mapWidth = (totalFilas * espX * pxPerMeter) + (padding * 2);
  const mapHeight = (maxCovasInRow * espY * pxPerMeter) + (padding * 2);

  const canvas = document.createElement('div');
  canvas.style.position = 'relative';
  canvas.style.width = `${mapWidth}px`;
  canvas.style.height = `${mapHeight}px`;

  // CAMADA VETORIAL SVG (Para desenhar a linha do Centro da Parcela)
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", mapWidth);
  svg.setAttribute("height", mapHeight);
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none'; // Permite clicar nas árvores por trás da linha
  svg.style.zIndex = '5';
  canvas.appendChild(svg);

  const centralPoints = [];

  trees.forEach(t => {
    const filaIdx = t.fila - minFila; 
    const posX = filaIdx * espX * pxPerMeter;
    const seq = filasSeq[t.fila];
    const N = seq.length;
    const covaIdx = seq.indexOf(t.cova); 
    const offsetY = (maxCovasInRow - N) / 2;
    let localYIdx = 0;
    
    if (t.fila % 2 !== 0) localYIdx = offsetY + covaIdx;
    else localYIdx = offsetY + (N - 1 - covaIdx);

    const posY = localYIdx * espY * pxPerMeter;
    
    const fusteOffset = (t.fuste > 1) ? (t.fuste - 1) * (4 * zoom) : 0;
    const finalX = posX + padding + fusteOffset;
    const finalY = posY + padding + fusteOffset;

    // Se a árvore é o Centro, mapeia as coordenadas (o SVG opera de cima pra baixo, o CSS de baixo pra cima)
    if (t.central) {
      centralPoints.push({ x: finalX, y: mapHeight - finalY });
    }

    const dot = document.createElement('div');
    dot.style.position = 'absolute';
    dot.style.left = `${finalX}px`;
    dot.style.bottom = `${finalY}px`;
    dot.style.width = `${dotSize}px`;
    dot.style.height = `${dotSize}px`;
    dot.style.borderRadius = '50%';
    dot.style.transform = 'translate(-50%, 50%)';
    dot.style.display = 'flex';
    dot.style.alignItems = 'center';
    dot.style.justifyContent = 'center';
    dot.style.fontSize = `${fontSize}px`;
    dot.style.fontWeight = 'bold';
    dot.style.color = '#fff';
    dot.style.zIndex = '10';
    dot.style.cursor = 'pointer';

    let hasBorder = false;

    if (t.cat === 'dominante') {
      dot.style.backgroundColor = '#2980b9'; 
      dot.style.boxShadow = `0 0 ${6 * zoom}px rgba(41, 128, 185, 0.6)`;
      dot.style.zIndex = '20';
    } else if (DEAD_CATS.includes(t.cat)) {
      dot.style.backgroundColor = '#2c3e50'; 
    } else if (FALHA_CATS.includes(t.cat)) {
      dot.style.backgroundColor = 'transparent';
      dot.style.border = `${Math.max(1, 2 * zoom)}px solid #e74c3c`; 
      dot.style.color = '#e74c3c';
      hasBorder = true;
    } else {
      dot.style.backgroundColor = '#27ae60'; 
    }

    if (t.ht != null && !FALHA_CATS.includes(t.cat)) {
      dot.style.border = `${Math.max(1, 2 * zoom)}px solid #00ffff`;
      hasBorder = true;
    }

    if (t.flags && t.flags.length > 0) {
      if (hasBorder) {
        dot.style.outline = `${Math.max(1, 2 * zoom)}px solid #f39c12`;
        dot.style.outlineOffset = `${1 * zoom}px`;
      } else {
        dot.style.border = `${Math.max(1, 2 * zoom)}px solid #f39c12`;
      }
    }

    if (t.fuste > 1) dot.textContent = t.fuste;

    // Toast revelando a numeração dupla
    const relCova = covaMap[t.id] || t.cova;
    dot.onclick = () => showToast(`F:${t.fila} C:${relCova} (Absoluta:${t.cova}) ${t.fuste > 1 ? `Fst:${t.fuste}` : ''} | DAP: ${t.dap || '-'}`);
    canvas.appendChild(dot);

    // NUMERAÇÃO DAS BORDAS EXTERNAS
    if (localYIdx === offsetY + N - 1 || localYIdx === offsetY) {
      const lbl = document.createElement('div');
      lbl.textContent = t.cova; 
      lbl.style.position = 'absolute';
      lbl.style.color = '#e74c3c'; 
      lbl.style.fontSize = `${Math.max(9, 11 * zoom)}px`;
      lbl.style.fontFamily = 'monospace';
      lbl.style.fontWeight = 'bold';
      lbl.style.left = `${finalX}px`;
      lbl.style.transform = 'translateX(-50%)';

      // Posiciona para cima ou para baixo evitando as árvores
      if (localYIdx === offsetY + N - 1) { // Borda de Cima
        lbl.style.bottom = `${finalY + (12 * zoom)}px`;
      } else if (localYIdx === offsetY) { // Borda de Baixo
        lbl.style.bottom = `${finalY - (22 * zoom)}px`;
      }
      canvas.appendChild(lbl);
    }
  });

  // DESENHA A LINHA CONECTANDO AS ÁRVORES CENTRAIS
  if (centralPoints.length >= 2) {
    for (let i = 0; i < centralPoints.length - 1; i++) {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", centralPoints[i].x);
      line.setAttribute("y1", centralPoints[i].y);
      line.setAttribute("x2", centralPoints[i+1].x);
      line.setAttribute("y2", centralPoints[i+1].y);
      line.setAttribute("stroke", "#f39c12"); // Laranja/Amarelo destque
      line.setAttribute("stroke-width", `${Math.max(2, 4 * zoom)}`);
      line.setAttribute("stroke-dasharray", `${6 * zoom},${4 * zoom}`); // Linha tracejada
      svg.appendChild(line);
    }
  }

  container.appendChild(canvas);
}