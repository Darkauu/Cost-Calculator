// Motor de precios. Funciones puras: sin DOM, fáciles de probar.

export function roundUp(value, step) {
  if (!step) return value;
  return Math.ceil(value / step - 1e-9) * step;
}

export function machineRatePerHour(cfg, printer = cfg.printer) {
  const p = printer;
  return p.priceUsd / p.lifeHours + p.powerKw * cfg.electricityPerKwh + p.maintenancePerHour;
}

// Impresora elegida: 'printer2' (H2C) si está activa; si no, la principal.
export function selectPrinter(cfg, id) {
  if (id === 'printer2' && cfg.printer2?.enabled) return cfg.printer2;
  return cfg.printer;
}

// Tiempo en tres casillas (h, m, s), como lo muestra Bambu Studio → horas decimales.
// Vacíos o negativos cuentan como 0; minutos y segundos pueden pasar de 59.
export function hmsToHours(h, m, s) {
  const v = (x) => Math.max(0, parseFloat(x) || 0);
  return v(h) + v(m) / 60 + v(s) / 3600;
}

export function quantityDiscount(qty, tiers = []) {
  let pct = 0;
  for (const t of tiers) if (qty >= t.minQty && t.pct > pct) pct = t.pct;
  return pct;
}

export function marginStatus(margin, target, minMargin) {
  if (margin >= target - 0.05) return 'good';
  if (margin >= minMargin) return 'warn';
  return 'bad';
}

/**
 * @param {object} job
 *   grams, hours      — por pieza (las horas son SOLO de impresión, sin la preparación)
 *   prepHours         — preparación de la impresora (calentado, nivelado, calibración):
 *                       se cobra UNA vez por modelo, no por pieza → 5 min + 7 min × cantidad
 *   exact             — true si vienen de un archivo laminado (Bambu Studio)
 *   complexity        — 1..5
 *   material, quality, finish, urgent, quantity
 *   printer           — 'printer' | 'printer2'
 *   packaging         — clave de cfg.packaging (none, basic, gift)
 *   supplies          — { id: cantidad por pieza } del catálogo de insumos; suppliesPerUnit: USD extra por pieza
 *   shipping          — clave de cfg.shipping
 *   payment           — clave de cfg.paymentFees
 *   itbms             — true para sumar ITBMS al cobro
 * @param {object} cfg  configuración (ver config.js)
 *
 * El precio se arma así (para cada nivel: mínimo, recomendado, premium):
 *   pieza        = (material + máquina + gastos fijos + postproceso + acabado + riesgo) + ganancia
 *                  → el precio por pieza (y por gramo) NO cambia con la cantidad; solo baja
 *                    con el descuento por cantidad
 *   preparación  = (preparación de la impresora + preparación del pedido) + ganancia, una vez
 *   producto     = preparación + pieza × cantidad × (1 − descuento)
 *                  (nunca por debajo del margen mínimo ni del pedido mínimo)
 *   empaquetado  = insumos + packaging, al costo ("Gastos adicionales de empaquetado")
 *   envío        = costo del envío, al costo ("Gastos adicionales de envío")
 *   precio       = (producto + empaquetado + envío) ÷ (1 − comisión del método de pago)
 * Los precios son SIN ITBMS. El margen se mide sobre el producto: lo que queda después de la
 * comisión y de los gastos adicionales.
 */
