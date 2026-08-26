import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-g83-41170-price-test-preflight-v1.0.0";
const ROUTE = "/amazon/price/g83/41170-test/preflight";
const SKU = "E7-YLJ3-F9CY";
const ASIN = "B0GZBHBQN2";
const EXPECTED_NORMAL_PRICE = 58000;
const EXPECTED_CURRENT_SALE_PRICE = 42000;
const TARGET_SALE_PRICE = 41170;
const EXPECTED_MINIMUM_SELLER_ALLOWED_PRICE = 36100;
const INTERNAL_SAFE_FLOOR = 36400;
const EXPECTED_B2B_PRICE = 39900;
const EXPECTED_QTY_LOWER_BOUND = 10;
const EXPECTED_QTY_PERCENT = 3;
const DURATION_HOURS = 48;
const REQUEST_TIMEOUT_MS = 20000;

const originalPost = express.application.post;
const originalUse = express.application.use;

function parseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function epoch(v) {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : null;
}

function getSecret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

function config() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528").trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  return { sellerId, marketplaceId, endpoint };
}

async function lwaToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const j = parseJson(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA token error: ${r.status}`);
  return j.access_token;
}

async function amazonRequest({ method, url, accessToken, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const j = parseJson(await r.text());
    if (!r.ok) throw new Error(`SP-API request error: ${r.status} ${JSON.stringify(j)}`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = config();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  return amazonRequest({
    method: "GET",
    url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`,
    accessToken,
  });
}

function schedules(offer, key) {
  const s = offer?.[key]?.[0]?.schedule;
  return Array.isArray(s) ? s : [];
}

function activeSchedule(offer, key, nowMs) {
  return schedules(offer, key)
    .filter(s => {
      const start = epoch(s?.start_at);
      const end = epoch(s?.end_at);
      return (start === null || nowMs >= start) && (end === null || nowMs < end);
    })
    .sort((a, b) => (epoch(b?.start_at) ?? 0) - (epoch(a?.start_at) ?? 0))[0] || null;
}

function quantityPlan(offer) {
  return offer?.quantity_discount_plan ?? offer?.quantity_discount_plans ?? null;
}

function quantityPlanMatchesExpected(plan) {
  if (plan === null || plan === undefined) return false;
  const text = JSON.stringify(plan).toLowerCase();
  const percent = text.includes("percent");
  const lowerBound10 = /"lower_?bound"\s*:\s*10(?:\.0+)?/.test(text);
  const value3 = /"value"\s*:\s*3(?:\.0+)?/.test(text);
  return percent && lowerBound10 && value3;
}

function analyze(raw, nowMs = Date.now()) {
  const summary = Array.isArray(raw?.summaries) ? raw.summaries[0] || {} : {};
  const attrs = raw?.attributes || {};
  const issues = Array.isArray(raw?.issues) ? raw.issues : [];
  const availability = Array.isArray(raw?.fulfillmentAvailability) ? raw.fulfillmentAvailability[0] || {} : {};
  const offers = Array.isArray(attrs?.purchasable_offer) ? attrs.purchasable_offer : [];
  const consumerIndex = offers.findIndex(o => String(o?.audience || "ALL").toUpperCase() === "ALL");
  const b2bIndex = offers.findIndex(o => String(o?.audience || "").toUpperCase() === "B2B");
  const consumer = consumerIndex >= 0 ? offers[consumerIndex] : null;
  const b2b = b2bIndex >= 0 ? offers[b2bIndex] : null;
  const sale = activeSchedule(consumer, "discounted_price", nowMs);
  const qp = quantityPlan(b2b);
  return {
    asin: String(summary?.asin || ""),
    productType: String(summary?.productType || ""),
    statuses: Array.isArray(summary?.status) ? summary.status.map(String) : [],
    listingErrorCount: issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: num(availability?.quantity) ?? num(attrs?.fulfillment_availability?.[0]?.quantity) ?? 0,
    offers,
    consumerIndex,
    b2bIndex,
    consumer,
    b2b,
    normalPrice: num(activeSchedule(consumer, "our_price", nowMs)?.value_with_tax),
    activeSalePrice: num(sale?.value_with_tax),
    activeSaleStart: sale?.start_at || null,
    activeSaleEnd: sale?.end_at || null,
    minimumSellerAllowedPrice: num(activeSchedule(consumer, "minimum_seller_allowed_price", nowMs)?.value_with_tax),
    b2bPrice: num(activeSchedule(b2b, "our_price", nowMs)?.value_with_tax),
    b2bQuantityDiscountPlan: qp,
    b2bQuantityDiscountPlanMatchesExpected: quantityPlanMatchesExpected(qp),
  };
}

