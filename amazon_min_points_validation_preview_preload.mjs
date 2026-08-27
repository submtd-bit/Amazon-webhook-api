import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon minimum seller allowed price - Points-aware Validation Preview v1.0.0
 * 2026-08-27
 *
 * VALIDATION_PREVIEW ONLY.
 * - Exact 12-SKU approved batch is hard-coded.
 * - Fresh listing state is read for all 12 before any preview call.
 * - Current Amazon points are included as an absolute seller cost.
 * - Approved minimum is recomputed from current points and immutable economics.
 * - Any preflight drift blocks ALL preview calls.
 * - E7 approved B2B 39,900 / 10 units 3% quantity plan is explicitly preserved.
 * - No persistent Amazon mutation; externalChanges=0.
 */
const MODULE_VERSION = "2026-08-27-amazon-min-points-validation-preview-v1.0.0";
const ROUTE = "/amazon/price/minimum/points-aware-validation-preview";
const BATCH_TOKEN = "AMAZON_MIN_POINTS_12_20260827_V1";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const originalListen = express.application.listen;

const APPROVED = Object.freeze([
  Object.freeze({ sku: "LeLib_SV1_16gb_256", asin: "B0G59QKJXB", totalCost: 27750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 40500 }),
  Object.freeze({ sku: "RB-Y7G2-H0EK", asin: "B0GZGM1BND", totalCost: 27750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 40500 }),
  Object.freeze({ sku: "LeLib_SV1_16GB_SSD512", asin: "B0G5ZRLZZH", totalCost: 37750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 54900 }),
  Object.freeze({ sku: "ZK-N79H-VRJQ", asin: "B0D4QMJK1Z", totalCost: 20850, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 30300 }),
  Object.freeze({ sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", totalCost: 44750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 65200 }),
  Object.freeze({ sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", totalCost: 24750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 36200 }),
  Object.freeze({ sku: "5K-G098-FO9O", asin: "B0FPC52B8K", totalCost: 34750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 50800 }),
  Object.freeze({ sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", totalCost: 36750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 53800 }),
  Object.freeze({ sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", totalCost: 16750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 25000 }),
  Object.freeze({ sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", totalCost: 26750, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 39400 }),
  Object.freeze({ sku: "FU-OAHV-H4W4", asin: "B0H211KYDG", totalCost: 18850, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 27900 }),
  Object.freeze({ sku: "LeLib_l580_i5-8G_16gb_SSD256", asin: "B0F333JB5Q", totalCost: 26450, feeRate: 0.10, minProfit: 5000, minGrossRate: 0.20, approvedMin: 38500 }),
]);

const PROTECTED_E7 = Object.freeze({
  sku: "E7-YLJ3-F9CY",
  b2bPrice: 39900,
  discountType: "percent",
  lowerBound: 10,
  value: 3,
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
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
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function hasOwn(obj, key) { return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key); }
function ceil100(v) { return Math.ceil(v / 100) * 100; }
function epochOrNull(v) { const t = Date.parse(String(v || "")); return Number.isFinite(t) ? t : null; }
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
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const j = safeJsonParse(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA token error: ${r.status}`);
  return j.access_token;
}
async function amazonRequest(url, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...options, signal: controller.signal });
      const text = await r.text();
      const json = safeJsonParse(text);
      if (r.ok) return { response: r, json };
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) throw new Error(`SP-API error: ${r.status} ${JSON.stringify(json).slice(0, 2000)}`);
      const retryAfter = Number(r.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * attempt);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error("SP-API request failed");
}
async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,offers,fulfillmentAvailability", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  return (await amazonRequest(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } })).json;
}
function scheduleEntries(offer, key) { const s = offer?.[key]?.[0]?.schedule; return Array.isArray(s) ? s : []; }
function scheduleActive(schedule, nowMs) {
  const start = epochOrNull(schedule?.start_at); const end = epochOrNull(schedule?.end_at);
  if (start !== null && nowMs < start) return false;
  if (end !== null && nowMs >= end) return false;
  return true;
}
function activeSchedule(offer, key, nowMs) {
  return scheduleEntries(offer, key).filter(s => scheduleActive(s, nowMs)).sort((a,b)=>(epochOrNull(b?.start_at)??0)-(epochOrNull(a?.start_at)??0))[0] || null;
}
function audienceValue(offer) {
  if (!offer) return "";
  if (typeof offer.audience === "string") return String(offer.audience).toUpperCase();
  return String(offer?.audience?.value || offer?.audience?.displayName || "").toUpperCase();
}
function offerType(offer) { return String(offer?.offerType || offer?.offer_type || "").toUpperCase(); }
function listingOfferSummary(listing) {
  const { marketplaceId } = getConfig();
  const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const market = offers.filter(o => { const id = String(o?.marketplaceId || o?.marketplace_id || ""); return !id || id === marketplaceId; });
  const b2c = market.find(o => offerType(o) === "B2C" || audienceValue(o) === "ALL") || null;
  const b2b = market.find(o => offerType(o) === "B2B" || audienceValue(o) === "B2B") || null;
  return {
    b2c: { present:Boolean(b2c), price:b2c&&hasOwn(b2c,"price")?numberOrNull(b2c.price):null, pointsPresent:Boolean(b2c&&hasOwn(b2c,"points")), points:b2c&&hasOwn(b2c,"points")?numberOrNull(b2c.points):null },
    b2b: { present:Boolean(b2b), price:b2b&&hasOwn(b2b,"price")?numberOrNull(b2b.price):null },
  };
}
function quantityPlan(b2bOffer, b2bPrice, nowMs) {
  const schedule = activeSchedule(b2bOffer, "quantity_discount_plan", nowMs) || {};
  const discountType = String(schedule?.discount_type || "").toLowerCase();
  const raw = Array.isArray(schedule?.levels) ? schedule.levels : [];
  const levels = raw.map(level => {
    const lowerBound=numberOrNull(level?.lower_bound), value=numberOrNull(level?.value); let effective=null;
    if(lowerBound!==null&&value!==null){if(discountType==="percent"&&b2bPrice!==null)effective=b2bPrice*(1-value/100);else if(discountType==="fixed_price")effective=value;}
    return {lowerBound,value,effectivePrice:effective};
  }).filter(x=>x.lowerBound!==null&&x.value!==null);
  const effective=levels.map(x=>x.effectivePrice).filter(x=>x!==null);
  return {discountType,levels,lowestEffective:effective.length?Math.min(...effective):null};
}
function recomputeApprovedMin(item, pointsAmount) {
  const profitFloor=ceil100((item.totalCost+pointsAmount+item.minProfit)/(1-item.feeRate));
  const grossFloor=ceil100((item.totalCost+pointsAmount)/(1-item.feeRate-item.minGrossRate));
  return {profitFloor,grossFloor,computedMin:Math.max(profitFloor,grossFloor)};
}
function analyze(item, listing, nowMs) {
  const summary=Array.isArray(listing?.summaries)?listing.summaries[0]||{}:{};
  const attrs=listing?.attributes||{};
  const issues=Array.isArray(listing?.issues)?listing.issues:[];
  const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR");
  const statuses=Array.isArray(summary?.status)?summary.status.map(String):[];
  const buyable=statuses.includes("BUYABLE"); const productType=String(summary?.productType||""); const asin=String(summary?.asin||"");
  const purchasableOffers=Array.isArray(attrs?.purchasable_offer)?JSON.parse(JSON.stringify(attrs.purchasable_offer)):[];
  const consumerIndexes=purchasableOffers.map((offer,index)=>({offer,index})).filter(x=>String(x.offer?.audience||"ALL").toUpperCase()==="ALL");
  const b2bIndexes=purchasableOffers.map((offer,index)=>({offer,index})).filter(x=>String(x.offer?.audience||"").toUpperCase()==="B2B");
  const consumer=consumerIndexes.length===1?consumerIndexes[0].offer:null;
  const b2b=b2bIndexes.length===1?b2bIndexes[0].offer:null;
  const normal=numberOrNull(activeSchedule(consumer,"our_price",nowMs)?.value_with_tax);
  const sale=numberOrNull(activeSchedule(consumer,"discounted_price",nowMs)?.value_with_tax);
  const effectiveCurrentPrice=sale!==null?sale:normal;
  const currentMin=numberOrNull(activeSchedule(consumer,"minimum_seller_allowed_price",nowMs)?.value_with_tax);
  const maximum=numberOrNull(activeSchedule(consumer,"maximum_seller_allowed_price",nowMs)?.value_with_tax);
  const b2bPrice=numberOrNull(activeSchedule(b2b,"our_price",nowMs)?.value_with_tax);
  const qty=quantityPlan(b2b,b2bPrice,nowMs);
  const listed=listingOfferSummary(listing); const points=listed.b2c.points;
  const economics=points!==null?recomputeApprovedMin(item,points):null;
  const blocks=[];
  if(asin!==item.asin)blocks.push(`ASIN_MISMATCH:${asin}`);
  if(productType!=="NOTEBOOK_COMPUTER")blocks.push(`PRODUCT_TYPE_MISMATCH:${productType}`);
  if(!buyable)blocks.push("NOT_BUYABLE");
  if(errors.length)blocks.push(`LISTING_ERRORS:${errors.map(x=>String(x?.code||"")).join(",")}`);
  if(consumerIndexes.length!==1)blocks.push(`CONSUMER_OFFER_COUNT:${consumerIndexes.length}`);
  if(!listed.b2c.present||listed.b2c.price===null)blocks.push("ACTUAL_B2C_OFFER_MISSING");
  if(!listed.b2c.pointsPresent||points===null)blocks.push("AMAZON_POINTS_MISSING");
  if(!economics||economics.computedMin!==item.approvedMin)blocks.push(`POINTS_AWARE_FLOOR_DRIFT:${economics?economics.computedMin:"null"}`);
  if(effectiveCurrentPrice===null||item.approvedMin>effectiveCurrentPrice)blocks.push(`MIN_ABOVE_CURRENT_PRICE:${effectiveCurrentPrice}`);
  if(maximum!==null&&item.approvedMin>maximum)blocks.push(`MIN_ABOVE_MAX:${maximum}`);
  if(b2bPrice!==null&&b2bPrice<item.approvedMin)blocks.push(`B2B_BELOW_MIN:${b2bPrice}`);
  if(listed.b2b.price!==null&&listed.b2b.price<item.approvedMin)blocks.push(`ACTUAL_B2B_BELOW_MIN:${listed.b2b.price}`);
  if(qty.lowestEffective!==null&&qty.lowestEffective<item.approvedMin)blocks.push(`QTY_BELOW_MIN:${qty.lowestEffective}`);
  if(item.sku===PROTECTED_E7.sku){const level=qty.levels.find(x=>x.lowerBound===PROTECTED_E7.lowerBound&&x.value===PROTECTED_E7.value);if(b2bPrice!==PROTECTED_E7.b2bPrice||qty.discountType!==PROTECTED_E7.discountType||!level)blocks.push("E7_PROTECTED_B2B_QTY_DRIFT");}
  const afterOffers=JSON.parse(JSON.stringify(purchasableOffers));
  if(consumerIndexes.length===1)afterOffers[consumerIndexes[0].index].minimum_seller_allowed_price=[{schedule:[{value_with_tax:item.approvedMin}]}];
  return {sku:item.sku,asin,productType,statuses,buyable,issueCodes:issues.map(x=>String(x?.code||"")).filter(Boolean),errorCodes:errors.map(x=>String(x?.code||"")).filter(Boolean),normalPrice:normal,activeSalePrice:sale,effectiveCurrentPrice,currentMinimum:currentMin,maximumSellerAllowed:maximum,actualOfferB2C:listed.b2c.price,actualOfferB2B:listed.b2b.price,amazonPoints:points,economics,approvedMin:item.approvedMin,b2bPrice,quantityPlan:qty,protectedE7Match:item.sku===PROTECTED_E7.sku?!blocks.includes("E7_PROTECTED_B2B_QTY_DRIFT"):null,beforeOffers:purchasableOffers,afterOffers,blocks};
}
async function validationPreview(accessToken,item,state){
  const {sellerId,marketplaceId,endpoint}=getConfig();
  const body={productType:state.productType,patches:[{op:"replace",path:"/attributes/purchasable_offer",value:state.afterOffers}]};
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  const url=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(item.sku)}?${q}`;
  const {response:r,json}=await amazonRequest(url,{method:"PATCH",headers:{"x-amz-access-token":accessToken,"content-type":"application/json",accept:"application/json"},body:JSON.stringify(body)});
  const issues=Array.isArray(json?.issues)?json.issues:[]; const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR"); const status=String(json?.status||"").toUpperCase();
  return {sku:item.sku,asin:item.asin,approvedMin:item.approvedMin,httpStatus:r.status,responseOk:r.ok,status,submissionId:String(json?.submissionId||""),errorCount:errors.length,issueCodes:issues.map(x=>String(x?.code||"")).filter(Boolean),issues,validationPassed:r.ok&&errors.length===0&&(status==="VALID"||status==="ACCEPTED")};
}
async function handler(req,res){
  const fetchedAt=new Date().toISOString(); const nowMs=Date.parse(fetchedAt);
  try{
    const secret=getSecret();
    if(!secret)return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,error:"AMAZON_STOCK_API_SECRET is not set"});
    if(String(req.headers["x-api-secret"]||"")!==secret)return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,error:"Unauthorized"});
    if(String(req.body?.batchToken||"")!==BATCH_TOKEN)throw new Error("GUARD_BLOCKED: invalid batchToken");
    if(req.body?.dryRun===false)throw new Error("LIVE_DISABLED: VALIDATION_PREVIEW only");
    const accessToken=await getLwaAccessToken(); const preflight=[];
    for(const item of APPROVED){const listing=await getListing(accessToken,item.sku);preflight.push(analyze(item,listing,nowMs));await sleep(150);}
    const blocked=preflight.filter(x=>x.blocks.length>0);
    if(blocked.length)return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,batchToken:BATCH_TOKEN,decision:"STOP_PREFLIGHT_DRIFT_NO_PREVIEW_CALLED",fetchedAt,approvedCount:APPROVED.length,blockedCount:blocked.length,previewCalls:0,blocked:blocked.map(x=>({sku:x.sku,asin:x.asin,approvedMin:x.approvedMin,currentMinimum:x.currentMinimum,effectiveCurrentPrice:x.effectiveCurrentPrice,amazonPoints:x.amazonPoints,economics:x.economics,b2bPrice:x.b2bPrice,quantityPlan:x.quantityPlan,blocks:x.blocks})),externalChanges:0});
    const previews=[]; for(let i=0;i<APPROVED.length;i+=1){previews.push(await validationPreview(accessToken,APPROVED[i],preflight[i]));await sleep(200);}
    const passed=previews.filter(x=>x.validationPassed).length;
    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,batchToken:BATCH_TOKEN,decision:passed===APPROVED.length?"VALIDATION_PREVIEW_ALL_12_PASSED":"VALIDATION_PREVIEW_HAS_ERRORS",fetchedAt,approvedCount:APPROVED.length,preflightPassed:APPROVED.length,previewCalls:previews.length,validationPassedCount:passed,validationFailedCount:previews.length-passed,safety:{mode:"VALIDATION_PREVIEW",persistentAmazonWrites:0,spreadsheetWrites:0,liveCalls:0,externalChanges:0},preflight:preflight.map(x=>({sku:x.sku,asin:x.asin,approvedMin:x.approvedMin,currentMinimum:x.currentMinimum,effectiveCurrentPrice:x.effectiveCurrentPrice,maximumSellerAllowed:x.maximumSellerAllowed,amazonPoints:x.amazonPoints,economics:x.economics,actualOfferB2C:x.actualOfferB2C,actualOfferB2B:x.actualOfferB2B,b2bPrice:x.b2bPrice,quantityPlan:x.quantityPlan,protectedE7Match:x.protectedE7Match})),previews,externalChanges:0,note:"All PATCH calls used mode=VALIDATION_PREVIEW. No persistent listing mutation was requested."});
  }catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,batchToken:BATCH_TOKEN,decision:"STOP_EXCEPTION",previewCalls:0,externalChanges:0,error:err?.message||String(err)});}
}
express.application.listen=function amazonMinPointsValidationPreviewListen(...args){const alreadyRegistered=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));if(!alreadyRegistered)this.post(ROUTE,handler);return originalListen.apply(this,args);};
