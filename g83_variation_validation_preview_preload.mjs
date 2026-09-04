import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-04-g83-variation-validation-preview-v1.0.0";
const ROUTE = "/amazon/listing/g83-variation-validation-preview";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const VARIATION_THEME = "HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";
const PARENT_SKU = "g83-hs-i5-11g-variation-parent";
const PARENT_TITLE = "【整備済み品】ダイナブック G83/HS 中古ノートパソコン 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ Wi-Fi6 ノートン360付属 MTD整備済み";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const CHILDREN = Object.freeze([
  { sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", memoryGB: 8, storageGB: 256 },
  { sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", memoryGB: 8, storageGB: 512 },
  { sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", memoryGB: 8, storageGB: 1024 },
  { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", memoryGB: 16, storageGB: 256, canonical: true },
  { sku: "5K-G098-FO9O", asin: "B0FPC52B8K", memoryGB: 16, storageGB: 512 },
  { sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", memoryGB: 16, storageGB: 1024 }
]);

function jparse(text){ try{return text?JSON.parse(text):{};}catch{return {rawText:String(text||"").slice(0,1200)};} }
function clone(v){ return JSON.parse(JSON.stringify(v)); }
function secret(){ return String(process.env.AMAZON_STOCK_API_SECRET||"").trim(); }
function cfg(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if(marketplaceId!==MARKETPLACE_ID) throw new Error(`GUARD_BLOCKED marketplace=${marketplaceId}`);
  return {sellerId,marketplaceId,endpoint};
}
async function ft(url,opt={}){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);
  try{return await fetch(url,{...opt,signal:c.signal});} finally{clearTimeout(t);}
}
async function token(){
  const clientId=process.env.LWA_CLIENT_ID, clientSecret=process.env.LWA_CLIENT_SECRET, refreshToken=process.env.REFRESH_TOKEN;
  if(!clientId||!clientSecret||!refreshToken) throw new Error("Missing LWA env");
  const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})});
  const x=jparse(await r.text()); if(!r.ok||!x.access_token) throw new Error(`LWA token error ${r.status}`); return x.access_token;
}
async function req(url,a,opt={}){
  const r=await ft(url,{method:opt.method||"GET",headers:{"x-amz-access-token":a,accept:"application/json",...(opt.body?{"content-type":"application/json"}:{})},
    ...(opt.body?{body:JSON.stringify(opt.body)}:{})});
  return {http:r.status,ok:r.ok,body:jparse(await r.text())};
}
async function getListing(a,sku){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a);
}
async function getSchema(a){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({sellerId,marketplaceIds:marketplaceId,requirements:"LISTING",requirementsEnforced:"ENFORCED",locale:"ja_JP"});
  const d=await req(`${endpoint}/definitions/2020-09-01/productTypes/${PRODUCT_TYPE}?${q}`,a); if(!d.ok) throw new Error(`PTD GET ${d.http}`);
  const u=String(d.body?.schema?.link?.resource||""); if(!u) throw new Error("PTD schema link missing");
  const r=await ft(u,{headers:{accept:"application/json"}}); const s=jparse(await r.text()); if(!r.ok) throw new Error(`PTD schema fetch ${r.status}`); return s;
}
function rawValues(spec){
  const out=[],seen=new Set();
  (function w(n,d){ if(!n||typeof n!=="object"||d>7)return; if(Array.isArray(n)){n.forEach(x=>w(x,d+1));return;}
    if(Array.isArray(n.enum)) for(const v of n.enum){const k=typeof v+":"+JSON.stringify(v); if(!seen.has(k)){seen.add(k);out.push(v);}}
    if(n.const!==undefined){const v=n.const,k=typeof v+":"+JSON.stringify(v); if(!seen.has(k)){seen.add(k);out.push(v);}}
    for(const k of ["items","properties","oneOf","anyOf","allOf"]) w(n[k],d+1);
  })(spec,0); return out;
}
function nestedSpec(s,n,c){ return s?.properties?.[n]?.items?.properties?.[c]||null; }
function vals(s){ return rawValues(s).map(String); }
function first(rows){ return Array.isArray(rows)&&rows[0]?rows[0].value??null:null; }
function nestedMeasure(rows,key){ return Array.isArray(rows)&&rows[0]&&Array.isArray(rows[0][key])&&rows[0][key][0]?rows[0][key][0]:null; }
function toGB(row){ if(!row)return null; const v=Number(row.value); if(!Number.isFinite(v))return null; const u=String(row.unit||"GB").toUpperCase(); return u==="TB"?v*1024:u==="MB"?v/1024:v; }
function ramGB(a){ return toGB(nestedMeasure(a?.ram_memory,"installed_size")); }
function storageGB(a){ const h=toGB(nestedMeasure(a?.hard_disk,"size")); return h!==null?h:toGB(nestedMeasure(a?.flash_memory,"installed_size")); }
function qty(x){ return (Array.isArray(x?.fulfillmentAvailability)?x.fulfillmentAvailability:[]).reduce((n,r)=>n+(Number.isFinite(Number(r?.quantity))?Number(r.quantity):0),0); }
function relation(a){ return {parentageLevel:first(a?.parentage_level),parentSku:a?.child_parent_sku_relationship?.[0]?.parent_sku??null,
  childRelationshipType:a?.child_parent_sku_relationship?.[0]?.child_relationship_type??null,variationTheme:a?.variation_theme?.[0]?.name??null}; }
