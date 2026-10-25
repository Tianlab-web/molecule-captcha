"""Server-owned, single-use timed attention check. Client input is not attestation."""
import secrets
from security_validation import EvidenceError, finite, obj

from attention_image import make_scene, render


def new_check(now, available=None, *, language='en'):
    # Client-provided toolbar inventories/rectangles cannot influence the scene.
    scene = make_scene()
    target = scene['slots'][scene['selected']]
    delay = 3000 + secrets.randbelow(5001)
    return dict(id=secrets.token_urlsafe(18), frameId=secrets.token_urlsafe(24), version=3,
                target=target['label'], side=target['side'], scene=scene,
                bounds={key:target[key] for key in ('x','y','width','height')},
                delayMs=delay, plannedAtTs=now, dueAtTs=now+delay/1000,
                expiresAtTs=now+delay/1000+5, status='scheduled',windowMs=5000, **render(scene, language))


def expire(check, now):
    if check['status'] in ('scheduled', 'shown', 'pressed') and now > check['expiresAtTs']:
        check.update(status='failed', reason='timeout')


def audit(check):
    # Never persist the two bearer nonces in audit records or reports.
    keys = ('version', 'frameId', 'bounds', 'scene', 'imageSha256', 'id', 'target', 'side', 'delayMs', 'windowMs', 'plannedAtTs', 'dueAtTs',
            'expiresAtTs', 'shownAtTs', 'pressedAtTs', 'clickedAtTs', 'evidenceCommittedAtTs', 'status', 'reason', 'down', 'up')
    return {k: check[k] for k in keys if k in check}


def _event(value, kind, check, session, now):
    event = obj(value, 'attention event')
    data = obj(event.get('data'), 'attention event.data')
    if set(event) != {'t', 'type', 'data'} or event.get('type') != kind:
        raise EvidenceError('invalid_attention_event', 'Unexpected attention event')
    if set(data) != {'challengeId', 'frameId', 'x', 'y', 'pointerId', 'pointerType', 'button'}:
        raise EvidenceError('invalid_attention_event', 'Unexpected attention event fields')
    if data['challengeId'] != check['id'] or data['frameId'] != check['frameId'] or data['button'] != 0 or isinstance(data['button'], bool):
        raise EvidenceError('invalid_attention_target', 'Click is not bound to this challenge/button')
    if data['pointerType'] not in ('mouse', 'pen', 'touch'):
        raise EvidenceError('invalid_attention_pointer', 'A pointer interaction is required')
    finite(data['pointerId'], 'pointerId', high=2147483647)
    t = finite(event['t'], 'attention event.t', high=session['ttlMs'])
    observed = (now-session['createdAtTs'])*1000
    if abs(t-observed) > 2000:
        raise EvidenceError('invalid_attention_time', 'Click time differs from server receipt time')
    rect = check['bounds']
    x = finite(data['x'], 'x', high=check['scene']['width'])
    y = finite(data['y'], 'y', high=check['scene']['height'])
    if not rect['x'] <= x <= rect['x']+rect['width'] or not rect['y'] <= y <= rect['y']+rect['height']:
        raise EvidenceError('invalid_attention_bounds', 'Click did not match the displayed challenge')
    return event


def advance(check, session, payload, now, safe_equal):
    expire(check, now)
    action = payload.get('action')
    if action not in ('poll', 'down', 'up'):
        raise EvidenceError('invalid_attention_action', 'Unknown attention action')
    if check['status'] in ('passed', 'failed'):
        if action != 'poll':
            raise EvidenceError('attention_consumed', 'This click challenge is already consumed')
        return dict(ok=True, status=check['status'])
    if now < check['dueAtTs']:
        if action != 'poll':
            raise EvidenceError('attention_too_early', 'The challenge is not open yet')
        return dict(ok=True, status='scheduled', retryAfterMs=max(25, round((check['dueAtTs']-now)*1000)))
    progress = session['progress']
    if progress.get('sealed') or progress.get('failed') or not progress.get('count') or now-progress.get('receivedAt', 0) > 4:
        raise EvidenceError('attention_no_live_stream', 'A recent live checkpoint is required')
    if action == 'poll':
        if check['status'] == 'scheduled':
            check.update(status='shown', shownAtTs=now, nonce=secrets.token_urlsafe(32))
        return dict(ok=True, status=check['status'], version=3, challengeId=check['id'], frameId=check['frameId'],
                    image=check['image'], width=check['scene']['width'], height=check['scene']['height'],
                    nonce=check['nonce'], remainingMs=max(0, round((check['expiresAtTs']-now)*1000)))
    try:
        if action == 'down':
            if check['status'] != 'shown' or not safe_equal(payload.get('nonce'), check.get('nonce')):
                raise EvidenceError('invalid_attention_nonce', 'Invalid or reused display nonce')
            event = _event(payload.get('event'), 'attention_down', check, session, now)
            check.update(status='pressed', down=event, pressedAtTs=now, pressNonce=secrets.token_urlsafe(32))
            return dict(ok=True, status='pressed', pressNonce=check['pressNonce'])
        if check['status'] != 'pressed' or not safe_equal(payload.get('nonce'), check.get('pressNonce')):
            raise EvidenceError('invalid_attention_nonce', 'Invalid or reused press nonce')
        event = _event(payload.get('event'), 'attention_up', check, session, now)
        down = check['down']
        if now-check['pressedAtTs'] > 2 or not 0 <= event['t']-down['t'] <= 2000:
            raise EvidenceError('invalid_attention_gesture', 'Pointer press/release is too long or reversed')
        if any(event['data'][key] != down['data'][key] for key in ('pointerId', 'pointerType')):
            raise EvidenceError('invalid_attention_gesture', 'Pointer press/release does not match')
        check.update(status='passed', up=event, clickedAtTs=now)
        return dict(ok=True, status='passed')
    except EvidenceError as error:
        check.update(status='failed', reason=error.code)
        raise


def commit_evidence(check, timeline, now):
    if check['status'] != 'passed' or 'evidenceCommittedAtTs' in check:
        return False
    entries = [e for e in timeline if e.get('type') in ('attention_down', 'attention_up')]
    if entries == [check['down'], check['up']] and now-check['clickedAtTs'] <= 4:
        check['evidenceCommittedAtTs'] = now
        return True
    return False


def verify(check, timeline, now):
    expire(check, now)
    if check['status'] == 'passed':
        # Final timeline itself has already been checked against sealed live commitments.
        entries = [e for e in timeline if e.get('type') in ('attention_down', 'attention_up')]
        if entries != [check['down'], check['up']] or 'evidenceCommittedAtTs' not in check:
            check.update(status='failed', reason='attention_evidence_mismatch')
    elif check['status'] != 'failed':
        check.update(status='failed', reason='not_completed')
    result = {k: check[k] for k in ('id','frameId','version','delayMs','windowMs','status','reason','clickedAtTs','evidenceCommittedAtTs') if k in check}
    result['passed'] = check['status'] == 'passed'
    result['messageZh'] = '限时点击验证通过' if result['passed'] else '未通过限时点击验证，按规则判定为机器人'
    result['message'] = 'Timed click passed' if result['passed'] else 'Timed click failed; classified as a bot by policy'
    return result