function assertExactScope(body) {
  const errors = [];
  if (body?.dryRun !== true) errors.push("dryRun must be true");
  if (String(body?.sku || "") !== SKU) errors.push(`sku must equal ${SKU}`);
  if (String(body?.asin || "") !== ASIN) errors.push(`asin must equal ${ASIN}`);
  if (Number(body?.currentSalePrice) !== EXPECTED_CURRENT_SALE_PRICE) errors.push(`currentSalePrice must equal ${EXPECTED_CURRENT_SALE_PRICE}`);
  if (Number(body?.targetSalePrice) !== TARGET_SALE_PRICE) errors.push(`targetSalePrice must equal ${TARGET_SALE_PRICE}`);
  if (Number(body?.safeFloor) !== INTERNAL_SAFE_FLOOR) errors.push(`safeFloor must equal ${INTERNAL_SAFE_FLOOR}`);
  if (Number(body?.durationHours) !== DURATION_HOURS) errors.push(`durationHours must equal ${DURATION_HOURS}`);
  if (errors.length) throw new Error(`Exact-scope request rejected: ${errors.join(" / ")}`);
}

function assertCurrentState(s) {
  const errors = [];
  if (s.asin !== ASIN) errors.push(`ASIN mismatch: ${s.asin || "(empty)"}`);
  if (!s.productType) errors.push("productType missing");
  if (!s.statuses.includes("BUYABLE")) errors.push(`BUYABLE missing: ${s.statuses.join(",")}`);
  if (s.listingErrorCount !== 0) errors.push(`listing ERROR issues=${s.listingErrorCount}`);
  if (!(s.availableQuantity > 0)) errors.push(`availableQuantity must be > 0: ${s.availableQuantity}`);
  if (!s.consumer || s.consumerIndex < 0) errors.push("consumer offer missing");
  if (!s.b2b || s.b2bIndex < 0) errors.push("B2B offer missing");
  if (s.normalPrice !== EXPECTED_NORMAL_PRICE) errors.push(`normal price mismatch: ${s.normalPrice}`);
  if (s.activeSalePrice !== EXPECTED_CURRENT_SALE_PRICE) errors.push(`current active sale mismatch: ${s.activeSalePrice}`);
  if (s.minimumSellerAllowedPrice !== EXPECTED_MINIMUM_SELLER_ALLOWED_PRICE) errors.push(`minimum seller allowed price mismatch: ${s.minimumSellerAllowedPrice}`);
  if (s.b2bPrice !== EXPECTED_B2B_PRICE) errors.push(`B2B price mismatch: ${s.b2bPrice}`);
  if (!s.b2bQuantityDiscountPlanMatchesExpected) errors.push(`B2B quantity plan is not expected ${EXPECTED_QTY_LOWER_BOUND}+ / ${EXPECTED_QTY_PERCENT}%`);
  if (TARGET_SALE_PRICE < INTERNAL_SAFE_FLOOR) errors.push(`target below internal safe floor: ${TARGET_SALE_PRICE}<${INTERNAL_SAFE_FLOOR}`);
  if (TARGET_SALE_PRICE < EXPECTED_MINIMUM_SELLER_ALLOWED_PRICE) errors.push(`target below Amazon minimum seller allowed price`);
  if (TARGET_SALE_PRICE <= EXPECTED_B2B_PRICE) errors.push(`consumer target must remain above B2B price: ${TARGET_SALE_PRICE}<=${EXPECTED_B2B_PRICE}`);
  if (errors.length) {
    const err = new Error(`G83 41170 preflight failed: ${errors.join(" / ")}`);
    err.code = "PREFLIGHT_FAILED";
    throw err;
  }
}

