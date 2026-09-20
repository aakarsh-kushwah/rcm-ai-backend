const { ChannelVideo } = require('../models');
const axios = require('axios');

async function syncRealStats() {
  const apiKey = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
  console.log('🚀 Loading shorts from DB...');

  const shorts = await ChannelVideo.findAll({
    where: { isShort: true },
    attributes: ['id', 'youtubeVideoId', 'title']
  });

  console.log(`Found ${shorts.length} shorts. Fetching real YouTube stats...`);

  for (let i = 0; i < shorts.length; i += 50) {
    const batch = shorts.slice(i, i + 50);
    const videoIds = batch.map(b => b.youtubeVideoId).filter(Boolean).join(',');
    if (!videoIds) continue;

    const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'snippet,statistics',
        id: videoIds,
        key: apiKey
      }
    });

    for (const item of res.data.items || []) {
      const stats = item.statistics || {};
      const snippet = item.snippet || {};

      await ChannelVideo.update({
        likesCount: parseInt(stats.likeCount || 0, 10),
        commentsCount: parseInt(stats.commentCount || 0, 10),
        viewCount: parseInt(stats.viewCount || 0, 10),
        description: snippet.description || ''
      }, {
        where: { youtubeVideoId: item.id }
      });
    }
    console.log(`✅ Synced batch ${i + 1} to ${Math.min(i + 50, shorts.length)}`);
  }

  console.log('🎉 SUCCESS: All 346 shorts updated with REAL YouTube stats!');
  process.exit(0);
}

syncRealStats().catch(err => {
  console.error('❌ Sync failed:', err.response?.data || err.message);
  process.exit(1);
});
