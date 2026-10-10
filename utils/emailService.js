const nodemailer = require('nodemailer');
const logger = require('./logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: (Number(process.env.SMTP_PORT) === 465) || false, // Use false for port 587, true for 465
  requireTLS: (Number(process.env.SMTP_PORT) === 587) || true, // Use true for port 587
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER,
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS,
  },
});

/**
 * Generic email alert sender with graceful background error handling
 */
async function sendEmailAlert({ subject, htmlContent, to }) {
  const recipient = to || process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_NOTIFICATION_EMAIL || process.env.EMAIL_USER;
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!user || !pass || !recipient) {
    logger.warn('[EmailService] SMTP credentials or recipient ADMIN_ALERT_EMAIL not configured. Skipping email alert.');
    return false;
  }

  try {
    const info = await transporter.sendMail({
      from: `"RCM AI Alerts" <${user}>`,
      to: recipient,
      subject: subject,
      html: htmlContent,
    });
    logger.info(`✅ [Admin Alert] Sent successfully to: ${recipient}. MessageId: ${info.messageId}`);
    return true;
  } catch (err) {
    logger.error(`❌ [Admin Alert] Transporter error: Failed to send email alert ("${subject}"): ${err.message}`);
    // Fail gracefully - never throw or block calling workflows
    return false;
  }
}

/**
 * Send admin alert on user registration or login events
 */
async function sendNewUserAlert(details) {
  const { eventType = 'New Registration', fullName, email, role, userId, timestamp, ip, userAgent } = details;
  const subject = `🚨 Admin Alert: [${eventType}] - ${fullName || email}`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px;">
      <h2 style="color: #2c3e50;">Titan Security & User Event Alert</h2>
      <p><b>Event Type:</b> ${eventType}</p>
      <p><b>User Name:</b> ${fullName || 'N/A'}</p>
      <p><b>Email:</b> ${email || 'N/A'}</p>
      <p><b>Role:</b> ${role || 'USER'}</p>
      <p><b>User ID:</b> ${userId || 'N/A'}</p>
      <p><b>Timestamp:</b> ${timestamp ? new Date(timestamp).toLocaleString() : new Date().toLocaleString()}</p>
      <p><b>Client IP:</b> ${ip || 'N/A'}</p>
      <p><b>User-Agent:</b> ${userAgent || 'N/A'}</p>
    </div>
  `;
  return await sendEmailAlert({ subject, htmlContent });
}

/**
 * Send general admin alerts
 */
async function sendAdminAlert({ type, user, totalUsers, ip, userAgent }) {
  logger.info('📧 [Admin Alert] Triggered for:', user.email);
  const formattedTime = new Date().toLocaleString();
  const userName = user.name || user.fullName || 'N/A';
  const subject = `🚀 #${totalUsers} • New User: ${userName} (${user.email})`;
  const htmlContent = `
    <!-- Invisible Preheader for Mobile Notification Drawer -->
    <div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
      👤 ${userName} (${user.email}) just joined RCM AI. Total platform members: #${totalUsers}.
    </div>
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #2563eb, #1d4ed8); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 700;">🚀 New Member Registered!</h2>
        <p style="margin: 6px 0 0; opacity: 0.9; font-size: 14px;">A new user has joined RCM AI</p>
      </div>

      <div style="padding: 24px;">
        <!-- Total Users Badge -->
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px; text-align: center; margin-bottom: 20px;">
          <span style="font-size: 13px; color: #166534; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Platform Milestones</span>
          <div style="font-size: 26px; font-weight: 800; color: #15803d; margin-top: 4px;">#${totalUsers} Total Users</div>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #334155;">
          <tr>
            <td style="padding: 8px 0; font-weight: 600; color: #64748b;">User Name</td>
            <td style="padding: 8px 0; text-align: right; font-weight: 700; color: #0f172a;">${userName}</td>
          </tr>
          <tr style="border-top: 1px solid #f1f5f9;">
            <td style="padding: 8px 0; font-weight: 600; color: #64748b;">Email Address</td>
            <td style="padding: 8px 0; text-align: right; color: #2563eb;">${user.email}</td>
          </tr>
          <tr style="border-top: 1px solid #f1f5f9;">
            <td style="padding: 8px 0; font-weight: 600; color: #64748b;">User ID</td>
            <td style="padding: 8px 0; text-align: right; font-family: monospace;">${user.id || 'N/A'}</td>
          </tr>
          <tr style="border-top: 1px solid #f1f5f9;">
            <td style="padding: 8px 0; font-weight: 600; color: #64748b;">Date & Time</td>
            <td style="padding: 8px 0; text-align: right;">${formattedTime}</td>
          </tr>
        </table>
      </div>

      <div style="background: #f8fafc; padding: 14px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
        Automated Enterprise Alert • RCM AI Production Engine
      </div>
    </div>
  `;
  return await sendEmailAlert({ subject, htmlContent });
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

async function sendPaymentAlert() {}

module.exports = {
  sendEmailAlert,
  sendNewUserAlert,
  sendPaymentAlert,
  sendAdminAlert,
  sendTokenUsageAlert,
};
