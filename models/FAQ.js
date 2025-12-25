/**
 * @file src/models/FAQ.js
 * @description Database Schema for Questions & Answers
 */
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FAQ = sequelize.define('FAQ', {
    question: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    answer: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    audioUrl: {
      type: DataTypes.STRING,
      allowNull: true
    },
    voiceType: {
      // ELEVENLABS: Paid/Premium Voice
      // EDGE: Free AI Voice
      type: DataTypes.ENUM('ELEVENLABS', 'EDGE', 'NONE'),
      defaultValue: 'NONE'
    },
    status: {
      // APPROVED: Verified Answer
      // PENDING_REVIEW: New Question from WhatsApp/Web
      type: DataTypes.ENUM('APPROVED', 'PENDING_REVIEW'),
      defaultValue: 'APPROVED'
    },
    isUserSubmitted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    tags: {
      type: DataTypes.JSON,
      allowNull: true
    }
  });

  return FAQ;
};