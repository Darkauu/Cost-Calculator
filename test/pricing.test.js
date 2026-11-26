import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, machineRatePerHour, roundUp, quantityDiscount, marginStatus, selectPrinter, hmsToHours, computeOrder } from '../js/pricing.js';
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

test('packaging e insumos: "gastos adicionales de empaquetado", al costo', () => {
  const a = computeQuote({ ...base, quantity: 10 }, cfg);
  const b = computeQuote({ ...base, quantity: 10, packaging: 'basic', supplies: { ring: 1 } }, cfg);
  close(b.breakdown.packaging, 0.18 * 10 + 0.10);
  close(b.extras.packaging, 0.18 * 10 + 0.10 + 0.12 * 10);
  close(b.cost, a.cost, 1e-9);                       // no es costo de producción
  close(b.tiers.recommended.profit, a.tiers.recommended.profit, 0.5);
  assert.ok(b.tiers.minimum.margin >= cfg.minMargin - 1e-9);
  const l = b.lines(b.tiers.recommended.price);
  close(l.packaging, b.extras.packaging);
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

test('envío: línea aparte "gastos adicionales de envío" al costo', () => {
  const b = computeQuote({ ...base, shipping: 'outer' }, cfg);
  const l = b.lines(b.tiers.recommended.price);
  close(l.shipping, 7);
  close(l.items[0].total + l.packaging + l.shipping + l.fee, b.tiers.recommended.price);
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

test('insumos del catálogo por unidad', () => {
  const q = computeQuote({ ...base, quantity: 10, supplies: { ring: 1, magnet: 2 }, suppliesPerUnit: 0.1 }, cfg);
  close(q.breakdown.supplies, (0.12 + 0.30 + 0.1) * 10);
});

test('el desglose de un precio suma exactamente ese precio (+ ITBMS)', () => {
  const q = computeQuote({ ...base, quantity: 6, packaging: 'gift', shipping: 'city', payment: 'card', itbms: true, supplies: { ring: 1 } }, cfg);
  for (const key of ['minimum', 'recommended', 'premium']) {
    const tr = q.tiers[key];
    const sum = q.split(tr.price).reduce((a, [, v]) => a + v, 0);
    close(sum, tr.price + tr.tax);
  }
});

test('listas del admin: reemplazan a las de fábrica y aceptan el formato anterior', () => {
  const c = mergeConfig(cfg, { supplies: { cord: { name: 'Cordón', cost: 0.3 } }, shipping: { pickup: 0, city: 5 }, paymentFees: { card: 0.05 } });
  assert.deepEqual(Object.keys(c.supplies), ['cord']);
  assert.deepEqual(c.shipping.city, { name: 'Delivery Ciudad de Panamá', cost: 5 });
  assert.equal(c.paymentFees.card.pct, 0.05);
  const q = computeQuote({ ...base, shipping: 'city', payment: 'card' }, c);
  close(q.shipping.amount, 5);
  close(q.feePct, 0.05);
});

test('tiempo en casillas h / m / s', () => {
  close(hmsToHours(2, 35, 0), 2 + 35 / 60);
  close(hmsToHours('0', '0', '90'), 90 / 3600);
  close(hmsToHours('', '45', ''), 0.75);
  close(hmsToHours(-1, 'x', 30), 30 / 3600);
});

const orderOpts = { packaging: 'basic', shipping: 'city', shippingMode: 'included', payment: 'card', itbms: true };

test('pedido con varios modelos: cada uno con sus parámetros', () => {
  const jobs = [
    { ...base, quantity: 20, grams: 8, hours: 0.4, complexity: 1 },
    { ...base, quantity: 2, grams: 120, hours: 5, complexity: 3, material: 'PETG', finish: 'painted', supplies: { magnet: 4 } },
  ];
  const o = computeOrder(jobs, orderOpts, cfg);
  assert.equal(o.items.length, 2);
  assert.equal(o.quantity, 22);
  assert.equal(o.items[1].breakdown.supplies > 0, true);
  // el costo por pedido del packaging se cuenta una sola vez
  close(o.breakdown.packaging, 0.18 * 22 + 0.10);
  close(o.cost, o.items[0].cost + o.items[1].cost);
  close(o.extras.packaging, 0.18 * 22 + 0.10 + 0.15 * 4 * 2);
  const { minimum, recommended, premium } = o.tiers;
  assert.ok(minimum.price <= recommended.price && recommended.price <= premium.price);
  assert.ok(minimum.margin >= cfg.minMargin - 1e-9, 'el mínimo respeta el margen mínimo');
  assert.ok(recommended.price >= o.items[0].tiers.recommended.price + o.items[1].tiers.recommended.price - 1);
  // las líneas del cliente suman el precio, y cada modelo mantiene su precio por pieza
  const l = o.lines(recommended.price);
  close(l.items.reduce((a, x) => a + x.total, 0) + l.packaging + l.shipping + l.fee, recommended.price);
  for (const key of ['minimum', 'recommended', 'premium']) {
    const tr = o.tiers[key];
    close(o.split(tr.price).reduce((a, [, v]) => a + v, 0), tr.price + tr.tax);
  }
});

test('pedido de un solo modelo = cotización simple', () => {
  const single = computeQuote({ ...base, quantity: 5, ...orderOpts }, cfg);
  const order = computeOrder([{ ...base, quantity: 5 }], orderOpts, cfg);
  for (const k of ['minimum', 'recommended', 'premium']) assert.equal(order.tiers[k].price, single.tiers[k].price);
  assert.equal(order.items.length, 1);
  assert.ok(order.tiers.minimum.margin >= cfg.minMargin - 1e-9);
});

test('pedido mínimo se aplica al pedido, no a cada modelo', () => {
  const tiny = { ...base, grams: 2, hours: 0.1, complexity: 1 };
  const one = computeOrder([tiny], { packaging: 'none', shipping: 'pickup', payment: 'cash' }, cfg);
  assert.equal(one.tiers.recommended.price, cfg.minOrderPrice);
  const two = computeOrder([tiny, tiny], { packaging: 'none', shipping: 'pickup', payment: 'cash' }, cfg);
  assert.ok(two.tiers.recommended.price < 2 * cfg.minOrderPrice, 'no se cobra el mínimo dos veces');
});

test('pedido vacío lanza error', () => {
  assert.throws(() => computeOrder([], orderOpts, cfg));
});

test('preparación: se cobra una vez, no por pieza (5 min + 7 min × cantidad)', () => {
  const job = { ...base, grams: 4, hours: 7 / 60, prepHours: 5 / 60 };
  const q1 = computeQuote({ ...job, quantity: 1 }, cfg);
  const q9 = computeQuote({ ...job, quantity: 9 }, cfg);
  close(q9.hours.total, 5 / 60 + 9 * 7 / 60);
  close(q9.breakdown.machine, (5 / 60 + 9 * 7 / 60) * machineRatePerHour(cfg));
  close(q9.prepCost, q1.prepCost);
});

test('el precio por pieza (y por gramo) no cambia con la cantidad, salvo el descuento', () => {
  const big = mergeConfig(cfg, { minOrderPrice: 0, roundingStep: 0.01 });
  const job = { ...base, grams: 20, hours: 0.8, prepHours: 0.1 };
  const unit = (n) => { const q = computeQuote({ ...job, quantity: n }, big); return q.lines(q.tiers.recommended.price).items[0].unit; };
  close(unit(3), unit(7), 0.02);                      // mismo precio por pieza sin descuento
  close(unit(10), unit(7) * (1 - 0.05), 0.02);        // 10+ → 5 %
  close(unit(50), unit(7) * (1 - 0.15), 0.02);        // 50+ → 15 %
});

test('alerta de mercado: solo el precio de las piezas, sin insumos ni preparación', () => {
  const job = { ...base, grams: 3, hours: 0.15, prepHours: 0.1, quantity: 20, complexity: 1 };
  const plain = computeQuote(job, cfg);
  const withNfc = computeQuote({ ...job, suppliesPerUnit: 1.5, packaging: 'gift' }, cfg);
  assert.equal(withNfc.warnings.length, plain.warnings.length);
});
