import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-29-amazon-y3-main-image-preview-v1.0.0";
const ROUTE = "/amazon/listing/y3-main-image-preview";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 700;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "Y3-30YC-UORU",
  asin: "B0HGDZNVQN",
  productType: "NOTEBOOK_COMPUTER",
  issueCode: "18320",
  mainImageAttribute: "main_product_image_locator",
  titleTokens: ["Latitude", "5330"],
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
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`GUARD_BLOCKED: marketplace mismatch ${marketplaceId}`);
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

async function amazonRequest(url, accessToken, options = {}) {
  const response = await fetchWithTimeout(url, {
    method: options.method || "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    body: safeJsonParse(text),
  };
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  return amazonRequest(url, accessToken);
}

async function getCatalogDirect(accessToken) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,images,productTypes",
  });
  return amazonRequest(`${endpoint}/catalog/2022-04-01/items/${GUARD.asin}?${query}`, accessToken);
}

async function getCatalogSearch(accessToken) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    identifiers: GUARD.asin,
    identifiersType: "ASIN",
    includedData: "summaries,images,productTypes",
    pageSize: "10",
  });
  return amazonRequest(`${endpoint}/catalog/2022-04-01/items?${query}`, accessToken);
}

function listingSnapshot(raw) {
  if (!raw.responseOk) throw new Error(`GUARD_BLOCKED: listing GET failed HTTP ${raw.httpStatus} ${JSON.stringify(raw.body)}`);
  const body = raw.body || {};
  const summary = Array.isArray(body.summaries) ? body.summaries[0] || {} : {};
  const attributes = body.attributes && typeof body.attributes === "object" ? body.attributes : {};
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const fulfillment = Array.isArray(body.fulfillmentAvailability) ? body.fulfillmentAvailability : [];
  const statuses = Array.isArray(summary.status) ? summary.status.map(x => String(x || "")).filter(Boolean) : [];
  const availableQuantity = fulfillment.reduce((sum, row) => {
    const n = Number(row?.quantity);
    return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
  }, 0);

  const snap = {
    sku: String(body.sku || ""),
    asin: String(summary.asin || ""),
    productType: String(summary.productType || ""),
    title: String(summary.itemName || ""),
    statuses,
    availableQuantity,
    mainImagePresent: Array.isArray(attributes[GUARD.mainImageAttribute]) && attributes[GUARD.mainImageAttribute].length > 0,
    issue18320Count: issues.filter(issue => String(issue?.code || "") === GUARD.issueCode).length,
    issueCodes: issues.map(issue => String(issue?.code || "")).filter(Boolean),
    offerTypes: Array.isArray(body.offers) ? body.offers.map(x => String(x?.offerType || "")).filter(Boolean) : [],
  };

  if (snap.sku !== GUARD.sku) throw new Error(`GUARD_BLOCKED: SKU mismatch ${snap.sku}`);
  if (snap.asin !== GUARD.asin) throw new Error(`GUARD_BLOCKED: ASIN mismatch ${snap.asin}`);
  if (snap.productType !== GUARD.productType) throw new Error(`GUARD_BLOCKED: productType mismatch ${snap.productType}`);
  if (snap.mainImagePresent) throw new Error("GUARD_BLOCKED: main_product_image_locator already exists");
  if (snap.issue18320Count < 1) throw new Error("GUARD_BLOCKED: issue18320 is no longer present");

  for (const token of GUARD.titleTokens) {
    if (!snap.title.toUpperCase().includes(token.toUpperCase())) {
      throw new Error(`GUARD_BLOCKED: listing title token missing ${token}`);
    }
  }
  return snap;
}

function catalogTitle(item) {
  const summaries = Array.isArray(item?.summaries) ? item.summaries : [];
  const row = summaries.find(x => String(x?.marketplaceId || "") === MARKETPLACE_ID) || summaries[0] || {};
  return String(row?.itemName || "");
}

function catalogProductType(item) {
  const rows = Array.isArray(item?.productTypes) ? item.productTypes : [];
  const row = rows.find(x => String(x?.marketplaceId || "") === MARKETPLACE_ID) || rows[0] || {};
  return String(row?.productType || "");
}

function catalogImageGroups(item) {
  return Array.isArray(item?.images) ? item.images : [];
}

function mainCandidates(item) {
  const groups = catalogImageGroups(item);
  const rows = [];
  for (const group of groups) {
    const marketplaceId = String(group?.marketplaceId || "");
    if (marketplaceId && marketplaceId !== MARKETPLACE_ID) continue;
    const images = Array.isArray(group?.images) ? group.images : [];
    for (const image of images) {
      if (String(image?.variant || "").toUpperCase() !== "MAIN") continue;
      rows.push({
        marketplaceId: marketplaceId || MARKETPLACE_ID,
        variant: "MAIN",
        link: String(image?.link || "").trim(),
        height: Number(image?.height),
        width: Number(image?.width),
      });
    }
  }
  return rows.filter(x => x.link);
}

function assertCatalogItem(item, sourceLabel) {
  if (!item || typeof item !== "object") throw new Error(`GUARD_BLOCKED: ${sourceLabel} catalog item missing`);
  if (String(item.asin || "").toUpperCase() !== GUARD.asin) throw new Error(`GUARD_BLOCKED: ${sourceLabel} catalog ASIN mismatch`);

  const title = catalogTitle(item);
  const productType = catalogProductType(item);
  for (const token of GUARD.titleTokens) {
    if (!title.toUpperCase().includes(token.toUpperCase())) {
      throw new Error(`GUARD_BLOCKED: ${sourceLabel} catalog title token missing ${token}`);
    }
  }
  if (productType && productType !== GUARD.productType) {
    throw new Error(`GUARD_BLOCKED: ${sourceLabel} catalog productType mismatch ${productType}`);
  }

  return { title, productType, mainCandidates: mainCandidates(item) };
}

