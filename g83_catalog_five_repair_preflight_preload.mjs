import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION =
  "2026-09-06-g83-catalog-five-repair-preflight-v1.0.0";
const ROUTE =
  "/amazon/listing/g83-catalog-five-repair-preflight";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const VARIATION_THEME =
  "HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";
const PARENT_SKU =
  "g83-hs-i5-11g-variation-parent";
const EXPECTED_PARENT_ASIN = "B0HHYNVYD5";
const LEGACY_PARENT_SKU = "TJ-00SX-UW3J";
const CANONICAL_SKU = "E7-YLJ3-F9CY";
const CANONICAL_ASIN = "B0GZBHBQN2";
const REQUEST_TIMEOUT_MS = 20000;
const originalListen = express.application.listen;

const TARGETS = Object.freeze([
  {
    sku: "F7-AF7O-IGX5",
    asin: "B0FN3KQFR3",
    label: "8GB/256GB"
  },
  {
    sku: "SO-9QJ3-7SHR",
    asin: "B0FPC2JKBY",
    label: "8GB/512GB"
  },
  {
    sku: "9K-D0RA-4R8V",
    asin: "B0FPC4R7ZG",
    label: "8GB/1TB"
  },
  {
    sku: "5K-G098-FO9O",
    asin: "B0FPC52B8K",
    label: "16GB/512GB"
  },
  {
    sku: "QH-ITJ6-BTTC",
    asin: "B0FPC385LM",
    label: "16GB/1TB"
  }
]);

const IDENTITY_KEYS = Object.freeze([
  "brand",
  "manufacturer",
  "model_name",
  "model_number",
  "part_number",
  "item_type_name",
  "product_type_name"
]);

function jparse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {
      rawText: String(text || "").slice(0, 2000)
    };
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function secret() {
  return String(
    process.env.AMAZON_STOCK_API_SECRET || ""
  ).trim();
}

function cfg() {
  const sellerId = String(
    process.env.SPAPI_SELLER_ID || ""
  ).trim();

  const marketplaceId = String(
    process.env.SPAPI_MARKETPLACE_ID ||
    MARKETPLACE_ID
  ).trim();

  const endpoint = String(
    process.env.SPAPI_ENDPOINT ||
    "https://sellingpartnerapi-fe.amazon.com"
  ).replace(/\/$/, "");

  if (!sellerId) {
    throw new Error("Missing env: SPAPI_SELLER_ID");
  }

  if (marketplaceId !== MARKETPLACE_ID) {
    throw new Error(
      `GUARD_BLOCKED marketplace=${marketplaceId}`
    );
  }

  return {
    sellerId,
    marketplaceId,
    endpoint
  };
}

async function ft(url, opt = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...opt,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function token() {
  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  const refreshToken = process.env.REFRESH_TOKEN;

  if (
    !clientId ||
    !clientSecret ||
    !refreshToken
  ) {
    throw new Error("Missing LWA env");
  }

  const response = await ft(
    "https://api.amazon.com/auth/o2/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      })
    }
  );

  const body = jparse(await response.text());

  if (!response.ok || !body.access_token) {
    throw new Error(
      `LWA token error ${response.status}`
    );
  }

  return body.access_token;
}

async function req(url, accessToken, opt = {}) {
  const response = await ft(url, {
    method: opt.method || "GET",
    headers: {
      "x-amz-access-token": accessToken,
      accept: "application/json",
      ...(opt.body
        ? { "content-type": "application/json" }
        : {})
    },
    ...(opt.body
      ? { body: JSON.stringify(opt.body) }
      : {})
  });

  return {
    http: response.status,
    ok: response.ok,
    body: jparse(await response.text())
  };
}

async function getListing(accessToken, sku) {
  const {
    sellerId,
    marketplaceId,
    endpoint
  } = cfg();

  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData:
      "summaries,attributes,issues,offers,fulfillmentAvailability",
    issueLocale: "ja_JP"
  });

  return req(
    `${endpoint}/listings/2021-08-01/items/` +
      `${encodeURIComponent(sellerId)}/` +
      `${encodeURIComponent(sku)}?${query}`,
    accessToken
  );
}

async function getCatalog(accessToken, asin) {
  const {
    marketplaceId,
    endpoint
  } = cfg();

  const query = new URLSearchParams({
    marketplaceIds: marketplaceId,
    includedData:
      "attributes,relationships,summaries,productTypes"
  });

  return req(
    `${endpoint}/catalog/2022-04-01/items/` +
      `${encodeURIComponent(asin)}?${query}`,
    accessToken
  );
}

