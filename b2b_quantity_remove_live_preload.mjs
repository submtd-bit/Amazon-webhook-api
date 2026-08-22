import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config";

const MODULE_VERSION = "2026-08-22-b2b-qty-remove-live-v1.0.0";
const DRYRUN_MODULE_VERSION = "2026-08-22-b2b-qty-remove-dryrun-v1.0.0";
const ROUTE = "/amazon/price/b2b/quantity/remove/live";
const ACTION = "QTY_REMOVE";
const CONFIRM = "B2B-QTY-REMOVE-LIVE-V1";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 700;
const FINGERPRINT_TTL_MS = 60 * 60 * 1000;
const VERIFY_ATTEMPTS = 8;
const VERIFY_WAIT_MS = 2500;
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
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
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
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
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
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter * 1000) : RETRY_BASE_MS * attempt;
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
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,fulfillmentAvailability", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonRequest({ method: "GET", url, accessToken, allowRetry: true });
}
async function submitLive(accessToken, sku, patchBody) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonRequest({ method: "PATCH", url, accessToken, body: patchBody, allowRetry: false });
}

function scheduleValue(offer, key) { return offer?.[key]?.[0]?.schedule?.[0] || {}; }
function normalizeTiers(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(row => ({ lowerBound: numberOrNull(row?.lower_bound ?? row?.lowerBound), value: numberOrNull(row?.value) }))
    .filter(row => row.lowerBound !== null && row.value !== null)
    .sort((a, b) => a.lowerBound - b.lowerBound || a.value - b.value);
}
function parseQuantityPlan(b2bOffer) {
  const schedule = b2bOffer?.quantity_discount_plan?.[0]?.schedule?.[0] || {};
  return { discountType: String(schedule?.discount_type || "").toLowerCase(), tiers: normalizeTiers(schedule?.levels) };
}
function analyzeListing(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const availability = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability[0] || {} : {};
  const offers = Array.isArray(attributes?.purchasable_offer) ? attributes.purchasable_offer : [];
  const consumerIndex = offers.findIndex(row => String(row?.audience || "ALL").toUpperCase() === "ALL");
  const b2bIndex = offers.findIndex(row => String(row?.audience || "").toUpperCase() === "B2B");
  const consumer = consumerIndex >= 0 ? offers[consumerIndex] : null;
  const b2b = b2bIndex >= 0 ? offers[b2bIndex] : null;
  const statuses = Array.isArray(summary?.status) ? summary.status.map(String) : [];
  const normalPrice = numberOrNull(scheduleValue(consumer, "our_price")?.value_with_tax);
  const salePrice = numberOrNull(scheduleValue(consumer, "discounted_price")?.value_with_tax);
  const b2bPrice = numberOrNull(scheduleValue(b2b, "our_price")?.value_with_tax);
  return {
    asin: String(summary?.asin || ""), productType: String(summary?.productType || ""), statuses,
    buyable: statuses.includes("BUYABLE"),
    errorCount: issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR").length,
    availableQuantity: numberOrNull(availability?.quantity) ?? numberOrNull(attributes?.fulfillment_availability?.[0]?.quantity) ?? 0,
    offers, consumerIndex, b2bIndex, consumer, b2b, normalPrice, salePrice,
    generalPrice: salePrice ?? normalPrice, b2bPrice, quantityPlan: parseQuantityPlan(b2b),
  };
}
function plansEqual(actual, expected) {
  if (actual.discountType !== expected.discountType || actual.tiers.length !== expected.tiers.length) return false;
  return actual.tiers.every((row, i) => row.lowerBound === expected.tiers[i].lowerBound && row.value === expected.tiers[i].value);
}
function publicState(state) {
  return {
    asin: state.asin, productType: state.productType, statuses: state.statuses, buyable: state.buyable,
    errorCount: state.errorCount, availableQuantity: state.availableQuantity, normalPrice: state.normalPrice,
    salePrice: state.salePrice, generalPrice: state.generalPrice, b2bPrice: state.b2bPrice, quantityPlan: state.quantityPlan,
  };
}

