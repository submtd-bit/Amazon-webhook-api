import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-latitude5330-chassis-preview-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-chassis-preview";
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
  conditionType: "new_new",
  source: {
    lengthCm: 28.35,
    widthCm: 20.38,
    thicknessCm: 2.45,
    weightGrams: 980,
    totalUsbPorts: 3,
    usb2Ports: 0,
    usb3Ports: 3,
    b2cPrice: 59800,
    b2bPrice: 56000,
    quantity: 0,
  },
});

const TARGET = Object.freeze({
  lengthCm: 30.57,
  widthCm: 20.75,
  thicknessCm: 1.843,
  weightGrams: 1200,
  totalUsbPorts: 4,
  usb2Ports: 0,
  usb3Ports: 2,
  evidence: {
    dimensions: "Dell Latitude 5330 official: width 305.70 mm, depth 207.50 mm, rear height 18.43 mm",
    weight: "Dell Latitude 5330 official minimum laptop weight: 1.20 kg; actual weight varies by configuration",
    usb: "Dell Latitude 5330 official: USB 3.2 Gen 1 x2 + Thunderbolt 4/USB-C/USB4 x2",
  },
});

function safeJsonParse(text) { if (!text) return {}; try { return JSON.parse(text); } catch { return { rawText: text }; } }
function getSecret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }
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
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
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
async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,offers,fulfillmentAvailability", issueLocale: "ja_JP" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, { method: "GET", headers: { "x-amz-access-token": accessToken, accept: "application/json" } });
  const json = safeJsonParse(await response.text());
  if (!response.ok) throw new Error(`SP-API GET error: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
function firstValue(attributes, name) { return attributes?.[name]?.[0]?.value; }
function nestedValue(attributes, attributeName, key) { return attributes?.[attributeName]?.[0]?.[key]?.value ?? attributes?.[attributeName]?.[0]?.[key]?.[0]?.value; }
function numEq(actual, expected, tolerance = 0.0001) {
  const a = Number(actual); const e = Number(expected);
  return Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) <= tolerance;
}
function assertEqual(label, actual, expected) {
  if (String(actual ?? "") !== String(expected ?? "")) throw new Error(`SOURCE_DRIFT: ${label} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}
