// backend/services/youtubeService.js
const { google } = require('googleapis');
const axios = require('axios'); // Channel ID nikalne ke liye

// YouTube API ko initialize karein
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY, // Yeh .env se aayega
});

/**
 * 1. Channel URL se Channel ID nikalta hai
 * (Kyunki kabhi-kabhi URL mein '@handle' hota hai, ID nahi)
 */
const getChannelIdFromUrl = async (url) => {
    try {
        // Pehle dekhein ki URL mein ID hai ya nahi
        if (url.includes('/channel/')) {
            return url.split('/channel/')[1].split('/')[0];
        }

        // Agar URL mein @handle hai
        if (url.includes('@')) {
            const handle = url.split('@')[1].split('/')[0];
            // Google API se 'search' karke channel ki ID nikalni padegi
            const response = await youtube.search.list({
                part: 'snippet',
                q: handle,
                type: 'channel',
                maxResults: 1,
            });
            if (response.data.items && response.data.items.length > 0) {
                return response.data.items[0].snippet.channelId;
            }
        }
        
        throw new Error('Could not resolve Channel ID from URL.');

    } catch (error) {
        console.error("Error getting Channel ID:", error.message);
        throw new Error('Invalid Channel URL or YouTube API error.');
    }
};

/**
 * 2. Channel ID se 'Uploads' Playlist ID nikalta hai
 */
const getUploadsPlaylistId = async (channelId) => {
  try {
    const response = await youtube.channels.list({
      id: [channelId],
      part: 'contentDetails',
    });
    return response.data.items[0].contentDetails.relatedPlaylists.uploads;
  } catch (error) {
    console.error("Error fetching uploads playlist:", error.message);
    throw new Error('Could not find channel uploads. Is the channel public?');
  }
};

/**
 * 3. Playlist ID se sabhi videos laata hai
 */
const fetchAllVideosFromPlaylist = async (playlistId) => {
  let videos = [];
  let nextPageToken = null;

  try {
    do {
      const response = await youtube.playlistItems.list({
        playlistId: playlistId,
        part: 'snippet',
        maxResults: 50, // Ek baar mein 50 (max limit)
        pageToken: nextPageToken,
      });

      const newItems = response.data.items.map(item => ({
        title: item.snippet.title,
        description: item.snippet.description || '',
        publicId: item.snippet.resourceId.videoId, // Video ID
        videoUrl: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`,
        thumbnailUrl: item.snippet.thumbnails.medium ? item.snippet.thumbnails.medium.url : '',
      }));
      
      videos = [...videos, ...newItems];
      nextPageToken = response.data.nextPageToken;

    } while (nextPageToken);

    return videos;
  } catch (error) {
    console.error("Error fetching playlist items:", error.message);
    throw new Error('Failed to fetch videos from playlist.');
  }
};

// --- Mukhya Functions (Jo Controller mein use honge) ---

/**
 * A. Channel URL se sabhi video import karein
 */
const fetchChannelVideos = async (channelUrl) => {
  const channelId = await getChannelIdFromUrl(channelUrl);
  const uploadsPlaylistId = await getUploadsPlaylistId(channelId);
  return await fetchAllVideosFromPlaylist(uploadsPlaylistId);
};

/**
 * B. Playlist URL se sabhi video import karein
 */
const fetchPlaylistVideos = async (playlistId) => {
  return await fetchAllVideosFromPlaylist(playlistId);
};


module.exports = {
  fetchChannelVideos,
  fetchPlaylistVideos
};