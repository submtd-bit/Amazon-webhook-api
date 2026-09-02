import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon B2B approved-eight exact base-price LIVE v1.0.0
 * 2026-09-02
 *
 * User-approved scope: exactly eight Seller SKUs.
 * Changes ONLY the explicit B2B our_price target.
 * Preserves consumer offer, Amazon points, minimum/maximum seller prices,
 * discounted_price, inventory, and all quantity-discount fields.
 *
 * Safety flow:
 * 1) Fresh GET all 8 and exact preflight against approved current state.
 * 2) VALIDATION_PREVIEW all 8. No persistent mutation.
 * 3) Fresh GET all 8 and exact second preflight.
 * 4) For each SKU: Fresh guard -> one LIVE PATCH (never retried) -> Fresh postverify.
 * 5) If any LIVE call was attempted, caller must never rerun the LIVE batch.
 *    Use the READ ONLY audit route instead.
 */
const MODULE_VERSION = "2026-09-02-amazon-b2b-approved-eight-live-v1.0.0";
const LIVE_ROUTE = "/amazon/price/b2b/approved-eight/live";
const AUDIT_ROUTE = "/amazon/price/b2b/approved-eight/audit";
const LIVE_CONFIRM = "AMAZON_B2B_APPROVED8_LIVE_20260902_V1";
const REQUEST_TIMEOUT_MS = 20000;
const READ_RETRIES = 3;
const RETRY_BASE_MS = 700;
const VERIFY_ATTEMPTS = 8;
const VERIFY_WAIT_MS = 1800;
const originalListen = express.application.listen;

const APPROVED = Object.freeze([
  Object.freeze({
    sku: "cf-sv8-i5-8gb-ssd256", asin: "B0GH792325",
    normal: 30000, effective: 30000, points: 300, min: 27000,
    currentB2b: 44000, targetB2b: 28500, qtyPlan: null,
  }),
  Object.freeze({
    sku: "IB-8QMD-0078", asin: "B0FQCTCH8M",
    normal: 79000, effective: 79000, points: 790, min: 53000,
    currentB2b: 76646, targetB2b: 75000, qtyPlan: null,
  }),
  Object.freeze({
    sku: "cf-sv9-i5-8gb-ssd1", asin: "B0GH77Z9M5",
    normal: 70000, effective: 70000, points: 700, min: 61000,
    currentB2b: 67914, targetB2b: 66500, qtyPlan: null,
  }),
  Object.freeze({
    sku: "cf-sv9-i5-8gb-ssd256", asin: "B0GH6ZT2X2",
    normal: 42000, effective: 42000, points: 420, min: 38000,
    currentB2b: 64000, targetB2b: 39900, qtyPlan: null,
  }),
  Object.freeze({
    sku: "55-4W0H-JKMS", asin: "B0FQCTDLG1",
    normal: 70000, effective: 70000, points: 700, min: 44000,
    currentB2b: 67914, targetB2b: 66500, qtyPlan: null,
  }),
  Object.freeze({
    sku: "CH-CIRX-CP7X", asin: "B0FPC2HV45",
    normal: 46800, effective: 46800, points: 468, min: 44000,
    currentB2b: 70300, targetB2b: 44400,
    qtyPlan: Object.freeze({
      discountType: "percent",
      levels: Object.freeze([
        Object.freeze({ lowerBound: 5, value: 5 }),
        Object.freeze({ lowerBound: 10, value: 7 }),
      ]),
    }),
  }),
  Object.freeze({
    sku: "g83-i5-11-8gb-ssd256", asin: "B0GN84QRCF",
    normal: 51000, effective: 51000, points: 510, min: null,
    currentB2b: 49480, targetB2b: 48400, qtyPlan: null,
  }),
  Object.freeze({
    sku: "latitude5330-i5-12g-16gb-ssd512", asin: "B0HH3ST712",
    normal: 64800, effective: 64800, points: 648, min: 58320,
    currentB2b: 62869, targetB2b: 61500, qtyPlan: null,
  }),
]);

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
function jsonEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    for (const key of ["amount", "Amount", "value", "Value", "pointsNumber", "PointsNumber", "points_number"]) {
      if (value[key] !== undefined) return numberOrNull(value[key]);
    }
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function epochOrNull(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : null;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
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

async function amazonRequest(url, options, allowRetry) {
  const attempts = allowRetry ? READ_RETRIES : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const json = safeJsonParse(await response.text());
      if (response.ok) return { response, json };
      const retryable = response.status === 429 || response.status >= 500;
      if (!allowRetry || !retryable || attempt === attempts) {
        const err = new Error(`SP-API error: ${response.status} ${JSON.stringify(json).slice(0, 2500)}`);
        err.amazonBody = json;
        throw err;
      }
      await sleep(RETRY_BASE_MS * attempt);
    } catch (err) {
      lastError = err;
      if (!allowRetry || attempt === attempts) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  return (await amazonRequest(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  }, true)).json;
}

