// Análisis geométrico de mallas (triángulos sueltos, en mm, eje Z hacia arriba).
// `positions` es un Float32Array con 9 valores por triángulo.

export function analyzeMesh(positions, opts = {}) {
  const supportAngleDeg = opts.supportAngleDeg ?? 45;
  // cara que se inclina más de X° respecto a la vertical (mirando hacia abajo) necesita soporte
  const overhangNz = -Math.sin(supportAngleDeg * Math.PI / 180);
  const triCount = Math.floor(positions.length / 9);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < triCount * 9; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  let volume = 0, area = 0, overhangArea = 0, supportVolume = 0;
  const overhangMask = new Uint8Array(triCount);
  const bedTolerance = 0.5;

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];

    // volumen con signo (teorema de la divergencia)
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    const triArea = len / 2;
    area += triArea;

    const nzUnit = nz / len;
    const centroidZ = (az + bz + cz) / 3;
    const heightAboveBed = centroidZ - minZ;
    if (nzUnit < overhangNz && heightAboveBed > bedTolerance) {
      overhangArea += triArea;
      overhangMask[t] = 1;
      // columna de soporte bajo la cara: área proyectada × altura
      supportVolume += triArea * -nzUnit * heightAboveBed;
    }
  }

  // Si la malla está invertida (normales hacia adentro) el volumen sale negativo.
  const absVolume = Math.abs(volume);
  const size = triCount ? [maxX - minX, maxY - minY, maxZ - minZ] : [0, 0, 0];

  return {
    triangles: triCount,
    volumeMm3: absVolume,
    areaMm2: area,
    overhangAreaMm2: overhangArea,
    supportVolumeMm3: supportVolume,
    sizeMm: size,
    min: [minX, minY, minZ],
    overhangMask,
    inverted: volume < 0,
    complexity: scoreComplexity({ volume: absVolume, area, overhangArea, size }),
  };
}

function step(value, thresholds, points) {
  for (let i = 0; i < thresholds.length; i++) if (value < thresholds[i]) return points[i];
  return points[points.length - 1];
}

// Puntaje de complejidad 1–5 a partir de tres señales fáciles de explicar al cliente.
export function scoreComplexity({ volume, area, overhangArea, size }) {
  if (!volume || !area) return { level: 1, factors: { detail: 0, overhang: 0, slenderness: 0 }, total: 0 };

  // Detalle: superficie respecto al volumen (esfera ≈ 4.8, cubo = 6; piezas finas o detalladas ≫ 10)
  const shapeFactor = area / Math.pow(volume, 2 / 3);
  const detail = step(shapeFactor, [7, 10, 15, 25], [0, 0.5, 1, 1.5, 2]);

  // Voladizos: porcentaje de la superficie que necesita soporte
  const overhangRatio = overhangArea / area;
  const overhang = step(overhangRatio, [0.02, 0.06, 0.12, 0.2], [0, 0.5, 1, 1.5, 2]);

  // Esbeltez: piezas altas y delgadas son más propensas a fallar
  const footprint = Math.sqrt(Math.max(size[0] * size[1], 1e-6));
  const slender = size[2] / footprint;
  const slenderness = step(slender, [2, 3.5], [0, 0.5, 1]);

  const total = detail + overhang + slenderness;
  const level = Math.max(1, Math.min(5, 1 + Math.floor(total + 0.25)));
  return {
    level,
    total,
    factors: { detail, overhang, slenderness },
    metrics: { shapeFactor, overhangRatio, slender },
  };
}

// Estimación de peso (g) y tiempo (h) para FDM a partir del análisis geométrico.
export function estimatePrint(analysis, { material, quality, estimation }) {
  const e = estimation;
  const V = analysis.volumeMm3;
  const shell = Math.min(V, analysis.areaMm2 * e.shellMm);
  const infill = (V - shell) * e.infill;
  const support = analysis.supportVolumeMm3 * e.supportDensity;
  const grams = ((shell + infill + support) / 1000) * material.density * e.massCalibration;
  const supportGrams = (support / 1000) * material.density * e.massCalibration;

  const layers = analysis.sizeMm[2] / quality.layerMm;
  const level = analysis.complexity.level;
  const printHours = grams / (quality.gramsPerHour * (material.speedFactor ?? 1));
  const hours = (printHours + (layers * e.layerOverheadSec) / 3600 + e.warmupHours)
    * e.timeComplexityFactor[level - 1] * e.timeCalibration;

  return { grams, supportGrams, hours, layers: Math.ceil(layers) };
}

export function fitsBed(sizeMm, bedMm) {
  const a = [...sizeMm].sort((x, y) => x - y);
  const b = [...bedMm].sort((x, y) => x - y);
  // permite rotar la pieza en cualquier eje
  return a.every((v, i) => v <= b[i]);
}