export function computeQuote(job, cfg) {
  const qty = Math.max(1, Math.floor(job.quantity || 1));
  const level = Math.min(5, Math.max(1, Math.round(job.complexity || 1)));
  const idx = level - 1;
  const material = cfg.materials[job.material];
  if (!material) throw new Error(`Material desconocido: ${job.material}`);
  const finish = cfg.finishes[job.finish] || cfg.finishes.none;
  const printer = selectPrinter(cfg, job.printer);

  // Los archivos laminados ya incluyen la purga multicolor real.
  const matFactor = job.exact ? 1 : finish.materialFactor;
  const timeFactor = job.exact ? 1 : finish.timeFactor;
  const gramsUnit = job.grams * matFactor;
  const hoursUnit = job.hours * timeFactor;
  const prepHours = Math.max(0, job.prepHours || 0);
  const totalGrams = gramsUnit * qty;
  const totalHours = prepHours + hoursUnit * qty;

  const hoursBase = Math.max(1, cfg.sellableHoursPerMonth);
  const rate = machineRatePerHour(cfg, printer);
  const overheadRate = (cfg.fixedCostsMonthly || 0) / hoursBase;
  const goalRate = cfg.monthlyProfitGoal / hoursBase;
  const targetMargin = cfg.marginByComplexity[idx];

  // Por pieza
  const u = {
    material: gramsUnit * (material.costPerKg / 1000) * (1 + cfg.wasteFactor),
    machine: hoursUnit * rate,
    overhead: hoursUnit * overheadRate,
    labor: ((cfg.postMinutesByComplexity[idx] + finish.extraMinutes) / 60) * cfg.laborPerHour,
    extras: finish.extraCost,
  };
  u.risk = (u.material + u.machine) * cfg.failureRiskByComplexity[idx];
  const unitCost = u.material + u.machine + u.overhead + u.labor + u.extras + u.risk;
  // Una vez por modelo: preparación de la impresora (tiempo de máquina) y del pedido (mano de obra)
  const p = { machine: prepHours * rate, overhead: prepHours * overheadRate, labor: (cfg.setupMinutes / 60) * cfg.laborPerHour };
  const prepCost = p.machine + p.overhead + p.labor;
  const cost = unitCost * qty + prepCost;

  // Ganancia: lo mayor entre el margen objetivo y lo que la meta mensual exige por hora de máquina.
  const withProfit = (c, h) => Math.max(c / (1 - targetMargin), c + h * goalRate);
  const unitRec = withProfit(unitCost, hoursUnit);
  const prepRec = withProfit(prepCost, prepHours);
  const discountPct = quantityDiscount(qty, cfg.quantityDiscounts);
  const piecesRec = unitRec * qty * (1 - discountPct);

  // Gastos adicionales (al costo): empaquetado (insumos + packaging) y envío
  let suppliesUnit = Math.max(0, job.suppliesPerUnit || 0);
  for (const [id, n] of Object.entries(job.supplies || {})) {
    const s = (cfg.supplies || {})[id];
    if (s && n > 0) suppliesUnit += s.cost * n;
  }
  const suppliesCost = suppliesUnit * qty;
  const pack = (cfg.packaging || {})[job.packaging] || { unit: 0, order: 0 };
  // En un pedido con varios modelos, el costo por pedido del packaging lo suma computeOrder una sola vez.
  const packagingCost = pack.unit * qty + (job.skipOrderCosts ? 0 : pack.order);
  const shipEntry = (cfg.shipping || {})[job.shipping];
  const shipAmount = Math.max(0, (typeof shipEntry === 'number' ? shipEntry : shipEntry?.cost) || 0);
  const extras = { packaging: suppliesCost + packagingCost, shipping: shipAmount };
  const feeEntry = (cfg.paymentFees || {})[job.payment];
  const fee = Math.min(0.5, Math.max(0, (typeof feeEntry === 'number' ? feeEntry : feeEntry?.pct) || 0));
  const taxRate = job.itbms ? (cfg.itbmsRate || 0) : 0;

  const urgency = job.urgent ? cfg.urgencyMultiplier : 1;
  const floorNet = cost / (1 - cfg.minMargin);
  const productNet = {
    recommended: Math.max(prepRec + piecesRec, floorNet, cfg.minOrderPrice) * urgency,
    minimum: Math.max(floorNet, cfg.minOrderPrice) * urgency,
  };
  productNet.premium = productNet.recommended * cfg.premiumMultiplier;

  // Reparto del producto entre preparación y piezas (proporcional a su precio recomendado)
  const part = { pieces: piecesRec * urgency, nominal: (prepRec + piecesRec) * urgency, quantity: qty };
  const quote = finishQuote({
    cfg, fee, taxRate, cost, extras, productNet, targetMargin, quantity: qty,
    parts: [part],
    costs: {
      material: u.material * qty, machine: u.machine * qty + p.machine, overhead: u.overhead * qty + p.overhead,
      risk: u.risk * qty, labor: u.labor * qty + p.labor, extras: u.extras * qty,
    },
  });

  // Alerta de mercado: solo el precio de las piezas por gramo (sin preparación ni gastos adicionales).
  const warnings = [];
  const piecesPerGram = quote.lines(quote.tiers.recommended.price).items[0].pieces / totalGrams;
  if (totalGrams >= cfg.marketCheckMinGrams && piecesPerGram > cfg.marketMaxPerGram) {
    warnings.push({ code: 'aboveMarket', perGram: piecesPerGram });
  }

  return {
    ...quote,
    complexity: level,
    printer: printer.name,
    grams: { unit: gramsUnit, total: totalGrams },
    hours: { unit: hoursUnit, prep: prepHours, total: totalHours },
    breakdown: {
      ...quote.breakdown,
      supplies: suppliesCost,
      packaging: packagingCost,
      machineRate: rate,
      overheadRate,
      laborMinutes: cfg.setupMinutes + (cfg.postMinutesByComplexity[idx] + finish.extraMinutes) * qty,
    },
    unitCost,
    prepCost,
    part,
    profitDriver: hoursUnit * goalRate > unitCost * targetMargin / (1 - targetMargin) ? 'goal' : 'margin',
    discountPct,
    urgent: !!job.urgent,
    warnings,
  };
}

