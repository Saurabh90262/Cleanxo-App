/**
 * CLEANXO - backend (single file)
 * Express + MongoDB Atlas (Mongoose) + Cloudflare R2 (S3 API) + Google Apps Script (email)
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

dotenv.config({ quiet: true });

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */
const env = process.env;
const isProd = env.NODE_ENV === 'production';
const PORT = Number(env.PORT) || 5000;
// Origins must match exactly what the browser sends (no trailing slash), so tidy what was typed in .env
const CLIENT_URLS = (env.CLIENT_URL || 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const JWT_SECRET = (env.JWT_SECRET || '').trim();
const envStr = (key, fallback = '') => String(env[key] ?? fallback).trim();
const isPlaceholder = (v) => !v || /your[_-]|change[_-]?me|dummy|example\.com/i.test(v);

const FREE_SHIPPING_MIN = Number(env.FREE_SHIPPING_MIN) || 499;
const SHIPPING_FEE = Number.isFinite(Number(env.SHIPPING_FEE)) && env.SHIPPING_FEE !== '' ? Number(env.SHIPPING_FEE) : 49;
const MAX_QTY_PER_ITEM = 10;

const COMPANY = {
  name: envStr('COMPANY_NAME', 'CLEANXO Home Care Pvt. Ltd.'),
  email: envStr('COMPANY_EMAIL'),
  phone: envStr('COMPANY_PHONE'),
  address: envStr('COMPANY_ADDRESS'),
  hours: envStr('COMPANY_HOURS', 'Mon-Sat, 9:30 AM - 6:30 PM'),
  // Filled in by resolveMap() at start-up from MAP_URL
  mapLink: '',
  mapEmbed: '',
  social: {
    instagram: envStr('SOCIAL_INSTAGRAM', 'https://www.instagram.com/'),
    youtube: envStr('SOCIAL_YOUTUBE', 'https://www.youtube.com/'),
    facebook: envStr('SOCIAL_FACEBOOK', 'https://www.facebook.com/'),
    twitter: envStr('SOCIAL_TWITTER', 'https://x.com/'),
  },
};
const SITE_URL = CLIENT_URLS[0] || 'http://localhost:5173';

if (JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set in .env and be at least 32 characters long.');
  process.exit(1);
}
if (isProd && (isPlaceholder(JWT_SECRET) || JWT_SECRET.includes('0f3a9c71d2b84e56'))) {
  console.error('FATAL: JWT_SECRET is a sample/dummy value that has been shared before. Generate a fresh one:\n  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const normEmail = (e) => str(e, 254).toLowerCase();
const strongPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72 && /[A-Za-z]/.test(p) && /\d/.test(p);
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const validId = (id) => mongoose.isValidObjectId(id) && String(id).length === 24;

const STATUSES = ['pending', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'];
const FLOW = ['pending', 'confirmed', 'shipped', 'out_for_delivery', 'delivered'];
const CUSTOMER_CANCELLABLE = ['pending', 'confirmed'];
const STATUS_TEXT = {
  pending: 'Order placed',
  confirmed: 'Confirmed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */
const addressSchema = new mongoose.Schema(
  { name: String, phone: String, line1: String, line2: String, city: String, state: String, pincode: String },
  { _id: false },
);

const User = mongoose.model(
  'User',
  new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true, maxlength: 80 },
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      phone: { type: String, default: '' },
      passwordHash: { type: String, required: true },
      role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
      address: { type: addressSchema, default: () => ({}) },
      passwordChangedAt: Date,
    },
    { timestamps: true },
  ),
);

const otpSchema = new mongoose.Schema({
  email: { type: String, required: true },
  purpose: { type: String, enum: ['register', 'reset'], required: true },
  hash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  sentAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
otpSchema.index({ email: 1, purpose: 1 }, { unique: true });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Otp = mongoose.model('Otp', otpSchema);

const Product = mongoose.model(
  'Product',
  new mongoose.Schema(
    {
      name: { type: String, required: true, trim: true, maxlength: 120 },
      category: { type: String, required: true, trim: true, maxlength: 60 },
      size: { type: String, default: '', maxlength: 40 },
      price: { type: Number, required: true, min: 1 },
      mrp: { type: Number, default: 0 },
      stock: { type: Number, default: 0, min: 0 },
      sold: { type: Number, default: 0, min: 0 },
      badge: { type: String, default: '', maxlength: 24 },
      shortDescription: { type: String, default: '', maxlength: 200 },
      details: { type: String, default: '', maxlength: 2000 },
      uses: { type: String, default: '', maxlength: 1000 },
      image: { type: String, default: '' },
      imageKey: { type: String, default: '', select: false },
      active: { type: Boolean, default: true },
    },
    { timestamps: true },
  ),
);

const Order = mongoose.model(
  'Order',
  new mongoose.Schema(
    {
      orderNumber: { type: String, unique: true, required: true },
      customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      items: [
        {
          _id: false,
          product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
          name: String,
          image: String,
          size: String,
          price: Number,
          qty: Number,
        },
      ],
      subtotal: Number,
      shipping: Number,
      total: Number,
      shippingAddress: addressSchema,
      paymentMethod: { type: String, default: 'COD' },
      paymentStatus: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
      status: { type: String, enum: STATUSES, default: 'pending', index: true },
      history: [{ _id: false, status: String, note: String, at: { type: Date, default: Date.now } }],
      cancelledAt: Date,
      cancelledBy: String,
      cancelReason: { type: String, default: '' },
      deliveredAt: Date,
      emails: {
        customer: { type: String, default: 'pending' },
        company: { type: String, default: 'pending' },
        lastAttemptAt: Date,
      },
    },
    { timestamps: true },
  ),
);

/* ------------------------------------------------------------------ */
/* Email through Google Apps Script                                    */
/* ------------------------------------------------------------------ */
async function sendMail({ to, subject, html, replyTo, devNote }) {
  to = String(to || '').trim();
  if (!isEmail(to)) throw new Error(`Invalid email recipient "${to}"`);
  const url = envStr('GOOGLE_APPS_SCRIPT_URL');
  if (isPlaceholder(url)) {
    if (isProd) fail(503, 'Email service is not configured. Set GOOGLE_APPS_SCRIPT_URL.');
    console.log(`[mail:dev-mock] to=${to} subject="${subject}"${devNote ? ` -> ${devNote}` : ''}`);
    return;
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      // Extra fields (secret, replyTo) are simply ignored by older relay scripts.
      body: JSON.stringify({ secret: envStr('APPS_SCRIPT_SECRET'), to, subject, html, replyTo: replyTo || '' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    console.error(`[mail] request failed to=${to}: ${e.message}`);
    fail(502, 'Could not reach the email service. Please try again shortly.');
  }
  const text = (await res.text().catch(() => '')).trim();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text answers are fine */
  }
  // Apps Script answers 200 with an HTML page when the deployment is not public / not authorised.
  const looksLikeHtml = /^<(!doctype|html)/i.test(text);
  if (!res.ok || looksLikeHtml || data?.ok === false || data?.success === false || data?.error) {
    console.error(`[mail] FAILED to=${to} http=${res.status} ${looksLikeHtml ? 'got an HTML page (check the Apps Script deployment: Execute as Me, Access Anyone)' : data?.error || text.slice(0, 200)}`);
    fail(502, 'The email service rejected the request. Please try again shortly.');
  }
  console.log(`[mail] sent to=${to} :: ${subject}`);
}

/** Fire-and-forget wrapper: never lets an email failure break the main action. */
const sendMailQuiet = (opts) => sendMail(opts).catch((e) => console.error('Email not delivered:', e.message));

/** Try twice (Apps Script occasionally times out) and report instead of throwing. */
async function sendWithRetry(opts, tries = 2) {
  let last = '';
  for (let i = 0; i < tries; i += 1) {
    try {
      await sendMail(opts);
      return true;
    } catch (e) {
      last = e.message;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 2500));
    }
  }
  console.error(`[mail] gave up on ${opts.to}: ${last}`);
  return false;
}

const mailLayout = (heading, inner) => `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;border:1px solid #dcebe9;border-radius:14px;overflow:hidden;background:#fff">
  <div style="background:#0a2a33;color:#fff;padding:18px 24px;font-size:22px;font-weight:700;letter-spacing:-.5px">CLEAN<span style="color:#f2c94c">XO</span></div>
  <div style="padding:24px;color:#0a2a33;line-height:1.6;font-size:14px">
    <h2 style="margin:0 0 14px;font-size:20px">${esc(heading)}</h2>${inner}
  </div>
  <div style="background:#eaf7f6;padding:14px 24px;font-size:12px;color:#4d6b70">${esc(COMPANY.name)}${COMPANY.phone ? ' &middot; ' + esc(COMPANY.phone) : ''}${COMPANY.email ? ' &middot; ' + esc(COMPANY.email) : ''}</div>
</div>`;

const mailImg = (src, alt) =>
  /^https:\/\//.test(src || '')
    ? `<img src="${esc(src)}" alt="${esc(alt)}" width="56" height="56" style="width:56px;height:56px;object-fit:cover;border-radius:8px;display:block;background:#eaf5f4">`
    : '';

const orderTable = (o) => `
<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:13px">
  <tr style="color:#6b8186;font-size:12px"><td colspan="2" style="padding:0 0 6px;border-bottom:2px solid #0a2a33">PRODUCT</td><td style="padding:0 0 6px;border-bottom:2px solid #0a2a33;text-align:right">AMOUNT</td></tr>
  ${o.items
    .map(
      (i) => `<tr>
    <td style="padding:10px 10px 10px 0;border-bottom:1px solid #e6efee;width:60px;vertical-align:top">${mailImg(i.image, i.name)}</td>
    <td style="padding:10px 8px 10px 0;border-bottom:1px solid #e6efee;vertical-align:top"><b>${esc(i.name)}</b><br><span style="color:#6b8186;font-size:12px">${esc(i.size)} &middot; ${inr(i.price)} each &times; ${i.qty}</span></td>
    <td style="padding:10px 0;border-bottom:1px solid #e6efee;text-align:right;vertical-align:top">${inr(i.price * i.qty)}</td></tr>`,
    )
    .join('')}
  <tr><td colspan="2" style="padding:8px 0 2px">Subtotal</td><td style="text-align:right">${inr(o.subtotal)}</td></tr>
  <tr><td colspan="2" style="padding:2px 0">Delivery</td><td style="text-align:right">${o.shipping ? inr(o.shipping) : 'FREE'}</td></tr>
  <tr><td colspan="2" style="padding:8px 0;font-weight:700;font-size:15px;border-top:1px solid #0a2a33">Total (${esc(o.paymentMethod === 'COD' ? 'pay on delivery' : o.paymentMethod)})</td><td style="text-align:right;font-weight:700;font-size:15px;border-top:1px solid #0a2a33">${inr(o.total)}</td></tr>
</table>`;

const placedAt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const mailButton = (href, label) =>
  `<p style="margin:18px 0 4px"><a href="${esc(href)}" style="background:#0e7c86;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:700;display:inline-block">${esc(label)}</a></p>`;

const addressLines = (a = {}) =>
  [a.name, a.line1, a.line2, `${a.city || ''}, ${a.state || ''} ${a.pincode || ''}`, a.phone ? `Phone: ${a.phone}` : '']
    .filter(Boolean)
    .map(esc)
    .join('<br>');

/* ------------------------------------------------------------------ */
/* Cloudflare R2                                                       */
/* ------------------------------------------------------------------ */
const r2Ready = ![envStr('R2_ACCOUNT_ID'), envStr('R2_ACCESS_KEY_ID'), envStr('R2_SECRET_ACCESS_KEY'), envStr('R2_BUCKET'), envStr('R2_PUBLIC_URL')].some(isPlaceholder);
const r2 = r2Ready
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${envStr('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: envStr('R2_ACCESS_KEY_ID'), secretAccessKey: envStr('R2_SECRET_ACCESS_KEY') },
    })
  : null;

/** Check real file signature instead of trusting the client's mimetype. */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
async function storeImage(file) {
  if (!r2) fail(503, 'Image storage (Cloudflare R2) is not configured yet. Fill in the R2_* values in .env, or paste an image URL instead.');
  const type = sniffImage(file.buffer);
  if (!type) fail(400, 'Only JPG, PNG or WebP images are allowed.');
  const key = `products/${crypto.randomUUID()}.${type.ext}`;
  try {
    await r2.send(
      new PutObjectCommand({ Bucket: envStr('R2_BUCKET'), Key: key, Body: file.buffer, ContentType: type.mime, CacheControl: 'public, max-age=31536000, immutable' }),
    );
  } catch (e) {
    console.error('R2 upload failed:', e.message);
    fail(502, 'Image upload to Cloudflare R2 failed. Check your R2 credentials and bucket name.');
  }
  return { url: `${envStr('R2_PUBLIC_URL').replace(/\/$/, '')}/${key}`, key };
}
const deleteImageQuiet = async (key) => {
  if (!r2 || !key) return;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: envStr('R2_BUCKET'), Key: key }));
  } catch (e) {
    console.error('R2 delete failed:', e.message);
  }
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
});

