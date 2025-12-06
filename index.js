import express from "express";

const app = express();
app.use(express.json());

// ---- 共通設定 ----
const LWA_CLIENT_ID = process.env.LWA_CLIENT_ID;
const LWA_CLIENT_SECRET = process.env.LWA_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const MARKETPLACE_ID = process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528";

// Webhook受信エンドポイント
app.post("/webhook", (req, res) => {
  console.log("🔔 Webhook received:", req.body);

  // ひとまず 200 OK を返す
  res.status(200).json({ status: "ok" });
});

// LWA リフレッシュトークンから access_token を取得
async function getLwaAccessToken() {
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

// 既存 webhook エンドポイント（そのまま）
app.post("/webhook", (req, res) => {
  console.log("🔔 Webhook received:", req.body);
  res.status(200).json({ status: "ok" });
});

// ---- Orders API 本番実装 ----
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
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders?MarketplaceIds=${encodeURIComponent(
        MARKETPLACE_ID
      )}&CreatedAfter=${encodeURIComponent(createdAfter)}&OrderStatuses=Unshipped,PartiallyShipped`,
      {
        method: "GET",
        headers: {
          "x-amz-access-token": accessToken,
          "accept": "application/json"
        }
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
    const rawOrders = ordersJson.Orders || [];

    // ※ まずはシンプルにヘッダ情報だけ返す
    // （PII住所などは RDT が必要になるので後で拡張）
    const simplified = rawOrders.map((o) => ({
      AmazonOrderId: o.AmazonOrderId,
      PurchaseDate: o.PurchaseDate,
      OrderStatus: o.OrderStatus,
      OrderTotal:
        o.OrderTotal && o.OrderTotal.Amount ? Number(o.OrderTotal.Amount) : null,
      Currency:
        o.OrderTotal && o.OrderTotal.CurrencyCode ? o.OrderTotal.CurrencyCode : null,
      Items: [] // TODO: getOrderItems で後から拡張
    }));

    res.status(200).json(simplified);
  } catch (err) {
    console.error("❌ Error in /orders:", err);
    res.status(500).json({ error: err.message || "SP-API error" });
  }
});

// ---- Render が使うポート ----
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
