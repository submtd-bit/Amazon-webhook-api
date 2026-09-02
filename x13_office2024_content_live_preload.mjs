import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-02-x13-office2024-content-live-v1.0.0";
const ROUTE = "/amazon/listing/x13-office2024-content-live";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 8;
const VERIFY_GAP_MS = 3000;
const originalListen = express.application.listen;

const GUARD = Object.freeze({
  sku: "NY-G14F-GH8Y",
  asin: "B0FMS8XJ3D",
  productType: "NOTEBOOK_COMPUTER",
  approvedPreviewSubmissionId: "1c55c2a7f79c44dfb5fad4c6fc077371",
  confirmLive: "CONFIRM_X13_CONTENT_B0FMS8XJ3D_20260902",
  title: "【整備済み品】 中古ノートパソコン ThinkPad X13 Gen1 シンクパッド | 中古 PC | 第10世代 Core i5 | メモリ8GB SSD256GB | 13.3インチ | Ｗebカメラ付属 | 無線Wifi USB3.0 | Type-C - HDMI | Win11 pro搭載 | WPS Office2搭載",
  brand: "MTD",
  manufacturer: "MTD",
  modelName: "THINK PAD X13",
  warranty: "Amazon整備済み品180日間保証",
  sourceSoftware: ["WPS Office2", "Security Care+"],
});