/* ------------------------------------------------------------------ */
/* Auth helpers                                                        */
/* ------------------------------------------------------------------ */
const signToken = (user) => jwt.sign({ id: String(user._id) }, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
const publicUser = (u) => ({ id: String(u._id), name: u.name, email: u.email, phone: u.phone || '', role: u.role, address: u.address || {} });

const requireAuth = wrap(async (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    fail(401, 'Please sign in to continue.');
  }
  const user = await User.findById(payload.id);
  if (!user) fail(401, 'Your session has expired. Please sign in again.');
  if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
    fail(401, 'Your password was changed. Please sign in again.');
  }
  req.user = user;
  next();
});
const requireAdmin = [
  requireAuth,
  (req, res, next) => (req.user.role === 'admin' ? next() : next(new HttpError(403, 'Admin access required.'))),
];

async function issueOtp(email, purpose) {
  const existing = await Otp.findOne({ email, purpose });
  if (existing && Date.now() - existing.sentAt.getTime() < 30 * 1000) {
    fail(429, 'Please wait 30 seconds before requesting another code.');
  }
  const code = String(crypto.randomInt(100000, 1000000));
  const hash = await bcrypt.hash(code, 8);
  await Otp.findOneAndUpdate(
    { email, purpose },
    { hash, attempts: 0, sentAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    { upsert: true },
  );
  const heading = purpose === 'register' ? 'Verify your email' : 'Reset your password';
  await sendMail({
    to: email,
    subject: `${code} is your CLEANXO verification code`,
    html: mailLayout(
      heading,
      `<p>Use this code to ${purpose === 'register' ? 'finish creating your account' : 'reset your password'}:</p>
       <p style="font-size:32px;letter-spacing:8px;font-weight:700;background:#eaf7f6;padding:14px;text-align:center;border-radius:10px">${code}</p>
       <p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
    ),
    devNote: `OTP ${code}`,
  });
}
async function checkOtp(email, purpose, code) {
  const rec = await Otp.findOne({ email, purpose });
  if (!rec || rec.expiresAt < new Date()) fail(400, 'That code is invalid or has expired. Request a new one.');
  if (rec.attempts >= 5) {
    await rec.deleteOne();
    fail(429, 'Too many wrong attempts. Request a new code.');
  }
  const ok = /^\d{6}$/.test(String(code)) && (await bcrypt.compare(String(code), rec.hash));
  if (!ok) {
    await Otp.updateOne({ _id: rec._id }, { $inc: { attempts: 1 } });
    fail(400, 'That code is incorrect. Please check it and try again.');
  }
  await rec.deleteOne();
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */
function parseAddress(a = {}) {
  const x = {
    name: str(a.name, 80),
    phone: str(a.phone, 16).replace(/[\s-]/g, ''),
    line1: str(a.line1, 150),
    line2: str(a.line2, 150),
    city: str(a.city, 60),
    state: str(a.state, 60),
    pincode: str(a.pincode, 6),
  };
  if (x.name.length < 2) fail(400, 'Enter the recipient name.');
  if (!/^(\+91)?[6-9]\d{9}$/.test(x.phone)) fail(400, 'Enter a valid 10-digit Indian mobile number.');
  if (x.line1.length < 5) fail(400, 'Enter the house / street address.');
  if (x.city.length < 2) fail(400, 'Enter the city.');
  if (x.state.length < 2) fail(400, 'Enter the state.');
  if (!/^[1-9]\d{5}$/.test(x.pincode)) fail(400, 'Enter a valid 6-digit PIN code.');
  return x;
}

function parseProduct(body, { partial = false } = {}) {
  const out = {};
  const need = (k) => !partial || body[k] !== undefined;
  if (need('name')) {
    out.name = str(body.name, 120);
    if (out.name.length < 2) fail(400, 'Product name is required.');
  }
  if (need('category')) {
    out.category = str(body.category, 60);
    if (!out.category) fail(400, 'Category is required.');
  }
  if (need('price')) {
    out.price = Number(body.price);
    if (!Number.isFinite(out.price) || out.price < 1 || out.price > 1e6) fail(400, 'Enter a valid price.');
  }
  if (body.mrp !== undefined && body.mrp !== '') {
    out.mrp = Number(body.mrp);
    if (!Number.isFinite(out.mrp) || out.mrp < 0) fail(400, 'Enter a valid MRP.');
  } else if (body.mrp === '') out.mrp = 0;
  if (need('stock')) {
    out.stock = Number(body.stock);
    if (!Number.isInteger(out.stock) || out.stock < 0 || out.stock > 1e6) fail(400, 'Stock must be a whole number (0 or more).');
  }
  for (const [k, max] of [['size', 40], ['badge', 24], ['shortDescription', 200], ['details', 2000], ['uses', 1000]]) {
    if (body[k] !== undefined) out[k] = str(body[k], max);
  }
  if (body.active !== undefined) out.active = body.active === true || body.active === 'true';
  if (body.image !== undefined) {
    const img = str(body.image, 500);
    if (img) {
      let u;
      try {
        u = new URL(img);
      } catch {
        fail(400, 'Image URL is not valid.');
      }
      if (u.protocol !== 'https:') fail(400, 'Image URL must start with https://');
    }
    out.image = img;
  }
  if (out.mrp && out.price && out.mrp < out.price) out.mrp = out.price;
  return out;
}

/* ------------------------------------------------------------------ */
/* Footer map (MAP_URL)                                                */
/* ------------------------------------------------------------------ */
/** Turns almost any pasted Google Maps URL into an embeddable one. */
function deriveMapEmbed(url) {
  if (!url) return '';
  if (/google\.[a-z.]+\/maps\/embed/i.test(url)) return url; // already an "Embed a map" link
  let q = '';
  const pin = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); // exact pin of a place link
  const view = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); // map centre
  const place = url.match(/\/maps\/place\/([^/@?]+)/);
  let qParam = '';
  try {
    const u = new URL(url);
    qParam = u.searchParams.get('q') || u.searchParams.get('query') || '';
  } catch {
    /* not a valid URL */
  }
  if (pin) q = `${pin[1]},${pin[2]}`;
  else if (qParam) q = qParam;
  else if (place) q = decodeURIComponent(place[1].replace(/\+/g, ' '));
  else if (view) q = `${view[1]},${view[2]}`;
  return q ? `https://www.google.com/maps?q=${encodeURIComponent(q)}&z=15&output=embed` : '';
}

async function resolveMap() {
  const raw = envStr('MAP_URL');
  const fallbackQuery = COMPANY.address || 'India';
  if (!raw) {
    COMPANY.mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallbackQuery)}`;
    COMPANY.mapEmbed = `https://www.google.com/maps?q=${encodeURIComponent(fallbackQuery)}&output=embed`;
    return;
  }
  COMPANY.mapLink = raw;
  let full = raw;
  // Short share links (maps.app.goo.gl/...) cannot be embedded, so follow them to the long URL first.
  if (/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(raw)) {
    try {
      const r = await fetch(raw, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (r.url) full = r.url;
    } catch (e) {
      console.warn('MAP_URL short link could not be expanded:', e.message);
    }
  }
  COMPANY.mapEmbed = deriveMapEmbed(full) || `https://www.google.com/maps?q=${encodeURIComponent(fallbackQuery)}&output=embed`;
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */
const orderNumber = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `CX${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};
const restock = (items) =>
  Promise.all(items.map((i) => (i.product ? Product.updateOne({ _id: i.product }, { $inc: { stock: i.qty, sold: -i.qty } }) : null)));

/** Cancels atomically (only once) and puts stock back. Returns the updated order or null. */
async function cancelOrder(filter, by, reason) {
  const o = await Order.findOneAndUpdate(
    filter,
    {
      $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: by, cancelReason: reason, paymentStatus: 'pending' },
      $push: { history: { status: 'cancelled', note: reason || `Cancelled by ${by}`, at: new Date() } },
    },
    { returnDocument: 'after' },
  );
  if (o) await restock(o.items);
  return o;
}

/** Confirmation to the customer + notification to the company, both with full product details. */
async function sendOrderEmails(orderId) {
  const order = await Order.findById(orderId);
  if (!order) return null;
  const customer = await User.findById(order.customer).select('name email phone');
  if (!customer) return null;
  const trackUrl = `${SITE_URL}/#/order/${order._id}`;
  const addr = `<p style="margin:14px 0 4px"><b>Delivering to</b><br>${addressLines(order.shippingAddress)}</p>`;
  const meta = `<p style="margin:0 0 4px;color:#4d6b70">Order <b style="color:#0a2a33">${esc(order.orderNumber)}</b> &middot; placed ${esc(placedAt(order.createdAt))}</p>`;

  const toCustomer = sendWithRetry({
    to: customer.email,
    subject: `Order confirmed: ${order.orderNumber} - CLEANXO`,
    html: mailLayout(
      'Thank you for your order!',
      `<p>Hi ${esc(customer.name)}, we have received your order and our team is getting it ready.</p>${meta}${orderTable(order)}${addr}
       <p style="margin:14px 0 4px"><b>Payment:</b> cash on delivery &middot; <b>Expected delivery:</b> 2 to 5 working days</p>
       ${mailButton(trackUrl, 'Track your order')}
       <p style="color:#6b8186;font-size:12px">You can cancel from My orders until the order ships. Questions? Just reply to this email or write to ${esc(COMPANY.email || 'our care team')}.</p>`,
    ),
  });
  const toCompany = COMPANY.email
    ? sendWithRetry({
        to: COMPANY.email,
        replyTo: customer.email,
        subject: `New order ${order.orderNumber} - ${inr(order.total)} - ${customer.name}`,
        html: mailLayout(
          'New order received',
          `${meta}<p><b>Customer:</b> ${esc(customer.name)} &lt;${esc(customer.email)}&gt;${customer.phone ? ' &middot; ' + esc(customer.phone) : ''}</p>${orderTable(order)}${addr}
           <p style="margin:14px 0 4px"><b>Payment:</b> cash on delivery (collect ${inr(order.total)})</p>
           ${mailButton(`${SITE_URL}/#/admin`, 'Open admin panel')}`,
        ),
      })
    : Promise.resolve(false);
  const [okCustomer, okCompany] = await Promise.all([toCustomer, toCompany]);
  if (!COMPANY.email) console.error('[mail] COMPANY_EMAIL is not set, so the company was not notified about the order.');
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'emails.customer': okCustomer ? 'sent' : 'failed', 'emails.company': okCompany ? 'sent' : 'failed', 'emails.lastAttemptAt': new Date() } },
  );
  return { customer: okCustomer, company: okCompany };
}

