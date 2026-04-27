from __future__ import annotations

import base64
import json
import re
from datetime import datetime
from urllib.parse import urljoin

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.dependencies import get_model_service
from app.core.errors import BadRequestError
from app.domain.enums import ProviderType
from app.schemas.api import ChatAttachment, ChatCompletionRequest, ChatCompletionResponse
from app.schemas.config import ModelConfig
from app.services.model_service import ModelService
from app.services.search_service import search_service

router = APIRouter(prefix="/chat", tags=["chat"])
SYSTEM_MESSAGE = (
    "You are Quokka, a local assistant inside a desktop model manager. "
    "Answer in the user's language, be complete but concise. If your runtime emits reasoning or <think> text, "
    "Quokka will separate it into a collapsible thinking panel; keep the final answer clean."
)


@router.post("/completion", response_model=ChatCompletionResponse)
async def create_chat_completion(
    payload: ChatCompletionRequest,
    model_service: ModelService = Depends(get_model_service),
) -> ChatCompletionResponse:
    model = model_service.config_service.get_model(payload.model_id)
    profile = model.get_active_profile()
    temperature = payload.temperature if payload.temperature is not None else profile.temperature if profile else 0.2
    top_p = payload.top_p if payload.top_p is not None else profile.top_p if profile else 0.95

    if model.provider == ProviderType.OLLAMA:
        content, finish_reason, thinking_content = await _chat_with_ollama(model, payload, temperature, top_p)
    else:
        content, finish_reason, thinking_content = await _chat_with_openai_compatible(model, payload, temperature, top_p)

    return ChatCompletionResponse(
        model_id=model.id,
        model_name=model.name,
        content=content,
        thinking_content=thinking_content or None,
        thinking_tokens_estimate=_estimate_tokens(thinking_content or "") if thinking_content else None,
        created_at=datetime.utcnow(),
        finish_reason=finish_reason,
        truncated=finish_reason in {"length", "max_tokens"},
        max_tokens=payload.max_tokens,
    )


@router.post("/completion/stream")
async def stream_chat_completion(
    payload: ChatCompletionRequest,
    model_service: ModelService = Depends(get_model_service),
) -> StreamingResponse:
    model = model_service.config_service.get_model(payload.model_id)
    profile = model.get_active_profile()
    temperature = payload.temperature if payload.temperature is not None else profile.temperature if profile else 0.2
    top_p = payload.top_p if payload.top_p is not None else profile.top_p if profile else 0.95

    async def events():
        try:
            if model.provider == ProviderType.OLLAMA:
                async for event in _stream_with_ollama(model, payload, temperature, top_p):
                    yield event
            else:
                async for event in _stream_with_openai_compatible(model, payload, temperature, top_p):
                    yield event
        except Exception as exc:  # noqa: BLE001 - stream errors must become data events.
            yield _sse("error", {"detail": str(exc)})

    return StreamingResponse(events(), media_type="text/event-stream")


async def _chat_with_openai_compatible(
    model: ModelConfig,
    payload: ChatCompletionRequest,
    temperature: float,
    top_p: float,
) -> tuple[str, str | None, str | None]:
    messages = [message.model_dump() for message in payload.messages]
    messages = _ensure_system_message(messages)
    
    # If web search is enabled, perform search and augment the query
    if payload.enable_web_search:
        search_query = payload.messages[-1].content  # Use the last user message as search query
        search_results = await search_service.search_and_augment(
            search_query, 
            provider=payload.web_search_provider
        )
        
        # Add search results to the messages
        messages.append({
            "role": "system",
            "content": search_results
        })
    
    messages = _merge_text_attachments(messages, payload.attachments)
    image_attachments = [attachment for attachment in payload.attachments if attachment.data_url]
    if image_attachments:
        messages = _attach_openai_images(messages, image_attachments)

    request_payload = {
        "model": str(model.metadata.get("served_model", model.name)),
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": payload.max_tokens,
        "stream": False,
    }

    async with httpx.AsyncClient(timeout=payload.timeout_seconds) as client:
        response = await client.post(urljoin(model.endpoint.rstrip("/") + "/", "v1/chat/completions"), json=request_payload)
    if not response.is_success:
        raise BadRequestError(f"Chat request failed with HTTP {response.status_code}: {response.text[:500]}")

    try:
        data = response.json()
        choice = data["choices"][0]
        message = choice["message"]
        answer, thinking = _split_hidden_reasoning(str(message.get("content", "")))
        explicit_thinking = message.get("reasoning_content") or message.get("reasoning") or message.get("thinking")
        if explicit_thinking:
            thinking = str(explicit_thinking)
        return answer, choice.get("finish_reason"), thinking
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise BadRequestError("Chat endpoint returned an unsupported response shape.") from exc


