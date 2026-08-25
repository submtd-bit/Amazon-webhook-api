import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-latitude5330-listing-live-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-live";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_GAP_MS = 2500;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "Y3-30YC-UORU",
  asin: "B0HGDZNVQN",
  productType: "NOTEBOOK_COMPUTER",
  approvedPreviewSubmissionId: "50fb1b847c154a04a0599709689dc864",
  confirmLive: "CONFIRM_LATITUDE5330_B0HGDZNVQN_20260825",
  source: Object.freeze({
    title: "【整備済み品】デル Latitude 5330 13.3型 i5-1245U 16GB SSD256GB Win11 Pro ノートン・Office付",
    brand: "MTD",
    manufacturer: "MTD",
    modelName: "Latitude 5330",
    conditionType: "new_new",
    cpuFamily: "core_i5_1245u",
    cpuManufacturer: "Intel",
    cpuModelNumber: "1245U",
    cpuSpeedGHz: 2.21,
    displayInches: 12.1,
    displayType: "LED",
    ramInstalledGB: 8,
    ramMaximumGB: 8,
    ramTechnology: "LPDDR4",
    processorCount: 2,
    modelYear: 2025,
    resolution: "1080p",
    graphics: "Intel UHD Graphics",
    b2cPrice: 59800,
    b2bPrice: 56000,
    quantity: 0,
  }),
  target: Object.freeze({
    cpuFamily: "core_i5_1245u",
    cpuManufacturer: "Intel",
    cpuModelNumber: "1245U",
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
  }),
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

function nestedValue(attributes, attributeName, outerKey, innerKey = "value") {
  return attributes?.[attributeName]?.[0]?.[outerKey]?.[0]?.[innerKey];
}

function directValue(attributes, attributeName) {
  return attributes?.[attributeName]?.[0]?.value;
}

function numEq(actual, expected, tolerance = 0.0001) {
  const a = Number(actual);
  const e = Number(expected);
  return Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) <= tolerance;
}

