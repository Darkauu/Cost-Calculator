import { loadConfig, saveLocalConfig, clearLocalConfig, mergeConfig, DEFAULT_CONFIG } from './config.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';
import { analyzeMesh, estimatePrint, fitsBed } from './geometry.js';
import { computeQuote, machineRatePerHour } from './pricing.js';
import { parseFile } from './parsers.js';

const $ = (id) => document.getElementById(id);
const state = {
  cfg: null,
  fileName: null,
  positions: null,
  sliced: null,
  analysis: null,
  quote: null,
  admin: false,
  viewer: null,
};

// ---------- formato ----------
// es-US / en-US: "$1,234.50" en ambos idiomas, sin ambigüedad con pesos.
const locale = () => (getLang() === 'es' ? 'es-US' : 'en-US');
const money = (v) => new Intl.NumberFormat(locale(), { style: 'currency', currency: state.cfg.currency }).format(v);
const num = (v, d = 1) => new Intl.NumberFormat(locale(), { maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
const pct = (v) => `${Math.round(v * 100)}%`;
function duration(h) {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return hh ? `${hh} h ${mm} min` : `${mm} min`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1800);
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------- lectura de opciones ----------
function options() {
  return {
    material: $('material').value,
    quality: document.querySelector('input[name=quality]:checked').value,
    quantity: Math.max(1, parseInt($('quantity').value, 10) || 1),
    finish: $('finish').value,
    urgent: document.querySelector('input[name=urgency]:checked').value === 'urgent',
    complexity: $('complexity').value,
  };
}

function manualValues() {
  if (!$('manual').open) return null;
  const g = parseFloat($('manualGrams').value);
  const h = parseFloat($('manualHours').value);
  return g > 0 && h > 0 ? { grams: g, hours: h } : null;
}

// ---------- cálculo ----------
function currentJob() {
  const o = options();
  const cfg = state.cfg;
  const manual = manualValues();
  const autoLevel = state.analysis?.complexity.level;
  const level = o.complexity === 'auto' ? (autoLevel || 2) : +o.complexity;

  let grams, hours, source, exact = false, estimate = null;
  if (manual) {
    ({ grams, hours } = manual); source = 'manual'; exact = true;
  } else if (state.sliced) {
    grams = state.sliced.grams; hours = state.sliced.hours; source = 'exact'; exact = true;
  } else if (state.analysis) {
    estimate = estimatePrint({ ...state.analysis, complexity: { level } }, {
      material: cfg.materials[o.material], quality: cfg.qualities[o.quality], estimation: cfg.estimation,
    });
    grams = estimate.grams; hours = estimate.hours; source = 'estimate';
  } else {
    return null;
  }
  return { ...o, complexity: level, grams, hours, exact, source, estimate };
}

function recompute() {
  const job = currentJob();
  const exactSource = !!state.sliced && !manualValues();
  for (const el of document.querySelectorAll('input[name=quality]')) el.disabled = exactSource;
  $('quality').classList.toggle('disabled', exactSource);

  if (!job) {
    state.quote = null;
    $('emptyResult').hidden = false;
    $('resultBody').hidden = true;
    renderAnalysis(null);
    return;
  }
  state.quote = computeQuote(job, state.cfg);
  state.job = job;
  $('emptyResult').hidden = true;
  $('resultBody').hidden = false;
  renderAnalysis(job);
  renderQuote(job, state.quote);
}

// ---------- render ----------
function renderAnalysis(job) {
  const card = $('analysisCard');
  const a = state.analysis;
  if (!a && !state.sliced) { card.hidden = true; return; }
  card.hidden = false;
  const rows = [];
  if (a) {
    const [x, y, z] = a.sizeMm;
    rows.push([t('dimensions'), `${num(x)} × ${num(y)} × ${num(z)} mm`]);
    rows.push([t('volume'), `${num(a.volumeMm3 / 1000)} cm³`]);
  }
  if (job) {
    rows.push([t('weight'), `${num(job.grams)} g`]);
    rows.push([t('time'), duration(job.hours)]);
    if (job.estimate) rows.push([t('supports'), `${num(job.estimate.supportGrams)} g`]);
  }
  if (state.sliced?.filaments?.length) {
    const fil = state.sliced.filaments.map((f) => `<span class="swatch" style="background:${esc(f.color.slice(0, 7) || 'transparent')}"></span>${esc(f.type)} ${num(f.grams)} g`).join('<br>');
    rows.push([t('filaments'), fil, true]);
  }
  if (state.sliced?.plates > 1) rows.push([t('plates'), state.sliced.plates]);
  if (a) rows.push(['', fitsBed(a.sizeMm, state.cfg.printer.bedMm) ? `✓ ${t('fits')}` : `✗ ${t('notFits')}`]);
  $('stats').innerHTML = rows.map(([k, v, raw]) => `<div><dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd></div>`).join('');

  const level = job?.complexity ?? a?.complexity.level ?? 2;
  let reason = '';
  if (a && $('complexity').value === 'auto') {
    const f = a.complexity.factors;
    const names = Object.entries(f).filter(([, v]) => v > 0).sort((p, q) => q[1] - p[1]).map(([k]) => t(`factor_${k}`));
    reason = names.length ? `${t('complexityBecause')}: ${names.join(', ')}` : t('complexityPlain');
  }
  $('complexityBox').innerHTML = `
    <strong>${t('complexity')}: ${level} · ${t(`level_${level}`)}</strong>
    <span class="dots">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= level ? 'on' : ''}"></i>`).join('')}</span>
    ${reason ? `<span class="muted small">${esc(reason)}</span>` : ''}`;
}

function renderQuote(job, q) {
  const tierHtml = (key, main) => {
    const tr = q.tiers[key];
    return `<div class="tier ${main ? 'main' : ''}">
      <span class="name">${t(`tier_${key}`)}</span>
      <span class="price">${money(tr.price)}</span>
      ${q.quantity > 1 ? `<span class="unit">${money(tr.unit)} ${t('perUnit')}</span>` : ''}
      <span class="hint">${t(`tier_${key}_hint`)}</span>
      <span class="pill ${tr.status}">${t('margin')} ${pct(tr.margin)}</span>
    </div>`;
  };
  $('tiers').innerHTML = tierHtml('minimum') + tierHtml('recommended', true) + tierHtml('premium');

  const notes = [];
  if (q.discountPct) notes.push(`<li><span>${t('discountApplied')}</span><b>−${pct(q.discountPct)}</b></li>`);
  if (q.urgent) notes.push(`<li><span>${t('urgentApplied')}</span><b>+${pct(state.cfg.urgencyMultiplier - 1)}</b></li>`);
  const share = Math.max(0, q.goalShare);
  notes.push(`<li><span>${t('goalShare')} (${money(state.cfg.monthlyProfitGoal)})</span><b>${num(share * 100, 1)}%</b></li>
    <li><div class="goal-bar" style="flex:1"><i style="width:${Math.min(100, share * 100)}%"></i></div></li>`);
  $('notes').innerHTML = notes.join('');

  renderNegotiated();

  const warnings = [];
  if (state.analysis) {
    if (!fitsBed(state.analysis.sizeMm, state.cfg.printer.bedMm)) warnings.push(t('w_notFits'));
    const maxDim = Math.max(...state.analysis.sizeMm);
    if (maxDim < 3 || maxDim > 2000) warnings.push(t('w_scale'));
  }
  for (const w of q.warnings) if (w.code === 'aboveMarket') warnings.push(t('w_aboveMarket', { perGram: money(w.perGram) }));
  const info = state.notices || [];
  $('warnings').innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('') + info.map(([k, v]) => `<li class="info">${esc(t(k, v))}</li>`).join('');

  renderBreakdown(q);
}

function renderNegotiated() {
  const el = $('negotiatedStatus');
  const v = parseFloat($('negotiated').value);
  if (!state.quote || !(v > 0)) { el.hidden = true; return; }
  const r = state.quote.evaluate(v);
  el.hidden = false;
  el.className = `pill ${r.status}`;
  el.textContent = `${t('margin')} ${pct(r.margin)} · ${t(`status_${r.status}`)}`;
}

function renderBreakdown(q) {
  const el = $('breakdown');
  el.classList.toggle('hidden', !state.admin);
  if (!state.admin) return;
  const b = q.breakdown;
  const rows = [
    [t('b_material'), b.material, `${num(q.grams.total)} g`],
    [t('b_machine'), b.machine, `${duration(q.hours.total)} × ${money(b.machineRate)}${t('perHour')}`],
    [t('b_labor'), b.labor, `${Math.round(b.laborMinutes)} min`],
    [t('b_extras'), b.extras, ''],
    [t('b_risk'), b.risk, pct(state.cfg.failureRiskByComplexity[q.complexity - 1])],
  ];
  el.innerHTML = `<h2>${t('breakdown')}</h2>
    <table>
      ${rows.map(([k, v, d]) => `<tr><td>${esc(k)} <span class="muted small">${esc(d)}</span></td><td>${money(v)}</td></tr>`).join('')}
      <tr class="total"><td>${t('b_cost')}</td><td>${money(q.cost)}</td></tr>
    </table>
    <p class="muted small">${t(q.profitDriver === 'goal' ? 'b_driver_goal' : 'b_driver_margin')}</p>`;
}

// ---------- archivo ----------
async function handleFile(file) {
  if (!file) return;
  const status = $('dropStatus');
  status.textContent = t('loading');
  status.classList.remove('hidden');
  try {
    const parsed = await parseFile(file);
    state.fileName = file.name;
    state.positions = parsed.positions;
    state.sliced = parsed.sliced;
    state.analysis = parsed.positions ? analyzeMesh(parsed.positions, { supportAngleDeg: state.cfg.estimation.supportAngleDeg }) : null;
    state.notices = [];
    $('manual').open = false;

    // Datos del laminado: material y multicolor automáticos
    if (state.sliced) {
      const fils = state.sliced.filaments || [];
      const type = fils[0]?.type?.toUpperCase();
      const match = type && Object.keys(state.cfg.materials).find((m) => type === m.toUpperCase())
        || (type && Object.keys(state.cfg.materials).find((m) => type.startsWith(m.toUpperCase())));
      if (match) { $('material').value = match; state.notices.push(['w_materialFromFile', { m: match }]); }
      if (fils.length > 1) { $('finish').value = 'multicolor'; state.notices.push(['w_multicolor', { n: fils.length }]); }
    }
    if (!state.analysis && $('complexity').value === 'auto') state.notices.push(['w_noGeometry']);
    if (state.analysis?.inverted) state.notices.push(['w_inverted']);

    $('fileName').textContent = file.name;
    $('fileRow').classList.remove('hidden');
    const badge = $('sourceBadge');
    badge.className = `badge ${state.sliced ? 'exact' : 'estimate'}`;
    badge.dataset.i18n = state.sliced ? 'sourceExact' : 'sourceEstimate';
    badge.textContent = t(badge.dataset.i18n);

    if (state.positions) {
      $('dropEmpty').classList.add('hidden');
      $('viewer').classList.remove('hidden');
      $('drop').classList.add('loaded');
      if (!state.viewer) {
        const { createViewer } = await import('./viewer.js');
        state.viewer = createViewer($('viewer'));
      }
      state.viewer.show(state.positions, state.analysis.overhangMask, {
        base: cssVar('--model'), overhang: cssVar('--overhang'), grid: cssVar('--grid'),
      });
    } else {
      state.viewer?.clear();
      $('viewer').classList.add('hidden');
      $('dropEmpty').classList.remove('hidden');
      $('drop').classList.remove('loaded');
    }
    recompute();
  } catch (err) {
    console.error(err);
    toast(`${t('errorPrefix')}: ${err.message}`);
  } finally {
    status.classList.add('hidden');
  }
}

function setupDrop() {
  const drop = $('drop');
  const input = $('fileInput');
  drop.addEventListener('click', () => { if (!drop.classList.contains('loaded')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  $('changeFile').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { handleFile(input.files[0]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    handleFile(e.dataTransfer.files[0]);
  });
}

// ---------- cotización para el cliente ----------
function quoteText() {
  const q = state.quote, j = state.job;
  const rec = q.tiers.recommended;
  const lines = [
    t('quoteHeader'),
    `${t('quoteItem')}: ${state.fileName || '—'}`,
    `${t('material')}: ${j.material} · ${t('quality')}: ${state.sliced && !manualValues() ? '—' : t(`quality_${j.quality}`)} · ${t('finish')}: ${t(`finish_${j.finish}`)}`,
    `${t('quantity')}: ${q.quantity} × ${money(rec.unit)} = ${money(rec.price)}`,
    `${t('urgency')}: ${t(j.urgent ? 'urgency_urgent' : 'urgency_normal')}`,
    t('quoteValid'),
  ];
  return lines.join('\n');
}

function buildPrintSheet() {
  if (!state.quote) return;
  const q = state.quote, j = state.job;
  const rec = q.tiers.recommended;
  const canvas = $('viewer').querySelector('canvas');
  let img = '';
  if (state.positions && canvas) { try { img = `<img src="${canvas.toDataURL('image/png')}" alt="">`; } catch { /* nada */ } }
  $('printSheet').innerHTML = `
    <h1>${t('quoteHeader')}</h1>
    <div>${new Date().toLocaleDateString(locale())}</div>
    ${img}
    <table>
      <tr><th>${t('quoteItem')}</th><th>${t('material')}</th><th>${t('finish')}</th><th class="num">${t('quantity')}</th><th class="num">${t('perUnit')}</th><th class="num">${t('quoteTotal')}</th></tr>
      <tr><td>${esc(state.fileName || '—')}</td><td>${esc(j.material)}</td><td>${t(`finish_${j.finish}`)}</td>
        <td class="num">${q.quantity}</td><td class="num">${money(rec.unit)}</td><td class="num"><b>${money(rec.price)}</b></td></tr>
    </table>
    <p>${t('urgency')}: ${t(j.urgent ? 'urgency_urgent' : 'urgency_normal')}</p>
    <p>${t('quoteValid')}</p>`;
}

// ---------- administración ----------
async function sha256(text) {
  if (crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

const ADMIN_SECTIONS = [
  ['sec_printer', [['printer.name', 'text'], ['printer.priceUsd'], ['printer.lifeHours'], ['printer.powerKw'], ['printer.maintenancePerHour']]],
  ['sec_costs', [['electricityPerKwh'], ['laborPerHour'], ['setupMinutes']]],
  ['sec_pricing', [['monthlyProfitGoal'], ['sellableHoursPerMonth'], ['minOrderPrice'], ['minMargin', 'pct'], ['premiumMultiplier'], ['urgencyMultiplier'], ['roundingStep'], ['marketMaxPerGram']]],
  ['sec_complexity', [['marginByComplexity', 'pctlist'], ['failureRiskByComplexity', 'pctlist'], ['postMinutesByComplexity', 'list']]],
  ['sec_estimation', [['estimation.infill', 'pct'], ['estimation.massCalibration'], ['estimation.timeCalibration']]],
];
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function renderAdmin() {
  const cfg = state.cfg;
  let html = '';
  for (const [sec, fields] of ADMIN_SECTIONS) {
    html += `<div class="admin-sec"><h3>${t(sec)}</h3>`;
    const simple = fields.filter(([, type]) => !type || type === 'text' || type === 'pct');
    const lists = fields.filter(([, type]) => type === 'list' || type === 'pctlist');
    if (simple.length) {
      html += '<div class="admin-grid">' + simple.map(([path, type]) => {
        const v = getPath(cfg, path);
        const shown = type === 'pct' ? +(v * 100).toFixed(2) : v;
        return `<label><span>${t('f_' + path.replace('.', '_'))}</span><input data-path="${path}" data-type="${type || 'num'}" type="${type === 'text' ? 'text' : 'number'}" step="any" value="${esc(shown)}"></label>`;
      }).join('') + '</div>';
    }
    for (const [path, type] of lists) {
      const arr = getPath(cfg, path);
      html += `<label><span>${t('f_' + path)}</span><div class="list5">${arr.map((v, i) =>
        `<input data-path="${path}" data-index="${i}" data-type="${type}" type="number" step="any" value="${type === 'pctlist' ? +(v * 100).toFixed(2) : v}">`).join('')}</div></label>`;
    }
    if (sec === 'sec_printer') {
      html += `<p class="admin-info muted">${t('machineRate')}: <b>${money(machineRatePerHour(cfg))}${t('perHour')}</b></p>`;
    }
    if (sec === 'sec_pricing') {
      html += `<p class="admin-info muted">${t('goalPerHour')}: <b>${money(cfg.monthlyProfitGoal / Math.max(1, cfg.sellableHoursPerMonth))}${t('perHour')}</b></p>`;
    }
    html += '</div>';
  }
  html += `<div class="admin-sec"><h3>${t('sec_materials')}</h3><div class="admin-grid">${Object.entries(cfg.materials).map(([m, v]) =>
    `<label><span>${esc(m)}</span><input data-path="materials.${esc(m)}.costPerKg" data-type="num" type="number" step="any" value="${v.costPerKg}"></label>`).join('')}</div></div>`;
  html += `<div class="admin-sec"><h3>PIN</h3><div class="admin-grid"><label><span>${t('newPin')}</span><input type="password" id="newPin" autocomplete="new-password"></label></div></div>`;
  html += `<details class="admin-sec"><summary>${t('sec_advanced')}</summary><textarea id="rawCfg" spellcheck="false">${esc(JSON.stringify(cfg, null, 2))}</textarea></details>`;
  $('adminFields').innerHTML = html;
}

async function collectAdmin() {
  let cfg;
  const raw = $('rawCfg');
  const rawChanged = raw && raw.value !== JSON.stringify(state.cfg, null, 2);
  if (rawChanged) {
    cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(raw.value));
  } else {
    cfg = structuredClone(state.cfg);
    for (const el of $('adminFields').querySelectorAll('[data-path]')) {
      const type = el.dataset.type;
      let v = type === 'text' ? el.value : parseFloat(el.value);
      if (type !== 'text' && !Number.isFinite(v)) continue;
      if (type === 'pct' || type === 'pctlist') v /= 100;
      if (el.dataset.index != null) getPath(cfg, el.dataset.path)[+el.dataset.index] = v;
      else setPath(cfg, el.dataset.path, v);
    }
  }
  const pin = $('newPin')?.value;
  if (pin) cfg.adminPinHash = await sha256(pin);
  return cfg;
}

function setAdmin(on) {
  state.admin = on;
  $('lockBtn').classList.toggle('hidden', !on);
  if (state.quote) renderBreakdown(state.quote);
}

function setupAdmin() {
  $('adminBtn').addEventListener('click', () => {
    if (state.admin) { renderAdmin(); $('adminDialog').showModal(); return; }
    $('pinError').hidden = true;
    $('pinInput').value = '';
    $('pinDialog').showModal();
  });
  $('pinCancel').addEventListener('click', () => $('pinDialog').close());
  $('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hash = await sha256($('pinInput').value);
    if (hash && hash === state.cfg.adminPinHash) {
      $('pinDialog').close();
      setAdmin(true);
      renderAdmin();
      $('adminDialog').showModal();
    } else {
      $('pinError').hidden = false;
    }
  });
  $('lockBtn').addEventListener('click', () => setAdmin(false));
  $('closeAdmin').addEventListener('click', () => $('adminDialog').close());
  $('saveCfg').addEventListener('click', async () => {
    try {
      state.cfg = await collectAdmin();
      saveLocalConfig(state.cfg);
      fillMaterials();
      renderAdmin();
      recompute();
      toast(t('saved'));
    } catch (err) { toast(err.message); }
  });
  $('exportCfg').addEventListener('click', async () => {
    const cfg = await collectAdmin();
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('importCfg').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(await file.text()));
      saveLocalConfig(state.cfg);
      fillMaterials(); renderAdmin(); recompute(); toast(t('saved'));
    } catch (err) { toast(err.message); }
    e.target.value = '';
  });
  $('resetCfg').addEventListener('click', async () => {
    clearLocalConfig();
    state.cfg = await loadConfig();
    fillMaterials(); renderAdmin(); recompute(); toast(t('saved'));
  });
}

// ---------- inicio ----------
function fillMaterials() {
  const sel = $('material');
  const prev = sel.value;
  sel.innerHTML = Object.keys(state.cfg.materials).map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  sel.value = state.cfg.materials[prev] ? prev : Object.keys(state.cfg.materials)[0];
}

function refreshLanguage() {
  applyI18n();
  for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('active', b.dataset.lang === getLang());
  if (state.admin && $('adminDialog').open) renderAdmin();
  recompute();
}

async function init() {
  state.cfg = await loadConfig();
  fillMaterials();
  setupDrop();
  setupAdmin();
  for (const b of document.querySelectorAll('[data-lang]')) {
    b.addEventListener('click', () => { setLang(b.dataset.lang); refreshLanguage(); });
  }
  $('opts').addEventListener('input', recompute);
  $('opts').addEventListener('change', recompute);
  $('manual').addEventListener('input', recompute);
  $('manual').addEventListener('toggle', recompute);
  $('negotiated').addEventListener('input', renderNegotiated);
  $('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(quoteText()); toast(t('copied')); } catch { toast(quoteText()); }
  });
  $('printBtn').addEventListener('click', () => { buildPrintSheet(); window.print(); });
  window.addEventListener('beforeprint', buildPrintSheet);
  refreshLanguage();
}

init();
