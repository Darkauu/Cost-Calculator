// Configuración por defecto del cotizador.
// Todos los valores son editables desde el panel de administración.
// Los valores marcados como "SUPUESTO" son referencias iniciales que conviene ajustar.

export const DEFAULT_CONFIG = {
  version: 1,
  currency: 'USD',

  // Impresora principal. Más adelante esto será una lista (gestión de impresoras en modo LAN).
  printer: {
    id: 'p2s-combo',
    name: 'Bambu Lab P2S Combo',
    priceUsd: 799,            // SUPUESTO: precio de compra
    lifeHours: 6000,          // SUPUESTO: horas de vida útil para amortizar
    powerKw: 0.15,            // SUPUESTO: consumo promedio imprimiendo PLA
    maintenancePerHour: 0.08, // SUPUESTO: boquillas, PEI, correas, lubricante
    bedMm: [256, 256, 256],
  },

  electricityPerKwh: 0.25,

  // Mano de obra (preparar, laminar, retirar y limpiar). Pon 0 si tu tiempo cuenta como ganancia.
  laborPerHour: 6,                              // SUPUESTO
  setupMinutes: 10,                             // por pedido
  postMinutesByComplexity: [2, 4, 8, 15, 25],   // por unidad, según complejidad 1–5

  // Riesgo de falla (reimpresión de material + máquina), según complejidad 1–5
  failureRiskByComplexity: [0.03, 0.05, 0.08, 0.12, 0.18],

  // Margen objetivo sobre el precio, según complejidad 1–5
  marginByComplexity: [0.55, 0.60, 0.65, 0.68, 0.72],
  minMargin: 0.35,          // por debajo de esto la venta necesita aprobación
  premiumMultiplier: 1.2,   // precio premium = recomendado × esto
  urgencyMultiplier: 1.3,   // pedidos urgentes

  // Meta mensual de ganancia. Se reparte entre las horas de máquina que esperas vender,
  // así cada hora de impresión aporta lo suficiente para llegar a la meta.
  monthlyProfitGoal: 300,
  sellableHoursPerMonth: 120, // SUPUESTO: ~4 h/día de impresión vendida

  minOrderPrice: 5,
  roundingStep: 0.5,
  wasteFactor: 0.05,          // purga, falda, pruebas

  // Alerta de "posible precio fuera de mercado"
  marketMaxPerGram: 0.5,
  marketCheckMinGrams: 30,

  quantityDiscounts: [
    { minQty: 10, pct: 0.05 },
    { minQty: 25, pct: 0.10 },
    { minQty: 50, pct: 0.15 },
  ],

  materials: {
    'PLA':    { costPerKg: 20, density: 1.24, speedFactor: 1.0 },
    'PETG':   { costPerKg: 22, density: 1.27, speedFactor: 0.85 },
    'ABS':    { costPerKg: 22, density: 1.04, speedFactor: 0.9 },
    'ASA':    { costPerKg: 25, density: 1.07, speedFactor: 0.9 },
    'TPU':    { costPerKg: 30, density: 1.21, speedFactor: 0.45 },
    'PLA-CF': { costPerKg: 35, density: 1.30, speedFactor: 0.85 },
  },

  // Perfiles de calidad (alturas de capa típicas de Bambu Studio)
  qualities: {
    draft:    { layerMm: 0.28, gramsPerHour: 45 },
    standard: { layerMm: 0.20, gramsPerHour: 30 },
    fine:     { layerMm: 0.12, gramsPerHour: 16 },
  },

  // Acabados. materialFactor/timeFactor solo se aplican a estimaciones (no a archivos laminados,
  // que ya incluyen la purga real del AMS).
  finishes: {
    none:       { extraMinutes: 0,  extraCost: 0,   materialFactor: 1,    timeFactor: 1 },
    sanded:     { extraMinutes: 15, extraCost: 0.3, materialFactor: 1,    timeFactor: 1 },
    painted:    { extraMinutes: 40, extraCost: 1.5, materialFactor: 1,    timeFactor: 1 },
    multicolor: { extraMinutes: 5,  extraCost: 0,   materialFactor: 1.25, timeFactor: 1.35 },
  },

  // Parámetros para estimar peso y tiempo desde la geometría (STL/OBJ/3MF sin laminar)
  estimation: {
    shellMm: 0.9,            // paredes + techos/pisos equivalentes
    infill: 0.15,            // relleno por defecto de Bambu Studio
    supportDensity: 0.2,     // soportes tipo árbol
    supportAngleDeg: 45,
    layerOverheadSec: 1.5,
    warmupHours: 0.1,        // calentado, nivelado, calibración
    timeComplexityFactor: [1, 1.05, 1.1, 1.18, 1.28],
    massCalibration: 1,      // ajustar comparando contra Bambu Studio
    timeCalibration: 1,
  },

  // SHA-256 del PIN de administración. Por defecto: "1234". ¡Cámbialo!
  adminPinHash: '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
};

const STORAGE_KEY = 'cc3d.config';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Mezcla profunda: los valores de `override` reemplazan a los de `base`.
export function mergeConfig(base, override) {
  if (!isObject(override)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObject(v) && isObject(out[k]) ? mergeConfig(out[k], v) : structuredClone(v);
  }
  return out;
}

// Orden de carga: valores por defecto → config.json del repo (equipo) → cambios locales del admin.
export async function loadConfig() {
  let cfg = structuredClone(DEFAULT_CONFIG);
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (res.ok) cfg = mergeConfig(cfg, await res.json());
  } catch { /* sin config.json: usar valores por defecto */ }
  try {
    const local = localStorage.getItem(STORAGE_KEY);
    if (local) cfg = mergeConfig(cfg, JSON.parse(local));
  } catch { /* almacenamiento no disponible */ }
  return cfg;
}

export function saveLocalConfig(cfg) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); return true; } catch { return false; }
}

export function clearLocalConfig() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nada */ }
}
