import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

/**
 * Amazon B2B six-SKU explicit-price Validation Preview v1.2.0
 * 2026-08-29
 *
 * VALIDATION_PREVIEW ONLY.
 *
 * Discovery from v1.0.0 preflight:
 * Listings Items includedData=offers already exposes an actual B2B offer for all six,
 * even when attributes.purchasable_offer has no explicit B2B row. Therefore this
 * route treats actualOffer B2B as authoritative current state and supports both:
 *   - explicit B2B attribute already present -> replace its our_price
 *   - actual B2B offer present but explicit attribute absent -> append explicit B2B row
 *
 * Quantity discounts are not added or changed.
 * No persistent Amazon mutation; externalChanges=0.
 */
const MODULE_VERSION = "2026-08-29-amazon-b2b-six-validation-preview-v1.2.0";
const ROUTE = "/amazon/price/b2b/six-create-validation-preview";
const BATCH_TOKEN = "AMAZON_B2B_6_CREATE_20260827_V1";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
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
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && value !== null) {
    for (const key of ["amount","Amount","value","Value","pointsNumber","PointsNumber","points_number"]) {
      if (value[key] !== undefined) return numberOrNull(value[key]);
    }
  }
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function hasOwn(obj, key) { return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key); }
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
  const clientId = process.env.LWA_CLIENT_ID, clientSecret = process.env.LWA_CLIENT_SECRET, refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}
