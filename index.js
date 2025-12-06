import express from "express";

const app = express();
app.use(express.json());

// Webhook受信エンドポイント
app.post("/webhook", (req, res) => {
  console.log("🔔 Webhook received:", req.body);

  // ひとまず 200 OK を返す
  res.status(200).json({ status: "ok" });
});

// ▼▼ ここから追加：注文取得ダミーAPI ▼▼
app.get("/orders", (req, res) => {
  // 本番ではここを Amazon SP-API の getOrders に差し替える
  const dummyOrders = [
    {
      AmazonOrderId: "123-1234567-1234567",
      PurchaseDate: "2025-12-01T10:30:00Z",
      OrderStatus: "Unshipped",
      BuyerName: "山田 太郎",
      PostalCode: "123-4567",
      StateOrRegion: "東京都",
      City: "足立区",
      AddressLine1: "青井4-3-20",
      Phone: "03-0000-0000",
      OrderTotal: 1980,
      Currency: "JPY",
      Items: [
        {
          SellerSKU: "Entry_001",
          Title: "DELL LATITUDE 3540 メモリ32GB SSD256GB Corei3-1215U",
          QuantityOrdered: 1
        }
      ]
    }
  ];

  res.status(200).json(dummyOrders);
});
// ▲▲ ここまで追加 ▲▲

// Render が使うポート
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