async function notifyStatus(order) {
  const customer = await User.findById(order.customer).select('email name');
  if (!customer) return;
  const text = STATUS_TEXT[order.status] || order.status;
  await sendMailQuiet({
    to: customer.email,
    subject: `CLEANXO order ${order.orderNumber}: ${text}`,
    html: mailLayout(
      `Your order is now: ${text}`,
      `<p>Hi ${esc(customer.name)}, the status of order <b>${esc(order.orderNumber)}</b> has changed to <b>${esc(text)}</b>.</p>
       ${order.status === 'cancelled' && order.cancelReason ? `<p>Reason: ${esc(order.cancelReason)}</p>` : ''}${orderTable(order)}`,
    ),
  });
}

/* ------------------------------------------------------------------ */
/* App + middleware                                                    */
/* ------------------------------------------------------------------ */
const app = express();
if (isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        frameSrc: ["'self'", 'https://www.google.com', 'https://maps.google.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
  }),
);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || CLIENT_URLS.includes(origin)) return cb(null, true);
      return cb(new HttpError(403, 'Origin not allowed'));
    },
  }),
);
app.use(express.json({ limit: '100kb' }));

const limiter = (limit, windowMs, message) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { message } });
app.use('/api', limiter(400, 15 * 60 * 1000, 'Too many requests. Please slow down.'));
const loginLimiter = limiter(10, 15 * 60 * 1000, 'Too many sign-in attempts. Try again in 15 minutes.');
const otpLimiter = limiter(8, 15 * 60 * 1000, 'Too many code requests. Try again in 15 minutes.');
const formLimiter = limiter(10, 60 * 60 * 1000, 'Too many messages sent. Try again later.');

