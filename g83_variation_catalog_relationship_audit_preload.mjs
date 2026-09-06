import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-06-g83-variation-catalog-relationship-audit-v1.0.0";
const ROUTE = "/amazon/listing/g83-variation-catalog-relationship-audit";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PARENT_SKU = "g83-hs-i5-11g-variation-parent";
const LEGACY_PARENT_SKU = "TJ-00SX-UW3J";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const CHILDREN = Object.freeze([
  { sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", label: "8GB/256GB" },
  { sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", label: "8GB/512GB" },
  { sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", label: "8GB/1TB" },
  { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", label: "16GB/256GB" },
  { sku: "5K-G098-FO9O", asin: "B0FPC52B8K", label: "16GB/512GB" },
  { sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", label: "16GB/1TB" }
]);

function safeJsonParse(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { rawText: String(text || "").slice(0, 2000) }; }
}

function secret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}

function config() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(
    process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID
  ).trim();
  const endpoint = String(
    process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com"
  ).replace(/\/$/, "");

  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) {
    throw new Error(`GUARD_BLOCKED marketplace=${marketplaceId}`);
  }

  return { sellerId, marketplaceId, endpoint };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing LWA env");
  }

  const response = await fetchWithTimeout(
    "https://api.amazon.com/auth/o2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const body = safeJsonParse(await response.text());

  if (!response.ok || !body.access_token) {
    throw new Error(`LWA token error ${response.status}`);
  }

  return body.access_token;
}

async function getJson(url, token) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": token,
      accept: "application/json"
    }
  });

  return {
    httpStatus: response.status,
    ok: response.ok,
    body: safeJsonParse(await response.text())
  };
}

