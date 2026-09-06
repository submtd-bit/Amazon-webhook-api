import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const MODULE_VERSION =
  "2026-09-06-g83-catalog-five-relation-repair-live-v1.0.0";
const ROUTE =
  "/amazon/listing/g83-catalog-five-relation-repair-live";
const MARKETPLACE_ID = "A1VC38T7YXB528";
const PRODUCT_TYPE = "NOTEBOOK_COMPUTER";
const VARIATION_THEME =
  "HARD_DISK_SIZE/RAM_MEMORY_INSTALLED_SIZE";
const PARENT_SKU =
  "g83-hs-i5-11g-variation-parent";
const PARENT_ASIN = "B0HHYNVYD5";
const LEGACY_PARENT_SKU = "TJ-00SX-UW3J";
const CANONICAL_SKU = "E7-YLJ3-F9CY";
const CANONICAL_ASIN = "B0GZBHBQN2";
const APPROVED_SCOPE =
  "G83_UNLINKED_FIVE_RELATION_ONLY_CATALOG_REPAIR";
const CONFIRM_LIVE =
  "CONFIRM_G83_FIVE_RELATION_ONLY_CATALOG_REPAIR_20260906";
const REQUEST_TIMEOUT_MS = 20000;
const VERIFY_ATTEMPTS = 6;
const VERIFY_GAP_MS = 5000;
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

const APPROVED_PATCH_PATHS = Object.freeze([
  "/attributes/parentage_level",
  "/attributes/variation_theme",
  "/attributes/child_parent_sku_relationship",
  "/attributes/is_exclusive_product"
]);

