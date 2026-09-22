const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}
const axios = require('axios');
const { parse } = require('iso8601-duration');
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');

async function verify() {
  await connectDB();
  const apiKey = process.env.YOUTUBE_API_KEY;

  // 1. Check durations for our 5 sample shorts
  const sampleVideoIds = ['GtEP_oxWZHA', '54ATJeZwHe4', 'WvlGd7Pu4Ac', '5_5-41SJFxs', 'kv1dUEiS6Fs'];
  console.log('--- 1. Sample Shorts Durations via YouTube API ---');
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${sampleVideoIds.join(',')}&key=${apiKey}`);
  for (const item of (res.data.items || [])) {
    const durStr = item.contentDetails?.duration;
    const durObj = parse(durStr);
    const totalSecs = (durObj.hours || 0) * 3600 + (durObj.minutes || 0) * 60 + (durObj.seconds || 0);
    console.log(`Video ID: ${item.id} | Title: "${item.snippet.title}" | Duration Str: ${durStr} | Total Seconds: ${totalSecs}`);
  }

  // 2. Check total video counts across all active channels for quota estimation
  console.log('\n--- 3. Quota Analysis Across All Channels ---');
  const activeChannels = await Channel.findAll({ where: { isActive: true } });
  let totalVideosAllChannels = 0;
  for (const ch of activeChannels) {
    const count = await ChannelVideo.count({ where: { channelId: ch.id } });
    totalVideosAllChannels += count;
    console.log(`Channel: "${ch.name}" (ID: ${ch.id}) -> Videos in DB: ${count}`);
  }
  console.log(`\nTotal Videos Across All Active Channels: ${totalVideosAllChannels}`);
  console.log(`Estimated API Calls (batches of 50): ~${Math.ceil(totalVideosAllChannels / 50)}`);
  console.log(`Estimated Quota Cost for full re-scan: ~${Math.ceil(totalVideosAllChannels / 50) + activeChannels.length * 2} units (playlistItems + videos.list).`);
  console.log(`YouTube Default Daily Quota Limit: 10,000 units.`);

  process.exit(0);
}

verify();