async function listingGet(token, sku) {
  const { sellerId, marketplaceId, endpoint } = config();

  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData:
      "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP"
  });

  return getJson(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(
      sellerId
    )}/${encodeURIComponent(sku)}?${query}`,
    token
  );
}

async function catalogGet(token, asin) {
  const { marketplaceId, endpoint } = config();

  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "relationships,summaries,productTypes"
  });

  return getJson(
    `${endpoint}/catalog/2022-04-01/items/${encodeURIComponent(
      asin
    )}?${query}`,
    token
  );
}

function listingIdentity(sku, response) {
  if (!response.ok) {
    return {
      sku,
      exists: false,
      httpStatus: response.httpStatus,
      asin: "",
      productType: "",
      title: "",
      error: response.body
    };
  }

  const body = response.body || {};
  const summary = Array.isArray(body.summaries)
    ? body.summaries[0] || {}
    : {};

  return {
    sku,
    exists: true,
    httpStatus: response.httpStatus,
    asin: String(summary.asin || ""),
    productType: String(summary.productType || ""),
    title: String(summary.itemName || "")
  };
}

function collectAsinPaths(node) {
  const hits = [];

  function walk(value, path, depth) {
    if (depth > 12 || value == null) return;

    if (typeof value === "string") {
      const s = value.trim().toUpperCase();

      if (/^[A-Z0-9]{10}$/.test(s)) {
        hits.push({
          asin: s,
          path
        });
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`, depth + 1);
      });
      return;
    }

    if (typeof value === "object") {
      Object.entries(value).forEach(([k, v]) => {
        const next = path ? `${path}.${k}` : k;
        walk(v, next, depth + 1);
      });
    }
  }

  walk(node, "relationships", 0);

  const seen = new Set();
  return hits.filter(hit => {
    const key = `${hit.asin}|${hit.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function catalogSnapshot(asin, response) {
  if (!response.ok) {
    return {
      asin,
      exists: false,
      httpStatus: response.httpStatus,
      relationshipAsins: [],
      relationshipHits: [],
      relationshipCount: 0,
      error: response.body
    };
  }

  const body = response.body || {};
  const relationships = Array.isArray(body.relationships)
    ? body.relationships
    : [];

  const hits = collectAsinPaths(relationships);
  const relationshipAsins = [
    ...new Set(hits.map(x => x.asin))
  ];

  return {
    asin: String(body.asin || asin),
    exists: true,
    httpStatus: response.httpStatus,
    productTypes: Array.isArray(body.productTypes)
      ? body.productTypes
      : [],
    summaries: Array.isArray(body.summaries)
      ? body.summaries
      : [],
    relationshipCount: relationships.length,
    relationshipAsins,
    relationshipHits: hits,
    relationships
  };
}

async function safeLegacyAudit(token) {
  const listingResponse =
    await listingGet(token, LEGACY_PARENT_SKU);

  const listing =
    listingIdentity(LEGACY_PARENT_SKU, listingResponse);

  if (!listing.exists || !listing.asin) {
    return {
      listing,
      catalog: null
    };
  }

  const catalog =
    catalogSnapshot(
      listing.asin,
      await catalogGet(token, listing.asin)
    );

  return { listing, catalog };
}

async function handler(req, res) {
  try {
    const sec = secret();

    if (!sec) {
      return res.status(500).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        amazonPersistentWrites: 0,
        externalChanges: 0,
        error: "secret missing"
      });
    }

    if (String(req.headers["x-api-secret"] || "") !== sec) {
      return res.status(401).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        amazonPersistentWrites: 0,
        externalChanges: 0,
        error: "Unauthorized"
      });
    }

    if (req.body?.dryRun === false) {
      throw new Error("LIVE disabled; catalog audit is read-only");
    }

    const token = await accessToken();

    const parentListingResponse =
      await listingGet(token, PARENT_SKU);

    const parentListing =
      listingIdentity(PARENT_SKU, parentListingResponse);

    if (!parentListing.exists) {
      throw new Error("PARENT_LISTING_NOT_FOUND");
    }

    if (!parentListing.asin) {
      throw new Error("PARENT_ASIN_NOT_RESOLVED");
    }

    const parentCatalog =
      catalogSnapshot(
        parentListing.asin,
        await catalogGet(token, parentListing.asin)
      );

    const legacy = await safeLegacyAudit(token);

    const expectedChildAsins =
      CHILDREN.map(x => x.asin);

    const children = [];

    for (const plan of CHILDREN) {
      const listingResponse =
        await listingGet(token, plan.sku);

      const listing =
        listingIdentity(plan.sku, listingResponse);

      const actualAsin =
        listing.asin || plan.asin;

      const catalog =
        catalogSnapshot(
          actualAsin,
          await catalogGet(token, actualAsin)
        );

      const parentContainsChild =
        parentCatalog.relationshipAsins.includes(plan.asin);

      const childPointsToParent =
        catalog.relationshipAsins.includes(
          parentListing.asin
        );

      const childPointsToLegacy =
        Boolean(
          legacy?.listing?.asin &&
          catalog.relationshipAsins.includes(
            legacy.listing.asin
          )
        );

      children.push({
        label: plan.label,
        sku: plan.sku,
        expectedAsin: plan.asin,
        listing,
        catalog: {
          asin: catalog.asin,
          exists: catalog.exists,
          httpStatus: catalog.httpStatus,
          relationshipCount:
            catalog.relationshipCount,
          relationshipAsins:
            catalog.relationshipAsins,
          relationshipHits:
            catalog.relationshipHits
        },
        checks: {
          listingExists: listing.exists,
          listingAsinExact:
            listing.asin === plan.asin,
          catalogExists: catalog.exists,
          parentCatalogContainsChild:
            parentContainsChild,
          childCatalogPointsToParent:
            childPointsToParent,
          childCatalogStillPointsToLegacy:
            childPointsToLegacy
        },
        catalogLinked:
          parentContainsChild &&
          childPointsToParent
      });
    }

    const parentContainsCount =
      children.filter(
        x => x.checks.parentCatalogContainsChild
      ).length;

    const childPointsToParentCount =
      children.filter(
        x => x.checks.childCatalogPointsToParent
      ).length;

    const catalogLinkedCount =
      children.filter(x => x.catalogLinked).length;

    const stillLegacyCount =
      children.filter(
        x => x.checks.childCatalogStillPointsToLegacy
      ).length;

    const allListingsExact =
      children.every(
        x =>
          x.checks.listingExists &&
          x.checks.listingAsinExact &&
          x.checks.catalogExists
      );

    let status = "CATALOG_REVIEW_REQUIRED";

    if (
      parentCatalog.exists &&
      allListingsExact &&
      catalogLinkedCount === 6 &&
      stillLegacyCount === 0
    ) {
      status = "CATALOG_6_OF_6_PASS";
    } else if (
      catalogLinkedCount > 0 &&
      catalogLinkedCount < 6
    ) {
      status = "CATALOG_PARTIAL";
    } else if (
      catalogLinkedCount === 0
    ) {
      status = "CATALOG_NONE";
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      status,
      readOnly: true,
      observedAt: new Date().toISOString(),
      parent: {
        listing: parentListing,
        catalog: {
          asin: parentCatalog.asin,
          exists: parentCatalog.exists,
          httpStatus: parentCatalog.httpStatus,
          relationshipCount:
            parentCatalog.relationshipCount,
          relationshipAsins:
            parentCatalog.relationshipAsins,
          relationshipHits:
            parentCatalog.relationshipHits,
          relationships:
            parentCatalog.relationships
        }
      },
      legacyParent: {
        listing: legacy.listing,
        catalog: legacy.catalog
          ? {
              asin: legacy.catalog.asin,
              exists: legacy.catalog.exists,
              httpStatus:
                legacy.catalog.httpStatus,
              relationshipCount:
                legacy.catalog.relationshipCount,
              relationshipAsins:
                legacy.catalog.relationshipAsins,
              relationshipHits:
                legacy.catalog.relationshipHits
            }
          : null
      },
      children,
      summary: {
        expectedChildCount: 6,
        allListingsExact,
        parentContainsChildCount:
          parentContainsCount,
        childPointsToParentCount,
        catalogLinkedCount,
        stillLegacyCount,
        catalogFamilyComplete:
          status === "CATALOG_6_OF_6_PASS"
      },
      interpretation:
        status === "CATALOG_6_OF_6_PASS"
          ? "Catalog Items relationship is complete for all six children."
          : status === "CATALOG_PARTIAL"
            ? "Catalog Items relationship is only partially reflected. Do not resend the original LIVE."
            : status === "CATALOG_NONE"
              ? "Catalog Items relationship is not yet visible for the new family. Do not resend the original LIVE."
              : "Catalog relationship state requires review. Do not resend the original LIVE.",
      amazonPersistentWrites: 0,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: 0,
      liveAllowed: false,
      doNotRerunOriginalLive: true
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      status: "BLOCK",
      readOnly: true,
      amazonPersistentWrites: 0,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: 0,
      liveAllowed: false,
      doNotRerunOriginalLive: true,
      error: err?.message || String(err)
    });
  }
}

express.application.listen =
  function g83VariationCatalogRelationshipAuditListen(...args) {
    const exists = Boolean(
      this?._router?.stack?.some(
        layer => layer?.route?.path === ROUTE
      )
    );

    if (!exists) this.post(ROUTE, handler);

    return originalListen.apply(this, args);
  };
