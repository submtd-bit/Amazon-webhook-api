import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * CF-SV1 RB-Y7G2-H0EK guarded PRICE TEST dry-run v1.0.1
 * READ + Listings VALIDATION_PREVIEW only. No LIVE route exists.
 *
 * Proposal under review:
 * - B2C normal 56,000 -> 49,800
 * - B2B 53,200 -> 47,300
 * - preserve Amazon minimum 40,500
 * - internal review floor 41,600
 * - exact Product Pricing seller offer must be 56,000 / 560 points
 * - quantity discount remains absent
 * - no Amazon Ads / Yahoo / inventory mutation
 *
 * v1.0.1 quota hardening:
 * - long fail-closed 429 backoff
 * - a cooldown before Product Pricing
 * - exactly ONE Product Pricing request in the DRY transaction
 * - post-preview non-mutation is verified through fresh Listings state
 */

const MODULE_VERSION = "2026-09-01-sv1-49800-price-dryrun-v1.0.1";
const ROUTE = "/amazon/price/sv1-49800/dry-run";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const ITEM_CONDITION = "New";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 5;
const QUOTA_BACKOFF_MS = [15000, 30000, 60000, 90000];
const PRODUCT_PRICING_COOLDOWN_MS = 20000;
const POST_PREVIEW_SETTLE_MS = 2500;
const originalUse = express.application.use;
const originalPost = express.application.post;

