const { DataTypes } = require('sequelize');

// Youtube Channel Table (Admin defined sections)
module.exports = (sequelize) => {
    const YoutubeChannel = sequelize.define(
        'YoutubeChannel',
        {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true,
            },
            channelName: {
                type: DataTypes.STRING(100),
                allowNull: false,
                unique: true, 
                field: 'channel_name',
            },
            channelLogoUrl: {
                type: DataTypes.STRING(500),
                allowNull: false,
                field: 'channel_logo_url',
            },
        },
        {
            tableName: 'youtube_channels',
            timestamps: true, 
            underscored: true,
            indexes: [{ fields: ['channel_name'] }],
        }
    );
    return YoutubeChannel;
};