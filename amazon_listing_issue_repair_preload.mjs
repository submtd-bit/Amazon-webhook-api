import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-amazon-listing-issue-repair-v1.0.0";
const ROUTE = "/amazon/listing/issue-repair";
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
  if (!response.ok || !json.access_token) {
    throw new Error(`LWA token error: ${response.status}`);
  }
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
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
    },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function getCurrentError(listing, code, attributeName) {
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  return issues.find(issue => {
    const severity = String(issue?.severity || "").toUpperCase();
    const issueCode = String(issue?.code || "");
    const attrs = Array.isArray(issue?.attributeNames) ? issue.attributeNames.map(String) : [];
    return severity === "ERROR" && issueCode === code && attrs.includes(attributeName);
  }) || null;
}

function cloneAttributeWithReplacement(currentValues, replacementValue) {
  if (!Array.isArray(currentValues) || currentValues.length === 0) {
    throw new Error("title_differentiation current attribute is missing");
  }
  return currentValues.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`title_differentiation[${index}] has unexpected structure`);
    }
    const copy = { ...entry };
    if (Object.prototype.hasOwnProperty.call(copy, "value")) {
      copy.value = replacementValue;
      return copy;
    }
    const stringKeys = Object.keys(copy).filter(key => typeof copy[key] === "string" && key !== "marketplace_id" && key !== "language_tag");
    if (stringKeys.length === 1) {
      copy[stringKeys[0]] = replacementValue;
      return copy;
    }
    throw new Error(`title_differentiation[${index}] has no replaceable value field`);
  });
}

async function patchTitleDifferentiation(accessToken, sku, productType, value, dryRun) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  if (dryRun) query.set("mode", "VALIDATION_PREVIEW");

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      productType,
      patches: [{
        op: "replace",
        path: "/attributes/title_differentiation",
        value,
      }],
    }),
  });

  const json = safeJsonParse(await response.text());
  if (!response.ok) {
    throw new Error(`SP-API PATCH error: ${response.status} ${JSON.stringify(json)}`);
  }
  return { httpStatus: response.status, json };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const issueCode = String(req.body?.issueCode || "").trim();
    const attributeName = String(req.body?.attributeName || "").trim();
    const replacementValue = String(req.body?.replacementValue || "").trim();
    const dryRun = req.body?.dryRun !== false;

    if (!sku) throw new Error("sku is required");
    if (issueCode !== "90225") throw new Error("Only issueCode 90225 is supported by this guarded route");
    if (attributeName !== "title_differentiation") throw new Error("Only title_differentiation is supported by this guarded route");
    if (!replacementValue) throw new Error("replacementValue is required");
    if ([...replacementValue].length > 125) throw new Error("replacementValue must be <= 125 characters");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const issue = getCurrentError(listing, issueCode, attributeName);
    if (!issue) throw new Error("Target 90225 title_differentiation ERROR is not currently present");

    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    const productType = String(summary?.productType || "").trim();
    if (!productType) throw new Error("Listing productType could not be resolved");

    const currentValues = listing?.attributes?.title_differentiation;
    const patchedValues = cloneAttributeWithReplacement(currentValues, replacementValue);
    const patch = await patchTitleDifferentiation(accessToken, sku, productType, patchedValues, dryRun);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      issueCode,
      attributeName,
      dryRun,
      productType,
      replacementValue,
      replacementLength: [...replacementValue].length,
      currentValue: Array.isArray(currentValues) && currentValues[0] && typeof currentValues[0] === "object"
        ? String(currentValues[0].value || "")
        : "",
      currentLength: Array.isArray(currentValues) && currentValues[0] && typeof currentValues[0] === "object"
        ? [...String(currentValues[0].value || "")].length
        : null,
      patchResponse: patch.json,
      externalChanges: dryRun ? 0 : 1,
    });
  } catch (err) {
    console.error("Amazon listing issue repair error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonListingIssueRepairListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
