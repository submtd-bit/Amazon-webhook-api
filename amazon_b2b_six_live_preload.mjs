import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon B2B six-SKU explicit-price LIVE v1.0.0
 * 2026-08-29
 *
 * Exact scope:
 * - Six approved Seller SKUs only.
 * - Set explicit B2B our_price to the approved target for each SKU.
 * - Preserve consumer offer, points, minimum price, and all non-target offer fields.
 * - Never add or change quantity discounts.
 *
 * Flow:
 * Fresh GET all 6 -> exact preflight all 6 -> VALIDATION_PREVIEW all 6 ->
 * Fresh GET all 6 -> exact second preflight all 6 -> for each SKU:
 * fresh preflight -> LIVE PATCH once (no retry) -> fresh postverify.
 * If any LIVE was attempted, never instruct rerun of the batch; fresh audit only.
 */
const MODULE_VERSION = "2026-08-29-amazon-b2b-six-live-v1.0.0";
const ROUTE = "/amazon/price/b2b/six-live";
const LIVE_CONFIRM = "AMAZON_B2B6_LIVE_APPROVED_20260829_V1";
const REQUEST_TIMEOUT_MS = 20000;
const READ_RETRIES = 3;
const RETRY_BASE_MS = 700;
const VERIFY_ATTEMPTS = 8;
const VERIFY_WAIT_MS = 1800;
const originalListen = express.application.listen;

const APPROVED = Object.freeze([
  Object.freeze({ sku: "LeLib_SV1_16gb_256", asin: "B0G59QKJXB", normal: 60000, effective: 60000, points: 600, min: 40500, currentActualB2b: 58212, targetB2b: 57000 }),
  Object.freeze({ sku: "RB-Y7G2-H0EK", asin: "B0GZGM1BND", normal: 56000, effective: 56000, points: 560, min: 40500, currentActualB2b: 54363, targetB2b: 53200 }),
  Object.freeze({ sku: "LeLib_SV1_16GB_SSD512", asin: "B0G5ZRLZZH", normal: 68000, effective: 68000, points: 680, min: 54900, currentActualB2b: 65974, targetB2b: 64600 }),
  Object.freeze({ sku: "ZK-N79H-VRJQ", asin: "B0D4QMJK1Z", normal: 32000, effective: 32000, points: 320, min: 30300, currentActualB2b: 31046, targetB2b: 30400 }),
  Object.freeze({ sku: "FU-OAHV-H4W4", asin: "B0H211KYDG", normal: 65000, effective: 65000, points: 650, min: 27900, currentActualB2b: 63063, targetB2b: 61700 }),
  Object.freeze({ sku: "LeLib_l580_i5-8G_16gb_SSD256", asin: "B0F333JB5Q", normal: 44000, effective: 44000, points: 440, min: 38500, currentActualB2b: 42689, targetB2b: 41800 }),
]);

function safeJsonParse(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { rawText: text }; } }
function clone(value) { return value===undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function jsonEqual(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
function hasOwn(obj,key) { return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj,key); }
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    for (const key of ["amount","Amount","value","Value","pointsNumber","PointsNumber","points_number"]) {
      if (value[key] !== undefined) return numberOrNull(value[key]);
    }
  }
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function epochOrNull(value) { const t = Date.parse(String(value || "")); return Number.isFinite(t) ? t : null; }
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
  const clientId = process.env.LWA_CLIENT_ID, clientSecret = process.env.LWA_CLIENT_SECRET, refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret}),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

async function amazonRequest(url, options, allowRetry) {
  const attempts = allowRetry ? READ_RETRIES : 1;
  let lastError = null;
  for (let attempt=1; attempt<=attempts; attempt+=1) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url,{...options,signal:controller.signal});
      const json = safeJsonParse(await response.text());
      if (response.ok) return {response,json};
      const retryable = response.status===429 || response.status>=500;
      if (!allowRetry || !retryable || attempt===attempts) {
        const err = new Error(`SP-API error: ${response.status} ${JSON.stringify(json).slice(0,2500)}`);
        err.amazonBody = json;
        throw err;
      }
      await sleep(RETRY_BASE_MS * attempt);
    } catch(err) {
      lastError = err;
      if (!allowRetry || attempt===attempts) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken, sku) {
  const {sellerId,marketplaceId,endpoint}=getConfig();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  const url=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  return (await amazonRequest(url,{method:"GET",headers:{"x-amz-access-token":accessToken,accept:"application/json"}},true)).json;
}

