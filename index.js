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

// ---- Webhook（今はログ用） ----
app.post("/webhook", (req, res) => {
  console.log("🔔 Webhook received:", req.body);
  res.status(200).json({ status: "ok" });
});

// ---- Orders API 本番実装 (/orders) ----
app.get("/orders", async (req, res) => {
  try {
    // どこから取得するか：クエリで指定なければ過去24時間
    const since = req.query.createdAfter
      ? new Date(req.query.createdAfter)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const createdAfter = since.toISOString();

    // 1) LWAアクセストークン取得
    const accessToken = await getLwaAccessToken();

    // 2) Orders API を呼ぶ
    const ordersRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders?` +
        `MarketplaceIds=${encodeURIComponent(MARKETPLACE_ID)}` +
        `&CreatedAfter=${encodeURIComponent(createdAfter)}` +
        `&OrderStatuses=Unshipped,PartiallyShipped`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
        },
      }
    );

    if (!ordersRes.ok) {
      const text = await ordersRes.text();
      console.error("❌ Orders API error:", ordersRes.status, text);
      return res
        .status(ordersRes.status)
        .json({ error: "Orders API error", status: ordersRes.status, body: text });
    }

    const ordersJson = await ordersRes.json();
    const rawOrders  = ordersJson.Orders || [];

    // まずはヘッダ情報だけ返す（PIIなどは後でRDT対応）
    const simplified = rawOrders.map((o) => ({
      AmazonOrderId: o.AmazonOrderId,
      PurchaseDate:  o.PurchaseDate,
      OrderStatus:   o.OrderStatus,
      OrderTotal:
        o.OrderTotal && o.OrderTotal.Amount ? Number(o.OrderTotal.Amount) : null,
      Currency:
        o.OrderTotal && o.OrderTotal.CurrencyCode
          ? o.OrderTotal.CurrencyCode
          : null,
      Items: [], // TODO: getOrderItems で後から拡張
    }));

    res.status(200).json(simplified);
  } catch (err) {
    console.error("❌ Error in /orders:", err);
    res.status(500).json({ error: err.message || "SP-API error" });
  }
});

// ---- 出荷通知API（佐川の伝票番号を使って confirmShipment） ----
app.post("/confirm-shipment", async (req, res) => {
  try {
    const { orderId, trackingNumber } = req.body;

    if (!orderId || !trackingNumber) {
      return res
        .status(400)
        .json({ error: "orderId と trackingNumber は必須です" });
    }

    // 1) LWAアクセストークン
    const accessToken = await getLwaAccessToken();

    // 2) 注文の明細（orderItemId と quantity）を取得
    const itemsRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders/${encodeURIComponent(
        orderId
      )}/orderItems`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          accept: "application/json",
        },
      }
    );

    if (!itemsRes.ok) {
      const text = await itemsRes.text();
      console.error("❌ getOrderItems error:", itemsRes.status, text);
      return res
        .status(itemsRes.status)
        .json({
          error: "getOrderItems error",
          status: itemsRes.status,
          body: text,
        });
    }

    const itemsJson  = await itemsRes.json();
    const orderItems = itemsJson.OrderItems || [];

    if (orderItems.length === 0) {
      return res
        .status(400)
        .json({ error: "orderItems が取得できませんでした" });
    }

    // 3) confirmShipment リクエストボディを構築
    const shipDate = new Date().toISOString();
    const packageDetail = {
      packageReferenceId: "1",
      carrierCode: "SAGAWA",            // 佐川急便
      carrierName: "SAGAWA EXPRESS",    // 任意（表示用）
      shippingMethod: "Hikyaku",        // 任意or空でも可
      trackingNumber,
      shipDate,
      orderItems: orderItems.map((oi) => ({
        orderItemId: oi.OrderItemId,
        quantity: oi.QuantityOrdered, // 全数量を一度に出荷する前提
      })),
    };

    const body = {
      marketplaceId: MARKETPLACE_ID,
      packageDetail,
    };

    // 4) confirmShipment 呼び出し
    const confirmRes = await fetch(
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders/${encodeURIComponent(
        orderId
      )}/shipmentConfirmation`,
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

    if (!confirmRes.ok) {
      const text = await confirmRes.text();
      console.error("❌ confirmShipment error:", confirmRes.status, text);
      return res
        .status(confirmRes.status)
        .json({
          error: "confirmShipment error",
          status: confirmRes.status,
          body: text,
        });
    }

    const respBody = await confirmRes.text(); // 204なら空文字
    console.log("✅ confirmShipment success:", orderId, respBody);

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


app.get('/health', (req, res) => {
  res.status(200).send('OK');
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

