'use strict';

const { Op } = require('sequelize');
const { DownlineNode } = require('../models');

function normalizeQuery(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

async function verifyAncestor(targetBuyerId, rootBuyerId, { maxDepth = 60, model = DownlineNode } = {}) {
  if (!targetBuyerId || !rootBuyerId) return { isDescendant: false };

  const targetId = Number(targetBuyerId);
  const rootId = Number(rootBuyerId);
  if (!Number.isFinite(targetId) || !Number.isFinite(rootId)) return { isDescendant: false };
  if (targetId === rootId) return { isDescendant: true, depth: 0 };

  let currentBuyerId = targetId;
  let depth = 0;

  while (depth <= maxDepth && currentBuyerId) {
    const node = await model.findByPk(currentBuyerId, {
      attributes: ['buyer_id', 'upline_id', 'lineage'],
      raw: true,
    });

    if (!node) return { isDescendant: false };

    if (Number(node.upline_id) === rootId || Number(node.buyer_id) === rootId) {
      return { isDescendant: true, depth: depth + 1 };
    }

    if (node.lineage && new RegExp(`/${rootId}/`).test(node.lineage)) {
      return { isDescendant: true, depth: depth + 1 };
    }

    currentBuyerId = node.upline_id ? Number(node.upline_id) : null;
    depth += 1;
  }

  return { isDescendant: false };
}

async function searchLifelineMembers({ rootBuyerId, searchQuery, limit = 20, model = DownlineNode } = {}) {
  const rootId = Number(rootBuyerId);
  if (!Number.isFinite(rootId) || rootId <= 0) return null;

  const normalizedQuery = normalizeQuery(searchQuery);
  if (!normalizedQuery) return null;

  const numericQuery = Number(normalizedQuery);
  if (Number.isInteger(numericQuery) && String(numericQuery) === normalizedQuery) {
    const node = await model.findByPk(numericQuery, { raw: true });
    if (!node) return null;

    const ancestorCheck = await verifyAncestor(node.buyer_id, rootId, { model });
    if (!ancestorCheck.isDescendant) return null;

    return node;
  }

  const likeQuery = `${normalizedQuery}%`;
  const rows = await model.findAll({
    where: {
      name: { [Op.like]: likeQuery },
      lineage: { [Op.like]: `%/${rootId}/%` },
    },
    limit: Math.max(1, Math.min(50, Number(limit) || 20)),
    order: [['name', 'ASC']],
    raw: true,
  });

  return rows.slice(0, Math.max(1, Number(limit) || 20));
}

module.exports = {
  verifyAncestor,
  searchLifelineMembers,
};
