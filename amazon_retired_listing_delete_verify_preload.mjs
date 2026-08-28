import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-28-amazon-retired-listing-delete-verify-v1.0.0";
const ROUTE = "/amazon/listing/retired-delete-verify";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 500;
const originalListen = express.application.listen;

const TARGETS = Object.freeze([
  { sku: "x13g1-i5-10210u-8gb-ssd1", asin: "B0GHY9J1NF" },
  { sku: "KL-GLTE-GU7A", asin: "B0D4LDW2TF" },
  { sku: "LM-QO9K-G631", asin: "B0D4LDW2TF" },
  { sku: "QS-PTMS-QOU0", asin: "B0D4LDW2TF" },
  { sku: "V3-ARPY-J6AB", asin: "B0D4LDW2TF" },
]);

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
    includedData: "summaries,issues,fulfillmentAvailability",
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
  return {
    sku: String(body?.sku || ""),
    asin: String(summary?.asin || ""),
    title: String(summary?.itemName || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    deleted: statuses.includes("DELETED"),
    issueCount: Array.isArray(body?.issues) ? body.issues.length : 0,
  };
}

async function inspect(accessToken, target) {
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

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });

    const accessToken = await getLwaAccessToken();
    const results = [];
    for (let i = 0; i < TARGETS.length; i += 1) {
      results.push(await inspect(accessToken, TARGETS[i]));
      if (i < TARGETS.length - 1) await sleep(REQUEST_GAP_MS);
    }

    const verifiedDeletedCount = results.filter(x => x.verifiedDeleted).length;
    const stillPresentCount = results.filter(x => x.state === "STILL_PRESENT").length;
    const errorCount = results.filter(x => x.state === "GET_ERROR").length;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: MARKETPLACE_ID,
      targetCount: TARGETS.length,
      verifiedDeletedCount,
      stillPresentCount,
      errorCount,
      allVerifiedDeleted: verifiedDeletedCount === TARGETS.length,
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

express.application.listen = function amazonRetiredListingDeleteVerifyListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
