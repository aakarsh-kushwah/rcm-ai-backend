const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');

async function queryDB() {
  await connectDB();
  const ids = [30001, 30002, 30003, 60004, 120002, 120004];
  
  console.log('=== DATABASE STATUS & SHORTS COUNTS FOR 6 CHANNELS ===\n');

  for (const id of ids) {
    const channel = await Channel.findOne({ where: { id } });
    if (!channel) continue;

    const shortsCount = await ChannelVideo.count({ where: { channelId: id, isShort: true } });
    const totalVideos = await ChannelVideo.count({ where: { channelId: id } });

    console.log(`[${channel.id}] ${channel.name}:`);
    console.log(`  - lastSyncStatus: ${channel.lastSyncStatus}`);
    console.log(`  - lastSyncError: ${channel.lastSyncError}`);
    console.log(`  - lastSyncedAt: ${channel.lastSyncedAt ? channel.lastSyncedAt.toISOString() : 'NULL'}`);
    console.log(`  - Total Videos: ${totalVideos}`);
    console.log(`  - Shorts Count (isShort=true): ${shortsCount}\n`);
  }

  process.exit(0);
}

queryDB();
