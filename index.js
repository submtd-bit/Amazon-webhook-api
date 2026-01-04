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

// ---- 発送元固定（Render Environment Variables）----
// 荷送人電話番号（サンプルの 03-5831-5923 のほう）
const SHIPPER_TEL   = process.env.SHIPPER_TEL || "";
// ご依頼主電話番号（サンプルの 0落ちしてた方＝本来 03-xxxx-xxxx）
const REQUESTER_TEL = process.env.REQUESTER_TEL || "";

const SENDER_POST   = process.env.SENDER_POST || "";
const SENDER_ADDR1  = process.env.SENDER_ADDR1 || "";
const SENDER_NAME1  = process.env.SENDER_NAME1 || ""; // 例: Amazon.co.jp
const SENDER_NAME2  = process.env.SENDER_NAME2 || ""; // 例: MTDオンラインストア

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
  const name = ship?.Name || ""; // 必須

  // 住所分割（推奨）
  const addr1 = joinNotEmpty(ship.StateOrRegion, ship.City);
  const addr2 = ship.AddressLine1 || "";
  const addr3 = joinNotEmpty(ship.AddressLine2, ship.AddressLine3);

  // 品名（推奨）
  const items  = order.Items || [];
  const skus   = items.map((i) => i.SellerSKU).filter(Boolean).join(",");
  const titles = items.map((i) => i.Title).filter(Boolean).join(" / ");

  return [
    "",          // お届け先コード取得区分（未使用）
    "0",         // お届け先コード（サンプル踏襲）
    ship.Phone || "",
    ship.PostalCode || "",
    addr1,
    addr2,
    addr3,
    name,        // お届け先名称１
    "",          // お届け先名称２
    order.AmazonOrderId || "", // お客様管理番号
    "",          // お客様コード

    "", "", "",  // 部署ご担当者（未使用）
    SHIPPER_TEL, // 荷送人電話番号（固定）

    "",          // ご依頼主コード取得区分（未使用）
    "",          // ご依頼主コード（未使用）
    REQUESTER_TEL, // ご依頼主電話番号（固定）
    SENDER_POST,
    SENDER_ADDR1,
    "",          // ご依頼主住所２
    SENDER_NAME1,
    SENDER_NAME2,

    "",          // 荷姿
    "中古PC",    // 品名１（固定）
    cut(skus, 60),    // 品名２
    cut(titles, 60),  // 品名３
    "", "",      // 品名４・５

    "", "", "", "", "", "", "", "", "", "", "", // 荷札系（未使用）
    "1",         // 出荷個数（1個口固定）
    "", "", "", "", "", // スピード/クール/配達日/時間帯/時分
    "", "", "", "",     // 代引/税/決済/保険
    "", "", "",         // 指定シール
    "", "", "", "",     // 営業所受取等
    "", "",             // メール/不在
    "", "", "",         // 出荷日/問合せNo/出荷場印字
    "",                 // 集約解除
    "", "", "", "", "", "", "", "", "", "" // 編集01-10
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

// -------------------- SP-API: orderItems --------------------
async function getOrderItems(accessToken, orderId) {
  const r = await fetch(
    `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
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
      accept: "application/json",
    },
  });

  const text = await ordersRes.text();
  if (!ordersRes.ok) {
    console.error("❌ Orders API error:", ordersRes.status, text);
    throw new Error(`Orders API error: ${ordersRes.status} ${text}`);
  }

  const ordersJson = text ? JSON.parse(text) : {};
  const rawOrders  = ordersJson?.payload?.Orders || [];

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
        Name:         o?.ShippingAddress?.Name || "",
        Phone:        o?.ShippingAddress?.Phone || "",
        PostalCode:   o?.ShippingAddress?.PostalCode || "",
        StateOrRegion:o?.ShippingAddress?.StateOrRegion || "",
        City:         o?.ShippingAddress?.City || "",
        AddressLine1: o?.ShippingAddress?.AddressLine1 || "",
        AddressLine2: o?.ShippingAddress?.AddressLine2 || "",
        AddressLine3: o?.ShippingAddress?.AddressLine3 || "",
      },

      OrderTotal: o?.OrderTotal?.Amount ? Number(o.OrderTotal.Amount) : null,
      Currency:   o?.OrderTotal?.CurrencyCode || null,

      Items: items,
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

// 切り分け用：単一注文
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

// 注文一覧JSON（既存）
app.get("/orders", async (req, res) => {
  try {
    const since = req.query.createdAfter
      ? new Date(req.query.createdAfter)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const createdAfterIso = since.toISOString();
    const orders = await fetchOrdersWithItems(createdAfterIso);

    // 既存GASに合わせた平坦化形式も残す（互換用）
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
      Items:      o.Items,
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
      // Nameが空でも落とさない。BuyerNameにフォールバック
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

// 出荷通知（既存）
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
        quantity: oi.QuantityOrdered,
      })),
    };

    const body = { marketplaceId: MARKETPLACE_ID, packageDetail };

    const confirmRes = await fetch(
      `${SPAPI_ENDPOINT}/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`,
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

app.get("/version", (req, res) => {
  res.status(200).json({
    version: "2026-01-04-1845", // ←ここを更新して目視確認
  });
});

