import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
app.use(express.json());

// ---- 共通設定（Render Environment Variables）----
const LWA_CLIENT_ID     = process.env.LWA_CLIENT_ID;
const LWA_CLIENT_SECRET = process.env.LWA_CLIENT_SECRET;
const REFRESH_TOKEN     = process.env.REFRESH_TOKEN;
const MARKETPLACE_ID    = process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528"; // JP
const SPAPI_ENDPOINT    = process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com";
const SELLER_ID         = process.env.SPAPI_SELLER_ID;

// 価格取得条件
const PRICING_ITEM_CONDITIONS = (process.env.PRICING_ITEM_CONDITIONS || "Refurbished")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Offers配列が返る場合に使うサブコンディション
const REQUIRED_SUBCONDITIONS = (process.env.REQUIRED_SUBCONDITIONS || "Very Good")
  .split(",")
  .map((s) => normalizeSubCondition(s))
  .filter(Boolean);

// Summary.LowestPrices で優先する condition
const REQUIRED_SUMMARY_CONDITIONS = (process.env.REQUIRED_SUMMARY_CONDITIONS || "new")
  .split(",")
  .map((s) => normalizeApiCondition(s))
  .filter(Boolean);

// Summary.LowestPrices のうち required summary condition に合わない価格も価格調整に使うか
const ALLOW_SUMMARY_LOWESTPRICE_FOR_REPRICING =
  String(process.env.ALLOW_SUMMARY_LOWESTPRICE_FOR_REPRICING || "false").toLowerCase() === "true";

// セール・異常値ガード
const SALE_GUARD_AVG_DROP_RATE = Number(process.env.SALE_GUARD_AVG_DROP_RATE || "-0.15");
const SALE_GUARD_POINT_RATE    = Number(process.env.SALE_GUARD_POINT_RATE || "0.03");

// ---- 発送元固定（Render Environment Variables）----
const SHIPPER_TEL   = process.env.SHIPPER_TEL || "";
const REQUESTER_TEL = process.env.REQUESTER_TEL || "";

const SENDER_POST   = process.env.SENDER_POST || "";
const SENDER_ADDR1  = process.env.SENDER_ADDR1 || "";
const SENDER_NAME1  = process.env.SENDER_NAME1 || "";
const SENDER_NAME2  = process.env.SENDER_NAME2 || "";

// -------------------- Benchmark Master --------------------
const BENCHMARK_MASTER = [
  {
    active: true,
    group: "SV1",
    targetSkuGroup: "SV1_16_256",
    benchmarkRank: 1,
    benchmarkRole: "同等競合",
    asin: "B0G1C3YG3W",
    productName: "CF-SV1 16GB/SSD256GB",
    cpu: "i5-1145G7",
    cpuGeneration: 11,
    memoryGb: 16,
    storageType: "SSD",
    storageGb: 256,
    sourceSalesUnits: 20,
    sourceAvgPrice: 50503,
    useForPriceMonitor: true,
    useForRepricing: true,
    memo: "SV1 16GB/256GBの安値基準"
  },
  {
    active: true,
    group: "SV1",
    targetSkuGroup: "SV1_16_256",
    benchmarkRank: 2,
    benchmarkRole: "同等競合",
    asin: "B0GCZWBVLN",
    productName: "CF-SV1 16GB/SSD256GB",
    cpu: "i5-1145G7",
    cpuGeneration: 11,
    memoryGb: 16,
    storageType: "SSD",
    storageGb: 256,
    sourceSalesUnits: 9,
    sourceAvgPrice: 62205,
    useForPriceMonitor: true,
    useForRepricing: true,
    memo: "高価格でも売れているSV1競合"
  },
  {
    active: true,
    group: "SV1",
    targetSkuGroup: "SV1_16_256",
    benchmarkRank: 3,
    benchmarkRole: "同等競合",
    asin: "B0GPX1XN8Y",
    productName: "CF-SV1 16GB/SSD256GB",
    cpu: "i5-1145G7",
    cpuGeneration: 11,
    memoryGb: 16,
    storageType: "SSD",
    storageGb: 256,
    sourceSalesUnits: 4,
    sourceAvgPrice: 59205,
    useForPriceMonitor: true,
    useForRepricing: true,
    memo: "MTD想定価格に近いSV1競合"
  },
  {
    active: true,
    group: "G83",
    targetSkuGroup: "G83_16_256",
    benchmarkRank: 1,
    benchmarkRole: "同等競合",
    asin: "B0DR9BRG8B",
    productName: "G83/HS 16GB/SSD256GB",
    cpu: "i5-1135G7",
    cpuGeneration: 11,
    memoryGb: 16,
    storageType: "SSD",
    storageGb: 256,
    sourceSalesUnits: 33,
    sourceAvgPrice: 55339,
    useForPriceMonitor: true,
    useForRepricing: true,
    memo: "G83 16GB/256GBの主力競合"
  },
  {
    active: true,
    group: "G83",
    targetSkuGroup: "G83_16_256",
    benchmarkRank: 2,
    benchmarkRole: "同等競合",
    asin: "B0FKNK8SMZ",
    productName: "G83 16GB/SSD256GB",
    cpu: "i5-1135G7",
    cpuGeneration: 11,
    memoryGb: 16,
    storageType: "SSD",
    storageGb: 256,
    sourceSalesUnits: 6,
    sourceAvgPrice: 46800,
    useForPriceMonitor: true,
    useForRepricing: true,
    memo: "G83 16GB/256GBの安値寄り競合"
  },
  {
    active: true,
    group: "G83",
    targetSkuGroup: "G83_16_256",
    benchmarkRank: 3,
    benchmarkRole: "同等競合",
    asin: "B0GR429T3D",
    productName: "G83 16GB/SSD256GB",
    cpu: "i5-1135G7",
    cpuGeneration: 11,
    memoryGb: 16,
    storageType: "SSD",
    storageGb: 256,
    sourceSalesUnits: 4,
    sourceAvgPrice: 56090,
    useForPriceMonitor: true,
    useForRepricing: true,
    memo: "G83 55,000円台の直接競合"
  }
];

// -------------------- Utils --------------------
function csvEscape(v) {
  const s = (v ?? "").toString();
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function joinNotEmpty(...parts) {
  return parts
    .map((p) => (p ?? "").toString().trim())
    .filter(Boolean)
    .join("");
}

function cut(s, n) {
  const str = (s ?? "").toString();
  return str.length > n ? str.slice(0, n) : str;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeJsonParse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    return { rawText: text };
  }
}

