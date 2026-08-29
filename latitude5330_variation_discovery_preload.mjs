import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-29-latitude5330-variation-discovery-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-variation-discovery";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sourceSku: "Y3-30YC-UORU",
  sourceAsin: "B0HGDZNVQN",
  productType: "NOTEBOOK_COMPUTER",
  targetChildSku: "latitude5330-i5-12g-16gb-ssd512",
  sourceStorageGB: 256,
  targetStorageGB: 512,
  titleTokens: ["Latitude", "5330", "1245U", "16GB"],
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function compact(value, max = 600) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "").slice(0, max);
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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getLwaAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");

  const response = await fetchWithTimeout("https://api.amazon.com/auth/o2/token", {
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
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status} ${compact(json)}`);
  return json.access_token;
}

async function amazonRequest(url, accessToken) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const text = await response.text();
  return { httpStatus: response.status, responseOk: response.ok, body: safeJsonParse(text) };
}

async function getListing(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(GUARD.sourceSku)}?${query}`;
  const result = await amazonRequest(url, accessToken);
  if (!result.responseOk) throw new Error(`GUARD_BLOCKED: source listing GET HTTP ${result.httpStatus} ${compact(result.body, 1200)}`);
  return result.body;
}

function firstValue(attributes, name) {
  return attributes?.[name]?.[0]?.value;
}

function nestedValue(attributes, name, outerKey, innerKey = "value") {
  return attributes?.[name]?.[0]?.[outerKey]?.[0]?.[innerKey];
}

function inspectSourceListing(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const fulfillment = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [];
  const title = String(summary?.itemName || firstValue(attributes, "item_name") || "");
  const qty = fulfillment.reduce((sum, row) => {
    const n = Number(row?.quantity);
    return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
  }, 0);

  if (String(listing?.sku || "") !== GUARD.sourceSku) throw new Error("GUARD_BLOCKED: source SKU mismatch");
  if (String(summary?.asin || "") !== GUARD.sourceAsin) throw new Error("GUARD_BLOCKED: source ASIN mismatch");
  if (String(summary?.productType || "") !== GUARD.productType) throw new Error("GUARD_BLOCKED: source productType mismatch");
  for (const token of GUARD.titleTokens) {
    if (!title.toUpperCase().includes(token.toUpperCase())) throw new Error(`GUARD_BLOCKED: source title token missing ${token}`);
  }

  const relationKeys = Object.keys(attributes).filter(k => /(variation|parent|child|relationship|theme)/i.test(k)).sort();
  const storageKeys = Object.keys(attributes).filter(k => /(hard_disk|flash_memory|storage|solid_state|memory)/i.test(k)).sort();

  return {
    sku: GUARD.sourceSku,
    asin: GUARD.sourceAsin,
    productType: GUARD.productType,
    title,
    availableQuantity: qty,
    issueCodes: issues.map(x => String(x?.code || "")).filter(Boolean),
    relationAttributeKeys: relationKeys,
    storageAttributeKeys: storageKeys,
    storageSnapshot: {
      hardDisk: attributes.hard_disk || null,
      flashMemory: attributes.flash_memory || null,
      solidStateStorageDriveCapacity: attributes.solid_state_storage_drive_capacity || null,
      digitalStorageCapacity: attributes.digital_storage_capacity || null,
    },
    operatingSystem: firstValue(attributes, "operating_system") || "",
    ramInstalledGB: nestedValue(attributes, "ram_memory", "installed_size") ?? null,
  };
}

async function getProductTypeDefinition(accessToken) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    sellerId,
    marketplaceIds: marketplaceId,
    requirements: "LISTING",
    requirementsEnforced: "ENFORCED",
    locale: "ja_JP",
  });
  const url = `${endpoint}/definitions/2020-09-01/productTypes/${encodeURIComponent(GUARD.productType)}?${query}`;
  const result = await amazonRequest(url, accessToken);
  if (!result.responseOk) throw new Error(`PTD_GET_FAILED: HTTP ${result.httpStatus} ${compact(result.body, 1600)}`);
  return { httpStatus: result.httpStatus, body: result.body };
}

async function fetchSchema(definition) {
  const resource = String(definition?.schema?.link?.resource || "").trim();
  if (!resource) throw new Error("PTD_SCHEMA_LINK_MISSING");
  const response = await fetchWithTimeout(resource, { method: "GET", headers: { accept: "application/json" } });
  const text = await response.text();
  const body = safeJsonParse(text);
  if (!response.ok || !body || typeof body !== "object") throw new Error(`PTD_SCHEMA_FETCH_FAILED: HTTP ${response.status} ${compact(body, 1200)}`);
  return { httpStatus: response.status, resource, body };
}

