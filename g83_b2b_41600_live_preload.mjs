import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon G83 B2B 41,600 LIVE v1.0.0
 * 2026-08-28
 *
 * Exact mutation scope:
 * - SKU E7-YLJ3-F9CY / ASIN B0GZBHBQN2
 * - B2B our_price only: 39,900 -> 41,600
 * - Preserve consumer normal 43,800
 * - Preserve consumer points 438
 * - Preserve minimum seller allowed 36,200
 * - Preserve quantity discount 10+ at 3%
 * - Preserve expired sale container and every non-target offer field
 *
 * Flow:
 * Fresh GET -> exact preflight -> VALIDATION_PREVIEW -> Fresh GET -> exact
 * preflight -> LIVE PATCH once -> Fresh postverify. Never auto-retry LIVE.
 */
const MODULE_VERSION = "2026-08-28-g83-b2b-41600-live-v1.0.0";
const ROUTE = "/amazon/price/g83/b2b-41600-live";
const LIVE_CONFIRM = "G83_B2B_41600_LIVE_APPROVED_20260828";
const REQUEST_TIMEOUT_MS = 20000;
const READ_RETRIES = 3;
const RETRY_BASE_MS = 700;
const VERIFY_ATTEMPTS = 8;
const VERIFY_WAIT_MS = 1800;
const originalListen = express.application.listen;

const TARGET = Object.freeze({
  sku: "E7-YLJ3-F9CY",
  asin: "B0GZBHBQN2",
  normalPrice: 43800,
  actualB2CPrice: 43800,
  amazonPoints: 438,
  minimumSellerAllowed: 36200,
  currentB2B: 39900,
  targetB2B: 41600,
  quantityDiscountType: "percent",
  quantityLowerBound: 10,
  quantityValue: 3,
});

function safeJsonParse(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { rawText: text }; } }
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    for (const key of ["amount","Amount","value","Value","pointsNumber","PointsNumber","points_number"]) {
      if (value && value[key] !== undefined) return numberOrNull(value[key]);
    }
  }
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function jsonEqual(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
function hasOwn(obj,key) { return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj,key); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function epochOrNull(value) { const t = Date.parse(String(value || "")); return Number.isFinite(t) ? t : null; }
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

async function amazonRequest(url, options, allowRetry) {
  const attempts = allowRetry ? READ_RETRIES : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      const json = safeJsonParse(text);
      if (response.ok) return { response, json };
      const retryable = response.status === 429 || response.status >= 500;
      if (!allowRetry || !retryable || attempt === attempts) {
        const err = new Error(`SP-API error: ${response.status} ${JSON.stringify(json).slice(0,2500)}`);
        err.amazonBody = json;
        throw err;
      }
      await sleep(RETRY_BASE_MS * attempt);
    } catch (err) {
      lastError = err;
      if (!allowRetry || attempt === attempts) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,offers,fulfillmentAvailability", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(TARGET.sku)}?${q}`;
  return (await amazonRequest(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } }, true)).json;
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
  }, validationPreview)).json;
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  return { body, json, issues, errors };
}