function normalizeApiCondition(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function normalizeSubCondition(value) {
  const s = normalizeApiCondition(value);
  if (!s) return "";

  if (s === "very good" || s === "verygood" || s === "非常に良い" || s === "非常に良い品") {
    return "very good";
  }

  if (s === "good" || s === "良い" || s === "良い品") {
    return "good";
  }

  if (s === "acceptable" || s === "可" || s === "可品") {
    return "acceptable";
  }

  if (s === "like new" || s === "likenew" || s === "ほぼ新品") {
    return "like new";
  }

  return s;
}

function isRequiredSubConditionMatched(subCondition) {
  if (REQUIRED_SUBCONDITIONS.length === 0) return true;
  const normalized = normalizeSubCondition(subCondition);
  if (!normalized) return false;
  return REQUIRED_SUBCONDITIONS.includes(normalized);
}

function isRequiredSummaryConditionMatched(summaryCondition) {
  if (REQUIRED_SUMMARY_CONDITIONS.length === 0) return true;
  const normalized = normalizeApiCondition(summaryCondition);
  if (!normalized) return false;
  return REQUIRED_SUMMARY_CONDITIONS.includes(normalized);
}

function buildSaleGuard({ sourceAvgPrice, apiPrice, effectivePrice, points }) {
  const avg = num(sourceAvgPrice);
  const effective = num(effectivePrice);
  const price = num(apiPrice);
  const pointValue = num(points);

  const avgPriceDiff = effective !== null && avg !== null ? effective - avg : null;
  const avgPriceDiffRate = avgPriceDiff !== null && avg ? avgPriceDiff / avg : null;
  const pointRate = pointValue !== null && price ? pointValue / price : null;

  const reasons = [];

  if (avgPriceDiffRate !== null && avgPriceDiffRate <= SALE_GUARD_AVG_DROP_RATE) {
    reasons.push(`資料平均との差率${Math.round(avgPriceDiffRate * 1000) / 10}%`);
  }

  if (pointRate !== null && pointRate >= SALE_GUARD_POINT_RATE) {
    reasons.push(`ポイント率${Math.round(pointRate * 1000) / 10}%`);
  }

  return {
    avgPriceDiff,
    avgPriceDiffRate,
    pointRate,
    isSaleGuard: reasons.length > 0,
    saleGuardReason: reasons.join(" / ")
  };
}

function amountOf(moneyObj) {
  if (!moneyObj) return null;
  const value = moneyObj.Amount ?? moneyObj.amount;
  if (value === null || value === undefined || value === "") return null;

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// -------------------- e飛伝Ⅲ header --------------------
const SAGAWA_HEADER = [
  "お届け先コード取得区分","お届け先コード","お届け先電話番号","お届け先郵便番号",
  "お届け先住所１","お届け先住所２","お届け先住所３","お届け先名称１","お届け先名称２",
  "お客様管理番号","お客様コード",
  "部署ご担当者コード取得区分","部署ご担当者コード","部署ご担当者名称",
  "荷送人電話番号",
  "ご依頼主コード取得区分","ご依頼主コード","ご依頼主電話番号","ご依頼主郵便番号",
  "ご依頼主住所１","ご依頼主住所２","ご依頼主名称１","ご依頼主名称２",
  "荷姿","品名１","品名２","品名３","品名４","品名５",
  "荷札荷姿","荷札品名１","荷札品名２","荷札品名３","荷札品名４","荷札品名５",
  "荷札品名６","荷札品名７","荷札品名８","荷札品名９","荷札品名１０","荷札品名１１",
  "出荷個数","スピード指定","クール便指定","配達日","配達指定時間帯","配達指定時間（時分）",
  "代引金額","消費税","決済種別","保険金額",
  "指定シール１","指定シール２","指定シール３",
  "営業所受取","SRC区分","営業所受取営業所コード","元着区分",
  "メールアドレス","ご不在時連絡先","出荷日","お問い合せ送り状No.","出荷場印字区分",
  "集約解除指定",
  "編集０１","編集０２","編集０３","編集０４","編集０５","編集０６","編集０７","編集０８","編集０９","編集１０"
];

function orderToSagawaRow(order) {
  const ship = order?.ShippingAddress || {};
  const name = ship?.Name || order?.BuyerName || "";

  const addr1 = joinNotEmpty(ship.StateOrRegion, ship.City);
  const addr2 = ship.AddressLine1 || "";
  const addr3 = joinNotEmpty(ship.AddressLine2, ship.AddressLine3);

  const items  = order.Items || [];
  const skus   = items.map((i) => i.SellerSKU).filter(Boolean).join(",");
  const titles = items.map((i) => i.Title).filter(Boolean).join(" / ");

  return [
    "",
    "0",
    ship.Phone || "",
    ship.PostalCode || "",
    addr1,
    addr2,
    addr3,
    name,
    "",
    order.AmazonOrderId || "",
    "",

    "", "", "",
    SHIPPER_TEL,

    "",
    "",
    REQUESTER_TEL,
    SENDER_POST,
    SENDER_ADDR1,
    "",
    SENDER_NAME1,
    SENDER_NAME2,

    "",
    "中古PC",
    cut(skus, 60),
    cut(titles, 60),
    "", "",

    "", "", "", "", "", "", "", "", "", "", "",
    "1",
    "", "", "", "", "",
    "", "", "", "",
    "", "", "",
    "", "", "", "",
    "", "",
    "", "", "",
    "",
    "", "", "", "", "", "", "", "", "", ""
  ];
}

// -------------------- LWA Token --------------------
async function getLwaAccessToken() {
  if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Missing env: LWA_CLIENT_ID / LWA_CLIENT_SECRET / REFRESH_TOKEN");
  }

  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ LWA token error:", res.status, text);
    throw new Error(`LWA token error: ${res.status}`);
  }

  const json = await res.json();
  return json.access_token;
}

// -------------------- 共通：SP-API request --------------------
async function spApiRequest({ method = "GET", path, body = null, accessToken }) {
  const bodyText = body ? JSON.stringify(body) : undefined;

  const headers = {
    "x-amz-access-token": accessToken,
    accept: "application/json",
    "user-agent": "amazon-webhook-api/1.0"
  };

  if (bodyText) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`${SPAPI_ENDPOINT}${path}`, {
    method,
    headers,
    body: bodyText
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) {
    const detail = typeof json === "object" ? JSON.stringify(json) : text;
    throw new Error(`SP-API request error: ${res.status} ${detail}`);
  }

  return json;
}

async function updateAmazonListingQuantity({ sku, quantity }) {
  if (!SELLER_ID) {
    throw new Error("Missing env: SPAPI_SELLER_ID");
  }

  if (!sku) {
    throw new Error("sku is required");
  }

  const qty = Number(quantity);

  if (!Number.isFinite(qty) || qty < 0) {
    throw new Error("quantity must be a non-negative number");
  }

  const accessToken = await getLwaAccessToken();

  const body = {
    productType: "PRODUCT",
    patches: [
      {
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: [
          {
            fulfillment_channel_code: "DEFAULT",
            quantity: qty
          }
        ]
      }
    ]
  };

  return await spApiRequest({
    method: "PATCH",
    path:
      `/listings/2021-08-01/items/${encodeURIComponent(SELLER_ID)}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${encodeURIComponent(MARKETPLACE_ID)}`,
    body,
    accessToken
  });
}

