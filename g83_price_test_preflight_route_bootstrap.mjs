import express from "express";

const ROUTE = "/amazon/price/g83/price-test/preflight";
const originalListen = express.application.listen;

express.application.listen = function g83PriceTestPreflightBootstrapListen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)
  );

  if (!alreadyRegistered) {
    // g83_price_test_preflight_preload.mjs has already replaced app.post().
    // Calling this.post for ROUTE makes that preloader register its guarded handler.
    this.post(ROUTE, (_req, res) => {
      return res.status(500).json({ ok: false, error: "G83 price-test preflight bootstrap fallback" });
    });
  }

  return originalListen.apply(this, args);
};
