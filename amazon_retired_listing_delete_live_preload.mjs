import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-27-amazon-retired-listing-delete-live-v1.0.0";
const ROUTE = "/amazon/listing/retired-delete-live";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const POST_VERIFY_ATTEMPTS = 5;
const POST_VERIFY_GAP_MS = 1800;
const PRICE_RETIRE_PROOF = "RETIRE9_FINAL_VERIFY_PASS";
const originalListen = express.application.listen;
const deleteAcceptedThisProcess = new Set();

const TARGETS = Object.freeze({
  "x13g1-i5-10210u-8gb-ssd1": Object.freeze({
    sku: "x13g1-i5-10210u-8gb-ssd1",
    asin: "B0GHY9J1NF",
    productType: "NOTEBOOK_COMPUTER",
    titleTokens: ["X13", "1TB"],
    requiredIssueCode: "18146",
    requiredEnforcement: "CATALOG_ITEM_REMOVED",
    confirmToken: "CONFIRM_DELETE_X13G1_1TB_B0GHY9J1NF_20260827",
  }),
  "KL-GLTE-GU7A": Object.freeze({
    sku: "KL-GLTE-GU7A",
    asin: "B0D4LDW2TF",
    productType: "NOTEBOOK_COMPUTER",
    titleTokens: ["CF-SZ6", "16GB", "512GB"],
    confirmToken: "CONFIRM_DELETE_KL_GLTE_GU7A_20260827",
  }),
  "LM-QO9K-G631": Object.freeze({
    sku: "LM-QO9K-G631",
    asin: "B0D4LDW2TF",
    productType: "NOTEBOOK_COMPUTER",
    titleTokens: ["CF-SZ6", "16GB", "512GB"],
    confirmToken: "CONFIRM_DELETE_LM_QO9K_G631_20260827",
  }),
  "QS-PTMS-QOU0": Object.freeze({
    sku: "QS-PTMS-QOU0",
    asin: "B0D4LDW2TF",
    productType: "NOTEBOOK_COMPUTER",
    titleTokens: ["CF-SZ6", "16GB", "512GB"],
    confirmToken: "CONFIRM_DELETE_QS_PTMS_QOU0_20260827",
  }),
  "V3-ARPY-J6AB": Object.freeze({
    sku: "V3-ARPY-J6AB",
    asin: "B0D4LDW2TF",
    productType: "NOTEBOOK_COMPUTER",
    titleTokens: ["CF-SZ6", "16GB", "512GB"],
    confirmToken: "CONFIRM_DELETE_V3_ARPY_J6AB_20260827",
  }),
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

function listingSnapshot(result) {
  const body = result?.body || {};
  const summary = Array.isArray(body?.summaries) ? body.summaries[0] || {} : {};
  const statuses = Array.isArray(summary?.status)
    ? summary.status.map(x => String(x || "").trim()).filter(Boolean)
    : [];
  const issues = Array.isArray(body?.issues) ? body.issues : [];
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
    deleted: statuses.includes("DELETED"),
    availableQuantity,
    issueCount: issues.length,
    issues: issues.map(issue => ({
      code: String(issue?.code || ""),
      severity: String(issue?.severity || ""),
      message: String(issue?.message || ""),
      enforcementActions: Array.isArray(issue?.enforcements?.actions)
        ? issue.enforcements.actions.map(x => String(x?.action || ""))
        : [],
    })),
  };
}

function assertFreshDeleteGuard(result, target) {
  if (!result?.responseOk) {
    throw new Error(`LIVE_GUARD_BLOCKED: fresh listing GET failed HTTP ${result?.httpStatus}`);
  }
  const snap = listingSnapshot(result);
  if (snap.sku !== target.sku) throw new Error(`LIVE_GUARD_BLOCKED: SKU mismatch ${snap.sku}`);
  if (snap.asin !== target.asin) throw new Error(`LIVE_GUARD_BLOCKED: ASIN mismatch ${snap.asin}`);
  if (snap.productType !== target.productType) throw new Error(`LIVE_GUARD_BLOCKED: productType mismatch ${snap.productType}`);
  if (snap.buyable) throw new Error("LIVE_GUARD_BLOCKED: listing became BUYABLE");
  if (snap.deleted) return { alreadyDeleted: true, snapshot: snap };

  const normalizedTitle = snap.title.toUpperCase().replace(/\s+/g, " ");
  for (const token of target.titleTokens || []) {
    if (!normalizedTitle.includes(String(token).toUpperCase())) {
      throw new Error(`LIVE_GUARD_BLOCKED: title spec token missing ${token}`);
    }
  }

  if (target.requiredIssueCode) {
    const issue = snap.issues.find(x => x.code === target.requiredIssueCode);
    if (!issue) throw new Error(`LIVE_GUARD_BLOCKED: required issue ${target.requiredIssueCode} missing`);
    if (target.requiredEnforcement && !issue.enforcementActions.includes(target.requiredEnforcement)) {
      throw new Error(`LIVE_GUARD_BLOCKED: required enforcement ${target.requiredEnforcement} missing`);
    }
  }

  return { alreadyDeleted: false, snapshot: snap };
}

async function submitDelete(accessToken, target) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(target.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "DELETE",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
    },
  });
  const text = await response.text();
  const json = safeJsonParse(text);
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  const accepted = response.ok && status === "ACCEPTED" && errors.length === 0;
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    errorCount: errors.length,
    issues,
    accepted,
    raw: json,
  };
}

