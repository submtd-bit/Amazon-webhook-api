'use strict';

/**
 * MTD price system - Amazon Orders API bridge
 * Version: 1.0.0
 * Updated: 2026-08-10
 *
 * Purpose:
 *   Provide privacy-minimal Amazon order data to the Price System GAS.
 *
 * Routes:
 *   GET  /price/orders/capabilities
 *   POST /price/orders/snapshot
 *
 * Security:
 *   - Requires x-api-secret or x-amazon-api-secret.
 *   - Does NOT request BUYER or RECIPIENT data from Amazon.
 *   - Does NOT return buyer/address/phone/email data.
 *   - Read-only: never changes Amazon orders, listings, inventory, prices, or ads.
 *
 * Required deps from the existing Render server:
 *   - spApiRequest({ method, path, body, accessToken })
 *   - getLwaAccessToken()
 *   - marketplaceId
 *   - apiSecret
 */

const PRICE_ORDERS_API_VERSION = '2026-01-01';
const PRICE_ORDERS_MAX_LOOKBACK_DAYS = 180;
const PRICE_ORDERS_DEFAULT_LOOKBACK_DAYS = 45;
const PRICE_ORDERS_DEFAULT_MAX_PAGES = 20;
const PRICE_ORDERS_MAX_RESULTS_PER_PAGE = 100;
const PRICE_ORDERS_INCLUDED_DATA = ['FULFILLMENT', 'PROCEEDS', 'CANCELLATION'];

function registerPriceOrderRoutes(app, deps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerPriceOrderRoutes: Express app is required');
  }

  deps = deps || {};
  const spApiRequest = deps.spApiRequest;
  const getLwaAccessToken = deps.getLwaAccessToken;
  const marketplaceId = String(deps.marketplaceId || 'A1VC38T7YXB528').trim();
  const apiSecret = String(deps.apiSecret || '').trim();

  if (typeof spApiRequest !== 'function') {
    throw new Error('registerPriceOrderRoutes: spApiRequest is required');
  }
  if (typeof getLwaAccessToken !== 'function') {
    throw new Error('registerPriceOrderRoutes: getLwaAccessToken is required');
  }
  if (!marketplaceId) {
    throw new Error('registerPriceOrderRoutes: marketplaceId is required');
  }

  function requirePriceOrderSecret(req, res, next) {
    if (!apiSecret) {
      return res.status(500).json({
        ok: false,
        error: 'PRICE_ORDER_API_SECRET_NOT_CONFIGURED'
      });
    }

    const actual = String(
      req.headers['x-api-secret'] ||
      req.headers['x-amazon-api-secret'] ||
      ''
    ).trim();

    if (!actual || actual !== apiSecret) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    return next();
  }

  app.get('/price/orders/capabilities', requirePriceOrderSecret, async (req, res) => {
    try {
      const accessToken = await getLwaAccessToken();

      // Verify the Orders v2026-01-01 permission with a minimal, PII-free request.
      // No BUYER/RECIPIENT/includedData is requested here.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const path = buildSearchOrdersPath_({
        marketplaceId,
        lastUpdatedAfter: since,
        maxResultsPerPage: 1,
        includedData: []
      });

      await spApiRequest({
        method: 'GET',
        path,
        accessToken
      });

      return res.status(200).json({
        ok: true,
        service: 'price-orders-bridge',
        ordersApiVersion: PRICE_ORDERS_API_VERSION,
        marketplaceId,
        maxLookbackDays: PRICE_ORDERS_MAX_LOOKBACK_DAYS,
        privacyMode: 'NO_BUYER_NO_RECIPIENT'
      });
    } catch (err) {
      safeLog_('price orders capabilities failed', err);
      return res.status(502).json({
        ok: false,
        error: 'PRICE_ORDER_CAPABILITIES_FAILED',
        message: safeMessage_(err)
      });
    }
  });

  app.post('/price/orders/snapshot', requirePriceOrderSecret, async (req, res) => {
    try {
      const input = req.body || {};
      const lookbackDays = clampInt_(
        input.lookbackDays,
        1,
        PRICE_ORDERS_MAX_LOOKBACK_DAYS,
        PRICE_ORDERS_DEFAULT_LOOKBACK_DAYS
      );
      const maxPages = clampInt_(
        input.maxPages,
        1,
        20,
        PRICE_ORDERS_DEFAULT_MAX_PAGES
      );

      const accessToken = await getLwaAccessToken();
      const lastUpdatedAfter = new Date(
        Date.now() - lookbackDays * 24 * 60 * 60 * 1000
      ).toISOString();

      const orders = [];
      let paginationToken = '';
      let pages = 0;
      let partial = false;

      for (let page = 0; page < maxPages; page += 1) {
        const path = buildSearchOrdersPath_({
          marketplaceId,
          lastUpdatedAfter,
          maxResultsPerPage: PRICE_ORDERS_MAX_RESULTS_PER_PAGE,
          includedData: PRICE_ORDERS_INCLUDED_DATA,
          paginationToken
        });

        const json = await spApiRequest({
          method: 'GET',
          path,
          accessToken
        });

        pages += 1;

        const pageOrders = extractOrders_(json);
        for (const order of pageOrders) orders.push(order);

        const nextToken = extractNextToken_(json);
        if (!nextToken) {
          paginationToken = '';
          break;
        }

        paginationToken = nextToken;
      }

      if (paginationToken) partial = true;

      // De-duplicate in case an order changes while pagination is running.
      const normalizedByKey = new Map();
      for (const order of orders) {
        const normalizedItems = normalizeOrder_(order);
        for (const item of normalizedItems) {
          const key = [item.orderId, item.orderItemId].join('|');
          normalizedByKey.set(key, item);
        }
      }

      const items = Array.from(normalizedByKey.values()).sort((a, b) => {
        const at = Date.parse(a.lastUpdatedTime || a.orderDate || '') || 0;
        const bt = Date.parse(b.lastUpdatedTime || b.orderDate || '') || 0;
        return bt - at;
      });

      const uniqueOrderIds = new Set(items.map((item) => item.orderId).filter(Boolean));

      return res.status(200).json({
        ok: true,
        service: 'price-orders-bridge',
        ordersApiVersion: PRICE_ORDERS_API_VERSION,
        marketplaceId,
        lookbackDays,
        pages,
        partial,
        orderCount: uniqueOrderIds.size,
        count: items.length,
        items
      });
    } catch (err) {
      safeLog_('price orders snapshot failed', err);
      return res.status(502).json({
        ok: false,
        error: 'PRICE_ORDER_SNAPSHOT_FAILED',
        message: safeMessage_(err)
      });
    }
  });
}

