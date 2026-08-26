import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-image-suppression-batch-live-v1.0.0";
const ROUTE = "/amazon/listing/image-suppression-batch-repair-live";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;
let batchState = "IDLE";

const CONFIRM_TOKEN = "CONFIRM_IMAGE_BATCH_12_LIVE_20260826";
const EXPECTED_TARGET_COUNT = 12;

const TARGETS = Object.freeze([
  {
    sku: "g83-i5-11-16gb-ssd256",
    asin: "B0GN7YRC3J",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 5, attributeName: "other_product_image_locator_4", mediaLocation: "https://m.media-amazon.com/images/I/61j6IUWF2eL.jpg" }],
  },
  {
    sku: "g83-i5-8-8gb-ssd256",
    asin: "B0GN85PR8H",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 5, attributeName: "other_product_image_locator_4", mediaLocation: "https://m.media-amazon.com/images/I/61-vBnnau9L.jpg" }],
  },
  {
    sku: "g83-i5-8108gb-ssd256",
    asin: "B0GN77WCT8",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 5, attributeName: "other_product_image_locator_4", mediaLocation: "https://m.media-amazon.com/images/I/61-vBnnau9L.jpg" }],
  },
  {
    sku: "KL-GLTE-GU7A",
    asin: "B0D4LDW2TF",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [
      { pt: 2, attributeName: "other_product_image_locator_1", mediaLocation: "https://m.media-amazon.com/images/I/71LqguEit+L.jpg" },
      { pt: 7, attributeName: "other_product_image_locator_6", mediaLocation: "https://m.media-amazon.com/images/I/61dORdcMeJL.jpg" },
    ],
  },
  {
    sku: "S0-1PU1-TKQW",
    asin: "B0FPFF23WF",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
  {
    sku: "x13g1-i5-10210u-8gb-ssd256",
    asin: "B0GHZ1RRMN",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
  {
    sku: "x1carbon-i5-8250u-8gb-ssd1",
    asin: "B0GHYP5B5Y",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
  {
    sku: "x1carbon-i5-8250u-8gb-ssd256",
    asin: "B0GHY8MGLX",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
  {
    sku: "x1carbon-i5-8250u-8gb-ssd512",
    asin: "B0GHYK1KZ6",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
  {
    sku: "x280-i5-8gb-ssd1",
    asin: "B0GHYFKBL8",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
  {
    sku: "x280-i5-8gb-ssd256",
    asin: "B0GHYT9XVK",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
  {
    sku: "x280-i5-8gb-ssd512",
    asin: "B0GHZ2F1YV",
    productType: "NOTEBOOK_COMPUTER",
    deletes: [{ pt: 6, attributeName: "other_product_image_locator_5", mediaLocation: "https://m.media-amazon.com/images/I/61SY9FiCT8L.jpg" }],
  },
]);

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
    includedData: "summaries,attributes,issues",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error ${sku}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function parsePt(issue) {
  const match = String(issue?.message || "").match(/PT\s*0*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function assertTargetState(target, listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const asin = String(summary?.asin || "").trim();
  const productType = String(summary?.productType || "").trim();
  if (asin !== target.asin) throw new Error(`GUARD_BLOCKED ${target.sku}: ASIN mismatch ${asin}`);
  if (productType !== target.productType) throw new Error(`GUARD_BLOCKED ${target.sku}: productType mismatch ${productType}`);

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const imageErrors = issues.filter(issue => String(issue?.code || "") === "100238" && String(issue?.severity || "").toUpperCase() === "ERROR");
  const actualPts = [...new Set(imageErrors.map(parsePt).filter(Number.isInteger))].sort((a, b) => a - b);
  const expectedPts = [...new Set(target.deletes.map(x => x.pt))].sort((a, b) => a - b);
  if (JSON.stringify(actualPts) !== JSON.stringify(expectedPts)) {
    throw new Error(`GUARD_BLOCKED ${target.sku}: image issue PT set mismatch actual=${JSON.stringify(actualPts)} expected=${JSON.stringify(expectedPts)}`);
  }

  const plannedDeletes = target.deletes.map(spec => {
    const values = attributes[spec.attributeName];
    if (!Array.isArray(values) || values.length !== 1) {
      throw new Error(`GUARD_BLOCKED ${target.sku}: ${spec.attributeName} must contain exactly one value`);
    }
    const actualUrl = String(values[0]?.media_location || "").trim();
    if (actualUrl !== spec.mediaLocation) {
      throw new Error(`GUARD_BLOCKED ${target.sku}: ${spec.attributeName} URL mismatch ${actualUrl}`);
    }
    return {
      pt: spec.pt,
      attributeName: spec.attributeName,
      path: `/attributes/${spec.attributeName}`,
      value: values,
      mediaLocation: actualUrl,
    };
  });

  return { productType, plannedDeletes };
}

async function patchListing(accessToken, target, state, validationPreview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
  if (validationPreview) query.set("mode", "VALIDATION_PREVIEW");

  const body = {
    productType: state.productType,
    patches: state.plannedDeletes.map(item => ({
      op: "delete",
      path: item.path,
      value: item.value,
    })),
  };

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(target.sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  const valid = response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED");
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: String(json?.submissionId || ""),
    errorCount: errors.length,
    issues,
    valid,
    raw: json,
  };
}

function publicPlan(target, state) {
  return {
    sku: target.sku,
    asin: target.asin,
    productType: state.productType,
    deletes: state.plannedDeletes.map(item => ({
      pt: item.pt,
      attributeName: item.attributeName,
      mediaLocation: item.mediaLocation,
    })),
  };
}

async function handler(req, res) {
  let externalChanges = 0;
  const liveResults = [];
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const confirmToken = String(req.body?.confirmToken || "").trim();
    const expectedTargetCount = Number(req.body?.expectedTargetCount);
    if (confirmToken !== CONFIRM_TOKEN) throw new Error("BATCH_GUARD_BLOCKED: confirmation token mismatch");
    if (expectedTargetCount !== EXPECTED_TARGET_COUNT) throw new Error("BATCH_GUARD_BLOCKED: expectedTargetCount mismatch");
    if (TARGETS.length !== EXPECTED_TARGET_COUNT) throw new Error("BATCH_GUARD_BLOCKED: server target count mismatch");
    if (batchState !== "IDLE") throw new Error(`BATCH_GUARD_BLOCKED: batch state is ${batchState}`);

    batchState = "RUNNING";
    const accessToken = await getLwaAccessToken();
    const preflights = [];

    // Phase 1: Fresh GET + exact-state guard + Validation Preview for all 12.
    // No live mutation occurs unless every target passes this phase.
    for (const target of TARGETS) {
      const listing = await getListing(accessToken, target.sku);
      const state = assertTargetState(target, listing);
      const preview = await patchListing(accessToken, target, state, true);
      if (!preview.valid) {
        throw new Error(`BATCH_PREFLIGHT_BLOCKED ${target.sku}: ${JSON.stringify(preview.raw)}`);
      }
      preflights.push({
        target,
        state,
        preview,
        plan: publicPlan(target, state),
      });
    }

    // Phase 2: all targets passed. Begin live sends exactly once for this process.
    batchState = "SENT";
    for (const item of preflights) {
      const live = await patchListing(accessToken, item.target, item.state, false);
      externalChanges += 1;
      const result = {
        sku: item.target.sku,
        asin: item.target.asin,
        plannedDeletes: item.plan.deletes,
        preview: {
          httpStatus: item.preview.httpStatus,
          status: item.preview.status,
          submissionId: item.preview.submissionId,
          errorCount: item.preview.errorCount,
          issues: item.preview.issues,
        },
        live: {
          httpStatus: live.httpStatus,
          responseOk: live.responseOk,
          status: live.status,
          submissionId: live.submissionId,
          errorCount: live.errorCount,
          issues: live.issues,
          accepted: Boolean(live.valid),
        },
      };
      liveResults.push(result);
      if (!live.valid) {
        throw new Error(`BATCH_LIVE_STOPPED ${item.target.sku}: live response not accepted ${JSON.stringify(live.raw)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      targetCount: TARGETS.length,
      preflightPassedCount: preflights.length,
      liveAcceptedCount: liveResults.filter(x => x.live.accepted).length,
      results: liveResults,
      externalChanges,
      batchState,
      note: "All 12 targets passed fresh-state guards and Validation Preview before live sends began. Do not resend this batch.",
    });
  } catch (err) {
    if (externalChanges === 0) batchState = "IDLE";
    else batchState = "SENT";
    console.error("Amazon image suppression batch live error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      batchState,
      externalChanges,
      liveResults,
      error: err?.message || String(err),
      note: externalChanges > 0 ? "At least one live PATCH was already sent. Do not rerun blindly." : "No live PATCH was sent; preflight failed closed.",
    });
  }
}

express.application.listen = function amazonImageSuppressionBatchLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
