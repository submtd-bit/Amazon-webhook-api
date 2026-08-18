import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-08-18-g83-b2b-price-v1.0.0";
const ROUTE = "/amazon/price/g83/b2b";
const G83_SKU = "E7-YLJ3-F9CY";
const G83_ASIN = "B0GZBHBQN2";
const EXPECTED_NORMAL_PRICE = 58000;
const EXPECTED_SALE_PRICE = 41170;
const EXPECTED_MIN_PRICE = 36100;
const EXPECTED_B2B_BEFORE = 55100;
const TARGET_B2B_PRICE = 39900;
const EXPECTED_SALE_END_UTC = "2026-08-23T15:00:00.000Z";
const LIVE_CONFIRM = "G83-B2B-39900";
const FINGERPRINT_TTL_MS = 60 * 60 * 1000;
const VERIFY_ATTEMPTS = 6;
const VERIFY_WAIT_MS = 2500;

const originalPost = express.application.post;

function safeJsonParse(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { rawText: text }; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function numberOrNull(value) { if (value === null || value === undefined || value === "") return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function isoMs(value) { const t = Date.parse(String(value || "")); return Number.isFinite(t) ? new Date(t).toISOString() : ""; }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret })
  });
  const text = await response.text(); const json = safeJsonParse(text);
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}

