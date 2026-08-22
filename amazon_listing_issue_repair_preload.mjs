import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-amazon-listing-issue-repair-v1.2.0";
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

function extractFirstValue(values) {
  if (!Array.isArray(values) || !values.length || !values[0] || typeof values[0] !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(values[0], "value")) return String(values[0].value || "");
  const keys = Object.keys(values[0]).filter(
    key => typeof values[0][key] === "string" && key !== "marketplace_id" && key !== "language_tag"
  );
  return keys.length === 1 ? String(values[0][keys[0]] || "") : "";
}

function cloneAttributeWithReplacement(currentValues, replacementValue, attributeName) {
  if (!Array.isArray(currentValues) || currentValues.length === 0) return null;

  return currentValues.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${attributeName}[${index}] has unexpected structure`);
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
    throw new Error(`${attributeName}[${index}] has no replaceable value field`);
  });
}

function buildAttributeCandidates(attributeName, currentValues, replacementValue, marketplaceId) {
  const cloned = cloneAttributeWithReplacement(currentValues, replacementValue, attributeName);
  if (cloned) {
    return [{ strategy: `${attributeName}_clone_current`, op: "replace", value: cloned }];
  }

  return [
    {
      strategy: `${attributeName}_add_value_marketplace_language`,
      op: "add",
      value: [{ value: replacementValue, marketplace_id: marketplaceId, language_tag: "ja_JP" }],
    },
    {
      strategy: `${attributeName}_add_value_marketplace`,
      op: "add",
      value: [{ value: replacementValue, marketplace_id: marketplaceId }],
    },
    {
      strategy: `${attributeName}_add_value_language`,
      op: "add",
      value: [{ value: replacementValue, language_tag: "ja_JP" }],
    },
    {
      strategy: `${attributeName}_add_value_only`,
      op: "add",
      value: [{ value: replacementValue }],
    },
  ];
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

async function patchListingPreview(accessToken, sku, productType, titleCandidate, highlightCandidate) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });

  const patches = [];
  if (titleCandidate) {
    patches.push({
      op: titleCandidate.op,
      path: "/attributes/item_name",
      value: titleCandidate.value,
    });
  }
  patches.push({
    op: highlightCandidate.op,
    path: "/attributes/title_differentiation",
    value: highlightCandidate.value,
  });

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ productType, patches }),
  });

  const json = safeJsonParse(await response.text());
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    json,
    ...summarizePatchResponse(json),
  };
}

async function runValidationPreview(accessToken, sku, productType, listing, replacementTitle, replacementHighlight) {
  const { marketplaceId } = getConfig();
  const currentTitleValues = listing?.attributes?.item_name;
  const currentHighlightValues = listing?.attributes?.title_differentiation;
  const titleCandidates = buildAttributeCandidates("item_name", currentTitleValues, replacementTitle, marketplaceId);
  const highlightCandidates = buildAttributeCandidates("title_differentiation", currentHighlightValues, replacementHighlight, marketplaceId);
  const attempts = [];

  for (const titleCandidate of titleCandidates) {
    for (const highlightCandidate of highlightCandidates) {
      const result = await patchListingPreview(accessToken, sku, productType, titleCandidate, highlightCandidate);
      attempts.push({
        titleStrategy: titleCandidate.strategy,
        titleOp: titleCandidate.op,
        highlightStrategy: highlightCandidate.strategy,
        highlightOp: highlightCandidate.op,
        httpStatus: result.httpStatus,
        responseOk: result.responseOk,
        status: result.status,
        errorCount: result.errorCount,
        issues: result.issues,
      });

      if (result.responseOk && result.valid) {
        return { selectedTitle: titleCandidate, selectedHighlight: highlightCandidate, patchResult: result, attempts };
      }

      await sleep(PREVIEW_RETRY_GAP_MS);
    }
  }

  const last = attempts[attempts.length - 1] || {};
  return {
    selectedTitle: null,
    selectedHighlight: null,
    patchResult: { json: { status: last.status || "", issues: last.issues || [] } },
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
    const replacementTitle = String(req.body?.replacementTitle || "").trim();
    const dryRun = req.body?.dryRun !== false;

    if (!sku) throw new Error("sku is required");
    if (issueCode !== "90225") throw new Error("Only issueCode 90225 is supported by this guarded route");
    if (attributeName !== "title_differentiation") throw new Error("Only title_differentiation is supported by this guarded route");
    if (!replacementTitle) throw new Error("replacementTitle is required for the 2026 title/highlight format preview");
    if (!replacementValue) throw new Error("replacementValue is required");
    if ([...replacementTitle].length > 75) throw new Error("replacementTitle must be <= 75 characters");
    if ([...replacementValue].length > 125) throw new Error("replacementValue must be <= 125 characters");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const issue = getCurrentError(listing, issueCode, attributeName);
    if (!issue) throw new Error("Target 90225 title_differentiation ERROR is not currently present");

    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    const productType = String(summary?.productType || "").trim();
    if (!productType) throw new Error("Listing productType could not be resolved");

    const currentTitleValues = listing?.attributes?.item_name;
    const currentHighlightValues = listing?.attributes?.title_differentiation;
    const currentTitle = extractFirstValue(currentTitleValues);
    const currentHighlight = extractFirstValue(currentHighlightValues);

    if (!dryRun) {
      throw new Error("LIVE_REPAIR_BLOCKED: v1.2.0 requires a successful combined title/highlight VALIDATION_PREVIEW before live repair is enabled");
    }

    const preview = await runValidationPreview(
      accessToken,
      sku,
      productType,
      listing,
      replacementTitle,
      replacementValue,
    );

    const selectedTitle = preview.selectedTitle;
    const selectedHighlight = preview.selectedHighlight;
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
      currentTitlePresent: Array.isArray(currentTitleValues) && currentTitleValues.length > 0,
      currentTitle,
      currentTitleLength: currentTitle ? [...currentTitle].length : null,
      currentHighlightPresent: Array.isArray(currentHighlightValues) && currentHighlightValues.length > 0,
      currentHighlight,
      currentHighlightLength: currentHighlight ? [...currentHighlight].length : null,
      replacementTitle,
      replacementTitleLength: [...replacementTitle].length,
      replacementValue,
      replacementLength: [...replacementValue].length,
      validationPassed: Boolean(selectedTitle && selectedHighlight),
      selectedTitleStrategy: selectedTitle ? selectedTitle.strategy : "",
      selectedTitleOp: selectedTitle ? selectedTitle.op : "",
      selectedHighlightStrategy: selectedHighlight ? selectedHighlight.strategy : "",
      selectedHighlightOp: selectedHighlight ? selectedHighlight.op : "",
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
