# Autonomous QA Tester — MERN Web Application

A modern MERN (MongoDB, Express.js, React, Node.js) web application built on top of the Autonomous QA Tester Agent.

Clients can enter their target website URL, upload a Markdown specification file (`specs.md`), optionally supply clarification answers (`answers.json`), and trigger end-to-end autonomous QA testing with Playwright browser automation and Google Gemini intelligence.

---

## Architecture Overview

```text
┌────────────────────────┐      HTTP / Multipart       ┌────────────────────────┐
│     React Frontend     │ ──────────────────────────> │   Express.js Backend   │
│   (Vite + Vanilla CSS) │ <────────────────────────── │      (Port 5000)       │
└────────────────────────┘        Polls Status         └───────────┬────────────┘
                                                                   │
                                                                   │ Stores Job Metadata
                                                                   ▼
                                                       ┌────────────────────────┐
                                                       │        MongoDB         │
                                                       │   (qa_tester_agent)    │
                                                       └────────────────────────┘
                                                                   │
                                              Spawns Child Process │ (isolated args & cwd)
                                                                   ▼
                                                       ┌────────────────────────┐
                                                       │  Python QA Tester CLI  │
                                                       │   qa_agent (Playwright │
                                                       │     + Gemini Engine)   │
                                                       └────────────────────────┘
```

- **Frontend (`web/client`)**: React 18 SPA built with Vite and high-performance Vanilla CSS design system. Features real-time status polling, honest stream logs terminal, interactive KPI metrics cards, sanitized Markdown report viewer (DOMPurify), and original report downloader.
- **Backend (`web/server`)**: Node.js & Express REST API. Enforces SSRF defense (private IP/metadata blocking), per-job folder isolation, file-type/size restrictions, child process concurrency limiting, and execution timeouts.
- **Database (MongoDB)**: Stores job metadata, status, timestamps, and execution logs.
- **Engine (`qa_agent`)**: Untouched existing Python agent orchestrated via `child_process.spawn`.

---

## Prerequisites

1. **Node.js**: v18.0.0 or higher (v20+ recommended).
2. **MongoDB**: Local MongoDB instance running on `mongodb://127.0.0.1:27017` or a MongoDB Atlas URI.
3. **Python**: Python 3.10+ virtual environment (`.venv`) with all dependencies from `requirements.txt` installed.
4. **Gemini API Key**: Configured in project root `.env` as `GEMINI_API_KEY=your_key`.

---

## Quick Start

### 1. Ensure MongoDB is Running

For local MongoDB on Windows:
```powershell
net start MongoDB
# Or verify connection:
# mongosh mongodb://127.0.0.1:27017
```

### 2. Verify Root Environment
Ensure the root `.env` contains your Gemini API key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```

### 3. Start Backend Server
From the project root:
```bash
npm run server:dev
# Or navigate to web/server:
# cd web/server && npm run dev
```
The server will start on `http://localhost:5000`. Verify health at:
```text
http://localhost:5000/api/health
```

### 4. Start React Frontend
In a separate terminal from the project root:
```bash
npm run client
# Or navigate to web/client:
# cd web/client && npm run dev
```
Open `http://localhost:5173` in your browser.

### 5. (Optional) Run Local Target Demo Shop
In another terminal:
```bash
npm --prefix demo_shop start:all-bugs
```
The demo shop runs on `http://localhost:3000`.

---

## Environment Variables

