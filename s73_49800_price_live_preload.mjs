import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

/**
 * S73/HS 7X-725F-2ZML consumer normal price 49,800 guarded flow v1.0.0
 * 2026-08-31
 *
 * Explicitly approved scope:
 * - SKU 7X-725F-2ZML / ASIN B0HGDBYRS8
 * - Consumer normal price only: 58,000 -> 49,800
 * - Economic floor: 39,800
 * - Preserve minimum seller allowed price: 38,000
 * - Preserve B2B attribute price: 52,000
 * - Preserve quantity discount state: none
 * - Preserve every non-target purchasable_offer field
 * - Never touches Amazon Ads / Yahoo / inventory
 *
 * DRY: exact Fresh GET -> VALIDATION_PREVIEW -> Fresh GET -> signed fingerprint.
 * LIVE: fingerprint -> Fresh GET -> VALIDATION_PREVIEW -> Fresh GET -> one LIVE PATCH -> Fresh verify.
 * AUDIT: READ ONLY Fresh state after a possibly-sent LIVE.
 */

const MODULE_VERSION = "2026-08-31-s73-49800-price-v1.0.0";
const DRY_ROUTE = "/amazon/price/s73-49800/dry-run";
const LIVE_ROUTE = "/amazon/price/s73-49800/live";
const AUDIT_ROUTE = "/amazon/price/s73-49800/audit";
const LIVE_CONFIRM = "S73_49800_LIVE_APPROVED_20260831";
const FINGERPRINT_TTL_MINUTES = 30;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const VERIFY_ATTEMPTS = 8;
const VERIFY_WAIT_MS = 1800;
const originalListen = express.application.listen;