/* ----------------------------- public ------------------------------ */
app.get('/api/health', (req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1, r2: r2Ready }));

app.get('/api/config', (req, res) =>
  res.json({
    freeShippingMin: FREE_SHIPPING_MIN,
    shippingFee: SHIPPING_FEE,
    maxQty: MAX_QTY_PER_ITEM,
    company: COMPANY,
  }),
);

app.get(
  '/api/products',
  wrap(async (req, res) => {
    res.json(await Product.find({ active: true }).sort({ createdAt: -1 }).lean());
  }),
);
app.get(
  '/api/products/:id',
  wrap(async (req, res) => {
    if (!validId(req.params.id)) fail(404, 'Product not found.');
    const p = await Product.findOne({ _id: req.params.id, active: true }).lean();
    if (!p) fail(404, 'Product not found.');
    res.json(p);
  }),
);

app.post(
  '/api/contact',
  formLimiter,
  wrap(async (req, res) => {
    const name = str(req.body.name, 80);
    const email = normEmail(req.body.email);
    const message = str(req.body.message, 2000);
    if (name.length < 2) fail(400, 'Please enter your name.');
    if (!isEmail(email)) fail(400, 'Please enter a valid email address.');
    if (message.length < 10) fail(400, 'Please write a little more so we can help.');
    await sendMail({
      to: COMPANY.email,
      replyTo: email,
      subject: `[Website contact] ${name}`,
      html: mailLayout('New contact message', `<p><b>${esc(name)}</b> (${esc(email)})</p><p>${esc(message).replace(/\n/g, '<br>')}</p>`),
    });
    res.json({ message: 'Thanks! Our care team will reply by email soon.' });
  }),
);

