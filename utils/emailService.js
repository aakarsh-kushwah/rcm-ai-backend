const nodemailer = require('nodemailer');
const logger = require('./logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER,
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS,
  },
});

/**
 * Generic email alert sender with graceful background error handling
 */
async function sendEmailAlert({ subject, htmlContent, to }) {
  const recipient = to || process.env.ADMIN_NOTIFICATION_EMAIL || process.env.EMAIL_USER;
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!user || !pass) {
    logger.warn('[EmailService] SMTP credentials not configured. Skipping email alert.');
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from: `"RCM AI Command Center" <${user}>`,
      to: recipient,
      subject: subject,
      html: htmlContent,
    });
    logger.info(`[EmailService] Email sent successfully: ${info.messageId} to ${recipient}`);
    return true;
  } catch (err) {
    logger.error(`[EmailService] Failed to send email alert ("${subject}"): ${err.message}`);
    // Fail gracefully - never throw or block calling workflows
    return false;
  }
}

/**
 * Lightweight AI Token Usage Alert function
 */
async function sendTokenUsageAlert({ model, promptTokens, completionTokens, totalTokens }) {
  const subject = `📊 AI Token Usage: Model [${model}]`;
  const htmlContent = `
    <h3>AI Model Token Consumption Report</h3>
    <p><b>Model Name:</b> ${model || 'Unknown'}</p>
    <p><b>Prompt Tokens:</b> ${promptTokens || 0}</p>
    <p><b>Completion Tokens:</b> ${completionTokens || 0}</p>
    <p><b>Total Tokens Used:</b> ${totalTokens || 0}</p>
    <p><i>Time:</i> ${new Date().toLocaleString()}</p>
  `;
  return await sendEmailAlert({ subject, htmlContent });
}

// Safe placeholder stubs to prevent ReferenceErrors if imported elsewhere
async function sendNewUserAlert() {}
async function sendPaymentAlert() {}

module.exports = {
  sendEmailAlert,
  sendNewUserAlert,
  sendPaymentAlert,
  sendTokenUsageAlert,
};