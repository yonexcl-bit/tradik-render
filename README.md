# SupGift / Tradik — деплой на Render

Репозиторий содержит 5 ботов. Deploy идёт через **Render Blueprint** (`render.yaml`).

## Сервисы

| Сервис | Тип | Папка | Что делает |
|---|---|---|---|
| `trade` | Web Service | `trade/` | Основной бот: API + мини-апп (порт из `PORT`) |
| `bot2` | Worker | `bot2/` | Магазин подарков (кнопки, выдать/продать) |
| `work-bot` | Worker | `work-bot/` | @FKPDSFKOSKObot |
| `offera` | Worker | `offera/` | @StarToGiftsBot — офферы подарков |
| `checks` | Worker | `checks/` | Бот-чеки (работает только в чате `-5488159430`) |
| `trade-db` | PostgreSQL | — | Общая база для trade / bot2 / work-bot |

Все боты работают на **поллинге** (никаких вебхуков и туннелей) — Render сам держит процесс живым.

## Как задеплоить

1. Залить этот репозиторий на GitHub (любой репозиторий, private подойдёт).
2. В Render: **New → Blueprint** → выбрать репозиторий → Render прочитает `render.yaml`.
3. Заполнить секреты (`sync: false`), они попросят при создании:
   - `BOT_TOKEN` — токен основного бота (@SuppGiftbot)
   - `MAIN_TOKEN` — тот же токен основного бота (для уведомлений из bot2/work-bot)
   - `BOT2_TOKEN` — токен второго бота
   - `WORK_BOT_TOKEN` — токен @FKPDSFKOSKObot
   - `BANK_ACCOUNT` — юзернейм банк-аккаунта (например `supgiftbank`)
   - `OFFERA_API_ID`, `OFFERA_API_HASH` — api_id/api_hash с my.telegram.org (для входа юзербота в offera)

## Переменные окружения

- `DATABASE_URL` — подставляется автоматически из `trade-db`.
- `APP_URL` — домин Render-сервиса `trade` (подставляется автоматически, схема `https://` добавляется в коде).
- `PORT` — задаёт Render для веб-сервиса.
- `ADMIN_ID` — ID суперадмина (по умолчанию `7593759960`).
- `WEBHOOK_SECRET`, `INTERNAL_API_SECRET` — генерируются автоматически.

## Важно

- **Free-план**: Postgres в Render бесплатен, но **удаляется через 30 дней** — потом нужно создать новый (или перейти на платный). Данные `trade-db` при пересоздании сбрасываются.
- **offera** и **checks** используют SQLite (`inline_offers.sqlite3`, `bot_v108.db`). На бесплатном плане файловая система эфемерная — база **сбрасывается при каждом рестарте/деплое**. Для постоянного хранения нужен платный план с Persistent Disk, либо перевод на PostgreSQL.
- Telegram-токены лучше задавать через Render Secrets (`sync: false` в Blueprint).
- `bot2` и `work-bot` обращаются к основному боту за уведомлениями через `MAIN_TOKEN`.

## Локальный запуск (для проверки)

```bash
cd trade && npm install && BOT_TOKEN=... DATABASE_URL=... node server.js
cd bot2  && npm install && BOT2_TOKEN=... DATABASE_URL=... node bot2.js
cd offera && pip install -r requirements.txt && python bot.py
cd checks && pip install -r requirements.txt && python run_bot_launcher.py
```
