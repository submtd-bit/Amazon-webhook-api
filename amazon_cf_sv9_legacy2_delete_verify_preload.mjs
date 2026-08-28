import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-28-amazon-cf-sv9-legacy2-delete-verify-v1.0.0";
const ROUTE = "/amazon/listing/cf-sv9-legacy2-delete-verify";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 600;
const originalListen = express.application.listen;

const TARGETS = Object.freeze([
  Object.freeze({ sku: "26-U7P4-5C6U", asin: "B0F1SDLKN8" }),
  Object.freeze({ sku: "CO-SU33-PSCB", asin: "B0F1SDLKN8" }),
]);

const HEALTHY = Object.freeze({
  sku: "cf-sv9-i5-8gb-ssd256",
  asin: "B0GH6ZT2X2",
  productType: "NOTEBOOK_COMPUTER",
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

function getConfig() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`marketplace mismatch: ${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
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

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getListingRaw(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "summaries,issues,offers,fulfillmentAvailability",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
    },
  });
  const text = await response.text();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    body: safeJsonParse(text),
  };
}

function snapshot(result) {
  const body = result?.body || {};
  const summary = Array.isArray(body?.summaries) ? body.summaries[0] || {} : {};
  const statuses = Array.isArray(summary?.status)
    ? summary.status.map(x => String(x || "").trim()).filter(Boolean)
    : [];
  const fulfillment = Array.isArray(body?.fulfillmentAvailability) ? body.fulfillmentAvailability : [];
  const availableQuantity = fulfillment.reduce((sum, row) => {
    const n = Number(row?.quantity);
    return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
  }, 0);
  return {
    sku: String(body?.sku || ""),
    asin: String(summary?.asin || ""),
    title: String(summary?.itemName || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    discoverable: statuses.includes("DISCOVERABLE"),
    deleted: statuses.includes("DELETED"),
    availableQuantity,
    issueCount: Array.isArray(body?.issues) ? body.issues.length : 0,
  };
}

async function inspectRetired(accessToken, target) {
  const result = await getListingRaw(accessToken, target.sku);
  if (result.httpStatus === 404) {
    return {
      sku: target.sku,
      expectedAsin: target.asin,
      httpStatus: 404,
      verifiedDeleted: true,
      state: "NOT_FOUND",
    };
  }
  if (!result.responseOk) {
    return {
      sku: target.sku,
      expectedAsin: target.asin,
      httpStatus: result.httpStatus,
      verifiedDeleted: false,
      state: "GET_ERROR",
      raw: result.body,
    };
  }
  const snap = snapshot(result);
  const asinMatches = snap.asin === target.asin;
  const verifiedDeleted = asinMatches && snap.deleted;
  return {
    sku: target.sku,
    expectedAsin: target.asin,
    httpStatus: result.httpStatus,
    asinMatches,
    verifiedDeleted,
    state: verifiedDeleted ? "DELETED" : "STILL_PRESENT",
    snapshot: snap,
  };
}

async function inspectHealthy(accessToken) {
  const result = await getListingRaw(accessToken, HEALTHY.sku);
  if (!result.responseOk) {
    return {
      sku: HEALTHY.sku,
      expectedAsin: HEALTHY.asin,
      httpStatus: result.httpStatus,
      healthy: false,
      state: "GET_ERROR",
      raw: result.body,
    };
  }
  const snap = snapshot(result);
  const healthy =
    snap.asin === HEALTHY.asin &&
    snap.productType === HEALTHY.productType &&
    snap.buyable &&
    !snap.deleted;
  return {
    sku: HEALTHY.sku,
    expectedAsin: HEALTHY.asin,
    httpStatus: result.httpStatus,
    healthy,
    state: healthy ? "BUYABLE_HEALTHY" : "HEALTHY_GUARD_FAILED",
    snapshot: snap,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    }

    const accessToken = await getLwaAccessToken();
    const results = [];
    for (let i = 0; i < TARGETS.length; i += 1) {
      results.push(await inspectRetired(accessToken, TARGETS[i]));
      if (i < TARGETS.length - 1) await sleep(REQUEST_GAP_MS);
    }
    await sleep(REQUEST_GAP_MS);
    const healthyListing = await inspectHealthy(accessToken);

    const verifiedDeletedCount = results.filter(x => x.verifiedDeleted).length;
    const stillPresentCount = results.filter(x => x.state === "STILL_PRESENT").length;
    const errorCount = results.filter(x => x.state === "GET_ERROR").length;
    const allVerifiedDeleted = verifiedDeletedCount === TARGETS.length;
    const finalClosed = allVerifiedDeleted && healthyListing.healthy;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: MARKETPLACE_ID,
      targetCount: TARGETS.length,
      verifiedDeletedCount,
      stillPresentCount,
      errorCount,
      allVerifiedDeleted,
      healthyListing,
      finalClosed,
      readOnly: true,
      externalChanges: 0,
      results,
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

express.application.listen = function amazonCfSv9Legacy2DeleteVerifyListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