async function patchListing(accessToken, sku, productType, offers, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  if (validationPreview) q.set("mode", "VALIDATION_PREVIEW");
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  const body = {
    productType,
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }],
  };
  const json = (await amazonRequest(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, validationPreview)).json;
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  return { json, issues, errors };
}

function scheduleEntries(offer, key) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  const all = [];
  groups.forEach((group, groupIndex) => {
    const schedules = Array.isArray(group?.schedule) ? group.schedule : [];
    schedules.forEach((schedule, scheduleIndex) => all.push({ groupIndex, scheduleIndex, schedule }));
  });
  return all;
}
function scheduleIsActive(schedule, now) {
  const start = epochOrNull(schedule?.start_at);
  const end = epochOrNull(schedule?.end_at);
  if (start !== null && now < start) return false;
  if (end !== null && now >= end) return false;
  return true;
}
function activeScheduleRef(offer, key, now) {
  return scheduleEntries(offer, key)
    .filter(x => scheduleIsActive(x.schedule, now))
    .sort((a, b) => (epochOrNull(b.schedule?.start_at) ?? 0) - (epochOrNull(a.schedule?.start_at) ?? 0))[0] || null;
}
function activeScheduleValue(offer, key, now) {
  return numberOrNull(activeScheduleRef(offer, key, now)?.schedule?.value_with_tax);
}
function audienceValue(offer) {
  if (!offer) return "";
  if (typeof offer.audience === "string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value || offer?.audience?.displayName || "").toUpperCase();
}
function offerType(offer) {
  return String(offer?.offerType || offer?.offer_type || "").toUpperCase();
}
function offerPrice(offer) {
  return offer && hasOwn(offer, "price") ? numberOrNull(offer.price) : null;
}
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
function currentOfferSummary(listing) {
  const { marketplaceId } = getConfig();
  const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const market = offers.filter(o => {
    const id = String(o?.marketplaceId || o?.marketplace_id || "");
    return !id || id === marketplaceId;
  });
  const b2c = market.find(o => offerType(o) === "B2C" || audienceValue(o) === "ALL") || null;
  const b2b = market.find(o => offerType(o) === "B2B" || audienceValue(o) === "B2B") || null;
  return {
    b2cPresent: Boolean(b2c),
    b2cPrice: offerPrice(b2c),
    pointsPresent: Boolean(b2c && hasOwn(b2c, "points")),
    points: b2c && hasOwn(b2c, "points") ? parsePointsValue(b2c.points) : null,
    b2bPresent: Boolean(b2b),
    b2bPrice: offerPrice(b2b),
  };
}

function quantityPlanSummary(offer) {
  const entries = scheduleEntries(offer, "quantity_discount_plan");
  if (!entries.length) return null;
  const active = entries.filter(x => scheduleIsActive(x.schedule, Date.now()));
  if (active.length !== 1 || entries.length !== 1) {
    return {
      invalidShape: true,
      scheduleCount: entries.length,
      activeCount: active.length,
    };
  }
  const schedule = active[0].schedule || {};
  const discountType = String(schedule.discount_type || "").toLowerCase();
  const levels = (Array.isArray(schedule.levels) ? schedule.levels : [])
    .map(level => ({
      lowerBound: numberOrNull(level?.lower_bound),
      value: numberOrNull(level?.value),
    }))
    .filter(level => level.lowerBound !== null && level.value !== null)
    .sort((a, b) => a.lowerBound - b.lowerBound);
  return { discountType, levels };
}
function normalizedQtyPlan(plan) {
  if (!plan) return null;
  if (plan.invalidShape) return plan;
  return {
    discountType: String(plan.discountType || "").toLowerCase(),
    levels: (Array.isArray(plan.levels) ? plan.levels : [])
      .map(x => ({ lowerBound: Number(x.lowerBound), value: Number(x.value) }))
      .sort((a, b) => a.lowerBound - b.lowerBound),
  };
}
function qtyPlanMatches(actual, expected) {
  return jsonEqual(normalizedQtyPlan(actual), normalizedQtyPlan(expected));
}

function analyze(approved, listing, now = Date.now()) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attrs = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const offers = Array.isArray(attrs?.purchasable_offer) ? clone(attrs.purchasable_offer) : [];
  const indexed = offers.map((offer, index) => ({ offer, index }));
  const consumers = indexed.filter(x => audienceValue(x.offer) === "ALL");
  const b2bs = indexed.filter(x => audienceValue(x.offer) === "B2B");
  const consumer = consumers.length === 1 ? consumers[0].offer : null;
  const b2b = b2bs.length === 1 ? b2bs[0].offer : null;
  const normal = activeScheduleValue(consumer, "our_price", now);
  const sale = activeScheduleValue(consumer, "discounted_price", now);
  const effective = sale !== null ? sale : normal;
  const min = activeScheduleValue(consumer, "minimum_seller_allowed_price", now);
  const max = activeScheduleValue(consumer, "maximum_seller_allowed_price", now);
  const qty = numberOrNull(listing?.fulfillmentAvailability?.[0]?.quantity)
    ?? numberOrNull(attrs?.fulfillment_availability?.[0]?.quantity)
    ?? 0;
  const actual = currentOfferSummary(listing);
  const b2bAttributePrice = b2b ? activeScheduleValue(b2b, "our_price", now) : null;
  const currentAuthorityB2b = b2bAttributePrice !== null ? b2bAttributePrice : actual.b2bPrice;
  const qtyPlan = b2b ? quantityPlanSummary(b2b) : null;
  return {
    approved,
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    errors,
    qty,
    offers,
    consumerIndex: consumers.length === 1 ? consumers[0].index : -1,
    b2bIndex: b2bs.length === 1 ? b2bs[0].index : -1,
    consumer,
    b2b,
    consumerCount: consumers.length,
    b2bCount: b2bs.length,
    normal,
    sale,
    effective,
    min,
    max,
    actual,
    b2bAttributePrice,
    currentAuthorityB2b,
    qtyPlan,
  };
}

