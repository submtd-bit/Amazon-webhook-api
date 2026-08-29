import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-29-amazon-y3-main-image-adopted-preview-v1.0.0";
const ROUTE = "/amazon/listing/y3-main-image-adopted-preview";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "Y3-30YC-UORU",
  asin: "B0HGDZNVQN",
  productType: "NOTEBOOK_COMPUTER",
  issueCode: "18320",
  attributeName: "main_product_image_locator",
  imageUrl: "https://amazon-webhook-api.onrender.com/assets/y3-main.jpg",
  titleTokens: ["Latitude", "5330"],
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
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`GUARD_BLOCKED: marketplace mismatch ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const response = await fetchWithTimeout("https://api.amazon.com/auth/o2/token", {
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

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`GUARD_BLOCKED: listing GET failed HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function inspectListing(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attrs = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const fulfillment = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [];
  const statuses = Array.isArray(summary?.status) ? summary.status.map(x => String(x || "")).filter(Boolean) : [];
  const quantity = fulfillment.reduce((sum, row) => {
    const n = Number(row?.quantity);
    return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
  }, 0);
  const snap = {
    sku: String(listing?.sku || ""),
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    title: String(summary?.itemName || ""),
    statuses,
    availableQuantity: quantity,
    mainImagePresent: Array.isArray(attrs[GUARD.attributeName]) && attrs[GUARD.attributeName].length > 0,
    issue18320Count: issues.filter(x => String(x?.code || "") === GUARD.issueCode).length,
    issueCodes: issues.map(x => String(x?.code || "")).filter(Boolean),
  };
  if (snap.sku !== GUARD.sku) throw new Error(`GUARD_BLOCKED: SKU mismatch ${snap.sku}`);
  if (snap.asin !== GUARD.asin) throw new Error(`GUARD_BLOCKED: ASIN mismatch ${snap.asin}`);
  if (snap.productType !== GUARD.productType) throw new Error(`GUARD_BLOCKED: productType mismatch ${snap.productType}`);
  if (snap.mainImagePresent) throw new Error("GUARD_BLOCKED: main_product_image_locator already exists");
  if (snap.issue18320Count !== 1) throw new Error(`GUARD_BLOCKED: expected exactly one 18320 issue, got ${snap.issue18320Count}`);
  for (const token of GUARD.titleTokens) {
    if (!snap.title.toUpperCase().includes(token.toUpperCase())) throw new Error(`GUARD_BLOCKED: title token missing ${token}`);
  }
  return snap;
}

async function inspectAsset() {
  const response = await fetchWithTimeout(GUARD.imageUrl, { method: "GET", headers: { accept: "image/jpeg" } });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok) throw new Error(`GUARD_BLOCKED: image asset HTTP ${response.status}`);
  if (!contentType.includes("image/jpeg")) throw new Error(`GUARD_BLOCKED: image content-type ${contentType}`);
  if (bytes.length < 10000) throw new Error(`GUARD_BLOCKED: image asset unexpectedly small ${bytes.length}`);
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) throw new Error("GUARD_BLOCKED: image asset is not JPEG");
  return { httpStatus: response.status, contentType, byteLength: bytes.length, url: GUARD.imageUrl };
}

async function runPreview(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const patch = {
    op: "add",
    path: `/attributes/${GUARD.attributeName}`,
    value: [{ media_location: GUARD.imageUrl, marketplace_id: marketplaceId }],
  };
  const body = { productType: GUARD.productType, patches: [patch] };
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
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    issueCount: issues.length,
    errorCount: errors.length,
    issues,
    validationPassed: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
    plannedPatch: patch,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    if (req.body?.dryRun === false) throw new Error("LIVE is intentionally disabled on this route");

    const accessToken = await getLwaAccessToken();
    const listingPreflight = inspectListing(await getListing(accessToken));
    const imageAsset = await inspectAsset();
    const preview = await runPreview(accessToken);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: GUARD.asin,
      productType: GUARD.productType,
      listingPreflight,
      imageAsset,
      preview,
      readyForLive: preview.validationPassed,
      readOnly: true,
      externalChanges: 0,
      note: "Adopted image asset + Listings VALIDATION_PREVIEW only. No listing mutation persisted.",
    });
  } catch (err) {
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

express.application.listen = function amazonY3MainImageAdoptedPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
