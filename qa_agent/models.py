"""Pydantic models for the QA agent, planning, browser interactions, and reporting."""

from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field


class SnapshotElement(BaseModel):
    """An interactive element discovered on the page."""
    index: int
    tag: str
    text: str = ""
    input_type: Optional[str] = None
    value: Optional[str] = None
    stable_locator: str
    description: str


class PageSnapshot(BaseModel):
    """Compact structured snapshot of the current page state."""
    url: str
    title: str
    elements: List[SnapshotElement] = Field(default_factory=list)
    page_text: str = ""

    def formatted_text(self) -> str:
        """Format the snapshot for the LLM prompt according to Section 5 Step 3."""
        lines = []
        for el in self.elements:
            lines.append(f"[{el.index}] {el.description}")
        if self.page_text:
            lines.append(f"PAGE TEXT: {self.page_text}")
        return "\n".join(lines)


AllowedActionType = Literal[
    "click",
    "fill",
    "select",
    "press",
    "goto",
    "finish",
    "ask_user"
]


class AgentAction(BaseModel):
    """An action chosen by the LLM."""
    thought: str = Field(description="Short explanation of why this action was chosen")
    action: AllowedActionType = Field(description="Action name")
    target: Optional[Union[int, str]] = Field(default=None, description="Element number [N] or locator")
    value: Optional[str] = Field(default=None, description="Text value for fill or select")
    key: Optional[str] = Field(default=None, description="Key name for press, e.g. Enter")
    url: Optional[str] = Field(default=None, description="Local path or URL for goto")
    question: Optional[str] = Field(default=None, description="Clarification question for ask_user")


class RecordedAction(BaseModel):
    """An executed action recorded with resolved stable locator for deterministic replay."""
    step: int
    thought: str
    action: str
    target_locator: Optional[str] = None
    value: Optional[str] = None
    key: Optional[str] = None
    url: Optional[str] = None
    result: Optional[str] = None


class BrowserEvidence(BaseModel):
    """Evidence captured during browser execution."""
    console_errors: List[str] = Field(default_factory=list)
    page_errors: List[str] = Field(default_factory=list)
    failed_requests: List[Dict[str, Any]] = Field(default_factory=list)
    screenshot_path: Optional[str] = None


# --- Spec Understanding & Planning Models ---

class SpecRule(BaseModel):
    """A rule extracted from the specification."""
    id: str = Field(description="Unique rule ID, e.g. R1, R3, R4, R5")
    description: str = Field(description="Concise description of the rule")
    expected_behavior: str = Field(description="Expected behavior of the system under this rule")
    how_verified: str = Field(description="How this rule can be tested and verified")


class SpecUnderstanding(BaseModel):
    """Rules extracted from the specification and optional clarification question."""
    rules: List[SpecRule] = Field(description="List of extracted specification rules")
    ambiguity_question: Optional[str] = Field(
        default=None,
        description="One clarification question if an important requirement is ambiguous, or null"
    )


class TestCase(BaseModel):
    """A planned test case tied to a specific specification rule."""
    __test__ = False
    id: str = Field(description="Test case ID, e.g. T1, T2")
    rule_id: str = Field(description="Associated rule ID, e.g. R1")
    objective: str = Field(description="Objective of this test case")
    initial_conditions: str = Field(description="Initial conditions needed, e.g. clean cart on home page")
    expected_outcome: str = Field(description="Expected outcome according to the specification")
    goal: str = Field(description="Goal for the agent to achieve via browser interaction")


class TestPlan(BaseModel):
    """List of generated test cases (1 to 6 cases)."""
    __test__ = False
    test_cases: List[TestCase] = Field(description="1 to 6 test cases covering specification rules")


FindingStatus = Literal["confirmed", "inconclusive", "not_reproduced"]


class BugFinding(BaseModel):
    """A suspected or confirmed bug finding."""
    test_id: str
    rule_id: str
    title: str
    status: FindingStatus
    steps: List[RecordedAction] = Field(default_factory=list)
    expected: str
    actual: str
    replays: str = "0/2"  # e.g. "2/2"
    screenshot_path: Optional[str] = None
    evidence: Optional[BrowserEvidence] = None


class TestResult(BaseModel):
    """Structured result of executing a single test case across all execution paths."""
    __test__ = False
    test_id: str = Field(description="Unique test ID, e.g. T1, T2")
    rule_id: str = Field(description="Associated rule ID, e.g. R1")
    objective: str = Field(description="Objective of the test case")
    status: str = Field(
        default="passed",
        description="Final test outcome: passed, failed, confirmed_bug, inconclusive, not_reproduced, unable_to_complete",
    )
    execution_status: str = Field(
        default="completed",
        description="Execution outcome: completed or unable_to_complete",
    )
    finding_status: Optional[str] = Field(
        default=None,
        description="Finding status: confirmed, inconclusive, not_reproduced, or None",
    )
    expected: Optional[str] = Field(default=None, description="Expected behavior according to spec")
    observed: Optional[str] = Field(default=None, description="Actual observed behavior or outcome")
    error_type: Optional[str] = Field(default=None, description="Class or category of error, e.g. 503 UNAVAILABLE, TimeoutError")
    error_message: Optional[str] = Field(default=None, description="Raw error message if execution failed")
    execution_stage: Optional[str] = Field(default=None, description="Stage where test stopped: setup, agent_loop, judgment, reproduction, completed")
    finding: Optional[BugFinding] = Field(default=None, description="Suspected or confirmed bug finding details")
    reproduction_status: Optional[str] = Field(default=None, description="Independent reproduction ratio, e.g. 2/2, 1/2, 0/2")
    screenshot_path: Optional[str] = Field(default=None, description="Screenshot path if evidence was captured")
