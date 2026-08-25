import express from "express";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-g83-price-velocity-v1.0.0";
const ROUTE = "/amazon/price/g83/velocity/evaluate";
const G83_SKU = "E7-YLJ3-F9CY";
const G83_ASIN = "B0GZBHBQN2";
const originalListen = express.application.listen;

const DEFAULT_POLICY = Object.freeze({
  baselinePrice: 42000,
  baselineDailyUnits: 3,
  maxConfigCost: 23500,
  shipping: 1050,
  packing: 200,
  amazonFeeRate: 0.10,
  blendedAdRate: 0.01888,
  minimumProfit: 5000,
  minimumMarginRate: 0.20,
  evaluationWindowHours: 48,
  extensionWindowHours: 24,
  competitorReferencePrice: 39800,
});

const PRICE_TARGET_LADDER = Object.freeze([
  Object.freeze({ minPrice: 42000, targetDailyUnits: 3.00 }),
  Object.freeze({ minPrice: 41500, targetDailyUnits: 3.25 }),
  Object.freeze({ minPrice: 41200, targetDailyUnits: 3.50 }),
  Object.freeze({ minPrice: 40800, targetDailyUnits: 3.75 }),
  Object.freeze({ minPrice: 39800, targetDailyUnits: 4.00 }),
  Object.freeze({ minPrice: -Infinity, targetDailyUnits: 4.25 }),
]);