async function patchListing(accessToken, sku, productType, offers, validationPreview) {
  const {sellerId,marketplaceId,endpoint}=getConfig();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP"});
  if (validationPreview) q.set("mode","VALIDATION_PREVIEW");
  const url=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  const body={productType,patches:[{op:"replace",path:"/attributes/purchasable_offer",value:offers}]};
  const json=(await amazonRequest(url,{method:"PATCH",headers:{"x-amz-access-token":accessToken,accept:"application/json","content-type":"application/json"},body:JSON.stringify(body)},validationPreview)).json;
  const issues=Array.isArray(json?.issues)?json.issues:[];
  const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
  return {json,issues,errors};
}

function scheduleEntries(offer,key) {
  const groups=Array.isArray(offer?.[key])?offer[key]:[];
  const all=[];
  groups.forEach((group,groupIndex)=>{
    const schedules=Array.isArray(group?.schedule)?group.schedule:[];
    schedules.forEach((schedule,scheduleIndex)=>all.push({groupIndex,scheduleIndex,schedule}));
  });
  return all;
}
function scheduleIsActive(s,now) {
  const st=epochOrNull(s?.start_at),en=epochOrNull(s?.end_at);
  if (st!==null && now<st) return false;
  if (en!==null && now>=en) return false;
  return true;
}
function activeScheduleRef(offer,key,now) {
  return scheduleEntries(offer,key).filter(x=>scheduleIsActive(x.schedule,now)).sort((a,b)=>(epochOrNull(b.schedule?.start_at)??0)-(epochOrNull(a.schedule?.start_at)??0))[0]||null;
}
function activeScheduleValue(offer,key,now) { return numberOrNull(activeScheduleRef(offer,key,now)?.schedule?.value_with_tax); }
function audienceValue(offer) {
  if (!offer) return "";
  if (typeof offer.audience==="string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value||offer?.audience?.displayName||"").toUpperCase();
}
function offerType(offer) { return String(offer?.offerType||offer?.offer_type||"").toUpperCase(); }
function offerPrice(offer) { return offer&&hasOwn(offer,"price")?numberOrNull(offer.price):null; }
function parsePointsValue(raw) {
  if (raw===null||raw===undefined||raw==="") return null;
  if (typeof raw!=="object") return numberOrNull(raw);
  for (const k of ["pointsNumber","PointsNumber","points_number","amount","Amount","value","Value"]) {
    if (raw[k]!==undefined) { const n=numberOrNull(raw[k]); if (n!==null) return n; }
  }
  return null;
}
function currentOfferSummary(listing) {
  const {marketplaceId}=getConfig();
  const offers=Array.isArray(listing?.offers)?listing.offers:[];
  const market=offers.filter(o=>{const id=String(o?.marketplaceId||o?.marketplace_id||"");return !id||id===marketplaceId;});
  const b2c=market.find(o=>offerType(o)==="B2C"||audienceValue(o)==="ALL")||null;
  const b2b=market.find(o=>offerType(o)==="B2B"||audienceValue(o)==="B2B")||null;
  return {b2cPresent:Boolean(b2c),b2cPrice:offerPrice(b2c),pointsPresent:Boolean(b2c&&hasOwn(b2c,"points")),points:b2c&&hasOwn(b2c,"points")?parsePointsValue(b2c.points):null,b2bPresent:Boolean(b2b),b2bPrice:offerPrice(b2b)};
}
function quantityPlanPresent(offer) { return scheduleEntries(offer,"quantity_discount_plan").length>0; }

function analyze(approved,listing,now=Date.now()) {
  const summary=Array.isArray(listing?.summaries)?listing.summaries[0]||{}:{};
  const attrs=listing?.attributes||{},issues=Array.isArray(listing?.issues)?listing.issues:[];
  const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR"),statuses=Array.isArray(summary?.status)?summary.status.map(String):[];
  const offers=Array.isArray(attrs?.purchasable_offer)?clone(attrs.purchasable_offer):[];
  const indexed=offers.map((offer,index)=>({offer,index}));
  const consumers=indexed.filter(x=>audienceValue(x.offer)==="ALL");
  const b2bs=indexed.filter(x=>audienceValue(x.offer)==="B2B");
  const consumer=consumers.length===1?consumers[0].offer:null;
  const b2b=b2bs.length===1?b2bs[0].offer:null;
  const normal=activeScheduleValue(consumer,"our_price",now);
  const sale=activeScheduleValue(consumer,"discounted_price",now);
  const effective=sale!==null?sale:normal;
  const min=activeScheduleValue(consumer,"minimum_seller_allowed_price",now);
  const qty=numberOrNull(listing?.fulfillmentAvailability?.[0]?.quantity)??numberOrNull(attrs?.fulfillment_availability?.[0]?.quantity)??0;
  const actual=currentOfferSummary(listing);
  return {approved,asin:String(summary?.asin||""),productType:String(summary?.productType||""),statuses,buyable:statuses.includes("BUYABLE"),errors,qty,offers,consumerIndex:consumers.length===1?consumers[0].index:-1,b2bIndex:b2bs.length===1?b2bs[0].index:-1,consumer,b2b,consumerCount:consumers.length,b2bCount:b2bs.length,normal,sale,effective,min,actual,quantityPlanPresent:b2b?quantityPlanPresent(b2b):false};
}

function preflightBlocks(state,expectedActualB2b) {
  const a=state.approved,blocks=[];
  if (state.asin!==a.asin) blocks.push(`ASIN_MISMATCH:${state.asin}`);
  if (!state.productType) blocks.push("PRODUCT_TYPE_MISSING");
  if (!state.buyable) blocks.push(`NOT_BUYABLE:${state.statuses.join(",")}`);
  if (state.errors.length) blocks.push(`LISTING_ERRORS:${state.errors.map(x=>String(x?.code||"")).join(",")}`);
  if (!(state.qty>0)) blocks.push(`NO_INVENTORY:${state.qty}`);
  if (state.consumerCount!==1) blocks.push(`CONSUMER_OFFER_COUNT:${state.consumerCount}`);
  if (state.b2bCount>1) blocks.push(`B2B_ATTRIBUTE_COUNT:${state.b2bCount}`);
  if (state.quantityPlanPresent) blocks.push("EXISTING_QUANTITY_PLAN_PRESENT");
  if (!state.actual.b2cPresent||state.actual.b2cPrice===null) blocks.push("ACTUAL_B2C_OFFER_MISSING");
  if (!state.actual.b2bPresent||state.actual.b2bPrice===null) blocks.push("ACTUAL_B2B_OFFER_MISSING");
  if (state.actual.b2bPrice!==expectedActualB2b) blocks.push(`ACTUAL_B2B_DRIFT:${state.actual.b2bPrice}`);
  if (!state.actual.pointsPresent||state.actual.points===null) blocks.push("AMAZON_POINTS_MISSING");
  if (state.normal!==a.normal) blocks.push(`NORMAL_PRICE_DRIFT:${state.normal}`);
  if (state.effective!==a.effective) blocks.push(`EFFECTIVE_PRICE_DRIFT:${state.effective}`);
  if (state.actual.b2cPrice!==a.normal) blocks.push(`ACTUAL_B2C_DRIFT:${state.actual.b2cPrice}`);
  if (state.actual.points!==a.points) blocks.push(`POINTS_DRIFT:${state.actual.points}`);
  if (state.min!==a.min) blocks.push(`MINIMUM_DRIFT:${state.min}`);
  if (a.targetB2b<a.min) blocks.push(`TARGET_BELOW_MIN:${a.targetB2b}<${a.min}`);
  if (state.effective===null||a.targetB2b>=state.effective) blocks.push(`TARGET_NOT_BELOW_EFFECTIVE:${a.targetB2b}>=${state.effective}`);
  return blocks;
}

function priceTemplateFrom(offer) { return Array.isArray(offer?.our_price)&&offer.our_price.length?clone(offer.our_price[0]||{}):null; }
function setOfferPrice(offer,target,templateOffer) {
  const ownTemplate=priceTemplateFrom(offer),fallbackTemplate=priceTemplateFrom(templateOffer),first=ownTemplate||fallbackTemplate;
  if (!first) throw new Error("our_price template missing");
  first.schedule=[{value_with_tax:target}];
  offer.our_price=[first];
  return ownTemplate?"OWN_OUR_PRICE":"SEEDED_OUR_PRICE_FROM_CONSUMER";
}
function buildTargetOffers(state) {
  const before=clone(state.offers),after=clone(state.offers);
  let mode="";
  if (state.b2bIndex>=0) {
    const beforeB2B=clone(before[state.b2bIndex]);
    const b2b=clone(after[state.b2bIndex]);
    const priceMode=setOfferPrice(b2b,state.approved.targetB2b,state.consumer);
    if (quantityPlanPresent(b2b)) throw new Error("quantity plan changed or present");
    const normalized=clone(b2b); normalized.our_price=clone(beforeB2B.our_price);
    const beforeNormalized=clone(beforeB2B);
    if (!jsonEqual(normalized,beforeNormalized)) throw new Error("B2B offer changed outside our_price");
    after[state.b2bIndex]=b2b;
    mode=priceMode==="OWN_OUR_PRICE"?"REPLACE_EXPLICIT_B2B_ATTRIBUTE":"REPLACE_EXPLICIT_B2B_ATTRIBUTE_SEEDED_OUR_PRICE";
  } else {
    const b2b=clone(state.consumer); b2b.audience="B2B";
    delete b2b.discounted_price; delete b2b.minimum_seller_allowed_price; delete b2b.maximum_seller_allowed_price; delete b2b.quantity_discount_plan;
    setOfferPrice(b2b,state.approved.targetB2b,state.consumer);
    if (quantityPlanPresent(b2b)) throw new Error("quantity plan unexpectedly present");
    after.push(b2b); mode="APPEND_EXPLICIT_B2B_ATTRIBUTE";
  }
  for (let i=0;i<before.length;i+=1) {
    if (i===state.b2bIndex) continue;
    if (!jsonEqual(before[i],after[i])) throw new Error(`existing offer changed:${i}`);
  }
  return {offers:after,mode};
}

function postverifyBlocks(state) {
  const a=state.approved,blocks=preflightBlocks(state,a.targetB2b);
  if (state.b2bCount!==1) blocks.push(`POST_B2B_ATTRIBUTE_COUNT:${state.b2bCount}`);
  if (!state.b2b) blocks.push("POST_B2B_ATTRIBUTE_MISSING");
  else {
    const price=activeScheduleValue(state.b2b,"our_price",Date.now());
    if (price!==a.targetB2b) blocks.push(`POST_B2B_ATTRIBUTE_PRICE:${price}`);
    if (quantityPlanPresent(state.b2b)) blocks.push("POST_QUANTITY_PLAN_PRESENT");
  }
  return [...new Set(blocks)];
}

async function verifyApplied(accessToken, approved) {
  let state=null,blocks=[];
  for (let attempt=1;attempt<=VERIFY_ATTEMPTS;attempt+=1) {
    state=analyze(approved,await getListing(accessToken,approved.sku),Date.now());
    blocks=postverifyBlocks(state);
    if (!blocks.length) return {verified:true,attempt,state,blocks:[]};
    if (attempt<VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return {verified:false,attempt:VERIFY_ATTEMPTS,state,blocks};
}

function stateSummary(state) {
  return state?{sku:state.approved.sku,asin:state.asin,normalPrice:state.normal,effectivePrice:state.effective,amazonPoints:state.actual.points,minimumSellerAllowed:state.min,b2bAttributePrice:state.b2b?activeScheduleValue(state.b2b,"our_price",Date.now()):null,actualOfferB2BPrice:state.actual.b2bPrice,quantityPlanPresent:state.quantityPlanPresent,buyable:state.buyable,errorCount:state.errors.length,availableQuantity:state.qty}:null;
}

async function readAllStates(accessToken) {
  const states=[];
  for (const approved of APPROVED) states.push(analyze(approved,await getListing(accessToken,approved.sku),Date.now()));
  return states;
}

async function handler(req,res) {
  let validationPreviewCalls=0,liveCalls=0;
  const completed=[];
  let activeLiveSku=null;
  try {
    const secret=getSecret();
    if (!secret) return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"CONFIG_ERROR",validationPreviewCalls:0,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,error:"AMAZON_STOCK_API_SECRET is not set"});
    if (String(req.headers["x-api-secret"]||"")!==secret) return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"UNAUTHORIZED",validationPreviewCalls:0,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,error:"Unauthorized"});
    if (String(req.body?.confirm||"")!==LIVE_CONFIRM) return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_CONFIRM_MISMATCH",validationPreviewCalls:0,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,error:`confirm must equal ${LIVE_CONFIRM}`});

    const accessToken=await getLwaAccessToken();

    const firstStates=await readAllStates(accessToken);
    const firstFailures=firstStates.map(s=>({sku:s.approved.sku,blocks:preflightBlocks(s,s.approved.currentActualB2b),state:stateSummary(s)})).filter(x=>x.blocks.length);
    if (firstFailures.length) return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"PREFLIGHT_BLOCKED_NO_LIVE",validationPreviewCalls:0,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,failures:firstFailures});

    for (const state of firstStates) {
      const built=buildTargetOffers(state);
      const preview=await patchListing(accessToken,state.approved.sku,state.productType,built.offers,true); validationPreviewCalls+=1;
      if (preview.errors.length) return res.status(422).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"VALIDATION_PREVIEW_FAILED_NO_LIVE",validationPreviewCalls,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,sku:state.approved.sku,issues:preview.issues});
    }

    const secondStates=await readAllStates(accessToken);
    const secondFailures=secondStates.map(s=>({sku:s.approved.sku,blocks:preflightBlocks(s,s.approved.currentActualB2b),state:stateSummary(s)})).filter(x=>x.blocks.length);
    if (secondFailures.length) return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"SECOND_PREFLIGHT_BLOCKED_NO_LIVE",validationPreviewCalls,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,failures:secondFailures});

    for (const approved of APPROVED) {
      const fresh=analyze(approved,await getListing(accessToken,approved.sku),Date.now());
      const freshBlocks=preflightBlocks(fresh,approved.currentActualB2b);
      if (freshBlocks.length) {
        const changed=liveCalls>0;
        return res.status(changed?202:409).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:changed?"PARTIAL_LIVE_APPLIED_DO_NOT_RERUN_BATCH":"FINAL_PREFLIGHT_BLOCKED_NO_LIVE",validationPreviewCalls,liveCalls,persistentAmazonWrites:liveCalls,externalChanges:liveCalls,completed,blockedSku:approved.sku,blocks:freshBlocks,state:stateSummary(fresh),nextStep:changed?"FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH":undefined});
      }
      const built=buildTargetOffers(fresh);
      activeLiveSku=approved.sku;
      liveCalls+=1;
      const accepted=await patchListing(accessToken,approved.sku,fresh.productType,built.offers,false);
      if (accepted.errors.length) return res.status(202).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_SUBMITTED_WITH_ERROR_ISSUES_DO_NOT_RERUN_BATCH",validationPreviewCalls,liveCalls,persistentAmazonWrites:liveCalls,externalChanges:liveCalls,completed,activeLiveSku,issues:accepted.issues,nextStep:"FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH"});
      const verification=await verifyApplied(accessToken,approved);
      if (!verification.verified) return res.status(202).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_SUBMITTED_POSTVERIFY_INCOMPLETE_DO_NOT_RERUN_BATCH",validationPreviewCalls,liveCalls,persistentAmazonWrites:liveCalls,externalChanges:liveCalls,completed,activeLiveSku,verifyAttempts:verification.attempt,verifyBlocks:verification.blocks,state:stateSummary(verification.state),nextStep:"FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH"});
      completed.push({sku:approved.sku,asin:approved.asin,fromB2b:approved.currentActualB2b,targetB2b:approved.targetB2b,attributeMode:built.mode,verifyAttempts:verification.attempt,state:stateSummary(verification.state)});
      activeLiveSku=null;
    }

    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_B2B6_ALL_6_VERIFIED",validationPreviewCalls,liveCalls,persistentAmazonWrites:liveCalls,externalChanges:liveCalls,completed,nextStep:"RUN_B2B6_RESUME_FRESH_V120_SHADOW_AND_RECONCILE_SSOT"});
  } catch(err) {
    if (liveCalls>0) return res.status(202).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"LIVE_ATTEMPTED_RESULT_AMBIGUOUS_DO_NOT_RERUN_BATCH",validationPreviewCalls,liveCalls,persistentAmazonWrites:liveCalls,externalChanges:liveCalls,completed,activeLiveSku,error:err?.message||String(err),nextStep:"FRESH_AUDIT_ONLY_DO_NOT_RERUN_BATCH"});
    return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"ERROR_BEFORE_LIVE_NO_MUTATION",validationPreviewCalls,liveCalls:0,persistentAmazonWrites:0,externalChanges:0,error:err?.message||String(err)});
  }
}

express.application.listen=function amazonB2BSixLiveListen(...args){
  const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));
  if (!exists) this.post(ROUTE,handler);
  return originalListen.apply(this,args);
};
