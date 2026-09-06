import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION = "2026-09-06-g83-variation-live-v1.0.0";
const ROUTE = "/amazon/listing/g83-variation-live";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const VARIATION_THEME = "HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";
const PARENT_SKU = "g83-hs-i5-11g-variation-parent";
const PARENT_TITLE = "【整備済み品】ダイナブック G83/HS 中古ノートパソコン 13.3型FHD 第11世代 Core i5-1135G7 Windows 11 Pro MS Office 2024 Webカメラ Wi-Fi6 ノートン360付属 MTD整備済み";
const APPROVED_SCOPE = "G83_PARENT_PLUS_6_CHILDREN_OFFICE2024_NORTON360";
const CONFIRM_LIVE = "CONFIRM_G83_PARENT6_VARIATION_20260906";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 8;
const VERIFY_GAP_MS = 3000;
const originalListen = express.application.listen;

const CHILDREN = Object.freeze([
  { sku: "F7-AF7O-IGX5", asin: "B0FN3KQFR3", memoryGB: 8, storageGB: 256 },
  { sku: "SO-9QJ3-7SHR", asin: "B0FPC2JKBY", memoryGB: 8, storageGB: 512 },
  { sku: "9K-D0RA-4R8V", asin: "B0FPC4R7ZG", memoryGB: 8, storageGB: 1024 },
  { sku: "E7-YLJ3-F9CY", asin: "B0GZBHBQN2", memoryGB: 16, storageGB: 256, canonical: true },
  { sku: "5K-G098-FO9O", asin: "B0FPC52B8K", memoryGB: 16, storageGB: 512 },
  { sku: "QH-ITJ6-BTTC", asin: "B0FPC385LM", memoryGB: 16, storageGB: 1024 }
]);

const CONTENT_ALLOWED_KEYS = Object.freeze([
  "item_name",
  "bullet_point",
  "product_description",
  "included_components",
  "software_included"
]);

function jparse(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { rawText: String(text || "").slice(0, 1600) }; }
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function secret() { return String(process.env.AMAZON_STOCK_API_SECRET || "").trim(); }

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

async function req(url, a, opt = {}) {
  const r = await ft(url, {
    method: opt.method || "GET",
    headers: {
      "x-amz-access-token": a,
      accept: "application/json",
      ...(opt.body ? { "content-type": "application/json" } : {})
    },
    ...(opt.body ? { body: JSON.stringify(opt.body) } : {})
  });
  return { http: r.status, ok: r.ok, body: jparse(await r.text()) };
}

async function getListing(a, sku) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData: "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP"
  });
  return req(`${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`, a);
}

async function getSchema(a) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    sellerId,
    marketplaceIds: marketplaceId,
    requirements: "LISTING",
    requirementsEnforced: "ENFORCED",
    locale: "ja_JP"
  });
  const d = await req(`${endpoint}/definitions/2020-09-01/productTypes/${PRODUCT_TYPE}?${q}`, a);
  if (!d.ok) throw new Error(`PTD GET ${d.http}`);
  const u = String(d.body?.schema?.link?.resource || "");
  if (!u) throw new Error("PTD schema link missing");
  const r = await ft(u, { headers: { accept: "application/json" } });
  const x = jparse(await r.text());
  if (!r.ok) throw new Error(`PTD schema fetch ${r.status}`);
  return x;
}

function rawValues(spec) {
  const out = [];
  const seen = new Set();
  (function walk(n, d) {
    if (!n || typeof n !== "object" || d > 7) return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, d + 1)); return; }
    if (Array.isArray(n.enum)) {
      for (const v of n.enum) {
        const k = typeof v + ":" + JSON.stringify(v);
        if (!seen.has(k)) { seen.add(k); out.push(v); }
      }
    }
    if (n.const !== undefined) {
      const v = n.const;
      const k = typeof v + ":" + JSON.stringify(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    for (const k of ["items", "properties", "oneOf", "anyOf", "allOf"]) walk(n[k], d + 1);
  })(spec, 0);
  return out;
}

