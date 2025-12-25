const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const attributes = {
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        month: {
            type: DataTypes.INTEGER, // e.g., 11
            allowNull: false,
        },
        year: {
            type: DataTypes.INTEGER, // e.g., 2025
            allowNull: false,
        },
        // ✅ PRO MOVE: Pura mahina ek JSON object mein
        // Format: { "1": 100, "2": 500, "15": 200 }
        daily_data: {
            type: DataTypes.JSON, 
            allowNull: false,
            defaultValue: {}
        },
        // ✅ FAST CALCULATION: Total hum yahi save kar lenge taaki baar baar jodna na pade
        monthly_total: {
            type: DataTypes.DECIMAL(20, 2),
            allowNull: false,
            defaultValue: 0
        }
    };

    const options = {
        tableName: "monthly_reports", // Name changed to reflect logic
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['user_id', 'month', 'year'], // 1 User = 1 Row per Month
                name: 'unique_user_month_report'
            }
        ]
    };

    const DailyReport = sequelize.define("DailyReport", attributes, options);

    DailyReport.associate = function (models) {
        this.belongsTo(models.User, {
            foreignKey: 'user_id',
            as: 'user',
        });
    };

    return DailyReport;
};