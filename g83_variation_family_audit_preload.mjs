import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-04-g83-variation-family-audit-v1.0.0";
const ROUTE = "/amazon/listing/g83-variation-family-audit";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const PLAN = Object.freeze({
  familyKey: "G83-HS-11G",
  legacyParentSku: "TJ-00SX-UW3J",
  preserveChild: { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", memoryGB: 16, storageGB: 256 },
  listings: [
    { sku: "CH-CIRX-CP7X", asin: "B0FPC2HV45", memoryGB: 16, storageGB: 256, role: "LEGACY_DUPLICATE" },
    { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", memoryGB: 16, storageGB: 256, role: "PRESERVE_CANONICAL" },
    { sku: "LeLib_G83_i511g_16GB_SSD256", asin: "B0DR9BRG8B", memoryGB: 16, storageGB: 256, role: "THIRD_PARTY_EXCEPTION" },
    { sku: "g83-i5-11-16gb-ssd256", asin: "B0GN7YRC3J", memoryGB: 16, storageGB: 256, role: "LEGACY_DUPLICATE" },
    { sku: "5K-G098-FO9O", asin: "B0FPC52B8K", memoryGB: 16, storageGB: 512, role: "LEGACY_CHILD" },
    { sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", memoryGB: 16, storageGB: 1024, role: "LEGACY_CHILD" },
    { sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", memoryGB: 8, storageGB: 256, role: "LEGACY_CHILD" },
    { sku: "g83-i5-11-8gb-ssd256", asin: "B0GN84QRCF", memoryGB: 8, storageGB: 256, role: "LEGACY_DUPLICATE" },
    { sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", memoryGB: 8, storageGB: 512, role: "LEGACY_CHILD" },
    { sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", memoryGB: 8, storageGB: 1024, role: "LEGACY_CHILD" }
  ]
});

function jsonParse(text){try{return text?JSON.parse(text):{};}catch{return {rawText:String(text||"").slice(0,1000)};}}
function secret(){return String(process.env.AMAZON_STOCK_API_SECRET||"").trim();}
function config(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if(marketplaceId!==MARKETPLACE_ID) throw new Error(`GUARD_BLOCKED marketplace=${marketplaceId}`);
  return {sellerId,marketplaceId,endpoint};
}
async function ft(url,opt={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);try{return await fetch(url,{...opt,signal:c.signal});}finally{clearTimeout(t);}}
async function token(){
  const clientId=process.env.LWA_CLIENT_ID,clientSecret=process.env.LWA_CLIENT_SECRET,refreshToken=process.env.REFRESH_TOKEN;
  if(!clientId||!clientSecret||!refreshToken) throw new Error("Missing LWA env");
  const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})});
  const x=jsonParse(await r.text()); if(!r.ok||!x.access_token) throw new Error(`LWA token ${r.status}`); return x.access_token;
}
async function req(url,a){const r=await ft(url,{headers:{"x-amz-access-token":a,accept:"application/json"}});return {http:r.status,ok:r.ok,body:jsonParse(await r.text())};}
function first(rows,key="value"){return Array.isArray(rows)&&rows[0]?rows[0]?.[key]??null:null;}
function nested(rows,key){return Array.isArray(rows)&&rows[0]&&Array.isArray(rows[0]?.[key])&&rows[0][key][0]?rows[0][key][0]?.value??null:null;}
function qty(listing){return (Array.isArray(listing?.fulfillmentAvailability)?listing.fulfillmentAvailability:[]).reduce((n,x)=>n+(Number.isFinite(Number(x?.quantity))?Number(x.quantity):0),0);}
function relationSnapshot(attrs){return {parentageLevel:first(attrs?.parentage_level),parentSku:first(attrs?.child_parent_sku_relationship,"parent_sku")||null,childRelationshipType:first(attrs?.child_parent_sku_relationship,"child_relationship_type")||null,variationTheme:first(attrs?.variation_theme,"name")||null};}
function specSnapshot(attrs){const hardDisk=nested(attrs?.hard_disk,"size"),flash=nested(attrs?.flash_memory,"installed_size"),ram=nested(attrs?.ram_memory,"installed_size");return {ramGB:ram===null?null:Number(ram),hardDiskGB:hardDisk===null?null:Number(hardDisk),flashMemoryGB:flash===null?null:Number(flash)};}
async function listingGet(a,sku){const {sellerId,marketplaceId,endpoint}=config();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a);}
async function catalogGet(a,asin){const {marketplaceId,endpoint}=config();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"attributes,images,productTypes,relationships,summaries"});return req(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${q}`,a);}
async function ptd(a){const {sellerId,marketplaceId,endpoint}=config();const q=new URLSearchParams({sellerId,marketplaceIds:marketplaceId,requirements:"LISTING",requirementsEnforced:"ENFORCED",locale:"ja_JP"});const d=await req(`${endpoint}/definitions/2020-09-01/productTypes/${PRODUCT_TYPE}?${q}`,a);if(!d.ok)throw new Error(`PTD GET ${d.http}`);const u=String(d.body?.schema?.link?.resource||"");if(!u)throw new Error("PTD schema link missing");const r=await ft(u,{headers:{accept:"application/json"}});const s=jsonParse(await r.text());if(!r.ok)throw new Error(`PTD schema ${r.status}`);return s;}
function rawValues(spec){const out=[];const seen=new Set();(function walk(n,d){if(!n||typeof n!=="object"||d>7)return;if(Array.isArray(n)){n.forEach(x=>walk(x,d+1));return;}if(Array.isArray(n.enum))for(const v of n.enum){const k=JSON.stringify(v);if(!seen.has(k)){seen.add(k);out.push(v);}}if(n.const!==undefined){const k=JSON.stringify(n.const);if(!seen.has(k)){seen.add(k);out.push(n.const);}}for(const k of ["items","properties","oneOf","anyOf","allOf"])walk(n[k],d+1);})(spec,0);return out;}
function nestedSpec(s,name,child){return s?.properties?.[name]?.items?.properties?.[child]||null;}
function ptdSummary(s){const themes=rawValues(nestedSpec(s,"variation_theme","name")).map(String);return {parentageValues:rawValues(nestedSpec(s,"parentage_level","value")).map(String),relationshipValues:rawValues(nestedSpec(s,"child_parent_sku_relationship","child_relationship_type")).map(String),ramStorageThemes:themes.filter(v=>/(RAM|MEMORY)/i.test(v)&&/HARD_DISK_SIZE/i.test(v)),storageThemes:themes.filter(v=>/HARD_DISK_SIZE/i.test(v)).slice(0,30),variationThemeCount:themes.length};}
function listingSummary(plan,r){if(!r.ok)return {...plan,exists:false,httpStatus:r.http,error:r.body};const x=r.body,s=Array.isArray(x?.summaries)?x.summaries[0]||{}:{},a=x?.attributes&&typeof x.attributes==="object"?x.attributes:{},issues=Array.isArray(x?.issues)?x.issues:[];return {...plan,exists:true,httpStatus:r.http,actualAsin:String(s?.asin||""),productType:String(s?.productType||""),title:String(s?.itemName||first(a?.item_name)||""),statuses:Array.isArray(s?.status)?s.status:[],availableQuantity:qty(x),relation:relationSnapshot(a),spec:specSnapshot(a),conditionType:first(a?.condition_type),offers:Array.isArray(x?.offers)?x.offers:[],issueCount:issues.length,errorCount:issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR").length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))]};}
async function handler(req0,res){try{const sec=secret();if(!sec)return res.status(500).json({ok:false,readOnly:true,externalChanges:0,error:"secret missing"});if(String(req0.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,readOnly:true,externalChanges:0,error:"Unauthorized"});if(req0.body?.dryRun===false)throw new Error("LIVE disabled");const a=await token(),schema=await ptd(a),listings=[],catalogs=[];for(const p of PLAN.listings){const lr=await listingGet(a,p.sku),ls=listingSummary(p,lr);listings.push(ls);if(ls.exists&&ls.actualAsin){const cr=await catalogGet(a,ls.actualAsin);catalogs.push({sku:p.sku,asin:ls.actualAsin,httpStatus:cr.http,ok:cr.ok,catalog:cr.ok?{asin:cr.body?.asin||"",productTypes:cr.body?.productTypes||[],relationships:cr.body?.relationships||[],summaries:cr.body?.summaries||[]}:null});}}const parentRaw=await listingGet(a,PLAN.legacyParentSku),legacyParent=listingSummary({sku:PLAN.legacyParentSku,role:"LEGACY_PARENT"},parentRaw),preserved=listings.find(x=>x.sku===PLAN.preserveChild.sku)||null,ptdInfo=ptdSummary(schema),blockers=[];if(!preserved?.exists)blockers.push("PRESERVE_CHILD_MISSING");if(preserved?.actualAsin!==PLAN.preserveChild.asin)blockers.push("PRESERVE_CHILD_ASIN_MISMATCH");if(preserved?.productType!==PRODUCT_TYPE)blockers.push("PRESERVE_CHILD_PRODUCT_TYPE_MISMATCH");if((preserved?.errorCount||0)>0)blockers.push("PRESERVE_CHILD_LISTING_ERROR");if(!ptdInfo.ramStorageThemes.length)blockers.push("NO_RAM_PLUS_STORAGE_THEME_IN_CURRENT_PTD");return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,amazonPersistentWrites:0,inventoryWrites:0,priceWrites:0,adsWrites:0,yahooWrites:0,plan:PLAN,productTypeDefinition:ptdInfo,legacyParent,listings,catalogs,decision:{readyForValidationPreview:blockers.length===0,blockers},liveAllowed:false,liveBlockedReason:"EXPLICIT_USER_LIVE_APPROVAL_REQUIRED"});}catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,readOnly:true,externalChanges:0,error:err?.message||String(err)});}}
express.application.listen=function g83VariationFamilyAuditListen(...args){const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);return originalListen.apply(this,args);};
