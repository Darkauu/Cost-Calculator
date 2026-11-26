import { loadConfig, saveLocalConfig, clearLocalConfig, mergeConfig, DEFAULT_CONFIG } from './config.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';
import { analyzeMesh, estimatePrint, fitsBed } from './geometry.js';
import { computeOrder, machineRatePerHour, selectPrinter, hmsToHours } from './pricing.js';
import { parseFile } from './parsers.js';

const $ = (id) => document.getElementById(id);
const state = {
  cfg: null,
  items: [],     // modelos del pedido, cada uno con su archivo y sus parámetros
  active: 0,     // modelo que se está editando
  entries: [],   // modelos con datos suficientes para cotizar: { item, i, job }
  quote: null,   // cotización del pedido completo
  admin: false,
  viewer: null,
};
const cur = () => state.items[state.active];
// Atajos al modelo activo, para que el análisis y el visor lean siempre el modelo elegido.
for (const k of ['fileName', 'positions', 'sliced', 'analysis', 'notices']) {
  Object.defineProperty(state, k, { get: () => cur()?.[k], set: (v) => { cur()[k] = v; } });
}

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

// ---------- modelos del pedido ----------
let nextId = 1;
function newItem(from) {
  const mats = Object.keys(state.cfg.materials);
  return {
    id: nextId++, fileName: null, positions: null, sliced: null, analysis: null, notices: [],
    form: {
      material: from?.form.material || mats[0], quantity: 1, finish: 'none', perFile: 1,
      printer: from?.form.printer || 'printer', complexity: 'auto', quality: 'standard',
      suppliesOther: 0, supplies: {}, manualOpen: false, grams: 0, h: 0, m: 0, s: 0, ph: 0, pm: 0, ps: 0,
    },
  };
}
const itemName = (it, i) => it.fileName || t('modelN', { n: i + 1 });

// Parámetros del modelo activo: se guardan en item.form al editar y se cargan al cambiar de modelo.
function readForm() {
  const n = (id) => Math.max(0, parseFloat($(id).value) || 0);
  return {
    material: $('material').value,
    quantity: Math.max(1, parseInt($('quantity').value, 10) || 1),
    finish: $('finish').value,
    perFile: Math.max(1, parseInt($('perFile').value, 10) || 1),
    printer: $('printer').value || 'printer',
    complexity: $('complexity').value,
    quality: document.querySelector('input[name=quality]:checked')?.value || 'standard',
    suppliesOther: n('supplies'),
    supplies: Object.fromEntries([...document.querySelectorAll('#suppliesList input[data-supply]')]
      .map((el) => [el.dataset.supply, Math.max(0, parseFloat(el.value) || 0)]).filter(([, v]) => v > 0)),
    manualOpen: $('manual').open,
    grams: n('manualGrams'), h: n('manualH'), m: n('manualM'), s: n('manualS'),
    ph: n('prepH'), pm: n('prepM'), ps: n('prepS'),
  };
}
function saveForm() { const it = cur(); if (it) it.form = readForm(); }
function loadForm(it) {
  const f = it.form;
  const mats = Object.keys(state.cfg.materials);
  $('material').value = state.cfg.materials[f.material] ? f.material : mats[0];
  $('quantity').value = f.quantity;
  $('finish').value = f.finish;
  $('perFile').value = f.perFile;
  $('printer').value = f.printer;
  if (!$('printer').value) $('printer').value = 'printer';
  $('complexity').value = f.complexity;
  for (const r of document.querySelectorAll('input[name=quality]')) r.checked = r.value === f.quality;
  $('supplies').value = f.suppliesOther;
  for (const el of document.querySelectorAll('#suppliesList input[data-supply]')) el.value = f.supplies[el.dataset.supply] || 0;
  $('manual').open = f.manualOpen;
  $('manualGrams').value = f.grams;
  $('manualH').value = f.h; $('manualM').value = f.m; $('manualS').value = f.s;
  $('prepH').value = f.ph || 0; $('prepM').value = f.pm || 0; $('prepS').value = f.ps || 0;
}

function manualOf(it) {
  const f = it.form;
  if (!f.manualOpen) return null;
  const h = hmsToHours(f.h, f.m, f.s);
  return f.grams > 0 && h > 0 ? { grams: f.grams, hours: h, prepHours: hmsToHours(f.ph, f.pm, f.ps) } : null;
}
const isEmpty = (it) => !it.fileName && !manualOf(it);

// Opciones del pedido completo (iguales para todos los modelos).
function orderOptions() {
  return {
    packaging: $('packaging').value,
    shipping: $('shipping').value,
    payment: $('payment').value,
    itbms: $('itbms').checked,
    urgent: document.querySelector('input[name=urgency]:checked').value === 'urgent',
  };
}

