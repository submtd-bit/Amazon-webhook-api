import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-0u18155-threshold-probe-v1.0.0";
const ROUTE = "/amazon/listing/0u18155-threshold-probe";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "0U-3IJD-CZ48",
  asin: "B0FMYF5C2Y",
  productType: "NOTEBOOK_COMPUTER",
  issueCode: "18155",
  ourPrice: 32000,
  expiredSalePrice: 53000,
  expiredSaleStart: "2025-10-26T15:00:00.000Z",
  expiredSaleEnd: "2025-11-29T15:00:00.000Z",
  currentMin: 32000,
  currentMax: 58000,
  b2bAttributePrice: 55100,
  quantityDiscountType: "percent",
  quantityTiers: [
    { lowerBound: 5, value: 5 },
    { lowerBound: 10, value: 7 },
  ],
  candidateMinimums: [31900, 31600, 31000, 30000],
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
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
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,offers", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const response = await fetchWithTimeout(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
function firstSchedule(node) {
  if (!Array.isArray(node) || node.length !== 1) return null;
  const schedule = node[0]?.schedule;
  if (!Array.isArray(schedule) || schedule.length !== 1) return null;
  return schedule[0] || null;
}
function parseQuantityPlan(b2bOffer) {
  const schedule = b2bOffer?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
  const levels = Array.isArray(schedule?.levels) ? schedule.levels : [];
  return {
    discountType: String(schedule?.discount_type || "").toLowerCase(),
    tiers: levels.map(x => ({ lowerBound: numberOrNull(x?.lower_bound), value: numberOrNull(x?.value) })),
  };
}
function plansEqual(a, b) {
  if (a.discountType !== b.discountType || a.tiers.length !== b.tiers.length) return false;
  return a.tiers.every((x, i) => x.lowerBound === b.tiers[i].lowerBound && x.value === b.tiers[i].value);
}
function assertCurrentState(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  if (String(summary?.asin || "") !== GUARD.asin) throw new Error(`GUARD_BLOCKED: ASIN mismatch ${summary?.asin || ""}`);
  if (String(summary?.productType || "") !== GUARD.productType) throw new Error(`GUARD_BLOCKED: productType mismatch ${summary?.productType || ""}`);

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const issue18155 = issues.filter(i => String(i?.code || "") === GUARD.issueCode && String(i?.severity || "").toUpperCase() === "ERROR");
  if (issue18155.length !== 1) throw new Error(`GUARD_BLOCKED: expected one ERROR 18155, found ${issue18155.length}`);

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const offers = Array.isArray(attributes?.purchasable_offer) ? JSON.parse(JSON.stringify(attributes.purchasable_offer)) : [];
  const consumerIndex = offers.findIndex(o => String(o?.audience || "ALL").toUpperCase() === "ALL");
  const b2bIndex = offers.findIndex(o => String(o?.audience || "").toUpperCase() === "B2B");
  if (consumerIndex < 0 || b2bIndex < 0) throw new Error("GUARD_BLOCKED: ALL or B2B purchasable_offer missing");

  const consumer = offers[consumerIndex];
  const b2b = offers[b2bIndex];
  const our = firstSchedule(consumer.our_price);
  const sale = firstSchedule(consumer.discounted_price);
  const min = firstSchedule(consumer.minimum_seller_allowed_price);
  const max = firstSchedule(consumer.maximum_seller_allowed_price);
  const b2bOur = firstSchedule(b2b.our_price);
  const qty = parseQuantityPlan(b2b);

  if (numberOrNull(our?.value_with_tax) !== GUARD.ourPrice) throw new Error(`GUARD_BLOCKED: ourPrice mismatch ${our?.value_with_tax}`);
  if (numberOrNull(sale?.value_with_tax) !== GUARD.expiredSalePrice) throw new Error(`GUARD_BLOCKED: salePrice mismatch ${sale?.value_with_tax}`);
  if (String(sale?.start_at || "") !== GUARD.expiredSaleStart || String(sale?.end_at || "") !== GUARD.expiredSaleEnd) throw new Error("GUARD_BLOCKED: expired sale window mismatch");
  if (!(Date.parse(GUARD.expiredSaleEnd) < Date.now())) throw new Error("GUARD_BLOCKED: sale is not expired");
  if (numberOrNull(min?.value_with_tax) !== GUARD.currentMin) throw new Error(`GUARD_BLOCKED: minimum mismatch ${min?.value_with_tax}`);
  if (numberOrNull(max?.value_with_tax) !== GUARD.currentMax) throw new Error(`GUARD_BLOCKED: maximum mismatch ${max?.value_with_tax}`);
  if (numberOrNull(b2bOur?.value_with_tax) !== GUARD.b2bAttributePrice) throw new Error(`GUARD_BLOCKED: B2B attribute price mismatch ${b2bOur?.value_with_tax}`);
  if (!plansEqual(qty, { discountType: GUARD.quantityDiscountType, tiers: GUARD.quantityTiers })) throw new Error(`GUARD_BLOCKED: B2B quantity plan mismatch ${JSON.stringify(qty)}`);

  const listingOffers = Array.isArray(listing?.offers) ? listing.offers : [];
  return {
    asin: GUARD.asin,
    productType: GUARD.productType,
    statuses: Array.isArray(summary?.status) ? summary.status : [],
    issue18155,
    offers,
    consumerIndex,
    marketplaceId: String(consumer?.marketplace_id || ""),
    current: {
      ourPrice: GUARD.ourPrice,
      expiredSalePrice: GUARD.expiredSalePrice,
      currentMin: GUARD.currentMin,
      currentMax: GUARD.currentMax,
      b2bAttributePrice: GUARD.b2bAttributePrice,
      quantityPlan: qty,
      listingOffers,
    },
  };
}
async function validationPreview(accessToken, state, candidateMin) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const mutated = JSON.parse(JSON.stringify(state.offers));
  mutated[state.consumerIndex].minimum_seller_allowed_price = [{ schedule: [{ value_with_tax: candidateMin }] }];
  const body = { productType: state.productType, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: mutated }] };
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues", mode: "VALIDATION_PREVIEW" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: { "x-amz-access-token": accessToken, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR");
  const issue18155 = errors.filter(i => String(i?.code || "") === "18155");
  const status = String(json?.status || "").toUpperCase();
  return {
    candidateMin,
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    errorCount: errors.length,
    issue18155Count: issue18155.length,
    issues,
    validationPassed: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}
async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    const sku = String(req.body?.sku || "").trim();
    if (sku !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken);
    const state = assertCurrentState(listing);
    const probes = [];
    for (const candidateMin of GUARD.candidateMinimums) {
      probes.push(await validationPreview(accessToken, state, candidateMin));
      await sleep(300);
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: GUARD.asin,
      productType: GUARD.productType,
      status: state.statuses,
      current: state.current,
      issue18155: state.issue18155,
      candidateMinimums: GUARD.candidateMinimums,
      probes,
      readOnly: true,
      externalChanges: 0,
      note: "All mutations were SP-API VALIDATION_PREVIEW only. No listing changes were persisted.",
    });
  } catch (err) {
    console.error("Amazon 0U 18155 threshold probe error", err?.message || String(err));
    return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: err?.message || String(err) });
  }
}
express.application.listen = function amazon0u18155ThresholdProbeListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