function assertEqual(label, actual, expected) {
  if (String(actual ?? "") !== String(expected ?? "")) {
    throw new Error(`SOURCE_DRIFT: ${label} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

function assertNumber(label, actual, expected) {
  if (!numEq(actual, expected)) {
    throw new Error(`SOURCE_DRIFT: ${label} expected=${expected} actual=${actual}`);
  }
}

function readOfferPrice(listing, offerType) {
  const offer = (Array.isArray(listing?.offers) ? listing.offers : []).find(row => String(row?.offerType || "") === offerType);
  return Number(offer?.price?.amount);
}

function readDefaultQuantity(listing) {
  const row = (Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : []).find(x => String(x?.fulfillmentChannelCode || "") === "DEFAULT");
  return Number(row?.quantity);
}

function assertIdentityAndSource(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  if (String(summary?.asin || "") !== GUARD.asin) throw new Error("SOURCE_DRIFT: ASIN mismatch");
  if (String(summary?.productType || "") !== GUARD.productType) throw new Error("SOURCE_DRIFT: productType mismatch");

  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const s = GUARD.source;

  assertEqual("item_name", directValue(attributes, "item_name"), s.title);
  assertEqual("brand", directValue(attributes, "brand"), s.brand);
  assertEqual("manufacturer", directValue(attributes, "manufacturer"), s.manufacturer);
  assertEqual("model_name", directValue(attributes, "model_name"), s.modelName);
  assertEqual("condition_type", directValue(attributes, "condition_type"), s.conditionType);
  assertEqual("cpu.family", nestedValue(attributes, "cpu_model", "family"), s.cpuFamily);
  assertEqual("cpu.manufacturer", nestedValue(attributes, "cpu_model", "manufacturer"), s.cpuManufacturer);
  assertEqual("cpu.model_number", nestedValue(attributes, "cpu_model", "model_number"), s.cpuModelNumber);
  assertNumber("cpu.speed", nestedValue(attributes, "cpu_model", "speed"), s.cpuSpeedGHz);
  assertNumber("display.size", nestedValue(attributes, "display", "size"), s.displayInches);
  assertEqual("display.type", nestedValue(attributes, "display", "type"), s.displayType);
  assertNumber("ram.installed_size", nestedValue(attributes, "ram_memory", "installed_size"), s.ramInstalledGB);
  assertNumber("ram.maximum_size", nestedValue(attributes, "ram_memory", "maximum_size"), s.ramMaximumGB);
  assertEqual("ram.technology", nestedValue(attributes, "ram_memory", "technology"), s.ramTechnology);
  assertNumber("processor_count", directValue(attributes, "processor_count"), s.processorCount);
  assertNumber("model_year", directValue(attributes, "model_year"), s.modelYear);
  assertEqual("resolution", directValue(attributes, "resolution"), s.resolution);
  assertEqual("graphics_coprocessor", directValue(attributes, "graphics_coprocessor"), s.graphics);

  const hardDisk = attributes?.hard_disk?.[0] || {};
  assertEqual("hard_disk.description", hardDisk?.description?.[0]?.value, "SSD");
  if (Array.isArray(hardDisk?.size) && hardDisk.size.length > 0) {
    throw new Error(`SOURCE_DRIFT: hard_disk.size expected missing actual=${JSON.stringify(hardDisk.size)}`);
  }

  // Important untouched facts.
  assertNumber("flash_memory.installed_size", nestedValue(attributes, "flash_memory", "installed_size"), 256);
  assertEqual("operating_system", directValue(attributes, "operating_system"), "Windows 11 Pro");
  assertNumber("battery.weight", nestedValue(attributes, "battery", "weight"), 230);
  assertNumber("lithium_battery.energy_content", nestedValue(attributes, "lithium_battery", "energy_content"), 58);
  assertNumber("number_of_lithium_ion_cells", directValue(attributes, "number_of_lithium_ion_cells"), 4);
  assertEqual("contains_battery_or_cell", directValue(attributes, "contains_battery_or_cell"), "battery");
  assertEqual("battery_installation_device_type", directValue(attributes, "battery_installation_device_type"), "not_installed");
  assertNumber("item_display_weight", directValue(attributes, "item_display_weight"), 980);

  const hazmatRows = Array.isArray(attributes?.hazmat) ? attributes.hazmat : [];
  const unRow = hazmatRows.find(row => String(row?.aspect || "") === "united_nations_regulatory_id");
  assertEqual("hazmat.UN", unRow?.value, "UN3481");

  assertNumber("B2C price", readOfferPrice(listing, "B2C"), s.b2cPrice);
  assertNumber("B2B price", readOfferPrice(listing, "B2B"), s.b2bPrice);
  assertNumber("DEFAULT quantity", readDefaultQuantity(listing), s.quantity);

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
  const t = GUARD.target;
  const patches = [];

  const cpu = requireArrayAttribute(attributes, "cpu_model");
  assertEqual("cpu.family.before_build", cpu?.[0]?.family?.[0]?.value, t.cpuFamily);
  assertEqual("cpu.model_number.before_build", cpu?.[0]?.model_number?.[0]?.value, t.cpuModelNumber);
  setNestedFirst(cpu[0], "manufacturer", "value", t.cpuManufacturer);
  setNestedFirst(cpu[0], "model_number", "value", t.cpuModelNumber);
  setNestedFirst(cpu[0], "speed", "value", t.cpuSpeedGHz);
  if (cpu[0].speed?.[0]) cpu[0].speed[0].unit = "GHz";
  patches.push({ op: "replace", path: "/attributes/cpu_model", value: cpu });

  const display = requireArrayAttribute(attributes, "display");
  setNestedFirst(display[0], "size", "value", t.displayInches);
  if (display[0].size?.[0]) display[0].size[0].unit = "inches";
  setNestedFirst(display[0], "type", "value", t.displayType);
  patches.push({ op: "replace", path: "/attributes/display", value: display });

  const ram = requireArrayAttribute(attributes, "ram_memory");
  setNestedFirst(ram[0], "installed_size", "value", t.ramInstalledGB);
  if (ram[0].installed_size?.[0]) ram[0].installed_size[0].unit = "GB";
  setNestedFirst(ram[0], "maximum_size", "value", t.ramMaximumGB);
  if (ram[0].maximum_size?.[0]) ram[0].maximum_size[0].unit = "GB";
  setNestedFirst(ram[0], "technology", "value", t.ramTechnology);
  patches.push({ op: "replace", path: "/attributes/ram_memory", value: ram });

  patches.push({ op: "replace", path: "/attributes/processor_count", value: replaceValueAttribute(attributes, "processor_count", t.processorCount) });
  patches.push({ op: "replace", path: "/attributes/model_year", value: replaceValueAttribute(attributes, "model_year", t.modelYear) });
  patches.push({ op: "replace", path: "/attributes/resolution", value: replaceValueAttribute(attributes, "resolution", t.resolution) });
  patches.push({ op: "replace", path: "/attributes/graphics_coprocessor", value: replaceValueAttribute(attributes, "graphics_coprocessor", t.graphics) });

  const hardDisk = requireArrayAttribute(attributes, "hard_disk");
  hardDisk[0].size = [{ unit: "GB", value: t.hardDiskSizeGB }];
  patches.push({ op: "replace", path: "/attributes/hard_disk", value: hardDisk });

  return patches;
}

async function patchListing(accessToken, sku, patches, preview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues",
  });
  if (preview) query.set("mode", "VALIDATION_PREVIEW");

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

function verifyTarget(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const t = GUARD.target;
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const has18448 = issues.some(issue => String(issue?.code || "") === "18448");

  const checks = {
    asin: String(summary?.asin || "") === GUARD.asin,
    productType: String(summary?.productType || "") === GUARD.productType,
    titleUnchanged: String(directValue(attributes, "item_name") || "") === GUARD.source.title,
    brandStillMTD: String(directValue(attributes, "brand") || "") === GUARD.source.brand,
    manufacturerStillMTD: String(directValue(attributes, "manufacturer") || "") === GUARD.source.manufacturer,
    conditionStillNew: String(directValue(attributes, "condition_type") || "") === GUARD.source.conditionType,
    cpuFamily: String(nestedValue(attributes, "cpu_model", "family") || "") === t.cpuFamily,
    cpuManufacturer: String(nestedValue(attributes, "cpu_model", "manufacturer") || "") === t.cpuManufacturer,
    cpuModelNumber: String(nestedValue(attributes, "cpu_model", "model_number") || "") === t.cpuModelNumber,
    cpuSpeed: numEq(nestedValue(attributes, "cpu_model", "speed"), t.cpuSpeedGHz),
    displayInches: numEq(nestedValue(attributes, "display", "size"), t.displayInches),
    displayType: String(nestedValue(attributes, "display", "type") || "") === t.displayType,
    ramInstalled: numEq(nestedValue(attributes, "ram_memory", "installed_size"), t.ramInstalledGB),
    ramMaximum: numEq(nestedValue(attributes, "ram_memory", "maximum_size"), t.ramMaximumGB),
    ramTechnology: String(nestedValue(attributes, "ram_memory", "technology") || "") === t.ramTechnology,
    processorCount: numEq(directValue(attributes, "processor_count"), t.processorCount),
    modelYear: numEq(directValue(attributes, "model_year"), t.modelYear),
    resolution: String(directValue(attributes, "resolution") || "") === t.resolution,
    graphics: String(directValue(attributes, "graphics_coprocessor") || "") === t.graphics,
    hardDiskSize: numEq(nestedValue(attributes, "hard_disk", "size"), t.hardDiskSizeGB),
    storageStill256: numEq(nestedValue(attributes, "flash_memory", "installed_size"), 256),
    osStillWin11Pro: String(directValue(attributes, "operating_system") || "") === "Windows 11 Pro",
    batteryStill58Wh: numEq(nestedValue(attributes, "lithium_battery", "energy_content"), 58),
    cellsStill4: numEq(directValue(attributes, "number_of_lithium_ion_cells"), 4),
    batteryWeightStill230g: numEq(nestedValue(attributes, "battery", "weight"), 230),
    unStill3481: (Array.isArray(attributes?.hazmat) ? attributes.hazmat : []).some(row => String(row?.aspect || "") === "united_nations_regulatory_id" && String(row?.value || "") === "UN3481"),
    itemWeightStill980g: numEq(directValue(attributes, "item_display_weight"), 980),
    b2cPriceStill59800: numEq(readOfferPrice(listing, "B2C"), GUARD.source.b2cPrice),
    b2bPriceStill56000: numEq(readOfferPrice(listing, "B2B"), GUARD.source.b2bPrice),
    quantityStill0: numEq(readDefaultQuantity(listing), GUARD.source.quantity),
    warning18448Cleared: !has18448,
  };

  return {
    checks,
    verified: Object.values(checks).every(Boolean),
    issues,
    snapshot: {
      title: directValue(attributes, "item_name"),
      cpu: attributes.cpu_model || [],
      display: attributes.display || [],
      ram: attributes.ram_memory || [],
      processorCount: directValue(attributes, "processor_count"),
      modelYear: directValue(attributes, "model_year"),
      resolution: directValue(attributes, "resolution"),
      graphics: directValue(attributes, "graphics_coprocessor"),
      hardDisk: attributes.hard_disk || [],
      battery: attributes.battery || [],
      lithiumBattery: attributes.lithium_battery || [],
      itemDisplayWeight: directValue(attributes, "item_display_weight"),
    },
  };
}

async function handler(req, res) {
  let livePatchSent = false;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, livePatchSent: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, livePatchSent: false, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const previewSubmissionId = String(req.body?.previewSubmissionId || "").trim();
    const confirmLive = String(req.body?.confirmLive || "").trim();

    if (sku !== GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (previewSubmissionId !== GUARD.approvedPreviewSubmissionId) throw new Error("LIVE_GUARD_BLOCKED: approved preview submission ID mismatch");
    if (confirmLive !== GUARD.confirmLive) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");

    const accessToken = await getLwaAccessToken();

    const beforeListing = await getListing(accessToken, sku);
    const { attributes } = assertIdentityAndSource(beforeListing);
    const patches = buildPatches(attributes);

    const freshPreview = await patchListing(accessToken, sku, patches, true);
    if (!freshPreview.valid) {
      throw new Error(`LIVE_GUARD_BLOCKED: fresh VALIDATION_PREVIEW failed ${JSON.stringify({ status: freshPreview.status, issues: freshPreview.issues })}`);
    }

    const liveResult = await patchListing(accessToken, sku, patches, false);
    livePatchSent = true;
    if (!liveResult.valid) {
      return res.status(502).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        sku,
        asin: GUARD.asin,
        livePatchSent: true,
        livePatchAttempts: 1,
        freshPreview,
        liveResult,
        postVerified: false,
        externalChanges: 0,
        error: "LIVE_PATCH_RESPONSE_NOT_ACCEPTED",
      });
    }

    const verificationAttempts = [];
    let verification = null;
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(VERIFY_GAP_MS);
      const afterListing = await getListing(accessToken, sku);
      verification = verifyTarget(afterListing);
      verificationAttempts.push({ attempt, verified: verification.verified, checks: verification.checks });
      if (verification.verified) break;
    }

    const postVerified = Boolean(verification?.verified);
    return res.status(200).json({
      ok: postVerified,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: GUARD.asin,
      productType: GUARD.productType,
      approvedPreviewSubmissionId: GUARD.approvedPreviewSubmissionId,
      freshPreview: {
        httpStatus: freshPreview.httpStatus,
        status: freshPreview.status,
        submissionId: freshPreview.submissionId,
        issueCount: freshPreview.issueCount,
        errorCount: freshPreview.errorCount,
        issues: freshPreview.issues,
        valid: freshPreview.valid,
      },
      livePatchSent: true,
      livePatchAttempts: 1,
      liveResult: {
        httpStatus: liveResult.httpStatus,
        status: liveResult.status,
        submissionId: liveResult.submissionId,
        issueCount: liveResult.issueCount,
        errorCount: liveResult.errorCount,
        issues: liveResult.issues,
        valid: liveResult.valid,
      },
      postVerified,
      verificationAttempts,
      finalSnapshot: verification?.snapshot || {},
      finalIssues: verification?.issues || [],
      externalChanges: postVerified ? 1 : 0,
      verificationPending: !postVerified,
      note: postVerified
        ? "Latitude 5330 listing attributes updated and verified"
        : "LIVE PATCH was accepted once, but propagation was not fully visible within the verification window; do not retry LIVE automatically",
    });
  } catch (err) {
    console.error("Latitude 5330 listing live error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      livePatchSent,
      livePatchAttempts: livePatchSent ? 1 : 0,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function latitude5330ListingLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