function preflightBlocks(state, expectedB2b) {
  const a = state.approved;
  const blocks = [];
  if (state.asin !== a.asin) blocks.push(`ASIN_MISMATCH:${state.asin}`);
  if (!state.productType) blocks.push("PRODUCT_TYPE_MISSING");
  if (!state.buyable) blocks.push(`NOT_BUYABLE:${state.statuses.join(",")}`);
  if (state.errors.length) blocks.push(`LISTING_ERRORS:${state.errors.map(x => String(x?.code || "")).join(",")}`);
  if (!(state.qty > 0)) blocks.push(`NO_INVENTORY:${state.qty}`);
  if (state.consumerCount !== 1) blocks.push(`CONSUMER_OFFER_COUNT:${state.consumerCount}`);
  if (state.b2bCount > 1) blocks.push(`B2B_ATTRIBUTE_COUNT:${state.b2bCount}`);
  if (!state.actual.b2cPresent || state.actual.b2cPrice === null) blocks.push("ACTUAL_B2C_OFFER_MISSING");
  if (!state.actual.b2bPresent || state.actual.b2bPrice === null) blocks.push("ACTUAL_B2B_OFFER_MISSING");
  if (!state.actual.pointsPresent || state.actual.points === null) blocks.push("AMAZON_POINTS_MISSING");
  if (state.normal !== a.normal) blocks.push(`NORMAL_PRICE_DRIFT:${state.normal}`);
  if (state.effective !== a.effective) blocks.push(`EFFECTIVE_PRICE_DRIFT:${state.effective}`);
  if (state.actual.b2cPrice !== a.effective) blocks.push(`ACTUAL_B2C_DRIFT:${state.actual.b2cPrice}`);
  if (state.actual.points !== a.points) blocks.push(`POINTS_DRIFT:${state.actual.points}`);
  if (state.min !== a.min) blocks.push(`MINIMUM_DRIFT:${state.min}`);
  if (state.currentAuthorityB2b !== expectedB2b) blocks.push(`CURRENT_B2B_DRIFT:${state.currentAuthorityB2b}`);
  if (!qtyPlanMatches(state.qtyPlan, a.qtyPlan)) blocks.push(`QUANTITY_PLAN_DRIFT:${JSON.stringify(state.qtyPlan)}`);
  if (a.targetB2b < (a.min === null ? 0 : a.min)) blocks.push(`TARGET_BELOW_MIN:${a.targetB2b}<${a.min}`);
  if (state.effective === null || a.targetB2b >= state.effective) blocks.push(`TARGET_NOT_BELOW_EFFECTIVE:${a.targetB2b}>=${state.effective}`);
  return [...new Set(blocks)];
}