/* ------------------------------ auth ------------------------------- */
app.post(
  '/api/auth/send-otp',
  otpLimiter,
  wrap(async (req, res) => {
    const email = normEmail(req.body.email);
    const purpose = req.body.purpose;
    if (!isEmail(email)) fail(400, 'Enter a valid email address.');
    if (!['register', 'reset'].includes(purpose)) fail(400, 'Invalid request.');
    const user = await User.findOne({ email }).select('_id');
    if (purpose === 'register' && user) fail(409, 'An account with this email already exists. Please sign in instead.');
    // For password resets we answer the same way whether or not the account exists (no account enumeration).
    if (purpose === 'reset' && !user) return res.json({ message: 'If that email has an account, a code is on its way.' });
    await issueOtp(email, purpose);
    res.json({ message: 'Verification code sent.' });
  }),
);

app.post(
  '/api/auth/register',
  loginLimiter,
  wrap(async (req, res) => {
    const name = str(req.body.name, 80);
    const email = normEmail(req.body.email);
    const phone = str(req.body.phone, 16).replace(/[\s-]/g, '');
    const { password, otp } = req.body;
    if (name.length < 2) fail(400, 'Enter your full name.');
    if (!isEmail(email)) fail(400, 'Enter a valid email address.');
    if (phone && !/^(\+91)?[6-9]\d{9}$/.test(phone)) fail(400, 'Enter a valid 10-digit mobile number or leave it blank.');
    if (!strongPassword(password)) fail(400, 'Password needs at least 8 characters with a letter and a number.');
    await checkOtp(email, 'register', otp);
    let user;
    try {
      user = await User.create({ name, email, phone, passwordHash: await bcrypt.hash(password, 12), role: 'customer' });
    } catch (e) {
      if (e.code === 11000) fail(409, 'An account with this email already exists. Please sign in instead.');
      throw e;
    }
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  }),
);

app.post(
  '/api/auth/login',
  loginLimiter,
  wrap(async (req, res) => {
    const email = normEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = isEmail(email) ? await User.findOne({ email }) : null;
    // Always run a bcrypt compare so response time does not reveal whether the account exists.
    const ok = await bcrypt.compare(password.slice(0, 72), user?.passwordHash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) fail(401, 'Incorrect email or password.');
    res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

app.post(
  '/api/auth/reset-password',
  loginLimiter,
  wrap(async (req, res) => {
    const email = normEmail(req.body.email);
    if (!isEmail(email)) fail(400, 'Enter a valid email address.');
    if (!strongPassword(req.body.password)) fail(400, 'Password needs at least 8 characters with a letter and a number.');
    const user = await User.findOne({ email });
    if (!user) fail(400, 'That code is invalid or has expired. Request a new one.');
    await checkOtp(email, 'reset', req.body.otp);
    user.passwordHash = await bcrypt.hash(req.body.password, 12);
    user.passwordChangedAt = new Date();
    await user.save();
    res.json({ message: 'Password updated. You can sign in now.' });
  }),
);

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch(
  '/api/auth/me',
  requireAuth,
  wrap(async (req, res) => {
    const name = str(req.body.name, 80);
    const phone = str(req.body.phone, 16).replace(/[\s-]/g, '');
    if (name.length < 2) fail(400, 'Enter your full name.');
    if (phone && !/^(\+91)?[6-9]\d{9}$/.test(phone)) fail(400, 'Enter a valid 10-digit mobile number.');
    const a = req.body.address || {};
    const address = {
      name: str(a.name, 80),
      phone: str(a.phone, 16).replace(/[\s-]/g, ''),
      line1: str(a.line1, 150),
      line2: str(a.line2, 150),
      city: str(a.city, 60),
      state: str(a.state, 60),
      pincode: str(a.pincode, 6),
    };
    if (address.pincode && !/^[1-9]\d{5}$/.test(address.pincode)) fail(400, 'Enter a valid 6-digit PIN code.');
    req.user.name = name;
    req.user.phone = phone;
    req.user.address = address;
    await req.user.save();
    res.json({ user: publicUser(req.user) });
  }),
);

app.post(
  '/api/auth/change-password',
  requireAuth,
  loginLimiter,
  wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || !(await bcrypt.compare(currentPassword.slice(0, 72), req.user.passwordHash))) {
      fail(400, 'Your current password is incorrect.');
    }
    if (!strongPassword(newPassword)) fail(400, 'New password needs at least 8 characters with a letter and a number.');
    req.user.passwordHash = await bcrypt.hash(newPassword, 12);
    req.user.passwordChangedAt = new Date();
    await req.user.save();
    res.json({ token: signToken(req.user), message: 'Password changed.' });
  }),
);

