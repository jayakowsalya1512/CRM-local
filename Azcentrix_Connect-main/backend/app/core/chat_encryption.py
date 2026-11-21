"""AES-256-GCM encryption for Team Chat message content and attachments.

No other module in this codebase encrypts data at rest (passwords/tokens are
hashed, not encrypted; everything else — SMTP passwords, payment keys — is
stored in plaintext). This is a new pattern, isolated here so it can be
reused by chat_service/chat_router without leaking key material anywhere else.

Key management: keys live only in environment variables (never in the DB or
source), keyed by an integer "version" so a key can be rotated without being
able to decrypt older messages — CHAT_ENCRYPTION_KEYS holds every version
that must still be *readable*; CHAT_ENCRYPTION_ACTIVE_KEY_VERSION controls
which version *new* writes use. Rotating is: add a new version to
CHAT_ENCRYPTION_KEYS, bump CHAT_ENCRYPTION_ACTIVE_KEY_VERSION, keep the old
version around until every message written under it has been re-encrypted
(or forever, if re-encryption is never run) so old rows stay readable.
"""
from __future__ import annotations

import base64
import os
import secrets
from functools import lru_cache
from typing import NamedTuple, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

NONCE_SIZE = 12  # 96-bit nonce, standard for AES-GCM


class EncryptedPayload(NamedTuple):
    ciphertext_b64: str
    nonce_b64: str
    key_version: int


class ChatEncryptionError(RuntimeError):
    pass


def _parse_key(raw: str) -> bytes:
    raw = (raw or "").strip()
    if not raw:
        raise ChatEncryptionError("Chat encryption key is empty")
    # Accept base64 (preferred, 32 raw bytes) or a raw 32-char ascii secret as a fallback.
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception:
        key = raw.encode("utf-8")
    if len(key) != 32:
        # Derive a deterministic 32-byte key from whatever secret was given, so
        # operators can set a passphrase instead of a precise base64 key.
        import hashlib
        key = hashlib.sha256(raw.encode("utf-8")).digest()
    return key


@lru_cache(maxsize=1)
def _key_ring() -> dict[int, bytes]:
    """version -> 32-byte key, loaded once from env/settings."""
    ring: dict[int, bytes] = {}

    # CHAT_ENCRYPTION_KEYS="1:base64key1,2:base64key2"
    multi = os.getenv("CHAT_ENCRYPTION_KEYS") or getattr(settings, "CHAT_ENCRYPTION_KEYS", "") or ""
    for part in multi.split(","):
        part = part.strip()
        if not part or ":" not in part:
            continue
        version_str, key_str = part.split(":", 1)
        try:
            ring[int(version_str.strip())] = _parse_key(key_str)
        except ValueError:
            continue

    # Single-key fallback: CHAT_ENCRYPTION_KEY, always version 1 unless already set above.
    single = os.getenv("CHAT_ENCRYPTION_KEY") or getattr(settings, "CHAT_ENCRYPTION_KEY", "") or ""
    if single and 1 not in ring:
        ring[1] = _parse_key(single)

    if not ring:
        if settings.DEBUG:
            # Dev convenience only: a deterministic local key so the module runs
            # without extra setup. Never reachable when DEBUG is false.
            ring[1] = _parse_key("dev-only-chat-key-do-not-use-in-prod")
        else:
            raise ChatEncryptionError(
                "CHAT_ENCRYPTION_KEY (or CHAT_ENCRYPTION_KEYS) must be set in the environment "
                "to run Team Chat outside DEBUG mode."
            )
    return ring


def active_key_version() -> int:
    configured = os.getenv("CHAT_ENCRYPTION_ACTIVE_KEY_VERSION") or getattr(
        settings, "CHAT_ENCRYPTION_ACTIVE_KEY_VERSION", ""
    )
    if configured:
        try:
            return int(configured)
        except ValueError:
            pass
    return max(_key_ring().keys())


def encrypt_text(plaintext: Optional[str]) -> EncryptedPayload:
    """Encrypt a unicode string. Empty/None input still round-trips as an empty string."""
    return encrypt_bytes((plaintext or "").encode("utf-8"))


def encrypt_bytes(plaintext: bytes) -> EncryptedPayload:
    version = active_key_version()
    key = _key_ring()[version]
    nonce = secrets.token_bytes(NONCE_SIZE)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)
    return EncryptedPayload(
        ciphertext_b64=base64.b64encode(ciphertext).decode("ascii"),
        nonce_b64=base64.b64encode(nonce).decode("ascii"),
        key_version=version,
    )


def decrypt_text(ciphertext_b64: Optional[str], nonce_b64: Optional[str], key_version: Optional[int]) -> str:
    if not ciphertext_b64:
        return ""
    return decrypt_bytes(ciphertext_b64, nonce_b64, key_version).decode("utf-8", errors="replace")


def decrypt_bytes(ciphertext_b64: str, nonce_b64: Optional[str], key_version: Optional[int]) -> bytes:
    ring = _key_ring()
    version = key_version if key_version is not None else 1
    key = ring.get(version)
    if key is None:
        raise ChatEncryptionError(f"No chat encryption key available for version {version}")
    ciphertext = base64.b64decode(ciphertext_b64)
    nonce = base64.b64decode(nonce_b64) if nonce_b64 else b""
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, None)
    except Exception as exc:  # pragma: no cover - corrupt/mismatched key
        raise ChatEncryptionError(f"Failed to decrypt chat payload (key version {version}): {exc}") from exc