function priceTemplateFrom(offer) {
  return Array.isArray(offer?.our_price) && offer.our_price.length ? clone(offer.our_price[0] || {}) : null;
}
function setExistingOfferPrice(offer, target, templateOffer) {
  const ref = activeScheduleRef(offer, "our_price", Date.now());
  if (ref && Array.isArray(offer?.our_price)) {
    offer.our_price = clone(offer.our_price);
    offer.our_price[ref.groupIndex].schedule[ref.scheduleIndex].value_with_tax = target;
    return "OWN_OUR_PRICE_ACTIVE_LEAF";
  }
  const fallbackTemplate = priceTemplateFrom(templateOffer);
  if (!fallbackTemplate) throw new Error("our_price template missing");
  fallbackTemplate.schedule = [{ value_with_tax: target }];
  offer.our_price = [fallbackTemplate];
  return "SEEDED_OUR_PRICE_FROM_CONSUMER";
}
function seedNewB2BPrice(offer, target, templateOffer) {
  const template = priceTemplateFrom(templateOffer);
  if (!template) throw new Error("consumer our_price template missing");
  template.schedule = [{ value_with_tax: target }];
  offer.our_price = [template];
}

function buildTargetOffers(state) {
  const before = clone(state.offers);
  const after = clone(state.offers);
  let mode = "";

  if (state.b2bIndex >= 0) {
    const beforeB2B = clone(before[state.b2bIndex]);
    const b2b = clone(after[state.b2bIndex]);
    const beforeQty = clone(beforeB2B?.quantity_discount_plan ?? null);
    const priceMode = setExistingOfferPrice(b2b, state.approved.targetB2b, state.consumer);
    if (!jsonEqual(clone(b2b?.quantity_discount_plan ?? null), beforeQty)) {
      throw new Error("B2B quantity_discount_plan changed while building target");
    }
    const normalized = clone(b2b);
    normalized.our_price = clone(beforeB2B.our_price);
    if (!jsonEqual(normalized, beforeB2B)) {
      throw new Error("B2B offer changed outside our_price");
    }
    after[state.b2bIndex] = b2b;
    mode = priceMode === "OWN_OUR_PRICE_ACTIVE_LEAF"
      ? "REPLACE_EXPLICIT_B2B_ATTRIBUTE_PRESERVE_ALL_OTHER_FIELDS"
      : "REPLACE_EXPLICIT_B2B_ATTRIBUTE_SEEDED_OUR_PRICE_PRESERVE_ALL_OTHER_FIELDS";
  } else {
    if (state.approved.qtyPlan !== null) {
      throw new Error("Approved quantity plan requires existing explicit B2B attribute");
    }
    const b2b = clone(state.consumer);
    b2b.audience = "B2B";
    delete b2b.discounted_price;
    delete b2b.minimum_seller_allowed_price;
    delete b2b.maximum_seller_allowed_price;
    delete b2b.quantity_discount_plan;
    seedNewB2BPrice(b2b, state.approved.targetB2b, state.consumer);
    after.push(b2b);
    mode = "APPEND_EXPLICIT_B2B_ATTRIBUTE";
  }

  for (let i = 0; i < before.length; i += 1) {
    if (i === state.b2bIndex) continue;
    if (!jsonEqual(before[i], after[i])) throw new Error(`EXISTING_OFFER_CHANGED:${i}`);
  }
  return { offers: after, mode };
}

