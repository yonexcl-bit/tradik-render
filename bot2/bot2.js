const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns').promises;

const BOT2_TOKEN = process.env.BOT2_TOKEN || '9172169817:AAFZ_NCY-qADKw88idEgbU9D9sqexXUnlb8';
const MAIN_TOKEN = process.env.MAIN_TOKEN || '8140187495:AAG28O6FXb-xd9hi86NK5B1Rwj4wsYNQ4pw';
const ADMIN_ID = Number(process.env.ADMIN_ID || 7593759960);
const DB = process.env.DATABASE_URL || 'postgresql://trade_bot:trade_bot_pass@127.0.0.1:5432/trade_bot';
const ACCESS_FILE = path.join(__dirname, 'bot2_access.json');

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

const pool = new Pool({ connectionString: DB });
const bot = new Telegraf(BOT2_TOKEN, { telegram: { agent: tgAgent } });
const mainTelegram = new Telegraf(MAIN_TOKEN, { telegram: { agent: tgAgent } }).telegram;

function readAccess() {
  try { return new Set((JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8')) || []).map(Number)); }
  catch { return new Set([ADMIN_ID]); }
}
function writeAccess(set) {
  fs.writeFileSync(ACCESS_FILE, JSON.stringify([...set], null, 2));
}
const hasAccess = async id => {
  id = Number(id);
  const acc = readAccess();
  if (acc.has(id) || id === ADMIN_ID) return true;
  try {
    const { rows } = await pool.query('SELECT 1 FROM admins WHERE telegram_id=$1', [id]);
    return rows.length > 0;
  } catch {
    return false;
  }
};

const gsNorm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const GS_API = 'https://gifts.supply/api/v1/catalog';
const gsCache = new Map();
async function gsFetch(url) {
  if (gsCache.has(url)) return gsCache.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('gifts.supply HTTP ' + res.status);
  const data = await res.json();
  gsCache.set(url, data);
  return data;
}
let priceMap = null;
async function getPriceMap() {
  if (priceMap) return priceMap;
  const data = await gsFetch(GS_API + '/collections?limit=200');
  const map = {};
  for (const c of data.items || []) {
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

async function getGifts(userId) {
  const { rows } = await pool.query('SELECT id, name, rarity, image, bg FROM gifts WHERE user_id=$1 ORDER BY name', [Number(userId)]);
  return rows.map(g => ({ id: g.id, name: g.name, rarity: g.rarity, image: g.image, bg: g.bg }));
}
async function getPrice(gift) {
  const prices = await getPriceMap().catch(() => ({}));
  const rates = await getTonRates();
  const slug = (gift && gift.id ? gift.id.split('_')[1] : '') || '';
  const floor = prices[gsNorm(slug)] || null;
  if (!floor) return null;
  const ton = Math.round(floor * 100) / 100;
  const usd = floor * rates.usd;
  const rub = fmtRub(floor * rates.rub);
  return {
    ton,
    usd: usd < 100 ? Math.round(usd * 10) / 10 : Math.round(usd),
    rub,
    floorTon: floor
  };
}
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
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const notifyAdmin = (text, kb) => mainTelegram.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
const notifyUser = (id, text, kb) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});

const menuKb = { reply_markup: { keyboard: [[{ text: '👤 Профиль' }], [{ text: '↻ Обновить' }]], resize_keyboard: true, one_time_keyboard: false } };

async function authCtx(ctx) {
  const id = Number(ctx.from.id);
  if (!(await hasAccess(id))) {
    ctx.reply('У тебя нет доступа.').catch(() => {});
    return null;
  }
  return id;
}

async function showProfile(id, chatId) {
  const gifts = await getGifts(id);
  if (!gifts.length) {
    bot.telegram.sendMessage(chatId, `👤 Профиль\nПодарков: 0\n\nПока нет подарков.`, menuKb).catch(() => {});
    return;
  }
  const rows = [];
  const step = 3;
  for (let i = 0; i < gifts.length; i += step) {
    rows.push(gifts.slice(i, i + step).map(g => ({ text: '🎁 ' + g.name.slice(0, 22), callback_data: 'g_' + g.id })));
  }
  rows.push([{ text: '◀ Назад', callback_data: 'menu' }]);
  const total = gifts.length;
  bot.telegram.sendMessage(chatId, `👤 Профиль\nПодарков: ${total}\n\nВыбери подарок — «Вывести» или «Продать».`, { reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

bot.start(async (ctx) => {
  const id = Number(ctx.from.id);
  if (!(await hasAccess(id))) return ctx.reply('У тебя нет доступа.').catch(() => {});
  const gifts = await getGifts(id);
  ctx.reply(`Привет!\n\nВ этом боте ты можешь управлять своими подарками: вывести в профиль или продать по курсу.\n\nПодарков: ${gifts.length}`, menuKb).catch(() => {});
});

bot.command('invite', async (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('Недостаточно прав.').catch(() => {});
  const target = Number(String(ctx.message.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(target) || target <= 0) return ctx.reply('Использование: /invite <telegram_id>').catch(() => {});
  const acc = readAccess();
  acc.add(target);
  writeAccess(acc);
  ctx.reply(`✅ Пользователь ${target} добавлен в доступ.`).catch(() => {});
});
bot.command('revoke', async (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('Недостаточно прав.').catch(() => {});
  const target = Number(String(ctx.message.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(target) || target <= 0) return ctx.reply('Использование: /revoke <telegram_id>').catch(() => {});
  const acc = readAccess();
  acc.delete(target);
  writeAccess(acc);
  ctx.reply(`❌ Пользователь ${target} удалён из доступа.`).catch(() => {});
});
bot.command('access', async (ctx) => {
  if (Number(ctx.from.id) !== ADMIN_ID) return ctx.reply('Недостаточно прав.').catch(() => {});
  ctx.reply('Доступ: ' + [...readAccess()].join(', ') || '—').catch(() => {});
});

bot.hears(/Профиль|Обновить/i, async (ctx) => {
  const id = authCtx(ctx);
  if (!id) return;
  await showProfile(id, ctx.chat.id);
});

bot.action(/^g_(.+)$/, async (ctx) => {
  const id = authCtx(ctx);
  if (!id) return;
  const giftId = ctx.callbackQuery.data.slice(2);
  const gifts = await getGifts(id);
  const gift = gifts.find(g => g.id === giftId);
  if (!gift) return ctx.answerCbQuery('Подарок не найден').catch(() => {});
  const p = await getPrice(gift).catch(() => null);
  let priceLine = 'Курс недоступен';
  if (p) priceLine = `${p.ton} TON  ≈  ${p.usd} USDT  ≈  ${p.rub} RUB`;
  const kb = { reply_markup: { inline_keyboard: [
    [{ text: '🖐 Вывести', callback_data: `wd_${gift.id}` }, { text: '💰 Продать', callback_data: `sl_${gift.id}` }],
    [{ text: '◀ Назад', callback_data: 'profile' }]
  ] } };
  await ctx.editMessageText(`🎁 <b>${esc(gift.name)}</b>\nРедкость: ${esc(gift.rarity || '—')}\n\n📈 Курс:\n${priceLine}\n\nВывести подарок в профиль или продать по заявке?`, { parse_mode: 'HTML', reply_markup: kb.reply_markup }).catch(() => {});
  return ctx.answerCbQuery().catch(() => {});
});

bot.action(/^wd_(.+)$/, async (ctx) => {
  const id = authCtx(ctx);
  if (!id) return;
  const giftId = ctx.callbackQuery.data.slice(3);
  const gifts = await getGifts(id);
  const gift = gifts.find(g => g.id === giftId);
  if (!gift) return ctx.answerCbQuery('Подарок не найден').catch(() => {});
  const target = ctx.from.username || String(id);
  await pool.query('DELETE FROM gifts WHERE user_id=$1 AND id=$2', [id, gift.id]);
  let localReq;
  try {
    localReq = await createRequest({ type: 'withdraw', userId: id, userUsername: ctx.from.username || '', gift, targetUsername: target });
  } catch (e) {
    await pool.query('INSERT INTO gifts (id, user_id, name, rarity, image, bg) VALUES ($1,$2,$3,$4,$5,$6)', [gift.id, id, gift.name, gift.rarity, gift.image, gift.bg ? JSON.stringify(gift.bg) : null]);
    return ctx.answerCbQuery('Не удалось создать заявку').catch(() => {});
  }
  await notifyAdmin(
    `📥 <b>Новая заявка #${localReq.id}</b>\n\nТип: 🎁 Вывод подарка в профиль\nОт: ID ${id}\nВывести на: <b>@${target}</b>\nПодарок: ${gift.name}`,
    { inline_keyboard: [[{ text: '✅ Подтвердить вывод', callback_data: `ap_${localReq.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${localReq.id}`, style: 'danger' }]] }
  );
  await ctx.editMessageText(`Заявка на вывод создана (#${localReq.id}).\n\nПодарок «${gift.name}» будет отправлен в твой профиль после подтверждения.`).catch(() => {});
  return ctx.answerCbQuery('Заявка создана').catch(() => {});
});

bot.action(/^sl_(.+)$/, async (ctx) => {
  const id = authCtx(ctx);
  if (!id) return;
  const giftId = ctx.callbackQuery.data.slice(3);
  const gifts = await getGifts(id);
  const gift = gifts.find(g => g.id === giftId);
  if (!gift) return ctx.answerCbQuery('Подарок не найден').catch(() => {});
  const p = await getPrice(gift).catch(() => null);
  if (!p) {
    await ctx.editMessageText(`Для «${gift.name}» курс пока недоступен. Попробуй позже.`).catch(() => {});
    return ctx.answerCbQuery().catch(() => {});
  }
  const kb = { inline_keyboard: [
    [{ text: '✅ Подтвердить продажу', callback_data: `cf_${gift.id}_ton` }],
    [{ text: '◀ Назад', callback_data: 'profile' }]
  ] };
  await ctx.editMessageText(`Продажа «<b>${esc(gift.name)}</b>»\n\nКурс: <b>${p.ton} TON</b>\n≈ ${p.usd} USDT · ≈ ${p.rub} RUB\n\nПодтверди — после одобрения заявки подарок спишется с профиля, а ${p.ton} TON зачислятся на баланс.`, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  return ctx.answerCbQuery().catch(() => {});
});

bot.action(/^cf_(.+)_ton$/, async (ctx) => {
  const id = authCtx(ctx);
  if (!id) return;
  const giftId = ctx.callbackQuery.data.slice(3, -4);
  const gifts = await getGifts(id);
  const gift = gifts.find(g => g.id === giftId);
  if (!gift) return ctx.answerCbQuery('Подарок не найден').catch(() => {});
  const p = await getPrice(gift).catch(() => null);
  if (!p) return ctx.answerCbQuery('Курс недоступен').catch(() => {});
  let localReq;
  try {
    localReq = await createRequest({ type: 'sell', userId: id, userUsername: ctx.from.username || '', gift, targetUsername: ctx.from.username || '', floorTon: p.floorTon, currency: 'ton', amount: p.ton });
  } catch (e) {
    return ctx.answerCbQuery('Не удалось создать заявку').catch(() => {});
  }
  await notifyAdmin(
    `📥 <b>Новая заявка #${localReq.id}</b>\n\nТип: 💰 Продажа подарка\nОт: ID ${id}\nПодарок: ${gift.name}\nКурс: ${p.ton} TON (${p.usd} USDT / ${p.rub} RUB)`,
    { inline_keyboard: [[{ text: '✅ Подтвердить продажу', callback_data: `ap_${localReq.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${localReq.id}`, style: 'danger' }]] }
  );
  await ctx.editMessageText(`Заявка на продажу создана (#${localReq.id}).\n\nПодарок «${gift.name}» будет списан с профиля после одобрения, начислено ${p.ton} TON.`).catch(() => {});
  return ctx.answerCbQuery('Заявка создана').catch(() => {});
});

bot.action(/^profile$/, async (ctx) => {
  const id = authCtx(ctx);
  if (!id) return;
  await showProfile(id, ctx.chat.id);
  return ctx.answerCbQuery().catch(() => {});
});
bot.action(/^menu$/, async (ctx) => {
  const id = authCtx(ctx);
  if (!id) return;
  await ctx.editMessageText('Меню. Выбери «Профиль», чтобы посмотреть подарки.', menuKb).catch(() => {});
  return ctx.answerCbQuery().catch(() => {});
});

bot.launch().then(() => console.log('bot2 running')).catch(e => { console.error('bot2 launch failed:', e.message); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));