function buildSearchOrdersPath_(options) {
  const params = new URLSearchParams();
  params.set('lastUpdatedAfter', options.lastUpdatedAfter);
  params.set('marketplaceIds', options.marketplaceId);
  params.set('maxResultsPerPage', String(options.maxResultsPerPage || 100));

  const includedData = Array.isArray(options.includedData) ? options.includedData : [];
  if (includedData.length) {
    params.set('includedData', includedData.join(','));
  }

  if (options.paginationToken) {
    params.set('paginationToken', options.paginationToken);
  }

  return '/orders/' + PRICE_ORDERS_API_VERSION + '/orders?' + params.toString();
}

function extractOrders_(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json.orders)) return json.orders;
  if (json.payload && Array.isArray(json.payload.orders)) return json.payload.orders;
  if (json.payload && Array.isArray(json.payload.Orders)) return json.payload.Orders;
  return [];
}

function extractNextToken_(json) {
  if (!json || typeof json !== 'object') return '';
  return String(
    (json.pagination && json.pagination.nextToken) ||
    (json.payload && json.payload.pagination && json.payload.pagination.nextToken) ||
    ''
  ).trim();
}

function normalizeOrder_(order) {
  order = order || {};
  const orderId = String(order.orderId || order.AmazonOrderId || '').trim();
  const orderDate = order.createdTime || order.PurchaseDate || '';
  const lastUpdatedTime = order.lastUpdatedTime || order.LastUpdateDate || '';
  const orderFulfillment = order.fulfillment || {};
  const fulfillmentStatus = String(
    orderFulfillment.fulfillmentStatus || order.OrderStatus || ''
  ).trim().toUpperCase();
  const fulfilledBy = String(
    orderFulfillment.fulfilledBy || order.FulfillmentChannel || ''
  ).trim().toUpperCase();

  const orderItems = Array.isArray(order.orderItems)
    ? order.orderItems
    : (Array.isArray(order.Items) ? order.Items : []);

  return orderItems.map((item) => {
    item = item || {};
    const product = item.product || {};
    const quantityOrdered = finiteNumber_(item.quantityOrdered ?? item.QuantityOrdered, 0);
    const quantityFulfilled = finiteNumber_(
      (item.fulfillment && item.fulfillment.quantityFulfilled) ?? item.QuantityFulfilled,
      0
    );

    const priceInfo = extractUnitPrice_(item, quantityOrdered);
    const promotionDiscount = extractDiscount_(item);

    return {
      orderId,
      orderDate,
      lastUpdatedTime,
      fulfillmentStatus,
      fulfilledBy,
      orderItemId: String(item.orderItemId || item.OrderItemId || '').trim(),
      sellerSku: String(product.sellerSku || item.SellerSKU || '').trim(),
      asin: String(product.asin || item.ASIN || '').trim(),
      title: String(product.title || item.Title || '').trim(),
      quantityOrdered,
      quantityFulfilled,
      unitPrice: priceInfo.amount,
      currency: priceInfo.currency || 'JPY',
      promotionDiscount
    };
  }).filter((item) => item.orderId && item.orderItemId);
}

