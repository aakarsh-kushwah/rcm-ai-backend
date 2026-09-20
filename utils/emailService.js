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
 * 1. New Video Synced Alert
 */
async function sendNewVideoAlert(videoData, channelName) {
  const subject = `📺 New Video Synced: ${videoData.title || 'Untitled'} (${channelName})`;
  const watchUrl = videoData.youtubeVideoId ? `https://www.youtube.com/watch?v=${videoData.youtubeVideoId}` : '#';
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f6f9; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        <h2 style="color: #004a99; margin-top: 0;">New YouTube Video Synced</h2>
        <p>A newly discovered video has been indexed on <strong>RCM AI</strong> platform.</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;" />
        <p><strong>Channel Name:</strong> ${channelName}</p>
        <p><strong>Video Title:</strong> ${videoData.title}</p>
        <p><strong>YouTube Video ID:</strong> ${videoData.youtubeVideoId}</p>
        <p><strong>Publish Date:</strong> ${videoData.publishedAt ? new Date(videoData.publishedAt).toLocaleString() : 'N/A'}</p>
        <p style="margin-top: 25px;">
          <a href="${watchUrl}" style="background-color: #004a99; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">Watch on YouTube</a>
        </p>
      </div>
    </div>
  `;
  return sendEmailAlert({ subject, htmlContent });
}

/**
 * 2. New User Registration Alert
 */
async function sendNewUserAlert(userData) {
  const subject = `👤 New User Registration: ${userData.fullName || userData.email}`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f6f9; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        <h2 style="color: #004a99; margin-top: 0;">New User Registered</h2>
        <p>A new user account has been successfully created on RCM AI.</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;" />
        <p><strong>User Name:</strong> ${userData.fullName || 'N/A'}</p>
        <p><strong>Email:</strong> ${userData.email}</p>
        <p><strong>Phone:</strong> ${userData.phone || 'N/A'}</p>
        <p><strong>RCM ID / City:</strong> ${userData.rcmId || userData.city || 'N/A'}</p>
        <p><strong>Assigned Role:</strong> ${userData.role || 'USER'}</p>
        <p><strong>Registration Timestamp:</strong> ${new Date().toLocaleString()}</p>
      </div>
    </div>
  `;
  return sendEmailAlert({ subject, htmlContent });
}

/**
 * 3. Payment Received Alert
 */
async function sendPaymentAlert(paymentData) {
  const subject = `💰 Payment Received: ₹${paymentData.amount || 49} (${paymentData.payerName || paymentData.email})`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f6f9; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        <h2 style="color: #28a745; margin-top: 0;">Payment Successful</h2>
        <p>A new subscription payment transaction has been successfully processed.</p>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;" />
        <p><strong>Payer Name:</strong> ${paymentData.payerName || 'N/A'}</p>
        <p><strong>Email:</strong> ${paymentData.email || 'N/A'}</p>
        <p><strong>Razorpay Payment ID:</strong> ${paymentData.paymentId || paymentData.transactionId || 'N/A'}</p>
        <p><strong>Plan Name:</strong> ${paymentData.planName || '₹49 Commander Pro'}</p>
        <p><strong>Amount:</strong> ₹${paymentData.amount || 49}</p>
        <p><strong>Status:</strong> <span style="color: #28a745; font-weight: bold;">SUCCESS</span></p>
        <p><strong>Subscription Expiry Date:</strong> ${paymentData.expiryDate ? new Date(paymentData.expiryDate).toLocaleDateString() : '30 Days from Today'}</p>
      </div>
    </div>
  `;
  return sendEmailAlert({ subject, htmlContent });
}

module.exports = {
  sendEmailAlert,
  sendNewVideoAlert,
  sendNewUserAlert,
  sendPaymentAlert,
};
