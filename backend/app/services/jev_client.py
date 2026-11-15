"""Request-scoped client for the standalone MARSCOPE JEV decision service.

Provider keys are forwarded in request bodies only. This module never logs
payloads, writes keys to disk, or copies them into process environment.

Phase 1 reliability work:
- Classifies JEV service errors instead of flattening them to one message.
- Attaches a per-request correlation id (X-Correlation-Id) to every call and
  includes it in error details so a failed evaluation is traceable. The token
  and provider key are never placed in a detail string.
- Performs one controlled retry for transient transport failures and for
  non-JSON 502/503/504 responses (Render free-tier cold starts). Authentication,
  validation, rate-limit and provider-key errors are never retried.
- Retains non-sensitive metadata about the last successful evaluation for the
  /api/jev/status diagnostic endpoint. No payloads or keys are stored.
- Does not issue a health check before every JEV request; reachability is
  probed only on demand by the status endpoint.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import HTTPException


_TRANSIENT_HTTPX_ERRORS = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)
_RETRY_BACKOFF_SECONDS = 1.0

_last_success: dict[str, Any] = {
    "available": False,
    "timestamp_utc": None,
    "endpoint": None,
    "model": None,
    "provider": None,
    "policy_version": None,
    "correlation_id": None,
}


def jev_service_config() -> dict[str, Any]:
    """Non-secret configuration snapshot for diagnostics. Never returns the token."""
    service_url = os.getenv("JEV_SERVICE_URL", "").strip().rstrip("/")
    service_token = os.getenv("MARSCOPE_JEV_SERVICE_TOKEN", "").strip()
    return {
        "configured": bool(service_url) and bool(service_token),
        "service_url": service_url if service_url else None,
        "token_configured": bool(service_token),
    }


def last_successful_evaluation() -> dict[str, Any]:
    """Snapshot of the last successful evaluation. Contains no secrets."""
    return dict(_last_success)


async def probe_jev_reachability() -> dict[str, Any]:
    """Check both HTTP reachability and the identity/configuration of JEV.

    This is an on-demand diagnostic only. It never sends the shared service
    token or a provider key to the public health endpoint.
    """
    config = jev_service_config()
    if not config["configured"]:
        return {
            "configured": False,
            "reachable": False,
            "service_configured": False,
            "service_ready": False,
            "reason": "not_configured",
        }

    service_url = config["service_url"]
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
            response = await client.get(
                f"{service_url}/health",
                headers={"Cache-Control": "no-store"},
            )

        if not response.is_success:
            return {
                "configured": True,
                "reachable": False,
                "service_configured": False,
                "service_ready": False,
                "status_code": response.status_code,
                "reason": "health_check_failed",
            }

        try:
            health = response.json()
        except ValueError:
            health = None

        if not isinstance(health, dict) or health.get("service") != "marscope-jev-decision-service" or health.get("status") != "ok":
            return {
                "configured": True,
                "reachable": False,
                "service_configured": False,
                "service_ready": False,
                "status_code": response.status_code,
                "reason": "unexpected_health_response",
            }

        service_configured = health.get("configured") is True
        return {
            "configured": True,
            "reachable": True,
            "service_configured": service_configured,
            "service_ready": service_configured,
            "service": health.get("service"),
            "status_code": response.status_code,
            **({} if service_configured else {"reason": "service_token_not_configured"}),
        }
    except httpx.HTTPError:
        return {
            "configured": True,
            "reachable": False,
            "service_configured": False,
            "service_ready": False,
            "reason": "transport_error",
        }


def _record_success(result: dict[str, Any], endpoint: str, provider: str, correlation_id: str) -> None:
    _last_success.update({
        "available": True,
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "endpoint": endpoint,
        "model": result.get("model"),
        "provider": provider,
        "policy_version": result.get("policyVersion"),
        "correlation_id": correlation_id,
    })


def _classify_error_response(response: httpx.Response, data: Any) -> tuple[int, str, bool]:
    """Map a non-success JEV response to (http_status, safe_detail, retryable).

    The decision service returns JSON for both provider failures and its own
    errors. Handle transient server statuses before the generic JSON-detail
    branch so a useful detail message does not accidentally disable retries.
    """
    status = response.status_code
    detail = (
        data.get("detail", "").strip()
        if isinstance(data, dict) and isinstance(data.get("detail"), str)
        else ""
    )

    if status == 503 and detail and (
        "authentication is not configured" in detail.lower()
        or "service token is not configured" in detail.lower()
    ):
        return (503, detail, False)

    if status in (502, 503, 504, 529):
        fallback = "JEV decision service or provider is temporarily unavailable. The static balanced route remains available."
        return (504 if status == 504 else 503, detail or fallback, True)

    if detail:
        if 400 <= status < 500:
            return status, detail, False
        return 502, detail, False

    if status == 404:
        return (502, "JEV_SERVICE_URL appears misconfigured (the service returned a non-JEV response). The static balanced route remains available.", False)
    if 400 <= status < 500:
        return (status, "JEV decision service rejected the request with an unexpected response. The static balanced route remains available.", False)
    return (502, "JEV decision service returned an unexpected response. The static balanced route remains available.", False)


async def _request_jev_service(endpoint: str, payload: dict[str, Any], required_result_field: str) -> dict[str, Any]:
    config = jev_service_config()
    if not config["configured"]:
        raise HTTPException(status_code=503, detail="JEV decision service is not configured. The static balanced route remains available.")
    service_url = config["service_url"]
    service_token = os.getenv("MARSCOPE_JEV_SERVICE_TOKEN", "").strip()
    correlation_id = uuid.uuid4().hex
    headers = {"Authorization": f"Bearer {service_token}", "Cache-Control": "no-store", "X-Correlation-Id": correlation_id}
    timeout = httpx.Timeout(100.0, connect=5.0)

    last_error: HTTPException | None = None
    for attempt in (1, 2):
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                response = await client.post(f"{service_url}{endpoint}", json=payload, headers=headers)
        except _TRANSIENT_HTTPX_ERRORS as exc:
            is_timeout = isinstance(exc, httpx.TimeoutException)
            detail = "JEV decision service timed out. The static balanced route remains available." if is_timeout else "JEV decision service is unavailable. The static balanced route remains available."
            status = 504 if is_timeout else 503
            last_error = HTTPException(status_code=status, detail=detail)
            if attempt == 1:
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS)
                continue
            raise HTTPException(status_code=status, detail=f"{detail} (correlation_id={correlation_id})") from exc
        except httpx.HTTPError as exc:
            detail = "JEV decision service is unavailable. The static balanced route remains available."
            last_error = HTTPException(status_code=503, detail=detail)
            if attempt == 1:
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS)
                continue
            raise HTTPException(status_code=503, detail=f"{detail} (correlation_id={correlation_id})") from exc

        try:
            data = response.json()
        except ValueError:
            data = None

        if not response.is_success:
            status, detail, retryable = _classify_error_response(response, data)
            if attempt == 1 and retryable:
                last_error = HTTPException(status_code=status, detail=f"{detail} (correlation_id={correlation_id})")
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS)
                continue
            raise HTTPException(status_code=status, detail=f"{detail} (correlation_id={correlation_id})")

        if not isinstance(data, dict) or required_result_field not in data:
            raise HTTPException(status_code=502, detail=("JEV decision service returned an invalid response. The static balanced route remains available. (correlation_id=" + correlation_id + ")"))

        _record_success(data, endpoint, str(payload.get("provider", "unknown")), correlation_id)
        data["correlation_id"] = correlation_id
        return data

    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=503, detail="JEV decision service could not be reached. The static balanced route remains available.")


async def request_jev_pathfinding_weights(payload: dict[str, Any]) -> dict[str, Any]:
    result = await _request_jev_service("/v1/pathfinding-weights", payload, "weights")
    if not isinstance(result["weights"], dict):
        raise HTTPException(status_code=502, detail="JEV decision service returned an invalid weight vector. The static balanced route remains available.")
    return result


async def request_jev_evidence_assessment(payload: dict[str, Any]) -> dict[str, Any]:
    result = await _request_jev_service("/v1/evidence-assessment", payload, "results")
    if not isinstance(result["results"], list):
        raise HTTPException(status_code=502, detail="JEV returned an invalid evidence assessment.")
    return result