// Parte común de una cotización simple y de un pedido: precios, margen, reparto en líneas
// para el cliente y desglose con barras.
function finishQuote({ cfg, fee, taxRate, cost, extras, productNet, targetMargin, quantity, parts, costs }) {
  const step = cfg.roundingStep;
  const extrasTotal = extras.packaging + extras.shipping;
  const gross = (net) => (net + extrasTotal) / (1 - fee);
  const recommended = roundUp(gross(productNet.recommended), step);
  const minimum = Math.min(recommended, roundUp(gross(productNet.minimum), step));
  const premium = Math.max(recommended, roundUp(gross(productNet.premium), step));

  const netOf = (price) => price * (1 - fee) - extrasTotal;
  const marginOf = (price) => { const n = netOf(price); return n > 0 ? (n - cost) / n : -1; };
  const tier = (price) => {
    const tax = price * taxRate;
    return {
      price, unit: price / quantity, margin: marginOf(price), profit: netOf(price) - cost,
      fee: price * fee, tax, clientTotal: price + tax,
      status: marginStatus(marginOf(price), targetMargin, cfg.minMargin),
    };
  };
  const nominal = parts.reduce((a, x) => a + x.nominal, 0) || 1;
  return {
    quantity,
    cost,
    extras,
    shipping: { amount: extras.shipping },
    feePct: fee,
    taxRate,
    targetMargin,
    productNet,
    breakdown: { ...costs },
    tiers: { minimum: tier(minimum), recommended: tier(recommended), premium: tier(premium) },
    goalShare: (netOf(recommended) - cost) / cfg.monthlyProfitGoal,
    evaluate(price) { return tier(price); },
    // Líneas de la cotización para el cliente: por modelo, preparación y piezas (con precio por
    // pieza); luego gastos adicionales de empaquetado y de envío, y la comisión del método de pago.
    // Las líneas suman exactamente el precio. El precio por pieza se mantiene fijo: lo que suben
    // el redondeo o el pedido mínimo va a la preparación; un precio menor baja todo en proporción.
    lines(price) {
      const product = netOf(price);
      const ratio = Math.min(1, Math.max(0, product) / nominal);
      const excess = product - nominal * ratio;
      const items = parts.map((x) => {
        const pieces = x.pieces * ratio;
        const total = x.nominal * ratio + excess * x.nominal / nominal;
        return { prep: total - pieces, pieces, unit: pieces / x.quantity, total, quantity: x.quantity };
      });
      return { items, product, packaging: extras.packaging, shipping: extras.shipping, fee: price * fee };
    },
    // Reparto de un precio en partes (para el desglose con barras). La suma de las partes es
    // el precio + ITBMS; si el precio no cubre el costo, la ganancia sale negativa.
    split(price) {
      const tr = tier(price);
      return [
        ['material', costs.material], ['machine', costs.machine], ['overhead', costs.overhead],
        ['risk', costs.risk], ['labor', costs.labor], ['supplies', costs.extras],
        ['packaging', extras.packaging], ['shipping', extras.shipping], ['fee', tr.fee],
        ['profit', tr.profit], ['tax', tr.tax],
      ];
    },
  };
}

