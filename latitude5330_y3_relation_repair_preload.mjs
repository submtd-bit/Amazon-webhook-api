import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-29-latitude5330-y3-relation-repair-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-y3-relation-repair";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_GAP_MS = 2200;
const originalListen = express.application.listen;

const G = Object.freeze({
  sourceSku: "Y3-30YC-UORU",
  sourceAsin: "B0HGDZNVQN",
  parentSku: "latitude5330-i5-12g-16gb-storage-parent",
  child512Sku: "latitude5330-i5-12g-16gb-ssd512",
  productType: "NOTEBOOK_COMPUTER",
  confirmLive: "CONFIRM_Y3_RELATION_REPAIR_20260829",
});

function jparse(t){try{return t?JSON.parse(t):{};}catch{return {rawText:t};}}
function clone(v){return JSON.parse(JSON.stringify(v));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function secret(){return String(process.env.AMAZON_STOCK_API_SECRET||"").trim();}
function cfg(){
  const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();
  const marketplaceId=String(process.env.SPAPI_MARKETPLACE_ID||MARKETPLACE_ID).trim();
  const endpoint=String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"");
  if(!sellerId)throw new Error("Missing env: SPAPI_SELLER_ID");
  if(marketplaceId!==MARKETPLACE_ID)throw new Error(`GUARD_BLOCKED marketplace=${marketplaceId}`);
  return {sellerId,marketplaceId,endpoint};
}
async function ft(url,opt={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),REQUEST_TIMEOUT_MS);try{return await fetch(url,{...opt,signal:c.signal});}finally{clearTimeout(t);}}
async function token(){
  const clientId=process.env.LWA_CLIENT_ID,clientSecret=process.env.LWA_CLIENT_SECRET,refreshToken=process.env.REFRESH_TOKEN;
  if(!clientId||!clientSecret||!refreshToken)throw new Error("Missing LWA env");
  const r=await ft("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})});
  const x=jparse(await r.text());if(!r.ok||!x.access_token)throw new Error(`LWA token error ${r.status}`);return x.access_token;
}
async function req(url,a,opt={}){
  const r=await ft(url,{method:opt.method||"GET",headers:{"x-amz-access-token":a,accept:"application/json",...(opt.body?{"content-type":"application/json"}:{})},...(opt.body?{body:JSON.stringify(opt.body)}:{})});
  return {httpStatus:r.status,responseOk:r.ok,body:jparse(await r.text())};
}
async function getListing(a,sku){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,offers,fulfillmentAvailability",issueLocale:"ja_JP"});
  const x=await req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a);
  if(!x.responseOk)throw new Error(`GET ${sku} HTTP ${x.httpStatus} ${JSON.stringify(x.body).slice(0,1000)}`);
  return x.body;
}
async function patchListing(a,sku,patches,preview){
  const {sellerId,marketplaceId,endpoint}=cfg();
  const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP",includedData:"issues"});
  if(preview)q.set("mode","VALIDATION_PREVIEW");
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,a,{method:"PATCH",body:{productType:G.productType,patches}});
}
function summary(x){return Array.isArray(x?.summaries)?x.summaries[0]||{}:{};}
function attrs(x){return x?.attributes&&typeof x.attributes==="object"?x.attributes:{};}
function firstValue(a,k){return a?.[k]?.[0]?.value;}
function firstName(a,k){return a?.[k]?.[0]?.name;}
function nested(a,k,outer,inner="value"){return a?.[k]?.[0]?.[outer]?.[0]?.[inner];}
function numEq(a,b){return Number.isFinite(Number(a))&&Math.abs(Number(a)-Number(b))<0.0001;}
function offerSnapshot(x){return (Array.isArray(x?.offers)?x.offers:[]).map(o=>({offerType:String(o?.offerType||""),price:Number(o?.price?.amount)})).sort((a,b)=>a.offerType.localeCompare(b.offerType));}
function qtySnapshot(x){return (Array.isArray(x?.fulfillmentAvailability)?x.fulfillmentAvailability:[]).map(o=>({channel:String(o?.fulfillmentChannelCode||""),quantity:Number(o?.quantity)})).sort((a,b)=>a.channel.localeCompare(b.channel));}
function relevantSnapshot(x){const a=attrs(x);return {asin:String(summary(x)?.asin||""),productType:String(summary(x)?.productType||""),parentage_level:clone(a.parentage_level||[]),child_parent_sku_relationship:clone(a.child_parent_sku_relationship||[]),variation_theme:clone(a.variation_theme||[]),is_exclusive_product:clone(a.is_exclusive_product||[]),hard_disk:clone(a.hard_disk||[]),flash_memory:clone(a.flash_memory||[]),ram_memory:clone(a.ram_memory||[]),main_product_image_locator:clone(a.main_product_image_locator||[]),offers:offerSnapshot(x),fulfillmentAvailability:qtySnapshot(x),issues:(Array.isArray(x?.issues)?x.issues:[]).map(i=>({code:String(i?.code||""),severity:String(i?.severity||""),message:String(i?.message||"").slice(0,300)}))};}
function assertIdentity(x,sku,asinRequired){const s=summary(x);if(String(x?.sku||sku)!==sku&&x?.sku)throw new Error(`SOURCE_DRIFT sku ${sku}`);if(String(s?.productType||"")!==G.productType)throw new Error(`SOURCE_DRIFT productType ${sku}=${s?.productType}`);if(asinRequired&&String(s?.asin||"")!==asinRequired)throw new Error(`SOURCE_DRIFT asin ${sku}=${s?.asin}`);}
function assertFreshState(y3,parent,c512){
  assertIdentity(y3,G.sourceSku,G.sourceAsin);assertIdentity(parent,G.parentSku,"");assertIdentity(c512,G.child512Sku,"");
  const ya=attrs(y3),pa=attrs(parent),ca=attrs(c512);
  if(!numEq(nested(ya,"hard_disk","size"),256)&&!numEq(nested(ya,"flash_memory","installed_size"),256))throw new Error("SOURCE_DRIFT Y3 is not 256GB");
  if(!numEq(nested(ya,"ram_memory","installed_size"),16))throw new Error("SOURCE_DRIFT Y3 RAM is not 16GB");
  if(String(firstValue(pa,"parentage_level")||"").toLowerCase()!=="parent")throw new Error("PARENT_NOT_PARENT");
  if(String(firstValue(ca,"parentage_level")||"").toLowerCase()!=="child")throw new Error("CHILD512_NOT_CHILD");
  const psku=String(ca?.child_parent_sku_relationship?.[0]?.parent_sku||"");if(psku!==G.parentSku)throw new Error(`CHILD512_PARENT_MISMATCH ${psku}`);
  const pt=String(firstName(pa,"variation_theme")||"");const ct=String(firstName(ca,"variation_theme")||"");if(!pt||pt!==ct)throw new Error(`THEME_MISMATCH parent=${pt} child512=${ct}`);
  if(!pt.split("/").includes("HARD_DISK_SIZE"))throw new Error(`THEME_NOT_STORAGE ${pt}`);
  if(!numEq(nested(ca,"hard_disk","size"),512)&&!numEq(nested(ca,"flash_memory","installed_size"),512))throw new Error("CHILD512_STORAGE_NOT_512");
  if(!numEq(nested(ca,"ram_memory","installed_size"),16))throw new Error("CHILD512_RAM_NOT_16");
  return {theme:pt,child512Asin:String(summary(c512)?.asin||"")};
}
function same(a,b){return JSON.stringify(a||[])===JSON.stringify(b||[]);}
function buildPatches(y3,c512){
  const ya=attrs(y3),ca=attrs(c512);const patches=[];
  for(const k of ["parentage_level","child_parent_sku_relationship","variation_theme"]){const v=clone(ca[k]||[]);if(!v.length)throw new Error(`CHILD512_MISSING ${k}`);if(!same(ya[k],v))patches.push({op:Array.isArray(ya[k])&&ya[k].length?"replace":"add",path:`/attributes/${k}`,value:v});}
  const exclusive=clone(ca.is_exclusive_product||[]);if(exclusive.length&&!same(ya.is_exclusive_product,exclusive))patches.push({op:Array.isArray(ya.is_exclusive_product)&&ya.is_exclusive_product.length?"replace":"add",path:"/attributes/is_exclusive_product",value:exclusive});
  return patches;
}
function summarizePatch(r){const issues=Array.isArray(r?.body?.issues)?r.body.issues:[];const errors=issues.filter(i=>String(i?.severity||"").toUpperCase()==="ERROR");const status=String(r?.body?.status||"").toUpperCase();return {httpStatus:r.httpStatus,responseOk:r.responseOk,status,submissionId:String(r?.body?.submissionId||""),issueCount:issues.length,errorCount:errors.length,issueCodes:[...new Set(issues.map(i=>String(i?.code||"")).filter(Boolean))],errors:errors.slice(0,10).map(i=>({code:String(i?.code||""),message:String(i?.message||"").slice(0,400),attributeNames:Array.isArray(i?.attributeNames)?i.attributeNames:[]})),valid:r.responseOk&&errors.length===0&&["VALID","ACCEPTED"].includes(status)};}
function verify(y3Before,y3After,c512){
  const ba=attrs(y3Before),aa=attrs(y3After),ca=attrs(c512);
  const checks={asinUnchanged:String(summary(y3After)?.asin||"")===G.sourceAsin,productType:String(summary(y3After)?.productType||"")===G.productType,parentage: same(aa.parentage_level,ca.parentage_level),parentRelationship:same(aa.child_parent_sku_relationship,ca.child_parent_sku_relationship),variationTheme:same(aa.variation_theme,ca.variation_theme),exclusiveProduct:!Array.isArray(ca.is_exclusive_product)||!ca.is_exclusive_product.length||same(aa.is_exclusive_product,ca.is_exclusive_product),storageStill256:numEq(nested(aa,"hard_disk","size"),256)||numEq(nested(aa,"flash_memory","installed_size"),256),ramStill16:numEq(nested(aa,"ram_memory","installed_size"),16),offersUnchanged:JSON.stringify(offerSnapshot(y3After))===JSON.stringify(offerSnapshot(y3Before)),quantityUnchanged:JSON.stringify(qtySnapshot(y3After))===JSON.stringify(qtySnapshot(y3Before)),imageUnchanged:same(aa.main_product_image_locator,ba.main_product_image_locator)};
  return {verified:Object.values(checks).every(Boolean),checks,snapshot:relevantSnapshot(y3After)};
}