async function amazonRequest({ method, url, accessToken, body }) {
  const response = await fetch(url, { method, headers: { "x-amz-access-token": accessToken, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text(); const json = safeJsonParse(text);
  if (!response.ok) throw new Error(`SP-API request error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,fulfillmentAvailability", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(G83_SKU)}?${query}`;
  return amazonRequest({ method: "GET", url, accessToken });
}

function getScheduleValue(offer, key) { return offer?.[key]?.[0]?.schedule?.[0] || {}; }
function analyzeListing(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {}; const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability[0] || {} : {};
  const offers = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const consumer = offers.find(row => String(row?.audience || "ALL").toUpperCase() === "ALL");
  const b2b = offers.find(row => String(row?.audience || "").toUpperCase() === "B2B");
  const normalSchedule = getScheduleValue(consumer, "our_price"); const saleSchedule = getScheduleValue(consumer, "discounted_price");
  const minSchedule = getScheduleValue(consumer, "minimum_seller_allowed_price"); const b2bSchedule = getScheduleValue(b2b, "our_price");
  return { asin: String(summary?.asin || ""), productType: String(summary?.productType || ""), statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [], errorIssues: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR"), availableQuantity: numberOrNull(availability?.quantity) ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity) ?? 0, offers, consumer, b2b, normalPrice: numberOrNull(normalSchedule?.value_with_tax), salePrice: numberOrNull(saleSchedule?.value_with_tax), saleStart: isoMs(saleSchedule?.start_at), saleEnd: isoMs(saleSchedule?.end_at), minPrice: numberOrNull(minSchedule?.value_with_tax), b2bPrice: numberOrNull(b2bSchedule?.value_with_tax) };
}

function assertPreflight(state) {
  const errors = [];
  if (state.asin !== G83_ASIN) errors.push(`ASIN mismatch: ${state.asin || "(empty)"}`);
  if (!state.productType) errors.push("productType missing");
  if (!state.statuses.includes("BUYABLE")) errors.push(`BUYABLE missing: ${state.statuses.join(",")}`);
  if (state.errorIssues.length) errors.push(`listing ERROR issues=${state.errorIssues.length}`);
  if (!(state.availableQuantity > 0)) errors.push(`availableQuantity must be > 0: ${state.availableQuantity}`);
  if (!state.consumer) errors.push("consumer purchasable_offer missing"); if (!state.b2b) errors.push("B2B purchasable_offer missing");
  if (state.normalPrice !== EXPECTED_NORMAL_PRICE) errors.push(`normal price mismatch: ${state.normalPrice}`);
  if (state.salePrice !== EXPECTED_SALE_PRICE) errors.push(`sale price mismatch: ${state.salePrice}`);
  if (state.minPrice !== EXPECTED_MIN_PRICE) errors.push(`minimum seller price mismatch: ${state.minPrice}`);
  if (state.saleEnd !== EXPECTED_SALE_END_UTC) errors.push(`sale end mismatch: ${state.saleEnd || "(empty)"}`);
  if (state.b2bPrice !== EXPECTED_B2B_BEFORE && state.b2bPrice !== TARGET_B2B_PRICE) errors.push(`B2B price mismatch: ${state.b2bPrice}`);
  if (errors.length) { const err = new Error(`G83 B2B preflight failed: ${errors.join(" / ")}`); err.code = "PREFLIGHT_FAILED"; err.details = errors; throw err; }
}

function buildPatch(state) {
  const offers = JSON.parse(JSON.stringify(state.offers));
  const b2bIndex = offers.findIndex(row => String(row?.audience || "").toUpperCase() === "B2B");
  if (b2bIndex < 0) throw new Error("B2B purchasable_offer not found");
  const schedule = offers[b2bIndex]?.our_price?.[0]?.schedule?.[0]; if (!schedule) throw new Error("B2B our_price schedule not found");
  schedule.value_with_tax = TARGET_B2B_PRICE;
  return { productType: state.productType, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }] };
}
function hasErrorIssues(result) { const issues = Array.isArray(result?.issues) ? result.issues : []; return issues.some(row => String(row?.severity || "").toUpperCase() === "ERROR"); }
async function submitPatch(accessToken, patchBody, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig(); const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" }); if (validationPreview) query.set("mode", "VALIDATION_PREVIEW");
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(G83_SKU)}?${query}`;
  const result = await amazonRequest({ method: "PATCH", url, accessToken, body: patchBody }); if (hasErrorIssues(result)) throw new Error(`Amazon validation returned ERROR issues: ${JSON.stringify(result.issues)}`); return result;
}
function makeFingerprint(state) {
  const secret = getSecret(); const payload = { v: 1, sku: G83_SKU, asin: G83_ASIN, normalPrice: state.normalPrice, salePrice: state.salePrice, minPrice: state.minPrice, saleEnd: state.saleEnd, b2bPrice: state.b2bPrice, targetB2bPrice: TARGET_B2B_PRICE, issuedAt: Date.now() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url"); const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url"); return `${encoded}.${signature}`;
}
function verifyFingerprint(token) {
  const secret = getSecret(); const [encoded, signature] = String(token || "").split("."); if (!encoded || !signature) throw new Error("dryRunFingerprint is required");
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url"); const a = Buffer.from(signature); const b = Buffer.from(expected); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("dryRunFingerprint signature mismatch");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); if (Date.now() - Number(payload.issuedAt || 0) > FINGERPRINT_TTL_MS) throw new Error("dryRunFingerprint expired");
  if (payload.sku !== G83_SKU || payload.asin !== G83_ASIN || payload.normalPrice !== EXPECTED_NORMAL_PRICE || payload.salePrice !== EXPECTED_SALE_PRICE || payload.minPrice !== EXPECTED_MIN_PRICE || payload.saleEnd !== EXPECTED_SALE_END_UTC || payload.targetB2bPrice !== TARGET_B2B_PRICE) throw new Error("dryRunFingerprint scope mismatch"); return payload;
}
function isApplied(state) { return state.asin === G83_ASIN && state.normalPrice === EXPECTED_NORMAL_PRICE && state.salePrice === EXPECTED_SALE_PRICE && state.minPrice === EXPECTED_MIN_PRICE && state.saleEnd === EXPECTED_SALE_END_UTC && state.b2bPrice === TARGET_B2B_PRICE; }
async function verifyApplied(accessToken) { let lastError = ""; for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) { try { const state = analyzeListing(await getListing(accessToken)); if (isApplied(state)) return { verified: true, attempt, state }; lastError = `not yet applied: b2b=${state.b2bPrice}`; } catch (err) { lastError = err?.message || String(err); } if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS); } return { verified: false, attempt: VERIFY_ATTEMPTS, error: lastError }; }

async function handler(req, res) {
  try {
    const secret = getSecret(); if (!secret) return res.status(500).json({ ok: false, error: "AMAZON_STOCK_API_SECRET is not set" }); if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const dryRun = req.body?.dryRun === true; if (!dryRun) { if (req.body?.confirm !== LIVE_CONFIRM) return res.status(400).json({ ok: false, error: `confirm must equal ${LIVE_CONFIRM}` }); verifyFingerprint(req.body?.dryRunFingerprint); }
    if (Number(req.body?.targetB2bPrice) !== TARGET_B2B_PRICE) return res.status(400).json({ ok: false, error: `targetB2bPrice must equal ${TARGET_B2B_PRICE}` });
    const accessToken = await getLwaAccessToken(); const before = analyzeListing(await getListing(accessToken)); assertPreflight(before);
    if (isApplied(before)) return res.status(200).json({ ok: true, moduleVersion: MODULE_VERSION, status: "ALREADY_APPLIED", dryRun, verified: true, before });
    const patchBody = buildPatch(before);
    if (dryRun) { const validation = await submitPatch(accessToken, patchBody, true); return res.status(200).json({ ok: true, moduleVersion: MODULE_VERSION, status: "DRY_RUN_READY", dryRun: true, sku: G83_SKU, asin: G83_ASIN, before, targetB2bPrice: TARGET_B2B_PRICE, patchPreview: patchBody, amazonValidation: validation, dryRunFingerprint: makeFingerprint(before), fingerprintTtlMinutes: 60, liveConfirm: LIVE_CONFIRM }); }
    const accepted = await submitPatch(accessToken, patchBody, false); const verification = await verifyApplied(accessToken); if (!verification.verified) return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, status: "VERIFICATION_FAILED", accepted, verification });
    return res.status(200).json({ ok: true, moduleVersion: MODULE_VERSION, status: "COMPLETED", dryRun: false, accepted, verification });
  } catch (err) {
    console.error("G83 B2B price error", { message: err?.message || String(err), code: err?.code || "" });
    return res.status(err?.code === "PREFLIGHT_FAILED" ? 409 : 500).json({ ok: false, moduleVersion: MODULE_VERSION, status: err?.code || "ERROR", error: err?.message || String(err), details: err?.details || [] });
  }
}

express.application.post = function g83B2bPricePost(path, ...handlers) { if (path === ROUTE) return originalPost.call(this, path, handler); return originalPost.call(this, path, ...handlers); };
