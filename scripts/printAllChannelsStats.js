const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');

async function printStats() {
  await connectDB();
  const activeChannels = await Channel.findAll({ where: { isActive: true } });

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
}

printStats();