function hardPostverifyBlocks(state) {
  const a = state.approved;
  const blocks = [];
  if (state.asin !== a.asin) blocks.push(`POST_ASIN_MISMATCH:${state.asin}`);
  if (!state.productType) blocks.push("POST_PRODUCT_TYPE_MISSING");
  if (!state.buyable) blocks.push(`POST_NOT_BUYABLE:${state.statuses.join(",")}`);
  if (state.errors.length) blocks.push(`POST_LISTING_ERRORS:${state.errors.map(x => String(x?.code || "")).join(",")}`);
  if (!(state.qty > 0)) blocks.push(`POST_NO_INVENTORY:${state.qty}`);
  if (state.consumerCount !== 1) blocks.push(`POST_CONSUMER_OFFER_COUNT:${state.consumerCount}`);
  if (state.b2bCount !== 1) blocks.push(`POST_B2B_ATTRIBUTE_COUNT:${state.b2bCount}`);
  if (!state.b2b) blocks.push("POST_B2B_ATTRIBUTE_MISSING");
  if (state.b2bAttributePrice !== a.targetB2b) blocks.push(`POST_B2B_ATTRIBUTE_PRICE:${state.b2bAttributePrice}`);
  if (state.normal !== a.normal) blocks.push(`POST_NORMAL_PRICE_DRIFT:${state.normal}`);
  if (state.effective !== a.effective) blocks.push(`POST_EFFECTIVE_PRICE_DRIFT:${state.effective}`);
  if (!state.actual.b2cPresent || state.actual.b2cPrice !== a.effective) blocks.push(`POST_ACTUAL_B2C_DRIFT:${state.actual.b2cPrice}`);
  if (!state.actual.pointsPresent || state.actual.points !== a.points) blocks.push(`POST_POINTS_DRIFT:${state.actual.points}`);
  if (state.min !== a.min) blocks.push(`POST_MINIMUM_DRIFT:${state.min}`);
  if (!qtyPlanMatches(state.qtyPlan, a.qtyPlan)) blocks.push(`POST_QUANTITY_PLAN_DRIFT:${JSON.stringify(state.qtyPlan)}`);
  return [...new Set(blocks)];
}

function propagationPending(state) {
  return !state.actual.b2bPresent || state.actual.b2bPrice !== state.approved.targetB2b;
}

async function verifyApplied(accessToken, approved) {
  let state = null;
  let blocks = [];
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    state = analyze(approved, await getListing(accessToken, approved.sku), Date.now());
    blocks = hardPostverifyBlocks(state);
    if (!blocks.length) {
      return {
        hardVerified: true,
        actualConverged: !propagationPending(state),
        attempt,
        state,
        blocks: [],
      };
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return {
    hardVerified: false,
    actualConverged: false,
    attempt: VERIFY_ATTEMPTS,
    state,
    blocks,
  };
}

function stateSummary(state) {
  if (!state) return null;
  return {
    sku: state.approved.sku,
    asin: state.asin,
    normalPrice: state.normal,
    effectivePrice: state.effective,
    amazonPoints: state.actual.points,
    minimumSellerAllowed: state.min,
    maximumSellerAllowed: state.max,
    b2bAttributePrice: state.b2bAttributePrice,
    actualOfferB2BPrice: state.actual.b2bPrice,
    currentAuthorityB2BPrice: state.currentAuthorityB2b,
    quantityPlan: normalizedQtyPlan(state.qtyPlan),
    buyable: state.buyable,
    errorCount: state.errors.length,
    availableQuantity: state.qty,
  };
}

async function readAllStates(accessToken) {
  const states = [];
  for (const approved of APPROVED) {
    states.push(analyze(approved, await getListing(accessToken, approved.sku), Date.now()));
  }
  return states;
}

async function auditHandler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({
      ok: false, moduleVersion: MODULE_VERSION, route: AUDIT_ROUTE,
      decision: "CONFIG_ERROR", amazonReads: 0, amazonWrites: 0, externalChanges: 0,
      error: "AMAZON_STOCK_API_SECRET is not set",
    });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({
      ok: false, moduleVersion: MODULE_VERSION, route: AUDIT_ROUTE,
      decision: "UNAUTHORIZED", amazonReads: 0, amazonWrites: 0, externalChanges: 0,
      error: "Unauthorized",
    });

    const accessToken = await getLwaAccessToken();
    const states = await readAllStates(accessToken);
    const results = states.map(state => ({
      sku: state.approved.sku,
      asin: state.approved.asin,
      targetB2b: state.approved.targetB2b,
      hardPostverifyBlocks: hardPostverifyBlocks(state),
      actualConverged: !propagationPending(state),
      state: stateSummary(state),
    }));
    const hardFailed = results.filter(x => x.hardPostverifyBlocks.length > 0);
    const pending = results.filter(x => !x.actualConverged);
    const decision = hardFailed.length
      ? "READ_ONLY_AUDIT_REVIEW_REQUIRED"
      : (pending.length ? "READ_ONLY_AUDIT_ATTRIBUTE_VERIFIED_PROPAGATION_PENDING" : "READ_ONLY_AUDIT_ALL_8_CONVERGED");
    return res.status(200).json({
      ok: hardFailed.length === 0,
      moduleVersion: MODULE_VERSION,
      route: AUDIT_ROUTE,
      decision,
      targetCount: APPROVED.length,
      hardVerifiedCount: APPROVED.length - hardFailed.length,
      actualConvergedCount: APPROVED.length - pending.length,
      propagationPendingCount: pending.length,
      results,
      amazonReads: APPROVED.length,
      amazonWrites: 0,
      validationPreviewCalls: 0,
      liveCalls: 0,
      persistentAmazonWrites: 0,
      externalChanges: 0,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: AUDIT_ROUTE,
      decision: "READ_ONLY_AUDIT_ERROR",
      amazonWrites: 0,
      validationPreviewCalls: 0,
      liveCalls: 0,
      persistentAmazonWrites: 0,
      externalChanges: 0,
      error: String(err?.message || err),
    });
  }
}