// -------------------- SP-API: Product Pricing --------------------
function buildItemOffersBatchRequest(items, itemCondition) {
  return {
    requests: items.map((item) => ({
      uri: `/products/pricing/v0/items/${encodeURIComponent(item.asin)}/offers`,
      method: "GET",
      MarketplaceId: MARKETPLACE_ID,
      ItemCondition: itemCondition,
      CustomerType: "Consumer"
    }))
  };
}

function extractAmount(moneyObj) {
  if (!moneyObj) return null;
  return num(moneyObj.Amount ?? moneyObj.amount);
}

function extractPointsNumber(pointsObj) {
  if (!pointsObj) return null;

  const pointsNumber =
    num(pointsObj.PointsNumber) ??
    num(pointsObj.pointsNumber);

  if (pointsNumber !== null) return pointsNumber;

  const monetaryValue = extractAmount(
    pointsObj.PointsMonetaryValue ?? pointsObj.pointsMonetaryValue
  );

  return monetaryValue;
}

function normalizeOffer(offer) {
  const listingPrice = extractAmount(offer?.ListingPrice ?? offer?.listingPrice);
  const shippingPrice = extractAmount(offer?.Shipping ?? offer?.shipping) ?? 0;
  const landedPrice = listingPrice !== null ? listingPrice + shippingPrice : null;

  const points = extractPointsNumber(offer?.Points ?? offer?.points);
  const coupon = null;

  const effectivePrice = landedPrice !== null
    ? landedPrice - (points || 0) - (coupon || 0)
    : null;

  const rawSubCondition =
    offer?.SubCondition ??
    offer?.subCondition ??
    offer?.Subcondition ??
    "";

  const subCondition = normalizeSubCondition(rawSubCondition);
  const isSubConditionMatched = isRequiredSubConditionMatched(subCondition);

  return {
    listingPrice,
    shippingPrice,
    landedPrice,
    points,
    coupon,
    effectivePrice,
    seller: offer?.SellerId || offer?.sellerId || "",
    fulfillment: offer?.IsFulfilledByAmazon ? "AFN" : "MFN",
    isBuyBoxWinner: Boolean(offer?.IsBuyBoxWinner),
    isFeaturedMerchant: Boolean(offer?.IsFeaturedMerchant),
    rawSubCondition,
    subCondition,
    isSubConditionMatched,
    rawSummaryCondition: "",
    summaryCondition: "",
    isSummaryConditionMatched: false,
    priceSource: "Offers"
  };
}

function normalizeLowestPrice(lp) {
  const listingPrice = extractAmount(lp?.ListingPrice ?? lp?.listingPrice);
  const landedPriceFromApi = extractAmount(lp?.LandedPrice ?? lp?.landedPrice);
  const shippingPrice = extractAmount(lp?.Shipping ?? lp?.shipping) ?? 0;

  const points = extractPointsNumber(lp?.Points ?? lp?.points);
  const coupon = null;

  const landedPrice =
    landedPriceFromApi !== null
      ? landedPriceFromApi
      : listingPrice !== null
        ? listingPrice + shippingPrice - (points || 0)
        : null;

  const effectivePrice = landedPrice !== null
    ? landedPrice - (coupon || 0)
    : null;

  const fulfillmentRaw =
    lp?.fulfillmentChannel ||
    lp?.FulfillmentChannel ||
    "";

  let fulfillment = "";
  if (fulfillmentRaw === "Amazon") fulfillment = "AFN";
  else if (fulfillmentRaw === "Merchant") fulfillment = "MFN";
  else fulfillment = fulfillmentRaw || "";

  const rawSummaryCondition =
    lp?.condition ??
    lp?.Condition ??
    "";

  const summaryCondition = normalizeApiCondition(rawSummaryCondition);
  const isSummaryConditionMatched = isRequiredSummaryConditionMatched(summaryCondition);

  return {
    listingPrice,
    shippingPrice,
    landedPrice,
    points,
    coupon,
    effectivePrice,
    seller: "",
    fulfillment,
    isBuyBoxWinner: false,
    isFeaturedMerchant: false,
    rawSubCondition: "",
    subCondition: "",
    isSubConditionMatched: false,
    rawSummaryCondition,
    summaryCondition,
    isSummaryConditionMatched,
    priceSource: "Summary.LowestPrices"
  };
}

function sortByEffectivePrice(a, b) {
  if (a.effectivePrice !== b.effectivePrice) return a.effectivePrice - b.effectivePrice;
  if (a.isBuyBoxWinner && !b.isBuyBoxWinner) return -1;
  if (!a.isBuyBoxWinner && b.isBuyBoxWinner) return 1;
  return a.landedPrice - b.landedPrice;
}

function pickBestOffer(offers, requiredOnly = false) {
  if (!Array.isArray(offers) || offers.length === 0) return null;

  let normalized = offers
    .map(normalizeOffer)
    .filter((o) => o.landedPrice !== null);

  if (requiredOnly) {
    normalized = normalized.filter((o) => o.isSubConditionMatched);
  }

  if (normalized.length === 0) return null;

  normalized.sort(sortByEffectivePrice);
  return normalized[0];
}

function pickBestLowestPrice(lowestPrices, requiredOnly = false) {
  if (!Array.isArray(lowestPrices) || lowestPrices.length === 0) return null;

  let normalized = lowestPrices
    .map(normalizeLowestPrice)
    .filter((o) => o.landedPrice !== null);

  if (requiredOnly) {
    normalized = normalized.filter((o) => o.isSummaryConditionMatched);
  }

  if (normalized.length === 0) return null;

  normalized.sort(sortByEffectivePrice);
  return normalized[0];
}