const TARGET = Object.freeze({
  sku: "RB-Y7G2-H0EK",
  asin: "B0GZGM1BND",
  currentNormal: 56000,
  targetNormal: 49800,
  currentB2B: 53200,
  targetB2B: 47300,
  minimumSellerAllowed: 40500,
  internalReviewFloor: 41600,
  pointsBefore: 560,
  safetyStock: 2,
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function jsonEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function numberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") {
    for (const k of ["Amount","amount","value","Value","PointsNumber","pointsNumber","points_number"]) {
      if (v && v[k] !== undefined) return numberOrNull(v[k]);
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function epochOrNull(v) {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : null;
}
function scheduleIsActive(s, nowMs) {
  const start = epochOrNull(s?.start_at);
  const end = epochOrNull(s?.end_at);
  if (start !== null && nowMs < start) return false;
  if (end !== null && nowMs >= end) return false;
  return true;
}
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`marketplace mismatch: ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}
async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type:"refresh_token", refresh_token:refreshToken, client_id:clientId, client_secret:clientSecret }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

async function amazonRequest(method, url, accessToken, body, audit) {
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
          ...(body ? { "content-type":"application/json" } : {}),
        },
        ...(body ? { body:JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      const json = safeJsonParse(text);
      if (response.ok) return json;

      if (response.status === 429) {
        audit.quota429Count += 1;
        if (attempt === MAX_RETRIES) throw new Error(`SP-API ${method} 429: ${JSON.stringify(json).slice(0,2500)}`);
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.ceil(retryAfter * 1000)
          : QUOTA_BACKOFF_MS[Math.min(attempt - 1, QUOTA_BACKOFF_MS.length - 1)];
        audit.quotaWaitMs += waitMs;
        await sleep(waitMs);
        continue;
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = Math.min(10000, 1500 * attempt);
        audit.serverRetryCount += 1;
        await sleep(waitMs);
        continue;
      }

      throw new Error(`SP-API ${method} ${response.status}: ${JSON.stringify(json).slice(0,2500)}`);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) throw err;
      if (String(err?.message || "").includes("SP-API ")) throw err;
      const waitMs = Math.min(10000, 1500 * attempt);
      audit.networkRetryCount += 1;
      await sleep(waitMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken, audit) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({ marketplaceIds:marketplaceId, includedData:"summaries,attributes,issues,offers,fulfillmentAvailability", issueLocale:"ja_JP" });
  audit.listingsGetCalls += 1;
  return amazonRequest("GET", `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`, accessToken, null, audit);
}

async function getExactSellerOffer(accessToken, audit) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const body = { requests:[{ uri:`/products/pricing/v0/items/${encodeURIComponent(TARGET.asin)}/offers`, method:"GET", MarketplaceId:marketplaceId, ItemCondition:ITEM_CONDITION, CustomerType:"Consumer" }] };
  audit.productPricingCalls += 1;
  const json = await amazonRequest("POST", `${endpoint}/batches/products/pricing/v0/itemOffers`, accessToken, body, audit);
  const batch = (json?.responses || json?.Responses || [])[0] || {};
  const status = typeof batch?.status === "number" ? batch.status : (batch?.status?.statusCode ?? batch?.Status?.StatusCode ?? batch?.statusCode ?? null);
  const b = batch?.body || batch?.Body || {};
  const payload = b?.payload || b?.Payload || b || {};
  const offers = Array.isArray(payload?.Offers) ? payload.Offers : (Array.isArray(payload?.offers) ? payload.offers : []);
  const ours = offers.filter(o => String(o?.SellerId || o?.sellerId || "") === sellerId).map(o => {
    const listingPrice = numberOrNull(o?.ListingPrice || o?.listingPrice);
    const shipping = numberOrNull(o?.Shipping || o?.shipping) ?? 0;
    const points = numberOrNull(o?.Points || o?.points) ?? 0;
    return {
      listingPrice,
      shipping,
      points,
      landedBeforePoints: listingPrice === null ? null : listingPrice + shipping,
      effectiveAfterPoints: listingPrice === null ? null : Math.max(0, listingPrice + shipping - points),
      isBuyBoxWinner: o?.IsBuyBoxWinner === true || o?.isBuyBoxWinner === true,
      isFulfilledByAmazon: o?.IsFulfilledByAmazon === true || o?.isFulfilledByAmazon === true,
      subCondition: String(o?.SubCondition || o?.subCondition || ""),
    };
  }).filter(o => o.listingPrice !== null);
  return { httpStatus:status, ourOfferCount:ours.length, selected:ours.find(o => o.isBuyBoxWinner) || ours[0] || null };
}

function audienceValue(o) {
  if (!o) return "";
  if (typeof o.audience === "string") return String(o.audience).toUpperCase();
  return String(o?.audience?.value || o?.audience?.displayName || "").toUpperCase();
}
function activeScheduleRef(offer, key, nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : [];
  const candidates = [];
  groups.forEach((g,gi) => (Array.isArray(g?.schedule) ? g.schedule : []).forEach((s,si) => {
    if (scheduleIsActive(s,nowMs)) candidates.push({ groupIndex:gi, scheduleIndex:si, schedule:s, startMs:epochOrNull(s?.start_at) ?? 0 });
  }));
  candidates.sort((a,b) => b.startMs - a.startMs);
  return candidates[0] || null;
}
function activeScheduleCount(offer, key, nowMs) {
  let count = 0;
  (Array.isArray(offer?.[key]) ? offer[key] : []).forEach(g => (Array.isArray(g?.schedule) ? g.schedule : []).forEach(s => { if (scheduleIsActive(s,nowMs)) count += 1; }));
  return count;
}
function analyzeListing(listing, nowMs = Date.now()) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attrs = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const offers = Array.isArray(attrs?.purchasable_offer) ? clone(attrs.purchasable_offer) : [];
  const indexed = offers.map((offer,index) => ({ offer,index }));
  const consumers = indexed.filter(x => audienceValue(x.offer) === "ALL");
  const b2bs = indexed.filter(x => audienceValue(x.offer) === "B2B");
  const consumer = consumers.length === 1 ? consumers[0].offer : null;
  const b2b = b2bs.length === 1 ? b2bs[0].offer : null;
  const normalRef = activeScheduleRef(consumer,"our_price",nowMs);
  const saleRef = activeScheduleRef(consumer,"discounted_price",nowMs);
  const minRef = activeScheduleRef(consumer,"minimum_seller_allowed_price",nowMs);
  const b2bRef = activeScheduleRef(b2b,"our_price",nowMs);
  const availableQuantity = numberOrNull(listing?.fulfillmentAvailability?.[0]?.quantity) ?? numberOrNull(attrs?.fulfillment_availability?.[0]?.quantity) ?? 0;
  return {
    asin:String(summary?.asin || ""), productType:String(summary?.productType || ""), statuses:Array.isArray(summary?.status) ? summary.status.map(String) : [],
    errorCount:issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity, offers,
    consumerIndex:consumers.length === 1 ? consumers[0].index : -1,
    b2bIndex:b2bs.length === 1 ? b2bs[0].index : -1,
    consumerCount:consumers.length, b2bCount:b2bs.length,
    normalRef, normalPrice:numberOrNull(normalRef?.schedule?.value_with_tax),
    salePrice:numberOrNull(saleRef?.schedule?.value_with_tax), activeSaleCount:activeScheduleCount(consumer,"discounted_price",nowMs),
    minimumSellerAllowed:numberOrNull(minRef?.schedule?.value_with_tax),
    b2bRef, b2bPrice:numberOrNull(b2bRef?.schedule?.value_with_tax),
    quantityDiscountActiveCount:activeScheduleCount(b2b,"quantity_discount_plan",nowMs),
  };
}

function stateBlocks(state) {
  const b = [];
  if (state.asin !== TARGET.asin) b.push(`ASIN_MISMATCH:${state.asin}`);
  if (!state.productType) b.push("PRODUCT_TYPE_MISSING");
  if (!state.statuses.includes("BUYABLE")) b.push(`NOT_BUYABLE:${state.statuses.join(",")}`);
  if (!state.statuses.includes("DISCOVERABLE")) b.push(`NOT_DISCOVERABLE:${state.statuses.join(",")}`);
  if (state.errorCount !== 0) b.push(`LISTING_ERRORS:${state.errorCount}`);
  if (!(state.availableQuantity > TARGET.safetyStock)) b.push(`SELLABLE_NOT_POSITIVE:qty=${state.availableQuantity}:safety=${TARGET.safetyStock}`);
  if (state.consumerCount !== 1) b.push(`CONSUMER_COUNT:${state.consumerCount}`);
  if (state.b2bCount !== 1) b.push(`B2B_COUNT:${state.b2bCount}`);
  if (!state.normalRef || state.normalPrice !== TARGET.currentNormal) b.push(`NORMAL_DRIFT:${state.normalPrice}`);
  if (state.salePrice !== null || state.activeSaleCount !== 0) b.push(`ACTIVE_SALE:${state.salePrice}`);
  if (state.minimumSellerAllowed !== TARGET.minimumSellerAllowed) b.push(`MINIMUM_DRIFT:${state.minimumSellerAllowed}`);
  if (!state.b2bRef || state.b2bPrice !== TARGET.currentB2B) b.push(`B2B_DRIFT:${state.b2bPrice}`);
  if (state.quantityDiscountActiveCount !== 0) b.push(`QTY_PLAN_ACTIVE:${state.quantityDiscountActiveCount}`);
  if (TARGET.targetNormal < TARGET.internalReviewFloor) b.push("TARGET_NORMAL_BELOW_REVIEW_FLOOR");
  if (TARGET.targetB2B < TARGET.minimumSellerAllowed) b.push("TARGET_B2B_BELOW_AMAZON_MIN");
  if (Math.floor((TARGET.targetNormal * 0.95) / 100) * 100 !== TARGET.targetB2B) b.push("B2B_TARGET_FORMULA_MISMATCH");
  return b;
}
function pricingBlocks(pricing) {
  const b = [];
  if (!pricing?.selected) b.push(`PRODUCT_PRICING_SELLER_OFFER_ABSENT:http=${pricing?.httpStatus ?? "NA"}`);
  if (pricing?.selected?.listingPrice !== TARGET.currentNormal) b.push(`PRODUCT_PRICING_PRICE_DRIFT:${pricing?.selected?.listingPrice}`);
  if (pricing?.selected?.points !== TARGET.pointsBefore) b.push(`PRODUCT_PRICING_POINTS_DRIFT:${pricing?.selected?.points}`);
  return b;
}
function buildPreview(state) {
  const before = clone(state.offers);
  const after = clone(state.offers);
  const c = after[state.consumerIndex];
  const b = after[state.b2bIndex];
  const cRef = activeScheduleRef(c,"our_price",Date.now());
  const bRef = activeScheduleRef(b,"our_price",Date.now());
  if (!cRef || !bRef) throw new Error("ACTIVE_PRICE_SCHEDULE_MISSING_WHILE_BUILDING_PREVIEW");
  c.our_price[cRef.groupIndex].schedule[cRef.scheduleIndex].value_with_tax = TARGET.targetNormal;
  b.our_price[bRef.groupIndex].schedule[bRef.scheduleIndex].value_with_tax = TARGET.targetB2B;
  const restored = clone(after);
  restored[state.consumerIndex].our_price[cRef.groupIndex].schedule[cRef.scheduleIndex].value_with_tax = TARGET.currentNormal;
  restored[state.b2bIndex].our_price[bRef.groupIndex].schedule[bRef.scheduleIndex].value_with_tax = TARGET.currentB2B;
  if (!jsonEqual(restored,before)) throw new Error("PREVIEW_SCOPE_EXCEEDED_TWO_PRICE_LEAVES");
  return { productType:state.productType, patches:[{ op:"replace", path:"/attributes/purchasable_offer", value:after }] };
}
async function validationPreview(accessToken, patchBody, audit) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({ marketplaceIds:marketplaceId, issueLocale:"ja_JP", mode:"VALIDATION_PREVIEW" });
  audit.validationPreviewCalls += 1;
  const json = await amazonRequest("PATCH", `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`, accessToken, patchBody, audit);
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  return { json, issues, errors:issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR") };
}
function summarizeState(s) {
  return { normalPrice:s.normalPrice, b2bPrice:s.b2bPrice, minimumSellerAllowed:s.minimumSellerAllowed, activeSalePrice:s.salePrice, quantityDiscountActiveCount:s.quantityDiscountActiveCount, availableQuantity:s.availableQuantity, statuses:s.statuses, errorCount:s.errorCount };
}

async function handler(req,res) {
  const audit = { productPricingCalls:0, listingsGetCalls:0, validationPreviewCalls:0, quota429Count:0, quotaWaitMs:0, serverRetryCount:0, networkRetryCount:0 };
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok:false, status:"SECRET_MISSING", moduleVersion:MODULE_VERSION, audit, liveCalls:0, externalChanges:0 });
    if (String(req.headers?.["x-api-secret"] || "") !== secret) return res.status(401).json({ ok:false, status:"UNAUTHORIZED", moduleVersion:MODULE_VERSION, audit, liveCalls:0, externalChanges:0 });
    const body = req.body || {};
    if (body.dryRun !== true || String(body.sku || "") !== TARGET.sku || String(body.asin || "") !== TARGET.asin || Number(body.targetNormal) !== TARGET.targetNormal || Number(body.targetB2B) !== TARGET.targetB2B) {
      return res.status(400).json({ ok:false, status:"EXACT_SCOPE_REJECTED", moduleVersion:MODULE_VERSION, audit, liveCalls:0, externalChanges:0 });
    }

    const accessToken = await getLwaAccessToken();
    const before = analyzeListing(await getListing(accessToken,audit));
    const beforeBlocks = stateBlocks(before);
    if (beforeBlocks.length) return res.status(409).json({ ok:false, status:"PREFLIGHT_BLOCKED", moduleVersion:MODULE_VERSION, blocks:beforeBlocks, before:summarizeState(before), audit, liveCalls:0, externalChanges:0 });

    await sleep(PRODUCT_PRICING_COOLDOWN_MS);
    const pricingBefore = await getExactSellerOffer(accessToken,audit);
    const ppBlocks = pricingBlocks(pricingBefore);
    if (ppBlocks.length) return res.status(409).json({ ok:false, status:"PRODUCT_PRICING_BLOCKED", moduleVersion:MODULE_VERSION, blocks:ppBlocks, before:summarizeState(before), productPricingBefore:pricingBefore, audit, liveCalls:0, externalChanges:0 });

    const patchBody = buildPreview(before);
    const preview = await validationPreview(accessToken,patchBody,audit);
    if (preview.errors.length) return res.status(422).json({ ok:false, status:"VALIDATION_PREVIEW_FAILED_NO_MUTATION", moduleVersion:MODULE_VERSION, validationIssues:preview.issues, audit, liveCalls:0, externalChanges:0 });

    await sleep(POST_PREVIEW_SETTLE_MS);
    const after = analyzeListing(await getListing(accessToken,audit));
    const postBlocks = stateBlocks(after);
    if (postBlocks.length) return res.status(409).json({ ok:false, status:"POST_PREVIEW_STATE_DRIFT", moduleVersion:MODULE_VERSION, blocks:postBlocks, after:summarizeState(after), audit, liveCalls:0, externalChanges:0 });

    return res.status(200).json({
      ok:true,
      status:"SV1_49800_47300_DRY_RUN_PASS",
      moduleVersion:MODULE_VERSION,
      sku:TARGET.sku,
      asin:TARGET.asin,
      before:summarizeState(before),
      productPricingBefore:pricingBefore,
      target:{ normalPrice:TARGET.targetNormal, b2bPrice:TARGET.targetB2B, internalReviewFloor:TARGET.internalReviewFloor, minimumSellerAllowed:TARGET.minimumSellerAllowed, pointsPreserved:TARGET.pointsBefore },
      validation:{ status:String(preview.json?.status || ""), issues:preview.issues, errorCount:0 },
      after:summarizeState(after),
      protections:{ onlyTwoPriceLeavesChangedInPreview:true, amazonMinimumPreserved:true, pointsNotMutated:true, quantityDiscountAbsent:true, productPricingCallsExactlyOne:audit.productPricingCalls === 1, liveRouteExists:false, amazonAdsTouched:false, yahooTouched:false },
      audit,
      validationPreviewCalls:audit.validationPreviewCalls,
      liveCalls:0,
      readOnly:true,
      externalChanges:0,
    });
  } catch (err) {
    console.error("SV1 49800 dry-run error", err?.message || String(err));
    return res.status(500).json({ ok:false, status:"ERROR", moduleVersion:MODULE_VERSION, error:err?.message || String(err), audit, validationPreviewCalls:audit.validationPreviewCalls, liveCalls:0, externalChanges:0 });
  }
}

express.application.use = function sv149800DryUse(...args) {
  const result = originalUse.apply(this,args);
  if (!this.__sv149800DryInstalled) {
    this.__sv149800DryInstalled = true;
    originalPost.call(this,ROUTE,handler);
    console.log(`${MODULE_VERSION} route installed: POST ${ROUTE}`);
  }
  return result;
};
