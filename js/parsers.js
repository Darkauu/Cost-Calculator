// Lectores de archivos: STL (binario/ASCII), OBJ, 3MF (incluye .gcode.3mf de Bambu Studio) y G-code.
// Todo corre en el navegador; el archivo nunca sale del equipo.
import { unzipSync, strFromU8 } from 'fflate';

// ---------- STL ----------
export function parseSTL(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const n = view.getUint32(80, true);
    if (84 + n * 50 === buffer.byteLength) {
      const out = new Float32Array(n * 9);
      let o = 84;
      for (let t = 0; t < n; t++) {
        o += 12; // normal (se recalcula)
        for (let k = 0; k < 9; k++) { out[t * 9 + k] = view.getFloat32(o, true); o += 4; }
        o += 2;
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(buffer);
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const vals = [];
  let m;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  if (vals.length < 9) throw new Error('STL vacío o no reconocido');
  return new Float32Array(vals.slice(0, vals.length - (vals.length % 9)));
}

// ---------- OBJ ----------
export function parseOBJ(text) {
  const verts = [];
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      verts.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('f ')) {
      const idx = line.split(/\s+/).slice(1).map((s) => {
        const i = parseInt(s.split('/')[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      for (let k = 1; k < idx.length - 1; k++) {
        for (const i of [idx[0], idx[k], idx[k + 1]]) {
          const v = verts[i];
          if (!v) throw new Error('OBJ con índices inválidos');
          out.push(v[0], v[1], v[2]);
        }
      }
    }
  }
  if (!out.length) throw new Error('OBJ sin caras');
  return new Float32Array(out);
}

// ---------- utilidades XML (regex, funciona en navegador y en Node) ----------
function attrs(tag) {
  const o = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) o[m[1]] = m[2];
  return o;
}

// Matriz 3MF: "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (vector fila: p' = p·M)
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function parseTransform(s) {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
}
// a se aplica primero, luego b
function compose(a, b) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  for (let j = 0; j < 3; j++) {
    r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  }
  return r;
}

function parseModelXml(xml) {
  const objects = new Map();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const a = attrs(m[1]);
    const body = m[2];
    const obj = { id: a.id, mesh: null, components: [] };
    const meshMatch = /<mesh\b[\s\S]*?<\/mesh>/.exec(body);
    if (meshMatch) {
      const mesh = meshMatch[0];
      const vertices = [];
      const vRe = /<vertex\b([^>]*)\/?>/g;
      let v;
      while ((v = vRe.exec(mesh))) {
        const va = attrs(v[1]);
        vertices.push(+va.x, +va.y, +va.z);
      }
      const triangles = [];
      const tRe = /<triangle\b([^>]*)\/?>/g;
      let t;
      while ((t = tRe.exec(mesh))) {
        const ta = attrs(t[1]);
        triangles.push(+ta.v1, +ta.v2, +ta.v3);
      }
      obj.mesh = { vertices, triangles };
    }
    const cRe = /<component\b([^>]*)\/?>/g;
    let c;
    while ((c = cRe.exec(body))) {
      const ca = attrs(c[1]);
      obj.components.push({
        objectid: ca.objectid,
        path: (ca['p:path'] || ca.path || '').replace(/^\//, ''),
        transform: parseTransform(ca.transform),
      });
    }
    objects.set(a.id, obj);
  }
  const items = [];
  const buildMatch = /<build\b[\s\S]*?<\/build>/.exec(xml);
  if (buildMatch) {
    const iRe = /<item\b([^>]*)\/?>/g;
    let i;
    while ((i = iRe.exec(buildMatch[0]))) {
      const ia = attrs(i[1]);
      items.push({
        objectid: ia.objectid,
        path: (ia['p:path'] || '').replace(/^\//, ''),
        transform: parseTransform(ia.transform),
        printable: ia.printable !== '0',
      });
    }
  }
  return { objects, items };
}

function parseDuration(s) {
  if (!s) return null;
  let sec = 0;
  let found = false;
  const re = /([\d.]+)\s*([dhms])/g;
  let m;
  while ((m = re.exec(s))) {
    found = true;
    sec += +m[1] * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]];
  }
  return found ? sec : null;
}

// ---------- cambios de color y purga (G-code de Bambu Studio) ----------
const splitList = (v) => (v ? v.split(v.includes(';') ? ';' : ',').map((x) => x.trim().replace(/^"|"$/g, '')) : []);

// Recorre el cuerpo del G-code y cuenta los cambios de filamento del AMS (M620 S<n>A) y la
// purga de cada cambio: en P2S/H2 la firma el firmware (M620.10 A1 … L<mm>); en X1/P1 son
// extrusiones entre "; FLUSH_START" y "; FLUSH_END". También suma la torre de purga.
// Los gramos de purga ya vienen incluidos en el peso total de Bambu Studio: esto solo los separa.
export function scanToolChanges(text) {
  const cfgBlock = (re) => re.exec(text.slice(0, 400000))?.[1];
  const dens = splitList(cfgBlock(/;\s*filament_density\s*[:=]\s*([^\n]+)/)).map(Number);
  const dias = splitList(cfgBlock(/;\s*filament_diameter\s*[:=]\s*([^\n]+)/)).map(Number);
  const gPerMm = (i) => { const r = (dias[i] || dias[0] || 1.75) / 2; return Math.PI * r * r / 1000 * (dens[i] || dens[0] || 1.24); };

  let cur = null, chg = null, inFlush = false, feature = '', rel = true, lastE = 0;
  let changes = 0, purgeG = 0, towerG = 0;
  const closeChange = () => {
    if (chg) purgeG += (chg.L > 0 ? chg.L : chg.E) * gPerMm(chg.to);
    chg = null;
  };
  const eOf = (l) => {
    const m = /\sE(-?\d*\.?\d+)/.exec(l);
    if (!m) return 0;
    const e = parseFloat(m[1]);
    if (rel) return e;
    const d = e - lastE; lastE = e; return d;
  };
  let start = 0;
  const n = text.length;
  while (start < n) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    const l = text.slice(start, end).trim();
    start = end + 1;
    if (!l) continue;
    const c0 = l.charCodeAt(0);
    if (c0 === 59) { // ';'
      if (l.startsWith('; FLUSH_START')) inFlush = true;
      else if (l.startsWith('; FLUSH_END')) inFlush = false;
      else if (l.startsWith('; FEATURE:')) feature = l.slice(10).trim();
      continue;
    }
    if (c0 === 71) { // 'G'
      if (l.startsWith('G92')) { const m = /\sE(-?\d*\.?\d+)/.exec(l); if (m) lastE = parseFloat(m[1]); continue; }
      if (!/^G[123]\s/.test(l) || l.indexOf('E') < 0) continue;
      const e = eOf(l);
      if (e <= 0) continue;
      if (inFlush && chg) chg.E += e;
      else if (feature === 'Prime tower' && cur != null) towerG += e * gPerMm(cur);
      continue;
    }
    if (c0 === 77) { // 'M'
      if (/^M83\b/.test(l)) { rel = true; continue; }
      if (/^M82\b/.test(l)) { rel = false; continue; }
      const m = /^M620\s+S(\d+)A/.exec(l);
      if (m) {
        const id = +m[1];
        if (id >= 255) continue;
        closeChange();
        if (cur != null && id !== cur) { changes++; chg = { to: id, L: 0, E: 0 }; }
        cur = id;
        continue;
      }
      if (chg && l.startsWith('M620.10 A1')) { const L = /\sL(\d*\.?\d+)/.exec(l); if (L) chg.L = parseFloat(L[1]); }
    }
  }
  closeChange();
  return { changes, purgeGrams: purgeG + towerG };
}

