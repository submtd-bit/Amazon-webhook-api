const IMAGE_REPAIR_PREVIEW_VERSION = 'AMAZON_IMAGE_SUPPRESSION_REPAIR_PREVIEW_V1.0.0';

function registerAmazonImageRepairPreviewRoutes(app, deps) {
  const { spApiRequest, sellerId, marketplaceId, apiSecret } = deps || {};
  if (!app || !spApiRequest || !sellerId || !marketplaceId || !apiSecret) {
    throw new Error('Image repair preview route requires app, spApiRequest, sellerId, marketplaceId and apiSecret.');
  }

  const requireSecret = (req, res, next) => {
    if (req.get('X-API-SECRET') !== apiSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };

  app.post('/ads/listings/image-suppression-repair-preview', requireSecret, async (req, res) => {
    try {
      const skus = uniqueStrings(Array.isArray(req.body?.skus) ? req.body.skus : []);
      if (!skus.length) {
        return res.status(400).json({
          version: IMAGE_REPAIR_PREVIEW_VERSION,
          readOnly: true,
          externalChanges: 0,
          error: 'skus is required'
        });
      }
      if (skus.length > 20) {
        return res.status(400).json({
          version: IMAGE_REPAIR_PREVIEW_VERSION,
          readOnly: true,
          externalChanges: 0,
          error: 'max 20 skus per request'
        });
      }

      const results = [];

      for (const sku of skus) {
        try {
          const current = await spApiRequest({
            method: 'GET',
            path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`,
            query: {
              marketplaceIds: marketplaceId,
              issueLocale: 'ja_JP',
              includedData: 'summaries,attributes,issues'
            }
          });

          const summaries = Array.isArray(current?.summaries) ? current.summaries : [];
          const summary = summaries.find(x => !x?.marketplaceId || x.marketplaceId === marketplaceId) || summaries[0] || {};
          const attributes = current?.attributes && typeof current.attributes === 'object' ? current.attributes : {};
          const issues = Array.isArray(current?.issues) ? current.issues : [];
          const imageViolationIssues = issues.filter(issue => String(issue?.code || '').trim() === '100238');

          if (!imageViolationIssues.length) {
            results.push({
              sku,
              asin: String(summary.asin || '').trim(),
              productType: String(summary.productType || '').trim(),
              status: 'SKIP_NO_IMAGE_100238',
              plannedDeletes: [],
              preview: null,
              apiError: ''
            });
            continue;
          }

          const productType = String(summary.productType || '').trim();
          if (!productType) {
            results.push({
              sku,
              asin: String(summary.asin || '').trim(),
              productType: '',
              status: 'BLOCK_PRODUCT_TYPE_MISSING',
              plannedDeletes: [],
              preview: null,
              apiError: ''
            });
            continue;
          }

          const plannedDeletes = [];
          const seenAttributes = new Set();
          const blockers = [];

          for (const issue of imageViolationIssues) {
            const message = String(issue?.message || '');
            const match = message.match(/PT\s*0*(\d+)/i);
            if (!match) {
              blockers.push({
                code: String(issue?.code || ''),
                message,
                reason: 'PT_NUMBER_NOT_FOUND'
              });
              continue;
            }

            const pt = Number(match[1]);
            const attributeName = imageAttributeFromPt(pt);
            if (!attributeName) {
              blockers.push({
                code: String(issue?.code || ''),
                message,
                reason: `UNSUPPORTED_PT_${pt}`
              });
              continue;
            }

            if (seenAttributes.has(attributeName)) continue;
            seenAttributes.add(attributeName);

            const currentValue = attributes[attributeName];
            if (!Array.isArray(currentValue) || !currentValue.length) {
              blockers.push({
                code: String(issue?.code || ''),
                message,
                attributeName,
                reason: 'CURRENT_ATTRIBUTE_VALUE_MISSING'
              });
              continue;
            }

            plannedDeletes.push({
              pt,
              attributeName,
              path: `/attributes/${attributeName}`,
              value: currentValue
            });
          }

          if (blockers.length || !plannedDeletes.length) {
            results.push({
              sku,
              asin: String(summary.asin || '').trim(),
              productType,
              status: 'BLOCK_PREVIEW_NOT_SAFE',
              plannedDeletes,
              blockers,
              preview: null,
              apiError: ''
            });
            continue;
          }

          const body = {
            productType,
            patches: plannedDeletes.map(x => ({
              op: 'delete',
              path: x.path,
              value: x.value
            }))
          };

          const preview = await spApiRequest({
            method: 'PATCH',
            path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}` +
              `?marketplaceIds=${encodeURIComponent(marketplaceId)}` +
              `&issueLocale=${encodeURIComponent('ja_JP')}` +
              `&mode=${encodeURIComponent('VALIDATION_PREVIEW')}`,
            body
          });

          const previewIssues = Array.isArray(preview?.issues) ? preview.issues : [];
          const previewStatus = String(preview?.status || '').trim().toUpperCase();

          results.push({
            sku,
            asin: String(summary.asin || '').trim(),
            productType,
            status: previewStatus === 'INVALID' || previewIssues.some(x => String(x?.severity || '').toUpperCase() === 'ERROR')
              ? 'PREVIEW_INVALID'
              : 'PREVIEW_RETURNED',
            plannedDeletes,
            blockers: [],
            preview: {
              status: preview?.status || '',
              submissionId: preview?.submissionId || '',
              issues: previewIssues
            },
            apiError: ''
          });
        } catch (error) {
          results.push({
            sku,
            asin: '',
            productType: '',
            status: 'API_ERROR',
            plannedDeletes: [],
            blockers: [],
            preview: null,
            apiError: error.message || String(error)
          });
        }

        if (skus.length > 1) await waitMs(1100);
      }

      res.json({
        version: IMAGE_REPAIR_PREVIEW_VERSION,
        readOnly: true,
        validationPreview: true,
        externalChanges: 0,
        marketplaceId,
        requestedSkuCount: skus.length,
        apiErrorCount: results.filter(x => x.apiError).length,
        previewInvalidCount: results.filter(x => x.status === 'PREVIEW_INVALID').length,
        previewReturnedCount: results.filter(x => x.status === 'PREVIEW_RETURNED').length,
        results
      });
    } catch (error) {
      res.status(500).json({
        version: IMAGE_REPAIR_PREVIEW_VERSION,
        readOnly: true,
        validationPreview: true,
        externalChanges: 0,
        error: error.message || String(error)
      });
    }
  });
}

function imageAttributeFromPt(pt) {
  if (!Number.isInteger(pt) || pt < 1) return '';
  if (pt === 1) return 'main_product_image_locator';
  return `other_product_image_locator_${pt - 1}`;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(x => String(x || '').trim()).filter(Boolean))];
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { registerAmazonImageRepairPreviewRoutes };
