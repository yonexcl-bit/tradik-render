# -*- coding: utf-8 -*-
"""
Alfa-Bank SBP PRO Receipt Bot v108 (Fixed Stamp Overlap)
========================================================================
Fixed: Cyan stamp box moved down to avoid overlapping with the "Recipient" field.
"""

import os
import re
import asyncio
import logging
import random
from datetime import datetime, timezone, timedelta
from io import BytesIO

from aiogram import Bot, Dispatcher, F, Router
from aiogram.types import Message, BufferedInputFile
from aiogram.filters import CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage

import aiosqlite

from aiohttp import web

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# --- CONFIG ---
BOT_TOKEN = os.getenv("BOT_TOKEN", "8943909330:AAFqD_pCh9SPxZql4di-BY8Tk9BNflxMDOU")
DB_PATH = "bot_v108.db"

# --- FONTS ---
try:
    pdfmetrics.registerFont(TTFont('Arial', 'Arial.ttf'))
    pdfmetrics.registerFont(TTFont('Arial-Bold', 'Arialbd.ttf'))
    pdfmetrics.registerFont(TTFont('Tahoma', 'Tahoma.ttf'))
    pdfmetrics.registerFont(TTFont('Tahoma-Bold', 'Tahomabd.ttf'))
    pdfmetrics.registerFontFamily('Arial', normal='Arial', bold='Arial-Bold')
    pdfmetrics.registerFontFamily('Tahoma', normal='Tahoma', bold='Tahoma-Bold')
    FN, FB = 'Tahoma', 'Tahoma-Bold'
except Exception as e:
    try:
        pdfmetrics.registerFont(TTFont('Arial', 'Arial.ttf'))
        pdfmetrics.registerFont(TTFont('Arial-Bold', 'Arialbd.ttf'))
        pdfmetrics.registerFontFamily('Arial', normal='Arial', bold='Arial-Bold')
        FN, FB = 'Arial', 'Arial-Bold'
    except Exception as e2:
        logging.error(f"ОШИБКА ШРИФТОВ: {e2}. Кириллица может не отображаться!")
        FN, FB = 'Helvetica', 'Helvetica-Bold'

logging.basicConfig(level=logging.INFO)

class BotStates(StatesGroup):
    waiting_target = State()
    waiting_amount = State()
    waiting_recipient = State()
    waiting_phone = State()
    waiting_bank = State()

# --- DATABASE ---
async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("CREATE TABLE IF NOT EXISTS history (u_id INTEGER, t TEXT, a INTEGER, s INTEGER, UNIQUE(u_id, t))")
        await db.commit()

async def check_target(u_id, target):
    async with aiosqlite.connect(DB_PATH) as db:
        target = target.strip().lower()
        c = await db.execute("SELECT a, s FROM history WHERE u_id = ? AND t = ?", (u_id, target))
        r = await c.fetchone()
        if r:
            at = r[0] + 1
            await db.execute("UPDATE history SET a = ? WHERE u_id = ? AND t = ?", (at, u_id, target))
            await db.commit()
            return {"exists": True, "attempts": at, "success": r[1]}
        await db.execute("INSERT INTO history (u_id, t, a, s) VALUES (?, ?, 1, 0)", (u_id, target))
        await db.commit()
        return {"exists": False, "attempts": 1, "success": 0}

# --- PARSING FORWARDED OFFER / DEAL MESSAGES ---
def _clean(s):
    return re.sub(r'[\s\u00a0]+', ' ', s or '').strip()

def _find_name(text):
    for line in text.splitlines():
        if 'продаёт' in line or 'Сделка' in line:
            m = re.search(r'([А-ЯЁа-яёA-Za-z][\w.\- ]*?)\s*\(\s*(?:http|t\.me|https)', line)
            if m:
                return _clean(m.group(1))
    m = re.search(r'(?:👨‍🦰|👤|🙍)\s*([А-ЯЁа-яёA-Za-z][\w.\- ]*?)\s*\(', text)
    if m:
        return _clean(m.group(1))
    return None

def _normalize_phone(p):
    if not p:
        return None
    digits = re.sub(r'\D', '', p)
    if digits.startswith('8'):
        digits = '7' + digits[1:]
    if len(digits) == 10:
        digits = '7' + digits
    if len(digits) == 11 and digits[0] == '7':
        return '+7 ({}{}{}) {}{}{}-{}{}-{}{}'.format(*digits[1:])
    return p

def _find_phone(text):
    m = re.search(r'Реквизиты:\s*([+\d][\d\s\-\(\)]{5,20})', text)
    if m:
        return _normalize_phone(_clean(m.group(1)))
    m = re.search(r'([+]?[7,8]?\d{10})', text)
    if m:
        return _normalize_phone(m.group(1))
    return None