function verifyFingerprint(token) {
  const secret = getSecret();
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("dryRunFingerprint required");
  const [encoded, suppliedSig] = parts;
  const expectedSig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(suppliedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("fingerprint mismatch");

  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new Error("fingerprint payload invalid"); }

  const issuedAt = Number(payload?.issuedAt || 0);
  const age = Date.now() - issuedAt;
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || age < -5 * 60 * 1000 || age > FINGERPRINT_TTL_MS) throw new Error("fingerprint expired or invalid timestamp");
  if (payload?.v !== 1 || payload?.moduleVersion !== DRYRUN_MODULE_VERSION || payload?.action !== ACTION) throw new Error("fingerprint scope mismatch");
  if (!payload?.sku || !payload?.asin || !Number.isInteger(payload?.expectedGeneralPrice) || !Number.isInteger(payload?.expectedNormalPrice) || !Number.isInteger(payload?.expectedB2bPrice)) throw new Error("fingerprint required fields invalid");
  if (payload?.ssotQuantityDiscountEnabled !== false || !Number.isInteger(payload?.ssotQuantityMinLot) || payload.ssotQuantityMinLot <= 0) throw new Error("fingerprint SSOT quantity scope invalid");
  const expectedQuantityPlan = {
    discountType: String(payload?.expectedQuantityPlan?.discountType || "").toLowerCase(),
    tiers: normalizeTiers(payload?.expectedQuantityPlan?.tiers),
  };
  if (!expectedQuantityPlan.discountType || !expectedQuantityPlan.tiers.length) throw new Error("fingerprint quantity plan invalid");
  return { ...payload, expectedQuantityPlan };
}

function guardCurrentAgainstFingerprint(fp, state) {
  const errors = [];
  if (state.asin !== fp.asin) errors.push(`ASIN mismatch: expected=${fp.asin} actual=${state.asin || "(empty)"}`);
  if (!state.productType) errors.push("productType missing");
  if (!state.buyable) errors.push(`BUYABLE missing: ${state.statuses.join(",")}`);
  if (state.errorCount !== 0) errors.push(`listing ERROR issues=${state.errorCount}`);
  if (!state.consumer) errors.push("consumer purchasable_offer missing");
  if (!state.b2b) errors.push("B2B purchasable_offer missing");
  if (state.generalPrice !== fp.expectedGeneralPrice) errors.push(`general price mismatch: expected=${fp.expectedGeneralPrice} actual=${state.generalPrice}`);
  if (state.normalPrice !== fp.expectedNormalPrice) errors.push(`normal price mismatch: expected=${fp.expectedNormalPrice} actual=${state.normalPrice}`);
  if (state.b2bPrice !== fp.expectedB2bPrice) errors.push(`B2B price mismatch: expected=${fp.expectedB2bPrice} actual=${state.b2bPrice}`);
  if (!(state.availableQuantity < fp.ssotQuantityMinLot)) errors.push(`inventory no longer below SSOT quantity minimum lot: available=${state.availableQuantity} minLot=${fp.ssotQuantityMinLot}`);
  if (!plansEqual(state.quantityPlan, fp.expectedQuantityPlan)) errors.push(`quantity plan mismatch: expected=${JSON.stringify(fp.expectedQuantityPlan)} actual=${JSON.stringify(state.quantityPlan)}`);
  if (fp?.before?.generalPrice !== state.generalPrice || fp?.before?.normalPrice !== state.normalPrice || fp?.before?.b2bPrice !== state.b2bPrice) errors.push("fingerprint before-price state mismatch");
  if (!plansEqual({ discountType: String(fp?.before?.quantityPlan?.discountType || "").toLowerCase(), tiers: normalizeTiers(fp?.before?.quantityPlan?.tiers) }, state.quantityPlan)) errors.push("fingerprint before-quantity state mismatch");
  if (errors.length) {
    const err = new Error(`B2B quantity-remove LIVE preflight failed: ${errors.join(" / ")}`);
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
  if (beforeB2bPrice === null || afterB2bPrice !== beforeB2bPrice) throw new Error(`B2B price preservation check failed: before=${beforeB2bPrice} after=${afterB2bPrice}`);
  return { productType: state.productType, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }] };
}