async function amazonRequest(url, options) {
  let lastError = null;
  for (let attempt=1; attempt<=MAX_RETRIES; attempt+=1) {
    const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
    try {
      const response=await fetch(url,{...options,signal:controller.signal});
      const json=safeJsonParse(await response.text());
      if (response.ok) return {response,json};
      const retryable=response.status===429||response.status>=500;
      if (!retryable || attempt===MAX_RETRIES) { const e=new Error(`SP-API error: ${response.status} ${JSON.stringify(json).slice(0,2500)}`); e.amazonBody=json; throw e; }
      const ra=Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(ra)&&ra>0?ra*1000:RETRY_BASE_MS*attempt);
    } catch(err) { lastError=err; if(attempt===MAX_RETRIES) throw err; await sleep(RETRY_BASE_MS*attempt); }
    finally { clearTimeout(timer); }
  }
  throw lastError || new Error("SP-API request failed");
}
async function getListing(accessToken, sku) {
  const {sellerId,marketplaceId,endpoint}=getConfig();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  const url=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  return (await amazonRequest(url,{method:"GET",headers:{"x-amz-access-token":accessToken,accept:"application/json"}})).json;
}
async function validationPreview(accessToken, sku, productType, offers) {
  const {sellerId,marketplaceId,endpoint}=getConfig();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",mode:"VALIDATION_PREVIEW"});
  const url=`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`;
  const body={productType,patches:[{op:"replace",path:"/attributes/purchasable_offer",value:offers}]};
  const result=(await amazonRequest(url,{method:"PATCH",headers:{"x-amz-access-token":accessToken,accept:"application/json","content-type":"application/json"},body:JSON.stringify(body)})).json;
  const issues=Array.isArray(result?.issues)?result.issues:[];
  return {result,body,errors:issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR")};
}
function scheduleEntries(offer,key){const s=offer?.[key]?.[0]?.schedule;return Array.isArray(s)?s:[];}
function scheduleIsActive(s,now){const st=epochOrNull(s?.start_at),en=epochOrNull(s?.end_at);if(st!==null&&now<st)return false;if(en!==null&&now>=en)return false;return true;}
function activeSchedule(offer,key,now){return scheduleEntries(offer,key).filter(s=>scheduleIsActive(s,now)).sort((a,b)=>(epochOrNull(b?.start_at)??0)-(epochOrNull(a?.start_at)??0))[0]||null;}
function audienceValue(offer){if(!offer)return "";if(typeof offer.audience==="string")return String(offer.audience).toUpperCase();return String(offer?.audience?.value||offer?.audience?.displayName||"").toUpperCase();}
function offerType(offer){return String(offer?.offerType||offer?.offer_type||"").toUpperCase();}
function offerPrice(offer){return offer&&hasOwn(offer,"price")?numberOrNull(offer.price):null;}
function parsePointsValue(raw){if(raw===null||raw===undefined||raw==="")return null;if(typeof raw!=="object")return numberOrNull(raw);for(const k of ["pointsNumber","PointsNumber","points_number","amount","Amount","value","Value"]){if(raw[k]!==undefined){const n=numberOrNull(raw[k]);if(n!==null)return n;}}return null;}
function currentOfferSummary(listing){
  const {marketplaceId}=getConfig();
  const offers=Array.isArray(listing?.offers)?listing.offers:[];
  const market=offers.filter(o=>{const id=String(o?.marketplaceId||o?.marketplace_id||"");return !id||id===marketplaceId;});
  const b2c=market.find(o=>offerType(o)==="B2C"||audienceValue(o)==="ALL")||null;
  const b2b=market.find(o=>offerType(o)==="B2B"||audienceValue(o)==="B2B")||null;
  return {b2cPresent:Boolean(b2c),b2cPrice:offerPrice(b2c),pointsPresent:Boolean(b2c&&hasOwn(b2c,"points")),points:b2c&&hasOwn(b2c,"points")?parsePointsValue(b2c.points):null,b2bPresent:Boolean(b2b),b2bPrice:offerPrice(b2b)};
}
function analyze(approved,listing,now){
  const summary=Array.isArray(listing?.summaries)?listing.summaries[0]||{}:{};
  const attrs=listing?.attributes||{},issues=Array.isArray(listing?.issues)?listing.issues:[];
  const errors=issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR"),statuses=Array.isArray(summary?.status)?summary.status.map(String):[];
  const offers=Array.isArray(attrs?.purchasable_offer)?JSON.parse(JSON.stringify(attrs.purchasable_offer)):[];
  const indexed=offers.map((offer,index)=>({offer,index}));
  const consumers=indexed.filter(x=>String(x.offer?.audience||"ALL").toUpperCase()==="ALL");
  const b2bs=indexed.filter(x=>String(x.offer?.audience||"").toUpperCase()==="B2B");
  const consumer=consumers.length===1?consumers[0].offer:null;
  const normal=numberOrNull(activeSchedule(consumer,"our_price",now)?.value_with_tax), sale=numberOrNull(activeSchedule(consumer,"discounted_price",now)?.value_with_tax);
  const effective=sale!==null?sale:normal, min=numberOrNull(activeSchedule(consumer,"minimum_seller_allowed_price",now)?.value_with_tax), max=numberOrNull(activeSchedule(consumer,"maximum_seller_allowed_price",now)?.value_with_tax);
  const qty=numberOrNull(listing?.fulfillmentAvailability?.[0]?.quantity)??numberOrNull(attrs?.fulfillment_availability?.[0]?.quantity)??0;
  const actual=currentOfferSummary(listing),blocks=[];
  if(String(summary?.asin||"")!==approved.asin)blocks.push(`ASIN_MISMATCH:${String(summary?.asin||"")}`);
  if(!String(summary?.productType||""))blocks.push("PRODUCT_TYPE_MISSING");
  if(!statuses.includes("BUYABLE"))blocks.push(`NOT_BUYABLE:${statuses.join(",")}`);
  if(errors.length)blocks.push(`LISTING_ERRORS:${errors.map(x=>String(x?.code||"")).join(",")}`);
  if(!(qty>0))blocks.push(`NO_INVENTORY:${qty}`);
  if(consumers.length!==1)blocks.push(`CONSUMER_OFFER_COUNT:${consumers.length}`);
  if(b2bs.length>1)blocks.push(`B2B_ATTRIBUTE_COUNT:${b2bs.length}`);
  if(b2bs.length===1 && scheduleEntries(b2bs[0].offer,"quantity_discount_plan").length)blocks.push("EXISTING_QUANTITY_PLAN_PRESENT");
  if(!actual.b2cPresent||actual.b2cPrice===null)blocks.push("ACTUAL_B2C_OFFER_MISSING");
  if(!actual.b2bPresent||actual.b2bPrice===null)blocks.push("ACTUAL_B2B_OFFER_MISSING");
  if(actual.b2bPrice!==approved.currentActualB2b)blocks.push(`ACTUAL_B2B_DRIFT:${actual.b2bPrice}`);
  if(!actual.pointsPresent||actual.points===null)blocks.push("AMAZON_POINTS_MISSING");
  if(normal!==approved.normal)blocks.push(`NORMAL_PRICE_DRIFT:${normal}`);
  if(effective!==approved.effective)blocks.push(`EFFECTIVE_PRICE_DRIFT:${effective}`);
  if(actual.points!==approved.points)blocks.push(`POINTS_DRIFT:${actual.points}`);
  if(min!==approved.min)blocks.push(`MINIMUM_DRIFT:${min}`);
  if(approved.targetB2b<approved.min)blocks.push(`TARGET_BELOW_MIN:${approved.targetB2b}<${approved.min}`);
  if(effective===null||approved.targetB2b>=effective)blocks.push(`TARGET_NOT_BELOW_EFFECTIVE:${approved.targetB2b}>=${effective}`);
  if(max!==null&&approved.targetB2b>max)blocks.push(`TARGET_ABOVE_MAX:${approved.targetB2b}>${max}`);
  return {approved,asin:String(summary?.asin||""),productType:String(summary?.productType||""),statuses,buyable:statuses.includes("BUYABLE"),errorCount:errors.length,qty,offers,consumer,b2bIndex:b2bs.length===1?b2bs[0].index:-1,b2bAttribute:b2bs.length===1?b2bs[0].offer:null,consumerState:{normal,sale,effective,min,max},actual,blocks};
}
function setOfferPrice(offer,target){
  if(!Array.isArray(offer.our_price)||!offer.our_price.length)throw new Error("our_price missing");
  const first=JSON.parse(JSON.stringify(offer.our_price[0]||{}));
  first.schedule=[{value_with_tax:target}];
  offer.our_price=[first];
}
function buildOffers(state){
  const offers=JSON.parse(JSON.stringify(state.offers));
  let b2b,mode;
  if(state.b2bIndex>=0){b2b=JSON.parse(JSON.stringify(offers[state.b2bIndex]));setOfferPrice(b2b,state.approved.targetB2b);offers[state.b2bIndex]=b2b;mode="REPLACE_EXPLICIT_B2B_ATTRIBUTE";}
  else {
    b2b=JSON.parse(JSON.stringify(state.consumer));b2b.audience="B2B";
    delete b2b.discounted_price;delete b2b.minimum_seller_allowed_price;delete b2b.maximum_seller_allowed_price;delete b2b.quantity_discount_plan;
    setOfferPrice(b2b,state.approved.targetB2b);offers.push(b2b);mode="APPEND_EXPLICIT_B2B_ATTRIBUTE";
  }
  return {offers,b2b,mode};
}
function summarizeValidation(result){return (Array.isArray(result?.issues)?result.issues:[]).map(i=>({code:String(i?.code||""),severity:String(i?.severity||""),message:String(i?.message||"").slice(0,1000),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames.map(String):[]}));}

async function handler(req,res){
  try {
    const secret=getSecret();if(!secret)return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,error:"AMAZON_STOCK_API_SECRET is not set"});
    if(String(req.headers["x-api-secret"]||"")!==secret)return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,error:"Unauthorized"});
    if(String(req.body?.batchToken||"")!==BATCH_TOKEN)return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,error:`batchToken must equal ${BATCH_TOKEN}`});
    const at=await getLwaAccessToken(),now=Date.now(),states=[];
    for(const approved of APPROVED)states.push(analyze(approved,await getListing(at,approved.sku),now));
    const failures=states.filter(s=>s.blocks.length).map(s=>({sku:s.approved.sku,asin:s.approved.asin,blocks:s.blocks}));
    if(failures.length)return res.status(409).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"PREFLIGHT_BLOCKED_NO_VALIDATION_CALLS",approvedCount:6,preflightPassed:6-failures.length,preflightFailed:failures.length,validationPreviewCalls:0,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,failures});
    const results=[];let passed=0;
    for(const state of states){
      const built=buildOffers(state);
      try{
        const preview=await validationPreview(at,state.approved.sku,state.productType,built.offers),issues=summarizeValidation(preview.result),errs=issues.filter(i=>i.severity.toUpperCase()==="ERROR"),ok=errs.length===0;if(ok)passed++;
        results.push({sku:state.approved.sku,asin:state.approved.asin,currentActualB2bPrice:state.actual.b2bPrice,targetB2bPrice:state.approved.targetB2b,currentMinimum:state.consumerState.min,currentEffectivePrice:state.consumerState.effective,amazonPoints:state.actual.points,availableQuantity:state.qty,attributeMode:built.mode,validationPassed:ok,validationStatus:String(preview.result?.status||""),submissionId:String(preview.result?.submissionId||""),issues});
      }catch(err){results.push({sku:state.approved.sku,asin:state.approved.asin,currentActualB2bPrice:state.actual.b2bPrice,targetB2bPrice:state.approved.targetB2b,attributeMode:built.mode,validationPassed:false,transportError:err?.message||String(err),amazonBody:err?.amazonBody||null});}
    }
    const all=passed===6;
    return res.status(all?200:409).json({ok:all,moduleVersion:MODULE_VERSION,route:ROUTE,decision:all?"VALIDATION_PREVIEW_ALL_6_PASSED":"VALIDATION_PREVIEW_FAILED_REVIEW_REQUIRED",approvedCount:6,preflightPassed:6,preflightFailed:0,validationPreviewCalls:6,validationPassedCount:passed,validationFailedCount:6-passed,persistentAmazonWrites:0,liveCalls:0,externalChanges:0,results});
  } catch(err){console.error("B2B six validation preview error",err);return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,decision:"ERROR",error:err?.message||String(err),validationPreviewCalls:0,persistentAmazonWrites:0,liveCalls:0,externalChanges:0});}
}

express.application.listen=function amazonB2bSixValidationPreviewListen(...args){const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);return originalListen.apply(this,args);};