// ---------- G-code (Bambu Studio / Orca / Prusa) ----------
export function parseGcode(text) {
  // Solo se leen encabezado y final, donde los slicers escriben el resumen.
  const head = text.slice(0, 200000);
  const tail = text.slice(-200000);
  const both = head + '\n' + tail;

  let seconds = null;
  const timePatterns = [
    /total estimated time:\s*([^;\n]+)/i,
    /estimated printing time \(normal mode\)\s*=\s*([^\n]+)/i,
    /model printing time:\s*([^;\n]+)/i,
  ];
  for (const re of timePatterns) {
    const m = re.exec(both);
    if (m && (seconds = parseDuration(m[1])) != null) break;
  }
  if (seconds == null) {
    const m = /;TIME:(\d+)/.exec(both);
    if (m) seconds = +m[1];
  }

  let grams = null;
  let perFilament = [];
  const w = /total filament weight \[g\]\s*:\s*([\d.,\s]+)/i.exec(both);
  const used = /filament used \[g\]\s*=\s*([\d.,\s]+)/i.exec(both);
  if (used) perFilament = used[1].split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
  // Bambu Studio escribe un valor por filamento: "total filament weight [g] : 38.02,12.00"
  const wList = w ? w[1].split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x)) : [];
  if (!perFilament.length && wList.length > 1) perFilament = wList;
  if (wList.length) grams = wList.reduce((a, b) => a + b, 0);
  else if (perFilament.length) grams = perFilament.reduce((a, b) => a + b, 0);

  const types = (/;\s*filament_type\s*=\s*([^\n]+)/i.exec(both)?.[1] || '').split(';').map((s) => s.trim());
  const colors = (/;\s*filament_colou?r\s*=\s*([^\n]+)/i.exec(both)?.[1] || '').split(';').map((s) => s.trim());
  const filaments = perFilament.length
    ? perFilament.map((g, i) => ({ type: types[i] || types[0] || '', color: colors[i] || '', grams: g })).filter((f) => f.grams > 0)
    : (types[0] ? [{ type: types[0], color: colors[0] || '', grams }] : []);

  if (seconds == null || grams == null) throw new Error('No se encontró tiempo/peso en el G-code. Exporta desde Bambu Studio.');
  const { changes, purgeGrams } = scanToolChanges(text);
  return { grams, hours: seconds / 3600, filaments, plates: 1, changes, purgeGrams };
}

// ---------- 3MF ----------
function findFile(files, name) {
  const lower = name.toLowerCase();
  return Object.keys(files).find((k) => k.toLowerCase() === lower);
}