function buildPreviewPatch(s, nowMs) {
  const offers = JSON.parse(JSON.stringify(s.offers));
  const beforeOffers = JSON.parse(JSON.stringify(s.offers));
  const consumer = offers[s.consumerIndex];
  const saleContainer = consumer?.discounted_price?.[0];
  if (!saleContainer || !Array.isArray(saleContainer.schedule) || !saleContainer.schedule.length) {
    throw new Error("existing discounted_price schedule container missing; refusing to invent schema");
  }

  const template = JSON.parse(JSON.stringify(activeSchedule(consumer, "discounted_price", nowMs) || saleContainer.schedule[0] || {}));
  const startAt = new Date(nowMs - 60 * 1000).toISOString();
  const endAt = new Date(nowMs + DURATION_HOURS * 60 * 60 * 1000).toISOString();
  template.value_with_tax = TARGET_SALE_PRICE;
  template.start_at = startAt;
  template.end_at = endAt;
  saleContainer.schedule = [template];

  for (let i = 0; i < offers.length; i += 1) {
    if (i === s.consumerIndex) continue;
    if (JSON.stringify(offers[i]) !== JSON.stringify(beforeOffers[i])) {
      throw new Error(`protected non-consumer offer changed at index ${i}`);
    }
  }
  if (JSON.stringify(consumer?.our_price || null) !== JSON.stringify(beforeOffers[s.consumerIndex]?.our_price || null)) {
    throw new Error("consumer normal price changed while building preview");
  }
  if (JSON.stringify(consumer?.minimum_seller_allowed_price || null) !== JSON.stringify(beforeOffers[s.consumerIndex]?.minimum_seller_allowed_price || null)) {
    throw new Error("minimum seller allowed price changed while building preview");
  }

  return {
    startAt,
    endAt,
    patchBody: {
      productType: s.productType,
      patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }],
    },
  };
}

function hasErrorIssues(result) {
  return (Array.isArray(result?.issues) ? result.issues : [])
    .some(x => String(x?.severity || "").toUpperCase() === "ERROR");
}

async function submitValidationPreview(accessToken, patchBody) {
  const { sellerId, marketplaceId, endpoint } = config();
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", mode: "VALIDATION_PREVIEW" });
  const result = await amazonRequest({
    method: "PATCH",
    url: `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(SKU)}?${q}`,
    accessToken,
    body: patchBody,
  });
  if (hasErrorIssues(result)) throw new Error(`Amazon VALIDATION_PREVIEW returned ERROR issues: ${JSON.stringify(result.issues)}`);
  return result;
}

async function handler(req, res) {
  const nowMs = Date.now();
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    assertExactScope(req.body || {});
    const accessToken = await lwaToken();
    const before = analyze(await getListing(accessToken), nowMs);
    assertCurrentState(before);
    const preview = buildPreviewPatch(before, nowMs);
    const amazonValidation = await submitValidationPreview(accessToken, preview.patchBody);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      status: "DRY_RUN_VALIDATED",
      dryRun: true,
      externalChanges: 0,
      sku: SKU,
      asin: ASIN,
      before: {
        normalPrice: before.normalPrice,
        activeSalePrice: before.activeSalePrice,
        activeSaleStart: before.activeSaleStart,
        activeSaleEnd: before.activeSaleEnd,
        minimumSellerAllowedPrice: before.minimumSellerAllowedPrice,
        b2bPrice: before.b2bPrice,
        b2bQuantityDiscountPlan: before.b2bQuantityDiscountPlan,
        availableQuantity: before.availableQuantity,
        statuses: before.statuses,
        listingErrorCount: before.listingErrorCount,
      },
      target: {
        consumerSalePrice: TARGET_SALE_PRICE,
        safeFloor: INTERNAL_SAFE_FLOOR,
        durationHours: DURATION_HOURS,
        startAt: preview.startAt,
        endAt: preview.endAt,
      },
      protections: {
        normalPricePreserved: true,
        minimumSellerAllowedPricePreserved: true,
        b2bPriceExpectedAndPreserved: before.b2bPrice === EXPECTED_B2B_PRICE,
        quantityDiscountPlanExpectedAndPreserved: before.b2bQuantityDiscountPlanMatchesExpected,
        allNonConsumerOffersPreserved: true,
        liveMutationPathExists: false,
      },
      amazonValidation,
    });
  } catch (err) {
    console.error("G83 41170 price-test preflight error", { message: err?.message || String(err), code: err?.code || "" });
    return res.status(err?.code === "PREFLIGHT_FAILED" ? 409 : 500).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      status: err?.code || "ERROR",
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.post = function patchedPost(path, ...handlers) {
  if (path === ROUTE) return originalPost.call(this, path, ...handlers);
  return originalPost.call(this, path, ...handlers);
};

express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  if (!this.__g83PriceTest41170PreflightInstalled) {
    this.__g83PriceTest41170PreflightInstalled = true;
    originalPost.call(this, ROUTE, handler);
    console.log(`${MODULE_VERSION} route installed: POST ${ROUTE}`);
  }
  return result;
};
