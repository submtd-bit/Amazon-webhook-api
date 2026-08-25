import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-sv1-price-test-live-once-v1.0.0";
const STATUS_ROUTE = "/__status/sv1-52800-live-4fd489a7d6a24d1f9ab421d2a7fd07b1";
const APPROVAL_TAG = "SV1-52800-LIVE-APPROVED-20260825";
const SKU = "RB-Y7G2-H0EK";
const ASIN = "B0GZGM1BND";
const NORMAL_PRICE = 56000;
const SALE_PRICE = 52800;
const MIN_ALLOWED_PRICE = 35000;
const SAFE_FLOOR = 40500;
const DURATION_HOURS = 72;
const VERIFY_ATTEMPTS = 12;
const VERIFY_WAIT_MS = 3000;
const REQUEST_TIMEOUT_MS = 25000;

const originalUse = express.application.use;
const originalGet = express.application.get;

const liveState = globalThis.__sv1PriceTestLiveOnceState || {
  moduleVersion: MODULE_VERSION,
  approvalTag: APPROVAL_TAG,
  status: "BOOTING",
  externalChanges: 0,
  startedAt: new Date().toISOString(),
  verifiedAt: null,
  error: null,
  before: null,
  after: null,
  accepted: null,
};
globalThis.__sv1PriceTestLiveOnceState = liveState;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseJson(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { rawText: text }; } }
function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function epoch(v) { const t = Date.parse(String(v || "")); return Number.isFinite(t) ? t : null; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((o, k) => { o[k] = stable(value[k]); return o; }, {});
  return value;
}
function stableString(value) { return JSON.stringify(stable(value)); }

function config() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}

async function lwaToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const j = parseJson(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA token error: ${r.status}`);
  return j.access_token;
}

async function amazon({ method, url, accessToken, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: { "x-amz-access-token": accessToken, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const j = parseJson(await r.text());
    if (!r.ok) throw new Error(`SP-API request error: ${r.status} ${JSON.stringify(j)}`);
    return j;
  } finally { clearTimeout(timer); }
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = config();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,fulfillmentAvailability", issueLocale: "ja_JP" });
  return amazon({ method: "GET", url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`, accessToken });
}

function schedules(offer, key) { const s = offer?.[key]?.[0]?.schedule; return Array.isArray(s) ? s : []; }
function activeSchedule(offer, key, now) {
  return schedules(offer, key).filter(s => {
    const start = epoch(s?.start_at); const end = epoch(s?.end_at);
    return (start === null || now >= start) && (end === null || now < end);
  }).sort((a, b) => (epoch(b?.start_at) ?? 0) - (epoch(a?.start_at) ?? 0))[0] || null;
}

function analyze(raw, now = Date.now()) {
  const summary = Array.isArray(raw?.summaries) ? raw.summaries[0] || {} : {};
  const attrs = raw?.attributes || {};
  const issues = Array.isArray(raw?.issues) ? raw.issues : [];
  const availability = Array.isArray(raw?.fulfillmentAvailability) ? raw.fulfillmentAvailability[0] || {} : {};
  const offers = Array.isArray(attrs?.purchasable_offer) ? attrs.purchasable_offer : [];
  const consumerIndex = offers.findIndex(r => String(r?.audience || "ALL").toUpperCase() === "ALL");
  const consumer = consumerIndex >= 0 ? offers[consumerIndex] : null;
  const sale = activeSchedule(consumer, "discounted_price", now);
  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    errorCount: issues.filter(r => String(r?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: num(availability?.quantity) ?? num(attrs?.fulfillment_availability?.[0]?.quantity) ?? 0,
    offers,
    consumerIndex,
    consumer,
    normalPrice: num(activeSchedule(consumer, "our_price", now)?.value_with_tax),
    activeSalePrice: num(sale?.value_with_tax),
    activeSaleStart: sale?.start_at || null,
    activeSaleEnd: sale?.end_at || null,
    minimumSellerAllowedPrice: num(activeSchedule(consumer, "minimum_seller_allowed_price", now)?.value_with_tax),
  };
}

function publicState(s) {
  return {
    asin: s.asin,
    productType: s.productType,
    statuses: s.statuses,
    errorCount: s.errorCount,
    availableQuantity: s.availableQuantity,
    normalPrice: s.normalPrice,
    activeSalePrice: s.activeSalePrice,
    activeSaleStart: s.activeSaleStart,
    activeSaleEnd: s.activeSaleEnd,
    minimumSellerAllowedPrice: s.minimumSellerAllowedPrice,
  };
}

function assertPreflight(s) {
  const e = [];
  if (s.asin !== ASIN) e.push(`ASIN=${s.asin}`);
  if (!s.productType) e.push("productType missing");
  if (!s.statuses.includes("BUYABLE")) e.push(`BUYABLE missing:${s.statuses.join("|")}`);
  if (s.errorCount !== 0) e.push(`listingErrors=${s.errorCount}`);
  if (!(s.availableQuantity > 0)) e.push(`qty=${s.availableQuantity}`);
  if (!s.consumer || s.consumerIndex < 0) e.push("consumer offer missing");
  if (s.normalPrice !== NORMAL_PRICE) e.push(`normal=${s.normalPrice}`);
  if (s.minimumSellerAllowedPrice !== MIN_ALLOWED_PRICE) e.push(`minAllowed=${s.minimumSellerAllowedPrice}`);
  if (SALE_PRICE < SAFE_FLOOR) e.push(`salePrice below safeFloor:${SALE_PRICE}<${SAFE_FLOOR}`);
  if (s.activeSalePrice !== null && s.activeSalePrice !== SALE_PRICE) e.push(`unexpected activeSale=${s.activeSalePrice}`);
  if (e.length) { const err = new Error(`SV1 LIVE preflight failed: ${e.join(" / ")}`); err.code = "PREFLIGHT_FAILED"; throw err; }
}

function snapshotProtectedOffers(s) {
  return {
    nonConsumer: s.offers.filter((_, i) => i !== s.consumerIndex),
    consumerWithoutDiscount: (() => {
      const c = JSON.parse(JSON.stringify(s.consumer || {}));
      delete c.discounted_price;
      return c;
    })(),
  };
}

function protectedOffersMatch(beforeProtected, afterState) {
  const afterProtected = snapshotProtectedOffers(afterState);
  return stableString(beforeProtected.nonConsumer) === stableString(afterProtected.nonConsumer)
    && stableString(beforeProtected.consumerWithoutDiscount) === stableString(afterProtected.consumerWithoutDiscount);
}

function buildPatch(s, now) {
  const offers = JSON.parse(JSON.stringify(s.offers));
  const consumer = offers[s.consumerIndex];
  const saleContainer = consumer?.discounted_price?.[0];
  if (!saleContainer || !Array.isArray(saleContainer.schedule) || !saleContainer.schedule.length) throw new Error("discounted_price template missing");
  const template = JSON.parse(JSON.stringify(saleContainer.schedule[0] || {}));
  const startAt = new Date(now - 60000).toISOString();
  const endAt = new Date(now + DURATION_HOURS * 3600000).toISOString();
  template.value_with_tax = SALE_PRICE;
  template.start_at = startAt;
  template.end_at = endAt;
  saleContainer.schedule = [template];
  return { startAt, endAt, patchBody: { productType: s.productType, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }] } };
}