function buildFinalPriceResult(masterItem, batchItem, itemCondition) {
  const statusCode =
    typeof batchItem?.status === "number"
      ? batchItem.status
      : batchItem?.status?.statusCode ??
        batchItem?.Status?.StatusCode ??
        batchItem?.statusCode ??
        null;

  const body = batchItem?.body || batchItem?.Body || {};
  const payload = body?.payload || body?.Payload || body || {};

  const offers = payload?.Offers || payload?.offers || [];
  const summary = payload?.Summary || payload?.summary || {};
  const lowestPrices = summary?.LowestPrices || summary?.lowestPrices || [];

  const offerCount =
    num(summary?.TotalOfferCount) ??
    num(summary?.totalOfferCount) ??
    num(payload?.TotalOfferCount) ??
    (Array.isArray(offers) ? offers.length : 0);

  const bestRequiredOffer = pickBestOffer(offers, true);
  const bestRequiredSummaryPrice = pickBestLowestPrice(lowestPrices, true);
  const bestAnyOffer = pickBestOffer(offers, false);
  const bestAnySummaryPrice = pickBestLowestPrice(lowestPrices, false);

  let bestPrice = null;
  let selectionReason = "";

  if (bestRequiredOffer) {
    bestPrice = bestRequiredOffer;
    selectionReason = "required_subcondition_offer";
  } else if (bestRequiredSummaryPrice) {
    bestPrice = bestRequiredSummaryPrice;
    selectionReason = "required_summary_condition";
  } else if (bestAnyOffer) {
    bestPrice = bestAnyOffer;
    selectionReason = "offer_without_required_subcondition";
  } else if (bestAnySummaryPrice) {
    bestPrice = bestAnySummaryPrice;
    selectionReason = "summary_without_required_condition";
  }

  if (!bestPrice) {
    return {
      checkedAt: new Date().toISOString(),
      group: masterItem.group,
      targetSkuGroup: masterItem.targetSkuGroup,
      asin: masterItem.asin,
      productName: masterItem.productName,
      sourceAvgPrice: masterItem.sourceAvgPrice,
      apiPrice: null,
      shippingPrice: null,
      landedPrice: null,
      points: null,
      coupon: null,
      effectivePrice: null,
      seller: "",
      fulfillment: "",
      availability: offerCount > 0 ? "offer_summary_only_no_price" : "no_offer",
      offerCount,
      source: `SP-API getItemOffersBatch / ${itemCondition}`,
      confidence: statusCode === 200 ? "low" : "api_error",
      avgPriceDiff: null,
      avgPriceDiffRate: null,
      pointRate: null,
      itemCondition,
      rawSubCondition: "",
      subCondition: "",
      requiredSubConditions: REQUIRED_SUBCONDITIONS,
      isSubConditionMatched: false,
      rawSummaryCondition: "",
      summaryCondition: "",
      requiredSummaryConditions: REQUIRED_SUMMARY_CONDITIONS,
      isSummaryConditionMatched: false,
      priceSource: "",
      isSaleGuard: false,
      saleGuardReason: "",
      useForRepricing: false,
      selectionReason: "",
      memo: statusCode === 200
        ? `価格なし / offerCount=${offerCount}`
        : `API statusCode=${statusCode}`
    };
  }

  const saleGuard = buildSaleGuard({
    sourceAvgPrice: masterItem.sourceAvgPrice,
    apiPrice: bestPrice.listingPrice,
    effectivePrice: bestPrice.effectivePrice,
    points: bestPrice.points
  });

  const requiredConditionMatched =
    Boolean(bestPrice.isSubConditionMatched) ||
    Boolean(bestPrice.isSummaryConditionMatched);

  const summaryFallbackAllowed =
    bestPrice.priceSource === "Summary.LowestPrices" &&
    ALLOW_SUMMARY_LOWESTPRICE_FOR_REPRICING;

  const canUseForRepricing =
    Boolean(masterItem.useForRepricing) &&
    bestPrice.effectivePrice !== null &&
    (
      requiredConditionMatched ||
      summaryFallbackAllowed
    ) &&
    !saleGuard.isSaleGuard;

  let memo = "";

  if (bestPrice.priceSource === "Offers") {
    if (bestPrice.isSubConditionMatched) {
      memo = bestPrice.isBuyBoxWinner
        ? "Offers / required subCondition / BuyBoxWinner offer"
        : "Offers / required subCondition / lowest effective offer";
    } else {
      memo = `Offers / subCondition not matched. raw=${bestPrice.rawSubCondition || "(empty)"}`;
    }
  } else {
    if (bestPrice.isSummaryConditionMatched) {
      memo = `Summary.LowestPrices / required summary condition: ${bestPrice.summaryCondition}`;
    } else if (ALLOW_SUMMARY_LOWESTPRICE_FOR_REPRICING) {
      memo = "Summary.LowestPrices / fallback allowed by env";
    } else {
      memo = `Summary.LowestPrices / summary condition not matched. raw=${bestPrice.rawSummaryCondition || "(empty)"}`;
    }
  }

  if (saleGuard.isSaleGuard) {
    memo += ` / sale_guard: ${saleGuard.saleGuardReason}`;
  }

  return {
    checkedAt: new Date().toISOString(),
    group: masterItem.group,
    targetSkuGroup: masterItem.targetSkuGroup,
    asin: masterItem.asin,
    productName: masterItem.productName,
    sourceAvgPrice: masterItem.sourceAvgPrice,
    apiPrice: bestPrice.listingPrice,
    shippingPrice: bestPrice.shippingPrice,
    landedPrice: bestPrice.landedPrice,
    points: bestPrice.points,
    coupon: bestPrice.coupon,
    effectivePrice: bestPrice.effectivePrice,
    seller: bestPrice.seller,
    fulfillment: bestPrice.fulfillment,
    availability: "offer_found",
    offerCount,
    source: `SP-API getItemOffersBatch / ${itemCondition}`,
    confidence:
      bestPrice.priceSource === "Offers" && bestPrice.isSubConditionMatched
        ? "high"
        : bestPrice.priceSource === "Summary.LowestPrices" && bestPrice.isSummaryConditionMatched
          ? "medium_high"
          : "medium",
    avgPriceDiff: saleGuard.avgPriceDiff,
    avgPriceDiffRate: saleGuard.avgPriceDiffRate,
    pointRate: saleGuard.pointRate,
    itemCondition,
    rawSubCondition: bestPrice.rawSubCondition || "",
    subCondition: bestPrice.subCondition || "",
    requiredSubConditions: REQUIRED_SUBCONDITIONS,
    isSubConditionMatched: Boolean(bestPrice.isSubConditionMatched),
    rawSummaryCondition: bestPrice.rawSummaryCondition || "",
    summaryCondition: bestPrice.summaryCondition || "",
    requiredSummaryConditions: REQUIRED_SUMMARY_CONDITIONS,
    isSummaryConditionMatched: Boolean(bestPrice.isSummaryConditionMatched),
    priceSource: bestPrice.priceSource,
    isSaleGuard: saleGuard.isSaleGuard,
    saleGuardReason: saleGuard.saleGuardReason,
    useForRepricing: canUseForRepricing,
    selectionReason,
    memo
  };
}

