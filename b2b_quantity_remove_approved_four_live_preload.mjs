import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-b2b-qty-remove-approved-four-live-v1.0.0";
const ROUTE = "/amazon/price/b2b/quantity/remove/approved-four/live";
const ACTION = "QTY_REMOVE_MERGE_NULL_APPROVED_FOUR";
const CONFIRM = "B2B-QTY-REMOVE-APPROVED-FOUR-LIVE-V1";
const SCOPE_KEY = "APPROVED_2026_08_22_1845_EXCLUDE_E7_YLJ3_F9CY";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const VERIFY_ATTEMPTS = 12;
const VERIFY_WAIT_MS = 2500;
const originalListen = express.application.listen;

const APPROVED = Object.freeze([
  Object.freeze({
    sku: "QH-ITJ6-BTTC",
    asin: "B0FPC385LM",
    generalPrice: 87000,
    normalPrice: 87000,
    b2bPrice: 82650,
    quantityMinLot: 10,
    plan: Object.freeze({ discountType: "percent", tiers: Object.freeze([{ lowerBound: 5, value: 5 }, { lowerBound: 10, value: 7 }]) }),
  }),
  Object.freeze({
    sku: "5K-G098-FO9O",
    asin: "B0FPC52B8K",
    generalPrice: 78000,
    normalPrice: 78000,
    b2bPrice: 74100,
    quantityMinLot: 10,
    plan: Object.freeze({ discountType: "percent", tiers: Object.freeze([{ lowerBound: 5, value: 5 }, { lowerBound: 10, value: 7 }]) }),
  }),
  Object.freeze({
    sku: "F7-AF7O-IGX5",
    asin: "B0FN3KQFR3",
    generalPrice: 68000,
    normalPrice: 73000,
    b2bPrice: 69350,
    quantityMinLot: 10,
    plan: Object.freeze({ discountType: "percent", tiers: Object.freeze([{ lowerBound: 5, value: 5 }, { lowerBound: 10, value: 7 }]) }),
  }),
  Object.freeze({
    sku: "SO-9QJ3-7SHR",
    asin: "B0FPC2JKBY",
    generalPrice: 77000,
    normalPrice: 77000,
    b2bPrice: 73150,
    quantityMinLot: 10,
    plan: Object.freeze({ discountType: "percent", tiers: Object.freeze([{ lowerBound: 5, value: 5 }, { lowerBound: 10, value: 7 }]) }),
  }),
]);

const EXCLUDED_SENTINEL = Object.freeze({
  sku: "E7-YLJ3-F9CY",
  asin: "B0GZBHBQN2",
  generalPrice: 41170,
  normalPrice: 58000,
  b2bPrice: 39900,
  plan: Object.freeze({ discountType: "percent", tiers: Object.freeze([{ lowerBound: 10, value: 3 }]) }),
});

const parse = text => { try { return JSON.parse(text || "{}"); } catch { return { rawText: text }; } };
const num = value => (value === null || value === undefined || value === "") ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = () => String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}

async function token() {
  const { LWA_CLIENT_ID, LWA_CLIENT_SECRET, REFRESH_TOKEN } = process.env;
  if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !REFRESH_TOKEN) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  });
  const json = parse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error ${response.status}`);
  return json.access_token;
}

async function spRequest({ method, url, accessToken, body }) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const json = parse(await response.text());
      if (response.ok) return json;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        const error = new Error(`SP-API ${method} ${response.status} ${JSON.stringify(json)}`);
        error.httpStatus = response.status;
        error.details = json;
        throw error;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter * 1000)
        : RETRY_BASE_MS * attempt;
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) throw error;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  return spRequest({
    method: "GET",
    url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`,
    accessToken,
  });
}

