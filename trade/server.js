const { Telegraf } = require('telegraf');
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const https = require('https');
const dns = require('dns').promises;
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN || '8140187495:AAG28O6FXb-xd9hi86NK5B1Rwj4wsYNQ4pw';
const ADMIN_ID = Number(process.env.ADMIN_ID || '7593759960');
const BANK_ACCOUNT = (process.env.BANK_ACCOUNT || 'supgiftbank').replace(/^@/, '');
const APP_URL = (process.env.APP_URL || 'https://trade-botik.new.tg').replace(/\/+$/, '').replace(/^([^h])/, 'https://$1');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'trade-secret';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://trade_bot:trade_bot_pass@127.0.0.1:5432/trade_bot';
let botUsername = null;

function getTunnelUrl() {
  try {
    const url = fs.readFileSync(path.join(__dirname, 'tunnel-url.txt'), 'utf8').trim();
    if (url) return url;
  } catch {}
  return null;
}

function getAppUrl() {
  return getTunnelUrl() || APP_URL;
}

function mediaUrl(filePath) {
  const base = (getTunnelUrl() || APP_URL).replace(/\/+$/, '');
  return base + (filePath.charAt(0) === '/' ? filePath : '/' + filePath);
}

const ADMINS_FILE = path.join(__dirname, 'admins.json');
const admins = new Set();
const adminTradeCache = new Map(); // key -> { tradeId, seller, amount, currency, want, at }

const TG_FALLBACK_IPS = ['149.154.167.220', '149.154.167.206', '149.154.175.100', '149.154.175.53', '149.154.166.110'];

async function resolveHost(hostname) {
  let addrs = [];
  try {
    const osAddrs = await dns.lookup(hostname, { all: true, family: 4 });
    if (osAddrs.length) addrs = osAddrs.map(a => a.address);
  } catch {}
  if (!addrs.length) {
    try {
      const r = await dns.resolve4(hostname);
      if (r.length) addrs = r;
    } catch {}
  }
  if (hostname === 'api.telegram.org') {
    for (const ip of TG_FALLBACK_IPS) {
      if (!addrs.includes(ip)) addrs.push(ip);
    }
  }
  return addrs;
}

function smartLookup(hostname, options, cb) {
  resolveHost(hostname).then(addrs => {
    if (!addrs.length) return cb(new Error('DNS failed for ' + hostname));
    if (options && options.all) cb(null, addrs.map(a => ({ address: a, family: 4 })));
    else cb(null, addrs[0], 4);
  }, cb);
}

let tgAgent;
if (process.env.TG_PROXY) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  tgAgent = new HttpsProxyAgent(process.env.TG_PROXY, { keepAlive: false });
} else {
  tgAgent = new https.Agent({ keepAlive: true, lookup: smartLookup });
}
const bot = new Telegraf(BOT_TOKEN, { telegram: { agent: tgAgent } });

function isRetryableTelegramError(e) {
  if (!e) return false;
  const code = e.response && e.response.error_code;
  if (code === 502 || code === 504 || code === 429 || code === 503) return true;
  const msg = String(e.message || e.code || e.errno || e);
  return /502|503|504|429|Bad Gateway|Gateway Time|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|EAI_AGAIN|network|timeout/i.test(msg);
}

const _rawCallApi = bot.telegram.callApi.bind(bot.telegram);
bot.telegram.callApi = async function (method, payload, options) {
  const maxAttempts = 10;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await _rawCallApi(method, payload, options);
    } catch (e) {
      lastErr = e;
      if (!isRetryableTelegramError(e) || attempt === maxAttempts) throw e;
      const delay = Math.min(300 * Math.pow(1.5, attempt - 1), 2500) + Math.floor(Math.random() * 250);
      console.error(`TG retry ${method} attempt ${attempt}/${maxAttempts} after ${Math.round(delay)}ms: ${e && e.message ? e.message : e}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
};

async function safeReply(ctx, text, extra) {
  try { return await ctx.reply(text, extra); }
  catch (e) { console.error('reply failed:', e && e.message ? e.message : e); return null; }
}

process.on('unhandledRejection', (e) => {
  console.error('Unhandled rejection:', e && e.message ? e.message : e);
});
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e && e.message ? e.message : e);
});

const CE = {
  gift: ['5203996991054432397', '🎁'],
  gem: ['5471952986970267163', '💎'],
  bear: ['5397915559037785261', '🧸'],
  rose: ['5440911110838425969', '🌹'],
  ring: ['5402100905883488232', '💍'],
  trophy: ['5409008750893734809', '🏆'],
  rocket: ['5445284980978621387', '🚀'],
  cake: ['5370999492914976897', '🎂'],
  bouquet: ['5395347834314696158', '💐'],
  heart: ['5465263910414195580', '💝'],
  champagne: ['5370900768796711127', '🍾']
};
function ceTag(key) {
  const [id, fallback] = CE[key] || CE.gift;
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}
function ceId(key) {
  return (CE[key] || CE.gift)[0];
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function offerLabel(o) {
  if (!o) return '—';
  if (o.type === 'gift') return (o.data && o.data.name) ? o.data.name : 'подарок';
  if (['usdt', 'rub', 'ton'].includes(o.type)) return `${o.data} ${String(o.type).toUpperCase()}`;
  return String(o.data == null ? '' : o.data);
}
function wantOfferLabel(o) {
  if (!o) return 'любой подарок';
  if (o.type === 'currency') return o.name || `${o.amount} ${String(o.currency).toUpperCase()}`;
  if (o.type === 'gift') return (o.link && o.link.trim()) ? o.link : (o.name || 'подарок');
  return o.name || 'любой подарок';
}
function displayName(p) {
  if (!p) return 'Пользователь';
  if (p.username) return '@' + p.username;
  if (p.name) return p.name;
  return 'ID ' + p.id;
}
function giftEmojiKey(name) {
  const n = String(name).toLowerCase();
  if (/bear|pug|pepe|cat|neko|bird|duck|penguin|snake|bunny|chimp|monkey/.test(n)) return 'bear';
  if (/rose|flower|sakura|bloom|tulip/.test(n)) return 'rose';
  if (/ring/.test(n)) return 'ring';
  if (/diamond|gem|crystal|shard/.test(n)) return 'gem';
  if (/trophy|cup|medal/.test(n)) return 'trophy';
  if (/rocket|broom|star|moon|planet/.test(n)) return 'rocket';
  if (/cake|cookie|muffin|candle|ice ?cream/.test(n)) return 'cake';
  if (/bouquet|posy/.test(n)) return 'bouquet';
  if (/heart|love|cupid/.test(n)) return 'heart';
  if (/champagne|potion|bottle/.test(n)) return 'champagne';
  return 'gift';
}

let giftEmojiMap = {};
try {
  giftEmojiMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'gifts', 'gift-emoji-map.json'), 'utf8')).gifts || {};
} catch {}

function giftSlug(gift) {
  const m = String(gift.image || '').match(/\/gifts\/(?:models|nft)\/([a-z0-9-]+)\.(?:png|jpg|webp)/i);
  return m ? m[1] : null;
}
function giftEmojiIdFor(gift) {
  const slug = giftSlug(gift);
  const m = slug ? giftEmojiMap[slug] : null;
  return (m && m.id) || ceId(giftEmojiKey(gift.name));
}
function giftEmojiFor(gift) {
  const slug = giftSlug(gift);
  const m = slug ? giftEmojiMap[slug] : null;
  if (m && m.id) return `<tg-emoji emoji-id="${m.id}">${m.emoji || '🎁'}</tg-emoji>`;
  return ceTag(giftEmojiKey(gift.name));
}
function giftEmojiPlainFor(gift) {
  const slug = giftSlug(gift);
  const m = slug ? giftEmojiMap[slug] : null;
  if (m && m.emoji) return m.emoji;
  return CE[giftEmojiKey(gift.name)][1];
}
function giftLabel(gift) { return gift.name; }
function giftLabelText(gift) { return `${giftEmojiFor(gift)} ${gift.name}`; }

function newReqId() {
  return Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
}

async function createRequest(fields) {
  const id = newReqId();
  await pool.query(
    'INSERT INTO requests (id, type, user_id, user_username, gift, target_username, floor_ton, currency, amount, destination, tx_hash, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [id, fields.type, Number(fields.userId), fields.userUsername || '', fields.gift ? JSON.stringify(fields.gift) : null, fields.targetUsername || null, fields.floorTon ?? null, fields.currency || null, fields.amount ?? null, fields.destination || null, fields.txHash || null, 'pending', Date.now()]
  );
  return { id };
}

async function getRequest(id) {
  const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1', [id]);
  return rows[0] || null;
}

async function creditUser(userId, currency, amount) {
  const user = await getUser(Number(userId));
  user[currency] = Math.round((user[currency] + Number(amount)) * 100) / 100;
  await setUserBalance(Number(userId), currency, user[currency]);
  return user[currency];
}

async function processAdminDecision(reqId, approve) {
  const r = await getRequest(reqId);
  if (!r) return { success: false, error: 'Заявка не найдена' };
  if (r.status !== 'pending') {
    return { success: false, error: r.status === 'approved' ? 'Уже подтверждена' : 'Уже отклонена' };
  }
  const gift = r.gift;
  if (!approve) {
    try {
      if (r.type === 'withdraw' && gift && gift.id) {
        await addGift(Number(r.user_id), gift);
        const u = await getUser(Number(r.user_id));
        u.gifts.push(gift);
      } else if (r.type === 'withdraw_currency') {
        await creditUser(r.user_id, r.currency, Number(r.amount || r.floor_ton));
      }
    } catch (e) {
      return { success: false, error: 'Ошибка отклонения: ' + e.message };
    }
    await pool.query("UPDATE requests SET status='rejected' WHERE id=$1", [reqId]);
    let adminText;
    if (r.type === 'withdraw_currency') {
      adminText = `❌ Заявка #${r.id} отклонена — ${r.amount} ${r.currency} возвращено пользователю`;
      bot.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} отклонена.\n${r.amount} ${r.currency} возвращено на баланс.`).catch(() => {});
    } else if (r.type === 'deposit_ton' || r.type === 'deposit_usdt') {
      adminText = `❌ Заявка #${r.id} отклонена — пополнение ${r.amount} ${r.currency} не зачислено`;
      bot.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} отклонена.\nПополнение ${r.amount} ${r.currency} не зачислено.`).catch(() => {});
    } else if (r.type === 'deposit_gift') {
      adminText = `❌ Заявка #${r.id} отклонена — пополнение подарком ${gift ? gift.name : ''} не зачислено`;
      bot.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} на пополнение подарком отклонена.\nПодарок «${gift ? gift.name : ''}» не зачислен.`).catch(() => {});
    } else if (r.type === 'sell') {
      adminText = `❌ Заявка #${r.id} на продажу ${gift ? gift.name : ''} отклонена — подарок остался в профиле`;
      bot.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} на продажу подарка отклонена.\nПодарок «${gift ? gift.name : ''}» остался в твоём профиле.`).catch(() => {});
    } else {
      adminText = `❌ Заявка #${r.id} отклонена — ${gift ? gift.name : 'подарок'} возвращён пользователю`;
      bot.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} отклонена.\nПодарок «${gift ? gift.name : ''}» возвращён в твой профиль.`).catch(() => {});
    }
    return { success: true, status: 'rejected', adminText };
  }

  try {
    if (r.type === 'deposit_ton' || r.type === 'deposit_usdt') {
      await creditUser(r.user_id, r.currency, Number(r.amount || r.floor_ton));
    }
  } catch (e) {
    return { success: false, error: 'Ошибка подтверждения: ' + e.message };
  }
  await pool.query("UPDATE requests SET status='approved' WHERE id=$1", [reqId]);
  let adminText;
  if (r.type === 'withdraw_currency') {
    adminText = `✅ Заявка #${r.id}: подтверждена выплата ${r.amount} ${r.currency}`;
    bot.telegram.sendMessage(r.user_id, `✅ Вывод подтверждён!\n\n${r.amount} ${r.currency} будет отправлено на ${r.destination}.`).catch(() => {});
  } else if (r.type === 'deposit_ton' || r.type === 'deposit_usdt') {
    adminText = `✅ Заявка #${r.id}: зачислено ${r.amount} ${r.currency}`;
    bot.telegram.sendMessage(r.user_id, `✅ Пополнение подтверждено!\n\nЗачислено ${r.amount} ${r.currency}.`).catch(() => {});
  } else if (r.type === 'deposit_gift') {
    adminText = `✅ Заявка #${r.id}: подарок ${gift ? gift.name : ''} зачислен на баланс пользователя`;
    bot.telegram.sendMessage(r.user_id, `✅ Пополнение подарком подтверждено!\n\nПодарок «${gift ? gift.name : ''}» зачислен в твой профиль.`, { parse_mode: 'HTML' }).catch(() => {});
  } else if (r.type === 'sell' && gift && gift.id) {
    await removeGift(Number(r.user_id), gift.id);
    const cur = r.currency || 'ton';
    await creditUser(r.user_id, cur, Number(r.amount || r.floor_ton || 0));
    adminText = `✅ Заявка #${r.id}: подарок ${gift.name} продан, начислено ${r.amount} ${cur.toUpperCase()}`;
    bot.telegram.sendMessage(r.user_id, `✅ Продажа подтверждена!\n\nПодарок «${gift.name}» продан, начислено <b>${r.amount} ${cur.toUpperCase()}</b>.`, { parse_mode: 'HTML' }).catch(() => {});
  } else {
    adminText = `✅ Заявка #${r.id} подтверждена.\nОтправь ${gift ? gift.name : 'подарок'} вручную на @${r.target_username} (NFT переносятся через Fragment).`;
    bot.telegram.sendMessage(r.user_id, `✅ Заявка #${r.id} одобрена!\n\nПодарок «${gift ? gift.name : ''}» будет отправлен в профиль @${r.target_username} в ближайшее время.`, { parse_mode: 'HTML' }).catch(() => {});
  }
  return { success: true, status: 'approved', adminText };
}

