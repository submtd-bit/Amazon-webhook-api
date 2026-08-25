import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-08-25-sv1-price-test-once-bridge-v1.0.0";
const ROUTE = "/__tmp/sv1-preflight/8d6c1f4a6b0e4aa898bb6f5748b3d26e";
const TOKEN = "e9d4e7f30ff44e2c8b8c30bc629dbf31d79c4a26c9324f5680db9158ed47f1d0";
const EXPIRES_AT = Date.parse("2026-08-25T11:00:00.000Z");
const originalUse = express.application.use;
const originalGet = express.application.get;

function clean(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return {
    ok: obj.ok === true,
    moduleVersion: obj.moduleVersion || null,
    status: obj.status || null,
    dryRun: obj.dryRun === true,
    externalChanges: Number(obj.externalChanges || 0),
    sku: obj.sku || null,
    asin: obj.asin || null,
    before: obj.before || null,
    target: obj.target || null,
    protections: obj.protections || null,
    amazonValidation: obj.amazonValidation || null,
    error: obj.error || null,
  };
}

async function handler(req, res) {
  res.set("Cache-Control", "no-store");
  try {
    if (Date.now() > EXPIRES_AT) return res.status(410).json({ ok: false, status: "BRIDGE_EXPIRED", externalChanges: 0, moduleVersion: MODULE_VERSION });
    if (String(req.query?.token || "") !== TOKEN) return res.status(403).json({ ok: false, status: "FORBIDDEN", externalChanges: 0, moduleVersion: MODULE_VERSION });

    const secret = String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
    const port = String(process.env.PORT || "").trim();
    if (!secret) return res.status(500).json({ ok: false, status: "MISSING_SECRET", externalChanges: 0, moduleVersion: MODULE_VERSION });
    if (!port) return res.status(500).json({ ok: false, status: "MISSING_PORT", externalChanges: 0, moduleVersion: MODULE_VERSION });

    const upstream = await fetch(`http://127.0.0.1:${port}/amazon/price/sv1/price-test/preflight`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-secret": secret,
      },
      body: JSON.stringify({
        dryRun: true,
        sku: "RB-Y7G2-H0EK",
        asin: "B0GZGM1BND",
        normalPrice: 56000,
        salePrice: 52800,
        safeFloor: 40500,
        durationHours: 72,
      }),
    });
    const text = await upstream.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { ok: false, status: "UPSTREAM_NON_JSON", externalChanges: 0, error: text.slice(0, 1000) }; }
    return res.status(upstream.status).json({ bridgeVersion: MODULE_VERSION, upstreamHttpStatus: upstream.status, ...clean(body) });
  } catch (err) {
    return res.status(500).json({ ok: false, status: "BRIDGE_ERROR", externalChanges: 0, moduleVersion: MODULE_VERSION, error: err?.message || String(err) });
  }
}

express.application.use = function patchedUse(...args) {
  const result = originalUse.apply(this, args);
  if (!this.__sv1PriceTestOnceBridgeInstalled) {
    this.__sv1PriceTestOnceBridgeInstalled = true;
    originalGet.call(this, ROUTE, handler);
    console.log(`${MODULE_VERSION} temporary route installed: GET ${ROUTE}`);
  }
  return result;
};
