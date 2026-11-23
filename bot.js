'use strict';
/*
 * Telegram Stars Refer & Earn Bot — built for Render
 *  - users / balances / referrals / settings live in PostgreSQL (survive restarts)
 *  - Telegram's Bot API cannot send Stars to users, so withdrawals are REQUESTS:
 *    the admin receives each request with ✅ Paid / ❌ Reject buttons, sends the Stars
 *    from their own Telegram account, and taps Paid. Only then is the user told and
 *    the payout channel updated. Reject refunds the balance.
 */
const http = require('http');
const he = require('he');
const { Pool } = require('pg');
const { toHTML } = require('@telegraf/entity');
const { Telegraf, session, Scenes } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { BaseScene: Scene, Stage } = Scenes;

/* ====================================================================
 *  CONFIG  (secrets come from Render environment variables)
 * ==================================================================== */
const CONFIG = {
  BOT_TOKEN: (process.env.BOT_TOKEN || 'PASTE_NEW_BOT_TOKEN_HERE').trim(),
  DATABASE_URL: (process.env.DATABASE_URL || '').trim(),
  DATABASE_SSL: process.env.DATABASE_SSL === 'true', // true only if you use Render's EXTERNAL db url
  MAX_WITHDRAW_PER_TX: 0 // max Stars per withdrawal request, 0 = no limit
};

if (CONFIG.BOT_TOKEN.startsWith('PASTE_') || !CONFIG.DATABASE_URL) {
  console.error('Set the BOT_TOKEN and DATABASE_URL environment variables first.');
  process.exit(1);
}

// default settings (seed). After first start the live copy is kept in the database.
let data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));

const options = [
  'Welcome Message', 'Earn More', 'Bonus', 'Refer', 'Withdraw', 'Currency', 'Payout Channel',
  'Broad Speed', 'Add Check', 'Remove Check', 'Add Admin', 'Remove Admin', 'Bot Off Text', 'On / Off Bot'
];

const slug = (w) => w.replace(/ /g, '-').toLowerCase();
const cb = (w) => 'adhymn_' + slug(w);
const chunk2 = (arr) => { const r = []; for (let i = 0; i < arr.length; i += 2) r.push(arr.slice(i, i + 2)); return r; };
const adminRows = () => chunk2(options.map((w) => ({ text: w, callback_data: cb(w) })));