function scheduleIsActive(schedule, nowMs) {
  const start = epochOrNull(schedule?.start_at); const end = epochOrNull(schedule?.end_at);
  if (start !== null && nowMs < start) return false;
  if (end !== null && nowMs >= end) return false;
  return true;
}
function activeScheduleRef(offer,key,nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : []; const candidates = [];
  groups.forEach((group,groupIndex) => {
    const schedules = Array.isArray(group?.schedule) ? group.schedule : [];
    schedules.forEach((schedule,scheduleIndex) => { if (scheduleIsActive(schedule,nowMs)) candidates.push({ groupIndex, scheduleIndex, schedule, startMs: epochOrNull(schedule?.start_at) ?? 0 }); });
  });
  candidates.sort((a,b) => b.startMs - a.startMs); return candidates[0] || null;
}
function scheduleDiagnostics(offer,key,nowMs) {
  const groups = Array.isArray(offer?.[key]) ? offer[key] : []; let total=0,active=0,expired=0,future=0;
  groups.forEach(group => (Array.isArray(group?.schedule)?group.schedule:[]).forEach(schedule => {
    total += 1; const start=epochOrNull(schedule?.start_at); const end=epochOrNull(schedule?.end_at);
    if (scheduleIsActive(schedule,nowMs)) active += 1;
    else if (end !== null && nowMs >= end) expired += 1;
    else if (start !== null && nowMs < start) future += 1;
  }));
  return { total, active, expired, future };
}
function audienceValue(offer) {
  if (!offer) return "";
  if (typeof offer.audience === "string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value || offer?.audience?.displayName || "").toUpperCase();
}
function offerType(offer) { return String(offer?.offerType || offer?.offer_type || "").toUpperCase(); }
function offerPrice(offer) { return offer && hasOwn(offer,"price") ? numberOrNull(offer.price) : null; }
function parsePointsValue(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") return numberOrNull(raw);
  for (const key of ["pointsNumber","PointsNumber","points_number","amount","Amount","value","Value"]) {
    if (raw[key] !== undefined) { const n=numberOrNull(raw[key]); if (n !== null) return n; }
  }
  return null;
}
function summarizeActualOffers(listing) {
  const { marketplaceId } = getConfig(); const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const market = offers.filter(offer => { const id=String(offer?.marketplaceId || offer?.marketplace_id || ""); return !id || id===marketplaceId; });
  const b2c = market.find(offer => offerType(offer)==="B2C" || audienceValue(offer)==="ALL") || null;
  const b2b = market.find(offer => offerType(offer)==="B2B" || audienceValue(offer)==="B2B") || null;
  return { b2cPresent:Boolean(b2c), b2cPrice:offerPrice(b2c), pointsPresent:Boolean(b2c && hasOwn(b2c,"points")), points:b2c && hasOwn(b2c,"points") ? parsePointsValue(b2c.points) : null, b2bPresent:Boolean(b2b), b2bPrice:offerPrice(b2b) };
}
function quantityPlanFromB2B(b2b,nowMs) {
  const ref=activeScheduleRef(b2b,"quantity_discount_plan",nowMs); const schedule=ref?.schedule || null;
  const type=String(schedule?.discount_type || "").toLowerCase(); const levels=Array.isArray(schedule?.levels)?schedule.levels:[];
  return { type, levels:levels.map(level => ({ lowerBound:numberOrNull(level?.lower_bound), value:numberOrNull(level?.value) })).filter(level => level.lowerBound!==null && level.value!==null) };
}

function analyzeListing(listing,nowMs=Date.now()) {
  const summary=Array.isArray(listing?.summaries)?listing.summaries[0]||{}:{}; const attributes=listing?.attributes||{};
  const issues=Array.isArray(listing?.issues)?listing.issues:[]; const errorIssues=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
  const statuses=Array.isArray(summary?.status)?summary.status.map(String):[]; const offers=Array.isArray(attributes?.purchasable_offer)?clone(attributes.purchasable_offer):[];
  const indexed=offers.map((offer,index)=>({offer,index})); const consumers=indexed.filter(x=>audienceValue(x.offer)==="ALL"); const b2bs=indexed.filter(x=>audienceValue(x.offer)==="B2B");
  const consumer=consumers.length===1?consumers[0].offer:null; const b2b=b2bs.length===1?b2bs[0].offer:null;
  const normalRef=activeScheduleRef(consumer,"our_price",nowMs); const saleRef=activeScheduleRef(consumer,"discounted_price",nowMs); const minimumRef=activeScheduleRef(consumer,"minimum_seller_allowed_price",nowMs); const b2bPriceRef=activeScheduleRef(b2b,"our_price",nowMs);
  const actual=summarizeActualOffers(listing); const saleDiagnostics=scheduleDiagnostics(consumer,"discounted_price",nowMs); const quantityPlan=quantityPlanFromB2B(b2b,nowMs);
  const availableQuantity=numberOrNull(listing?.fulfillmentAvailability?.[0]?.quantity) ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity) ?? 0;
  return { asin:String(summary?.asin||""), productType:String(summary?.productType||""), statuses, buyable:statuses.includes("BUYABLE"), errorIssues, availableQuantity, offers, consumerIndex:consumers.length===1?consumers[0].index:-1, b2bIndex:b2bs.length===1?b2bs[0].index:-1, normalPrice:numberOrNull(normalRef?.schedule?.value_with_tax), salePrice:numberOrNull(saleRef?.schedule?.value_with_tax), saleDiagnostics, minimumSellerAllowed:numberOrNull(minimumRef?.schedule?.value_with_tax), b2bPriceRef, b2bPrice:numberOrNull(b2bPriceRef?.schedule?.value_with_tax), quantityPlan, actual, consumerCount:consumers.length, b2bCount:b2bs.length };
}

