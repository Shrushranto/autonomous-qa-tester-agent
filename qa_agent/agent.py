"""Autonomous QA Agent: LLM client, planning, agent loop, judging, and reproduction."""

from __future__ import annotations

import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Type, TypeVar
from dotenv import load_dotenv
from pydantic import BaseModel, ValidationError

def is_permanent_error(exc: Exception) -> bool:
    """Return True if an error is non-retryable (e.g. 401/403 auth, 400 invalid request)."""
    code = getattr(exc, "code", None)
    if code in (400, 401, 403, 404):
        return True
    err_str = str(exc).lower()
    return any(k in err_str for k in [
        "api_key_invalid", "api key not valid", "permission_denied",
        "unauthenticated", "invalid argument", "not found"
    ])

def extract_retry_after(exc: Exception) -> Optional[float]:
    """Extract Retry-After duration in seconds if present in error message or headers."""
    err_str = str(exc)
    match = re.search(r"retry[-_\s]after[:\s]+(\d+(?:\.\d+)?)", err_str, re.IGNORECASE)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            pass
    return None

def is_transient_error(exc: Exception) -> bool:
    """Return True if an error is temporary and retryable (503, 429, 504, network timeouts)."""
    if is_permanent_error(exc):
        return False
    code = getattr(exc, "code", None)
    if code in (429, 503, 504):
        return True
    err_str = str(exc).lower()
    return any(k in err_str for k in [
        "503", "unavailable", "high demand", "overloaded",
        "429", "resource_exhausted", "quota", "rate limit",
        "504", "deadline_exceeded", "timed out", "timeout", "connection"
    ])

def classify_gemini_error(exc: Exception) -> Tuple[str, str, bool]:
    """Classify exception into (error_code, user_friendly_message, retryable)."""
    code = getattr(exc, "code", None)
    err_str = str(exc).lower()

    if code in (401, 403) or any(k in err_str for k in ["api_key_invalid", "api key not valid", "permission_denied", "unauthenticated"]):
        return (
            "GEMINI_AUTH_ERROR",
            "The AI service configuration is invalid. Please contact the administrator.",
            False
        )
    if code == 429 or any(k in err_str for k in ["429", "resource_exhausted", "quota", "rate limit"]):
        return (
            "GEMINI_RATE_LIMITED",
            "The AI request limit has been reached. Please wait before starting another test.",
            True
        )
    if code == 504 or any(k in err_str for k in ["504", "deadline_exceeded", "timed out", "timeout"]):
        return (
            "GEMINI_TIMEOUT",
            "The AI request timed out. Please try again.",
            True
        )
    if code == 503 or any(k in err_str for k in ["503", "unavailable", "high demand", "overloaded"]):
        return (
            "GEMINI_UNAVAILABLE",
            "The AI model is temporarily overloaded. The agent retried the request but could not complete it. Please try again shortly.",
            True
        )

    return (
        "AGENT_EXECUTION_FAILED",
        f"The test agent stopped unexpectedly. No complete report was generated.",
        True
    )

from qa_agent.browser import BrowserController
from qa_agent.models import (
    AgentAction,
    BugFinding,
    PageSnapshot,
    RecordedAction,
    SpecRule,
    SpecUnderstanding,
    TestCase,
    TestPlan,
    TestResult,
)

load_dotenv()

T = TypeVar("T", bound=BaseModel)

DEFAULT_MODEL = "gemini-3.1-flash-lite"
DEFAULT_MAX_CALLS = 60
MAX_ACTIONS_PER_TEST = 10


def clean_json_text(text: str) -> str:
    """Strip markdown code fences and extraneous text surrounding JSON."""
    text = text.strip()
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        text = match.group(1).strip()
    return text


