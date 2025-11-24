const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const attributes = {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        date: {
            type: DataTypes.DATEONLY, // format: YYYY-MM-DD
            allowNull: false,
        },
        amount: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: false,
            defaultValue: 0,
        },
    };

    const options = {
        tableName: "dailyReports",
        charset: "utf8",
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['user_id', 'date'], // prevent duplicate entry per day per user
                name: 'unique_user_date_report'
            }
        ]
    };

    const DailyReport = sequelize.define("DailyReport", attributes, options);

    return DailyReport;
};