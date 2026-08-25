import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-latitude5330-listing-preview-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-preview";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "Y3-30YC-UORU",
  asin: "B0HGDZNVQN",
  productType: "NOTEBOOK_COMPUTER",
  title: "【整備済み品】デル Latitude 5330 13.3型 i5-1245U 16GB SSD256GB Win11 Pro ノートン・Office付",
  brand: "MTD",
  manufacturer: "MTD",
  modelName: "Latitude 5330",
  cpuFamily: "core_i5_1245u",
  cpuModelNumber: "1245U",
});

const TARGET = Object.freeze({
  cpuSpeedGHz: 1.6,
  displayInches: 13.3,
  displayType: "LED",
  ramInstalledGB: 16,
  ramMaximumGB: 32,
  ramTechnology: "DDR4",
  processorCount: 10,
  modelYear: 2022,
  resolution: "1920 x 1080",
  graphics: "Intel Iris Xe Graphics",
  hardDiskSizeGB: 256,
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
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
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

function firstValue(attributes, name) {
  return attributes?.[name]?.[0]?.value;
}

function nestedValue(attributes, attributeName, outerKey, innerKey = "value") {
  return attributes?.[attributeName]?.[0]?.[outerKey]?.[0]?.[innerKey];
}

function assertEqual(label, actual, expected) {
  if (String(actual ?? "") !== String(expected ?? "")) {
    throw new Error(`SOURCE_DRIFT: ${label} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

function assertNumber(label, actual, expected, tolerance = 0.0001) {
  const a = Number(actual);
  const e = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(e) || Math.abs(a - e) > tolerance) {
    throw new Error(`SOURCE_DRIFT: ${label} expected=${expected} actual=${actual}`);
  }
}

function assertIdentityAndSource(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};

  assertEqual("asin", summary?.asin, GUARD.asin);
  assertEqual("productType", summary?.productType, GUARD.productType);
  assertEqual("item_name", firstValue(attributes, "item_name"), GUARD.title);
  assertEqual("brand", firstValue(attributes, "brand"), GUARD.brand);
  assertEqual("manufacturer", firstValue(attributes, "manufacturer"), GUARD.manufacturer);
  assertEqual("model_name", firstValue(attributes, "model_name"), GUARD.modelName);
  assertEqual("cpu.family", nestedValue(attributes, "cpu_model", "family"), GUARD.cpuFamily);
  assertEqual("cpu.model_number", nestedValue(attributes, "cpu_model", "model_number"), GUARD.cpuModelNumber);

  // Known source-state values from the fresh inspector. Preview fails closed if Seller Central changes underneath us.
  assertNumber("cpu.speed", nestedValue(attributes, "cpu_model", "speed"), 2.21);
  assertNumber("display.size", nestedValue(attributes, "display", "size"), 12.1);
  assertNumber("ram.installed_size", nestedValue(attributes, "ram_memory", "installed_size"), 8);
  assertNumber("ram.maximum_size", nestedValue(attributes, "ram_memory", "maximum_size"), 8);
  assertEqual("ram.technology", nestedValue(attributes, "ram_memory", "technology"), "LPDDR4");
  assertNumber("processor_count", firstValue(attributes, "processor_count"), 2);
  assertNumber("model_year", firstValue(attributes, "model_year"), 2025);
  assertEqual("resolution", firstValue(attributes, "resolution"), "1080p");
  assertEqual("graphics_coprocessor", firstValue(attributes, "graphics_coprocessor"), "Intel UHD Graphics");

  // Values that must remain untouched by this preview.
  assertNumber("flash_memory.installed_size", nestedValue(attributes, "flash_memory", "installed_size"), 256);
  assertEqual("operating_system", firstValue(attributes, "operating_system"), "Windows 11 Pro");
  assertNumber("battery.weight", nestedValue(attributes, "battery", "weight"), 230);
  assertNumber("lithium_battery.energy_content", nestedValue(attributes, "lithium_battery", "energy_content"), 58);
  assertNumber("number_of_lithium_ion_cells", firstValue(attributes, "number_of_lithium_ion_cells"), 4);
  assertEqual("contains_battery_or_cell", firstValue(attributes, "contains_battery_or_cell"), "battery");

  const hazmatRows = Array.isArray(attributes?.hazmat) ? attributes.hazmat : [];
  const unRow = hazmatRows.find(row => String(row?.aspect || "") === "united_nations_regulatory_id");
  assertEqual("hazmat.UN", unRow?.value, "UN3481");

  return { summary, attributes };
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

  const cpu = requireArrayAttribute(attributes, "cpu_model");
  const liveFamily = String(cpu?.[0]?.family?.[0]?.value || "");
  if (liveFamily !== GUARD.cpuFamily) throw new Error(`CPU_FAMILY_DRIFT: expected ${GUARD.cpuFamily}, got ${liveFamily || "(missing)"}`);
  setNestedFirst(cpu[0], "manufacturer", "value", "Intel");
  setNestedFirst(cpu[0], "model_number", "value", GUARD.cpuModelNumber);
  setNestedFirst(cpu[0], "speed", "value", TARGET.cpuSpeedGHz);
  if (cpu[0].speed?.[0]) cpu[0].speed[0].unit = "GHz";
  patches.push({ op: "replace", path: "/attributes/cpu_model", value: cpu });

  const display = requireArrayAttribute(attributes, "display");
  setNestedFirst(display[0], "size", "value", TARGET.displayInches);
  if (display[0].size?.[0]) display[0].size[0].unit = "inches";
  setNestedFirst(display[0], "type", "value", TARGET.displayType);
  patches.push({ op: "replace", path: "/attributes/display", value: display });

  const ram = requireArrayAttribute(attributes, "ram_memory");
  setNestedFirst(ram[0], "installed_size", "value", TARGET.ramInstalledGB);
  if (ram[0].installed_size?.[0]) ram[0].installed_size[0].unit = "GB";
  setNestedFirst(ram[0], "maximum_size", "value", TARGET.ramMaximumGB);
  if (ram[0].maximum_size?.[0]) ram[0].maximum_size[0].unit = "GB";
  setNestedFirst(ram[0], "technology", "value", TARGET.ramTechnology);
  patches.push({ op: "replace", path: "/attributes/ram_memory", value: ram });

  patches.push({ op: "replace", path: "/attributes/processor_count", value: replaceValueAttribute(attributes, "processor_count", TARGET.processorCount) });
  patches.push({ op: "replace", path: "/attributes/model_year", value: replaceValueAttribute(attributes, "model_year", TARGET.modelYear) });
  patches.push({ op: "replace", path: "/attributes/resolution", value: replaceValueAttribute(attributes, "resolution", TARGET.resolution) });
  patches.push({ op: "replace", path: "/attributes/graphics_coprocessor", value: replaceValueAttribute(attributes, "graphics_coprocessor", TARGET.graphics) });

  const hardDisk = requireArrayAttribute(attributes, "hard_disk");
  if (!hardDisk[0] || typeof hardDisk[0] !== "object") throw new Error("Unexpected live shape: hard_disk[0]");
  hardDisk[0].size = [{ unit: "GB", value: TARGET.hardDiskSizeGB }];
  patches.push({ op: "replace", path: "/attributes/hard_disk", value: hardDisk });

  return patches;
}

async function previewPatch(accessToken, sku, patches) {
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
    body: JSON.stringify({ productType: GUARD.productType, patches }),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return {
    httpStatus: response.status,
    responseOk: response.ok,
    status,
    submissionId: json?.submissionId || "",
    issueCount: issues.length,
    errorCount: errors.length,
    issues,
    valid: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED"),
  };
}

async function handler(req, res) {
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });

    const sku = String(req.body?.sku || "").trim();
    if (sku !== GUARD.sku) throw new Error("GUARD_BLOCKED: unexpected SKU");

    const accessToken = await getLwaAccessToken();
    const listing = await getListing(accessToken, sku);
    const { summary, attributes } = assertIdentityAndSource(listing);
    const patches = buildPatches(attributes);

    const individual = [];
    for (const patch of patches) {
      individual.push({ path: patch.path, ...(await previewPatch(accessToken, sku, [patch])) });
    }
    const combined = await previewPatch(accessToken, sku, patches);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin,
      productType: summary.productType,
      preservedCpuFamily: GUARD.cpuFamily,
      targetTitle: GUARD.title,
      targetFacts: {
        cpu: "Intel Core i5-1245U",
        cpuBaseGHz: TARGET.cpuSpeedGHz,
        cpuMaxGHzReferenceOnly: 4.4,
        processorCoreCount: TARGET.processorCount,
        ramInstalledGB: TARGET.ramInstalledGB,
        ramMaximumGB: TARGET.ramMaximumGB,
        ramTechnology: "DDR4-3200",
        storage: "256GB SSD PCIe NVMe",
        hardDiskSizeAddedGB: TARGET.hardDiskSizeGB,
        operatingSystem: "Windows 11 Pro (left unchanged)",
        display: "13.3 inch FHD LED",
        resolution: TARGET.resolution,
        graphics: TARGET.graphics,
        modelYear: TARGET.modelYear,
        battery: "58Wh / 4-cell lithium-ion / UN3481 (left unchanged)",
        itemDisplayWeight: "980g live value intentionally left unchanged pending physical confirmation",
      },
      individual,
      combined,
      externalChanges: 0,
    });
  } catch (err) {
    console.error("Latitude 5330 listing preview error", err?.message || String(err));
    return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, externalChanges: 0, error: err?.message || String(err) });
  }
}

express.application.listen = function latitude5330ListingPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