const STANDARD_CANDIDATE_PRICES = Object.freeze([42000, 41500, 41200, 40800, 39900, 39800]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveOrDefault(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n > 0 ? n : fallback;
}

function nonNegativeOrDefault(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? n : fallback;
}

function rateOrDefault(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 && n < 1 ? n : fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function ceilToStep(value, step) {
  if (!(Number.isFinite(value) && Number.isFinite(step) && step > 0)) return null;
  return Math.ceil((value - 1e-12) / step) * step;
}

function ceil100(value) {
  return Math.ceil(value / 100) * 100;
}

function buildPolicy(body = {}) {
  const policy = {
    baselinePrice: positiveOrDefault(body.baselinePrice, DEFAULT_POLICY.baselinePrice),
    baselineDailyUnits: positiveOrDefault(body.baselineDailyUnits, DEFAULT_POLICY.baselineDailyUnits),
    maxConfigCost: nonNegativeOrDefault(body.maxConfigCost, DEFAULT_POLICY.maxConfigCost),
    shipping: nonNegativeOrDefault(body.shipping, DEFAULT_POLICY.shipping),
    packing: nonNegativeOrDefault(body.packing, DEFAULT_POLICY.packing),
    amazonFeeRate: rateOrDefault(body.amazonFeeRate, DEFAULT_POLICY.amazonFeeRate),
    blendedAdRate: rateOrDefault(body.blendedAdRate, DEFAULT_POLICY.blendedAdRate),
    minimumProfit: nonNegativeOrDefault(body.minimumProfit, DEFAULT_POLICY.minimumProfit),
    minimumMarginRate: rateOrDefault(body.minimumMarginRate, DEFAULT_POLICY.minimumMarginRate),
    evaluationWindowHours: positiveOrDefault(body.evaluationWindowHours, DEFAULT_POLICY.evaluationWindowHours),
    extensionWindowHours: positiveOrDefault(body.extensionWindowHours, DEFAULT_POLICY.extensionWindowHours),
    competitorReferencePrice: positiveOrDefault(body.competitorReferencePrice, DEFAULT_POLICY.competitorReferencePrice),
  };

  const totalVariableRate = policy.amazonFeeRate + policy.blendedAdRate;
  if (!(totalVariableRate < 1)) throw new Error("amazonFeeRate + blendedAdRate must be < 1");
  if (!(totalVariableRate + policy.minimumMarginRate < 1)) {
    throw new Error("amazonFeeRate + blendedAdRate + minimumMarginRate must be < 1");
  }
  return policy;
}

function fixedCost(policy) {
  return policy.maxConfigCost + policy.shipping + policy.packing;
}

function contributionPerUnit(price, policy) {
  return price * (1 - policy.amazonFeeRate - policy.blendedAdRate) - fixedCost(policy);
}

function contributionMargin(price, policy) {
  if (!(price > 0)) return null;
  return contributionPerUnit(price, policy) / price;
}

function safeFloor(policy) {
  const fixed = fixedCost(policy);
  const netRate = 1 - policy.amazonFeeRate - policy.blendedAdRate;
  const floorByMinimumProfit = (fixed + policy.minimumProfit) / netRate;
  const floorByMinimumMargin = fixed / (netRate - policy.minimumMarginRate);
  const raw = Math.max(floorByMinimumProfit, floorByMinimumMargin);
  return {
    fixedCost: fixed,
    floorByMinimumProfit: round(floorByMinimumProfit, 2),
    floorByMinimumMargin: round(floorByMinimumMargin, 2),
    raw: round(raw, 2),
    floor100: ceil100(raw),
  };
}

function ladderTargetDailyUnits(price) {
  for (const band of PRICE_TARGET_LADDER) {
    if (price >= band.minPrice) return band.targetDailyUnits;
  }
  return 4.25;
}

function baselineDailyContribution(policy) {
  return contributionPerUnit(policy.baselinePrice, policy) * policy.baselineDailyUnits;
}

function candidateMetrics(price, policy) {
  const perUnitContribution = contributionPerUnit(price, policy);
  const baselineContribution = baselineDailyContribution(policy);
  const ladderTarget = ladderTargetDailyUnits(price);
  const profitNeutralTargetRaw = perUnitContribution > 0
    ? baselineContribution / perUnitContribution
    : Infinity;
  const profitNeutralTarget = Number.isFinite(profitNeutralTargetRaw)
    ? ceilToStep(profitNeutralTargetRaw, 0.25)
    : null;
  const targetDailyUnits = profitNeutralTarget === null
    ? null
    : Math.max(ladderTarget, profitNeutralTarget);
  const targetWindowUnits = targetDailyUnits === null
    ? null
    : Math.ceil(targetDailyUnits * policy.evaluationWindowHours / 24);
  const targetDailyContribution = targetDailyUnits === null
    ? null
    : perUnitContribution * targetDailyUnits;

  return {
    price,
    competitorGap: price - policy.competitorReferencePrice,
    perUnitContribution: round(perUnitContribution, 2),
    contributionMargin: round(contributionMargin(price, policy), 6),
    ladderTargetDailyUnits: ladderTarget,
    profitNeutralTargetDailyUnits: profitNeutralTarget,
    targetDailyUnits,
    targetWindowHours: policy.evaluationWindowHours,
    targetWindowUnits,
    targetDailyContribution: round(targetDailyContribution, 2),
    baselineDailyContribution: round(baselineContribution, 2),
    dailyContributionUplift: round(targetDailyContribution - baselineContribution, 2),
    aboveSafeFloor: price >= safeFloor(policy).floor100,
  };
}

function evaluate(body, policy) {
  const price = positiveOrDefault(body.price, policy.baselinePrice);
  const unitsSold = nonNegativeOrDefault(body.unitsSold, 0);
  const elapsedHours = nonNegativeOrDefault(body.elapsedHours, 0);
  const eligibleInStockHoursRaw = body.eligibleInStockHours === undefined
    ? elapsedHours
    : nonNegativeOrDefault(body.eligibleInStockHours, 0);
  const eligibleInStockHours = Math.min(elapsedHours, eligibleInStockHoursRaw);
  const knownSellableCapacityUnits = numberOrNull(body.sellableCapacityUnitsDuringWindow);
  const metrics = candidateMetrics(price, policy);
  const floor = safeFloor(policy);
  const eligibleDays = eligibleInStockHours / 24;
  const actualDailyUnits = eligibleDays > 0 ? unitsSold / eligibleDays : 0;
  const actualDailyContribution = actualDailyUnits * metrics.perUnitContribution;
  const requiredUnits = metrics.targetWindowUnits;
  const nearThresholdUnits = requiredUnits === null ? null : Math.max(0, requiredUnits - 2);

  let verdict = "OBSERVE";
  let reason = "Eligible in-stock evaluation window is not complete.";

  if (price < floor.floor100) {
    verdict = "BLOCK_BELOW_SAFE_FLOOR";
    reason = `Price ${price} is below internal safe floor ${floor.floor100}.`;
  } else if (knownSellableCapacityUnits !== null && requiredUnits !== null && knownSellableCapacityUnits < requiredUnits) {
    verdict = "STOCK_LIMITED";
    reason = `Known sellable capacity ${knownSellableCapacityUnits} is below required ${requiredUnits} units for the evaluation window.`;
  } else if (eligibleInStockHours < policy.evaluationWindowHours) {
    verdict = "OBSERVE";
    reason = `Only ${round(eligibleInStockHours, 2)} eligible in-stock hours accrued; ${policy.evaluationWindowHours} are required.`;
  } else if (unitsSold >= requiredUnits && actualDailyContribution >= metrics.baselineDailyContribution) {
    verdict = "PASS_HOLD";
    reason = `Sales met the ${metrics.targetDailyUnits}/day target and daily contribution is not below the 42,000 yen baseline.`;
  } else if (unitsSold >= nearThresholdUnits) {
    verdict = "EXTEND_24H";
    reason = `Sales are within 2 units of the target; extend by ${policy.extensionWindowHours} eligible in-stock hours before repricing.`;
  } else {
    verdict = "REPRICE_REVIEW";
    reason = `Sales are below the price-specific target of ${metrics.targetDailyUnits}/day.`;
  }

  return {
    price,
    unitsSold,
    elapsedHours: round(elapsedHours, 2),
    eligibleInStockHours: round(eligibleInStockHours, 2),
    pausedOutOfStockHours: round(Math.max(0, elapsedHours - eligibleInStockHours), 2),
    actualDailyUnits: round(actualDailyUnits, 4),
    actualDailyContribution: round(actualDailyContribution, 2),
    requiredUnitsForWindow: requiredUnits,
    nearThresholdUnits,
    knownSellableCapacityUnits,
    verdict,
    reason,
    ...metrics,
  };
}

function normalizeScope(body) {
  const sku = String(body?.sku || "").trim();
  const asin = String(body?.asin || "").trim().toUpperCase();
  if (sku !== G83_SKU) throw new Error(`sku must equal ${G83_SKU}`);
  if (asin !== G83_ASIN) throw new Error(`asin must equal ${G83_ASIN}`);
  return { sku, asin };
}

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({ ok: false, error: "AMAZON_STOCK_API_SECRET is not set", externalChanges: 0 });
    }
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, error: "Unauthorized", externalChanges: 0 });
    }

    const scope = normalizeScope(req.body || {});
    const policy = buildPolicy(req.body?.policy || {});
    const evaluation = evaluate(req.body || {}, policy);
    const floor = safeFloor(policy);
    const candidates = STANDARD_CANDIDATE_PRICES.map(price => candidateMetrics(price, policy));

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      scope,
      policy,
      safeFloor: floor,
      evaluation,
      candidates,
      notes: [
        "Lower prices require higher daily unit velocity.",
        "Target daily units are the stricter of the G83 price ladder and the units needed to preserve baseline daily contribution.",
        "Only eligible in-stock hours count toward the evaluation window; stockout hours pause the test clock.",
        "This endpoint is READ ONLY and performs no Amazon or spreadsheet mutation.",
      ],
      externalChanges: 0,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      error: err?.message || String(err),
      externalChanges: 0,
    });
  }
}

express.application.listen = function g83PriceVelocityListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};

export {
  MODULE_VERSION,
  ROUTE,
  DEFAULT_POLICY,
  PRICE_TARGET_LADDER,
  STANDARD_CANDIDATE_PRICES,
  buildPolicy,
  safeFloor,
  contributionPerUnit,
  candidateMetrics,
  evaluate,
};