function quantityExact(state) {
  const qp=state.quantityPlan||{}; const levels=Array.isArray(qp.levels)?qp.levels:[];
  return qp.type===TARGET.quantityDiscountType && levels.length===1 && levels[0].lowerBound===TARGET.quantityLowerBound && levels[0].value===TARGET.quantityValue;
}
function baseProtectionBlocks(state,expectedB2B) {
  const blocks=[];
  if (state.asin!==TARGET.asin) blocks.push(`ASIN_MISMATCH:${state.asin||""}`);
  if (!state.productType) blocks.push("PRODUCT_TYPE_MISSING");
  if (!state.buyable) blocks.push(`NOT_BUYABLE:${state.statuses.join(",")}`);
  if (state.errorIssues.length) blocks.push(`LISTING_ERRORS:${state.errorIssues.length}`);
  if (!(state.availableQuantity>0)) blocks.push(`NO_INVENTORY:${state.availableQuantity}`);
  if (state.consumerCount!==1) blocks.push(`CONSUMER_OFFER_COUNT:${state.consumerCount}`);
  if (state.b2bCount!==1) blocks.push(`B2B_OFFER_COUNT:${state.b2bCount}`);
  if (state.normalPrice!==TARGET.normalPrice) blocks.push(`NORMAL_PRICE:${state.normalPrice}`);
  if (!state.actual.b2cPresent || state.actual.b2cPrice!==TARGET.actualB2CPrice) blocks.push(`ACTUAL_B2C:${state.actual.b2cPrice}`);
  if (!state.actual.pointsPresent || state.actual.points!==TARGET.amazonPoints) blocks.push(`POINTS:${state.actual.points}`);
  if (state.salePrice!==null || state.saleDiagnostics.active!==0 || state.saleDiagnostics.future!==0) blocks.push(`SALE_STATE:${JSON.stringify(state.saleDiagnostics)}`);
  if (state.minimumSellerAllowed!==TARGET.minimumSellerAllowed) blocks.push(`MINIMUM:${state.minimumSellerAllowed}`);
  if (!state.b2bPriceRef || state.b2bPrice!==expectedB2B) blocks.push(`B2B_ATTRIBUTE:${state.b2bPrice}`);
  if (!state.actual.b2bPresent || state.actual.b2bPrice!==expectedB2B) blocks.push(`ACTUAL_B2B:${state.actual.b2bPrice}`);
  if (!quantityExact(state)) blocks.push(`QTY_PLAN:${JSON.stringify(state.quantityPlan)}`);
  return blocks;
}

function buildTargetOffers(state) {
  const beforeOffers=clone(state.offers); const afterOffers=clone(state.offers); const b2b=afterOffers[state.b2bIndex];
  if (!b2b) throw new Error("B2B offer missing");
  const ref=activeScheduleRef(b2b,"our_price",Date.now()); if (!ref) throw new Error("active B2B our_price missing");
  const beforeConsumer=clone(beforeOffers[state.consumerIndex]); const beforeB2B=clone(beforeOffers[state.b2bIndex]); const beforeQty=clone(beforeB2B?.quantity_discount_plan ?? null);
  b2b.our_price[ref.groupIndex].schedule[ref.scheduleIndex].value_with_tax=TARGET.targetB2B;
  const expectedOurPrice=clone(beforeB2B.our_price); expectedOurPrice[ref.groupIndex].schedule[ref.scheduleIndex].value_with_tax=TARGET.targetB2B;
  if (!jsonEqual(b2b.our_price,expectedOurPrice)) throw new Error("B2B our_price changed outside target leaf");
  const normalized=clone(b2b); normalized.our_price=clone(beforeB2B.our_price);
  if (!jsonEqual(normalized,beforeB2B)) throw new Error("B2B offer changed outside our_price");
  if (!jsonEqual(afterOffers[state.consumerIndex],beforeConsumer)) throw new Error("consumer offer changed");
  if (!jsonEqual(b2b.quantity_discount_plan ?? null,beforeQty)) throw new Error("quantity plan changed");
  return afterOffers;
}

