from __future__ import annotations

import math
from typing import Any

from security_validation import EvidenceError


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _round(value: float, places: int = 0) -> float:
    return round(value, places)


def _as_list(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else []


def _event_data(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data")
    return data if isinstance(data, dict) else {}


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _cv(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = _mean(values)
    if not mean:
        return None
    variance = sum((item - mean) ** 2 for item in values) / len(values)
    return math.sqrt(variance) / mean


def build_features(report: dict[str, Any]) -> dict[str, Any]:
    session = report.get("session") or {}
    counters = report.get("counters") or {}
    events = _as_list(report.get("timeline"))
    strokes = _as_list(report.get("strokes"))
    changes = _as_list(report.get("structureChanges"))
    final_structure = report.get("finalStructure") or {}
    final_counts = final_structure.get("counts") if isinstance(final_structure, dict) else {}
    final_counts = final_counts if isinstance(final_counts, dict) else {}

    intervals = []
    for i in range(1, len(changes)):
        left = changes[i - 1].get("t")
        right = changes[i].get("t")
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            intervals.append(max(0, right - left))

    canvas_events = [
        event for event in events
        if event.get("type") in {"pointer_up", "click"} and bool(_event_data(event).get("canvas"))
    ]
    key_actions = [event for event in events if event.get("type") == "key_action"]
    import_events = [event for event in events if event.get("type") in {"import_blocked", "paste_attempt"}]
    canvas_strokes = [stroke for stroke in strokes if bool(stroke.get("canvas"))]
    drag_strokes = [
        stroke for stroke in canvas_strokes
        if (stroke.get("pathPx") or 0) >= 18
        and (stroke.get("durationMs") or 0) >= 100
        and len(stroke.get("points") or []) >= 4
    ]
    curved_strokes = [
        stroke for stroke in drag_strokes
        if (stroke.get("straightness") or 1) < 0.94 or (stroke.get("directionChanges") or 0) >= 2
    ]
    straight_strokes = [
        stroke for stroke in drag_strokes
        if (stroke.get("straightness") or 0) >= 0.985 and (stroke.get("directionChanges") or 0) == 0
    ]
    drag_speeds = [
        float(stroke.get("meanSpeedPxPerSec"))
        for stroke in drag_strokes
        if isinstance(stroke.get("meanSpeedPxPerSec"), (int, float)) and stroke.get("meanSpeedPxPerSec") > 0
    ]

    correction_intents = [
        event for event in events
        if event.get("type") == "key_action"
        and _event_data(event).get("action") in {"undo", "redo", "delete"}
    ]
    corrections = 0
    for intent in correction_intents:
        t = intent.get("t")
        if not isinstance(t, (int, float)):
            continue
        if any(isinstance(change.get("t"), (int, float)) and 0 <= change["t"] - t <= 3500 for change in changes):
            corrections += 1

    final_atoms = final_counts.get("atoms")
    final_bonds = final_counts.get("bonds")
    if not isinstance(final_atoms, (int, float)):
        final_atoms = 0
    if not isinstance(final_bonds, (int, float)):
        final_bonds = 0

    duration_ms = session.get("durationMs")
    if not isinstance(duration_ms, (int, float)):
        duration_ms = 0

    pointer_intervals = []
    for i in range(1, len(canvas_events)):
        left = canvas_events[i - 1].get("t")
        right = canvas_events[i].get("t")
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            pointer_intervals.append(max(0, right - left))

    return {
        "durationMs": int(duration_ms),
        "durationSec": _round(duration_ms / 1000, 1),
        "events": len(events),
        "structureChanges": len(changes),
        "finalAtoms": int(final_atoms),
        "finalBonds": int(final_bonds),
        "manualCanvasActions": len(canvas_events),
        "keyActions": len(key_actions),
        "corrections": corrections,
        "structureReductions": sum(1 for item in changes if item.get("action") == "reduce_structure"),
        "canvasStrokes": len(canvas_strokes),
        "dragStrokes": len(drag_strokes),
        "curvedStrokes": len(curved_strokes),
        "straightDragRatio": _round(len(straight_strokes) / len(drag_strokes), 3) if drag_strokes else 0,
        "dragSpeedCv": _round(_cv(drag_speeds), 3) if _cv(drag_speeds) is not None else None,
        "structureIntervalCv": _round(_cv(intervals), 3) if _cv(intervals) is not None else None,
        "pointerIntervals": len(pointer_intervals),
        "pointerIntervalCv": _round(_cv(pointer_intervals), 3) if _cv(pointer_intervals) is not None else None,
        "pointerMedianIntervalMs": sorted(pointer_intervals)[len(pointer_intervals) // 2] if pointer_intervals else None,
        "idleGaps": sum(1 for item in intervals if item > 2000),
        "blockedPaste": counters.get("blockedPaste", 0),
        "blockedImport": counters.get("blockedImport", 0),
        "importAttempts": len(import_events),
    }


def classify_report(report: dict[str, Any], *, replayed_raw_hash: bool = False) -> dict[str, Any]:
    if replayed_raw_hash:
        raise EvidenceError("behavior_replay", "Previously submitted evidence is not eligible for scoring")
    features = build_features(report)
    dimensions = {"construction": 5, "trajectory": 5, "rhythm": 5, "integrity": 3}
    limits = {"construction": 30, "trajectory": 25, "rhythm": 25, "integrity": 20}
    reasons: list[dict[str, Any]] = []

    def evidence(dimension: str, weight: int, code: str, message: str, message_zh: str) -> None:
        before = dimensions[dimension]
        dimensions[dimension] = int(_clamp(before + weight, 0, limits[dimension]))
        applied = dimensions[dimension] - before
        if applied:
            reasons.append({
                "code": code,
                "dimension": dimension,
                "weight": applied,
                "direction": "bot" if applied > 0 else "human",
                "message": message,
                "messageZh": message_zh,
            })

    if features["structureChanges"] >= 3 and features["canvasStrokes"] == 0:
        evidence(
            "trajectory",
            20,
            "no_pointer_trajectory",
            "There were multiple structure changes, but no usable canvas pointer trajectory.",
            "存在多次结构变化，但没有可用的画板指针轨迹。"
        )
    if features["finalAtoms"] >= 10 and features["durationSec"] < 5 and features["manualCanvasActions"] < 4:
        evidence(
            "construction",
            8,
            "implausibly_fast_construction",
            "A complex structure was completed very quickly with very few manual operations.",
            "复杂结构在极少手工操作下快速完成。"
        )
    if features["dragStrokes"] >= 4 and features["straightDragRatio"] >= 0.8 and features["dragSpeedCv"] is not None and features["dragSpeedCv"] < 0.1:
        evidence(
            "trajectory",
            8,
            "mechanical_drag_pattern",
            "Multiple drag paths and speeds are highly consistent, suggesting a mechanical trajectory.",
            "多次拖动的路径和速度高度一致，呈现机械轨迹。"
        )
    elif features["curvedStrokes"] >= 1 and features["dragSpeedCv"] is not None and features["dragSpeedCv"] > 0.2:
        evidence(
            "trajectory",
            -3,
            "natural_drag_variation",
            "Drag trajectories contain natural direction and speed variation.",
            "拖动轨迹存在方向与速度变化。"
        )
    if features["pointerIntervals"] >= 5 and features["pointerIntervalCv"] is not None:
        if features["pointerIntervalCv"] < 0.1:
            evidence(
                "rhythm",
                15,
                "highly_regular_pointer_timing",
                f"Consecutive canvas operations are highly regular (CV {features['pointerIntervalCv']}).",
                f"连续画板操作间隔高度规律（变异系数 {features['pointerIntervalCv']}）。"
            )
        elif features["pointerIntervalCv"] > 0.35:
            evidence(
                "rhythm",
                -3,
                "variable_pointer_timing",
                f"Canvas operation rhythm has natural variation (CV {features['pointerIntervalCv']}).",
                f"画板操作节奏具有自然波动（变异系数 {features['pointerIntervalCv']}）。"
            )
    if features["idleGaps"] >= 1:
        evidence(
            "rhythm",
            -2,
            "thinking_pauses",
            f"There were {features['idleGaps']} pauses longer than 2 seconds between structure edits.",
            f"结构编辑之间出现 {features['idleGaps']} 次超过 2 秒的停顿。"
        )
    if features["importAttempts"] > 0:
        evidence(
            "integrity",
            15 if features["importAttempts"] >= 2 else 9,
            "manual_only_violation",
            f"Blocked {features['importAttempts']} import, paste, drop, or API injection attempt(s).",
            f"拦截到 {features['importAttempts']} 次导入、粘贴、拖放或 API 注入尝试。"
        )
    if features["corrections"] >= 1:
        evidence(
            "integrity",
            -min(4, features["corrections"] * 2),
            "verified_correction_behavior",
            f"Confirmed {features['corrections']} correction operation(s), followed by actual structure changes.",
            f"确认 {features['corrections']} 次纠错操作，并且随后确实发生结构变化。"
        )

    insufficient = (
        features["finalAtoms"] == 0
        or features["structureChanges"] < 2
        or features["manualCanvasActions"] < 3
        or features["durationSec"] < 2
    )
    if insufficient:
        reasons.append({
            "code": "insufficient_behavior",
            "dimension": "coverage",
            "weight": 0,
            "direction": "neutral",
            "message": "The drawing steps or duration are insufficient, so this sample cannot reliably distinguish a human from automation.",
            "messageZh": "有效绘图步骤或持续时间不足，当前样本不能可靠区分人类与机器人。",
        })

    raw_score = sum(dimensions.values())
    score = max(50, raw_score) if insufficient and features["importAttempts"] > 0 else (50 if insufficient else int(_clamp(raw_score, 0, 100)))
    verdict = "uncertain" if insufficient else ("likely_bot" if score >= 60 else "uncertain" if score >= 30 else "likely_human")
    coverage = _clamp((features["structureChanges"] / 8) * 0.45 + (features["manualCanvasActions"] / 10) * 0.35 + (features["durationSec"] / 20) * 0.2, 0, 1)
    confidence = 20 if insufficient and features["importAttempts"] > 0 else (0 if insufficient else int(_clamp(35 + abs(score - 45) + coverage * 30, 0, 95)))

    return {
        "source": "server",
        "score": score,
        "verdict": verdict,
        "label": "Likely bot" if verdict == "likely_bot" else "Likely human" if verdict == "likely_human" else "Insufficient evidence",
        "labelZh": "疑似机器人" if verdict == "likely_bot" else "更像人类" if verdict == "likely_human" else "证据不足",
        "confidence": confidence,
        "policyStatus": "violation_blocked" if features["importAttempts"] > 0 else "manual_only_ok",
        "policyLabel": "Blocked prohibited import" if features["importAttempts"] > 0 else "Manual drawing only detected",
        "policyLabelZh": "已拦截违规导入" if features["importAttempts"] > 0 else "仅检测到手工绘图",
        "dimensions": dimensions,
        "reasons": reasons,
        "features": features,
    }
