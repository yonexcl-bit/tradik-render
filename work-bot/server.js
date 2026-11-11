const { Telegraf } = require('telegraf');
const { Pool } = require('pg');
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const dns = require('dns').promises;

const WORK_BOT_TOKEN = process.env.WORK_BOT_TOKEN || '8700036093:AAGyDfnm-yiUqIBMZv8AJuj2kN-OvpD83MM';
const ADMIN_ID = Number(process.env.ADMIN_ID || '7593759960');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://work_bot:work_bot_pass@127.0.0.1:5432/work_bot';
const TRADE_BOT_URL = process.env.TRADE_BOT_URL || 'http://127.0.0.1:3000';
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'trade-work-secret';
const WORK_BOT_PORT = Number(process.env.WORK_BOT_PORT || 3001);

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
const bot2 = new Telegraf(WORK_BOT_TOKEN, { telegram: { agent: tgAgent } });

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

const pool = new Pool({ connectionString: DATABASE_URL });
const admins = new Set();

const app = express();
app.use(express.json());

async function loadAdmins() {
  admins.clear();
  const { rows } = await pool.query('SELECT telegram_id FROM admins');
  rows.forEach(r => admins.add(Number(r.telegram_id)));
}
function isAdminUser(id) {
  return Number(id) === ADMIN_ID || admins.has(Number(id));
}