async def _stream_with_openai_compatible(
    model: ModelConfig,
    payload: ChatCompletionRequest,
    temperature: float,
    top_p: float,
):
    messages = [message.model_dump() for message in payload.messages]
    messages = _ensure_system_message(messages)
    messages = _merge_text_attachments(messages, payload.attachments)
    image_attachments = [attachment for attachment in payload.attachments if attachment.data_url]
    if image_attachments:
        messages = _attach_openai_images(messages, image_attachments)

    request_payload = {
        "model": str(model.metadata.get("served_model", model.name)),
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": payload.max_tokens,
        "stream": True,
    }

    raw_content = ""
    explicit_thinking = ""
    finish_reason: str | None = None
    async with httpx.AsyncClient(timeout=payload.timeout_seconds) as client:
        async with client.stream(
            "POST",
            urljoin(model.endpoint.rstrip("/") + "/", "v1/chat/completions"),
            json=request_payload,
        ) as response:
            if not response.is_success:
                body = await response.aread()
                raise BadRequestError(f"Chat stream failed with HTTP {response.status_code}: {body.decode(errors='replace')[:500]}")

            async for line in response.aiter_lines():
                if not line:
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                if line == "[DONE]":
                    break
                try:
                    data = json.loads(line)
                    choice = data.get("choices", [{}])[0]
                    delta = choice.get("delta") or {}
                except (json.JSONDecodeError, TypeError, IndexError):
                    continue
                finish_reason = choice.get("finish_reason") or finish_reason
                thinking_delta = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking")
                if thinking_delta:
                    explicit_thinking += str(thinking_delta)
                    yield _sse("thinking_delta", {"delta": str(thinking_delta)})
                content_delta = delta.get("content")
                if content_delta:
                    raw_content += str(content_delta)
                    yield _sse("delta", {"delta": str(content_delta)})

    answer, parsed_thinking = _split_hidden_reasoning(raw_content)
    thinking = explicit_thinking or parsed_thinking
    yield _sse(
        "done",
        {
            "model_id": model.id,
            "model_name": model.name,
            "content": answer,
            "thinking_content": thinking or None,
            "thinking_tokens_estimate": _estimate_tokens(thinking or "") if thinking else None,
            "created_at": datetime.utcnow().isoformat(),
            "finish_reason": finish_reason,
            "truncated": finish_reason in {"length", "max_tokens"},
            "max_tokens": payload.max_tokens,
        },
    )


async def _chat_with_ollama(
    model: ModelConfig,
    payload: ChatCompletionRequest,
    temperature: float,
    top_p: float,
) -> tuple[str, str | None, str | None]:
    messages = [message.model_dump() for message in payload.messages]
    messages = _ensure_system_message(messages)
    
    # If web search is enabled, perform search and augment the query
    if payload.enable_web_search:
        search_query = payload.messages[-1].content  # Use the last user message as search query
        search_results = await search_service.search_and_augment(
            search_query, 
            provider=payload.web_search_provider
        )
        
        # Add search results to the messages
        messages.append({
            "role": "system",
            "content": search_results
        })
    
    messages = _merge_text_attachments(messages, payload.attachments)
    image_payloads = [_data_url_to_base64(attachment.data_url) for attachment in payload.attachments if attachment.data_url]
    image_payloads = [item for item in image_payloads if item]
    if image_payloads and messages:
        messages[-1]["images"] = image_payloads

    request_payload = {
        "model": str(model.metadata.get("ollama_model", model.name)),
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature, "top_p": top_p, "num_predict": payload.max_tokens},
    }

    async with httpx.AsyncClient(timeout=payload.timeout_seconds) as client:
        response = await client.post(urljoin(model.endpoint.rstrip("/") + "/", "api/chat"), json=request_payload)
    if not response.is_success:
        raise BadRequestError(f"Ollama chat failed with HTTP {response.status_code}: {response.text[:500]}")

    try:
        data = response.json()
        message = data["message"]
        answer, thinking = _split_hidden_reasoning(str(message.get("content", "")))
        explicit_thinking = message.get("thinking") or message.get("reasoning_content") or message.get("reasoning")
        if explicit_thinking:
            thinking = str(explicit_thinking)
        return answer, data.get("done_reason"), thinking
    except (KeyError, TypeError, ValueError) as exc:
        raise BadRequestError("Ollama returned an unsupported response shape.") from exc


