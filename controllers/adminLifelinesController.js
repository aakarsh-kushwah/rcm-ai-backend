'use strict';

const { sequelize } = require('../config/db');
const { SyncIncidentLog, RcmIdentity, DownlineNode } = require('../models');

exports.getIncidentLogs = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const offset = (page - 1) * perPage;

    const { count, rows } = await SyncIncidentLog.findAndCountAll({
      order: [['created_at', 'DESC']],
      limit: perPage,
      offset,
      raw: true,
    });

    return res.status(200).json({ success: true, count, page, perPage, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load incident logs.' });
  }
};

exports.getSystemHealth = async (req, res) => {
  try {
    const [identityCount] = await sequelize.query('SELECT COUNT(*) AS count FROM rcm_identities');
    const [nodeCount] = await sequelize.query('SELECT COUNT(*) AS count FROM rcm_downline_nodes');
    const [dbStatus] = await sequelize.query('SELECT 1 AS ok');

    return res.status(200).json({
      success: true,
      data: {
        dbStatus: dbStatus?.[0]?.ok ? 'online' : 'offline',
        indexedNodes: Number(nodeCount?.[0]?.count || 0),
        identities: Number(identityCount?.[0]?.count || 0),
        cacheHitRate: 'N/A',
        syncStatus: 'ready',
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Unable to load system health.' });
  }
};
