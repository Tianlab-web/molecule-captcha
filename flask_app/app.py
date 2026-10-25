from __future__ import annotations

import json
import os
import re
import secrets
import time
from collections import deque
from threading import RLock
import sys
from datetime import datetime, timedelta, timezone
from functools import lru_cache, wraps
from io import BytesIO
from pathlib import Path
from typing import Any

from flask import Flask, abort, jsonify, request, send_file, send_from_directory, url_for
from rdkit import Chem
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.exceptions import HTTPException

# app.py 既可以作为脚本启动，也可以被测试模块导入。把项目根目录加入模块搜索路径，
# 这样两种启动方式都能稳定加载根目录下的“molecule_generator”包。
PROJECT_IMPORT_DIR = Path(__file__).resolve().parent.parent
if str(PROJECT_IMPORT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_IMPORT_DIR))

import config
import attention_check
from molecule_generator import generate_library
from rendering import render_test_image
from security_scoring import classify_report
from security_store import ReplayIndex
from security_validation import (EvidenceError, behavior_fingerprint, check_json,
    evidence_projection, finite, integer, obj, prefix_commitment, validate_final_report,
    validate_projection, verify_append_only, TIME_TOLERANCE_MS)


APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent
KETCHER_DIR = PROJECT_DIR / "ketcher"
APP_STATIC_DIR = APP_DIR / "static"
REPORT_DIR = Path(os.environ.get("MOLECULE_CAPTCHA_REPORT_DIR", APP_DIR / "data" / "reports"))
SMILES_SOURCE = APP_DIR / "data" / "smiles_pool.json"
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,100}$")
SERVER_SESSIONS: dict[str, dict[str, Any]] = {}
SERVER_CHALLENGES: dict[str, dict[str, Any]] = {}
BEIJING_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")

app = Flask(__name__, static_folder=None)
if config.TRUST_PROXY_HEADERS:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
app.json.ensure_ascii = False


STATE_LOCK = RLock()
OWNER_COOKIE = "molecule_captcha_owner"
RATE_BUCKETS = {}
REPLAY_INDEXES = {}