function nestedSpec(s, n, c) { return s?.properties?.[n]?.items?.properties?.[c] || null; }
function vals(s) { return rawValues(s).map(String); }
function first(rows) { return Array.isArray(rows) && rows[0] ? rows[0].value ?? null : null; }
function nestedMeasure(rows, key) {
  return Array.isArray(rows) && rows[0] && Array.isArray(rows[0][key]) && rows[0][key][0]
    ? rows[0][key][0] : null;
}
function toGB(row) {
  if (!row) return null;
  const v = Number(row.value);
  if (!Number.isFinite(v)) return null;
  const u = String(row.unit || "GB").toUpperCase();
  return u === "TB" ? v * 1024 : u === "MB" ? v / 1024 : v;
}
function ramGB(a) { return toGB(nestedMeasure(a?.ram_memory, "installed_size")); }
function storageGB(a) {
  const h = toGB(nestedMeasure(a?.hard_disk, "size"));
  return h !== null ? h : toGB(nestedMeasure(a?.flash_memory, "installed_size"));
}
function qty(x) {
  return (Array.isArray(x?.fulfillmentAvailability) ? x.fulfillmentAvailability : [])
    .reduce((n, r) => n + (Number.isFinite(Number(r?.quantity)) ? Number(r.quantity) : 0), 0);
}
function relation(a) {
  return {
    parentageLevel: first(a?.parentage_level),
    parentSku: a?.child_parent_sku_relationship?.[0]?.parent_sku ?? null,
    childRelationshipType: a?.child_parent_sku_relationship?.[0]?.child_relationship_type ?? null,
    variationTheme: a?.variation_theme?.[0]?.name ?? null
  };
}
function offerSummary(x) {
  return (Array.isArray(x?.offers) ? x.offers : []).map(r => ({
    offerType: r?.offerType || "",
    amount: r?.price?.amount ?? null,
    currency: r?.price?.currencyCode || r?.price?.currency || "",
    points: r?.points?.pointsNumber ?? null,
    quantityDiscountPlan: r?.quantityDiscountPlan || null
  }));
}
function imageKeys(a) {
  return Object.keys(a || {}).filter(k =>
    /(main_product_image_locator|other_product_image_locator|swatch_product_image_locator)/i.test(k)
  ).sort();
}
function imageCount(a) {
  return imageKeys(a).reduce((n, k) => n + (Array.isArray(a[k]) ? a[k].length : 0), 0);
}
function flatten(v, out = []) {
  if (v == null) return out;
  if (typeof v === "string") { out.push(v); return out; }
  if (Array.isArray(v)) { v.forEach(x => flatten(x, out)); return out; }
  if (typeof v === "object") Object.values(v).forEach(x => flatten(x, out));
  return out;
}
function markerKeys(attrs, re) {
  const out = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    const text = flatten(v, []).join(" ");
    if (re.test(text)) out.push(k);
  }
  return out.sort();
}
function bundle(a, title) {
  const t = [String(title || "")];
  for (const k of CONTENT_ALLOWED_KEYS) flatten(a?.[k], t);
  const b = t.join(" ").toUpperCase();
  return {
    office2024: /OFFICE\s*2024|MICROSOFT\s*OFFICE\s*2024|MS\s*OFFICE\s*2024/.test(b),
    norton360: /NORTON\s*360|ノートン\s*360/.test(b),
    wps: /WPS\s*OFFICE|WPSOFFICE/.test(b)
  };
}

