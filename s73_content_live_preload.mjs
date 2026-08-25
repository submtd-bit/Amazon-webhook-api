import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-s73-content-live-v1.0.0";
const ROUTE = "/amazon/listing/s73-content-live";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 5;
const VERIFY_GAP_MS = 2500;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "7X-725F-2ZML",
  asin: "B0HGDBYRS8",
  productType: "NOTEBOOK_COMPUTER",
  approvedPreviewSubmissionId: "0eb7e44b3e9743f685cfce279fde61fd",
  confirmLive: "CONFIRM_S73_CONTENT_B0HGDBYRS8_20260825",
  title: "【整備済み品】ダイナブック S73/HS 13.3型 i5-1135G7 16GB SSD256GB Win11 Pro ノートン・Office付",
  brand: "MTD",
  manufacturer: "MTD",
  modelName: "S73/HS",
  sourceBullet: "仮",
  sourceDescription: "仮",
  sourceSpecificUse: "エンターテインメント",
  warranty: "自然故障180日間",
});

const TARGET = Object.freeze({
  bulletPoints: [
    "【第11世代Core i5・メモリ16GB】Intel Core i5-1135G7と16GBメモリを搭載。複数のアプリやブラウザを使う日常業務にも対応する、13.3型モバイルノートPCです。",
    "【SSD256GB・Windows 11 Pro】高速な256GB PCIe NVMe SSDとWindows 11 Proを搭載。起動やデータアクセスを軽快にし、ビジネス用途にも使いやすい構成です。",
    "【13.3型フルHD】1920×1080のフルHDディスプレイを搭載。コンパクトな本体で、文書作成・表計算・Web会議・動画視聴など幅広い用途に対応します。",
    "【Office 2024・ノートン360デラックス同梱】Office 2024とノートン360デラックスを同梱。到着後のセットアップ後、仕事や学習、セキュリティ対策に活用できます。",
    "【整備済み・180日保証】専門スタッフが動作確認・クリーニングを実施した整備済み品です。自然故障を対象とした180日間の保証付きです。",
  ],
  description: "MTD整備済みのdynabook S73/HSです。第11世代Intel Core i5-1135G7、メモリ16GB、256GB PCIe NVMe SSD、Windows 11 Proを搭載。13.3型フルHD（1920×1080）ディスプレイ、Webカメラ、Wi-Fiに対応し、文書作成、表計算、Web会議、学習など幅広い用途に適しています。Office 2024とノートン360デラックスを同梱。専門スタッフによる動作確認・クリーニングを行い、自然故障を対象とした180日間の保証を付帯しています。整備済み品のため、外装には使用に伴う擦れや小傷などがある場合があります。",
  specificUse: "ビジネス",
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

function firstValue(attributes, name) {
  return attributes?.[name]?.[0]?.value;
}

function assertEqual(label, actual, expected) {
  if (String(actual ?? "") !== String(expected ?? "")) {
    throw new Error(`CONTENT_SOURCE_DRIFT: ${label} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
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
  assertEqual("bullet_point", firstValue(attributes, "bullet_point"), GUARD.sourceBullet);
  assertEqual("product_description", firstValue(attributes, "product_description"), GUARD.sourceDescription);
  assertEqual("specific_uses_for_product", firstValue(attributes, "specific_uses_for_product"), GUARD.sourceSpecificUse);
  assertEqual("warranty_description", firstValue(attributes, "warranty_description"), GUARD.warranty);

  const included = Array.isArray(attributes?.included_components) ? attributes.included_components.map(row => String(row?.value || "")) : [];
  if (!included.includes("office2024") || !included.includes("ノートン360デラックス")) {
    throw new Error(`CONTENT_SOURCE_DRIFT: included_components unexpected=${JSON.stringify(included)}`);
  }

  const offers = Array.isArray(listing?.offers) ? listing.offers : [];
  const b2c = offers.find(row => row?.offerType === "B2C");
  const b2b = offers.find(row => row?.offerType === "B2B");
  assertEqual("B2C price", b2c?.price?.amount, "58000.0");
  assertEqual("B2B price", b2b?.price?.amount, "52000.0");
  const fulfillment = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [];
  assertEqual("fulfillment quantity", fulfillment?.[0]?.quantity, 0);

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
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const bullets = Array.isArray(attributes?.bullet_point) ? attributes.bullet_point.map(row => String(row?.value || "")) : [];
  const checks = {
    bulletPoints: JSON.stringify(bullets) === JSON.stringify(TARGET.bulletPoints),
    description: String(firstValue(attributes, "product_description") || "") === TARGET.description,
    specificUse: String(firstValue(attributes, "specific_uses_for_product") || "") === TARGET.specificUse,
    brandStillMTD: String(firstValue(attributes, "brand") || "") === GUARD.brand,
    manufacturerStillMTD: String(firstValue(attributes, "manufacturer") || "") === GUARD.manufacturer,
    warrantyStill180Days: String(firstValue(attributes, "warranty_description") || "") === GUARD.warranty,
  };
  return {
    verified: Object.values(checks).every(Boolean),
    checks,
    snapshot: {
      bulletPoints: bullets,
      description: firstValue(attributes, "product_description"),
      specificUse: firstValue(attributes, "specific_uses_for_product"),
      brand: firstValue(attributes, "brand"),
      manufacturer: firstValue(attributes, "manufacturer"),
      warranty: firstValue(attributes, "warranty_description"),
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
    const { attributes } = assertSource(beforeListing);
    const patches = buildPatches(attributes);

    const freshPreview = await patchListing(accessToken, sku, patches, true);
    if (!freshPreview.valid) throw new Error(`LIVE_GUARD_BLOCKED: fresh VALIDATION_PREVIEW failed ${JSON.stringify({ status: freshPreview.status, issues: freshPreview.issues })}`);

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
      asin: GUARD.asin,
      productType: GUARD.productType,
      approvedPreviewSubmissionId: GUARD.approvedPreviewSubmissionId,
      freshPreview,
      livePatchSent: true,
      livePatchAttempts: 1,
      liveResult,
      postVerified,
      verificationAttempts,
      finalSnapshot: verification?.snapshot || {},
      externalChanges: postVerified ? 1 : 0,
      verificationPending: !postVerified,
      note: postVerified ? "S73 sales content updated and verified" : "LIVE PATCH was accepted once, but propagation was not fully visible within the verification window; do not retry LIVE automatically",
    });
  } catch (err) {
    console.error("S73 content live error", err?.message || String(err));
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

express.application.listen = function s73ContentLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