const PROTECTED_ATTRIBUTE_KEYS = Object.freeze([
  "item_name",
  "bullet_point",
  "product_description",
  "included_components",
  "software_included",
  "brand",
  "manufacturer",
  "model_name",
  "model_number",
  "part_number",
  "hard_disk",
  "flash_memory",
  "ram_memory",
  "computer_memory",
  "memory_storage_capacity",
  "main_product_image_locator",
  "other_product_image_locator_1",
  "other_product_image_locator_2",
  "other_product_image_locator_3",
  "other_product_image_locator_4",
  "other_product_image_locator_5",
  "other_product_image_locator_6",
  "other_product_image_locator_7",
  "other_product_image_locator_8"
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

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
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
    throw new Error(
      "Missing env: SPAPI_SELLER_ID"
    );
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
  const controller =
    new AbortController();

  const timer =
    setTimeout(
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
  const clientId =
    process.env.LWA_CLIENT_ID;

  const clientSecret =
    process.env.LWA_CLIENT_SECRET;

  const refreshToken =
    process.env.REFRESH_TOKEN;

  if (
    !clientId ||
    !clientSecret ||
    !refreshToken
  ) {
    throw new Error("Missing LWA env");
  }

  const response =
    await ft(
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

  const body =
    jparse(await response.text());

  if (
    !response.ok ||
    !body.access_token
  ) {
    throw new Error(
      `LWA token error ${response.status}`
    );
  }

  return body.access_token;
}

async function req(
  url,
  accessToken,
  opt = {}
) {
  const response =
    await ft(url, {
      method: opt.method || "GET",
      headers: {
        "x-amz-access-token":
          accessToken,
        accept: "application/json",
        ...(opt.body
          ? {
              "content-type":
                "application/json"
            }
          : {})
      },
      ...(opt.body
        ? {
            body:
              JSON.stringify(opt.body)
          }
        : {})
    });

  return {
    http: response.status,
    ok: response.ok,
    body:
      jparse(await response.text())
  };
}

async function getListing(
  accessToken,
  sku
) {
  const {
    sellerId,
    marketplaceId,
    endpoint
  } = cfg();

  const query =
    new URLSearchParams({
      marketplaceIds:
        marketplaceId,
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

async function getCatalog(
  accessToken,
  asin
) {
  const {
    marketplaceId,
    endpoint
  } = cfg();

  const query =
    new URLSearchParams({
      marketplaceIds:
        marketplaceId,
      includedData:
        "relationships,summaries,productTypes"
    });

  return req(
    `${endpoint}/catalog/2022-04-01/items/` +
      `${encodeURIComponent(asin)}?${query}`,
    accessToken
  );
}

async function getSchema(
  accessToken
) {
  const {
    sellerId,
    marketplaceId,
    endpoint
  } = cfg();

  const query =
    new URLSearchParams({
      sellerId,
      marketplaceIds:
        marketplaceId,
      requirements: "LISTING",
      requirementsEnforced:
        "ENFORCED",
      locale: "ja_JP"
    });

  const definition =
    await req(
      `${endpoint}/definitions/2020-09-01/` +
        `productTypes/${PRODUCT_TYPE}?${query}`,
      accessToken
    );

  if (!definition.ok) {
    throw new Error(
      `PTD GET ${definition.http}`
    );
  }

  const resource =
    String(
      definition.body
        ?.schema?.link?.resource ||
      ""
    );

  if (!resource) {
    throw new Error(
      "PTD schema link missing"
    );
  }

  const response =
    await ft(resource, {
      headers: {
        accept: "application/json"
      }
    });

  const schema =
    jparse(
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

  (function walk(
    node,
    depth
  ) {
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
        const k =
          typeof v +
          ":" +
          JSON.stringify(v);

        if (!seen.has(k)) {
          seen.add(k);
          out.push(v);
        }
      }
    }

    if (
      node.const !== undefined
    ) {
      const v = node.const;
      const k =
        typeof v +
        ":" +
        JSON.stringify(v);

      if (!seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }

    for (
      const k of [
        "items",
        "properties",
        "oneOf",
        "anyOf",
        "allOf"
      ]
    ) {
      walk(
        node[k],
        depth + 1
      );
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
  return rawValues(spec).map(
    String
  );
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
      first(
        attrs?.parentage_level
      ),
    parentSku:
      attrs?.child_parent_sku_relationship
        ?.[0]?.parent_sku ??
      null,
    childRelationshipType:
      attrs?.child_parent_sku_relationship
        ?.[0]?.child_relationship_type ??
      null,
    variationTheme:
      attrs?.variation_theme?.[0]
        ?.name ??
      null
  };
}

function relationshipAsins(
  relationships
) {
  const out = [];

  (function walk(
    value,
    depth
  ) {
    if (
      value == null ||
      depth > 12
    ) {
      return;
    }

    if (
      typeof value ===
      "string"
    ) {
      const s =
        value
          .trim()
          .toUpperCase();

      if (
        /^[A-Z0-9]{10}$/.test(s)
      ) {
        out.push(s);
      }

      return;
    }

    if (Array.isArray(value)) {
      value.forEach(
        x =>
          walk(
            x,
            depth + 1
          )
      );

      return;
    }

    if (
      typeof value ===
      "object"
    ) {
      Object.values(value).forEach(
        x =>
          walk(
            x,
            depth + 1
          )
      );
    }
  })(
    relationships,
    0
  );

  return [
    ...new Set(out)
  ];
}

function catalogSnapshot(
  asin,
  response
) {
  if (!response.ok) {
    return {
      asin,
      exists: false,
      httpStatus:
        response.http,
      relationshipAsins: [],
      error:
        response.body
    };
  }

  const body =
    response.body || {};

  const relationships =
    Array.isArray(
      body.relationships
    )
      ? body.relationships
      : [];

  return {
    asin:
      String(
        body.asin || asin
      ),
    exists: true,
    httpStatus:
      response.http,
    relationshipAsins:
      relationshipAsins(
        relationships
      )
  };
}

function listingSnapshot(
  plan,
  response
) {
  if (!response.ok) {
    return {
      sku: plan.sku,
      asin: "",
      exists: false,
      httpStatus:
        response.http,
      relation: {},
      attrs: {},
      errorCount: null,
      issueCodes: [],
      error:
        response.body
    };
  }

  const body =
    response.body || {};

  const summary =
    Array.isArray(
      body.summaries
    )
      ? body.summaries[0] || {}
      : {};

  const attrs =
    body.attributes &&
    typeof body.attributes ===
      "object"
      ? body.attributes
      : {};

  const issues =
    Array.isArray(body.issues)
      ? body.issues
      : [];

  const errors =
    issues.filter(
      i =>
        String(
          i?.severity || ""
        ).toUpperCase() ===
        "ERROR"
    );

  return {
    sku: plan.sku,
    asin:
      String(
        summary.asin || ""
      ),
    expectedAsin:
      plan.asin,
    exists: true,
    httpStatus:
      response.http,
    productType:
      String(
        summary.productType || ""
      ),
    title:
      String(
        summary.itemName || ""
      ),
    relation:
      relation(attrs),
    availableQuantity:
      (
        Array.isArray(
          body.fulfillmentAvailability
        )
          ? body.fulfillmentAvailability
          : []
      ).reduce(
        (n, r) =>
          n +
          (
            Number.isFinite(
              Number(r?.quantity)
            )
              ? Number(
                  r.quantity
                )
              : 0
          ),
        0
      ),
    offers:
      Array.isArray(body.offers)
        ? clone(body.offers)
        : [],
    attrs,
    errorCount:
      errors.length,
    issueCodes: [
      ...new Set(
        issues
          .map(
            i =>
              String(
                i?.code || ""
              )
          )
          .filter(Boolean)
      )
    ]
  };
}

function protectedSnapshot(
  listing
) {
  const attrs = {};
  const src =
    listing.attrs || {};

  for (
    const key of
    PROTECTED_ATTRIBUTE_KEYS
  ) {
    if (
      Object.prototype
        .hasOwnProperty
        .call(src, key)
    ) {
      attrs[key] =
        clone(src[key]);
    }
  }

  return {
    asin: listing.asin,
    productType:
      listing.productType,
    title:
      listing.title,
    availableQuantity:
      listing.availableQuantity,
    offers:
      clone(listing.offers),
    attrs
  };
}

function sameJson(a, b) {
  return (
    JSON.stringify(a) ===
    JSON.stringify(b)
  );
}

function attrPatch(
  attrs,
  key,
  value
) {
  return {
    op:
      Array.isArray(
        attrs?.[key]
      ) &&
      attrs[key].length
        ? "replace"
        : "add",
    path:
      `/attributes/${key}`,
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
        name:
          VARIATION_THEME
      }
    ],
    child_parent_sku_relationship:
      [
        {
          marketplace_id:
            MARKETPLACE_ID,
          child_relationship_type:
            relationship,
          parent_sku:
            PARENT_SKU
        }
      ]
  };
}

function exclusiveFalse(
  schema
) {
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
    allowed.some(
      v => v === false
    )
  ) {
    value = false;
  } else if (
    allowed.some(
      v =>
        String(v).toLowerCase() ===
        "false"
    )
  ) {
    value =
      allowed.find(
        v =>
          String(v).toLowerCase() ===
          "false"
      );
  } else if (
    String(
      spec.type || ""
    ).toLowerCase() ===
    "boolean"
  ) {
    value = false;
  }

  if (value === null) {
    throw new Error(
      "PTD no false value for is_exclusive_product"
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
  exclusive
) {
  const rows =
    relationRows(
      relationship
    );

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
      clone(exclusive)
    )
  ];
}

function patchPathsExact(
  patches
) {
  return (
    Array.isArray(patches) &&
    patches.length ===
      APPROVED_PATCH_PATHS.length &&
    patches.every(
      (p, i) =>
        String(p?.path || "") ===
        APPROVED_PATCH_PATHS[i]
    )
  );
}

async function patchListing(
  accessToken,
  sku,
  patches,
  preview
) {
  const {
    sellerId,
    marketplaceId,
    endpoint
  } = cfg();

  const query =
    new URLSearchParams({
      marketplaceIds:
        marketplaceId,
      issueLocale:
        "ja_JP",
      includedData:
        "issues"
    });

  if (preview) {
    query.set(
      "mode",
      "VALIDATION_PREVIEW"
    );
  }

  return req(
    `${endpoint}/listings/2021-08-01/items/` +
      `${encodeURIComponent(sellerId)}/` +
      `${encodeURIComponent(sku)}?${query}`,
    accessToken,
    {
      method: "PATCH",
      body: {
        productType:
          PRODUCT_TYPE,
        patches
      }
    }
  );
}

function writeSummary(
  response,
  preview
) {
  const issues =
    Array.isArray(
      response?.body?.issues
    )
      ? response.body.issues
      : [];

  const errors =
    issues.filter(
      i =>
        String(
          i?.severity || ""
        ).toUpperCase() ===
        "ERROR"
    );

  const status =
    String(
      response?.body?.status || ""
    ).toUpperCase();

  const acceptedStatuses =
    preview
      ? [
          "VALID",
          "ACCEPTED"
        ]
      : [
          "ACCEPTED"
        ];

  return {
    httpStatus:
      response.http,
    responseOk:
      response.ok,
    status,
    submissionId:
      String(
        response?.body
          ?.submissionId || ""
      ),
    issueCount:
      issues.length,
    errorCount:
      errors.length,
    issueCodes: [
      ...new Set(
        issues
          .map(
            i =>
              String(
                i?.code || ""
              )
          )
          .filter(Boolean)
      )
    ],
    errors:
      errors
        .slice(0, 10)
        .map(
          i => ({
            code:
              String(
                i?.code || ""
              ),
            message:
              String(
                i?.message || ""
              ).slice(
                0,
                500
              )
          })
        ),
    valid:
      response.ok &&
      errors.length === 0 &&
      acceptedStatuses.includes(
        status
      )
  };
}

async function getLegacyAsin(
  accessToken
) {
  const plan = {
    sku:
      LEGACY_PARENT_SKU,
    asin: ""
  };

  const response =
    await getListing(
      accessToken,
      LEGACY_PARENT_SKU
    );

  if (!response.ok) {
    return "";
  }

  const listing =
    listingSnapshot(
      plan,
      response
    );

  return listing.asin || "";
}

async function freshPlan(
  accessToken
) {
  const schema =
    await getSchema(
      accessToken
    );

  const relationship =
    vals(
      nestedSpec(
        schema,
        "child_parent_sku_relationship",
        "child_relationship_type"
      )
    ).find(
      v =>
        /^variation$/i.test(v)
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
    ).includes(
      VARIATION_THEME
    )
  ) {
    throw new Error(
      "PTD variation theme missing"
    );
  }

  const exclusive =
    exclusiveFalse(
      schema
    );

  const parentPlan = {
    sku: PARENT_SKU,
    asin: PARENT_ASIN
  };

  const parentListing =
    listingSnapshot(
      parentPlan,
      await getListing(
        accessToken,
        PARENT_SKU
      )
    );

  if (
    !parentListing.exists ||
    parentListing.asin !==
      PARENT_ASIN ||
    parentListing.productType !==
      PRODUCT_TYPE ||
    parentListing.errorCount !== 0
  ) {
    throw new Error(
      "PARENT_FRESH_GUARD_FAILED"
    );
  }

  const parentCatalog =
    catalogSnapshot(
      PARENT_ASIN,
      await getCatalog(
        accessToken,
        PARENT_ASIN
      )
    );

  if (!parentCatalog.exists) {
    throw new Error(
      "PARENT_CATALOG_NOT_FOUND"
    );
  }

  const canonicalPlan = {
    sku:
      CANONICAL_SKU,
    asin:
      CANONICAL_ASIN
  };

  const canonicalListing =
    listingSnapshot(
      canonicalPlan,
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
    canonicalListing.productType ===
      PRODUCT_TYPE &&
    canonicalListing.errorCount ===
      0 &&
    canonicalListing.relation
      ?.parentageLevel ===
      "child" &&
    canonicalListing.relation
      ?.parentSku ===
      PARENT_SKU &&
    String(
      canonicalListing.relation
        ?.childRelationshipType ||
      ""
    ).toLowerCase() ===
      "variation" &&
    canonicalListing.relation
      ?.variationTheme ===
      VARIATION_THEME &&
    parentCatalog.relationshipAsins
      .includes(
        CANONICAL_ASIN
      ) &&
    canonicalCatalog.exists &&
    canonicalCatalog
      .relationshipAsins
      .includes(PARENT_ASIN);

  if (!canonicalLinked) {
    throw new Error(
      "CANONICAL_E7_NOT_STABLE"
    );
  }

  const legacyAsin =
    await getLegacyAsin(
      accessToken
    );

  const targets = [];
  let asymmetryCount = 0;
  let stillLegacyCount = 0;
  let listingGuardFailCount = 0;

  for (
    const plan of TARGETS
  ) {
    const listing =
      listingSnapshot(
        plan,
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
      listing.asin ===
        plan.asin &&
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
      parentCatalog
        .relationshipAsins
        .includes(plan.asin);

    const childPoints =
      catalog.exists &&
      catalog
        .relationshipAsins
        .includes(PARENT_ASIN);

    const asymmetric =
      parentContains !==
      childPoints;

    if (asymmetric) {
      asymmetryCount += 1;
    }

    const stillLegacy =
      Boolean(
        legacyAsin &&
        catalog.exists &&
        catalog
          .relationshipAsins
          .includes(legacyAsin)
      );

    if (stillLegacy) {
      stillLegacyCount += 1;
    }

    const catalogLinked =
      parentContains &&
      childPoints;

    const patches =
      catalogLinked
        ? []
        : relationPatches(
            listing.attrs,
            relationship,
            exclusive
          );

    if (
      !catalogLinked &&
      !patchPathsExact(
        patches
      )
    ) {
      throw new Error(
        `PATCH_SCOPE_INVALID ${plan.sku}`
      );
    }

    targets.push({
      plan,
      listing,
      protectedBefore:
        protectedSnapshot(
          listing
        ),
      catalog: {
        exists:
          catalog.exists,
        relationshipAsins:
          catalog
            .relationshipAsins,
        parentContains,
        childPoints,
        asymmetric,
        stillLegacy,
        catalogLinked
      },
      listingRelationOk,
      patches,
      preview: null
    });
  }

  if (
    asymmetryCount > 0
  ) {
    throw new Error(
      `CATALOG_ASYMMETRY ${asymmetryCount}`
    );
  }

  if (
    stillLegacyCount > 0
  ) {
    throw new Error(
      `STILL_LEGACY ${stillLegacyCount}`
    );
  }

  if (
    listingGuardFailCount > 0
  ) {
    throw new Error(
      `LISTING_GUARD_FAIL ${listingGuardFailCount}`
    );
  }

  const unresolved =
    targets.filter(
      x =>
        !x.catalog
          .catalogLinked
    );

  for (
    const target of unresolved
  ) {
    target.preview =
      writeSummary(
        await patchListing(
          accessToken,
          target.plan.sku,
          target.patches,
          true
        ),
        true
      );
  }

  const previewValidCount =
    unresolved.filter(
      x =>
        x.preview
          ?.valid === true
    ).length;

  const allPreviewValid =
    previewValidCount ===
      unresolved.length;

  if (!allPreviewValid) {
    throw new Error(
      "FRESH_RELATION_ONLY_VALIDATION_PREVIEW_FAILED"
    );
  }

  return {
    relationship,
    exclusive,
    parentCatalog,
    canonicalLinked,
    legacyAsin,
    targets,
    unresolved,
    summary: {
      approvedTargetCount:
        TARGETS.length,
      unresolvedCount:
        unresolved.length,
      alreadyLinkedCount:
        TARGETS.length -
        unresolved.length,
      previewValidCount,
      allPreviewValid,
      asymmetryCount,
      stillLegacyCount,
      listingGuardFailCount,
      prospectivePersistentWriteCount:
        unresolved.length,
      prospectiveSkus:
        unresolved.map(
          x => x.plan.sku
        )
    }
  };
}

async function catalogVerify(
  accessToken
) {
  const parentCatalog =
    catalogSnapshot(
      PARENT_ASIN,
      await getCatalog(
        accessToken,
        PARENT_ASIN
      )
    );

  const children = [];

  for (
    const plan of [
      {
        sku:
          CANONICAL_SKU,
        asin:
          CANONICAL_ASIN
      },
      ...TARGETS
    ]
  ) {
    const catalog =
      catalogSnapshot(
        plan.asin,
        await getCatalog(
          accessToken,
          plan.asin
        )
      );

    children.push({
      sku:
        plan.sku,
      asin:
        plan.asin,
      parentContains:
        parentCatalog
          .relationshipAsins
          .includes(
            plan.asin
          ),
      childPoints:
        catalog.exists &&
        catalog
          .relationshipAsins
          .includes(
            PARENT_ASIN
          ),
      relationshipAsins:
        catalog
          .relationshipAsins
    });
  }

  const linkedCount =
    children.filter(
      x =>
        x.parentContains &&
        x.childPoints
    ).length;

  return {
    parentRelationshipAsins:
      parentCatalog
        .relationshipAsins,
    children,
    linkedCount,
    complete:
      linkedCount === 6
  };
}

async function protectedVerify(
  accessToken,
  targets
) {
  const rows = [];

  for (
    const target of targets
  ) {
    const now =
      listingSnapshot(
        target.plan,
        await getListing(
          accessToken,
          target.plan.sku
        )
      );

    const relationNow =
      now.relation || {};

    const protectedNow =
      protectedSnapshot(now);

    rows.push({
      sku:
        target.plan.sku,
      relationOk:
        now.exists &&
        now.asin ===
          target.plan.asin &&
        relationNow
          .parentageLevel ===
          "child" &&
        relationNow
          .parentSku ===
          PARENT_SKU &&
        String(
          relationNow
            .childRelationshipType ||
          ""
        ).toLowerCase() ===
          "variation" &&
        relationNow
          .variationTheme ===
          VARIATION_THEME,
      protectedOk:
        sameJson(
          target.protectedBefore,
          protectedNow
        ),
      availableQuantity:
        now.availableQuantity,
      errorCount:
        now.errorCount,
      issueCodes:
        now.issueCodes
    });
  }

  return {
    rows,
    relationVerifiedCount:
      rows.filter(
        x => x.relationOk
      ).length,
    protectedVerifiedCount:
      rows.filter(
        x => x.protectedOk
      ).length,
    allProtected:
      rows.every(
        x => x.protectedOk
      )
  };
}

function compactDryRun(plan) {
  return {
    status:
      plan.unresolved.length === 0
        ? "ALREADY_COMPLETE_NO_WRITE"
        : plan.unresolved.length === 5
          ? "FIVE_RELATION_ONLY_PREVIEW_VALID"
          : "PARTIAL_RELATION_ONLY_PREVIEW_VALID",
    parentAsin:
      PARENT_ASIN,
    canonicalLinked:
      plan.canonicalLinked,
    summary:
      plan.summary,
    targets:
      plan.targets.map(
        x => ({
          label:
            x.plan.label,
          sku:
            x.plan.sku,
          asin:
            x.plan.asin,
          listingRelationOk:
            x.listingRelationOk,
          catalogLinked:
            x.catalog.catalogLinked,
          patchPaths:
            x.patches.map(
              p => p.path
            ),
          preview:
            x.preview
        })
      ),
    prospectivePersistentWrites: {
      count:
        plan.unresolved.length,
      skus:
        plan.unresolved.map(
          x => x.plan.sku
        )
    }
  };
}

async function handler(
  req0,
  res
) {
  let amazonPersistentWrites = 0;

  try {
    const sec = secret();

    if (!sec) {
      return res.status(500).json({
        ok: false,
        moduleVersion:
          MODULE_VERSION,
        route: ROUTE,
        amazonPersistentWrites: 0,
        externalChanges: 0,
        error:
          "secret missing"
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
        amazonPersistentWrites: 0,
        externalChanges: 0,
        error:
          "Unauthorized"
      });
    }

    const dryRun =
      req0.body?.dryRun !==
      false;

    const accessToken =
      await token();

    const plan =
      await freshPlan(
        accessToken
      );

    if (dryRun) {
      const preview =
        compactDryRun(plan);

      return res
        .status(200)
        .json({
          ok: true,
          moduleVersion:
            MODULE_VERSION,
          route: ROUTE,
          approvedScope:
            APPROVED_SCOPE,
          readOnly: true,
          dryRun: true,
          ...preview,
          approvedPatchPaths:
            APPROVED_PATCH_PATHS,
          amazonPersistentWrites: 0,
          inventoryWrites: 0,
          priceWrites: 0,
          b2bWrites: 0,
          adsWrites: 0,
          yahooWrites: 0,
          externalChanges: 0,
          liveAllowed: false,
          liveBlockedReason:
            plan.unresolved.length ===
            0
              ? "ALREADY_COMPLETE"
              : "EXACT_CONFIRMATION_REQUIRED",
          doNotRerunOriginalLive:
            true
        });
    }

    if (
      String(
        req0.body
          ?.approvedScope || ""
      ) !== APPROVED_SCOPE
    ) {
      throw new Error(
        "APPROVED_SCOPE_MISMATCH"
      );
    }

    if (
      String(
        req0.body
          ?.confirmLive || ""
      ) !== CONFIRM_LIVE
    ) {
      throw new Error(
        "CONFIRM_LIVE_MISMATCH"
      );
    }

    if (
      plan.unresolved.length === 0
    ) {
      return res
        .status(200)
        .json({
          ok: true,
          moduleVersion:
            MODULE_VERSION,
          route: ROUTE,
          approvedScope:
            APPROVED_SCOPE,
          status:
            "ALREADY_COMPLETE_NO_WRITE",
          readOnly: false,
          dryRun: false,
          parentAsin:
            PARENT_ASIN,
          amazonPersistentWrites: 0,
          inventoryWrites: 0,
          priceWrites: 0,
          b2bWrites: 0,
          adsWrites: 0,
          yahooWrites: 0,
          externalChanges: 0,
          postVerified: true,
          doNotRerunOriginalLive:
            true
        });
    }

    const writes = [];

    for (
      const target of
      plan.unresolved
    ) {
      if (
        !patchPathsExact(
          target.patches
        )
      ) {
        throw new Error(
          `LIVE_PATCH_SCOPE_INVALID ${target.plan.sku}`
        );
      }

      const response =
        await patchListing(
          accessToken,
          target.plan.sku,
          target.patches,
          false
        );

      amazonPersistentWrites += 1;

      const result =
        writeSummary(
          response,
          false
        );

      writes.push({
        sku:
          target.plan.sku,
        asin:
          target.plan.asin,
        patchPaths:
          target.patches.map(
            p => p.path
          ),
        ...result
      });

      if (!result.valid) {
        return res
          .status(200)
          .json({
            ok: false,
            moduleVersion:
              MODULE_VERSION,
            route: ROUTE,
            approvedScope:
              APPROVED_SCOPE,
            status:
              "PARTIAL_WRITE_REVIEW_REQUIRED",
            readOnly: false,
            dryRun: false,
            preflight:
              compactDryRun(
                plan
              ),
            writes,
            amazonPersistentWrites,
            inventoryWrites: 0,
            priceWrites: 0,
            b2bWrites: 0,
            adsWrites: 0,
            yahooWrites: 0,
            externalChanges:
              amazonPersistentWrites,
            postVerified: false,
            doNotRerunOriginalLive:
              true,
            retryAllowed:
              false
          });
      }
    }

    const protectedCheck =
      await protectedVerify(
        accessToken,
        plan.unresolved
      );

    const verificationAttempts = [];
    let finalCatalog = null;

    for (
      let attempt = 1;
      attempt <=
        VERIFY_ATTEMPTS;
      attempt++
    ) {
      const current =
        await catalogVerify(
          accessToken
        );

      verificationAttempts.push({
        attempt,
        linkedCount:
          current.linkedCount,
        complete:
          current.complete,
        parentRelationshipAsins:
          current
            .parentRelationshipAsins
      });

      finalCatalog =
        current;

      if (
        current.complete
      ) {
        break;
      }

      if (
        attempt <
        VERIFY_ATTEMPTS
      ) {
        await sleep(
          VERIFY_GAP_MS
        );
      }
    }

    const postVerified =
      Boolean(
        finalCatalog
          ?.complete &&
        protectedCheck
          .allProtected
      );

    const status =
      postVerified
        ? "LIVE_COMPLETE_CATALOG_6_OF_6"
        : "LIVE_ACCEPTED_PENDING_CATALOG";

    return res
      .status(200)
      .json({
        ok: true,
        moduleVersion:
          MODULE_VERSION,
        route: ROUTE,
        approvedScope:
          APPROVED_SCOPE,
        status,
        readOnly: false,
        dryRun: false,
        parentAsin:
          PARENT_ASIN,
        preflight:
          compactDryRun(
            plan
          ),
        writes,
        protectedCheck,
        verificationAttempts,
        finalCatalog,
        amazonPersistentWrites,
        inventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        externalChanges:
          amazonPersistentWrites,
        postVerified,
        retryAllowed:
          false,
        doNotRerunOriginalLive:
          true
      });
  } catch (err) {
    return res
      .status(400)
      .json({
        ok: false,
        moduleVersion:
          MODULE_VERSION,
        route: ROUTE,
        status: "BLOCK",
        amazonPersistentWrites,
        inventoryWrites: 0,
        priceWrites: 0,
        b2bWrites: 0,
        adsWrites: 0,
        yahooWrites: 0,
        externalChanges:
          amazonPersistentWrites,
        liveAllowed: false,
        retryAllowed: false,
        doNotRerunOriginalLive:
          true,
        error:
          err?.message ||
          String(err)
      });
  }
}

express.application.listen =
  function g83CatalogFiveRelationRepairLiveListen(
    ...args
  ) {
    const exists =
      Boolean(
        this?._router?.stack?.some(
          layer =>
            layer?.route?.path ===
            ROUTE
        )
      );

    if (!exists) {
      this.post(
        ROUTE,
        handler
      );
    }

    return originalListen.apply(
      this,
      args
    );
  };
