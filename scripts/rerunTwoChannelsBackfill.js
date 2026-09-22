const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
process.env.DISABLE_CRONS = 'true';
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}

const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');
const { syncChannel } = require('../services/channelSyncService');

async function run() {
  await connectDB();
  const ids = [120002, 120004];

  console.log('=== CHECKING lastSyncedAt FOR CHANNELS 120002 & 120004 ===\n');
  const channels = await Channel.findAll({ where: { id: ids } });

  for (const ch of channels) {
    console.log(`Channel [${ch.id}] ${ch.name}: lastSyncedAt = ${ch.lastSyncedAt}`);
    ch.lastSyncedAt = null;
    await ch.save();
    console.log(`➡️ Reset lastSyncedAt to NULL for [${ch.id}] ${ch.name}\n`);
  }

  console.log('=== STARTING RE-RUN BACKFILL FOR 120002 & 120004 ===\n');

  for (const ch of channels) {
    console.log(`--------------------------------------------------`);
    console.log(`🔄 Re-syncing Channel: "${ch.name}" (ID: ${ch.id})`);
    const startTime = Date.now();
    try {
      const newAdded = await syncChannel(ch);
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
      const totalVideos = await ChannelVideo.count({ where: { channelId: ch.id } });
      const shortsCount = await ChannelVideo.count({ where: { channelId: ch.id, isShort: true } });
      console.log(`✅ Completed "${ch.name}": Total Videos = ${totalVideos}, Shorts Count = ${shortsCount}, New Added = ${newAdded}, Time Taken = ${durationSec}s`);
    } catch (err) {
      console.error(`❌ Error syncing "${ch.name}": ${err.message}`);
      if (err.response) {
        console.error('Response Status:', err.response.status);
        console.error('Response Data:', JSON.stringify(err.response.data, null, 2));
      }
    }
  }

  console.log('\n==================================================');
  console.log('📊 FINAL RESULTS FOR 120002 & 120004');
  console.log('==================================================');
  const finalChannels = await Channel.findAll({ where: { id: ids } });
  for (const ch of finalChannels) {
    const total = await ChannelVideo.count({ where: { channelId: ch.id } });
    const shorts = await ChannelVideo.count({ where: { channelId: ch.id, isShort: true } });
    console.log(`[${ch.id}] ${ch.name} -> Total Videos: ${total}, Shorts Count: ${shorts}, lastSyncedAt: ${ch.lastSyncedAt}`);
  }
  console.log('==================================================');

  process.exit(0);
}

run();
