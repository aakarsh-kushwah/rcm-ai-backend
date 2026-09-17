const { Channel, sequelize } = require('../models');
const { runPhaseADiscovery } = require('../services/channelSyncService');

async function inspectAndTrigger() {
  try {
    await sequelize.authenticate();
    console.log("Database connected.");

    const channels = await Channel.findAll();
    console.log(`Found ${channels.length} channels in database.`);

    for (const ch of channels) {
      console.log(`\nChannel: ${ch.name} (ID: ${ch.id})`);
      console.log(`  - youtubeChannelId: ${ch.youtubeChannelId}`);
      console.log(`  - uploadsPlaylistId: ${ch.uploadsPlaylistId}`);
      console.log(`  - upcomingVideoId: ${ch.upcomingVideoId}`);
      console.log(`  - scheduledStartTime: ${ch.scheduledStartTime}`);
      console.log(`  - upcomingPremiereAt: ${ch.upcomingPremiereAt}`);
      console.log(`  - isCurrentlyLive: ${ch.isCurrentlyLive}`);
      console.log(`  - checkLiveStatus: ${ch.checkLiveStatus}`);

      // Manually trigger Phase A discovery for this channel
      console.log(`  -> Triggering manual Phase A discovery for ${ch.name}...`);
      ch.lastLiveCheckAt = null; // Reset throttle
      await ch.save();
      await runPhaseADiscovery(ch);
      
      await ch.reload();
      console.log(`  -> After Phase A: upcomingVideoId = ${ch.upcomingVideoId}, scheduledStartTime = ${ch.scheduledStartTime}`);
    }

    process.exit(0);
  } catch (err) {
    console.error("Error inspecting/triggering channels:", err);
    process.exit(1);
  }
}

inspectAndTrigger();
