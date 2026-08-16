import fs from "node:fs";

const file = "index.js";
let src = fs.readFileSync(file, "utf8");
const original = src;

const helperStart = "async function updateAmazonListingQuantity({ sku, quantity }) {";
const helperEnd = "\n\nregisterAmazonAdsDecisionRoutes";

if (src.includes(helperStart)) {
  const start = src.indexOf(helperStart);
  const end = src.indexOf(helperEnd, start);
  if (end < 0) throw new Error("Could not find end of updateAmazonListingQuantity block");

  const replacement = `function buildAmazonInventoryPatch({
  sku,
  quantity,
  reservation = false,
  leadTimeBusinessDays = 0,
  restockDate = "",
  clearReservationMetadata = false
}) {
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

  const availability = {
    fulfillment_channel_code: "DEFAULT",
    quantity: qty
  };

  const isReservation = reservation === true;
  const shouldClearReservationMetadata = clearReservationMetadata === true;

  if (isReservation) {
    const leadDays = Number(leadTimeBusinessDays);
    const dateText = String(restockDate || "").trim();

    if (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > 30) {
      throw new Error("leadTimeBusinessDays must be an integer between 1 and 30 for reservation stock");
    }

    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(dateText) || Number.isNaN(Date.parse(dateText + "T00:00:00Z"))) {
      throw new Error("restockDate must be YYYY-MM-DD for reservation stock");
    }

    availability.lead_time_to_ship_max_days = leadDays;
    availability.restock_date = dateText;
  }

  // Amazonのmergeはquantityのみを更新し、restock_date / lead_time_to_ship_max_daysを保持する。
  // 予約開始時はreplaceで3項目を確定し、予約解除時はreplaceのquantity-onlyで予約メタデータを消す。
  const operation = (isReservation || shouldClearReservationMetadata) ? "replace" : "merge";

  return {
    qty,
    reservation: isReservation,
    clearReservationMetadata: shouldClearReservationMetadata,
    operation,
    availability,
    body: {
      productType: "PRODUCT",
      patches: [
        {
          op: operation,
          path: "/attributes/fulfillment_availability",
          value: [availability]
        }
      ]
    }
  };
}

async function updateAmazonListingQuantity(params) {
  const patch = buildAmazonInventoryPatch(params);
  const accessToken = await getLwaAccessToken();

  const result = await spApiRequest({
    method: "PATCH",
    path:
      "/listings/2021-08-01/items/" + encodeURIComponent(SELLER_ID) + "/" + encodeURIComponent(params.sku) +
      "?marketplaceIds=" + encodeURIComponent(MARKETPLACE_ID),
    body: patch.body,
    accessToken
  });

  return {
    amazon: result,
    operation: patch.operation,
    submittedAvailability: patch.availability
  };
}

async function previewAmazonListingQuantity(params) {
  const patch = buildAmazonInventoryPatch(params);
  const accessToken = await getLwaAccessToken();

  const result = await spApiRequest({
    method: "PATCH",
    path:
      "/listings/2021-08-01/items/" + encodeURIComponent(SELLER_ID) + "/" + encodeURIComponent(params.sku) +
      "?marketplaceIds=" + encodeURIComponent(MARKETPLACE_ID) + "&mode=VALIDATION_PREVIEW",
    body: patch.body,
    accessToken
  });

  return {
    amazon: result,
    operation: patch.operation,
    submittedAvailability: patch.availability
  };
}`;

  src = src.slice(0, start) + replacement + src.slice(end);
} else if (!src.includes("function buildAmazonInventoryPatch({")) {
  throw new Error("Expected Amazon inventory helper marker not found");
}

const routeStartMarker = "// Amazon在庫更新 中継API";
const routeEndMarker = "\napp.get(\"/version\"";

if (src.includes(routeStartMarker) && !src.includes("availabilityPreview")) {
  const start = src.indexOf(routeStartMarker);
  const end = src.indexOf(routeEndMarker, start);
  if (end < 0) throw new Error("Could not find end of /amazon/stock/update route");

  const replacement = `// Amazon在庫更新 中継API
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

    const {
      sku,
      quantity,
      dryRun,
      reservation,
      leadTimeBusinessDays,
      restockDate,
      clearReservationMetadata
    } = req.body || {};

    if (!sku) {
      return res.status(400).json({ ok: false, error: "sku is required" });
    }

    if (quantity === undefined || quantity === null || quantity === "") {
      return res.status(400).json({ ok: false, error: "quantity is required" });
    }

    const params = {
      sku: String(sku).trim(),
      quantity: Number(quantity),
      reservation: reservation === true,
      leadTimeBusinessDays: Number(leadTimeBusinessDays || 0),
      restockDate: String(restockDate || "").trim(),
      clearReservationMetadata: clearReservationMetadata === true
    };

    if (dryRun === true) {
      const preview = await previewAmazonListingQuantity(params);

      console.log("✅ Amazon stock validation preview:", {
        sku: params.sku,
        quantity: params.quantity,
        reservation: params.reservation,
        clearReservationMetadata: params.clearReservationMetadata,
        operation: preview.operation,
        availability: preview.submittedAvailability,
        result: preview.amazon
      });

      return res.status(200).json({
        ok: true,
        dryRun: true,
        sku: params.sku,
        quantity: params.quantity,
        reservation: params.reservation,
        clearReservationMetadata: params.clearReservationMetadata,
        operation: preview.operation,
        availabilityPreview: preview.submittedAvailability,
        result: preview.amazon,
        message: "AMAZON VALIDATION PREVIEW OK"
      });
    }

    const result = await updateAmazonListingQuantity(params);

    console.log("✅ Amazon stock live update:", {
      sku: params.sku,
      quantity: params.quantity,
      reservation: params.reservation,
      clearReservationMetadata: params.clearReservationMetadata,
      operation: result.operation,
      availability: result.submittedAvailability,
      result: result.amazon
    });

    return res.status(200).json({
      ok: true,
      dryRun: false,
      sku: params.sku,
      quantity: params.quantity,
      reservation: params.reservation,
      clearReservationMetadata: params.clearReservationMetadata,
      operation: result.operation,
      availability: result.submittedAvailability,
      result: result.amazon
    });

  } catch (err) {
    console.error("❌ Error in /amazon/stock/update:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});`;

  src = src.slice(0, start) + replacement + src.slice(end);
}

src = src.replace(
  'version: "2026-08-12-price-orders-safety-v1.0.2"',
  'version: "2026-08-16-reservation-metadata-v1.0.4"'
);

if (src === original) {
  console.log("Reservation patch already applied; no changes.");
  process.exit(0);
}

fs.writeFileSync(file, src, "utf8");
console.log("Reservation metadata patch applied to index.js");
