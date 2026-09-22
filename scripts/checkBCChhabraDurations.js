const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}
const axios = require('axios');
const { connectDB } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');
const { parse } = require('iso8601-duration');

async function checkBC() {
  await connectDB();
  const apiKey = process.env.YOUTUBE_API_KEY;
  const channel = await Channel.findOne({ where: { id: 30002 } });
  
  console.log(`Checking B.C. CHHABRA (30002). Last synced at: ${channel.lastSyncedAt}, status: ${channel.lastSyncStatus}, error: ${channel.lastSyncError}`);

  const videos = await ChannelVideo.findAll({
    where: { channelId: 30002 },
    limit: 10,
    attributes: ['youtubeVideoId', 'title', 'isShort']
  });

  const videoIds = videos.map(v => v.youtubeVideoId);
  const res = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoIds.join(',')}&key=${apiKey}`);
  
  console.log('\nSample YouTube API duration check for B.C. CHHABRA videos:');
  for (const item of (res.data.items || [])) {
    let durationSeconds = 0;
    if (item.contentDetails?.duration) {
      try {
        const d = parse(item.contentDetails.duration);
        durationSeconds = (d.hours || 0) * 3600 + (d.minutes || 0) * 60 + (d.seconds || 0);
      } catch (e) {}
    }
    const title = item.snippet?.title;
    const hasShortsTag = title.toLowerCase().includes('#shorts') || title.toLowerCase().includes('#short');
    console.log(`- [${item.id}] Duration: ${durationSeconds}s | #shorts tag: ${hasShortsTag} | Title: ${title}`);
  }

  process.exit(0);
}

checkBC();
