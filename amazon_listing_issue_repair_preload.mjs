import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-amazon-listing-issue-repair-v1.1.0";
const ROUTE = "/amazon/listing/issue-repair";
const REQUEST_TIMEOUT_MS = 20000;
const PREVIEW_RETRY_GAP_MS = 1100;
const originalListen = express.application.listen;

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
  if (!Array.isArray(currentValues) || currentValues.length === 0) return null;

  return currentValues.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`title_differentiation[${index}] has unexpected structure`);
    }
    const copy = { ...entry };
    if (Object.prototype.hasOwnProperty.call(copy, "value")) {
      copy.value = replacementValue;
      return copy;
    }
    const stringKeys = Object.keys(copy).filter(
      key => typeof copy[key] === "string" && key !== "marketplace_id" && key !== "language_tag"
    );
    if (stringKeys.length === 1) {
      copy[stringKeys[0]] = replacementValue;
      return copy;
    }
    throw new Error(`title_differentiation[${index}] has no replaceable value field`);
  });
}

function buildPreviewCandidates(currentValues, replacementValue, marketplaceId) {
  const candidates = [];
  const cloned = cloneAttributeWithReplacement(currentValues, replacementValue);
  if (cloned) {
    candidates.push({ strategy: "clone_current", op: "replace", value: cloned });
  }

  // GET Listings Items can report an issue for an attribute without returning that
  // attribute in the seller contribution. In that case, VALIDATION_PREVIEW is used
  // to safely discover the accepted top-level attribute shape without persisting data.
  candidates.push(
    {
      strategy: "add_value_marketplace_language",
      op: "add",
      value: [{ value: replacementValue, marketplace_id: marketplaceId, language_tag: "ja_JP" }],
    },
    {
      strategy: "add_value_marketplace",
      op: "add",
      value: [{ value: replacementValue, marketplace_id: marketplaceId }],
    },
    {
      strategy: "add_value_language",
      op: "add",
      value: [{ value: replacementValue, language_tag: "ja_JP" }],
    },
    {
      strategy: "add_value_only",
      op: "add",
      value: [{ value: replacementValue }],
    },
  );

  const seen = new Set();
  return candidates.filter(candidate => {
    const key = JSON.stringify({ op: candidate.op, value: candidate.value });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizePatchResponse(json) {
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errorIssues = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    status,
    issues,
    errorCount: errorIssues.length,
    valid: errorIssues.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}

async function patchTitleDifferentiation(accessToken, sku, productType, candidate, dryRun) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
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
        op: candidate.op,
        path: "/attributes/title_differentiation",
        value: candidate.value,
      }],
    }),
  });

  const json = safeJsonParse(await response.text());
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    json,
    ...summarizePatchResponse(json),
  };
}

async function runValidationPreview(accessToken, sku, productType, currentValues, replacementValue) {
  const { marketplaceId } = getConfig();
  const candidates = buildPreviewCandidates(currentValues, replacementValue, marketplaceId);
  const attempts = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const result = await patchTitleDifferentiation(accessToken, sku, productType, candidate, true);
    attempts.push({
      strategy: candidate.strategy,
      op: candidate.op,
      value: candidate.value,
      httpStatus: result.httpStatus,
      responseOk: result.responseOk,
      status: result.status,
      errorCount: result.errorCount,
      issues: result.issues,
    });

    if (result.responseOk && result.valid) {
      return { selected: candidate, patchResult: result, attempts };
    }

    if (i < candidates.length - 1) await sleep(PREVIEW_RETRY_GAP_MS);
  }

  return {
    selected: null,
    patchResult: attempts.length ? { json: { status: attempts[attempts.length - 1].status, issues: attempts[attempts.length - 1].issues } } : { json: {} },
    attempts,
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
    const currentAttributePresent = Array.isArray(currentValues) && currentValues.length > 0;
    const currentValue = currentAttributePresent && currentValues[0] && typeof currentValues[0] === "object"
      ? String(currentValues[0].value || "")
      : "";
    const currentLength = currentAttributePresent ? [...currentValue].length : null;

    if (!dryRun) {
      throw new Error("LIVE_REPAIR_BLOCKED: v1.1.0 requires a successful VALIDATION_PREVIEW before live repair is enabled");
    }

    const preview = await runValidationPreview(
      accessToken,
      sku,
      productType,
      currentValues,
      replacementValue,
    );

    const selected = preview.selected;
    const patchResponse = preview.patchResult?.json || {};

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      issueCode,
      attributeName,
      dryRun: true,
      productType,
      currentAttributePresent,
      currentValue,
      currentLength,
      replacementValue,
      replacementLength: [...replacementValue].length,
      validationPassed: Boolean(selected),
      selectedStrategy: selected ? selected.strategy : "",
      selectedOp: selected ? selected.op : "",
      selectedValue: selected ? selected.value : null,
      attempts: preview.attempts,
      patchResponse,
      externalChanges: 0,
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
