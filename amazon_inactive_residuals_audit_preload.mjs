import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-28-amazon-inactive-residuals-audit-v1.0.0";
const ROUTE = "/amazon/listing/inactive-residuals-audit";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 500;
const originalListen = express.application.listen;

const IMAGE_TARGETS = Object.freeze([
  Object.freeze({ sku: "g83-i5-8-8gb-ssd256", asin: "B0GN85PR8H", pts: [5], attrs: ["other_product_image_locator_4"] }),
  Object.freeze({ sku: "g83-i5-8108gb-ssd256", asin: "B0GN77WCT8", pts: [5], attrs: ["other_product_image_locator_4"] }),
  Object.freeze({ sku: "S0-1PU1-TKQW", asin: "B0FPFF23WF", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x13g1-i5-10210u-8gb-ssd256", asin: "B0GHZ1RRMN", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x13g1-i5-10210u-8gb-ssd512", asin: "B0GHY4ZS4K", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x1carbon-i5-8250u-8gb-ssd1", asin: "B0GHYP5B5Y", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x1carbon-i5-8250u-8gb-ssd256", asin: "B0GHY8MGLX", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x1carbon-i5-8250u-8gb-ssd512", asin: "B0GHYK1KZ6", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x280-i5-8gb-ssd1", asin: "B0GHYFKBL8", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x280-i5-8gb-ssd256", asin: "B0GHYT9XVK", pts: [6], attrs: ["other_product_image_locator_5"] }),
  Object.freeze({ sku: "x280-i5-8gb-ssd512", asin: "B0GHZ2F1YV", pts: [6], attrs: ["other_product_image_locator_5"] }),
]);

const PRICE_TARGET = Object.freeze({ sku: "0U-3IJD-CZ48", asin: "B0FMYF5C2Y" });
const Y3_TARGET = Object.freeze({ sku: "Y3-30YC-UORU", asin: "B0HGDZNVQN" });

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
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
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

function summaryOf(body) {
  return Array.isArray(body?.summaries) ? body.summaries[0] || {} : {};
}

function statusOf(body) {
  const summary = summaryOf(body);
  return Array.isArray(summary?.status)
    ? summary.status.map(x => String(x || "").trim()).filter(Boolean)
    : [];
}

function qtyOf(body) {
  const rows = Array.isArray(body?.fulfillmentAvailability) ? body.fulfillmentAvailability : [];
  return rows.reduce((sum, row) => {
    const n = Number(row?.quantity);
    return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
  }, 0);
}

function issueList(body) {
  return Array.isArray(body?.issues) ? body.issues : [];
}

function parsePt(issue) {
  const match = String(issue?.message || "").match(/PT\s*0*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function publicIssue(issue) {
  return {
    code: String(issue?.code || ""),
    severity: String(issue?.severity || ""),
    message: String(issue?.message || ""),
    categories: Array.isArray(issue?.categories) ? issue.categories : [],
    enforcements: issue?.enforcements || null,
  };
}

function inspectImageTarget(raw, target) {
  if (!raw.responseOk) {
    return {
      sku: target.sku,
      expectedAsin: target.asin,
      httpStatus: raw.httpStatus,
      result: raw.httpStatus === 404 ? "NOT_FOUND" : "GET_ERROR",
      apiError: raw.body,
    };
  }

  const body = raw.body || {};
  const summary = summaryOf(body);
  const asin = String(summary?.asin || "");
  const media = body?.attributes && typeof body.attributes === "object" ? body.attributes : {};
  const all100238 = issueList(body).filter(issue => String(issue?.code || "") === "100238");
  const targetIssues = all100238.filter(issue => {
    const pt = parsePt(issue);
    return pt !== null && target.pts.includes(pt);
  });
  const attrsStillPresent = target.attrs.filter(attr => Array.isArray(media[attr]) && media[attr].length > 0);

  let result;
  if (asin !== target.asin) {
    result = "ASIN_MISMATCH";
  } else if (attrsStillPresent.length === 0 && targetIssues.length === 0) {
    result = "CLOSED";
  } else if (attrsStillPresent.length === 0 && targetIssues.length > 0) {
    result = "ATTRIBUTE_REMOVED_ISSUE_PENDING";
  } else if (attrsStillPresent.length > 0 && targetIssues.length === 0) {
    result = "ISSUE_CLEARED_ATTRIBUTE_STILL_PRESENT";
  } else {
    result = "ATTRIBUTE_AND_ISSUE_STILL_PRESENT";
  }

  return {
    sku: target.sku,
    expectedAsin: target.asin,
    asin,
    httpStatus: raw.httpStatus,
    status: statusOf(body),
    availableQuantity: qtyOf(body),
    targetPts: target.pts,
    targetAttrs: target.attrs,
    attrsStillPresent,
    targetIssueCount: targetIssues.length,
    targetIssues: targetIssues.map(publicIssue),
    all100238Count: all100238.length,
    result,
  };
}

function inspectPrice(raw) {
  if (!raw.responseOk) {
    return {
      sku: PRICE_TARGET.sku,
      expectedAsin: PRICE_TARGET.asin,
      httpStatus: raw.httpStatus,
      result: raw.httpStatus === 404 ? "NOT_FOUND" : "GET_ERROR",
      apiError: raw.body,
    };
  }
  const body = raw.body || {};
  const summary = summaryOf(body);
  const issues = issueList(body);
  const codes = issues.map(x => String(x?.code || ""));
  return {
    sku: PRICE_TARGET.sku,
    expectedAsin: PRICE_TARGET.asin,
    asin: String(summary?.asin || ""),
    httpStatus: raw.httpStatus,
    status: statusOf(body),
    buyable: statusOf(body).includes("BUYABLE"),
    discoverable: statusOf(body).includes("DISCOVERABLE"),
    availableQuantity: qtyOf(body),
    issueCodes: codes,
    issueCount: issues.length,
    has18155: codes.includes("18155"),
    has18639: codes.includes("18639"),
    has101265: codes.includes("101265"),
    issues: issues.map(publicIssue),
    offers: Array.isArray(body?.offers) ? body.offers : [],
    result: codes.includes("18155") || codes.includes("18639") ? "PRICE_SUPPRESSION_PRESENT" : "PRICE_SUPPRESSION_NOT_PRESENT",
  };
}

function inspectY3(raw) {
  if (!raw.responseOk) {
    return {
      sku: Y3_TARGET.sku,
      expectedAsin: Y3_TARGET.asin,
      httpStatus: raw.httpStatus,
      result: raw.httpStatus === 404 ? "NOT_FOUND" : "GET_ERROR",
      apiError: raw.body,
    };
  }
  const body = raw.body || {};
  const summary = summaryOf(body);
  const attrs = body?.attributes && typeof body.attributes === "object" ? body.attributes : {};
  const mainAttr = Array.isArray(attrs?.main_product_image_locator) ? attrs.main_product_image_locator : [];
  const issues18320 = issueList(body).filter(issue => String(issue?.code || "") === "18320");
  return {
    sku: Y3_TARGET.sku,
    expectedAsin: Y3_TARGET.asin,
    asin: String(summary?.asin || ""),
    httpStatus: raw.httpStatus,
    status: statusOf(body),
    availableQuantity: qtyOf(body),
    mainProductImagePresent: mainAttr.length > 0,
    mainProductImageCount: mainAttr.length,
    mainProductImageValues: mainAttr,
    issue18320Count: issues18320.length,
    issues18320: issues18320.map(publicIssue),
    result: mainAttr.length === 0 && issues18320.length > 0
      ? "MISSING_MAIN_IMAGE_CONFIRMED"
      : mainAttr.length > 0 && issues18320.length > 0
        ? "MAIN_IMAGE_PRESENT_ISSUE_PENDING"
        : mainAttr.length > 0
          ? "MAIN_IMAGE_PRESENT"
          : "NO_MAIN_IMAGE_NO_18320",
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    }

    const accessToken = await getLwaAccessToken();
    const imageResults = [];
    for (let i = 0; i < IMAGE_TARGETS.length; i += 1) {
      const target = IMAGE_TARGETS[i];
      const raw = await getListingRaw(accessToken, target.sku);
      imageResults.push(inspectImageTarget(raw, target));
      if (i < IMAGE_TARGETS.length - 1) await sleep(REQUEST_GAP_MS);
    }

    await sleep(REQUEST_GAP_MS);
    const priceResult = inspectPrice(await getListingRaw(accessToken, PRICE_TARGET.sku));
    await sleep(REQUEST_GAP_MS);
    const y3Result = inspectY3(await getListingRaw(accessToken, Y3_TARGET.sku));

    const imageCounts = imageResults.reduce((acc, row) => {
      acc[row.result] = (acc[row.result] || 0) + 1;
      return acc;
    }, {});

    const closedCount = imageResults.filter(x => x.result === "CLOSED").length;
    const issuePendingCount = imageResults.filter(x => x.result === "ATTRIBUTE_REMOVED_ISSUE_PENDING").length;
    const attributeRemainingCount = imageResults.filter(x => x.result === "ATTRIBUTE_AND_ISSUE_STILL_PRESENT" || x.result === "ISSUE_CLEARED_ATTRIBUTE_STILL_PRESENT").length;
    const imageErrorCount = imageResults.filter(x => ["GET_ERROR", "NOT_FOUND", "ASIN_MISMATCH"].includes(x.result)).length;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: MARKETPLACE_ID,
      readOnly: true,
      externalChanges: 0,
      imageSummary: {
        targetCount: IMAGE_TARGETS.length,
        closedCount,
        issuePendingCount,
        attributeRemainingCount,
        errorCount: imageErrorCount,
        resultCounts: imageCounts,
      },
      imageResults,
      priceResult,
      y3Result,
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

express.application.listen = function amazonInactiveResidualsAuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