async function submitLive(accessToken, patchBody) {
  const { sellerId, marketplaceId, endpoint } = config();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  const result = await amazon({ method: "PATCH", url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`, accessToken, body: patchBody });
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const errors = issues.filter(r => String(r?.severity || "").toUpperCase() === "ERROR");
  if (errors.length) throw new Error(`Amazon LIVE returned ERROR issues: ${JSON.stringify(errors)}`);
  return result;
}

function applied(s) {
  return s.asin === ASIN
    && s.statuses.includes("BUYABLE")
    && s.errorCount === 0
    && s.normalPrice === NORMAL_PRICE
    && s.activeSalePrice === SALE_PRICE
    && s.minimumSellerAllowedPrice === MIN_ALLOWED_PRICE;
}

async function verify(accessToken, beforeProtected) {
  let last = null;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    const state = analyze(await getListing(accessToken));
    last = state;
    if (applied(state) && protectedOffersMatch(beforeProtected, state)) {
      return { verified: true, attempt, verifiedAt: new Date().toISOString(), state };
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return { verified: false, attempt: VERIFY_ATTEMPTS, state: last };
}

async function runOnce() {
  if (liveState.status !== "BOOTING") return;
  liveState.status = "FRESH_GET_PREFLIGHT";
  try {
    const accessToken = await lwaToken();
    const before = analyze(await getListing(accessToken));
    liveState.before = publicState(before);
    assertPreflight(before);

    const beforeProtected = snapshotProtectedOffers(before);
    if (applied(before)) {
      liveState.status = "ALREADY_APPLIED_VERIFIED";
      liveState.verifiedAt = new Date().toISOString();
      liveState.after = publicState(before);
      liveState.externalChanges = 0;
      return;
    }

    if (before.activeSalePrice !== null) throw new Error(`Active sale unexpectedly exists: ${before.activeSalePrice}`);

    liveState.status = "PATCHING_LIVE";
    const built = buildPatch(before, Date.now());
    const accepted = await submitLive(accessToken, built.patchBody);
    liveState.accepted = { sku: accepted?.sku || SKU, status: accepted?.status || null, submissionId: accepted?.submissionId || null, issues: accepted?.issues || [] };
    liveState.status = "VERIFYING_FRESH_GET";

    const verification = await verify(accessToken, beforeProtected);
    liveState.after = verification.state ? publicState(verification.state) : null;
    if (!verification.verified) {
      liveState.status = "VERIFICATION_FAILED";
      liveState.externalChanges = 0;
      liveState.error = "Amazon accepted the PATCH but Fresh GET verification did not prove the exact protected state.";
      return;
    }

    liveState.status = "COMPLETED";
    liveState.verifiedAt = verification.verifiedAt;
    liveState.verificationAttempt = verification.attempt;
    liveState.externalChanges = 1;
  } catch (err) {
    liveState.status = err?.code || "ERROR";
    liveState.externalChanges = 0;
    liveState.error = err?.message || String(err);
  }
}

function statusHandler(req, res) {
  res.set("Cache-Control", "no-store");
  res.json({ ...liveState, target: { sku: SKU, asin: ASIN, normalPrice: NORMAL_PRICE, salePrice: SALE_PRICE, safeFloor: SAFE_FLOOR, minimumSellerAllowedPrice: MIN_ALLOWED_PRICE, durationHours: DURATION_HOURS } });
}

express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  if (!this.__sv1PriceTestLiveStatusInstalled) {
    this.__sv1PriceTestLiveStatusInstalled = true;
    originalGet.call(this, STATUS_ROUTE, statusHandler);
    console.log(`${MODULE_VERSION} status route installed: GET ${STATUS_ROUTE}`);
  }
  return result;
};

setTimeout(() => {
  runOnce().catch(err => {
    liveState.status = "ERROR";
    liveState.externalChanges = 0;
    liveState.error = err?.message || String(err);
  });
}, 1500);
