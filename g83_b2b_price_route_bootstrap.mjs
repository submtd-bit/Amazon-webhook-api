import express from "express";

const ROUTE = "/amazon/price/g83/b2b";
const originalListen = express.application.listen;

express.application.listen = function g83B2bPriceRouteBootstrapListen(...args) {
  const alreadyRegistered = Boolean(
    this?._router?.stack?.some(layer => layer?.route?.path === ROUTE)
  );

  if (!alreadyRegistered) {
    // g83_b2b_price_preload.mjs has already replaced app.post().
    this.post(ROUTE, (_req, res) => {
      return res.status(500).json({ ok: false, error: "G83 B2B route bootstrap fallback" });
    });
  }

  return originalListen.apply(this, args);
};
