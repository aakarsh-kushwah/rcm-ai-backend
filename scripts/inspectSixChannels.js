const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');

async function inspectChannels() {
  await connectDB();
  const channelIds = [30001, 30002, 30003, 60004, 120002, 120004];
  
  console.log('=== INSPECTION OF 6 CHANNELS ===\n');

  for (const id of channelIds) {
    const channel = await Channel.findOne({ where: { id } });
    if (!channel) {
      console.log(`Channel ID ${id} not found.`);
      continue;
    }
    const total = await ChannelVideo.count({ where: { channelId: id } });
    const shorts = await ChannelVideo.count({ where: { channelId: id, isShort: true } });
    console.log(`Channel [${channel.id}] ${channel.name}:`);
    console.log(`  - Status: ${channel.lastSyncStatus}`);
    console.log(`  - LastSyncedAt: ${channel.lastSyncedAt ? channel.lastSyncedAt.toISOString() : 'NULL'}`);
    console.log(`  - LastSyncError: ${channel.lastSyncError || 'None'}`);
    console.log(`  - Total Videos in DB: ${total}`);
    console.log(`  - Shorts Count (isShort=true): ${shorts}\n`);
  }

  // Deep dive into B.C. CHHABRA (30002)
  console.log('=== DEEP DIVE: B.C. CHHABRA (ID: 30002) ===');
  const bcChannel = await Channel.findOne({ where: { id: 30002 } });
  if (bcChannel) {
    const bcVideos = await ChannelVideo.findAll({
      where: { channelId: 30002 },
      attributes: ['id', 'youtubeVideoId', 'title', 'publishedAt', 'isShort']
    });

    console.log(`Total videos fetched for B.C. CHHABRA: ${bcVideos.length}`);
    let shortsCount = bcVideos.filter(v => v.isShort).length;
    console.log(`Videos with isShort = true: ${shortsCount}`);
    
    console.log('Sample 10 videos from B.C. CHHABRA:');
    bcVideos.slice(0, 10).forEach((v, i) => {
      console.log(`${i+1}. [${v.youtubeVideoId}] isShort: ${v.isShort} | Title: ${v.title}`);
    });
  }

  process.exit(0);
}

inspectChannels();
