import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-27-amazon-cf-sv7-8115-condition-live-v1.0.0";
const ROUTE = "/amazon/listing/cf-sv7-8115-condition-live";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_GAP_MS = 2500;
const originalListen = express.application.listen;
let liveSentThisProcess = false;

const GUARD = Object.freeze({
  sku: "cf-sv7-i5-8gb-ssd512",
  asin: "B0GH7L4DQ3",
  peerSku: "cf-sv7-i5-8gb-ssd516",
  productType: "NOTEBOOK_COMPUTER",
  marketplaceId: "A1VC38T7YXB528",
  issueCode: "8115",
  targetCondition: "new_new",
  expectedB2cPrice: 44000,
  expectedPoints: 440,
  expectedQuantity: 4,
  priorPreviewSubmissionId: "1570781bc1b647c295357161f103fc64",
  confirmToken: "CONFIRM_CF_SV7_8115_CONDITION_NEW_NEW_20260827",
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || GUARD.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== GUARD.marketplaceId) throw new Error(`LIVE_GUARD_BLOCKED: marketplace mismatch ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}
async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
function summaryOf(listing) {
  return Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
}
function issuesOf(listing) {
  return Array.isArray(listing?.issues) ? listing.issues : [];
}
function conditionOf(listing) {
  const rows = listing?.attributes?.condition_type;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length !== 1) return { invalidShape: true, raw: rows };
  return {
    value: String(rows[0]?.value || ""),
    marketplaceId: String(rows[0]?.marketplace_id || ""),
    raw: rows[0],
  };
}
function issue8115Rows(listing) {
  return issuesOf(listing).filter(x => String(x?.code || "") === GUARD.issueCode);
}
function b2cSnapshot(listing) {
  const row = (Array.isArray(listing?.offers) ? listing.offers : [])
    .find(x => String(x?.offerType || "") === "B2C");
  return {
    price: numberOrNull(row?.price?.amount),
    points: numberOrNull(row?.points?.pointsNumber),
  };
}
function quantitySnapshot(listing) {
  const row = (Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [])
    .find(x => String(x?.fulfillmentChannelCode || "") === "DEFAULT");
  return numberOrNull(row?.quantity);
}
function assertTargetBefore(listing) {
  const summary = summaryOf(listing);
  if (String(summary.asin || "") !== GUARD.asin) throw new Error(`LIVE_GUARD_BLOCKED: target ASIN mismatch ${summary.asin || ""}`);
  if (String(summary.productType || "") !== GUARD.productType) throw new Error(`LIVE_GUARD_BLOCKED: target productType mismatch ${summary.productType || ""}`);
  if (conditionOf(listing) !== null) throw new Error(`LIVE_GUARD_BLOCKED: target condition_type is no longer absent ${JSON.stringify(conditionOf(listing))}`);
  const issue8115 = issue8115Rows(listing);
  if (issue8115.length !== 1) throw new Error(`LIVE_GUARD_BLOCKED: expected exactly one issue 8115, found ${issue8115.length}`);
  const suppressed = Array.isArray(issue8115[0]?.enforcements?.actions)
    && issue8115[0].enforcements.actions.some(x => String(x?.action || "") === "LISTING_SUPPRESSED");
  if (!suppressed) throw new Error("LIVE_GUARD_BLOCKED: 8115 is not LISTING_SUPPRESSED");

  const b2c = b2cSnapshot(listing);
  const quantity = quantitySnapshot(listing);
  if (b2c.price !== GUARD.expectedB2cPrice) throw new Error(`LIVE_GUARD_BLOCKED: B2C price drift ${b2c.price}`);
  if (b2c.points !== GUARD.expectedPoints) throw new Error(`LIVE_GUARD_BLOCKED: points drift ${b2c.points}`);
  if (quantity !== GUARD.expectedQuantity) throw new Error(`LIVE_GUARD_BLOCKED: quantity drift ${quantity}`);

  return {
    status: Array.isArray(summary.status) ? summary.status : [],
    issues: issuesOf(listing),
    b2c,
    quantity,
    offers: Array.isArray(listing?.offers) ? listing.offers : [],
    fulfillmentAvailability: Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [],
  };
}
function assertPeer(listing) {
  const summary = summaryOf(listing);
  if (String(summary.asin || "") !== GUARD.asin) throw new Error(`LIVE_GUARD_BLOCKED: peer ASIN mismatch ${summary.asin || ""}`);
  if (String(summary.productType || "") !== GUARD.productType) throw new Error(`LIVE_GUARD_BLOCKED: peer productType mismatch ${summary.productType || ""}`);
  const condition = conditionOf(listing);
  if (!condition || condition.invalidShape) throw new Error(`LIVE_GUARD_BLOCKED: peer condition_type missing/invalid ${JSON.stringify(condition)}`);
  if (condition.value !== GUARD.targetCondition) throw new Error(`LIVE_GUARD_BLOCKED: peer condition_type=${condition.value}`);
  if (condition.marketplaceId !== GUARD.marketplaceId) throw new Error(`LIVE_GUARD_BLOCKED: peer marketplace_id=${condition.marketplaceId}`);
  if (issue8115Rows(listing).length !== 0) throw new Error("LIVE_GUARD_BLOCKED: peer has issue 8115");
  return {
    status: Array.isArray(summary.status) ? summary.status : [],
    conditionType: condition,
    issueCount: issuesOf(listing).length,
  };
}
function buildPatches() {
  return [{
    op: "add",
    path: "/attributes/condition_type",
    value: [{
      value: GUARD.targetCondition,
      marketplace_id: GUARD.marketplaceId,
    }],
  }];
}
async function patchListing(accessToken, preview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
  if (preview) query.set("mode", "VALIDATION_PREVIEW");
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ productType: GUARD.productType, patches: buildPatches() }),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const issue8115 = issues.filter(x => String(x?.code || "") === GUARD.issueCode);
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issueCount: issues.length,
    errorCount: errors.length,
    issue8115Count: issue8115.length,
    issues,
    accepted: response.ok && errors.length === 0 && issue8115.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}
function verifyAfter(listing) {
  const summary = summaryOf(listing);
  const condition = conditionOf(listing);
  const b2c = b2cSnapshot(listing);
  const quantity = quantitySnapshot(listing);
  const checks = {
    asinUnchanged: String(summary.asin || "") === GUARD.asin,
    productTypeUnchanged: String(summary.productType || "") === GUARD.productType,
    conditionApplied: Boolean(condition && !condition.invalidShape && condition.value === GUARD.targetCondition && condition.marketplaceId === GUARD.marketplaceId),
    b2cPriceUnchanged: b2c.price === GUARD.expectedB2cPrice,
    pointsUnchanged: b2c.points === GUARD.expectedPoints,
    quantityUnchanged: quantity === GUARD.expectedQuantity,
  };
  return {
    verified: Object.values(checks).every(Boolean),
    checks,
    conditionType: condition,
    status: Array.isArray(summary.status) ? summary.status : [],
    issue8115Count: issue8115Rows(listing).length,
    issues: issuesOf(listing),
    b2c,
    quantity,
  };
}
async function handler(req, res) {
  let livePatchSent = false;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    if (liveSentThisProcess) throw new Error("LIVE_GUARD_BLOCKED: live already sent in this process");

    const sku = String(req.body?.sku || "").trim();
    const priorPreviewSubmissionId = String(req.body?.priorPreviewSubmissionId || "").trim();
    const confirmToken = String(req.body?.confirmToken || "").trim();
    if (sku !== GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (priorPreviewSubmissionId !== GUARD.priorPreviewSubmissionId) throw new Error("LIVE_GUARD_BLOCKED: prior Preview submission ID mismatch");
    if (confirmToken !== GUARD.confirmToken) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");

    const accessToken = await getLwaAccessToken();
    const before = assertTargetBefore(await getListing(accessToken, GUARD.sku));
    const peer = assertPeer(await getListing(accessToken, GUARD.peerSku));

    const freshPreview = await patchListing(accessToken, true);
    if (!freshPreview.accepted) throw new Error(`LIVE_GUARD_BLOCKED: fresh Validation Preview failed ${JSON.stringify(freshPreview)}`);

    const live = await patchListing(accessToken, false);
    livePatchSent = true;
    liveSentThisProcess = true;
    if (!live.accepted) {
      return res.status(502).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        sku: GUARD.sku,
        asin: GUARD.asin,
        repairIntent: "ADD_CONDITION_TYPE_NEW_NEW_ONLY",
        priorPreviewSubmissionId: GUARD.priorPreviewSubmissionId,
        freshPreview,
        live,
        livePatchSent: true,
        externalChanges: 1,
        error: "LIVE_PATCH_RESPONSE_NOT_ACCEPTED",
        note: "A LIVE PATCH was sent. Do not rerun blindly.",
      });
    }

    let verification = null;
    const verificationAttempts = [];
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(VERIFY_GAP_MS);
      verification = verifyAfter(await getListing(accessToken, GUARD.sku));
      verificationAttempts.push({
        attempt,
        verified: verification.verified,
        checks: verification.checks,
        status: verification.status,
        issue8115Count: verification.issue8115Count,
      });
      if (verification.verified) break;
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: GUARD.asin,
      productType: GUARD.productType,
      repairIntent: "ADD_CONDITION_TYPE_NEW_NEW_ONLY",
      priorPreviewSubmissionId: GUARD.priorPreviewSubmissionId,
      evidence: {
        targetConditionBefore: null,
        targetIssue8115Count: 1,
        targetStatus: before.status,
        peerSku: GUARD.peerSku,
        peerConditionType: peer.conditionType,
        peerIssueCount: peer.issueCount,
        peerStatus: peer.status,
      },
      preservedBefore: {
        b2c: before.b2c,
        quantity: before.quantity,
        offers: before.offers,
        fulfillmentAvailability: before.fulfillmentAvailability,
      },
      after: { conditionType: GUARD.targetCondition },
      freshPreview,
      live,
      livePatchSent: true,
      postVerified: Boolean(verification?.verified),
      verificationAttempts,
      final: verification,
      externalChanges: 1,
      note: verification?.verified
        ? "condition_type=new_new is visible and guarded price/points/quantity are unchanged. 8115 enforcement may clear asynchronously."
        : "LIVE PATCH was accepted once but condition propagation is not fully visible yet. Do not resend; verify later with READ ONLY audit.",
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      livePatchSent,
      externalChanges: livePatchSent ? 1 : 0,
      error: err?.message || String(err),
      note: livePatchSent ? "A LIVE PATCH was already sent. Do not rerun blindly." : "No LIVE PATCH was sent; request failed closed.",
    });
  }
}

express.application.listen = function amazonCfSv78115ConditionLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