// ---------- cálculo ----------
function jobFor(it) {
  const f = it.form;
  const cfg = state.cfg;
  const material = cfg.materials[f.material] ? f.material : Object.keys(cfg.materials)[0];
  const manual = manualOf(it);
  const autoLevel = it.analysis?.complexity.level;
  const level = f.complexity === 'auto' ? (autoLevel || 2) : +f.complexity;

  let grams, hours, prepHours = 0, source, exact = false, estimate = null;
  if (manual) {
    ({ grams, hours, prepHours } = manual); source = 'manual'; exact = true;
  } else if (it.sliced) {
    // La preparación (total − tiempo del modelo) va aparte; una placa con varias piezas
    // iguales reparte el tiempo de impresión y el material entre ellas.
    prepHours = Math.min(it.sliced.prepHours || 0, it.sliced.hours);
    grams = it.sliced.grams / f.perFile; hours = (it.sliced.hours - prepHours) / f.perFile; source = 'exact'; exact = true;
  } else if (it.analysis) {
    estimate = estimatePrint({ ...it.analysis, complexity: { level } }, {
      material: cfg.materials[material], quality: cfg.qualities[f.quality], estimation: cfg.estimation,
    });
    grams = estimate.grams; hours = estimate.hours; prepHours = estimate.prepHours; source = 'estimate';
  } else {
    return null;
  }
  return {
    material, quality: f.quality, quantity: f.quantity, finish: f.finish, complexity: level,
    printer: f.printer, suppliesPerUnit: f.suppliesOther, supplies: f.supplies,
    grams, hours, prepHours, exact, source, estimate,
  };
}

function recompute() {
  const it = cur();
  const exactSource = !!it?.sliced && !manualOf(it);
  for (const el of document.querySelectorAll('input[name=quality]')) el.disabled = exactSource;
  $('quality').classList.toggle('disabled', exactSource);

  state.entries = state.items.map((item, i) => ({ item, i, job: jobFor(item) })).filter((e) => e.job);
  const activeJob = it ? jobFor(it) : null;
  state.quoteNo = null; // la cotización cambió: el próximo PDF lleva número nuevo
  state.quote = state.entries.length ? computeOrder(state.entries.map((e) => e.job), orderOptions(), state.cfg) : null;
  renderModels();
  renderAnalysis(activeJob);
  if (!state.quote) {
    $('emptyResult').hidden = false;
    $('resultBody').hidden = true;
    return;
  }
  $('emptyResult').hidden = true;
  $('resultBody').hidden = false;
  renderQuote(state.quote);
}

// Parte del precio recomendado que le toca a cada modelo (preparación + piezas, sin gastos adicionales).
const itemLine = (k) => state.quote.lines(state.quote.tiers.recommended.price).items[k];

function renderModels() {
  const q = state.quote;
  $('modelList').innerHTML = state.items.map((it, i) => {
    const k = state.entries.findIndex((e) => e.item === it);
    const f = it.form;
    const line = q && k >= 0 ? itemLine(k) : null;
    const meta = `${f.quantity} × ${f.material} · ${t(`finish_${f.finish}`)}${line ? ` · ${money(line.unit)} ${t('perUnit')}` : ''}`;
    const sub = line ? money(line.total) : t('noData');
    return `<li class="${i === state.active ? 'active' : ''}">
      <button type="button" class="model-sel" data-sel="${i}" aria-pressed="${i === state.active}">
        <span class="model-name">${esc(itemName(it, i))}</span><span class="muted small">${esc(meta)}</span>
      </button>
      <span class="model-sub ${k < 0 ? 'muted' : ''}">${sub}</span>
      ${state.items.length > 1 ? `<button type="button" class="del" data-rm="${i}" aria-label="${esc(t('removeModel'))}" title="${esc(t('removeModel'))}">✕</button>` : ''}
    </li>`;
  }).join('');
  $('modelsHint').hidden = state.items.length > 1;
  $('modelOptionsTitle').textContent = state.items.length > 1
    ? `${t('modelOptions')}: ${itemName(cur(), state.active)}` : t('options');
}

async function selectItem(i) {
  saveForm();
  state.active = Math.max(0, Math.min(i, state.items.length - 1));
  loadForm(cur());
  await showItem(cur());
  recompute();
}

function addItem() {
  saveForm();
  state.items.push(newItem(cur()));
  state.active = state.items.length - 1;
  loadForm(cur());
  showItem(cur());
  recompute();
}

function removeItem(i) {
  if (state.items.length < 2) return;
  saveForm();
  state.items.splice(i, 1);
  if (state.active > i || state.active >= state.items.length) state.active--;
  state.active = Math.max(0, state.active);
  loadForm(cur());
  showItem(cur());
  recompute();
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
    rows.push([t('pieceTime'), duration(job.hours)]);
    if (job.prepHours > 0) {
      rows.push([t('prepStat'), duration(job.prepHours)]);
      rows.push([t('totalTime'), `${duration(job.prepHours + job.hours * job.quantity)} (${duration(job.prepHours)} + ${duration(job.hours)} × ${job.quantity})`]);
    }
    if (job.estimate) rows.push([t('supports'), `${num(job.estimate.supportGrams)} g`]);
  }
  if (state.sliced?.filaments?.length) {
    const fil = state.sliced.filaments.map((f) => `<span class="swatch" style="background:${esc(f.color.slice(0, 7) || 'transparent')}"></span>${esc(f.type)} ${num(f.grams)} g`).join('<br>');
    rows.push([t('filaments'), fil, true]);
  }
  if (state.sliced?.changes != null && state.sliced.filaments?.length > 1) {
    rows.push([t('colorChanges'), state.sliced.changes]);
    rows.push([t('purge'), `${num(state.sliced.purgeGrams || 0)} g`]);
  }
  if (state.sliced?.plates > 1) rows.push([t('plates'), state.sliced.plates]);
  if (a) rows.push(['', fitsBed(a.sizeMm, currentPrinter().bedMm) ? `✓ ${t('fits')}` : `✗ ${t('notFits')}`]);
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

