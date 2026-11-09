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
  const w = /total filament weight \[g\]\s*:\s*([\d.]+)/i.exec(both);
  const used = /filament used \[g\]\s*=\s*([\d.,\s]+)/i.exec(both);
  if (used) perFilament = used[1].split(',').map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
  if (w) grams = +w[1];
  else if (perFilament.length) grams = perFilament.reduce((a, b) => a + b, 0);

  const types = (/;\s*filament_type\s*=\s*([^\n]+)/i.exec(both)?.[1] || '').split(';').map((s) => s.trim());
  const colors = (/;\s*filament_colou?r\s*=\s*([^\n]+)/i.exec(both)?.[1] || '').split(';').map((s) => s.trim());
  const filaments = perFilament.length
    ? perFilament.map((g, i) => ({ type: types[i] || types[0] || '', color: colors[i] || '', grams: g })).filter((f) => f.grams > 0)
    : (types[0] ? [{ type: types[0], color: colors[0] || '', grams }] : []);

  if (seconds == null || grams == null) throw new Error('No se encontró tiempo/peso en el G-code. Exporta desde Bambu Studio.');
  return { grams, hours: seconds / 3600, filaments, plates: 1 };
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
  if (!sliced) {
    const gkey = Object.keys(files).find((k) => /^metadata\/plate_\d+\.gcode$/i.test(k));
    if (gkey) { try { sliced = parseGcode(strFromU8(files[gkey])); } catch { /* sin datos */ } }
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
