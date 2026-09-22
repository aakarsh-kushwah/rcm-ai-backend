const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { connectDB } = require('../config/db');
const { Channel } = require('../models');

async function resetChannel() {
  await connectDB();
  const channel = await Channel.findOne({ where: { id: 30001 } });
  if (channel) {
    channel.lastSyncStatus = 'error';
    channel.lastSyncError = 'Reset from stuck syncing status';
    await channel.save();
    console.log('Channel 30001 status reset from syncing to error.');
  }
  process.exit(0);
}

resetChannel();
