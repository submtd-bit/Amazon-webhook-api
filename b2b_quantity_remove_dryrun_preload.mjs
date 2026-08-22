import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-b2b-qty-remove-dryrun-v1.0.0";
const ROUTE = "/amazon/price/b2b/quantity/remove/dry-run";
const ACTION = "QTY_REMOVE";
const MAX_ITEMS = 20;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const FINGERPRINT_TTL_MS = 60 * 60 * 1000;
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

async function amazonRequest({ method, url, accessToken, body, allowRetry = false }) {
  const attempts = allowRetry ? MAX_RETRIES : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();
      const json = safeJsonParse(text);
      if (response.ok) return json;

      const retryable = allowRetry && (response.status === 429 || response.status >= 500);
      if (!retryable || attempt === attempts) {
        const err = new Error(`SP-API request error: ${response.status} ${JSON.stringify(json)}`);
        err.httpStatus = response.status;
        throw err;
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter * 1000)
        : RETRY_BASE_MS * attempt;
      await sleep(waitMs);
    } catch (err) {
      lastError = err;
      if (attempt === attempts) throw err;
      await sleep(RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("SP-API request failed");
}

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonRequest({ method: "GET", url, accessToken, allowRetry: true });
}

async function validationPreview(accessToken, sku, patchBody) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    mode: "VALIDATION_PREVIEW",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const result = await amazonRequest({ method: "PATCH", url, accessToken, body: patchBody, allowRetry: true });
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const errorIssues = issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR");
  if (errorIssues.length) {
    const err = new Error(`Amazon VALIDATION_PREVIEW returned ERROR issues: ${JSON.stringify(errorIssues)}`);
    err.code = "AMAZON_VALIDATION_ERROR";
    err.details = errorIssues;
    throw err;
  }
  return result;
}

function scheduleValue(offer, key) {
  return offer?.[key]?.[0]?.schedule?.[0] || {};
}

function normalizeTiers(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(row => ({
      lowerBound: numberOrNull(row?.lower_bound ?? row?.lowerBound),
      value: numberOrNull(row?.value),
    }))
    .filter(row => row.lowerBound !== null && row.value !== null)
    .sort((a, b) => a.lowerBound - b.lowerBound || a.value - b.value);
}

function parseQuantityPlan(b2bOffer) {
  const schedule = b2bOffer?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
  return {
    discountType: String(schedule?.discount_type || "").toLowerCase(),
    tiers: normalizeTiers(schedule?.levels),
  };
}

function analyzeListing(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability)
    ? listing.fulfillmentAvailability[0] || {}
    : {};
  const offers = Array.isArray(attributes?.purchasable_offer)
    ? attributes.purchasable_offer
    : [];

  const consumerIndex = offers.findIndex(row => String(row?.audience || "ALL").toUpperCase() === "ALL");
  const b2bIndex = offers.findIndex(row => String(row?.audience || "").toUpperCase() === "B2B");
  const consumer = consumerIndex >= 0 ? offers[consumerIndex] : null;
  const b2b = b2bIndex >= 0 ? offers[b2bIndex] : null;
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const normalPrice = numberOrNull(scheduleValue(consumer, "our_price")?.value_with_tax);
  const salePrice = numberOrNull(scheduleValue(consumer, "discounted_price")?.value_with_tax);
  const b2bPrice = numberOrNull(scheduleValue(b2b, "our_price")?.value_with_tax);

  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: numberOrNull(availability?.quantity)
      ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity)
      ?? 0,
    offers,
    consumerIndex,
    b2bIndex,
    consumer,
    b2b,
    normalPrice,
    salePrice,
    generalPrice: salePrice ?? normalPrice,
    b2bPrice,
    quantityPlan: parseQuantityPlan(b2b),
  };
}

function plansEqual(actual, expected) {
  if (actual.discountType !== expected.discountType) return false;
  if (actual.tiers.length !== expected.tiers.length) return false;
  return actual.tiers.every((row, index) => (
    row.lowerBound === expected.tiers[index].lowerBound
    && row.value === expected.tiers[index].value
  ));
}