function renderQuote(q) {
  const multi = q.items.length > 1;
  const tierHtml = (key, main) => {
    const tr = q.tiers[key];
    return `<div class="tier ${main ? 'main' : ''}">
      <span class="name">${t(`tier_${key}`)}</span>
      <span class="price">${money(tr.price)}</span>
      ${q.quantity > 1 && !multi ? `<span class="unit">${money(q.lines(tr.price).items[0].unit)} ${t("perUnit")}</span>` : ''}
      ${tr.clientTotal > tr.price + 0.005 ? `<span class="total">${t('clientTotal')}: ${money(tr.clientTotal)}</span>` : ''}
      <span class="hint">${t(`tier_${key}_hint`)}</span>
      <span class="pill ${tr.status}">${t('margin')} ${pct(tr.margin)}</span>
    </div>`;
  };
  $('tiers').innerHTML = tierHtml('minimum') + tierHtml('recommended', true) + tierHtml('premium');

  const notes = [];
  if (multi) notes.push(`<li><span>${t('orderModels', { n: q.items.length })}</span><b>${q.quantity} ${t('units')}</b></li>`);
  if (q.discountPct) notes.push(`<li><span>${t('discountApplied')}</span><b>−${pct(q.discountPct)}</b></li>`);
  if (q.urgent) notes.push(`<li><span>${t('urgentApplied')}</span><b>+${pct(state.cfg.urgencyMultiplier - 1)}</b></li>`);
  if (q.extras.packaging > 0.004) notes.push(`<li><span>${t('packNote')}</span><b>${money(q.extras.packaging)}</b></li>`);
  if (q.extras.shipping > 0.004) notes.push(`<li><span>${t('shipNote')}</span><b>${money(q.extras.shipping)}</b></li>`);
  if (q.feePct) notes.push(`<li><span>${t('feeNote')}</span><b>${num(q.feePct * 100, 1)}%</b></li>`);
  if (q.taxRate) notes.push(`<li><span>${t('taxNote')}</span><b>+${money(q.tiers.recommended.tax)}</b></li>`);
  const share = Math.max(0, q.goalShare);
  notes.push(`<li><span>${t('goalShare')} (${money(state.cfg.monthlyProfitGoal)})</span><b>${num(share * 100, 1)}%</b></li>
    <li><div class="goal-bar" style="flex:1"><i style="width:${Math.min(100, share * 100)}%"></i></div></li>`);
  $('notes').innerHTML = notes.join('');

  renderNegotiated();
  renderSplit();

  const warnings = [];
  const who = (e) => (multi ? `${itemName(e.item, e.i)}: ` : '');
  for (const e of state.entries) {
    const a = e.item.analysis;
    if (!a) continue;
    if (!fitsBed(a.sizeMm, selectPrinter(state.cfg, e.item.form.printer).bedMm)) warnings.push(who(e) + t('w_notFits'));
    const maxDim = Math.max(...a.sizeMm);
    if (maxDim < 3 || maxDim > 2000) warnings.push(who(e) + t('w_scale'));
  }
  for (const w of q.warnings) {
    if (w.code === 'aboveMarket') warnings.push(who(state.entries[w.item]) + t('w_aboveMarket', { perGram: money(w.perGram) }));
  }
  const info = state.notices || [];
  $('warnings').innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('') + info.map(([k, v]) => `<li class="info">${esc(t(k, v))}</li>`).join('');

  renderBreakdown(q);
}