function inspect(plan, r) {
  if (!r.ok) throw new Error(`CHILD_GET_FAILED ${plan.sku} HTTP ${r.http}`);
  const x = r.body;
  const s = x?.summaries?.[0] || {};
  const a = x?.attributes || {};
  const issues = Array.isArray(x?.issues) ? x.issues : [];
  const title = String(s?.itemName || first(a?.item_name) || "");
  if (String(x?.sku || "") !== plan.sku) throw new Error(`SKU_MISMATCH ${plan.sku}`);
  if (String(s?.asin || "") !== plan.asin) throw new Error(`ASIN_MISMATCH ${plan.sku}`);
  if (String(s?.productType || "") !== PRODUCT_TYPE) throw new Error(`PRODUCT_TYPE_MISMATCH ${plan.sku}`);
  const rg = ramGB(a), sg = storageGB(a);
  if (rg !== plan.memoryGB) throw new Error(`RAM_MISMATCH ${plan.sku} expected=${plan.memoryGB} actual=${rg}`);
  if (sg !== plan.storageGB) throw new Error(`STORAGE_MISMATCH ${plan.sku} expected=${plan.storageGB} actual=${sg}`);
  return {
    plan,
    attrs: a,
    listing: x,
    preserve: {
      sku: plan.sku,
      asin: plan.asin,
      title,
      status: Array.isArray(s?.status) ? s.status : [],
      availableQuantity: qty(x),
      ramGB: rg,
      storageGB: sg,
      relationBefore: relation(a),
      offers: offerSummary(x),
      imageCount: imageCount(a),
      issueCount: issues.length,
      errorCount: issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR").length,
      issueCodes: [...new Set(issues.map(i => String(i?.code || "")).filter(Boolean))],
      bundle: bundle(a, title),
      wpsAttributeKeys: markerKeys(a, /WPS\s*OFFICE|WPSOFFICE/i)
    }
  };
}

