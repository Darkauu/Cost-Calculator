import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, machineRatePerHour, roundUp, quantityDiscount, marginStatus, selectPrinter } from '../js/pricing.js';
import { DEFAULT_CONFIG, mergeConfig } from '../js/config.js';

const cfg = DEFAULT_CONFIG;
const base = { grams: 50, hours: 2, complexity: 2, material: 'PLA', quality: 'standard', finish: 'none', urgent: false, quantity: 1, exact: true };
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('costo de máquina por hora: amortización + electricidad + mantenimiento', () => {
  close(machineRatePerHour(cfg), 799 / 6000 + 0.15 * 0.25 + 0.08);
});

test('redondeo comercial hacia arriba', () => {
  assert.equal(roundUp(12.01, 0.5), 12.5);
  assert.equal(roundUp(12.5, 0.5), 12.5);
  assert.equal(roundUp(7.2, 1), 8);
});

test('desglose de costos de una pieza de 50 g / 2 h', () => {
  const q = computeQuote(base, cfg);
  close(q.breakdown.material, 50 * 0.02 * 1.05);
  close(q.breakdown.machine, 2 * machineRatePerHour(cfg));
  close(q.breakdown.labor, (10 + 4) / 60 * 6);
  close(q.breakdown.risk, (q.breakdown.material + q.breakdown.machine) * 0.05);
  close(q.breakdown.overhead, 2 * 40 / 120);
  close(q.cost, q.breakdown.material + q.breakdown.machine + q.breakdown.overhead + q.breakdown.labor + q.breakdown.risk);
});

test('el precio recomendado cumple el margen objetivo y los tres niveles están ordenados', () => {
  const q = computeQuote(base, cfg);
  const { minimum, recommended, premium } = q.tiers;
  assert.ok(minimum.price <= recommended.price && recommended.price < premium.price);
  assert.ok(recommended.margin >= cfg.marginByComplexity[1] - 1e-9);
  assert.ok(minimum.margin >= cfg.minMargin - 1e-9);
  assert.equal(recommended.status, 'good');
  assert.equal(recommended.price % 0.5, 0);
});

test('la meta mensual fija la ganancia en impresiones largas', () => {
  // 20 h de máquina: 20 × (300/120) = 50 USD de ganancia mínima
  const q = computeQuote({ ...base, grams: 200, hours: 20 }, cfg);
  assert.equal(q.profitDriver, 'goal');
  assert.ok(q.tiers.recommended.profit >= 50 - 1e-9);
});

test('pedido mínimo para piezas pequeñas', () => {
  const q = computeQuote({ ...base, grams: 2, hours: 0.1, complexity: 1 }, cfg);
  assert.equal(q.tiers.recommended.price, cfg.minOrderPrice);
  assert.equal(q.tiers.minimum.price, cfg.minOrderPrice);
});

test('descuento por cantidad sin bajar del margen mínimo', () => {
  assert.equal(quantityDiscount(9, cfg.quantityDiscounts), 0);
  assert.equal(quantityDiscount(25, cfg.quantityDiscounts), 0.10);
  const one = computeQuote(base, cfg);
  const many = computeQuote({ ...base, quantity: 50 }, cfg);
  assert.equal(many.discountPct, 0.15);
  assert.ok(many.tiers.recommended.unit < one.tiers.recommended.unit, 'precio unitario menor');
  assert.ok(many.tiers.recommended.margin >= cfg.minMargin);
});

test('urgencia sube el precio', () => {
  const n = computeQuote(base, cfg);
  const u = computeQuote({ ...base, urgent: true }, cfg);
  assert.ok(u.tiers.recommended.price >= (n.tiers.recommended.price - cfg.roundingStep) * cfg.urgencyMultiplier);
});

test('multicolor: agrega purga y tiempo solo cuando el dato es estimado', () => {
  const est = computeQuote({ ...base, exact: false, finish: 'multicolor' }, cfg);
  close(est.grams.unit, 50 * 1.25);
  close(est.hours.unit, 2 * 1.35);
  const exact = computeQuote({ ...base, exact: true, finish: 'multicolor' }, cfg);
  close(exact.grams.unit, 50);
});

test('más complejidad → más margen y más riesgo', () => {
  const a = computeQuote({ ...base, complexity: 1 }, cfg);
  const b = computeQuote({ ...base, complexity: 5 }, cfg);
  assert.ok(b.tiers.recommended.price > a.tiers.recommended.price);
  assert.ok(b.targetMargin > a.targetMargin);
});