// ---------- desglose del precio (visible para ventas) ----------
const SPLIT_ORDER = ['minimum', 'recommended', 'premium', 'negotiated'];
function renderSplit() {
  const q = state.quote;
  if (!q) return;
  const neg = parseFloat($('negotiated').value);
  const keys = SPLIT_ORDER.filter((k) => k !== 'negotiated' || neg > 0);
  if (!keys.includes(state.splitTier)) state.splitTier = 'recommended';
  $('splitTier').innerHTML = keys.map((k) =>
    `<button type="button" data-tier="${k}" class="${k === state.splitTier ? 'active' : ''}" aria-pressed="${k === state.splitTier}">${t(k === 'negotiated' ? 'tier_negotiated' : `tier_${k}`)}</button>`).join('');
  const price = state.splitTier === 'negotiated' ? neg : q.tiers[state.splitTier].price;
  const tr = q.evaluate(price);
  const parts = q.split(price).filter(([k, v]) => k === 'profit' || v > 0.004);
  const scale = parts.reduce((a, [, v]) => a + Math.max(0, v), 0) || 1;
  const rows = parts.map(([k, v]) => {
    const p = Math.max(0, v) / scale * 100;
    const cls = k === 'profit' ? `profit${v < 0 ? ' neg' : ''}` : k === 'tax' ? 'tax' : '';
    return `<tr class="${cls}"><td>${esc(t(`s_${k}`))}</td><td class="amt">${money(v)}</td><td class="pct">${Math.round(p)}%</td><td class="bar"><i style="width:${p.toFixed(1)}%"></i></td></tr>`;
  });
  rows.push(`<tr class="total"><td>${t('s_total')}</td><td class="amt">${money(price + tr.tax)}</td><td colspan="2"><span class="pill ${tr.status}">${t('margin')} ${pct(tr.margin)} · ${t(`status_${tr.status}`)}</span></td></tr>`);
  $('splitBody').innerHTML = rows.join('');
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
  const multi = q.items.length > 1;
  const prepH = q.hours.prep || 0;
  const rows = [
    [t('b_material'), b.material, `${num(q.grams.total)} g`],
    [t('b_machine'), b.machine, multi ? duration(q.hours.total) : `${q.printer} · ${duration(q.hours.total)}${prepH ? ` (${t('b_prep')} ${duration(prepH)})` : ''} × ${money(b.machineRate)}${t('perHour')}`],
    [t('b_overhead'), b.overhead, multi ? '' : `${money(b.overheadRate)}${t('perHour')}`],
    [t('b_labor'), b.labor, `${Math.round(b.laborMinutes)} min`],
    [t('b_extras'), b.extras, ''],
    [t('b_risk'), b.risk, multi ? '' : pct(state.cfg.failureRiskByComplexity[q.complexity - 1])],
  ].filter(([, v], i) => i < 3 || v > 0.004);
  const rec = q.tiers.recommended;
  const after = [];
  if (q.extras.packaging > 0.004) after.push([`${t('b_extrasTitle')}`, q.extras.packaging, `${t('b_supplies')} ${money(b.supplies)} · ${t('b_packaging')} ${money(b.packaging)}`]);
  if (q.extras.shipping > 0.004) after.push([t('b_shipping'), q.extras.shipping, '']);
  if (rec.fee > 0.004) after.push([t('b_fee'), rec.fee, '']);
  after.push([t('b_profit'), rec.profit, '']);
  const perModel = state.entries.map((e, k) => {
    const iq = q.items[k];
    const li = itemLine(k);
    return `<tr><td>${esc(itemName(e.item, e.i))} <span class="muted small">${iq.quantity} × · ${t('complexity')} ${iq.complexity} · ${iq.printer}${iq.discountPct ? ` · −${pct(iq.discountPct)}` : ''}</span></td>
      <td>${money(li.unit)}</td><td>${money(li.prep)}</td><td>${money(iq.cost)}</td><td>${pct(iq.tiers.recommended.margin)}</td></tr>`;
  }).join('');
  el.innerHTML = `<h2>${t('breakdown')}</h2>
    <table>
      ${rows.map(([k, v, d]) => `<tr><td>${esc(k)} <span class="muted small">${esc(d)}</span></td><td>${money(v)}</td></tr>`).join('')}
      <tr class="total"><td>${t('b_cost')}</td><td>${money(q.cost)}</td></tr>
      ${after.map(([k, v, d]) => `<tr><td>${esc(k)} <span class="muted small">${esc(d)}</span></td><td>${money(v)}</td></tr>`).join('')}
      <tr class="total"><td>${t('b_price')}</td><td>${money(rec.price)}</td></tr>
      ${rec.tax ? `<tr><td>${t('b_tax')}</td><td>${money(rec.tax)}</td></tr>` : ''}
    </table>
    <h3>${t(multi ? 'b_perModel' : 'b_unitPrice')}</h3><table>
      <tr><th>${t('quoteItem')}</th><th>${t('b_unitPrice')}</th><th>${t('b_prep')}</th><th>${t('b_cost')}</th><th>${t('margin')}</th></tr>
      ${perModel}</table>
    ${multi ? `<p class="muted small">${t('b_perModelNote')}</p>`
    : `<p class="muted small">${t(q.profitDriver === 'goal' ? 'b_driver_goal' : 'b_driver_margin')}</p>`}`;
}

