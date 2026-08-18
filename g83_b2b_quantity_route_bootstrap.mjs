import express from "express";

const ROUTE = "/amazon/price/g83/b2b-quantity";
const originalListen = express.application.listen;

express.application.listen = function g83B2bQuantityRouteBootstrapListen(...args) {
  const alreadyRegistered = Boolean(this?._router?.stack?.some(layer => layer?.route?.path === ROUTE));
  if (!alreadyRegistered) {
    this.post(ROUTE, (_req, res) => res.status(500).json({ ok: false, error: "G83 B2B quantity route bootstrap fallback" }));
  }
  return originalListen.apply(this, args);
};
