import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-27-amazon-cf-sv7-8115-condition-preview-v1.0.0";
const ROUTE = "/amazon/listing/cf-sv7-8115-condition-preview";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "cf-sv7-i5-8gb-ssd512",
  asin: "B0GH7L4DQ3",
  peerSku: "cf-sv7-i5-8gb-ssd516",
  productType: "NOTEBOOK_COMPUTER",
  marketplaceId: "A1VC38T7YXB528",
  issueCode: "8115",
  targetCondition: "new_new",
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || GUARD.marketplaceId).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== GUARD.marketplaceId) throw new Error(`GUARD_BLOCKED: marketplace mismatch ${marketplaceId}`);
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
function assertTarget(listing) {
  const summary = summaryOf(listing);
  if (String(summary.asin || "") !== GUARD.asin) throw new Error(`GUARD_BLOCKED: target ASIN mismatch ${summary.asin || ""}`);
  if (String(summary.productType || "") !== GUARD.productType) throw new Error(`GUARD_BLOCKED: target productType mismatch ${summary.productType || ""}`);
  if (conditionOf(listing) !== null) throw new Error(`GUARD_BLOCKED: target condition_type is no longer absent ${JSON.stringify(conditionOf(listing))}`);
  const issue8115 = issue8115Rows(listing);
  if (issue8115.length !== 1) throw new Error(`GUARD_BLOCKED: expected exactly one issue 8115, found ${issue8115.length}`);
  const suppression = Array.isArray(issue8115[0]?.enforcements?.actions)
    && issue8115[0].enforcements.actions.some(x => String(x?.action || "") === "LISTING_SUPPRESSED");
  if (!suppression) throw new Error("GUARD_BLOCKED: 8115 is not LISTING_SUPPRESSED");
  return {
    status: Array.isArray(summary.status) ? summary.status : [],
    issues: issuesOf(listing),
    offers: Array.isArray(listing?.offers) ? listing.offers : [],
    fulfillmentAvailability: Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [],
  };
}
function assertPeer(listing) {
  const summary = summaryOf(listing);
  if (String(summary.asin || "") !== GUARD.asin) throw new Error(`GUARD_BLOCKED: peer ASIN mismatch ${summary.asin || ""}`);
  if (String(summary.productType || "") !== GUARD.productType) throw new Error(`GUARD_BLOCKED: peer productType mismatch ${summary.productType || ""}`);
  const condition = conditionOf(listing);
  if (!condition || condition.invalidShape) throw new Error(`GUARD_BLOCKED: peer condition_type missing/invalid ${JSON.stringify(condition)}`);
  if (condition.value !== GUARD.targetCondition) throw new Error(`GUARD_BLOCKED: peer condition_type=${condition.value}`);
  if (condition.marketplaceId !== GUARD.marketplaceId) throw new Error(`GUARD_BLOCKED: peer marketplace_id=${condition.marketplaceId}`);
  if (issue8115Rows(listing).length !== 0) throw new Error("GUARD_BLOCKED: peer has issue 8115");
  return {
    status: Array.isArray(summary.status) ? summary.status : [],
    conditionType: condition,
    issueCount: issuesOf(listing).length,
  };
}
async function validationPreview(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const body = {
    productType: GUARD.productType,
    patches: [{
      op: "add",
      path: "/attributes/condition_type",
      value: [{
        value: GUARD.targetCondition,
        marketplace_id: marketplaceId,
      }],
    }],
  };
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
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
    validationPassed: response.ok && errors.length === 0 && issue8115.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}
async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    if (String(req.body?.sku || "").trim() !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");

    const accessToken = await getLwaAccessToken();
    const targetState = assertTarget(await getListing(accessToken, GUARD.sku));
    const peerState = assertPeer(await getListing(accessToken, GUARD.peerSku));
    const preview = await validationPreview(accessToken);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: GUARD.asin,
      productType: GUARD.productType,
      repairIntent: "ADD_CONDITION_TYPE_NEW_NEW_ONLY",
      evidence: {
        targetConditionBefore: null,
        targetIssue8115Count: 1,
        targetStatus: targetState.status,
        peerSku: GUARD.peerSku,
        peerConditionType: peerState.conditionType,
        peerIssueCount: peerState.issueCount,
        peerStatus: peerState.status,
      },
      preservedSnapshot: {
        offers: targetState.offers,
        fulfillmentAvailability: targetState.fulfillmentAvailability,
      },
      after: {
        conditionType: GUARD.targetCondition,
      },
      validationPassed: preview.validationPassed,
      preview,
      readOnly: true,
      externalChanges: 0,
      note: "VALIDATION_PREVIEW only. Patch adds condition_type=new_new and does not modify price, B2B, quantity, content, or images.",
    });
  } catch (err) {
    console.error("Amazon CF-SV7 8115 condition preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonCfSv78115ConditionPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
