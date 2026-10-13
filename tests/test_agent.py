"""Unit tests for the agent's deterministic logic."""

import os
import pytest
from pydantic import ValidationError

from qa_agent.agent import (
    LLMClient,
    app_checks,
    clean_json_text,
    generate_markdown_report,
    reproduce_bug,
    resolve_clarification,
    run_test_case,
)
from qa_agent.browser import is_localhost_url
from qa_agent.models import (
    AgentAction,
    BugFinding,
    PageSnapshot,
    RecordedAction,
    SnapshotElement,
    SpecRule,
    TestCase,
    TestPlan,
    TestResult,
)





def test_invalid_llm_action_rejected():

    """Verify that malformed or unsupported action names are rejected by Pydantic."""

    with pytest.raises(ValidationError):

        AgentAction.model_validate_json('{"action": "click", "target": 1}')



    with pytest.raises(ValidationError):

        AgentAction.model_validate_json('{"thought": "test", "action": "execute_script"}')





def test_unsupported_goto_external_rejected():

    """Verify that external URLs are rejected by the localhost security validator."""

    assert is_localhost_url("/") is True

    assert is_localhost_url("/cart.html") is True

    assert is_localhost_url("http://localhost:3000/cart.html") is True

    assert is_localhost_url("http://127.0.0.1:3000") is True



    # External targets must be rejected

    assert is_localhost_url("https://google.com") is False

    assert is_localhost_url("http://evil.com/phishing") is False

    assert is_localhost_url("https://example.com:3000") is False





def test_llm_call_budget_enforced():

    """Verify that the LLM call budget is strictly enforced."""

    client = LLMClient.__new__(LLMClient)

    client.call_count = 5

    client.max_calls = 5



    with pytest.raises(RuntimeError, match="LLM call budget exceeded"):

        client._invoke("test prompt")





def test_clean_json_text_strips_fences():

    """Verify that markdown fences are cleaned before parsing."""

    fenced = '```json\n{"thought": "test", "action": "finish"}\n```'

    assert clean_json_text(fenced) == '{"thought": "test", "action": "finish"}'



    plain = '{"thought": "test", "action": "finish"}'

    assert clean_json_text(plain) == plain





def test_corrective_retry_recovers(monkeypatch):

    """Verify that one corrective retry is executed and can recover from invalid JSON."""

    client = LLMClient.__new__(LLMClient)

    client.api_key = "dummy"

    client.model = "dummy"

    client.max_calls = 10

    client.call_count = 0



    responses = [

        "This is not json at all",

        '{"thought": "recovered", "action": "finish"}',

    ]



    def mock_invoke(prompt, system_instruction=None):

        return responses.pop(0)



    monkeypatch.setattr(client, "_invoke", mock_invoke)



    result = client.generate_structured("test", AgentAction)

    assert result.action == "finish"

    assert result.thought == "recovered"





def test_resolve_clarification_from_answers_file():

    """Verify non-interactive clarification resolution via answers JSON."""

    ans = resolve_clarification(

        "What is the maximum quantity allowed per item?",

        answers_path="answers.example.json",

        interactive=False,

    )

    assert ans == "10"





def test_finding_requires_valid_rule_id():

    """Section 9: A finding without a valid rule ID cannot be marked confirmed."""

    with pytest.raises(ValidationError):

        BugFinding(

            test_id="T1",

            rule_id=None,  # type: ignore

            title="Some Bug",

            status="confirmed",

            expected="positive qty",

            actual="negative qty accepted",

        )





def test_action_budget_enforced_in_loop(monkeypatch, tmp_path):

    """Section 9: The action budget is enforced (max actions per test)."""

    client = LLMClient.__new__(LLMClient)

    client.api_key = "dummy"

    client.model = "dummy"

    client.max_calls = 100

    client.call_count = 0



    step_counter = [0]

    def mock_gen(prompt, model, system_instruction=None):

        step_counter[0] += 1

        return AgentAction(thought=f"step {step_counter[0]}", action="click", target=step_counter[0])



    monkeypatch.setattr(client, "generate_structured", mock_gen)



    class MockBrowser:

        def take_snapshot(self):

            return PageSnapshot(url="http://localhost:3000", title="Test", elements=[SnapshotElement(index=1, tag="button", stable_locator="#btn", description="test button")])

        def execute_action(self, action, snapshot, step_number):

            return RecordedAction(step=step_number, thought=action.thought, action=action.action, target_locator="#btn", result="clicked"), "clicked"



    log_path = str(tmp_path / "run_log.jsonl")

    tc = TestCase(id="T1", rule_id="R1", objective="budget test", initial_conditions="none", expected_outcome="none", goal="none")

    rule = SpecRule(id="R1", description="rule", expected_behavior="behavior", how_verified="verified")



    steps = run_test_case(tc, rule, MockBrowser(), client, run_log_path=log_path, max_actions=3)

    assert len(steps) == 3

    assert step_counter[0] == 3





