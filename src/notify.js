// Sends one-time codes by SMS and email. Providers are chosen in .env:
//   OTP_SMS_PROVIDER   = msg91 | twilio | webhook | console | none
//   OTP_EMAIL_PROVIDER = smtp | webhook | console | none
// "console" prints the code in the server log; it is meant for testing and is refused in production.
const config = require('./config');

const smsProvider = () => (process.env.OTP_SMS_PROVIDER || (config.isProd ? 'none' : 'console')).toLowerCase();
const emailProvider = () => (process.env.OTP_EMAIL_PROVIDER || (config.isProd ? 'none' : 'console')).toLowerCase();
const appName = () => process.env.APP_NAME || 'Laytime Calculator';
const ttlMin = () => {
  const v = parseInt(process.env.OTP_TTL_MINUTES || '5', 10);
  return v > 0 ? v : 5;
};

function enabled() {
  const ok = p => p && p !== 'none' && !(p === 'console' && config.isProd);
  return { sms: ok(smsProvider()), email: ok(emailProvider()) };
}

function text(code, purpose) {
  const what = purpose === 'login' ? 'sign-in' : 'verification';
  return `${code} is your ${appName()} ${what} code. It expires in ${ttlMin()} minutes. Do not share it with anyone.`;
}

async function post(url, init, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await r.text();
    if (!r.ok) throw new Error(`${label} returned ${r.status}: ${body.slice(0, 200)}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

// ---------- SMS ----------
async function sendSms(to, code, purpose) {
  const p = smsProvider();
  const msg = text(code, purpose);
  if (p === 'console') {
    if (config.isProd) throw new Error('Console SMS is disabled in production.');
    console.log(`[otp:sms] ${to}: ${msg}`);
    return;
  }
  if (p === 'msg91') {
    // MSG91 Flow API with a DLT-approved template that has one variable for the code.
    await post(
      'https://control.msg91.com/api/v5/flow/',
      {
        method: 'POST',
        headers: {
          authkey: process.env.MSG91_AUTH_KEY || '',
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          template_id: process.env.MSG91_TEMPLATE_ID,
          short_url: '0',
          recipients: [{ mobiles: to.replace('+', ''), [process.env.MSG91_CODE_VAR || 'otp']: code }],
        }),
      },
      'MSG91',
    );
    return;
  }
  if (p === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID,
      tok = process.env.TWILIO_AUTH_TOKEN;
    const form = new URLSearchParams({ To: to, Body: msg });
    if (process.env.TWILIO_MESSAGING_SERVICE_SID)
      form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
    else form.set('From', process.env.TWILIO_FROM || '');
    await post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        body: form,
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
      'Twilio',
    );
    return;
  }
  if (p === 'webhook') {
    // Any gateway: we POST JSON and your small adapter or the gateway sends the SMS.
    await post(
      process.env.SMS_WEBHOOK_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ to, code, message: msg, purpose }),
      },
      'SMS webhook',
    );
    return;
  }
  throw new Error('Text messages are not set up on this server.');
}

// ---------- email ----------
let transport = null;
function smtp() {
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

async function sendEmail(to, code, purpose) {
  const p = emailProvider();
  const subject = `${code} is your ${appName()} code`;
  const msg = text(code, purpose);
  if (p === 'console') {
    if (config.isProd) throw new Error('Console email is disabled in production.');
    console.log(`[otp:email] ${to}: ${msg}`);
    return;
  }
  if (p === 'smtp') {
    await smtp().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text: `${msg}\n\nIf you did not ask for this code, ignore this email.`,
      html: `<p style="font:16px/1.5 sans-serif">Your ${appName()} code is</p><p style="font:600 28px/1 monospace;letter-spacing:4px">${code}</p><p style="font:14px/1.5 sans-serif;color:#555">It expires in ${ttlMin()} minutes. If you did not ask for this code, ignore this email.</p>`,
    });
    return;
  }
  if (p === 'webhook') {
    await post(
      process.env.EMAIL_WEBHOOK_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.EMAIL_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ to, code, subject, message: msg, purpose }),
      },
      'Email webhook',
    );
    return;
  }
  throw new Error('Email is not set up on this server.');
}

module.exports = { sendSms, sendEmail, enabled, ttlMin };
