import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main
from app.services.jev_client import request_jev_pathfinding_weights
from app.terrain import generate_terrain


def test_jev_weights_endpoint_derives_layers_from_selected_terrain(monkeypatch):
    terrain = generate_terrain(width=16, height=16, seed=42)
    captured = {}

    async def fake_request(payload):
        captured.update(payload)
        return {
            "provider": payload["provider"],
            "model": "test-model",
            "evaluatedAt": "2026-11-15T00:00:00.000Z",
            "missionPrompt": payload["missionPrompt"],
            "strategy": "balanced",
            "weights": {"distance": 1.0},
            "judgements": [],
            "jevInfluenceShare": 0.9,
            "strategyPriorShare": 0.1,
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "policyVersion": "test",
            "notice": "Test result only",
        }

    monkeypatch.setattr(main, "_terrain_for_site", lambda _site_id: terrain)
    monkeypatch.setattr(main, "request_jev_pathfinding_weights", fake_request)

    client = TestClient(main.app)
    response = client.post(
        "/api/jev/pathfinding-weights",
        json={
            "provider": "typesafe",
            "apiKey": "temporary-test-key",
            "missionPrompt": "Prioritize a low-risk traverse with useful science access.",
            "site_id": "jezero",
            # Browser-supplied layer claims are deliberately ignored.
            "availableLayers": ["made_up_layer"],
        },
    )

    assert response.status_code == 200
    assert captured["availableLayers"] == sorted(terrain.available_layers)
    assert "made_up_layer" not in captured["availableLayers"]
    assert captured["missionContext"]["cell_size_m"] == terrain.cell_m
    assert response.headers["cache-control"].startswith("no-store")
    assert "temporary-test-key" not in response.text


def test_jev_client_falls_back_when_service_is_not_configured(monkeypatch):
    monkeypatch.delenv("JEV_SERVICE_URL", raising=False)
    monkeypatch.delenv("MARSCOPE_JEV_SERVICE_TOKEN", raising=False)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(request_jev_pathfinding_weights({"apiKey": "transient"}))

    assert exc_info.value.status_code == 503
    assert "static balanced route remains available" in exc_info.value.detail


def test_evidence_assessment_endpoint_forwards_user_record_without_caching(monkeypatch):
    captured = {}

    async def fake_request(payload):
        captured.update(payload)
        return {
            "model": "test-model",
            "evaluatedAt": "2026-11-15T00:00:00.000Z",
            "results": [],
            "notice": "Test review only",
        }

    monkeypatch.setattr(main, "request_jev_evidence_assessment", fake_request)
    client = TestClient(main.app)
    response = client.post(
        "/api/jev/evidence-assessment",
        json={
            "provider": "opencode",
            "apiKey": "temporary-evidence-key",
            "objective": "Assess evidence for the mission objective.",
            "hypothesis": "The deposit may include hydrated minerals.",
            "evidence": [{
                "id": "record-1",
                "title": "NASA PDS observation record",
                "summary": "User-supplied observation summary.",
                "url": "https://pds.nasa.gov/example-record",
            }],
        },
    )

    assert response.status_code == 200
    assert captured["evidence"][0]["id"] == "record-1"
    assert captured["provider"] == "opencode"
    assert response.headers["cache-control"].startswith("no-store")
    assert "temporary-evidence-key" not in response.text


def test_jev_status_endpoint_reports_config_and_last_success_without_secrets(monkeypatch):
    async def fake_probe():
        return {"configured": True, "reachable": True, "service_configured": True, "service_ready": True, "status_code": 200}

    monkeypatch.setattr(main, "probe_jev_reachability", fake_probe)
    monkeypatch.setattr(
        main,
        "jev_service_config",
        lambda: {
            "configured": True,
            "service_url": "https://jev.example.test",
            "token_configured": True,
        },
    )
    monkeypatch.setattr(
        main,
        "last_successful_evaluation",
        lambda: {
            "available": True,
            "timestamp_utc": "2026-11-15T00:00:00+00:00",
            "endpoint": "/v1/pathfinding-weights",
            "model": "test-model",
            "provider": "typesafe",
            "policy_version": "test",
            "correlation_id": "abc12345",
        },
    )

    client = TestClient(main.app)
    response = client.get("/api/jev/status")

    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is True
    assert body["reachable"] is True
    assert body["ready"] is True
    assert body["reachability"]["service_ready"] is True
    assert body["last_success"]["model"] == "test-model"
    assert body["last_success"]["correlation_id"] == "abc12345"
    assert response.headers["cache-control"].startswith("no-store")
    assert "test-token-value" not in response.text
    assert "MARSCOPE_JEV_SERVICE_TOKEN" not in response.text

