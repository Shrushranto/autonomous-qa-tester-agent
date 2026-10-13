"""Playwright browser controller, DOM snapshot extraction, stable locators, and action execution."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from playwright.sync_api import Browser, BrowserContext, Page, Playwright, Response, sync_playwright

from qa_agent.models import AgentAction, BrowserEvidence, PageSnapshot, RecordedAction, SnapshotElement

# Centralized constants as required by Section 8
ACTION_TIMEOUT_MS = 5000
NAV_TIMEOUT_MS = 10000
DOM_SETTLE_MS = 250


def is_localhost_url(url: str, base_origin: str = "http://localhost:3000") -> bool:
    """Validate that URL is restricted to the local demo application."""
    if not url:
        return False
    # Relative path on same origin
    if url.startswith("/") or not (url.startswith("http://") or url.startswith("https://")):
        return True
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
        return hostname in ("localhost", "127.0.0.1")
    except Exception:
        return False


def normalize_target_url(target: str, base_origin: str) -> str:
    """Normalize relative or absolute localhost URL against the base origin."""
    if target.startswith("http://") or target.startswith("https://"):
        return target
    if not target.startswith("/"):
        target = "/" + target
    return base_origin.rstrip("/") + target


class BrowserController:
    """Manages Playwright lifecycle, snapshots, action execution, and evidence collection."""

    def __init__(self, base_url: str = "http://localhost:3000", headless: bool = True):
        self.base_url = base_url.rstrip("/")
        self.headless = headless
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self.evidence = BrowserEvidence()

    def start(self) -> Page:
        """Launch the browser and prepare a fresh page."""
        if not self._playwright:
            self._playwright = sync_playwright().start()
        if not self._browser:
            self._browser = self._playwright.chromium.launch(headless=self.headless)
        return self.new_context()

    def new_context(self) -> Page:
        """Create an isolated browser context with clean evidence tracking."""
        if self._context:
            try:
                self._context.close()
            except Exception:
                pass

        self.evidence = BrowserEvidence()
        self._context = self._browser.new_context()
        self._page = self._context.new_page()
        self._page.set_default_timeout(ACTION_TIMEOUT_MS)
        self._page.set_default_navigation_timeout(NAV_TIMEOUT_MS)

        # Attach listeners for evidence recording
        self._page.on("console", self._handle_console)
        self._page.on("pageerror", self._handle_pageerror)
        self._page.on("response", self._handle_response)

        return self._page

    def _handle_console(self, msg) -> None:
        if msg.type in ("error", "warning"):
            self.evidence.console_errors.append(f"[{msg.type}] {msg.text}")

    def _handle_pageerror(self, err) -> None:
        self.evidence.page_errors.append(str(err))

    def _handle_response(self, response: Response) -> None:
        if response.status >= 400:
            self.evidence.failed_requests.append({
                "url": response.url,
                "status": response.status,
                "status_text": response.status_text,
                "method": response.request.method,
            })

    def wait_for_idle(self) -> None:
        """Wait for network to be idle and DOM to settle after updates."""
        if not self._page:
            return
        try:
            self._page.wait_for_load_state("networkidle", timeout=3000)
        except Exception:
            pass
        try:
            self._page.wait_for_timeout(DOM_SETTLE_MS)
        except Exception:
            pass

    def take_snapshot(self) -> PageSnapshot:
        """Extract interactive elements, stable locators, and visible text."""
        self.wait_for_idle()
        if not self._page:
            raise RuntimeError("Browser page is not initialized")

        raw_data: Dict[str, Any] = self._page.evaluate("""() => {
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            const computeStableLocator = (el) => {
                if (el.id) return '#' + el.id;
                const testId = el.getAttribute('data-testid');
                if (testId) return `[data-testid="${testId}"]`;
                const name = el.getAttribute('name');
                if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
                const role = el.getAttribute('role') || el.tagName.toLowerCase();
                const label = el.innerText || el.getAttribute('aria-label') || el.value || '';
                if (label.trim()) {
                    return `${el.tagName.toLowerCase()}:has-text("${label.trim().replace(/"/g, '\\"')}")`;
                }
                return el.tagName.toLowerCase();
            };

            const elements = [];
            const candidates = Array.from(document.querySelectorAll('button, input, textarea, select, a[href]'));

            for (const el of candidates) {
                if (!isVisible(el)) continue;
                const tag = el.tagName.toLowerCase();
                const type = (el.getAttribute('type') || '').toLowerCase();
                const text = (el.innerText || el.textContent || '').trim();
                const value = el.value !== undefined ? String(el.value) : '';
                const id = el.id || '';
                const locator = computeStableLocator(el);

                let desc = '';
                if (tag === 'button' || (tag === 'input' && (type === 'button' || type === 'submit'))) {
                    const btnLabel = text || value || el.getAttribute('aria-label') || id;
                    desc = `button "${btnLabel}"`;
                } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                    // Try to find an associated label
                    let labelText = '';
                    if (id) {
                        const lbl = document.querySelector(`label[for="${id}"]`);
                        if (lbl) labelText = lbl.innerText.trim();
                    }
                    if (!labelText) {
                        const parentLabel = el.closest('label');
                        if (parentLabel) labelText = parentLabel.innerText.trim();
                    }
                    if (!labelText) {
                        labelText = el.getAttribute('placeholder') || el.getAttribute('aria-label') || id;
                    }
                    const typeLabel = type || tag;
                    desc = `input[${typeLabel}] "${labelText}"${value ? ` value="${value}"` : ''}`;
                } else if (tag === 'a') {
                    const href = el.getAttribute('href') || '';
                    desc = `link "${text || id}" href="${href}"`;
                }

                elements.push({
                    tag: tag,
                    text: text,
                    input_type: type || null,
                    value: value || null,
                    stable_locator: locator,
                    description: desc
                });
            }

            // Extract visible key text
            const keyTextParts = [];
            const totalEl = document.getElementById('cart-total');
            if (totalEl && isVisible(totalEl)) keyTextParts.push(totalEl.innerText.trim());

            const msgEl = document.getElementById('message');
            if (msgEl && isVisible(msgEl) && msgEl.innerText.trim()) {
                keyTextParts.push(`Message: ${msgEl.innerText.trim()}`);
            }

            const emptyEl = document.getElementById('cart-empty');
            if (emptyEl && isVisible(emptyEl) && emptyEl.innerText.trim()) {
                keyTextParts.push(emptyEl.innerText.trim());
            }

            // Fallback body text summary if no specific elements
            if (!keyTextParts.length && document.body) {
                const bodyLines = document.body.innerText.split('\\n')
                    .map(l => l.trim())
                    .filter(l => l && !l.includes('Products') && !l.includes('Cart') && !l.includes('Signup'));
                if (bodyLines.length) keyTextParts.push(bodyLines.slice(0, 3).join(' | '));
            }

            return {
                url: window.location.href,
                title: document.title,
                elements: elements,
                page_text: keyTextParts.join(' | ')
            };
        }""")

        snapshot_elements = [
            SnapshotElement(
                index=i + 1,
                tag=item["tag"],
                text=item["text"],
                input_type=item["input_type"],
                value=item["value"],
                stable_locator=item["stable_locator"],
                description=item["description"],
            )
            for i, item in enumerate(raw_data.get("elements", []))
        ]

        return PageSnapshot(
            url=raw_data.get("url", ""),
            title=raw_data.get("title", ""),
            elements=snapshot_elements,
            page_text=raw_data.get("page_text", ""),
        )

    def resolve_locator(self, target: Any, snapshot: PageSnapshot) -> str:
        """Resolve an LLM target (e.g. 3, '[3]', or '#id') to a stable CSS locator."""
        if target is None:
            raise ValueError("Action target cannot be None")

        # If integer or string representing integer
        idx: Optional[int] = None
        if isinstance(target, int):
            idx = target
        elif isinstance(target, str):
            clean = target.strip()
            match = re.match(r"^\[?(\d+)\]?$", clean)
            if match:
                idx = int(match.group(1))

        if idx is not None:
            for el in snapshot.elements:
                if el.index == idx:
                    return el.stable_locator
            raise ValueError(f"Snapshot element [{idx}] not found (available: 1..{len(snapshot.elements)})")

        target_str = str(target).strip()
        # Direct CSS locator provided
        return target_str

    def execute_action(
        self,
        action: AgentAction,
        snapshot: PageSnapshot,
        step_number: int = 1,
    ) -> Tuple[RecordedAction, str]:
        """Execute an action, validate safety rules, and record the stable locator."""
        if not self._page:
            raise RuntimeError("Browser page is not initialized")

        act_type = action.action

        # Safety: Validate goto URL
        if act_type == "goto":
            url = action.url or (str(action.target) if action.target else "/")
            if not is_localhost_url(url, self.base_url):
                raise ValueError(f"Security violation: goto target must be localhost demo app, got: '{url}'")
            dest = normalize_target_url(url, self.base_url)
            self._page.goto(dest)
            self.wait_for_idle()
            rec = RecordedAction(
                step=step_number,
                thought=action.thought,
                action="goto",
                url=dest,
                result=f"Navigated to {dest}",
            )
            return rec, rec.result or ""

        if act_type == "finish":
            rec = RecordedAction(
                step=step_number,
                thought=action.thought,
                action="finish",
                result="Test finished by agent",
            )
            return rec, rec.result or ""

        if act_type == "ask_user":
            rec = RecordedAction(
                step=step_number,
                thought=action.thought,
                action="ask_user",
                value=action.question,
                result=f"Question asked: {action.question}",
            )
            return rec, rec.result or ""

        # Resolving locator for element actions
        locator = self.resolve_locator(action.target, snapshot)

        if act_type == "click":
            self._page.click(locator)
            result = f"Clicked {locator}"
        elif act_type == "fill":
            val = "" if action.value is None else str(action.value)
            self._page.fill(locator, val)
            # Trigger change event if standard fill didn't
            try:
                self._page.eval_on_selector(locator, "el => el.dispatchEvent(new Event('change', {bubbles: true}))")
            except Exception:
                pass
            result = f"Filled {locator} with '{val}'"
        elif act_type == "select":
            val = "" if action.value is None else str(action.value)
            self._page.select_option(locator, val)
            result = f"Selected '{val}' in {locator}"
        elif act_type == "press":
            key = action.key or "Enter"
            self._page.press(locator, key)
            result = f"Pressed {key} on {locator}"
        else:
            raise ValueError(f"Unsupported action: {act_type}")

        self.wait_for_idle()

        rec = RecordedAction(
            step=step_number,
            thought=action.thought,
            action=act_type,
            target_locator=locator,
            value=action.value,
            key=action.key,
            result=result,
        )
        return rec, result

    def replay_actions(self, recorded_actions: List[RecordedAction]) -> bool:
        """Replay recorded actions deterministically using stable locators without LLM."""
        if not self._page:
            raise RuntimeError("Browser page is not initialized")

        try:
            # If fresh page starts at about:blank and first action isn't goto, open initial base_url
            if self._page.url in ("about:blank", "") and (not recorded_actions or recorded_actions[0].action != "goto"):
                self._page.goto(self.base_url + "/")
                self.wait_for_idle()

            for act in recorded_actions:
                if act.action == "goto":
                    dest = normalize_target_url(act.url or "/", self.base_url)
                    self._page.goto(dest)
                elif act.action == "click":
                    if not act.target_locator:
                        return False
                    self._page.click(act.target_locator)
                elif act.action == "fill":
                    if not act.target_locator:
                        return False
                    val = "" if act.value is None else str(act.value)
                    self._page.fill(act.target_locator, val)
                    try:
                        self._page.eval_on_selector(act.target_locator, "el => el.dispatchEvent(new Event('change', {bubbles: true}))")
                    except Exception:
                        pass
                elif act.action == "select":
                    if not act.target_locator:
                        return False
                    self._page.select_option(act.target_locator, act.value or "")
                elif act.action == "press":
                    loc = act.target_locator or "body"
                    self._page.press(loc, act.key or "Enter")
                elif act.action in ("finish", "ask_user"):
                    continue
                self.wait_for_idle()

            return True
        except Exception as e:
            print(f"Replay action failed: {e}")
            return False

    def capture_screenshot(self, filepath: str) -> str:
        """Save a screenshot of current page state for evidence."""
        if not self._page:
            raise RuntimeError("Browser page is not initialized")
        self._page.screenshot(path=filepath)
        self.evidence.screenshot_path = filepath
        return filepath

    def close(self) -> None:
        """Clean shutdown of browser resources."""
        if self._context:
            try:
                self._context.close()
            except Exception:
                pass
            self._context = None
        if self._browser:
            try:
                self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._playwright:
            try:
                self._playwright.stop()
            except Exception:
                pass
            self._playwright = None
