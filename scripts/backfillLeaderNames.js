const { sequelize, LeaderVideo } = require('../models');

async function backfillLeaderNames() {
  try {
    await sequelize.authenticate();
    console.log('Database connection established for backfill.');

    const leaderVideos = await LeaderVideo.findAll();
    let updatedCount = 0;
    let nullCount = 0;

    for (const video of leaderVideos) {
      if (!video.leaderName) { // Only process if leaderName is not already set
        let extractedName = null;
        // Simple heuristic: Try to extract a name if the title contains common patterns
        // This is a placeholder and might need more sophisticated NLP for real-world use
        const title = video.title.toLowerCase();
        
        // Example: If title is "RCM Leader John Doe - Training Video", extract "John Doe"
        const leaderKeywords = ['leader', 'sir', 'madam', 'shri', 'smt']; // Add more as needed
        for (const keyword of leaderKeywords) {
          const regex = new RegExp(`${keyword}\s+([a-z ]+)`, 'i');
          const match = title.match(regex);
          if (match && match[1]) {
            extractedName = match[1].trim().replace(/video|training|motivation/g, '').trim();
            // Capitalize first letter of each word
            extractedName = extractedName.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            break;
          }
        }

        if (extractedName) {
          video.leaderName = extractedName;
          await video.save();
          updatedCount++;
        } else {
          nullCount++;
        }
      }
    }
    console.log(`Backfill complete: ${updatedCount} leader names updated, ${nullCount} remained null.`);
  } catch (error) {
    console.error('Error during leaderName backfill:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

backfillLeaderNames();