class LLMClient:
    """Robust LLM client with Pydantic validation, call capping, and one corrective retry."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        max_calls: Optional[int] = None,
    ):
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        if not self.api_key or not self.api_key.strip():
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Please add it to your .env file or environment variables."
            )

        self.model = model or os.environ.get("LLM_MODEL") or DEFAULT_MODEL
        env_max = os.environ.get("MAX_LLM_CALLS")
        self.max_calls = max_calls if max_calls is not None else (int(env_max) if env_max else DEFAULT_MAX_CALLS)
        self.call_count = 0

        # Lazy import so tests can mock or import without requiring google-genai
        from google import genai
        self._client = genai.Client(api_key=self.api_key)

    def _invoke(self, prompt: str, system_instruction: Optional[str] = None) -> str:
        """Execute a raw model call with transient retry and fallback, enforcing the call budget."""
        if self.call_count >= self.max_calls:
            raise RuntimeError(
                f"LLM call budget exceeded: reached {self.call_count} of max {self.max_calls} allowed calls."
            )

        self.call_count += 1

        contents = prompt
        if system_instruction:
            contents = f"{system_instruction}\n\n{prompt}"

        # Fallback models in case of quota exhaustion
        fallback_models = [self.model, "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
        seen_models = set()
        last_error = None
        max_retries_per_model = 3
        base_delay = 1.0
        max_delay = 8.0

        for current_model in fallback_models:
            if current_model in seen_models:
                continue
            seen_models.add(current_model)

            for attempt in range(max_retries_per_model + 1):
                try:
                    response = self._client.models.generate_content(
                        model=current_model,
                        contents=contents,
                    )
                    self.model = current_model
                    return response.text or ""
                except Exception as e:
                    last_error = e
                    # Permanent errors (auth, bad request) fail immediately without retry
                    if is_permanent_error(e):
                        raise e

                    # Non-transient errors fail immediately
                    if not is_transient_error(e):
                        raise e

                    err_str = str(e).lower()

                    # On quota exhaustion (429), if we have other models, break to try fallback model
                    if ("429" in err_str or "resource_exhausted" in err_str) and len(seen_models) < len(fallback_models):
                        break

                    # If this model has exhausted its retries, break to fallback or raise
                    if attempt >= max_retries_per_model:
                        break

                    retry_after = extract_retry_after(e)
                    if retry_after is not None:
                        sleep_time = min(retry_after, max_delay)
                    else:
                        sleep_time = min(base_delay * (2 ** attempt) + random.uniform(0.1, 0.4), max_delay)

                    print(f"  [WARN] Gemini transient failure on {current_model}. Retrying in {sleep_time:.1f}s (attempt {attempt + 1}/{max_retries_per_model})...")
                    time.sleep(sleep_time)

        raise last_error or RuntimeError("Model invocation failed after fallback attempts")

    def generate_structured(
        self,
        prompt: str,
        response_model: Type[T],
        system_instruction: Optional[str] = None,
    ) -> T:
        """Generate structured output validated against a Pydantic model with 1 corrective retry."""
        schema_json = json.dumps(response_model.model_json_schema(), indent=2)
        full_prompt = (
            f"{prompt}\n\n"
            f"Respond with a single JSON object that strictly adheres to this JSON Schema:\n"
            f"{schema_json}\n"
            f"Output raw valid JSON only. Do not wrap in commentary or markdown if possible."
        )

        raw_text = self._invoke(full_prompt, system_instruction=system_instruction)
        cleaned = clean_json_text(raw_text)

        try:
            return response_model.model_validate_json(cleaned)
        except (ValidationError, json.JSONDecodeError) as err:
            # Stage 4 Requirement: Exactly one corrective retry after malformed output
            retry_prompt = (
                f"Your previous output could not be parsed or failed schema validation.\n"
                f"Error: {err}\n\n"
                f"Previous output was:\n{raw_text}\n\n"
                f"Expected JSON Schema:\n{schema_json}\n\n"
                f"Please correct the error and output ONLY the valid JSON object adhering strictly to the schema."
            )
            retry_raw = self._invoke(retry_prompt, system_instruction=system_instruction)
            retry_cleaned = clean_json_text(retry_raw)
            try:
                return response_model.model_validate_json(retry_cleaned)
            except Exception as final_err:
                raise ValueError(
                    f"LLM structured output failed validation after corrective retry: {final_err}\n"
                    f"Raw response: {retry_raw}"
                ) from final_err


# --- Stage 5: Spec Understanding and Test Planning ---

def understand_spec(spec_text: str, client: LLMClient) -> SpecUnderstanding:
    """Analyze the specification to extract testable rules and identify ambiguity."""
    prompt = f"""You are an autonomous QA tester agent.