async function handler(req0,res){let liveAccepted=false;try{
  const sec=secret();if(!sec)return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,error:"secret missing"});if(String(req0.headers["x-api-secret"]||"")!==sec)return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:0,error:"Unauthorized"});
  const mode=String(req0.body?.mode||"PREVIEW").toUpperCase();if(!["PREVIEW","LIVE"].includes(mode))throw new Error("mode must be PREVIEW or LIVE");if(String(req0.body?.sku||G.sourceSku)!==G.sourceSku)throw new Error("GUARD_BLOCKED unexpected SKU");if(mode==="LIVE"&&String(req0.body?.confirmLive||"")!==G.confirmLive)throw new Error("LIVE_GUARD_BLOCKED confirm token mismatch");
  const a=await token();const [y3,parent,c512]=await Promise.all([getListing(a,G.sourceSku),getListing(a,G.parentSku),getListing(a,G.child512Sku)]);const state=assertFreshState(y3,parent,c512);const patches=buildPatches(y3,c512);
  if(!patches.length)return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,mode,status:"ALREADY_MATCHED",readOnly:mode!=="LIVE",externalChanges:0,sku:G.sourceSku,asin:G.sourceAsin,parentSku:G.parentSku,child512Sku:G.child512Sku,child512Asin:state.child512Asin,theme:state.theme,patchCount:0,pre:{y3:relevantSnapshot(y3),parent:relevantSnapshot(parent),child512:relevantSnapshot(c512)},next:"Relation already matches child512; no write needed."});
  const preview=summarizePatch(await patchListing(a,G.sourceSku,patches,true));
  if(!preview.valid)return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,mode,status:"BLOCK",readOnly:true,externalChanges:0,sku:G.sourceSku,asin:G.sourceAsin,parentSku:G.parentSku,child512Sku:G.child512Sku,child512Asin:state.child512Asin,theme:state.theme,patchCount:patches.length,patchPaths:patches.map(p=>p.path),preview,pre:{y3:relevantSnapshot(y3),parent:relevantSnapshot(parent),child512:relevantSnapshot(c512)},next:"STOP. No live write. Fix only the preview errors."});
  if(mode==="PREVIEW")return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,mode,status:"PASS",readOnly:true,externalChanges:0,sku:G.sourceSku,asin:G.sourceAsin,parentSku:G.parentSku,child512Sku:G.child512Sku,child512Asin:state.child512Asin,theme:state.theme,patchCount:patches.length,patchPaths:patches.map(p=>p.path),preview,pre:{y3:relevantSnapshot(y3),parent:relevantSnapshot(parent),child512:relevantSnapshot(c512)},readyForLive:true,next:`Run LIVE once with confirmLive=${G.confirmLive}`});
  const live=summarizePatch(await patchListing(a,G.sourceSku,patches,false));liveAccepted=live.responseOk&&["ACCEPTED","VALID"].includes(live.status)&&live.errorCount===0;
  if(!liveAccepted)return res.status(502).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,mode,status:"LIVE_NOT_ACCEPTED",externalChanges:0,preview,live,next:"STOP. Do not retry automatically."});
  const attempts=[];let v=null;for(let i=1;i<=VERIFY_ATTEMPTS;i++){if(i>1)await sleep(VERIFY_GAP_MS);const after=await getListing(a,G.sourceSku);v=verify(y3,after,c512);attempts.push({attempt:i,verified:v.verified,checks:v.checks});if(v.verified)break;}
  return res.status(200).json({ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,mode,status:v?.verified?"PASS":"PENDING_PROPAGATION",externalChanges:1,sku:G.sourceSku,asin:G.sourceAsin,parentSku:G.parentSku,child512Sku:G.child512Sku,child512Asin:state.child512Asin,theme:state.theme,preview,live,postVerified:Boolean(v?.verified),verificationAttempts:attempts,finalSnapshot:v?.snapshot||{},next:v?.verified?"Y3 relation repair verified. Keep EC inventory pause until inventory mapping/Fresh checks are complete.":"LIVE accepted once. Do not retry; verify read-only later."});
}catch(err){return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,externalChanges:liveAccepted?1:0,error:err?.message||String(err),liveAccepted});}}

express.application.listen=function latitude5330Y3RelationRepairListen(...args){const exists=Boolean(this?._router?.stack?.some(layer=>layer?.route?.path===ROUTE));if(!exists)this.post(ROUTE,handler);return originalListen.apply(this,args);};