### Backend (`web/server/.env`)
| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `5000` | Express server HTTP port |
| `CLIENT_URL` | `http://localhost:5173` | Allowed frontend origin for CORS |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/qa_tester_agent` | MongoDB connection string |
| `PYTHON_PATH` | *(Auto-detected from `.venv`)* | Path to Python executable |
| `MAX_CONCURRENT_JOBS` | `2` | Max concurrent Python agent runs |
| `EXECUTION_TIMEOUT_MS` | `300000` (5 mins) | Child process timeout before termination |
| `ALLOW_LOCAL_TARGETS` | `true` | Permits `localhost` and loopback targets in dev |

---

## Running the Automated Test Suite

### Run Backend Unit & Integration Tests (Jest + Supertest)
```bash
npm run test:server
```
*Tests request validation, SSRF protections, job creation, mocked child process execution, download endpoints, safe paths, failure classification (503, 401, timeout, missing report), and retry isolation.*

### Run Frontend Tests (Vitest + React Testing Library)
```bash
npm run test:client
```
*Tests form input validation, file selection restrictions, DOMPurify XSS sanitization, failed job display with error badges and troubleshooting instructions, and completed job report rendering.*

### Run Python Tests (pytest)
```bash
npm run test:python
# or: .venv\Scripts\python.exe -m pytest tests\test_agent.py tests\test_gemini_failures.py -v
```
*Runs all 28 Python unit tests, including transient 503 retries, retry limit exhaustion, 429 quota fallback, and prompt failure on permanent 401/403 errors.*

### Run All Test Suites
```bash
npm run test:all
```

---

## Gemini Failure Handling & Error Architecture

### 1. Error Codes & Classifications
The system categorizes failures into structured machine-readable error codes and user-friendly messages:

| Error Code | Exit Code | Retryable | User-Facing Message |
| :--- | :---: | :---: | :--- |
| `GEMINI_UNAVAILABLE` | `10` | Yes | The AI model is temporarily overloaded. The agent retried the request but could not complete it. Please try again shortly. |
| `GEMINI_RATE_LIMITED` | `11` | Yes | The AI request limit has been reached. Please wait before starting another test. |
| `GEMINI_AUTH_ERROR` | `12` | No | The AI service configuration is invalid. Please contact the administrator. |
| `GEMINI_TIMEOUT` | `13` | Yes | The AI request timed out. Please try again. |
| `REPORT_NOT_GENERATED` | `0` (missing report) | Yes | Testing stopped, but the report could not be generated. Please check the run details before retrying. |
| `EXECUTION_TIMEOUT` | Terminated | Yes | The test exceeded its allowed runtime and was stopped. |
| `AGENT_EXECUTION_FAILED` | `1` / other | Yes | The test agent stopped unexpectedly. No complete report was generated. |

### 2. Python Agent Retry Behavior
- **Bounded Exponential Backoff**: Transient errors (503, retryable 429) retry up to 3 times per model with exponential backoff (`base_delay * 2^attempt + jitter`).
- **Retry-After Header**: Automatically parses and respects HTTP `Retry-After` headers where provided.
- **Permanent Errors Fail Promptly**: 401 Unauthorized, 403 Forbidden, and 400 Bad Request fail immediately without retry loops.
- **Dual Status Reporting**: The agent writes a structured `status.json` to the job's report directory and emits a structured `[AGENT_ERROR]` log message on stderr.
- **Redaction**: All API keys, authorization tokens, and credentials are automatically stripped from error logs and API responses.

### 3. Backend & Job State Transition
- **Terminal States**: Jobs transition cleanly between `queued` → `running` → `completed` | `failed`.
- **Integrity Validation**: A job is only marked `completed` if the Python agent exited with code 0 and the expected `report.md` exists and is non-empty.
- **Isolated Retries (`POST /api/tests/:id/retry`)**:
  - Rejects retrying jobs with permanent auth errors (`GEMINI_AUTH_ERROR`).
  - Spawns a new job with a unique UUID (`uuidv4()`).
  - Preserves historical records, logs, and evidence of the prior failed run intact.

### 4. React Frontend UX
- **In-Progress Guidance**: Shows when a test is running and notes that the AI engine may retry temporary provider hiccups.
- **Structured Error Panel**: Displays an error badge (`GEMINI_UNAVAILABLE`, etc.), a clear explanatory message, and concrete troubleshooting steps.
- **Conditional Retry Button**: The "Retry Test" action is presented only when `job.retryable !== false`. For permanent configuration errors, the button is hidden and guidance to inspect `.env` is displayed.
- **No Blank / Fabricated Reports**: The UI never presents an incomplete run or missing report as a success.

---

## Troubleshooting Guide

### 1. MongoDB Connection Error
**Symptoms:** `Fatal error during server startup: connect ECONNREFUSED 127.0.0.1:27017`
- **Solution:** Verify the MongoDB service is running via Windows Services or run `net start MongoDB` in an Administrator PowerShell. If using Docker: `docker run -d -p 27017:27017 --name mongo mongo:latest`.

### 2. Python Path or Virtual Environment Not Found
**Symptoms:** `Failed to spawn Python process` or module not found.
- **Solution:** Ensure the virtual environment exists in the project root (`.venv`). If using a custom Python path, set `PYTHON_PATH=C:\path\to\python.exe` in `web/server/.env`.

### 3. Gemini API 503 or Rate Limit
**Symptoms:** Job fails with `ServerError: 503 UNAVAILABLE` or high demand spike.
- **Solution:** Gemini API occasionally experiences high traffic spikes. The Python agent will automatically retry transient spikes. If exhausted, the UI displays a `GEMINI_UNAVAILABLE` panel with a one-click "Retry Test" button.

### 4. Target Website Blocked (SSRF)
**Symptoms:** `Requests to localhost / loopback addresses are restricted in this environment.`
- **Solution:** Ensure `ALLOW_LOCAL_TARGETS=true` is set in `web/server/.env` when testing against local development servers like `http://localhost:3000`.
