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
 *   grams, hours      — por unidad
 *   exact             — true si vienen de un archivo laminado (Bambu Studio)
 *   complexity        — 1..5
 *   material, quality, finish, urgent, quantity
 *   printer           — 'printer' | 'printer2'
 *   packaging         — clave de cfg.packaging (none, basic, gift)
 *   shipping          — clave de cfg.shipping; shippingMode: 'included' | 'separate'
 *   payment           — clave de cfg.paymentFees
 *   itbms             — true para sumar ITBMS al cobro
 *   suppliesPerUnit   — insumos extra por unidad (argollas, imanes…), USD
 * @param {object} cfg  configuración (ver config.js)
 *
 * Los tres precios (mínimo, recomendado, premium) son SIN ITBMS. Ya incluyen la entrega
 * cuando se cobra dentro del precio y la comisión del método de pago, de modo que el
 * margen que se muestra es lo que queda después de pagar ambas.
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
  const totalGrams = gramsUnit * qty;
  const totalHours = hoursUnit * qty;

  const hoursBase = Math.max(1, cfg.sellableHoursPerMonth);
  const materialCost = totalGrams * (material.costPerKg / 1000) * (1 + cfg.wasteFactor);
  const rate = machineRatePerHour(cfg, printer);
  const machineCost = totalHours * rate;
  const overheadRate = (cfg.fixedCostsMonthly || 0) / hoursBase;
  const overheadCost = totalHours * overheadRate;
  const laborMinutes = cfg.setupMinutes + (cfg.postMinutesByComplexity[idx] + finish.extraMinutes) * qty;
  const laborCost = (laborMinutes / 60) * cfg.laborPerHour;
  const extrasCost = finish.extraCost * qty;
  // Insumos: los del catálogo (cantidad por unidad) más un monto libre por unidad.
  let suppliesUnit = Math.max(0, job.suppliesPerUnit || 0);
  for (const [id, n] of Object.entries(job.supplies || {})) {
    const s = (cfg.supplies || {})[id];
    if (s && n > 0) suppliesUnit += s.cost * n;
  }
  const suppliesCost = suppliesUnit * qty;
  const pack = (cfg.packaging || {})[job.packaging] || { unit: 0, order: 0 };
  const packagingCost = pack.unit * qty + pack.order;
  const riskCost = (materialCost + machineCost) * cfg.failureRiskByComplexity[idx];
  // Costo de producir y empacar el pedido (sin entrega ni comisión).
  const cost = materialCost + machineCost + overheadCost + laborCost + extrasCost + suppliesCost + packagingCost + riskCost;

  const shipEntry = (cfg.shipping || {})[job.shipping];
  const shipAmount = Math.max(0, (typeof shipEntry === 'number' ? shipEntry : shipEntry?.cost) || 0);
  const shipIncluded = job.shippingMode === 'separate' ? 0 : shipAmount;
  const shipSeparate = job.shippingMode === 'separate' ? shipAmount : 0;
  const feeEntry = (cfg.paymentFees || {})[job.payment];
  const fee = Math.min(0.5, Math.max(0, (typeof feeEntry === 'number' ? feeEntry : feeEntry?.pct) || 0));

  // Ganancia: lo mayor entre el margen objetivo y lo que la meta mensual exige por hora de máquina.
  const targetMargin = cfg.marginByComplexity[idx];
  const profitByMargin = cost * targetMargin / (1 - targetMargin);
  const profitPerHour = cfg.monthlyProfitGoal / hoursBase;
  const profitByGoal = totalHours * profitPerHour;
  const profit = Math.max(profitByMargin, profitByGoal);

  const discountPct = quantityDiscount(qty, cfg.quantityDiscounts);
  const floorNet = cost / (1 - cfg.minMargin);
  const urgency = job.urgent ? cfg.urgencyMultiplier : 1;
  const step = cfg.roundingStep;
  // Neto (lo que queda para el producto) → precio de venta: suma la entrega incluida y
  // sube el precio para cubrir la comisión del cobro.
  const gross = (net) => (net + shipIncluded) / (1 - fee);

  const recNet = Math.max((cost + profit) * (1 - discountPct), floorNet, cfg.minOrderPrice) * urgency;
  const minNet = Math.max(floorNet, cfg.minOrderPrice) * urgency;
  const recommended = roundUp(gross(recNet), step);
  let minimum = roundUp(gross(minNet), step);
  if (minimum > recommended) minimum = recommended;
  const premium = roundUp(gross(recNet * cfg.premiumMultiplier), step);

  // Margen sobre lo que queda del producto: precio − comisión − entrega incluida.
  const netOf = (price) => price * (1 - fee) - shipIncluded;
  const marginOf = (price) => { const n = netOf(price); return n > 0 ? (n - cost) / n : -1; };
  const taxRate = job.itbms ? (cfg.itbmsRate || 0) : 0;
  const tier = (price) => {
    const tax = price * taxRate;
    return {
      price,
      unit: price / qty,
      margin: marginOf(price),
      profit: netOf(price) - cost,
      fee: price * fee,
      tax,
      clientTotal: price + tax + shipSeparate,
      status: marginStatus(marginOf(price), targetMargin, cfg.minMargin),
    };
  };

  const warnings = [];
  const productPrice = netOf(recommended);
  if (totalGrams >= cfg.marketCheckMinGrams && productPrice / totalGrams > cfg.marketMaxPerGram) {
    warnings.push({ code: 'aboveMarket', perGram: productPrice / totalGrams });
  }

  return {
    quantity: qty,
    complexity: level,
    printer: printer.name,
    grams: { unit: gramsUnit, total: totalGrams },
    hours: { unit: hoursUnit, total: totalHours },
    breakdown: {
      material: materialCost,
      machine: machineCost,
      overhead: overheadCost,
      labor: laborCost,
      extras: extrasCost,
      supplies: suppliesCost,
      packaging: packagingCost,
      risk: riskCost,
      machineRate: rate,
      overheadRate,
      laborMinutes,
    },
    cost,
    shipping: { amount: shipAmount, included: shipIncluded, separate: shipSeparate },
    feePct: fee,
    taxRate,
    targetMargin,
    profitDriver: profitByGoal > profitByMargin ? 'goal' : 'margin',
    discountPct,
    urgent: !!job.urgent,
    tiers: {
      minimum: tier(minimum),
      recommended: tier(recommended),
      premium: tier(premium),
    },
    goalShare: (netOf(recommended) - cost) / cfg.monthlyProfitGoal,
    warnings,
    evaluate(price) { return tier(price); },
    // Reparto de un precio en partes (para el desglose con barras). La suma de las partes es
    // el precio + ITBMS; si el precio no cubre el costo, la ganancia sale negativa.
    split(price) {
      const tr = tier(price);
      return [
        ['material', materialCost], ['machine', machineCost], ['overhead', overheadCost],
        ['risk', riskCost], ['labor', laborCost], ['supplies', extrasCost + suppliesCost],
        ['packaging', packagingCost], ['shipping', shipIncluded], ['fee', tr.fee],
        ['profit', tr.profit], ['tax', tr.tax],
      ];
    },
  };
}
