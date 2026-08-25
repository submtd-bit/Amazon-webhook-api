import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-s73-postregister-fix-v1.0.0";
const ROUTE = "/amazon/listing/s73-postregister-fix";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_GAP_MS = 2500;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "7X-725F-2ZML",
  asin: "B0HGDBYRS8",
  productType: "NOTEBOOK_COMPUTER",
  confirmLive: "CONFIRM_S73_POSTREGISTER_B0HGDBYRS8_20260825",
  source: Object.freeze({
    conditionType: "new_new",
    hardDiskSizeMissing: true,
    itemDisplayWeightGrams: 980,
    b2cPrice: 58000,
    b2bPrice: 52000,
    quantity: 0,
  }),
  target: Object.freeze({
    conditionType: "refurbished_refurbished",
    hardDiskSizeGB: 256,
    itemDisplayWeightGrams: 1189,
  }),
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
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
async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,offers,fulfillmentAvailability", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function requireArrayAttribute(attributes, name) {
  const value = attributes?.[name];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Missing live attribute shape: ${name}`);
  return cloneJson(value);
}
function directValue(attributes, name) { return attributes?.[name]?.[0]?.value; }
function nestedValue(attributes, name, outerKey, innerKey = "value") { return attributes?.[name]?.[0]?.[outerKey]?.[0]?.[innerKey]; }
function numEq(a, b, tolerance = 0.0001) { const x = Number(a), y = Number(b); return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x-y) <= tolerance; }
function readOfferPrice(listing, offerType) {
  const row = (Array.isArray(listing?.offers) ? listing.offers : []).find(x => String(x?.offerType || "") === offerType);
  return Number(row?.price?.amount);
}
function readQuantity(listing) {
  const row = (Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : []).find(x => String(x?.fulfillmentChannelCode || "") === "DEFAULT");
  return Number(row?.quantity);
}
function assertSource(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  if (String(summary.asin || "") !== GUARD.asin) throw new Error("SOURCE_DRIFT: ASIN mismatch");
  if (String(summary.productType || "") !== GUARD.productType) throw new Error("SOURCE_DRIFT: productType mismatch");
  const a = listing?.attributes || {};
  if (String(directValue(a, "condition_type") || "") !== GUARD.source.conditionType) throw new Error(`SOURCE_DRIFT: condition_type=${JSON.stringify(directValue(a, "condition_type"))}`);
  if (!numEq(directValue(a, "item_display_weight"), GUARD.source.itemDisplayWeightGrams)) throw new Error(`SOURCE_DRIFT: item_display_weight=${JSON.stringify(directValue(a, "item_display_weight"))}`);
  const hardDisk = a?.hard_disk?.[0] || {};
  if (!Array.isArray(a?.hard_disk) || a.hard_disk.length === 0) throw new Error("SOURCE_DRIFT: hard_disk missing");
  if (Array.isArray(hardDisk.size) && hardDisk.size.length > 0) throw new Error(`SOURCE_DRIFT: hard_disk.size already present=${JSON.stringify(hardDisk.size)}`);
  if (!numEq(readOfferPrice(listing, "B2C"), GUARD.source.b2cPrice)) throw new Error("SOURCE_DRIFT: B2C price changed");
  if (!numEq(readOfferPrice(listing, "B2B"), GUARD.source.b2bPrice)) throw new Error("SOURCE_DRIFT: B2B price changed");
  if (!numEq(readQuantity(listing), GUARD.source.quantity)) throw new Error("SOURCE_DRIFT: quantity changed");
  return a;
}
function buildPatches(attributes) {
  const condition = requireArrayAttribute(attributes, "condition_type");
  condition[0].value = GUARD.target.conditionType;
  const hardDisk = requireArrayAttribute(attributes, "hard_disk");
  hardDisk[0].size = [{ unit: "GB", value: GUARD.target.hardDiskSizeGB }];
  const weight = requireArrayAttribute(attributes, "item_display_weight");
  weight[0].value = GUARD.target.itemDisplayWeightGrams;
  weight[0].unit = "grams";
  return [
    { op: "replace", path: "/attributes/condition_type", value: condition },
    { op: "replace", path: "/attributes/hard_disk", value: hardDisk },
    { op: "replace", path: "/attributes/item_display_weight", value: weight },
  ];
}
async function patchListing(accessToken, sku, patches, preview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues" });
  if (preview) query.set("mode", "VALIDATION_PREVIEW");
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: { "x-amz-access-token": accessToken, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ productType: GUARD.productType, patches }),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return { httpStatus: response.status, responseOk: response.ok, status, submissionId: json?.submissionId || "", issueCount: issues.length, errorCount: errors.length, issues, valid: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED") };
}
function verifyTarget(listing) {
  const a = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const checks = {
    conditionRefurbished: String(directValue(a, "condition_type") || "") === GUARD.target.conditionType,
    hardDisk256GB: numEq(nestedValue(a, "hard_disk", "size"), GUARD.target.hardDiskSizeGB),
    itemWeight1189g: numEq(directValue(a, "item_display_weight"), GUARD.target.itemDisplayWeightGrams),
    b2cPriceUnchanged: numEq(readOfferPrice(listing, "B2C"), GUARD.source.b2cPrice),
    b2bPriceUnchanged: numEq(readOfferPrice(listing, "B2B"), GUARD.source.b2bPrice),
    quantityStill0: numEq(readQuantity(listing), GUARD.source.quantity),
    warning18448Cleared: !issues.some(x => String(x?.code || "") === "18448"),
  };
  return { verified: Object.values(checks).every(Boolean), checks, issues, snapshot: { conditionType: directValue(a, "condition_type"), hardDisk: a.hard_disk || [], itemDisplayWeight: a.item_display_weight || [], offers: listing.offers || [], fulfillmentAvailability: listing.fulfillmentAvailability || [] } };
}
async function handler(req, res) {
  let livePatchSent = false;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, livePatchSent: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, livePatchSent: false, externalChanges: 0, error: "Unauthorized" });
    const sku = String(req.body?.sku || "").trim();
    const confirmLive = String(req.body?.confirmLive || "").trim();
    if (sku !== GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (confirmLive !== GUARD.confirmLive) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");

    const token = await getLwaAccessToken();
    const before = await getListing(token, sku);
    const attributes = assertSource(before);
    const patches = buildPatches(attributes);
    const freshPreview = await patchListing(token, sku, patches, true);
    if (!freshPreview.valid) throw new Error(`LIVE_GUARD_BLOCKED: fresh VALIDATION_PREVIEW failed ${JSON.stringify(freshPreview)}`);
    const liveResult = await patchListing(token, sku, patches, false);
    livePatchSent = true;
    if (!liveResult.valid) return res.status(502).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, sku, asin: GUARD.asin, livePatchSent: true, freshPreview, liveResult, postVerified: false, externalChanges: 0, error: "LIVE_PATCH_RESPONSE_NOT_ACCEPTED" });

    let verification = null;
    const verificationAttempts = [];
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(VERIFY_GAP_MS);
      verification = verifyTarget(await getListing(token, sku));
      verificationAttempts.push({ attempt, verified: verification.verified, checks: verification.checks });
      if (verification.verified) break;
    }
    const postVerified = Boolean(verification?.verified);
    return res.status(200).json({ ok: postVerified, moduleVersion: MODULE_VERSION, route: ROUTE, sku, asin: GUARD.asin, productType: GUARD.productType, freshPreview, livePatchSent: true, livePatchAttempts: 1, liveResult, postVerified, verificationAttempts, finalSnapshot: verification?.snapshot || {}, finalIssues: verification?.issues || [], externalChanges: postVerified ? 1 : 0, verificationPending: !postVerified, note: postVerified ? "S73 condition, storage size and weight updated and verified" : "LIVE PATCH accepted once but propagation was not fully visible; do not retry automatically" });
  } catch (err) {
    return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, livePatchSent, livePatchAttempts: livePatchSent ? 1 : 0, externalChanges: 0, error: err?.message || String(err) });
  }
}
express.application.listen = function s73PostregisterFixListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
