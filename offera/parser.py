from dataclasses import dataclass
from datetime import datetime, timezone
import re


INFO_PATTERN = re.compile(
    r"^/info\s+(?P<url>https?://t\.me/nft/(?P<slug>[A-Za-z0-9][A-Za-z0-9_-]*))\s+"
    r"(?P<language>[A-Za-z]{2,10})\s+"
    r"(?P<amount>\d+(?:[.,]\d{1,2})?)"
    r"(?:\s+(?P<currency>gram|star))?$",
    re.IGNORECASE,
)

OFFER_PATTERN = re.compile(
    r"^/offer\s+(?P<url>https?://t\.me/nft/(?P<slug>[A-Za-z0-9][A-Za-z0-9_-]*))$",
    re.IGNORECASE,
)

OFFER_NFT_PATTERN = re.compile(
    r"^/offer\s+(?P<gift_name>[A-Za-z0-9_-]+)#(?P<gift_number>\d+)$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class InfoCommand:
    url: str
    gift_name: str
    gift_number: int
    language: str
    amount: int | float
    currency: str


@dataclass(frozen=True)
class OfferCommand:
    url: str
    gift_name: str
    gift_number: int


def _gift_details(match: re.Match[str]) -> tuple[str, int] | None:
    slug = match.group("slug")
    gift_name, separator, gift_number_text = slug.rpartition("-")
    if not separator or not gift_name or not gift_number_text.isdigit():
        return None
    return gift_name, int(gift_number_text)


def parse_info_command(text: str) -> InfoCommand | None:
    match = INFO_PATTERN.fullmatch(text.strip())
    if not match:
        return None

    details = _gift_details(match)
    if details is None:
        return None

    amount_text = match.group("amount").replace(",", ".")
    amount: int | float = float(amount_text)
    if amount.is_integer():
        amount = int(amount)

    cur_raw = match.group("currency")
    currency = cur_raw.lower() if cur_raw else None
    if currency == "star":
        currency = "stars"

    return InfoCommand(
        url=match.group("url"),
        gift_name=details[0],
        gift_number=details[1],
        language=match.group("language").lower(),
        amount=amount,
        currency=currency,
    )


def parse_offer_command(text: str) -> OfferCommand | None:
    nft_match = OFFER_NFT_PATTERN.fullmatch(text.strip())
    if nft_match:
        gift_name = nft_match.group("gift_name")
        gift_number = int(nft_match.group("gift_number"))
        slug = f"{gift_name}-{gift_number}"
        url = f"https://t.me/nft/{slug}"
        return OfferCommand(
            url=url,
            gift_name=gift_name,
            gift_number=gift_number,
        )

    match = OFFER_PATTERN.fullmatch(text.strip())
    if not match:
        return None

    details = _gift_details(match)
    if details is None:
        return None

    return OfferCommand(
        url=match.group("url"),
        gift_name=details[0],
        gift_number=details[1],
    )


def format_amount(amount: int | float) -> str:
    if float(amount).is_integer():
        return str(int(amount))
    return f"{amount:.2f}".rstrip("0").rstrip(".")


def format_expiry(expires_at: datetime) -> str:
    local_time = expires_at.astimezone()
    return local_time.strftime("%d.%m.%Y %H:%M")