function relationRows(kind, relationship) {
  const o = {
    parentage_level: [{ marketplace_id: MARKETPLACE_ID, value: kind }],
    variation_theme: [{ name: VARIATION_THEME }]
  };
  if (kind === "child") {
    o.child_parent_sku_relationship = [{
      marketplace_id: MARKETPLACE_ID,
      child_relationship_type: relationship,
      parent_sku: PARENT_SKU
    }];
  }
  return o;
}
function attrPatch(attrs, key, value) {
  return {
    op: Array.isArray(attrs?.[key]) && attrs[key].length ? "replace" : "add",
    path: `/attributes/${key}`,
    value
  };
}
function relationPatches(attrs, relationship, exclusiveRows) {
  const out = Object.entries(relationRows("child", relationship))
    .map(([k, v]) => attrPatch(attrs, k, v));
  out.push(attrPatch(attrs, "is_exclusive_product", clone(exclusiveRows)));
  return out;
}
function exclusiveFalse(schema) {
  const spec = nestedSpec(schema, "is_exclusive_product", "value");
  if (!spec) throw new Error("PTD missing is_exclusive_product.value");
  const allowed = rawValues(spec);
  let value = null;
  if (allowed.some(v => v === false)) value = false;
  else if (allowed.some(v => String(v).toLowerCase() === "false")) {
    value = allowed.find(v => String(v).toLowerCase() === "false");
  } else if (String(spec.type || "").toLowerCase() === "boolean") value = false;
  if (value === null) {
    throw new Error(`PTD no false value for is_exclusive_product allowed=${JSON.stringify(allowed.slice(0, 10))}`);
  }
  return [{ marketplace_id: MARKETPLACE_ID, value }];
}
function cloneTemplate(sourceAttrs, canonicalAttrs, key) {
  const row = sourceAttrs?.[key]?.[0] || canonicalAttrs?.[key]?.[0];
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !Object.prototype.hasOwnProperty.call(row, "value")) {
    throw new Error(`CONTENT_TEMPLATE_MISSING ${key}`);
  }
  return clone(row);
}
function valueRows(sourceAttrs, canonicalAttrs, key, values) {
  const t = cloneTemplate(sourceAttrs, canonicalAttrs, key);
  return values.map(v => ({ ...clone(t), value: v }));
}
function storageLabel(gb) { return gb >= 1024 ? `${gb / 1024}TB` : `${gb}GB`; }
function titleFor(plan) {
  return `【整備済み品】ダイナブック G83/HS 中古ノートパソコン 13.3型FHD 第11世代 Core i5-1135G7 メモリ${plan.memoryGB}GB SSD${storageLabel(plan.storageGB)} Windows 11 Pro MS Office 2024 Webカメラ Wi-Fi6 ノートン360付属 MTD整備済み`;
}
function bulletsFor(plan) {
  return [
    `【第11世代Core i5・メモリ${plan.memoryGB}GB】Intel Core i5-1135G7と${plan.memoryGB}GBメモリを搭載。日常業務や複数アプリの利用に対応する13.3型モバイルノートPCです。`,
    `【SSD${storageLabel(plan.storageGB)}・Windows 11 Pro】SSD${storageLabel(plan.storageGB)}とWindows 11 Proを搭載。起動やデータアクセスを軽快にし、ビジネス用途にも使いやすい構成です。`,
    "【13.3型フルHD・Wi-Fi 6】フルHDディスプレイ、Webカメラ、Wi-Fi 6に対応。文書作成、表計算、Web会議、学習など幅広い用途に利用できます。",
    "【Office 2024・ノートン360デラックス同梱】Office 2024とノートン360デラックスを同梱。セットアップ後、仕事や学習、セキュリティ対策に活用できます。",
    "【MTD整備済み】専門スタッフが動作確認・クリーニングを実施した整備済み品です。"
  ];
}
function descriptionFor(plan) {
  return `MTD整備済みのdynabook G83/HSです。第11世代Intel Core i5-1135G7、メモリ${plan.memoryGB}GB、SSD${storageLabel(plan.storageGB)}、Windows 11 Proを搭載。13.3型フルHDディスプレイ、Webカメラ、Wi-Fi 6に対応し、文書作成、表計算、Web会議、学習など幅広い用途に適しています。Office 2024とノートン360デラックスを同梱。専門スタッフによる動作確認・クリーニングを行っています。整備済み品のため、外装には使用に伴う擦れや小傷などがある場合があります。`;
}
function contentPatches(child, canonical) {
  const a = child.attrs, c = canonical.attrs, p = child.plan, out = [];
  out.push(attrPatch(a, "item_name", valueRows(a, c, "item_name", [titleFor(p)])));
  out.push(attrPatch(a, "bullet_point", valueRows(a, c, "bullet_point", bulletsFor(p))));
  out.push(attrPatch(a, "product_description", valueRows(a, c, "product_description", [descriptionFor(p)])));
  out.push(attrPatch(a, "included_components", valueRows(a, c, "included_components", ["office2024", "ノートン360デラックス"])));
  if (child.preserve.wpsAttributeKeys.includes("software_included")) {
    out.push(attrPatch(a, "software_included", valueRows(a, c, "software_included", ["Office 2024", "ノートン360デラックス"])));
  }
  return out;
}
function setValue(a, k, v) {
  if (Array.isArray(a[k]) && a[k][0]) {
    a[k] = clone(a[k]);
    a[k][0].value = v;
  } else {
    a[k] = [{ marketplace_id: MARKETPLACE_ID, language_tag: "ja_JP", value: v }];
  }
}
function parentAttrs(source, relationship, exclusive) {
  const a = clone(source);
  for (const k of [
    "externally_assigned_product_identifier", "merchant_suggested_asin",
    "purchasable_offer", "fulfillment_availability", "condition_type", "list_price",
    "minimum_seller_allowed_price", "maximum_seller_allowed_price",
    "merchant_shipping_group", "hard_disk", "flash_memory", "ram_memory",
    "computer_memory", "memory_storage_capacity", "child_parent_sku_relationship",
    "parentage_level", "variation_theme"
  ]) delete a[k];
  setValue(a, "item_name", PARENT_TITLE);
  const r = relationRows("parent", relationship);
  a.parentage_level = r.parentage_level;
  a.variation_theme = r.variation_theme;
  a.is_exclusive_product = clone(exclusive);
  return a;
}

