const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}
const axios = require('axios');
const { parse } = require('iso8601-duration');
const { connectDB } = require('../config/db');
const { ChannelVideo, Channel } = require('../models');

async function analyze() {
  await connectDB();
  const apiKey = process.env.YOUTUBE_API_KEY;

  const targetChannels = [
    { id: 120002, name: 'RCM JOSH' },
    { id: 120004, name: 'Jay Rcm' },
    { id: 30003, name: 'Saroj Kumar' }
  ];

  for (const chInfo of targetChannels) {
    console.log(`\n==================================================`);
    console.log(`Analyzing Channel: [${chInfo.id}] ${chInfo.name}`);
    console.log(`==================================================`);

    const videos = await ChannelVideo.findAll({
      where: { channelId: chInfo.id },
      attributes: ['youtubeVideoId', 'title', 'isShort']
    });

    const totalInDB = videos.length;
    console.log(`Total videos in DB: ${totalInDB}`);

    const ids = videos.map(v => v.youtubeVideoId).filter(Boolean);
    let totalChecked = 0;
    let under60Count = 0;
    const sampleBetween60And200 = [];

    // Check in chunks of 50
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      try {
        const res = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${chunk.join(',')}&key=${apiKey}`);
        for (const item of (res.data.items || [])) {
          const durStr = item.contentDetails?.duration;
          if (!durStr) continue;
          totalChecked++;
          const durObj = parse(durStr);
          const totalSecs = (durObj.hours || 0) * 3600 + (durObj.minutes || 0) * 60 + (durObj.seconds || 0);

          if (totalSecs < 60) {
            under60Count++;
          }

          if (chInfo.id === 120002 && totalSecs > 60 && totalSecs < 200 && sampleBetween60And200.length < 5) {
            sampleBetween60And200.push({
              id: item.id,
              title: item.snippet.title,
              durationStr: durStr,
              totalSeconds: totalSecs
            });
          }
        }
      } catch (err) {
        console.error(`Error fetching chunk: ${err.message}`);
      }
    }

    const pctUnder60 = totalChecked > 0 ? ((under60Count / totalChecked) * 100).toFixed(2) : 0;
    console.log(`Checked via YouTube API: ${totalChecked}`);
    console.log(`Videos < 60s: ${under60Count} (${pctUnder60}%)`);

    if (chInfo.id === 120002) {
      console.log(`\n--- RCM JOSH (120002) 5 Sample Videos (60s < duration < 200s) ---`);
      sampleBetween60And200.forEach((v, idx) => {
        console.log(`${idx + 1}. [${v.id}] "${v.title}" | Duration: ${v.durationStr} (${v.totalSeconds}s)`);
      });
    }
  }

  process.exit(0);
}

analyze();
