import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-b2b-qty-remove-merge-live-v1.1.0";
const PREFLIGHT_MODULE_VERSION = "2026-08-22-b2b-qty-remove-merge-preflight-v1.1.0";
const ROUTE = "/amazon/price/b2b/quantity/remove/merge/live";
const ACTION = "QTY_REMOVE_MERGE_NULL";
const CONFIRM = "B2B-QTY-REMOVE-MERGE-LIVE-V1";
const TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 12;
const VERIFY_WAIT_MS = 2500;
const originalListen = express.application.listen;

const num = v => (v === null || v === undefined || v === "") ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const parse = t => { try { return JSON.parse(t || "{}"); } catch { return { rawText: t }; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

async function spRequest({ method, url, accessToken, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const j = parse(await r.text());
    if (!r.ok) {
      const e = new Error(`SP-API ${method} ${r.status} ${JSON.stringify(j)}`);
      e.httpStatus = r.status;
      e.details = j;
      throw e;
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,fulfillmentAvailability", issueLocale: "ja_JP" });
  return spRequest({
    method: "GET",
    url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,
    accessToken,
  });
}

async function submitMergeLive(accessToken, sku, body) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  return spRequest({
    method: "PATCH",
    url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,
    accessToken,
    body,
  });
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
function samePlan(a,b){ return String(a?.discountType||"").toLowerCase()===String(b?.discountType||"").toLowerCase() && sameTiers(tiers(a?.tiers), tiers(b?.tiers)); }

function verifyFingerprint(raw) {
  const sec = secret();
  const [enc, sig] = String(raw || "").split(".");
  if (!enc || !sig) throw new Error("dryRunFingerprint required");
  const expectedSig = crypto.createHmac("sha256", sec).update(enc).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) throw new Error("fingerprint mismatch");
  let p;
  try { p = JSON.parse(Buffer.from(enc, "base64url").toString("utf8")); } catch { throw new Error("fingerprint payload invalid"); }
  const issuedAt = Number(p?.issuedAt || 0), age = Date.now() - issuedAt;
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || age < -5*60*1000 || age > TTL_MS) throw new Error("fingerprint expired or invalid timestamp");
  if (p?.v !== 1 || p?.moduleVersion !== PREFLIGHT_MODULE_VERSION || p?.action !== ACTION) throw new Error("fingerprint scope mismatch");
  if (!p?.sku || !p?.asin || !Number.isInteger(p?.expectedGeneralPrice) || !Number.isInteger(p?.expectedNormalPrice) || !Number.isInteger(p?.expectedB2bPrice)) throw new Error("fingerprint required fields invalid");
  if (p?.ssotQuantityDiscountEnabled !== false || !Number.isInteger(p?.ssotQuantityMinLot) || p.ssotQuantityMinLot <= 0) throw new Error("fingerprint SSOT scope invalid");
  p.expectedQuantityPlan = {
    discountType: String(p?.expectedQuantityPlan?.discountType || "").toLowerCase(),
    tiers: tiers(p?.expectedQuantityPlan?.tiers),
  };
  if (!p.expectedQuantityPlan.discountType || !p.expectedQuantityPlan.tiers.length) throw new Error("fingerprint quantity plan invalid");
  if (!p?.selector?.audience || !p?.selector?.currency || !p?.selector?.marketplace_id) throw new Error("fingerprint selector invalid");
  if (!p?.patchSha256) throw new Error("fingerprint patch hash missing");
  return p;
}

function guardProtected(fp, s, { requirePlan }) {
  const e=[];
  if (s.asin !== fp.asin) e.push(`ASIN=${s.asin}`);
  if (!s.productType) e.push("productType");
  if (!s.buyable) e.push("BUYABLE");
  if (s.errorCount) e.push(`errors=${s.errorCount}`);
  if (s.generalPrice !== fp.expectedGeneralPrice) e.push(`general=${s.generalPrice}`);
  if (s.normalPrice !== fp.expectedNormalPrice) e.push(`normal=${s.normalPrice}`);
  if (s.b2bPrice !== fp.expectedB2bPrice) e.push(`b2b=${s.b2bPrice}`);
  if (!(s.availableQuantity < fp.ssotQuantityMinLot)) e.push(`qty=${s.availableQuantity}`);
  if (String(s.selector.audience).toUpperCase() !== String(fp.selector.audience).toUpperCase()) e.push(`selector.audience=${s.selector.audience}`);
  if (s.selector.currency !== fp.selector.currency) e.push(`selector.currency=${s.selector.currency}`);
  if (s.selector.marketplace_id !== fp.selector.marketplace_id) e.push(`selector.marketplace_id=${s.selector.marketplace_id}`);
  if (requirePlan && !samePlan(s.quantityPlan, fp.expectedQuantityPlan)) e.push(`plan=${JSON.stringify(s.quantityPlan)}`);
  if (e.length) { const z = new Error(`MERGE_LIVE_PREFLIGHT_FAILED: ${e.join(" / ")}`); z.code="PREFLIGHT_FAILED"; z.details=e; throw z; }
}

function buildPatch(fp, s) {
  const p = {
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
  const hash = crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex");
  if (hash !== fp.patchSha256) {
    const z = new Error(`patch hash mismatch: expected=${fp.patchSha256} actual=${hash}`);
    z.code = "PATCH_HASH_MISMATCH";
    throw z;
  }
  return p;
}

function verifiedRemoved(fp, s) {
  return s.asin === fp.asin
    && s.buyable === true
    && s.errorCount === 0
    && s.generalPrice === fp.expectedGeneralPrice
    && s.normalPrice === fp.expectedNormalPrice
    && s.b2bPrice === fp.expectedB2bPrice
    && !s.quantityPlan.discountType
    && s.quantityPlan.tiers.length === 0;
}

async function verifyAfter(accessToken, fp) {
  let lastState = null, lastError = "";
  for (let attempt=1; attempt<=VERIFY_ATTEMPTS; attempt+=1) {
    try {
      lastState = state(await getListing(accessToken, fp.sku));
      if (verifiedRemoved(fp, lastState)) return { verified:true, attempt, state:lastState };
      lastError = `quantity plan still present or protected fields drifted: ${JSON.stringify(lastState)}`;
    } catch (e) {
      lastError = e?.message || String(e);
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return { verified:false, attempt:VERIFY_ATTEMPTS, state:lastState, error:lastError };
}

async function handler(req,res) {
  const requestedAt = new Date().toISOString();
  try {
    const sec = secret();
    if (!sec) return res.status(500).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:"ERROR",error:"AMAZON_STOCK_API_SECRET is not set",actualExternalChanges:0,externalChanges:0});
    if (String(req.headers["x-api-secret"]||"") !== sec) return res.status(401).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:"ERROR",error:"Unauthorized",actualExternalChanges:0,externalChanges:0});
    if (String(req.body?.confirm || "") !== CONFIRM) return res.status(400).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:"CONFIRM_REQUIRED",error:`confirm must equal ${CONFIRM}`,actualExternalChanges:0,externalChanges:0});

    const fp = verifyFingerprint(req.body?.dryRunFingerprint);
    const accessToken = await token();
    const before = state(await getListing(accessToken, fp.sku));

    if (verifiedRemoved(fp, before)) {
      return res.status(200).json({
        ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:"ALREADY_APPLIED",before,verification:{verified:true,attempt:0,state:before},actualExternalChanges:0,externalChanges:0,
      });
    }

    guardProtected(fp, before, { requirePlan:true });
    const body = buildPatch(fp, before);

    const accepted = await submitMergeLive(accessToken, fp.sku, body);
    const verification = await verifyAfter(accessToken, fp);

    if (!verification.verified) {
      return res.status(409).json({
        ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:"LIVE_ACCEPTED_FRESH_VERIFICATION_FAILED",accepted,verification,actualExternalChanges:0,externalChanges:0,
      });
    }

    return res.status(200).json({
      ok:true,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:"COMPLETED",accepted,verification,actualExternalChanges:1,externalChanges:1,
    });
  } catch(e) {
    const statusCode = e?.code === "PREFLIGHT_FAILED" || e?.code === "PATCH_HASH_MISMATCH" ? 409 : 400;
    return res.status(statusCode).json({ok:false,moduleVersion:MODULE_VERSION,route:ROUTE,requestedAt,status:e?.code||"ERROR",error:e?.message||String(e),details:e?.details||[],actualExternalChanges:0,externalChanges:0});
  }
}

express.application.listen = function(...args) {
  const exists = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!exists) this.post(ROUTE, handler);
  return originalListen.apply(this,args);
};
