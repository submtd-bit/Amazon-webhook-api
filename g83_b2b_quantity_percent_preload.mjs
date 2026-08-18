import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const V="2026-08-18-g83-b2b-quantity-percent-v1.0.0";
const ROUTE="/amazon/price/g83/b2b-quantity";
const SKU="E7-YLJ3-F9CY", ASIN="B0GZBHBQN2";
const NORMAL=58000, SALE=41170, MIN=36100, B2B=39900, LOT=10, PCT=3, EFFECTIVE=38700;
const SALE_END="2026-08-23T15:00:00.000Z";
const CONFIRM="G83-B2B-Q10-3PCT";
const TTL=60*60*1000, VERIFY_ATTEMPTS=6, VERIFY_WAIT_MS=2500;
const originalPost=express.application.post;

const parse=t=>{try{return JSON.parse(t||"{}")}catch{return {rawText:t}}};
const num=v=>v===null||v===undefined||v===""?null:(Number.isFinite(Number(v))?Number(v):null);
const iso=v=>{const t=Date.parse(String(v||""));return Number.isFinite(t)?new Date(t).toISOString():""};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const secret=()=>String(process.env.AMAZON_STOCK_API_SECRET||"").trim();

async function token(){
  const {LWA_CLIENT_ID:a,LWA_CLIENT_SECRET:b,REFRESH_TOKEN:c}=process.env;
  if(!a||!b||!c) throw new Error("Missing LWA env");
  const r=await fetch("https://api.amazon.com/auth/o2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:c,client_id:a,client_secret:b})});
  const j=parse(await r.text()); if(!r.ok||!j.access_token) throw new Error(`LWA token error ${r.status}`); return j.access_token;
}
function cfg(){const sellerId=String(process.env.SPAPI_SELLER_ID||"").trim();if(!sellerId)throw new Error("Missing SPAPI_SELLER_ID");return {sellerId,marketplaceId:String(process.env.SPAPI_MARKETPLACE_ID||"A1VC38T7YXB528").trim(),endpoint:String(process.env.SPAPI_ENDPOINT||"https://sellingpartnerapi-fe.amazon.com").replace(/\/$/,"")}}
async function req(method,url,accessToken,body){const r=await fetch(url,{method,headers:{"x-amz-access-token":accessToken,accept:"application/json",...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});const j=parse(await r.text());if(!r.ok)throw new Error(`SP-API ${r.status} ${JSON.stringify(j)}`);return j}
async function listing(accessToken){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,includedData:"summaries,attributes,issues,fulfillmentAvailability",issueLocale:"ja_JP"});return req("GET",`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`,accessToken)}
function sched(o,k){return o?.[k]?.[0]?.schedule?.[0]||{}}
function state(j){
  const s=j?.summaries?.[0]||{}, a=j?.attributes||{}, issues=Array.isArray(j?.issues)?j.issues:[], offers=Array.isArray(a?.purchasable_offer)?a.purchasable_offer:[];
  const c=offers.find(x=>String(x?.audience||"ALL").toUpperCase()==="ALL"), b=offers.find(x=>String(x?.audience||"").toUpperCase()==="B2B");
  const qs=b?.quantity_discount_plan?.[0]?.schedule?.[0]||{}, levels=Array.isArray(qs?.levels)?qs.levels:[];
  const q=levels.map(x=>({lowerBound:num(x?.lower_bound),value:num(x?.value)})).filter(x=>x.lowerBound!==null&&x.value!==null);
  const q10=q.find(x=>x.lowerBound===LOT)||null;
  return {asin:String(s?.asin||""),productType:String(s?.productType||""),statuses:Array.isArray(s?.status)?s.status.map(String):[],errorCount:issues.filter(x=>String(x?.severity||"").toUpperCase()==="ERROR").length,qty:num(j?.fulfillmentAvailability?.[0]?.quantity)||0,offers,c,b,normal:num(sched(c,"our_price")?.value_with_tax),sale:num(sched(c,"discounted_price")?.value_with_tax),saleEnd:iso(sched(c,"discounted_price")?.end_at),min:num(sched(c,"minimum_seller_allowed_price")?.value_with_tax),b2b:num(sched(b,"our_price")?.value_with_tax),discountType:String(qs?.discount_type||"").toLowerCase(),levels:q,q10:q10?q10.value:null};
}
function guard(x){const e=[];if(x.asin!==ASIN)e.push("ASIN");if(!x.productType)e.push("productType");if(!x.statuses.includes("BUYABLE"))e.push("BUYABLE");if(x.errorCount)e.push(`ERROR=${x.errorCount}`);if(!(x.qty>0))e.push(`qty=${x.qty}`);if(!x.c||!x.b)e.push("offers");if(x.normal!==NORMAL)e.push(`normal=${x.normal}`);if(x.sale!==SALE)e.push(`sale=${x.sale}`);if(x.min!==MIN)e.push(`min=${x.min}`);if(x.b2b!==B2B)e.push(`b2b=${x.b2b}`);if(x.saleEnd!==SALE_END)e.push(`saleEnd=${x.saleEnd}`);if(x.levels.length&&(x.discountType!=="percent"||x.levels.length!==1||x.levels[0].lowerBound!==LOT||x.levels[0].value!==PCT))e.push(`unexpected quantity plan ${JSON.stringify({type:x.discountType,levels:x.levels})}`);if(e.length){const z=new Error(`G83 B2B quantity preflight failed: ${e.join(" / ")}`);z.code="PREFLIGHT_FAILED";z.details=e;throw z}}
function applied(x){return x.asin===ASIN&&x.normal===NORMAL&&x.sale===SALE&&x.min===MIN&&x.b2b===B2B&&x.saleEnd===SALE_END&&x.discountType==="percent"&&x.levels.length===1&&x.levels[0].lowerBound===LOT&&x.levels[0].value===PCT}
function patch(x){const offers=JSON.parse(JSON.stringify(x.offers));const i=offers.findIndex(o=>String(o?.audience||"").toUpperCase()==="B2B");if(i<0)throw new Error("B2B offer missing");offers[i].quantity_discount_plan=[{schedule:[{discount_type:"percent",levels:[{lower_bound:LOT,value:PCT}]}]}];return {productType:x.productType,patches:[{op:"replace",path:"/attributes/purchasable_offer",value:offers}]}}
async function submit(accessToken,body,preview){const {sellerId,marketplaceId,endpoint}=cfg();const q=new URLSearchParams({marketplaceIds:marketplaceId,issueLocale:"ja_JP"});if(preview)q.set("mode","VALIDATION_PREVIEW");const j=await req("PATCH",`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`,accessToken,body);if((j?.issues||[]).some(x=>String(x?.severity||"").toUpperCase()==="ERROR"))throw new Error(`Amazon validation ERROR ${JSON.stringify(j.issues)}`);return j}
function fingerprint(x){const p={v:1,sku:SKU,asin:ASIN,normal:x.normal,sale:x.sale,min:x.min,b2b:x.b2b,saleEnd:x.saleEnd,lot:LOT,pct:PCT,issuedAt:Date.now()};const enc=Buffer.from(JSON.stringify(p)).toString("base64url");return `${enc}.${crypto.createHmac("sha256",secret()).update(enc).digest("base64url")}`}
function verifyFp(t){const [enc,sig]=String(t||"").split(".");if(!enc||!sig)throw new Error("dryRunFingerprint required");const exp=crypto.createHmac("sha256",secret()).update(enc).digest("base64url");const a=Buffer.from(sig),b=Buffer.from(exp);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new Error("fingerprint mismatch");const p=JSON.parse(Buffer.from(enc,"base64url").toString("utf8"));if(Date.now()-Number(p.issuedAt||0)>TTL)throw new Error("fingerprint expired");if(p.sku!==SKU||p.asin!==ASIN||p.normal!==NORMAL||p.sale!==SALE||p.min!==MIN||p.b2b!==B2B||p.saleEnd!==SALE_END||p.lot!==LOT||p.pct!==PCT)throw new Error("fingerprint scope mismatch");return p}
async function verifyLive(accessToken){let last="";for(let i=1;i<=VERIFY_ATTEMPTS;i++){try{const x=state(await listing(accessToken));if(applied(x))return {verified:true,attempt:i,state:x};last=JSON.stringify({type:x.discountType,levels:x.levels})}catch(e){last=e.message||String(e)}if(i<VERIFY_ATTEMPTS)await sleep(VERIFY_WAIT_MS)}return {verified:false,attempt:VERIFY_ATTEMPTS,error:last}}
async function handler(req0,res){try{const s=secret();if(!s)return res.status(500).json({ok:false,error:"AMAZON_STOCK_API_SECRET is not set"});if(String(req0.headers["x-api-secret"]||"")!==s)return res.status(401).json({ok:false,error:"Unauthorized"});const dry=req0.body?.dryRun===true;if(Number(req0.body?.lowerBound)!==LOT||Number(req0.body?.discountPercent)!==PCT)return res.status(400).json({ok:false,error:`scope must be lot=${LOT}, percent=${PCT}`});if(!dry){if(req0.body?.confirm!==CONFIRM)return res.status(400).json({ok:false,error:`confirm must equal ${CONFIRM}`});verifyFp(req0.body?.dryRunFingerprint)}const at=await token();const before=state(await listing(at));guard(before);if(applied(before))return res.status(200).json({ok:true,moduleVersion:V,status:"ALREADY_APPLIED",dryRun:dry,verified:true,before,effectivePrice:EFFECTIVE});const body=patch(before);if(dry){const validation=await submit(at,body,true);return res.status(200).json({ok:true,moduleVersion:V,status:"DRY_RUN_READY",dryRun:true,before,lowerBound:LOT,discountPercent:PCT,effectivePrice:EFFECTIVE,amazonValidation:validation,dryRunFingerprint:fingerprint(before),fingerprintTtlMinutes:60,liveConfirm:CONFIRM})}const accepted=await submit(at,body,false),verification=await verifyLive(at);if(!verification.verified)return res.status(409).json({ok:false,moduleVersion:V,status:"VERIFICATION_FAILED",accepted,verification});return res.status(200).json({ok:true,moduleVersion:V,status:"COMPLETED",accepted,verification,effectivePrice:EFFECTIVE})}catch(e){console.error("G83 B2B quantity percent error",e);return res.status(e?.code==="PREFLIGHT_FAILED"?409:500).json({ok:false,moduleVersion:V,status:e?.code||"ERROR",error:e?.message||String(e),details:e?.details||[]})}}

express.application.post=function(path,...handlers){if(path===ROUTE)return originalPost.call(this,path,handler);return originalPost.call(this,path,...handlers)};
