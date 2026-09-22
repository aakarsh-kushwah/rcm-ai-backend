const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}

const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');
const { syncChannel } = require('../services/channelSyncService');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

async function testSync() {
  try {
    await connectDB();
    console.log('Database connected successfully.');

    let channel = await Channel.findOne({
      where: {
        [Op.or]: [
          { id: 60001 },
          { name: { [Op.like]: '%Nutricharge%' } }
        ]
      }
    });

    if (!channel) {
      console.log('Channel not found.');
      process.exit(0);
    }

    console.log(`Found channel: ID=${channel.id}, Name="${channel.name}", YT ID=${channel.youtubeChannelId}`);

    channel.lastSyncedAt = null;
    await channel.save();
    console.log('Reset lastSyncedAt to null.');

    console.log('Starting syncChannel...');
    const newCount = await syncChannel(channel);
    console.log(`Sync completed. New videos added: ${newCount}`);

    const totalVideos = await ChannelVideo.count({ where: { channelId: channel.id } });
    const shortsCount = await ChannelVideo.count({ where: { channelId: channel.id, isShort: true } });

    console.log(`📊 Statistics for Channel "${channel.name}" (ID: ${channel.id}):`);
    console.log(`- Total Videos in DB: ${totalVideos}`);
    console.log(`- Shorts (isShort = true): ${shortsCount}`);

    process.exit(0);
  } catch (err) {
    console.error('Error in testSync script:', err);
    process.exit(1);
  }
}

testSync();