async function notifyTradeAdmin(text, replyMarkup) {
  try { await bot.telegram.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML', reply_markup: replyMarkup }); }
  catch (e) { console.error('Trade admin notify failed:', e.message); }
}

bot.action(/^ap_(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery('Недостаточно прав').catch(() => {});
  const reqId = ctx.callbackQuery.data.slice(3);
  const result = await processAdminDecision(reqId, true).catch(e => ({ success: false, error: e.message }));
  if (!result.success) return ctx.answerCbQuery(result.error || 'Ошибка').catch(() => {});
  await ctx.editMessageText(result.adminText, { parse_mode: 'HTML' }).catch(() => {});
  return ctx.answerCbQuery('Подтверждено').catch(() => {});
});

bot.action(/^rj_(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery('Недостаточно прав').catch(() => {});
  const reqId = ctx.callbackQuery.data.slice(3);
  const result = await processAdminDecision(reqId, false).catch(e => ({ success: false, error: e.message }));
  if (!result.success) return ctx.answerCbQuery(result.error || 'Ошибка').catch(() => {});
  await ctx.editMessageText(result.adminText, { parse_mode: 'HTML' }).catch(() => {});
  return ctx.answerCbQuery('Отклонено').catch(() => {});
});

function parseRubTicketAmount(subject, message) {
  const s = `${subject || ''}\n${message || ''}`;
  const m = s.match(/Сумма:\s*([\d.,]+)\s*RUB/i) || s.match(/Пополнение\s+RUB\s+([\d.,]+)/i) || s.match(/([\d.,]+)\s*RUB/i);
  if (!m) return null;
  const v = Number(String(m[1]).replace(/\s/g, '').replace(',', '.'));
  return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}
function isRubDepositTicket(subject) { return /пополнение\s+RUB/i.test(String(subject || '')); }

const pendingTicketReplies = new Map();

async function addTicketMessage(ticketId, sender, text) {
  const body = String(text || '').slice(0, 2000);
  if (!body.trim()) return;
  await pool.query('INSERT INTO ticket_messages (ticket_id, sender, text, created_at) VALUES ($1,$2,$3,$4)', [ticketId, sender, body, Date.now()]);
}

async function closeTicketReply(ticketId, replyText) {
  await pool.query("UPDATE tickets SET status='answered', admin_reply=$1, replied_at=$2 WHERE id=$3", [replyText, Date.now(), ticketId]);
  await addTicketMessage(ticketId, 'admin', replyText);
}

bot.action(/^tda_(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery('Недостаточно прав').catch(() => {});
  const ticketId = ctx.callbackQuery.data.slice(4);
  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE id=$1', [ticketId]);
    const t = rows[0];
    if (!t) return ctx.answerCbQuery('Тикет не найден').catch(() => {});
    if (t.status !== 'open') return ctx.answerCbQuery('Тикет уже закрыт').catch(() => {});
    const amt = parseRubTicketAmount(t.subject, t.message);
    if (!amt) return ctx.answerCbQuery('Не удалось определить сумму').catch(() => {});
    await creditUser(t.user_id, 'rub', amt);
    await closeTicketReply(ticketId, `Пополнение подтверждено: ${amt} RUB`);
    await bot.telegram.sendMessage(t.user_id, `✅ Поддержка подтвердила пополнение!\n\nЗачислено ${amt} RUB на баланс.`).catch(() => {});
    await ctx.editMessageText(`🎫 Тикет #${ticketId} — <b>Пополнение RUB ${amt}</b>\n\n✅ Подтверждено: зачислено ${amt} RUB пользователю ID ${t.user_id}.`, { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCbQuery('Подтверждено').catch(() => {});
  } catch (e) { return ctx.answerCbQuery('Ошибка: ' + e.message).catch(() => {}); }
});

bot.action(/^tdr_(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery('Недостаточно прав').catch(() => {});
  const ticketId = ctx.callbackQuery.data.slice(4);
  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE id=$1', [ticketId]);
    const t = rows[0];
    if (!t) return ctx.answerCbQuery('Тикет не найден').catch(() => {});
    if (t.status !== 'open') return ctx.answerCbQuery('Тикет уже закрыт').catch(() => {});
    const amt = parseRubTicketAmount(t.subject, t.message);
    await closeTicketReply(ticketId, `Пополнение отклонено${amt ? ': ' + amt + ' RUB' : ''}`);
    await bot.telegram.sendMessage(t.user_id, `❌ Поддержка отклонила заявку на пополнение${amt ? ` на ${amt} RUB` : ''}.\n\nЕсли это ошибка — создай новый тикет или напиши в поддержку.`).catch(() => {});
    await ctx.editMessageText(`🎫 Тикет #${ticketId} — <b>Пополнение RUB${amt ? ' ' + amt : ''}</b>\n\n❌ Отклонено (ID ${t.user_id}).`, { parse_mode: 'HTML' }).catch(() => {});
    return ctx.answerCbQuery('Отклонено').catch(() => {});
  } catch (e) { return ctx.answerCbQuery('Ошибка: ' + e.message).catch(() => {}); }
});

bot.action(/^trp_(.+)$/, async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.answerCbQuery('Недостаточно прав').catch(() => {});
  const ticketId = ctx.callbackQuery.data.slice(4);
  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE id=$1', [ticketId]);
    const t = rows[0];
    if (!t) return ctx.answerCbQuery('Тикет не найден').catch(() => {});
    if (t.status !== 'open') return ctx.answerCbQuery('Тикет уже закрыт').catch(() => {});
    pendingTicketReplies.set(Number(ctx.from.id), { ticketId: t.id, userId: Number(t.user_id) });
    ctx.reply(`✏️ Ответ по тикету #${t.id} (тема: ${t.subject || '—'}).\n\nОтправь текст следующим сообщением — он придёт пользователю.`).catch(() => {});
    return ctx.answerCbQuery('Напиши текст ответа').catch(() => {});
  } catch (e) { return ctx.answerCbQuery('Ошибка: ' + e.message).catch(() => {}); }
});

const app = express();
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
}));

app.post('/webhook/trade', async (req, res) => {
  const secret = req.get('x-telegram-bot-api-secret-token');
  if (secret !== WEBHOOK_SECRET) return res.status(403).end();
  if (!bot.botInfo) {
    try { bot.botInfo = await bot.telegram.getMe(); botUsername = bot.botInfo.username; }
    catch (e) { return res.status(503).end(); }
  }
  try { await bot.handleUpdate(req.body); res.sendStatus(200); }
  catch (e) { console.error('Trade webhook handling failed:', e && e.message ? e.message : e); res.status(500).end(); }
});

const pool = new Pool({ connectionString: DATABASE_URL });

async function loadAdmins() {
  admins.clear();
  const { rows } = await pool.query('SELECT telegram_id FROM admins');
  rows.forEach(r => admins.add(Number(r.telegram_id)));
}
function isAdminUser(id) {
  return Number(id) === ADMIN_ID || admins.has(Number(id));
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      rub NUMERIC NOT NULL DEFAULT 0,
      usdt NUMERIC NOT NULL DEFAULT 0,
      ton NUMERIC NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gifts (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rarity TEXT,
      image TEXT,
      bg JSONB
    );
    CREATE TABLE IF NOT EXISTS trades (
      trade_id TEXT PRIMARY KEY,
      seller_id BIGINT NOT NULL,
      buyer_id BIGINT,
      seller_gift JSONB NOT NULL,
      buyer_offer JSONB,
      want_offer JSONB,
      status TEXT NOT NULL,
      comment TEXT,
      link TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      telegram_id BIGINT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      user_id BIGINT NOT NULL,
      user_username TEXT,
      gift JSONB,
      target_username TEXT,
      floor_ton NUMERIC,
      currency TEXT,
      amount NUMERIC,
      destination TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      decided_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      subject TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      admin_reply TEXT,
      created_at BIGINT NOT NULL,
      replied_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id BIGSERIAL PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query("ALTER TABLE trades ADD COLUMN IF NOT EXISTS link TEXT");
  await pool.query("ALTER TABLE trades ADD COLUMN IF NOT EXISTS want_offer JSONB");
  await pool.query("ALTER TABLE trades ADD COLUMN IF NOT EXISTS created_by BIGINT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS successful_deals INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_deals INTEGER NOT NULL DEFAULT 0");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      referrer_id BIGINT NOT NULL,
      joiner_id BIGINT NOT NULL,
      source TEXT NOT NULL DEFAULT 'trade',
      trade_id TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_pair ON referrals (referrer_id, joiner_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_referrals_created ON referrals (created_at DESC)");
  await pool.query("UPDATE trades SET link = 'https://t.me/SuppGiftbot?start=trade_' || trade_id WHERE link IS NULL OR link LIKE '%rerleprlpebot%'");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id)");
  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, sender, text, created_at)
     SELECT t.id, 'user', t.message, t.created_at FROM tickets t
     WHERE NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id)`
  ).catch(() => {});
  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, sender, text, created_at)
     SELECT t.id, 'admin', t.admin_reply, COALESCE(t.replied_at, t.created_at) FROM tickets t
     WHERE t.admin_reply IS NOT NULL AND t.admin_reply <> ''
       AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.sender = 'admin')`
  ).catch(() => {});
  await loadAdmins();
}

async function fetchUser(userId) {
  const u = await pool.query('SELECT telegram_id, username, first_name, rub, usdt, ton, successful_deals, completed_deals, banned, created_at FROM users WHERE telegram_id=$1', [userId]);
  if (!u.rowCount) return null;
  const g = await pool.query('SELECT id, name, rarity, image, bg FROM gifts WHERE user_id=$1', [userId]);
  return {
    telegram_id: Number(u.rows[0].telegram_id),
    username: u.rows[0].username || '',
    first_name: u.rows[0].first_name || '',
    created_at: Number(u.rows[0].created_at || 0),
    rub: Number(u.rows[0].rub),
    banned: u.rows[0].banned || false,
    usdt: Number(u.rows[0].usdt),
    ton: Number(u.rows[0].ton),
    successfulDeals: Number(u.rows[0].successful_deals || 0),
    completedDeals: Number(u.rows[0].completed_deals || 0),
    gifts: g.rows.map(r => ({ id: r.id, name: r.name, rarity: r.rarity, image: r.image, bg: r.bg }))
  };
}

function getNftCatalog() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'gifts', 'nft', 'catalog-nft.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function getUser(userId) {
  const existing = await fetchUser(userId);
  if (existing) return existing;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users (telegram_id, rub, usdt, ton, created_at) VALUES ($1,$2,$3,$4,$5)', [userId, 0, 0, 0, Date.now()]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code !== '23505') throw e;
  } finally {
    client.release();
  }
  const user = await fetchUser(userId);
  if (!user) throw new Error('user not found');
  return user;
}

async function rememberUser(from) {
  if (!from || !from.id) return;
  try {
    await pool.query(
      `INSERT INTO users (telegram_id, rub, usdt, ton, created_at, username, first_name)
       VALUES ($1,0,0,0,$2,$3,$4)
       ON CONFLICT (telegram_id) DO UPDATE
       SET username = COALESCE(EXCLUDED.username, users.username),
           first_name = COALESCE(EXCLUDED.first_name, users.first_name)`,
      [from.id, Date.now(), from.username || null, from.first_name || null]
    );
  } catch (e) { console.error('rememberUser failed:', e.message); }
}

const profileCache = new Map();
async function profileOf(id) {
  const key = Number(id);
  if (!Number.isFinite(key) || key <= 0) return { id: key, username: '', name: '', successfulDeals: 0, completedDeals: 0 };
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.p;
  let p = { id: key, username: '', name: '', successfulDeals: 0, completedDeals: 0 };
  try {
    const { rows } = await pool.query('SELECT username, first_name, successful_deals, completed_deals FROM users WHERE telegram_id=$1', [key]);
    if (rows[0]) p = {
      id: key,
      username: rows[0].username || '',
      name: rows[0].first_name || '',
      successfulDeals: Number(rows[0].successful_deals || 0),
      completedDeals: Number(rows[0].completed_deals || 0)
    };
  } catch {}
  profileCache.set(key, { at: Date.now(), p });
  return p;
}

async function removeGift(userId, giftId) {
  await pool.query('DELETE FROM gifts WHERE user_id=$1 AND id=$2', [userId, giftId]);
}
async function addGift(userId, gift) {
  await pool.query('INSERT INTO gifts (id, user_id, name, rarity, image, bg) VALUES ($1,$2,$3,$4,$5,$6)', [gift.id, userId, gift.name, gift.rarity, gift.image, gift.bg ? JSON.stringify(gift.bg) : null]);
}
async function setUserBalance(userId, currency, value) {
  await pool.query(`UPDATE users SET ${currency}=$1 WHERE telegram_id=$2`, [value, userId]);
}

function validateTelegramInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'))) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

