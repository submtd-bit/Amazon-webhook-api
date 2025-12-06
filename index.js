import express from "express";

const app = express();
app.use(express.json());

// Webhook受信エンドポイント
app.post("/webhook", (req, res) => {
  console.log("🔔 Webhook received:", req.body);

  // TODO：後でGASやSheets連携を追加

  res.status(200).json({ status: "ok" });
});

// Renderが使用するポート番号
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