async function callTrade(path, body) {
  const res = await fetch(TRADE_BOT_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, body, { secret: INTERNAL_API_SECRET })),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || ('trade HTTP ' + res.status));
  return data;
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
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      user_id BIGINT NOT NULL,
      user_username TEXT,
      gift JSONB NOT NULL,
      target_username TEXT,
      floor_ton NUMERIC,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      telegram_id BIGINT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      subject TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      admin_reply TEXT,
      created_at BIGINT NOT NULL,
      replied_at BIGINT
    );
  `);
  await pool.query('ALTER TABLE requests ADD COLUMN IF NOT EXISTS currency TEXT');
  await pool.query('ALTER TABLE requests ADD COLUMN IF NOT EXISTS amount NUMERIC');
  await pool.query('ALTER TABLE requests ADD COLUMN IF NOT EXISTS destination TEXT');
  await pool.query('ALTER TABLE requests ADD COLUMN IF NOT EXISTS tx_hash TEXT');
  await loadAdmins();
}

async function fetchUser(userId) {
  const u = await pool.query('SELECT rub, usdt, ton FROM users WHERE telegram_id=$1', [userId]);
  if (!u.rowCount) return null;
  const g = await pool.query('SELECT id, name, rarity, image, bg FROM gifts WHERE user_id=$1', [userId]);
  return {
    rub: Number(u.rows[0].rub),
    usdt: Number(u.rows[0].usdt),
    ton: Number(u.rows[0].ton),
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
function getSeedGifts(userId) {
  const cat = getNftCatalog().filter(g => g.id !== 'plushpepe');
  if (!cat.length) {
    return [
      { id: `${userId}_g1`, name: 'Золотой кубок', rarity: 'Легендарный', image: '🏆' },
      { id: `${userId}_g2`, name: 'Крипто-мишка', rarity: 'Редкий', image: '🧸' }
    ];
  }
  const prefer = ['toybear', 'eternalrose', 'heartlocket', 'bdaycandle', 'berrybox'];
  const picks = [];
  for (const p of prefer) {
    const g = cat.find(x => x.id === p);
    if (g && !picks.includes(g)) picks.push(g);
    if (picks.length === 2) break;
  }
  let guard = 0;
  while (picks.length < 2 && guard++ < 60) {
    const g = cat[Math.floor(Math.random() * cat.length)];
    if (!picks.includes(g)) picks.push(g);
  }
  return picks.map((g, i) => ({
    id: `${userId}_s${i}_${g.id}`,
    name: g.name,
    rarity: i === 0 ? 'Редкий' : 'Обычный',
    image: g.file,
    bg: g.bg || null
  }));
}

async function getUser(userId) {
  const existing = await fetchUser(userId);
  if (existing) return existing;
  const seed = getSeedGifts(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users (telegram_id, rub, usdt, ton, created_at) VALUES ($1,$2,$3,$4,$5)', [userId, 1000, 50, 5, Date.now()]);
    for (const gift of seed) {
      await client.query('INSERT INTO gifts (id, user_id, name, rarity, image, bg) VALUES ($1,$2,$3,$4,$5,$6)', [gift.id, userId, gift.name, gift.rarity, gift.image, gift.bg ? JSON.stringify(gift.bg) : null]);
    }
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

async function removeGift(userId, giftId) {
  await pool.query('DELETE FROM gifts WHERE user_id=$1 AND id=$2', [userId, giftId]);
}
async function addGift(userId, gift) {
  await pool.query('INSERT INTO gifts (id, user_id, name, rarity, image, bg) VALUES ($1,$2,$3,$4,$5,$6)', [gift.id, userId, gift.name, gift.rarity, gift.image, gift.bg ? JSON.stringify(gift.bg) : null]);
}
async function setUserBalance(userId, currency, value) {
  await pool.query(`UPDATE users SET ${currency}=$1 WHERE telegram_id=$2`, [value, userId]);
}

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

function newReqId() {
  return Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
}
async function createRequest(req) {
  const id = newReqId();
  await pool.query('INSERT INTO requests (id, type, user_id, user_username, gift, target_username, floor_ton, status, created_at, currency, amount, destination, tx_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [id, req.type, req.userId, req.userUsername || '', JSON.stringify(req.gift), req.targetUsername || null, req.floorTon || null, 'pending', Date.now(), req.currency || null, req.amount || req.floorTon || null, req.destination || req.targetUsername || null, req.txHash || null]);
  const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1', [id]);
  return rows[0];
}
async function getRequest(id) {
  const { rows } = await pool.query('SELECT * FROM requests WHERE id=$1', [id]);
  return rows[0] || null;
}

async function notifyAdminRequest(r) {
  const userTag = r.user_username ? `@${r.user_username} (ID ${r.user_id})` : `ID ${r.user_id}`;
  const gift = r.gift;
  const lines = r.type === 'withdraw'
    ? [`📥 <b>Новая заявка #${r.id}</b>`, '', `Тип: 🎁 Вывод подарка в профиль`, `От: ${userTag}`, `Вывести на: <b>@${r.target_username}</b>`, `Подарок: ${gift.name}`]
    : r.type === 'withdraw_currency'
    ? [`📥 <b>Новая заявка #${r.id}</b>`, '', `Тип: 💸 Вывод валюты`, `От: ${userTag}`, `Валюта: <b>${r.currency}</b>`, `Сумма: <b>${r.amount} ${r.currency}</b>`, `Реквизиты: <b>${r.destination}</b>`]
    : r.type === 'deposit_ton' || r.type === 'deposit_usdt'
    ? [`📥 <b>Новая заявка #${r.id}</b>`, '', `Тип: 💵 Пополнение ${r.currency.toUpperCase()}`, `От: ${userTag}`, `Сумма: <b>${r.amount} ${r.currency.toUpperCase()}</b>`, `TX/подтверждение: <b>${r.tx_hash || '—'}</b>`]
    : [`📥 <b>Новая заявка #${r.id}</b>`, '', `Тип: 💰 Продажа по флору`, `От: ${userTag}`, `Подарок: ${gift.name}`, `Флор: <b>${r.floor_ton} TON</b>`];
  const verb = r.type === 'withdraw' ? '✅ Подтвердить вывод'
    : r.type === 'withdraw_currency' ? '✅ Подтвердить выплату'
    : r.type === 'deposit_ton' || r.type === 'deposit_usdt' ? '✅ Зачислить'
    : `✅ Начислить ${r.floor_ton} TON`;
  const payload = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: verb, callback_data: `ap_${r.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${r.id}`, style: 'danger' }]] }
  };
  const text = lines.join('\n');
  try {
    await bot2.telegram.sendMessage(ADMIN_ID, text, payload);
  } catch (e) {
    console.error('Admin notify failed:', e.message);
  }
}