const listeners = {};
function notify(userId, payload) {
  const res = listeners[userId];
  if (res) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  }
}
setInterval(() => {
  for (const userId in listeners) {
    try { listeners[userId].write(': ping\n\n'); } catch {}
  }
}, 20000);

async function mapTradeRow(row) {
  const seller = await profileOf(row.seller_id);
  const buyer = row.buyer_id == null ? null : await profileOf(row.buyer_id);
  return {
    tradeId: row.trade_id,
    sellerId: Number(row.seller_id),
    buyerId: row.buyer_id == null ? null : Number(row.buyer_id),
    sellerGift: row.seller_gift,
    buyerOffer: row.buyer_offer,
    wantOffer: row.want_offer || null,
    status: row.status,
    createdAt: Number(row.created_at),
    comment: row.comment || '',
    bankAccount: BANK_ACCOUNT,
    sellerName: seller.name || '',
    sellerUsername: seller.username || '',
    buyerName: buyer ? buyer.name : '',
    buyerUsername: buyer ? buyer.username : '',
    link: row.link || ('https://t.me/' + (botUsername || 'SuppGiftbot') + '?start=trade_' + row.trade_id)
  };
}

const GS_API = 'https://gifts.supply/api/v1/catalog';
const gsCache = new Map();
const assetCacheDir = path.join(__dirname, 'public', 'gifts', 'cache');
fs.mkdirSync(path.join(assetCacheDir, 'models'), { recursive: true });
fs.mkdirSync(path.join(assetCacheDir, 'backdrops'), { recursive: true });

async function gsFetch(url) {
  if (gsCache.has(url)) return gsCache.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('gifts.supply HTTP ' + res.status);
  const data = await res.json();
  gsCache.set(url, data);
  return data;
}
async function gsFetchAll(baseUrl) {
  let items = [];
  let offset = 0;
  for (let page = 0; page < 4; page++) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const data = await gsFetch(`${baseUrl}${sep}limit=200&offset=${offset}`);
    items = items.concat(data.items || []);
    if (!data.pagination || !data.pagination.has_more) break;
    offset += (data.items || []).length;
  }
  return items;
}
const gsNorm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
let gsCollections = null;
async function getGsCollections() {
  if (!gsCollections) {
    const data = await gsFetch(GS_API + '/collections?limit=200');
    gsCollections = data.items || [];
  }
  return gsCollections;
}
let priceMap = null;
async function getPriceMap() {
  if (priceMap) return priceMap;
  const colls = await getGsCollections();
  const map = {};
  for (const c of colls) {
    const floor = parseFloat(c.floor_price);
    map[gsNorm(c.slug)] = isFinite(floor) && floor > 0 ? floor : null;
  }
  priceMap = map;
  setTimeout(() => { priceMap = null; }, 15 * 60 * 1000);
  return map;
}
let tonRates = { usd: 1.44, rub: 122.97, ts: 0 };
async function getTonRates() {
  if (Date.now() - tonRates.ts < 30 * 60 * 1000) return tonRates;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd,rub', { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const t = j['the-open-network'];
    if (t && t.usd > 0 && t.rub > 0) tonRates = { usd: t.usd, rub: t.rub, ts: Date.now() };
  } catch {}
  return tonRates;
}
function fmtRub(v) { return Math.round(v / 50) * 50; }

app.get('/api/user/:id', async (req, res) => {
  try { res.json(await getUser(Number(req.params.id))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/profile/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Некорректный ID' });
  const p = await profileOf(id);
  res.json({
    id,
    name: p.name || '',
    username: p.username || '',
    successfulDeals: Number(p.successfulDeals || 0),
    completedDeals: Number(p.completedDeals || 0)
  });
});

const avatarCache = new Map();
app.get('/api/avatar/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).end();
  const hit = avatarCache.get(id);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) {
    res.set('Content-Type', hit.ctype);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(hit.data);
  }
  try {
    const photos = await bot.telegram.getUserProfilePhotos(id, 0, 1);
    if (!photos || !photos.total_count || !photos.photos || !photos.photos.length) return res.status(404).end();
    const sizes = photos.photos[0];
    const fileId = sizes[sizes.length - 1].file_id;
    const file = await bot.telegram.getFile(fileId);
    if (!file || !file.file_path) return res.status(404).end();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    https.get(url, { agent: tgAgent }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return res.status(404).end(); }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const data = Buffer.concat(chunks);
        if (!data.length) return res.status(404).end();
        const ctype = r.headers['content-type'] || 'image/jpeg';
        avatarCache.set(id, { data, ctype, at: Date.now() });
        res.set('Content-Type', ctype);
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(data);
      });
    }).on('error', () => res.status(404).end());
  } catch {
    res.status(404).end();
  }
});