async function getSchema(accessToken) {
  const {
    sellerId,
    marketplaceId,
    endpoint
  } = cfg();

  const query = new URLSearchParams({
    sellerId,
    marketplaceIds: marketplaceId,
    requirements: "LISTING",
    requirementsEnforced: "ENFORCED",
    locale: "ja_JP"
  });

  const definition = await req(
    `${endpoint}/definitions/2020-09-01/` +
      `productTypes/${PRODUCT_TYPE}?${query}`,
    accessToken
  );

  if (!definition.ok) {
    throw new Error(
      `PTD GET ${definition.http}`
    );
  }

  const resource = String(
    definition.body?.schema?.link?.resource || ""
  );

  if (!resource) {
    throw new Error("PTD schema link missing");
  }

  const response = await ft(resource, {
    headers: {
      accept: "application/json"
    }
  });

  const schema = jparse(
    await response.text()
  );

  if (!response.ok) {
    throw new Error(
      `PTD schema fetch ${response.status}`
    );
  }

  return schema;
}

function rawValues(spec) {
  const out = [];
  const seen = new Set();

  (function walk(node, depth) {
    if (
      !node ||
      typeof node !== "object" ||
      depth > 7
    ) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(
        x => walk(x, depth + 1)
      );
      return;
    }

    if (Array.isArray(node.enum)) {
      for (const v of node.enum) {
        const key =
          typeof v + ":" + JSON.stringify(v);

        if (!seen.has(key)) {
          seen.add(key);
          out.push(v);
        }
      }
    }

    if (node.const !== undefined) {
      const v = node.const;
      const key =
        typeof v + ":" + JSON.stringify(v);

      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }

    for (const k of [
      "items",
      "properties",
      "oneOf",
      "anyOf",
      "allOf"
    ]) {
      walk(node[k], depth + 1);
    }
  })(spec, 0);

  return out;
}

function nestedSpec(
  schema,
  name,
  child
) {
  return (
    schema?.properties?.[name]
      ?.items?.properties?.[child] ||
    null
  );
}

function vals(spec) {
  return rawValues(spec).map(String);
}

function first(rows) {
  return (
    Array.isArray(rows) &&
    rows[0]
      ? rows[0].value ?? null
      : null
  );
}

function relation(attrs) {
  return {
    parentageLevel:
      first(attrs?.parentage_level),
    parentSku:
      attrs?.child_parent_sku_relationship
        ?.[0]?.parent_sku ?? null,
    childRelationshipType:
      attrs?.child_parent_sku_relationship
        ?.[0]?.child_relationship_type ??
      null,
    variationTheme:
      attrs?.variation_theme?.[0]?.name ??
      null
  };
}

function flatten(
  value,
  out = []
) {
  if (value == null) {
    return out;
  }

  if (typeof value === "string") {
    out.push(value);
    return out;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    out.push(String(value));
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach(
      x => flatten(x, out)
    );
    return out;
  }

  if (typeof value === "object") {
    Object.values(value).forEach(
      x => flatten(x, out)
    );
  }

  return out;
}

function normalizedValues(
  attrs,
  key
) {
  const values = flatten(
    attrs?.[key],
    []
  )
    .map(v => String(v).trim())
    .filter(Boolean)
    .sort();

  return [...new Set(values)];
}

function identitySnapshot(attrs) {
  const out = {};

  for (const key of IDENTITY_KEYS) {
    out[key] =
      normalizedValues(attrs, key);
  }

  return out;
}

function identityDiff(
  canonicalIdentity,
  targetIdentity
) {
  const diffs = [];

  for (const key of IDENTITY_KEYS) {
    const a =
      canonicalIdentity[key] || [];
    const b =
      targetIdentity[key] || [];

    if (
      JSON.stringify(a) !==
      JSON.stringify(b)
    ) {
      diffs.push({
        key,
        canonical: a,
        target: b
      });
    }
  }

  return diffs;
}