const isAdmin = (id) => data.bot_admin.includes(id);
const whole = (n) => Math.round(Number(n) || 0); // Stars are whole numbers
const isInt = (s) => /^\d+$/.test(String(s).trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ====================================================================
 *  PostgreSQL
 * ==================================================================== */
const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  ssl: CONFIG.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 8
});
pool.on('error', (e) => console.log('DB pool error:', e.message));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}',
      reset BOOLEAN NOT NULL DEFAULT false,
      ref_count INT GENERATED ALWAYS AS (
        CASE WHEN jsonb_typeof(data->'ref') = 'array' THEN jsonb_array_length(data->'ref') ELSE 0 END
      ) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS users_ref_idx ON users (ref_count DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY, user_id BIGINT, address TEXT, amount NUMERIC,
      txid TEXT, status TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function loadSettings() {
  const r = await pool.query("SELECT value FROM settings WHERE key = 'config'");
  const seed = data; // values from data.json
  if (r.rows[0]) {
    const saved = r.rows[0].value;
    data = { ...seed, ...saved, but: seed.but }; // button layout always comes from data.json
    data.bot_admin = [...new Set([...seed.bot_admin, ...(data.bot_admin || [])])]; // seed admins can't be locked out
    // raise "seed_version" in data.json to make the texts in data.json replace the saved ones
    if ((seed.seed_version || 0) > (saved.seed_version || 0)) {
      data.welcome = seed.welcome;
      data.earn = seed.earn;
      data.seed_version = seed.seed_version;
      await saveData();
    }
  } else await saveData();
}
const saveData = () => pool.query(
  "INSERT INTO settings(key, value) VALUES('config', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [data]);

async function getUserData(id) {
  const r = await pool.query('SELECT data FROM users WHERE id = $1', [id]);
  return r.rows[0] ? r.rows[0].data : {};
}

/*
 * Safe read-modify-write on one user inside a transaction with a row lock.
 * fn(user, client) mutates `user` in place and may return a value; use `client` for other queries in the same transaction. If the user doesn't exist,
 * fn gets null (or a new empty user when create = true).
 */
async function withUser(id, fn, create = false) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let r = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [id]);
    let u = null;
    if (r.rows.length) u = r.rows[0].data;
    else if (create) {
      await c.query('INSERT INTO users(id, data) VALUES($1, $2) ON CONFLICT (id) DO NOTHING', [id, {}]);
      r = await c.query('SELECT data FROM users WHERE id = $1 FOR UPDATE', [id]);
      u = r.rows[0].data;
    }
    const result = await fn(u, c); // c = this transaction's connection
    if (u) await c.query('UPDATE users SET data = $2 WHERE id = $1', [id, u]);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Telegraf session (scene state) stored in the database so restarts don't break flows
const pgSessionStore = {
  async get(key) { const r = await pool.query('SELECT value FROM sessions WHERE key = $1', [key]); return r.rows[0] ? r.rows[0].value : undefined; },
  async set(key, value) { await pool.query('INSERT INTO sessions(key, value) VALUES($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, value]); },
  async delete(key) { await pool.query('DELETE FROM sessions WHERE key = $1', [key]); }
};

async function refund(uid, amt) {
  await withUser(uid, (u) => { u.bal = whole((Number(u.bal) || 0) + Number(amt)); });
}

/* ====================================================================
 *  Bot + scenes
 * ==================================================================== */
const bot = new Telegraf(CONFIG.BOT_TOKEN);
const stage = new Stage();
const botStartTime = Date.now();

const onWithdraw = new Scene('onWithdraw');
const getMsg = new Scene('getMsg');
stage.register(onWithdraw, getMsg);

bot.use(session({ store: pgSessionStore }));
bot.use(stage.middleware());

bot.on('message', async (ctx, next) => {
  if (ctx.chat.type !== 'private' || ctx.message.date * 1000 < botStartTime - 10 * 60 * 1000) return;
  if (ctx.message.text === '/cancel') {
    ctx.replyWithMarkdown('*Done*');
    ctx.scene.leave();
    return;
  }
  const fwd = ctx.message.forward_from_chat || (ctx.message.forward_origin && ctx.message.forward_origin.chat);
  if (fwd && isAdmin(ctx.from.id)) { // helper: forward any post of a channel to get its numeric ID
    return ctx.reply('📢 ' + (fwd.title || '') + '\nChat ID: ' + fwd.id + (fwd.username ? '\nUsername: @' + fwd.username : '') +
      '\n\nUse /admin -> Add Check and send this ' + (fwd.username ? 'username' : 'ID') + ' to enforce joining.');
  }
  if (data.bot || isAdmin(ctx.from.id)) return next();
  ctx.replyWithHTML(data.bot_text);
});

async function check(ctx, next) {
  const u = await getUserData(ctx.from.id);
  if (!u.registered) return ctx.replyWithMarkdown('*Register Now With /start*');
  await next();
}

const homeKeyboard = () => ({ keyboard: data.but, resize_keyboard: true });

/* ---------------- registration: /start -> Join Airdrop -> home ---------------- */
bot.start(async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return;
    const uid = ctx.from.id;
    const ref = Number(ctx.startPayload);
    let validRef = false;
    if (ref && ref !== uid) validRef = !!(await getUserData(ref)).registered; // referrer must be registered

    const res = await withUser(uid, (u) => {
      if (u.bal !== undefined) return { isNew: false, registered: !!u.registered };
      u.bal = 0; // the signup bonus is paid when registration is completed
      u.ref = [];
      if (validRef) u.pendref = ref;
      return { isNew: true, registered: false };
    }, true);

    if (res.isNew && validRef) {
      bot.telegram.sendMessage(ref,
        '<a href="tg://user?id=' + uid + '"><b>' + he.encode(ctx.from.first_name) + '</b></a> <b>Has started bot with your refer link.</b>\n<i>You will be rewarded when he complete his registration</i>',
        { parse_mode: 'HTML' }).catch(() => {});
    }
    if (res.registered) { // already a member: just show the home keyboard
      return ctx.replyWithMarkdown('*Welcome back!*', { reply_markup: homeKeyboard() });
    }
    ctx.reply(data.welcome, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '✅ Join Airdrop', callback_data: 'next' }]] }
    });
  } catch (e) { console.log(e); }
});

