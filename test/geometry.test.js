import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMesh, estimatePrint, fitsBed, scoreComplexity } from '../js/geometry.js';
import { DEFAULT_CONFIG } from '../js/config.js';
import { box, concat } from './helpers.js';

const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

test('cubo de 20 mm: volumen, área, tamaño y sin soportes', () => {
  const a = analyzeMesh(box(20, 20, 20).positions);
  close(a.volumeMm3, 8000);
  close(a.areaMm2, 2400);
  assert.deepEqual(a.sizeMm.map((v) => Math.round(v)), [20, 20, 20]);
  assert.equal(a.overhangAreaMm2, 0, 'la cara inferior apoya en la cama');
  assert.equal(a.complexity.level, 1);
  assert.equal(a.inverted, false);
});

test('malla invertida: el volumen sigue siendo positivo', () => {
  const p = box(10, 10, 10).positions;
  const inv = new Float32Array(p.length);
  for (let t = 0; t < p.length; t += 9) { inv.set(p.subarray(t, t + 3), t); inv.set(p.subarray(t + 6, t + 9), t + 3); inv.set(p.subarray(t + 3, t + 6), t + 6); }
  const a = analyzeMesh(inv);
  close(a.volumeMm3, 1000);
  assert.equal(a.inverted, true);
});

test('pieza en T (voladizo) detecta área y volumen de soporte', () => {
  const stem = box(10, 10, 30, 20, 20, 0).positions;
  const top = box(50, 50, 5, 0, 0, 30).positions; // vuela sobre la cama
  const a = analyzeMesh(concat(stem, top));
  assert.ok(a.overhangAreaMm2 > 2000, `área de voladizo ${a.overhangAreaMm2}`);
  close(a.supportVolumeMm3, 2500 * 30, 0.01);
  assert.ok(a.complexity.level >= 2);
});

test('la complejidad sube con detalle, voladizos y esbeltez', () => {
  const simple = scoreComplexity({ volume: 8000, area: 2400, overhangArea: 0, size: [20, 20, 20] });
  const hard = scoreComplexity({ volume: 1000, area: 6000, overhangArea: 1500, size: [10, 10, 60] });
  assert.equal(simple.level, 1);
  assert.equal(hard.level, 5);
});

test('estimación de peso y tiempo para un cubo de 20 mm en PLA', () => {
  const a = analyzeMesh(box(20, 20, 20).positions);
  const e = estimatePrint(a, {
    material: DEFAULT_CONFIG.materials.PLA,
    quality: DEFAULT_CONFIG.qualities.standard,
    estimation: DEFAULT_CONFIG.estimation,
  });
  // cáscara 2400×0.9 = 2160 mm³ + relleno (8000−2160)×0.15 = 876 → 3.036 cm³ × 1.24 ≈ 3.76 g
  close(e.grams, 3.765, 0.01);
  assert.ok(e.hours > 0.1 && e.hours < 0.5, `horas ${e.hours}`);
  assert.equal(e.layers, 100);
});

test('cabe en la cama permitiendo rotar la pieza', () => {
  assert.equal(fitsBed([300, 10, 10], [256, 256, 256]), false);
  assert.equal(fitsBed([250, 200, 100], [256, 256, 256]), true);
});