function relationshipAsins(
  relationships
) {
  const out = [];

  (function walk(value, depth) {
    if (
      value == null ||
      depth > 12
    ) {
      return;
    }

    if (typeof value === "string") {
      const s =
        value.trim().toUpperCase();

      if (/^[A-Z0-9]{10}$/.test(s)) {
        out.push(s);
      }

      return;
    }

    if (Array.isArray(value)) {
      value.forEach(
        x => walk(x, depth + 1)
      );
      return;
    }

    if (typeof value === "object") {
      Object.values(value).forEach(
        x => walk(x, depth + 1)
      );
    }
  })(
    relationships,
    0
  );

  return [...new Set(out)];
}

function catalogSnapshot(
  asin,
  response
) {
  if (!response.ok) {
    return {
      asin,
      exists: false,
      httpStatus: response.http,
      relationshipAsins: [],
      identity: {},
      error: response.body
    };
  }

  const body = response.body || {};
  const attrs =
    body.attributes &&
    typeof body.attributes === "object"
      ? body.attributes
      : {};

  const relationships =
    Array.isArray(body.relationships)
      ? body.relationships
      : [];

  return {
    asin:
      String(body.asin || asin),
    exists: true,
    httpStatus: response.http,
    relationshipAsins:
      relationshipAsins(relationships),
    identity:
      identitySnapshot(attrs),
    productTypes:
      Array.isArray(body.productTypes)
        ? body.productTypes
        : [],
    summaries:
      Array.isArray(body.summaries)
        ? body.summaries
        : []
  };
}

function listingSnapshot(
  expectedSku,
  expectedAsin,
  response
) {
  if (!response.ok) {
    return {
      sku: expectedSku,
      exists: false,
      httpStatus: response.http,
      asin: "",
      productType: "",
      relation: {},
      errorCount: null,
      issueCodes: [],
      attrs: {},
      error: response.body
    };
  }

  const body = response.body || {};
  const summary =
    Array.isArray(body.summaries)
      ? body.summaries[0] || {}
      : {};

  const attrs =
    body.attributes &&
    typeof body.attributes === "object"
      ? body.attributes
      : {};

  const issues =
    Array.isArray(body.issues)
      ? body.issues
      : [];

  const errors =
    issues.filter(
      x =>
        String(
          x?.severity || ""
        ).toUpperCase() === "ERROR"
    );

  return {
    sku: expectedSku,
    exists: true,
    httpStatus: response.http,
    asin:
      String(summary.asin || ""),
    expectedAsin,
    productType:
      String(summary.productType || ""),
    relation: relation(attrs),
    errorCount: errors.length,
    issueCodes: [
      ...new Set(
        issues
          .map(
            x => String(x?.code || "")
          )
          .filter(Boolean)
      )
    ],
    attrs
  };
}

function attrPatch(
  attrs,
  key,
  value
) {
  return {
    op:
      Array.isArray(attrs?.[key]) &&
      attrs[key].length
        ? "replace"
        : "add",
    path: `/attributes/${key}`,
    value
  };
}

function relationRows(
  relationship
) {
  return {
    parentage_level: [
      {
        marketplace_id:
          MARKETPLACE_ID,
        value: "child"
      }
    ],
    variation_theme: [
      {
        name: VARIATION_THEME
      }
    ],
    child_parent_sku_relationship: [
      {
        marketplace_id:
          MARKETPLACE_ID,
        child_relationship_type:
          relationship,
        parent_sku: PARENT_SKU
      }
    ]
  };
}

function exclusiveFalse(schema) {
  const spec =
    nestedSpec(
      schema,
      "is_exclusive_product",
      "value"
    );

  if (!spec) {
    throw new Error(
      "PTD missing is_exclusive_product.value"
    );
  }

  const allowed =
    rawValues(spec);

  let value = null;

  if (
    allowed.some(v => v === false)
  ) {
    value = false;
  } else if (
    allowed.some(
      v =>
        String(v).toLowerCase() ===
        "false"
    )
  ) {
    value = allowed.find(
      v =>
        String(v).toLowerCase() ===
        "false"
    );
  } else if (
    String(
      spec.type || ""
    ).toLowerCase() === "boolean"
  ) {
    value = false;
  }

  if (value === null) {
    throw new Error(
      "PTD no false value for " +
      "is_exclusive_product"
    );
  }

  return [
    {
      marketplace_id:
        MARKETPLACE_ID,
      value
    }
  ];
}

