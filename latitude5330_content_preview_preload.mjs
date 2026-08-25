import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-latitude5330-content-preview-v1.0.0";
const ROUTE = "/amazon/listing/latitude5330-content-preview";
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
  sourceBullet: "仮",
  sourceDescription: "仮",
  sourceSpecificUse: "エンターテインメント",
  warranty: "自然故障180日間",
});

const TARGET = Object.freeze({
  bulletPoints: [
    "【第12世代Core i5・メモリ16GB】Intel Core i5-1245Uと16GB DDR4メモリを搭載。10コアCPUで、複数のアプリやブラウザを使う日常業務にも対応する13.3型モバイルノートPCです。",
    "【SSD256GB・Windows 11 Pro】256GB PCIe NVMe SSDとWindows 11 Proを搭載。起動やデータアクセスを軽快にし、ビジネス用途にも使いやすい構成です。",
    "【13.3型フルHD・Webカメラ】1920×1080のフルHDディスプレイとWebカメラを搭載。文書作成、表計算、Web会議、動画視聴など幅広い用途に対応します。",
    "【Office 2024・ノートン360デラックス同梱】Office 2024とノートン360デラックスを同梱。到着後のセットアップ後、仕事や学習、セキュリティ対策に活用できます。",
    "【整備済み・180日保証】専門スタッフが動作確認・クリーニングを実施した整備済み品です。自然故障を対象とした180日間の保証付きです。",
  ],
  description: "MTD整備済みのDell Latitude 5330です。第12世代Intel Core i5-1245U、メモリ16GB、256GB PCIe NVMe SSD、Windows 11 Proを搭載。13.3型フルHD（1920×1080）ディスプレイ、Webカメラ、Wi-Fiに対応し、文書作成、表計算、Web会議、学習など幅広い用途に適しています。Office 2024とノートン360デラックスを同梱。専門スタッフによる動作確認・クリーニングを行い、自然故障を対象とした180日間の保証を付帯しています。整備済み品のため、外装には使用に伴う擦れや小傷などがある場合があります。",
  specificUse: "ビジネス",
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
  const response = await fetch("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }) });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) throw new Error(`LWA token error: ${response.status}`);
  return json.access_token;
}
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
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
function assertEqual(label, actual, expected) { if (String(actual ?? "") !== String(expected ?? "")) throw new Error(`CONTENT_SOURCE_DRIFT: ${label} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`); }
function assertSource(listing) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  assertEqual("asin", summary?.asin, GUARD.asin);
  assertEqual("productType", summary?.productType, GUARD.productType);
  assertEqual("item_name", firstValue(attributes, "item_name"), GUARD.title);
  assertEqual("brand", firstValue(attributes, "brand"), GUARD.brand);
  assertEqual("manufacturer", firstValue(attributes, "manufacturer"), GUARD.manufacturer);
  assertEqual("model_name", firstValue(attributes, "model_name"), GUARD.modelName);
  assertEqual("bullet_point", firstValue(attributes, "bullet_point"), GUARD.sourceBullet);
  assertEqual("product_description", firstValue(attributes, "product_description"), GUARD.sourceDescription);
  assertEqual("specific_uses_for_product", firstValue(attributes, "specific_uses_for_product"), GUARD.sourceSpecificUse);
  assertEqual("warranty_description", firstValue(attributes, "warranty_description"), GUARD.warranty);
  const included = Array.isArray(attributes?.included_components) ? attributes.included_components.map(row => String(row?.value || "")) : [];
  if (!included.includes("Office2024") || !included.includes("ノートン360デラックス")) throw new Error(`CONTENT_SOURCE_DRIFT: included_components unexpected=${JSON.stringify(included)}`);
  return { summary, attributes };
}
function cloneRowTemplate(attributes, name) {
  const row = attributes?.[name]?.[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Missing live attribute shape: ${name}`);
  return JSON.parse(JSON.stringify(row));
}
function buildValueRows(attributes, name, values) {
  const template = cloneRowTemplate(attributes, name);
  if (!Object.prototype.hasOwnProperty.call(template, "value")) throw new Error(`Unexpected live shape: ${name}.value`);
  return values.map(value => ({ ...template, value }));
}
function buildPatches(attributes) {
  return [
    { op: "replace", path: "/attributes/bullet_point", value: buildValueRows(attributes, "bullet_point", TARGET.bulletPoints) },
    { op: "replace", path: "/attributes/product_description", value: buildValueRows(attributes, "product_description", [TARGET.description]) },
    { op: "replace", path: "/attributes/specific_uses_for_product", value: buildValueRows(attributes, "specific_uses_for_product", [TARGET.specificUse]) },
  ];
}
async function previewPatch(accessToken, sku, patches) {
  const { sellerId, marketplaceId, endpoint } = getConfig();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId, issueLocale: "ja_JP", includedData: "issues", mode: "VALIDATION_PREVIEW" });
  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${query}`;
  const response = await fetchWithTimeout(url, { method: "PATCH", headers: { "x-amz-access-token": accessToken, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ productType: GUARD.productType, patches }) });
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
      target: TARGET,
      targetLengths: { bulletPoints: TARGET.bulletPoints.map(value => [...value].length), description: [...TARGET.description].length, specificUse: [...TARGET.specificUse].length },
      unchanged: { brand: GUARD.brand, manufacturer: GUARD.manufacturer, includedComponents: attributes.included_components || [], warranty: attributes.warranty_description || [], prices: Array.isArray(listing?.offers) ? listing.offers : [], fulfillmentAvailability: Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [] },
      individual,
      combined,
      externalChanges: 0,
    });
  } catch (err) {
    console.error("Latitude 5330 content preview error", err?.message || String(err));
    return res.status(400).json({ ok: false, moduleVersion: MODULE_VERSION, route: ROUTE, externalChanges: 0, error: err?.message || String(err) });
  }
}

express.application.listen = function latitude5330ContentPreviewListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
