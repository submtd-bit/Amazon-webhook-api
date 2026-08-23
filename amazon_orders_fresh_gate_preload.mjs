import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-23-amazon-orders-fresh-gate-v1.0.0";
const ROUTE = "/amazon/orders/fresh-gate";
const JP_MARKETPLACE = process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528";
const ENDPOINT = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
const MAX_SKUS = 50;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 25000;
const originalListen = express.application.listen;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function requireTextEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
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

async function getLwaAccessToken() {
  const response = await fetchWithTimeout("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: requireTextEnv("REFRESH_TOKEN"),
      client_id: requireTextEnv("LWA_CLIENT_ID"),
      client_secret: requireTextEnv("LWA_CLIENT_SECRET")
    })
  });
  const json = safeJsonParse(await response.text());
  if (!response.ok || !json.access_token) {
    throw new Error(`LWA token error: HTTP ${response.status}`);
  }
  return json.access_token;
}

async function spGet(accessToken, path, params) {
  const url = new URL(`${ENDPOINT}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, String(v)));
    else if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetchWithTimeout(url.toString(), {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json"
    }
  });
  const text = await response.text();
  const json = safeJsonParse(text);
  if (!response.ok) {
    throw new Error(`SP-API GET ${path} failed: HTTP ${response.status} ${JSON.stringify(json).slice(0, 1000)}`);
  }
  return json;
}

async function fetchOpenOrders(accessToken, lastUpdatedAfter) {
  const orders = [];
  let nextToken = "";
  let page = 0;

  do {
    page++;
    if (page > MAX_PAGES) throw new Error("Orders pagination exceeded safety limit");

    const params = nextToken
      ? { NextToken: nextToken }
      : {
          MarketplaceIds: [JP_MARKETPLACE],
          LastUpdatedAfter: lastUpdatedAfter,
          OrderStatuses: ["Unshipped", "PartiallyShipped"],
          MaxResultsPerPage: 100
        };

    const json = await spGet(accessToken, "/orders/v0/orders", params);
    const payload = json?.payload || {};
    if (Array.isArray(payload.Orders)) orders.push(...payload.Orders);
    nextToken = String(payload.NextToken || "").trim();
  } while (nextToken);

  return orders;
}

async function fetchOrderItems(accessToken, amazonOrderId) {
  const items = [];
  let nextToken = "";
  let page = 0;

  do {
    page++;
    if (page > MAX_PAGES) throw new Error(`OrderItems pagination exceeded safety limit: ${amazonOrderId}`);

    const params = nextToken ? { NextToken: nextToken } : {};
    const json = await spGet(
      accessToken,
      `/orders/v0/orders/${encodeURIComponent(amazonOrderId)}/orderItems`,
      params
    );
    const payload = json?.payload || {};
    if (Array.isArray(payload.OrderItems)) items.push(...payload.OrderItems);
    nextToken = String(payload.NextToken || "").trim();
  } while (nextToken);

  return items;
}

function normalizeSku(value) {
  return String(value || "").trim().toLowerCase();
}

async function handler(req, res) {
  try {
    const expectedSecret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
    if (!expectedSecret) {
      return res.status(500).json({ ok: false, externalChanges: 0, error: "AMAZON_STOCK_API_SECRET is not set" });
    }
    if (String(req.headers["x-api-secret"] || "") !== expectedSecret) {
      return res.status(401).json({ ok: false, externalChanges: 0, error: "Unauthorized" });
    }

    const inputSkus = Array.isArray(req.body?.skus) ? req.body.skus : [];
    const skus = [...new Set(inputSkus.map(v => String(v || "").trim()).filter(Boolean))];
    if (!skus.length) throw new Error("skus is required");
    if (skus.length > MAX_SKUS) throw new Error(`skus max ${MAX_SKUS}`);

    const lookbackHoursRaw = Number(req.body?.lookbackHours ?? 72);
    const lookbackHours = Number.isFinite(lookbackHoursRaw)
      ? Math.min(168, Math.max(1, Math.floor(lookbackHoursRaw)))
      : 72;
    const lastUpdatedAfter = new Date(Date.now() - lookbackHours * 3600000).toISOString();
    const skuSet = new Set(skus.map(normalizeSku));

    const accessToken = await getLwaAccessToken();
    const orders = await fetchOpenOrders(accessToken, lastUpdatedAfter);
    const matching = [];

    for (const order of orders) {
      const orderId = String(order?.AmazonOrderId || "").trim();
      if (!orderId) continue;
      const items = await fetchOrderItems(accessToken, orderId);
      for (const item of items) {
        const sellerSku = String(item?.SellerSKU || "").trim();
        if (!skuSet.has(normalizeSku(sellerSku))) continue;
        matching.push({
          amazonOrderId: orderId,
          orderStatus: String(order?.OrderStatus || ""),
          purchaseDate: String(order?.PurchaseDate || ""),
          lastUpdateDate: String(order?.LastUpdateDate || ""),
          sellerSku,
          orderItemId: String(item?.OrderItemId || ""),
          quantityOrdered: Number(item?.QuantityOrdered || 0),
          quantityShipped: Number(item?.QuantityShipped || 0)
        });
      }
    }

    const totalMatchingOpenQty = matching.reduce((sum, x) => sum + Math.max(0, Number(x.quantityOrdered || 0)), 0);

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      marketplaceId: JP_MARKETPLACE,
      lookbackHours,
      lastUpdatedAfter,
      requestedSkus: skus,
      openOrderCount: orders.length,
      matchingLineCount: matching.length,
      totalMatchingOpenQty,
      matching,
      checkedAt: new Date().toISOString(),
      externalChanges: 0
    });
  } catch (err) {
    console.error("Amazon orders fresh gate error", err?.message || String(err));
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      externalChanges: 0,
      error: err?.message || String(err)
    });
  }
}

express.application.listen = function amazonOrdersFreshGateListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
