const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');

async function checkProgress() {
  await connectDB();
  const channels = await Channel.findAll({
    where: { isActive: true },
    attributes: ['id', 'name', 'lastSyncedAt', 'lastSyncStatus']
  });

  console.log('Channel Sync Status & lastSyncedAt:');
  for (const c of channels) {
    const total = await ChannelVideo.count({ where: { channelId: c.id } });
    const shorts = await ChannelVideo.count({ where: { channelId: c.id, isShort: true } });
    console.log(`[${c.id}] ${c.name.padEnd(30)} | status: ${c.lastSyncStatus} | lastSyncedAt: ${c.lastSyncedAt ? c.lastSyncedAt.toISOString() : 'NULL'} | Total: ${total} | Shorts: ${shorts}`);
  }
  process.exit(0);
}

checkProgress();