def _find_bank(text):
    m = re.search(r'перевод\s+в\s+([А-ЯЁа-яёA-Za-z][\w\- ]*?)\s+по\s+номеру', text, re.IGNORECASE)
    if m:
        return _clean(m.group(1))
    m = re.search(r'Способ\s+оплаты[:\s]+([А-ЯЁа-яёA-Za-z][^\n]*?)\s*(?:\n|$)', text, re.IGNORECASE)
    if m:
        return _clean(m.group(1)).rstrip(' ')
    return None

def _find_amount(text):
    m = re.search(r'Отправьте\s+([\d\s.,]+)\s*RUB', text, re.IGNORECASE)
    if m:
        return _clean(m.group(1))
    m = re.search(r'Платите[:\s]+([\d\s.,]+)\s*RUB', text, re.IGNORECASE)
    if m:
        return _clean(m.group(1))
    m = re.search(r'Сумма\s+сделки[:\s]+([\d\s.,]+)\s*RUB', text, re.IGNORECASE)
    if m:
        return _clean(m.group(1))
    return None

def parse_forwarded(text):
    """Detect source and extract data from a forwarded message."""
    info = {"source": None, "name": None, "amount": None, "phone": None, "bank": None}
    low = text.lower()
    if "xrocket" in low or re.search(r'Объявление\s*#PA', text):
        info["source"] = "xrocket"
    elif re.search(r'#O\s*\(', text) or re.search(r'Объявление\s*#O', text):
        info["source"] = "cb_offer"
    elif re.search(r'#D\s*\(', text) or re.search(r'Сделка\s*#D', text):
        info["source"] = "cb_deal"
    elif "cryptobot" in low or "t.me/send?start=u-" in low:
        if re.search(r'#D', text):
            info["source"] = "cb_deal"
        else:
            info["source"] = "cb_offer"
    info["name"] = _find_name(text)
    info["phone"] = _find_phone(text)
    info["bank"] = _find_bank(text)
    info["amount"] = _find_amount(text)
    return info

# --- DRAWING EXTRA BOLD LOGO ---
def draw_extra_bold_alfa_logo(c, x, y):
    red = colors.HexColor('#EF3124')
    c.setFillColor(red)
    p = c.beginPath()
    p.moveTo(x - 1.5, y)
    p.lineTo(x + 9, y + 27)
    p.curveTo(x + 11, y + 35, x + 19, y + 35, x + 21, y + 27)
    p.lineTo(x + 31.5, y)
    p.lineTo(x + 23.5, y)
    p.lineTo(x + 19.5, y + 11)
    p.lineTo(x + 10.5, y + 11)
    p.lineTo(x + 6.5, y)
    p.close()
    c.drawPath(p, fill=1, stroke=0)
    p_inner = c.beginPath()
    p_inner.moveTo(x + 11.5, y + 16)
    p_inner.lineTo(x + 18.5, y + 16)
    p_inner.lineTo(x + 15, y + 26)
    p_inner.close()
    c.setFillColor(colors.white)
    c.drawPath(p_inner, fill=1, stroke=0)
    c.setFillColor(red)
    c.rect(x - 1.5, y - 11, 33, 9, fill=1, stroke=0)

# --- PDF 1:1 ENGINE ---
def generate_v108_pdf(data: dict) -> BytesIO:
    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    w, h = A4
    alfa_red = colors.HexColor('#EF3124')
    dark_red = colors.HexColor('#A82A2A')
    bank_cyan = colors.HexColor('#0082CA')
    grey = colors.HexColor('#828282')
    black = colors.black
    now_msk = datetime.now(timezone.utc) + timedelta(hours=3)
    ts_full = now_msk.strftime("%d.%m.%Y %H:%M:%S мск")
    ts_short = now_msk.strftime("%d.%m.%Y %H:%M мск")
    base = os.path.dirname(os.path.abspath(__file__))
    logo_path = os.path.join(base, "logo.png")
    stamp_path = os.path.join(base, "stamp.png")
    footer_path = os.path.join(base, "footer.png")
    c.drawImage(logo_path, 35, 761, width=30, height=46, mask='auto')
    c.setFont(FN, 11)
    c.setFillColor(grey)
    c.drawRightString(560, 795, "Сформирована")
    c.setFont(FN, 11)
    c.drawRightString(560, 780, ts_short)
    c.setFont(FN, 21)
    c.setFillColor(black)
    c.drawString(35, 725, "Квитанция о переводе по СБП")
    col1, col2 = 35, 305
    y, step = 687, 43
    amt_raw = str(data['amount']).replace("\u00a0", " ").replace(" ", "").replace(",", ".")
    amt = f"{float(amt_raw):,.0f}".replace(",", " ") + " RUR"
    acc = "408178102059044" + "".join(random.choices("0123456789", k=5))
    opn = "C" + "".join(random.choices("0123456789", k=15))
    sid = "A52130925214490T00000" + "".join(random.choices("0123456789", k=11))
    def row(lx, rx, lbl, val, cur_y, fs=12):
        c.setFont(FN, 11)
        c.setFillColor(grey)
        c.drawString(lx, cur_y, lbl)
        c.setFont(FN, fs)
        c.setFillColor(black)
        c.drawString(lx, cur_y - 18, str(val))
    row(col1, col2, "Сумма перевода", amt, y)
    row(col2, col2, "Номер телефона получателя", str(data['phone']), y)
    y -= step
    row(col1, col2, "Комиссия", "0 RUR", y)
    row(col2, col2, "Банк получателя", str(data['bank']), y)
    y -= step
    row(col1, col2, "Дата и время перевода", ts_full, y)
    row(col2, col2, "Счёт списания", acc, y)
    y -= step
    row(col1, col2, "Номер операции", opn, y)
    row(col2, col2, "Идентификатор операции в СБП", sid, y)
    y -= step
    row(col1, col2, "Получатель", str(data['recipient']), y)
    row(col2, col2, "Сообщение получателю", "Перевод денежных средств", y)
    c.drawImage(stamp_path, 35, 371, width=201, height=85, mask='auto')
    c.drawImage(footer_path, 263, 36, width=297, height=35, mask='auto')
    c.showPage()
    c.save()
    buffer.seek(0)
    return buffer