Read the specification below and extract explicit, testable rules.
Each rule must have:
- id: unique rule ID matching the spec (e.g. R1, R3, R4, R5)
- description: concise summary
- expected_behavior: clear description of expected behavior
- how_verified: how the behavior can be validated

IMPORTANT:
- Never invent requirements not in the specification.
- If an important requirement is ambiguous or unspecified, formulate ONE concise clarification question in 'ambiguity_question'.
  (For example, if the maximum quantity per item is not specified, ask what the maximum quantity per item should be).
- If nothing important is ambiguous, set 'ambiguity_question' to null.

SPECIFICATION:
{spec_text}
"""
    return client.generate_structured(prompt, SpecUnderstanding)


def resolve_clarification(
    question: Optional[str],
    answers_path: Optional[str] = None,
    interactive: bool = True,
) -> Optional[str]:
    """Resolve the clarification question non-interactively from answers file or via CLI input."""
    if not question:
        return None

    # Try non-interactive resolution via answers JSON
    if answers_path and os.path.isfile(answers_path):
        try:
            with open(answers_path, "r", encoding="utf-8") as f:
                answers_dict = json.load(f)
            _STOPWORDS = {"the", "a", "an", "is", "are", "in", "of", "to", "per", "for",
                          "what", "how", "can", "you", "be", "it", "this", "that"}

            def _keywords(text: str) -> set:
                return {w for w in re.findall(r"[a-z]+", text.lower())
                        if len(w) >= 3 and w not in _STOPWORDS}

            q_kw = _keywords(question)
            for k, v in answers_dict.items():
                k_kw = _keywords(k)
                # Exact substring match or significant keyword overlap (>= 2 shared keywords)
                if k.lower() in question.lower() or question.lower() in k.lower():
                    return str(v)
                if len(q_kw & k_kw) >= 2:
                    return str(v)
        except Exception as e:
            print(f"Warning: Could not read answers file '{answers_path}': {e}")

    # Fallback to interactive CLI prompt if enabled
    if interactive:
        try:
            print(f"\n[Agent Clarification Question]: {question}")
            user_input = input("Your answer (or press Enter to skip): ").strip()
            return user_input if user_input else None
        except (EOFError, KeyboardInterrupt):
            return None

    return None


def generate_test_plan(
    understanding: SpecUnderstanding,
    clarification_question: Optional[str] = None,
    clarification_answer: Optional[str] = None,
    client: Optional[LLMClient] = None,
) -> TestPlan:
    """Generate between 1 and 6 test cases covering all extracted rules."""
    if client is None:
        client = LLMClient()

    rules_summary = "\n".join(
        f"- {r.id}: {r.description} (Expected: {r.expected_behavior})"
        for r in understanding.rules
    )

    clarification_context = ""
    if clarification_question and clarification_answer:
        clarification_context = (
            f"User Clarification:\n"
            f"Q: {clarification_question}\n"
            f"A: {clarification_answer}\n"
        )

    prompt = f"""You are an autonomous QA tester agent.
Generate a test plan with at least 1 and at most 6 test cases covering every specification rule at least once.
Include normal, boundary, or negative cases when justified by the specification.

Specification Rules:
{rules_summary}

{clarification_context}
Each test case must have:
- id: e.g. T1, T2, T3...
- rule_id: the rule ID it validates (e.g. R1, R3, R4, R5)
- objective: short test objective
- initial_conditions: starting state (e.g. Clean cart on home page)
- expected_outcome: expected result according to specification
- goal: actionable goal for browser interaction
"""
    plan = client.generate_structured(prompt, TestPlan)

    # Ensure bounds: 1 to 6 cases
    if len(plan.test_cases) > 6:
        plan.test_cases = plan.test_cases[:6]

    return plan


def save_test_plan(plan: TestPlan, output_path: str = "reports/test_plan.json") -> str:
    """Save the test plan to reports/test_plan.json."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(plan.model_dump_json(indent=2))
    return output_path


# --- Stage 6: Bounded Agent Loop with run_log.jsonl ---

