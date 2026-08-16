import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const originalPost = express.application.post;

function safeJsonParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { rawText: text }; }
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
      client_secret: clientSecret
    })
  });
  const text = await response.text();
  const json = safeJsonParse(text);
  if (!response.ok || !json.access_token) {
    throw new Error(`LWA token error: ${response.status}`);
  }
  return json.access_token;
}

function buildInventoryPatch(payload) {
  const sku = String(payload.sku || "").trim();
  const quantity = Number(payload.quantity);
  const reservation = payload.reservation === true;
  const clearReservationMetadata = payload.clearReservationMetadata === true;
  const dryRun = payload.dryRun === true;
  const leadDays = Number(payload.leadTimeBusinessDays || 0);
  const restockDate = String(payload.restockDate || "").trim();

  if (!sku) throw new Error("sku is required");
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error("quantity must be a non-negative number");
  }

  const availability = {
    fulfillment_channel_code: "DEFAULT",
    quantity
  };

  if (reservation) {
    if (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > 30) {
      throw new Error("leadTimeBusinessDays must be an integer between 1 and 30 for reservation stock");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(restockDate) || Number.isNaN(Date.parse(`${restockDate}T00:00:00Z`))) {
      throw new Error("restockDate must be YYYY-MM-DD for reservation stock");
    }
    availability.lead_time_to_ship_max_days = leadDays;
    availability.restock_date = restockDate;
  }

  // Amazon VALIDATION_PREVIEW does not accept merge operations.
  // For DRY RUN only, validate the same quantity payload with replace.
  // LIVE quantity-only updates still use merge so reservation metadata is preserved.
  const operation = (reservation || clearReservationMetadata || dryRun) ? "replace" : "merge";
  return { sku, quantity, reservation, clearReservationMetadata, operation, availability };
}

async function submitPatch(patch, validationPreview) {
  const sellerId = process.env.SPAPI_SELLER_ID;
  const marketplaceId = process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528";
  const endpoint = process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com";
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");

  const accessToken = await getLwaAccessToken();
  const query = new URLSearchParams({ marketplaceIds: marketplaceId });
  if (validationPreview) query.set("mode", "VALIDATION_PREVIEW");

  const url = `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(patch.sku)}?${query}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "x-amz-access-token": accessToken,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      productType: "PRODUCT",
      patches: [{
        op: patch.operation,
        path: "/attributes/fulfillment_availability",
        value: [patch.availability]
      }]
    })
  });
  const text = await response.text();
  const json = safeJsonParse(text);
  if (!response.ok) {
    throw new Error(`SP-API request error: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function reservationStockHandler(req, res) {
  try {
    const secret = req.headers["x-api-secret"];
    if (!process.env.AMAZON_STOCK_API_SECRET) {
      return res.status(500).json({ ok: false, error: "AMAZON_STOCK_API_SECRET is not set" });
    }
    if (secret !== process.env.AMAZON_STOCK_API_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const patch = buildInventoryPatch(req.body || {});
    const dryRun = req.body?.dryRun === true;
    const result = await submitPatch(patch, dryRun);

    console.log(dryRun ? "Amazon stock validation preview" : "Amazon stock live update", {
      sku: patch.sku,
      quantity: patch.quantity,
      reservation: patch.reservation,
      clearReservationMetadata: patch.clearReservationMetadata,
      operation: patch.operation,
      availability: patch.availability,
      result
    });

    return res.status(200).json({
      ok: true,
      dryRun,
      sku: patch.sku,
      quantity: patch.quantity,
      reservation: patch.reservation,
      clearReservationMetadata: patch.clearReservationMetadata,
      operation: patch.operation,
      ...(dryRun ? { availabilityPreview: patch.availability } : { availability: patch.availability }),
      result,
      message: dryRun ? "AMAZON VALIDATION PREVIEW OK" : "AMAZON LIVE UPDATE ACCEPTED"
    });
  } catch (err) {
    console.error("Amazon reservation stock update error", err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}

express.application.post = function patchedPost(path, ...handlers) {
  if (path === "/amazon/stock/update") {
    return originalPost.call(this, path, reservationStockHandler);
  }
  return originalPost.call(this, path, ...handlers);
};
