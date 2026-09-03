import express from "express";

const ROUTE = "/amazon/price/f7/49800-price-test/preflight";
const originalListen = express.application.listen;

express.application.listen = function f7PriceTestPreflightBootstrapListen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)
  );

  if (!alreadyRegistered) {
    // f7_49800_price_test_preflight_preload.mjs has already replaced app.post().
    // Calling this.post for ROUTE makes the preloader register its guarded handler.
    this.post(ROUTE, (_req, res) => {
      return res.status(500).json({ ok: false, error: "F7 49800 price-test preflight bootstrap fallback" });
    });
  }

  return originalListen.apply(this, args);
};