def append_run_log(entry: Dict[str, Any], path: str = "reports/run_log.jsonl") -> None:
    """Append a decision trace entry to run_log.jsonl."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def run_test_case(
    test_case: TestCase,
    rule: SpecRule,
    browser: BrowserController,
    client: LLMClient,
    run_log_path: str = "reports/run_log.jsonl",
    max_actions: int = MAX_ACTIONS_PER_TEST,
    clarification_context: Optional[str] = None,
) -> List[RecordedAction]:
    """Execute a single test case using the bounded autonomous agent loop."""
    recorded_steps: List[RecordedAction] = []
    recent_signatures: List[str] = []
    previous_result = "Test initialized."

    for step_num in range(1, max_actions + 1):
        snapshot = browser.take_snapshot()

        history_summary = "\n".join(
            f"Step {s.step}: {s.action} on {s.target_locator or s.url or ''} -> {s.result or ''}"
            for s in recorded_steps[-4:]
        ) or "None (starting first step)"

        clarification_note = (
            f"\nClarification note: {clarification_context}" if clarification_context else ""
        )

        prompt = f"""You are an autonomous QA tester agent executing a test in the browser.
Choose the NEXT browser action based on your CURRENT observation.

CURRENT TEST CASE:
- ID: {test_case.id}
- Rule: {rule.id} ({rule.description})
- Objective: {test_case.objective}
- Expected Outcome: {test_case.expected_outcome}
- Goal: {test_case.goal}
{clarification_note}

RECENT ACTION HISTORY:
{history_summary}
Previous Result: {previous_result}

CURRENT PAGE SNAPSHOT:
Page URL: {snapshot.url}
Page Title: {snapshot.title}
Interactive Elements:
{snapshot.formatted_text()}