router = Router()

ALLOWED_CHAT = -5488159430

@router.message.outer_middleware()
async def chat_only(handler, event, data):
    if getattr(event, 'chat', None) and getattr(event.chat, 'id', None) != ALLOWED_CHAT:
        return None
    return await handler(event, data)

async def _safe_answer(m: Message, text: str):
    try:
        await m.answer(text)
    except Exception as e:
        logging.error(f"Не удалось отправить сообщение: {e}")

async def finalize_receipt(m: Message, data: dict):
    await _safe_answer(m, "⏳ Генерация...")
    try:
        loop = asyncio.get_running_loop()
        pdf = await loop.run_in_executor(None, generate_v108_pdf, data)
        await m.answer_document(BufferedInputFile(pdf.read(), filename="receipt.pdf"))
    except Exception as e:
        logging.exception("generate failed")
        await _safe_answer(m, f"❌ Ошибка генерации: {e}")

@router.message(CommandStart())
async def s(m: Message, state: FSMContext):
    await state.clear()
    await m.answer("Бот готов. Перешли объявление или сделку, либо нажмите /gen")

@router.message(F.text == "/gen")
async def g(m: Message, state: FSMContext):
    await state.update_data(amount=None, phone=None, bank=None)
    await m.answer("Сумма:")
    await state.set_state(BotStates.waiting_amount)

# --- FSM-обработчики идут ПЕРЕД handle_forwarded, чтобы иметь приоритет ---
@router.message(BotStates.waiting_amount)
async def a(m: Message, state: FSMContext):
    await state.update_data(amount=m.text)
    await prompt_next(m, state)

@router.message(BotStates.waiting_phone)
async def p(m: Message, state: FSMContext):
    await state.update_data(phone=m.text)
    await prompt_next(m, state)

@router.message(BotStates.waiting_bank)
async def b(m: Message, state: FSMContext):
    await state.update_data(bank=m.text)
    await prompt_next(m, state)

@router.message(BotStates.waiting_recipient)
async def r(m: Message, state: FSMContext):
    data = await state.get_data()
    data['recipient'] = m.text
    await state.clear()
    await finalize_receipt(m, data)

async def prompt_next(m: Message, state: FSMContext):
    data = await state.get_data()
    if not data.get("phone"):
        await state.set_state(BotStates.waiting_phone)
        await _safe_answer(m, "Реквизиты (номер):")
        return
    if not data.get("bank"):
        await state.set_state(BotStates.waiting_bank)
        await _safe_answer(m, "Банк:")
        return
    if not data.get("amount"):
        await state.set_state(BotStates.waiting_amount)
        await _safe_answer(m, "Сумма:")
        return
    await state.set_state(BotStates.waiting_recipient)
    await _safe_answer(m, "ФИО:")

# --- FORWARDED OFFER / DEAL HANDLING (срабатывает только когда НЕТ активного FSM-состояния) ---
@router.message(F.text, ~F.text.startswith("/"))
async def handle_forwarded(m: Message, state: FSMContext):
    info = parse_forwarded(m.text)
    if not info["source"]:
        return
    # check seller name
    if info["name"]:
        res = await check_target(m.from_user.id, info["name"])
        if res["exists"]:
            await m.answer(f"⚠️ Попытки были! Всего: {res['attempts']}, Успешно: {res['success']}")
        else:
            await m.answer("✅ Чистый! Пробуй")
    # xRocket: only name check
    if info["source"] == "xrocket":
        return
    # Crypto Bot deal/offer: collect fields, then ask only missing ones
    await state.update_data(
        amount=info["amount"],
        phone=info["phone"],
        bank=info["bank"],
    )
    await prompt_next(m, state)

async def main():
    await init_db()
    bot = Bot(token=BOT_TOKEN)
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
