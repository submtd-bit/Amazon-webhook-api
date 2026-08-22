import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-amazon-listing-issue-inspect-v1.0.0";
const ROUTE = "/amazon/listing/issue-inspect";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

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
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
    },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function charLength(value) {
  if (value === null || value === undefined) return null;
  return [...String(value)].length;
}

function summarizeAttribute(values) {
  if (!Array.isArray(values)) {
    return { present: false, count: 0, values: [], lengths: [] };
  }
  const extracted = values.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { raw: entry };
    const value = Object.prototype.hasOwnProperty.call(entry, "value") ? entry.value : null;
    return {
      value,
      length: value === null || value === undefined ? null : charLength(value),
      marketplace_id: entry.marketplace_id || "",
      language_tag: entry.language_tag || "",
      raw: entry,
    };
  });
  return {
    present: values.length > 0,
    count: values.length,
    values: extracted,
    lengths: extracted.map(x => x.length),
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
    if (!sku) throw new Error("sku is required");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const summaries = Array.isArray(listing?.summaries) ? listing.summaries : [];
    const summary = summaries[0] || {};
    const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
    const issues = Array.isArray(listing?.issues) ? listing.issues : [];
    const errorIssues = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
    const attributeKeys = Object.keys(attributes).sort();

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin || "",
      productType: summary.productType || "",
      status: Array.isArray(summary.status) ? summary.status : [],
      itemNameSummary: summary.itemName || "",
      itemNameSummaryLength: summary.itemName ? charLength(summary.itemName) : null,
      createdDate: summary.createdDate || listing.createdDate || "",
      lastUpdatedDate: summary.lastUpdatedDate || listing.lastUpdatedDate || "",
      itemNameAttribute: summarizeAttribute(attributes.item_name),
      titleDifferentiationAttribute: summarizeAttribute(attributes.title_differentiation),
      relevantAttributeKeys: attributeKeys.filter(key => /title|name|differentiation/i.test(key)),
      attributeKeyCount: attributeKeys.length,
      issueCount: issues.length,
      errorCount: errorIssues.length,
      issues,
      offers: Array.isArray(listing?.offers) ? listing.offers : [],
      fulfillmentAvailability: Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [],
      externalChanges: 0,
    });
  } catch (err) {
    console.error("Amazon listing issue inspect error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonListingIssueInspectListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