function offerSummary(x){ return (Array.isArray(x?.offers)?x.offers:[]).map(r=>({offerType:r?.offerType||"",amount:r?.price?.amount??null,currency:r?.price?.currencyCode||r?.price?.currency||"",
  points:r?.points?.pointsNumber??null,quantityDiscountPlan:r?.quantityDiscountPlan||null})); }
function imageCount(a){ return Object.keys(a||{}).filter(k=>/(main_product_image_locator|other_product_image_locator|swatch_product_image_locator)/i.test(k))
  .reduce((n,k)=>n+(Array.isArray(a[k])?a[k].length:0),0); }
function flatten(v,out=[]){ if(v==null)return out; if(typeof v==="string"){out.push(v);return out;} if(Array.isArray(v)){v.forEach(x=>flatten(x,out));return out;}
  if(typeof v==="object")Object.values(v).forEach(x=>flatten(x,out)); return out; }
function bundle(a,title){ const t=[String(title||"")]; for(const k of ["item_name","included_components","software_included","bullet_point","product_description"]) flatten(a?.[k],t);
  const b=t.join(" ").toUpperCase(); return {office2024:/OFFICE\s*2024|MICROSOFT\s*OFFICE\s*2024|MS\s*OFFICE\s*2024/.test(b),norton360:/NORTON\s*360|ノートン\s*360/.test(b),wps:/WPS\s*OFFICE|WPSOFFICE/.test(b)}; }