async function verifyApplied(accessToken) {
  let finalState=null; let blocks=[];
  for (let attempt=1; attempt<=VERIFY_ATTEMPTS; attempt+=1) {
    finalState=analyzeListing(await getListing(accessToken),Date.now());
    blocks=baseProtectionBlocks(finalState,TARGET.targetB2B);
    if (!blocks.length) return { verified:true, attempt, state:finalState, blocks:[] };
    if (attempt<VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return { verified:false, attempt:VERIFY_ATTEMPTS, state:finalState, blocks };
}

function stateSummary(state) {
  return state ? { normalPrice:state.normalPrice, actualOfferB2CPrice:state.actual.b2cPrice, amazonPoints:state.actual.points, minimumSellerAllowed:state.minimumSellerAllowed, b2bAttributePrice:state.b2bPrice, actualOfferB2BPrice:state.actual.b2bPrice, quantityPlan:state.quantityPlan, saleSchedule:state.saleDiagnostics, buyable:state.buyable, errorCount:state.errorIssues.length, availableQuantity:state.availableQuantity } : null;
}

async function handler(req,res) {
  let validationPreviewCalls=0; let liveAttempted=false; let liveCalls=0;
  try {
    const secret=getSecret();
    if (!secret) return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"CONFIG_ERROR",persistentAmazonWrites:0,liveCalls:0,externalChanges:0,error:"AMAZON_STOCK_API_SECRET is not set"});
    if (String(req.headers["x-api-secret"]||"")!==secret) return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"UNAUTHORIZED",persistentAmazonWrites:0,liveCalls:0,externalChanges:0,error:"Unauthorized"});
    if (String(req.body?.confirm||"")!==LIVE_CONFIRM) return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_CONFIRM_MISMATCH",persistentAmazonWrites:0,liveCalls:0,externalChanges:0,error:`confirm must equal ${LIVE_CONFIRM}`});

    const accessToken=await getLwaAccessToken();
    const first=analyzeListing(await getListing(accessToken),Date.now()); const firstBlocks=baseProtectionBlocks(first,TARGET.currentB2B);
    if (firstBlocks.length) return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"PREFLIGHT_BLOCKED_NO_LIVE",validationPreviewCalls:0,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,blocks:firstBlocks,state:stateSummary(first)});

    const previewOffers=buildTargetOffers(first);
    const preview=await patchListing(accessToken,first.productType,previewOffers,true); validationPreviewCalls=1;
    if (preview.errors.length) return res.status(422).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"VALIDATION_PREVIEW_FAILED_NO_LIVE",validationPreviewCalls,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,issues:preview.issues});

    const second=analyzeListing(await getListing(accessToken),Date.now()); const secondBlocks=baseProtectionBlocks(second,TARGET.currentB2B);
    if (secondBlocks.length) return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"SECOND_PREFLIGHT_BLOCKED_NO_LIVE",validationPreviewCalls,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,blocks:secondBlocks,state:stateSummary(second)});

    const liveOffers=buildTargetOffers(second);
    liveAttempted=true;
    const accepted=await patchListing(accessToken,second.productType,liveOffers,false);
    liveCalls=1;
    if (accepted.errors.length) return res.status(202).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_SUBMITTED_WITH_ERROR_ISSUES_DO_NOT_RERUN",validationPreviewCalls,liveCalls,persistentAmazonWrites:1,externalChanges:1,issues:accepted.issues,nextStep:"FRESH_AUDIT_ONLY_DO_NOT_RERUN_LIVE"});

    const verification=await verifyApplied(accessToken);
    if (!verification.verified) return res.status(202).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_SUBMITTED_POSTVERIFY_INCOMPLETE_DO_NOT_RERUN",validationPreviewCalls,liveCalls,persistentAmazonWrites:1,externalChanges:1,verifyAttempts:verification.attempt,verifyBlocks:verification.blocks,state:stateSummary(verification.state),nextStep:"RUN_FRESH_AUDIT_ONLY_DO_NOT_RERUN_LIVE"});

    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_G83_B2B_41600_VERIFIED",validationPreviewCalls,liveCalls,persistentAmazonWrites:1,externalChanges:1,verifyAttempts:verification.attempt,state:stateSummary(verification.state),nextStep:"RUN_V120_FRESH_RECONCILE_AND_VERIFY_SSOT"});
  } catch (err) {
    if (liveAttempted) return res.status(202).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_ATTEMPTED_RESULT_AMBIGUOUS_DO_NOT_RERUN",validationPreviewCalls,liveCalls:Math.max(liveCalls,1),persistentAmazonWrites:1,externalChanges:1,error:err?.message||String(err),nextStep:"FRESH_AUDIT_ONLY_DO_NOT_RERUN_LIVE"});
    return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"ERROR_BEFORE_LIVE_NO_MUTATION",validationPreviewCalls,liveCalls:0,persistentAmazonWrites:0,externalChanges:0,error:err?.message||String(err)});
  }
}

express.application.listen=function g83B2B41600LiveListen(...args){
  const alreadyRegistered=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));
  if (!alreadyRegistered) this.post(ROUTE,handler);
  return originalListen.apply(this,args);
};
