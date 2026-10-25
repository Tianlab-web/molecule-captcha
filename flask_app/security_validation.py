"""Validate untrusted drawing evidence; consistency is NOT proof of a human.

The streaming protocol constrains when evidence was received and makes it
append-only. A client that fabricates a coherent stream in real time can still
imitate it; browser attestation is deliberately not claimed here.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from datetime import datetime
from typing import Any

from rdkit import Chem

MAX_EVENTS = 12000
MAX_STROKES = 3000
MAX_CHANGES = 3000
MAX_FRAMES = 3002
MAX_POINTS = 500
MAX_ATOMS = 512
MAX_BONDS = 1024
TIME_TOLERANCE_MS = 1500


class EvidenceError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    raise EvidenceError(code, message)


def finite(value: Any, name: str, low=0, high=3600000) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        fail('invalid_number', f'{name} must be a finite number in [{low}, {high}]')
    return value


def integer(value: Any, name: str, high=MAX_EVENTS) -> int:
    finite(value, name, high=high)
    if int(value) != value:
        fail('invalid_number', f'{name} must be an integer')
    return int(value)


def obj(value: Any, name: str) -> dict:
    if not isinstance(value, dict):
        fail('invalid_shape', f'{name} must be an object')
    return value


def array(value: Any, name: str, limit: int) -> list:
    if not isinstance(value, list) or len(value) > limit:
        fail('invalid_shape', f'{name} must be an array with at most {limit} entries')
    for item in value:
        obj(item, name + '[]')
    return value


def check_json(value: Any, depth=0) -> None:
    if depth > 24:
        fail('invalid_shape', 'JSON nesting limit exceeded')
    if isinstance(value, float) and not math.isfinite(value):
        fail('invalid_number', 'NaN and Infinity are forbidden')
    if isinstance(value, str) and len(value) > 200000:
        fail('invalid_shape', 'String limit exceeded')
    if isinstance(value, dict):
        if len(value) > 200:
            fail('invalid_shape', 'Object field limit exceeded')
        for key, child in value.items():
            if len(key) > 100:
                fail('invalid_shape', 'Object key limit exceeded')
            check_json(child, depth + 1)
    elif isinstance(value, list):
        if len(value) > 25000:
            fail('invalid_shape', 'Array limit exceeded')
        for child in value:
            check_json(child, depth + 1)


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def evidence_projection(report: dict) -> dict[str, list]:
    """Only immutable observations, not recomputed attribution/score fields."""
    replay = obj(report.get('replay'), 'replay')
    specs = {
        'timeline': (report.get('timeline'), MAX_EVENTS, ('t', 'type', 'data')),
        'strokes': (report.get('strokes'), MAX_STROKES, ('startedAt', 'pointerType', 'button', 'target', 'canvas', 'points', 'cancelled')),
        'structureChanges': (report.get('structureChanges'), MAX_CHANGES, ('t', 'action', 'source', 'before', 'after')),
        'frames': (replay.get('frames'), MAX_FRAMES, ('t', 'action', 'atoms', 'bonds', 'molfile')),
        'pointerTrail': (replay.get('pointerTrail'), 25000, ('t', 'x', 'y', 'target', 'canvas', 'kind', 'pointerType', 'buttons')),
    }
    return {name: [{k: item[k] for k in keys if k in item} for item in array(items, name, limit)]
            for name, (items, limit, keys) in specs.items()}


def validate_projection(evidence: Any, elapsed: float) -> dict:
    evidence = obj(evidence, 'evidence')
    limits = {'timeline': MAX_EVENTS, 'strokes': MAX_STROKES, 'structureChanges': MAX_CHANGES,
              'frames': MAX_FRAMES, 'pointerTrail': 25000}
    if set(evidence) != set(limits):
        fail('invalid_shape', 'Checkpoint evidence has unexpected fields')
    for name, limit in limits.items():
        previous = -1
        for entry in array(evidence.get(name), name, limit):
            t = finite(entry.get('startedAt' if name == 'strokes' else 't'), name + '.t', high=elapsed + 5)
            if t < previous:
                fail('invalid_timeline', f'{name} must be ordered by time')
            previous = t
            if name == 'strokes':
                points = array(entry.get('points'), 'stroke.points', MAX_POINTS)
                last_dt = -1
                for point in points:
                    dt = finite(point.get('dt'), 'point.dt', high=elapsed - t + 5)
                    if dt < last_dt:
                        fail('invalid_timeline', 'Stroke points must be ordered')
                    last_dt = dt
                    finite(point.get('x'), 'point.x', -100000, 100000)
                    finite(point.get('y'), 'point.y', -100000, 100000)
                if not isinstance(entry.get('canvas'), bool):
                    fail('invalid_shape', 'stroke.canvas must be boolean')
            elif name == 'timeline':
                if not isinstance(entry.get('type'), str):
                    fail('invalid_shape', 'event.type must be a string')
                data = obj(entry.get('data'), 'event.data')
                if 'canvas' in data and not isinstance(data['canvas'], bool):
                    fail('invalid_shape', 'event.data.canvas must be boolean')
    return evidence


def prefix_commitment(evidence: dict) -> dict:
    return {name: {'count': len(items), 'hash': digest(items)} for name, items in evidence.items()}


def verify_append_only(evidence: dict, previous: dict) -> None:
    for name, commit in previous.items():
        items = evidence[name]
        n = commit['count']
        if len(items) < n or digest(items[:n]) != commit['hash']:
            fail('evidence_rewritten', 'Previously received evidence cannot be replaced or removed')


def counts(snapshot: Any, label: str) -> tuple[int, int]:
    snapshot = obj(snapshot, label)
    return (integer(snapshot.get('atoms'), label + '.atoms', MAX_ATOMS),
            integer(snapshot.get('bonds'), label + '.bonds', MAX_BONDS))


def mol_from_frame(frame: dict):
    raw = frame.get('molfile')
    if not isinstance(raw, str) or len(raw) > 200000:
        fail('invalid_structure_history', 'Replay molfile is missing or too large')
    if not raw.strip():
        return None
    mol = Chem.MolFromMolBlock(raw, sanitize=False, removeHs=False, strictParsing=True)
    if mol is None or mol.GetNumAtoms() > MAX_ATOMS or mol.GetNumBonds() > MAX_BONDS:
        fail('invalid_structure_history', 'Invalid replay molfile')
    return mol


def canonical_mol(mol) -> str:
    if mol is None or mol.GetNumAtoms() == 0:
        return ''
    try:
        mol = Chem.RemoveHs(Chem.Mol(mol))
        Chem.SanitizeMol(mol)
        return Chem.MolToSmiles(mol, canonical=True, isomericSmiles=True)
    except Exception:
        fail('invalid_final_structure', 'Final replay structure is chemically invalid')


def validate_final_report(report: dict, issued: dict, now_ts: float) -> dict:
    """Return a normalized copy for scoring. Never trust submitted summaries."""
    check_json(report)
    obj(report, 'report')
    session = obj(report.get('session'), 'session')
    if report.get('schemaVersion') != 3:
        fail('protocol_upgrade_required', 'Reload the editor to use security protocol v3')
    duration = finite(session.get('durationMs'), 'session.durationMs', high=issued['ttlMs'])
    server_elapsed = max(0, (now_ts - issued['createdAtTs']) * 1000)
    if duration > server_elapsed + TIME_TOLERANCE_MS:
        fail('impossible_duration', 'Drawing duration exceeds the server-observed session lifetime')
    if session.get('startedAt') != issued['createdAt']:
        fail('invalid_session_time', 'Session start must match the server-issued start')
    try:
        end = datetime.fromisoformat(session.get('endedAt', ''))
        if end.tzinfo is None:
            raise ValueError()
    except (ValueError, TypeError):
        fail('invalid_session_time', 'endedAt must include a timezone')
    evidence = validate_projection(evidence_projection(report), duration)
    frames = evidence['frames']
    changes = evidence['structureChanges']
    if not frames or frames[0].get('action') != 'initial' or frames[0].get('t') != 0 or counts(frames[0], 'initial') != (0, 0):
        fail('missing_initial_frame', 'The drawing history must start with an empty canvas')
    if mol_from_frame(frames[0]) is not None:
        fail('invalid_initial_frame', 'The initial canvas must be empty')
    frame_counts = []
    last_mol = None
    for frame in frames:
        mol = mol_from_frame(frame)
        actual = (mol.GetNumAtoms(), mol.GetNumBonds()) if mol is not None else (0, 0)
        if counts(frame, 'frame') != actual:
            fail('frame_counts_mismatch', 'Replay atom/bond counts disagree with its molfile')
        frame_counts.append(actual)
        last_mol = mol
    final = obj(report.get('finalStructure'), 'finalStructure')
    smiles = final.get('smiles')
    if not isinstance(smiles, str) or len(smiles) > 10000:
        fail('invalid_final_structure', 'Final SMILES is missing or too long')
    parsed = Chem.MolFromSmiles(smiles) if smiles.strip() else None
    if smiles.strip() and parsed is None:
        fail('invalid_final_structure', 'Invalid final SMILES')
    actual_canonical = canonical_mol(parsed)
    if canonical_mol(last_mol) != actual_canonical:
        fail('final_structure_mismatch', 'Final SMILES and the last replay molfile describe different molecules')
    if counts(final.get('counts'), 'final.counts') != frame_counts[-1]:
        fail('final_counts_mismatch', 'Final counts disagree with the parsed final molfile')
    previous = (0, 0)
    previous_digest = None
    events = evidence['timeline']
    inputs = [e for e in events if e['type'] in ('pointer_down', 'pointer_up', 'click', 'key_action')]
    for change in changes:
        before = counts(change.get('before'), 'change.before')
        after = counts(change.get('after'), 'change.after')
        if before != previous:
            fail('broken_structure_history', 'Structure changes must form a continuous history')
        if previous_digest is not None and change['before'].get('chemistryDigest') != previous_digest:
            fail('broken_structure_history', 'Chemical history was replaced between changes')
        previous = after
        previous_digest = change['after'].get('chemistryDigest')
        if not any(0 <= change['t'] - e['t'] <= (6500 if not e['data'].get('canvas') else 2200) for e in inputs):
            fail('unlinked_structure_change', 'A structure change has no preceding editor input')
    if previous != frame_counts[-1]:
        fail('final_history_mismatch', 'Final structure is inconsistent with the last recorded change')
    if changes and final['counts'].get('chemistryDigest') != previous_digest:
        fail('final_history_mismatch', 'Final chemical snapshot disagrees with the last change')
    if parsed is not None and (len(frames) < 2 or not changes):
        fail('missing_structure_history', 'A final answer requires an actual structure history')
    # Derive stroke metrics from points, ignoring caller-supplied path/velocity.
    normalized = copy.deepcopy(report)
    for stroke in normalized['strokes']:
        points = stroke['points']
        if len(points) < 2:
            fail('missing_trajectory', 'A completed stroke requires at least two points')
        segments = [(b['x']-a['x'], b['y']-a['y']) for a,b in zip(points, points[1:])]
        length = sum(math.hypot(x,y) for x,y in segments)
        displacement = math.hypot(points[-1]['x']-points[0]['x'], points[-1]['y']-points[0]['y'])
        ms = points[-1]['dt']
        angles = [math.atan2(y,x) for x,y in segments if math.hypot(x,y) > 0.5]
        turns = sum(abs(math.atan2(math.sin(b-a),math.cos(b-a))) > 0.35 for a,b in zip(angles, angles[1:]))
        stroke.update(durationMs=ms, pathPx=length, displacementPx=displacement,
                      straightness=displacement/length if length else 1,
                      directionChanges=turns, meanSpeedPxPerSec=length*1000/ms if ms else 0)
    # An arbitrary list of click events alone is not a completed input history.
    for event in events:
        if event['type'] not in ('pointer_up', 'click') or not event['data'].get('canvas'):
            continue
        if not any(s.get('canvas') and s['startedAt'] <= event['t'] <= s['startedAt'] + s['durationMs'] + 250
                   for s in normalized['strokes']):
            fail('missing_trajectory', 'Canvas actions must have corresponding completed pointer strokes')
    normalized['counters'] = {
        'blockedPaste': sum(e['type'] == 'paste_attempt' for e in events),
        'blockedImport': sum(e['type'] == 'import_blocked' for e in events),
    }
    normalized['finalStructure']['counts']['atoms'] = parsed.GetNumAtoms() if parsed is not None else 0
    normalized['finalStructure']['counts']['bonds'] = parsed.GetNumBonds() if parsed is not None else 0
    normalized['session']['durationMs'] = min(duration, server_elapsed)
    normalized['replay']['strokes'] = normalized['strokes']
    return normalized


def behavior_fingerprint(report: dict) -> str:
    """Independent of answer/session/score. Metadata edits cannot hide reuse."""
    evidence = evidence_projection(report)
    # Session-specific click challenges must not disguise reuse of the drawing itself.
    evidence['timeline'] = [e for e in evidence['timeline'] if e.get('type') not in ('attention_down', 'attention_up')]
    # Absolute wall-clock times and report duration are deliberately excluded.
    return digest({key: evidence[key] for key in ('timeline', 'strokes', 'structureChanges')})