// ---------- archivo ----------
async function handleFile(file, item = cur()) {
  if (!file) return;
  const status = $('dropStatus');
  status.textContent = t('loading');
  status.classList.remove('hidden');
  try {
    const parsed = await parseFile(file);
    item.fileName = file.name;
    item.positions = parsed.positions;
    item.sliced = parsed.sliced;
    item.analysis = parsed.positions ? analyzeMesh(parsed.positions, { supportAngleDeg: state.cfg.estimation.supportAngleDeg }) : null;
    item.notices = [];
    if (item === cur()) saveForm();
    item.form.manualOpen = false;
    item.form.perFile = 1;

    // Datos del laminado: material y multicolor automáticos
    if (item.sliced) {
      const fils = item.sliced.filaments || [];
      const type = fils[0]?.type?.toUpperCase();
      const match = type && Object.keys(state.cfg.materials).find((m) => type === m.toUpperCase())
        || (type && Object.keys(state.cfg.materials).find((m) => type.startsWith(m.toUpperCase())));
      if (match) { item.form.material = match; item.notices.push(['w_materialFromFile', { m: match }]); }
      if (fils.length > 1) { item.form.finish = 'multicolor'; item.notices.push(['w_multicolor', { n: fils.length }]); }
    }
    if (!item.analysis && item.form.complexity === 'auto') item.notices.push(['w_noGeometry']);
    if (item.analysis?.inverted) item.notices.push(['w_inverted']);

    if (item === cur()) { loadForm(item); await showItem(item); }
    recompute();
  } catch (err) {
    console.error(err);
    toast(`${t('errorPrefix')}: ${err.message}`);
  } finally {
    status.classList.add('hidden');
  }
}

// Varios archivos a la vez: el primero va al modelo activo si está vacío (o si es uno solo,
// como "cambiar archivo"); el resto crea un modelo nuevo por archivo.
async function handleFiles(files) {
  const list = [...(files || [])];
  for (const [i, file] of list.entries()) {
    if (i > 0 || (list.length > 1 && !isEmpty(cur()))) addItem();
    await handleFile(file, cur());
  }
}

// Muestra el archivo y el visor del modelo activo.
async function showItem(it) {
  $('fileRow').classList.toggle('hidden', !it.fileName);
  $('fileName').textContent = it.fileName || '';
  const badge = $('sourceBadge');
  badge.className = `badge ${it.sliced ? 'exact' : 'estimate'}`;
  badge.dataset.i18n = it.sliced ? 'sourceExact' : 'sourceEstimate';
  badge.textContent = t(badge.dataset.i18n);
  if (it.positions) {
    $('dropEmpty').classList.add('hidden');
    $('viewer').classList.remove('hidden');
    $('drop').classList.add('loaded');
    if (!state.viewer) {
      const { createViewer } = await import('./viewer.js');
      state.viewer = createViewer($('viewer'));
    }
    if (it !== cur()) return;
    state.viewer.show(it.positions, it.analysis.overhangMask, {
      base: cssVar('--model'), overhang: cssVar('--overhang'), grid: cssVar('--grid'),
    });
  } else {
    state.viewer?.clear();
    $('viewer').classList.add('hidden');
    $('dropEmpty').classList.remove('hidden');
    $('drop').classList.remove('loaded');
  }
}

