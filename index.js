import fetch from "node-fetch";
import express from "express";

const app = express();
app.use(express.json());

// ---- 共通設定 ----
const LWA_CLIENT_ID     = process.env.LWA_CLIENT_ID;
const LWA_CLIENT_SECRET = process.env.LWA_CLIENT_SECRET;
const REFRESH_TOKEN     = process.env.REFRESH_TOKEN;
const MARKETPLACE_ID    = process.env.SPAPI_MARKETPLACE_ID || "A1VC38T7YXB528"; // JP

// 先頭付近に追加（発送元固定値：Render環境変数で管理）
const SENDER_TEL   = process.env.SENDER_TEL;     // 例: 03-5831-5923
const SENDER_CODE  = process.env.SENDER_CODE;    // 例: 366841582
const SENDER_POST  = process.env.SENDER_POST;    // 例: 121-0012
const SENDER_ADDR1 = process.env.SENDER_ADDR1;   // 例: 東京都足立区青井４ー３ー２０
const SENDER_NAME1 = process.env.SENDER_NAME1;   // 例: Amazon.co.jp
const SENDER_NAME2 = process.env.SENDER_NAME2;   // 例: MTDオンラインストア

function csvEscape(v) {
  const s = (v ?? "").toString();
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function joinNotEmpty(...parts) {
  return parts.map(p => (p ?? "").toString().trim()).filter(Boolean).join("");
}

// e飛伝のヘッダ（ユーザー提示の列）
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
  const name = ship?.Name || ""; // 必須要件

  // 住所分割ルール（推奨：住所1=都道府県+市区町村、住所2=番地、住所3=建物等）
  const addr1 = joinNotEmpty(ship.StateOrRegion, ship.City);
  const addr2 = ship.AddressLine1 || "";
  const addr3 = joinNotEmpty(ship.AddressLine2, ship.AddressLine3);

  // 品名ルール（推奨）
  const items = order.Items || [];
  const skus  = items.map(i => i.SellerSKU).filter(Boolean).join(",");
  const titles = items.map(i => i.Title).filter(Boolean).join(" / ");

  // 長すぎると弾かれることがあるため安全に切る（必要なら調整）
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n) : (s || ""));

  return [
    "",                 // お届け先コード取得区分（サンプル踏襲）
    "0",                // お届け先コード（サンプル踏襲）
    ship.Phone || "",
    ship.PostalCode || "",
    addr1,
    addr2,
    addr3,
    name,
    "",                 // お届け先名称２
    order.AmazonOrderId || "",
    "",                 // お客様コード

    "", "", "",         // 部署ご担当者（未使用）
    SENDER_TEL || "",

    "",                 // ご依頼主コード取得区分
    "",                 // ご依頼主コード（未使用なら空。使うならここに入れる）
    SENDER_CODE || "",  // ご依頼主電話番号（※サンプル上ここが“366...”なので、運用に合わせて固定）
    SENDER_POST || "",
    SENDER_ADDR1 || "",
    "",                 // ご依頼主住所２
    SENDER_NAME1 || "",
    SENDER_NAME2 || "",

    "",                 // 荷姿
    "中古PC",           // 品名１
    cut(skus, 60),      // 品名２
    cut(titles, 60),    // 品名３
    "", "",             // 品名４・５

    "", "", "", "", "", "", "", "", "", "", "", // 荷札系（未使用）
    "1",                // 出荷個数（1個口固定）
    "", "", "", "", "", // スピード/クール/配達日/時間帯/時分
    "", "", "", "",     // 代引/税/決済/保険
    "", "", "",         // 指定シール
    "", "", "", "",     // 営業所受取など
    "", "",             // メール/不在連絡先
    "", "", "",         // 出荷日/問合せNo/出荷場印字
    "",                 // 集約解除指定
    "", "", "", "", "", "", "", "", "", "" // 編集01-10
  ];
}

app.get("/sagawa.csv", async (req, res) => {
  try {
    const since = req.query.createdAfter
      ? new Date(req.query.createdAfter)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const createdAfter = since.toISOString();

    // 既存の /orders ロジックを関数化して呼ぶのが理想ですが、
    // まずは同じ流れで rawOrders→items付与→CSV化でもOKです。

    const accessToken = await getLwaAccessToken();
    const ordersUrl =
      `https://sellingpartnerapi-fe.amazon.com/orders/v0/orders?` +
      `MarketplaceIds=${encodeURIComponent(MARKETPLACE_ID)}` +
      `&CreatedAfter=${encodeURIComponent(createdAfter)}` +
      `&OrderStatuses=Unshipped,PartiallyShipped`;

    const ordersRes = await fetch(ordersUrl, {
      method: "GET",
      headers: { "x-amz-access-token": accessToken, accept: "application/json" },
    });

    const text = await ordersRes.text();
    if (!ordersRes.ok) {
      return res.status(ordersRes.status).send(text);
    }

    const ordersJson = text ? JSON.parse(text) : {};
    const rawOrders  = ordersJson?.payload?.Orders || [];

    // Items付与＋ShippingAddress.Name を残す
    const enriched = [];
    for (const o of rawOrders) {
      const items = await getOrderItems(accessToken, o.AmazonOrderId);
      enriched.push({
        AmazonOrderId: o.AmazonOrderId,
        Items: items,
        ShippingAddress: {
          Name: o?.ShippingAddress?.Name || "",
          Phone: o?.ShippingAddress?.Phone || "",
          PostalCode: o?.ShippingAddress?.PostalCode || "",
          StateOrRegion: o?.ShippingAddress?.StateOrRegion || "",
          City: o?.ShippingAddress?.City || "",
          AddressLine1: o?.ShippingAddress?.AddressLine1 || "",
          AddressLine2: o?.ShippingAddress?.AddressLine2 || "",
          AddressLine3: o?.ShippingAddress?.AddressLine3 || "",
        },
      });
    }

    const lines = [];
    lines.push(SAGAWA_HEADER.map(csvEscape).join(","));
    for (const order of enriched) {
      // ShippingAddress.Name が空だとラベルが作れないので、空なら落とす/ログにするなど運用決め推奨
      const row = orderToSagawaRow(order);
      lines.push(row.map(csvEscape).join(","));
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(csv);
  } catch (e) {
    res.status(500).send(e?.message || String(e));
  }
});



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