async def _stream_with_ollama(
    model: ModelConfig,
    payload: ChatCompletionRequest,
    temperature: float,
    top_p: float,
):
    messages = [message.model_dump() for message in payload.messages]
    messages = _ensure_system_message(messages)
    
    # If web search is enabled, perform search and augment the query
    if payload.enable_web_search:
        search_query = payload.messages[-1].content  # Use the last user message as search query
        search_results = await search_service.search_and_augment(
            search_query, 
            provider=payload.web_search_provider,
            max_results=payload.web_search_results
        )
        
        # Add search results to the messages
        messages.append({
            "role": "system",
            "content": search_results
        })
    
    messages = _merge_text_attachments(messages, payload.attachments)
    image_payloads = [_data_url_to_base64(attachment.data_url) for attachment in payload.attachments if attachment.data_url]
    image_payloads = [item for item in image_payloads if item]
    if image_payloads and messages:
        messages[-1]["images"] = image_payloads

    request_payload = {
        "model": str(model.metadata.get("ollama_model", model.name)),
        "messages": messages,
        "stream": True,
        "options": {"temperature": temperature, "top_p": top_p, "num_predict": payload.max_tokens},
    }

    raw_content = ""
    explicit_thinking = ""
    finish_reason: str | None = None
    async with httpx.AsyncClient(timeout=payload.timeout_seconds) as client:
        async with client.stream("POST", urljoin(model.endpoint.rstrip("/") + "/", "api/chat"), json=request_payload) as response:
            if not response.is_success:
                body = await response.aread()
                raise BadRequestError(f"Ollama chat stream failed with HTTP {response.status_code}: {body.decode(errors='replace')[:500]}")

            async for line in response.aiter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = data.get("message") or {}
                thinking_delta = message.get("thinking") or message.get("reasoning_content") or message.get("reasoning")
                if thinking_delta:
                    explicit_thinking += str(thinking_delta)
                    yield _sse("thinking_delta", {"delta": str(thinking_delta)})
                content_delta = message.get("content")
                if content_delta:
                    raw_content += str(content_delta)
                    yield _sse("delta", {"delta": str(content_delta)})
                finish_reason = data.get("done_reason") or finish_reason
                if data.get("done"):
                    break

    answer, parsed_thinking = _split_hidden_reasoning(raw_content)
    thinking = explicit_thinking or parsed_thinking
    yield _sse(
        "done",
        {
            "model_id": model.id,
            "model_name": model.name,
            "content": answer,
            "thinking_content": thinking or None,
            "thinking_tokens_estimate": _estimate_tokens(thinking or "") if thinking else None,
            "created_at": datetime.utcnow().isoformat(),
            "finish_reason": finish_reason,
            "truncated": finish_reason in {"length", "max_tokens"},
            "max_tokens": payload.max_tokens,
        },
    )


def _sse(event: str, payload: dict[str, object]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _ensure_system_message(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    if any(message.get("role") == "system" for message in messages):
        return messages
    return [{"role": "system", "content": SYSTEM_MESSAGE}, *messages]


def _strip_hidden_reasoning(content: str) -> str:
    cleaned, _thinking = _split_hidden_reasoning(content)
    return cleaned.strip()


def _split_hidden_reasoning(content: str) -> tuple[str, str]:
    thinking_parts = re.findall(r"<think>(.*?)</think>", content, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"<think>.*?</think>\s*", "", content, flags=re.IGNORECASE | re.DOTALL)
    lower = cleaned.lower()
    if "</think>" in lower:
        thinking_parts.append(cleaned[: lower.rfind("</think>")])
        cleaned = cleaned[lower.rfind("</think>") + len("</think>") :]
    lower = cleaned.lower().lstrip()
    if lower.startswith("<think>"):
        marker_index = cleaned.lower().find("<think>")
        thinking_parts.append(cleaned[marker_index + len("<think>") :])
        cleaned = ""
    for marker in ("**Final Text**", "**Final Output**", "Final Text:", "Final Output:"):
        index = cleaned.rfind(marker)
        if index >= 0:
            cleaned = cleaned[index + len(marker) :]
            break
    thinking = "\n\n".join(part.strip() for part in thinking_parts if part.strip())
    return cleaned.strip(), thinking.strip()


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(re.findall(r"\S+", text)) * 1.35))


def _merge_text_attachments(messages: list[dict[str, object]], attachments: list[ChatAttachment]) -> list[dict[str, object]]:
    text_blocks = [f"File: {attachment.name}\n{attachment.text}" for attachment in attachments if attachment.text]
    if not text_blocks:
        return messages

    merged = [dict(message) for message in messages]
    attachment_text = "\n\nAttached context:\n\n" + "\n\n---\n\n".join(text_blocks)
    if not merged:
        merged.append({"role": "user", "content": attachment_text})
    else:
        merged[-1]["content"] = f"{merged[-1].get('content', '')}{attachment_text}"
    return merged


def _attach_openai_images(messages: list[dict[str, object]], attachments: list[ChatAttachment]) -> list[dict[str, object]]:
    merged = [dict(message) for message in messages]
    if not merged:
        merged.append({"role": "user", "content": ""})

    text = str(merged[-1].get("content", ""))
    content: list[dict[str, object]] = [{"type": "text", "text": text}]
    for attachment in attachments:
        if attachment.data_url:
            content.append({"type": "image_url", "image_url": {"url": attachment.data_url}})
    merged[-1]["content"] = content
    return merged


def _data_url_to_base64(data_url: str | None) -> str | None:
    if not data_url:
        return None
    if "," in data_url:
        return data_url.split(",", 1)[1]
    try:
        base64.b64decode(data_url, validate=True)
        return data_url
    except ValueError:
        return None
