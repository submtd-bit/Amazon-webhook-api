import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-qs99300-image-preview-v1.0.0";
const ROUTE = "/amazon/listing/qs99300-image-repair-preview";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "QS-PTMS-QOU0",
  asin: "B0D4LDW2TF",
  productType: "NOTEBOOK_COMPUTER",
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
    throw new Error(`GUARD_BLOCKED: ${attributeName} must contain exactly one value`);
  }
  const actual = String(values[0]?.media_location || "").trim();
  if (actual !== expectedUrl) {
    throw new Error(`GUARD_BLOCKED: ${attributeName} URL mismatch ${actual}`);
  }
  return values;
}

function assertCurrentState(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  if (String(summary?.asin || "") !== GUARD.asin) throw new Error("GUARD_BLOCKED: ASIN mismatch");
  if (String(summary?.productType || "") !== GUARD.productType) throw new Error("GUARD_BLOCKED: productType mismatch");

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const bullets = attributes.bullet_point;
  if (!Array.isArray(bullets) || bullets.length !== 1) {
    throw new Error("GUARD_BLOCKED: bullet_point must contain exactly one value");
  }
  if (String(bullets[0]?.value || "") !== GUARD.bulletValue) {
    throw new Error(`GUARD_BLOCKED: bullet text mismatch ${String(bullets[0]?.value || "")}`);
  }

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const hasPt02 = issues.some(issue => String(issue?.code || "") === "100238" && /PT\s*0*2/i.test(String(issue?.message || "")));
  const hasPt07 = issues.some(issue => String(issue?.code || "") === "100238" && /PT\s*0*7/i.test(String(issue?.message || "")));
  if (!hasPt02 || !hasPt07) throw new Error("GUARD_BLOCKED: current PT02/PT07 image issues not both present");

  const pt02Value = assertSingleMedia(attributes[GUARD.pt02Attribute], GUARD.pt02Media, GUARD.pt02Attribute);
  const pt07Value = assertSingleMedia(attributes[GUARD.pt07Attribute], GUARD.pt07Media, GUARD.pt07Attribute);

  return { summary, bulletValue: bullets, pt02Value, pt07Value };
}

async function runPreview(accessToken, sku, state) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });

  const body = {
    productType: GUARD.productType,
    patches: [
      { op: "delete", path: "/attributes/bullet_point", value: state.bulletValue },
      { op: "delete", path: `/attributes/${GUARD.pt02Attribute}`, value: state.pt02Value },
      { op: "delete", path: `/attributes/${GUARD.pt07Attribute}`, value: state.pt07Value },
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
    validationPassed: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
    raw: json,
    body,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    if (sku !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");
    if (req.body?.dryRun === false) throw new Error("LIVE is intentionally disabled on this route");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const state = assertCurrentState(listing);
    const preview = await runPreview(accessToken, sku, state);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: GUARD.asin,
      productType: GUARD.productType,
      dryRun: true,
      plannedDeletes: [
        { attributeName: "bullet_point", value: state.bulletValue },
        { attributeName: GUARD.pt02Attribute, value: state.pt02Value },
        { attributeName: GUARD.pt07Attribute, value: state.pt07Value },
      ],
      validationPassed: preview.validationPassed,
      preview: {
        httpStatus: preview.httpStatus,
        responseOk: preview.responseOk,
        status: preview.status,
        submissionId: preview.submissionId,
        errorCount: preview.errorCount,
        issues: preview.issues,
      },
      externalChanges: 0,
      note: "VALIDATION_PREVIEW only. No listing mutation was persisted.",
    });
  } catch (err) {
    console.error("Amazon QS combined preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonQs99300ImagePreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