function normalizeItems(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw new Error("items must be a non-empty array");
  if (items.length > MAX_ITEMS) throw new Error(`items must be <= ${MAX_ITEMS}`);

  const seen = new Set();
  return items.map((item, index) => {
    const sku = String(item?.sku || "").trim();
    const asin = String(item?.asin || "").trim();
    const action = String(item?.action || "").trim().toUpperCase();
    const expectedGeneralPrice = numberOrNull(item?.expectedGeneralPrice);
    const expectedNormalPrice = numberOrNull(item?.expectedNormalPrice);
    const expectedB2bPrice = numberOrNull(item?.expectedB2bPrice);
    const ssotQuantityDiscountEnabled = item?.ssotQuantityDiscountEnabled;
    const ssotQuantityMinLot = numberOrNull(item?.ssotQuantityMinLot);
    const expectedQuantityDiscountType = String(item?.expectedQuantityDiscountType || "").trim().toLowerCase();
    const expectedQuantityTiers = normalizeTiers(item?.expectedQuantityTiers);

    if (!sku) throw new Error(`items[${index}].sku is required`);
    if (!asin) throw new Error(`items[${index}].asin is required`);
    if (action !== ACTION) throw new Error(`items[${index}].action must be ${ACTION}`);
    if (!Number.isInteger(expectedGeneralPrice) || expectedGeneralPrice <= 0) {
      throw new Error(`items[${index}].expectedGeneralPrice must be a positive integer`);
    }
    if (!Number.isInteger(expectedNormalPrice) || expectedNormalPrice <= 0) {
      throw new Error(`items[${index}].expectedNormalPrice must be a positive integer`);
    }
    if (!Number.isInteger(expectedB2bPrice) || expectedB2bPrice <= 0) {
      throw new Error(`items[${index}].expectedB2bPrice must be a positive integer`);
    }
    if (ssotQuantityDiscountEnabled !== false) {
      throw new Error(`items[${index}].ssotQuantityDiscountEnabled must be false`);
    }
    if (!Number.isInteger(ssotQuantityMinLot) || ssotQuantityMinLot <= 0) {
      throw new Error(`items[${index}].ssotQuantityMinLot must be a positive integer`);
    }
    if (!expectedQuantityDiscountType) {
      throw new Error(`items[${index}].expectedQuantityDiscountType is required`);
    }
    if (!expectedQuantityTiers.length) {
      throw new Error(`items[${index}].expectedQuantityTiers must be non-empty`);
    }

    const key = `${sku}\u0000${asin}`;
    if (seen.has(key)) throw new Error(`duplicate item: ${sku} / ${asin}`);
    seen.add(key);

    return {
      sku,
      asin,
      action,
      expectedGeneralPrice,
      expectedNormalPrice,
      expectedB2bPrice,
      ssotQuantityDiscountEnabled,
      ssotQuantityMinLot,
      expectedQuantityPlan: {
        discountType: expectedQuantityDiscountType,
        tiers: expectedQuantityTiers,
      },
    };
  });
}

function guardState(item, state) {
  const errors = [];

  if (state.asin !== item.asin) errors.push(`ASIN mismatch: expected=${item.asin} actual=${state.asin || "(empty)"}`);
  if (!state.productType) errors.push("productType missing");
  if (!state.buyable) errors.push(`BUYABLE missing: ${state.statuses.join(",")}`);
  if (state.errorCount !== 0) errors.push(`listing ERROR issues=${state.errorCount}`);
  if (!state.consumer) errors.push("consumer purchasable_offer missing");
  if (!state.b2b) errors.push("B2B purchasable_offer missing");
  if (state.generalPrice !== item.expectedGeneralPrice) {
    errors.push(`general price mismatch: expected=${item.expectedGeneralPrice} actual=${state.generalPrice}`);
  }
  if (state.normalPrice !== item.expectedNormalPrice) {
    errors.push(`normal price mismatch: expected=${item.expectedNormalPrice} actual=${state.normalPrice}`);
  }
  if (state.b2bPrice !== item.expectedB2bPrice) {
    errors.push(`B2B price mismatch: expected=${item.expectedB2bPrice} actual=${state.b2bPrice}`);
  }
  if (!(state.availableQuantity < item.ssotQuantityMinLot)) {
    errors.push(`inventory no longer below SSOT quantity minimum lot: available=${state.availableQuantity} minLot=${item.ssotQuantityMinLot}`);
  }
  if (!plansEqual(state.quantityPlan, item.expectedQuantityPlan)) {
    errors.push(`quantity plan mismatch: expected=${JSON.stringify(item.expectedQuantityPlan)} actual=${JSON.stringify(state.quantityPlan)}`);
  }

  if (errors.length) {
    const err = new Error(`B2B quantity-remove dry-run preflight failed: ${errors.join(" / ")}`);
    err.code = "PREFLIGHT_FAILED";
    err.details = errors;
    throw err;
  }
}

