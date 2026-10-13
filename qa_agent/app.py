"""Command-line entry point for the autonomous QA tester agent."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

from qa_agent.models import SpecRule, TestResult

load_dotenv()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="qa_agent",
        description="Autonomous QA Tester Agent — runs against a local demo shop.",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("DEMO_APP_URL", "http://localhost:3000"),
        help="Base URL of the demo application (default: http://localhost:3000)",
    )
    parser.add_argument(
        "--spec",
        default="specs/shop.md",
        help="Path to the plain-Markdown specification file (default: specs/shop.md)",
    )
    parser.add_argument(
        "--answers",
        default=None,
        metavar="FILE",
        help="Path to a JSON file with pre-filled answers for clarification questions",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=True,
        help="Run browser in headless mode (default: True)",
    )
    parser.add_argument(
        "--no-headless",
        dest="headless",
        action="store_false",
        help="Run browser in visible (non-headless) mode",
    )
    parser.add_argument(
        "--max-calls",
        type=int,
        default=None,
        metavar="N",
        help="Maximum number of LLM calls (default: read from MAX_LLM_CALLS env or 60)",
    )
    parser.add_argument(
        "--report",
        default="reports/bug_report.md",
        metavar="FILE",
        help="Output path for the Markdown bug report (default: reports/bug_report.md)",
    )
    return parser.parse_args()


def _read_spec(spec_path: str) -> str:
    path = Path(spec_path)
    if not path.exists():
        sys.exit(f"[ERROR] Spec file not found: {spec_path}")
    return path.read_text(encoding="utf-8")


def _wait_for_server(url: str, retries: int = 15, delay: float = 1.0) -> bool:
    """Poll the server until it responds or retries are exhausted."""
    import urllib.request
    for _ in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(delay)
    return False


def _run_pipeline(args: argparse.Namespace) -> None:

    # --- Import after dotenv is loaded ---
    from qa_agent.agent import (
        LLMClient,
        append_run_log,
        generate_markdown_report,
        generate_test_plan,
        judge_finding,
        reproduce_bug,
        reset_app_state,
        resolve_clarification,
        run_test_case,
        save_test_plan,
        understand_spec,
    )
    from qa_agent.browser import BrowserController

    # ------------------------------------------------------------------ #
    # 1. Read specification                                                #
    # ------------------------------------------------------------------ #
    print(f"\n{'='*60}")
    print("  Autonomous QA Tester Agent")
    print(f"{'='*60}")
    print(f"  Target : {args.url}")
    print(f"  Spec   : {args.spec}")
    print(f"  Answers: {args.answers or '(interactive)'}")
    print(f"{'='*60}\n")

    spec_text = _read_spec(args.spec)
    print("[Step 1] Reading specification...")

    # ------------------------------------------------------------------ #
    # 2. Build LLM client                                                  #
    # ------------------------------------------------------------------ #
    try:
        client = LLMClient(max_calls=args.max_calls)
    except RuntimeError as e:
        sys.exit(f"[ERROR] {e}")

    print(f"[LLM] Using model: {client.model}  |  Budget: {client.max_calls} calls\n")

    # ------------------------------------------------------------------ #
    # 3. Understand spec — extract rules + clarification question          #
    # ------------------------------------------------------------------ #
    print("[Step 2] Analyzing specification...")
    understanding = understand_spec(spec_text, client)
    print(f"  Extracted {len(understanding.rules)} rules:")
    for rule in understanding.rules:
        print(f"    {rule.id}: {rule.description}")

    clarification_question: Optional[str] = understanding.ambiguity_question
    clarification_answer: Optional[str] = None
    clarification_source = None

    if clarification_question:
        print(f"\n[Agent Question]: {clarification_question}")
        clarification_answer = resolve_clarification(
            clarification_question,
            answers_path=args.answers,
            interactive=True,
        )
        if clarification_answer:
            clarification_source = args.answers or "interactive"
            print(f"[Answer Used]: {clarification_answer}  (source: {clarification_source})\n")
        else:
            print("[Answer]: No answer provided — proceeding without clarification.\n")

    # ------------------------------------------------------------------ #
    # 4. Generate test plan                                                #
    # ------------------------------------------------------------------ #
    print("[Step 3] Generating test plan...")
    plan = generate_test_plan(
        understanding,
        clarification_question=clarification_question,
        clarification_answer=clarification_answer,
        client=client,
    )
    plan_path = save_test_plan(plan)
    print(f"  {len(plan.test_cases)} test case(s) saved to {plan_path}")
    for tc in plan.test_cases:
        print(f"    {tc.id} [{tc.rule_id}]: {tc.objective}")
    print()

    # ------------------------------------------------------------------ #
    # 5. Check server is reachable                                         #
    # ------------------------------------------------------------------ #
    print(f"[Step 4] Connecting to demo app at {args.url} ...")
    if not _wait_for_server(args.url):
        sys.exit(
            f"[ERROR] Cannot reach {args.url}. "
            "Please start the demo shop first:\n"
            "  cd demo_shop && npm run start:clean\n"
            "or with bugs:\n"
            "  cd demo_shop && npm run start:all-bugs"
        )
    print("  Server is up.\n")

    # ------------------------------------------------------------------ #
    # 6. Build a rule lookup map                                           #
    # ------------------------------------------------------------------ #
    rule_map = {r.id: r for r in understanding.rules}
    run_log_path = "reports/run_log.jsonl"

    # ------------------------------------------------------------------ #
    # 7. Execute each test case                                            #
    # ------------------------------------------------------------------ #
    print("[Step 5] Executing test cases...\n")

    test_results: List[TestResult] = []
    all_findings = []
    tests_executed = 0
    tests_passed = 0
    tests_failed_to_complete = 0

    clarification_context: Optional[str] = (
        f"Q: {clarification_question}\nA: {clarification_answer}"
        if clarification_question and clarification_answer
        else None
    )

    # Clear old run log
    os.makedirs("reports", exist_ok=True)
    if os.path.exists(run_log_path):
        os.remove(run_log_path)

    browser = BrowserController(base_url=args.url, headless=args.headless)
    try:
        browser.start()

        for tc in plan.test_cases:
            print(f"  Running {tc.id} [{tc.rule_id}]: {tc.objective}")
            tests_executed += 1

            # Reset state and fresh context before each test
            reset_app_state(args.url)
            browser.new_context()

            rule = rule_map.get(tc.rule_id)
            if rule is None:
                rule = SpecRule(
                    id=tc.rule_id,
                    description=tc.objective,
                    expected_behavior=tc.expected_outcome,
                    how_verified="Browser observation",
                )

            try:
                # Navigate to start page
                browser._page.goto(args.url + "/")
                browser.wait_for_idle()

                steps = run_test_case(
                    tc,
                    rule,
                    browser,
                    client,
                    run_log_path=run_log_path,
                    clarification_context=clarification_context,
                )

                snapshot = browser.take_snapshot()
                finding = judge_finding(tc, rule, steps, args.url, snapshot)

                if finding:
                    all_findings.append(finding)
                    tr = TestResult(
                        test_id=tc.id,
                        rule_id=tc.rule_id,
                        objective=tc.objective,
                        status="suspected_bug",
                        execution_status="completed",
                        finding_status="suspected",
                        expected=finding.expected,
                        observed=f"Suspected violation: [{finding.rule_id}] {finding.title}",
                        execution_stage="judgment",
                        finding=finding,
                    )
                    test_results.append(tr)
                    print(f"     !! Suspected violation: [{finding.rule_id}] {finding.title}")
                else:
                    tests_passed += 1
                    tr = TestResult(
                        test_id=tc.id,
                        rule_id=tc.rule_id,
                        objective=tc.objective,
                        status="passed",
                        execution_status="completed",
                        finding_status="no_violation",
                        expected=tc.expected_outcome,
                        observed="No violation detected; behavior aligned with specification",
                        execution_stage="completed",
                    )
                    test_results.append(tr)
                    print(f"     OK No violation detected")

            except Exception as e:
                tests_failed_to_complete += 1
                err_str = str(e)
                err_type = type(e).__name__
                if "503" in err_str or "UNAVAILABLE" in err_str:
                    err_type = "Gemini 503 UNAVAILABLE"
                elif "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
                    err_type = "Gemini 429 RESOURCE_EXHAUSTED"
                elif "Timeout" in err_type or "timeout" in err_str.lower():
                    err_type = "Timeout"
                elif "TargetClosed" in err_str or "Browser closed" in err_str:
                    err_type = "Browser Failure"

                tr = TestResult(
                    test_id=tc.id,
                    rule_id=tc.rule_id,
                    objective=tc.objective,
                    status="unable_to_complete",
                    execution_status="unable_to_complete",
                    expected=tc.expected_outcome,
                    observed=f"Execution halted: {err_str}",
                    error_type=err_type,
                    error_message=err_str,
                    execution_stage="agent_loop",
                )
                test_results.append(tr)
                print(f"     FAIL Test could not complete: {e}")
                append_run_log(
                    {
                        "test_id": tc.id,
                        "step": 0,
                        "observation": str(e),
                        "action": "error",
                        "thought": "Exception during test execution",
                        "result": str(e),
                        "timestamp": time.time(),
                    },
                    run_log_path,
                )

            print()

    finally:
        browser.close()

    # ------------------------------------------------------------------ #
    # 8. Independently reproduce suspected bugs                            #
    # ------------------------------------------------------------------ #
    confirmed_bugs = []
    inconclusive_findings = []

    if all_findings:
        print(f"[Step 6] Independently reproducing {len(all_findings)} suspected finding(s)...\n")
        repro_browser = BrowserController(base_url=args.url, headless=args.headless)
        try:
            repro_browser.start()
            for finding in all_findings:
                print(f"  Reproducing [{finding.rule_id}] {finding.title} ...")
                tr = next((r for r in test_results if r.test_id == finding.test_id), None)
                try:
                    result = reproduce_bug(finding, repro_browser, args.url)
                    if result.status == "confirmed":
                        confirmed_bugs.append(result)
                        if tr:
                            tr.status = "confirmed_bug"
                            tr.finding_status = "confirmed"
                            tr.reproduction_status = result.replays
                            tr.observed = f"[{result.rule_id}] {result.title} (Confirmed in {result.replays} replays)"
                            tr.screenshot_path = result.screenshot_path
                        print(f"     CONFIRMED ({result.replays})")
                    elif result.status == "not_reproduced":
                        if tr:
                            tr.status = "not_reproduced"
                            tr.finding_status = "not_reproduced"
                            tr.reproduction_status = result.replays
                            tr.observed = f"Suspected violation not reproduced ({result.replays} replays)"
                        print(f"     NOT reproduced ({result.replays})")
                    else:
                        inconclusive_findings.append(result)
                        if tr:
                            tr.status = "inconclusive"
                            tr.finding_status = "inconclusive"
                            tr.reproduction_status = result.replays
                            tr.observed = f"Suspected violation inconclusive ({result.replays} replays)"
                        print(f"     INCONCLUSIVE ({result.replays})")
                except Exception as repro_err:
                    print(f"     ERROR during reproduction: {repro_err}")
                    if tr:
                        tr.status = "inconclusive"
                        tr.finding_status = "inconclusive"
                        tr.error_type = type(repro_err).__name__
                        tr.error_message = f"Reproduction error: {repro_err}"
                        tr.observed = f"Reproduction interrupted: {repro_err}"
                    inconclusive_findings.append(finding)
                print()
        finally:
            repro_browser.close()
    else:
        print("[Step 6] No suspected bugs to reproduce.\n")

    # ------------------------------------------------------------------ #
    # 9. Generate Markdown report                                          #
    # ------------------------------------------------------------------ #
    print("[Step 7] Writing bug report...")

    bugs_config = os.environ.get("BUGS", "none")
    tests_failed = sum(1 for r in test_results if r.status in ("failed", "not_reproduced"))
    summary: Dict[str, Any] = {
        "target_url": args.url,
        "bugs_config": bugs_config,
        "tests_attempted": len(test_results),
        "tests_executed": len(test_results),
        "tests_passed": tests_passed,
        "tests_failed": tests_failed,
        "tests_failed_to_complete": tests_failed_to_complete,
        "tests_unable_to_complete": tests_failed_to_complete,
    }

    clarifications_used = []
    if clarification_question:
        clarifications_used.append(
            {
                "question": clarification_question,
                "answer": clarification_answer or "(no answer)",
                "source": clarification_source or "none",
            }
        )

    report_path = generate_markdown_report(
        summary=summary,
        confirmed_bugs=confirmed_bugs,
        inconclusive_findings=inconclusive_findings,
        clarifications=clarifications_used if clarifications_used else None,
        output_path=args.report,
        test_results=test_results,
    )

    # Record successful completion status for web backend
    status_dir = os.path.dirname(args.report) if getattr(args, "report", None) else "reports"
    if status_dir:
        os.makedirs(status_dir, exist_ok=True)
        status_path = os.path.join(status_dir, "status.json")
        try:
            with open(status_path, "w", encoding="utf-8") as f:
                json.dump({
                    "status": "completed",
                    "reportAvailable": True,
                    "tests_attempted": len(test_results),
                    "tests_passed": tests_passed,
                    "confirmed_bugs": len(confirmed_bugs)
                }, f, indent=2)
        except Exception:
            pass

    # ------------------------------------------------------------------ #
    # 10. Final summary                                                    #
    # ------------------------------------------------------------------ #
    print(f"\n{'='*60}")
    print("  Run Complete")
    print(f"{'='*60}")
    print(f"  Tests attempted         : {len(test_results)}")
    print(f"  Tests passed            : {tests_passed}")
    print(f"  Tests failed            : {tests_failed}")
    print(f"  Confirmed bugs (2/2)    : {len(confirmed_bugs)}")
    print(f"  Inconclusive findings   : {len(inconclusive_findings)}")
    print(f"  Could not complete      : {tests_failed_to_complete}")
    print(f"  LLM calls used          : {client.call_count} / {client.max_calls}")
    print(f"\n  Report  -> {report_path}")
    print(f"  Run log -> {run_log_path}")
    print(f"  Plan    -> {plan_path}")
    print(f"{'='*60}\n")

    if confirmed_bugs:
        print("Confirmed bugs:")
        for bug in confirmed_bugs:
            print(f"  [{bug.rule_id}] {bug.title}  (replays: {bug.replays})")
    else:
        print("No confirmed bugs found.")


def main() -> None:
    args = _parse_args()
    try:
        _run_pipeline(args)
    except SystemExit:
        raise
    except Exception as exc:
        clean_msg = re.sub(r"(?:AIzaSy|key=)[A-Za-z0-9_-]{20,}", "[REDACTED_KEY]", str(exc))
        from qa_agent.agent import classify_gemini_error
        err_code, user_msg, retryable = classify_gemini_error(exc)

        status_info = {
            "status": "failed",
            "error": {
                "code": err_code,
                "message": user_msg,
                "detail": clean_msg[:200],
            },
            "retryable": retryable,
            "reportAvailable": False,
        }

        status_dir = os.path.dirname(args.report) if getattr(args, "report", None) else "reports"
        if status_dir:
            os.makedirs(status_dir, exist_ok=True)
            status_path = os.path.join(status_dir, "status.json")
            try:
                with open(status_path, "w", encoding="utf-8") as f:
                    json.dump(status_info, f, indent=2)
            except Exception:
                pass

        print(f"\n[AGENT_ERROR] code={err_code} retryable={retryable} message={user_msg}", file=sys.stderr)
        print(f"[ERROR] {clean_msg}", file=sys.stderr)

        exit_code_map = {
            "GEMINI_UNAVAILABLE": 10,
            "GEMINI_RATE_LIMITED": 11,
            "GEMINI_AUTH_ERROR": 12,
            "GEMINI_TIMEOUT": 13,
        }
        sys.exit(exit_code_map.get(err_code, 1))


if __name__ == "__main__":
    main()

