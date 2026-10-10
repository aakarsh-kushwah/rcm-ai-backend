/**
 * @file rcm-ai-backend/services/emailService.js
 * @description Email service utility for sending administrative alerts using nodemailer or similar.
 */

const nodemailer = require('nodemailer');
const { logger } = require('../utils/logger');

// Create transporter using environment variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
        user: process.env.SMTP_USER || process.env.EMAIL_USER,
        pass: process.env.SMTP_PASS || process.env.EMAIL_PASS,
    },
});

/**
 * Sends an email notification to the admin alert email address.
 * @param {Object} options - Email options { subject, message, html }
 * @returns {Promise<boolean>} Success status
 */
async function sendAdminAlert({ subject, message, html }) {
    const adminEmail = process.env.ADMIN_ALERT_EMAIL;
    if (!adminEmail) {
        logger.warn('[EmailService] ADMIN_ALERT_EMAIL is not configured. Skipping admin alert email.');
        return false;
    }

    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@rcmai.in',
            to: adminEmail,
            subject: subject || 'RCM AI Titan Admin Alert',
            text: message,
            html: html || `<div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px;"><h2>Titan Admin Alert</h2><p>${message}</p></div>`,
        });

        logger.info(`[EmailService] Admin alert email sent successfully: ${info.messageId}`);
        return true;
    } catch (error) {
        logger.error(`[EmailService] Failed to send admin alert email: ${error.message}`);
        return false;
    }
}

module.exports = {
    sendAdminAlert,
};
