
const { sequelize } = require('../config/db');
const { Channel, ChannelVideo } = require('../models');

async function runDetailedQuery() {
    try {
        await sequelize.authenticate();
        const channels = await Channel.findAll({ raw: true });
        console.log(`\n=== ALL CHANNELS & VIDEO/SHORTS COUNTS (${channels.length} channels) ===\n`);

        for (const ch of channels) {
            const totalVideos = await ChannelVideo.count({ where: { channelId: ch.id } });
            const totalShorts = await ChannelVideo.count({ where: { channelId: ch.id, isShort: true } });
            console.log(`[ID: ${ch.id}] "${ch.name}" (YT ID: ${ch.youtubeChannelId}) => Total Videos: ${totalVideos}, Shorts: ${totalShorts}`);
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await sequelize.close();
    }
}

runDetailedQuery();