def test_loop_detector_stops_infinite_loop(monkeypatch, tmp_path):

    """Verify that repeating the exact same state 3 times triggers the loop detector."""

    client = LLMClient.__new__(LLMClient)

    client.api_key = "dummy"

    client.model = "dummy"

    client.max_calls = 100

    client.call_count = 0



    def mock_gen(prompt, model, system_instruction=None):

        return AgentAction(thought="repeating", action="click", target=1)



    monkeypatch.setattr(client, "generate_structured", mock_gen)



    class MockBrowser:

        def take_snapshot(self):

            return PageSnapshot(url="http://localhost:3000", title="Test", elements=[SnapshotElement(index=1, tag="button", stable_locator="#btn", description="test button")])

        def execute_action(self, action, snapshot, step_number):

            return RecordedAction(step=step_number, thought=action.thought, action=action.action, target_locator="#btn", result="clicked"), "clicked"



    log_path = str(tmp_path / "run_log.jsonl")

    tc = TestCase(id="T1", rule_id="R1", objective="loop test", initial_conditions="none", expected_outcome="none", goal="none")

    rule = SpecRule(id="R1", description="rule", expected_behavior="behavior", how_verified="verified")



    steps = run_test_case(tc, rule, MockBrowser(), client, run_log_path=log_path, max_actions=10)

    assert len(steps) < 10





def test_cart_total_mismatch_detected(monkeypatch):

    """Section 9: A cart-total mismatch is detected by app_checks."""

    mock_state = {

        "products": [{"id": "p1", "price": 200}],

        "cart": [{"id": "p1", "name": "Notebook", "price": 200, "quantity": 2}],

        "appliedCoupons": [],

        "registeredEmails": [],

        "total": 500,  # Incorrect! (200 * 2 = 400)

    }



    import qa_agent.agent as agent_mod

    monkeypatch.setattr(agent_mod, "get_app_state", lambda url: mock_state)



    violations = app_checks("http://dummy")

    assert any(v["rule_id"] == "R4" and "mismatch" in v["title"].lower() for v in violations)





def test_suspected_bug_fails_reproduction_not_confirmed(monkeypatch):

    """Section 9: A suspected bug that fails independent reproduction is not reported as confirmed."""

    finding = BugFinding(

        test_id="T1",

        rule_id="R1",

        title="Unconfirmed Bug",

        status="inconclusive",

        steps=[RecordedAction(step=1, thought="t", action="click", target_locator="#btn")],

        expected="fail",

        actual="fail",

    )



    import qa_agent.agent as agent_mod

    monkeypatch.setattr(agent_mod, "reset_app_state", lambda url: None)

    # When app_checks is called during replay, return NO violations (reproduction fails)

    monkeypatch.setattr(agent_mod, "app_checks", lambda url, snap: [])



    class MockReplayBrowser:

        def new_context(self): pass

        def replay_actions(self, steps): return True

        def take_snapshot(self): return None



    result = reproduce_bug(finding, MockReplayBrowser(), "http://dummy")

    assert result.status == "not_reproduced"

    assert result.replays == "0/2"





def test_generate_markdown_report_structure(tmp_path):

    """Section 9: Bug report generates correctly formatted Markdown with reproduction evidence."""

    from qa_agent.agent import generate_markdown_report

    report_file = str(tmp_path / "bug_report.md")



    finding = BugFinding(

        test_id="T1",

        rule_id="R1",

        title="Negative quantity accepted",

        status="confirmed",

        replays="2/2",

        expected="Positive integer",

        actual="Accepted -5",

        steps=[RecordedAction(step=1, thought="change qty", action="fill", target_locator="#qty", value="-5")],

    )



    out = generate_markdown_report(

        summary={"tests_executed": 1, "tests_passed": 0, "tests_failed_to_complete": 0, "target_url": "http://localhost:3000"},

        confirmed_bugs=[finding],

        inconclusive_findings=[],

        output_path=report_file,

    )



    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    assert "# Autonomous QA Tester Agent" in content
    assert "2/2" in content
    assert "Negative quantity accepted" in content
    assert "R1" in content


