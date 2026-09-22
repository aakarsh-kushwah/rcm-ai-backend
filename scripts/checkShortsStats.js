const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');

async function checkStats() {
  try {
    await connectDB();
    const channel = await Channel.findOne({ where: { id: 60001 } });
    if (!channel) {
      console.log('Channel 60001 not found');
      process.exit(0);
    }

    const totalVideos = await ChannelVideo.count({ where: { channelId: channel.id } });
    const shortsCount = await ChannelVideo.count({ where: { channelId: channel.id, isShort: true } });

    console.log(`Channel: ${channel.name} (ID: ${channel.id})`);
    console.log(`Total Videos: ${totalVideos}`);
    console.log(`Shorts Count (isShort=true): ${shortsCount}`);

    const sampleShorts = await ChannelVideo.findAll({
      where: { channelId: channel.id, isShort: true },
      limit: 5,
      attributes: ['title', 'youtubeVideoId', 'publishedAt']
    });

    console.log('Sample 5 Shorts:');
    sampleShorts.forEach((v, i) => {
      console.log(`${i+1}. [${v.youtubeVideoId}] ${v.title}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkStats();
