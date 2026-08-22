import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-amazon-inventory-fresh-get-v1.1.0";
const ROUTE = "/amazon/stock/fresh-get";
const MAX_SKUS = 50;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const originalListen = express.application.listen;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  if (!response.ok || !json.access_token) {
    throw new Error(`LWA token error: ${response.status}`);
  }

  return json.access_token;
}

async function amazonGet(url, accessToken) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
        },
        signal: controller.signal,
      });

      const text = await response.text();
      const json = safeJsonParse(text);

      if (response.ok) return json;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error(`SP-API request error: ${response.status} ${JSON.stringify(json)}`);
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter * 1000)
        : RETRY_BASE_MS * attempt;
      await sleep(waitMs);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("SP-API GET failed");
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonGet(url, accessToken);
}

function normalizeIssueDetail(issue) {
  const attributeNames = Array.isArray(issue?.attributeNames)
    ? issue.attributeNames.map(value => String(value || "").trim()).filter(Boolean).slice(0, 20)
    : [];
  const categories = Array.isArray(issue?.categories)
    ? issue.categories.map(value => String(value || "").trim()).filter(Boolean).slice(0, 20)
    : [];
  const enforcements = Array.isArray(issue?.enforcements)
    ? issue.enforcements.slice(0, 20).map(value => ({
        action: String(value?.action || ""),
        exemption: value?.exemption && typeof value.exemption === "object" ? value.exemption : null,
      }))
    : [];

  return {
    code: String(issue?.code || ""),
    severity: String(issue?.severity || ""),
    message: String(issue?.message || ""),
    attributeNames,
    categories,
    enforcements,
  };
}

function analyzeListing(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability)
    ? listing.fulfillmentAvailability[0] || {}
    : {};

  const quantity = numberOrNull(availability?.quantity) ?? 0;
  const errorIssues = issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR");

  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    discoverable: statuses.includes("DISCOVERABLE"),
    availableQuantity: quantity,
    errorCount: errorIssues.length,
    issueCodes: errorIssues.map(row => String(row?.code || "")).filter(Boolean).slice(0, 10),
    issueDetails: errorIssues.map(normalizeIssueDetail).slice(0, 10),
  };
}

function normalizeSkus(body) {
  let source = [];

  if (Array.isArray(body?.skus)) {
    source = body.skus;
  } else if (Array.isArray(body?.items)) {
    source = body.items.map(item => item?.sku);
  }

  if (!source.length) throw new Error("skus must be a non-empty array");
  if (source.length > MAX_SKUS) throw new Error(`skus must be <= ${MAX_SKUS}`);

  const seen = new Set();
  const skus = [];

  source.forEach((value, index) => {
    const sku = String(value || "").trim();
    if (!sku) throw new Error(`skus[${index}] is required`);
    if (seen.has(sku)) return;
    seen.add(sku);
    skus.push(sku);
  });

  return skus;
}

async function handler(req, res) {
  const fetchedAt = new Date().toISOString();

  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        externalChanges: 0,
        error: "AMAZON_STOCK_API_SECRET is not set",
      });
    }

    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        externalChanges: 0,
        error: "Unauthorized",
      });
    }

    const skus = normalizeSkus(req.body);
    const accessToken = await getLwaAccessToken();
    const results = [];

    for (let i = 0; i < skus.length; i += 1) {
      const sku = skus[i];

      try {
        const listing = await getListing(accessToken, sku);
        results.push({
          ok: true,
          sku,
          fetchedAt,
          ...analyzeListing(listing),
        });
      } catch (err) {
        results.push({
          ok: false,
          sku,
          fetchedAt,
          error: err?.message || String(err),
        });
      }

      if (i < skus.length - 1) await sleep(250);
    }

    const succeeded = results.filter(row => row.ok).length;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      fetchedAt,
      requested: skus.length,
      succeeded,
      failed: skus.length - succeeded,
      externalChanges: 0,
      results,
    });
  } catch (err) {
    console.error("Amazon inventory fresh GET error", err?.message || String(err));

    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      fetchedAt,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonInventoryFreshGetListen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)
  );

  if (!alreadyRegistered) {
    this.post(ROUTE, handler);
  }

  return originalListen.apply(this, args);
};