const TARGET = Object.freeze({
  sku: "7X-725F-2ZML",
  asin: "B0HGDBYRS8",
  currentNormal: 58000,
  targetNormal: 49800,
  economicFloor: 39800,
  minimumSellerAllowed: 38000,
  amazonPointsBefore: 580,
  b2bAttributePrice: 52000,
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    for (const key of ["amount", "Amount", "value", "Value", "pointsNumber", "PointsNumber", "points_number"]) {
      if (value && value[key] !== undefined) return numberOrNull(value[key]);
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function jsonEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function hasOwn(obj, key) { return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function epochOrNull(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : null;
}
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function base64urlEncode(value) { return Buffer.from(String(value), "utf8").toString("base64url"); }
function base64urlDecode(value) { return Buffer.from(String(value), "base64url").toString("utf8"); }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
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
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

async function amazonRequest(url, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      const json = safeJsonParse(text);
      if (response.ok) return { response, json };
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw new Error(`SP-API error: ${response.status} ${JSON.stringify(json).slice(0, 2500)}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * attempt);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,offers,fulfillmentAvailability", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;
  return (await amazonRequest(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } })).json;
}

async function patchListing(accessToken, productType, offers, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  if (validationPreview) q.set("mode", "VALIDATION_PREVIEW");
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;
  const body = { productType, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }] };
  const json = (await amazonRequest(url, {
    method: "PATCH",
    headers: { "x-amz-access-token": accessToken, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json;
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  return { json, issues, errors };
}

function scheduleIsActive(schedule, nowMs) {
  const start = epochOrNull(schedule?.start_at);
  const end = epochOrNull(schedule?.end_at);
  if (start !== null && nowMs < start) return false;
  if (end !== null && nowMs >= end) return false;
  return true;
}
function activeScheduleRef(offer, key, nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  const candidates = [];
  groups.forEach((group, groupIndex) => {
    const schedules = Array.isArray(group?.schedule) ? group.schedule : [];
    schedules.forEach((schedule, scheduleIndex) => {
      if (scheduleIsActive(schedule, nowMs)) candidates.push({ groupIndex, scheduleIndex, schedule, startMs: epochOrNull(schedule?.start_at) ?? 0 });
    });
  });
  candidates.sort((a, b) => b.startMs - a.startMs);
  return candidates[0] || null;
}
function activeScheduleCount(offer, key, nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  let count = 0;
  groups.forEach(group => (Array.isArray(group?.schedule) ? group.schedule : []).forEach(s => { if (scheduleIsActive(s, nowMs)) count += 1; }));
  return count;
}
function audienceValue(offer) {
  if (!offer) return "";
  if (typeof offer.audience === "string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value || offer?.audience?.displayName || "").toUpperCase();
}
function offerType(offer) { return String(offer?.offerType || offer?.offer_type || "").toUpperCase(); }
function offerPrice(offer) { return offer && hasOwn(offer, "price") ? numberOrNull(offer.price) : null; }
function parsePointsValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") return numberOrNull(raw);
  for (const key of ["pointsNumber", "PointsNumber", "points_number", "amount", "Amount", "value", "Value"]) {
    if (raw[key] !== undefined) {
      const n = numberOrNull(raw[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

function analyzeListing(listing, nowMs = Date.now()) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const errorIssues = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const offers = Array.isArray(attributes?.purchasable_offer) ? clone(attributes.purchasable_offer) : [];
  const indexed = offers.map((offer, index) => ({ offer, index }));
  const consumers = indexed.filter(x => audienceValue(x.offer) === "ALL");
  const b2bs = indexed.filter(x => audienceValue(x.offer) === "B2B");
  const consumer = consumers.length === 1 ? consumers[0].offer : null;
  const b2b = b2bs.length === 1 ? b2bs[0].offer : null;
  const normalRef = activeScheduleRef(consumer, "our_price", nowMs);
  const saleRef = activeScheduleRef(consumer, "discounted_price", nowMs);
  const minimumRef = activeScheduleRef(consumer, "minimum_seller_allowed_price", nowMs);
  const maximumRef = activeScheduleRef(consumer, "maximum_seller_allowed_price", nowMs);
  const b2bPriceRef = activeScheduleRef(b2b, "our_price", nowMs);
  const activeQuantityDiscountCount = activeScheduleCount(b2b, "quantity_discount_plan", nowMs);

  const { marketplaceId } = getConfig();
  const actualOffers = Array.isArray(listing?.offers) ? listing.offers.filter(o => {
    const id = String(o?.marketplaceId || o?.marketplace_id || "");
    return !id || id === marketplaceId;
  }) : [];
  const actualB2C = actualOffers.find(o => offerType(o) === "B2C" || audienceValue(o) === "ALL") || null;
  const actualB2B = actualOffers.find(o => offerType(o) === "B2B" || audienceValue(o) === "B2B") || null;
  const availableQuantity = numberOrNull(listing?.fulfillmentAvailability?.[0]?.quantity) ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity) ?? 0;

  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    discoverable: statuses.includes("DISCOVERABLE"),
    errorIssues,
    availableQuantity,
    offers,
    consumerIndex: consumers.length === 1 ? consumers[0].index : -1,
    b2bIndex: b2bs.length === 1 ? b2bs[0].index : -1,
    consumerCount: consumers.length,
    b2bCount: b2bs.length,
    normalRef,
    normalPrice: numberOrNull(normalRef?.schedule?.value_with_tax),
    salePrice: numberOrNull(saleRef?.schedule?.value_with_tax),
    activeSaleCount: activeScheduleCount(consumer, "discounted_price", nowMs),
    minimumSellerAllowed: numberOrNull(minimumRef?.schedule?.value_with_tax),
    maximumSellerAllowed: numberOrNull(maximumRef?.schedule?.value_with_tax),
    b2bPrice: numberOrNull(b2bPriceRef?.schedule?.value_with_tax),
    activeQuantityDiscountCount,
    actualB2CPrice: offerPrice(actualB2C),
    actualPointsPresent: Boolean(actualB2C && hasOwn(actualB2C, "points")),
    actualPoints: actualB2C && hasOwn(actualB2C, "points") ? parsePointsValue(actualB2C.points) : null,
    actualB2BPrice: offerPrice(actualB2B),
  };
}

function protectedBlocks(state) {
  const blocks = [];
  if (state.asin !== TARGET.asin) blocks.push(`ASIN_MISMATCH:${state.asin || "(empty)"}`);
  if (!state.productType) blocks.push("PRODUCT_TYPE_MISSING");
  if (!state.buyable) blocks.push(`NOT_BUYABLE:${state.statuses.join(",")}`);
  if (!state.discoverable) blocks.push(`NOT_DISCOVERABLE:${state.statuses.join(",")}`);
  if (state.errorIssues.length) blocks.push(`LISTING_ERRORS:${state.errorIssues.map(x => String(x?.code || "")).join(",")}`);
  if (!(state.availableQuantity > 0)) blocks.push(`NO_INVENTORY:${state.availableQuantity}`);
  if (state.consumerCount !== 1) blocks.push(`CONSUMER_OFFER_COUNT:${state.consumerCount}`);
  if (state.b2bCount !== 1) blocks.push(`B2B_OFFER_COUNT:${state.b2bCount}`);
  if (state.salePrice !== null || state.activeSaleCount !== 0) blocks.push(`ACTIVE_SALE_PRESENT:${state.salePrice}`);
  if (state.minimumSellerAllowed !== TARGET.minimumSellerAllowed) blocks.push(`MINIMUM_DRIFT:${state.minimumSellerAllowed}`);
  if (TARGET.targetNormal < Math.max(TARGET.economicFloor, TARGET.minimumSellerAllowed)) blocks.push("TARGET_BELOW_SAFE_FLOOR");
  if (state.b2bPrice !== TARGET.b2bAttributePrice) blocks.push(`B2B_ATTRIBUTE_DRIFT:${state.b2bPrice}`);
  if (state.activeQuantityDiscountCount !== 0) blocks.push(`QTY_PLAN_ACTIVE:${state.activeQuantityDiscountCount}`);
  return blocks;
}
function beforeLiveBlocks(state) {
  const blocks = protectedBlocks(state);
  if (!state.normalRef) blocks.push("ACTIVE_NORMAL_SCHEDULE_MISSING");
  if (state.normalPrice !== TARGET.currentNormal) blocks.push(`NORMAL_PRICE_DRIFT:${state.normalPrice}`);
  if (state.actualB2CPrice !== TARGET.currentNormal) blocks.push(`ACTUAL_B2C_DRIFT:${state.actualB2CPrice}`);
  if (!state.actualPointsPresent || state.actualPoints !== TARGET.amazonPointsBefore) blocks.push(`POINTS_DRIFT:${state.actualPoints}`);
  return blocks;
}
function appliedBlocks(state) {
  const blocks = protectedBlocks(state);
  if (state.normalPrice !== TARGET.targetNormal) blocks.push(`NORMAL_NOT_TARGET:${state.normalPrice}`);
  if (state.actualB2CPrice !== TARGET.targetNormal) blocks.push(`ACTUAL_B2C_NOT_TARGET:${state.actualB2CPrice}`);
  if (!state.actualPointsPresent || state.actualPoints === null) blocks.push("AMAZON_POINTS_MISSING_POSTLIVE");
  return blocks;
}

function buildTargetOffers(state) {
  const before = clone(state.offers);
  const after = clone(state.offers);
  const consumer = after[state.consumerIndex];
  if (!consumer) throw new Error("consumer offer missing");
  const ref = activeScheduleRef(consumer, "our_price", Date.now());
  if (!ref) throw new Error("active consumer our_price missing");
  consumer.our_price[ref.groupIndex].schedule[ref.scheduleIndex].value_with_tax = TARGET.targetNormal;

  const normalized = clone(after);
  normalized[state.consumerIndex].our_price[ref.groupIndex].schedule[ref.scheduleIndex].value_with_tax = TARGET.currentNormal;
  if (!jsonEqual(normalized, before)) throw new Error("NON_TARGET_PURCHASABLE_OFFER_DRIFT");
  return { offers: after, targetOffersHash: sha256(JSON.stringify(after)) };
}

function publicState(state) {
  return {
    normalPrice: state.normalPrice,
    actualOfferB2CPrice: state.actualB2CPrice,
    amazonPoints: state.actualPoints,
    minimumSellerAllowed: state.minimumSellerAllowed,
    maximumSellerAllowed: state.maximumSellerAllowed,
    b2bAttributePrice: state.b2bPrice,
    actualOfferB2BPrice: state.actualB2BPrice,
    activeQuantityDiscountCount: state.activeQuantityDiscountCount,
    activeSalePrice: state.salePrice,
    buyable: state.buyable,
    discoverable: state.discoverable,
    errorCount: state.errorIssues.length,
    availableQuantity: state.availableQuantity,
  };
}
function summarizeIssues(issues) {
  return (Array.isArray(issues) ? issues : []).map(issue => ({ code: String(issue?.code || ""), severity: String(issue?.severity || ""), message: String(issue?.message || "").slice(0, 1000) }));
}

function signFingerprint(payload, secret) {
  const body = base64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyFingerprint(fingerprint, secret) {
  const parts = String(fingerprint || "").split(".");
  if (parts.length !== 2) return { ok: false, error: "FINGERPRINT_FORMAT" };
  const [body, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "FINGERPRINT_SIGNATURE" };
  let payload;
  try { payload = JSON.parse(base64urlDecode(body)); } catch { return { ok: false, error: "FINGERPRINT_PAYLOAD" }; }
  if (String(payload.moduleVersion || "") !== MODULE_VERSION) return { ok: false, error: "FINGERPRINT_VERSION" };
  if (String(payload.sku || "") !== TARGET.sku || String(payload.asin || "") !== TARGET.asin) return { ok: false, error: "FINGERPRINT_IDENTITY" };
  if (Number(payload.currentNormal) !== TARGET.currentNormal || Number(payload.targetNormal) !== TARGET.targetNormal) return { ok: false, error: "FINGERPRINT_PRICE_SCOPE" };
  if (!(Number(payload.expiresAtMs) > Date.now())) return { ok: false, error: "FINGERPRINT_EXPIRED" };
  return { ok: true, payload };
}
function makeFingerprint(state, built, secret) {
  const issuedAtMs = Date.now();
  const payload = {
    moduleVersion: MODULE_VERSION,
    sku: TARGET.sku,
    asin: TARGET.asin,
    currentNormal: TARGET.currentNormal,
    targetNormal: TARGET.targetNormal,
    economicFloor: TARGET.economicFloor,
    minimumSellerAllowed: TARGET.minimumSellerAllowed,
    b2bAttributePrice: TARGET.b2bAttributePrice,
    amazonPointsBefore: TARGET.amazonPointsBefore,
    availableQuantity: state.availableQuantity,
    productType: state.productType,
    targetOffersHash: built.targetOffersHash,
    issuedAtMs,
    expiresAtMs: issuedAtMs + FINGERPRINT_TTL_MINUTES * 60 * 1000,
  };
  return { fingerprint: signFingerprint(payload, secret), hash: sha256(JSON.stringify(payload)), expiresAt: new Date(payload.expiresAtMs).toISOString() };
}

function authorize(req, res) {
  const secret = getSecret();
  if (!secret) {
    res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, decision: "CONFIG_ERROR", externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    return null;
  }
  if (String(req.headers["x-api-secret"] || "") !== secret) {
    res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, decision: "UNAUTHORIZED", externalChanges: 0, error: "Unauthorized" });
    return null;
  }
  return secret;
}

async function verifyApplied(accessToken) {
  let state = null;
  let error = "";
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    try {
      state = analyzeListing(await getListing(accessToken), Date.now());
      const blocks = appliedBlocks(state);
      if (!blocks.length) return { ok: true, attempt, state, blocks: [] };
      error = blocks.join("|");
    } catch (err) { error = err?.message || String(err); }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return { ok: false, attempt: VERIFY_ATTEMPTS, state, blocks: state ? appliedBlocks(state) : [], error };
}

async function dryHandler(req, res) {
  try {
    const secret = authorize(req, res); if (!secret) return;
    const accessToken = await getLwaAccessToken();
    const first = analyzeListing(await getListing(accessToken), Date.now());
    if (first.normalPrice === TARGET.targetNormal && first.actualB2CPrice === TARGET.targetNormal) {
      const blocks = appliedBlocks(first);
      return res.status(blocks.length ? 409 : 200).json({ ok: !blocks.length, moduleVersion: MODULE_VERSION, route: DRY_ROUTE, decision: blocks.length ? "TARGET_ALREADY_PRESENT_BUT_PROTECTED_STATE_INVALID" : "ALREADY_APPLIED_S73_49800", validationPreviewCalls: 0, liveCalls: 0, externalChanges: 0, blocks, state: publicState(first) });
    }
    const firstBlocks = beforeLiveBlocks(first);
    if (firstBlocks.length) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: DRY_ROUTE, decision: "PRECHECK_BLOCKED_NO_MUTATION", validationPreviewCalls: 0, liveCalls: 0, externalChanges: 0, blocks: firstBlocks, state: publicState(first) });

    const built1 = buildTargetOffers(first);
    const preview = await patchListing(accessToken, first.productType, built1.offers, true);
    if (preview.errors.length) return res.status(422).json({ ok: false, moduleVersion: MODULE_VERSION, route: DRY_ROUTE, decision: "VALIDATION_PREVIEW_FAILED_NO_MUTATION", validationPreviewCalls: 1, validationIssues: summarizeIssues(preview.issues), liveCalls: 0, externalChanges: 0 });

    const second = analyzeListing(await getListing(accessToken), Date.now());
    const secondBlocks = beforeLiveBlocks(second);
    if (secondBlocks.length) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: DRY_ROUTE, decision: "POST_PREVIEW_FRESH_DRIFT_NO_MUTATION", validationPreviewCalls: 1, liveCalls: 0, externalChanges: 0, blocks: secondBlocks, state: publicState(second) });
    const built2 = buildTargetOffers(second);
    if (built1.targetOffersHash !== built2.targetOffersHash) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: DRY_ROUTE, decision: "TARGET_OFFER_SHAPE_DRIFT_NO_MUTATION", validationPreviewCalls: 1, liveCalls: 0, externalChanges: 0 });

    const fp = makeFingerprint(second, built2, secret);
    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: DRY_ROUTE,
      decision: "DRY_RUN_READY_FOR_S73_49800_NO_MUTATION",
      approvedScope: { sku: TARGET.sku, asin: TARGET.asin, currentNormal: TARGET.currentNormal, targetNormal: TARGET.targetNormal, economicFloor: TARGET.economicFloor, minimumSellerAllowed: TARGET.minimumSellerAllowed },
      before: publicState(second),
      target: { normalPrice: TARGET.targetNormal },
      validationPreviewCalls: 1,
      validationIssues: summarizeIssues(preview.issues),
      dryRunFingerprint: fp.fingerprint,
      dryRunHash: fp.hash,
      expiresAt: fp.expiresAt,
      liveCalls: 0,
      persistentAmazonWrites: 0,
      amazonAdsWrites: 0,
      yahooWrites: 0,
      externalChanges: 0,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, route: DRY_ROUTE, decision: "DRY_RUN_ERROR_NO_LIVE_MUTATION", liveCalls: 0, persistentAmazonWrites: 0, externalChanges: 0, error: err?.message || String(err) });
  }
}

async function liveHandler(req, res) {
  let liveCallMade = false;
  let validationPreviewCalls = 0;
  try {
    const secret = authorize(req, res); if (!secret) return;
    if (String(req.body?.liveConfirm || "") !== LIVE_CONFIRM) return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "LIVE_CONFIRM_MISMATCH", liveCalls: 0, externalChanges: 0 });
    const checked = verifyFingerprint(String(req.body?.dryRunFingerprint || ""), secret);
    if (!checked.ok) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: checked.error, liveCalls: 0, externalChanges: 0 });

    const accessToken = await getLwaAccessToken();
    const first = analyzeListing(await getListing(accessToken), Date.now());
    if (first.normalPrice === TARGET.targetNormal && first.actualB2CPrice === TARGET.targetNormal) {
      const blocks = appliedBlocks(first);
      return res.status(blocks.length ? 409 : 200).json({ ok: !blocks.length, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: blocks.length ? "TARGET_ALREADY_PRESENT_BUT_PROTECTED_STATE_INVALID" : "ALREADY_APPLIED_S73_49800", liveCalls: 0, externalChanges: 0, blocks, state: publicState(first) });
    }
    const firstBlocks = beforeLiveBlocks(first);
    if (firstBlocks.length) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "LIVE_PRECHECK_BLOCKED_NO_MUTATION", liveCalls: 0, externalChanges: 0, blocks: firstBlocks, state: publicState(first) });

    const built1 = buildTargetOffers(first);
    if (built1.targetOffersHash !== String(checked.payload.targetOffersHash || "")) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "DRY_FINGERPRINT_OFFER_SHAPE_DRIFT_NO_MUTATION", liveCalls: 0, externalChanges: 0 });

    const preview = await patchListing(accessToken, first.productType, built1.offers, true);
    validationPreviewCalls = 1;
    if (preview.errors.length) return res.status(422).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "LIVE_GATE_VALIDATION_PREVIEW_FAILED_NO_MUTATION", validationPreviewCalls, validationIssues: summarizeIssues(preview.issues), liveCalls: 0, externalChanges: 0 });

    const second = analyzeListing(await getListing(accessToken), Date.now());
    const secondBlocks = beforeLiveBlocks(second);
    if (secondBlocks.length) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "POST_PREVIEW_FRESH_DRIFT_NO_LIVE_MUTATION", validationPreviewCalls, liveCalls: 0, externalChanges: 0, blocks: secondBlocks, state: publicState(second) });
    const built2 = buildTargetOffers(second);
    if (built2.targetOffersHash !== String(checked.payload.targetOffersHash || "")) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "POST_PREVIEW_TARGET_SHAPE_DRIFT_NO_LIVE_MUTATION", validationPreviewCalls, liveCalls: 0, externalChanges: 0 });

    const live = await patchListing(accessToken, second.productType, built2.offers, false);
    liveCallMade = true;
    if (live.errors.length) {
      const afterError = analyzeListing(await getListing(accessToken), Date.now());
      const applied = !appliedBlocks(afterError).length;
      return res.status(applied ? 200 : 422).json({ ok: applied, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: applied ? "S73_49800_LIVE_PASS_DESPITE_RESPONSE_ISSUES" : "LIVE_REJECTED_OR_UNCONFIRMED_DO_NOT_RERUN", validationPreviewCalls, validationIssues: summarizeIssues(live.issues), liveCalls: 1, persistentAmazonWrites: applied ? 1 : 0, externalChanges: 1, mutationState: applied ? "VERIFIED_APPLIED" : "LIVE_CALL_MADE_TREAT_AS_POSSIBLY_SENT", state: publicState(afterError), nextStep: applied ? "FRESH_COMPLETE" : "RUN_AUDIT_ONLY_DO_NOT_RERUN_LIVE" });
    }

    const verify = await verifyApplied(accessToken);
    if (!verify.ok) return res.status(202).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "LIVE_SUBMITTED_POSTVERIFY_INCOMPLETE_DO_NOT_RERUN", validationPreviewCalls, liveCalls: 1, persistentAmazonWrites: 0, externalChanges: 1, mutationState: "LIVE_CALL_MADE_TREAT_AS_POSSIBLY_SENT", verifyAttempts: verify.attempt, verifyBlocks: verify.blocks, verifyError: verify.error, state: verify.state ? publicState(verify.state) : null, nextStep: "RUN_AUDIT_ONLY_DO_NOT_RERUN_LIVE" });

    return res.status(200).json({ ok: true, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: "S73_49800_LIVE_PASS", approvedChange: { sku: TARGET.sku, asin: TARGET.asin, normalPriceBefore: TARGET.currentNormal, normalPriceAfter: TARGET.targetNormal }, validationPreviewCalls, liveCalls: 1, persistentAmazonWrites: 1, amazonAdsWrites: 0, yahooWrites: 0, externalChanges: 1, mutationState: "VERIFIED_APPLIED", verifyAttempts: verify.attempt, before: publicState(second), after: publicState(verify.state), nextStep: "SYNC_PRICE_SSOT_AND_COMPLETE" });
  } catch (err) {
    return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE, decision: liveCallMade ? "ERROR_AFTER_LIVE_CALL_DO_NOT_RERUN" : "ERROR_BEFORE_LIVE_CALL_NO_MUTATION", validationPreviewCalls, liveCalls: liveCallMade ? 1 : 0, persistentAmazonWrites: 0, amazonAdsWrites: 0, yahooWrites: 0, externalChanges: liveCallMade ? 1 : 0, mutationState: liveCallMade ? "LIVE_CALL_MADE_TREAT_AS_POSSIBLY_SENT" : "NO_LIVE_CALL", error: err?.message || String(err), nextStep: liveCallMade ? "RUN_AUDIT_ONLY_DO_NOT_RERUN_LIVE" : "INSPECT_ERROR_BEFORE_RETRY" });
  }
}

async function auditHandler(req, res) {
  try {
    const secret = authorize(req, res); if (!secret) return;
    const accessToken = await getLwaAccessToken();
    const state = analyzeListing(await getListing(accessToken), Date.now());
    const blocks = state.normalPrice === TARGET.targetNormal ? appliedBlocks(state) : beforeLiveBlocks(state);
    const completed = state.normalPrice === TARGET.targetNormal && state.actualB2CPrice === TARGET.targetNormal && blocks.length === 0;
    return res.status(200).json({ ok: true, moduleVersion: MODULE_VERSION, route: AUDIT_ROUTE, decision: completed ? "S73_49800_FRESH_COMPLETED" : "S73_49800_FRESH_NOT_COMPLETED", completed, blocks, state: publicState(state), liveCalls: 0, persistentAmazonWrites: 0, amazonAdsWrites: 0, yahooWrites: 0, externalChanges: 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, route: AUDIT_ROUTE, decision: "AUDIT_ERROR_READ_ONLY", liveCalls: 0, persistentAmazonWrites: 0, externalChanges: 0, error: err?.message || String(err) });
  }
}

express.application.listen = function s7349800PriceListen(...args) {
  const stack = this?._router?.stack || [];
  const hasDry = Boolean(stack.some(layer => layer?.route?.path === DRY_ROUTE));
  const hasLive = Boolean(stack.some(layer => layer?.route?.path === LIVE_ROUTE));
  const hasAudit = Boolean(stack.some(layer => layer?.route?.path === AUDIT_ROUTE));
  if (!hasDry) this.post(DRY_ROUTE, dryHandler);
  if (!hasLive) this.post(LIVE_ROUTE, liveHandler);
  if (!hasAudit) this.post(AUDIT_ROUTE, auditHandler);
  return originalListen.apply(this, args);
};