def locked(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
        with STATE_LOCK:
            return function(*args, **kwargs)
    return wrapper


def _safe_equal(left, right):
    return isinstance(left, str) and isinstance(right, str) and left.isascii() and right.isascii() and secrets.compare_digest(left, right)


def _require_owner(info):
    if not _safe_equal(info.get("owner"), request.cookies.get(OWNER_COOKIE)):
        abort(403, description="Challenge/session does not belong to this browser")


def _json_object():
    try:
        data = request.get_json(silent=False)
    except RecursionError:
        abort(400, description="JSON nesting limit exceeded")
    obj(data, "request")
    check_json(data)
    return data


def _rate_limit(bucket, maximum):
    now = time.monotonic()
    for key in list(RATE_BUCKETS):
        q = RATE_BUCKETS[key]
        while q and now-q[0] >= 60:
            q.popleft()
        if not q:
            RATE_BUCKETS.pop(key, None)
    for key, limit in (((request.remote_addr, bucket), maximum), (("*", bucket), maximum * 10)):
        if key not in RATE_BUCKETS and len(RATE_BUCKETS) >= 4096:
            abort(429, description="Too many clients; retry later")
        q = RATE_BUCKETS.setdefault(key, deque())
        if len(q) >= limit:
            abort(429, description="Too many attempts; retry later")
    RATE_BUCKETS[(request.remote_addr, bucket)].append(now)
    RATE_BUCKETS[("*", bucket)].append(now)


def _replay_index():
    key = str(REPORT_DIR.resolve())
    if key not in REPLAY_INDEXES:
        REPLAY_INDEXES[key] = ReplayIndex(REPORT_DIR)
    return REPLAY_INDEXES[key]


@app.before_request
def same_origin_api():
    if request.path.startswith("/api/") and request.method == "POST":
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
            abort(403, description="Cross-origin API requests are not allowed")


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.path.startswith(("/api/", "/app-static/")) or request.path in ("/", "/editor", "/monitor-config.js"):
        response.headers["Cache-Control"] = "no-store, private"
    return response


@app.errorhandler(EvidenceError)
def evidence_error(error):
    messages = {
        "unlinked_structure_change": "绘图记录中存在未关联到手动操作的结构变化，请换一题重试。",
        "frame_counts_mismatch": "回放记录的原子或化学键数量不同步，未完成结构校验。",
        "final_structure_mismatch": "最终结构与回放记录不同步，未完成结构校验。",
        "broken_structure_history": "绘图记录不连续，未完成结构校验。",
        "missing_trajectory": "绘图记录缺少对应的指针轨迹，未完成结构校验。",
        "checkpoint_gap": "绘图记录上传中断时间过长，请检查网络后重试。",
        "drawing_changed_after_completion": "点击完成后结构又发生变化，请换一题重试。",
    }
    return jsonify(ok=False, accepted=False, error=error.code, message=str(error),
                   messageZh=messages.get(error.code, "绘图记录校验失败，请换一题重新检测。")), 422


@app.errorhandler(HTTPException)
def http_error(error):
    if request.path.startswith("/api/"):
        response = jsonify(ok=False, accepted=False, error=error.name, message=error.description)
        response.status_code = error.code
        if error.code == 429:
            response.headers["Retry-After"] = "60"
        return response
    return error


def _beijing_now() -> datetime:
    """返回带 ``+08:00`` 时区信息的北京时间。"""
    return datetime.now(BEIJING_TIMEZONE)


def _cleanup_sessions() -> None:
    now_ts = _beijing_now().timestamp()
    for session_id, info in list(SERVER_SESSIONS.items()):
        check = info.get("attention")
        if check:
            previous_status = check["status"]
            attention_check.expire(check, now_ts)
            if check["status"] != previous_status:
                _save_attention_audit(session_id, info)
        if info.get("used") or float(info.get("expiresAtTs", 0)) < now_ts:
            SERVER_SESSIONS.pop(session_id, None)
            challenge_id = info.get("challengeId")
            challenge = SERVER_CHALLENGES.get(challenge_id)
            if challenge and challenge.get("sessionId") == session_id:
                SERVER_CHALLENGES.pop(challenge_id, None)
    for challenge_id, info in list(SERVER_CHALLENGES.items()):
        if float(info.get("expiresAtTs", 0)) < now_ts:
            SERVER_CHALLENGES.pop(challenge_id, None)


def _canonical_smiles(smiles: Any) -> str | None:
    if not isinstance(smiles, str) or not smiles.strip():
        return None
    molecule = Chem.MolFromSmiles(smiles.strip())
    if molecule is None:
        return None
    return Chem.MolToSmiles(molecule, canonical=True, isomericSmiles=True)


def _load_challenge_pool() -> list[tuple[str, str]]:
    try:
        data = json.loads(SMILES_SOURCE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Cannot load test SMILES: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("The SMILES pool must be a JSON object")
    valid = [(str(key), value) for key, value in data.items() if _canonical_smiles(value)]
    if not valid:
        raise RuntimeError("The SMILES pool has no valid molecules")
    return valid


@lru_cache(maxsize=8)
def _load_generated_pool(
    heavy_atoms: int,
    max_hetero_atoms: int,
    allow_single_ring: bool,
) -> tuple[str, ...]:
    """生成并缓存一组合法 SMILES，避免每次换题都重新枚举。"""
    generated = generate_library(
        heavy_atoms=heavy_atoms,
        max_hetero_atoms=max_hetero_atoms,
        allow_single_ring=allow_single_ring,
    )
    valid = tuple(smiles for smiles in generated if _canonical_smiles(smiles))
    if not valid:
        raise RuntimeError("The automatic molecule generator returned no valid molecules")
    return valid


def _choose_challenge_molecule(source_type: str) -> tuple[str, str]:
    """按前端选择，从文件分子库或自动生成器中安全地随机取题。"""
    if source_type == "library":
        pool = _load_challenge_pool()
        source_key, smiles = pool[secrets.randbelow(len(pool))]
        return str(source_key), smiles

    if source_type == "generated":
        atom_options = tuple(config.AUTO_GENERATOR_HEAVY_ATOMS)
        if not atom_options or any(not isinstance(value, int) or value < 1 for value in atom_options):
            raise RuntimeError("AUTO_GENERATOR_HEAVY_ATOMS must contain positive integers")
        heavy_atoms = atom_options[secrets.randbelow(len(atom_options))]
        pool = _load_generated_pool(
            heavy_atoms,
            config.AUTO_GENERATOR_MAX_HETERO_ATOMS,
            config.AUTO_GENERATOR_ALLOW_SINGLE_RING,
        )
        smiles = pool[secrets.randbelow(len(pool))]
        return f"generated-{heavy_atoms}", smiles

    abort(400, description="source must be 'library' or 'generated'")


def _report_path(session_id: str) -> Path:
    if not SESSION_ID_RE.fullmatch(session_id):
        abort(400, description="Invalid session id")
    return REPORT_DIR / f"{session_id}.json"


def _validate_report_session(report: dict[str, Any], session_id: str) -> dict[str, Any]:
    security = report.get("security")
    if not isinstance(security, dict):
        abort(403, description="Missing server-issued session token")
    if str(security.get("sessionId") or "") != session_id:
        abort(403, description="Session token does not match report session")

    _cleanup_sessions()
    info = SERVER_SESSIONS.get(session_id)
    if not info:
        abort(403, description="Session token is unknown or expired")
    if info.get("used"):
        abort(403, description="Session token was already used")
    if not _safe_equal(info.get("token"), security.get("token")):
        abort(403, description="Invalid session token")
    if float(info.get("expiresAtTs", 0)) < _beijing_now().timestamp():
        SERVER_SESSIONS.pop(session_id, None)
        abort(403, description="Session token expired")
    _require_owner(info)
    return info


def _verify_challenge(report: dict[str, Any], issued_session: dict[str, Any]) -> dict[str, Any]:
    final_structure = report.get("finalStructure")
    submitted = final_structure.get("smiles") if isinstance(final_structure, dict) else None
    actual = _canonical_smiles(submitted)
    expected = issued_session.get("targetCanonicalSmiles")
    matched = bool(expected and actual and secrets.compare_digest(str(expected), actual))
    if not actual:
        status = "empty_or_invalid"
        message = "No valid final structure was submitted."
        message_zh = "未提交有效的最终结构。"
    elif matched:
        status = "matched"
        message = "The drawn structure matches the test image."
        message_zh = "绘制结构与测试图片一致。"
    else:
        status = "mismatched"
        message = "The drawn structure does not match the test image."
        message_zh = "绘制结构与测试图片不一致。"
    return {
        "challengeId": issued_session.get("challengeId"),
        "matched": matched,
        "status": status,
        "message": message,
        "messageZh": message_zh,
    }


@app.get("/")
def index():
    return send_from_directory(APP_STATIC_DIR, "challenge.html")


@app.get("/healthz")
def healthz():
    return jsonify({"status": "ok", "smilesPool": len(_load_challenge_pool())})


@app.get("/editor")
def editor():
    html = (KETCHER_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace("</head>", '<script src="app-static/attention-check.js?v=4"></script><link rel="stylesheet" href="app-static/attention-check.css?v=3"></head>')
    atom_config = dict(initialProbability=config.ATOM_SURPRISE_INITIAL_PROBABILITY,
                       increment=config.ATOM_SURPRISE_INCREMENT,
                       firstForceAt=config.ATOM_SURPRISE_FIRST_FORCE_AT,
                       repeatProbability=config.ATOM_SURPRISE_REPEAT_PROBABILITY,
                       maxProbability=config.ATOM_SURPRISE_MAX_PROBABILITY,
                       cooldownSteps=config.ATOM_SURPRISE_COOLDOWN_STEPS)
    html = html.replace("<head>", "<head><script>window.KETCHER_ATOM_SURPRISE_CONFIG=" +
                        json.dumps(atom_config, allow_nan=False) + ";</script>", 1)
    return html


@app.get("/monitor-config.js")
def monitor_config():
    return send_from_directory(APP_STATIC_DIR, "monitor-config.js", mimetype="application/javascript")


@app.get("/app-static/<path:filename>")
def app_static(filename: str):
    return send_from_directory(APP_STATIC_DIR, filename)


@app.post("/api/challenges")
@locked
def create_challenge():
    _rate_limit("challenge", config.CHALLENGES_PER_MINUTE)
    _cleanup_sessions()
    if len(SERVER_CHALLENGES) >= config.MAX_ACTIVE_CHALLENGES:
        abort(429, description="Too many active challenges; retry later")
    payload = _json_object()
    source_type = str(payload.get("source") or "library").strip().lower()
    language = "zh" if payload.get("language") == "zh" else "en"
    try:
        source_key, smiles = _choose_challenge_molecule(source_type)
    except RuntimeError as exc:
        abort(503, description=str(exc))
    challenge_id = secrets.token_urlsafe(24)
    now = _beijing_now()
    expires_at_ts = now.timestamp() + config.SESSION_TTL_SECONDS
    rendered = render_test_image(smiles, seed=secrets.randbits(32))
    owner = request.cookies.get(OWNER_COOKIE)
    if not owner or not SESSION_ID_RE.fullmatch(owner):
        owner = secrets.token_urlsafe(32)
    SERVER_CHALLENGES[challenge_id] = {
        "owner": owner,
        "sourceKey": source_key,
        "sourceType": source_type,
        "language": language,
        "targetCanonicalSmiles": _canonical_smiles(smiles),
        "heavyAtomCount": Chem.MolFromSmiles(smiles).GetNumHeavyAtoms(),
        "image": rendered.data,
        "imageMimetype": rendered.mimetype,
        "imageExtension": rendered.extension,
        "createdAt": now.isoformat(),
        "expiresAtTs": expires_at_ts,
        "sessionId": None,
    }
    response = jsonify({
        "ok": True,
        "challengeId": challenge_id,
        "imageUrl": url_for("challenge_image", challenge_id=challenge_id),
        "source": source_type,
        "expiresAt": datetime.fromtimestamp(expires_at_ts, BEIJING_TIMEZONE).isoformat(),
    })
    response.set_cookie(OWNER_COOKIE, owner, httponly=True, secure=request.is_secure,
                        samesite="Strict", path=request.script_root or "/", max_age=config.SESSION_TTL_SECONDS)
    return response


@app.get("/api/challenges/<challenge_id>/image")
@locked
def challenge_image(challenge_id: str):
    _cleanup_sessions()
    info = SERVER_CHALLENGES.get(challenge_id)
    if not info:
        abort(404)
    _require_owner(info)
    response = send_file(
        BytesIO(info["image"]),
        mimetype=info["imageMimetype"],
        download_name=f"molecule-test.{info['imageExtension']}",
        max_age=0,
    )
    response.headers["Cache-Control"] = "no-store, private"
    return response


@app.post("/api/sessions")
@locked
def create_detection_session():
    _rate_limit("session", config.SESSIONS_PER_MINUTE)
    _cleanup_sessions()
    if len(SERVER_SESSIONS) >= config.MAX_ACTIVE_SESSIONS:
        abort(429, description="Too many active sessions; retry later")
    payload = _json_object()
    challenge_id = str(payload.get("challengeId") or "")
    challenge = SERVER_CHALLENGES.get(challenge_id)
    if not challenge:
        abort(400, description="A valid challengeId is required")
    _require_owner(challenge)
    if challenge.get("sessionId"):
        abort(409, description="This test is already bound to a detection session")

    session_id = secrets.token_urlsafe(18)
    token = secrets.token_urlsafe(32)
    now = _beijing_now()
    expires_at_ts = now.timestamp() + config.SESSION_TTL_SECONDS
    expires_at = datetime.fromtimestamp(expires_at_ts, BEIJING_TIMEZONE)
    nonce = secrets.token_urlsafe(24)
    attention = attention_check.new_check(now.timestamp(), language=challenge["language"])
    SERVER_SESSIONS[session_id] = {
        "owner": challenge["owner"],
        "attention": attention,
        "createdAtTs": now.timestamp(),
        "drawingLimitSeconds": max(0, config.DRAWING_REFERENCE_SECONDS +
            (challenge["heavyAtomCount"] - config.DRAWING_REFERENCE_HEAVY_ATOMS) * config.DRAWING_SECONDS_PER_ATOM),
        "drawingMinSeconds": config.DRAWING_MIN_SECONDS,
        "ttlMs": config.SESSION_TTL_SECONDS * 1000,
        "progress": {"nonce": nonce, "sequence": 0, "commitments": {}, "count": 0, "sealed": False},
        "token": token,
        "createdAt": now.isoformat(),
        "expiresAt": expires_at.isoformat(),
        "expiresAtTs": expires_at_ts,
        "remoteAddress": request.remote_addr,
        "challengeId": challenge_id,
        "targetCanonicalSmiles": challenge.get("targetCanonicalSmiles"),
        "used": False,
    }
    challenge["sessionId"] = session_id
    _save_attention_audit(session_id, SERVER_SESSIONS[session_id])
    response = jsonify({
        "ok": True,
        "sessionId": session_id,
        "token": token,
        "protocolVersion": 3,
        "drawingRemainingMs": max(0, round((SERVER_SESSIONS[session_id]["drawingLimitSeconds"] -
            (_beijing_now().timestamp() - now.timestamp())) * 1000)),
        "attentionRequired": True,
        "attentionVersion": 3,
        "checkpointNonce": nonce,
        "checkpointIntervalMs": config.CHECKPOINT_INTERVAL_MS,
        "startedAt": now.isoformat(),
        "expiresAt": expires_at.isoformat(),
    })
    response.set_cookie(OWNER_COOKIE, challenge["owner"], httponly=True, secure=request.is_secure,
                        samesite="Strict", path=request.script_root or "/", max_age=config.SESSION_TTL_SECONDS)
    return response


def _drawing_time_verification(issued, now_ts):
    # Only server receipt times decide the result. Never trust report.durationMs.
    completion = issued.get("drawingCompletion")
    end = completion["receivedAtTs"] if completion else now_ts
    elapsed = max(0, end - issued["createdAtTs"])
    if elapsed > issued["drawingLimitSeconds"]:
        status, message, zh = "timeout", "Drawing time exceeded; verification failed", "绘制超时，未通过验证"
        reason = "The drawing took longer than allowed for this question. Verification failed."
        reason_zh = "绘制超时：完成绘制时已超过本题允许的时间，本次未通过验证。"
    elif elapsed <= issued["drawingMinSeconds"]:
        status, message, zh = "too_fast", "Operation too fast; verification failed", "操作过快，未通过验证"
        reason = "The drawing was completed too quickly and classified as a bot by policy. Verification failed."
        reason_zh = "操作过快：完成绘制的用时过短，按规则判定为机器人，本次未通过验证。"
    else:
        status, message, zh = "passed", "Drawing time check passed", "绘制时间校验通过"
        reason, reason_zh = message, zh
    return dict(passed=status == "passed", status=status, elapsedMs=round(elapsed * 1000),
                message=message, messageZh=zh, reason=reason, reasonZh=reason_zh)


@app.post("/api/sessions/<session_id>/completion")
@locked
def complete_drawing(session_id):
    payload = _json_object()
    issued = _validate_report_session({"security": {"sessionId": session_id, "token": payload.get("token")}}, session_id)
    received_at = _beijing_now().timestamp()
    if "drawingCompletion" not in issued:
        smiles = payload.get("smiles")
        if not isinstance(smiles, str) or len(smiles) > 10000:
            raise EvidenceError("invalid_final_structure", "Completion SMILES must be a bounded string")
        issued["drawingCompletion"] = dict(receivedAtTs=received_at, canonicalSmiles=_canonical_smiles(smiles))
    return jsonify(ok=True, timeVerification=_drawing_time_verification(issued, received_at))


def _write_report(session_id, report):
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    target = _report_path(session_id)
    temp = target.with_suffix(".json.tmp")
    temp.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    os.replace(temp, target)


def _drawing_time_failure(session_id, issued, verification, now):
    # A timing rejection never claims that the submitted drawing evidence is valid.
    too_fast = verification["status"] == "too_fast"
    classification = dict(source="server", verdict="likely_bot" if too_fast else "uncertain",
        score=100 if too_fast else 50, confidence=99 if too_fast else 0, hardFailure=True,
        label=verification["message"], labelZh=verification["messageZh"],
        policyStatus="drawing_" + verification["status"], policyLabel=verification["message"],
        policyLabelZh=verification["messageZh"], features={"durationSec": verification["elapsedMs"] / 1000},
        reasons=[dict(code="drawing_" + verification["status"], dimension="integrity",
            direction="bot" if too_fast else "neutral", weight=100 if too_fast else 0,
            message=verification["reason"], messageZh=verification["reasonZh"])])
    result = dict(ok=True, sessionId=session_id, accepted=False, classification=classification,
        timeVerification=verification, protocolVersion=3,
        challengeVerification=dict(matched=False, status="not_checked", message=verification["message"], messageZh=verification["messageZh"]))
    audit = dict(result, security=dict(sessionId=session_id, verifiedByServer=True),
        server=dict(receivedAt=now.isoformat(), sessionCreatedAt=issued["createdAt"], evidenceValidated=False))
    _write_report(session_id, audit)
    return jsonify(result)


def _save_attention_audit(session_id, issued):
    directory = REPORT_DIR / "attention"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (session_id + ".json")
    data = {"sessionId": session_id, "moleculeChallengeId": issued["challengeId"],
            "createdAt": issued["createdAt"], "attention": attention_check.audit(issued["attention"])}
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, target)


@app.post("/api/sessions/<session_id>/attention")
@locked
def session_attention(session_id):
    payload = _json_object()
    issued = _validate_report_session({"security": {"sessionId": session_id, "token": payload.get("token")}}, session_id)
    check = issued["attention"]
    before = check["status"]
    check["requests"] = check.get("requests", 0) + 1
    if check["requests"] > 64:
        abort(429, description="Too many attention requests")
    try:
        result = attention_check.advance(check, issued, payload, _beijing_now().timestamp(), _safe_equal)
    finally:
        if check["status"] != before:
            _save_attention_audit(session_id, issued)
    return jsonify(result)


@app.post("/api/sessions/<session_id>/checkpoints")
@locked
def receive_checkpoint(session_id: str):
    payload = _json_object()
    issued = _validate_report_session({"security": {"sessionId": session_id, "token": payload.get("token")}}, session_id)
    progress = issued["progress"]
    if progress.get("sealed") or progress.get("failed"):
        abort(409, description="This evidence stream is closed")
    sequence = integer(payload.get("sequence"), "sequence", config.MAX_CHECKPOINTS)
    if sequence != progress["sequence"] or not _safe_equal(payload.get("nonce"), progress["nonce"]):
        abort(409, description="Invalid or already used checkpoint receipt")
    now_ts = _beijing_now().timestamp()
    elapsed = finite(payload.get("elapsedMs"), "elapsedMs", high=issued["ttlMs"])
    observed = (now_ts - issued["createdAtTs"]) * 1000
    if elapsed > observed + TIME_TOLERANCE_MS:
        raise EvidenceError("impossible_duration", "Checkpoint time exceeds server-observed lifetime")
    if elapsed < progress.get("elapsedMs", 0):
        raise EvidenceError("invalid_timeline", "Checkpoint time went backwards")
    evidence = validate_projection(payload.get("evidence"), elapsed)
    final = payload.get("final")
    if not isinstance(final, bool):
        raise EvidenceError("invalid_shape", "final must be a boolean")
    if progress["count"] == 0:
        frames = evidence["frames"]
        if final or evidence["strokes"] or evidence["structureChanges"] or len(frames) != 1 or frames[0].get("molfile") != "":
            raise EvidenceError("missing_initial_checkpoint", "Start with a blank-canvas checkpoint before drawing")
        if any(e.get("type") not in ("session_started", "monitor_ready") for e in evidence["timeline"]):
            raise EvidenceError("invalid_initial_checkpoint", "Drawing cannot precede the initial checkpoint")
        progress["firstReceivedAt"] = now_ts
    else:
        verify_append_only(evidence, progress["commitments"])
        if now_ts - progress["receivedAt"] > config.CHECKPOINT_MAX_GAP_SECONDS:
            raise EvidenceError("checkpoint_gap", "Drawing evidence was not received in time; start a new test")
        # Newly committed observations cannot be backfilled arbitrarily late.
        for name, items in evidence.items():
            old_count = progress["commitments"][name]["count"]
            for item in items[old_count:]:
                t = item.get("startedAt" if name == "strokes" else "t", 0)
                if name == "strokes" and item.get("points"):
                    t += item["points"][-1]["dt"]
                if t < progress.get("elapsedMs", 0) - config.CHECKPOINT_MAX_GAP_SECONDS * 1000:
                    raise EvidenceError("late_evidence", "Cannot backfill old drawing evidence")
    if progress["count"] >= config.MAX_CHECKPOINTS:
        abort(429, description="Too many checkpoints")
    # Finalization is allowed only after a previously received live checkpoint.
    if final and evidence["structureChanges"] and not progress["commitments"].get("structureChanges", {}).get("count"):
        raise EvidenceError("missing_live_structure", "Drawing changes must be committed before the final checkpoint")
    if final and (progress["count"] < 2 or now_ts - progress["firstReceivedAt"] < 2):
        raise EvidenceError("missing_live_evidence", "Live drawing checkpoints are required before finishing")
    if not final and progress["count"] and now_ts - progress["receivedAt"] < 0.25:
        abort(429, description="Checkpoints are arriving too quickly")
    if attention_check.commit_evidence(issued["attention"], evidence["timeline"], now_ts):
        _save_attention_audit(session_id, issued)
    progress.update(commitments=prefix_commitment(evidence), elapsedMs=elapsed,
                    receivedAt=now_ts, count=progress["count"] + 1,
                    sequence=progress["sequence"] + 1, nonce=secrets.token_urlsafe(24), sealed=final)
    return jsonify(ok=True, sequence=progress["sequence"], nonce=progress["nonce"], sealed=final)


@app.post("/api/reports")
@locked
def save_report():
    report = _json_object()
    session = obj(report.get("session"), "session")
    session_id = session.get("id")
    if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
        abort(400, description="Invalid session.id")
    issued = _validate_report_session(report, session_id)
    # A valid token buys one final attempt, including invalid evidence.
    issued["used"] = True
    now = _beijing_now()
    timing = _drawing_time_verification(issued, now.timestamp())
    if not timing["passed"]:
        return _drawing_time_failure(session_id, issued, timing, now)
    normalized = validate_final_report(report, issued, now.timestamp())
    completion = issued.get("drawingCompletion")
    if completion and completion["canonicalSmiles"] != _canonical_smiles(normalized["finalStructure"]["smiles"]):
        raise EvidenceError("drawing_changed_after_completion", "Drawing changed after completion was recorded")
    if completion and any(change["t"] > timing["elapsedMs"] + TIME_TOLERANCE_MS
                          for change in normalized["structureChanges"]):
        raise EvidenceError("drawing_changed_after_completion", "Drawing continued after completion was recorded")
    progress = issued["progress"]
    receipt = obj(report.get("security", {}).get("checkpoint"), "security.checkpoint")
    if not progress.get("sealed") or progress.get("failed") or progress["count"] < 3:
        raise EvidenceError("missing_live_evidence", "No completed live evidence stream exists for this session")
    if receipt.get("sequence") != progress["sequence"] or not _safe_equal(receipt.get("nonce"), progress["nonce"]):
        raise EvidenceError("invalid_receipt", "The final checkpoint receipt is invalid")
    if now.timestamp() - progress["receivedAt"] > config.CHECKPOINT_MAX_GAP_SECONDS:
        raise EvidenceError("expired_receipt", "The final checkpoint receipt expired")
    if abs(report["session"]["durationMs"] - progress["elapsedMs"]) > 5:
        raise EvidenceError("duration_mismatch", "Report duration differs from sealed evidence")
    projection = evidence_projection(report)
    if prefix_commitment(projection) != progress["commitments"]:
        raise EvidenceError("evidence_rewritten", "Report evidence differs from the sealed checkpoints")
    fingerprint = behavior_fingerprint(report)
    # Empty attempts are not fingerprinted: they are common and never pass.
    if report["structureChanges"] and not _replay_index().claim(fingerprint, session_id):
        raise EvidenceError("behavior_replay", "Drawing history was already submitted in another session")
    report["strokes"] = normalized["strokes"]
    report["replay"]["strokes"] = normalized["strokes"]
    report["counters"] = normalized["counters"]
    report["finalStructure"]["counts"] = normalized["finalStructure"]["counts"]
    report["clientClassification"] = report.get("classification")
    report["classification"] = classify_report(normalized)
    report["challengeVerification"] = _verify_challenge(normalized, issued)
    report["attentionVerification"] = attention_check.verify(issued["attention"], report["timeline"], now.timestamp())
    _save_attention_audit(session_id, issued)
    if not report["attentionVerification"]["passed"]:
        classification = report["classification"]
        classification.update(verdict="likely_bot", score=100, confidence=99, hardFailure=True,
                              label="Bot: timed click failed", labelZh="机器人：限时点击未通过",
                              policyStatus="attention_check_failed", policyLabel="Timed click required",
                              policyLabelZh="限时点击验证未通过")
        classification["reasons"].insert(0, {"code": "attention_check_failed", "dimension": "integrity",
            "direction": "bot", "weight": 100, "message": report["attentionVerification"]["message"],
            "messageZh": report["attentionVerification"]["messageZh"]})
    report["timeVerification"] = timing
    report["accepted"] = (report["attentionVerification"]["passed"] and report["challengeVerification"]["matched"] and
                          report["classification"]["verdict"] == "likely_human" and
                          report["classification"]["policyStatus"] == "manual_only_ok")
    report["security"] = {"sessionId": session_id, "startedAt": issued["createdAt"],
                          "expiresAt": issued["expiresAt"], "verifiedByServer": True,
                          "protocolVersion": 3, "checkpointCount": progress["count"]}
    report["server"] = {"receivedAt": now.isoformat(), "remoteAddress": request.remote_addr,
                        "sessionCreatedAt": issued["createdAt"], "classificationSource": "server",
                        "evidenceValidated": True, "behaviorHash": fingerprint,
                        "observedDurationMs": round((now.timestamp()-issued["createdAtTs"])*1000),
                        "note": "Consistent client evidence is not proof of a human operator."}
    _write_report(session_id, report)
    return jsonify(ok=True, sessionId=session_id, accepted=report["accepted"],
                   timeVerification=timing, attentionVerification=report["attentionVerification"], classification=report["classification"],
                   challengeVerification=report["challengeVerification"], protocolVersion=3)


@app.get("/<path:filename>")
def ketcher_asset(filename: str):
    return send_from_directory(KETCHER_DIR, filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=config.PORT, debug=False)
