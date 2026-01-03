import express from "express";

const app = express();
app.use(express.json());

// ---- 共通設定 ----
const LWA_CLIENT_ID     = process.env.LWA_CLIENT_ID;
const LWA_CLIENT_SECRET = process.env.LWA_CLIENT_SECRET;
const REFRESH_TOKEN     = process.env.REFRESH_TOKEN;
const MARKETPLACE_ID    = process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528"; // JP

// ---- LWA リフレッシュトークンから access_token を取得 ----
async function getLwaAccessToken() {
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ LWA token error:", res.status, text);
    throw new Error(`LWA token error: ${res.status}`);
  }

  const json = await res.json();
  return json.access_token;
}

// ---- SP-API: orderItems を取得（/orders で Items を埋めるため） ----
async function getOrderItems(accessToken, orderId) {
  const r = await fetch(
    `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
    {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json",
      },
    }
  );

  const text = await r.text();
  if (!r.ok) {
    console.error("❌ getOrderItems error:", orderId, r.status, text);
    return []; // 失敗しても一覧自体は返す
  }

  const json = text ? JSON.parse(text) : {};
  const orderItems = json?.payload?.OrderItems || json?.OrderItems || [];

  // GAS 側の importAmazonOrders() が期待するキーに合わせる
  return orderItems.map((oi) => ({
    SellerSKU: oi.SellerSKU || "",
    Title: oi.Title || "",
    QuantityOrdered: oi.QuantityOrdered ?? 1,
  }));
}

// ---- health（Renderスリープ起こし用）----
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ---- 単一注文取得（切り分け用） ----
app.get("/order/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const accessToken = await getLwaAccessToken();

    const r = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders/${encodeURIComponent(orderId)}`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
        },
      }
    );

    const text = await r.text();
    if (!r.ok) {
      console.error("❌ GetOrder error:", r.status, text);
      return res.status(r.status).json({
        error: "GetOrder error",
        status: r.status,
        body: text,
      });
    }

    return res.status(200).json(JSON.parse(text));
  } catch (e) {
    console.error("❌ Error in /order/:orderId", e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// ---- Webhook（今はログ用） ----
app.post("/webhook", (req, res) => {
  console.log("🔔 Webhook received:", req.body);
  res.status(200).json({ status: "ok" });
});

// ---- Orders API (/orders) ----
app.get("/orders", async (req, res) => {
  try {
    const since = req.query.createdAfter
      ? new Date(req.query.createdAfter)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const createdAfter = since.toISOString();

    const accessToken = await getLwaAccessToken();

    // ★ OrderStatuses は環境によってカンマ区切りが効かない場合があるので、
    // 必要なら次の行を「&OrderStatuses=Unshipped&OrderStatuses=PartiallyShipped」に変更してください。
    const ordersUrl =
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders?` +
      `MarketplaceIds=${encodeURIComponent(MARKETPLACE_ID)}` +
      `&CreatedAfter=${encodeURIComponent(createdAfter)}` +
      `&OrderStatuses=Unshipped,PartiallyShipped`;

    const ordersRes = await fetch(ordersUrl, {
      method: "GET",
      headers: {
        "x-amz-access-token": accessToken,
        accept: "application/json",
      },
    });

    const text = await ordersRes.text();
    if (!ordersRes.ok) {
      console.error("❌ Orders API error:", ordersRes.status, text);
      return res
        .status(ordersRes.status)
        .json({ error: "Orders API error", status: ordersRes.status, body: text });
    }

    const ordersJson = text ? JSON.parse(text) : {};
    const rawOrders  = ordersJson?.payload?.Orders || [];

    console.log("✅ /orders rawOrders count:", rawOrders.length);

    // ★ 各注文の明細を取って Items に埋める（順次実行・確実）
    // 注文数が多い場合は、後で並列化や件数制限を入れて最適化できます。
    const simplified = [];
    for (const o of rawOrders) {
      const items = await getOrderItems(accessToken, o.AmazonOrderId);

      simplified.push({
        AmazonOrderId: o.AmazonOrderId,
        PurchaseDate:  o.PurchaseDate,
        OrderStatus:   o.OrderStatus,

        // 取れる範囲で入れる（無い注文もある）
        BuyerName:  o?.BuyerInfo?.BuyerName || "",
        BuyerEmail: o?.BuyerInfo?.BuyerEmail || "",

        PostalCode:    o?.ShippingAddress?.PostalCode || "",
        StateOrRegion: o?.ShippingAddress?.StateOrRegion || "",
        City:          o?.ShippingAddress?.City || "",
        AddressLine1:  o?.ShippingAddress?.AddressLine1 || "",
        AddressLine2:  o?.ShippingAddress?.AddressLine2 || "",
        Phone:         o?.ShippingAddress?.Phone || "",
        ShipName: o?.ShippingAddress?.Name || "",

        OrderTotal: o?.OrderTotal?.Amount ? Number(o.OrderTotal.Amount) : null,
        Currency:   o?.OrderTotal?.CurrencyCode || null,

        Items: items,
      });
    }

    return res.status(200).json(simplified);
  } catch (err) {
    console.error("❌ Error in /orders:", err);
    return res.status(500).json({ error: err.message || "SP-API error" });
  }
});

// ---- 出荷通知API (/confirm-shipment) ----
app.post("/confirm-shipment", async (req, res) => {
  try {
    const { orderId: rawOrderId, trackingNumber } = req.body;

    if (!rawOrderId || !trackingNumber) {
      return res.status(400).json({ error: "orderId と trackingNumber は必須です" });
    }

    const orderId = String(rawOrderId).trim();
    const accessToken = await getLwaAccessToken();

    const itemsRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
        },
      }
    );

    const itemsText = await itemsRes.text();
    if (!itemsRes.ok) {
      console.error("❌ getOrderItems error:", itemsRes.status, itemsText);
      return res.status(itemsRes.status).json({
        error: "getOrderItems error",
        status: itemsRes.status,
        body: itemsText,
      });
    }

    const itemsJson  = itemsText ? JSON.parse(itemsText) : {};
    const orderItems = itemsJson?.payload?.OrderItems || itemsJson?.OrderItems || []; // ★payload対応

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
        quantity: oi.QuantityOrdered,
      })),
    };

    const body = { marketplaceId: MARKETPLACE_ID, packageDetail };

    const confirmRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`,
      {
        method: "POST",
        headers: {
          "x-amz-access-token": accessToken,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const confirmText = await confirmRes.text();
    if (!confirmRes.ok) {
      console.error("❌ confirmShipment error:", confirmRes.status, confirmText);
      return res.status(confirmRes.status).json({
        error: "confirmShipment error",
        status: confirmRes.status,
        body: confirmText,
      });
    }

    console.log("✅ confirmShipment success:", orderId, confirmText);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Error in /confirm-shipment:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---- Render が使うポート ----
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
