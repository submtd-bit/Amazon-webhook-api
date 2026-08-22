import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-amazon-listing-issue-repair-v1.3.0";
const ROUTE = "/amazon/listing/issue-repair";
const REQUEST_TIMEOUT_MS = 20000;
const PREVIEW_RETRY_GAP_MS = 1100;
const originalListen = express.application.listen;

const LIVE_GUARD = Object.freeze({
  sku: "6ada397f-cb6f-4488-8f76-544f3cbaa33f",
  issueCode: "90225",
  attributeName: "title_differentiation",
  previewSubmissionId: "ed4d476ac1314537a9e2589066b59b9a",
  confirmLiveRepair: "CONFIRM_6ADA_90225_20260822",
  replacementTitle: "【整備済み品】Panasonic Let's note CF-SV8 第8世代 Core i5 8GB SSD256GB Windows11",
  replacementValue: "12.1型WUXGA・Webカメラ・Wi-Fi・HDMI・Office搭載",
  titleStrategy: "item_name_add_value_marketplace_language",
  highlightStrategy: "title_differentiation_add_value_marketplace_language",
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
    const keys = Object.keys(copy).filter(
      key => typeof copy[key] === "string" && key !== "marketplace_id" && key !== "language_tag"
    );
    if (keys.length === 1) {
      copy[keys[0]] = replacementValue;
      return copy;
    }
    throw new Error(`${attributeName}[${index}] has no replaceable value field`);
  });
}

function buildAttributeCandidates(attributeName, currentValues, replacementValue, marketplaceId) {
  const cloned = cloneAttributeWithReplacement(currentValues, replacementValue, attributeName);
  if (cloned) return [{ strategy: `${attributeName}_clone_current`, op: "replace", value: cloned }];

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
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    status,
    issues,
    errorCount: errors.length,
    valid: errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}

async function patchListing(accessToken, sku, productType, titleCandidate, highlightCandidate, dryRun) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
  if (dryRun) query.set("mode", "VALIDATION_PREVIEW");

  const patches = [
    { op: titleCandidate.op, path: "/attributes/item_name", value: titleCandidate.value },
    { op: highlightCandidate.op, path: "/attributes/title_differentiation", value: highlightCandidate.value },
  ];

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
  return { httpStatus: response.status, responseOk: response.ok, json, ...summarizePatchResponse(json) };
}

async function runValidationPreview(accessToken, sku, productType, listing, replacementTitle, replacementHighlight) {
  const { marketplaceId } = getConfig();
  const titleCandidates = buildAttributeCandidates("item_name", listing?.attributes?.item_name, replacementTitle, marketplaceId);
  const highlightCandidates = buildAttributeCandidates("title_differentiation", listing?.attributes?.title_differentiation, replacementHighlight, marketplaceId);
  const attempts = [];

  for (const titleCandidate of titleCandidates) {
    for (const highlightCandidate of highlightCandidates) {
      const result = await patchListing(accessToken, sku, productType, titleCandidate, highlightCandidate, true);
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
        submissionId: result.json?.submissionId || "",
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

function assertLiveGuard(body, preview) {
  const sku = String(body?.sku || "").trim();
  const issueCode = String(body?.issueCode || "").trim();
  const attributeName = String(body?.attributeName || "").trim();
  const replacementTitle = String(body?.replacementTitle || "").trim();
  const replacementValue = String(body?.replacementValue || "").trim();
  const previewSubmissionId = String(body?.previewSubmissionId || "").trim();
  const confirmLiveRepair = String(body?.confirmLiveRepair || "").trim();

  if (sku !== LIVE_GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
  if (issueCode !== LIVE_GUARD.issueCode) throw new Error("LIVE_GUARD_BLOCKED: unexpected issueCode");
  if (attributeName !== LIVE_GUARD.attributeName) throw new Error("LIVE_GUARD_BLOCKED: unexpected attributeName");
  if (replacementTitle !== LIVE_GUARD.replacementTitle) throw new Error("LIVE_GUARD_BLOCKED: replacementTitle changed since preview");
  if (replacementValue !== LIVE_GUARD.replacementValue) throw new Error("LIVE_GUARD_BLOCKED: replacementValue changed since preview");
  if (previewSubmissionId !== LIVE_GUARD.previewSubmissionId) throw new Error("LIVE_GUARD_BLOCKED: preview submission ID mismatch");
  if (confirmLiveRepair !== LIVE_GUARD.confirmLiveRepair) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");
  if (!preview?.selectedTitle || !preview?.selectedHighlight) throw new Error("LIVE_GUARD_BLOCKED: fresh validation preview did not pass");
  if (preview.selectedTitle.strategy !== LIVE_GUARD.titleStrategy) throw new Error("LIVE_GUARD_BLOCKED: title strategy changed");
  if (preview.selectedHighlight.strategy !== LIVE_GUARD.highlightStrategy) throw new Error("LIVE_GUARD_BLOCKED: highlight strategy changed");
}

async function handler(req, res) {
  let externalChanges = 0;
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
    if (!replacementTitle) throw new Error("replacementTitle is required");
    if (!replacementValue) throw new Error("replacementValue is required");
    if ([...replacementTitle].length > 75) throw new Error("replacementTitle must be <= 75 characters");
    if ([...replacementValue].length > 125) throw new Error("replacementValue must be <= 125 characters");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const issue = getCurrentError(listing, issueCode, attributeName);
    if (!issue) throw new Error("Target 90225 title_differentiation ERROR is not currently present; no change sent");

    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    const productType = String(summary?.productType || "").trim();
    if (!productType) throw new Error("Listing productType could not be resolved");

    const currentTitleValues = listing?.attributes?.item_name;
    const currentHighlightValues = listing?.attributes?.title_differentiation;
    const currentTitle = extractFirstValue(currentTitleValues);
    const currentHighlight = extractFirstValue(currentHighlightValues);

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

    if (dryRun) {
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
        patchResponse: preview.patchResult?.json || {},
        externalChanges: 0,
      });
    }

    assertLiveGuard(req.body, preview);

    const live = await patchListing(
      accessToken,
      sku,
      productType,
      selectedTitle,
      selectedHighlight,
      false,
    );
    externalChanges = 1;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      issueCode,
      attributeName,
      dryRun: false,
      productType,
      preflightValidationPassed: true,
      selectedTitleStrategy: selectedTitle.strategy,
      selectedTitleOp: selectedTitle.op,
      selectedHighlightStrategy: selectedHighlight.strategy,
      selectedHighlightOp: selectedHighlight.op,
      replacementTitle,
      replacementTitleLength: [...replacementTitle].length,
      replacementValue,
      replacementLength: [...replacementValue].length,
      liveHttpStatus: live.httpStatus,
      liveStatus: live.status,
      liveAccepted: Boolean(live.responseOk && live.valid),
      patchResponse: live.json,
      externalChanges,
      note: "Live request sent once. Do not resend solely because Fresh GET propagation is delayed.",
    });
  } catch (err) {
    console.error("Amazon listing issue repair error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonListingIssueRepairListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