function sameBundle(a,b){ return a.office2024===b.office2024&&a.norton360===b.norton360&&a.wps===b.wps; }
function inspect(plan,r){
  if(!r.ok) throw new Error(`CHILD_GET_FAILED ${plan.sku} HTTP ${r.http}`);
  const x=r.body,s=x?.summaries?.[0]||{},a=x?.attributes||{},issues=Array.isArray(x?.issues)?x.issues:[],title=String(s?.itemName||first(a?.item_name)||"");
  if(String(x?.sku||"")!==plan.sku) throw new Error(`SKU_MISMATCH ${plan.sku}`);
  if(String(s?.asin||"")!==plan.asin) throw new Error(`ASIN_MISMATCH ${plan.sku}`);
  if(String(s?.productType||"")!==PRODUCT_TYPE) throw new Error(`PRODUCT_TYPE_MISMATCH ${plan.sku}`);
  const rg=ramGB(a),sg=storageGB(a); if(rg!==plan.memoryGB) throw new Error(`RAM_MISMATCH ${plan.sku} expected=${plan.memoryGB} actual=${rg}`);
  if(sg!==plan.storageGB) throw new Error(`STORAGE_MISMATCH ${plan.sku} expected=${plan.storageGB} actual=${sg}`);
  return {plan,attrs:a,preserve:{sku:plan.sku,asin:plan.asin,title,status:Array.isArray(s?.status)?s.status:[],availableQuantity:qty(x),ramGB:rg,storageGB:sg,
    relationBefore:relation(a),offers:offerSummary(x),imageCount:imageCount(a),issueCount:issues.length,errorCount:issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR").length,
    issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],bundle:bundle(a,title)}};
}
function relationRows(kind,relationship){
  const o={parentage_level:[{marketplace_id:MARKETPLACE_ID,value:kind}],variation_theme:[{name:VARIATION_THEME}]};
  if(kind==="child")o.child_parent_sku_relationship=[{marketplace_id:MARKETPLACE_ID,child_relationship_type:relationship,parent_sku:PARENT_SKU}]; return o;
}
function relationPatches(a,relationship){ return Object.entries(relationRows("child",relationship)).map(([k,v])=>({op:Array.isArray(a?.[k])&&a[k].length?"replace":"add",path:`/attributes/${k}`,value:v})); }
function setValue(a,k,v){ if(Array.isArray(a[k])&&a[k][0]){a[k]=clone(a[k]);a[k][0].value=v;} else a[k]=[{marketplace_id:MARKETPLACE_ID,language_tag:"ja_JP",value:v}]; }
function exclusiveFalse(s){
  const spec=nestedSpec(s,"is_exclusive_product","value"); if(!spec)return null; const allowed=rawValues(spec); let value=null;
  if(allowed.some(v=>v===false))value=false; else if(allowed.some(v=>String(v).toLowerCase()==="false"))value=allowed.find(v=>String(v).toLowerCase()==="false");
  else if(String(spec.type||"").toLowerCase()==="boolean")value=false; return value===null?null:[{marketplace_id:MARKETPLACE_ID,value}];
}
function parentAttrs(source,relationship,exclusive){
  const a=clone(source); for(const k of ["externally_assigned_product_identifier","merchant_suggested_asin","purchasable_offer","fulfillment_availability","condition_type","list_price",
    "minimum_seller_allowed_price","maximum_seller_allowed_price","merchant_shipping_group","hard_disk","flash_memory","ram_memory","computer_memory","memory_storage_capacity",
    "child_parent_sku_relationship","parentage_level","variation_theme"]) delete a[k];
  setValue(a,"item_name",PARENT_TITLE); const r=relationRows("parent",relationship); a.parentage_level=r.parentage_level;a.variation_theme=r.variation_theme;if(exclusive)a.is_exclusive_product=clone(exclusive);return a;
}
async function patchPreview(a,sku,patches){
  const {sellerId,marketplaceId,endpoint}=cfg(); const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:PRODUCT_TYPE,patches}});
}
async function putPreview(a,sku,attrs){
  const {sellerId,marketplaceId,endpoint}=cfg(); const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues",mode:"VALIDATION_PREVIEW"});
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PUT",body:{productType:PRODUCT_TYPE,requirements:"LISTING",attributes:attrs}});
}
function sum(r){ const issues=Array.isArray(r?.body?.issues)?r.body.issues:[],errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR"),status=String(r?.body?.status||"").toUpperCase();
  return {httpStatus:r.http,responseOk:r.ok,status,submissionId:r?.body?.submissionId||"",issueCount:issues.length,errorCount:errors.length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],
    errors:errors.slice(0,10).map(i=>({code:String(i?.code||""),message:String(i?.message||"").slice(0,500),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames:[]})),
    valid:r.ok&&errors.length===0&&["VALID","ACCEPTED"].includes(status)}; }