bot.action('next', async (ctx) => {
  try {
    for (const ch of data.check) { // optional channel check (empty list = no check)
      let status;
      try {
        status = (await bot.telegram.getChatMember(/^-?\d+$/.test(String(ch)) ? Number(ch) : ch, ctx.from.id)).status;
      } catch (e) {
        console.log('Cannot verify ' + ch + ' (is the bot admin there?): ' + e.message);
        continue;
      }
      if (!['creator', 'administrator', 'member'].includes(status)) {
        await ctx.answerCbQuery().catch(() => {});
        return ctx.replyWithMarkdown('*Must Join All Channels First*');
      }
    }
    await ctx.answerCbQuery().catch(() => {});
    const uid = ctx.from.id;
    if (!ctx.from.username) { // the Telegram username is the payout account
      return ctx.reply('❌ You need a Telegram username first.\n\nOpen Telegram Settings → Edit profile → Username, set one, then press ✅ Join Airdrop again.');
    }

    // everything in one locked transaction: the signup bonus and the referral reward are paid only once
    const res = await withUser(uid, (u) => {
      if (u.bal === undefined) return { err: 'noreg' };
      if (u.registered) { u.username = ctx.from.username; return { first: false }; }
      u.registered = true;
      u.username = ctx.from.username;
      u.bal = whole((Number(u.bal) || 0) + Number(data.bonus || 0));
      const r = u.pendref;
      delete u.pendref;
      if (r && !u.invited) { u.invited = r; return { first: true, refId: r }; }
      return { first: true, refId: null };
    });
    if (res.err) return ctx.reply('Register with /start first');
    ctx.deleteMessage().catch(() => {});

    if (res.refId) {
      const ok = await withUser(res.refId, (r) => {
        if (!r || !r.registered) return false;
        r.bal = whole((Number(r.bal) || 0) + Number(data.reffer_bonus || 0));
        r.ref = r.ref || [];
        if (!r.ref.includes(uid)) r.ref.push(uid);
        return true;
      });
      if (ok) {
        bot.telegram.sendMessage(res.refId,
          '*🎯 A New Referral has registered the bot using your referral link :* [' + ctx.from.first_name.replace(/[\[\]_*`]/g, '') + '](tg://user?id=' + uid + ')',
          { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
    ctx.replyWithMarkdown('*🎉 Welcome In Our ' + data.bot_cur + ' Airdrop*', { reply_markup: homeKeyboard() });
  } catch (e) { console.log(e); }
});

/* ---------------- user menu ---------------- */
bot.hears('👤 Account', check, async (ctx) => {
  const u = await getUserData(ctx.from.id);
  ctx.reply(`👤 <b>Your Account</b>

<b>👫 Referrals:</b> ${(u.ref || []).length}
<b>📊 Balance:</b> ${whole(u.bal)} ${he.encode(data.bot_cur)}
<b>🙇‍♀️ Your referral link:</b> <code>https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}</code>
<b>🆔 Telegram ID:</b> <code>${ctx.from.id}</code>`,
    { parse_mode: 'HTML', disable_web_page_preview: true });
});

// 💸 Earn More: the text is set by the admin (/admin -> Earn More); the user's own referral link is added below it
bot.hears('💸 Earn More', check, async (ctx) => {
  let text = data.earn || 'No message has been added yet.';
  text += '\n\n🔗 <b>Your referral link:</b>\n<code>https://t.me/' + ctx.botInfo.username + '?start=' + ctx.from.id + '</code>';
  ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => ctx.reply(text.replace(/<[^>]+>/g, '')));
});

bot.hears('/stat', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const r = await pool.query('SELECT COUNT(*) AS n FROM users');
  ctx.replyWithMarkdown('*Total : ' + r.rows[0].n + ' Users*');
});

/* ---------------- withdraw: creates a request that an admin pays ---------------- */
bot.hears('📤 Withdraw', check, async (ctx) => {
  const u = await getUserData(ctx.from.id);
  const bal = whole(u.bal);
  if (!ctx.from.username) return ctx.reply('❌ Set a Telegram username first (Settings → Edit profile → Username). The Stars are sent to your @username. Then try again.');
  if (bal < data.min_wd) {
    return ctx.reply('🔐 To withdraw, you need to complete the following missions:\n\n👥 At least ' + data.min_wd + ' ' + data.bot_cur + ' in Balance\n🌀 Status: ' + bal + ' / ' + data.min_wd);
  }
  const pending = await pool.query("SELECT 1 FROM withdrawals WHERE user_id = $1 AND status = 'pending' LIMIT 1", [ctx.from.id]);
  if (pending.rows.length) return ctx.reply('⏳ You already have a withdrawal waiting for the admin. Please wait until it is paid.');
  await ctx.reply('*📤 Enter the number of Stars to withdraw*\n\n*Available for withdrawal*\n`' + bal + ' ' + data.bot_cur + '`\n\n_The admin will send the Stars to your Telegram account @' + ctx.from.username.replace(/_/g, '\\_') + '._',
    { parse_mode: 'Markdown', reply_markup: { keyboard: [['Back 🔙']], resize_keyboard: true } });
  ctx.scene.enter('onWithdraw');
});

bot.hears('Back 🔙', check, (ctx) => ctx.replyWithMarkdown('_Welcome Back_', { reply_markup: homeKeyboard() }));

const requestKeyboard = (id) => ({
  inline_keyboard: [[
    { text: '✅ Paid', callback_data: 'wd_paid_' + id },
    { text: '❌ Reject (refund)', callback_data: 'wd_rej_' + id }
  ]]
});
const requestText = (w, name) =>
  '📤 <b>Withdrawal request #' + w.id + '</b>\n\n👤 User: <a href="tg://user?id=' + w.user_id + '"><b>' + he.encode(name || String(w.user_id)) + '</b></a> (<code>' + w.user_id + '</code>)' +
  (w.address ? '\n📥 Pay to: ' + he.encode(w.address) : '') +
  '\n💰 Amount: <b>' + whole(w.amount) + ' ' + he.encode(data.bot_cur) + '</b>\n\nSend the Stars from your Telegram account, then tap <b>Paid</b>.';

onWithdraw.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const kb = homeKeyboard();
  try {
    await ctx.scene.leave();
    const text = ctx.message.text.trim();
    if (text === 'Back 🔙') return ctx.replyWithMarkdown('_Welcome Back_', { reply_markup: kb });
    if (!isInt(text)) return ctx.replyWithMarkdown('❌ _Send a whole number, for example 50_', { reply_markup: kb });
    const amt = Number(text);
    if (!ctx.from.username) return ctx.reply('❌ Set a Telegram username first (Settings → Edit profile → Username), then try again.', { reply_markup: kb });
    const username = '@' + ctx.from.username;

    // check + deduct + one-pending-request rule, all in ONE locked transaction
    const r = await withUser(uid, async (u, c) => {
      const bal = whole(u.bal);
      if (!u.registered) return { err: 'noreg' };
      if (amt <= 0 || amt < data.min_wd || amt > bal) return { err: 'range', bal };
      if (CONFIG.MAX_WITHDRAW_PER_TX > 0 && amt > CONFIG.MAX_WITHDRAW_PER_TX) return { err: 'max' };
      const pend = await c.query("SELECT 1 FROM withdrawals WHERE user_id = $1 AND status = 'pending' LIMIT 1", [uid]);
      if (pend.rows.length) return { err: 'pending' };
      u.bal = whole(bal - amt);
      u.username = ctx.from.username;
      const ins = await c.query("INSERT INTO withdrawals(user_id, address, amount, status) VALUES($1,$2,$3,'pending') RETURNING id", [uid, username, amt]);
      return { id: ins.rows[0].id };
    });
    if (r.err === 'noreg') return ctx.replyWithMarkdown('*Register Now With /start*');
    if (r.err === 'pending') return ctx.reply('⏳ You already have a withdrawal waiting for the admin.', { reply_markup: kb });
    if (r.err === 'range') {
      return ctx.replyWithMarkdown('😐 Send a number of at least *' + data.min_wd + ' ' + data.bot_cur + '* and not greater than *' + r.bal + ' ' + data.bot_cur + '*', { reply_markup: kb });
    }
    if (r.err === 'max') return ctx.replyWithMarkdown('😐 Maximum per withdrawal is *' + CONFIG.MAX_WITHDRAW_PER_TX + ' ' + data.bot_cur + '*', { reply_markup: kb });

    await ctx.replyWithMarkdown('*✅ Withdrawal request sent.*\nThe admin will send your ' + amt + ' ' + data.bot_cur + ' soon. You will get a message when it is paid.', { reply_markup: kb });
    const w = { id: r.id, user_id: uid, amount: amt, address: username };
    for (const adminId of data.bot_admin) {
      bot.telegram.sendMessage(adminId, requestText(w, ctx.from.first_name), { parse_mode: 'HTML', reply_markup: requestKeyboard(w.id) }).catch(() => {});
    }
  } catch (e) { console.log(e); }
});

// admin buttons on a withdrawal request
bot.action(/^wd_(paid|rej)_(\d+)$/, async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not allowed');
    const act = ctx.match[1];
    const id = ctx.match[2];
    // the status change happens in ONE statement, so two admins (or a double tap) can't both act
    const r = await pool.query("UPDATE withdrawals SET status = $2 WHERE id = $1 AND status = 'pending' RETURNING user_id, amount, address",
      [id, act === 'paid' ? 'paid' : 'rejected']);
    if (!r.rows[0]) {
      await ctx.answerCbQuery('Already handled').catch(() => {});
      return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    }
    const w = r.rows[0];
    const amt = whole(w.amount);
    await ctx.answerCbQuery(act === 'paid' ? 'Marked as paid' : 'Rejected and refunded').catch(() => {});
    ctx.editMessageText((act === 'paid' ? '✅ Withdrawal #' + id + ' marked PAID' : '❌ Withdrawal #' + id + ' REJECTED (balance refunded)') +
      '\nUser ' + w.user_id + ' - ' + amt + ' ' + data.bot_cur + '\nBy admin ' + ctx.from.id).catch(() => {});

    if (act === 'paid') {
      bot.telegram.sendMessage(w.user_id, '✅ *Withdrawal paid!*\n`' + amt + ' ' + data.bot_cur + '` has been sent to your Telegram account.', { parse_mode: 'Markdown' }).catch(() => {});
      let name = String(w.user_id);
      try { name = (await bot.telegram.getChat(w.user_id)).first_name || name; } catch (e) { /* keep id */ }
      const payText = '<b><u>🚀 New Withdrawal Paid!</u>\n\n🔰 User :</b> <a href="tg://user?id=' + w.user_id + '"><b>' + he.encode(name) + '</b></a>\n<b>💲 Amount : ' + amt + ' ' + he.encode(data.bot_cur) + '</b>\n\n<b>🔃 Bot Link : @' + ctx.botInfo.username + '</b>';
      bot.telegram.sendMessage(data.payout, payText, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
    } else {
      await refund(w.user_id, amt);
      bot.telegram.sendMessage(w.user_id, '❌ Your withdrawal of ' + amt + ' ' + data.bot_cur + ' was rejected. The balance has been restored.').catch(() => {});
    }
  } catch (e) { console.log(e); }
});

// admin: list requests that still wait for payment (e.g. after a restart), each with its buttons
bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const r = await pool.query("SELECT id, user_id, amount, address FROM withdrawals WHERE status = 'pending' ORDER BY id LIMIT 30");
  if (!r.rows.length) return ctx.reply('No pending withdrawals ✅');
  for (const w of r.rows) {
    await ctx.reply(requestText(w, ''), { parse_mode: 'HTML', reply_markup: requestKeyboard(w.id) }).catch(() => {});
  }
});

/* ---------------- admin: balances, delete data ---------------- */
// /addbal <telegram id> <amount>   -> add Stars to a user's balance (negative amount removes)
bot.command('addbal', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id, amt] = ctx.message.text.trim().split(/\s+/);
  if (!/^\d+$/.test(id || '') || !/^-?\d+$/.test(amt || '')) return ctx.reply('Usage: /addbal <telegram id> <whole amount>\nExample: /addbal 5028581330 100');
  const n = Number(amt);
  const res = await withUser(id, (u) => {
    if (!u || u.bal === undefined) return null;
    const nb = whole((Number(u.bal) || 0) + n);
    if (nb < 0) return 'neg';
    u.bal = nb;
    return nb;
  });
  if (res === null) return ctx.reply('User not found. They must press /start in the bot first.');
  if (res === 'neg') return ctx.reply('Balance cannot go below 0.');
  ctx.reply('✅ Balance of ' + id + ' is now ' + res + ' ' + data.bot_cur);
});

// /deluser <telegram id>   -> removes one user so they can register again
bot.command('deluser', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = (ctx.message.text.split(/\s+/)[1] || '').trim();
  if (!/^\d+$/.test(id)) return ctx.reply('Usage: /deluser <telegram id>\nExample: /deluser 123456789');
  const r = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  await pool.query('DELETE FROM sessions WHERE key LIKE $1', [id + ':%']);
  ctx.reply(r.rows.length ? '🗑 User ' + id + ' deleted.' : 'User ' + id + ' not found.');
});

// /resetall CONFIRM   -> deletes ALL users and balances (settings and withdrawal history are kept)
bot.command('resetall', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  if ((ctx.message.text.split(/\s+/)[1] || '') !== 'CONFIRM') {
    return ctx.reply('⚠️ This deletes ALL users, balances and referrals and cannot be undone.\nTo continue send exactly:\n/resetall CONFIRM');
  }
  await pool.query('TRUNCATE users, sessions');
  ctx.reply('🗑 All users deleted. The bot is now empty (settings were kept).');
});

/* ---------------- broadcast ---------------- */
bot.command('broad', (ctx) => { if (isAdmin(ctx.from.id)) ctx.scene.enter('getMsg'); });
getMsg.enter((ctx) => ctx.replyWithMarkdown(' *Okay Admin 👮‍♂, Send your broadcast message*'));
getMsg.hears('⬅️ Back', (ctx) => ctx.scene.leave());
getMsg.on('text', async (ctx) => {
  await ctx.scene.leave();
  if (ctx.message.text.length > 3000) return ctx.reply('Message may not exceed 3000 characters.');
  globalBroadCast(ctx);
});

async function globalBroadCast(ctx) {
  const users = (await pool.query('SELECT id FROM users')).rows.map((r) => Number(r.id));
  const html = toHTML(ctx.message);
  let fail = 0;
  ctx.reply('Your message is queued and will be posted to all of your subscribers soon. Total subscribers: ' + users.length);
  for (const id of users) {
    try { await bot.telegram.sendMessage(id, html, { parse_mode: 'HTML' }); } catch (e) { fail++; }
    await sleep(data.broad_speed);
  }
  bot.telegram.sendMessage(ctx.from.id, '<b>Your message has been posted to all of your subscribers.</b>\n\n<b>Total User:</b> ' + users.length + '\n<b>Total Sent:</b> ' + (users.length - fail) + '\n<b>Total Failed:</b> ' + fail, { parse_mode: 'HTML' });
}

/* ---------------- admin panel ---------------- */
bot.command('admin', (ctx) => {
  if (isAdmin(ctx.from.id)) ctx.replyWithMarkdown('*Welcome admin :)*\n\n_Here Is Your Admin Panel._', { reply_markup: { inline_keyboard: adminRows() } });
});

// helper: a one-input admin scene. apply() returns an error string, or nothing on success.
function adminScene(name, doneMsg, apply) {
  const sc = new Scene(name);
  sc.on('text', async (ctx) => {
    const txt = ctx.message.text.trim();
    if (txt === '/cancel') { await ctx.replyWithMarkdown('*Done*'); return ctx.scene.leave(); }
    const err = await apply(txt, ctx);
    if (err) return ctx.replyWithMarkdown(err);
    await saveData();
    await ctx.scene.leave();
    ctx.replyWithMarkdown('*' + doneMsg + '*\n\n_Here Is Your Admin Panel._', { reply_markup: { inline_keyboard: adminRows() } });
  });
  stage.register(sc);
}

const amountErr = (t) => (isInt(t) ? null : '*Invalid amount.* Send a whole number of Stars, for example 5.');
adminScene('bonuss', 'Bonus Amount Has Updated :)', (t) => amountErr(t) || void (data.bonus = Number(t)));
adminScene('referam', 'Refer Amount Has Updated :)', (t) => amountErr(t) || void (data.reffer_bonus = Number(t)));
adminScene('minwd', 'Minimum Withdraw Amount Has Updated :)', (t) => amountErr(t) || void (data.min_wd = Number(t)));
adminScene('broad', 'Broadcast Speed Updated :)', (t) => {
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) return '*Invalid Amount*';
  if (Number(t) > 15) return 'Sorry, *Max 15 Users* per sec broadcast can be set.';
  data.broad_speed = 1000 / Number(t);
});
adminScene('addadmin', 'User Had Promoted :)', (t) => {
  if (!isInt(t)) return '*Invalid User ID*';
  if (data.bot_admin.includes(Number(t))) return 'This user is already admin';
  data.bot_admin.push(Number(t));
});
adminScene('rmvadmin', 'User Had Demoted :)', (t) => {
  if (!isInt(t)) return '*Invalid User ID*';
  if (!data.bot_admin.includes(Number(t))) return 'This user is not admin';
  data.bot_admin = data.bot_admin.filter((id) => id !== Number(t));
});
const chanVal = (t) => (/^-?\d+$/.test(t) ? Number(t) : (t.startsWith('@') ? t : null));
adminScene('acheck', 'Channel Has Added In Check :)', (t) => {
  const v = chanVal(t);
  if (v === null) return '*Invalid.* Send @username, or the numeric ID (like -100123...) for a private channel.';
  if (data.check.includes(v)) return 'This channel is already in check';
  data.check.push(v);
});
adminScene('rcheck', 'Channel Has Removed From Check :)', (t) => {
  const v = chanVal(t);
  if (v === null) return '*Invalid.* Send @username or numeric ID.';
  if (!data.check.includes(v)) return 'This channel is not in check';
  data.check = data.check.filter((c) => c !== v);
});
adminScene('currency', 'Your Currency Name Has Updated :)', (t) => { data.bot_cur = t; });
adminScene('payout', 'Your Payout Channel Has Updated :)', (t) => {
  if (!t.startsWith('@')) return '*Invalid Username*';
  data.payout = t;
});
adminScene('botoff', 'Bot Turned Off Message Has Updated :)', (t, ctx) => { data.bot_text = toHTML(ctx.message); });
adminScene('welcomemsg', 'Welcome Message Has Updated :)', (t, ctx) => { data.welcome = toHTML(ctx.message); });
adminScene('earnmsg', 'Earn More Message Has Updated :)', (t, ctx) => { data.earn = toHTML(ctx.message); });

const prompts = {
  'welcome-message': ['Ok good, send me a new already formatted welcome text', 'welcomemsg'],
  'earn-more': ['Ok good, send me the Earn More message (ways to earn, tasks, links...). Formatting is kept. The user\'s own referral link is added under it automatically.', 'earnmsg'],
  'bonus': ['Ok good, send me the new signup bonus (whole number of Stars)', 'bonuss'],
  'refer': ['Ok good, send me the new refer amount (whole number of Stars)', 'referam'],
  'withdraw': ['Ok good, send me the new minimum withdraw (whole number of Stars)', 'minwd'],
  'currency': ['Ok good, send me the currency name shown in the bot (example: ⭐ Stars)', 'currency'],
  'payout-channel': ['Ok good, send me your payout channel username with @ (the bot must be an admin there)', 'payout'],
  'broad-speed': ['Ok good, send me to how many users you wanna send broadcast per sec.', 'broad'],
  'add-admin': ['Ok good, send me user id of user whom you wanna promote as admin', 'addadmin'],
  'remove-admin': ['Ok good, send me user id of user whom you wanna demote from admin', 'rmvadmin'],
  'bot-off-text': ['Ok good, give me text to send to users when bot is off', 'botoff'],
  'add-check': ['Ok good, send the channel @username (or numeric ID like -100123... for a private channel) to add in check', 'acheck'],
  'remove-check': ['Ok good, send the channel @username or numeric ID to remove from check', 'rcheck']
};

bot.action(/adhymn_/, async (ctx) => {
  try {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Not allowed');
    ctx.answerCbQuery().catch(() => {});
    const edit = ctx.callbackQuery.data.split('_')[1];
    if (prompts[edit]) {
      await ctx.editMessageText(prompts[edit][0]).catch(() => {});
      return ctx.scene.enter(prompts[edit][1]);
    }
    if (edit === 'on-/-off-bot') {
      data.bot = !data.bot;
      await saveData();
      return ctx.editMessageText('*Bot Has ' + (data.bot ? 'Turned On' : 'Turned Off') + ' :)*\n\n_Here Is Your Admin Panel._', { reply_markup: { inline_keyboard: adminRows() }, parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch (e) { console.log(e); }
});

bot.catch((err) => console.log('Bot error:', err));

/* ====================================================================
 *  Start-up: database, health endpoint (keeps Render awake), bot
 * ==================================================================== */
async function main() {
  await initDb();
  await loadSettings();

  const PORT = process.env.PORT || 10000;
  http.createServer(async (req, res) => {
    if (req.url === '/health') {
      try { await pool.query('SELECT 1'); res.end('ok'); } catch (e) { res.statusCode = 500; res.end('db error'); }
    } else res.end('Stars airdrop bot is running');
  }).listen(PORT, () => console.log('Health endpoint on port ' + PORT));

  // Render injects RENDER_EXTERNAL_URL; pinging ourselves counts as inbound traffic (best effort —
  // an external pinger such as UptimeRobot on /health is the more reliable backup).
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {}), 9 * 60 * 1000);
  }

  bot.launch().catch((e) => { console.error('Launch failed:', e.message); process.exit(1); });
  console.log('Bot is running...');

  const waiting = await pool.query("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'");
  if (Number(waiting.rows[0].n) > 0) {
    for (const id of data.bot_admin) bot.telegram.sendMessage(id, '⚠️ ' + waiting.rows[0].n + ' withdrawal(s) are waiting for payment. Send /pending').catch(() => {});
  }
}

main().catch((e) => { console.error('Fatal start-up error:', e); process.exit(1); });

const shutdown = (sig) => { try { bot.stop(sig); } catch (e) { /* not started */ } pool.end().finally(() => process.exit(0)); };
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
