const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}
const axios = require('axios');
const { parse } = require('iso8601-duration');
const { connectDB } = require('../config/db');
const { ChannelVideo } = require('../models');

async function findBoundary() {
  await connectDB();
  const apiKey = process.env.YOUTUBE_API_KEY;

  // Fetch 250 videos that are isShort=false
  const nonShorts = await ChannelVideo.findAll({
    where: { channelId: 60001, isShort: false },
    limit: 250,
    attributes: ['youtubeVideoId', 'title', 'isShort']
  });

  const ids = nonShorts.map(v => v.youtubeVideoId).filter(Boolean);
  let boundaryMatches = [];

  // Check in chunks of 50
  for (let i = 0; i < ids.length && boundaryMatches.length < 5; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await axios.get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${chunk.join(',')}&key=${apiKey}`);
    for (const item of (res.data.items || [])) {
      const durStr = item.contentDetails?.duration;
      if (!durStr) continue;
      const durObj = parse(durStr);
      const totalSecs = (durObj.hours || 0) * 3600 + (durObj.minutes || 0) * 60 + (durObj.seconds || 0);

      // Look for videos that are between 61s and 300s (1m1s to 5m)
      if (totalSecs >= 61 && totalSecs <= 300) {
        boundaryMatches.push({
          id: item.id,
          title: item.snippet.title,
          durationStr: durStr,
          totalSeconds: totalSecs
        });
      }
    }
  }

  boundaryMatches.sort((a, b) => a.totalSeconds - b.totalSeconds);

  console.log('--- Boundary Check: non-short videos (duration > 60s) ---');
  boundaryMatches.slice(0, 5).forEach((v, i) => {
    console.log(`${i+1}. [${v.id}] "${v.title}" | Duration: ${v.durationStr} (${v.totalSeconds}s) | isShort in DB: false`);
  });

  process.exit(0);
}

findBoundary();