async function liveHandler(req, res) {
  let validationPreviewCalls = 0;
  let liveCalls = 0;
  const completed = [];
  let activeLiveSku = null;

  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({
      ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
      decision: "CONFIG_ERROR", validationPreviewCalls: 0,
      persistentAmazonWrites: 0, liveCalls: 0, externalChanges: 0,
      error: "AMAZON_STOCK_API_SECRET is not set",
    });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({
      ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
      decision: "UNAUTHORIZED", validationPreviewCalls: 0,
      persistentAmazonWrites: 0, liveCalls: 0, externalChanges: 0,
      error: "Unauthorized",
    });
    if (String(req.body?.confirm || "") !== LIVE_CONFIRM) return res.status(400).json({
      ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
      decision: "LIVE_CONFIRM_MISMATCH", validationPreviewCalls: 0,
      persistentAmazonWrites: 0, liveCalls: 0, externalChanges: 0,
      error: `confirm must equal ${LIVE_CONFIRM}`,
    });

    const accessToken = await getLwaAccessToken();

    const firstStates = await readAllStates(accessToken);
    const firstFailures = firstStates
      .map(state => ({
        sku: state.approved.sku,
        blocks: preflightBlocks(state, state.approved.currentB2b),
        state: stateSummary(state),
      }))
      .filter(x => x.blocks.length);
    if (firstFailures.length) return res.status(409).json({
      ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
      decision: "PREFLIGHT_BLOCKED_NO_LIVE",
      validationPreviewCalls: 0, persistentAmazonWrites: 0, liveCalls: 0, externalChanges: 0,
      failures: firstFailures,
    });

    for (const state of firstStates) {
      const built = buildTargetOffers(state);
      const preview = await patchListing(accessToken, state.approved.sku, state.productType, built.offers, true);
      validationPreviewCalls += 1;
      if (preview.errors.length) return res.status(422).json({
        ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
        decision: "VALIDATION_PREVIEW_FAILED_NO_LIVE",
        validationPreviewCalls, persistentAmazonWrites: 0, liveCalls: 0, externalChanges: 0,
        sku: state.approved.sku, issues: preview.issues,
      });
    }

    const secondStates = await readAllStates(accessToken);
    const secondFailures = secondStates
      .map(state => ({
        sku: state.approved.sku,
        blocks: preflightBlocks(state, state.approved.currentB2b),
        state: stateSummary(state),
      }))
      .filter(x => x.blocks.length);
    if (secondFailures.length) return res.status(409).json({
      ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
      decision: "SECOND_PREFLIGHT_BLOCKED_NO_LIVE",
      validationPreviewCalls, persistentAmazonWrites: 0, liveCalls: 0, externalChanges: 0,
      failures: secondFailures,
    });

    for (const approved of APPROVED) {
      const fresh = analyze(approved, await getListing(accessToken, approved.sku), Date.now());
      const freshBlocks = preflightBlocks(fresh, approved.currentB2b);
      if (freshBlocks.length) {
        const changed = liveCalls > 0;
        return res.status(changed ? 202 : 409).json({
          ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
          decision: changed ? "PARTIAL_LIVE_APPLIED_DO_NOT_RERUN_BATCH" : "FINAL_PREFLIGHT_BLOCKED_NO_LIVE",
          validationPreviewCalls, liveCalls,
          persistentAmazonWrites: liveCalls,
          externalChanges: liveCalls,
          completed,
          blockedSku: approved.sku,
          blocks: freshBlocks,
          state: stateSummary(fresh),
          nextStep: changed ? "FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH" : undefined,
        });
      }

      const built = buildTargetOffers(fresh);
      activeLiveSku = approved.sku;
      liveCalls += 1;
      const accepted = await patchListing(accessToken, approved.sku, fresh.productType, built.offers, false);
      if (accepted.errors.length) return res.status(202).json({
        ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
        decision: "LIVE_SUBMITTED_WITH_ERROR_ISSUES_DO_NOT_RERUN_BATCH",
        validationPreviewCalls, liveCalls,
        persistentAmazonWrites: liveCalls,
        externalChanges: liveCalls,
        completed,
        activeLiveSku,
        issues: accepted.issues,
        nextStep: "FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH",
      });

      const verification = await verifyApplied(accessToken, approved);
      if (!verification.hardVerified) return res.status(202).json({
        ok: false, moduleVersion: MODULE_VERSION, route: LIVE_ROUTE,
        decision: "LIVE_SUBMITTED_HARD_POSTVERIFY_INCOMPLETE_DO_NOT_RERUN_BATCH",
        validationPreviewCalls, liveCalls,
        persistentAmazonWrites: liveCalls,
        externalChanges: liveCalls,
        completed,
        activeLiveSku,
        verifyAttempts: verification.attempt,
        verifyBlocks: verification.blocks,
        state: stateSummary(verification.state),
        nextStep: "FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH",
      });

      completed.push({
        sku: approved.sku,
        asin: approved.asin,
        fromB2b: approved.currentB2b,
        targetB2b: approved.targetB2b,
        attributeMode: built.mode,
        verifyAttempts: verification.attempt,
        actualConverged: verification.actualConverged,
        state: stateSummary(verification.state),
      });
      activeLiveSku = null;
    }

    const pendingCount = completed.filter(x => !x.actualConverged).length;
    return res.status(pendingCount ? 202 : 200).json({
      ok: pendingCount === 0,
      moduleVersion: MODULE_VERSION,
      route: LIVE_ROUTE,
      decision: pendingCount
        ? "LIVE_B2B8_ALL_8_ATTRIBUTE_VERIFIED_PROPAGATION_PENDING_DO_NOT_RERUN"
        : "LIVE_B2B8_ALL_8_VERIFIED",
      approvedCount: APPROVED.length,
      completedCount: completed.length,
      propagationPendingCount: pendingCount,
      validationPreviewCalls,
      liveCalls,
      persistentAmazonWrites: liveCalls,
      externalChanges: liveCalls,
      completed,
      nextStep: pendingCount
        ? "RUN_APPROVED8_READ_ONLY_AUDIT_ONLY_DO_NOT_RERUN_LIVE"
        : "REFRESH_PRICE_V120_SSOT_FROM_FRESH_STATE",
    });
  } catch (err) {
    const changed = liveCalls > 0;
    return res.status(changed ? 202 : 500).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: LIVE_ROUTE,
      decision: changed
        ? "LIVE_ATTEMPTED_EXCEPTION_DO_NOT_RERUN_BATCH"
        : "PRE_LIVE_EXCEPTION_NO_MUTATION_CONFIRMED",
      validationPreviewCalls,
      liveCalls,
      persistentAmazonWrites: liveCalls,
      externalChanges: liveCalls,
      completed,
      activeLiveSku,
      error: String(err?.message || err),
      nextStep: changed ? "FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH" : "REVIEW_ERROR_BEFORE_ANY_RETRY",
    });
  }
}

express.application.listen = function amazonB2BApproved8Listen(...args) {
  const hasLive = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === LIVE_ROUTE));
  const hasAudit = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === AUDIT_ROUTE));
  if (!hasLive) this.post(LIVE_ROUTE, liveHandler);
  if (!hasAudit) this.post(AUDIT_ROUTE, auditHandler);
  return originalListen.apply(this, args);
};