async function fetchBenchmarkPrices() {
  const accessToken = await getLwaAccessToken();

  const activeItems = BENCHMARK_MASTER
    .filter((item) => item.active && item.useForPriceMonitor)
    .sort((a, b) => {
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return a.benchmarkRank - b.benchmarkRank;
    });

  const finalResultsByAsin = new Map();

  for (let idx = 0; idx < PRICING_ITEM_CONDITIONS.length; idx += 1) {
    const itemCondition = PRICING_ITEM_CONDITIONS[idx];

    const remainingItems = activeItems.filter((item) => !finalResultsByAsin.has(item.asin));
    if (remainingItems.length === 0) break;

    if (idx > 0) {
      await sleep(11000);
    }

    const body = buildItemOffersBatchRequest(remainingItems, itemCondition);

    const json = await spApiRequest({
      method: "POST",
      path: "/batches/products/pricing/v0/itemOffers",
      body,
      accessToken
    });

    const responses = json?.responses || json?.Responses || [];

    remainingItems.forEach((masterItem, i) => {
      const batchItem = responses[i] || {};
      const parsed = buildFinalPriceResult(masterItem, batchItem, itemCondition);

      if (parsed.availability === "offer_found" || idx === PRICING_ITEM_CONDITIONS.length - 1) {
        finalResultsByAsin.set(masterItem.asin, parsed);
      }
    });
  }

  return activeItems.map((item) => {
    return finalResultsByAsin.get(item.asin) || {
      checkedAt: new Date().toISOString(),
      group: item.group,
      targetSkuGroup: item.targetSkuGroup,
      asin: item.asin,
      productName: item.productName,
      sourceAvgPrice: item.sourceAvgPrice,
      apiPrice: null,
      shippingPrice: null,
      landedPrice: null,
      points: null,
      coupon: null,
      effectivePrice: null,
      seller: "",
      fulfillment: "",
      availability: "not_checked",
      offerCount: 0,
      source: "SP-API getItemOffersBatch",
      confidence: "none",
      avgPriceDiff: null,
      avgPriceDiffRate: null,
      pointRate: null,
      itemCondition: "",
      rawSubCondition: "",
      subCondition: "",
      requiredSubConditions: REQUIRED_SUBCONDITIONS,
      isSubConditionMatched: false,
      rawSummaryCondition: "",
      summaryCondition: "",
      requiredSummaryConditions: REQUIRED_SUMMARY_CONDITIONS,
      isSummaryConditionMatched: false,
      priceSource: "",
      isSaleGuard: false,
      saleGuardReason: "",
      useForRepricing: false,
      selectionReason: "",
      memo: "価格取得処理に到達しませんでした"
    };
  });
}

// -------------------- SP-API: order address --------------------
async function getOrderAddress(accessToken, orderId) {
  const r = await fetch(
    `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}/address`,
    {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json"
      }
    }
  );

  const text = await r.text();

  if (!r.ok) {
    console.error("❌ getOrderAddress error:", orderId, r.status, text);
    return {};
  }

  const json = text ? JSON.parse(text) : {};
  const payload = json?.payload || json?.Payload || {};

  return payload?.ShippingAddress || payload?.shippingAddress || payload || {};
}

// -------------------- SP-API: buyer info --------------------
async function getOrderBuyerInfo(accessToken, orderId) {
  const r = await fetch(
    `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}/buyerInfo`,
    {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json"
      }
    }
  );

  const text = await r.text();

  if (!r.ok) {
    console.error("❌ getOrderBuyerInfo error:", orderId, r.status, text);
    return {};
  }

  const json = text ? JSON.parse(text) : {};
  const payload = json?.payload || json?.Payload || {};

  return payload?.BuyerInfo || payload?.buyerInfo || payload || {};
}