function buildPatch(state) {
  if (state.b2bIndex < 0) throw new Error("B2B purchasable_offer missing");

  const offers = JSON.parse(JSON.stringify(state.offers));
  const b2b = offers[state.b2bIndex];
  const beforeB2bPrice = numberOrNull(scheduleValue(b2b, "our_price")?.value_with_tax);

  delete b2b.quantity_discount_plan;

  const afterB2bPrice = numberOrNull(scheduleValue(b2b, "our_price")?.value_with_tax);
  if (beforeB2bPrice === null || afterB2bPrice !== beforeB2bPrice) {
    throw new Error(`B2B price preservation check failed: before=${beforeB2bPrice} after=${afterB2bPrice}`);
  }

  return {
    productType: state.productType,
    patches: [{
      op: "replace",
      path: "/attributes/purchasable_offer",
      value: offers,
    }],
  };
}

function makeFingerprint(item, state, patchBody) {
  const payload = {
    v: 1,
    moduleVersion: MODULE_VERSION,
    action: ACTION,
    sku: item.sku,
    asin: item.asin,
    expectedGeneralPrice: item.expectedGeneralPrice,
    expectedNormalPrice: item.expectedNormalPrice,
    expectedB2bPrice: item.expectedB2bPrice,
    ssotQuantityDiscountEnabled: item.ssotQuantityDiscountEnabled,
    ssotQuantityMinLot: item.ssotQuantityMinLot,
    expectedQuantityPlan: item.expectedQuantityPlan,
    before: {
      availableQuantity: state.availableQuantity,
      generalPrice: state.generalPrice,
      normalPrice: state.normalPrice,
      b2bPrice: state.b2bPrice,
      quantityPlan: state.quantityPlan,
      buyable: state.buyable,
      errorCount: state.errorCount,
    },
    patchSha256: crypto.createHash("sha256").update(JSON.stringify(patchBody)).digest("hex"),
    issuedAt: Date.now(),
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", getSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function publicState(state) {
  return {
    asin: state.asin,
    productType: state.productType,
    statuses: state.statuses,
    buyable: state.buyable,
    errorCount: state.errorCount,
    availableQuantity: state.availableQuantity,
    normalPrice: state.normalPrice,
    salePrice: state.salePrice,
    generalPrice: state.generalPrice,
    b2bPrice: state.b2bPrice,
    quantityPlan: state.quantityPlan,
  };
}

async function handler(req, res) {
  const requestedAt = new Date().toISOString();
  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        requestedAt,
        externalChanges: 0,
        error: "AMAZON_STOCK_API_SECRET is not set",
      });
    }
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        requestedAt,
        externalChanges: 0,
        error: "Unauthorized",
      });
    }

    const items = normalizeItems(req.body);
    const accessToken = await getLwaAccessToken();
    const results = [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      try {
        const state = analyzeListing(await getListing(accessToken, item.sku));
        guardState(item, state);
        const patchBody = buildPatch(state);
        const amazonValidation = await validationPreview(accessToken, item.sku, patchBody);

        results.push({
          ok: true,
          status: "DRY_RUN_READY",
          sku: item.sku,
          asin: item.asin,
          action: ACTION,
          before: publicState(state),
          intendedAfter: {
            b2bPrice: state.b2bPrice,
            quantityPlan: { discountType: "", tiers: [] },
          },
          amazonValidation,
          dryRunFingerprint: makeFingerprint(item, state, patchBody),
          fingerprintTtlMinutes: Math.floor(FINGERPRINT_TTL_MS / 60000),
          externalChanges: 0,
        });
      } catch (err) {
        results.push({
          ok: false,
          status: err?.code || "ERROR",
          sku: item.sku,
          asin: item.asin,
          action: ACTION,
          error: err?.message || String(err),
          details: err?.details || [],
          externalChanges: 0,
        });
      }

      if (i < items.length - 1) await sleep(250);
    }

    const ready = results.filter(row => row.ok && row.status === "DRY_RUN_READY").length;
    const failed = results.length - ready;
    return res.status(200).json({
      ok: failed === 0,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      requestedAt,
      requested: items.length,
      ready,
      failed,
      externalChanges: 0,
      results,
    });
  } catch (err) {
    console.error("B2B quantity-remove dry-run error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      requestedAt,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function b2bQuantityRemoveDryRunListen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)
  );
  if (!alreadyRegistered) {
    this.post(ROUTE, handler);
  }
  return originalListen.apply(this, args);
};