function assertNumber(label, actual, expected) {
  if (!numEq(actual, expected)) throw new Error(`SOURCE_DRIFT: ${label} expected=${expected} actual=${actual}`);
}
function readOfferPrice(listing, offerType) {
  const row = (Array.isArray(listing?.offers) ? listing.offers : []).find(x => String(x?.offerType || "") === offerType);
  return Number(row?.price?.amount);
}
function readDefaultQuantity(listing) {
  const row = (Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : []).find(x => String(x?.fulfillmentChannelCode || "") === "DEFAULT");
  return Number(row?.quantity);
}
function assertSource(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  assertEqual("asin", summary?.asin, GUARD.asin);
  assertEqual("productType", summary?.productType, GUARD.productType);
  assertEqual("item_name", firstValue(attributes, "item_name"), GUARD.title);
  assertEqual("brand", firstValue(attributes, "brand"), GUARD.brand);
  assertEqual("manufacturer", firstValue(attributes, "manufacturer"), GUARD.manufacturer);
  assertEqual("model_name", firstValue(attributes, "model_name"), GUARD.modelName);
  assertEqual("condition_type", firstValue(attributes, "condition_type"), GUARD.conditionType);
  assertNumber("ram installed", attributes?.ram_memory?.[0]?.installed_size?.[0]?.value, 16);
  assertNumber("flash storage", attributes?.flash_memory?.[0]?.installed_size?.[0]?.value, 256);
  const dim = attributes?.item_length_width_thickness?.[0] || {};
  assertNumber("length", dim?.length?.value, GUARD.source.lengthCm);
  assertNumber("width", dim?.width?.value, GUARD.source.widthCm);
  assertNumber("thickness", dim?.thickness?.value, GUARD.source.thicknessCm);
  assertNumber("item_display_weight", firstValue(attributes, "item_display_weight"), GUARD.source.weightGrams);
  assertNumber("total_usb_ports", firstValue(attributes, "total_usb_ports"), GUARD.source.totalUsbPorts);
  assertNumber("total_usb_2_0_ports", firstValue(attributes, "total_usb_2_0_ports"), GUARD.source.usb2Ports);
  assertNumber("total_usb_3_0_ports", firstValue(attributes, "total_usb_3_0_ports"), GUARD.source.usb3Ports);
  assertNumber("B2C price", readOfferPrice(listing, "B2C"), GUARD.source.b2cPrice);
  assertNumber("B2B price", readOfferPrice(listing, "B2B"), GUARD.source.b2bPrice);
  assertNumber("quantity", readDefaultQuantity(listing), GUARD.source.quantity);
  return { summary, attributes };
}
function cloneRows(attributes, name) {
  const rows = attributes?.[name];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`Missing live attribute shape: ${name}`);
  return JSON.parse(JSON.stringify(rows));
}
function valueRows(attributes, name, value) {
  const rows = cloneRows(attributes, name);
  if (!Object.prototype.hasOwnProperty.call(rows[0], "value")) throw new Error(`Unexpected live shape: ${name}.value`);
  rows[0].value = value;
  return rows;
}
function buildPatches(attributes) {
  const dims = cloneRows(attributes, "item_length_width_thickness");
  const row = dims[0];
  for (const key of ["length", "width", "thickness"]) {
    if (!row?.[key] || typeof row[key] !== "object" || !Object.prototype.hasOwnProperty.call(row[key], "value")) throw new Error(`Unexpected live shape: item_length_width_thickness.${key}`);
    row[key].unit = "centimeters";
  }
  row.length.value = TARGET.lengthCm;
  row.width.value = TARGET.widthCm;
  row.thickness.value = TARGET.thicknessCm;

  const weight = cloneRows(attributes, "item_display_weight");
  weight[0].unit = "grams";
  weight[0].value = TARGET.weightGrams;

  return [
    { op: "replace", path: "/attributes/item_length_width_thickness", value: dims },
    { op: "replace", path: "/attributes/item_display_weight", value: weight },
    { op: "replace", path: "/attributes/total_usb_ports", value: valueRows(attributes, "total_usb_ports", TARGET.totalUsbPorts) },
    { op: "replace", path: "/attributes/total_usb_3_0_ports", value: valueRows(attributes, "total_usb_3_0_ports", TARGET.usb3Ports) },
  ];
}
async function previewPatch(accessToken, sku, patches) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues", mode: "VALIDATION_PREVIEW" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: { "x-amz-access-token": accessToken, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ productType: GUARD.productType, patches }),
  });
  const json = safeJsonParse(await response.text());
  const issues = Array.isArray(json?.issues) ? json.issues : [];
  const errors = issues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");
  const status = String(json?.status || "").toUpperCase();
  return { httpStatus: response.status, responseOk: response.ok, status, submissionId: json?.submissionId || "", issueCount: issues.length, errorCount: errors.length, issues, valid: response.ok && errors.length === 0 && (status === "VALID" || status === "ACCEPTED") };
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
    const { summary, attributes } = assertSource(listing);
    const patches = buildPatches(attributes);
    const individual = [];
    for (const patch of patches) individual.push({ path: patch.path, ...(await previewPatch(accessToken, sku, [patch])) });
    const combined = await previewPatch(accessToken, sku, patches);
    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin,
      productType: summary.productType,
      source: GUARD.source,
      target: TARGET,
      unchanged: {
        conditionType: firstValue(attributes, "condition_type"),
        totalUsb2Ports: firstValue(attributes, "total_usb_2_0_ports"),
        b2cPrice: readOfferPrice(listing, "B2C"),
        b2bPrice: readOfferPrice(listing, "B2B"),
        quantity: readDefaultQuantity(listing),
        issues: Array.isArray(listing?.issues) ? listing.issues : [],
      },
      individual,
      combined,
      externalChanges: 0,
      note: "VALIDATION_PREVIEW only. Weight target uses Dell's official minimum 1.20 kg; actual configured weight may vary.",
    });
  } catch (err) {
    console.error("Latitude 5330 chassis preview error", err?.message || String(err));
    return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, externalChanges: 0, error: err?.message || String(err) });
  }
}

express.application.listen = function latitude5330ChassisPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};