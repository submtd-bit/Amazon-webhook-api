import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-06-g83-variation-postlive-audit-v1.0.0";
const ROUTE = "/amazon/listing/g83-variation-postlive-audit";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const VARIATION_THEME = "HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";
const PARENT_SKU = "g83-hs-i5-11g-variation-parent";
const PARENT_TITLE = "【整備済み品】ダイナブック G83/HS 中古ノートパソコン 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ Wi-Fi6 ノートン360付属 MTD整備済み";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const CHILDREN = Object.freeze([
  { sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", memoryGB: 8, storageGB: 256 },
  { sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", memoryGB: 8, storageGB: 512 },
  { sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", memoryGB: 8, storageGB: 1024 },
  { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", memoryGB: 16, storageGB: 256 },
  { sku: "5K-G098-FO9O", asin: "B0FPC52B8K", memoryGB: 16, storageGB: 512 },
  { sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", memoryGB: 16, storageGB: 1024 }
]);

const CONTENT_KEYS = Object.freeze([
  "item_name",
  "bullet_point",
  "product_description",
  "included_components",
  "software_included"
]);

function jparse(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { rawText: String(text || "").slice(0, 2000) }; }
}
function secret() {
  return String(process.env.AMAZON_STOCK_API_SECRET || "").trim();
}
function cfg() {
  const sellerId = String(process.env.SPAPI_SELLER_ID || "").trim();
  const marketplaceId = String(process.env.SPAPI_MARKETPLACE_ID || MARKETPLACE_ID).trim();
  const endpoint = String(process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-fe.amazon.com").replace(/\/$/, "");
  if (!sellerId) throw new Error("Missing env: SPAPI_SELLER_ID");
  if (marketplaceId !== MARKETPLACE_ID) throw new Error(`GUARD_BLOCKED marketplace=${marketplaceId}`);
  return { sellerId, marketplaceId, endpoint };
}
async function ft(url, opt = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...opt, signal: c.signal }); }
  finally { clearTimeout(t); }
}
async function token() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing LWA env");
  const r = await ft("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  const x = jparse(await r.text());
  if (!r.ok || !x.access_token) throw new Error(`LWA token error ${r.status}`);
  return x.access_token;
}
async function req(url, accessToken) {
  const r = await ft(url, {
    method: "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json"
    }
  });
  return { http: r.status, ok: r.ok, body: jparse(await r.text()) };
}
async function getListing(accessToken, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP"
  });
  return req(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,
    accessToken
  );
}
function first(rows, key = "value") {
  return Array.isArray(rows) && rows[0] ? rows[0]?.[key] ?? null : null;
}
function nestedMeasure(rows, key) {
  return Array.isArray(rows) &&
    rows[0] &&
    Array.isArray(rows[0]?.[key]) &&
    rows[0][key][0]
    ? rows[0][key][0]
    : null;
}
function toGB(row) {
  if (!row) return null;
  const v = Number(row.value);
  if (!Number.isFinite(v)) return null;
  const u = String(row.unit || "GB").toUpperCase();
  return u === "TB" ? v * 1024 : u === "MB" ? v / 1024 : v;
}
function ramGB(a) {
  return toGB(nestedMeasure(a?.ram_memory, "installed_size"));
}
function storageGB(a) {
  const h = toGB(nestedMeasure(a?.hard_disk, "size"));
  return h !== null
    ? h
    : toGB(nestedMeasure(a?.flash_memory, "installed_size"));
}
function qty(x) {
  return (Array.isArray(x?.fulfillmentAvailability)
    ? x.fulfillmentAvailability
    : [])
    .reduce((n, r) => n + (
      Number.isFinite(Number(r?.quantity))
        ? Number(r.quantity)
        : 0
    ), 0);
}
function relation(a) {
  return {
    parentageLevel: first(a?.parentage_level),
    parentSku: first(a?.child_parent_sku_relationship, "parent_sku") || null,
    childRelationshipType:
      first(a?.child_parent_sku_relationship, "child_relationship_type") || null,
    variationTheme: first(a?.variation_theme, "name") || null
  };
}
function flatten(v, out = []) {
  if (v == null) return out;
  if (typeof v === "string") {
    out.push(v);
    return out;
  }
  if (Array.isArray(v)) {
    v.forEach(x => flatten(x, out));
    return out;
  }
  if (typeof v === "object") {
    Object.values(v).forEach(x => flatten(x, out));
  }
  return out;
}
function bundle(a, title) {
  const t = [String(title || "")];
  for (const k of CONTENT_KEYS) flatten(a?.[k], t);
  const b = t.join(" ").toUpperCase();
  return {
    office2024:
      /OFFICE\s*2024|MICROSOFT\s*OFFICE\s*2024|MS\s*OFFICE\s*2024/.test(b),
    norton360:
      /NORTON\s*360|ノートン\s*360/.test(b),
    wps:
      /WPS\s*OFFICE|WPSOFFICE/.test(b)
  };
}
function imageCount(a) {
  return Object.keys(a || {})
    .filter(k =>
      /(main_product_image_locator|other_product_image_locator|swatch_product_image_locator)/i.test(k)
    )
    .reduce((n, k) => n + (
      Array.isArray(a[k]) ? a[k].length : 0
    ), 0);
}
function offerSummary(x) {
  return (Array.isArray(x?.offers) ? x.offers : []).map(r => ({
    offerType: String(r?.offerType || ""),
    amount: r?.price?.amount ?? null,
    currency:
      r?.price?.currencyCode ||
      r?.price?.currency ||
      "",
    points: r?.points?.pointsNumber ?? null,
    quantityDiscountPlan: r?.quantityDiscountPlan || null
  }));
}
function expectedTitle(p) {
  const storage =
    p.storageGB >= 1024
      ? `${p.storageGB / 1024}TB`
      : `${p.storageGB}GB`;
  return `【整備済み品】ダイナブック G83/HS 中古ノートパソコン 13.3型FHD 第11世代 Core i5-1135G7 メモリ${p.memoryGB}GB SSD${storage} Windows 11 Pro MS Office 2024 Webカメラ Wi-Fi6 ノートン360付属 MTD整備済み`;
}
function issueSummary(x) {
  const issues = Array.isArray(x?.issues) ? x.issues : [];
  const errors = issues.filter(
    i => String(i?.severity || "").toUpperCase() === "ERROR"
  );
  return {
    issueCount: issues.length,
    errorCount: errors.length,
    issueCodes: [...new Set(
      issues.map(i => String(i?.code || "")).filter(Boolean)
    )]
  };
}
function parentAudit(r) {
  if (!r.ok) {
    return {
      verified: false,
      httpStatus: r.http,
      reason: "PARENT_GET_FAILED"
    };
  }
  const x = r.body || {};
  const s = Array.isArray(x?.summaries) ? x.summaries[0] || {} : {};
  const a = x?.attributes && typeof x.attributes === "object"
    ? x.attributes
    : {};
  const rel = relation(a);
  const issues = issueSummary(x);
  const title = String(s?.itemName || first(a?.item_name) || "");
  const productTypeObserved = String(s?.productType || "");

  const checks = {
    sku: String(x?.sku || "") === PARENT_SKU,
    title: title === PARENT_TITLE,
    parentageLevel: rel.parentageLevel === "parent",
    variationTheme: rel.variationTheme === VARIATION_THEME,
    quantityZero: qty(x) === 0,
    offerZero: !Array.isArray(x?.offers) || x.offers.length === 0,
    errorZero: issues.errorCount === 0
  };

  return {
    verified: Object.values(checks).every(Boolean),
    checks,
    productTypeObserved,
    productTypeNotUsedAsGate: true,
    title,
    relation: rel,
    availableQuantity: qty(x),
    offerCount: Array.isArray(x?.offers) ? x.offers.length : 0,
    issueCount: issues.issueCount,
    errorCount: issues.errorCount,
    issueCodes: issues.issueCodes
  };
}
function childAudit(plan, r) {
  if (!r.ok) {
    return {
      sku: plan.sku,
      asin: plan.asin,
      verified: false,
      structureVerified: false,
      contentVerified: false,
      httpStatus: r.http,
      reason: "CHILD_GET_FAILED"
    };
  }

  const x = r.body || {};
  const s = Array.isArray(x?.summaries) ? x.summaries[0] || {} : {};
  const a = x?.attributes && typeof x.attributes === "object"
    ? x.attributes
    : {};
  const title = String(s?.itemName || first(a?.item_name) || "");
  const rel = relation(a);
  const b = bundle(a, title);
  const rg = ramGB(a);
  const sg = storageGB(a);
  const issues = issueSummary(x);

  const structureChecks = {
    sku: String(x?.sku || "") === plan.sku,
    asin: String(s?.asin || "") === plan.asin,
    productType: String(s?.productType || "") === PRODUCT_TYPE,
    ram: rg === plan.memoryGB,
    storage: sg === plan.storageGB,
    parentageLevel: rel.parentageLevel === "child",
    parentSku: rel.parentSku === PARENT_SKU,
    relationship:
      String(rel.childRelationshipType || "").toLowerCase() === "variation",
    variationTheme: rel.variationTheme === VARIATION_THEME,
    errorZero: issues.errorCount === 0
  };

  const contentChecks = {
    title: title === expectedTitle(plan),
    office2024: b.office2024 === true,
    norton360: b.norton360 === true,
    wpsRemoved: b.wps === false
  };

  const structureVerified =
    Object.values(structureChecks).every(Boolean);
  const contentVerified =
    Object.values(contentChecks).every(Boolean);

  return {
    sku: plan.sku,
    asin: plan.asin,
    verified: structureVerified && contentVerified,
    structureVerified,
    contentVerified,
    structureChecks,
    contentChecks,
    title,
    expectedTitle: expectedTitle(plan),
    bundle: b,
    relation: rel,
    ramGB: rg,
    storageGB: sg,
    availableQuantity: qty(x),
    offers: offerSummary(x),
    imageCount: imageCount(a),
    issueCount: issues.issueCount,
    errorCount: issues.errorCount,
    issueCodes: issues.issueCodes
  };
}

