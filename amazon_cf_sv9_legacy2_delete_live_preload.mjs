import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-28-amazon-cf-sv9-legacy2-delete-live-v1.0.0";
const ROUTE = "/amazon/listing/cf-sv9-legacy2-delete-live";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 700;
const POST_VERIFY_ATTEMPTS = 5;
const POST_VERIFY_GAP_MS = 1800;
const PRICE_RETIRE_PROOF = "RETIRE_CF_SV9_LEGACY2_FINAL_VERIFY_PASS";
const INVENTORY_RETIRE_PROOF = "RETIRE_CF_SV9_LEGACY2_INVENTORY_VERIFY_PASS";
const CONFIRM_TOKEN = "CONFIRM_DELETE_CF_SV9_LEGACY2_B0F1SDLKN8_20260828";
const LEGACY_ASIN = "B0F1SDLKN8";
const HEALTHY_ASIN = "B0GH6ZT2X2";
const originalListen = express.application.listen;
const deleteAcceptedThisProcess = new Set();

const TARGETS = Object.freeze([
  Object.freeze({
    sku: "26-U7P4-5C6U",
    asin: LEGACY_ASIN,
    productType: "NOTEBOOK_COMPUTER",
    titleTokens: ["CF-SV9", "256GB"],
  }),
  Object.freeze({
    sku: "CO-SU33-PSCB",
    asin: LEGACY_ASIN,
    productType: "NOTEBOOK_COMPUTER",
    titleTokens: ["CF-SV9", "256GB"],
  }),
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

async function amazonGetRaw(url, accessToken) {
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

async function getListingRaw(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "summaries,issues,fulfillmentAvailability",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonGetRaw(url, accessToken);
}

function listingSnapshot(result) {
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
  const issues = Array.isArray(body?.issues) ? body.issues : [];
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
  };
}

function assertListingGuard(result, target) {
  if (!result?.responseOk) {
    if (result?.httpStatus === 404) {
      return { alreadyDeleted: true, snapshot: null };
    }
    throw new Error(`LIVE_GUARD_BLOCKED: fresh listing GET failed for ${target.sku} HTTP ${result?.httpStatus}`);
  }
  const snap = listingSnapshot(result);
  if (snap.sku !== target.sku) throw new Error(`LIVE_GUARD_BLOCKED: SKU mismatch ${snap.sku}`);
  if (snap.asin !== target.asin) throw new Error(`LIVE_GUARD_BLOCKED: ASIN mismatch ${target.sku} ${snap.asin}`);
  if (snap.productType !== target.productType) throw new Error(`LIVE_GUARD_BLOCKED: productType mismatch ${target.sku} ${snap.productType}`);
  if (snap.buyable) throw new Error(`LIVE_GUARD_BLOCKED: listing became BUYABLE ${target.sku}`);
  if (snap.deleted) return { alreadyDeleted: true, snapshot: snap };

  const normalizedTitle = snap.title.toUpperCase().replace(/\s+/g, " ");
  for (const token of target.titleTokens) {
    if (!normalizedTitle.includes(token.toUpperCase())) {
      throw new Error(`LIVE_GUARD_BLOCKED: title token missing ${target.sku} ${token}`);
    }
  }
  return { alreadyDeleted: false, snapshot: snap };
}

async function getCatalogItem(accessToken, asin) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,productTypes",
  });
  return amazonGetRaw(`${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${query}`, accessToken);
}

async function searchCatalogByAsin(accessToken, asin) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    identifiers: asin,
    identifiersType: "ASIN",
    includedData: "summaries,productTypes",
    pageSize: "10",
  });
  return amazonGetRaw(`${endpoint}/catalog/2022-04-01/items?${query}`, accessToken);
}

function catalogItems(result) {
  return result?.responseOk && Array.isArray(result?.body?.items) ? result.body.items : [];
}

