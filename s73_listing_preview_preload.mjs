import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-s73-listing-preview-v1.0.0";
const ROUTE = "/amazon/listing/s73-preview";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "7X-725F-2ZML",
  asin: "B0HGDBYRS8",
  productType: "NOTEBOOK_COMPUTER",
  title: "【整備済み品】ダイナブック S73/HS 13.3型 i5-1135G7 16GB SSD256GB Win11 Pro ノートン・Office付",
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

async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues",
    issueLocale: "ja_JP",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireArrayAttribute(attributes, name) {
  const value = attributes?.[name];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Missing live attribute shape: ${name}`);
  return cloneJson(value);
}

function setNestedFirst(entry, outerKey, innerKey, value) {
  if (!Array.isArray(entry?.[outerKey]) || !entry[outerKey][0] || typeof entry[outerKey][0] !== "object") {
    throw new Error(`Unexpected live shape: ${outerKey}.${innerKey}`);
  }
  entry[outerKey][0][innerKey] = value;
}

function replaceValueAttribute(attributes, name, value) {
  const rows = requireArrayAttribute(attributes, name);
  if (!Object.prototype.hasOwnProperty.call(rows[0], "value")) throw new Error(`Unexpected live shape: ${name}.value`);
  rows[0].value = value;
  return rows;
}

function buildPatches(attributes) {
  const patches = [];

  const title = replaceValueAttribute(attributes, "item_name", GUARD.title);
  patches.push({ op: "replace", path: "/attributes/item_name", value: title });

  const cpu = requireArrayAttribute(attributes, "cpu_model");
  setNestedFirst(cpu[0], "family", "value", "core_i5_1135g7");
  setNestedFirst(cpu[0], "manufacturer", "value", "Intel");
  setNestedFirst(cpu[0], "model_number", "value", "1135G7");
  setNestedFirst(cpu[0], "speed", "value", 2.4);
  if (cpu[0].speed?.[0]) cpu[0].speed[0].unit = "GHz";
  patches.push({ op: "replace", path: "/attributes/cpu_model", value: cpu });

  const display = requireArrayAttribute(attributes, "display");
  setNestedFirst(display[0], "size", "value", 13.3);
  if (display[0].size?.[0]) display[0].size[0].unit = "inches";
  setNestedFirst(display[0], "type", "value", "LED");
  patches.push({ op: "replace", path: "/attributes/display", value: display });

  const ram = requireArrayAttribute(attributes, "ram_memory");
  setNestedFirst(ram[0], "installed_size", "value", 16);
  if (ram[0].installed_size?.[0]) ram[0].installed_size[0].unit = "GB";
  setNestedFirst(ram[0], "maximum_size", "value", 24);
  if (ram[0].maximum_size?.[0]) ram[0].maximum_size[0].unit = "GB";
  setNestedFirst(ram[0], "technology", "value", "DDR4");
  patches.push({ op: "replace", path: "/attributes/ram_memory", value: ram });

  patches.push({
    op: "replace",
    path: "/attributes/processor_count",
    value: replaceValueAttribute(attributes, "processor_count", 4),
  });

  patches.push({
    op: "replace",
    path: "/attributes/model_year",
    value: replaceValueAttribute(attributes, "model_year", 2021),
  });

  patches.push({
    op: "replace",
    path: "/attributes/resolution",
    value: replaceValueAttribute(attributes, "resolution", "1920 x 1080"),
  });

  const graphics = replaceValueAttribute(attributes, "graphics_coprocessor", "Intel Iris Xe Graphics");
  patches.push({ op: "replace", path: "/attributes/graphics_coprocessor", value: graphics });

  return patches;
}

async function previewPatch(accessToken, sku, productType, patches) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
    mode: "VALIDATION_PREVIEW",
  });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ productType, patches }),
  });
  const json = safeJsonParse(await response.text());
  return { httpStatus: response.status, responseOk: response.ok, json };
}

function summarizePreview(result) {
  const issues = Array.isArray(result?.json?.issues) ? result.json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(result?.json?.status || "").toUpperCase();
  return {
    httpStatus: result.httpStatus,
    responseOk: result.responseOk,
    status,
    submissionId: result?.json?.submissionId || "",
    issueCount: issues.length,
    errorCount: errors.length,
    issues,
    valid: result.responseOk && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    if (sku !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    if (String(summary?.asin || "") !== GUARD.asin) throw new Error("GUARD_BLOCKED: ASIN mismatch");
    if (String(summary?.productType || "") !== GUARD.productType) throw new Error("GUARD_BLOCKED: productType mismatch");

    const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
    const patches = buildPatches(attributes);

    const individual = [];
    for (const patch of patches) {
      const result = await previewPatch(accessToken, sku, GUARD.productType, [patch]);
      individual.push({ path: patch.path, ...summarizePreview(result) });
    }

    const combinedResult = await previewPatch(accessToken, sku, GUARD.productType, patches);
    const combined = summarizePreview(combinedResult);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin,
      productType: summary.productType,
      targetTitle: GUARD.title,
      targetTitleLength: [...GUARD.title].length,
      targetFacts: {
        cpu: "Intel Core i5-1135G7",
        cpuBaseGHz: 2.4,
        cpuMaxGHzReferenceOnly: 4.2,
        processorCoreCount: 4,
        ramInstalledGB: 16,
        ramMaximumGB: 24,
        ramTechnology: "DDR4-3200 / PC4-25600",
        storage: "256GB SSD PCIe NVMe (left unchanged because live value is already correct)",
        operatingSystem: "Windows 11 Pro (left unchanged because live value is already correct)",
        display: "13.3 inch FHD LED",
        resolution: "1920 x 1080",
        graphics: "Intel Iris Xe Graphics",
        modelYear: 2021,
      },
      individual,
      combined,
      externalChanges: 0,
    });
  } catch (err) {
    console.error("S73 listing preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function s73ListingPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
