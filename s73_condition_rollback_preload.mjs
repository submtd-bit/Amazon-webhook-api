import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-s73-condition-rollback-v1.0.0";
const ROUTE = "/amazon/listing/s73-condition-rollback";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_GAP_MS = 2500;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "7X-725F-2ZML",
  asin: "B0HGDBYRS8",
  productType: "NOTEBOOK_COMPUTER",
  confirmLive: "CONFIRM_S73_CONDITION_ROLLBACK_B0HGDBYRS8_20260826",
  source: Object.freeze({
    conditionType: "refurbished_refurbished",
    hardDiskSizeGB: 256,
    itemDisplayWeightGrams: 1189,
    b2cPrice: 58000,
    b2bPrice: 52000,
    quantity: 10,
  }),
  targetConditionType: "new_new",
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
function numEq(a, b, tolerance = 0.0001) {
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= tolerance;
}
function readOfferPrice(listing, offerType) {
  const row = (Array.isArray(listing?.offers) ? listing.offers : []).find(x => String(x?.offerType || "") === offerType);
  return Number(row?.price?.amount);
}
function readQuantity(listing) {
  const row = (Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : []).find(x => String(x?.fulfillmentChannelCode || "") === "DEFAULT");
  return Number(row?.quantity);
}
function readCondition(listing) { return String(listing?.attributes?.condition_type?.[0]?.value || ""); }
function readHardDiskSize(listing) { return Number(listing?.attributes?.hard_disk?.[0]?.size?.[0]?.value); }
function readWeight(listing) { return Number(listing?.attributes?.item_display_weight?.[0]?.value); }
function summaryOf(listing) { return Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {}; }

function assertSource(listing) {
  const summary = summaryOf(listing);
  if (String(summary.asin || "") !== GUARD.asin) throw new Error("SOURCE_DRIFT: ASIN mismatch");
  if (String(summary.productType || "") !== GUARD.productType) throw new Error("SOURCE_DRIFT: productType mismatch");
  if (readCondition(listing) !== GUARD.source.conditionType) throw new Error(`SOURCE_DRIFT: condition_type=${JSON.stringify(readCondition(listing))}`);
  if (!numEq(readHardDiskSize(listing), GUARD.source.hardDiskSizeGB)) throw new Error(`SOURCE_DRIFT: hard_disk.size=${JSON.stringify(readHardDiskSize(listing))}`);
  if (!numEq(readWeight(listing), GUARD.source.itemDisplayWeightGrams)) throw new Error(`SOURCE_DRIFT: item_display_weight=${JSON.stringify(readWeight(listing))}`);
  if (!numEq(readOfferPrice(listing, "B2C"), GUARD.source.b2cPrice)) throw new Error("SOURCE_DRIFT: B2C price changed");
  if (!numEq(readOfferPrice(listing, "B2B"), GUARD.source.b2bPrice)) throw new Error("SOURCE_DRIFT: B2B price changed");
  if (!numEq(readQuantity(listing), GUARD.source.quantity)) throw new Error("SOURCE_DRIFT: quantity changed");
}

function buildConditionPatch(listing) {
  const current = listing?.attributes?.condition_type;
  if (!Array.isArray(current) || !current[0]) throw new Error("Missing live condition_type shape");
  const value = JSON.parse(JSON.stringify(current));
  value[0].value = GUARD.targetConditionType;
  return [{ op: "replace", path: "/attributes/condition_type", value }];
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
  const summary = summaryOf(listing);
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const checks = {
    conditionRestored: readCondition(listing) === GUARD.targetConditionType,
    hardDiskStill256GB: numEq(readHardDiskSize(listing), GUARD.source.hardDiskSizeGB),
    itemWeightStill1189g: numEq(readWeight(listing), GUARD.source.itemDisplayWeightGrams),
    b2cPriceUnchanged: numEq(readOfferPrice(listing, "B2C"), GUARD.source.b2cPrice),
    b2bPriceUnchanged: numEq(readOfferPrice(listing, "B2B"), GUARD.source.b2bPrice),
    quantityStill10: numEq(readQuantity(listing), GUARD.source.quantity),
  };
  return {
    verified: Object.values(checks).every(Boolean),
    checks,
    status: Array.isArray(summary.status) ? summary.status : [],
    issues,
    issue18971Present: issues.some(x => String(x?.code || "") === "18971"),
    snapshot: {
      conditionType: readCondition(listing),
      hardDisk: listing?.attributes?.hard_disk || [],
      itemDisplayWeight: listing?.attributes?.item_display_weight || [],
      offers: listing?.offers || [],
      fulfillmentAvailability: listing?.fulfillmentAvailability || [],
    },
  };
}

async function handler(req, res) {
  let livePatchSent = false;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });

    const sku = String(req.body?.sku || "").trim();
    const confirmLive = String(req.body?.confirmLive || "").trim();
    if (sku !== GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (confirmLive !== GUARD.confirmLive) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");

    const token = await getLwaAccessToken();
    const before = await getListing(token, sku);
    assertSource(before);
    const patches = buildConditionPatch(before);

    const freshPreview = await patchListing(token, sku, patches, true);
    if (!freshPreview.valid) throw new Error(`LIVE_GUARD_BLOCKED: VALIDATION_PREVIEW failed ${JSON.stringify(freshPreview)}`);

    const liveResult = await patchListing(token, sku, patches, false);
    livePatchSent = true;
    if (!liveResult.valid) return res.status(502).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, sku, asin: GUARD.asin, livePatchSent: true, livePatchAttempts: 1, freshPreview, liveResult, externalChanges: 0, error: "LIVE_PATCH_RESPONSE_NOT_ACCEPTED" });

    let verification = null;
    const verificationAttempts = [];
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(VERIFY_GAP_MS);
      verification = verifyTarget(await getListing(token, sku));
      verificationAttempts.push({ attempt, verified: verification.verified, checks: verification.checks, status: verification.status, issue18971Present: verification.issue18971Present });
      if (verification.verified) break;
    }

    return res.status(200).json({
      ok: Boolean(verification?.verified),
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: GUARD.asin,
      targetConditionType: GUARD.targetConditionType,
      freshPreview,
      livePatchSent: true,
      livePatchAttempts: 1,
      liveResult,
      postVerified: Boolean(verification?.verified),
      verificationAttempts,
      finalStatus: verification?.status || [],
      issue18971Present: Boolean(verification?.issue18971Present),
      finalIssues: verification?.issues || [],
      finalSnapshot: verification?.snapshot || {},
      externalChanges: verification?.verified ? 1 : 0,
      note: verification?.verified
        ? "condition_type restored to original new_new; storage, weight, prices and quantity preserved. BUYABLE/18971 may clear asynchronously."
        : "LIVE PATCH accepted once but condition propagation was not fully visible; do not retry automatically.",
    });
  } catch (err) {
    return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, livePatchSent, livePatchAttempts: livePatchSent ? 1 : 0, externalChanges: 0, error: err?.message || String(err) });
  }
}

express.application.listen = function s73ConditionRollbackListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