async function patchListing(a, sku, patches, preview) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues"
  });
  if (preview) q.set("mode", "VALIDATION_PREVIEW");
  return req(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,
    a,
    { method: "PATCH", body: { productType: PRODUCT_TYPE, patches } }
  );
}
async function putListing(a, sku, attrs, preview) {
  const { sellerId, marketplaceId, endpoint } = cfg();
  const q = new URLSearchParams({
    marketplaceIds: marketplaceId,
    issueLocale: "ja_JP",
    includedData: "issues"
  });
  if (preview) q.set("mode", "VALIDATION_PREVIEW");
  return req(
    `${endpoint}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?${q}`,
    a,
    { method: "PUT", body: { productType: PRODUCT_TYPE, requirements: "LISTING", attributes: attrs } }
  );
}

function sum(r) {
  const issues = Array.isArray(r?.body?.issues) ? r.body.issues : [];
  const errors = issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR");
  const status = String(r?.body?.status || "").toUpperCase();
  return {
    httpStatus: r.http,
    responseOk: r.ok,
    status,
    submissionId: r?.body?.submissionId || "",
    issueCount: issues.length,
    errorCount: errors.length,
    issueCodes: [...new Set(issues.map(i => String(i?.code || "")).filter(Boolean))],
    errors: errors.slice(0, 12).map(i => ({
      code: String(i?.code || ""),
      message: String(i?.message || "").slice(0, 600),
      attributeNames: Array.isArray(i?.attributeNames) ? i.attributeNames : []
    })),
    valid: r.ok && errors.length === 0 && ["VALID", "ACCEPTED"].includes(status)
  };
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function attrExact(a, key) { return clone(a?.[key] || []); }

function protectedSnapshot(x) {
  const a = x.attrs || {};
  const images = {};
  for (const k of imageKeys(a)) images[k] = clone(a[k] || []);
  return {
    availableQuantity: x.preserve.availableQuantity,
    offers: clone(x.preserve.offers),
    images,
    brand: attrExact(a, "brand"),
    manufacturer: attrExact(a, "manufacturer"),
    modelName: attrExact(a, "model_name"),
    warranty: attrExact(a, "warranty_description"),
    conditionType: attrExact(a, "condition_type"),
    listPrice: attrExact(a, "list_price"),
    minimumSellerAllowedPrice: attrExact(a, "minimum_seller_allowed_price"),
    maximumSellerAllowedPrice: attrExact(a, "maximum_seller_allowed_price")
  };
}

async function buildPreflight(a) {
  const schema = await getSchema(a);
  if (!vals(nestedSpec(schema, "parentage_level", "value")).includes("parent") ||
      !vals(nestedSpec(schema, "parentage_level", "value")).includes("child")) {
    throw new Error("PTD parentage missing");
  }
  const relationship = vals(nestedSpec(schema, "child_parent_sku_relationship", "child_relationship_type"))
    .find(v => /^variation$/i.test(v));
  if (!relationship) throw new Error("PTD variation relationship missing");
  if (!vals(nestedSpec(schema, "variation_theme", "name")).includes(VARIATION_THEME)) {
    throw new Error(`PTD theme missing ${VARIATION_THEME}`);
  }
  const exclusive = exclusiveFalse(schema);

  const pf = await getListing(a, PARENT_SKU);
  if (pf.ok) throw new Error(`PARENT_SKU_ALREADY_EXISTS ${PARENT_SKU}`);
  if (pf.http !== 404) throw new Error(`PARENT_PREFLIGHT_UNEXPECTED_HTTP ${pf.http}`);

  const kids = [];
  for (const p of CHILDREN) kids.push(inspect(p, await getListing(a, p.sku)));
  const canonical = kids.find(x => x.plan.canonical);
  if (!canonical) throw new Error("CANONICAL_E7_NOT_FOUND");
  if (canonical.preserve.errorCount > 0) {
    throw new Error(`CANONICAL_E7_HAS_ERRORS ${canonical.preserve.issueCodes.join(",")}`);
  }
  if (!canonical.preserve.bundle.office2024 ||
      !canonical.preserve.bundle.norton360 ||
      canonical.preserve.bundle.wps) {
    throw new Error(`CANONICAL_E7_BUNDLE_UNEXPECTED ${JSON.stringify(canonical.preserve.bundle)}`);
  }

  const unresolved = [];
  for (const child of kids.filter(x => !x.plan.canonical)) {
    const outside = child.preserve.wpsAttributeKeys.filter(k => !CONTENT_ALLOWED_KEYS.includes(k));
    if (outside.length) {
      unresolved.push({
        sku: child.plan.sku,
        asin: child.plan.asin,
        keys: outside,
        reason: "WPS_MARKER_OUTSIDE_ALLOWED_CONTENT_KEYS"
      });
    }
  }
  if (unresolved.length) {
    throw new Error(`UNRESOLVED_WPS_ATTRIBUTE ${JSON.stringify(unresolved)}`);
  }

  const parentAttributes = parentAttrs(canonical.attrs, relationship, exclusive);
  const parentPreview = sum(await putListing(a, PARENT_SKU, parentAttributes, true));

  const childPlans = [];
  for (const child of kids) {
    const patches = relationPatches(child.attrs, relationship, exclusive);
    if (!child.plan.canonical) patches.push(...contentPatches(child, canonical));
    const preview = sum(await patchListing(a, child.plan.sku, patches, true));
    childPlans.push({
      child,
      patches,
      preview,
      protectedBefore: protectedSnapshot(child)
    });
  }

  const ready = parentPreview.valid && childPlans.every(x => x.preview.valid);
  if (!ready) {
    throw new Error(`FRESH_VALIDATION_PREVIEW_FAILED ${JSON.stringify({
      parent: parentPreview,
      children: childPlans.map(x => ({ sku: x.child.plan.sku, preview: x.preview }))
    })}`);
  }

  return {
    relationship,
    exclusive,
    kids,
    canonical,
    parentAttributes,
    parentPreview,
    childPlans
  };
}

function verifyChildExpected(child, listingResponse) {
  if (!listingResponse.ok) {
    return { verified: false, reason: `HTTP_${listingResponse.http}` };
  }
  const now = inspect(child.plan, listingResponse);
  const r = now.preserve.relationBefore;
  const relationOk =
    r.parentageLevel === "child" &&
    r.parentSku === PARENT_SKU &&
    String(r.childRelationshipType || "").toLowerCase() === "variation" &&
    r.variationTheme === VARIATION_THEME;

  const contentOk = child.plan.canonical
    ? (
        now.preserve.title === child.preserve.title &&
        sameJson(bundle(now.attrs, now.preserve.title), child.preserve.bundle)
      )
    : (
        now.preserve.title === titleFor(child.plan) &&
        now.preserve.bundle.office2024 &&
        now.preserve.bundle.norton360 &&
        !now.preserve.bundle.wps
      );

  const protectedNow = protectedSnapshot(now);
  const protectedBefore = protectedSnapshot(child);
  const protectedOk = sameJson(protectedNow, protectedBefore);

  return {
    verified: relationOk && contentOk && protectedOk && now.preserve.errorCount === 0,
    relationOk,
    contentOk,
    protectedOk,
    errorCount: now.preserve.errorCount,
    issueCodes: now.preserve.issueCodes,
    availableQuantity: now.preserve.availableQuantity,
    title: now.preserve.title,
    bundle: now.preserve.bundle,
    relation: r
  };
}

function parentVerify(r) {
  if (!r.ok) return { verified: false, reason: `HTTP_${r.http}` };
  const x = r.body || {};
  const s = x?.summaries?.[0] || {};
  const a = x?.attributes || {};
  const rel = relation(a);
  const issues = Array.isArray(x?.issues) ? x.issues : [];
  const errors = issues.filter(i => String(i?.severity || "").toUpperCase() === "ERROR");
  const verified =
    String(x?.sku || "") === PARENT_SKU &&
    String(s?.productType || "") === PRODUCT_TYPE &&
    String(first(a?.item_name) || "") === PARENT_TITLE &&
    rel.parentageLevel === "parent" &&
    rel.variationTheme === VARIATION_THEME &&
    qty(x) === 0 &&
    (!Array.isArray(x?.offers) || x.offers.length === 0) &&
    errors.length === 0;
  return {
    verified,
    productType: s?.productType || "",
    title: first(a?.item_name),
    relation: rel,
    availableQuantity: qty(x),
    offerCount: Array.isArray(x?.offers) ? x.offers.length : 0,
    errorCount: errors.length,
    issueCodes: [...new Set(issues.map(i => String(i?.code || "")).filter(Boolean))]
  };
}

async function verifyAll(a, preflight) {
  const attempts = [];
  let final = null;
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(VERIFY_GAP_MS);
    const p = parentVerify(await getListing(a, PARENT_SKU));
    const c = [];
    for (const plan of preflight.childPlans) {
      c.push({
        sku: plan.child.plan.sku,
        ...verifyChildExpected(plan.child, await getListing(a, plan.child.plan.sku))
      });
    }
    const verified = p.verified && c.every(x => x.verified);
    final = { verified, parent: p, children: c };
    attempts.push({
      attempt,
      verified,
      parentVerified: p.verified,
      childVerifiedCount: c.filter(x => x.verified).length
    });
    if (verified) break;
  }
  return { attempts, final };
}

