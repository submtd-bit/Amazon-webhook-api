import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-sv1-price-test-postlive-audit-v1.0.0";
const ROUTE = "/amazon/price/sv1/price-test/postlive-audit";
const SKU = "RB-Y7G2-H0EK";
const ASIN = "B0GZGM1BND";
const EXPECTED_NORMAL = 56000;
const EXPECTED_SALE = 52800;
const EXPECTED_MIN = 35000;
const originalPost = express.application.post;
const originalUse = express.application.use;

function parseJson(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { rawText: text }; } }
function num(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function epoch(v) { const t = Date.parse(String(v || "")); return Number.isFinite(t) ? t : null; }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}
async function lwa() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const j = parseJson(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA token error: ${r.status}`);
  return j.access_token;
}
async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,fulfillmentAvailability", issueLocale: "ja_JP" });
  const r = await fetch(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`, {
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const j = parseJson(await r.text());
  if (!r.ok) throw new Error(`SP-API GET error: ${r.status} ${JSON.stringify(j)}`);
  return j;
}
function schedules(offer, key) { const s = offer?.[key]?.[0]?.schedule; return Array.isArray(s) ? s : []; }
function active(offer, key, now) {
  return schedules(offer, key).filter(s => {
    const st = epoch(s?.start_at), en = epoch(s?.end_at);
    return (st === null || now >= st) && (en === null || now < en);
  }).sort((a,b)=>(epoch(b?.start_at)??0)-(epoch(a?.start_at)??0))[0] || null;
}
function summarizeOffer(offer, now) {
  const audience = String(offer?.audience || "ALL").toUpperCase();
  const qp = offer?.quantity_discount_plan || offer?.quantity_discount_plans || null;
  return {
    audience,
    ourPrice: num(active(offer, "our_price", now)?.value_with_tax),
    discountedPrice: num(active(offer, "discounted_price", now)?.value_with_tax),
    minimumSellerAllowedPrice: num(active(offer, "minimum_seller_allowed_price", now)?.value_with_tax),
    maximumSellerAllowedPrice: num(active(offer, "maximum_seller_allowed_price", now)?.value_with_tax),
    quantityDiscountPlan: qp,
    keys: Object.keys(offer || {}).sort(),
  };
}
async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok:false, externalChanges:0, error:"AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok:false, externalChanges:0, error:"Unauthorized" });
    const now = Date.now();
    const raw = await getListing(await lwa());
    const summary = Array.isArray(raw?.summaries) ? raw.summaries[0] || {} : {};
    const attrs = raw?.attributes || {};
    const issues = Array.isArray(raw?.issues) ? raw.issues : [];
    const availability = Array.isArray(raw?.fulfillmentAvailability) ? raw.fulfillmentAvailability[0] || {} : {};
    const offers = Array.isArray(attrs?.purchasable_offer) ? attrs.purchasable_offer : [];
    const semanticOffers = offers.map(o => summarizeOffer(o, now));
    const consumer = semanticOffers.find(o => o.audience === "ALL") || null;
    const nonConsumer = semanticOffers.filter(o => o.audience !== "ALL");
    const b2b = semanticOffers.filter(o => o.audience === "B2B");
    const quantityPlans = semanticOffers.filter(o => o.quantityDiscountPlan != null).map(o => ({ audience:o.audience, plan:o.quantityDiscountPlan }));
    const checks = {
      asin: String(summary?.asin || "") === ASIN,
      buyable: (Array.isArray(summary?.status) ? summary.status : []).map(String).includes("BUYABLE"),
      listingErrorsZero: issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR").length === 0,
      normalPricePreserved: consumer?.ourPrice === EXPECTED_NORMAL,
      activeSaleApplied: consumer?.discountedPrice === EXPECTED_SALE,
      minimumSellerAllowedPricePreserved: consumer?.minimumSellerAllowedPrice === EXPECTED_MIN,
      noB2BOffer: b2b.length === 0,
      noQuantityDiscountPlan: quantityPlans.length === 0,
    };
    const corePass = checks.asin && checks.buyable && checks.listingErrorsZero && checks.normalPricePreserved && checks.activeSaleApplied && checks.minimumSellerAllowedPricePreserved;
    const ssotProtectionPass = corePass && checks.noB2BOffer && checks.noQuantityDiscountPlan;
    return res.json({
      ok:true,
      moduleVersion:MODULE_VERSION,
      readOnly:true,
      externalChanges:0,
      auditAt:new Date().toISOString(),
      sku:SKU,
      asin:ASIN,
      availableQuantity:num(availability?.quantity) ?? num(attrs?.fulfillment_availability?.[0]?.quantity) ?? 0,
      statuses:Array.isArray(summary?.status) ? summary.status.map(String) : [],
      listingErrorCount:issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR").length,
      semanticOffers,
      nonConsumerOfferCount:nonConsumer.length,
      b2bOfferCount:b2b.length,
      quantityDiscountPlans:quantityPlans,
      checks,
      corePass,
      ssotProtectionPass,
      ssotBaselineNote:"42_Amazon法人価格SSOT 2026-08-24 FRESH: NO_B2B_OFFER / quantity discount plan NONE",
    });
  } catch (err) {
    return res.status(500).json({ ok:false, moduleVersion:MODULE_VERSION, readOnly:true, externalChanges:0, error:err?.message || String(err) });
  }
}
express.application.post = function patchedPost(path, ...handlers) {
  if (path === ROUTE) return originalPost.call(this, path, ...handlers);
  return originalPost.call(this, path, ...handlers);
};
express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  if (!this.__sv1PostliveAuditInstalled) {
    this.__sv1PostliveAuditInstalled = true;
    originalPost.call(this, ROUTE, handler);
    console.log(`${MODULE_VERSION} route installed: POST ${ROUTE}`);
  }
  return result;
};
