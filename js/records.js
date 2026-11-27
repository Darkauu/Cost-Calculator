// Registros del historial: qué se guarda de cada cotización y cómo se resume un mes.
// Sin dependencias de Firebase ni del DOM, para poder probarlo con node --test.

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const dayKey = (d = new Date()) => `${monthKey(d)}-${pad(d.getDate())}`;

/**
 * Arma el registro de una cotización.
 * @param {object} p
 *   number   número de cotización (AAAAMMDDxxxx)
 *   doc      lo que ve el cliente (clientDoc en app.js): items, prep, packaging, shipping, subtotal, taxRate, groups, urgent
 *   quote    cotización del vendedor (con el método de pago elegido): tiers, cost, extras, feePct, targetMargin, breakdown
 *   user     { email, name }
 *   client   { name, contact }
 *   negotiated  precio negociado (opcional)
 * @returns {{ pub: object, priv: object }}  pub: lo ve todo el equipo · priv: costos, solo admin
 */
export function quoteRecord({ number, doc, quote, user, client = {}, negotiated = null, now = new Date() }) {
  const tiers = quote.tiers;
  const pub = {
    number,
    month: monthKey(now),
    day: dayKey(now),
    createdBy: { email: user.email, name: user.name || user.email },
    client: { name: String(client.name || '').trim(), contact: String(client.contact || '').trim() },
    items: doc.items.map((l) => ({
      name: l.name, material: l.job.material, finish: l.job.finish,
      quantity: l.qty, unit: r2(l.unit), pieces: r2(l.pieces), discount: l.discount || 0,
    })),
    prep: r2(doc.prep),
    packaging: r2(doc.packaging),
    shipping: r2(doc.shipping),
    subtotal: r2(doc.subtotal),
    taxRate: doc.taxRate || 0,
    payments: doc.groups.map((g) => ({ methods: g.names, price: r2(g.tier.price), total: r2(g.tier.clientTotal) })),
    prices: {
      minimum: r2(tiers.minimum.price), recommended: r2(tiers.recommended.price), premium: r2(tiers.premium.price),
      negotiated: negotiated > 0 ? r2(negotiated) : null,
    },
    marginRecommended: Math.round(tiers.recommended.margin * 1000) / 1000,
    urgent: !!doc.urgent,
    status: 'quoted',
    finalPrice: null,
    poDate: null,
    notes: '',
  };
  const b = quote.breakdown || {};
  const priv = {
    cost: r2(quote.cost),
    extras: r2((quote.extras?.packaging || 0) + (quote.extras?.shipping || 0)),
    feePct: quote.feePct || 0,
    targetMargin: quote.targetMargin,
    profitRecommended: r2(tiers.recommended.profit),
    breakdown: Object.fromEntries(['material', 'machine', 'overhead', 'labor', 'extras', 'risk', 'supplies', 'packaging']
      .map((k) => [k, r2(b[k])])),
  };
  return { pub, priv };
}

// Ganancia real de una PO a partir del precio final pagado y de los costos guardados.
export function profitAt(price, priv) {
  if (!priv) return null;
  return r2(price * (1 - (priv.feePct || 0)) - (priv.extras || 0) - (priv.cost || 0));
}

/**
 * Resumen de un conjunto de cotizaciones (normalmente, las de un mes).
 * @param {object[]} records   registros pub (con status, finalPrice, prices)
 * @param {object}   privs     { [number]: priv } — opcional, solo admin; si falta, no hay ganancia
 */
export function summarize(records, privs = null) {
  const po = records.filter((r) => r.status === 'po');
  const lost = records.filter((r) => r.status === 'lost');
  const decided = po.length + lost.length;
  const sales = po.reduce((a, r) => a + (r.finalPrice ?? r.prices.recommended), 0);
  const quoted = po.reduce((a, r) => a + r.prices.recommended, 0);
  let profit = null;
  if (privs) {
    profit = po.reduce((a, r) => a + (profitAt(r.finalPrice ?? r.prices.recommended, privs[r.number]) ?? 0), 0);
  }
  return {
    count: records.length,
    po: po.length,
    lost: lost.length,
    open: records.length - decided,
    // Conversión sobre las que ya tienen respuesta (las abiertas todavía pueden convertirse).
    conversion: decided ? po.length / decided : null,
    sales: r2(sales),
    quotedValue: r2(records.reduce((a, r) => a + r.prices.recommended, 0)),
    // Cuánto se cedió en negociación: precio final contra el recomendado de esas mismas PO.
    discountVsRecommended: quoted ? 1 - sales / quoted : null,
    profit: profit == null ? null : r2(profit),
  };
}
