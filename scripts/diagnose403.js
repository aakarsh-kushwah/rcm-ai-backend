const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.YOUTUBE_API_KEY) {
  process.env.YOUTUBE_API_KEY = 'AIzaSyCHcc5q75mfA4bFL-3MPumrQGjD7Kp2cCo';
}
const axios = require('axios');
const { connectDB } = require('../config/db');
const { Channel } = require('../models');

async function diagnose() {
  await connectDB();
  const apiKey = process.env.YOUTUBE_API_KEY;
  const channel = await Channel.findOne({ where: { id: 30002 } });

  try {
    await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
      params: {
        part: 'snippet',
        playlistId: channel.uploadsPlaylistId,
        maxResults: 50,
        key: apiKey
      }
    });
    console.log('Playlist items request succeeded.');
  } catch (err) {
    console.log('Playlist items request failed:');
    if (err.response) {
      console.log('Status:', err.response.status);
      console.log('Data:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.log(err.message);
    }
  }

  process.exit(0);
}

diagnose();