async function processAdminDecision(reqId, approve) {
  const r = await getRequest(reqId);
  if (!r) return { success: false, error: 'Заявка не найдена' };
  if (r.status !== 'pending') {
    return { success: false, error: r.status === 'approved' ? 'Уже подтверждена' : 'Уже отклонена', status: r.status };
  }

  const gift = r.gift;
  if (!approve) {
    try {
      if (r.type === 'sell' || r.type === 'withdraw') {
        await addGift(Number(r.user_id), gift);
      } else if (r.type === 'withdraw_currency') {
        await callTrade(`/internal/user/${r.user_id}/refund`, { currency: r.currency, amount: Number(r.amount || r.floor_ton) });
      }
    } catch (e) {
      return { success: false, error: 'Ошибка отклонения: ' + e.message };
    }
    await pool.query('UPDATE requests SET status=$1 WHERE id=$2', ['rejected', reqId]);
    const adminText = r.type === 'withdraw_currency'
      ? `❌ Заявка #${r.id} отклонена — ${r.amount} ${r.currency} возвращено пользователю`
      : r.type === 'deposit_ton' || r.type === 'deposit_usdt'
      ? `❌ Заявка #${r.id} отклонена — пополнение ${r.amount} ${r.currency} не зачислено`
      : `❌ Заявка #${r.id} отклонена — ${gift.name} возвращён пользователю`;
    if (r.type === 'withdraw_currency') {
      bot2.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} отклонена.\n${r.amount} ${r.currency} возвращено на баланс.`).catch(() => {});
    } else if (r.type === 'deposit_ton' || r.type === 'deposit_usdt') {
      bot2.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} отклонена.\nПополнение ${r.amount} ${r.currency} не зачислено.`).catch(() => {});
    } else {
      bot2.telegram.sendMessage(r.user_id, `❌ Заявка #${r.id} отклонена.\nПодарок «${gift.name}» возвращён в твой профиль.`).catch(() => {});
    }
    return { success: true, status: 'rejected', adminText, type: r.type, id: r.id };
  }

  try {
    if (r.type === 'sell') {
      await callTrade(`/internal/user/${r.user_id}/credit`, { currency: 'ton', amount: Number(r.floor_ton) });
    } else if (r.type === 'deposit_ton' || r.type === 'deposit_usdt') {
      await callTrade(`/internal/user/${r.user_id}/credit`, { currency: r.currency, amount: Number(r.amount || r.floor_ton) });
    }
  } catch (e) {
    return { success: false, error: 'Ошибка подтверждения: ' + e.message };
  }

  await pool.query('UPDATE requests SET status=$1 WHERE id=$2', ['approved', reqId]);
  let adminText;
  if (r.type === 'sell') {
    adminText = `✅ Заявка #${r.id}: начислено ${r.floor_ton} TON за ${gift.name}`;
    bot2.telegram.sendMessage(r.user_id, `✅ Продажа завершена!\n\n«${gift.name}» продан по флору.\n💎 Зачислено: <b>${r.floor_ton} TON</b> — баланс обновлён.`, { parse_mode: 'HTML' }).catch(() => {});
  } else if (r.type === 'withdraw_currency') {
    adminText = `✅ Заявка #${r.id}: подтверждена выплата ${r.amount} ${r.currency}`;
    bot2.telegram.sendMessage(r.user_id, `✅ Вывод подтверждён!\n\n${r.amount} ${r.currency} будет отправлено на ${r.destination}.`, { parse_mode: 'HTML' }).catch(() => {});
  } else if (r.type === 'deposit_ton' || r.type === 'deposit_usdt') {
    adminText = `✅ Заявка #${r.id}: зачислено ${r.amount} ${r.currency}`;
    bot2.telegram.sendMessage(r.user_id, `✅ Пополнение подтверждено!\n\nЗачислено ${r.amount} ${r.currency}.`, { parse_mode: 'HTML' }).catch(() => {});
  } else {
    adminText = `✅ Заявка #${r.id} подтверждена.\nОтправь ${gift.name} вручную на @${r.target_username} (NFT переносятся через Fragment).`;
    bot2.telegram.sendMessage(r.user_id, `✅ Заявка #${r.id} одобрена!\n\nПодарок «${gift.name}» будет отправлен в профиль @${r.target_username} в ближайшее время.`, { parse_mode: 'HTML' }).catch(() => {});
  }
  return { success: true, status: 'approved', adminText, type: r.type, id: r.id };
}