function relationPatches(
  attrs,
  relationship,
  exclusiveRows
) {
  const rows =
    relationRows(relationship);

  return [
    attrPatch(
      attrs,
      "parentage_level",
      rows.parentage_level
    ),
    attrPatch(
      attrs,
      "variation_theme",
      rows.variation_theme
    ),
    attrPatch(
      attrs,
      "child_parent_sku_relationship",
      rows.child_parent_sku_relationship
    ),
    attrPatch(
      attrs,
      "is_exclusive_product",
      clone(exclusiveRows)
    )
  ];
}

async function patchPreview(
  accessToken,
  sku,
  patches
) {
  const {
    sellerId,
    marketplaceId,
    endpoint
  } = cfg();

  const query =
    new URLSearchParams({
      marketplaceIds: marketplaceId,
      issueLocale: "ja_JP",
      includedData: "issues",
      mode: "VALIDATION_PREVIEW"
    });

  return req(
    `${endpoint}/listings/2021-08-01/items/` +
      `${encodeURIComponent(sellerId)}/` +
      `${encodeURIComponent(sku)}?${query}`,
    accessToken,
    {
      method: "PATCH",
      body: {
        productType: PRODUCT_TYPE,
        patches
      }
    }
  );
}

function previewSummary(response) {
  const issues =
    Array.isArray(response?.body?.issues)
      ? response.body.issues
      : [];

  const errors =
    issues.filter(
      x =>
        String(
          x?.severity || ""
        ).toUpperCase() === "ERROR"
    );

  const status =
    String(
      response?.body?.status || ""
    ).toUpperCase();

  return {
    httpStatus: response.http,
    responseOk: response.ok,
    status,
    submissionId:
      String(
        response?.body?.submissionId || ""
      ),
    issueCount: issues.length,
    errorCount: errors.length,
    issueCodes: [
      ...new Set(
        issues
          .map(
            x => String(x?.code || "")
          )
          .filter(Boolean)
      )
    ],
    valid:
      response.ok &&
      errors.length === 0 &&
      ["VALID", "ACCEPTED"].includes(
        status
      )
  };
}

