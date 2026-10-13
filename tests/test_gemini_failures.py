"""Tests for Gemini API failure handling, exponential backoff retries, and error classification."""

from unittest.mock import MagicMock
import pytest

from qa_agent.agent import (
    LLMClient,
    classify_gemini_error,
    is_permanent_error,
    is_transient_error,
)


class DummyError(Exception):
    def __init__(self, code, message):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message


def test_classify_gemini_error_codes():
    """Verify that exceptions are correctly classified into structured codes."""
    err_503 = DummyError(503, "This model is currently experiencing high demand.")
    code, msg, retryable = classify_gemini_error(err_503)
    assert code == "GEMINI_UNAVAILABLE"
    assert "temporarily overloaded" in msg
    assert retryable is True

    err_429 = DummyError(429, "Resource exhausted: quota exceeded")
    code, msg, retryable = classify_gemini_error(err_429)
    assert code == "GEMINI_RATE_LIMITED"
    assert "limit has been reached" in msg
    assert retryable is True

    err_auth = DummyError(401, "API_KEY_INVALID: API key not valid")
    code, msg, retryable = classify_gemini_error(err_auth)
    assert code == "GEMINI_AUTH_ERROR"
    assert "configuration is invalid" in msg
    assert retryable is False

    err_timeout = DummyError(504, "Deadline exceeded while waiting for response")
    code, msg, retryable = classify_gemini_error(err_timeout)
    assert code == "GEMINI_TIMEOUT"
    assert "timed out" in msg
    assert retryable is True


def test_is_permanent_vs_transient_error():
    """Verify distinction between retryable transient errors and permanent failures."""
    auth_err = DummyError(401, "API key not valid")
    assert is_permanent_error(auth_err) is True
    assert is_transient_error(auth_err) is False

    bad_req = DummyError(400, "Invalid argument: contents is empty")
    assert is_permanent_error(bad_req) is True
    assert is_transient_error(bad_req) is False

    overload_503 = DummyError(503, "Unavailable")
    assert is_permanent_error(overload_503) is False
    assert is_transient_error(overload_503) is True

    quota_429 = DummyError(429, "Quota exceeded")
    assert is_permanent_error(quota_429) is False
    assert is_transient_error(quota_429) is True


def test_gemini_503_transient_retry_success(monkeypatch):
    """Simulate temporary Gemini 503 followed by success on retry."""
    monkeypatch.setattr("time.sleep", lambda s: None)

    client = LLMClient.__new__(LLMClient)
    client.api_key = "dummy"
    client.model = "gemini-3.7-flash"
    client.max_calls = 10
    client.call_count = 0

    mock_response = MagicMock()
    mock_response.text = '{"thought": "ok", "action": "finish"}'

    # First call raises 503, second call succeeds
    mock_gen = MagicMock(side_effect=[
        DummyError(503, "High demand - temporary spike"),
        mock_response
    ])
    client._client = MagicMock()
    client._client.models.generate_content = mock_gen

    result = client._invoke("test prompt")
    assert result == '{"thought": "ok", "action": "finish"}'
    assert mock_gen.call_count == 2


def test_gemini_repeated_503_exhausts_retry_limit(monkeypatch):
    """Simulate repeated 503 errors that exhaust the bounded retry limit."""
    monkeypatch.setattr("time.sleep", lambda s: None)

    client = LLMClient.__new__(LLMClient)
    client.api_key = "dummy"
    client.model = "gemini-3.7-flash"
    client.max_calls = 10
    client.call_count = 0

    # Always raises 503
    mock_gen = MagicMock(side_effect=DummyError(503, "Persistent overload"))
    client._client = MagicMock()
    client._client.models.generate_content = mock_gen

    with pytest.raises(Exception) as exc_info:
        client._invoke("test prompt")

    assert "Persistent overload" in str(exc_info.value)
    # Verifies bounded retries were executed (4 models * 4 attempts max or stopped)
    assert mock_gen.call_count > 1
    assert mock_gen.call_count <= 16


def test_gemini_permanent_auth_error_fails_immediately(monkeypatch):
    """Simulate invalid API key (401/403) and verify it fails immediately without retrying."""
    sleep_mock = MagicMock()
    monkeypatch.setattr("time.sleep", sleep_mock)

    client = LLMClient.__new__(LLMClient)
    client.api_key = "invalid_key"
    client.model = "gemini-3.7-flash"
    client.max_calls = 10
    client.call_count = 0

    auth_err = DummyError(401, "API_KEY_INVALID: API key not valid. Please pass a valid API key.")
    mock_gen = MagicMock(side_effect=auth_err)
    client._client = MagicMock()
    client._client.models.generate_content = mock_gen

    with pytest.raises(DummyError) as exc_info:
        client._invoke("test prompt")

    assert exc_info.value.code == 401
    # MUST have executed exactly once — zero retries for permanent errors!
    assert mock_gen.call_count == 1
    assert sleep_mock.call_count == 0


def test_gemini_429_rate_limit_fallback(monkeypatch):
    """Simulate 429 quota exhaustion on primary model, falling back to alternate model."""
    monkeypatch.setattr("time.sleep", lambda s: None)

    client = LLMClient.__new__(LLMClient)
    client.api_key = "dummy"
    client.model = "gemini-3.7-flash"
    client.max_calls = 10
    client.call_count = 0

    success_resp = MagicMock()
    success_resp.text = "Success on fallback model"

    # Primary model gemini-3.7-flash raises 429 twice, then next model succeeds
    mock_gen = MagicMock(side_effect=[
        DummyError(429, "RESOURCE_EXHAUSTED: Quota exceeded"),
        DummyError(429, "RESOURCE_EXHAUSTED: Quota exceeded"),
        success_resp
    ])
    client._client = MagicMock()
    client._client.models.generate_content = mock_gen

    result = client._invoke("test prompt")
    assert result == "Success on fallback model"
    assert client.model != "gemini-3.7-flash"  # switched model
