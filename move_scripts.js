const fs = require('fs');
const path = require('path');

const files = [
  'checkBCChhabraDurations.js',
  'checkCurrentProgress.js',
  'checkShortsStats.js',
  'detailedChannelCounts.js',
  'diagnose403.js',
  'findBoundaryVideos.js',
  'inspectSixChannels.js',
  'listScripts.js',
  'markExistingShorts.js',
  'printAllChannelsStats.js',
  'resetStuckChannel.js',
  'runTargetedBackfillSixChannels.js',
  'testSingleChannelSync.js',
  'verifyShortsData.js',
  'verifyShortsDurations.js',
  'querySixChannelsDB.js',
  'rerunTwoChannelsBackfill.js',
  'analyzeChannelDurations.js'
];

const scriptsDir = path.join(__dirname, 'scripts');
const archiveDir = path.join(scriptsDir, 'archive');

if (!fs.existsSync(archiveDir)) {
  fs.mkdirSync(archiveDir, { recursive: true });
}

files.forEach(f => {
  const src = path.join(scriptsDir, f);
  const dest = path.join(archiveDir, f);
  if (fs.existsSync(src)) {
    fs.renameSync(src, dest);
    console.log(`✅ Moved: ${f}`);
  } else {
    console.log(`⚠️ Not found: ${f}`);
  }
});
console.log('Done moving scripts.');