function patchHash(body) { return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"); }
function isVerifiedRemoved(fp, state) {
  return state.asin === fp.asin
    && state.buyable === true
    && state.errorCount === 0
    && state.generalPrice === fp.expectedGeneralPrice
    && state.normalPrice === fp.expectedNormalPrice
    && state.b2bPrice === fp.expectedB2bPrice
    && state.quantityPlan.discountType === ""
    && state.quantityPlan.tiers.length === 0;
}
async function verifyLive(accessToken, fp) {
  let lastState = null;
  let lastError = "";
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    try {
      const state = analyzeListing(await getListing(accessToken, fp.sku));
      lastState = state;
      if (isVerifiedRemoved(fp, state)) return { verified: true, attempt, state: publicState(state) };
      lastError = `quantity plan still present or protected fields drifted: ${JSON.stringify(publicState(state))}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    if (attempt < VERIFY_ATTEMPTS) await sleep(VERIFY_WAIT_MS);
  }
  return { verified: false, attempt: VERIFY_ATTEMPTS, state: lastState ? publicState(lastState) : null, error: lastError };
}

async function handler(req, res) {
  const requestedAt = new Date().toISOString();
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, requestedAt, actualExternalChanges: 0, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, requestedAt, actualExternalChanges: 0, externalChanges: 0, error: "Unauthorized" });
    if (String(req.body?.confirm || "") !== CONFIRM) return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, requestedAt, actualExternalChanges: 0, externalChanges: 0, error: `confirm must equal ${CONFIRM}` });

    const fp = verifyFingerprint(req.body?.dryRunFingerprint);
    const accessToken = await getLwaAccessToken();
    const before = analyzeListing(await getListing(accessToken, fp.sku));
    guardCurrentAgainstFingerprint(fp, before);
    const patchBody = buildPatch(before);
    const hash = patchHash(patchBody);
    if (hash !== fp.patchSha256) throw new Error(`patch fingerprint mismatch: expected=${fp.patchSha256} actual=${hash}`);

    const accepted = await submitLive(accessToken, fp.sku, patchBody);
    const acceptedErrors = Array.isArray(accepted?.issues) ? accepted.issues.filter(row => String(row?.severity || "").toUpperCase() === "ERROR") : [];
    if (acceptedErrors.length) {
      return res.status(409).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, requestedAt, status: "AMAZON_LIVE_ERROR", accepted, actualExternalChanges: 0, externalChanges: 0 });
    }

    const verification = await verifyLive(accessToken, fp);
    if (!verification.verified) {
      return res.status(409).json({
        ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, requestedAt,
        status: "LIVE_ACCEPTED_FRESH_VERIFICATION_FAILED",
        accepted, verification,
        actualExternalChanges: 0, externalChanges: 0,
      });
    }

    return res.status(200).json({
      ok: true, moduleVersion: MODULE_VERSION, route: ROUTE, requestedAt,
      status: "COMPLETED", sku: fp.sku, asin: fp.asin, action: ACTION,
      before: publicState(before), accepted, verification,
      actualExternalChanges: 1, externalChanges: 1,
    });
  } catch (err) {
    const status = err?.code === "PREFLIGHT_FAILED" ? 409 : 400;
    console.error("B2B quantity-remove LIVE error", err?.message || String(err));
    return res.status(status).json({
      ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, requestedAt,
      status: err?.code || "ERROR", error: err?.message || String(err), details: err?.details || [],
      actualExternalChanges: 0, externalChanges: 0,
    });
  }
}

express.application.listen = function b2bQuantityRemoveLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
