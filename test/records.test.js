import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteRecord, summarize, profitAt, monthKey } from '../js/records.js';
import { computeOrder } from '../js/pricing.js';
import { DEFAULT_CONFIG as cfg } from '../js/config.js';

const job = { grams: 20, hours: 1, prepHours: 0.1, complexity: 2, material: 'PLA', finish: 'none', quantity: 5, exact: true };
const order = { packaging: 'basic', shipping: 'city', payment: 'cash', itbms: true };

function sample(number = '202611271234') {
  const quote = computeOrder([job], order, cfg);
  const L = quote.lines(quote.tiers.recommended.price);
  const doc = {
    items: [{ name: 'Llavero', job, qty: 5, unit: L.items[0].unit, pieces: L.items[0].pieces, discount: 0 }],
    prep: L.items[0].prep, packaging: L.packaging, shipping: L.shipping, subtotal: L.product + L.packaging + L.shipping,
    taxRate: 0.07, urgent: false, groups: [{ names: ['Efectivo', 'Yappy'], tier: quote.tiers.recommended }],
  };
  return { quote, ...quoteRecord({ number, doc, quote, user: { email: 'a@b.com', name: 'Ana' }, client: { name: ' Cliente X ' }, negotiated: 0, now: new Date(2026, 10, 27) }) };
}

test('registro de cotización: datos públicos y costos aparte', () => {
  const { pub, priv, quote } = sample();
  assert.equal(pub.month, '2026-11');
  assert.equal(pub.day, '2026-11-27');
  assert.equal(pub.client.name, 'Cliente X');
  assert.equal(pub.status, 'quoted');
  assert.equal(pub.prices.negotiated, null);
  assert.equal(pub.items[0].quantity, 5);
  assert.equal(pub.payments[0].methods.join('/'), 'Efectivo/Yappy');
  assert.equal('cost' in pub, false, 'el costo no va en el registro público');
  assert.ok(Math.abs(priv.cost - quote.cost) < 0.01);
  // la ganancia al precio recomendado coincide con la de la cotización
  assert.ok(Math.abs(profitAt(pub.prices.recommended, priv) - quote.tiers.recommended.profit) < 0.02);
});

test('resumen del mes: conversión, ventas con precio final y ganancia real', () => {
  const a = sample('1').pub, b = sample('2').pub, c = sample('3').pub;
  const privs = { 1: sample('1').priv, 2: sample('2').priv, 3: sample('3').priv };
  a.status = 'po'; a.finalPrice = a.prices.recommended - 2;
  b.status = 'lost';
  const s = summarize([a, b, c], privs);
  assert.equal(s.count, 3);
  assert.equal(s.po, 1);
  assert.equal(s.open, 1);
  assert.equal(s.conversion, 0.5);
  assert.equal(s.sales, a.finalPrice);
  assert.ok(s.discountVsRecommended > 0);
  assert.ok(Math.abs(s.profit - profitAt(a.finalPrice, privs[1])) < 0.01);
  assert.equal(summarize([a, b, c]).profit, null, 'sin costos (ventas) no hay ganancia');
});

test('clave de mes', () => {
  assert.equal(monthKey(new Date(2026, 0, 5)), '2026-01');
});