async function handleAdminDecision(ctx, approve) {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('Недостаточно прав');
  const reqId = ctx.callbackQuery.data.slice(3);
  const result = await processAdminDecision(reqId, approve);
  if (!result.success) return ctx.answerCbQuery(result.error || 'Ошибка');
  await ctx.editMessageText(result.adminText, { parse_mode: 'HTML' }).catch(() => {});
  return ctx.answerCbQuery(approve ? 'Подтверждено' : 'Отклонено');
}

const userFlow = new Map();

bot2.action(/^ap_(.+)$/, ctx => handleAdminDecision(ctx, true));
bot2.action(/^rj_(.+)$/, ctx => handleAdminDecision(ctx, false));

bot2.action('withdraw_start', async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (!user.gifts.length) {
    await ctx.answerCbQuery('У тебя нет подарков');
    return ctx.reply('У тебя нет подарков для вывода.');
  }
  userFlow.set(ctx.from.id, { stage: 'pick_withdraw', gifts: user.gifts.slice() });
  const kb = user.gifts.map((g, i) => [{ text: giftLabel(g), icon_custom_emoji_id: giftEmojiIdFor(g), callback_data: `wg_${i}` }]);
  kb.push([{ text: '↩️ Отмена', callback_data: 'flow_cancel' }]);
  await ctx.answerCbQuery();
  return ctx.reply(`${ceTag('gift')} <b>Вывод подарка в профиль</b>\n\nВыбери, какой подарок вывести:`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
});

bot2.action(/^wg_(\d+)$/, async (ctx) => {
  const flow = userFlow.get(ctx.from.id);
  if (!flow || flow.stage !== 'pick_withdraw') return ctx.answerCbQuery('Меню устарело, нажми /start');
  const gift = flow.gifts[Number(ctx.match[1])];
  if (!gift) return ctx.answerCbQuery('Подарок не найден');
  flow.stage = 'await_username';
  flow.giftIdx = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  return ctx.reply(`Выбран: ${giftLabelText(gift)}\n\n📩 Введи <b>@username</b> аккаунта Telegram, куда вывести подарок\n(формат: @username, ссылка t.me/... или числовой ID):`, { parse_mode: 'HTML' });
});

bot2.action('sell_start', async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (!user.gifts.length) {
    await ctx.answerCbQuery('У тебя нет подарков');
    return ctx.reply('У тебя нет подарков для продажи.');
  }
  await ctx.answerCbQuery('Считаем флор-цены...');
  const prices = await getPriceMap().catch(() => ({}));
  const gifts = user.gifts.slice();
  const rows = [];
  gifts.forEach((g, i) => {
    const slug = giftSlug(g);
    const floor = slug ? prices[gsNorm(slug)] : null;
    if (floor) rows.push([{ text: `${giftLabel(g)} — ${floor} TON`, icon_custom_emoji_id: giftEmojiIdFor(g), callback_data: `sg_${i}` }]);
  });
  if (!rows.length) return ctx.reply('Ни на один твой подарок нет флор-цены на gifts.supply — продажа недоступна.');
  userFlow.set(ctx.from.id, { stage: 'pick_sell', gifts });
  rows.push([{ text: '↩️ Отмена', callback_data: 'flow_cancel' }]);
  return ctx.reply(`${ceTag('gem')} <b>Продажа по флору</b> (цены в реальном времени с gifts.supply)\n\nВыбери подарок — заявка уйдёт админу на подтверждение:`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
});