/* ----------------------------- orders ------------------------------ */
app.get(
  '/api/orders/my',
  requireAuth,
  wrap(async (req, res) => {
    res.json(await Order.find({ customer: req.user._id }).sort({ createdAt: -1 }).limit(100).lean());
  }),
);

app.get(
  '/api/orders/:id',
  requireAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) fail(404, 'Order not found.');
    const o = await Order.findOne({ _id: req.params.id, customer: req.user._id }).lean();
    if (!o) fail(404, 'Order not found.');
    res.json(o);
  }),
);

app.post(
  '/api/orders',
  requireAuth,
  wrap(async (req, res) => {
    const raw = Array.isArray(req.body.items) ? req.body.items : [];
    if (!raw.length || raw.length > 30) fail(400, 'Your bag is empty.');
    const wanted = new Map();
    for (const it of raw) {
      const id = String(it?.productId || '');
      const qty = Number(it?.qty);
      if (!validId(id) || !Number.isInteger(qty) || qty < 1) fail(400, 'One of the items in your bag is invalid.');
      wanted.set(id, (wanted.get(id) || 0) + qty);
    }
    for (const q of wanted.values()) if (q > MAX_QTY_PER_ITEM) fail(400, `You can order up to ${MAX_QTY_PER_ITEM} units of one product.`);
    const shippingAddress = parseAddress(req.body.shippingAddress);

    const products = await Product.find({ _id: { $in: [...wanted.keys()] }, active: true });
    if (products.length !== wanted.size) fail(409, 'Some products in your bag are no longer available. Please review your bag.');

    // Reserve stock atomically per product; undo everything if any line fails.
    const reserved = [];
    let order;
    try {
      for (const p of products) {
        const qty = wanted.get(String(p._id));
        const r = await Product.updateOne({ _id: p._id, active: true, stock: { $gte: qty } }, { $inc: { stock: -qty, sold: qty } });
        if (!r.modifiedCount) fail(409, `Sorry, ${p.name} is low on stock. Please reduce the quantity or remove it.`);
        reserved.push({ product: p._id, qty });
      }
      const items = products.map((p) => ({
        product: p._id,
        name: p.name,
        image: p.image,
        size: p.size,
        price: p.price,
        qty: wanted.get(String(p._id)),
      }));
      const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
      const shipping = subtotal >= FREE_SHIPPING_MIN ? 0 : SHIPPING_FEE;
      order = await Order.create({
        orderNumber: orderNumber(),
        customer: req.user._id,
        items,
        subtotal,
        shipping,
        total: subtotal + shipping,
        shippingAddress,
        status: 'pending',
        history: [{ status: 'pending', note: 'Order placed', at: new Date() }],
      });
    } catch (e) {
      await restock(reserved);
      throw e;
    }

    res.status(201).json(order);
    // Emails are sent after the response so checkout stays fast. The result is stored on the order.
    sendOrderEmails(order._id).catch((e) => console.error('Order emails crashed:', e.message));
  }),
);

app.patch(
  '/api/orders/:id/cancel',
  requireAuth,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) fail(404, 'Order not found.');
    const reason = str(req.body.reason, 300) || 'Cancelled by customer';
    const o = await cancelOrder(
      { _id: req.params.id, customer: req.user._id, status: { $in: CUSTOMER_CANCELLABLE } },
      'customer',
      reason,
    );
    if (!o) fail(409, 'This order can no longer be cancelled because it has already been shipped or closed. Contact support for help.');
    notifyStatus(o);
    sendMailQuiet({
      to: COMPANY.email,
      subject: `Order ${o.orderNumber} cancelled by customer`,
      html: mailLayout('Order cancelled', `<p>${esc(req.user.name)} (${esc(req.user.email)}) cancelled order <b>${esc(o.orderNumber)}</b>.</p><p>Reason: ${esc(reason)}</p>`),
    });
    res.json(o);
  }),
);

app.post(
  '/api/support',
  requireAuth,
  formLimiter,
  wrap(async (req, res) => {
    const subject = str(req.body.subject, 120);
    const message = str(req.body.message, 3000);
    const ref = str(req.body.orderNumber, 30);
    if (subject.length < 3) fail(400, 'Add a short subject.');
    if (message.length < 10) fail(400, 'Please describe the issue in a little more detail.');
    await sendMail({
      to: COMPANY.email,
      replyTo: req.user.email,
      subject: `[Support] ${subject}${ref ? ` (${ref})` : ''}`,
      html: mailLayout(
        'Customer support request',
        `<p><b>${esc(req.user.name)}</b> &lt;${esc(req.user.email)}&gt;${req.user.phone ? ' &middot; ' + esc(req.user.phone) : ''}</p>
         ${ref ? `<p>Order: <b>${esc(ref)}</b></p>` : ''}<p>${esc(message).replace(/\n/g, '<br>')}</p>`,
      ),
    });
    res.json({ message: 'Your message has been sent to our care team. We will reply by email.' });
  }),
);