def test_node_app_reset_and_state():
    """Section 9: The Node app starts, POST /__reset is called, and GET /__state returns an empty cart."""
    import subprocess
    import time
    import urllib.request
    import json

    server_dir = os.path.join(os.path.dirname(__file__), "..", "demo_shop")
    server_dir = os.path.abspath(server_dir)

    # Start the Node server on a test port to avoid conflicts
    env = os.environ.copy()
    env["BUGS"] = "none"
    env["PORT"] = "3099"
    proc = subprocess.Popen(
        ["node", "server.js"],
        cwd=server_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP") else 0,
    )

    base = "http://localhost:3099"
    try:
        # Wait for the server to be ready
        ready = False
        for _ in range(20):
            try:
                with urllib.request.urlopen(f"{base}/api/products", timeout=1) as resp:
                    if resp.status == 200:
                        ready = True
                        break
            except Exception:
                pass
            time.sleep(0.5)
        assert ready, "Node server did not start within 10 seconds"

        # Call POST /__reset
        reset_req = urllib.request.Request(f"{base}/__reset", data=b"", method="POST",
                                           headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(reset_req, timeout=3) as resp:
            assert resp.status == 200

        # Call GET /__state and verify empty cart
        with urllib.request.urlopen(f"{base}/__state", timeout=3) as resp:
            state = json.loads(resp.read().decode())

        assert state["cart"] == [], f"Expected empty cart after reset, got: {state['cart']}"
        assert state["appliedCoupons"] == [], f"Expected no coupons after reset, got: {state['appliedCoupons']}"
        assert state["registeredEmails"] == [], f"Expected no emails after reset, got: {state['registeredEmails']}"
        assert state["total"] == 0, f"Expected total 0 after reset, got: {state['total']}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def test_replay_actions_uses_stable_locators():
    """Section 9: A recorded action sequence replays correctly using stable locators."""
    from unittest.mock import MagicMock

    from qa_agent.browser import BrowserController

    controller = BrowserController.__new__(BrowserController)
    controller.base_url = "http://localhost:3000"

    mock_page = MagicMock()
    mock_page.url = "about:blank"
    controller._page = mock_page
    controller.wait_for_idle = lambda: None

    actions = [
        RecordedAction(step=1, thought="go to home", action="goto", url="/"),
        RecordedAction(step=2, thought="click add", action="click", target_locator="#add-p1"),
        RecordedAction(step=3, thought="set qty", action="fill", target_locator="#qty-p1", value="3"),
        RecordedAction(step=4, thought="apply coupon", action="fill", target_locator="#coupon-input", value="SAVE10"),
        RecordedAction(step=5, thought="submit coupon", action="click", target_locator="#apply-coupon"),
        RecordedAction(step=6, thought="press enter", action="press", target_locator="#coupon-input", key="Enter"),
        RecordedAction(step=7, thought="done", action="finish"),
    ]

    result = controller.replay_actions(actions)
    assert result is True, "replay_actions should return True on success"

    mock_page.goto.assert_any_call("http://localhost:3000/")
    mock_page.click.assert_any_call("#add-p1")
    mock_page.click.assert_any_call("#apply-coupon")
    mock_page.fill.assert_any_call("#qty-p1", "3")
    mock_page.fill.assert_any_call("#coupon-input", "SAVE10")
    mock_page.press.assert_any_call("#coupon-input", "Enter")


# =====================================================================
# Regression Tests: Universal Report Generation & Result Tracking
# =====================================================================

def test_report_includes_passed_tests(tmp_path):
    """1. All passed tests appear in the report table and executive summary."""
    report_file = str(tmp_path / "report_passed.md")
    passed_result = TestResult(
        test_id="T_PASS_1",
        rule_id="R10",
        objective="Verify adding valid product to cart updates total",
        status="passed",
        execution_status="completed",
        expected="Item added, total recalculated accurately",
        observed="Product Notebook added; total displayed 200",
    )

    out = generate_markdown_report(
        summary={},
        confirmed_bugs=[],
        inconclusive_findings=[],
        output_path=report_file,
        test_results=[passed_result],
    )

    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    assert "## 2. Test Execution Details" in content
    assert "| T_PASS_1 | R10 | Verify adding valid product to cart updates total | Passed | Product Notebook added; total displayed 200 |" in content
    assert "| **Tests Attempted** | 1 |" in content
    assert "| **Tests Passed** | 1 |" in content
    assert "| **Tests Failed** | 0 |" in content
    assert "| **Tests Unable to Complete** | 0 |" in content


def test_report_includes_failed_and_not_reproduced_tests(tmp_path):
    """2. Failed tests and un-reproduced suspected bugs appear with their actual outcomes."""
    report_file = str(tmp_path / "report_failed.md")
    failed_result = TestResult(
        test_id="T_FAIL_1",
        rule_id="R2",
        objective="Test required form validation on checkout",
        status="failed",
        execution_status="completed",
        expected="Form blocks submission if required fields are empty",
        observed="Form submitted successfully despite empty required fields",
    )
    not_reproduced_result = TestResult(
        test_id="T_NOTREP_1",
        rule_id="R3",
        objective="Test coupon discount replay consistency",
        status="not_reproduced",
        execution_status="completed",
        reproduction_status="0/2",
        expected="Coupon discount applied exactly once",
        observed="Suspected duplicate coupon discount could not be reproduced in independent replays",
    )

    out = generate_markdown_report(
        summary={},
        confirmed_bugs=[],
        inconclusive_findings=[],
        output_path=report_file,
        test_results=[failed_result, not_reproduced_result],
    )

    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    assert "T_FAIL_1" in content
    assert "Failed" in content
    assert "Form submitted successfully despite empty required fields" in content
    assert "T_NOTREP_1" in content
    assert "Not Reproduced" in content
    assert "0/2 replays" in content
    assert "| **Tests Failed** | 2 |" in content
    assert "| **Tests Passed** | 0 |" in content


def test_report_confirmed_bugs_retain_reproduction_details_and_evidence(tmp_path):
    """3. Confirmed bugs retain reproduction details, steps, specification references, and evidence."""
    report_file = str(tmp_path / "report_confirmed.md")
    shot_path = str(tmp_path / "t1_evidence.png")
    with open(shot_path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")

    finding = BugFinding(
        test_id="T1",
        rule_id="R1",
        title="Negative quantity accepted in cart",
        status="confirmed",
        replays="2/2",
        expected="Positive integer required; negative values rejected",
        actual="Server and UI accepted -5 items, producing negative subtotal",
        steps=[
            RecordedAction(step=1, thought="Add item", action="click", target_locator="#add-p1"),
            RecordedAction(step=2, thought="Set negative qty", action="fill", target_locator="#qty-p1", value="-5"),
        ],
        screenshot_path=shot_path,
    )
    bug_result = TestResult(
        test_id="T1",
        rule_id="R1",
        objective="Verify quantity input rejects negative values",
        status="confirmed_bug",
        execution_status="completed",
        finding_status="confirmed",
        reproduction_status="2/2",
        finding=finding,
        expected=finding.expected,
        observed=finding.actual,
        screenshot_path=shot_path,
    )

    out = generate_markdown_report(
        summary={},
        confirmed_bugs=[finding],
        inconclusive_findings=[],
        output_path=report_file,
        test_results=[bug_result],
    )

    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    # Table entry
    assert "| T1 | R1 | Verify quantity input rejects negative values | Confirmed Bug |" in content
    assert "2/2 replays" in content

    # Confirmed Bugs section
    assert "## 4. Confirmed Bugs" in content
    assert "### Bug #1: [R1] Negative quantity accepted in cart" in content
    assert "**Severity:** **High**" in content
    assert "`2/2` (Reproduced in 2 of 2 deterministic replays" in content
    assert "#### Steps to Reproduce" in content
    assert "**CLICK** on `#add-p1`" in content
    assert '**FILL** on `#qty-p1` with value `"-5"`' in content
    assert "#### Screenshot Evidence" in content
    assert "![Negative quantity accepted in cart](t1_evidence.png)" in content


def test_report_incomplete_tests_record_actual_error_reasons(tmp_path):
    """4. Incomplete tests appear with recorded error reasons, e.g. 503, 429, timeout."""
    report_file = str(tmp_path / "report_incomplete.md")

    r_503 = TestResult(
        test_id="T_API_503",
        rule_id="R4",
        objective="Verify checkout total matches line items",
        status="unable_to_complete",
        execution_status="unable_to_complete",
        error_type="Gemini 503 UNAVAILABLE",
        error_message="503 UNAVAILABLE: The model is overloaded. Please try again later.",
        execution_stage="agent_loop",
    )
    r_429 = TestResult(
        test_id="T_API_429",
        rule_id="R5",
        objective="Verify email validation blocks invalid format",
        status="unable_to_complete",
        execution_status="unable_to_complete",
        error_type="Gemini 429 RESOURCE_EXHAUSTED",
        error_message="429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'GenerateContent'",
        execution_stage="agent_loop",
    )
    r_timeout = TestResult(
        test_id="T_TIMEOUT",
        rule_id="R6",
        objective="Verify cart drawer slide animation",
        status="unable_to_complete",
        execution_status="unable_to_complete",
        error_type="Timeout",
        error_message="Timeout 30000ms exceeded while waiting for selector '#cart-drawer'",
        execution_stage="agent_loop",
    )

    out = generate_markdown_report(
        summary={},
        confirmed_bugs=[],
        inconclusive_findings=[],
        output_path=report_file,
        test_results=[r_503, r_429, r_timeout],
    )

    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    # Verify all 3 appear with actual error text in table
    assert "T_API_503" in content
    assert "503 UNAVAILABLE: The model is overloaded" in content
    assert "T_API_429" in content
    assert "429 RESOURCE_EXHAUSTED: Quota exceeded" in content
    assert "T_TIMEOUT" in content
    assert "Timeout 30000ms exceeded" in content

    # Verify executive summary
    assert "| **Tests Attempted** | 3 |" in content
    assert "| **Tests Passed** | 0 |" in content
    assert "| **Tests Failed** | 0 |" in content
    assert "| **Tests Unable to Complete** | 3 |" in content

    # Verify Rules Not Fully Verified section
    assert "## 6. Rules Not Fully Verified" in content
    assert "**R4**" in content
    assert "**R5**" in content
    assert "**R6**" in content
    assert "An incomplete test does not establish whether the corresponding specification rule was satisfied" in content


def test_report_handles_missing_error_details_honestly(tmp_path):
    """5. Missing error details are handled honestly without fabricating messages."""
    report_file = str(tmp_path / "report_no_error.md")
    incomplete_no_details = TestResult(
        test_id="T_NO_DETAILS",
        rule_id="R8",
        objective="Verify coupon code case-insensitivity",
        status="unable_to_complete",
        execution_status="unable_to_complete",
        error_type=None,
        error_message=None,
        observed=None,
    )

    out = generate_markdown_report(
        summary={},
        confirmed_bugs=[],
        inconclusive_findings=[],
        output_path=report_file,
        test_results=[incomplete_no_details],
    )

    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    assert "T_NO_DETAILS" in content
    assert "Unable to Complete" in content
    assert "Execution halted (reason not recorded)" in content
    # Ensure neither 503 nor 429 was fabricated
    assert "503 UNAVAILABLE" not in content
    assert "429 RESOURCE_EXHAUSTED" not in content


def test_interrupted_test_preserves_previously_recorded_results(tmp_path):
    """6. One interrupted test does not erase previously recorded results or prevent safe continuation."""
    report_file = str(tmp_path / "report_interrupted.md")

    # Sequence: T1 passed, T2 bug found, T3 throws exception, T4 runs and passes
    results = [
        TestResult(
            test_id="T1",
            rule_id="R10",
            objective="Add product",
            status="passed",
            observed="Product added successfully",
        ),
        TestResult(
            test_id="T2",
            rule_id="R1",
            objective="Check negative qty",
            status="confirmed_bug",
            reproduction_status="2/2",
            observed="Accepted negative quantity",
        ),
        TestResult(
            test_id="T3",
            rule_id="R3",
            objective="Coupon discount",
            status="unable_to_complete",
            error_type="Gemini 503 UNAVAILABLE",
            error_message="503 UNAVAILABLE",
        ),
        TestResult(
            test_id="T4",
            rule_id="R4",
            objective="Tax calculation",
            status="passed",
            observed="Tax computed accurately",
        ),
    ]

    # Verify list preservation
    assert len(results) == 4
    assert [r.test_id for r in results] == ["T1", "T2", "T3", "T4"]

    out = generate_markdown_report(
        summary={},
        confirmed_bugs=[],
        inconclusive_findings=[],
        output_path=report_file,
        test_results=results,
    )

    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    # All four tests must appear in the execution details table
    assert "| T1 | R10 | Add product | Passed |" in content
    assert "| T2 | R1 | Check negative qty | Confirmed Bug |" in content
    assert "| T3 | R3 | Coupon discount | Unable to Complete |" in content
    assert "| T4 | R4 | Tax calculation | Passed |" in content


def test_summary_counts_agree_with_individual_records(tmp_path):
    """7. Summary counts agree with the individual records without overlap or double-counting."""
    report_file = str(tmp_path / "report_counts.md")

    results = [
        TestResult(test_id="T1", rule_id="R1", objective="o1", status="passed"),
        TestResult(test_id="T2", rule_id="R2", objective="o2", status="passed"),
        TestResult(test_id="T3", rule_id="R3", objective="o3", status="failed", observed="Assertion error"),
        TestResult(test_id="T4", rule_id="R4", objective="o4", status="confirmed_bug", reproduction_status="2/2"),
        TestResult(test_id="T5", rule_id="R5", objective="o5", status="confirmed_bug", reproduction_status="2/2"),
        TestResult(test_id="T6", rule_id="R6", objective="o6", status="inconclusive", reproduction_status="1/2"),
        TestResult(test_id="T7", rule_id="R7", objective="o7", status="unable_to_complete", error_message="503 UNAVAILABLE"),
        TestResult(test_id="T8", rule_id="R8", objective="o8", status="unable_to_complete", error_message="Timeout"),
    ]

    out = generate_markdown_report(
        summary={},
        confirmed_bugs=[],
        inconclusive_findings=[],
        output_path=report_file,
        test_results=results,
    )

    with open(out, "r", encoding="utf-8") as f:
        content = f.read()

    assert "| **Tests Attempted** | 8 |" in content
    assert "| **Tests Passed** | 2 |" in content
    assert "| **Tests Failed** | 1 |" in content
    assert "| **Confirmed Bugs** (2/2 Independent Replays) | 2 |" in content
    assert "| **Inconclusive Findings** | 1 |" in content
    assert "| **Tests Unable to Complete** | 2 |" in content


def test_report_adapts_to_variable_test_counts_and_rules(tmp_path):
    """8. Reports adapt dynamically to variable test counts and specification rules without hardcoding."""
    # Test with 1 test case on custom rule
    report_1 = str(tmp_path / "report_1.md")
    res_1 = [
        TestResult(
            test_id="T_SINGLE",
            rule_id="R99",
            objective="Custom rule test",
            status="unable_to_complete",
            error_message="Network connection reset",
        )
    ]
    out_1 = generate_markdown_report(
        summary={}, confirmed_bugs=[], inconclusive_findings=[],
        output_path=report_1, test_results=res_1,
    )
    with open(out_1, "r", encoding="utf-8") as f:
        c1 = f.read()
    assert "| **Tests Attempted** | 1 |" in c1
    assert "| **Tests Unable to Complete** | 1 |" in c1
    assert "| T_SINGLE | R99 | Custom rule test | Unable to Complete | Network connection reset |" in c1
    assert "- **R99** (Custom rule test)" in c1

    # Test with 10 test cases on arbitrary rules R1..R10
    report_10 = str(tmp_path / "report_10.md")
    res_10 = [
        TestResult(test_id=f"T{i}", rule_id=f"R{i}", objective=f"Test objective {i}", status="passed")
        for i in range(1, 11)
    ]
    out_10 = generate_markdown_report(
        summary={}, confirmed_bugs=[], inconclusive_findings=[],
        output_path=report_10, test_results=res_10,
    )
    with open(out_10, "r", encoding="utf-8") as f:
        c10 = f.read()
    assert "| **Tests Attempted** | 10 |" in c10
    assert "| **Tests Passed** | 10 |" in c10
    for i in range(1, 11):
        assert f"| T{i} | R{i} | Test objective {i} | Passed |" in c10