async function handler(req0,res){
  try{
    const sec=secret(); if(!sec)return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,error:"secret missing"});
    if(String(req0.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,error:"Unauthorized"});
    if(req0.body?.dryRun===false)throw new Error("LIVE is intentionally disabled on this route");
    const a=await token(),schema=await getSchema(a);
    if(!vals(nestedSpec(schema,"parentage_level","value")).includes("parent")||!vals(nestedSpec(schema,"parentage_level","value")).includes("child"))throw new Error("PTD parentage missing");
    const relationship=vals(nestedSpec(schema,"child_parent_sku_relationship","child_relationship_type")).find(v=>/^variation$/i.test(v)); if(!relationship)throw new Error("PTD variation relationship missing");
    if(!vals(nestedSpec(schema,"variation_theme","name")).includes(VARIATION_THEME))throw new Error(`PTD theme missing ${VARIATION_THEME}`);
    const pf=await getListing(a,PARENT_SKU); if(pf.ok)throw new Error(`PARENT_SKU_ALREADY_EXISTS ${PARENT_SKU}`); if(pf.http!==404)throw new Error(`PARENT_PREFLIGHT_UNEXPECTED_HTTP ${pf.http}`);
    const kids=[]; for(const p of CHILDREN)kids.push(inspect(p,await getListing(a,p.sku)));
    const canonical=kids.find(x=>x.plan.canonical); if(!canonical)throw new Error("CANONICAL_E7_NOT_FOUND"); if(canonical.preserve.errorCount>0)throw new Error("CANONICAL_E7_HAS_ERRORS");
    const mismatches=kids.filter(x=>!sameBundle(x.preserve.bundle,canonical.preserve.bundle)).map(x=>({sku:x.plan.sku,asin:x.plan.asin,title:x.preserve.title,canonicalBundle:canonical.preserve.bundle,actualBundle:x.preserve.bundle,reason:"NON_VARIATION_BUNDLE_DIFFERS_FROM_E7"}));
    const parent=sum(await putPreview(a,PARENT_SKU,parentAttrs(canonical.attrs,relationship,exclusiveFalse(schema))));
    const childPreviews=[]; for(const k of kids){const patches=relationPatches(k.attrs,relationship);childPreviews.push({sku:k.plan.sku,asin:k.plan.asin,patches,preview:sum(await patchPreview(a,k.plan.sku,patches))});}
    const technicalReady=parent.valid&&childPreviews.every(x=>x.preview.valid),contentConsistent=mismatches.length===0,blockers=[];
    if(!parent.valid)blockers.push("PARENT_VALIDATION_PREVIEW_FAILED"); for(const x of childPreviews)if(!x.preview.valid)blockers.push(`CHILD_VALIDATION_PREVIEW_FAILED:${x.sku}`);
    if(!contentConsistent)blockers.push(`NON_VARIATION_CONTENT_MISMATCH:${mismatches.map(x=>x.sku).join(",")}`);
    return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,status:technicalReady&&contentConsistent?"PASS":"BLOCK",productType:PRODUCT_TYPE,parentSku:PARENT_SKU,parentTitle:PARENT_TITLE,
      variationTheme:VARIATION_THEME,preserveSnapshot:kids.map(x=>x.preserve),contentConsistency:{canonicalSku:canonical.plan.sku,canonicalBundle:canonical.preserve.bundle,consistent:contentConsistent,mismatchCount:mismatches.length,mismatches},
      validationPreview:{parent,children:childPreviews},prospectivePersistentWritesIfSeparatelyApproved:{count:7,writes:[{type:"PUT_NEW_PARENT",sku:PARENT_SKU,scope:["parentage_level","variation_theme","parent content cloned from E7 with RAM/SSD/offer/inventory removed"]},
      ...CHILDREN.map(x=>({type:"PATCH_CHILD_RELATION_ONLY",sku:x.sku,asin:x.asin,scope:["parentage_level","child_parent_sku_relationship","variation_theme"]}))],
      deferredNotIncluded:["old TJ-00SX-UW3J parent retirement","child price changes","child inventory changes","child B2B changes","child image changes","child Office/Norton/WPS content changes","Amazon Ads","Yahoo"]},
      decision:{technicalReady,contentConsistent,readyForLiveDesign:technicalReady&&contentConsistent,blockers,next:technicalReady&&contentConsistent?"Prepare exact guarded LIVE plan and request explicit approval.":"Do not LIVE. Resolve reported blockers first."},
      readOnlyAmazonPersistence:true,externalChanges:0,amazonPersistentWrites:0,priceWrites:0,inventoryWrites:0,adsWrites:0,yahooWrites:0,liveAllowed:false,liveBlockedReason:"EXPLICIT_USER_LIVE_APPROVAL_REQUIRED"});
  }catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,amazonPersistentWrites:0,error:err?.message||String(err)});}
}
express.application.listen=function g83VariationValidationPreviewListen(...args){const exists=Boolean(this?._router?.stack?.some(l=>l?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);return originalListen.apply(this,args);};
