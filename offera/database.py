from datetime import datetime, timezone
import sqlite3


class InlineDatabase:
    def __init__(self, path: str) -> None:
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS offers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL,
                source_message_id INTEGER NOT NULL,
                buyer_id INTEGER NOT NULL,
                buyer_name TEXT NOT NULL,
                buyer_username TEXT,
                gift_url TEXT NOT NULL,
                gift_name TEXT NOT NULL,
                gift_number INTEGER NOT NULL,
                language TEXT NOT NULL,
                amount REAL NOT NULL,
                currency TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                offer_message_id TEXT
            );
            CREATE TABLE IF NOT EXISTS listings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                seller_id INTEGER NOT NULL,
                seller_name TEXT NOT NULL,
                seller_username TEXT,
                seller_chat_id INTEGER,
                gift_url TEXT NOT NULL UNIQUE,
                gift_name TEXT NOT NULL,
                gift_number INTEGER NOT NULL,
                language TEXT NOT NULL,
                amount REAL NOT NULL,
                currency TEXT NOT NULL,
                created_at TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS admins (
                user_id INTEGER PRIMARY KEY,
                added_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS authorized_users (
                user_id INTEGER PRIMARY KEY,
                auth_token TEXT NOT NULL,
                authorized INTEGER NOT NULL DEFAULT 1,
                authorized_at TEXT NOT NULL
            );
            """
        )
        self.connection.commit()

    @classmethod
    async def create(cls, path: str) -> "InlineDatabase":
        return cls(path)

    def create_listing(self, **values) -> sqlite3.Row:
        self.connection.execute(
            """
            INSERT INTO listings (
                seller_id, seller_name, seller_username, seller_chat_id,
                gift_url, gift_name, gift_number, language, amount,
                currency, created_at
            ) VALUES (
                :seller_id, :seller_name, :seller_username, :seller_chat_id,
                :gift_url, :gift_name, :gift_number, :language, :amount,
                :currency, :created_at
            )
            ON CONFLICT(gift_url) DO UPDATE SET
                seller_name = excluded.seller_name,
                seller_username = excluded.seller_username,
                gift_name = excluded.gift_name,
                gift_number = excluded.gift_number,
                language = excluded.language,
                amount = excluded.amount,
                currency = excluded.currency,
                created_at = excluded.created_at,
                active = 1
            """,
            values,
        )
        self.connection.commit()
        return self.find_listing(values["gift_url"])

    def find_listing(self, gift_url: str):
        return self.connection.execute(
            "SELECT * FROM listings WHERE gift_url = ?", (gift_url,)
        ).fetchone()

    def find_listing_by_id(self, offer_id: int):
        return self.connection.execute(
            "SELECT * FROM listings WHERE id = ?", (offer_id,)
        ).fetchone()

    def take_listing(self, gift_url: str):
        return self.find_listing(gift_url)

    def add_admin(self, user_id: int) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO admins (user_id, added_at) VALUES (?, ?)",
            (user_id, datetime.now(timezone.utc).isoformat()),
        )
        self.connection.commit()

    def is_admin(self, user_id: int) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM admins WHERE user_id = ?", (user_id,)
        ).fetchone() is not None

    def is_authorized(self, user_id: int) -> bool:
        row = self.connection.execute(
            "SELECT authorized FROM authorized_users WHERE user_id = ?", (user_id,)
        ).fetchone()
        return row is not None and bool(row["authorized"])

    def authorize_user(self, user_id: int, token: str) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO authorized_users (user_id, auth_token, authorized, authorized_at) VALUES (?, ?, 1, ?)",
            (user_id, token, datetime.now(timezone.utc).isoformat()),
        )
        self.connection.commit()

    def revoke_authorization(self, user_id: int) -> None:
        self.connection.execute(
            "UPDATE authorized_users SET authorized = 0 WHERE user_id = ?", (user_id,)
        )
        self.connection.commit()

    def remove_admin(self, user_id: int) -> None:
        self.connection.execute(
            "DELETE FROM admins WHERE user_id = ?", (user_id,)
        )
        self.connection.commit()

    def list_admins(self) -> list:
        rows = self.connection.execute(
            "SELECT user_id FROM admins ORDER BY user_id"
        ).fetchall()
        return [row["user_id"] for row in rows]

    def create_offer(self, **values) -> sqlite3.Row:
        cursor = self.connection.execute(
            """
            INSERT INTO offers (
                chat_id, source_message_id, buyer_id, buyer_name, buyer_username,
                gift_url, gift_name, gift_number, language, amount, currency,
                created_at, expires_at
            ) VALUES (
                :chat_id, :source_message_id, :buyer_id, :buyer_name, :buyer_username,
                :gift_url, :gift_name, :gift_number, :language, :amount, :currency,
                :created_at, :expires_at
            )
            """,
            values,
        )
        self.connection.commit()
        return self.get_offer(cursor.lastrowid)

    def get_offer(self, offer_id: int):
        row = self.connection.execute(
            "SELECT * FROM offers WHERE id = ?", (offer_id,)
        ).fetchone()
        if row is None:
            raise LookupError(f"Offer {offer_id} not found")
        return row

    def set_offer_message_id(self, offer_id: int, message_id) -> None:
        self.connection.execute(
            "UPDATE offers SET offer_message_id = ? WHERE id = ?",
            (message_id, offer_id),
        )
        self.connection.commit()

    def take_pending_offer(self, offer_id: int, status: str):
        now = datetime.now(timezone.utc).isoformat()
        cursor = self.connection.execute(
            """
            UPDATE offers SET status = ?
            WHERE id = ? AND status = 'pending' AND expires_at > ?
            """,
            (status, offer_id, now),
        )
        self.connection.commit()
        if cursor.rowcount != 1:
            return None
        return self.get_offer(offer_id)

    def list_offers(self, limit: int = 50) -> list:
        rows = self.connection.execute(
            "SELECT * FROM offers ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return rows

    def delete_offer(self, offer_id: int) -> None:
        self.connection.execute("DELETE FROM offers WHERE id = ?", (offer_id,))
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()