function chooseCatalogMain(directItem, searchItem) {
  const direct = assertCatalogItem(directItem, "direct");
  const search = assertCatalogItem(searchItem, "search");
  if (!direct.mainCandidates.length) throw new Error("GUARD_BLOCKED: direct catalog has no MAIN image");
  if (!search.mainCandidates.length) throw new Error("GUARD_BLOCKED: search catalog has no MAIN image");

  const directMain = direct.mainCandidates[0];
  const searchSame = search.mainCandidates.find(x => x.link === directMain.link);
  if (!searchSame) throw new Error("GUARD_BLOCKED: direct/search MAIN image URL mismatch");

  let parsed;
  try { parsed = new URL(directMain.link); } catch { throw new Error("GUARD_BLOCKED: catalog MAIN image URL invalid"); }
  const host = parsed.hostname.toLowerCase();
  if (!(host === "m.media-amazon.com" || host.endsWith(".media-amazon.com") || host === "images-na.ssl-images-amazon.com")) {
    throw new Error(`GUARD_BLOCKED: catalog MAIN image is not Amazon-hosted ${host}`);
  }
  if (parsed.protocol !== "https:") throw new Error("GUARD_BLOCKED: catalog MAIN image URL must be HTTPS");

  if (Number.isFinite(directMain.width) && directMain.width > 0 && directMain.width < 500) {
    throw new Error(`GUARD_BLOCKED: catalog MAIN image width too small ${directMain.width}`);
  }
  if (Number.isFinite(directMain.height) && directMain.height > 0 && directMain.height < 500) {
    throw new Error(`GUARD_BLOCKED: catalog MAIN image height too small ${directMain.height}`);
  }

  return {
    title: direct.title,
    productType: direct.productType || GUARD.productType,
    mainImage: directMain,
    directMainCandidates: direct.mainCandidates,
    searchMainCandidates: search.mainCandidates,
  };
}

async function validationPreview(accessToken, mainImageUrl) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const body = {
    productType: GUARD.productType,
    patches: [
      {
        op: "add",
        path: `/attributes/${GUARD.mainImageAttribute}`,
        value: [
          {
            media_location: mainImageUrl,
            marketplace_id: marketplaceId,
          },
        ],
      },
    ],
  };
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sku)}?${query}`;
  const result = await amazonRequest(url, accessToken, { method: "PATCH", body });
  const issues = Array.isArray(result?.body?.issues) ? result.body.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(result?.body?.status || "").toUpperCase();
  return {
    httpStatus: result.httpStatus,
    responseOk: result.responseOk,
    status,
    submissionId: String(result?.body?.submissionId || ""),
    errorCount: errors.length,
    issueCount: issues.length,
    issues,
    validationPassed: result.responseOk && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
    plannedPatch: body.patches[0],
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    }
    if (req.body?.dryRun === false) throw new Error("LIVE is intentionally disabled on this route");

    const accessToken = await getLwaAccessToken();
    const listingRaw = await getListing(accessToken);
    const listing = listingSnapshot(listingRaw);

    await sleep(REQUEST_GAP_MS);
    const direct = await getCatalogDirect(accessToken);
    if (!direct.responseOk) throw new Error(`GUARD_BLOCKED: catalog direct GET failed HTTP ${direct.httpStatus} ${JSON.stringify(direct.body)}`);

    await sleep(REQUEST_GAP_MS);
    const search = await getCatalogSearch(accessToken);
    if (!search.responseOk) throw new Error(`GUARD_BLOCKED: catalog search failed HTTP ${search.httpStatus} ${JSON.stringify(search.body)}`);
    const searchItems = Array.isArray(search?.body?.items) ? search.body.items : [];
    const exact = searchItems.find(x => String(x?.asin || "").toUpperCase() === GUARD.asin);
    if (!exact) throw new Error("GUARD_BLOCKED: exact ASIN missing from catalog search");

    const catalog = chooseCatalogMain(direct.body, exact);

    await sleep(REQUEST_GAP_MS);
    const preview = await validationPreview(accessToken, catalog.mainImage.link);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku: GUARD.sku,
      asin: GUARD.asin,
      marketplaceId: MARKETPLACE_ID,
      productType: GUARD.productType,
      readOnly: true,
      externalChanges: 0,
      listingPreflight: listing,
      catalogSource: {
        directHttpStatus: direct.httpStatus,
        searchHttpStatus: search.httpStatus,
        exactSearchMatch: true,
        title: catalog.title,
        productType: catalog.productType,
        selectedMainImage: catalog.mainImage,
        directMainCandidateCount: catalog.directMainCandidates.length,
        searchMainCandidateCount: catalog.searchMainCandidates.length,
      },
      preview,
      readyForLive: preview.validationPassed,
      note: "Catalog source + Listings VALIDATION_PREVIEW only. No listing mutation was persisted.",
    });
  } catch (err) {
    console.error("Y3 main image preview error", err?.message || String(err));
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

express.application.listen = function amazonY3MainImagePreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
