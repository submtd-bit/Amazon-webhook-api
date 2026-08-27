import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-27-amazon-nonbuyable-catalog-audit-v1.0.0";
const ROUTE = "/amazon/listing/nonbuyable-catalog-audit";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_GAP_MS = 900;
const MAX_ITEMS = 20;
const originalListen = express.application.listen;

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
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`marketplace mismatch: ${marketplaceId}`);
  return { marketplaceId, endpoint };
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

function normalizeItems(body) {
  const raw = Array.isArray(body?.items) ? body.items : [];
  if (!raw.length) throw new Error("items is required");
  if (raw.length > MAX_ITEMS) throw new Error(`max ${MAX_ITEMS} items`);

  const seen = new Set();
  return raw.map((item, index) => {
    const sku = String(item?.sku || "").trim();
    const asin = String(item?.asin || "").trim().toUpperCase();
    if (!sku) throw new Error(`items[${index}].sku is required`);
    if (!/^B[0-9A-Z]{9}$/.test(asin)) throw new Error(`items[${index}].asin is invalid`);
    const key = `${sku}\u0000${asin}`;
    if (seen.has(key)) throw new Error(`duplicate item ${sku}`);
    seen.add(key);
    return { sku, asin };
  });
}

function includedData() {
  return "summaries,identifiers,images,productTypes,relationships,salesRanks";
}

async function getCatalogItem(accessToken, asin) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: includedData(),
  });
  const url = `${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${query}`;
  return amazonGetRaw(url, accessToken);
}

async function searchCatalogItemByAsin(accessToken, asin) {
  const { marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    identifiers: asin,
    identifiersType: "ASIN",
    includedData: includedData(),
    pageSize: "10",
  });
  const url = `${endpoint}/catalog/2022-04-01/items?${query}`;
  return amazonGetRaw(url, accessToken);
}

function summarizeCatalogItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    asin: String(item?.asin || ""),
    summaries: Array.isArray(item?.summaries) ? item.summaries : [],
    identifiers: Array.isArray(item?.identifiers) ? item.identifiers : [],
    productTypes: Array.isArray(item?.productTypes) ? item.productTypes : [],
    relationships: Array.isArray(item?.relationships) ? item.relationships : [],
    images: Array.isArray(item?.images) ? item.images : [],
    salesRanks: Array.isArray(item?.salesRanks) ? item.salesRanks : [],
  };
}

function catalogSearchItems(result) {
  if (!result?.responseOk) return [];
  const items = Array.isArray(result?.body?.items) ? result.body.items : [];
  return items;
}

function errorSnapshot(result) {
  if (!result || result.responseOk) return null;
  return {
    httpStatus: result.httpStatus,
    errors: Array.isArray(result?.body?.errors) ? result.body.errors : [],
    body: result.body,
  };
}

function classify(asin, direct, search) {
  const searchItems = catalogSearchItems(search);
  const exact = searchItems.find(x => String(x?.asin || "").toUpperCase() === asin) || null;

  if (direct.responseOk && exact) {
    return {
      primaryDiagnostic: "CATALOG_ITEM_RESOLVES_DIRECT_AND_SEARCH",
      catalogResolvable: true,
      exactSearchMatch: true,
    };
  }

  if (direct.responseOk && !exact) {
    return {
      primaryDiagnostic: "CATALOG_DIRECT_RESOLVES_SEARCH_MISSING",
      catalogResolvable: true,
      exactSearchMatch: false,
    };
  }

  if (!direct.responseOk && exact) {
    return {
      primaryDiagnostic: "CATALOG_SEARCH_RESOLVES_DIRECT_FAILED",
      catalogResolvable: true,
      exactSearchMatch: true,
    };
  }

  if (!direct.responseOk && search.responseOk && searchItems.length === 0) {
    return {
      primaryDiagnostic: "CATALOG_ASIN_NOT_RESOLVABLE_IN_JP",
      catalogResolvable: false,
      exactSearchMatch: false,
    };
  }

  return {
    primaryDiagnostic: "CATALOG_AUDIT_INCONCLUSIVE_API_ERROR",
    catalogResolvable: false,
    exactSearchMatch: false,
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "AMAZON_STOCK_API_SECRET is not set",
      });
    }
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "Unauthorized",
      });
    }

    const items = normalizeItems(req.body || {});
    const accessToken = await getLwaAccessToken();
    const results = [];

    for (const item of items) {
      const direct = await getCatalogItem(accessToken, item.asin);
      await sleep(REQUEST_GAP_MS);
      const search = await searchCatalogItemByAsin(accessToken, item.asin);
      const classification = classify(item.asin, direct, search);
      const searchItems = catalogSearchItems(search);
      const exact = searchItems.find(x => String(x?.asin || "").toUpperCase() === item.asin) || null;

      results.push({
        sku: item.sku,
        asin: item.asin,
        ...classification,
        directGet: {
          httpStatus: direct.httpStatus,
          responseOk: direct.responseOk,
          item: direct.responseOk ? summarizeCatalogItem(direct.body) : null,
          error: errorSnapshot(direct),
        },
        searchByAsin: {
          httpStatus: search.httpStatus,
          responseOk: search.responseOk,
          itemCount: searchItems.length,
          exactMatch: exact ? summarizeCatalogItem(exact) : null,
          returnedAsins: searchItems.map(x => String(x?.asin || "")).filter(Boolean),
          error: errorSnapshot(search),
        },
      });

      await sleep(REQUEST_GAP_MS);
    }

    const diagnosticCounts = {};
    for (const row of results) {
      const key = String(row.primaryDiagnostic || "UNKNOWN");
      diagnosticCounts[key] = Number(diagnosticCounts[key] || 0) + 1;
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: MARKETPLACE_ID,
      requestedItemCount: items.length,
      catalogResolvableCount: results.filter(x => x.catalogResolvable).length,
      unresolvedCount: results.filter(x => !x.catalogResolvable).length,
      diagnosticCounts,
      readOnly: true,
      externalChanges: 0,
      results,
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

express.application.listen = function amazonNonBuyableCatalogAuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
