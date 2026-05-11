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

// 価格取得条件。
// Render Environment Variables に PRICING_ITEM_CONDITIONS=Refurbished を追加。
// 取れない場合は Refurbished,Used に変更して検証。
const PRICING_ITEM_CONDITIONS = (process.env.PRICING_ITEM_CONDITIONS || "Refurbished")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---- 発送元固定（Render Environment Variables）----
const SHIPPER_TEL   = process.env.SHIPPER_TEL || "";
const REQUESTER_TEL = process.env.REQUESTER_TEL || "";

const SENDER_POST   = process.env.SENDER_POST || "";
const SENDER_ADDR1  = process.env.SENDER_ADDR1 || "";
const SENDER_NAME1  = process.env.SENDER_NAME1 || "";
const SENDER_NAME2  = process.env.SENDER_NAME2 || "";

// -------------------- Benchmark Master --------------------
// G83は16GB/SSD256GBのみ。512GB・8GB・S73疑いは除外。
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
  const name = ship?.Name || "";

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

function extractPointsValue(offer) {
  const points = offer?.Points || offer?.points;
  if (!points) return null;

  const pointsNumber = num(points.PointsNumber ?? points.pointsNumber);
  if (pointsNumber !== null) return pointsNumber;

  const monetaryValue = extractAmount(points.PointsMonetaryValue ?? points.pointsMonetaryValue);
  if (monetaryValue !== null) return monetaryValue;

  return null;
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

  const points = extractPointsValue(offer);
  const coupon = null;

  const effectivePrice = landedPrice !== null
    ? landedPrice - (points || 0) - (coupon || 0)
    : null;

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
    subCondition: offer?.SubCondition || "",
    priceSource: "Offers"
  };
}

function normalizeLowestPrice(lp) {
  const listingPrice = extractAmount(lp?.ListingPrice ?? lp?.listingPrice);
  const landedPriceFromApi = extractAmount(lp?.LandedPrice ?? lp?.landedPrice);
  const shippingPrice = extractAmount(lp?.Shipping ?? lp?.shipping) ?? 0;

  const points = extractPointsNumber(lp?.Points ?? lp?.points);
  const coupon = null;

  // Summary.LowestPrices の LandedPrice は、JPでは ListingPrice + Shipping - Points の形で返ることがあります。
  // そのため LandedPrice が返ってきている場合はAPI値を優先します。
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
    subCondition: lp?.condition || lp?.Condition || "",
    priceSource: "Summary.LowestPrices"
  };
}

function pickBestOffer(offers) {
  if (!Array.isArray(offers) || offers.length === 0) return null;

  const normalized = offers
    .map(normalizeOffer)
    .filter((o) => o.landedPrice !== null);

  if (normalized.length === 0) return null;

  normalized.sort((a, b) => {
    if (a.effectivePrice !== b.effectivePrice) return a.effectivePrice - b.effectivePrice;
    if (a.isBuyBoxWinner && !b.isBuyBoxWinner) return -1;
    if (!a.isBuyBoxWinner && b.isBuyBoxWinner) return 1;
    return a.landedPrice - b.landedPrice;
  });

  return normalized[0];
}

function pickBestLowestPrice(lowestPrices) {
  if (!Array.isArray(lowestPrices) || lowestPrices.length === 0) return null;

  const normalized = lowestPrices
    .map(normalizeLowestPrice)
    .filter((o) => o.landedPrice !== null);

  if (normalized.length === 0) return null;

  normalized.sort((a, b) => {
    if (a.effectivePrice !== b.effectivePrice) return a.effectivePrice - b.effectivePrice;
    return a.landedPrice - b.landedPrice;
  });

  return normalized[0];
}

function parseBatchResponseForItem(masterItem, batchItem, itemCondition) {
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

  const lowestPrices =
    summary?.LowestPrices ||
    summary?.lowestPrices ||
    [];

  const offerCount =
    num(summary?.TotalOfferCount) ??
    num(summary?.totalOfferCount) ??
    num(payload?.TotalOfferCount) ??
    (Array.isArray(offers) ? offers.length : 0);

  const bestOffer = pickBestOffer(offers);
  const bestSummaryPrice = pickBestLowestPrice(lowestPrices);
  const bestPrice = bestOffer || bestSummaryPrice;

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
      itemCondition,
      memo: statusCode === 200
        ? `Offers価格なし / LowestPrices価格なし / offerCount=${offerCount}`
        : `API statusCode=${statusCode}`
    };
  }

  const effective = bestPrice.effectivePrice;
  const avg = num(masterItem.sourceAvgPrice);
  const avgPriceDiff = effective !== null && avg !== null ? effective - avg : null;

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
    confidence: bestPrice.priceSource === "Offers" ? "high" : "medium",
    avgPriceDiff,
    itemCondition,
    memo:
      bestPrice.priceSource === "Offers"
        ? (bestPrice.isBuyBoxWinner ? "Offers / BuyBoxWinner offer" : "Offers / lowest effective offer")
        : "Summary.LowestPrices / lowest landed price"
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
      const parsed = parseBatchResponseForItem(masterItem, batchItem, itemCondition);

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
      itemCondition: "",
      memo: "価格取得処理に到達しませんでした"
    };
  });
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
    OrderItemId: oi.OrderItemId || ""
  }));
}

// -------------------- 共通：注文+明細を取得 --------------------
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
    const items = await getOrderItems(accessToken, o.AmazonOrderId);

    enriched.push({
      AmazonOrderId: o.AmazonOrderId,
      PurchaseDate:  o.PurchaseDate,
      OrderStatus:   o.OrderStatus,

      BuyerName:  o?.BuyerInfo?.BuyerName || "",
      BuyerEmail: o?.BuyerInfo?.BuyerEmail || "",

      ShippingAddress: {
        Name:          o?.ShippingAddress?.Name || "",
        Phone:         o?.ShippingAddress?.Phone || "",
        PostalCode:    o?.ShippingAddress?.PostalCode || "",
        StateOrRegion: o?.ShippingAddress?.StateOrRegion || "",
        City:          o?.ShippingAddress?.City || "",
        AddressLine1:  o?.ShippingAddress?.AddressLine1 || "",
        AddressLine2:  o?.ShippingAddress?.AddressLine2 || "",
        AddressLine3:  o?.ShippingAddress?.AddressLine3 || ""
      },

      OrderTotal: o?.OrderTotal?.Amount ? Number(o.OrderTotal.Amount) : null,
      Currency:   o?.OrderTotal?.CurrencyCode || null,

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
      useForPriceMonitor: true
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
      results.push(parseBatchResponseForItem(testItem, response, itemCondition));
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
      Phone:         o.ShippingAddress.Phone,
      ShipName:      o.ShippingAddress.Name,

      OrderTotal: o.OrderTotal,
      Currency:   o.Currency,
      Items:      o.Items
    }));

    return res.status(200).json(simplified);
  } catch (err) {
    console.error("❌ Error in /orders:", err);
    return res.status(500).json({ error: err.message || "SP-API error" });
  }
});

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

    const body = { marketplaceId: MARKETPLACE_ID, packageDetail };

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

app.get("/version", (req, res) => {
  res.status(200).json({
    version: "2026-05-11-benchmark-prices-lwa-v3-points-lowestprices",
    marketplaceId: MARKETPLACE_ID,
    endpoint: SPAPI_ENDPOINT,
    pricingConditions: PRICING_ITEM_CONDITIONS
  });
});

// ---- Render が使うポート ----
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
