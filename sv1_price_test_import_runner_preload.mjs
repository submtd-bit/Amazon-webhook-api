import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-sv1-price-test-import-runner-v1.0.0";
const ROUTE = "/amazon/price/sv1/price-test/preflight-import";
const TOKEN = "6fa48876046ba4d5795d45fd1aca4f7df78e7c28630d7e79";
const EXPIRES_AT = Date.parse("2026-08-25T09:30:00.000Z");
const SKU = "RB-Y7G2-H0EK";
const ASIN = "B0GZGM1BND";
const NORMAL_PRICE = 56000;
const TEST_PRICE = 52800;
const SAFE_FLOOR = 40500;
const DURATION_HOURS = 72;
const REQUEST_TIMEOUT_MS = 20000;
const originalUse = express.application.use;
const originalGet = express.application.get;

function parseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function epoch(v) {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : null;
}
function config() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}
async function token() {
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
async function amazon({ method, url, accessToken, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: { "x-amz-access-token": accessToken, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const j = parseJson(await r.text());
    if (!r.ok) throw new Error(`SP-API request error: ${r.status} ${JSON.stringify(j)}`);
    return j;
  } finally { clearTimeout(timer); }
}
async function listing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = config();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,fulfillmentAvailability", issueLocale: "ja_JP" });
  return amazon({ method: "GET", url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`, accessToken });
}
function schedules(offer, key) {
  const s = offer?.[key]?.[0]?.schedule;
  return Array.isArray(s) ? s : [];
}
function active(offer, key, now) {
  return schedules(offer, key).filter(s => {
    const start = epoch(s?.start_at); const end = epoch(s?.end_at);
    return (start === null || now >= start) && (end === null || now < end);
  }).sort((a,b) => (epoch(b?.start_at) ?? 0) - (epoch(a?.start_at) ?? 0))[0] || null;
}
function analyze(raw, now = Date.now()) {
  const summary = Array.isArray(raw?.summaries) ? raw.summaries[0] || {} : {};
  const attrs = raw?.attributes || {};
  const issues = Array.isArray(raw?.issues) ? raw.issues : [];
  const availability = Array.isArray(raw?.fulfillmentAvailability) ? raw.fulfillmentAvailability[0] || {} : {};
  const offers = Array.isArray(attrs?.purchasable_offer) ? attrs.purchasable_offer : [];
  const ci = offers.findIndex(r => String(r?.audience || "ALL").toUpperCase() === "ALL");
  const consumer = ci >= 0 ? offers[ci] : null;
  return {
    asin: String(summary?.asin || ""), productType: String(summary?.productType || ""), statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    errorCount: issues.filter(r => String(r?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: num(availability?.quantity) ?? num(attrs?.fulfillment_availability?.[0]?.quantity) ?? 0,
    offers, ci, consumer,
    normalPrice: num(active(consumer, "our_price", now)?.value_with_tax),
    activeSalePrice: num(active(consumer, "discounted_price", now)?.value_with_tax),
    minAllowed: num(active(consumer, "minimum_seller_allowed_price", now)?.value_with_tax),
  };
}
function assertState(s) {
  const e = [];
  if (s.asin !== ASIN) e.push(`ASIN=${s.asin}`);
  if (!s.productType) e.push("productType missing");
  if (!s.statuses.includes("BUYABLE")) e.push(`BUYABLE missing:${s.statuses.join("|")}`);
  if (s.errorCount) e.push(`listingErrors=${s.errorCount}`);
  if (!(s.availableQuantity > 0)) e.push(`qty=${s.availableQuantity}`);
  if (!s.consumer || s.ci < 0) e.push("consumer offer missing");
  if (s.normalPrice !== NORMAL_PRICE) e.push(`normal=${s.normalPrice}`);
  if (s.activeSalePrice !== null) e.push(`activeSale=${s.activeSalePrice}`);
  if (!(s.minAllowed > 0)) e.push(`minAllowed=${s.minAllowed}`);
  if (s.minAllowed > SAFE_FLOOR) e.push(`minAllowed>${SAFE_FLOOR}`);
  if (TEST_PRICE < SAFE_FLOOR) e.push("test below floor");
  if (e.length) { const err = new Error(e.join(" / ")); err.code = "PREFLIGHT_FAILED"; throw err; }
}
function preview(s, now) {
  const offers = JSON.parse(JSON.stringify(s.offers));
  const before = JSON.parse(JSON.stringify(offers));
  const consumer = offers[s.ci];
  const c = consumer?.discounted_price?.[0];
  if (!c || !Array.isArray(c.schedule) || !c.schedule.length) throw new Error("discounted_price template missing");
  const template = JSON.parse(JSON.stringify(c.schedule[0] || {}));
  template.value_with_tax = TEST_PRICE;
  template.start_at = new Date(now - 60000).toISOString();
  template.end_at = new Date(now + DURATION_HOURS * 3600000).toISOString();
  c.schedule = [template];
  for (let i = 0; i < offers.length; i += 1) {
    if (i !== s.ci && JSON.stringify(offers[i]) !== JSON.stringify(before[i])) throw new Error(`non-consumer offer changed:${i}`);
  }
  if (JSON.stringify(consumer?.our_price || null) !== JSON.stringify(before[s.ci]?.our_price || null)) throw new Error("normal price changed");
  if (JSON.stringify(consumer?.minimum_seller_allowed_price || null) !== JSON.stringify(before[s.ci]?.minimum_seller_allowed_price || null)) throw new Error("min price changed");
  return { startAt: template.start_at, endAt: template.end_at, patchBody: { productType: s.productType, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }] } };
}
async function validate(accessToken, body) {
  const { sellerId, marketplaceId, endpoint } = config();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", mode: "VALIDATION_PREVIEW" });
  const result = await amazon({ method: "PATCH", url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`, accessToken, body });
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const errorCount = issues.filter(r => String(r?.severity || "").toUpperCase() === "ERROR").length;
  if (errorCount) throw new Error(`VALIDATION_PREVIEW errors=${errorCount}`);
  return { result, issueCount: issues.length };
}
function csv(v) { return `"${String(v ?? "").replaceAll('"','""')}"`; }
async function run(req, res) {
  res.set("Cache-Control", "no-store");
  res.type("text/csv; charset=utf-8");
  const header = ["ok","status","moduleVersion","normalPrice","activeSalePrice","minAllowed","availableQuantity","targetPrice","durationHours","amazonIssueCount","externalChanges","startAt","endAt"];
  try {
    if (Date.now() > EXPIRES_AT) throw new Error("bridge expired");
    if (String(req.query?.token || "") !== TOKEN) return res.status(403).send(header.join(",") + "\n" + [false,"FORBIDDEN",MODULE_VERSION,"","","","",TEST_PRICE,DURATION_HOURS,"",0,"",""] .map(csv).join(","));
    const now = Date.now();
    const accessToken = await token();
    const before = analyze(await listing(accessToken), now);
    assertState(before);
    const p = preview(before, now);
    const v = await validate(accessToken, p.patchBody);
    const row = [true,"DRY_RUN_VALIDATED",MODULE_VERSION,before.normalPrice,before.activeSalePrice,before.minAllowed,before.availableQuantity,TEST_PRICE,DURATION_HOURS,v.issueCount,0,p.startAt,p.endAt];
    return res.status(200).send(header.join(",") + "\n" + row.map(csv).join(","));
  } catch (err) {
    const row = [false,err?.code || "ERROR",MODULE_VERSION,"","","","",TEST_PRICE,DURATION_HOURS,"",0,"",err?.message || String(err)];
    return res.status(err?.code === "PREFLIGHT_FAILED" ? 409 : 500).send(header.join(",") + "\n" + row.map(csv).join(","));
  }
}

express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  if (!this.__sv1PriceImportRunnerInstalled) {
    this.__sv1PriceImportRunnerInstalled = true;
    originalGet.call(this, ROUTE, run);
    console.log(`${MODULE_VERSION} temporary route installed: GET ${ROUTE}`);
  }
  return result;
};
