const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
process.env.DISABLE_CRONS = 'true'; // Disable all crons in this process
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}

const fs = require('fs');
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');
const { syncChannel } = require('../services/channelSyncService');

async function runTargetedBackfill() {
  try {
    await connectDB();
    console.log('✅ [DB Connected] Starting targeted shorts backfill for the 6 channels...');

    const targetIds = [30001, 30002, 30003, 60004, 120002, 120004];
    const channels = await Channel.findAll({ where: { id: targetIds } });

    console.log(`Found ${channels.length} channels to process.\n`);

    const errorLogs = [];

    for (const channel of channels) {
      console.log(`--------------------------------------------------`);
      console.log(`🔄 Processing Channel: "${channel.name}" (ID: ${channel.id})`);
      
      // Reset lastSyncedAt to null to force full traversal
      channel.lastSyncedAt = null;
      await channel.save();

      try {
        const startTime = Date.now();
        const newAdded = await syncChannel(channel);
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
        const total = await ChannelVideo.count({ where: { channelId: channel.id } });
        const shorts = await ChannelVideo.count({ where: { channelId: channel.id, isShort: true } });
        console.log(`✅ Completed "${channel.name}": Total Videos = ${total}, Shorts = ${shorts}, New Added = ${newAdded}, Time Taken = ${durationSec}s`);
      } catch (chErr) {
        console.error(`❌ Error syncing channel "${channel.name}" (ID: ${channel.id}): ${chErr.message}`);
        let errorDetails = {
          channelId: channel.id,
          channelName: channel.name,
          message: chErr.message,
          status: chErr.response?.status,
          data: chErr.response?.data || null
        };
        errorLogs.push(errorDetails);
        console.error('Error Response Data:', JSON.stringify(chErr.response?.data, null, 2));
      }
    }

    if (errorLogs.length > 0) {
      fs.writeFileSync('backfill_error_log.json', JSON.stringify(errorLogs, null, 2));
      console.log('\n⚠️ Errors encountered. Logged to backfill_error_log.json');
    } else {
      console.log('\n🎉 All 6 channels synced successfully without any errors!');
    }

    console.log(`\n==================================================`);
    console.log(`📊 FINAL SUMMARY TABLE (6 TARGET CHANNELS)`);
    console.log(`==================================================`);
    console.log(
      'ID'.padEnd(8) + 
      'Channel Name'.padEnd(35) + 
      'Total Videos'.padEnd(15) + 
      'Shorts Count'
    );
    console.log('--------------------------------------------------');

    for (const channel of channels) {
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
    console.error('Fatal error in runTargetedBackfill:', err);
    process.exit(1);
  }
}

runTargetedBackfill();
