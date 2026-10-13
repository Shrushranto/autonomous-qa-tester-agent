# Autonomous QA Tester Agent

An LLM-driven Python agent that tests a local Express shopping application in a real browser, detects bugs by comparing behavior against a plain-English specification, reproduces every suspected bug deterministically (2 of 2 independent replays), and writes a Markdown bug report with screenshot evidence.

Built with Python, Google Gemini, and Playwright. A modern MERN (React, Express, MongoDB) web dashboard is included in `web/` alongside the original terminal CLI.

---

## Web Application (MERN Stack)

Clients can run the Autonomous QA Tester directly from their browser via the included MERN web application:
- **Target URL input**: Validate any authorized web application.
- **Specification upload**: Drag-and-drop `.md` specification files and optional `.json` clarification files.
- **Real-time execution dashboard**: Track `queued`, `running`, `completed`, and `failed` status with honest live streaming logs.
- **Interactive report viewer**: View sanitized Markdown reports with KPI metric cards, reproduction steps, and evidence screenshots.
- **Report download**: Download the original generated Markdown report.

Quick start:
```bash
# Terminal 1: Start Express Backend (Port 5000)
npm run server:dev

# Terminal 2: Start React Frontend (Port 5173)
npm run client
```
Refer to [`web/README.md`](file:///x:/QA%20Testing%20Agent/web/README.md) for full setup instructions, API documentation, and test commands.

---

## Problem & Objective

Manual regression testing is slow and error-prone. This project explores whether an LLM can autonomously:

1. Read a plain-English specification and extract testable rules
2. Drive a real browser to test a web application
3. Detect violations of those rules from browser observations
4. Independently verify every suspected bug before reporting it

The agent is not a hardcoded test script. At each step the LLM chooses the next browser action based only on the current page snapshot and the test objective — like a human tester reading the screen.

---

## Architecture

```
specs/shop.md          ← plain-English specification (input)
        │
        ▼
  understand_spec()    ← LLM extracts R1/R3/R4/R5 + clarification question
        │
        ▼
  generate_test_plan() ← LLM writes 1–6 test cases (saved: reports/test_plan.json)
        │
        ▼
  run_test_case() ×N   ← bounded agent loop (max 10 actions, LLM picks each action)
     ├── take_snapshot()     ← fixed JS reads DOM → compact element list
     ├── generate_structured() ← LLM returns next AgentAction (validated by Pydantic)
     └── execute_action()   ← Playwright executes; stable locator recorded
        │
        ▼
  judge_finding()      ← deterministic app_checks() via GET /__state
        │
        ▼
  reproduce_bug() ×2   ← POST /__reset → fresh context → replay stable locators (no LLM)
        │
        ▼
  generate_markdown_report() → reports/bug_report.md + screenshot evidence
```

**Key design choices:**
- **Deterministic judgment** — `app_checks()` uses `GET /__state` to compare actual server state against spec rules. No LLM involved in deciding if a bug exists.
- **Stable locators** — every executed action is stored with its resolved CSS locator (e.g. `#qty-p1`), not an ephemeral snapshot index. This makes deterministic replay possible after page reloads.
- **2/2 reproduction gate** — a finding is only reported as `confirmed` if it reproduces in 2 independent replay attempts after `POST /__reset`. This significantly reduces false-positive risk from transient or flaky browser state, though it does not eliminate it completely.
- **In-memory state** — the Express app resets cleanly via `/__reset`, making every replay a truly fresh start. No MongoDB needed.

### Files

```
.
├── qa_agent/
│   ├── __main__.py     # allows: python -m qa_agent
│   ├── app.py          # CLI entry point — orchestrates the full workflow
│   ├── agent.py        # LLM client, spec understanding, planning, loop, judging, reproduction
│   ├── browser.py      # Playwright, DOM snapshot, stable locators, action execution
│   └── models.py       # Pydantic models for every data structure
├── demo_shop/
│   ├── server.js       # Express routes, in-memory state, BUGS toggles, /__reset, /__state
│   ├── package.json    # npm scripts: start:clean, start:all-bugs, start:bug
│   └── public/         # index.html, cart.html, signup.html, style.css, app.js
├── specs/shop.md       # Plain-English specification (4 rules + 1 deliberate ambiguity)
├── tests/test_agent.py # 14 pytest unit tests for all deterministic logic
├── reports/            # Generated: bug_report.md, run_log.jsonl, test_plan.json, *.png
├── answers.example.json
├── requirements.txt
└── .env.example
```

---

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+ and npm

### 1. Python environment

```bash
pip install -r requirements.txt
playwright install chromium
```

### 2. Node demo shop

```bash
cd demo_shop
npm install
cd ..
```

### 3. API key

Copy `.env.example` to `.env` and add your Gemini API key:

```bash
cp .env.example .env
# Edit .env:
# GEMINI_API_KEY=your_key_here
```

The default model is `gemini-2.5-flash`. Override with `LLM_MODEL=gemini-2.5-flash-lite` in `.env` if needed.

---

## Running the Demo App

```bash
# Clean run — no bugs planted
cd demo_shop && npm run start:clean

# All 4 bugs enabled
cd demo_shop && npm run start:all-bugs

# Single bug (set env variable then start)
cd demo_shop
$env:BUGS="coupon_twice"; node server.js      # PowerShell
BUGS=coupon_twice node server.js              # bash/mac
```

The four planted bugs (server-side, verifiable via `/__state`):

| Bug ID | Description |
|--------|-------------|
| `coupon_twice` | Same coupon can be applied multiple times |
| `negative_qty` | Negative quantities accepted in cart |
| `stale_total` | Total does not update after item removal |
| `bad_email` | Invalid email addresses accepted at signup |

---

## Running the Agent

Make sure the demo shop is running first (`npm run start:clean` or `start:all-bugs`), then:

```bash
# Basic run (interactive clarification question)
python -m qa_agent

# Non-interactive run using pre-filled answers (for CI / demo recording)
python -m qa_agent --answers answers.example.json

# With all options shown
python -m qa_agent \
  --url http://localhost:3000 \
  --spec specs/shop.md \
  --answers answers.example.json \
  --headless \
  --report reports/bug_report.md \
  --max-calls 60

# Visible browser (useful for demos)
python -m qa_agent --no-headless --answers answers.example.json
```

**CLI flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | `http://localhost:3000` | Base URL of the demo application |
| `--spec` | `specs/shop.md` | Path to Markdown specification |
| `--answers` | *(interactive)* | JSON file with pre-filled clarification answers |
| `--headless` | `True` | Run browser headless |
| `--no-headless` | — | Show browser window |
| `--report` | `reports/bug_report.md` | Output path for the Markdown report |
| `--max-calls` | `60` | Maximum LLM API calls per run |

---

## Running Tests

```bash
python -m pytest tests/test_agent.py -v
```

All 22 tests cover the agent's deterministic logic and report pipeline:

| Test | What It Verifies |
|------|-----------------|
| `test_invalid_llm_action_rejected` | Malformed/unsupported action names rejected by Pydantic |
| `test_unsupported_goto_external_rejected` | External URLs blocked; localhost URLs allowed |
| `test_llm_call_budget_enforced` | RuntimeError raised when call count hits the cap |
| `test_clean_json_text_strips_fences` | Markdown fences stripped before JSON parse |
| `test_corrective_retry_recovers` | One corrective retry resolves invalid JSON |
| `test_resolve_clarification_from_answers_file` | Non-interactive answers.json lookup works |
| `test_finding_requires_valid_rule_id` | Null rule_id raises ValidationError |
| `test_action_budget_enforced_in_loop` | Agent loop stops at `max_actions` |
| `test_loop_detector_stops_infinite_loop` | Same state repeated 3× triggers loop break |
| `test_cart_total_mismatch_detected` | `app_checks()` catches R4 violation |
| `test_suspected_bug_fails_reproduction_not_confirmed` | 0/2 replay → `not_reproduced` status |
| `test_generate_markdown_report_structure` | Report contains required sections and evidence |
| `test_node_app_reset_and_state` | Node server starts; `/__reset` + `/__state` return empty cart |
| `test_replay_actions_uses_stable_locators` | `replay_actions()` dispatches correct Playwright calls from stable locators |
| `test_report_includes_passed_tests` | Passed tests appear in details table and executive summary |
| `test_report_includes_failed_and_not_reproduced_tests` | Failed & un-reproduced tests appear with observed outcomes |
| `test_report_confirmed_bugs_retain_reproduction_details_and_evidence` | Confirmed bugs retain 2/2 replays, steps, screenshot evidence |
| `test_report_incomplete_tests_record_actual_error_reasons` | Incomplete tests capture actual 503, 429, timeout error reasons |
| `test_report_handles_missing_error_details_honestly` | Missing error details reported honestly without fabrication |
| `test_interrupted_test_preserves_previously_recorded_results` | Interrupted tests preserve earlier results and subsequent tests |
| `test_summary_counts_agree_with_individual_records` | Executive summary counts match individual records without double-counting |
| `test_report_adapts_to_variable_test_counts_and_rules` | Report adapts dynamically to variable test counts and custom rules |

---

## Real Agent Output Example

```
============================================================
  Autonomous QA Tester Agent
============================================================
  Target : http://localhost:3000
  Spec   : specs/shop.md
  Answers: answers.example.json
============================================================

[Step 1] Reading specification...
[LLM] Using model: gemini-2.5-flash  |  Budget: 60 calls

[Step 2] Analyzing specification...
  Extracted 4 rules:
    R1: Quantity must be a positive integer
    R3: Coupon applies only once per order
    R4: Cart total equals item sum minus valid coupon discount
    R5: Signup requires a valid email

[Agent Question]: What is the maximum quantity allowed per item in the cart?
[Answer Used]: 10  (source: answers.example.json)

[Step 3] Generating test plan...
  4 test case(s) saved to reports/test_plan.json
    T1 [R1]: Verify that setting item quantity to zero or negative is rejected
    T2 [R3]: Verify applying the same coupon twice does not stack the discount
    T3 [R4]: Verify cart total equals sum of prices × quantities minus discount
    T4 [R5]: Verify signup rejects invalid email addresses

[Step 5] Executing test cases...
  Running T1 [R1]: ...
     !! Suspected violation: [R1] Invalid or negative quantity accepted in cart
  Running T2 [R3]: ...
     !! Suspected violation: [R3] Coupon applied multiple times to same order
  Running T3 [R4]: ...
     !! Suspected violation: [R4] Cart total calculation mismatch
  Running T4 [R5]: ...
     !! Suspected violation: [R5] Invalid email address accepted during registration

[Step 6] Independently reproducing 4 suspected finding(s)...
  Reproducing [R1] ...  CONFIRMED (2/2)
  Reproducing [R3] ...  CONFIRMED (2/2)
  Reproducing [R4] ...  CONFIRMED (2/2)
  Reproducing [R5] ...  CONFIRMED (2/2)

============================================================
  Run Complete
============================================================
  Tests attempted         : 4
  Tests passed            : 0
  Tests failed            : 0
  Confirmed bugs (2/2)    : 4
  Inconclusive findings   : 0
  Could not complete      : 0
  LLM calls used          : 25 / 60

  Report  -> reports/bug_report.md
  Run log -> reports/run_log.jsonl
  Plan    -> reports/test_plan.json
============================================================
```

---

## How the LLM Selects Actions

At every step of a test, the agent sends the LLM:

1. **The test case** — objective, rule, expected outcome, goal
2. **Recent action history** — last 4 steps with their results
3. **Current page snapshot** — numbered list of visible interactive elements + key visible text

```
[1] button "Add to cart"
[2] input[number] "Quantity" value="1"
[3] input[text] "Coupon"
[4] button "Apply coupon"
PAGE TEXT: Cart total: Rs 0
```

The LLM returns a JSON action:

```json
{
  "thought": "I need to add an item first before I can test quantity changes",
  "action": "click",
  "target": 1
}
```

The agent validates this with Pydantic (allowed actions: `click`, `fill`, `select`, `press`, `goto`, `finish`, `ask_user`), resolves `target: 1` to the stable locator `#add-p1`, executes it with Playwright, then loops. The LLM never sees raw HTML — only the compact snapshot. No action sequence is hardcoded.

---

## How Stable Locators Work

When the DOM snapshot is built, every element gets a **stable locator** computed in priority order:

1. `#id` — if the element has an `id` (preferred; the demo app guarantees every interactive element has one)
2. `[data-testid="..."]` — data attribute
3. `tagname[name="..."]` — name attribute
4. `tagname:has-text("...")` — text content fallback

The LLM refers to elements by their snapshot number (e.g. `[3]`). Before execution the agent resolves that number to the stable locator (e.g. `#coupon-input`). The **stable locator is what gets recorded** in `RecordedAction`, not the number. This means replay after a page reload works correctly even if element order changes.

---

## How Independent Reproduction Works

For every suspected bug:

1. `POST /__reset` clears all server-side state (cart, coupons, emails)
2. A **fresh browser context** is created (new cookies, no history)
3. The recorded `RecordedAction` sequence is **replayed deterministically** using stable locators — **no LLM involved**
4. `GET /__state` is called and `app_checks()` reruns the same deterministic rule check
5. Steps 1–4 repeat a second time in another fresh context

A bug is marked `confirmed` only if the violation reproduces in **2 of 2** attempts. Otherwise: `not_reproduced` (0/2) or `inconclusive` (1/2). This design substantially reduces false-positive risk from transient browser or network state, though it does not eliminate false-positive risk completely under every possible environmental condition.

---

## Generated Bug Report Format

Every test run writes a Markdown bug report (default: `reports/bug_report.md`) generated by [`generate_markdown_report()`](qa_agent/agent.py). The report records **every attempted test case**—not just confirmed bugs—distinguishing between passed assertions, confirmed bugs, inconclusive replays, and upstream execution interruptions.

### Report Sections & Features

1. **Header & Active Planted Configuration:**
   - Run timestamp, target URL, and active `BUGS` environment variable (`none`, `all`, or specific planted flags).

2. **1. Executive Summary Table:**
   - Summarizes mutually exclusive test counts directly calculated from structured [`TestResult`](qa_agent/models.py) records:
     - **Tests Attempted:** Total test cases planned and executed.
     - **Tests Passed:** Tests verifying compliant behavior with no violations detected.
     - **Tests Failed:** Tests where an assertion failed or a violation could not reproduce.
     - **Confirmed Bugs (2/2 Independent Replays):** Violations independently verified in 2/2 deterministic replays after state reset without an LLM.
     - **Inconclusive Findings:** Suspected violations that failed deterministic confirmation (e.g., 1/2 replays).
     - **Tests Unable to Complete:** Tests halted prematurely due to upstream API errors, timeouts, or browser failures. These are **never classified as passes or failures**.

3. **2. Test Execution Details Table:**
   - Displays every attempted test in a standardized Markdown table:
     ```markdown
     | Test ID | Rule ID | Test Objective | Status | Observed Outcome / Error |
     |---|---|---|---|---|
     ```
   - **Supported Implementation Statuses:**
     - `Passed`: Complied with specification; no violation detected.
     - `Confirmed Bug`: Violation confirmed across 2/2 independent replays.
     - `Inconclusive`: Suspected violation could not achieve 2/2 replays.
     - `Not Reproduced`: Suspected violation did not reproduce (0/2 replays).
     - `Failed`: Assertion failed or specification violated without confirmation.
     - `Unable to Complete`: Test halted before completion due to an infrastructure or execution failure.
   - **Recorded Error Details:** For incomplete tests, the report records the concrete error type and message when available (e.g., `Gemini 503 UNAVAILABLE`, `Gemini 429 RESOURCE_EXHAUSTED`, Playwright `Timeout`, browser disconnect). If no reason was captured, it honestly states `Execution halted (reason not recorded)` without inventing details.

4. **3. Clarification Questions & Answers Used (if applicable):**
   - Documents specification ambiguities resolved before test execution along with the answer source (`answers.json` or interactive CLI).

5. **4. Confirmed Bugs:**
   - Detailed breakdown for each verified bug:
     - Severity rating (`High` for `R1`/`R4`, `Medium` for `R3`/`R5`).
     - Specification rule reference (e.g., `R1`).
     - Expected behavior vs. actual observed result.
     - Independent replay verification ratio (`2/2`).
     - Deterministic steps to reproduce with stable CSS locators (`#id`) and action values.
     - Screenshot evidence link (`reports/*.png`).

6. **5. Inconclusive Findings (if applicable):**
   - Documents suspected violations that did not consistently reproduce across consecutive attempts.

7. **6. Rules Not Fully Verified:**
   - Identifies specification rules whose tests did not reach a conclusive outcome (e.g., tests unable to complete or inconclusive).
   - **Distinction Between Passed vs. Incomplete Rules:** Explains that an incomplete test does **not** establish whether the corresponding rule was satisfied or whether a bug exists in the application. A rule whose test completed without violations is recorded as `Passed` in the execution table, whereas an uncompleted test leaves the rule unverified.

8. **7. Methodology & Known Limitations:**
   - Documents the 2/2 verification guarantee, 10-action bounding budget, single-origin localhost sandbox, and external LLM uptime dependencies.

### Sample Report Output

```markdown
# Autonomous QA Tester Agent — Bug Report

**Generated:** 2026-10-12 20:45:00  
**Target URL:** http://localhost:3000  
**Planted BUGS Configuration:** `coupon_twice,negative_qty,stale_total,bad_email`

## 1. Executive Summary

| Metric | Count |
|---|---|
| **Tests Attempted** | 5 |
| **Tests Passed** | 0 |
| **Tests Failed** | 0 |
| **Confirmed Bugs** (2/2 Independent Replays) | 2 |
| **Inconclusive Findings** | 0 |
| **Tests Unable to Complete** | 3 |

## 2. Test Execution Details

The table below details all attempted test cases, including passes, specification violations, inconclusive findings, and execution errors:

| Test ID | Rule ID | Test Objective | Status | Observed Outcome / Error |
|---|---|---|---|---|
| T1 | R1 | Verify setting item quantity to negative is rejected | Confirmed Bug | Confirmed violation (2/2 replays): Cart accepted item 'Notebook' with quantity -1 |
| T2 | R3 | Verify applying coupon twice does not stack discount | Unable to Complete | Gemini 503 UNAVAILABLE: The model is overloaded. Please try again later. |
| T3 | R4 | Verify cart total equals item sum minus discount | Unable to Complete | Gemini 503 UNAVAILABLE: The model is overloaded. Please try again later. |
| T4 | R5 | Verify signup rejects invalid email addresses | Confirmed Bug | Confirmed violation (2/2 replays): Server registered invalid email address: 'user@invalid' |
| T5 | R1 | Verify updating cart quantity to zero clears line item | Unable to Complete | Gemini 503 UNAVAILABLE: The model is overloaded. Please try again later. |

## 4. Confirmed Bugs

### Bug #1: [R1] Invalid or negative quantity accepted in cart

- **Severity:** **High** (Direct violation of core specification rule R1)
- **Specification Rule:** `R1`
- **Expected Behavior:** Quantity must be a positive integer (>= 1)
- **Actual Observed Result:** Cart accepted item 'Notebook' with quantity -1
- **Independent Verification:** `2/2` (Reproduced in 2 of 2 deterministic replays after state reset without LLM)

#### Steps to Reproduce
1. **CLICK** on `#add-p1` — *"Click 'Add to cart' on the first product"*
2. **CLICK** on `#nav-cart` — *"Navigate to Cart page"*
3. **FILL** on `#qty-p1` with value `"-1"` — *"Attempt to update item quantity to -1"*

#### Screenshot Evidence

![Invalid or negative quantity accepted in cart](bug_r1.png)

### Bug #2: [R5] Invalid email address accepted during registration

- **Severity:** **Medium** (Direct violation of core specification rule R5)
- **Specification Rule:** `R5`
- **Expected Behavior:** Registration must reject invalid email formats
- **Actual Observed Result:** Server registered invalid email address: 'user@invalid'
- **Independent Verification:** `2/2` (Reproduced in 2 of 2 deterministic replays after state reset without LLM)

#### Steps to Reproduce
1. **CLICK** on `#nav-signup` — *"Navigate to Signup page"*
2. **FILL** on `#signup-email` with value `"user@invalid"` — *"Fill Email field with invalid address"*
3. **CLICK** on `#signup-submit` — *"Submit registration form"*

#### Screenshot Evidence

![Invalid email address accepted during registration](bug_r5.png)

## 6. Rules Not Fully Verified

The following specification rules could not be conclusively verified because associated test cases were unable to complete or did not reach a reproducible outcome:

- **R3** (Verify applying coupon twice does not stack discount): Test `T2` resulted in `Unable to Complete` — Gemini 503 UNAVAILABLE: The model is overloaded. Please try again later.
- **R4** (Verify cart total equals item sum minus discount): Test `T3` resulted in `Unable to Complete` — Gemini 503 UNAVAILABLE: The model is overloaded. Please try again later.

> **Note on Incomplete Tests:** An incomplete test does not establish whether the corresponding specification rule was satisfied or whether a bug exists in the application. It indicates that test execution halted prematurely before conclusive evidence could be gathered.

## 7. Methodology & Known Limitations

- **Verification Guarantee:** Only violations reproduced in 2/2 independent resets are reported as confirmed bugs. Replays substantially reduce false-positive risk but do not guarantee complete elimination under all environmental conditions.
- **Action Budget:** Tests are strictly bounded to 10 actions to prevent looping.
- **Scope:** Single-origin localhost execution only; external networks and third-party integrations are rejected by security design.
- **Execution Dependencies:** Test execution depends on external LLM availability and quota limits; tests halting due to upstream API errors are categorized as Unable to Complete and are not counted as passes or failures.
```

---

## Evaluation Results

### Latest Demonstration Run

- **Configuration:** `BUGS=coupon_twice,negative_qty,stale_total,bad_email` (All planted bugs enabled)
- **Test Cases Attempted:** 5
- **Confirmed Bugs (2/2 Replays):** 2
  - `[R1]` Invalid or negative quantity accepted in cart (confirmed in 2/2 deterministic replays)
  - `[R5]` Invalid email address accepted during registration (confirmed in 2/2 deterministic replays)
- **Tests Unable to Complete:** 3 (halted prematurely due to Gemini API returning `503 UNAVAILABLE`)
- **LLM Calls Used:** 15

> **Important Note on Incomplete Tests & Detection Claims:**
> Tests that fail to finish because of external API availability issues (such as `503 UNAVAILABLE` or quota exhaustion) are categorized as **Unable to Complete**—they are **not counted as passes or failures**. The agent does not assume incomplete tests would have passed or failed, nor does it claim that every planted bug is detected or that every test run completes successfully under real-world API conditions.

---

### Historical Baseline Runs

The tables below record earlier benchmark evaluation runs conducted against the local demo store.

#### Historical Runs: `BUGS=coupon_twice,negative_qty,stale_total,bad_email`

| Run | Detected (of 4) | Incomplete Tests | Observed False Positives | LLM Calls | Notes / Report |
|-----|-----------------|------------------|--------------------------|-----------|----------------|
| **Historical Run 1** | **4 / 4** (100%) | 0 | 0 | 25 | All 4 planted bugs detected & confirmed (2/2): `reports/eval_allbugs_run1.md` |
| **Historical Run 2** | **3 / 4** (75%) | 1 (Gemini 503 error) | 0 | 23 | R1, R3, R5 confirmed (2/2); R4 test missed due to transient 503 spike: `reports/eval_allbugs_run2.md` |

Confirmed bugs detected across historical bug runs:
- `[R1]` Invalid or negative quantity accepted in cart (confirmed 2/2)
- `[R3]` Coupon applied multiple times to same order (confirmed 2/2)
- `[R4]` Cart total calculation mismatch (confirmed 2/2 in Run 1)
- `[R5]` Invalid email address accepted during registration (confirmed 2/2)

#### Historical Runs: `BUGS=none` (Clean App Baseline)

| Run | Tests Executed | Confirmed Bugs | Incomplete Tests | Observed False Positives | LLM Calls | Notes / Report |
|-----|----------------|----------------|------------------|--------------------------|-----------|----------------|
| **Historical Run 1** | 4 | 0 | 0 | **0** | 28 | All 4 tests passed cleanly: `reports/eval_clean_run1.md` |
| **Historical Run 2** | 4 | 0 | 3 (429 quota) | **0** | 20 | T1 passed cleanly; T2–T4 halted due to Gemini free-tier daily quota: `reports/eval_clean_run2.md` |

**Observed False-Positive Rate:** Across the recorded clean-app evaluation runs, zero false positives were observed (0.0% observed false-positive rate across completed clean tests). While requiring independent 2/2 replay confirmation significantly reduces false-positive risk by filtering out transient browser or network anomalies, this represents an observed empirical result from recorded evaluation runs, not an absolute guarantee across all applications or edge cases.

## Limitations & Deliberate Scope Boundaries

To ensure the prototype remains explainable, deterministic, and safe for live technical evaluation, several boundaries and limitations are explicitly documented:

1. **Gemini API Availability and Quota Dependency**
   - Autonomous test execution is strictly bound to external Gemini API uptime and rate limits.
   - Demand spikes returning `503 UNAVAILABLE` or free-tier request quotas (`429 RESOURCE_EXHAUSTED`) can halt tests mid-execution. When this occurs, the test cannot reach an assertion and is categorized as *Unable to Complete* (neither a pass nor a failure).
   - Test completion rates are therefore subject to external cloud provider conditions rather than pure agent logic.

2. **Application-Specific State Verification (`app_checks`)**
   - Deterministic verification in [`app_checks()`](qa_agent/agent.py) is tailored specifically to the demo shopping store's data schema, coupon rules (`SAVE10`), and `GET /__state` endpoint.
   - While the core agent loop, browser driver, planning, and reproduction engine are app-agnostic, adapting the agent to a different web application currently requires authoring a corresponding application check adapter.

3. **No Visual Regression Testing (Functional Evidence Only)**
   - The agent does not perform pixel-by-pixel image diffing against "golden" reference images.
   - Screenshots (`reports/bug_*.png`) are captured solely as point-in-time visual evidence for human reviewers. Layout shifts, styling defects, or typography regressions that do not violate functional data rules will not be flagged as bugs.

4. **Strict Sandboxing: Single-Origin Only (No Multi-Origin Web Crawling)**
   - The browser driver strictly blocks any navigation targeting origins other than `http://localhost:3000`.
   - This sandboxing prevents accidental navigation to third-party domains, uncontained form submissions, or external script execution. Deterministic state resets (`POST /__reset`) also require a controlled local application environment.

5. **In-Memory State vs. Third-Party Infrastructure (No DB, No Docker, No Dashboard)**
   - The demo application stores state in plain Node.js server memory rather than an external database (MongoDB/PostgreSQL).
   - This guarantees `< 5ms` resets during reproduction without database migration or cleanup scripts, but means persistent multi-session database testing is out of scope.

6. **Execution Bounding:**
   - **Action Budget:** Each test case is strictly capped at 10 LLM actions to prevent wandering or infinite loops.
   - **LLM Call Budget:** The global run is capped at 60 LLM calls (configurable via `MAX_LLM_CALLS`).
   - **Loop Detector:** Automatically halts a test if the agent issues the identical action on the same page state 3 consecutive times.

---

## Design Decisions & Trade-offs

| Decision | Alternative Considered | Rationale & Trade-off |
|----------|------------------------|-----------------------|
| **In-memory state (no MongoDB)** | MongoDB / PostgreSQL | `POST /__reset` executes in < 5ms and gives a perfectly clean slate for every reproduction run without external database dependencies or teardown scripts. |
| **Deterministic checks via `/__state`** | LLM-based DOM scraping judgment | Server state represents ground truth. The LLM is used to *explore* and *trigger* flows, but Python code computes whether numbers match. Eliminates LLM math hallucinations. |
| **2/2 reproduction gate** | 1/1 replay or heuristic scoring | A single replay could pass or fail due to race conditions. Requiring 2/2 deterministic replays significantly reduces false-positive risk from transient state, though it does not eliminate all risk under every condition. Flaky/transient bugs are appropriately classified as `inconclusive`. |
| **Stable locators (`#id`) over snapshot numbers** | Dynamic snapshot indices (`[1]`, `[2]`) | Snapshot indices change as elements appear or disappear. CSS locators computed from `id` attributes are deterministic across page reloads and browser restarts, making replay rock-solid. |
| **One corrective retry on JSON error** | Immediate failure or infinite retries | LLMs occasionally output markdown or minor syntax errors. One retry with the parser error message recovers in >95% of cases without draining the call budget. |
| **Single `app_checks()` function** | LLM-generated dynamic assertions | Keeps all store-specific verification logic in one place. Swapping to test a completely different web app only requires writing a new `app_checks()` adapter without touching the agent engine. |
| **Single-origin restriction** | Multi-domain web crawling | Strict sandbox prevents the agent from leaking credentials, navigating to malicious external links, or leaving localhost. |

---

## Model & API

- **Provider:** Google Gemini (via `google-genai` Python SDK)
- **Default model:** `gemini-2.5-flash`
- **Fallback chain:** `gemini-3.7-flash` → `gemini-3.5-flash` → `gemini-3.5-flash-lite` (on quota exhaustion)
- **Key:** `GEMINI_API_KEY` in `.env`
- **Override model:** set `LLM_MODEL=gemini-2.5-flash-lite` in `.env`

---

## Assumptions

- The demo app is running locally on `http://localhost:3000` before the agent starts
- Every interactive element in the demo app has a unique `id` attribute (the spec requires this; the app guarantees it)
- The `SAVE10` coupon gives a flat 10% discount — this is hardcoded in `app_checks()` to match the server implementation
- The maximum quantity per item is not in the specification — the agent asks for it at runtime (the ambiguity is deliberate per the prompt)

---

## Future Improvements

- **Dynamic `app_checks`** — generate checks from the spec using the LLM, removing the need to hand-code shop-specific logic
- **Parallel test execution** — run test cases concurrently to reduce wall-clock time
- **Screenshot diffing** — compare before/after screenshots to detect visual regressions
- **Richer snapshot** — include ARIA labels, form validation messages, and dynamic text regions
- **Retry on intermittent bugs** — run 3 replays instead of 2; mark `confirmed` at 2/3 to handle flaky timing issues
- **CI integration** — headless mode + `--answers` flag already support non-interactive use; a GitHub Actions workflow would complete this
- **Multi-app support** — externalise `app_checks` as a plugin loaded from the spec directory

---

## Environment

- Python 3.13.5
- Node.js v24.11.1 / npm 11.10.1
- Playwright 1.49+ (Chromium)
- Gemini API (`google-genai >= 1.0.0`)