async function handler(req0, res) {
  try {
    const sec = secret();

    if (!sec) {
      return res.status(500).json({
        ok: false,
        moduleVersion:
          MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "secret missing"
      });
    }

    if (
      String(
        req0.headers[
          "x-api-secret"
        ] || ""
      ) !== sec
    ) {
      return res.status(401).json({
        ok: false,
        moduleVersion:
          MODULE_VERSION,
        route: ROUTE,
        readOnly: true,
        externalChanges: 0,
        error: "Unauthorized"
      });
    }

    if (req0.body?.dryRun === false) {
      throw new Error(
        "LIVE disabled; preflight is read-only"
      );
    }

    const accessToken =
      await token();

    const schema =
      await getSchema(accessToken);

    const relationship =
      vals(
        nestedSpec(
          schema,
          "child_parent_sku_relationship",
          "child_relationship_type"
        )
      ).find(
        v => /^variation$/i.test(v)
      );

    if (!relationship) {
      throw new Error(
        "PTD variation relationship missing"
      );
    }

    if (
      !vals(
        nestedSpec(
          schema,
          "variation_theme",
          "name"
        )
      ).includes(VARIATION_THEME)
    ) {
      throw new Error(
        "PTD variation theme missing"
      );
    }

    const exclusive =
      exclusiveFalse(schema);

    const parentListing =
      listingSnapshot(
        PARENT_SKU,
        EXPECTED_PARENT_ASIN,
        await getListing(
          accessToken,
          PARENT_SKU
        )
      );

    if (
      !parentListing.exists ||
      parentListing.asin !==
        EXPECTED_PARENT_ASIN
    ) {
      throw new Error(
        "PARENT_IDENTITY_CHANGED"
      );
    }

    const parentCatalog =
      catalogSnapshot(
        EXPECTED_PARENT_ASIN,
        await getCatalog(
          accessToken,
          EXPECTED_PARENT_ASIN
        )
      );

    if (!parentCatalog.exists) {
      throw new Error(
        "PARENT_CATALOG_NOT_FOUND"
      );
    }

    const canonicalListing =
      listingSnapshot(
        CANONICAL_SKU,
        CANONICAL_ASIN,
        await getListing(
          accessToken,
          CANONICAL_SKU
        )
      );

    const canonicalCatalog =
      catalogSnapshot(
        CANONICAL_ASIN,
        await getCatalog(
          accessToken,
          CANONICAL_ASIN
        )
      );

    const canonicalLinked =
      canonicalListing.exists &&
      canonicalListing.asin ===
        CANONICAL_ASIN &&
      canonicalCatalog.exists &&
      parentCatalog.relationshipAsins
        .includes(CANONICAL_ASIN) &&
      canonicalCatalog.relationshipAsins
        .includes(
          EXPECTED_PARENT_ASIN
        );

    if (!canonicalLinked) {
      throw new Error(
        "CANONICAL_E7_CATALOG_LINK_NOT_STABLE"
      );
    }

    const legacyListingResponse =
      await getListing(
        accessToken,
        LEGACY_PARENT_SKU
      );

    const legacyListing =
      listingSnapshot(
        LEGACY_PARENT_SKU,
        "",
        legacyListingResponse
      );

    let legacyAsin = "";

    if (
      legacyListing.exists &&
      legacyListing.asin
    ) {
      legacyAsin =
        legacyListing.asin;
    }

    const targets = [];
    let asymmetryCount = 0;
    let stillLegacyCount = 0;
    let listingGuardFailCount = 0;

    for (const plan of TARGETS) {
      const listing =
        listingSnapshot(
          plan.sku,
          plan.asin,
          await getListing(
            accessToken,
            plan.sku
          )
        );

      const catalog =
        catalogSnapshot(
          plan.asin,
          await getCatalog(
            accessToken,
            plan.asin
          )
        );

      const listingRelationOk =
        listing.exists &&
        listing.asin === plan.asin &&
        listing.productType ===
          PRODUCT_TYPE &&
        listing.errorCount === 0 &&
        listing.relation
          ?.parentageLevel ===
          "child" &&
        listing.relation
          ?.parentSku ===
          PARENT_SKU &&
        String(
          listing.relation
            ?.childRelationshipType ||
          ""
        ).toLowerCase() ===
          "variation" &&
        listing.relation
          ?.variationTheme ===
          VARIATION_THEME;

      if (!listingRelationOk) {
        listingGuardFailCount += 1;
      }

      const parentContains =
        parentCatalog.relationshipAsins
          .includes(plan.asin);

      const childPoints =
        catalog.relationshipAsins
          .includes(
            EXPECTED_PARENT_ASIN
          );

      const asymmetric =
        parentContains !== childPoints;

      if (asymmetric) {
        asymmetryCount += 1;
      }

      const stillLegacy =
        Boolean(
          legacyAsin &&
          catalog.relationshipAsins
            .includes(legacyAsin)
        );

      if (stillLegacy) {
        stillLegacyCount += 1;
      }

      const catalogLinked =
        parentContains &&
        childPoints;

      const identity =
        catalog.identity || {};

      const diffs =
        identityDiff(
          canonicalCatalog.identity,
          identity
        );

      targets.push({
        label: plan.label,
        sku: plan.sku,
        asin: plan.asin,
        listing: {
          exists: listing.exists,
          asin: listing.asin,
          productType:
            listing.productType,
          relation:
            listing.relation,
          errorCount:
            listing.errorCount,
          issueCodes:
            listing.issueCodes
        },
        catalog: {
          exists: catalog.exists,
          relationshipAsins:
            catalog.relationshipAsins,
          parentContains,
          childPoints,
          asymmetric,
          stillLegacy,
          catalogLinked
        },
        identity: {
          canonical:
            canonicalCatalog.identity,
          target: identity,
          diffs
        },
        listingRelationOk,
        patches:
          catalogLinked
            ? []
            : relationPatches(
                listing.attrs,
                relationship,
                exclusive
              ),
        preview: null
      });
    }

    if (asymmetryCount > 0) {
      return res.status(200).json({
        ok: true,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        status:
          "BLOCK_CATALOG_ASYMMETRY",
        readOnly: true,
        parentAsin:
          EXPECTED_PARENT_ASIN,
        canonicalLinked,
        targets,
        summary: {
          targetCount: 5,
          unresolvedCount:
            targets.filter(
              x =>
                !x.catalog
                  .catalogLinked
            ).length,
          asymmetryCount,
          stillLegacyCount,
          listingGuardFailCount,
          previewValidCount: 0
        },
        amazonPersistentWrites: 0,
        externalChanges: 0,
        liveAllowed: false,
        liveBlockedReason:
          "CATALOG_ASYMMETRY_REQUIRES_REVIEW"
      });
    }

    if (
      stillLegacyCount > 0 ||
      listingGuardFailCount > 0
    ) {
      return res.status(200).json({
        ok: true,
        moduleVersion: MODULE_VERSION,
        route: ROUTE,
        status:
          "BLOCK_FRESH_GUARD",
        readOnly: true,
        parentAsin:
          EXPECTED_PARENT_ASIN,
        legacyParentAsin:
          legacyAsin,
        canonicalLinked,
        targets,
        summary: {
          targetCount: 5,
          unresolvedCount:
            targets.filter(
              x =>
                !x.catalog
                  .catalogLinked
            ).length,
          asymmetryCount,
          stillLegacyCount,
          listingGuardFailCount,
          previewValidCount: 0
        },
        amazonPersistentWrites: 0,
        externalChanges: 0,
        liveAllowed: false,
        liveBlockedReason:
          "FRESH_GUARD_FAILED"
      });
    }

    const unresolved =
      targets.filter(
        x =>
          !x.catalog.catalogLinked
      );

    for (
      const target of unresolved
    ) {
      target.preview =
        previewSummary(
          await patchPreview(
            accessToken,
            target.sku,
            target.patches
          )
        );
    }

    const previewValidCount =
      unresolved.filter(
        x => x.preview?.valid === true
      ).length;

    const allPreviewValid =
      previewValidCount ===
      unresolved.length;

    const identityMismatchCount =
      targets.filter(
        x =>
          x.identity.diffs.length > 0
      ).length;

    let status =
      "RELATION_ONLY_PREVIEW_BLOCKED";

    if (unresolved.length === 0) {
      status =
        "ALREADY_CATALOG_COMPLETE";
    } else if (allPreviewValid) {
      status =
        unresolved.length === 5
          ? "FIVE_RELATION_ONLY_PREVIEW_VALID"
          : "PARTIAL_RELATION_ONLY_PREVIEW_VALID";
    }

    return res.status(200).json({
      ok: true,
      moduleVersion:
        MODULE_VERSION,
      route: ROUTE,
      status,
      readOnly: true,
      observedAt:
        new Date().toISOString(),
      parent: {
        sku: PARENT_SKU,
        asin: EXPECTED_PARENT_ASIN,
        relationshipAsins:
          parentCatalog.relationshipAsins
      },
      canonical: {
        sku: CANONICAL_SKU,
        asin: CANONICAL_ASIN,
        catalogLinked:
          canonicalLinked,
        identity:
          canonicalCatalog.identity
      },
      legacyParent: {
        sku:
          LEGACY_PARENT_SKU,
        asin:
          legacyAsin
      },
      targets,
      summary: {
        targetCount: 5,
        unresolvedCount:
          unresolved.length,
        alreadyLinkedCount:
          5 - unresolved.length,
        previewValidCount,
        allPreviewValid,
        identityMismatchCount,
        asymmetryCount,
        stillLegacyCount,
        listingGuardFailCount
      },
      diagnosisSignal:
        identityMismatchCount > 0
          ? "CATALOG_IDENTITY_DIFFERENCES_PRESENT"
          : "NO_TARGETED_IDENTITY_DIFFERENCES_FOUND",
      prospectivePersistentWrites: {
        count:
          allPreviewValid
            ? unresolved.length
            : 0,
        skus:
          allPreviewValid
            ? unresolved.map(
                x => x.sku
              )
            : []
      },
      amazonPersistentWrites: 0,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: 0,
      liveAllowed: false,
      liveBlockedReason:
        "EXPLICIT_NEW_REPAIR_APPROVAL_REQUIRED",
      doNotRerunOriginalLive: true
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      moduleVersion:
        MODULE_VERSION,
      route: ROUTE,
      status: "BLOCK",
      readOnly: true,
      amazonPersistentWrites: 0,
      inventoryWrites: 0,
      priceWrites: 0,
      b2bWrites: 0,
      adsWrites: 0,
      yahooWrites: 0,
      externalChanges: 0,
      liveAllowed: false,
      doNotRerunOriginalLive: true,
      error:
        err?.message || String(err)
    });
  }
}

express.application.listen =
  function g83CatalogFiveRepairPreflightListen(
    ...args
  ) {
    const exists = Boolean(
      this?._router?.stack?.some(
        layer =>
          layer?.route?.path ===
          ROUTE
      )
    );

    if (!exists) {
      this.post(ROUTE, handler);
    }

    return originalListen.apply(
      this,
      args
    );
  };