/* ------------------------------ admin ------------------------------ */
app.get(
  '/api/admin/dashboard',
  requireAdmin,
  wrap(async (req, res) => {
    const TZ = 'Asia/Kolkata';
    const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });
    const days = Array.from({ length: 14 }, (_, i) => dayKey(new Date(Date.now() - (13 - i) * 864e5)));
    const since = new Date(Date.now() - 15 * 864e5);
    const notCancelled = { status: { $ne: 'cancelled' } };

    const [byStatus, salesDaily, top, inv, lowStock, customers, totals] = await Promise.all([
      Order.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$total' } } }]),
      Order.aggregate([
        { $match: { ...notCancelled, createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: notCancelled },
        { $unwind: '$items' },
        { $group: { _id: '$items.name', units: { $sum: '$items.qty' }, revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } } } },
        { $sort: { units: -1 } },
        { $limit: 5 },
      ]),
      Product.aggregate([
        {
          $group: {
            _id: null,
            products: { $sum: 1 },
            active: { $sum: { $cond: ['$active', 1, 0] } },
            units: { $sum: '$stock' },
            value: { $sum: { $multiply: ['$stock', '$price'] } },
            outOfStock: { $sum: { $cond: [{ $eq: ['$stock', 0] }, 1, 0] } },
            low: { $sum: { $cond: [{ $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', 10] }] }, 1, 0] } },
          },
        },
      ]),
      Product.find({ stock: { $lte: 10 } }).sort({ stock: 1 }).limit(8).select('name stock size active').lean(),
      User.countDocuments({ role: 'customer' }),
      Order.aggregate([
        { $match: notCancelled },
        { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      ]),
    ]);

    const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let collected = 0;
    for (const s of byStatus) {
      statusCounts[s._id] = s.n;
      if (s._id === 'delivered') collected = s.amount;
    }
    const dailyMap = new Map(salesDaily.map((d) => [d._id, d]));
    const salesByDay = days.map((d) => ({ date: d, revenue: dailyMap.get(d)?.revenue || 0, orders: dailyMap.get(d)?.orders || 0 }));
    const t = totals[0] || { revenue: 0, orders: 0 };
    const i = inv[0] || { products: 0, active: 0, units: 0, value: 0, outOfStock: 0, low: 0 };
    res.json({
      totals: {
        revenue: t.revenue,
        collected,
        orders: Object.values(statusCounts).reduce((a, b) => a + b, 0),
        avgOrderValue: t.orders ? Math.round(t.revenue / t.orders) : 0,
        customers,
      },
      statusCounts,
      active: statusCounts.pending + statusCounts.confirmed + statusCounts.shipped + statusCounts.out_for_delivery,
      salesByDay,
      topProducts: top.map((x) => ({ name: x._id, units: x.units, revenue: x.revenue })),
      inventory: { products: i.products, active: i.active, units: i.units, value: i.value, outOfStock: i.outOfStock, lowStock: i.low },
      lowStock,
    });
  }),
);

app.get(
  '/api/admin/orders',
  requireAdmin,
  wrap(async (req, res) => {
    const filter = {};
    const status = str(req.query.status, 30);
    if (STATUSES.includes(status)) filter.status = status;
    const q = str(req.query.q, 60);
    if (q) {
      const rx = new RegExp(escRx(q), 'i');
      const users = await User.find({ $or: [{ email: rx }, { name: rx }] }).select('_id').limit(100);
      filter.$or = [{ orderNumber: rx }, { 'shippingAddress.name': rx }, { customer: { $in: users.map((u) => u._id) } }];
    }
    res.json(await Order.find(filter).populate('customer', 'name email phone').sort({ createdAt: -1 }).limit(300).lean());
  }),
);

app.patch(
  '/api/admin/orders/:id',
  requireAdmin,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) fail(404, 'Order not found.');
    const next = str(req.body.status, 30);
    if (!STATUSES.includes(next)) fail(400, 'Unknown status.');
    const order = await Order.findById(req.params.id);
    if (!order) fail(404, 'Order not found.');
    if (['delivered', 'cancelled'].includes(order.status)) fail(409, `This order is already ${order.status} and can no longer be changed.`);
    if (next === order.status) return res.json(order);

    let updated;
    if (next === 'cancelled') {
      updated = await cancelOrder(
        { _id: order._id, status: order.status },
        'admin',
        str(req.body.reason, 300) || 'Cancelled by CLEANXO',
      );
    } else {
      if (FLOW.indexOf(next) < FLOW.indexOf(order.status)) fail(400, 'An order cannot move back to an earlier status.');
      const set = { status: next };
      if (next === 'delivered') {
        set.deliveredAt = new Date();
        set.paymentStatus = 'paid';
      }
      updated = await Order.findOneAndUpdate(
        { _id: order._id, status: order.status },
        { $set: set, $push: { history: { status: next, note: STATUS_TEXT[next], at: new Date() } } },
        { returnDocument: 'after' },
      );
    }
    if (!updated) fail(409, 'The order was changed by someone else. Refresh and try again.');
    notifyStatus(updated);
    res.json(updated);
  }),
);

app.post(
  '/api/admin/orders/:id/resend-emails',
  requireAdmin,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) fail(404, 'Order not found.');
    const result = await sendOrderEmails(req.params.id);
    if (!result) fail(404, 'Order not found.');
    res.json(result);
  }),
);

app.get(
  '/api/admin/products',
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await Product.find().sort({ createdAt: -1 }).lean());
  }),
);

app.post(
  '/api/admin/products',
  requireAdmin,
  upload.single('image'),
  wrap(async (req, res) => {
    const data = parseProduct(req.body);
    if (req.file) {
      const saved = await storeImage(req.file);
      data.image = saved.url;
      data.imageKey = saved.key;
    }
    const p = await Product.create(data);
    res.status(201).json(p);
  }),
);

app.put(
  '/api/admin/products/:id',
  requireAdmin,
  upload.single('image'),
  wrap(async (req, res) => {
    if (!validId(req.params.id)) fail(404, 'Product not found.');
    const p = await Product.findById(req.params.id).select('+imageKey');
    if (!p) fail(404, 'Product not found.');
    const data = parseProduct(req.body, { partial: true });
    let oldKey = '';
    if (req.file) {
      const saved = await storeImage(req.file);
      oldKey = p.imageKey;
      data.image = saved.url;
      data.imageKey = saved.key;
    } else if (data.image !== undefined && data.image !== p.image) {
      oldKey = p.imageKey;
      data.imageKey = '';
    }
    p.set(data);
    await p.save();
    deleteImageQuiet(oldKey);
    res.json(p);
  }),
);

app.delete(
  '/api/admin/products/:id',
  requireAdmin,
  wrap(async (req, res) => {
    if (!validId(req.params.id)) fail(404, 'Product not found.');
    const p = await Product.findByIdAndDelete(req.params.id).select('+imageKey');
    if (!p) fail(404, 'Product not found.');
    deleteImageQuiet(p.imageKey);
    res.status(204).end();
  }),
);

/* ------------------------- static + errors ------------------------- */
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));

app.get('/', (req, res) => res.json({ name: 'CLEANXO API', ok: true }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'Image must be smaller than 5 MB.' : 'Upload failed. Check the file and try again.' });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid request body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ message: 'Request is too large.' });
  if (err.name === 'ValidationError') return res.status(400).json({ message: Object.values(err.errors)[0]?.message || 'Invalid data.' });
  if (err.name === 'CastError') return res.status(400).json({ message: 'Invalid value.' });
  if (err.code === 11000) return res.status(409).json({ message: 'That already exists.' });
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on our side. Please try again.' });
});