async function handler(req0, res) {
  let persistentWrites = 0;
  const writesSent = [];
  try {
    const sec = secret();
    if (!sec) {
      return res.status(500).json({
        ok: false, moduleVersion: MODULE_VERSION, route: ROUTE,
        amazonPersistentWrites: 0, externalChanges: 0, error: "secret missing"
      });
    }
    if (String(req0.headers["x-api-secret"] || "") !== sec) {
      return res.status(401).json({
        ok: false, moduleVersion: MODULE_VERSION, route: ROUTE,
        amazonPersistentWrites: 0, externalChanges: 0, error: "Unauthorized"
      });
    }

    const dryRun = req0.body?.dryRun !== false;
    const requestedScope = String(req0.body?.approvedScope || "").trim();
    const confirmLive = String(req0.body?.confirmLive || "").trim();

    if (!dryRun) {
      if (requestedScope !== APPROVED_SCOPE) {
        throw new Error("LIVE_GUARD_BLOCKED: approvedScope mismatch");
      }
      if (confirmLive !== CONFIRM_LIVE) {
        throw new Error("LIVE_GUARD_BLOCKED: confirmation token mismatch");
      }
    }

    const a = await token();
    const preflight = await buildPreflight(a);

    const previewResult = {
      parent: preflight.parentPreview,
      children: preflight.childPlans.map(x => ({
        sku: x.child.plan.sku,
        asin: x.child.plan.asin,
        relationOnly: !!x.child.plan.canonical,
        patchPaths: x.patches.map(p => p.path),
        preview: x.preview,
        freshBefore: x.child.preserve
      }))
    };

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        status: "PASS",
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        dryRun: true,
        productType: PRODUCT_TYPE,
        parentSku: PARENT_SKU,
        parentTitle: PARENT_TITLE,
        variationTheme: VARIATION_THEME,
        approvedScope: APPROVED_SCOPE,
        validationPreview: previewResult,
        decision: {
          technicalReady: true,
          readyForExplicitLiveApproval: true,
          next: "Request explicit approval for parent + 6 child persistent writes."
        },
        prospectivePersistentWrites: {
          count: 7,
          writes: [
            { type: "PUT_NEW_PARENT", sku: PARENT_SKU },
            ...preflight.childPlans.map(x => ({
              type: "PATCH_CHILD",
              sku: x.child.plan.sku,
              asin: x.child.plan.asin,
              patchPaths: x.patches.map(p => p.path)
            }))
          ],
          deferredNotIncluded: [
            "old TJ-00SX-UW3J parent retirement",
            "child price changes",
            "child inventory changes",
            "child B2B changes",
            "child image changes",
            "Amazon Ads",
            "Yahoo"
          ]
        },
        amazonPersistentWrites: 0,
        inventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        externalChanges: 0,
        liveAllowed: false,
        liveBlockedReason: "EXPLICIT_USER_LIVE_APPROVAL_REQUIRED"
      });
    }

    const parentLive = sum(await putListing(a, PARENT_SKU, preflight.parentAttributes, false));
    persistentWrites += 1;
    writesSent.push({ type: "PUT_NEW_PARENT", sku: PARENT_SKU, result: parentLive });
    if (!parentLive.valid) {
      return res.status(502).json({
        ok: false,
        status: "PARTIAL_OR_UNKNOWN",
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        approvedScope: APPROVED_SCOPE,
        writesSent,
        amazonPersistentWrites: persistentWrites,
        externalChanges: persistentWrites,
        doNotRetryAutomatically: true,
        error: "PARENT_LIVE_RESPONSE_NOT_ACCEPTED"
      });
    }

    for (const p of preflight.childPlans) {
      const live = sum(await patchListing(a, p.child.plan.sku, p.patches, false));
      persistentWrites += 1;
      writesSent.push({
        type: "PATCH_CHILD",
        sku: p.child.plan.sku,
        asin: p.child.plan.asin,
        result: live
      });
      if (!live.valid) {
        return res.status(502).json({
          ok: false,
          status: "PARTIAL_OR_UNKNOWN",
          moduleVersion: MODULE_VERSION,
          route: ROUTE,
          approvedScope: APPROVED_SCOPE,
          writesSent,
          amazonPersistentWrites: persistentWrites,
          externalChanges: persistentWrites,
          doNotRetryAutomatically: true,
          error: `CHILD_LIVE_RESPONSE_NOT_ACCEPTED:${p.child.plan.sku}`
        });
      }
    }

    const verification = await verifyAll(a, preflight);
    const postVerified = Boolean(verification.final?.verified);
    return res.status(200).json({
      ok: postVerified,
      status: postVerified ? "PASS" : "ACCEPTED_PENDING_VERIFICATION",
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      approvedScope: APPROVED_SCOPE,
      parentSku: PARENT_SKU,
      childCount: CHILDREN.length,
      validationPreview: previewResult,
      writesSent,
      postVerified,
      verificationAttempts: verification.attempts,
      finalVerification: verification.final,
      amazonPersistentWrites: persistentWrites,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: persistentWrites,
      doNotRetryAutomatically: !postVerified,
      note: postVerified
        ? "G83 parent + 6 children updated once and Fresh GET verified."
        : "All 7 writes were sent once, but Fresh verification is pending. Do not retry LIVE automatically."
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      status: persistentWrites > 0 ? "PARTIAL_OR_UNKNOWN" : "BLOCK",
      moduleVersion: MODULE_VERSION,
      route: ROUTE,
      writesSent,
      amazonPersistentWrites: persistentWrites,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: persistentWrites,
      doNotRetryAutomatically: persistentWrites > 0,
      error: err?.message || String(err),
      note: persistentWrites > 0
        ? "At least one persistent write was already sent. Do not retry automatically."
        : "No persistent Amazon write was sent."
    });
  }
}

express.application.listen = function g83VariationLiveListen(...args) {
  const exists = Boolean(this?._router?.stack?.some(l => l?.route?.path === ROUTE));
  if (!exists) this.post(ROUTE, handler);
  return originalListen.apply(this, args);
};