async function patchListing(accessToken, sku, body) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  return spRequest({
    method: "PATCH",
    url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`,
    accessToken,
    body,
  });
}

function scheduleValue(offer, key) {
  return offer?.[key]?.[0]?.schedule?.[0] || {};
}

function normalizeTiers(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(row => ({
      lowerBound: num(row?.lower_bound ?? row?.lowerBound),
      value: num(row?.value),
    }))
    .filter(row => row.lowerBound !== null && row.value !== null)
    .sort((a, b) => a.lowerBound - b.lowerBound || a.value - b.value);
}

function state(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const offers = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const consumer = offers.find(row => String(row?.audience || "ALL").toUpperCase() === "ALL") || null;
  const b2b = offers.find(row => String(row?.audience || "").toUpperCase() === "B2B") || null;
  const quantitySchedule = b2b?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const normalPrice = num(scheduleValue(consumer, "our_price")?.value_with_tax);
  const salePrice = num(scheduleValue(consumer, "discounted_price")?.value_with_tax);
  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: num(listing?.fulfillmentAvailability?.[0]?.quantity)
      ?? num(attributes?.fulfillment_availability?.[0]?.quantity)
      ?? 0,
    normalPrice,
    salePrice,
    generalPrice: salePrice ?? normalPrice,
    b2bPrice: num(scheduleValue(b2b, "our_price")?.value_with_tax),
    quantityPlan: {
      discountType: String(quantitySchedule?.discount_type || "").toLowerCase(),
      tiers: normalizeTiers(quantitySchedule?.levels),
    },
    selector: {
      audience: String(b2b?.audience || ""),
      currency: String(b2b?.currency || ""),
      marketplace_id: String(b2b?.marketplace_id || ""),
    },
  };
}

function sameTiers(a, b) {
  const x = normalizeTiers(a);
  const y = normalizeTiers(b);
  if (x.length !== y.length) return false;
  return x.every((row, i) => row.lowerBound === y[i].lowerBound && row.value === y[i].value);
}

function samePlan(actual, expected) {
  return String(actual?.discountType || "").toLowerCase() === String(expected?.discountType || "").toLowerCase()
    && sameTiers(actual?.tiers, expected?.tiers);
}

function guardApproved(expected, current) {
  const errors = [];
  if (current.asin !== expected.asin) errors.push(`ASIN=${current.asin}`);
  if (!current.productType) errors.push("productType");
  if (!current.buyable) errors.push("BUYABLE");
  if (current.errorCount) errors.push(`errors=${current.errorCount}`);
  if (current.generalPrice !== expected.generalPrice) errors.push(`general=${current.generalPrice}`);
  if (current.normalPrice !== expected.normalPrice) errors.push(`normal=${current.normalPrice}`);
  if (current.b2bPrice !== expected.b2bPrice) errors.push(`b2b=${current.b2bPrice}`);
  if (!(current.availableQuantity < expected.quantityMinLot)) errors.push(`qty=${current.availableQuantity}`);
  if (!samePlan(current.quantityPlan, expected.plan)) errors.push(`plan=${JSON.stringify(current.quantityPlan)}`);
  if (String(current.selector.audience).toUpperCase() !== "B2B") errors.push(`selector.audience=${current.selector.audience}`);
  if (current.selector.currency !== "JPY") errors.push(`selector.currency=${current.selector.currency}`);
  if (current.selector.marketplace_id !== cfg().marketplaceId) errors.push(`selector.marketplace_id=${current.selector.marketplace_id}`);
  if (errors.length) {
    const error = new Error(`APPROVED_SCOPE_PREFLIGHT_FAILED ${expected.sku}: ${errors.join(" / ")}`);
    error.code = "APPROVED_SCOPE_PREFLIGHT_FAILED";
    error.details = errors;
    throw error;
  }
}

function guardExcludedSentinel(current) {
  const expected = EXCLUDED_SENTINEL;
  const errors = [];
  if (current.asin !== expected.asin) errors.push(`ASIN=${current.asin}`);
  if (!current.productType) errors.push("productType");
  if (current.generalPrice !== expected.generalPrice) errors.push(`general=${current.generalPrice}`);
  if (current.normalPrice !== expected.normalPrice) errors.push(`normal=${current.normalPrice}`);
  if (current.b2bPrice !== expected.b2bPrice) errors.push(`b2b=${current.b2bPrice}`);
  if (!samePlan(current.quantityPlan, expected.plan)) errors.push(`plan=${JSON.stringify(current.quantityPlan)}`);
  if (String(current.selector.audience).toUpperCase() !== "B2B") errors.push(`selector.audience=${current.selector.audience}`);
  if (errors.length) {
    const error = new Error(`EXCLUDED_SENTINEL_DRIFT ${expected.sku}: ${errors.join(" / ")}`);
    error.code = "EXCLUDED_SENTINEL_DRIFT";
    error.details = errors;
    throw error;
  }
}

function buildPatch(current) {
  return {
    productType: current.productType,
    patches: [{
      op: "merge",
      path: "/attributes/purchasable_offer",
      value: [{
        audience: current.selector.audience,
        currency: current.selector.currency,
        marketplace_id: current.selector.marketplace_id,
        quantity_discount_plan: null,
      }],
    }],
  };
}

function verifiedRemoved(expected, current) {
  return current.asin === expected.asin
    && current.buyable === true
    && current.errorCount === 0
    && current.generalPrice === expected.generalPrice
    && current.normalPrice === expected.normalPrice
    && current.b2bPrice === expected.b2bPrice
    && !current.quantityPlan.discountType
    && current.quantityPlan.tiers.length === 0;
}

async function verifyRemoval(accessToken, expected) {
  let lastState = null;
  let lastError = "";
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    try {
      lastState = state(await getListing(accessToken, expected.sku));
      if (verifiedRemoved(expected, lastState)) {
        return { verified: true, attempt, state: lastState };
      }
      lastError = `plan still present or protected field drift: ${JSON.stringify(lastState)}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return { verified: false, attempt: VERIFY_ATTEMPTS, state: lastState, error: lastError };
}

async function handler(req, res) {
  const requestedAt = new Date().toISOString();
  let actualExternalChanges = 0;
  const completed = [];
  try {
    const sec = secret();
    if (!sec) return res.status(500).json({ ok:false, moduleVersion:MODULE_VERSION, route:ROUTE, requestedAt, status:"ERROR", error:"AMAZON_STOCK_API_SECRET is not set", actualExternalChanges:0, externalChanges:0 });
    if (String(req.headers["x-api-secret"] || "") !== sec) return res.status(401).json({ ok:false, moduleVersion:MODULE_VERSION, route:ROUTE, requestedAt, status:"ERROR", error:"Unauthorized", actualExternalChanges:0, externalChanges:0 });
    if (String(req.body?.confirm || "") !== CONFIRM) return res.status(400).json({ ok:false, moduleVersion:MODULE_VERSION, route:ROUTE, requestedAt, status:"CONFIRM_REQUIRED", error:`confirm must equal ${CONFIRM}`, actualExternalChanges:0, externalChanges:0 });
    if (String(req.body?.scopeKey || "") !== SCOPE_KEY) return res.status(400).json({ ok:false, moduleVersion:MODULE_VERSION, route:ROUTE, requestedAt, status:"SCOPE_KEY_REQUIRED", error:`scopeKey must equal ${SCOPE_KEY}`, actualExternalChanges:0, externalChanges:0 });

    const accessToken = await token();

    // Critical exclusion gate: E7 is explicitly NOT approved for removal.
    const excludedBefore = state(await getListing(accessToken, EXCLUDED_SENTINEL.sku));
    guardExcludedSentinel(excludedBefore);

    // Full four-item Fresh preflight before the first Amazon write.
    const preflight = [];
    for (const expected of APPROVED) {
      const current = state(await getListing(accessToken, expected.sku));
      guardApproved(expected, current);
      preflight.push({ sku: expected.sku, asin: expected.asin, before: current, attemptedPatch: buildPatch(current) });
    }

    const results = [];
    for (const expected of APPROVED) {
      const current = state(await getListing(accessToken, expected.sku));
      guardApproved(expected, current);
      const attemptedPatch = buildPatch(current);
      const accepted = await patchListing(accessToken, expected.sku, attemptedPatch);
      const verification = await verifyRemoval(accessToken, expected);
      if (!verification.verified) {
        return res.status(409).json({
          ok:false,
          moduleVersion:MODULE_VERSION,
          route:ROUTE,
          requestedAt,
          status:"PARTIAL_LIVE_ACCEPTED_FRESH_VERIFICATION_FAILED",
          action:ACTION,
          approvedScope:APPROVED.map(x => ({ sku:x.sku, asin:x.asin })),
          excludedSku:EXCLUDED_SENTINEL.sku,
          preflight,
          completed,
          failed:{ sku:expected.sku, asin:expected.asin, accepted, verification },
          actualExternalChanges,
          externalChanges:actualExternalChanges,
        });
      }
      actualExternalChanges += 1;
      completed.push({ sku: expected.sku, asin: expected.asin });
      results.push({ sku:expected.sku, asin:expected.asin, status:"COMPLETED", accepted, verification, actualExternalChanges:1, externalChanges:1 });
    }

    // Final exclusion sentinel: confirm the newly-created 10-unit 3% plan was untouched.
    const excludedAfter = state(await getListing(accessToken, EXCLUDED_SENTINEL.sku));
    guardExcludedSentinel(excludedAfter);

    return res.status(200).json({
      ok:true,
      moduleVersion:MODULE_VERSION,
      route:ROUTE,
      requestedAt,
      status:"COMPLETED",
      action:ACTION,
      scopeKey:SCOPE_KEY,
      approvedCount:APPROVED.length,
      approvedScope:APPROVED.map(x => ({ sku:x.sku, asin:x.asin })),
      excludedPreserved:{ sku:EXCLUDED_SENTINEL.sku, asin:EXCLUDED_SENTINEL.asin, before:excludedBefore, after:excludedAfter, unchanged:true },
      preflight,
      results,
      actualExternalChanges,
      externalChanges:actualExternalChanges,
    });
  } catch (error) {
    const statusCode = ["APPROVED_SCOPE_PREFLIGHT_FAILED", "EXCLUDED_SENTINEL_DRIFT"].includes(error?.code) ? 409 : 400;
    return res.status(statusCode).json({
      ok:false,
      moduleVersion:MODULE_VERSION,
      route:ROUTE,
      requestedAt,
      status:error?.code || "ERROR",
      error:error?.message || String(error),
      details:error?.details || [],
      approvedScope:APPROVED.map(x => ({ sku:x.sku, asin:x.asin })),
      excludedSku:EXCLUDED_SENTINEL.sku,
      completed,
      actualExternalChanges,
      externalChanges:actualExternalChanges,
    });
  }
}

express.application.listen = function approvedFourLiveListen(...args) {
  const exists = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!exists) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