function assertCatalogGuard(legacyDirect, legacySearch, healthyDirect, healthySearch) {
  const legacySearchItems = catalogItems(legacySearch);
  const legacyExact = legacySearchItems.find(x => String(x?.asin || "").toUpperCase() === LEGACY_ASIN) || null;
  const healthySearchItems = catalogItems(healthySearch);
  const healthyExact = healthySearchItems.find(x => String(x?.asin || "").toUpperCase() === HEALTHY_ASIN) || null;

  if (legacyDirect.httpStatus !== 404) {
    throw new Error(`LIVE_GUARD_BLOCKED: legacy ASIN direct GET is not 404 HTTP ${legacyDirect.httpStatus}`);
  }
  if (!legacySearch.responseOk || legacySearchItems.length !== 0 || legacyExact) {
    throw new Error("LIVE_GUARD_BLOCKED: legacy ASIN unexpectedly resolves in catalog search");
  }
  if (!healthyDirect.responseOk || String(healthyDirect?.body?.asin || "").toUpperCase() !== HEALTHY_ASIN) {
    throw new Error(`LIVE_GUARD_BLOCKED: healthy ASIN direct GET failed HTTP ${healthyDirect.httpStatus}`);
  }
  if (!healthySearch.responseOk || !healthyExact) {
    throw new Error("LIVE_GUARD_BLOCKED: healthy ASIN missing from catalog search");
  }

  return {
    legacyAsin: LEGACY_ASIN,
    legacyDirectHttpStatus: legacyDirect.httpStatus,
    legacySearchHttpStatus: legacySearch.httpStatus,
    legacySearchItemCount: legacySearchItems.length,
    legacyResolvable: false,
    healthyAsin: HEALTHY_ASIN,
    healthyDirectHttpStatus: healthyDirect.httpStatus,
    healthySearchHttpStatus: healthySearch.httpStatus,
    healthySearchExactMatch: true,
    healthyResolvable: true,
  };
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
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    status,
    submissionId: String(json?.submissionId || ""),
    issues,
    errorCount: errors.length,
    accepted: response.ok && status === "ACCEPTED" && errors.length === 0,
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
      attempts.push({ attempt, httpStatus: result.httpStatus, verified: false, state: "GET_ERROR" });
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

    const priceRetireProof = String(req.body?.priceRetireProof || "").trim();
    const inventoryRetireProof = String(req.body?.inventoryRetireProof || "").trim();
    const confirmToken = String(req.body?.confirmToken || "").trim();
    const expectedTargetCount = Number(req.body?.expectedTargetCount);

    if (priceRetireProof !== PRICE_RETIRE_PROOF) throw new Error("LIVE_GUARD_BLOCKED: price retirement proof mismatch");
    if (inventoryRetireProof !== INVENTORY_RETIRE_PROOF) throw new Error("LIVE_GUARD_BLOCKED: inventory retirement proof mismatch");
    if (confirmToken !== CONFIRM_TOKEN) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");
    if (expectedTargetCount !== TARGETS.length) throw new Error("LIVE_GUARD_BLOCKED: expected target count mismatch");
    for (const target of TARGETS) {
      if (deleteAcceptedThisProcess.has(target.sku)) {
        throw new Error(`LIVE_GUARD_BLOCKED: delete already accepted in this process ${target.sku}`);
      }
    }

    const accessToken = await getLwaAccessToken();

    const listingPreflight = [];
    for (const target of TARGETS) {
      const fresh = await getListingRaw(accessToken, target.sku);
      const guard = assertListingGuard(fresh, target);
      listingPreflight.push({
        sku: target.sku,
        asin: target.asin,
        alreadyDeleted: guard.alreadyDeleted,
        snapshot: guard.snapshot,
      });
      await sleep(REQUEST_GAP_MS);
    }

    const legacyDirect = await getCatalogItem(accessToken, LEGACY_ASIN);
    await sleep(REQUEST_GAP_MS);
    const legacySearch = await searchCatalogByAsin(accessToken, LEGACY_ASIN);
    await sleep(REQUEST_GAP_MS);
    const healthyDirect = await getCatalogItem(accessToken, HEALTHY_ASIN);
    await sleep(REQUEST_GAP_MS);
    const healthySearch = await searchCatalogByAsin(accessToken, HEALTHY_ASIN);
    const catalogPreflight = assertCatalogGuard(legacyDirect, legacySearch, healthyDirect, healthySearch);

    const results = [];
    for (const target of TARGETS) {
      const preflight = listingPreflight.find(x => x.sku === target.sku);
      if (preflight?.alreadyDeleted) {
        results.push({
          sku: target.sku,
          asin: target.asin,
          alreadyDeleted: true,
          deleteSubmitted: false,
          deleteAccepted: false,
          postVerified: true,
          postVerifyState: "ALREADY_DELETED",
          externalChanges: 0,
        });
        continue;
      }

      const deletion = await submitDelete(accessToken, target);
      if (!deletion.accepted) {
        throw new Error(`DELETE_NOT_ACCEPTED: ${target.sku} HTTP ${deletion.httpStatus} status=${deletion.status} errors=${deletion.errorCount} body=${JSON.stringify(deletion.raw)}`);
      }
      externalChanges += 1;
      deleteAcceptedThisProcess.add(target.sku);
      const verification = await verifyDeleted(accessToken, target);
      results.push({
        sku: target.sku,
        asin: target.asin,
        alreadyDeleted: false,
        deleteSubmitted: true,
        deleteAccepted: true,
        deleteHttpStatus: deletion.httpStatus,
        deleteStatus: deletion.status,
        submissionId: deletion.submissionId,
        deleteIssues: deletion.issues,
        postVerified: verification.verified,
        postVerifyState: verification.state,
        verificationAttempts: verification.attempts,
        externalChanges: 1,
      });
      await sleep(REQUEST_GAP_MS);
    }

    const acceptedCount = results.filter(x => x.deleteAccepted).length;
    const alreadyDeletedCount = results.filter(x => x.alreadyDeleted).length;
    const verifiedCount = results.filter(x => x.postVerified).length;
    const pendingPropagationCount = results.filter(x => x.deleteAccepted && !x.postVerified).length;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: MARKETPLACE_ID,
      priceRetireProof,
      inventoryRetireProof,
      targetCount: TARGETS.length,
      preflightPassed: true,
      listingPreflight,
      catalogPreflight,
      acceptedCount,
      alreadyDeletedCount,
      verifiedCount,
      pendingPropagationCount,
      allAcceptedOrAlreadyDeleted: acceptedCount + alreadyDeletedCount === TARGETS.length,
      results,
      externalChanges,
      next: pendingPropagationCount > 0
        ? "DELETE accepted. Do not rerun. Wait for Amazon propagation and verify READ ONLY."
        : "DELETE verified for all targets. Do not rerun.",
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

express.application.listen = function amazonCfSv9Legacy2DeleteLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