test('alerta de precio fuera de mercado', () => {
  const pricey = mergeConfig(cfg, { marketMaxPerGram: 0.05 });
  const q = computeQuote({ ...base, grams: 100 }, pricey);
  assert.equal(q.warnings[0]?.code, 'aboveMarket');
});

test('precio negociado: semáforo', () => {
  const q = computeQuote(base, cfg);
  assert.equal(q.evaluate(q.tiers.recommended.price).status, 'good');
  assert.equal(q.evaluate(q.cost * 1.05).status, 'bad');
  assert.equal(marginStatus(0.4, 0.6, 0.35), 'warn');
});

test('material desconocido lanza error', () => {
  assert.throws(() => computeQuote({ ...base, material: 'XYZ' }, cfg));
});

test('packaging por unidad y por pedido entra al costo', () => {
  const a = computeQuote({ ...base, quantity: 10 }, cfg);
  const b = computeQuote({ ...base, quantity: 10, packaging: 'basic' }, cfg);
  close(b.breakdown.packaging, 0.18 * 10 + 0.10);
  close(b.cost - a.cost, b.breakdown.packaging);
  assert.ok(b.tiers.minimum.margin >= cfg.minMargin - 1e-9);
});

test('insumos extra por unidad', () => {
  const q = computeQuote({ ...base, quantity: 4, suppliesPerUnit: 0.12 }, cfg);
  close(q.breakdown.supplies, 0.48);
});

test('entrega incluida: se suma al precio y no se come el margen', () => {
  const a = computeQuote(base, cfg);
  const b = computeQuote({ ...base, shipping: 'city', shippingMode: 'included' }, cfg);
  assert.ok(b.tiers.recommended.price >= a.tiers.recommended.price + 4 - 1e-9);
  assert.ok(b.tiers.minimum.margin >= cfg.minMargin - 1e-9);
  assert.ok(b.tiers.recommended.profit >= a.tiers.recommended.profit - 1e-9);
  assert.equal(b.tiers.recommended.clientTotal, b.tiers.recommended.price);
});

test('entrega aparte: no cambia el precio, sí el total del cliente', () => {
  const a = computeQuote(base, cfg);
  const b = computeQuote({ ...base, shipping: 'outer', shippingMode: 'separate' }, cfg);
  assert.equal(b.tiers.recommended.price, a.tiers.recommended.price);
  close(b.tiers.recommended.clientTotal, a.tiers.recommended.price + 7);
});

test('comisión de pago: el precio sube para conservar el margen', () => {
  const a = computeQuote(base, cfg);
  const b = computeQuote({ ...base, payment: 'card' }, cfg);
  assert.ok(b.tiers.recommended.price > a.tiers.recommended.price);
  close(b.tiers.recommended.fee, b.tiers.recommended.price * 0.045);
  assert.ok(b.tiers.minimum.margin >= cfg.minMargin - 1e-9, 'el mínimo sigue respetando el margen mínimo');
  assert.ok(b.tiers.recommended.profit >= a.tiers.recommended.profit - 1e-9);
});

test('ITBMS se suma aparte y no cuenta como ganancia', () => {
  const a = computeQuote(base, cfg);
  const b = computeQuote({ ...base, itbms: true }, cfg);
  const r = b.tiers.recommended;
  assert.equal(r.price, a.tiers.recommended.price);
  close(r.tax, r.price * 0.07);
  close(r.clientTotal, r.price * 1.07);
  close(r.profit, a.tiers.recommended.profit);
});

test('margen mínimo con todo activado (packaging, entrega, tarjeta, ITBMS)', () => {
  const q = computeQuote({ ...base, quantity: 12, packaging: 'gift', shipping: 'interior', shippingMode: 'included', payment: 'card', itbms: true, suppliesPerUnit: 0.2 }, cfg);
  assert.ok(q.tiers.minimum.margin >= cfg.minMargin - 1e-9);
  assert.ok(q.tiers.recommended.margin >= q.targetMargin - 0.02);
  assert.equal(q.evaluate(q.tiers.minimum.price - 2).status, 'bad');
});

test('H2C usa su propio costo por hora', () => {
  const p2s = computeQuote(base, cfg);
  const h2c = computeQuote({ ...base, printer: 'printer2' }, cfg);
  close(h2c.breakdown.machineRate, machineRatePerHour(cfg, cfg.printer2));
  assert.ok(h2c.breakdown.machine > p2s.breakdown.machine);
  const off = mergeConfig(cfg, { printer2: { enabled: false } });
  assert.equal(selectPrinter(off, 'printer2'), off.printer);
});