bot2.action(/^sg_(\d+)$/, async (ctx) => {
  const flow = userFlow.get(ctx.from.id);
  if (!flow || flow.stage !== 'pick_sell') return ctx.answerCbQuery('Меню устарело, нажми /start');
  const gift = flow.gifts[Number(ctx.match[1])];
  if (!gift) return ctx.answerCbQuery('Подарок не найден');
  const user = await getUser(ctx.from.id);
  const gi = user.gifts.findIndex(g => g.id === gift.id);
  if (gi === -1) return ctx.answerCbQuery('Подарка уже нет в профиле (возможно, он в другой заявке)');
  const escrow = user.gifts.splice(gi, 1)[0];
  await removeGift(ctx.from.id, escrow.id);
  const floor = await (async () => {
    const slug = giftSlug(escrow);
    if (!slug) return null;
    const prices = await getPriceMap().catch(() => ({}));
    return prices[gsNorm(slug)] || null;
  })();
  if (!floor) {
    await addGift(ctx.from.id, escrow);
    user.gifts.push(escrow);
    return ctx.answerCbQuery('На этот подарок нет флор-цены');
  }
  const r = await createRequest({ type: 'sell', userId: ctx.from.id, userUsername: ctx.from.username || '', gift: escrow, floorTon: floor });
  userFlow.delete(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.reply(`📝 <b>Заявка #${r.id} создана!</b>\n\nПродажа: ${giftLabelText(escrow)}\nСумма: <b>${floor} TON</b> (по флору)\n\n⏳ Ожидай подтверждения администратора — о результате сообщим.`, { parse_mode: 'HTML' });
  await notifyAdminRequest(r);
});

bot2.action('flow_cancel', async (ctx) => {
  userFlow.delete(ctx.from.id);
  await ctx.answerCbQuery();
  return ctx.reply('Отменено. /start — главное меню');
});

bot2.start(async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  ctx.reply(`${ceTag('gift')} <b>Сервис подарков Трейд-Маркет</b>\n\nВыводи подарки в свой Telegram-профиль или продавай по флор-цене (парсится с gifts.supply в реальном времени).\n\nТвой ID: <code>${userId}</code>\nБаланс: <b>${user.ton} TON</b> · ${user.usdt} USDT · ${user.rub} RUB\nПодарков: <b>${user.gifts.length}</b>\n\nКаждая операция — заявка, её подтверждает администратор.`, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Вывести подарок', icon_custom_emoji_id: ceId('gift'), callback_data: 'withdraw_start' }],
        [{ text: 'Продать по флору', icon_custom_emoji_id: ceId('gem'), style: 'success', callback_data: 'sell_start' }]
      ]
    }
  });
});

bot2.on('text', async (ctx) => {
  const flow = userFlow.get(ctx.from.id);
  if (!flow || flow.stage !== 'await_username') return;
  const raw = (ctx.message.text || '').trim();
  if (raw.startsWith('/')) return;
  const target = raw.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  const okUsername = /^[a-zA-Z0-9_]{5,32}$/.test(target);
  const okId = /^\d{5,15}$/.test(target);
  if (!okUsername && !okId) {
    return ctx.reply('⚠️ Не получилось распознать. Введи @username (например @durov), ссылку t.me/... или числовой ID.');
  }
  const user = await getUser(ctx.from.id);
  const flowData = userFlow.get(ctx.from.id);
  const gift = flowData.gifts[flowData.giftIdx];
  const gi = user.gifts.findIndex(g => g.id === gift.id);
  if (gi === -1) {
    userFlow.delete(ctx.from.id);
    return ctx.reply('Подарка уже нет в профиле (возможно, он в другой заявке). /start — главное меню');
  }
  const escrow = user.gifts.splice(gi, 1)[0];
  await removeGift(ctx.from.id, escrow.id);
  const r = await createRequest({ type: 'withdraw', userId: ctx.from.id, userUsername: ctx.from.username || '', gift: escrow, targetUsername: target });
  userFlow.delete(ctx.from.id);
  await ctx.reply(`📝 <b>Заявка #${r.id} создана!</b>\n\nВывод: ${giftLabelText(escrow)}\nКуда: <b>@${target}</b>\n\n⏳ Ожидай подтверждения администратора — о результате сообщим.`, { parse_mode: 'HTML' });
  await notifyAdminRequest(r);
});

