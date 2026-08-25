import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-s73-cpu-enum-preview-v1.0.0";
const ROUTE = "/amazon/listing/s73-cpu-enum-preview";
const REQUEST_TIMEOUT_MS = 25000;
const PREVIEW_GAP_MS = 1050;
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

async function fetchWithTimeout(url, options = {}) {
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

async function getProductTypeDefinition(accessToken, productType) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    sellerId,
    productTypeVersion: "LATEST",
    requirements: "LISTING",
    requirementsEnforced: "ENFORCED",
    locale: "ja_JP",
  });
  const url = `${endpoint}/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, accept: "application/json" },
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`PTD GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function getSchema(ptd) {
  const link = String(ptd?.schema?.link || "").trim();
  if (!link) throw new Error("PTD schema.link is missing");
  const response = await fetchWithTimeout(link, { method: "GET", headers: { accept: "application/json" } });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`PTD schema fetch error: ${response.status}`);
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

function collectEnums(node, path = "$", out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectEnums(value, `${path}[${index}]`, out));
    return out;
  }
  if (Array.isArray(node.enum)) {
    out.push({ path, values: node.enum, enumNames: Array.isArray(node.enumNames) ? node.enumNames : [] });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" || key === "enumNames") continue;
    collectEnums(value, `${path}.${key}`, out);
  }
  return out;
}

function normalize(v) {
  return String(v || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function cpuEnumMatches(enumRecords) {
  const rows = [];
  for (const record of enumRecords) {
    const pathLower = record.path.toLowerCase();
    record.values.forEach((value, index) => {
      if (typeof value !== "string") return;
      const n = normalize(value);
      const likelyCpu = /cpu|processor/.test(pathLower) || /core_i[3579]|ryzen|celeron|pentium/.test(n);
      if (!likelyCpu) return;
      if (!/core_i5|i5|1135/.test(n)) return;
      rows.push({
        value,
        enumName: record.enumNames[index] || "",
        path: record.path,
      });
    });
  }
  const unique = new Map();
  rows.forEach(row => {
    if (!unique.has(String(row.value))) unique.set(String(row.value), row);
  });
  return [...unique.values()];
}

function candidateScore(value) {
  const n = normalize(value);
  if (n === "core_i5_1135g7") return 1000;
  if (n.includes("1135g7") || n.includes("1135")) return 900;
  if (n === "core_i5") return 800;
  if (n.includes("core_i5") && /(11th|11_gen|11th_gen|11世代)/.test(n)) return 700;
  if (n.includes("core_i5") && !/\d{4,5}[a-z]/.test(n)) return 600;
  return 0;
}

function rankCpuCandidates(matches) {
  return matches
    .map(row => ({ ...row, score: candidateScore(row.value) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.value).localeCompare(String(b.value)))
    .slice(0, 12);
}

function buildCpuPatch(attributes, familyValue, omitFamily = false) {
  const cpu = requireArrayAttribute(attributes, "cpu_model");
  if (omitFamily) {
    delete cpu[0].family;
  } else {
    setNestedFirst(cpu[0], "family", "value", familyValue);
  }
  setNestedFirst(cpu[0], "manufacturer", "value", "Intel");
  setNestedFirst(cpu[0], "model_number", "value", "1135G7");
  setNestedFirst(cpu[0], "speed", "value", 2.4);
  if (cpu[0].speed?.[0]) cpu[0].speed[0].unit = "GHz";
  return { op: "replace", path: "/attributes/cpu_model", value: cpu };
}

function buildOtherPatches(attributes) {
  const patches = [];

  patches.push({
    op: "replace",
    path: "/attributes/item_name",
    value: replaceValueAttribute(attributes, "item_name", GUARD.title),
  });

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

  patches.push({ op: "replace", path: "/attributes/processor_count", value: replaceValueAttribute(attributes, "processor_count", 4) });
  patches.push({ op: "replace", path: "/attributes/model_year", value: replaceValueAttribute(attributes, "model_year", 2021) });
  patches.push({ op: "replace", path: "/attributes/resolution", value: replaceValueAttribute(attributes, "resolution", "1920 x 1080") });
  patches.push({ op: "replace", path: "/attributes/graphics_coprocessor", value: replaceValueAttribute(attributes, "graphics_coprocessor", "Intel Iris Xe Graphics") });

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
    const ptd = await getProductTypeDefinition(accessToken, GUARD.productType);
    const schema = await getSchema(ptd);
    const enumRecords = collectEnums(schema);
    const matches = cpuEnumMatches(enumRecords);
    const candidates = rankCpuCandidates(matches);

    const attempts = [];
    let selectedCpu = null;
    let selectedPatch = null;

    for (const candidate of candidates) {
      const patch = buildCpuPatch(attributes, candidate.value, false);
      const result = await previewPatch(accessToken, sku, GUARD.productType, [patch]);
      attempts.push({ strategy: "schema_enum", familyValue: candidate.value, enumName: candidate.enumName, schemaPath: candidate.path, ...result });
      if (result.valid) {
        selectedCpu = { strategy: "schema_enum", familyValue: candidate.value, enumName: candidate.enumName, schemaPath: candidate.path, submissionId: result.submissionId };
        selectedPatch = patch;
        break;
      }
      await sleep(PREVIEW_GAP_MS);
    }

    if (!selectedPatch) {
      const patch = buildCpuPatch(attributes, null, true);
      const result = await previewPatch(accessToken, sku, GUARD.productType, [patch]);
      attempts.push({ strategy: "omit_family", familyValue: null, enumName: "", schemaPath: "", ...result });
      if (result.valid) {
        selectedCpu = { strategy: "omit_family", familyValue: null, enumName: "", schemaPath: "", submissionId: result.submissionId };
        selectedPatch = patch;
      }
    }

    let combined = null;
    if (selectedPatch) {
      const patches = [selectedPatch, ...buildOtherPatches(attributes)];
      combined = await previewPatch(accessToken, sku, GUARD.productType, patches);
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin,
      productType: summary.productType,
      ptd: {
        productType: ptd?.productType || "",
        displayName: ptd?.displayName || "",
        requirements: ptd?.requirements || "",
        requirementsEnforced: ptd?.requirementsEnforced || "",
        locale: ptd?.locale || "",
        productTypeVersion: ptd?.productTypeVersion || {},
        schemaChecksum: ptd?.schema?.checksum || "",
      },
      currentCpu: attributes.cpu_model || [],
      cpuSchemaMatches: matches.slice(0, 50),
      rankedCpuCandidates: candidates,
      cpuAttempts: attempts,
      selectedCpu,
      combined,
      targetFacts: {
        cpuManufacturer: "Intel",
        cpuModelNumber: "1135G7",
        cpuBaseGHz: 2.4,
        title: GUARD.title,
        displayInches: 13.3,
        ramInstalledGB: 16,
        ramMaximumGB: 24,
        ramTechnology: "DDR4",
        processorCount: 4,
        modelYear: 2021,
        resolution: "1920 x 1080",
        graphics: "Intel Iris Xe Graphics",
      },
      externalChanges: 0,
    });
  } catch (err) {
    console.error("S73 CPU enum preview error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function s73CpuEnumPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
