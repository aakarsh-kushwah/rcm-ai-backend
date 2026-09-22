const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');
const { syncChannel } = require('../services/channelSyncService');
const logger = require('../utils/logger');

async function runFullBackfill() {
  try {
    await connectDB();
    console.log('✅ [DB Connected] Starting full shorts backfill for all active channels...');

    const activeChannels = await Channel.findAll({ where: { isActive: true } });
    console.log(`Found ${activeChannels.length} active channels to process.\n`);

    for (const channel of activeChannels) {
      console.log(`--------------------------------------------------`);
      console.log(`🔄 Processing Channel: "${channel.name}" (ID: ${channel.id})`);
      
      // Reset lastSyncedAt to null to force full playlist traversal
      channel.lastSyncedAt = null;
      await channel.save();

      try {
        const newAdded = await syncChannel(channel);
        const total = await ChannelVideo.count({ where: { channelId: channel.id } });
        const shorts = await ChannelVideo.count({ where: { channelId: channel.id, isShort: true } });
        console.log(`✅ Completed "${channel.name}": Total Videos = ${total}, Shorts = ${shorts}, New Added = ${newAdded}`);
      } catch (chErr) {
        console.error(`❌ Error syncing channel "${channel.name}": ${chErr.message}`);
      }
    }

    console.log(`\n==================================================`);
    console.log(`📊 FINAL SUMMARY TABLE (ALL ACTIVE CHANNELS)`);
    console.log(`==================================================`);
    console.log(
      'ID'.padEnd(8) + 
      'Channel Name'.padEnd(35) + 
      'Total Videos'.padEnd(15) + 
      'Shorts Count'
    );
    console.log('--------------------------------------------------');

    for (const channel of activeChannels) {
      const total = await ChannelVideo.count({ where: { channelId: channel.id } });
      const shorts = await ChannelVideo.count({ where: { channelId: channel.id, isShort: true } });
      console.log(
        String(channel.id).padEnd(8) + 
        String(channel.name).substring(0, 33).padEnd(35) + 
        String(total).padEnd(15) + 
        String(shorts)
      );
    }
    console.log(`==================================================`);

    process.exit(0);
  } catch (err) {
    console.error('Fatal error in runFullBackfill:', err);
    process.exit(1);
  }
}

runFullBackfill();
