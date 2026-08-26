import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-0u18155-control-probe-v1.0.0";
const ROUTE = "/amazon/listing/0u18155-control-probe";
const originalListen = express.application.listen;
const REQUEST_TIMEOUT_MS = 20000;

const GUARD = Object.freeze({
  sku: "0U-3IJD-CZ48",
  asin: "B0FMYF5C2Y",
  productType: "NOTEBOOK_COMPUTER",
  currentOurPrice: 32000,
  currentMin: 32000,
  currentMax: 58000,
  candidates: [32100, 32000, 31999],
});

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

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const j = safeJsonParse(await r.text());
  if (!r.ok || !j.access_token) throw new Error(`LWA token error: ${r.status}`);
  return j.access_token;
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${q}`;
  const r = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const j = safeJsonParse(await r.text());
  if (!r.ok) throw new Error(`SP-API GET error: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

function firstValue(node) {
  const raw = node?.[0]?.schedule?.[0]?.value_with_tax;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function assertState(listing) {
  const s = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  if (String(s.asin || "") !== GUARD.asin) throw new Error(`GUARD_BLOCKED: ASIN mismatch ${s.asin || ""}`);
  if (String(s.productType || "") !== GUARD.productType) throw new Error(`GUARD_BLOCKED: productType mismatch ${s.productType || ""}`);

  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const e18155 = issues.filter(x => String(x?.code || "") === "18155" && String(x?.severity || "").toUpperCase() === "ERROR");
  if (e18155.length !== 1) throw new Error(`GUARD_BLOCKED: expected one ERROR 18155, found ${e18155.length}`);

  const attrs = listing?.attributes || {};
  const offers = Array.isArray(attrs.purchasable_offer) ? JSON.parse(JSON.stringify(attrs.purchasable_offer)) : [];
  const idx = offers.findIndex(x => String(x?.audience || "ALL").toUpperCase() === "ALL");
  if (idx < 0) throw new Error("GUARD_BLOCKED: ALL offer missing");
  const all = offers[idx];
  if (firstValue(all.our_price) !== GUARD.currentOurPrice) throw new Error(`GUARD_BLOCKED: our price mismatch ${firstValue(all.our_price)}`);
  if (firstValue(all.minimum_seller_allowed_price) !== GUARD.currentMin) throw new Error(`GUARD_BLOCKED: min mismatch ${firstValue(all.minimum_seller_allowed_price)}`);
  if (firstValue(all.maximum_seller_allowed_price) !== GUARD.currentMax) throw new Error(`GUARD_BLOCKED: max mismatch ${firstValue(all.maximum_seller_allowed_price)}`);

  return {
    productType: GUARD.productType,
    offers,
    consumerIndex: idx,
    issue18155: e18155,
    listingOffers: Array.isArray(listing?.offers) ? listing.offers : [],
  };
}

async function preview(accessToken, state, candidateMin) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const offers = JSON.parse(JSON.stringify(state.offers));
  offers[state.consumerIndex].minimum_seller_allowed_price = [{ schedule: [{ value_with_tax: candidateMin }] }];
  const body = {
    productType: state.productType,
    patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: offers }],
  };
  const q = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues", mode: "VALIDATION_PREVIEW" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${q}`;
  const r = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = safeJsonParse(await r.text());
  const issues = Array.isArray(j?.issues) ? j.issues : [];
  const errors = issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR");
  return {
    candidateMin,
    httpStatus: r.status,
    responseOk: r.ok,
    status: String(j?.status || "").toUpperCase(),
    submissionId: String(j?.submissionId || ""),
    errorCount: errors.length,
    issue18155Count: errors.filter(x => String(x?.code || "") === "18155").length,
    issues,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    if (String(req.body?.sku || "").trim() !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");

    const accessToken = await getLwaAccessToken();
    const state = assertState(await getListing(accessToken));
    const probes = [];
    for (const candidate of GUARD.candidates) {
      probes.push(await preview(accessToken, state, candidate));
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: GUARD.asin,
      currentOurPrice: GUARD.currentOurPrice,
      currentMin: GUARD.currentMin,
      candidates: GUARD.candidates,
      currentIssue18155: state.issue18155,
      listingOffers: state.listingOffers,
      probes,
      readOnly: true,
      externalChanges: 0,
      note: "Control probe only. All PATCH requests used VALIDATION_PREVIEW; no listing mutation persisted.",
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

express.application.listen = function amazon0u18155ControlProbeListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