bot2.command('requests', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.reply('Недостаточно прав');
  const { rows } = await pool.query("SELECT * FROM requests WHERE status='pending' ORDER BY created_at DESC LIMIT 20");
  if (!rows.length) return ctx.reply('Нет ожидающих заявок.');
  for (const r of rows) {
    const gift = r.gift;
    const text = r.type === 'withdraw'
      ? `📥 <b>Заявка #${r.id}</b>\nТип: вывод\nОт: ID ${r.user_id}\nКуда: @${r.target_username}\nПодарок: ${gift.name}`
      : r.type === 'withdraw_currency'
      ? `📥 <b>Заявка #${r.id}</b>\nТип: вывод валюты\nОт: ID ${r.user_id}\nВалюта: ${r.currency}\nСумма: ${r.amount} ${r.currency}\nРеквизиты: ${r.destination}`
      : `📥 <b>Заявка #${r.id}</b>\nТип: продажа\nОт: ID ${r.user_id}\nПодарок: ${gift.name}\nСумма: ${r.floor_ton} TON`;
    const verb = r.type === 'withdraw' ? '✅ Подтвердить вывод' : `✅ Начислить ${r.floor_ton} TON`;
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: verb, callback_data: `ap_${r.id}`, style: 'success' }, { text: '❌ Отклонить', callback_data: `rj_${r.id}`, style: 'danger' }]] } });
  }
});
bot2.command('admins', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Недостаточно прав');
  const list = [...admins];
  ctx.reply(`👑 Главный админ: <code>${ADMIN_ID}</code>\n\nВыданные админки (${list.length}):\n${list.map(id => `• <code>${id}</code>`).join('\n') || '— нет —'}`, { parse_mode: 'HTML' });
});
bot2.command('addadmin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Недостаточно прав');
  const target = Number((ctx.message.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(target) || target <= 0) return ctx.reply('Использование: /addadmin <Telegram ID>');
  await pool.query('INSERT INTO admins (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING', [target]);
  admins.add(target);
  ctx.reply(`✅ Пользователь ${target} теперь админ.`);
});
bot2.command('deladmin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Недостаточно прав');
  const target = Number((ctx.message.text || '').split(/\s+/)[1]);
  if (!Number.isFinite(target)) return ctx.reply('Использование: /deladmin <Telegram ID>');
  if (target === ADMIN_ID) return ctx.reply('Главного админа нельзя снять');
  await pool.query('DELETE FROM admins WHERE telegram_id=$1', [target]);
  admins.delete(target);
  ctx.reply(`❌ Пользователь ${target} больше не админ.`);
});

bot2.command('tickets', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.reply('Недостаточно прав');
  const { rows } = await pool.query("SELECT * FROM support_tickets WHERE status='open' ORDER BY created_at DESC LIMIT 20");
  if (!rows.length) return ctx.reply('Нет открытых тикетов.');
  for (const t of rows) {
    await ctx.reply(`🎫 <b>Тикет #${t.id}</b>\nОт: ID ${t.user_id}\nТема: ${t.subject || '—'}\nСообщение: ${t.message}\n\nОтветить: /reply ${t.id} &lt;текст&gt;`, { parse_mode: 'HTML' });
  }
});

