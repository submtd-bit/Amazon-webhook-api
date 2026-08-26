import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-image-suppression-live-v1.0.0";
const ROUTE = "/amazon/listing/image-suppression-repair-live";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const LIVE_GUARD = Object.freeze({
  sku: "x13g1-i5-10210u-8gb-ssd512",
  asin: "B0GHY4ZS4K",
  issueCode: "100238",
  pt: 6,
  attributeName: "other_product_image_locator_5",
  mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg",
  confirmToken: "CONFIRM_X13_PT06_DELETE_20260826",
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

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
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  }
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

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues",
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

function resolveGuardedDelete(listing) {
  const summaries = Array.isArray(listing?.summaries) ? listing.summaries : [];
  const summary = summaries[0] || {};
  const asin = String(summary?.asin || "").trim();
  const productType = String(summary?.productType || "").trim();
  if (asin !== LIVE_GUARD.asin) throw new Error(`LIVE_GUARD_BLOCKED: ASIN mismatch ${asin}`);
  if (!productType) throw new Error("LIVE_GUARD_BLOCKED: productType missing");

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const issue = issues.find(item => {
    const code = String(item?.code || "");
    const severity = String(item?.severity || "").toUpperCase();
    const message = String(item?.message || "");
    return code === LIVE_GUARD.issueCode && severity === "ERROR" && /PT\s*0*6/i.test(message);
  });
  if (!issue) throw new Error("LIVE_GUARD_BLOCKED: current PT06 issue 100238 ERROR not found");

  const values = listing?.attributes?.[LIVE_GUARD.attributeName];
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error("LIVE_GUARD_BLOCKED: target attribute must contain exactly one value");
  }
  const media = String(values[0]?.media_location || "").trim();
  if (media !== LIVE_GUARD.mediaLocation) {
    throw new Error(`LIVE_GUARD_BLOCKED: media URL mismatch ${media}`);
  }

  return {
    productType,
    value: values,
    issueMessage: String(issue?.message || ""),
  };
}

async function patchDelete(accessToken, sku, productType, value, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
  if (validationPreview) query.set("mode", "VALIDATION_PREVIEW");

  const body = {
    productType,
    patches: [{
      op: "delete",
      path: `/attributes/${LIVE_GUARD.attributeName}`,
      value,
    }],
  };

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
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
  const errorIssues = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issues,
    errorCount: errorIssues.length,
    valid: response.ok && errorIssues.length === 0 && (status === "VALID" || status === "ACCEPTED"),
    raw: json,
  };
}

async function handler(req, res) {
  let externalChanges = 0;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const confirmToken = String(req.body?.confirmToken || "").trim();
    if (sku !== LIVE_GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (confirmToken !== LIVE_GUARD.confirmToken) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const target = resolveGuardedDelete(listing);

    const preview = await patchDelete(accessToken, sku, target.productType, target.value, true);
    if (!preview.valid) {
      throw new Error(`LIVE_GUARD_BLOCKED: fresh validation preview failed ${JSON.stringify(preview.raw)}`);
    }

    const live = await patchDelete(accessToken, sku, target.productType, target.value, false);
    externalChanges = 1;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: LIVE_GUARD.asin,
      issueCode: LIVE_GUARD.issueCode,
      pt: LIVE_GUARD.pt,
      attributeName: LIVE_GUARD.attributeName,
      mediaLocation: LIVE_GUARD.mediaLocation,
      preflightValidationPassed: true,
      preview: {
        httpStatus: preview.httpStatus,
        status: preview.status,
        submissionId: preview.submissionId,
        errorCount: preview.errorCount,
        issues: preview.issues,
      },
      live: {
        httpStatus: live.httpStatus,
        responseOk: live.responseOk,
        status: live.status,
        submissionId: live.submissionId,
        errorCount: live.errorCount,
        issues: live.issues,
        accepted: Boolean(live.responseOk && live.valid),
      },
      externalChanges,
      note: "One guarded live delete was sent. Do not resend solely because issue/status propagation is delayed.",
    });
  } catch (err) {
    console.error("Amazon image suppression live repair error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonImageSuppressionLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
