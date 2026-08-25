import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-latitude5330-content-audit-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-content-audit";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "Y3-30YC-UORU",
  asin: "B0HGDZNVQN",
  productType: "NOTEBOOK_COMPUTER",
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

function pick(attributes, keys) {
  const out = {};
  for (const key of keys) out[key] = Array.isArray(attributes?.[key]) ? attributes[key] : [];
  return out;
}

function firstValue(rows) {
  return Array.isArray(rows) && rows[0] && Object.prototype.hasOwnProperty.call(rows[0], "value") ? rows[0].value : null;
}

function textValues(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({ value: row?.value ?? null, language_tag: row?.language_tag || "", marketplace_id: row?.marketplace_id || "" }));
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
    const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
    if (String(summary?.asin || "") !== GUARD.asin) throw new Error("GUARD_BLOCKED: ASIN mismatch");
    if (String(summary?.productType || "") !== GUARD.productType) throw new Error("GUARD_BLOCKED: productType mismatch");

    const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
    const issues = Array.isArray(listing?.issues) ? listing.issues : [];
    const contentKeys = [
      "item_name","brand","manufacturer","model_name","bullet_point","product_description","included_components","warranty_description","specific_uses_for_product","connectivity_technology","has_webcam_capability","total_usb_ports","total_usb_2_0_ports","total_usb_3_0_ports","graphics_description","graphics_card_interface","optical_storage","item_length_width_thickness","item_display_weight","country_of_origin","recommended_browse_nodes","condition_type","list_price","purchasable_offer","fulfillment_availability","merchant_shipping_group"
    ];
    const content = pick(attributes, contentKeys);
    const missing = contentKeys.filter(key => !Array.isArray(content[key]) || content[key].length === 0);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin,
      productType: summary.productType,
      status: Array.isArray(summary.status) ? summary.status : [],
      itemNameSummary: summary.itemName || "",
      content,
      quickView: {
        title: firstValue(content.item_name),
        brand: firstValue(content.brand),
        manufacturer: firstValue(content.manufacturer),
        modelName: firstValue(content.model_name),
        bulletPoints: textValues(content.bullet_point),
        productDescription: textValues(content.product_description),
        includedComponents: textValues(content.included_components),
        warranty: textValues(content.warranty_description),
      },
      missingContentKeys: missing,
      issueCount: issues.length,
      errorCount: issues.filter(x => String(x?.severity || "").toUpperCase() === "ERROR").length,
      issues,
      offers: Array.isArray(listing?.offers) ? listing.offers : [],
      fulfillmentAvailability: Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [],
      allAttributeKeys: Object.keys(attributes).sort(),
      externalChanges: 0,
    });
  } catch (err) {
    console.error("Latitude 5330 content audit error", err?.message || String(err));
    return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, externalChanges: 0, error: err?.message || String(err) });
  }
}

express.application.listen = function latitude5330ContentAuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