async function handler(req0, res) {
  try {
    const sec = secret();

    if (!sec) {
      return res.status(500).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "secret missing"
      });
    }

    if (String(req0.headers["x-api-secret"] || "") !== sec) {
      return res.status(401).json({
        ok: false,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "Unauthorized"
      });
    }

    if (req0.body?.dryRun === false) {
      throw new Error("LIVE disabled; audit is read-only");
    }

    const accessToken = await token();

    const parent = parentAudit(
      await getListing(accessToken, PARENT_SKU)
    );

    const children = [];
    for (const plan of CHILDREN) {
      children.push(
        childAudit(
          plan,
          await getListing(accessToken, plan.sku)
        )
      );
    }

    const structureVerified =
      parent.verified &&
      children.every(x => x.structureVerified);

    const contentVerified =
      children.every(x => x.contentVerified);

    const fullyVerified =
      structureVerified && contentVerified;

    let status = "REVIEW_REQUIRED";

    if (fullyVerified) {
      status = "PASS";
    } else if (
      structureVerified &&
      !contentVerified
    ) {
      status = "STRUCTURE_PASS_CONTENT_PROPAGATION_PENDING";
    }

    return res.status(200).json({
      ok: true,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      status,
      readOnly: true,
      productType: PRODUCT_TYPE,
      parentSku: PARENT_SKU,
      variationTheme: VARIATION_THEME,
      parent,
      children,
      summary: {
        parentVerified: parent.verified,
        childStructureVerifiedCount:
          children.filter(x => x.structureVerified).length,
        childContentVerifiedCount:
          children.filter(x => x.contentVerified).length,
        childFullyVerifiedCount:
          children.filter(x => x.verified).length,
        structureVerified,
        contentVerified,
        fullyVerified
      },
      interpretation:
        status === "PASS"
          ? "Parent and all six children are fully reflected."
          : status === "STRUCTURE_PASS_CONTENT_PROPAGATION_PENDING"
            ? "Variation structure is fully reflected; one or more child content fields are still propagating. Do not resend the original LIVE."
            : "One or more structural checks failed. Do not resend the original LIVE; inspect the reported state.",
      amazonPersistentWrites: 0,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: 0,
      liveAllowed: false
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      readOnly: true,
      amazonPersistentWrites: 0,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: 0,
      error: err?.message || String(err)
    });
  }
}

express.application.listen = function g83VariationPostLiveAuditListen(...args) {
  const exists = Boolean(
    this?._router?.stack?.some(
      layer => layer?.route?.path === ROUTE
    )
  );

  if (!exists) this.post(ROUTE, handler);

  return originalListen.apply(this, args);
};