function extractUnitPrice_(item, quantityOrdered) {
  const product = item.product || {};
  const directMoney = product.price && product.price.unitPrice;
  const direct = money_(directMoney);
  if (direct.amount !== null) return direct;

  const itemBreakdown = findBreakdown_(item, 'ITEM');
  const subtotal = money_(itemBreakdown && itemBreakdown.subtotal);
  if (subtotal.amount !== null) {
    return {
      amount: quantityOrdered > 0 ? subtotal.amount / quantityOrdered : subtotal.amount,
      currency: subtotal.currency
    };
  }

  const legacy = finiteOrNull_(
    item.ItemPrice && (item.ItemPrice.Amount ?? item.ItemPrice.amount)
  );
  if (legacy !== null) {
    return {
      amount: quantityOrdered > 0 ? legacy / quantityOrdered : legacy,
      currency: String(
        (item.ItemPrice && (item.ItemPrice.CurrencyCode || item.ItemPrice.currencyCode)) || 'JPY'
      )
    };
  }

  return { amount: null, currency: 'JPY' };
}

function extractDiscount_(item) {
  const breakdown = findBreakdown_(item, 'DISCOUNT');
  const money = money_(breakdown && breakdown.subtotal);
  if (money.amount !== null) return money.amount;

  const legacy = finiteOrNull_(
    item.PromotionDiscount &&
    (item.PromotionDiscount.Amount ?? item.PromotionDiscount.amount)
  );
  return legacy === null ? 0 : legacy;
}

function findBreakdown_(item, type) {
  const proceeds = item && item.proceeds;
  const breakdowns = proceeds && Array.isArray(proceeds.breakdowns)
    ? proceeds.breakdowns
    : [];
  return breakdowns.find((x) => String(x && x.type || '').toUpperCase() === type) || null;
}

function money_(value) {
  if (!value || typeof value !== 'object') {
    return { amount: null, currency: '' };
  }
  return {
    amount: finiteOrNull_(value.amount ?? value.Amount),
    currency: String(value.currencyCode || value.CurrencyCode || '')
  };
}

function finiteOrNull_(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteNumber_(value, fallback) {
  const n = finiteOrNull_(value);
  return n === null ? fallback : n;
}

function clampInt_(value, min, max, fallback) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = fallback;
  n = Math.floor(n);
  return Math.max(min, Math.min(max, n));
}

function safeMessage_(err) {
  const text = String(err && err.message ? err.message : err || 'Unknown error');
  // Keep client errors useful without leaking credentials/tokens.
  return text
    .replace(/Atza\|[^\s"']+/g, '[REDACTED_TOKEN]')
    .slice(0, 1500);
}

function safeLog_(label, err) {
  console.error(label, {
    name: err && err.name ? err.name : '',
    message: safeMessage_(err)
  });
}

module.exports = {
  registerPriceOrderRoutes
};
