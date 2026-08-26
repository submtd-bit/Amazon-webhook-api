import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-qs99300-image-live-v1.0.0";
const ROUTE = "/amazon/listing/qs99300-image-repair-live";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;
let liveSentThisProcess = false;

const LIVE_GUARD = Object.freeze({
  sku: "QS-PTMS-QOU0",
  asin: "B0D4LDW2TF",
  productType: "NOTEBOOK_COMPUTER",
  priorPreviewSubmissionId: "cc53b90b752849a0b732a0c0927f9833",
  confirmToken: "CONFIRM_QS_99300_PT02_PT07_DELETE_20260826",
  bulletValue: "【長期保証】レビュー記載で180日間の保証がございます。",
  pt02Attribute: "other_product_image_locator_1",
  pt02Media: "https://m.media-amazon.com/images/I/71LqguEit+L.jpg",
  pt07Attribute: "other_product_image_locator_6",
  pt07Media: "https://m.media-amazon.com/images/I/61dORdcMeJL.jpg",
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

function assertSingleMedia(values, expectedUrl, attributeName) {
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error(`LIVE_GUARD_BLOCKED: ${attributeName} must contain exactly one value`);
  }
  const actual = String(values[0]?.media_location || "").trim();
  if (actual !== expectedUrl) {
    throw new Error(`LIVE_GUARD_BLOCKED: ${attributeName} URL mismatch ${actual}`);
  }
  return values;
}

function assertCurrentState(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  if (String(summary?.asin || "") !== LIVE_GUARD.asin) throw new Error("LIVE_GUARD_BLOCKED: ASIN mismatch");
  if (String(summary?.productType || "") !== LIVE_GUARD.productType) throw new Error("LIVE_GUARD_BLOCKED: productType mismatch");

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const bullets = attributes.bullet_point;
  if (!Array.isArray(bullets) || bullets.length !== 1) {
    throw new Error("LIVE_GUARD_BLOCKED: bullet_point must contain exactly one value");
  }
  if (String(bullets[0]?.value || "") !== LIVE_GUARD.bulletValue) {
    throw new Error(`LIVE_GUARD_BLOCKED: bullet text mismatch ${String(bullets[0]?.value || "")}`);
  }

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const hasPt02 = issues.some(issue => String(issue?.code || "") === "100238" && String(issue?.severity || "").toUpperCase() === "ERROR" && /PT\s*0*2/i.test(String(issue?.message || "")));
  const hasPt07 = issues.some(issue => String(issue?.code || "") === "100238" && String(issue?.severity || "").toUpperCase() === "ERROR" && /PT\s*0*7/i.test(String(issue?.message || "")));
  if (!hasPt02 || !hasPt07) throw new Error("LIVE_GUARD_BLOCKED: current PT02/PT07 image issues not both present");

  const pt02Value = assertSingleMedia(attributes[LIVE_GUARD.pt02Attribute], LIVE_GUARD.pt02Media, LIVE_GUARD.pt02Attribute);
  const pt07Value = assertSingleMedia(attributes[LIVE_GUARD.pt07Attribute], LIVE_GUARD.pt07Media, LIVE_GUARD.pt07Attribute);
  return { bulletValue: bullets, pt02Value, pt07Value };
}

async function patchRepair(accessToken, sku, state, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
  if (validationPreview) query.set("mode", "VALIDATION_PREVIEW");

  const body = {
    productType: LIVE_GUARD.productType,
    patches: [
      { op: "delete", path: "/attributes/bullet_point", value: state.bulletValue },
      { op: "delete", path: `/attributes/${LIVE_GUARD.pt02Attribute}`, value: state.pt02Value },
      { op: "delete", path: `/attributes/${LIVE_GUARD.pt07Attribute}`, value: state.pt07Value },
    ],
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
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issues,
    errorCount: errors.length,
    valid: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
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
    if (liveSentThisProcess) throw new Error("LIVE_GUARD_BLOCKED: live request already sent during this process; do not resend");

    const sku = String(req.body?.sku || "").trim();
    const confirmToken = String(req.body?.confirmToken || "").trim();
    const priorPreviewSubmissionId = String(req.body?.priorPreviewSubmissionId || "").trim();
    if (sku !== LIVE_GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (confirmToken !== LIVE_GUARD.confirmToken) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");
    if (priorPreviewSubmissionId !== LIVE_GUARD.priorPreviewSubmissionId) throw new Error("LIVE_GUARD_BLOCKED: prior preview submission ID mismatch");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const state = assertCurrentState(listing);

    const preview = await patchRepair(accessToken, sku, state, true);
    if (!preview.valid) {
      throw new Error(`LIVE_GUARD_BLOCKED: fresh validation preview failed ${JSON.stringify(preview.raw)}`);
    }

    const live = await patchRepair(accessToken, sku, state, false);
    externalChanges = 1;
    liveSentThisProcess = true;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: LIVE_GUARD.asin,
      productType: LIVE_GUARD.productType,
      preflightValidationPassed: true,
      priorPreviewSubmissionId,
      preview: {
        httpStatus: preview.httpStatus,
        responseOk: preview.responseOk,
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
      note: "One guarded combined live repair was sent. Do not resend solely because Fresh GET propagation is delayed.",
    });
  } catch (err) {
    console.error("Amazon QS combined live repair error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonQs99300ImageLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
