import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-27-amazon-orphan-listing-delete-preflight-v1.0.0";
const ROUTE = "/amazon/listing/orphan-delete-preflight";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 700;
const originalListen = express.application.listen;

const TARGETS = [
  {
    oldSku: "1BU9-4A3R-DJN4",
    oldAsin: "B0F37MMZQJ",
    replacementSku: "cf-sv7-i5-8gb-ssd512",
    replacementAsin: "B0GH7L4DQ3",
    model: "CF-SV7",
    storageTokens: ["512GB"],
  },
  {
    oldSku: "1BU9-4A3R-E0I3",
    oldAsin: "B0F431VQ48",
    replacementSku: "cf-sv7-i5-8gb-ssd1",
    replacementAsin: "B0GH7DD8PL",
    model: "CF-SV7",
    storageTokens: ["1TB"],
  },
  {
    oldSku: "73-30B0-V15G",
    oldAsin: "B0DD6VHLNV",
    replacementSku: "cf-sv7-i5-8gb-ssd256",
    replacementAsin: "B0GH73M1BH",
    model: "CF-SV7",
    storageTokens: ["256GB"],
  },
  {
    oldSku: "3O-WA24-QA0V",
    oldAsin: "B0F37LXDVQ",
    replacementSku: "cf-sv8-i5-8gb-ssd512",
    replacementAsin: "B0GH7GWDVP",
    model: "CF-SV8",
    storageTokens: ["512GB"],
  },
];

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
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
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function amazonGetRaw(url, accessToken) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const text = await response.text();
  return { httpStatus: response.status, responseOk: response.ok, body: safeJsonParse(text) };
}
async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  return amazonGetRaw(url, accessToken);
}
async function getCatalogDirect(accessToken, asin) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,identifiers,productTypes,relationships,images",
  });
  const url = `${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${query}`;
  return amazonGetRaw(url, accessToken);
}
async function searchCatalogByAsin(accessToken, asin) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    identifiers: asin,
    identifiersType: "ASIN",
    includedData: "summaries,identifiers,productTypes,relationships,images",
    pageSize: "10",
  });
  const url = `${endpoint}/catalog/2022-04-01/items?${query}`;
  return amazonGetRaw(url, accessToken);
}
function summaryOfListing(result) {
  const summaries = Array.isArray(result?.body?.summaries) ? result.body.summaries : [];
  return summaries[0] || {};
}
function statusesOfListing(result) {
  const status = summaryOfListing(result)?.status;
  return Array.isArray(status) ? status.map(x => String(x || "").trim()).filter(Boolean) : [];
}
function listingQty(result) {
  const rows = Array.isArray(result?.body?.fulfillmentAvailability) ? result.body.fulfillmentAvailability : [];
  return rows.reduce((sum, row) => {
    const n = Number(row?.quantity);
    return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
  }, 0);
}
function listingSnapshot(result) {
  if (!result?.responseOk) return null;
  const summary = summaryOfListing(result);
  const statuses = statusesOfListing(result);
  return {
    sku: String(result?.body?.sku || ""),
    asin: String(summary?.asin || ""),
    title: String(summary?.itemName || ""),
    productType: String(summary?.productType || ""),
    statuses,
    buyable: statuses.includes("BUYABLE"),
    issueCount: Array.isArray(result?.body?.issues) ? result.body.issues.length : 0,
    availableQuantity: listingQty(result),
  };
}
function catalogSearchItems(result) {
  return result?.responseOk && Array.isArray(result?.body?.items) ? result.body.items : [];
}
function firstCatalogSummary(item) {
  return Array.isArray(item?.summaries) ? item.summaries[0] || {} : {};
}
function firstCatalogProductType(item) {
  return Array.isArray(item?.productTypes) ? String(item.productTypes[0]?.productType || "") : "";
}
function catalogSnapshot(item) {
  if (!item || typeof item !== "object") return null;
  const summary = firstCatalogSummary(item);
  return {
    asin: String(item?.asin || ""),
    title: String(summary?.itemName || ""),
    brand: String(summary?.brand || ""),
    manufacturer: String(summary?.manufacturer || ""),
    modelNumber: String(summary?.modelNumber || ""),
    productType: firstCatalogProductType(item),
  };
}
function isNotFound(result, asin) {
  if (result?.httpStatus !== 404 || result?.responseOk) return false;
  const errors = Array.isArray(result?.body?.errors) ? result.body.errors : [];
  return errors.some(err => String(err?.code || "").toUpperCase() === "NOT_FOUND" && String(err?.message || "").includes(asin));
}
function titleMatchesSpec(title, target) {
  const normalized = String(title || "").toUpperCase().replace(/\s+/g, " ");
  const modelOk = normalized.includes(target.model.toUpperCase());
  const storageOk = target.storageTokens.every(token => normalized.includes(String(token).toUpperCase()));
  return { modelOk, storageOk, matched: modelOk && storageOk };
}
function exactCatalogSearchMatch(result, asin) {
  return catalogSearchItems(result).find(item => String(item?.asin || "").toUpperCase() === asin.toUpperCase()) || null;
}
async function inspectTarget(accessToken, target) {
  const oldListing = await getListing(accessToken, target.oldSku);
  await sleep(REQUEST_GAP_MS);
  const oldCatalogDirect = await getCatalogDirect(accessToken, target.oldAsin);
  await sleep(REQUEST_GAP_MS);
  const oldCatalogSearch = await searchCatalogByAsin(accessToken, target.oldAsin);
  await sleep(REQUEST_GAP_MS);
  const replacementCatalogDirect = await getCatalogDirect(accessToken, target.replacementAsin);
  await sleep(REQUEST_GAP_MS);
  const replacementCatalogSearch = await searchCatalogByAsin(accessToken, target.replacementAsin);
  await sleep(REQUEST_GAP_MS);
  const replacementListing = await getListing(accessToken, target.replacementSku);

  const oldListingSnap = listingSnapshot(oldListing);
  const replacementListingSnap = listingSnapshot(replacementListing);
  const replacementSearchExact = exactCatalogSearchMatch(replacementCatalogSearch, target.replacementAsin);
  const replacementDirectSnap = replacementCatalogDirect.responseOk ? catalogSnapshot(replacementCatalogDirect.body) : null;
  const replacementSearchSnap = replacementSearchExact ? catalogSnapshot(replacementSearchExact) : null;

  const oldSpecCheck = titleMatchesSpec(oldListingSnap?.title, target);
  const replacementDirectSpecCheck = titleMatchesSpec(replacementDirectSnap?.title, target);
  const replacementSearchSpecCheck = titleMatchesSpec(replacementSearchSnap?.title, target);
  const replacementListingSpecCheck = titleMatchesSpec(replacementListingSnap?.title, target);

  const checks = {
    oldListingGetOk: oldListing.responseOk,
    oldListingAsinExact: oldListingSnap?.asin === target.oldAsin,
    oldListingNotBuyable: oldListingSnap ? !oldListingSnap.buyable : false,
    oldListingSpecExact: oldSpecCheck.matched,
    oldCatalogDirectNotFound: isNotFound(oldCatalogDirect, target.oldAsin),
    oldCatalogSearchZero: oldCatalogSearch.responseOk && catalogSearchItems(oldCatalogSearch).length === 0,
    replacementCatalogDirectOk: replacementCatalogDirect.responseOk,
    replacementCatalogDirectAsinExact: replacementDirectSnap?.asin === target.replacementAsin,
    replacementCatalogDirectSpecExact: replacementDirectSpecCheck.matched,
    replacementCatalogSearchExact: Boolean(replacementSearchExact),
    replacementCatalogSearchSpecExact: replacementSearchSpecCheck.matched,
    replacementListingGetOk: replacementListing.responseOk,
    replacementListingAsinExact: replacementListingSnap?.asin === target.replacementAsin,
    replacementListingSpecExact: replacementListingSpecCheck.matched,
  };

  const amazonSideDeleteEligible = Object.values(checks).every(Boolean);

  return {
    oldSku: target.oldSku,
    oldAsin: target.oldAsin,
    replacementSku: target.replacementSku,
    replacementAsin: target.replacementAsin,
    expectedSpec: { model: target.model, storageTokens: target.storageTokens },
    checks,
    amazonSideDeleteEligible,
    oldListing: oldListingSnap,
    oldCatalog: {
      directHttpStatus: oldCatalogDirect.httpStatus,
      directResponseOk: oldCatalogDirect.responseOk,
      searchHttpStatus: oldCatalogSearch.httpStatus,
      searchResponseOk: oldCatalogSearch.responseOk,
      searchItemCount: catalogSearchItems(oldCatalogSearch).length,
    },
    replacementListing: replacementListingSnap,
    replacementCatalog: {
      directHttpStatus: replacementCatalogDirect.httpStatus,
      directResponseOk: replacementCatalogDirect.responseOk,
      direct: replacementDirectSnap,
      searchHttpStatus: replacementCatalogSearch.httpStatus,
      searchResponseOk: replacementCatalogSearch.responseOk,
      searchItemCount: catalogSearchItems(replacementCatalogSearch).length,
      exactMatch: replacementSearchSnap,
    },
  };
}
async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, readOnly: true, externalChanges: 0, error: "Unauthorized" });

    const accessToken = await getLwaAccessToken();
    const results = [];
    for (const target of TARGETS) {
      results.push(await inspectTarget(accessToken, target));
      await sleep(REQUEST_GAP_MS);
    }

    const amazonEligibleCount = results.filter(x => x.amazonSideDeleteEligible).length;
    const allAmazonSideEligible = amazonEligibleCount === TARGETS.length;

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: MARKETPLACE_ID,
      targetCount: TARGETS.length,
      amazonEligibleCount,
      allAmazonSideEligible,
      liveAllowed: false,
      blockingExternalGuard: "RETIRE_OLD_SKUS_FROM_PRICE_AND_INVENTORY_AUTOMATION_BEFORE_DELETE_LIVE",
      priceSsotKnownState: "OLD_SKUS_CURRENTLY_PRICE_REPRICING_TARGET_TRUE",
      inventoryAutomationState: "NOT_VERIFIED_IN_THIS_WORKSTREAM",
      readOnly: true,
      externalChanges: 0,
      results,
      note: "This endpoint never deletes listings. Even when Amazon-side checks pass, DELETE live must remain blocked until old SKUs are retired from automation sources that can recreate or mutate them.",
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

express.application.listen = function amazonOrphanListingDeletePreflightListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