bot2.command('reply', async (ctx) => {
  if (!isAdminUser(ctx.from.id)) return ctx.reply('Недостаточно прав');
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const ticketId = parts[1];
  const replyText = parts.slice(2).join(' ').trim();
  if (!ticketId || !replyText) return ctx.reply('Использование: /reply <ticket_id> <текст>');
  const { rows } = await pool.query('SELECT * FROM support_tickets WHERE id=$1', [ticketId]);
  const ticket = rows[0];
  if (!ticket) return ctx.reply('Тикет не найден');
  await pool.query('UPDATE support_tickets SET status=$1, admin_reply=$2, replied_at=$3 WHERE id=$4', ['answered', replyText, Date.now(), ticketId]);
  await bot2.telegram.sendMessage(ticket.user_id, `🎫 Поддержка ответила по тикету #${ticket.id}:\n\n${replyText}`, { parse_mode: 'HTML' }).catch(() => {});
  ctx.reply(`✅ Ответ отправлен по тикету #${ticketId}.`);
});

async function startBot2() {
  if (!bot2.botInfo) bot2.botInfo = await bot2.telegram.getMe();
  await bot2.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
  bot2.launch().catch(e => console.error('work-bot polling failed:', e && e.message ? e.message : e));
  console.log('Work bot online: @' + bot2.botInfo.username);
}
app.post('/internal/set-webhook', async (req, res) => {
  try {
    if (req.body.secret !== INTERNAL_API_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const url = String(req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'URL не указан' });
    await bot2.telegram.setWebhook(url, { secret_token: INTERNAL_API_SECRET, drop_pending_updates: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/webhook', async (req, res) => {
  const secret = req.get('x-telegram-bot-api-secret-token');
  if (secret !== INTERNAL_API_SECRET) return res.status(403).end();
  if (!bot2.botInfo) {
    try { bot2.botInfo = await bot2.telegram.getMe(); console.log('Work bot online: @' + bot2.botInfo.username); }
    catch (e) { return res.status(503).end(); }
  }
  try { await bot2.handleUpdate(req.body); res.sendStatus(200); }
  catch (e) { console.error('Work webhook handling failed:', e && e.message ? e.message : e); res.status(500).end(); }
});

app.post('/internal/request/decision', async (req, res) => {
  try {
    if (req.body.secret !== INTERNAL_API_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const result = await processAdminDecision(req.body.reqId, !!req.body.approve);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.post('/internal/request/create', async (req, res) => {
  try {
    if (req.body.secret !== INTERNAL_API_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const { type, userId, userUsername, gift, targetUsername, floorTon, currency, amount, destination, txHash } = req.body;
    if (!type || !userId || !gift) return res.status(400).json({ error: 'Некорректная заявка' });
    const id = newReqId();
    await pool.query('INSERT INTO requests (id, type, user_id, user_username, gift, target_username, floor_ton, status, created_at, currency, amount, destination, tx_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [id, type, Number(userId), userUsername || '', JSON.stringify(gift), targetUsername || null, floorTon || null, 'pending', Date.now(), currency || null, amount || floorTon || null, destination || targetUsername || null, txHash || null]);
    const r = await getRequest(id);
    res.json({ success: true, id, request: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/ticket/create', async (req, res) => {
  try {
    if (req.body.secret !== INTERNAL_API_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const { userId, subject, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: 'Некорректный тикет' });
    const id = 'T' + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1000).toString(36).padStart(2, '0');
    await pool.query('INSERT INTO support_tickets (id, user_id, subject, message, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, Number(userId), subject || null, String(message), 'open', Date.now()]);
    const { rows } = await pool.query('SELECT * FROM support_tickets WHERE id=$1', [id]);
    res.json({ success: true, id, ticket: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

initDb().then(() => {
  startBot2();
  app.listen(WORK_BOT_PORT, () => console.log('Work bot HTTP API on port ' + WORK_BOT_PORT));
}).catch(e => { console.error('DB init failed:', e.message); process.exit(1); });

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (process kept alive):', err && err.message ? err.message : err);
});
