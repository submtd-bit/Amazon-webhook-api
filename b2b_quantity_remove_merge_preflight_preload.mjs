import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-b2b-qty-remove-merge-preflight-v1.1.0";
const ROUTE = "/amazon/price/b2b/quantity/remove/merge/preflight";
const ACTION = "QTY_REMOVE_MERGE_NULL";
const TTL_MS = 60 * 60 * 1000;
const originalListen = express.application.listen;

const num = v => (v === null || v === undefined || v === "") ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const parse = t => { try { return JSON.parse(t || "{}"); } catch { return { rawText: t }; } };
const secret = () => String(process.env.AMAZON_STOCK_API_SECRET || "").trim();

function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}

async function token() {
  const { LWA_CLIENT_ID, LWA_CLIENT_SECRET, REFRESH_TOKEN } = process.env;
  if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !REFRESH_TOKEN) throw new Error("Missing LWA env");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN, client_id: LWA_CLIENT_ID, client_secret: LWA_CLIENT_SECRET }),
  });
  const j = parse(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA token error ${r.status}`);
  return j.access_token;
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,fulfillmentAvailability", issueLocale: "ja_JP" });
  const r = await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, {
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const j = parse(await r.text());
  if (!r.ok) throw new Error(`SP-API GET ${r.status} ${JSON.stringify(j)}`);
  return j;
}

function sched(o, k) { return o?.[k]?.[0]?.schedule?.[0] || {}; }
function tiers(levels) {
  return (Array.isArray(levels) ? levels : []).map(x => ({ lowerBound: num(x?.lower_bound ?? x?.lowerBound), value: num(x?.value) }))
    .filter(x => x.lowerBound !== null && x.value !== null)
    .sort((a,b) => a.lowerBound - b.lowerBound || a.value - b.value);
}
function state(j) {
  const s = j?.summaries?.[0] || {}, a = j?.attributes || {}, issues = Array.isArray(j?.issues) ? j.issues : [], offers = Array.isArray(a?.purchasable_offer) ? a.purchasable_offer : [];
  const c = offers.find(x => String(x?.audience || "ALL").toUpperCase() === "ALL");
  const b = offers.find(x => String(x?.audience || "").toUpperCase() === "B2B");
  const qs = b?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
  const sts = Array.isArray(s?.status) ? s.status.map(String) : [];
  const normal = num(sched(c, "our_price")?.value_with_tax);
  const sale = num(sched(c, "discounted_price")?.value_with_tax);
  return {
    asin: String(s?.asin || ""),
    productType: String(s?.productType || ""),
    statuses: sts,
    buyable: sts.includes("BUYABLE"),
    errorCount: issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: num(j?.fulfillmentAvailability?.[0]?.quantity) ?? num(a?.fulfillment_availability?.[0]?.quantity) ?? 0,
    normalPrice: normal,
    salePrice: sale,
    generalPrice: sale ?? normal,
    b2bPrice: num(sched(b, "our_price")?.value_with_tax),
    quantityPlan: { discountType: String(qs?.discount_type || "").toLowerCase(), tiers: tiers(qs?.levels) },
    selector: {
      audience: String(b?.audience || ""),
      currency: String(b?.currency || ""),
      marketplace_id: String(b?.marketplace_id || ""),
    },
  };
}

function sameTiers(a,b){ if(a.length!==b.length)return false; return a.every((x,i)=>x.lowerBound===b[i].lowerBound&&x.value===b[i].value); }

function normalize(body) {
  const item = body?.item || {};
  const out = {
    sku: String(item.sku || "").trim(),
    asin: String(item.asin || "").trim(),
    expectedGeneralPrice: num(item.expectedGeneralPrice),
    expectedNormalPrice: num(item.expectedNormalPrice),
    expectedB2bPrice: num(item.expectedB2bPrice),
    ssotQuantityDiscountEnabled: item.ssotQuantityDiscountEnabled,
    ssotQuantityMinLot: num(item.ssotQuantityMinLot),
    expectedQuantityPlan: {
      discountType: String(item.expectedQuantityDiscountType || "").toLowerCase(),
      tiers: tiers(item.expectedQuantityTiers),
    },
  };
  if (!out.sku || !out.asin) throw new Error("sku/asin required");
  if (![out.expectedGeneralPrice, out.expectedNormalPrice, out.expectedB2bPrice].every(x => Number.isInteger(x) && x > 0)) throw new Error("expected prices must be positive integers");
  if (out.ssotQuantityDiscountEnabled !== false) throw new Error("ssotQuantityDiscountEnabled must be false");
  if (!Number.isInteger(out.ssotQuantityMinLot) || out.ssotQuantityMinLot <= 0) throw new Error("ssotQuantityMinLot invalid");
  if (!out.expectedQuantityPlan.discountType || !out.expectedQuantityPlan.tiers.length) throw new Error("expected quantity plan required");
  return out;
}

function guard(item, s) {
  const e=[];
  if (s.asin !== item.asin) e.push(`ASIN=${s.asin}`);
  if (!s.productType) e.push("productType");
  if (!s.buyable) e.push("BUYABLE");
  if (s.errorCount) e.push(`errors=${s.errorCount}`);
  if (s.generalPrice !== item.expectedGeneralPrice) e.push(`general=${s.generalPrice}`);
  if (s.normalPrice !== item.expectedNormalPrice) e.push(`normal=${s.normalPrice}`);
  if (s.b2bPrice !== item.expectedB2bPrice) e.push(`b2b=${s.b2bPrice}`);
  if (!(s.availableQuantity < item.ssotQuantityMinLot)) e.push(`qty=${s.availableQuantity}`);
  if (s.quantityPlan.discountType !== item.expectedQuantityPlan.discountType || !sameTiers(s.quantityPlan.tiers, item.expectedQuantityPlan.tiers)) e.push(`plan=${JSON.stringify(s.quantityPlan)}`);
  if (String(s.selector.audience).toUpperCase() !== "B2B") e.push(`selector.audience=${s.selector.audience}`);
  if (!s.selector.currency) e.push("selector.currency");
  if (!s.selector.marketplace_id) e.push("selector.marketplace_id");
  if (e.length) { const z = new Error(`PRECHECK_FAILED: ${e.join(" / ")}`); z.code="PRECHECK_FAILED"; z.details=e; throw z; }
}

function patch(s) {
  return {
    productType: s.productType,
    patches: [{
      op: "merge",
      path: "/attributes/purchasable_offer",
      value: [{
        audience: s.selector.audience,
        currency: s.selector.currency,
        marketplace_id: s.selector.marketplace_id,
        quantity_discount_plan: null,
      }],
    }],
  };
}

function fingerprint(item, s, p) {
  const payload = { v:1, moduleVersion:MODULE_VERSION, action:ACTION, sku:item.sku, asin:item.asin, expectedGeneralPrice:item.expectedGeneralPrice, expectedNormalPrice:item.expectedNormalPrice, expectedB2bPrice:item.expectedB2bPrice, ssotQuantityDiscountEnabled:false, ssotQuantityMinLot:item.ssotQuantityMinLot, expectedQuantityPlan:item.expectedQuantityPlan, selector:s.selector, patchSha256:crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex"), issuedAt:Date.now() };
  const enc = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(enc).digest("base64url");
  return `${enc}.${sig}`;
}

async function handler(req,res) {
  const requestedAt = new Date().toISOString();
  try {
    const sec = secret();
    if (!sec) return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,externalChanges:0,error:"AMAZON_STOCK_API_SECRET is not set"});
    if (String(req.headers["x-api-secret"]||"") !== sec) return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,externalChanges:0,error:"Unauthorized"});
    const item = normalize(req.body);
    const accessToken = await token();
    const s = state(await getListing(accessToken, item.sku));
    guard(item,s);
    const p = patch(s);
    return res.status(200).json({
      ok:true,
      moduleVersion:MODULE_VERSION,
      route:ROUTE,
      requestedAt,
      status:"PREFLIGHT_READY_NO_AMAZON_WRITE",
      amazonValidationPreviewSupported:false,
      reason:"Amazon rejects merge operation in VALIDATION_PREVIEW; this preflight performs Fresh GET + exact drift checks + payload construction only.",
      item:{sku:item.sku,asin:item.asin,action:ACTION},
      before:s,
      attemptedPatch:p,
      dryRunFingerprint:fingerprint(item,s,p),
      fingerprintTtlMinutes:Math.floor(TTL_MS/60000),
      actualExternalChanges:0,
      externalChanges:0,
    });
  } catch(e) {
    return res.status(e?.code==="PRECHECK_FAILED"?409:400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:e?.code||"ERROR",error:e?.message||String(e),details:e?.details||[],actualExternalChanges:0,externalChanges:0});
  }
}

express.application.listen = function(...args) {
  const exists = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!exists) this.post(ROUTE, handler);
  return originalListen.apply(this,args);
};