async function verifyDeleted(accessToken, target) {
  const attempts = [];
  for (let attempt = 1; attempt <= POST_VERIFY_ATTEMPTS; attempt += 1) {
    await sleep(POST_VERIFY_GAP_MS);
    const result = await getListingRaw(accessToken, target.sku);
    if (result.httpStatus === 404) {
      attempts.push({ attempt, httpStatus: 404, verified: true, state: "NOT_FOUND" });
      return { verified: true, state: "NOT_FOUND", attempts };
    }
    if (result.responseOk) {
      const snap = listingSnapshot(result);
      const verified = snap.deleted;
      attempts.push({ attempt, httpStatus: result.httpStatus, verified, state: verified ? "DELETED" : "STILL_PRESENT", snapshot: snap });
      if (verified) return { verified: true, state: "DELETED", attempts };
    } else {
      attempts.push({ attempt, httpStatus: result.httpStatus, verified: false, state: "GET_ERROR", raw: result.body });
    }
  }
  return { verified: false, state: "PENDING_AMAZON_PROPAGATION", attempts };
}

async function handler(req, res) {
  let externalChanges = 0;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const expectedAsin = String(req.body?.expectedAsin || "").trim();
    const confirmToken = String(req.body?.confirmToken || "").trim();
    const priceRetireProof = String(req.body?.priceRetireProof || "").trim();
    const target = TARGETS[sku];

    if (!target) throw new Error("LIVE_GUARD_BLOCKED: SKU not approved for LIVE delete in this build");
    if (expectedAsin !== target.asin) throw new Error("LIVE_GUARD_BLOCKED: expected ASIN mismatch");
    if (confirmToken !== target.confirmToken) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");
    if (priceRetireProof !== PRICE_RETIRE_PROOF) throw new Error("LIVE_GUARD_BLOCKED: price retirement proof mismatch");
    if (deleteAcceptedThisProcess.has(sku)) throw new Error("LIVE_GUARD_BLOCKED: delete already accepted for this SKU in this process");

    const accessToken = await getLwaAccessToken();
    const fresh = await getListingRaw(accessToken, sku);
    if (fresh.httpStatus === 404) {
      return res.status(200).json({
        ok: true,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        sku,
        asin: target.asin,
        alreadyDeleted: true,
        deleteSubmitted: false,
        postVerified: true,
        postVerifyState: "NOT_FOUND",
        externalChanges: 0,
      });
    }

    const guard = assertFreshDeleteGuard(fresh, target);
    if (guard.alreadyDeleted) {
      return res.status(200).json({
        ok: true,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        sku,
        asin: target.asin,
        alreadyDeleted: true,
        deleteSubmitted: false,
        freshBefore: guard.snapshot,
        postVerified: true,
        postVerifyState: "DELETED",
        externalChanges: 0,
      });
    }

    const deletion = await submitDelete(accessToken, target);
    if (!deletion.accepted) {
      throw new Error(`DELETE_NOT_ACCEPTED: HTTP ${deletion.httpStatus} status=${deletion.status} errors=${deletion.errorCount} body=${JSON.stringify(deletion.raw)}`);
    }

    externalChanges = 1;
    deleteAcceptedThisProcess.add(sku);
    const verification = await verifyDeleted(accessToken, target);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: MARKETPLACE_ID,
      sku,
      asin: target.asin,
      priceRetireProof,
      inventoryGuard: "THIS_BUILD_ALLOWLIST_CONTAINS_ONLY_SKUS_VERIFIED_ABSENT_FROM_CURRENT_AMAZON_INVENTORY_SOURCE",
      freshBefore: guard.snapshot,
      deleteSubmitted: true,
      deleteAccepted: true,
      deleteHttpStatus: deletion.httpStatus,
      deleteStatus: deletion.status,
      submissionId: deletion.submissionId,
      deleteIssues: deletion.issues,
      postVerified: verification.verified,
      postVerifyState: verification.state,
      verificationAttempts: verification.attempts,
      externalChanges,
      next: verification.verified
        ? "DELETE verified. Do not rerun this SKU."
        : "DELETE was ACCEPTED. Do not rerun. Wait for Amazon propagation and use READ ONLY verification.",
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonRetiredListingDeleteLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