const TARGET = Object.freeze({
  title: "【整備済み品】 中古ノートパソコン ThinkPad X13 Gen1 シンクパッド | 中古 PC | 第10世代 Core i5 | メモリ8GB SSD256GB | 13.3インチ | Webカメラ内蔵 | 無線Wifi USB3.0 | Type-C - HDMI | Win11 pro搭載 | MS Office 2024・ノートン360デラックス付属",
  bulletPoints: [
    "【第10世代Core i5・メモリ8GB】インテル Core i5-10310Uと8GBメモリを搭載。Web閲覧、文書作成、表計算、Web会議など日常のビジネス用途に対応するモバイルノートPCです。",
    "【SSD256GB・Windows 11 Pro】256GB SSDとWindows 11 Proを搭載。起動やデータアクセスを軽快にし、仕事や学習用PCとして使いやすい構成です。",
    "【13.3型フルHD・モバイル設計】1920×1080の13.3型フルHDディスプレイを搭載。Webカメラ、Wi-Fi、Bluetooth、USB、Type-C、HDMIに対応しています。",
    "【MS Office 2024・ノートン360デラックス付属】MS Office 2024とノートン360デラックス 1年版を同梱。文書作成・表計算・プレゼン作成やセキュリティ対策に活用できます。",
    "【整備済み・180日保証】専門スタッフが動作確認、初期設定、クリーニングを実施した整備済み品です。自然故障を対象とした180日間の保証付きです。",
  ],
  description: "MTD整備済みのレノボ ThinkPad X13 Gen1です。第10世代インテル Core i5-10310U、メモリ8GB、SSD256GB、Windows 11 Proを搭載。13.3型フルHD（1920×1080）ディスプレイ、Webカメラ、Wi-Fi、Bluetooth、USB、Type-C、HDMIに対応し、文書作成、表計算、Web会議、学習など幅広い用途に適しています。MS Office 2024とノートン360デラックス 1年版を同梱。専門スタッフによる動作確認、初期設定、クリーニングを行い、自然故障を対象とした180日間の保証を付帯しています。整備済み品のため、外装には使用に伴う擦れや小傷などがある場合があります。",
  softwareIncluded: ["MS Office 2024", "ノートン360 デラックス 1年版"],
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

function firstValue(attributes, name) {
  return attributes?.[name]?.[0]?.value;
}

function values(attributes, name) {
  return (Array.isArray(attributes?.[name]) ? attributes[name] : [])
    .map(row => String(row?.value || ""));
}

function normalizedValues(attributes, name) {
  return values(attributes, name).map(v => v.trim()).filter(Boolean).sort();
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
  assertEqual("warranty_description", firstValue(attributes, "warranty_description"), GUARD.warranty);

  const actualSoftware = normalizedValues(attributes, "software_included");
  const expectedSoftware = [...GUARD.sourceSoftware].sort();
  if (JSON.stringify(actualSoftware) !== JSON.stringify(expectedSoftware)) {
    throw new Error(`CONTENT_SOURCE_DRIFT: software_included expected=${JSON.stringify(expectedSoftware)} actual=${JSON.stringify(actualSoftware)}`);
  }

  return { summary, attributes };
}

function cloneRowTemplate(attributes, name) {
  const row = attributes?.[name]?.[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`Missing live attribute shape: ${name}`);
  }
  return JSON.parse(JSON.stringify(row));
}

function buildValueRows(attributes, name, targetValues) {
  const template = cloneRowTemplate(attributes, name);
  if (!Object.prototype.hasOwnProperty.call(template, "value")) {
    throw new Error(`Unexpected live shape: ${name}.value`);
  }
  return targetValues.map(value => ({ ...template, value }));
}

function buildPatches(attributes) {
  return [
    { op: "replace", path: "/attributes/item_name", value: buildValueRows(attributes, "item_name", [TARGET.title]) },
    { op: "replace", path: "/attributes/bullet_point", value: buildValueRows(attributes, "bullet_point", TARGET.bulletPoints) },
    { op: "replace", path: "/attributes/product_description", value: buildValueRows(attributes, "product_description", [TARGET.description]) },
    { op: "replace", path: "/attributes/software_included", value: buildValueRows(attributes, "software_included", TARGET.softwareIncluded) },
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

function protectedSnapshot(listing) {
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  return {
    brand: attributes.brand || [],
    manufacturer: attributes.manufacturer || [],
    modelName: attributes.model_name || [],
    warranty: attributes.warranty_description || [],
    includedComponents: attributes.included_components || [],
    specificUses: attributes.specific_uses_for_product || [],
    purchasableOffer: attributes.purchasable_offer || [],
    fulfillmentAvailabilityAttribute: attributes.fulfillment_availability || [],
    parentageLevel: attributes.parentage_level || [],
    childParentRelationship: attributes.child_parent_sku_relationship || [],
    listPrice: attributes.list_price || [],
    mainImage: attributes.main_product_image_locator || [],
    offers: Array.isArray(listing?.offers) ? listing.offers : [],
    fulfillmentAvailability: Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [],
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function verifyTarget(listing, beforeProtected) {
  const summary = Array.isArray(listing?.summaries) ? listing.summaries[0] || {} : {};
  const attributes = listing?.attributes && typeof listing.attributes === "object" ? listing.attributes : {};
  const afterProtected = protectedSnapshot(listing);
  const currentSoftware = normalizedValues(attributes, "software_included");
  const expectedSoftware = [...TARGET.softwareIncluded].sort();
  const listingIssues = Array.isArray(listing?.issues) ? listing.issues : [];
  const listingErrors = listingIssues.filter(issue => String(issue?.severity || "").toUpperCase() === "ERROR");

  const targetChecks = {
    asin: String(summary?.asin || "") === GUARD.asin,
    productType: String(summary?.productType || "") === GUARD.productType,
    itemName: String(firstValue(attributes, "item_name") || "") === TARGET.title,
    bulletPoints: sameJson(values(attributes, "bullet_point"), TARGET.bulletPoints),
    description: String(firstValue(attributes, "product_description") || "") === TARGET.description,
    softwareIncluded: sameJson(currentSoftware, expectedSoftware),
  };

  const protectedChecks = {};
  Object.keys(beforeProtected).forEach(key => {
    protectedChecks[key] = sameJson(beforeProtected[key], afterProtected[key]);
  });

  return {
    verified: Object.values(targetChecks).every(Boolean) && Object.values(protectedChecks).every(Boolean),
    targetChecks,
    protectedChecks,
    listingIssueCount: listingIssues.length,
    listingErrorCount: listingErrors.length,
    snapshot: {
      title: firstValue(attributes, "item_name"),
      bulletPoints: values(attributes, "bullet_point"),
      description: firstValue(attributes, "product_description"),
      softwareIncluded: normalizedValues(attributes, "software_included"),
      brand: firstValue(attributes, "brand"),
      manufacturer: firstValue(attributes, "manufacturer"),
      modelName: firstValue(attributes, "model_name"),
      warranty: firstValue(attributes, "warranty_description"),
      offers: afterProtected.offers,
      fulfillmentAvailability: afterProtected.fulfillmentAvailability,
    },
  };
}

async function handler(req, res) {
  let livePatchSent = false;
  try {
    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({ ok: false, livePatchSent: false, amazonPersistentWrites: 0, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    }
    if (String(req.headers["x-api-secret"] || "") !== secret) {
      return res.status(401).json({ ok: false, livePatchSent: false, amazonPersistentWrites: 0, externalChanges: 0, error: "Unauthorized" });
    }

    const sku = String(req.body?.sku || "").trim();
    const previewSubmissionId = String(req.body?.previewSubmissionId || "").trim();
    const confirmLive = String(req.body?.confirmLive || "").trim();

    if (sku !== GUARD.sku) throw new Error("LIVE_GUARD_BLOCKED: unexpected SKU");
    if (previewSubmissionId !== GUARD.approvedPreviewSubmissionId) {
      throw new Error("LIVE_GUARD_BLOCKED: approved preview submission ID mismatch");
    }
    if (confirmLive !== GUARD.confirmLive) {
      throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");
    }

    const accessToken = await getLwaAccessToken();
    const beforeListing = await getListing(accessToken, sku);
    const { attributes } = assertSource(beforeListing);
    const beforeProtected = protectedSnapshot(beforeListing);
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
        approvedPreviewSubmissionId: GUARD.approvedPreviewSubmissionId,
        freshPreview,
        livePatchSent: true,
        livePatchAttempts: 1,
        liveResult,
        postVerified: false,
        amazonPersistentWrites: 1,
        externalChanges: liveResult.responseOk ? 1 : 0,
        error: "LIVE_PATCH_RESPONSE_NOT_ACCEPTED",
        note: "LIVE PATCH was sent once. Do not retry automatically.",
      });
    }

    const verificationAttempts = [];
    let verification = null;
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(VERIFY_GAP_MS);
      verification = verifyTarget(await getListing(accessToken, sku), beforeProtected);
      verificationAttempts.push({
        attempt,
        verified: verification.verified,
        targetChecks: verification.targetChecks,
        protectedChecks: verification.protectedChecks,
        listingErrorCount: verification.listingErrorCount,
      });
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
      finalVerification: verification || {},
      amazonPersistentWrites: 1,
      externalChanges: 1,
      verificationPending: !postVerified,
      note: postVerified
        ? "X13 sales content updated once and Fresh GET verified"
        : "LIVE PATCH was accepted once, but propagation or protected-state verification was not complete within the verification window; do not retry LIVE automatically",
    });
  } catch (err) {
    console.error("X13 Office2024 content live error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      livePatchSent,
      livePatchAttempts: livePatchSent ? 1 : 0,
      amazonPersistentWrites: livePatchSent ? 1 : 0,
      externalChanges: livePatchSent ? 1 : 0,
      error: err?.message || String(err),
      note: livePatchSent ? "A LIVE PATCH was already sent. Do not retry automatically." : "No LIVE PATCH was sent.",
    });
  }
}

express.application.listen = function x13Office2024ContentLiveListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