/* ------------------------------------------------------------------ */
/* Seed data + start                                                   */
/* ------------------------------------------------------------------ */
const SEED_PRODUCTS = [
  { name: 'Sparkle Floor Cleanser', category: 'Floor Care', size: '1 L', price: 189, mrp: 229, stock: 120, badge: 'Bestseller', shortDescription: 'Lemon-fresh shine for every floor.', details: 'A pH-balanced floor cleaner that lifts dirt and sticky spills without leaving a film. Dries streak-free and leaves a light citrus fragrance for hours.', uses: 'Tiles, marble, granite, vinyl and sealed wood floors. Add 2 caps to a bucket of water.', image: 'https://images.unsplash.com/photo-1585421514738-01798e348b17?auto=format&fit=crop&w=800&q=80' },
  { name: 'Power Bathroom Cleaner', category: 'Bathroom', size: '500 ml', price: 169, mrp: 199, stock: 90, badge: 'New', shortDescription: 'Cuts through soap scum and hard-water stains.', details: 'Fast-acting formula that removes limescale, soap scum and rust marks from fittings and tiles, leaving a bright finish.', uses: 'Sinks, taps, tubs, shower glass and wall tiles. Spray, wait 2 minutes, wipe or rinse.', image: 'https://images.unsplash.com/photo-1583947582886-f40ec95dd752?auto=format&fit=crop&w=800&q=80' },
  { name: 'Active Toilet Gel', category: 'Toilet Care', size: '500 ml', price: 145, mrp: 175, stock: 150, badge: 'Top rated', shortDescription: 'Clings under the rim for a deeper clean.', details: 'Thick gel that clings to the bowl surface to remove stains and kill 99.9% of germs, with a fresh ocean scent.', uses: 'Toilet bowls and urinals. Apply under the rim, leave for 10 minutes, brush and flush.', image: 'https://images.unsplash.com/photo-1585421514284-efb74c2b69c1?auto=format&fit=crop&w=800&q=80' },
  { name: 'Cloud Soft Detergent Powder', category: 'Laundry', size: '2 kg', price: 299, mrp: 349, stock: 80, badge: 'Value pack', shortDescription: 'Gentle on fabric, tough on stains.', details: 'Low-foam, fast-dissolving powder that removes everyday stains while keeping colours bright and fabrics soft.', uses: 'Front-load and top-load machines and hand wash. Use one scoop per 6 kg load.', image: 'https://images.unsplash.com/photo-1604335399105-a0c585fd81a1?auto=format&fit=crop&w=800&q=80' },
  { name: 'Aloe Care Hand Wash', category: 'Personal Care', size: '300 ml', price: 119, mrp: 139, stock: 200, badge: 'Gentle', shortDescription: 'Soft hands, clean confidence.', details: 'Mild liquid hand wash with aloe vera that cleans without drying your skin. Dermatologically tested.', uses: 'Everyday hand washing for the whole family.', image: 'https://images.unsplash.com/photo-1584305574647-0cc949a2bb9f?auto=format&fit=crop&w=800&q=80' },
  { name: 'Citrus Dishwash Gel', category: 'Kitchen', size: '500 ml', price: 135, mrp: 155, stock: 110, badge: 'Fresh', shortDescription: 'Shine through every greasy plate.', details: 'Concentrated gel with natural citrus extracts that cuts grease quickly, so a few drops go a long way.', uses: 'Utensils, cookware, glassware and kitchen counters.', image: 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=800&q=80' },
  { name: 'Herbal Bathing Soap (Pack of 4)', category: 'Personal Care', size: '4 x 100 g', price: 149, mrp: 180, stock: 140, badge: '', shortDescription: 'Neem and tulsi for fresh, clean skin.', details: 'A creamy bathing bar enriched with neem and tulsi that cleanses gently and leaves skin feeling refreshed.', uses: 'Daily bathing for all skin types.', image: '' },
  { name: 'Glass & Surface Cleaner', category: 'Home Care', size: '500 ml', price: 129, mrp: 149, stock: 7, badge: '', shortDescription: 'Streak-free shine on glass and mirrors.', details: 'Quick-drying spray that removes fingerprints, dust and smudges without leaving streaks.', uses: 'Windows, mirrors, glass tables, steel and laminate surfaces.', image: '' },
];

async function seed() {
  const adminEmail = normEmail(envStr('ADMIN_EMAIL'));
  if (isEmail(adminEmail) && !(await User.exists({ email: adminEmail }))) {
    if (!strongPassword(env.ADMIN_PASSWORD)) {
      console.warn('ADMIN_PASSWORD missing or weak (min 8 chars with letters + numbers). Admin account not created.');
    } else if (isProd && isPlaceholder(env.ADMIN_PASSWORD)) {
      console.error('ADMIN_PASSWORD is still a sample value. Set a real one before the first production start. Admin account not created.');
    } else {
      await User.create({ name: 'CLEANXO Admin', email: adminEmail, passwordHash: await bcrypt.hash(env.ADMIN_PASSWORD, 12), role: 'admin' });
      console.log(`Admin account created: ${adminEmail}`);
    }
  }
  if ((await Product.countDocuments()) === 0) {
    await Product.insertMany(SEED_PRODUCTS);
    console.log(`Seeded ${SEED_PRODUCTS.length} sample products.`);
  }
}

async function start() {
  if (isPlaceholder(envStr('MONGODB_URI'))) {
    console.error('\nFATAL: MONGODB_URI in .env is still a dummy value.\nCreate a free cluster at https://cloud.mongodb.com, allow your IP in Network Access, and paste the connection string.\n');
    process.exit(1);
  }
  try {
    await mongoose.connect(envStr('MONGODB_URI'), { serverSelectionTimeoutMS: 15000 });
    console.log('MongoDB connected');
    await Promise.all([User.init(), Order.init(), Otp.init(), Product.init()]);
    await seed();
  } catch (e) {
    console.error('FATAL: could not connect to MongoDB Atlas:', e.message);
    process.exit(1);
  }
  await resolveMap();
  if (!COMPANY.email) console.warn('COMPANY_EMAIL is not set: order and support emails to the company will not be sent.');
  if (isProd && CLIENT_URLS.some((u) => /localhost/.test(u))) console.warn('CLIENT_URL still points to localhost. Set it to your Vercel URL or the browser will be blocked by CORS.');
  if (isPlaceholder(env.GOOGLE_APPS_SCRIPT_URL)) console.warn('Email: GOOGLE_APPS_SCRIPT_URL not set - emails (and OTP codes) are printed to this console in development.');
  if (!r2Ready) console.warn('Images: Cloudflare R2 not configured - product image upload disabled (image URLs still work).');
  app.listen(PORT, () => console.log(`CLEANXO API listening on port ${PORT}`));
}
start();