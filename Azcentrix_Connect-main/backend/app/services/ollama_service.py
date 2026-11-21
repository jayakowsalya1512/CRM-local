from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.core.config import settings


class OllamaService:
    def __init__(self) -> None:
        self.base_url = settings.OLLAMA_BASE_URL.rstrip("/")

        self.timeout = httpx.Timeout(
            timeout=float(settings.OLLAMA_TIMEOUT_SECONDS),
            connect=10.0,
        )

        self.semaphore = asyncio.Semaphore(
            settings.AI_MAX_CONCURRENT_REQUESTS
        )

    async def health_check(self) -> dict[str, Any]:
        async with httpx.AsyncClient(
            base_url=self.base_url,
            timeout=15.0,
        ) as client:
            response = await client.get("/api/tags")
            response.raise_for_status()

            return response.json()

    async def chat(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
    ) -> str:
        payload = {
            "model": settings.OLLAMA_CHAT_MODEL,
            "stream": False,
            "messages": [
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": user_prompt,
                },
            ],
            "options": {
                "temperature": 0.1,
            },
            "keep_alive": settings.OLLAMA_KEEP_ALIVE,
        }

        async with self.semaphore:
            async with httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
            ) as client:
                response = await client.post(
                    "/api/chat",
                    json=payload,
                )

                response.raise_for_status()
                body = response.json()

        message = body.get("message") or {}
        content = message.get("content")

        if not content:
            raise RuntimeError(
                "Ollama returned an empty response."
            )

        return str(content).strip()


ollama_service = OllamaService()