INSTRUCTIONS:
1. Provide a short 'thought' explaining WHY you chose this action.
2. 'action' must be one of: click, fill, select, press, goto, finish.
3. For element actions (click, fill, select, press), set 'target' to the element number (e.g. 4 or "[4]") from the snapshot.
4. When the test objective is achieved or an expected error/result is observed, choose action 'finish'.
5. Only navigate using localhost relative paths (e.g. '/cart.html', '/').
"""
        action = client.generate_structured(prompt, AgentAction)

        # Loop Detection: Detect if identical action signature is repeated 3 times without progress
        sig = f"{action.action}:{action.target}:{action.value}:{snapshot.page_text}"
        recent_signatures.append(sig)
        if len(recent_signatures) >= 3 and len(set(recent_signatures[-3:])) == 1:
            log_entry = {
                "test_id": test_case.id,
                "step": step_num,
                "observation": snapshot.page_text or snapshot.title,
                "action": "finish",
                "target": None,
                "thought": "Loop detected: same state revisited without progress. Stopping test.",
                "result": "Stopped by loop detector",
                "timestamp": time.time(),
            }
            append_run_log(log_entry, run_log_path)
            break

        # Check for finish action
        if action.action == "finish":
            rec = RecordedAction(
                step=step_num,
                thought=action.thought,
                action="finish",
                result="Test finished by agent",
            )
            recorded_steps.append(rec)
            log_entry = {
                "test_id": test_case.id,
                "step": step_num,
                "observation": snapshot.page_text or snapshot.title,
                "action": "finish",
                "target": None,
                "thought": action.thought,
                "result": rec.result,
                "timestamp": time.time(),
            }
            append_run_log(log_entry, run_log_path)
            break

        # Execute the action via BrowserController
        try:
            rec, result_msg = browser.execute_action(action, snapshot, step_number=step_num)
            recorded_steps.append(rec)
            previous_result = result_msg
        except Exception as exec_err:
            result_msg = f"Action error: {exec_err}"
            rec = RecordedAction(
                step=step_num,
                thought=action.thought,
                action=action.action,
                result=result_msg,
            )
            recorded_steps.append(rec)
            previous_result = result_msg

        # Record decision trace to run_log.jsonl
        log_entry = {
            "test_id": test_case.id,
            "step": step_num,
            "observation": snapshot.page_text or snapshot.title,
            "action": action.action,
            "target": str(action.target) if action.target is not None else None,
            "target_locator": rec.target_locator,
            "thought": action.thought,
            "result": result_msg,
            "timestamp": time.time(),
        }
        append_run_log(log_entry, run_log_path)

    return recorded_steps


# --- Stage 7: Deterministic Checks (app_checks), Judging, and Independent Reproduction ---

def reset_app_state(base_url: str) -> None:
    """Clear all application state on the demo server via POST /__reset."""
    url = f"{base_url.rstrip('/')}/__reset"
    req = urllib.request.Request(url, data=b"", headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            pass
    except Exception as e:
        print(f"Warning: Failed to reset server state at {url}: {e}")


def get_app_state(base_url: str) -> Dict[str, Any]:
    """Fetch raw server state from GET /__state for deterministic verification."""
    url = f"{base_url.rstrip('/')}/__state"
    try:
        with urllib.request.urlopen(url) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"Warning: Failed to fetch state from {url}: {e}")
        return {}


def app_checks(base_url: str, snapshot: Optional[PageSnapshot] = None) -> List[Dict[str, Any]]:
    """Single centralized function executing deterministic application checks against /__state."""
    violations: List[Dict[str, Any]] = []
    state = get_app_state(base_url)
    if not state:
        return violations

    cart = state.get("cart", [])
    applied_coupons = state.get("appliedCoupons", [])
    registered_emails = state.get("registeredEmails", [])
    server_total = state.get("total", 0)

    # 1. Check R1: Quantity must be a positive integer
    for item in cart:
        qty = item.get("quantity")
        if qty is not None and (not isinstance(qty, int) or qty < 1):
            violations.append({
                "rule_id": "R1",
                "title": "Invalid or negative quantity accepted in cart",
                "expected": "Quantity must be a positive integer (>= 1)",
                "actual": f"Cart accepted item '{item.get('name')}' with quantity {qty}",
            })

    # 2. Check R3: A coupon applies only once per order
    if len(applied_coupons) > 1:
        violations.append({
            "rule_id": "R3",
            "title": "Coupon applied multiple times to same order",
            "expected": "Coupon discount must apply only once per order",
            "actual": f"Coupon applied {len(applied_coupons)} times: {applied_coupons}",
        })

    # 3. Check R4: Cart total equals sum(price * qty) minus valid coupon discount
    computed_subtotal = sum(item.get("price", 0) * item.get("quantity", 0) for item in cart)
    # At most 1 coupon discount of 10% under valid rules
    coupon_count = 1 if len(applied_coupons) >= 1 else 0
    computed_discount = computed_subtotal * 0.1 * coupon_count
    expected_total = computed_subtotal - computed_discount

    if server_total != expected_total:
        violations.append({
            "rule_id": "R4",
            "title": "Cart total calculation mismatch",
            "expected": f"Cart total should equal sum of items minus discount: Rs {expected_total}",
            "actual": f"Displayed/server total is Rs {server_total}",
        })

    # 4. Check R5: Signup requires a valid email
    for email in registered_emails:
        if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(email)):
            violations.append({
                "rule_id": "R5",
                "title": "Invalid email address accepted during registration",
                "expected": "Registration must reject invalid email formats",
                "actual": f"Server registered invalid email address: '{email}'",
            })

    return violations


def judge_finding(
    test_case: TestCase,
    rule: SpecRule,
    steps: List[RecordedAction],
    base_url: str,
    snapshot: Optional[PageSnapshot] = None,
) -> Optional[BugFinding]:
    """Deterministically judge whether a test revealed a specification violation."""
    violations = app_checks(base_url, snapshot)
    if not violations:
        return None

    # Pick the violation relevant to this test case's rule ID
    matched = next((v for v in violations if v["rule_id"] == rule.id), None)
    if not matched:
        # If another violation was triggered during this test
        matched = violations[0]

    return BugFinding(
        test_id=test_case.id,
        rule_id=matched["rule_id"],
        title=matched["title"],
        status="inconclusive",  # Needs independent reproduction before confirmation
        steps=steps,
        expected=matched["expected"],
        actual=matched["actual"],
        replays="0/2",
    )


def reproduce_bug(
    finding: BugFinding,
    browser: BrowserController,
    base_url: str,
) -> BugFinding:
    """Independently reproduce a suspected bug using 2 deterministic replays with reset state."""
    replays_passed = 0

    for attempt in range(1, 3):
        # 1. Reset state
        reset_app_state(base_url)
        # 2. Fresh browser context
        browser.new_context()

        # 3. Deterministic replay without LLM
        ok = browser.replay_actions(finding.steps)
        if not ok:
            continue

        # 4. Re-check deterministic application rules
        snap = browser.take_snapshot()
        violations = app_checks(base_url, snap)
        if any(v["rule_id"] == finding.rule_id for v in violations):
            replays_passed += 1

    finding.replays = f"{replays_passed}/2"

    if replays_passed == 2:
        finding.status = "confirmed"
        # Capture evidence screenshot
        os.makedirs("reports", exist_ok=True)
        shot_path = f"reports/bug_{finding.rule_id.lower()}.png"
        try:
            browser.capture_screenshot(shot_path)
            finding.screenshot_path = shot_path
        except Exception:
            pass
    elif replays_passed == 0:
        finding.status = "not_reproduced"
    else:
        finding.status = "inconclusive"

    return finding


# --- Stage 8: Generate Markdown Bug Report ---

def _sanitize_table_cell(text: Optional[str]) -> str:
    """Format string for clean markdown table rendering without breaking columns."""
    if text is None:
        return ""
    cleaned = " ".join(str(text).split())
    cleaned = cleaned.replace("|", "\\|")
    return cleaned


def _format_status_label(status: str) -> str:
    """Return clean human-readable status label."""
    mapping = {
        "passed": "Passed",
        "confirmed_bug": "Confirmed Bug",
        "inconclusive": "Inconclusive",
        "not_reproduced": "Not Reproduced",
        "failed": "Failed",
        "unable_to_complete": "Unable to Complete",
    }
    return mapping.get(status, status.replace("_", " ").title())


def _format_outcome_or_error(r: TestResult) -> str:
    """Format observed outcome or error details for table display."""
    if r.status == "unable_to_complete":
        if r.error_message and r.error_message.strip():
            msg = r.error_message.strip()
            if r.error_type and r.error_type not in msg:
                return _sanitize_table_cell(f"{r.error_type}: {msg}")
            return _sanitize_table_cell(msg)
        elif r.error_type and r.error_type.strip():
            return _sanitize_table_cell(r.error_type.strip())
        elif r.observed and r.observed.strip() and not r.observed.strip().lower().startswith("execution halted: none"):
            return _sanitize_table_cell(r.observed.strip())
        return "Execution halted (reason not recorded)"
    elif r.status == "confirmed_bug":
        replays = r.reproduction_status or (r.finding.replays if r.finding else "2/2")
        desc = r.observed or (r.finding.actual if r.finding else "Violation confirmed")
        return _sanitize_table_cell(f"Confirmed violation ({replays} replays): {desc}")
    elif r.status == "inconclusive":
        replays = r.reproduction_status or (r.finding.replays if r.finding else "1/2")
        desc = r.observed or (r.finding.actual if r.finding else "Inconclusive finding")
        return _sanitize_table_cell(f"Inconclusive ({replays} replays): {desc}")
    elif r.status == "not_reproduced":
        replays = r.reproduction_status or (r.finding.replays if r.finding else "0/2")
        desc = r.observed or (r.finding.actual if r.finding else "Violation did not reproduce")
        return _sanitize_table_cell(f"Not reproduced ({replays} replays): {desc}")
    elif r.status == "failed":
        return _sanitize_table_cell(r.observed or "Assertion failed")
    elif r.status == "passed":
        return _sanitize_table_cell(r.observed or "Specification satisfied; no violation detected")
    return _sanitize_table_cell(r.observed or "")


def generate_markdown_report(
    summary: Dict[str, Any],
    confirmed_bugs: List[BugFinding],
    inconclusive_findings: List[BugFinding],
    clarifications: Optional[List[Dict[str, str]]] = None,
    output_path: str = "reports/bug_report.md",
    test_results: Optional[List[TestResult]] = None,
) -> str:
    """Write comprehensive Markdown bug report including every attempted test case."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    lines: List[str] = []

    # If test_results was not passed, synthesize it for backwards compatibility
    if test_results is None:
        test_results = []
        for b in confirmed_bugs:
            test_results.append(
                TestResult(
                    test_id=b.test_id,
                    rule_id=b.rule_id,
                    objective=b.title,
                    status="confirmed_bug",
                    execution_status="completed",
                    finding_status="confirmed",
                    expected=b.expected,
                    observed=b.actual,
                    finding=b,
                    reproduction_status=b.replays,
                    screenshot_path=b.screenshot_path,
                )
            )
        for inc in inconclusive_findings:
            test_results.append(
                TestResult(
                    test_id=inc.test_id,
                    rule_id=inc.rule_id,
                    objective=inc.title,
                    status="inconclusive",
                    execution_status="completed",
                    finding_status="inconclusive",
                    expected=inc.expected,
                    observed=inc.actual,
                    finding=inc,
                    reproduction_status=inc.replays,
                    screenshot_path=inc.screenshot_path,
                )
            )
        passed_count = summary.get("tests_passed", 0)
        for i in range(passed_count):
            test_results.append(
                TestResult(
                    test_id=f"T_pass_{i+1}",
                    rule_id="Unknown",
                    objective="Specification verification",
                    status="passed",
                    execution_status="completed",
                    observed="Specification satisfied; no violation detected",
                )
            )
        incomplete_count = summary.get("tests_failed_to_complete", summary.get("tests_unable_to_complete", 0))
        for i in range(incomplete_count):
            test_results.append(
                TestResult(
                    test_id=f"T_inc_{i+1}",
                    rule_id="Unknown",
                    objective="Specification verification",
                    status="unable_to_complete",
                    execution_status="unable_to_complete",
                    observed="Execution halted (reason not recorded)",
                    error_message=None,
                )
            )

    # Calculate exact counts agreeing with individual test records
    tests_attempted = len(test_results)
    tests_passed = sum(1 for r in test_results if r.status == "passed")
    tests_failed = sum(1 for r in test_results if r.status in ("failed", "not_reproduced"))
    confirmed_count = sum(1 for r in test_results if r.status == "confirmed_bug")
    inconclusive_count = sum(1 for r in test_results if r.status == "inconclusive")
    tests_unable = sum(1 for r in test_results if r.status == "unable_to_complete")

    lines.append("# Autonomous QA Tester Agent — Bug Report\n")
    lines.append(f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ")
    lines.append(f"**Target URL:** {summary.get('target_url', 'http://localhost:3000')}  ")
    lines.append(f"**Planted BUGS Configuration:** `{summary.get('bugs_config', 'default')}`\n")

    # 1. Executive Summary Table
    lines.append("## 1. Executive Summary\n")
    lines.append("| Metric | Count |")
    lines.append("|---|---|")
    lines.append(f"| **Tests Attempted** | {tests_attempted} |")
    lines.append(f"| **Tests Passed** | {tests_passed} |")
    lines.append(f"| **Tests Failed** | {tests_failed} |")
    lines.append(f"| **Confirmed Bugs** (2/2 Independent Replays) | {confirmed_count} |")
    lines.append(f"| **Inconclusive Findings** | {inconclusive_count} |")
    lines.append(f"| **Tests Unable to Complete** | {tests_unable} |\n")

    # 2. Test Execution Details Table
    lines.append("## 2. Test Execution Details\n")
    lines.append("The table below details all attempted test cases, including passes, specification violations, inconclusive findings, and execution errors:\n")
    lines.append("| Test ID | Rule ID | Test Objective | Status | Observed Outcome / Error |")
    lines.append("|---|---|---|---|---|")
    for r in test_results:
        tid = _sanitize_table_cell(r.test_id)
        rid = _sanitize_table_cell(r.rule_id)
        obj = _sanitize_table_cell(r.objective)
        stat = _sanitize_table_cell(_format_status_label(r.status))
        outcome = _format_outcome_or_error(r)
        lines.append(f"| {tid} | {rid} | {obj} | {stat} | {outcome} |")
    lines.append("")

    # 3. Clarification Questions
    if clarifications:
        lines.append("## 3. Clarification Questions & Answers Used\n")
        lines.append("Before test execution, the agent analyzed the specification for ambiguities and resolved them:\n")
        for c in clarifications:
            lines.append(f"- **Question:** {c.get('question')}")
            lines.append(f"  - **Answer Used:** `{c.get('answer')}` (Source: `{c.get('source', 'answers.json')}`)\n")

    # 4. Confirmed Bugs
    lines.append("## 4. Confirmed Bugs\n")
    if not confirmed_bugs:
        lines.append("No bugs were confirmed. All tested specifications passed verification with zero false positives.\n")
    else:
        for idx, bug in enumerate(confirmed_bugs, 1):
            severity = "High" if bug.rule_id in ("R1", "R4") else "Medium"
            lines.append(f"### Bug #{idx}: [{bug.rule_id}] {bug.title}\n")
            lines.append(f"- **Severity:** **{severity}** (Direct violation of core specification rule {bug.rule_id})")
            lines.append(f"- **Specification Rule:** `{bug.rule_id}`")
            lines.append(f"- **Expected Behavior:** {bug.expected}")
            lines.append(f"- **Actual Observed Result:** {bug.actual}")
            lines.append(f"- **Independent Verification:** `{bug.replays}` (Reproduced in 2 of 2 deterministic replays after state reset without LLM)\n")

            lines.append("#### Steps to Reproduce")
            if bug.steps:
                step_idx = 1
                for s in bug.steps:
                    if s.action in ("finish", "ask_user"):
                        continue
                    target_info = f" on `{s.target_locator}`" if s.target_locator else (f" to `{s.url}`" if s.url else "")
                    value_info = f" with value `\"{s.value}\"`" if s.value is not None else ""
                    lines.append(f"{step_idx}. **{s.action.upper()}**{target_info}{value_info} — *\"{s.thought}\"*")
                    step_idx += 1
            else:
                lines.append("1. Follow test flow for " + bug.test_id)
            lines.append("")

            if bug.screenshot_path and os.path.exists(bug.screenshot_path):
                # Relative link from reports/
                shot_filename = os.path.basename(bug.screenshot_path)
                lines.append(f"#### Screenshot Evidence\n")
                lines.append(f"![{bug.title}]({shot_filename})\n")

    # 5. Inconclusive Findings
    if inconclusive_findings:
        lines.append("## 5. Inconclusive Findings\n")
        for inc in inconclusive_findings:
            lines.append(f"- **[{inc.rule_id}] {inc.title}** (Replays: {inc.replays}) — Could not deterministically reproduce across consecutive attempts.\n")

    # 6. Rules Not Fully Verified
    lines.append("## 6. Rules Not Fully Verified\n")
    confirmed_rules = {b.rule_id for b in confirmed_bugs}
    unverified_records = [
        r for r in test_results
        if r.status in ("unable_to_complete", "inconclusive", "not_reproduced")
        and r.rule_id not in confirmed_rules
    ]

    if unverified_records:
        lines.append("The following specification rules could not be conclusively verified because associated test cases were unable to complete or did not reach a reproducible outcome:\n")
        seen_rules = set()
        for r in unverified_records:
            if r.rule_id not in seen_rules:
                seen_rules.add(r.rule_id)
                reason = r.error_message or r.error_type or r.observed or "Execution halted"
                lines.append(f"- **{r.rule_id}** ({r.objective}): Test `{r.test_id}` resulted in `{_format_status_label(r.status)}` — {_sanitize_table_cell(reason)}")
        lines.append("\n> **Note on Incomplete Tests:** An incomplete test does not establish whether the corresponding specification rule was satisfied or whether a bug exists in the application. It indicates that test execution halted prematurely before conclusive evidence could be gathered.\n")
    else:
        lines.append("All specification rules evaluated in this run reached a conclusive verification result.\n")

    # 7. Known Limitations
    lines.append("## 7. Methodology & Known Limitations\n")
    lines.append("- **Verification Guarantee:** Only violations reproduced in 2/2 independent resets are reported as confirmed bugs. Replays substantially reduce false-positive risk but do not guarantee complete elimination under all environmental conditions.")
    lines.append("- **Action Budget:** Tests are strictly bounded to 10 actions to prevent looping.")
    lines.append("- **Scope:** Single-origin localhost execution only; external networks and third-party integrations are rejected by security design.")
    lines.append("- **Execution Dependencies:** Test execution depends on external LLM availability and quota limits; tests halting due to upstream API errors are categorized as Unable to Complete and are not counted as passes or failures.\n")

    content = "\n".join(lines)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(content)

    return output_path