function summarizeSpec(name, path, spec) {
  const out = { name, path };
  if (spec && typeof spec === "object") {
    if (spec.type !== undefined) out.type = spec.type;
    if (spec.title !== undefined) out.title = compact(spec.title, 180);
    if (spec.description !== undefined) out.description = compact(spec.description, 350);
    if (Array.isArray(spec.enum)) out.enum = spec.enum.slice(0, 50);
    if (spec.const !== undefined) out.const = spec.const;
    if (spec.minItems !== undefined) out.minItems = spec.minItems;
    if (spec.maxItems !== undefined) out.maxItems = spec.maxItems;
    if (Array.isArray(spec.required)) out.required = spec.required.slice(0, 50);
    if (spec.$ref !== undefined) out.$ref = spec.$ref;
    if (spec.items && typeof spec.items === "object") {
      if (spec.items.$ref) out.itemsRef = spec.items.$ref;
      if (Array.isArray(spec.items.required)) out.itemRequired = spec.items.required.slice(0, 50);
      if (spec.items.properties && typeof spec.items.properties === "object") {
        out.itemPropertyNames = Object.keys(spec.items.properties).slice(0, 80);
      }
    }
  }
  return out;
}

function discoverSchema(schema) {
  const relationRegex = /(variation|parent|child|relationship|theme)/i;
  const storageRegex = /(hard_disk|flash_memory|storage|solid_state|capacity)/i;
  const relation = [];
  const storage = [];
  const seen = new Set();

  function walk(node, path, depth) {
    if (!node || typeof node !== "object" || depth > 18) return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      return;
    }

    if (node.properties && typeof node.properties === "object") {
      for (const [name, spec] of Object.entries(node.properties)) {
        const p = `${path}.properties.${name}`;
        const key = `${p}|${name}`;
        if (!seen.has(key)) {
          if (relationRegex.test(name)) relation.push(summarizeSpec(name, p, spec));
          if (storageRegex.test(name)) storage.push(summarizeSpec(name, p, spec));
          seen.add(key);
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "properties") continue;
      if (value && typeof value === "object") walk(value, `${path}.${key}`, depth + 1);
    }
  }

  walk(schema, "$", 0);
  return {
    relationProperties: relation.slice(0, 200),
    storageProperties: storage.slice(0, 200),
    relationPropertyNames: [...new Set(relation.map(x => x.name))].sort(),
    storagePropertyNames: [...new Set(storage.map(x => x.name))].sort(),
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, readOnly: true, externalChanges: 0, error: "Unauthorized" });
    if (req.body?.dryRun === false) throw new Error("LIVE is intentionally disabled on this route");

    const requestedSource = String(req.body?.sourceSku || GUARD.sourceSku).trim();
    const requestedChild = String(req.body?.targetChildSku || GUARD.targetChildSku).trim();
    if (requestedSource !== GUARD.sourceSku) throw new Error("GUARD_BLOCKED: unexpected source SKU");
    if (requestedChild !== GUARD.targetChildSku) throw new Error("GUARD_BLOCKED: unexpected target child SKU");

    const accessToken = await getLwaAccessToken();
    const sourceListing = inspectSourceListing(await getListing(accessToken));
    const definitionRaw = await getProductTypeDefinition(accessToken);
    const schemaRaw = await fetchSchema(definitionRaw.body);
    const discovery = discoverSchema(schemaRaw.body);

    const relationNames = discovery.relationPropertyNames;
    const candidateNames = relationNames.filter(name => /(parent|child|relationship|variation|theme)/i.test(name));

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      externalChanges: 0,
      targetPlan: {
        sourceSku: GUARD.sourceSku,
        sourceAsin: GUARD.sourceAsin,
        targetChildSku: GUARD.targetChildSku,
        sourceStorageGB: GUARD.sourceStorageGB,
        targetStorageGB: GUARD.targetStorageGB,
        productType: GUARD.productType,
      },
      sourceListing,
      productTypeDefinition: {
        httpStatus: definitionRaw.httpStatus,
        productType: String(definitionRaw.body?.productType || ""),
        displayName: String(definitionRaw.body?.displayName || ""),
        marketplaceIds: Array.isArray(definitionRaw.body?.marketplaceIds) ? definitionRaw.body.marketplaceIds : [],
        requirements: String(definitionRaw.body?.requirements || ""),
        requirementsEnforced: String(definitionRaw.body?.requirementsEnforced || ""),
        schemaHttpStatus: schemaRaw.httpStatus,
        schemaResourceHost: (() => { try { return new URL(schemaRaw.resource).host; } catch { return ""; } })(),
      },
      discovery,
      decision: candidateNames.length ? "RELATION_SCHEMA_CANDIDATES_FOUND" : "RELATION_SCHEMA_NOT_FOUND__STOP",
      next: candidateNames.length ? "Build exact target-only Listings VALIDATION_PREVIEW for parent + 256 child relation + 512 child." : "Do not create variation. Review Product Type Definition schema result.",
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

express.application.listen = function latitude5330VariationDiscoveryListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