/**
 * Cotización de un pedido con varios modelos. Cada modelo tiene sus propios parámetros
 * (material, cantidad, acabado, complejidad, impresora, preparación, insumos…); el envío, el
 * método de pago, el ITBMS, el packaging y la urgencia son del pedido completo.
 *
 * Cada modelo se cotiza sin envío, sin comisión y sin pedido mínimo; el packaging por pedido
 * se cobra una sola vez. Por nivel: producto = Σ producto de cada modelo (el mínimo nunca baja
 * del pedido mínimo); precio = (producto + empaquetado + envío) ÷ (1 − comisión).
 *
 * @param {object[]} jobs   un job por modelo (mismo formato que computeQuote)
 * @param {object}   order  packaging, shipping, payment, itbms, urgent
 */
export function computeOrder(jobs, order, cfg) {
  if (!jobs.length) throw new Error('El pedido no tiene modelos');
  // Un solo modelo: el precio es exactamente el de computeQuote.
  if (jobs.length === 1) {
    const q = computeQuote({ ...jobs[0], ...order }, cfg);
    return { ...q, items: [q], warnings: q.warnings.map((w) => ({ ...w, item: 0 })) };
  }
  const quotes = jobs.map((j) => computeQuote({
    ...j, packaging: order.packaging, urgent: !!order.urgent, skipOrderCosts: true,
    shipping: null, payment: null, itbms: false,
  }, { ...cfg, minOrderPrice: 0 }));

  const sum = (f) => quotes.reduce((a, q) => a + f(q), 0);
  const pack = (cfg.packaging || {})[order.packaging] || { unit: 0, order: 0 };
  const shipEntry = (cfg.shipping || {})[order.shipping];
  const shipAmount = Math.max(0, (typeof shipEntry === 'number' ? shipEntry : shipEntry?.cost) || 0);
  const feeEntry = (cfg.paymentFees || {})[order.payment];
  const fee = Math.min(0.5, Math.max(0, (typeof feeEntry === 'number' ? feeEntry : feeEntry?.pct) || 0));
  const urgency = order.urgent ? cfg.urgencyMultiplier : 1;
  const minOrderNet = cfg.minOrderPrice * urgency;
  const productNet = {};
  for (const k of ['minimum', 'recommended', 'premium']) productNet[k] = Math.max(sum((q) => q.productNet[k]), minOrderNet);

  const cost = sum((q) => q.cost);
  const bsum = (k) => sum((q) => q.breakdown[k]);
  const quote = finishQuote({
    cfg, fee, taxRate: order.itbms ? (cfg.itbmsRate || 0) : 0, cost,
    extras: { packaging: sum((q) => q.extras.packaging) + pack.order, shipping: shipAmount },
    productNet,
    targetMargin: cost > 0 ? sum((q) => q.cost * q.targetMargin) / cost : quotes[0].targetMargin,
    quantity: sum((q) => q.quantity),
    parts: quotes.map((q) => q.part),
    costs: {
      material: bsum('material'), machine: bsum('machine'), overhead: bsum('overhead'),
      risk: bsum('risk'), labor: bsum('labor'), extras: bsum('extras'),
    },
  });
  return {
    ...quote,
    items: quotes,
    grams: { total: sum((q) => q.grams.total) },
    hours: { total: sum((q) => q.hours.total), prep: sum((q) => q.hours.prep) },
    breakdown: { ...quote.breakdown, supplies: bsum('supplies'), packaging: bsum('packaging') + pack.order, laborMinutes: bsum('laborMinutes') },
    urgent: !!order.urgent,
    warnings: quotes.flatMap((q, i) => q.warnings.map((w) => ({ ...w, item: i }))),
  };
}
