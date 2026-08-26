import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-latitude5330-chassis-live-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-chassis-live";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_GAP_MS = 2500;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "Y3-30YC-UORU",
  asin: "B0HGDZNVQN",
  productType: "NOTEBOOK_COMPUTER",
  approvedPreviewSubmissionId: "364addb42b92447a8450211de2fabacd",
  confirmLive: "CONFIRM_LATITUDE5330_CHASSIS_B0HGDZNVQN_20260826",
  title: "【整備済み品】デル Latitude 5330 13.3型 i5-1245U 16GB SSD256GB Win11 Pro ノートン・Office付",
  brand: "MTD",
  manufacturer: "MTD",
  modelName: "Latitude 5330",
  conditionType: "new_new",
  source: Object.freeze({
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
  }),
});

const TARGET = Object.freeze({
  lengthCm: 30.57,
  widthCm: 20.75,
  thicknessCm: 1.843,
  weightGrams: 1200,
  totalUsbPorts: 4,
  usb2Ports: 0,
  usb3Ports: 2,
});

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
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
function firstValue(attributes, name) { return attributes?.[name]?.[0]?.value; }
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
    if (!row?.[key] || typeof row[key] !== "object" || !Object.prototype.hasOwnProperty.call(row[key], "value")) {
      throw new Error(`Unexpected live shape: item_length_width_thickness.${key}`);
    }
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
async function patchListing(accessToken, sku, patches, preview) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues" });
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
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const dim = attributes?.item_length_width_thickness?.[0] || {};
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const checks = {
    length3057mm: numEq(dim?.length?.value, TARGET.lengthCm),
    width2075mm: numEq(dim?.width?.value, TARGET.widthCm),
    thickness1843mm: numEq(dim?.thickness?.value, TARGET.thicknessCm),
    weight1200g: numEq(firstValue(attributes, "item_display_weight"), TARGET.weightGrams),
    totalUsbPorts4: numEq(firstValue(attributes, "total_usb_ports"), TARGET.totalUsbPorts),
    usb3Ports2: numEq(firstValue(attributes, "total_usb_3_0_ports"), TARGET.usb3Ports),
    usb2PortsStill0: numEq(firstValue(attributes, "total_usb_2_0_ports"), GUARD.source.usb2Ports),
    conditionStillNew: String(firstValue(attributes, "condition_type") || "") === GUARD.conditionType,
    b2cPriceStill59800: numEq(readOfferPrice(listing, "B2C"), GUARD.source.b2cPrice),
    b2bPriceStill56000: numEq(readOfferPrice(listing, "B2B"), GUARD.source.b2bPrice),
    quantityStill0: numEq(readDefaultQuantity(listing), GUARD.source.quantity),
  };
  return {
    verified: Object.values(checks).every(Boolean),
    checks,
    issues,
    snapshot: {
      dimensions: attributes?.item_length_width_thickness || [],
      itemDisplayWeight: attributes?.item_display_weight || [],
      totalUsbPorts: attributes?.total_usb_ports || [],
      totalUsb2Ports: attributes?.total_usb_2_0_ports || [],
      totalUsb3Ports: attributes?.total_usb_3_0_ports || [],
      conditionType: firstValue(attributes, "condition_type"),
      offers: listing?.offers || [],
      fulfillmentAvailability: listing?.fulfillmentAvailability || [],
    },
  };
}
async function handler(req, res) {
  let livePatchSent = false;
  try {
    const secret = getSecret();
    if (!secret) return res.status(500).json({ ok: false, livePatchSent: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    if (String(req.headers["x-api-secret"] || "") !== secret) return res.status(401).json({ ok: false, livePatchSent: false, externalChanges: 0, error: "Unauthorized" });

    const sku = String(req.body?.sku || "").trim();
    const previewSubmissionId = String(req.body?.previewSubmissionId || "").trim();
    const confirmLive = String(req.body?.confirmLive || "").trim();
    if (sku !== GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (previewSubmissionId !== GUARD.approvedPreviewSubmissionId) throw new Error("LIVE_GUARD_BLOCKED: approved preview submission ID mismatch");
    if (confirmLive !== GUARD.confirmLive) throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");

    const accessToken = await getLwaAccessToken();
    const beforeListing = await getListing(accessToken, sku);
    const { summary, attributes } = assertSource(beforeListing);
    const patches = buildPatches(attributes);

    const freshPreview = await patchListing(accessToken, sku, patches, true);
    if (!freshPreview.valid) {
      throw new Error(`LIVE_GUARD_BLOCKED: fresh VALIDATION_PREVIEW failed ${JSON.stringify({ status: freshPreview.status, issues: freshPreview.issues })}`);
    }

    livePatchSent = true;
    const liveResult = await patchListing(accessToken, sku, patches, false);
    if (!liveResult.valid) {
      return res.status(502).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        sku,
        asin: GUARD.asin,
        productType: GUARD.productType,
        approvedPreviewSubmissionId: GUARD.approvedPreviewSubmissionId,
        freshPreview,
        livePatchSent: true,
        livePatchAttempts: 1,
        liveResult,
        postVerified: false,
        verificationPending: true,
        externalChanges: null,
        error: "LIVE_PATCH_RESPONSE_NOT_ACCEPTED_OR_AMBIGUOUS_DO_NOT_RETRY",
      });
    }

    let verification = null;
    const verificationAttempts = [];
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(VERIFY_GAP_MS);
      verification = verifyTarget(await getListing(accessToken, sku));
      verificationAttempts.push({ attempt, verified: verification.verified, checks: verification.checks });
      if (verification.verified) break;
    }

    const postVerified = Boolean(verification?.verified);
    return res.status(200).json({
      ok: postVerified,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin,
      productType: summary.productType,
      approvedPreviewSubmissionId: GUARD.approvedPreviewSubmissionId,
      freshPreview,
      livePatchSent: true,
      livePatchAttempts: 1,
      liveResult,
      postVerified,
      verificationAttempts,
      finalSnapshot: verification?.snapshot || {},
      finalIssues: verification?.issues || [],
      externalChanges: postVerified ? 1 : null,
      verificationPending: !postVerified,
      note: postVerified
        ? "Latitude 5330 chassis dimensions, weight and USB counts updated and verified. Price, quantity, condition and USB2 count stayed unchanged."
        : "LIVE PATCH was accepted once but propagation was not fully verified. Do not retry automatically; perform a read-only audit first.",
    });
  } catch (err) {
    return res.status(livePatchSent ? 502 : 400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      livePatchSent,
      livePatchAttempts: livePatchSent ? 1 : 0,
      verificationPending: livePatchSent,
      externalChanges: livePatchSent ? null : 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function latitude5330ChassisLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