function parseSliceInfo(xml) {
  const plates = [];
  const pRe = /<plate\b[^>]*>([\s\S]*?)<\/plate>/g;
  let p;
  while ((p = pRe.exec(xml))) {
    const meta = {};
    const mRe = /<metadata\b([^>]*)\/?>/g;
    let m;
    while ((m = mRe.exec(p[1]))) {
      const a = attrs(m[1]);
      if (a.key) meta[a.key] = a.value;
    }
    const filaments = [];
    const fRe = /<filament\b([^>]*)\/?>/g;
    let f;
    while ((f = fRe.exec(p[1]))) {
      const a = attrs(f[1]);
      filaments.push({ type: a.type || '', color: a.color || '', grams: parseFloat(a.used_g) || 0 });
    }
    const seconds = parseFloat(meta.prediction);
    const grams = parseFloat(meta.weight);
    if (Number.isFinite(seconds) && Number.isFinite(grams) && (seconds > 0 || grams > 0)) {
      plates.push({ seconds, grams, filaments });
    }
  }
  if (!plates.length) return null;
  const merged = new Map();
  for (const f of plates.flatMap((x) => x.filaments)) {
    const key = `${f.type}|${f.color}`;
    merged.set(key, { ...f, grams: (merged.get(key)?.grams || 0) + f.grams });
  }
  return {
    grams: plates.reduce((a, b) => a + b.grams, 0),
    hours: plates.reduce((a, b) => a + b.seconds, 0) / 3600,
    filaments: [...merged.values()].filter((f) => f.grams > 0),
    plates: plates.length,
  };
}

export function parse3MF(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (name) => {
    const key = findFile(files, name);
    return key ? strFromU8(files[key]) : null;
  };

  // Datos exactos del laminado (proyectos laminados o "Exportar archivo de placa laminada")
  let sliced = null;
  const sliceXml = read('Metadata/slice_info.config');
  if (sliceXml) sliced = parseSliceInfo(sliceXml);
  const gkeys = Object.keys(files).filter((k) => /^metadata\/plate_\d+\.gcode$/i.test(k));
  if (!sliced && gkeys.length) {
    try { sliced = parseGcode(strFromU8(files[gkeys[0]])); } catch { /* sin datos */ }
  } else if (sliced && gkeys.length) {
    // Cambios de color y purga: solo están en el G-code de cada placa.
    let changes = 0, purgeGrams = 0;
    for (const k of gkeys) {
      const r = scanToolChanges(strFromU8(files[k]));
      changes += r.changes; purgeGrams += r.purgeGrams;
    }
    sliced = { ...sliced, changes, purgeGrams };
  }

  // Geometría
  const models = new Map();
  const getModel = (path) => {
    const key = findFile(files, path);
    if (!key) return null;
    if (!models.has(key)) models.set(key, parseModelXml(strFromU8(files[key])));
    return models.get(key);
  };
  const mainPath = Object.keys(files).find((k) => /^3d\/3dmodel\.model$/i.test(k))
    || Object.keys(files).find((k) => k.toLowerCase().endsWith('.model'));

  const out = [];
  const emit = (mesh, T) => {
    const { vertices: v, triangles: t } = mesh;
    for (let i = 0; i < t.length; i++) {
      const j = t[i] * 3;
      const x = v[j], y = v[j + 1], z = v[j + 2];
      out.push(
        x * T[0] + y * T[3] + z * T[6] + T[9],
        x * T[1] + y * T[4] + z * T[7] + T[10],
        x * T[2] + y * T[5] + z * T[8] + T[11],
      );
    }
  };
  const visit = (modelPath, objectId, T, depth) => {
    if (depth > 8) return;
    const model = getModel(modelPath);
    const obj = model?.objects.get(objectId);
    if (!obj) return;
    if (obj.mesh) emit(obj.mesh, T);
    for (const c of obj.components) visit(c.path || modelPath, c.objectid, compose(c.transform, T), depth + 1);
  };

  if (mainPath) {
    const main = getModel(mainPath);
    const items = main.items.filter((i) => i.printable);
    if (items.length) {
      for (const it of items) visit(it.path || mainPath, it.objectid, it.transform, 0);
    } else {
      for (const obj of main.objects.values()) if (obj.mesh) emit(obj.mesh, IDENTITY);
    }
  }

  const positions = out.length ? new Float32Array(out) : null;
  if (!positions && !sliced) throw new Error('El 3MF no contiene geometría ni datos de laminado');
  return { positions, sliced };
}

// ---------- entrada única ----------
export async function parseFile(file) {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.stl')) return { positions: parseSTL(buf), sliced: null };
  if (name.endsWith('.obj')) return { positions: parseOBJ(new TextDecoder().decode(buf)), sliced: null };
  if (name.endsWith('.3mf')) return parse3MF(buf);
  if (name.endsWith('.gcode') || name.endsWith('.gco')) return { positions: null, sliced: parseGcode(new TextDecoder().decode(buf)) };
  throw new Error('Formato no soportado. Usa STL, 3MF, OBJ o G-code.');
}