function setupDrop() {
  const drop = $('drop');
  const input = $('fileInput');
  drop.addEventListener('click', () => { if (!drop.classList.contains('loaded')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  $('changeFile').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  });
}

// ---------- cotización para el cliente ----------
// Número de cotización: fecha (AAAAMMDD) + 4 cifras al azar que no se repiten el mismo día
// en este navegador. Se guarda solo la lista del día actual.
function newQuoteNumber() {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let used = [];
  try {
    const saved = JSON.parse(localStorage.getItem('cc3d.quoteNumbers') || 'null');
    if (saved?.date === date && Array.isArray(saved.used)) used = saved.used;
  } catch { /* sin almacenamiento: solo al azar */ }
  let n;
  do { n = 1000 + Math.floor(Math.random() * 9000); } while (used.includes(n) && used.length < 9000);
  try { localStorage.setItem('cc3d.quoteNumbers', JSON.stringify({ date, used: [...used, n] })); } catch { /* nada */ }
  return `${date}${n}`;
}
const pdfTitle = () => t('pdfTitle', { no: state.quoteNo || (state.quoteNo = newQuoteNumber()) });

// Datos de la cotización para el cliente: precio recomendado, con las líneas en el método de pago
// más barato y el total de cada método de pago (los que tienen la misma comisión van juntos).
function clientDoc() {
  const order = orderOptions();
  const jobs = state.entries.map((e) => e.job);
  const methods = Object.entries(state.cfg.paymentFees || {}).map(([id, v]) => ({
    id, name: v.name ?? id, pct: typeof v === 'number' ? v : (v.pct || 0),
  }));
  const quotes = methods.map((m) => ({ ...m, q: computeOrder(jobs, { ...order, payment: m.id }, state.cfg) }));
  const base = quotes.length ? quotes.reduce((a, x) => (x.pct < a.pct ? x : a)) : { q: state.quote, pct: 0 };
  const bq = base.q;
  const price = bq.tiers.recommended.price;
  const L = bq.lines(price);
  const r2 = (v) => Math.round(v * 100) / 100;
  let pieces = 0;
  const items = state.entries.map((e, k) => {
    const li = L.items[k];
    const unit = r2(li.unit);
    pieces += unit * li.quantity;
    return {
      name: itemName(e.item, e.i), job: e.job, qty: li.quantity, unit, pieces: r2(unit * li.quantity),
      discount: bq.items[k].discountPct || 0,
      quality: e.item.sliced && !manualOf(e.item) ? '—' : t(`quality_${e.job.quality}`),
    };
  });
  const groups = [];
  for (const m of quotes) {
    let g = groups.find((x) => Math.abs(x.pct - m.pct) < 1e-9);
    if (!g) groups.push(g = { pct: m.pct, names: [], tier: m.q.tiers.recommended });
    g.names.push(m.name);
  }
  return {
    items, prep: Math.max(0, r2(L.product - pieces)), packaging: L.packaging, shipping: L.shipping,
    subtotal: L.product + L.packaging + L.shipping, taxRate: bq.taxRate, groups, urgent: bq.urgent,
  };
}

const payLabel = (g) => `${g.names.join(' / ')}${g.pct ? ` · ${t('q_feeIncl', { pct: `${num(g.pct * 100, 1)} %` })}` : ''}`;
const payTotal = (g) => money(g.tier.clientTotal) + (g.tier.tax ? ` ${t('q_withTax')}` : '');

function quoteText() {
  const d = clientDoc();
  const lines = [pdfTitle(), ''];
  for (const l of d.items) {
    lines.push(
      `${t('quoteItem')}: ${l.name}`,
      `${t('material')}: ${l.job.material} · ${t('quality')}: ${l.quality} · ${t('finish')}: ${t(`finish_${l.job.finish}`)}`,
      `${t('quantity')}: ${l.qty} × ${money(l.unit)} = ${money(l.pieces)}${l.discount ? ` (${t('q_discount', { pct: pct(l.discount) })})` : ''}`,
      '',
    );
  }
  if (d.prep > 0.004) lines.push(`${t('q_prep')}: ${money(d.prep)}`);
  if (d.packaging > 0.004) lines.push(`${t('q_packaging')}: ${money(d.packaging)}`);
  if (d.shipping > 0.004) lines.push(`${t('q_shipping')}: ${money(d.shipping)}`);
  lines.push(`${t('q_subtotal')}: ${money(d.subtotal)}`, '', `${t('q_payments')}:`);
  for (const g of d.groups) lines.push(`• ${payLabel(g)}: ${payTotal(g)}`);
  lines.push('', `${t('urgency')}: ${t(d.urgent ? 'urgency_urgent' : 'urgency_normal')}`, t('quoteValid'));
  return lines.join('\n');
}

function buildPrintSheet() {
  if (!state.quote) return;
  const d = clientDoc();
  const canvas = $('viewer').querySelector('canvas');
  let img = '';
  if (d.items.length === 1 && state.positions && canvas) { try { img = `<img src="${canvas.toDataURL('image/png')}" alt="">`; } catch { /* nada */ } }
  const rows = d.items.map((l) => `<tr><td>${esc(l.name)}${l.discount ? `<br><span class="small">${t('q_discount', { pct: pct(l.discount) })}</span>` : ''}</td><td>${esc(l.job.material)}</td><td>${t(`finish_${l.job.finish}`)}</td>
        <td class="num">${l.qty}</td><td class="num">${money(l.unit)}</td><td class="num"><b>${money(l.pieces)}</b></td></tr>`).join('');
  const extra = (label, v) => (v > 0.004 ? `<tr><td colspan="5">${label}</td><td class="num">${money(v)}</td></tr>` : '');
  $('printSheet').innerHTML = `
    <h1>${esc(pdfTitle())}</h1>
    <div>${new Date().toLocaleDateString(locale())}</div>
    ${img}
    <table>
      <tr><th>${t('quoteItem')}</th><th>${t('material')}</th><th>${t('finish')}</th><th class="num">${t('quantity')}</th><th class="num">${t('perUnit')}</th><th class="num">${t('quoteTotal')}</th></tr>
      ${rows}
      ${extra(t('q_prep'), d.prep)}
      ${extra(t('q_packaging'), d.packaging)}
      ${extra(t('q_shipping'), d.shipping)}
      <tr><td colspan="5"><b>${t('q_subtotal')}</b></td><td class="num"><b>${money(d.subtotal)}</b></td></tr>
    </table>
    <h2 class="pay-title">${t('q_payments')}</h2>
    <table>
      ${d.groups.map((g) => `<tr><td>${esc(payLabel(g))}</td><td class="num"><b>${payTotal(g)}</b></td></tr>`).join('')}
    </table>
    <p>${t('urgency')}: ${t(d.urgent ? 'urgency_urgent' : 'urgency_normal')}</p>
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
  ['sec_printer2', [['printer2.name', 'text'], ['printer2.priceUsd'], ['printer2.lifeHours'], ['printer2.powerKw'], ['printer2.maintenancePerHour']]],
  ['sec_costs', [['electricityPerKwh'], ['laborPerHour'], ['setupMinutes'], ['fixedCostsMonthly'], ['itbmsRate', 'pct']]],
  ['sec_pricing', [['monthlyProfitGoal'], ['sellableHoursPerMonth'], ['minOrderPrice'], ['minMargin', 'pct'], ['premiumMultiplier'], ['urgencyMultiplier'], ['roundingStep'], ['marketMaxPerGram']]],
  ['sec_complexity', [['marginByComplexity', 'pctlist'], ['failureRiskByComplexity', 'pctlist'], ['postMinutesByComplexity', 'list']]],
  ['sec_estimation', [['estimation.infill', 'pct'], ['estimation.massCalibration'], ['estimation.timeCalibration']]],
];
// Listas que el administrador puede ampliar o recortar: filamentos, insumos, packaging,
// envíos y métodos de pago. Cada fila es un elemento; "Agregar" crea una fila vacía.
const ADMIN_LISTS = [
  { key: 'materials', title: 'sec_materials', nameIsKey: true, fields: [['costPerKg', 'num', 'col_costPerKg'], ['density', 'num', 'col_density'], ['speedFactor', 'num', 'col_speedFactor']], blank: { costPerKg: 25, density: 1.24, speedFactor: 1 } },
  { key: 'supplies', title: 'sec_supplies', fields: [['cost', 'num', 'col_costUnit']], blank: { cost: 0.1 } },
  { key: 'packaging', title: 'sec_packaging', fields: [['unit', 'num', 'col_perUnit'], ['order', 'num', 'col_perOrder']], blank: { unit: 0.2, order: 0 } },
  { key: 'shipping', title: 'sec_shipping', fields: [['cost', 'num', 'col_cost']], blank: { cost: 0 } },
  { key: 'paymentFees', title: 'sec_payments', fields: [['pct', 'pct', 'col_pct']], blank: { pct: 0 } },
];

function listRow(spec, id, v) {
  const name = spec.nameIsKey ? id : (v.name ?? '');
  const cells = spec.fields.map(([f, type]) => {
    const raw = v[f] ?? 0;
    const shown = type === 'pct' ? +(raw * 100).toFixed(3) : raw;
    return `<td><input type="number" step="any" data-f="${f}" data-type="${type}" value="${esc(shown)}"></td>`;
  }).join('');
  return `<tr data-id="${esc(id)}"><td><input type="text" data-f="name" value="${esc(name)}" aria-label="${esc(t('col_name'))}"></td>${cells}<td><button type="button" class="del" data-del aria-label="${esc(t('remove'))}">✕</button></td></tr>`;
}

function listEditor(spec, list) {
  return `<div class="admin-sec" data-list="${spec.key}"><h3>${t(spec.title)}</h3>
    <div class="admin-list-wrap"><table class="admin-list"><thead><tr><th>${t('col_name')}</th>${spec.fields.map(([, , l]) => `<th>${t(l)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${Object.entries(list).map(([id, v]) => listRow(spec, id, v)).join('')}</tbody></table></div>
    <button type="button" class="btn small" data-add="${spec.key}">${t('addItem')}</button></div>`;
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function collectLists(cfg) {
  for (const spec of ADMIN_LISTS) {
    const box = $('adminFields').querySelector(`[data-list="${spec.key}"]`);
    if (!box) continue;
    const out = {};
    for (const tr of box.querySelectorAll('tbody tr')) {
      const name = tr.querySelector('[data-f=name]').value.trim();
      if (!name) continue;
      let id = spec.nameIsKey ? name : (tr.dataset.id || slug(name));
      while (out[id]) id += '-2';
      const prev = (cfg[spec.key] || {})[tr.dataset.id] || {};
      const item = spec.nameIsKey ? { ...prev } : { ...prev, name };
      for (const el of tr.querySelectorAll('input[data-f]:not([data-f=name])')) {
        let v = parseFloat(el.value);
        if (!Number.isFinite(v)) v = 0;
        if (el.dataset.type === 'pct') v /= 100;
        item[el.dataset.f] = v;
      }
      out[id] = item;
    }
    if (spec.key === 'materials' && !Object.keys(out).length) throw new Error(t('needMaterial'));
    cfg[spec.key] = out;
  }
}

function setupListEditors() {
  $('adminFields').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { del.closest('tr').remove(); return; }
    const add = e.target.closest('[data-add]');
    if (!add) return;
    const spec = ADMIN_LISTS.find((x) => x.key === add.dataset.add);
    const tbody = add.parentElement.querySelector('tbody');
    tbody.insertAdjacentHTML('beforeend', listRow(spec, '', { ...spec.blank, name: '' }));
    tbody.lastElementChild.querySelector('input').focus();
  });
}

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
        return `<label><span>${t('f_' + path.replaceAll('.', '_'))}</span><input data-path="${path}" data-type="${type || 'num'}" type="${type === 'text' ? 'text' : 'number'}" step="any" value="${esc(shown)}"></label>`;
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
    if (sec === 'sec_printer2') {
      html += `<p class="admin-info muted">${t('machineRate')}: <b>${money(machineRatePerHour(cfg, cfg.printer2))}${t('perHour')}</b></p>`;
    }
    if (sec === 'sec_costs') {
      html += `<p class="admin-info muted">${t('overheadPerHour')}: <b>${money((cfg.fixedCostsMonthly || 0) / Math.max(1, cfg.sellableHoursPerMonth))}${t('perHour')}</b></p>`;
    }
    if (sec === 'sec_pricing') {
      html += `<p class="admin-info muted">${t('goalPerHour')}: <b>${money(cfg.monthlyProfitGoal / Math.max(1, cfg.sellableHoursPerMonth))}${t('perHour')}</b></p>`;
    }
    html += '</div>';
  }
  for (const spec of ADMIN_LISTS) html += listEditor(spec, cfg[spec.key] || {});
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
    collectLists(cfg);
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
function currentPrinter() { return selectPrinter(state.cfg, $('printer').value); }

function fillPrinterAndShipping() {
  const cfg = state.cfg;
  const ps = $('printer');
  const prevP = ps.value || 'printer';
  const list = [['printer', cfg.printer]];
  if (cfg.printer2?.enabled) list.push(['printer2', cfg.printer2]);
  ps.innerHTML = list.map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('');
  ps.value = list.some(([k]) => k === prevP) ? prevP : 'printer';
  $('printerField').hidden = list.length < 2;
  fillSelect('shipping', cfg.shipping, (v) => `${v.name} · ${money(v.cost)}`, 'pickup');
  fillSelect('packaging', cfg.packaging, (v) => v.name + (v.unit ? ` · ${money(v.unit)} ${t('perUnit')}` : ''), 'basic');
  fillSelect('payment', cfg.paymentFees, (v) => v.name + (v.pct ? ` (${num(v.pct * 100, 1)}%)` : ''), 'yappy');
  $('itbmsLabel').textContent = t('itbms', { rate: num((cfg.itbmsRate || 0) * 100, 0) });
  // Insumos del catálogo: cantidad por unidad (se conserva lo que ya estaba marcado).
  const prev = Object.fromEntries([...document.querySelectorAll('#suppliesList input[data-supply]')].map((el) => [el.dataset.supply, el.value]));
  const entries = Object.entries(cfg.supplies || {});
  $('suppliesBox').hidden = !entries.length;
  $('suppliesList').innerHTML = entries.map(([id, v]) =>
    `<label><input type="number" min="0" step="1" value="${esc(prev[id] ?? 0)}" data-supply="${esc(id)}" aria-label="${esc(v.name)}"><span>${esc(v.name)}</span><span class="cost">${money(v.cost)}</span></label>`).join('');
}

function fillSelect(id, list, label, fallback) {
  const el = $(id);
  const prev = el.value || fallback;
  const keys = Object.keys(list || {});
  el.innerHTML = keys.map((k) => `<option value="${esc(k)}">${esc(label(list[k]))}</option>`).join('');
  el.value = keys.includes(prev) ? prev : (keys.includes(fallback) ? fallback : keys[0] || '');
}

function fillMaterials() {
  fillPrinterAndShipping();
  const sel = $('material');
  const prev = sel.value;
  sel.innerHTML = Object.keys(state.cfg.materials).map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  sel.value = state.cfg.materials[prev] ? prev : Object.keys(state.cfg.materials)[0];
}

function refreshLanguage() {
  applyI18n();
  fillPrinterAndShipping();
  for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('active', b.dataset.lang === getLang());
  if (state.admin && $('adminDialog').open) renderAdmin();
  recompute();
}

async function init() {
  state.cfg = await loadConfig();
  fillMaterials();
  state.items = [newItem()];
  state.items[0].form.material = $('material').value;
  setupDrop();
  setupAdmin();
  setupListEditors();
  for (const b of document.querySelectorAll('[data-lang]')) {
    b.addEventListener('click', () => { setLang(b.dataset.lang); refreshLanguage(); });
  }
  const onItem = () => { saveForm(); recompute(); };
  $('opts').addEventListener('input', onItem);
  $('opts').addEventListener('change', onItem);
  $('manual').addEventListener('input', onItem);
  $('manual').addEventListener('toggle', onItem);
  $('orderOpts').addEventListener('input', recompute);
  $('orderOpts').addEventListener('change', recompute);
  $('addModel').addEventListener('click', addItem);
  $('modelList').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { removeItem(+rm.dataset.rm); return; }
    const sel = e.target.closest('[data-sel]');
    if (sel && +sel.dataset.sel !== state.active) selectItem(+sel.dataset.sel);
  });
  $('negotiated').addEventListener('input', () => { renderNegotiated(); renderSplit(); });
  $('splitTier').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tier]');
    if (b) { state.splitTier = b.dataset.tier; renderSplit(); }
  });
  $('copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(quoteText()); toast(t('copied')); } catch { toast(quoteText()); }
  });
  $('printBtn').addEventListener('click', () => { buildPrintSheet(); window.print(); });
  // El título de la pestaña es el nombre sugerido del PDF; se restaura al terminar.
  const appTitle = document.title;
  window.addEventListener('beforeprint', () => { buildPrintSheet(); if (state.quote) document.title = pdfTitle(); });
  window.addEventListener('afterprint', () => { document.title = appTitle; });
  refreshLanguage();
}

init();