app.post('/api/trade/create', async (req, res) => {
  try {
    const { sellerId, giftId, comment } = req.body;
    const user = await getUser(sellerId);
    const giftIndex = user.gifts.findIndex(g => g.id === giftId);
    if (giftIndex === -1) return res.status(400).json({ error: 'Подарок не найден' });
    const gift = user.gifts.splice(giftIndex, 1)[0];
    await removeGift(Number(sellerId), gift.id);
    const tradeId = uuidv4().slice(0, 8);
    let username = botUsername || bot.botInfo?.username;
    if (!username) {
      try { const me = await bot.telegram.getMe(); username = me.username; botUsername = username; } catch {}
    }
    const link = `https://t.me/${username || 'SuppGiftbot'}?start=trade_${tradeId}`;
    await pool.query('INSERT INTO trades (trade_id, seller_id, buyer_id, seller_gift, buyer_offer, status, comment, link, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [tradeId, Number(sellerId), null, JSON.stringify(gift), null, 'waiting', typeof comment === 'string' ? comment.trim().slice(0, 300) : '', link, Date.now()]);
    dbTrade = { tradeId, link };
    res.json({ tradeId, link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gifts', (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'gifts', 'nft', 'catalog-nft.json'), 'utf8').replace(/^\uFEFF/, '');
    res.json(JSON.parse(raw).filter(g => g.id !== 'plushpepe'));
  } catch {
    res.json([]);
  }
});

app.get('/api/gifts/:slug/options', async (req, res) => {
  try {
    const colls = await getGsCollections();
    const coll = colls.find(c => gsNorm(c.slug) === gsNorm(req.params.slug));
    if (!coll) return res.status(404).json({ error: 'Коллекция не найдена' });
    const [models, backdrops] = await Promise.all([
      gsFetchAll(`${GS_API}/models?collections=${encodeURIComponent(coll.slug)}`),
      gsFetchAll(`${GS_API}/backdrops?collection=${encodeURIComponent(coll.slug)}`)
    ]);
    res.json({
      collection: { slug: coll.slug, name: coll.name },
      models: models.map(m => ({ id: m.id, name: m.name, color: m.color_hex })),
      backdrops: backdrops.map(b => ({ id: b.id, name: b.name, bg: b.gradient_stops, color: b.color_hex }))
    });
  } catch (e) {
    res.status(502).json({ error: 'gifts.supply недоступен: ' + e.message });
  }
});

app.get('/gift-asset/:kind/:file', async (req, res) => {
  const { kind, file } = req.params;
  if (!['models', 'backdrops', 'symbols'].includes(kind)) return res.status(400).end();
  const uuid = file.replace(/\.png$/i, '');
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) return res.status(400).end();
  const dir = path.join(assetCacheDir, kind);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, uuid + '.png');
  if (!fs.existsSync(filePath)) {
    try {
      const size = kind === 'models' ? 256 : 128;
      const r = await fetch(`${GS_API}/assets/${kind}/${uuid}/png/${size}`, { signal: AbortSignal.timeout(25000) });
      if (!r.ok) return res.status(502).end();
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 500) return res.status(502).end();
      fs.writeFileSync(filePath, buf);
    } catch {
      return res.status(502).end();
    }
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(filePath);
});

let fakeFeed = null;
let fakeFeedExpiry = 0;
async function buildFakeFeed() {
  const cat = getNftCatalog().filter(g => g.id !== 'plushpepe');
  const prices = await getPriceMap().catch(() => ({}));
  const rates = await getTonRates();
  const sellers = [492771235, 1830045672, 958221347, 2094117733, 771290485, 129087712, 663902148, 2140993271, 812447190, 197553208, 559201844, 1348872019, 2211847503, 984172650, 1122334455, 707812394];
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const count = 10 + Math.floor(Math.random() * 5);
  const pool = [...cat].sort(() => Math.random() - 0.5).slice(0, count);
  return pool.map((g, i) => {
    const floor = prices[gsNorm(g.id)];
    const mult = 1.05 + Math.random() * 0.25;
    const roll = Math.random();
    let ask;
    if (floor) {
      if (roll < 0.35) ask = { type: 'ton', text: `${Math.round(floor * mult * 100) / 100} TON` };
      else if (roll < 0.65) {
        const v = floor * mult * rates.usd;
        ask = { type: 'usdt', text: `${v < 100 ? Math.round(v * 10) / 10 : Math.round(v)} USDT` };
      } else if (roll < 0.9) {
        ask = { type: 'rub', text: `${fmtRub(floor * mult * rates.rub).toLocaleString('ru-RU')} RUB` };
      } else ask = { type: 'gift', text: 'обмен на подарок' };
    } else {
      if (roll < 0.32) ask = { type: 'usdt', text: `${Math.floor(Math.random() * 291 + 10)} USDT` };
      else if (roll < 0.64) ask = { type: 'rub', text: `${fmtRub(Math.random() * 9400 + 600).toLocaleString('ru-RU')} RUB` };
      else if (roll < 0.88) ask = { type: 'ton', text: `${(Math.random() * 246 + 4).toFixed(1)} TON` };
      else ask = { type: 'gift', text: 'обмен на подарок' };
    }
    return {
      id: `showcase_${Date.now().toString(36)}_${i}`,
      showcase: true,
      sellerId: rnd(sellers),
      sellerGift: { name: g.name, image: g.file, rarity: g.rarity, bg: g.bg || null },
      ask,
      status: Math.random() < 0.5 ? 'connected' : 'completed',
      minutesAgo: Math.floor(Math.random() * 45) + 1
    };
  });
}

app.get('/api/feed', async (req, res) => {
  const now = Date.now();
  if (!fakeFeed || now > fakeFeedExpiry) {
    fakeFeed = await buildFakeFeed();
    fakeFeedExpiry = Date.now() + 75000;
  }
  res.json(fakeFeed);
});

app.get('/api/trades', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM trades WHERE status IN ('waiting','connected','offer_made') ORDER BY created_at DESC");
    res.json(await Promise.all(rows.map(mapTradeRow)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trades/history', async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'Некорректный ID' });
    const { rows } = await pool.query(
      "SELECT * FROM trades WHERE status='completed' AND (seller_id=$1 OR buyer_id=$1) ORDER BY created_at DESC LIMIT 100",
      [userId]
    );
    const mapped = await Promise.all(rows.map(mapTradeRow));
    res.json({
      purchases: mapped.filter(t => t.buyerId === userId),
      sales: mapped.filter(t => t.sellerId === userId)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/support/tickets', async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ error: 'Некорректный ID' });
    const { rows } = await pool.query(
      'SELECT id, subject, message, status, admin_reply, created_at, replied_at FROM tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
      [userId]
    );
    const ids = rows.map(r => r.id);
    const grouped = {};
    if (ids.length) {
      const mr = await pool.query(
        'SELECT ticket_id, sender, text, created_at FROM ticket_messages WHERE ticket_id = ANY($1) ORDER BY created_at ASC, id ASC',
        [ids]
      );
      for (const m of mr.rows) {
        (grouped[m.ticket_id] = grouped[m.ticket_id] || []).push({ sender: m.sender, text: m.text, at: Number(m.created_at) });
      }
    }
    res.json(rows.map(r => {
      let messages = grouped[r.id] || [];
      if (!messages.length) {
        messages = [{ sender: 'user', text: r.message, at: Number(r.created_at) }];
        if (r.admin_reply) messages.push({ sender: 'admin', text: r.admin_reply, at: Number(r.replied_at || r.created_at) });
      }
      const last = messages[messages.length - 1];
      return {
        id: r.id,
        subject: r.subject || '',
        message: r.message,
        status: r.status,
        adminReply: r.admin_reply || '',
        createdAt: Number(r.created_at),
        repliedAt: r.replied_at ? Number(r.replied_at) : null,
        lastSender: last ? last.sender : 'user',
        lastMessage: last ? last.text : '',
        messages
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trade/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM trades WHERE trade_id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Трейд не найден' });
    res.json(await mapTradeRow(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trade/:id/connect', async (req, res) => {
  try {
    const { buyerId } = req.body;
    const buyer = Number(buyerId);
    if (!Number.isFinite(buyer) || buyer <= 0) return res.status(400).json({ error: 'Некорректный ID' });
    const { rows } = await pool.query('SELECT * FROM trades WHERE trade_id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Трейд не найден' });
    const trade = await mapTradeRow(rows[0]);
    if (['completed', 'cancelled'].includes(trade.status)) return res.status(400).json({ error: 'Сделка уже закрыта', status: trade.status });
    if (trade.sellerId === buyer) return res.status(400).json({ error: 'Это твой трейд', reason: 'own' });
    const newStatus = trade.status === 'waiting' ? 'connected' : trade.status;
    // атомарно: занять трейд можно только если он пуст или это тот же покупатель
    const upd = await pool.query(
      `UPDATE trades SET buyer_id=$1, status=$2
       WHERE trade_id=$3 AND (buyer_id IS NULL OR buyer_id=$1)
         AND status NOT IN ('completed','cancelled')
       RETURNING trade_id`,
      [buyer, newStatus, req.params.id]
    );
    if (!upd.rows.length) return res.status(400).json({ error: 'Трейд уже занят другим покупателем', reason: 'busy' });
    const firstJoin = !trade.buyerId;
    if (firstJoin) notify(trade.sellerId, { type: 'buyer_connected', tradeId: trade.tradeId, buyerId: buyer });
    res.json({ success: true, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trade/:id/offer', async (req, res) => {
  try {
    const { offer, buyerId } = req.body;
    const { rows } = await pool.query('SELECT * FROM trades WHERE trade_id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Трейд не найден' });
    const trade = await mapTradeRow(rows[0]);
    if (['completed', 'cancelled'].includes(trade.status)) return res.status(400).json({ error: 'Сделка уже закрыта', status: trade.status });
    if (!trade.buyerId || Number(buyerId) !== trade.buyerId) return res.status(403).json({ error: 'Ты не в этой сделке' });
    if (trade.status !== 'connected') return res.status(400).json({ error: 'Сделка уже в другой стадии', status: trade.status });
    trade.buyerOffer = offer;
    trade.status = 'offer_made';
    await pool.query('UPDATE trades SET buyer_offer=$1, status=$2 WHERE trade_id=$3', [JSON.stringify(offer), trade.status, trade.tradeId]);
    notify(trade.sellerId, { type: 'offer_made', tradeId: trade.tradeId, offer, buyerId: trade.buyerId });
    const buyerProfile = await profileOf(trade.buyerId);
    const offerText = offerLabel(offer);
    bot.telegram.sendMessage(trade.sellerId, `<b>Новое предложение по твоему трейду</b>\n\nПартнёр: <b>${esc(displayName(buyerProfile))}</b>\nПредлагает: <b>${esc(offerText)}</b>\nТвой подарок: ${esc(trade.sellerGift.name)}\nНомер сделки: <code>${trade.tradeId}</code>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть сделку', web_app: { url: `${APP_URL}/?v=${Date.now()}` } }]] }
    }).catch(e => console.error('DM to seller failed:', e.message));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trade/:id/confirm', async (req, res) => {
  try {
    const { userId, initData } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM trades WHERE trade_id=$1', [req.params.id]);
    if (!rows.length) return res.status(400).json({ error: 'Неверный статус сделки' });
    const trade = await mapTradeRow(rows[0]);
    const admin = initData ? validateTelegramInitData(initData) : null;
    const isAdmin = !!admin && isAdminUser(admin.id);
    if (Number(userId) !== trade.sellerId && !isAdmin) return res.status(403).json({ error: 'Только продавец может подтвердить сделку' });
    if (trade.status !== 'offer_made') return res.status(400).json({ error: 'Неверный статус сделки', status: trade.status });
    const seller = await getUser(trade.sellerId);
    const buyer = await getUser(trade.buyerId);
    const { type, data } = trade.buyerOffer || {};
    if (['usdt', 'rub', 'ton'].includes(type)) {
      if (!(Number(data) > 0) || buyer[type] < Number(data)) return res.status(400).json({ error: 'У покупателя недостаточно средств' });
    } else if (type === 'gift') {
      if (!data || buyer.gifts.findIndex(g => g.id === data.id) === -1) return res.status(400).json({ error: 'Подарок покупателя не найден' });
    } else {
      return res.status(400).json({ error: 'Некорректное предложение' });
    }
    const sGift = trade.sellerGift || {};
    // seller -> buyer
    if (sGift.kind === 'currency') {
      const c = sGift.currency;
      if (!['rub', 'usdt', 'ton'].includes(c)) return res.status(400).json({ error: 'bad seller gift' });
      const amt = Number(sGift.amount || 0);
      if (Number(seller[c] || 0) < amt) return res.status(400).json({ error: 'seller has insufficient balance' });
      seller[c] = Math.round((Number(seller[c] || 0) - amt) * 100) / 100;
      buyer[c] = Math.round((Number(buyer[c] || 0) + amt) * 100) / 100;
      await setUserBalance(trade.sellerId, c, seller[c]);
      await setUserBalance(trade.buyerId, c, buyer[c]);
    } else {
      buyer.gifts.push(sGift);
      await addGift(trade.buyerId, sGift);
    }
    // buyer -> seller
    if (['usdt', 'rub', 'ton'].includes(type)) {
      buyer[type] = Math.round((buyer[type] - Number(data)) * 100) / 100;
      seller[type] = Math.round((seller[type] + Number(data)) * 100) / 100;
      await setUserBalance(trade.buyerId, type, buyer[type]);
      await setUserBalance(trade.sellerId, type, seller[type]);
    } else {
      const giftIdx = buyer.gifts.findIndex(g => g.id === data.id);
      const buyerGift = buyer.gifts.splice(giftIdx, 1)[0];
      seller.gifts.push(buyerGift);
      await removeGift(trade.buyerId, data.id);
      await addGift(trade.sellerId, buyerGift);
    }
    await pool.query('UPDATE trades SET status=$1 WHERE trade_id=$2', ['completed', trade.tradeId]);
    notify(trade.sellerId, { type: 'completed', tradeId: trade.tradeId, role: 'seller' });
    notify(trade.buyerId, { type: 'completed', tradeId: trade.tradeId, role: 'buyer' });
    const sellerProfile = { id: trade.sellerId, username: trade.sellerUsername, name: trade.sellerName };
    const buyerProfile = { id: trade.buyerId, username: trade.buyerUsername, name: trade.buyerName };
    const marketButton = { inline_keyboard: [[{ text: 'Открыть SupGift', web_app: { url: `${APP_URL}/?v=${Date.now()}` } }]] };
    Promise.allSettled([
      bot.telegram.sendMessage(trade.sellerId,
        `<b>Обмен завершён</b>\n\nТы получил: <b>${esc(offerLabel(trade.buyerOffer))}</b>\nТы передал: ${esc(trade.sellerGift.name)}\nПартнёр: ${esc(displayName(buyerProfile))}\n\nПодарки уже в профиле.`,
        { parse_mode: 'HTML', reply_markup: marketButton }),
      bot.telegram.sendMessage(trade.buyerId,
        `<b>Обмен завершён</b>\n\nТы получил: <b>${esc(trade.sellerGift.name)}</b>\nТы передал: ${esc(offerLabel(trade.buyerOffer))}\nПартнёр: ${esc(displayName(sellerProfile))}\n\nПодарки уже в профиле.`,
        { parse_mode: 'HTML', reply_markup: marketButton })
    ]).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trade/:id/cancel', async (req, res) => {
  try {
    const { userId, initData } = req.body || {};
    const { rows } = await pool.query('SELECT * FROM trades WHERE trade_id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Трейд не найден' });
    const trade = await mapTradeRow(rows[0]);
    const admin = initData ? validateTelegramInitData(initData) : null;
    const isAdmin = !!admin && isAdminUser(admin.id);
    if (Number(userId) !== trade.sellerId && !isAdmin) return res.status(403).json({ error: 'Только продавец может отменить сделку' });
    if (['completed', 'cancelled'].includes(trade.status)) return res.status(400).json({ error: 'Сделка уже закрыта' });
    const cGift = trade.sellerGift || {};
    if (cGift.kind === 'currency') {
      // nothing was locked at create for currency offers; only gift trades restore the gift
    } else {
      await addGift(trade.sellerId, trade.sellerGift);
    }
    await pool.query('UPDATE trades SET status=$1 WHERE trade_id=$2', ['cancelled', trade.tradeId]);
    notify(trade.sellerId, { type: 'cancelled', tradeId: trade.tradeId, byAdmin: isAdmin });
    if (trade.buyerId) notify(trade.buyerId, { type: 'cancelled', tradeId: trade.tradeId, byAdmin: isAdmin });
    if (isAdmin && trade.sellerId !== Number(admin.id)) {
      bot.telegram.sendMessage(trade.sellerId, `⚠️ Администратор отменил твой трейд <code>${trade.tradeId}</code>.\nПодарок «${trade.sellerGift.name}» возвращён в профиль.`, { parse_mode: 'HTML' }).catch(() => {});
    }
    res.json({ success: true, byAdmin: isAdmin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trade/stream/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  listeners[userId] = res;
  res.write(': connected\n\n');
  req.on('close', () => {
    if (listeners[userId] === res) delete listeners[userId];
  });
});

app.post('/api/wallet/deposit', async (req, res) => {
  try {
    const { userId, currency, amount } = req.body;
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!['rub', 'usdt', 'ton'].includes(currency) || !isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Некорректная сумма' });
    const user = await getUser(Number(userId));
    user[currency] = Math.round((user[currency] + amt) * 100) / 100;
    await setUserBalance(Number(userId), currency, user[currency]);
    res.json({ success: true, balance: user[currency] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wallet/withdraw', async (req, res) => {
  try {
    const { userId, currency, amount, destination } = req.body;
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!['rub', 'usdt', 'ton'].includes(currency) || !isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Некорректная сумма' });
    const dest = String(destination || '').trim();
    if (!dest) return res.status(400).json({ error: 'Укажи реквизиты для вывода' });
    if (currency === 'rub' && !/^\+?\d{10,15}$/.test(dest.replace(/\s+/g, ''))) return res.status(400).json({ error: 'Укажи номер СБП' });
    if ((currency === 'usdt' || currency === 'ton') && dest.length < 10) return res.status(400).json({ error: 'Укажи адрес кошелька' });
    const user = await getUser(Number(userId));
    if (user[currency] < amt) return res.status(400).json({ error: 'Недостаточно средств' });
    user[currency] = Math.round((user[currency] - amt) * 100) / 100;
    await setUserBalance(Number(userId), currency, user[currency]);
    let localReq;
    try {
      localReq = await createRequest({
        type: 'withdraw_currency',
        userId: Number(userId),
        userUsername: '',
        gift: { name: currency.toUpperCase() },
        floorTon: amt,
        targetUsername: dest,
        currency,
        amount: amt,
        destination: dest
      });
    } catch (e) {
      user[currency] = Math.round((user[currency] + amt) * 100) / 100;
      await setUserBalance(Number(userId), currency, user[currency]);
      return res.status(500).json({ error: 'Не удалось создать заявку на вывод: ' + e.message });
    }
    await notifyTradeAdmin(
      `📥 <b>Новая заявка #${localReq.id}</b>\n\nТип: 💸 Вывод валюты\nОт: ID ${userId}\nВалюта: <b>${currency.toUpperCase()}</b>\nСумма: <b>${amt} ${currency.toUpperCase()}</b>\nРеквизиты: <b>${dest}</b>`,
      { inline_keyboard: [[{ text: '✅ Подтвердить выплату', callback_data: `ap_${localReq.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${localReq.id}`, style: 'danger' }]] }
    );
    res.json({ success: true, requestId: localReq.id, balance: user[currency] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/check', async (req, res) => {
  const admin = validateTelegramInitData(req.body.initData || '');
  const ok = !!admin && isAdminUser(admin.id);
  res.json({ isAdmin: ok, isMain: ok && admin.id === ADMIN_ID });
});
app.get('/api/admin/list', async (req, res) => {
  const initData = req.query.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });
  res.json({ admins: [...admins], isMain: admin.id === ADMIN_ID });
});
app.post('/api/admin/grant', async (req, res) => {
  const { initData, targetId } = req.body;
  const admin = validateTelegramInitData(initData || '');
  if (!admin || admin.id !== ADMIN_ID) return res.status(403).json({ error: 'Только главный админ может выдавать админки' });
  const target = Number(targetId);
  if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Некорректный ID' });
  await pool.query('INSERT INTO admins (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING', [target]);
  admins.add(target);
  bot.telegram.sendMessage(target, '👑 Вам выдан доступ к админ-панели Трейд-Маркета! Нажмите /start боту.').catch(() => {});
  res.json({ success: true, admins: [...admins] });
});
app.post('/api/admin/revoke', async (req, res) => {
  const { initData, targetId } = req.body;
  const admin = validateTelegramInitData(initData || '');
  if (!admin || admin.id !== ADMIN_ID) return res.status(403).json({ error: 'Только главный админ может отзывать админки' });
  const target = Number(targetId);
  if (target === ADMIN_ID) return res.status(400).json({ error: 'Главного админа нельзя снять' });
  await pool.query('DELETE FROM admins WHERE telegram_id=$1', [target]);
  admins.delete(target);
  res.json({ success: true, admins: [...admins] });
});
app.post('/api/admin/profile-grant', async (req, res) => {
  const { initData, targetId, successful, completed, mode } = req.body;
  const admin = validateTelegramInitData(initData || '');
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });
  const target = Number(targetId);
  if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Некорректный ID' });
  const s = Math.trunc(Number(successful) || 0);
  const c = Math.trunc(Number(completed) || 0);
  if (mode !== 'set' && s === 0 && c === 0) return res.status(400).json({ error: 'Укажи количество' });
  await getUser(target).catch(() => {});
  if (mode === 'set') {
    await pool.query(
      'UPDATE users SET successful_deals=GREATEST($2,0), completed_deals=GREATEST($3,0) WHERE telegram_id=$1',
      [target, s, c]
    );
  } else {
    await pool.query(
      'UPDATE users SET successful_deals=GREATEST(successful_deals+$2,0), completed_deals=GREATEST(completed_deals+$3,0) WHERE telegram_id=$1',
      [target, s, c]
    );
  }
  profileCache.delete(target);
  const p = await profileOf(target);
  res.json({
    success: true,
    profile: {
      id: target,
      name: p.name || '',
      username: p.username || '',
      successfulDeals: Number(p.successfulDeals || 0),
      completedDeals: Number(p.completedDeals || 0)
    }
  });
});

app.get('/api/admin/referrals', async (req, res) => {
  const initData = req.query.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.referrer_id, r.joiner_id, r.source, r.trade_id, r.created_at,
              ru.username AS referrer_username, rf.first_name AS referrer_name,
              ju.username AS joiner_username, jf.first_name AS joiner_name,
              js.successful_deals, js.completed_deals
         FROM referrals r
         LEFT JOIN users ru ON ru.telegram_id = r.referrer_id
         LEFT JOIN users rf ON rf.telegram_id = r.referrer_id
         LEFT JOIN users ju ON ju.telegram_id = r.joiner_id
         LEFT JOIN users jf ON jf.telegram_id = r.joiner_id
         LEFT JOIN users js ON js.telegram_id = r.joiner_id
        ORDER BY r.created_at DESC LIMIT 50`
    );
    res.json({
      referrals: rows.map(r => ({
        id: Number(r.id),
        referrerId: Number(r.referrer_id),
        referrerUsername: r.referrer_username || '',
        referrerName: r.referrer_name || '',
        joinerId: Number(r.joiner_id),
        joinerUsername: r.joiner_username || '',
        joinerName: r.joiner_name || '',
        successfulDeals: Number(r.successful_deals || 0),
        completedDeals: Number(r.completed_deals || 0),
        source: r.source || 'trade',
        tradeId: r.trade_id || '',
        createdAt: Number(r.created_at || 0)
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/issue', async (req, res) => {
  const { initData, targetId, currency, amount } = req.body;
  const admin = validateTelegramInitData(initData || '');
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });
  const user = await getUser(Number(targetId));
  if (!['rub', 'usdt', 'ton'].includes(currency)) return res.status(400).json({ error: 'Неверная валюта' });
  user[currency] = Math.round((user[currency] + Number(amount)) * 100) / 100;
  await setUserBalance(Number(targetId), currency, user[currency]);
  res.json({ success: true, user });
});
app.post('/api/admin/issue-gift', async (req, res) => {
  const { initData, targetId, giftId, modelId, backdropId, modelName, backdropStops } = req.body;
  const admin = validateTelegramInitData(initData || '');
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });
  const gift = getNftCatalog().find(g => g.id === giftId);
  if (!gift) return res.status(400).json({ error: 'Подарок не найден в каталоге' });
  let image = gift.file;
  let bg = gift.bg || null;
  let name = gift.name;
  if (modelId && /^[0-9a-fA-F-]{36}$/.test(modelId)) {
    image = `/gift-asset/models/${modelId}.png`;
    if (typeof modelName === 'string' && modelName.trim()) name = `${gift.name} · ${modelName.trim().slice(0, 40)}`;
  }
  if (backdropId && Array.isArray(backdropStops)) {
    const stops = backdropStops.slice(0, 4).filter(s => s && typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color)).map(s => ({ color: s.color, offset: typeof s.offset === 'string' ? s.offset : '0%' }));
    if (stops.length) bg = stops;
  }
  const user = await getUser(Number(targetId));
  const instance = { id: `${targetId}_${gift.id}_${Date.now().toString(36)}`, name, rarity: 'NFT', image, bg };
  await addGift(Number(targetId), instance);
  user.gifts.push(instance);
  res.json({ success: true, gift: instance });
});

// Admin: create a trade where the seller offers currency and specifies what they want in return (currency or gift)
app.post('/api/admin/trade/create', async (req, res) => {
  try {
    const { initData, sellerId, offerAmount, offerCurrency, wantType, wantCurrency, wantAmount, wantName, wantLink, comment } = req.body;
    const admin = validateTelegramInitData(initData || '');
    if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

    const seller = Number(sellerId);
    if (!Number.isFinite(seller) || seller <= 0) return res.status(400).json({ error: 'Укажи корректный ID продавца' });
    const currency = String(offerCurrency || '').toLowerCase();
    if (!['rub', 'usdt', 'ton'].includes(currency)) return res.status(400).json({ error: 'Неверная валюта' });
    const amt = Math.round(Number(offerAmount) * 100) / 100;
    if (!isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Некорректная сумма' });

    const tradeId = uuidv4().slice(0, 8);
    const link = `https://t.me/${botUsername || 'SuppGiftbot'}?start=trade_${tradeId}`;
    const sellerGift = { id: 'cur_' + tradeId, name: `${amt} ${currency.toUpperCase()}`, kind: 'currency', currency, amount: amt, image: '', bg: null };

    let want = null;
    if (wantType === 'currency') {
      const wc = String(wantCurrency || '').toLowerCase();
      if (!['rub', 'usdt', 'ton'].includes(wc)) return res.status(400).json({ error: 'Неверная валюта желаемого' });
      const wa = Math.round(Number(wantAmount) * 100) / 100;
      if (!isFinite(wa) || wa <= 0) return res.status(400).json({ error: 'Некорректная сумма желаемого' });
      want = { type: 'currency', currency: wc, amount: wa, name: `${wa} ${wc.toUpperCase()}` };
    } else {
      const wname = String(wantName || '').trim();
      if (!wname) return res.status(400).json({ error: 'Укажи, что хочешь получить взамен' });
      want = { type: 'gift', name: wname.slice(0, 100), link: String(wantLink || '').trim().slice(0, 200) };
    }

    await pool.query('INSERT INTO trades (trade_id, seller_id, buyer_id, seller_gift, buyer_offer, want_offer, status, comment, link, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [tradeId, seller, null, JSON.stringify(sellerGift), null, JSON.stringify(want), 'waiting', typeof comment === 'string' ? comment.trim().slice(0, 300) : '', link, Date.now(), Number(admin.id)]);

    res.json({ success: true, tradeId, link, sellerGift, wantOffer: want });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

bot.command('addadmin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Недостаточно прав');
  const target = Number((ctx.message.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(target) || target <= 0) return ctx.reply('Использование: /addadmin <Telegram ID>');
  await pool.query('INSERT INTO admins (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING', [target]);
  admins.add(target);
  ctx.reply(`✅ Пользователь ${target} теперь админ.\nОн получит доступ при нажатии /start.`);
  bot.telegram.sendMessage(target, '👑 Вам выдан доступ к админ-панели Трейд-Маркета! Нажмите /start боту.').catch(() => {});
});
bot.command('deladmin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Недостаточно прав');
  const target = Number((ctx.message.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(target)) return ctx.reply('Использование: /deladmin <Telegram ID>');
  if (target === ADMIN_ID) return ctx.reply('Главного админа нельзя снять');
  await pool.query('DELETE FROM admins WHERE telegram_id=$1', [target]);
  admins.delete(target);
  ctx.reply(`❌ Пользователь ${target} больше не админ.`);
});
bot.command('admins', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Недостаточно прав');
  const list = [...admins];
  ctx.reply(`👑 Главный админ: <code>${ADMIN_ID}</code>\n\nВыданные админки (${list.length}):\n${list.map(id => `• <code>${id}</code>`).join('\n') || '— нет —'}`, { parse_mode: 'HTML' });
});

bot.command('tickets', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.reply('Недостаточно прав');
  try {
    const { rows } = await pool.query("SELECT * FROM tickets WHERE status='open' ORDER BY created_at DESC LIMIT 20");
    if (!rows.length) return ctx.reply('Нет открытых тикетов.');
    for (const t of rows) {
      await ctx.reply(`🎫 <b>Тикет #${t.id}</b>\nОт: ID ${t.user_id}\nТема: ${t.subject || '—'}\nСообщение: ${t.message}\n\nОтветить: /reply ${t.id} &lt;текст&gt;`, { parse_mode: 'HTML' });
    }
  } catch (e) { ctx.reply('Ошибка: ' + e.message); }
});

bot.command('reply', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.reply('Недостаточно прав');
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const ticketId = parts[1];
  const replyText = parts.slice(2).join(' ').trim();
  if (!ticketId || !replyText) return ctx.reply('Использование: /reply <ticket_id> <текст>');
  try {
    const { rows } = await pool.query('SELECT * FROM tickets WHERE id=$1', [ticketId]);
    const ticket = rows[0];
    if (!ticket) return ctx.reply('Тикет не найден');
    await pool.query("UPDATE tickets SET status='answered', admin_reply=$1, replied_at=$2 WHERE id=$3", [replyText, Date.now(), ticketId]);
    await addTicketMessage(ticketId, 'admin', replyText);
    await bot.telegram.sendMessage(ticket.user_id, `🎫 Поддержка ответила по тикету #${ticket.id}:\n\n${replyText}`).catch(() => {});
    ctx.reply(`✅ Ответ отправлен по тикету #${ticketId}.`);
  } catch (e) { ctx.reply('Ошибка: ' + e.message); }
});

bot.command('requests', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.reply('Недостаточно прав');
  try {
    const { rows } = await pool.query("SELECT * FROM requests WHERE status='pending' ORDER BY created_at DESC LIMIT 20");
    if (!rows.length) return ctx.reply('Нет ожидающих заявок.');
    for (const r of rows) {
      const gift = r.gift;
      const text = r.type === 'withdraw'
        ? `📥 <b>Заявка #${r.id}</b>\nТип: вывод подарка\nОт: ID ${r.user_id}\nКуда: @${r.target_username}\nПодарок: ${gift ? gift.name : '—'}`
        : r.type === 'withdraw_currency'
        ? `📥 <b>Заявка #${r.id}</b>\nТип: вывод валюты\nОт: ID ${r.user_id}\nВалюта: ${r.currency}\nСумма: ${r.amount} ${r.currency}\nРеквизиты: ${r.destination}`
        : r.type === 'deposit_gift'
        ? `📥 <b>Заявка #${r.id}</b>\nТип: пополнение подарком\nОт: ID ${r.user_id}\nПодарок: ${gift ? gift.name : '—'}\nНа банк-аккаунт: @${r.target_username}`
        : r.type === 'sell'
        ? `📥 <b>Заявка #${r.id}</b>\nТип: продажа подарка\nОт: ID ${r.user_id}\nПодарок: ${gift ? gift.name : '—'}\nЦена: ${r.amount} ${r.currency || ''}\nКурс: ${r.floor_ton ?? ''} TON`
        : `📥 <b>Заявка #${r.id}</b>\nТип: пополнение ${r.currency || ''}\nОт: ID ${r.user_id}\nСумма: ${r.amount} ${r.currency || ''}\nTX: ${r.tx_hash || '—'}`;
      const verb = r.type === 'withdraw' ? '✅ Подтвердить вывод'
        : r.type === 'withdraw_currency' ? '✅ Подтвердить выплату'
        : '✅ Зачислить';
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: verb, callback_data: `ap_${r.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${r.id}`, style: 'danger' }]] } });
    }
  } catch (e) { ctx.reply('Ошибка: ' + e.message); }
});

async function createAdminTrade(seller, offer, want, comment, existingTradeId, creatorId) {
  const sellerId = Number(seller);
  if (!Number.isFinite(sellerId) || sellerId <= 0) return { error: 'Некорректный ID продавца' };
  const currency = String(offer.currency || '').toLowerCase();
  if (!['rub', 'usdt', 'ton'].includes(currency)) return { error: 'Неверная валюта' };
  const amt = Math.round(Number(offer.amount) * 100) / 100;
  if (!isFinite(amt) || amt <= 0) return { error: 'Некорректная сумма' };
  let wantOffer = null;
  if (want && want.type === 'currency') {
    const wc = String(want.currency || '').toLowerCase();
    const wa = Math.round(Number(want.amount) * 100) / 100;
    wantOffer = { type: 'currency', currency: wc, amount: wa, name: `${wa} ${wc.toUpperCase()}` };
  } else if (want && want.type === 'gift') {
    wantOffer = { type: 'gift', name: String(want.name || '').slice(0, 100), link: String(want.link || '').slice(0, 200) };
  }
  if (existingTradeId) {
    await pool.query('UPDATE trades SET want_offer=$1, comment=$2 WHERE trade_id=$3', [JSON.stringify(wantOffer), comment ? String(comment).slice(0, 300) : '', existingTradeId]);
    const link = `https://t.me/${botUsername || 'SuppGiftbot'}?start=trade_${existingTradeId}`;
    return { success: true, tradeId: existingTradeId, link, wantOffer };
  }
  const tradeId = uuidv4().slice(0, 8);
  const link = `https://t.me/${botUsername || 'SuppGiftbot'}?start=trade_${tradeId}`;
  const sellerGift = { id: 'cur_' + tradeId, name: `${amt} ${currency.toUpperCase()}`, kind: 'currency', currency, amount: amt, image: '', bg: null };
  await pool.query('INSERT INTO trades (trade_id, seller_id, buyer_id, seller_gift, buyer_offer, want_offer, status, comment, link, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [tradeId, sellerId, null, JSON.stringify(sellerGift), null, JSON.stringify(wantOffer), 'waiting', comment ? String(comment).slice(0, 300) : '', link, Date.now(), creatorId ? Number(creatorId) : null]);
  return { success: true, tradeId, link, sellerGift, wantOffer };
}

async function resolveUsername(username) {
  try {
    const { rows } = await pool.query('SELECT telegram_id FROM users WHERE LOWER(username)=$1 LIMIT 1', [String(username).toLowerCase()]);
    return rows.length ? Number(rows[0].telegram_id) : null;
  } catch { return null; }
}

async function parseAdminTradeText(text) {
  if (!text) return null;
  let s = String(text);
  const u = (botUsername || 'SuppGiftbot').toLowerCase();
  const re = new RegExp('@' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const mm = re.exec(s);
  if (mm) s = (s.slice(0, mm.index) + ' ' + s.slice(mm.index + mm[0].length)).trim();
  if (!s) return null;
  const tokens = s.split(/\s+/).filter(Boolean);
  let at = tokens.findIndex(t => t[0] === '@');
  let pre, post, sellerToken = null;
  if (at === -1) {
    pre = tokens.slice(0, 2);
    post = tokens.slice(2);
  } else {
    pre = tokens.slice(0, at);
    post = tokens.slice(at + 1);
    sellerToken = tokens[at];
  }
  const offerMatch = pre.join(' ').match(/^(\d+(?:[.,]\d+)?)\s*(ton|usdt|rub)$/i);
  if (!offerMatch) return null;
  const offer = { amount: Number(offerMatch[1].replace(',', '.')), currency: offerMatch[2].toLowerCase() };
  const wantStr = post.join(' ');
  let want = null;
  if (wantStr) {
    const wm = wantStr.match(/^(\d+(?:[.,]\d+)?)\s*(ton|usdt|rub)$/i);
    if (wm) want = { type: 'currency', currency: wm[2].toLowerCase(), amount: Number(wm[1].replace(',', '.')) };
    else want = { type: 'gift', name: wantStr, link: wantStr };
  }
  if (!want && !sellerToken) return null;
  return { offer, want, sellerUsername: sellerToken ? sellerToken.slice(1) : null };
}

function parseAdminNftText(text) {
  if (!text) return null;
  let s = String(text).trim();
  const u = (botUsername || 'SuppGiftbot').toLowerCase();
  const re = new RegExp('@' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const mm = re.exec(s);
  if (mm) s = (s.slice(0, mm.index) + ' ' + s.slice(mm.index + mm[0].length)).trim();
  if (!s) return null;
  const tokens = s.split(/\s+/).filter(Boolean);
  const atIdx = tokens.findIndex(t => t[0] === '@');
  if (atIdx === -1) return null;
  const sellerToken = tokens[atIdx];
  const linkPart = tokens.slice(0, atIdx).join(' ');
  const ml = linkPart.match(/(?:t\.me\/nft\/)?([a-z0-9_]{2,64})(?:-(\d+))?/i);
  if (!ml) return null;
  const giftId = ml[1].toLowerCase();
  const idx = ml[2] ? Number(ml[2]) : 1;
  const gift = getNftCatalog().find(g => g.id.toLowerCase() === giftId);
  if (!gift) return null;
  return { targetUsername: sellerToken.slice(1), gift, idx };
}

async function resolveNftGift(gift, idx) {
  try {
    const colls = await getGsCollections();
    const coll = colls.find(c => gsNorm(c.slug) === gsNorm(gift.id));
    if (!coll) return null;
    const [models, backdrops] = await Promise.all([
      gsFetchAll(`${GS_API}/models?collections=${encodeURIComponent(coll.slug)}`),
      gsFetchAll(`${GS_API}/backdrops?collection=${encodeURIComponent(coll.slug)}`)
    ]);
    const n = Math.max(1, Math.floor(idx));
    const model = models[(n - 1) % (models.length || 1)];
    const backdrop = backdrops[(n - 1) % (backdrops.length || 1)];
    const name = model && model.name ? `${gift.name} · ${model.name}` : gift.name;
    return {
      name,
      rarity: gift.rarity || 'NFT',
      image: model ? `/gift-asset/models/${model.id}.png` : gift.file,
      bg: backdrop && Array.isArray(backdrop.gradient_stops) && backdrop.gradient_stops.length ? backdrop.gradient_stops : (gift.bg || null)
    };
  } catch {
    return null;
  }
}

async function adminNftCard(ctx, target, gift, instance) {
  const sender = ctx.from || {};
  const who = sender.username ? '@' + sender.username : (sender.first_name || 'Админ');
  const targetLabel = target.username ? '@' + target.username : (target.first_name || 'ID ' + target.id);
  const caption = `${who} выдал подарок ${targetLabel}\n\n` +
    `Подарок: <b>${esc(gift.name)}</b>\n` +
    `Редкость: ${esc(gift.rarity || 'NFT')}\n\n` +
    `Открывай профиль — подарок уже у тебя.`;
  const kb = { inline_keyboard: [[{ text: 'Открыть профиль', web_app: { url: `${APP_URL}/?profile=${target.id}&v=${Date.now()}` } }]] };
  const chatId = ctx.chat && ctx.chat.id;
  try {
    await bot.telegram.sendPhoto(chatId, { source: path.join(__dirname, 'public', 'trade.jpg') }, { caption, parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await bot.telegram.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  }
}

async function adminTradeCard(ctx, seller, offer, want, tradeId, link) {
  const sender = ctx.from || {};
  const who = sender.username ? '@' + sender.username : (sender.first_name || displayName(await profileOf(seller).catch(() => ({ id: seller, name: '', username: '' }))));
  const offerLabel2 = `${offer.amount} ${offer.currency.toUpperCase()}`;
  const wantLabel2 = want ? (want.type === 'currency' ? `${want.amount} ${want.currency.toUpperCase()}` : (want.link || want.name)) : 'любой подарок';
  const caption = `<b>${esc(who)} приглашает тебя обменяться</b>\n\n` +
    `Предлагает: <b>${esc(offerLabel2)}</b>\n` +
    `Хочет получить: <b>${esc(wantLabel2)}</b>\n\n` +
    `Согласен? Открой сделку, добавь свой подарок и подтверди обмен.`;
  const kb = { inline_keyboard: [[{ text: 'Открыть сделку', web_app: { url: `${APP_URL}/trade.html?id=${tradeId}&v=${Date.now()}` } }]] };
  const chatId = ctx.chat && ctx.chat.id;
  try {
    await bot.telegram.sendPhoto(chatId, { source: path.join(__dirname, 'public', 'trade.jpg') }, { caption, parse_mode: 'HTML', reply_markup: kb });
  } catch {
    await bot.telegram.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  }
}

bot.on('message', async (ctx, next) => {
  try {
    const text = ctx.message && ctx.message.text;
    if (text && isAdminUser(Number(ctx.from.id))) {
      const cmd = await parseAdminTradeText(text);
      if (cmd) {
        try {
          let seller = null;
          if (cmd.sellerUsername) {
            const { rows } = await pool.query('SELECT telegram_id FROM users WHERE LOWER(username)=$1', [cmd.sellerUsername.toLowerCase()]);
            if (!rows.length) return ctx.reply(`❌ Пользователь @${cmd.sellerUsername} не найден в базе.`, { reply_to_message_id: ctx.message.message_id });
            seller = Number(rows[0].telegram_id);
          } else {
            seller = Number(ctx.from.id);
          }
          const res = await createAdminTrade(seller, cmd.offer, cmd.want, null, null, ctx.from.id);
          if (!res.success) return ctx.reply(`❌ ${res.error || 'не удалось создать трейд'}.`, { reply_to_message_id: ctx.message.message_id });
          await adminTradeCard(ctx, seller, cmd.offer, cmd.want, res.tradeId, res.link);
        } catch (e) {
          ctx.reply('❌ Ошибка: ' + (e && e.message ? e.message : 'неизвестно'), { reply_to_message_id: ctx.message.message_id }).catch(() => {});
        }
        return;
      }
      const ncmd = parseAdminNftText(text);
      if (ncmd) {
        try {
          const { rows } = await pool.query('SELECT telegram_id, first_name, username FROM users WHERE LOWER(username)=$1', [ncmd.targetUsername.toLowerCase()]);
          if (!rows.length) return ctx.reply(`❌ Пользователь @${ncmd.targetUsername} не найден в базе.`, { reply_to_message_id: ctx.message.message_id });
          const target = rows[0];
          const targetId = Number(target.telegram_id);
          await getUser(targetId);
          const resolved = await resolveNftGift(ncmd.gift, ncmd.idx) || { name: ncmd.gift.name, rarity: ncmd.gift.rarity || 'NFT', image: ncmd.gift.file, bg: ncmd.gift.bg || null };
          const instance = { id: `${targetId}_${ncmd.gift.id}_${Date.now().toString(36)}`, name: resolved.name, rarity: resolved.rarity, image: resolved.image, bg: resolved.bg };
          await addGift(targetId, instance);
          await adminNftCard(ctx, target, ncmd.gift, instance);
        } catch (e) {
          ctx.reply('❌ Ошибка: ' + (e && e.message ? e.message : 'неизвестно'), { reply_to_message_id: ctx.message.message_id }).catch(() => {});
        }
        return;
      }
    }
    const pend = pendingTicketReplies.get(Number(ctx.from.id));
    if (pend && text && !text.startsWith('/')) {
      pendingTicketReplies.delete(Number(ctx.from.id));
      const { rows } = await pool.query('SELECT * FROM tickets WHERE id=$1', [pend.ticketId]);
      const t = rows[0];
      if (!t) return ctx.reply('Тикет не найден');
      if (t.status !== 'open') return ctx.reply('Тикет уже закрыт.');
      await closeTicketReply(pend.ticketId, text.slice(0, 2000));
      await bot.telegram.sendMessage(t.user_id, `🎫 Поддержка ответила по тикету #${t.id}:\n\n${text.slice(0, 4000)}`).catch(() => {});
      return ctx.reply(`✅ Ответ по тикету #${pend.ticketId} отправлен пользователю.`);
    }
  } catch (e) { console.error('Ticket reply failed:', e.message); }
  return next();
});

bot.on('inline_query', async (ctx) => {
  const q = (ctx.inlineQuery.query || '').trim();
  const from = ctx.inlineQuery.from;
  await rememberUser(from).catch(() => {});
  const who = displayName(await profileOf(from.id));
  let tradeId = null;
  const m = q.match(/trade[_-]?([a-z0-9]{6,16})/i) || q.match(/^([a-z0-9]{6,16})$/i);
  if (m) tradeId = m[1];
  try {
    // Admin: inline trade command "@SuppGiftbot 23 TON @seller <want>" -> create + card
    if (isAdminUser(Number(from.id)) && q) {
      const ncmd = parseAdminNftText(q);
      if (ncmd) {
        const { rows } = await pool.query('SELECT telegram_id, first_name, username FROM users WHERE LOWER(username)=$1', [ncmd.targetUsername.toLowerCase()]);
        if (!rows.length) return ctx.answerInlineQuery([{ type: 'article', id: 'nft_err', title: 'Пользователь не найден', input_message_content: { message_text: `Пользователь @${ncmd.targetUsername} не найден в базе.` }, description: `@${ncmd.targetUsername} не в системе` }], { cache_time: 0, is_personal: true });
        const target = rows[0];
        const targetId = Number(target.telegram_id);
        await getUser(targetId);
        const resolved = await resolveNftGift(ncmd.gift, ncmd.idx) || { name: ncmd.gift.name, rarity: ncmd.gift.rarity || 'NFT', image: ncmd.gift.file, bg: ncmd.gift.bg || null };
        const instance = { id: `${targetId}_${ncmd.gift.id}_${Date.now().toString(36)}`, name: resolved.name, rarity: resolved.rarity, image: resolved.image, bg: resolved.bg };
        await addGift(targetId, instance);
        const targetLabel = '@' + (target.username || ncmd.targetUsername);
        const caption = `${who} выдал подарок ${targetLabel}\n\n` +
          `Подарок: ${resolved.name}\n` +
          `Редкость: ${resolved.rarity}\n\n` +
          `Открывай профиль — подарок уже у тебя.`;
        return ctx.answerInlineQuery([{
          type: 'photo',
          id: 'nft_' + targetId + '_' + Date.now().toString(36),
          photo_url: `${mediaUrl('/trade.jpg')}`,
          photo_width: 1280,
          photo_height: 511,
          thumb_url: `${mediaUrl('/trade-thumb.jpg')}`,
          thumb_width: 512,
          thumb_height: 512,
          title: `Подарок выдан ${targetLabel}`,
          description: ncmd.gift.name,
          caption,
          show_caption_above_media: false,
          reply_markup: { inline_keyboard: [[{ text: 'Открыть профиль', url: `https://t.me/${botUsername || 'SuppGiftbot'}?start=profile_${targetId}` }]] }
        }], { cache_time: 0, is_personal: true });
      }
      const cmd = await parseAdminTradeText(q);
      if (cmd) {
        const seller = cmd.sellerUsername ? await resolveUsername(cmd.sellerUsername) : Number(from.id);
        if (!seller) return ctx.answerInlineQuery([{ type: 'article', id: 'adm_err', title: 'Продавец не найден', input_message_content: { message_text: `Пользователь @${cmd.sellerUsername} не найден в базе.` }, description: `@${cmd.sellerUsername} не в системе` }], { cache_time: 0, is_personal: true });
        const key = seller + '|' + cmd.offer.amount + '|' + cmd.offer.currency;
        const cached = adminTradeCache.get(key);
        const res = await createAdminTrade(seller, cmd.offer, cmd.want, null, cached ? cached.tradeId : null, from.id);
        if (!res.success) return ctx.answerInlineQuery([{ type: 'article', id: 'adm_err', title: 'Нельзя создать трейд', input_message_content: { message_text: `❌ ${res.error}` }, description: res.error }], { cache_time: 0, is_personal: true });
        if (!cached) adminTradeCache.set(key, { tradeId: res.tradeId, at: Date.now() });
        const whoName = from.username ? '@' + from.username : (from.first_name || who);
        const offerLabel2 = `${cmd.offer.amount} ${cmd.offer.currency.toUpperCase()}`;
        const wantLabel2 = cmd.want ? (cmd.want.type === 'currency' ? `${cmd.want.amount} ${cmd.want.currency.toUpperCase()}` : (cmd.want.link || cmd.want.name)) : 'любой подарок';
        const caption = `${whoName} приглашает тебя обменяться\n\n` +
          `Предлагает: ${offerLabel2}\n` +
          `Хочет получить: ${wantLabel2}\n\n` +
          `Согласен? Открой сделку, добавь свой подарок и подтверди обмен.`;
        const openLink = `https://t.me/${botUsername || 'SuppGiftbot'}?start=trade_${res.tradeId}`;
        return ctx.answerInlineQuery([{
          type: 'photo',
          id: 'adm_' + res.tradeId,
          photo_url: `${mediaUrl('/trade.jpg')}`,
          photo_width: 1280,
          photo_height: 511,
          thumb_url: `${mediaUrl('/trade-thumb.jpg')}`,
          thumb_width: 512,
          thumb_height: 512,
          title: `${whoName} приглашает тебя обменяться`,
          description: `${offerLabel2}  |  ${wantLabel2}`,
          caption,
          show_caption_above_media: false,
          reply_markup: { inline_keyboard: [[{ text: 'Открыть сделку', url: openLink }]] }
        }], { cache_time: 0, is_personal: true });
      }
    }
    let rows = [];
    if (tradeId) {
      ({ rows } = await pool.query('SELECT trade_id, seller_id, seller_gift, buyer_offer, want_offer, status FROM trades WHERE trade_id=$1', [tradeId]));
    } else {
      ({ rows } = await pool.query(
        "SELECT trade_id, seller_id, seller_gift, buyer_offer, want_offer, status FROM trades WHERE seller_id=$1 AND status IN ('waiting','connected','offer_made') ORDER BY created_at DESC LIMIT 20",
        [from.id]
      ));
    }
    const results = [];
    for (const tr of rows) {
      if (tr.status === 'completed' || tr.status === 'cancelled') continue;
      const gift = (tr.seller_gift && tr.seller_gift.name) ? tr.seller_gift.name : 'подарок';
      const want = tr.want_offer ? wantOfferLabel(tr.want_offer) : offerLabel(tr.buyer_offer);
      const link = `https://t.me/${botUsername || 'SuppGiftbot'}?start=trade_${tr.trade_id}`;
      const title = `${who} приглашает тебя обменяться`;
      const isCurrency = tr.seller_gift && tr.seller_gift.kind === 'currency';
      const message = `${who} приглашает тебя обменяться\n` +
        `${isCurrency ? 'Предлагает' : 'Подарок'}: ${gift}\n` +
        `Хочет получить: ${want}\n\n` +
        `Открой сделку, добавь свой подарок и подтверди обмен.`;
      results.push({
        type: 'photo',
        id: tr.trade_id,
        photo_url: `${mediaUrl('/trade.jpg')}`,
        photo_width: 1280,
        photo_height: 511,
        thumb_url: `${mediaUrl('/trade-thumb.jpg')}`,
        thumb_width: 512,
        thumb_height: 512,
        title,
        description: `${gift}  |  ${want}`,
        caption: message,
        show_caption_above_media: false,
        reply_markup: {
          inline_keyboard: [[{ text: 'Открыть окно обмена', url: link }]],
        },
      });
    }
    return ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
  } catch (e) {
    console.error('inline_query failed:', e.message);
    return ctx.answerInlineQuery([], { cache_time: 0 }).catch(() => {});
  }
});

async function notifyJoin(referrerId, joinerId, meta) {
  try {
    const ref = Number(referrerId);
    const joiner = Number(joinerId);
    if (!Number.isFinite(ref) || !Number.isFinite(joiner) || ref <= 0 || joiner <= 0 || ref === joiner) return false;
    const { rows } = await pool.query(
      `INSERT INTO referrals (referrer_id, joiner_id, source, trade_id, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (referrer_id, joiner_id) DO NOTHING
       RETURNING id`,
      [ref, joiner, (meta && meta.source) || 'trade', (meta && meta.tradeId) || null, Date.now()]
    );
    // notif-photo-patch: trade joins always notify, photo preview
    if (!rows.length && (!meta || meta.source !== 'trade')) return false;
    const p = await profileOf(joiner);
    const who = p.username ? '@' + p.username : (p.name || ('ID ' + joiner));
    const title = (meta && meta.source === 'ref')
      ? `👤 <b>По твоей ссылке присоединился ${esc(who)}</b>`
      : `👤 <b>Присоединился ${esc(who)}</b>`;
    const sub = (meta && meta.source === 'ref')
      ? 'Человек открыл твою ссылку на SupGift.'
      : 'Человек открыл твою трейд-ссылку.';
    const kb = {
      inline_keyboard: [[{
        text: '👤 Посмотреть профиль',
        web_app: { url: `${APP_URL}/?profile=${joiner}&v=${Date.now()}` }
      }]]
    };
    try {
      await bot.telegram.sendPhoto(ref, { source: path.join(__dirname, 'public', 'trade.jpg') }, {
        caption: `${title}\n\n${sub}`,
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    } catch (photoErr) {
      await bot.telegram.sendMessage(ref, `${title}\n\n${sub}`, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
    }
    return true;
  } catch (e) {
    console.error('join notify failed:', e && e.message ? e.message : e);
    return false;
  }
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  await getUser(userId);
  await rememberUser(ctx.from);
  const appUrl = APP_URL;
  const payload = ctx.startPayload;
  if (payload && payload.startsWith('ref_')) {
    const refId = Number(String(payload.slice(4)).replace(/\D/g, ''));
    if (Number.isFinite(refId) && refId > 0 && refId !== userId) {
      await notifyJoin(refId, userId, { source: 'ref' });
    }
  }
  if (payload && payload.startsWith('trade_')) {
    const tradeId = payload.replace('trade_', '').slice(0, 64);
    const openButton = { text: 'Присоединиться к трейду', web_app: { url: `${appUrl}/trade.html?id=${encodeURIComponent(tradeId)}&v=${Date.now()}` } };
    try {
      const { rows } = await pool.query('SELECT seller_id, seller_gift, status, created_by FROM trades WHERE trade_id=$1', [tradeId]);
      if (!rows.length) {
        return safeReply(ctx, 'Этот трейд не найден или уже удалён.', { reply_markup: { inline_keyboard: [[{ text: 'Открыть SupGift', web_app: { url: `${appUrl}/?v=${Date.now()}` } }]] } });
      }
      const tr = rows[0];
      if (tr.status === 'completed' || tr.status === 'cancelled') {
        return safeReply(ctx, 'Этот трейд уже завершён. Открой SupGift, чтобы создать новый обмен.', { reply_markup: { inline_keyboard: [[{ text: 'Открыть SupGift', web_app: { url: `${appUrl}/?v=${Date.now()}` } }]] } });
      }
      await notifyJoin(tr.seller_id, userId, { source: 'trade', tradeId });
      const inviterId = tr.created_by || tr.seller_id;
      const inviter = await profileOf(inviterId);
      const who = inviter.username ? '@' + inviter.username : (inviter.name || 'Пользователь');
      const gift = (tr.seller_gift && tr.seller_gift.name) ? tr.seller_gift.name : 'подарок';
      return safeReply(ctx,
        `<b>${esc(who)} приглашает тебя обменяться!</b>\n\n` +
        `Подарок партнёра: <b>${esc(gift)}</b>\n\n` +
        `Открой окно обмена, выбери что предложить взамен и подтверди сделку.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[openButton]] } }
      );
    } catch (e) {
      return safeReply(ctx, 'Не удалось открыть трейд. Попробуй ещё раз.', {
        reply_markup: { inline_keyboard: [[openButton]] }
      });
    }
  }
  const keyboard = [
    [{ text: 'Открыть SupGift', web_app: { url: `${appUrl}/?v=${Date.now()}` } }],
  ];
  if (isAdminUser(userId)) keyboard.push([{ text: 'Админ-панель', web_app: { url: `${appUrl}/admin.html?v=${Date.now()}` } }]);
  const greeting = `<b>SupGift — Безопасные трейды</b>\n\n` +
    `Обменивай свои подарки за TON, USDT и RUB.`;
  const gifPath = path.join(__dirname, 'gif.mp4');
  try {
    await bot.telegram.sendVideo(userId, { source: gifPath }, {
      caption: greeting,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (videoErr) {
    await safeReply(ctx, greeting, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
  }
});

async function syncIntegration() {
  const tunnelUrl = getTunnelUrl();
  const webhookUrl = tunnelUrl || APP_URL;
  const menuUrl = APP_URL + '/';
  if (webhookUrl === syncedUrl) return;
  try {
    await bot.telegram.setChatMenuButton({ menu_button: { type: 'web_app', text: 'SupGift', web_app: { url: menuUrl } } });
    await bot.telegram.setWebhook(webhookUrl + '/webhook/trade', { secret_token: WEBHOOK_SECRET, drop_pending_updates: true });
    syncedUrl = webhookUrl;
    console.log('Menu button:', menuUrl, '| webhook set:', webhookUrl);
  } catch (e) {
    console.error('Integration sync failed:', e && e.message ? e.message : e);
  }
}

async function startBot() {
  try {
    if (!bot.botInfo) bot.botInfo = await bot.telegram.getMe();
    botUsername = bot.botInfo.username;
    console.log('Bot online: @' + botUsername);
    await syncIntegration();
  } catch (e) {
    console.error('Bot startup failed:', e && e.message ? e.message : e, '- retry in 10s');
    setTimeout(startBot, 10000);
  }
}

let syncedUrl = null;
setInterval(() => syncIntegration().catch(() => {}), 15000);

initDb().then(() => {
  startBot();

  
app.post('/api/withdraw/gift', async (req, res) => {
  try {
    const { userId, giftId, targetUsername } = req.body;
    const target = String(targetUsername || '').trim().replace(/^@/, '');
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(target) && !/^\d{5,15}$/.test(target)) return res.status(400).json({ error: 'Укажи корректный @username или ID' });
    const user = await getUser(Number(userId));
    const idx = user.gifts.findIndex(g => g.id === giftId);
    if (idx === -1) return res.status(400).json({ error: 'Подарок не найден' });
    const gift = user.gifts.splice(idx, 1)[0];
    await removeGift(Number(userId), gift.id);
    let localReq;
    try {
      localReq = await createRequest({
        type: 'withdraw',
        userId: Number(userId),
        userUsername: '',
        gift,
        targetUsername: target
      });
    } catch (e) {
      await addGift(Number(userId), gift);
      user.gifts.push(gift);
      return res.status(500).json({ error: 'Не удалось создать заявку на вывод: ' + e.message });
    }
    await notifyTradeAdmin(
      `📥 <b>Новая заявка #${localReq.id}</b>\n\nТип: 🎁 Вывод подарка в профиль\nОт: ID ${userId}\nВывести на: <b>@${target}</b>\nПодарок: ${gift.name}`,
      { inline_keyboard: [[{ text: '✅ Подтвердить вывод', callback_data: `ap_${localReq.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${localReq.id}`, style: 'danger' }]] }
    );
    res.json({ success: true, requestId: localReq.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/deposit/create', async (req, res) => {
  try {
    const { userId, currency, amount, txHash } = req.body;
    if (!['ton', 'usdt'].includes(currency)) return res.status(400).json({ error: 'Неверная валюта' });
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Некорректная сумма' });
    const tx = String(txHash || '').trim();
    await getUser(Number(userId));
    const localReq = await createRequest({
      type: 'deposit_' + currency,
      userId: Number(userId),
      userUsername: '',
      gift: { name: currency.toUpperCase() },
      floorTon: amt,
      currency,
      amount: amt,
      txHash: tx || null
    });
    await notifyTradeAdmin(
      `📥 <b>Новая заявка #${localReq.id}</b>\n\nТип: 💵 Пополнение ${currency.toUpperCase()}\nОт: ID ${userId}\nСумма: <b>${amt} ${currency.toUpperCase()}</b>\nTX/подтверждение: <b>${tx || '—'}</b>`,
      { inline_keyboard: [[{ text: '✅ Зачислить', callback_data: `ap_${localReq.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${localReq.id}`, style: 'danger' }]] }
    );
    res.json({ success: true, requestId: localReq.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deposit/gift', async (req, res) => {
  try {
    const { userId, giftId } = req.body;
    const user = await getUser(Number(userId));
    const gift = (user.gifts || []).find(g => g.id === giftId);
    if (!gift) return res.status(400).json({ error: 'Подарок не найден' });
    const localReq = await createRequest({
      type: 'deposit_gift',
      userId: Number(userId),
      userUsername: '',
      gift,
      targetUsername: BANK_ACCOUNT
    });
    await notifyTradeAdmin(
      `📥 <b>Новая заявка #${localReq.id}</b>\n\nТип: 🎁 Пополнение подарком\nОт: ID ${userId}\nПодарок: <b>${esc(gift.name)}</b>\nПередать на банк-аккаунт: <b>@${BANK_ACCOUNT}</b>`,
      { inline_keyboard: [[{ text: '✅ Зачислить', callback_data: `ap_${localReq.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${localReq.id}`, style: 'danger' }]] }
    );
    res.json({ success: true, requestId: localReq.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/support/ticket', async (req, res) => {
  try {
    const { userId, subject, message } = req.body;
    const text = String(message || '').trim();
    if (!text) return res.status(400).json({ error: 'Введите сообщение' });
    const id = 'T' + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1000).toString(36).padStart(2, '0');
    await pool.query('INSERT INTO tickets (id, user_id, subject, message, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, Number(userId), String(subject || '').trim().slice(0, 120) || null, text.slice(0, 2000), 'open', Date.now()]);
    await addTicketMessage(id, 'user', text);
    const subjectStr = String(subject || '').trim();
    const keyboard = isRubDepositTicket(subjectStr)
      ? [[{ text: '✅ Подтвердить', callback_data: `tda_${id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `tdr_${id}`, style: 'danger' }],
         [{ text: '💬 Ответить', callback_data: `trp_${id}` }]]
      : [[{ text: '💬 Ответить', callback_data: `trp_${id}` }]];
    await notifyTradeAdmin(
      `🎫 <b>Новый тикет #${id}</b>\n\nОт: ID ${userId}\nТема: ${subjectStr.slice(0,120) || '—'}\nСообщение: ${text.slice(0,2000)}` +
      (isRubDepositTicket(subjectStr) ? `\n\n💵 Сумма: <b>${parseRubTicketAmount(subjectStr, text) ?? '—'} RUB</b>` : ''),
      { inline_keyboard: keyboard }
    );
    res.json({ success: true, ticketId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/support/ticket/:id/message', async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    const text = String(message || '').trim();
    if (!text) return res.status(400).json({ error: 'Введите сообщение' });
    const { rows } = await pool.query('SELECT * FROM tickets WHERE id=$1', [req.params.id]);
    const ticket = rows[0];
    if (!ticket || Number(ticket.user_id) !== Number(userId)) return res.status(404).json({ error: 'Тикет не найден' });
    await addTicketMessage(ticket.id, 'user', text);
    await pool.query("UPDATE tickets SET status='open', replied_at=NULL WHERE id=$1", [ticket.id]);
    await notifyTradeAdmin(
      `💬 <b>Новое сообщение в тикете #${ticket.id}</b>\n\nОт: ID ${ticket.user_id}\nТема: ${String(ticket.subject || '—').slice(0, 120)}\nСообщение: ${text.slice(0, 2000)}`,
      { inline_keyboard: [[{ text: '💬 Ответить', callback_data: `trp_${ticket.id}` }]] }
    ).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
  app.get('/api/health', (req, res) => res.json({ ok: true, bot: botUsername || null }));
  app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e.message); process.exit(1); });

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (process kept alive):', err && err.message ? err.message : err);
});

/* ============ ADMIN USER MANAGEMENT ============ */

// List users with search, pagination, filters
app.get('/api/admin/users', async (req, res) => {
  const initData = req.query.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const banned = req.query.banned === 'true' ? true : (req.query.banned === 'false' ? false : null);
    const hasGifts = req.query.hasGifts === 'true' ? true : (req.query.hasGifts === 'false' ? false : null);

    let where = [];
    const params = [];
    let pi = 1;

    if (search) {
      where.push('(telegram_id::text ILIKE $' + pi + ' OR username ILIKE $' + pi + ' OR first_name ILIKE $' + pi + ')');
      params.push('%' + search + '%');
      pi++;
    }
    if (banned !== null) { where.push('banned = $' + pi); params.push(banned); pi++; }
    if (hasGifts !== null) {
      where.push(hasGifts ? 'EXISTS (SELECT 1 FROM gifts g WHERE g.user_id = users.telegram_id)' : 'NOT EXISTS (SELECT 1 FROM gifts g WHERE g.user_id = users.telegram_id)');
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countSql = 'SELECT COUNT(*) FROM users ' + whereClause;
    const dataSql = 'SELECT telegram_id, username, first_name, rub, usdt, ton, banned, successful_deals, completed_deals, created_at FROM users ' + whereClause + ' ORDER BY created_at DESC LIMIT $' + pi + ' OFFSET $' + (pi + 1);

    params.push(limit, offset);

    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query(countSql, params.slice(0, -2)),
      pool.query(dataSql, params)
    ]);

    const ids = rows.map(u => u.telegram_id);
    const giftsMap = {};
    if (ids.length) {
      const g = await pool.query('SELECT user_id, COUNT(*)::int AS n FROM gifts WHERE user_id = ANY($1) GROUP BY user_id', [ids]);
      g.rows.forEach(r => { giftsMap[r.user_id] = r.n; });
    }

    res.json({
      users: rows.map(u => ({
        id: u.telegram_id,
        username: u.username || '',
        first_name: u.first_name || '',
        balance: { rub: Number(u.rub || 0), usdt: Number(u.usdt || 0), ton: Number(u.ton || 0) },
        gifts_count: hasGifts === null ? (giftsMap[u.telegram_id] || 0) : 0,
        banned: u.banned || false,
        successful_deals: Number(u.successful_deals || 0),
        completed_deals: Number(u.completed_deals || 0),
        created_at: u.created_at
      })),
      pagination: {
        page,
        limit,
        total: Number(count),
        pages: Math.ceil(Number(count) / limit)
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full user profile for admin
app.get('/api/admin/user/:id', async (req, res) => {
  const initData = req.query.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Некорректный ID' });

    const user = await getUser(id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // Get gifts details
    const gifts = (user.gifts || []).map(g => ({
      id: g.id,
      name: g.name || '',
      rarity: g.rarity || '',
      image: g.image || '',
      bg: g.bg || ''
    }));

    // Get trades (last 50)
    const { rows: trades } = await pool.query(
      'SELECT trade_id, seller_id, buyer_id, seller_gift, buyer_offer, status, comment, created_at FROM trades WHERE seller_id=$1 OR buyer_id=$1 ORDER BY created_at DESC LIMIT 50',
      [id]
    );
    const tradesMapped = trades.map(row => ({
      tradeId: row.trade_id,
      sellerId: Number(row.seller_id),
      buyerId: row.buyer_id == null ? null : Number(row.buyer_id),
      sellerGift: row.seller_gift,
      buyerOffer: row.buyer_offer,
      status: row.status,
      createdAt: Number(row.created_at),
      comment: row.comment || ''
    }));

    // Get referrals
    const { rows: referrals } = await pool.query(
      `SELECT r.id, r.referrer_id, r.joiner_id, r.source, r.trade_id, r.created_at,
              ju.username AS joiner_username, jf.first_name AS joiner_name,
              ru.username AS referrer_username
         FROM referrals r
         LEFT JOIN users ju ON ju.telegram_id = r.joiner_id
         LEFT JOIN users jf ON jf.telegram_id = r.joiner_id
         LEFT JOIN users ru ON ru.telegram_id = r.referrer_id
         WHERE r.referrer_id=$1 OR r.joiner_id=$1
         ORDER BY r.created_at DESC LIMIT 50`,
      [id]
    );

    // Referral stats
    const { rows: refStats } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE referrer_id=$1) AS invited,
              COUNT(*) FILTER (WHERE joiner_id=$1) AS invited_by,
              COUNT(*) FILTER (WHERE referrer_id=$1 AND source='ref') AS by_ref,
              COUNT(*) FILTER (WHERE referrer_id=$1 AND source='trade') AS by_trade
         FROM referrals WHERE referrer_id=$1 OR joiner_id=$1`,
      [id]
    );

    // Balance history (last 20 requests)
    const { rows: balanceHist } = await pool.query(
      `SELECT id, type, currency, amount, status, created_at
       FROM requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [id]
    );

    res.json({
      id: user.telegram_id,
      username: user.username || '',
      first_name: user.first_name || '',
      balance: { rub: Number(user.rub || 0), usdt: Number(user.usdt || 0), ton: Number(user.ton || 0) },
      gifts,
      gifts_count: user.gifts ? user.gifts.length : 0,
      banned: user.banned || false,
      successful_deals: Number(user.successfulDeals || 0),
      completed_deals: Number(user.completedDeals || 0),
      created_at: user.created_at,
      trades: tradesMapped,
      referrals,
      referral_stats: refStats[0],
      balance_history: balanceHist
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edit user balance (add/subtract)
app.post('/api/admin/user/:id/balance', async (req, res) => {
  const initData = req.body.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const id = Number(req.params.id);
    const { currency, amount, mode } = req.body; // mode: 'add' | 'subtract' | 'set'
    const currencies = ['rub', 'usdt', 'ton'];
    if (!currencies.includes(currency)) return res.status(400).json({ error: 'Неверная валюта' });
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!isFinite(amt) || amt < 0) return res.status(400).json({ error: 'Некорректная сумма' });
    if (!['add', 'subtract', 'set'].includes(mode)) return res.status(400).json({ error: 'Неверный режим' });

    const user = await getUser(Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    let newVal;
    if (mode === 'set') newVal = amt;
    else if (mode === 'add') newVal = Math.round((Number(user[currency] || 0) + amt) * 100) / 100;
    else newVal = Math.round((Number(user[currency] || 0) - amt) * 100) / 100;

    if (newVal < 0) return res.status(400).json({ error: 'Баланс не может быть отрицательным' });

    await setUserBalance(Number(req.params.id), currency, newVal);
    const updated = await getUser(Number(req.params.id));
    res.json({ success: true, balance: { rub: Number(updated.rub || 0), usdt: Number(updated.usdt || 0), ton: Number(updated.ton || 0) } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ban / unban user
app.post('/api/admin/user/:id/ban', async (req, res) => {
  const initData = req.body.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const id = Number(req.params.id);
    const { banned } = req.body; // true/false
    if (typeof banned !== 'boolean') return res.status(400).json({ error: 'Некорректный параметр' });

    await pool.query('UPDATE users SET banned=$1 WHERE telegram_id=$2', [banned, Number(req.params.id)]);
    const user = await getUser(Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ success: true, banned: user.banned || false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add/remove gift
app.post('/api/admin/user/:id/gift', async (req, res) => {
  const initData = req.body.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const id = Number(req.params.id);
    const { action, gift, giftId } = req.body;
    if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'Неверное действие' });

    const user = await getUser(id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (action === 'add') {
      if (!gift || !gift.id) return res.status(400).json({ error: 'Некорректный подарок' });
      const dup = await pool.query('SELECT id FROM gifts WHERE user_id=$1 AND id=$2', [id, gift.id]);
      if (dup.rowCount) return res.status(400).json({ error: 'Подарок уже есть' });
      await addGift(id, { id: gift.id, name: gift.name || '', rarity: gift.rarity || '', image: gift.image || '', bg: gift.bg || '' });
    } else {
      const removed = await pool.query('DELETE FROM gifts WHERE user_id=$1 AND id=$2 RETURNING id', [id, giftId]);
      if (!removed.rowCount) return res.status(404).json({ error: 'Подарок не найден' });
    }

    const updated = await getUser(id);
    res.json({ success: true, gifts: updated.gifts || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send notification to user
app.post('/api/admin/user/:id/notify', async (req, res) => {
  const initData = req.body.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const id = Number(req.params.id);
    const { text, parse_mode } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Текст сообщения пуст' });

    const user = await getUser(Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    try {
      await bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' });
    } catch (htmlErr) {
      await bot.telegram.sendMessage(id, text);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User trades history (full)
app.get('/api/admin/user/:id/trades', async (req, res) => {
  const initData = req.query.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const id = Number(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      'SELECT trade_id, seller_id, buyer_id, seller_gift, buyer_offer, status, comment, created_at FROM trades WHERE seller_id=$1 OR buyer_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [id, limit, offset]
    );
    const trades = rows.map(row => ({
      tradeId: row.trade_id,
      sellerId: Number(row.seller_id),
      buyerId: row.buyer_id == null ? null : Number(row.buyer_id),
      sellerGift: row.seller_gift,
      buyerOffer: row.buyer_offer,
      status: row.status,
      createdAt: Number(row.created_at),
      comment: row.comment || ''
    }));

    const { rows: cnt } = await pool.query(
      'SELECT COUNT(*) FROM trades WHERE seller_id=$1 OR buyer_id=$1',
      [id]
    );

    res.json({
      trades,
      pagination: { page, limit, total: Number(cnt[0].count), pages: Math.ceil(Number(cnt[0].count) / limit) }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User referrals
app.get('/api/admin/user/:id/referrals', async (req, res) => {
  const initData = req.query.initData || '';
  const admin = validateTelegramInitData(initData);
  if (!admin || !isAdminUser(admin.id)) return res.status(403).json({ error: 'Доступ запрещен' });

  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT r.id, r.referrer_id, r.joiner_id, r.source, r.trade_id, r.created_at,
              ju.username AS joiner_username, jf.first_name AS joiner_name,
              ru.username AS referrer_username
         FROM referrals r
         LEFT JOIN users ju ON ju.telegram_id = r.joiner_id
         LEFT JOIN users jf ON jf.telegram_id = r.joiner_id
         LEFT JOIN users ru ON ru.telegram_id = r.referrer_id
         WHERE r.referrer_id=$1 OR r.joiner_id=$1
         ORDER BY r.created_at DESC LIMIT 100`,
      [Number(req.params.id)]
    );
    res.json({ referrals: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

