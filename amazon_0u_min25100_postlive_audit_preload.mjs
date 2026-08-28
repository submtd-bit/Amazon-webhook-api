import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon 0U minimum 25,100 post-LIVE Fresh audit v1.0.0
 * READ ONLY. No PATCH / no persistent mutation.
 */
const MODULE_VERSION = "2026-08-28-amazon-0u-min25100-postlive-audit-v1.0.0";
const ROUTE = "/amazon/listing/0u-min25100-postlive-audit";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const TARGET = Object.freeze({
  sku: "0U-3IJD-CZ48",
  asin: "B0FMYF5C2Y",
  marketplaceId: "A1VC38T7YXB528",
  normalPrice: 32000,
  amazonPoints: 320,
  minimumSellerAllowed: 25100,
  maximumSellerAllowed: 58000,
  b2bPrice: 55100,
  quantityDiscountType: "percent",
  quantityTiers: [
    { lowerBound: 5, value: 5 },
    { lowerBound: 10, value: 7 },
  ],
  availableQuantity: 0,
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    for (const key of ["amount", "Amount", "value", "Value", "pointsNumber", "PointsNumber", "points_number"]) {
      if (value[key] !== undefined) return num(value[key]);
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function own(obj, key) { return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key); }
function epoch(value) { const t = Date.parse(String(value || "")); return Number.isFinite(t) ? t : null; }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || TARGET.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== TARGET.marketplaceId) throw new Error(`GUARD_BLOCKED: marketplace mismatch ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-amz-access-token": accessToken, accept: "application/json" },
      signal: controller.signal,
    });
    const json = safeJsonParse(await response.text());
    if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json).slice(0, 2500)}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function audience(offer) {
  if (!offer) return "";
  if (typeof offer.audience === "string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value || offer?.audience?.displayName || "").toUpperCase();
}
function offerType(offer) { return String(offer?.offerType || offer?.offer_type || "").toUpperCase(); }
function isActive(schedule, nowMs) {
  const start = epoch(schedule?.start_at);
  const end = epoch(schedule?.end_at);
  if (start !== null && nowMs < start) return false;
  if (end !== null && nowMs >= end) return false;
  return true;
}
function activeSchedule(offer, key, nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  const rows = [];
  groups.forEach(group => {
    const schedules = Array.isArray(group?.schedule) ? group.schedule : [];
    schedules.forEach(schedule => {
      if (isActive(schedule, nowMs)) rows.push({ schedule, start: epoch(schedule?.start_at) ?? 0 });
    });
  });
  rows.sort((a, b) => b.start - a.start);
  return rows[0]?.schedule || null;
}
function scheduleDiagnostics(offer, key, nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  let total = 0, active = 0, expired = 0, future = 0;
  groups.forEach(group => {
    const schedules = Array.isArray(group?.schedule) ? group.schedule : [];
    schedules.forEach(schedule => {
      total += 1;
      const start = epoch(schedule?.start_at);
      const end = epoch(schedule?.end_at);
      if (isActive(schedule, nowMs)) active += 1;
      else if (end !== null && nowMs >= end) expired += 1;
      else if (start !== null && nowMs < start) future += 1;
    });
  });
  return { total, active, expired, future };
}
function quantityPlan(b2b, nowMs) {
  const schedule = activeSchedule(b2b, "quantity_discount_plan", nowMs) || {};
  return {
    type: String(schedule?.discount_type || "").toLowerCase(),
    levels: (Array.isArray(schedule?.levels) ? schedule.levels : []).map(level => ({
      lowerBound: num(level?.lower_bound),
      value: num(level?.value),
    })).filter(x => x.lowerBound !== null && x.value !== null),
  };
}
function quantityPlanMatches(plan) {
  return plan.type === TARGET.quantityDiscountType &&
    plan.levels.length === TARGET.quantityTiers.length &&
    plan.levels.every((x, i) => x.lowerBound === TARGET.quantityTiers[i].lowerBound && x.value === TARGET.quantityTiers[i].value);
}
function parseActualOffers(listing) {
  const { marketplaceId } = getConfig();
  const offers = (Array.isArray(listing?.offers) ? listing.offers : []).filter(o => {
    const id = String(o?.marketplaceId || o?.marketplace_id || "");
    return !id || id === marketplaceId;
  });
  const b2c = offers.find(o => offerType(o) === "B2C" || audience(o) === "ALL") || null;
  const b2b = offers.find(o => offerType(o) === "B2B" || audience(o) === "B2B") || null;
  return {
    b2cPrice: b2c && own(b2c, "price") ? num(b2c.price) : null,
    points: b2c && own(b2c, "points") ? num(b2c.points) : null,
    b2bPrice: b2b && own(b2b, "price") ? num(b2b.price) : null,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, persistentWriteCalls: 0, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, readOnly: true, persistentWriteCalls: 0, externalChanges: 0, error: "Unauthorized" });
    }
    const sku = String(req.body?.sku || "").trim();
    const asin = String(req.body?.asin || "").trim();
    if (sku !== TARGET.sku) throw new Error(`GUARD_BLOCKED: unexpected SKU ${sku}`);
    if (asin !== TARGET.asin) throw new Error(`GUARD_BLOCKED: unexpected ASIN ${asin}`);

    const listing = await getListing(await getLwaAccessToken());
    const nowMs = Date.now();
    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    if (String(summary?.asin || "") !== TARGET.asin) throw new Error(`GUARD_BLOCKED: ASIN mismatch ${summary?.asin || ""}`);

    const attrs = listing?.attributes || {};
    const offers = Array.isArray(attrs?.purchasable_offer) ? attrs.purchasable_offer : [];
    const consumer = offers.find(o => audience(o) === "ALL") || null;
    const b2b = offers.find(o => audience(o) === "B2B") || null;
    const issues = Array.isArray(listing?.issues) ? listing.issues : [];
    const errorIssues = issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR");
    const errorCodes = errorIssues.map(i => String(i?.code || "")).filter(Boolean);
    const actual = parseActualOffers(listing);
    const plan = quantityPlan(b2b, nowMs);
    const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
    const availableQuantity = num(listing?.fulfillmentAvailability?.[0]?.quantity)
      ?? num(attrs?.fulfillment_availability?.[0]?.quantity)
      ?? 0;
    const normalPrice = num(activeSchedule(consumer, "our_price", nowMs)?.value_with_tax);
    const minimum = num(activeSchedule(consumer, "minimum_seller_allowed_price", nowMs)?.value_with_tax);
    const maximum = num(activeSchedule(consumer, "maximum_seller_allowed_price", nowMs)?.value_with_tax);
    const b2bAttributePrice = num(activeSchedule(b2b, "our_price", nowMs)?.value_with_tax);
    const saleDiagnostics = scheduleDiagnostics(consumer, "discounted_price", nowMs);

    const checks = {
      minimum25100: minimum === TARGET.minimumSellerAllowed,
      normal32000: normalPrice === TARGET.normalPrice,
      actualB2C32000: actual.b2cPrice === TARGET.normalPrice,
      points320: actual.points === TARGET.amazonPoints,
      maximum58000: maximum === TARGET.maximumSellerAllowed,
      b2bAttribute55100: b2bAttributePrice === TARGET.b2bPrice,
      actualB2B55100: actual.b2bPrice === TARGET.b2bPrice,
      quantityPlanPreserved: quantityPlanMatches(plan),
      inventory0: availableQuantity === TARGET.availableQuantity,
      issue18155Cleared: !errorCodes.includes("18155"),
      issue18639Cleared: !errorCodes.includes("18639"),
      discoverable: statuses.includes("DISCOVERABLE"),
    };
    const preservationPass = checks.minimum25100 && checks.normal32000 && checks.actualB2C32000 && checks.points320 &&
      checks.maximum58000 && checks.b2bAttribute55100 && checks.actualB2B55100 && checks.quantityPlanPreserved && checks.inventory0;
    const suppressionCleared = checks.issue18155Cleared && checks.issue18639Cleared;
    const finalPass = preservationPass && suppressionCleared && checks.discoverable;

    return res.status(200).json({
      ok: true,
      code: finalPass ? "0U_PRICE_SUPPRESSION_FINAL_VERIFY_PASS" : "0U_PRICE_SUPPRESSION_FRESH_VERIFY_PENDING",
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: TARGET.sku,
      asin: TARGET.asin,
      fetchedAt: new Date().toISOString(),
      status: statuses,
      buyable: statuses.includes("BUYABLE"),
      availableQuantity,
      pricing: {
        normalPrice,
        actualB2CPrice: actual.b2cPrice,
        amazonPoints: actual.points,
        minimumSellerAllowed: minimum,
        maximumSellerAllowed: maximum,
        b2bAttributePrice,
        actualB2BPrice: actual.b2bPrice,
        quantityPlan: plan,
        discountedPriceDiagnostics: saleDiagnostics,
      },
      issues: {
        errorCount: errorIssues.length,
        errorCodes,
        issue18155Present: errorCodes.includes("18155"),
        issue18639Present: errorCodes.includes("18639"),
        issue101265Present: issues.some(i => String(i?.code || "") === "101265"),
        allIssues: issues,
      },
      checks,
      preservationPass,
      suppressionCleared,
      finalPass,
      readOnly: true,
      persistentWriteCalls: 0,
      externalChanges: 0,
      nextAction: finalPass ? "SYNC_PRICE_SSOT_FRESH_CACHE_AND_CLOSE_0U" : "NO_WRITE_RECHECK_FRESH_LATER",
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      code: "0U_POSTLIVE_AUDIT_BLOCKED",
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      persistentWriteCalls: 0,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazon0uMin25100PostliveAuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
