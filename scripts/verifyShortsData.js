
const { sequelize } = require('../config/db');
const ChannelModel = require('../models/channel.model');
const ChannelVideoModel = require('../models/channelVideo.model');
const ShortInteractionModel = require('../models/shortInteraction.model');
const ShortCommentModel = require('../models/shortComment.model');
const UserModel = require('../models/user.model'); // Add User model

const Channel = ChannelModel(sequelize);
const ChannelVideo = ChannelVideoModel(sequelize);
const ShortInteraction = ShortInteractionModel(sequelize);
const ShortComment = ShortCommentModel(sequelize);
const User = UserModel(sequelize); // Initialize User model

const models = {
    Channel,
    ChannelVideo,
    ShortInteraction,
    ShortComment,
    User // Include User in models object
};

Object.keys(models).forEach(modelName => {
    if (models[modelName].associate) {
        models[modelName].associate(models);
    }
});

async function verifyShortsData() {
    try {
        await sequelize.authenticate();
        console.log('✅ [TITAN-DB] Hyper-Scale Connection Established for verification.');

        // 1. Shorts count per channel
        console.log('\n--- Shorts Count per Channel ---');
        const shortsPerChannel = await ChannelVideo.findAll({
            attributes: [
                'channelId',
                [sequelize.fn('COUNT', sequelize.col('ChannelVideo.id')), 'shortsCount'] // Qualify 'id'
            ],
            where: {
                is_short: true
            },
            group: ['channelId'],
            include: [{
                model: Channel,
                as: 'channel',
                attributes: ['name']
            }]
        });

        if (shortsPerChannel.length > 0) {
            shortsPerChannel.forEach(result => {
                console.log(`Channel ID: ${result.channelId}, Channel Name: ${result.channel.name}, Shorts: ${result.dataValues.shortsCount}`);
            });
        } else {
            console.log('No shorts found for any channel.');
        }


        // 2. Total channels and channels with at least 1 short
        console.log('\n--- Channel Statistics ---');
        const totalChannels = await Channel.count();
        console.log(`Total channels in DB: ${totalChannels}`);

        const channelsWithShorts = await ChannelVideo.findAll({
            attributes: [
                [sequelize.fn('DISTINCT', sequelize.col('channel_id')), 'channelId'] // Use actual column name 'channel_id'
            ],
            where: {
                is_short: true
            },
            raw: true
        });
        const countChannelsWithShorts = channelsWithShorts.length;
        console.log(`Channels with at least 1 short: ${countChannelsWithShorts}`);

    } catch (error) {
        console.error('❌ [TITAN-DB] Verification Failed:', error);
        process.exit(1);
    } finally {
        await sequelize.close();
        console.log('DB connection closed.');
    }
}

verifyShortsData();
