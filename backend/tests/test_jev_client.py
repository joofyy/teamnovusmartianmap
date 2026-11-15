"""Phase 1 tests for the JEV client reliability and diagnostics layer.

These tests do not hit any live provider. They use a scripted replacement for
httpx.AsyncClient so each scenario (transient transport failure, cold-start
non-JSON 503, malformed success, timeout, auth error, validation error, 404
misconfiguration, correlation ids, fallback, successful adaptive replan) can
be exercised deterministically without external provider credentials.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from app.services import jev_client


class FakeResponse:
    def __init__(self, status_code, json_data=None):
        self.status_code = status_code
        self._json = json_data
        self.is_success = 200 <= status_code < 300

    def json(self):
        if self._json is None:
            raise ValueError("not json")
        return self._json


class FakeClient:
    instances: list = []
    responses: list = []
    get_responses: list = []

    def __init__(self, *args, **kwargs):
        self.posts = []
        self.gets = []
        FakeClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        if not FakeClient.responses:
            raise httpx.ConnectError("no scripted response")
        entry = FakeClient.responses.pop(0)
        if isinstance(entry, Exception):
            raise entry
        return entry

    async def get(self, url, headers=None):
        self.gets.append({"url": url, "headers": headers})
        if not FakeClient.get_responses:
            raise httpx.ConnectError("no scripted health response")
        entry = FakeClient.get_responses.pop(0)
        if isinstance(entry, Exception):
            raise entry
        return entry


@pytest.fixture(autouse=True)
def _reset_fake_client(monkeypatch):
    FakeClient.instances = []
    FakeClient.responses = []
    FakeClient.get_responses = []
    monkeypatch.setattr(jev_client.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(jev_client, "_RETRY_BACKOFF_SECONDS", 0)
    yield


def _set_configured(monkeypatch, configured=True):
    if configured:
        monkeypatch.setenv("JEV_SERVICE_URL", "https://jev.example.test")
        monkeypatch.setenv("MARSCOPE_JEV_SERVICE_TOKEN", "test-token-value")
    else:
        monkeypatch.delenv("JEV_SERVICE_URL", raising=False)
        monkeypatch.delenv("MARSCOPE_JEV_SERVICE_TOKEN", raising=False)


def _run(coro):
    return asyncio.run(coro)


def test_not_configured_raises_503_with_static_fallback(monkeypatch):
    _set_configured(monkeypatch, False)
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "transient"}))
    assert exc_info.value.status_code == 503
    assert "static balanced route" in exc_info.value.detail
    assert FakeClient.instances == []


def test_transient_connect_error_retried_once_then_fails(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [httpx.ConnectError("boom"), httpx.ConnectError("boom")]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 503
    assert "correlation_id=" in exc_info.value.detail
    assert "test-token-value" not in exc_info.value.detail
    assert len(FakeClient.instances) == 2


def test_transient_timeout_then_success_retries_and_applies(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [
        httpx.ReadTimeout("slow"),
        FakeResponse(200, {"weights": {"distance": 1.0}, "model": "m", "policyVersion": "p"}),
    ]
    result = _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert result["weights"]["distance"] == 1.0
    assert isinstance(result["correlation_id"], str)
    assert len(FakeClient.instances) == 2
    last = jev_client.last_successful_evaluation()
    assert last["available"] is True
    assert last["model"] == "m"


def test_non_json_503_is_treated_transient_and_retried(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [
        FakeResponse(503),
        FakeResponse(200, {"weights": {"distance": 0.5}, "model": "m"}),
    ]
    result = _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert result["weights"]["distance"] == 0.5
    assert len(FakeClient.instances) == 2


def test_non_json_502_then_502_still_fails_503(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(502), FakeResponse(502)]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 503
    assert "temporarily unavailable" in exc_info.value.detail or "starting up or unreachable" in exc_info.value.detail
    assert "correlation_id=" in exc_info.value.detail


def test_json_503_provider_failure_is_retried_once(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [
        FakeResponse(503, {"detail": "Provider temporarily unavailable."}),
        FakeResponse(200, {"weights": {"distance": 0.5}, "model": "m"}),
    ]
    result = _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert result["weights"]["distance"] == 0.5
    assert len(FakeClient.instances) == 2


def test_json_503_service_auth_configuration_is_not_retried(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(503, {"detail": "JEV service authentication is not configured."})]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 503
    assert "authentication is not configured" in exc_info.value.detail
    assert len(FakeClient.instances) == 1


def test_json_429_rate_limit_is_not_retried(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(429, {"detail": "Provider rate limit reached."})]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 429
    assert "rate limit" in exc_info.value.detail
    assert len(FakeClient.instances) == 1


def test_health_probe_distinguishes_service_ready_from_http_reachable(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.get_responses = [FakeResponse(200, {
        "status": "ok",
        "service": "marscope-jev-decision-service",
        "configured": False,
    })]
    result = _run(jev_client.probe_jev_reachability())
    assert result["reachable"] is True
    assert result["service_configured"] is False
    assert result["service_ready"] is False
    assert result["reason"] == "service_token_not_configured"


def test_health_probe_rejects_unexpected_service_response(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.get_responses = [FakeResponse(200, {"status": "ok", "service": "other-service", "configured": True})]
    result = _run(jev_client.probe_jev_reachability())
    assert result["reachable"] is False
    assert result["service_ready"] is False
    assert result["reason"] == "unexpected_health_response"


def test_json_401_is_not_retried(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(401, {"detail": "Unauthorized JEV service request."})]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 401
    assert "Unauthorized" in exc_info.value.detail
    assert len(FakeClient.instances) == 1


def test_json_400_validation_is_not_retried(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(400, {"detail": "Enter a valid provider API key (maximum 1,024 characters)."})]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 400
    assert len(FakeClient.instances) == 1


def test_non_json_404_reported_as_misconfigured(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(404)]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 502
    assert "misconfigured" in exc_info.value.detail
    assert len(FakeClient.instances) == 1


def test_malformed_non_dict_success_raises_502(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(200, ["not", "a", "dict"])]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 502
    assert "invalid response" in exc_info.value.detail
    assert "correlation_id=" in exc_info.value.detail


def test_weights_not_dict_raises_502(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(200, {"weights": "nope", "model": "m"})]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    assert exc_info.value.status_code == 502
    assert "invalid weight vector" in exc_info.value.detail


def test_correlation_id_sent_in_header_and_echoed_in_error(monkeypatch):
    _set_configured(monkeypatch)
    FakeClient.responses = [FakeResponse(502), FakeResponse(502)]
    with pytest.raises(HTTPException) as exc_info:
        _run(jev_client.request_jev_pathfinding_weights({"apiKey": "k"}))
    sent_header = FakeClient.instances[0].posts[0]["headers"].get("X-Correlation-Id")
    assert isinstance(sent_header, str) and len(sent_header) > 0
    assert ("correlation_id=" + sent_header) in exc_info.value.detail
    assert "test-token-value" not in exc_info.value.detail


def test_successful_adaptive_replan_records_last_success(monkeypatch):
    _set_configured(monkeypatch)
    weights = {
        "distance": 0.6,
        "time": 0.4,
        "energy": 0.7,
        "terrain_risk": 0.8,
        "environment_risk": 0.5,
        "radiation": 0.5,
        "uncertainty": 0.5,
        "science_opportunity_cost": 0.6,
        "oxygen": 0.7,
    }
    FakeClient.responses = [FakeResponse(200, {"weights": weights, "model": "jev-test-model", "policyVersion": "p1"})]
    result = _run(jev_client.request_jev_pathfinding_weights({"provider": "typesafe", "apiKey": "k"}))
    assert result["weights"] == weights
    assert result["correlation_id"] is not None
    last = jev_client.last_successful_evaluation()
    assert last["available"] is True
    assert last["model"] == "jev-test-model"
    assert last["provider"] == "typesafe"
    assert last["policy_version"] == "p1"
