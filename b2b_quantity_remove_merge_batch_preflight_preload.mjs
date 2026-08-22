import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-b2b-qty-remove-merge-batch-preflight-v1.2.0";
const ROUTE = "/amazon/price/b2b/quantity/remove/merge/batch/preflight";
const ACTION = "QTY_REMOVE_MERGE_NULL";
const MAX_ITEMS = 30;
const TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const originalListen = express.application.listen;

const num = v => (v === null || v === undefined || v === "") ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const parse = t => { try { return JSON.parse(t || "{}"); } catch { return { rawText: t }; } };
const secret = () => String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}

async function token() {
  const { LWA_CLIENT_ID, LWA_CLIENT_SECRET, REFRESH_TOKEN } = process.env;
  if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !REFRESH_TOKEN) throw new Error("Missing LWA env");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  });
  const json = parse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error ${response.status}`);
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
        headers: { "x-amz-access-token": accessToken, accept: "application/json" },
        signal: controller.signal,
      });
      const json = parse(await response.text());
      if (response.ok) return json;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error(`SP-API GET ${response.status} ${JSON.stringify(json)}`);
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
  const { sellerId, marketplaceId, endpoint } = cfg();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonGet(url, accessToken);
}

function sched(offer, key) {
  return offer?.[key]?.[0]?.schedule?.[0] || {};
}

function tiers(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({
      lowerBound: num(level?.lower_bound ?? level?.lowerBound),
      value: num(level?.value),
    }))
    .filter(level => level.lowerBound !== null && level.value !== null)
    .sort((a, b) => a.lowerBound - b.lowerBound || a.value - b.value);
}

function state(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const offers = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const consumer = offers.find(row => String(row?.audience || "ALL").toUpperCase() === "ALL") || null;
  const b2b = offers.find(row => String(row?.audience || "").toUpperCase() === "B2B") || null;
  const quantitySchedule = b2b?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const normalPrice = num(sched(consumer, "our_price")?.value_with_tax);
  const salePrice = num(sched(consumer, "discounted_price")?.value_with_tax);
  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: num(listing?.fulfillmentAvailability?.[0]?.quantity)
      ?? num(attributes?.fulfillment_availability?.[0]?.quantity)
      ?? 0,
    normalPrice,
    salePrice,
    generalPrice: salePrice ?? normalPrice,
    b2bPrice: num(sched(b2b, "our_price")?.value_with_tax),
    quantityPlan: {
      discountType: String(quantitySchedule?.discount_type || "").toLowerCase(),
      tiers: tiers(quantitySchedule?.levels),
    },
    selector: {
      audience: String(b2b?.audience || ""),
      currency: String(b2b?.currency || ""),
      marketplace_id: String(b2b?.marketplace_id || ""),
    },
  };
}

function sameTiers(a, b) {
  if (a.length !== b.length) return false;
  return a.every((row, index) =>
    row.lowerBound === b[index].lowerBound && row.value === b[index].value
  );
}

function normalizeItem(item, index) {
  const out = {
    sku: String(item?.sku || "").trim(),
    asin: String(item?.asin || "").trim(),
    expectedGeneralPrice: num(item?.expectedGeneralPrice),
    expectedNormalPrice: num(item?.expectedNormalPrice),
    expectedB2bPrice: num(item?.expectedB2bPrice),
    ssotQuantityDiscountEnabled: item?.ssotQuantityDiscountEnabled,
    ssotQuantityMinLot: num(item?.ssotQuantityMinLot),
    expectedQuantityPlan: {
      discountType: String(item?.expectedQuantityDiscountType || "").toLowerCase(),
      tiers: tiers(item?.expectedQuantityTiers),
    },
    expectedQuantityAudit: String(item?.expectedQuantityAudit || "").trim(),
    expectedQuantityAuditReason: String(item?.expectedQuantityAuditReason || "").trim(),
    expectedQuantityLiveCandidate: String(item?.expectedQuantityLiveCandidate || "").trim(),
    expectedB2bStatus: String(item?.expectedB2bStatus || "").trim(),
  };

  if (!out.sku || !out.asin) throw new Error(`items[${index}] sku/asin required`);
  if (![out.expectedGeneralPrice, out.expectedNormalPrice, out.expectedB2bPrice].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error(`items[${index}] expected prices must be positive integers`);
  }
  if (out.ssotQuantityDiscountEnabled !== false) throw new Error(`items[${index}] ssotQuantityDiscountEnabled must be false`);
  if (!Number.isInteger(out.ssotQuantityMinLot) || out.ssotQuantityMinLot <= 0) throw new Error(`items[${index}] ssotQuantityMinLot invalid`);
  if (!out.expectedQuantityPlan.discountType || !out.expectedQuantityPlan.tiers.length) throw new Error(`items[${index}] expected quantity plan required`);
  if (!["LEGACY", "LEGACY_BLOCKED_B2B"].includes(out.expectedQuantityAudit)) throw new Error(`items[${index}] expectedQuantityAudit invalid`);
  if (!out.expectedQuantityAuditReason) throw new Error(`items[${index}] expectedQuantityAuditReason required`);
  if (out.expectedQuantityLiveCandidate !== "QTY_REMOVE") throw new Error(`items[${index}] expectedQuantityLiveCandidate must be QTY_REMOVE`);

  if (out.expectedQuantityAudit === "LEGACY") {
    if (!out.expectedQuantityAuditReason.startsWith("EXISTING_PLAN_WHILE_SSOT_DISABLED|")) {
      throw new Error(`items[${index}] LEGACY audit reason mismatch`);
    }
  } else {
    if (!out.expectedB2bStatus.startsWith("BLOCKED_")) throw new Error(`items[${index}] blocked B2B status required`);
    if (!out.expectedQuantityAuditReason.startsWith("EXISTING_PLAN_WHILE_B2B_BLOCKED|")) {
      throw new Error(`items[${index}] LEGACY_BLOCKED_B2B audit reason mismatch`);
    }
    if (!out.expectedQuantityAuditReason.endsWith(out.expectedB2bStatus)) {
      throw new Error(`items[${index}] blocked B2B reason/status mismatch`);
    }
  }

  return out;
}

function normalize(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw new Error("items must be a non-empty array");
  if (items.length > MAX_ITEMS) throw new Error(`items must be <= ${MAX_ITEMS}`);
  const seen = new Set();
  return items.map((item, index) => {
    const normalized = normalizeItem(item, index);
    const key = `${normalized.sku}\u0000${normalized.asin}`;
    if (seen.has(key)) throw new Error(`duplicate item ${normalized.sku} / ${normalized.asin}`);
    seen.add(key);
    return normalized;
  });
}

function guard(item, current) {
  const errors = [];
  if (current.asin !== item.asin) errors.push(`ASIN=${current.asin}`);
  if (!current.productType) errors.push("productType");
  if (!current.buyable) errors.push("BUYABLE");
  if (current.errorCount) errors.push(`errors=${current.errorCount}`);
  if (current.generalPrice !== item.expectedGeneralPrice) errors.push(`general=${current.generalPrice}`);
  if (current.normalPrice !== item.expectedNormalPrice) errors.push(`normal=${current.normalPrice}`);
  if (current.b2bPrice !== item.expectedB2bPrice) errors.push(`b2b=${current.b2bPrice}`);
  if (current.quantityPlan.discountType !== item.expectedQuantityPlan.discountType || !sameTiers(current.quantityPlan.tiers, item.expectedQuantityPlan.tiers)) {
    errors.push(`plan=${JSON.stringify(current.quantityPlan)}`);
  }
  if (String(current.selector.audience).toUpperCase() !== "B2B") errors.push(`selector.audience=${current.selector.audience}`);
  if (!current.selector.currency) errors.push("selector.currency");
  if (!current.selector.marketplace_id) errors.push("selector.marketplace_id");
  if (errors.length) {
    const error = new Error(`PRECHECK_FAILED: ${errors.join(" / ")}`);
    error.code = "PRECHECK_FAILED";
    error.details = errors;
    throw error;
  }
}

function patch(current) {
  return {
    productType: current.productType,
    patches: [{
      op: "merge",
      path: "/attributes/purchasable_offer",
      value: [{
        audience: current.selector.audience,
        currency: current.selector.currency,
        marketplace_id: current.selector.marketplace_id,
        quantity_discount_plan: null,
      }],
    }],
  };
}

function fingerprint(item, current, attemptedPatch) {
  const payload = {
    v: 2,
    moduleVersion: MODULE_VERSION,
    action: ACTION,
    sku: item.sku,
    asin: item.asin,
    expectedGeneralPrice: item.expectedGeneralPrice,
    expectedNormalPrice: item.expectedNormalPrice,
    expectedB2bPrice: item.expectedB2bPrice,
    ssotQuantityDiscountEnabled: false,
    ssotQuantityMinLot: item.ssotQuantityMinLot,
    expectedQuantityPlan: item.expectedQuantityPlan,
    expectedQuantityAudit: item.expectedQuantityAudit,
    expectedQuantityAuditReason: item.expectedQuantityAuditReason,
    expectedQuantityLiveCandidate: item.expectedQuantityLiveCandidate,
    expectedB2bStatus: item.expectedB2bStatus,
    selector: current.selector,
    patchSha256: crypto.createHash("sha256").update(JSON.stringify(attemptedPatch)).digest("hex"),
    issuedAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function handler(req, res) {
  const requestedAt = new Date().toISOString();
  try {
    const sec = secret();
    if (!sec) return res.status(500).json({ ok:false, moduleVersion:MODULE_VERSION, route:ROUTE, requestedAt, externalChanges:0, error:"AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== sec) {
      return res.status(401).json({ ok:false, moduleVersion:MODULE_VERSION, route:ROUTE, requestedAt, externalChanges:0, error:"Unauthorized" });
    }

    const items = normalize(req.body);
    const accessToken = await token();
    const results = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      try {
        const current = state(await getListing(accessToken, item.sku));
        guard(item, current);
        const attemptedPatch = patch(current);
        results.push({
          ok: true,
          status: "PREFLIGHT_READY_NO_AMAZON_WRITE",
          item: {
            sku: item.sku,
            asin: item.asin,
            action: ACTION,
            expectedQuantityAudit: item.expectedQuantityAudit,
            expectedQuantityAuditReason: item.expectedQuantityAuditReason,
            expectedB2bStatus: item.expectedB2bStatus,
          },
          before: current,
          attemptedPatch,
          dryRunFingerprint: fingerprint(item, current, attemptedPatch),
          fingerprintTtlMinutes: Math.floor(TTL_MS / 60000),
          actualExternalChanges: 0,
          externalChanges: 0,
        });
      } catch (error) {
        results.push({
          ok: false,
          status: error?.code || "ERROR",
          item: { sku: item.sku, asin: item.asin },
          error: error?.message || String(error),
          details: error?.details || [],
          actualExternalChanges: 0,
          externalChanges: 0,
        });
      }
      if (index < items.length - 1) await sleep(250);
    }

    const readyCount = results.filter(row => row.ok).length;
    const failedCount = results.length - readyCount;
    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      requestedAt,
      status: failedCount === 0 ? "PREFLIGHT_ALL_READY_NO_AMAZON_WRITE" : "PREFLIGHT_PARTIAL_NO_AMAZON_WRITE",
      amazonValidationPreviewSupported: false,
      reason: "Amazon rejects merge in VALIDATION_PREVIEW. This route performs Fresh GET, exact drift guards, selector-safe merge/null payload construction, and signed fingerprint issuance only.",
      requested: results.length,
      readyCount,
      failedCount,
      allReady: failedCount === 0,
      results,
      actualExternalChanges: 0,
      externalChanges: 0,
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      requestedAt,
      status: "ERROR",
      error: error?.message || String(error),
      actualExternalChanges: 0,
      externalChanges: 0,
    });
  }
}

express.application.listen = function b2bQtyRemoveMergeBatchPreflightListen(...args) {
  const exists = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!exists) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