// -------------------- SP-API: orderItems --------------------
async function getOrderItems(accessToken, orderId) {
  const r = await fetch(
    `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
    {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json"
      }
    }
  );

  const text = await r.text();

  if (!r.ok) {
    console.error("❌ getOrderItems error:", orderId, r.status, text);
    return [];
  }

  const json = text ? JSON.parse(text) : {};
  const orderItems = json?.payload?.OrderItems || json?.OrderItems || [];

  return orderItems.map((oi) => ({
    SellerSKU: oi.SellerSKU || "",
    Title: oi.Title || "",
    QuantityOrdered: oi.QuantityOrdered ?? 1,
    OrderItemId: oi.OrderItemId || "",

    ShippingFee: amountOf(oi.ShippingPrice),
    ShippingTax: amountOf(oi.ShippingTax),
    TotalTax: amountOf(oi.ItemTax),
    PromotionDiscount: amountOf(oi.PromotionDiscount),

    ItemPrice: amountOf(oi.ItemPrice),
    ItemTax: amountOf(oi.ItemTax),
    ShippingDiscount: amountOf(oi.ShippingDiscount),
    ShippingDiscountTax: amountOf(oi.ShippingDiscountTax),
    PromotionDiscountTax: amountOf(oi.PromotionDiscountTax)
  }));
}

// -------------------- 共通：注文+住所+購入者+明細を取得 --------------------
async function fetchOrdersWithItems(createdAfterIso) {
  const accessToken = await getLwaAccessToken();

  const ordersUrl =
    `${SPAPI_ENDPOINT}/orders/v0/orders?` +
    `MarketplaceIds=${encodeURIComponent(MARKETPLACE_ID)}` +
    `&CreatedAfter=${encodeURIComponent(createdAfterIso)}` +
    `&OrderStatuses=Unshipped&OrderStatuses=PartiallyShipped`;

  const ordersRes = await fetch(ordersUrl, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json"
    }
  });

  const text = await ordersRes.text();

  if (!ordersRes.ok) {
    console.error("❌ Orders API error:", ordersRes.status, text);
    throw new Error(`Orders API error: ${ordersRes.status} ${text}`);
  }

  const ordersJson = text ? JSON.parse(text) : {};
  const rawOrders  = ordersJson?.payload?.Orders || [];

  console.log("✅ rawOrders count:", rawOrders.length, "createdAfter:", createdAfterIso);

  const enriched = [];

  for (const o of rawOrders) {
    const orderId = o.AmazonOrderId;

    const items = await getOrderItems(accessToken, orderId);
    const shippingAddress = await getOrderAddress(accessToken, orderId);
    const buyerInfo = await getOrderBuyerInfo(accessToken, orderId);

    const fallbackShip = o?.ShippingAddress || {};

    const shipName =
      shippingAddress?.Name ||
      shippingAddress?.name ||
      fallbackShip?.Name ||
      "";

    const postalCode =
      shippingAddress?.PostalCode ||
      shippingAddress?.postalCode ||
      fallbackShip?.PostalCode ||
      "";

    const stateOrRegion =
      shippingAddress?.StateOrRegion ||
      shippingAddress?.stateOrRegion ||
      fallbackShip?.StateOrRegion ||
      "";

    const city =
      shippingAddress?.City ||
      shippingAddress?.city ||
      fallbackShip?.City ||
      "";

    const addressLine1 =
      shippingAddress?.AddressLine1 ||
      shippingAddress?.addressLine1 ||
      fallbackShip?.AddressLine1 ||
      "";

    const addressLine2 =
      shippingAddress?.AddressLine2 ||
      shippingAddress?.addressLine2 ||
      fallbackShip?.AddressLine2 ||
      "";

    const addressLine3 =
      shippingAddress?.AddressLine3 ||
      shippingAddress?.addressLine3 ||
      fallbackShip?.AddressLine3 ||
      "";

    const phone =
      shippingAddress?.Phone ||
      shippingAddress?.phone ||
      fallbackShip?.Phone ||
      "";

    const buyerName =
      buyerInfo?.BuyerName ||
      buyerInfo?.buyerName ||
      o?.BuyerInfo?.BuyerName ||
      "";

    const buyerEmail =
      buyerInfo?.BuyerEmail ||
      buyerInfo?.buyerEmail ||
      o?.BuyerInfo?.BuyerEmail ||
      "";

    const shippingFee = items.reduce((sum, item) => sum + (Number(item.ShippingFee) || 0), 0);
    const shippingTax = items.reduce((sum, item) => sum + (Number(item.ShippingTax) || 0), 0);
    const totalTax = items.reduce((sum, item) => sum + (Number(item.TotalTax) || 0), 0);
    const promotionDiscount = items.reduce((sum, item) => sum + (Number(item.PromotionDiscount) || 0), 0);

    enriched.push({
      AmazonOrderId: orderId,
      PurchaseDate:  o.PurchaseDate,
      OrderStatus:   o.OrderStatus,

      BuyerName: buyerName,
      BuyerEmail: buyerEmail,

      ShippingAddress: {
        Name:          shipName,
        Phone:         phone,
        PostalCode:    postalCode,
        StateOrRegion: stateOrRegion,
        City:          city,
        AddressLine1:  addressLine1,
        AddressLine2:  addressLine2,
        AddressLine3:  addressLine3
      },

      OrderTotal: o?.OrderTotal?.Amount ? Number(o.OrderTotal.Amount) : null,
      Currency:   o?.OrderTotal?.CurrencyCode || null,

      ShippingFee: shippingFee || null,
      ShippingTax: shippingTax || null,
      TotalTax: totalTax || null,
      PromotionDiscount: promotionDiscount || null,

      FulfillmentChannel: o?.FulfillmentChannel || "",
      PaymentMethod: o?.PaymentMethod || "",
      ShipmentServiceLevelCategory: o?.ShipmentServiceLevelCategory || "",
      LatestShipDate: o?.LatestShipDate || "",
      ShipServiceLevel: o?.ShipServiceLevel || "",

      Items: items
    });
  }

  return enriched;
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.post("/webhook", (req, res) => {
  console.log("🔔 Webhook received:", req.body);
  res.status(200).json({ status: "ok" });
});

app.get("/benchmark-master", (req, res) => {
  res.status(200).json(BENCHMARK_MASTER);
});

app.get("/benchmark-prices", async (req, res) => {
  try {
    const prices = await fetchBenchmarkPrices();
    return res.status(200).json(prices);
  } catch (err) {
    console.error("❌ Error in /benchmark-prices:", err);
    return res.status(500).json({
      error: "benchmark-prices error",
      message: err.message || String(err)
    });
  }
});

app.get("/pricing-test/:asin", async (req, res) => {
  try {
    const asin = String(req.params.asin || "").trim();
    if (!asin) {
      return res.status(400).json({ error: "ASIN is required" });
    }

    const accessToken = await getLwaAccessToken();
    const testItem = {
      active: true,
      group: "TEST",
      targetSkuGroup: "TEST",
      benchmarkRank: 1,
      asin,
      productName: `TEST ${asin}`,
      sourceAvgPrice: null,
      useForPriceMonitor: true,
      useForRepricing: true
    };

    const results = [];

    for (let idx = 0; idx < PRICING_ITEM_CONDITIONS.length; idx += 1) {
      const itemCondition = PRICING_ITEM_CONDITIONS[idx];

      if (idx > 0) {
        await sleep(11000);
      }

      const body = buildItemOffersBatchRequest([testItem], itemCondition);

      const json = await spApiRequest({
        method: "POST",
        path: "/batches/products/pricing/v0/itemOffers",
        body,
        accessToken
      });

      const response = (json?.responses || json?.Responses || [])[0] || {};
      results.push(buildFinalPriceResult(testItem, response, itemCondition));
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error("❌ Error in /pricing-test/:asin:", err);
    return res.status(500).json({
      error: "pricing-test error",
      message: err.message || String(err)
    });
  }
});

app.get("/pricing-raw/:asin", async (req, res) => {
  try {
    const asin = String(req.params.asin || "").trim();
    if (!asin) {
      return res.status(400).json({ error: "ASIN is required" });
    }

    const accessToken = await getLwaAccessToken();

    const testItem = { asin };
    const itemCondition = PRICING_ITEM_CONDITIONS[0] || "Refurbished";
    const body = buildItemOffersBatchRequest([testItem], itemCondition);

    const json = await spApiRequest({
      method: "POST",
      path: "/batches/products/pricing/v0/itemOffers",
      body,
      accessToken
    });

    return res.status(200).json(json);
  } catch (err) {
    console.error("❌ Error in /pricing-raw/:asin:", err);
    return res.status(500).json({
      error: "pricing-raw error",
      message: err.message || String(err)
    });
  }
});

// 切り分け用：単一注文の基本情報
app.get("/order/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const accessToken = await getLwaAccessToken();

    const r = await fetch(
      `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json"
        }
      }
    );

    const text = await r.text();

    if (!r.ok) {
      console.error("❌ GetOrder error:", r.status, text);
      return res.status(r.status).json({
        error: "GetOrder error",
        status: r.status,
        body: text
      });
    }

    return res.status(200).json(JSON.parse(text));
  } catch (e) {
    console.error("❌ Error in /order/:orderId", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 切り分け用：単一注文の住所・購入者・明細を確認
app.get("/order-full/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const accessToken = await getLwaAccessToken();

    const address = await getOrderAddress(accessToken, orderId);
    const buyerInfo = await getOrderBuyerInfo(accessToken, orderId);
    const items = await getOrderItems(accessToken, orderId);

    return res.status(200).json({
      AmazonOrderId: orderId,
      address,
      buyerInfo,
      items
    });
  } catch (e) {
    console.error("❌ Error in /order-full/:orderId", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 注文一覧JSON
app.get("/orders", async (req, res) => {
  try {
    const since = req.query.createdAfter
      ? new Date(req.query.createdAfter)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const createdAfterIso = since.toISOString();
    const orders = await fetchOrdersWithItems(createdAfterIso);

    const simplified = orders.map((o) => ({
      AmazonOrderId: o.AmazonOrderId,
      PurchaseDate:  o.PurchaseDate,
      OrderStatus:   o.OrderStatus,
      BuyerName:     o.BuyerName,
      BuyerEmail:    o.BuyerEmail,

      PostalCode:    o.ShippingAddress.PostalCode,
      StateOrRegion: o.ShippingAddress.StateOrRegion,
      City:          o.ShippingAddress.City,
      AddressLine1:  o.ShippingAddress.AddressLine1,
      AddressLine2:  o.ShippingAddress.AddressLine2,
      AddressLine3:  o.ShippingAddress.AddressLine3,
      Phone:         o.ShippingAddress.Phone,
      ShipName:      o.ShippingAddress.Name,

      OrderTotal: o.OrderTotal,
      Currency:   o.Currency,

      ShippingFee: o.ShippingFee,
      ShippingTax: o.ShippingTax,
      TotalTax: o.TotalTax,
      PromotionDiscount: o.PromotionDiscount,

      FulfillmentChannel: o.FulfillmentChannel,
      PaymentMethod: o.PaymentMethod,
      ShipmentServiceLevelCategory: o.ShipmentServiceLevelCategory,
      LatestShipDate: o.LatestShipDate,
      ShipServiceLevel: o.ShipServiceLevel,

      Items: o.Items
    }));

    return res.status(200).json(simplified);
  } catch (err) {
    console.error("❌ Error in /orders:", err);
    return res.status(500).json({ error: err.message || "SP-API error" });
  }
});

// e飛伝Ⅲ取込用CSV
app.get("/sagawa.csv", async (req, res) => {
  try {
    const since = req.query.createdAfter
      ? new Date(req.query.createdAfter)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const createdAfterIso = since.toISOString();
    const orders = await fetchOrdersWithItems(createdAfterIso);

    const lines = [];
    lines.push(SAGAWA_HEADER.map(csvEscape).join(","));

    for (const order of orders) {
      if (!order?.ShippingAddress?.Name) {
        order.ShippingAddress = order.ShippingAddress || {};
        order.ShippingAddress.Name = order.BuyerName || "（氏名不明）";
      }

      const row = orderToSagawaRow(order);
      lines.push(row.map(csvEscape).join(","));
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(csv);
  } catch (e) {
    console.error("❌ Error in /sagawa.csv:", e);
    res.status(500).send(e?.message || String(e));
  }
});

// 出荷通知
app.post("/confirm-shipment", async (req, res) => {
  try {
    const { orderId: rawOrderId, trackingNumber } = req.body;

    if (!rawOrderId || !trackingNumber) {
      return res.status(400).json({ error: "orderId と trackingNumber は必須です" });
    }

    const orderId = String(rawOrderId).trim();
    const accessToken = await getLwaAccessToken();

    const itemsRes = await fetch(
      `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json"
        }
      }
    );

    const itemsText = await itemsRes.text();

    if (!itemsRes.ok) {
      console.error("❌ getOrderItems error:", itemsRes.status, itemsText);
      return res.status(itemsRes.status).json({
        error: "getOrderItems error",
        status: itemsRes.status,
        body: itemsText
      });
    }

    const itemsJson  = itemsText ? JSON.parse(itemsText) : {};
    const orderItems = itemsJson?.payload?.OrderItems || itemsJson?.OrderItems || [];

    if (orderItems.length === 0) {
      return res.status(400).json({ error: "orderItems が取得できませんでした" });
    }

    const shipDate = new Date().toISOString();

    const packageDetail = {
      packageReferenceId: "1",
      carrierCode: "SAGAWA",
      trackingNumber,
      shipDate,
      orderItems: orderItems.map((oi) => ({
        orderItemId: oi.OrderItemId,
        quantity: oi.QuantityOrdered
      }))
    };

    const body = {
      marketplaceId: MARKETPLACE_ID,
      packageDetail
    };

    const confirmRes = await fetch(
      `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`,
      {
        method: "POST",
        headers: {
          "x-amz-access-token": accessToken,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    const confirmText = await confirmRes.text();

    if (!confirmRes.ok) {
      console.error("❌ confirmShipment error:", confirmRes.status, confirmText);
      return res.status(confirmRes.status).json({
        error: "confirmShipment error",
        status: confirmRes.status,
        body: confirmText
      });
    }

    console.log("✅ confirmShipment success:", orderId, confirmText);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error in /confirm-shipment:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// Amazon在庫更新 中継API
app.post("/amazon/stock/update", async (req, res) => {
  try {
    const secret = req.headers["x-api-secret"];

    if (!process.env.AMAZON_STOCK_API_SECRET) {
      return res.status(500).json({
        ok: false,
        error: "AMAZON_STOCK_API_SECRET is not set"
      });
    }

    if (secret !== process.env.AMAZON_STOCK_API_SECRET) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const { sku, quantity, dryRun } = req.body || {};

    if (!sku) {
      return res.status(400).json({
        ok: false,
        error: "sku is required"
      });
    }

    if (quantity === undefined || quantity === null || quantity === "") {
      return res.status(400).json({
        ok: false,
        error: "quantity is required"
      });
    }

    const qty = Number(quantity);

    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({
        ok: false,
        error: "quantity must be a non-negative number"
      });
    }

    // まずは疎通確認のみ。Amazon SP-APIへは送らない。
    if (dryRun) {
      console.log("✅ Amazon stock dryRun:", {
        sku,
        quantity: qty
      });

      return res.status(200).json({
        ok: true,
        dryRun: true,
        sku,
        quantity: qty,
        message: "DRY RUN OK"
      });
    }

const result = await updateAmazonListingQuantity({
  sku,
  quantity: qty
});

console.log("✅ Amazon stock live update:", {
  sku,
  quantity: qty,
  result
});

return res.status(200).json({
  ok: true,
  dryRun: false,
  sku,
  quantity: qty,
  result
});

  } catch (err) {
    console.error("❌ Error in /amazon/stock/update:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.get("/version", (req, res) => {
  res.status(200).json({
    version: "2026-05-11-orders-address-v6",
    marketplaceId: MARKETPLACE_ID,
    endpoint: SPAPI_ENDPOINT,
    pricingConditions: PRICING_ITEM_CONDITIONS,
    requiredSubConditions: REQUIRED_SUBCONDITIONS,
    requiredSummaryConditions: REQUIRED_SUMMARY_CONDITIONS,
    allowSummaryLowestPriceForRepricing: ALLOW_SUMMARY_LOWESTPRICE_FOR_REPRICING,
    saleGuardAvgDropRate: SALE_GUARD_AVG_DROP_RATE,
    saleGuardPointRate: SALE_GUARD_POINT_RATE,
    stockUpdateEndpoint: "/amazon/stock/update",
    sellerIdConfigured: Boolean(SELLER_ID),
    ordersAddressEnabled: true,
    orderFullEndpoint: "/order-full/:orderId"
  });
});

// ---- Render が使うポート ----
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

app.post('/amazon/shipment/notify', async (req, res) => {
  try {
    const secret = req.headers['x-amazon-shipment-secret'];

    if (!process.env.AMAZON_SHIPMENT_API_SECRET || secret !== process.env.AMAZON_SHIPMENT_API_SECRET) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const payload = req.body || {};
    const normalized = normalizeAmazonShipmentPayload(payload);

    const feedXml = buildAmazonOrderFulfillmentFeedXml(normalized);

    if (payload.dryRun === true) {
      return res.json({
        ok: true,
        dryRun: true,
        message: 'Amazon shipment feed was not submitted.',
        payload: normalized,
        feedXml
      });
    }

    const result = await submitAmazonOrderFulfillmentFeed(feedXml);

    return res.json({
      ok: true,
      dryRun: false,
      amazonOrderId: normalized.amazonOrderId,
      trackingNumber: normalized.trackingNumber,
      feedId: result.feedId,
      feedDocumentId: result.feedDocumentId,
      amazon: result
    });

  } catch (err) {
    console.error('[Amazon shipment notify error]', err);

    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

function normalizeAmazonShipmentPayload(payload) {
  const amazonOrderId = String(payload.amazonOrderId || '').trim();
  const trackingNumber = String(payload.trackingNumber || '').replace(/[^\dA-Za-z-]/g, '').trim();
  const carrier = normalizeAmazonCarrierName(payload.carrier || 'Sagawa');
  const shippingMethod = normalizeAmazonShippingMethod(payload.shippingMethod, carrier);


  const shipDate = String(payload.shipDate || '').trim();
  const fulfillmentDate = shipDate
    ? `${shipDate}T12:00:00+09:00`
    : new Date().toISOString();

  const items = Array.isArray(payload.items) && payload.items.length > 0
    ? payload.items
    : [{
        orderItemId: payload.orderItemId,
        sellerSku: payload.sellerSku,
        quantity: payload.quantity || 1
      }];

  const normalizedItems = items.map((item) => ({
    orderItemId: String(item.orderItemId || '').trim(),
    sellerSku: String(item.sellerSku || '').trim(),
    quantity: toPositiveInt(item.quantity || 1)
  })).filter((item) => item.orderItemId && item.quantity > 0);

  if (!amazonOrderId) {
    throw new Error('amazonOrderId is required');
  }

  if (!trackingNumber) {
    throw new Error('trackingNumber is required');
  }

  if (normalizedItems.length === 0) {
    throw new Error('items with orderItemId are required');
  }

  return {
    amazonOrderId,
    carrier,
    shippingMethod,
    trackingNumber,
    fulfillmentDate,
    items: normalizedItems
  };
}


function normalizeAmazonCarrierName(value) {
  const text = String(value || '').trim().toLowerCase();

  if (
    text.includes('sagawa') ||
    text.includes('佐川') ||
    text.includes('飛脚')
  ) {
    return 'Sagawa';
  }

  if (text.includes('japan') || text.includes('日本郵便')) {
    return 'Japan Post';
  }

  if (text.includes('yamato') || text.includes('ヤマト')) {
    return 'Yamato Transport';
  }

  return String(value || 'Sagawa').trim();
}


function normalizeAmazonShippingMethod(value, carrier) {
  const text = String(value || '').trim();

  if (
    String(carrier || '').toLowerCase() === 'sagawa' ||
    text.includes('佐川') ||
    text.toLowerCase().includes('sagawa')
  ) {
    return 'Hikyaku Express';
  }

  return text || carrier || 'Hikyaku Express';
}


function toPositiveInt(value) {
  const n = Number(String(value || '').replace(/[^\d]/g, ''));

  if (!Number.isInteger(n) || n <= 0) {
    return 1;
  }

  return n;
}


function buildAmazonOrderFulfillmentFeedXml(data) {
  const merchantId = process.env.SPAPI_SELLER_ID || process.env.SELLER_ID || '';

  if (!merchantId) {
    throw new Error('SPAPI_SELLER_ID is not set');
  }

  const itemXml = data.items.map((item) => {
    return (
      '<Item>' +
        '<AmazonOrderItemCode>' + escapeXml(item.orderItemId) + '</AmazonOrderItemCode>' +
        '<Quantity>' + escapeXml(String(item.quantity)) + '</Quantity>' +
      '</Item>'
    );
  }).join('');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">' +
      '<Header>' +
        '<DocumentVersion>1.01</DocumentVersion>' +
        '<MerchantIdentifier>' + escapeXml(merchantId) + '</MerchantIdentifier>' +
      '</Header>' +
      '<MessageType>OrderFulfillment</MessageType>' +
      '<Message>' +
        '<MessageID>1</MessageID>' +
        '<OperationType>Update</OperationType>' +
        '<OrderFulfillment>' +
          '<AmazonOrderID>' + escapeXml(data.amazonOrderId) + '</AmazonOrderID>' +
          '<FulfillmentDate>' + escapeXml(data.fulfillmentDate) + '</FulfillmentDate>' +
          '<FulfillmentData>' +
            '<CarrierName>' + escapeXml(data.carrier) + '</CarrierName>' +
            '<ShippingMethod>' + escapeXml(data.shippingMethod) + '</ShippingMethod>' +
            '<ShipperTrackingNumber>' + escapeXml(data.trackingNumber) + '</ShipperTrackingNumber>' +
          '</FulfillmentData>' +
          itemXml +
        '</OrderFulfillment>' +
      '</Message>' +
    '</AmazonEnvelope>'
  );
}


function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getAmazonAccessToken() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;

  if (!clientId) throw new Error('LWA_CLIENT_ID is not set');
  if (!clientSecret) throw new Error('LWA_CLIENT_SECRET is not set');
  if (!refreshToken) throw new Error('REFRESH_TOKEN is not set');

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const json = await response.json();

  if (!response.ok || !json.access_token) {
    throw new Error('Failed to get Amazon access token: ' + JSON.stringify(json));
  }

  return json.access_token;
}


async function submitAmazonOrderFulfillmentFeed(feedXml) {
  const endpoint = process.env.SPAPI_ENDPOINT;
  const marketplaceId = process.env.SPAPI_MARKETPLACE_ID;

  if (!endpoint) throw new Error('SPAPI_ENDPOINT is not set');
  if (!marketplaceId) throw new Error('SPAPI_MARKETPLACE_ID is not set');

  const accessToken = await getAmazonAccessToken();

  const contentType = 'text/xml; charset=UTF-8';

  const docResponse = await fetch(`${endpoint}/feeds/2021-06-30/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-amz-access-token': accessToken
    },
    body: JSON.stringify({
      contentType
    })
  });

  const docJson = await docResponse.json();

  if (!docResponse.ok || !docJson.feedDocumentId || !docJson.url) {
    throw new Error('createFeedDocument failed: ' + JSON.stringify(docJson));
  }

  const uploadResponse = await fetch(docJson.url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType
    },
    body: Buffer.from(feedXml, 'utf8')
  });

  const uploadText = await uploadResponse.text();

  if (!uploadResponse.ok) {
    throw new Error('Feed document upload failed: HTTP ' + uploadResponse.status + ' ' + uploadText);
  }

  const feedResponse = await fetch(`${endpoint}/feeds/2021-06-30/feeds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-amz-access-token': accessToken
    },
    body: JSON.stringify({
      feedType: 'POST_ORDER_FULFILLMENT_DATA',
      marketplaceIds: [marketplaceId],
      inputFeedDocumentId: docJson.feedDocumentId
    })
  });

  const feedJson = await feedResponse.json();

  if (!feedResponse.ok || !feedJson.feedId) {
    throw new Error('createFeed failed: ' + JSON.stringify(feedJson));
  }

  return {
    feedDocumentId: docJson.feedDocumentId,
    feedId: feedJson.feedId
  };
}
