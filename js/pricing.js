// Motor de precios. Funciones puras: sin DOM, fáciles de probar.

export function roundUp(value, step) {
  if (!step) return value;
  return Math.ceil(value / step - 1e-9) * step;
}

export function machineRatePerHour(cfg) {
  const p = cfg.printer;
  return p.priceUsd / p.lifeHours + p.powerKw * cfg.electricityPerKwh + p.maintenancePerHour;
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
 * @param {object} cfg  configuración (ver config.js)
 */
export function computeQuote(job, cfg) {
  const qty = Math.max(1, Math.floor(job.quantity || 1));
  const level = Math.min(5, Math.max(1, Math.round(job.complexity || 1)));
  const idx = level - 1;
  const material = cfg.materials[job.material];
  if (!material) throw new Error(`Material desconocido: ${job.material}`);
  const finish = cfg.finishes[job.finish] || cfg.finishes.none;

  // Los archivos laminados ya incluyen la purga multicolor real.
  const matFactor = job.exact ? 1 : finish.materialFactor;
  const timeFactor = job.exact ? 1 : finish.timeFactor;
  const gramsUnit = job.grams * matFactor;
  const hoursUnit = job.hours * timeFactor;
  const totalGrams = gramsUnit * qty;
  const totalHours = hoursUnit * qty;

  const materialCost = totalGrams * (material.costPerKg / 1000) * (1 + cfg.wasteFactor);
  const rate = machineRatePerHour(cfg);
  const machineCost = totalHours * rate;
  const laborMinutes = cfg.setupMinutes + (cfg.postMinutesByComplexity[idx] + finish.extraMinutes) * qty;
  const laborCost = (laborMinutes / 60) * cfg.laborPerHour;
  const extrasCost = finish.extraCost * qty;
  const riskCost = (materialCost + machineCost) * cfg.failureRiskByComplexity[idx];
  const cost = materialCost + machineCost + laborCost + extrasCost + riskCost;

  // Ganancia: lo mayor entre el margen objetivo y lo que la meta mensual exige por hora de máquina.
  const targetMargin = cfg.marginByComplexity[idx];
  const profitByMargin = cost * targetMargin / (1 - targetMargin);
  const profitPerHour = cfg.monthlyProfitGoal / Math.max(1, cfg.sellableHoursPerMonth);
  const profitByGoal = totalHours * profitPerHour;
  const profit = Math.max(profitByMargin, profitByGoal);

  const discountPct = quantityDiscount(qty, cfg.quantityDiscounts);
  const floorPrice = cost / (1 - cfg.minMargin);
  const urgency = job.urgent ? cfg.urgencyMultiplier : 1;
  const step = cfg.roundingStep;

  let recommended = Math.max((cost + profit) * (1 - discountPct), floorPrice, cfg.minOrderPrice) * urgency;
  recommended = roundUp(recommended, step);
  let minimum = roundUp(Math.max(floorPrice, cfg.minOrderPrice) * urgency, step);
  if (minimum > recommended) minimum = recommended;
  const premium = roundUp(recommended * cfg.premiumMultiplier, step);

  const marginOf = (price) => (price > 0 ? (price - cost) / price : 0);
  const tier = (price) => ({
    price,
    unit: price / qty,
    margin: marginOf(price),
    profit: price - cost,
    status: marginStatus(marginOf(price), targetMargin, cfg.minMargin),
  });

  const warnings = [];
  if (totalGrams >= cfg.marketCheckMinGrams && recommended / totalGrams > cfg.marketMaxPerGram) {
    warnings.push({ code: 'aboveMarket', perGram: recommended / totalGrams });
  }

  return {
    quantity: qty,
    complexity: level,
    grams: { unit: gramsUnit, total: totalGrams },
    hours: { unit: hoursUnit, total: totalHours },
    breakdown: {
      material: materialCost,
      machine: machineCost,
      labor: laborCost,
      extras: extrasCost,
      risk: riskCost,
      machineRate: rate,
      laborMinutes,
    },
    cost,
    targetMargin,
    profitDriver: profitByGoal > profitByMargin ? 'goal' : 'margin',
    discountPct,
    urgent: !!job.urgent,
    tiers: {
      minimum: tier(minimum),
      recommended: tier(recommended),
      premium: tier(premium),
    },
    goalShare: (recommended - cost) / cfg.monthlyProfitGoal,
    warnings,
    evaluate(price) { return tier(price); },
  };
}
