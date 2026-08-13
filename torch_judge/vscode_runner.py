"""Structured TorchCode judge entry point used by the VS Code extension."""

from __future__ import annotations

import json
import sys
from typing import Any

from torch_judge.progress import mark_attempted, mark_solved
from torch_judge.tasks import get_task
from torch_judge.web_engine import execute_code


def _reply(data: dict[str, Any]) -> None:
    print(json.dumps(data, ensure_ascii=False))


def _handle_hint(task_id: str) -> dict[str, Any]:
    task = get_task(task_id)
    if task is None:
        return {"ok": False, "error": f"Unknown task '{task_id}'."}
    return {"ok": True, "hint": task["hint"]}


def _handle_test(task_id: str, user_code: str) -> dict[str, Any]:
    result = execute_code(task_id, user_code)

    # Match the notebook judge: a completed test run records either a solved
    # or attempted status. Parse and definition errors leave progress intact.
    if result.get("tests"):
        if result["success"]:
            mark_solved(task_id, result.get("total_time_ms", 0.0) / 1000)
        else:
            mark_attempted(task_id)

    return {"ok": True, "result": result}


def main() -> int:
    try:
        request = json.load(sys.stdin)
        action = request.get("action")
        task_id = request.get("task_id", "")

        if action == "hint":
            _reply(_handle_hint(task_id))
            return 0
        if action == "test":
            _reply(_handle_test(task_id, request.get("user_code", "")))
            return 0

        _reply({"ok": False, "error": f"Unknown action '{action}'."})
        return 0
    except Exception as exc:  # pragma: no cover - defensive boundary for the extension host
        _reply({"ok": False, "error": f"Judge runner failed: {type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
