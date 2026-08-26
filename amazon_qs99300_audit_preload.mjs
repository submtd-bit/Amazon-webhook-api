import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-26-amazon-qs99300-audit-v1.0.0";
const ROUTE = "/amazon/listing/qs99300-audit";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "QS-PTMS-QOU0",
  asin: "B0D4LDW2TF",
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

function normalizeTextRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => ({
    index,
    value: row?.value ?? null,
    length: row?.value == null ? null : [...String(row.value)].length,
    language_tag: row?.language_tag || "",
    marketplace_id: row?.marketplace_id || "",
    raw: row,
  }));
}

function detectSignals(value) {
  const text = String(value || "");
  const patterns = [
    { key: "URL", re: /https?:\/\/|www\./i },
    { key: "WARRANTY_OR_GUARANTEE", re: /保証|guarantee|warranty/i },
    { key: "PROMOTIONAL", re: /送料無料|最安|激安|限定|セール|お得|キャンペーン|特価|爆速|高セキュリティ|MAR認証|付属|プレゼント/i },
    { key: "CONTACT_OR_EXTERNAL", re: /LINE|メール|電話|お問い合わせ|公式サイト|ホームページ/i },
  ];
  return patterns.filter(p => p.re.test(text)).map(p => p.key);
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
    const issues = Array.isArray(listing?.issues) ? listing.issues : [];
    const bullets = normalizeTextRows(attributes.bullet_point).map(row => ({
      ...row,
      signals: detectSignals(row.value),
    }));
    const issue99300 = issues.filter(issue => String(issue?.code || "") === "99300");
    const image100238 = issues.filter(issue => String(issue?.code || "") === "100238");

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      sku,
      asin: summary.asin,
      productType: summary.productType,
      status: Array.isArray(summary.status) ? summary.status : [],
      title: summary.itemName || "",
      bulletPointCount: bullets.length,
      bulletPoints: bullets,
      issue99300,
      image100238,
      issueCount: issues.length,
      issues,
      targetImageAttributes: {
        other_product_image_locator_1: Array.isArray(attributes.other_product_image_locator_1) ? attributes.other_product_image_locator_1 : [],
        other_product_image_locator_6: Array.isArray(attributes.other_product_image_locator_6) ? attributes.other_product_image_locator_6 : [],
      },
      externalChanges: 0,
      readOnly: true,
    });
  } catch (err) {
    console.error("Amazon QS 99300 audit error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err),
    });
  }
}

express.application.listen = function amazonQs99300AuditListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
