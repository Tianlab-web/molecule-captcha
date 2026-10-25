/*
 * Ketcher 使用行为监测。
 * 负责在浏览器本地记录绘图交互元数据，并生成可解释的行为报告预览。
 * 注意：最终可信评分由 Flask 后端重新计算，前端评分只作为即时展示。
 */
(function () {
  'use strict';

  var VERSION = '0.8.0';
  var CONFIG = Object.assign({
    autoUpload: false,
    reportEndpoint: 'api/reports'
  }, window.KETCHER_MONITOR_CONFIG || {});
  var STORAGE_DRAFT = 'ketcher-usage-monitor:last-draft';
  function configNumber(path, fallback) {
    var value = path.split('.').reduce(function (current, key) {
      return current && typeof current === 'object' ? current[key] : undefined;
    }, CONFIG);
    return typeof value === 'number' && isFinite(value) ? value : fallback;
  }
  var MAX_EVENTS = configNumber('limits.maxEvents', 12000);
  var MAX_STROKES = configNumber('limits.maxStrokes', 3000);
  var MAX_POINTER_TRAIL = configNumber('limits.maxPointerTrail', 25000);
  var MAX_POINTS_PER_STROKE = configNumber('limits.maxPointsPerStroke', 500);
  var STROKE_POINT_MIN_INTERVAL_MS = configNumber('pointerSampling.strokePointMinIntervalMs', 24);
  var STROKE_POINT_MIN_DISTANCE_PX = configNumber('pointerSampling.strokePointMinDistancePx', 4);
  var POINTER_TRAIL_MIN_INTERVAL_MS = configNumber('pointerSampling.pointerTrailMinIntervalMs', 32);
  var POINTER_TRAIL_MIN_DISTANCE_PX = configNumber('pointerSampling.pointerTrailMinDistancePx', 4);
  var STRUCTURE_POLL_INTERVAL_MS = configNumber('timers.structurePollIntervalMs', 200);
  var EDITOR_READY_CHECK_INTERVAL_MS = configNumber('timers.editorReadyCheckIntervalMs', 100);
  var DOCK_REFRESH_INTERVAL_MS = configNumber('timers.dockRefreshIntervalMs', 1000);
  var CANVAS_INPUT_LINK_WINDOW_MS = configNumber('attribution.canvasInputLinkWindowMs', 2200);
  var TOOL_INPUT_LINK_WINDOW_MS = configNumber('attribution.toolInputLinkWindowMs', 6500);
  var CORRECTION_LINK_WINDOW_MS = configNumber('attribution.correctionLinkWindowMs', 3500);
  var EDIT_TRANSACTION_GAP_MS = configNumber('attribution.editTransactionGapMs', 2500);
  var attention = window.ketcherAttentionCheck && window.ketcherAttentionCheck.claim();
  var state = null;
  var lastReport = null;
  var hookedEditor = null;
  var editorChangeHandler = null;
  var lastObservedSnapshot = null;
  var structureTimer = null;
  var activeStroke = null;
  var dockTimer = null;
  var replayCaptureChain = Promise.resolve();
  var replayPlayer = null;
  var replayCanvasTransitionCount = 0;
  var lastPointerTrailPoint = null;
  var lastPointerTrailTarget = null;
  var activeChallengeId = new URLSearchParams(window.location.search).get('challenge');
  var editorReadyNotified = false;
  var challengeActivationChain = Promise.resolve();
  var checkpointTimer = null;
  var beginPending = false;
  var finalizePending = null;
  var replayWriter = null;
  if (window.ketcherManualOnlyGuard && window.ketcherManualOnlyGuard.claimReplayWriter) {
    replayWriter = window.ketcherManualOnlyGuard.claimReplayWriter(function () {
      return Boolean(state && state.finalized && !state.recording);
    });
  }

  function checkpointEvidence(targetState) {
    function project(items, keys) {
      return items.map(function (item) {
        var out = {};
        keys.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(item, key)) out[key] = item[key]; });
        return out;
      });
    }
    return {
      timeline: project(targetState.events, ['t', 'type', 'data']),
      strokes: project(targetState.strokes, ['startedAt', 'pointerType', 'button', 'target', 'canvas', 'points', 'cancelled']),
      structureChanges: project(targetState.structureChanges, ['t', 'action', 'source', 'before', 'after']),
      frames: project(targetState.replayFrames, ['t', 'action', 'atoms', 'bonds', 'molfile']),
      pointerTrail: project(targetState.pointerTrail, ['t', 'x', 'y', 'target', 'canvas', 'kind', 'pointerType', 'buttons'])
    };
  }

  function verificationError(result, status) {
    var message = result.messageZh || result.message || ('HTTP ' + status);
    if (result.error) message += ' [' + result.error + ']';
    return new Error(message);
  }

  function hideTemplatePreview() {
    var preview = hookedEditor && hookedEditor._tool && hookedEditor._tool.templatePreview;
    if (preview && typeof preview.hidePreview === 'function') preview.hidePreview();
  }

  function hasTransientStructure(editor) {
    var tool = editor && editor._tool;
    var preview = tool && tool.templatePreview;
    return Boolean((activeStroke && activeStroke.canvas) || (tool && tool.dragCtx) ||
      (preview && (preview.floatingPreview || preview.connectedPreviewAction)));
  }

  async function recordDrawingCompletion(targetState) {
    if (!targetState.serverSession) return;
    var issued = targetState.serverSession;
    var structure = await readFinalStructure();
    var response = await fetch((CONFIG.sessionEndpoint || 'api/sessions') + '/' + encodeURIComponent(issued.sessionId) + '/completion', {
      method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: issued.token, smiles: structure && structure.smiles || ''})
    });
    var result = await response.json();
    if (!response.ok || !result.ok) throw verificationError(result, response.status);
    targetState.timeVerification = result.timeVerification;
  }

  function stopCheckpoints() {
    if (checkpointTimer) clearInterval(checkpointTimer);
    checkpointTimer = null;
  }

  function queueCheckpoint(targetState, final) {
    if (!CONFIG.autoUpload) return Promise.resolve();
    targetState.checkpointChain = (targetState.checkpointChain || Promise.resolve()).then(async function () {
      if (targetState.telemetryError) throw new Error(targetState.telemetryError);
      if (!targetState.serverSession) throw new Error('No server session');
      await replayCaptureChain;
      var elapsed = Math.max(0, Math.round((targetState.endedPerformance || performance.now()) - targetState.performanceStart));
      var issued = targetState.serverSession;
      var observedEvidence = checkpointEvidence(targetState);
      var endpoint = (CONFIG.sessionEndpoint || 'api/sessions') + '/' + encodeURIComponent(issued.sessionId) + '/checkpoints';
      var response = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({token: issued.token, sequence: issued.checkpointSequence,
          nonce: issued.checkpointNonce, elapsedMs: elapsed, final: Boolean(final), evidence: observedEvidence})
      });
      var result = await response.json();
      if (!response.ok || !result.ok) throw verificationError(result, response.status);
      issued.checkpointSequence = result.sequence;
      issued.checkpointNonce = result.nonce;
      if (!final) targetState.committedStructureChanges = observedEvidence.structureChanges.length;
    }).catch(function (error) {
      targetState.telemetryError = String(error && error.message || error);
      if (state === targetState) stopCheckpoints();
      throw error;
    });
    return targetState.checkpointChain;
  }

  function markUnverified(report, error) {
    var detail = String(error && error.message || error);
    report.accepted = false;
    report.classification = Object.assign({}, report.classification, {
      source: 'unverified', verdict: 'uncertain', score: 50, confidence: 0,
      label: 'Server verification failed', labelZh: '服务端未验证',
      policyStatus: 'server_verification_failed', policyLabel: 'Structure verification incomplete', policyLabelZh: '未完成结构校验',
      reasons: [{code: 'server_verification_failed', dimension: 'integrity', weight: 0,
        message: detail, messageZh: '未完成结构校验，无法判断绘制是否一致。原因：' + detail}]
    });
    report.challengeVerification = {matched: false, status: 'verification_failed',
      message: 'Structure verification incomplete: ' + detail, messageZh: '未完成结构校验，无法判断绘制是否一致。'};
    report.delivery = {ok: false, attemptedAt: isoNow(), error: detail};
  }

  function nowOffset() {
    if (!state || !state.recording || state.performanceStart === null) return 0;
    return Math.max(0, Math.round(performance.now() - state.performanceStart));
  }

  function isoNow() {
    var beijingOffsetMs = 8 * 60 * 60 * 1000;
    return new Date(Date.now() + beijingOffsetMs)
      .toISOString()
      .replace('Z', '+08:00');
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function round(value, places) {
    var factor = Math.pow(10, places || 0);
    return Math.round(value * factor) / factor;
  }
  function createId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'kum-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  
  
  

  async function requestServerSession() {
    if (!CONFIG.autoUpload || !/^https?:$/.test(window.location.protocol)) return null;
    try {
      var endpoint = CONFIG.sessionEndpoint || 'api/sessions';
      var response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: activeChallengeId }),
        credentials: 'same-origin'
      });
      var result = await response.json();
      if (!response.ok) throw new Error(result.message || ('HTTP ' + response.status));
      return result;
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) };
    }
  }

  function createSession(recording, serverSession) {
    var active = Boolean(recording);
    var trustedSession = serverSession && serverSession.ok && serverSession.sessionId && serverSession.token ? serverSession : null;
    return {
      schemaVersion: 3,
      monitorVersion: VERSION,
      sessionId: active ? (trustedSession ? serverSession.sessionId : createId()) : null,
      startedAt: active ? (trustedSession ? serverSession.startedAt : isoNow()) : null,
      serverSession: trustedSession ? {
        sessionId: serverSession.sessionId,
        token: serverSession.token,
        startedAt: serverSession.startedAt,
        expiresAt: serverSession.expiresAt,
        checkpointNonce: serverSession.checkpointNonce,
        checkpointSequence: 0
      } : null,
      serverSessionError: serverSession && serverSession.ok === false ? serverSession.error : null,
      endedAt: null,
      endReason: null,
      performanceStart: active ? performance.now() : null,
      viewport: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio || 1 },
      events: [],
      strokes: [],
      pointerTrail: [],
      structureChanges: [],
      replayFrames: [],
      counters: { blockedPaste: 0, blockedImport: 0, clicks: 0, keyActions: 0, pointerMoves: 0, structureUpdates: 0 },
      finalStructure: null,
      finalized: false,
      recording: active
    };
  }

  function describeTarget(target) {
    if (!(target instanceof Element)) return 'document';
    if (target.closest('#kum-root')) return 'monitor-ui';
    var element = target.closest('button,[role="button"],[data-testid],[title],[aria-label],input,textarea,select,a') || target;
    var testId = element.getAttribute && element.getAttribute('data-testid');
    var label = element.getAttribute && (element.getAttribute('aria-label') || element.getAttribute('title'));
    var text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    var name = testId || label || text || element.tagName.toLowerCase();
    return name.replace(/[\r\n]/g, ' ').slice(0, 80);
  }

  function isMonitorTarget(target) {
    return target instanceof Element && Boolean(target.closest('#kum-root'));
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element) || target.closest('.cliparea')) return false;
    return Boolean(target.closest('input,textarea,select,[contenteditable="true"]'));
  }

  function isCanvasTarget(target) {
    if (!(target instanceof Element) || isMonitorTarget(target)) return false;
    if (target.closest('[data-testid="top-toolbar"],button,input,select,[role="dialog"],[role="menu"]')) return false;
    return Boolean(target.closest('.cliparea,svg,canvas,[class*="canvas"],[class*="Canvas"],[class*="editor"],[class*="Editor"],#root'));
  }

  function record(type, data) {
    if (!state || !state.recording || state.finalized || state.events.length >= MAX_EVENTS) return null;
    var event = { t: nowOffset(), type: type, data: data || {} };
    state.events.push(event);
    appendLiveEvent(event);
    updateLiveSummary();
    return event;
  }

  function pointerPoint(event, startTime) {
    return {
      dt: Math.round(performance.now() - startTime),
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      pressure: round(typeof event.pressure === 'number' ? event.pressure : 0, 3)
    };
  }

  function distance(a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function summarizeStroke(stroke) {
    var points = stroke.points;
    var path = 0;
    var directionChanges = 0;
    var previousAngle = null;
    for (var i = 1; i < points.length; i += 1) {
      path += distance(points[i - 1], points[i]);
      var angle = Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x);
      if (previousAngle !== null) {
        var delta = Math.abs(angle - previousAngle);
        if (delta > Math.PI) delta = Math.PI * 2 - delta;
        if (delta > 0.35) directionChanges += 1;
      }
      previousAngle = angle;
    }
    var displacement = points.length > 1 ? distance(points[0], points[points.length - 1]) : 0;
    var duration = points.length ? points[points.length - 1].dt : 0;
    stroke.durationMs = duration;
    stroke.pathPx = round(path, 1);
    stroke.displacementPx = round(displacement, 1);
    stroke.straightness = path > 0 ? round(displacement / path, 3) : 1;
    stroke.directionChanges = directionChanges;
    stroke.meanSpeedPxPerSec = duration > 0 ? round(path / duration * 1000, 1) : 0;
    return stroke;
  }

  function handlePointerDown(event) {
    capturePointerTrail(event, true);
    if (!state || !state.recording || state.finalized || isMonitorTarget(event.target)) return;
    activeStroke = {
      startedAt: nowOffset(),
      pointerType: event.pointerType || 'mouse',
      button: event.button,
      target: describeTarget(event.target),
      canvas: isCanvasTarget(event.target),
      rawStart: performance.now(),
      points: []
    };
    activeStroke.points.push(pointerPoint(event, activeStroke.rawStart));
    record('pointer_down', { target: activeStroke.target, canvas: activeStroke.canvas, pointerType: activeStroke.pointerType });
  }

  function handlePointerMove(event) {
    if (!state || !state.recording || state.finalized) return;
    state.counters.pointerMoves += 1;
    capturePointerTrail(event, false);
    if (!activeStroke || activeStroke.points.length >= MAX_POINTS_PER_STROKE) return;
    var point = pointerPoint(event, activeStroke.rawStart);
    var previous = activeStroke.points[activeStroke.points.length - 1];
    if (point.dt - previous.dt >= STROKE_POINT_MIN_INTERVAL_MS || distance(previous, point) >= STROKE_POINT_MIN_DISTANCE_PX) activeStroke.points.push(point);
  }

  function capturePointerTrail(event, force) {
    if (!state || !state.recording || state.finalized || state.pointerTrail.length >= MAX_POINTER_TRAIL) return;
    var target = describeTarget(event.target);
    var current = {
      t: nowOffset(),
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      pointerType: event.pointerType || 'mouse',
      buttons: typeof event.buttons === 'number' ? event.buttons : 0,
      canvas: isCanvasTarget(event.target)
    };
    var targetChanged = target !== lastPointerTrailTarget;
    var enoughTime = !lastPointerTrailPoint || current.t - lastPointerTrailPoint.t >= POINTER_TRAIL_MIN_INTERVAL_MS;
    var enoughDistance = !lastPointerTrailPoint || distance(lastPointerTrailPoint, current) >= POINTER_TRAIL_MIN_DISTANCE_PX;
    if (!force && !targetChanged && !enoughTime && !enoughDistance) return;
    if (targetChanged) current.target = target;
    state.pointerTrail.push(current);
    lastPointerTrailPoint = current;
    lastPointerTrailTarget = target;
  }

  function handlePointerUp(event, cancelled) {
    capturePointerTrail(event, true);
    finishStroke(event, cancelled);
  }

  function finishStroke(event, cancelled) {
    if (!activeStroke || !state) return;
    var point = pointerPoint(event, activeStroke.rawStart);
    var previous = activeStroke.points[activeStroke.points.length - 1];
    if (!previous || distance(previous, point) > 0 || point.dt !== previous.dt) activeStroke.points.push(point);
    activeStroke.cancelled = Boolean(cancelled);
    delete activeStroke.rawStart;
    summarizeStroke(activeStroke);
    if (state.strokes.length < MAX_STROKES) state.strokes.push(activeStroke);
    record('pointer_up', {
      canvas: activeStroke.canvas,
      durationMs: activeStroke.durationMs,
      pathPx: activeStroke.pathPx,
      points: activeStroke.points.length,
      straightness: activeStroke.straightness
    });
    activeStroke = null;
  }

  function normalizedKeyAction(event) {
    var mod = event.ctrlKey || event.metaKey;
    var key = String(event.key || '').toLowerCase();
    if (key === 'delete' || key === 'backspace') return 'delete';
    if (mod && key === 'z' && event.shiftKey) return 'redo';
    if (mod && key === 'z') return 'undo';
    if (mod && key === 'y') return 'redo';
    if (mod && key === 'v') return 'paste';
    if (key === 'escape') return 'escape';
    return null;
  }

  function handleKeyDown(event) {
    if (!state || !state.recording || state.finalized || isMonitorTarget(event.target)) return;
    var action = normalizedKeyAction(event);
    if (!action) return;
    if (isEditableTarget(event.target) && (action === 'delete' || action === 'undo' || action === 'redo')) return;
    state.counters.keyActions += 1;
    if (action === 'paste' && isCanvasTarget(event.target)) state.counters.blockedPaste += 1;
    var shortcut = [];
    if (event.ctrlKey) shortcut.push('Ctrl');
    if (event.metaKey) shortcut.push('Command');
    if (event.altKey) shortcut.push('Alt');
    if (event.shiftKey) shortcut.push('Shift');
    shortcut.push(event.key === ' ' ? 'Space' : String(event.key || action));
    record('key_action', {
      action: action,
      target: describeTarget(event.target),
      key: String(event.key || ''),
      ctrlKey: Boolean(event.ctrlKey),
      metaKey: Boolean(event.metaKey),
      altKey: Boolean(event.altKey),
      shiftKey: Boolean(event.shiftKey),
      shortcut: shortcut.join('+')
    });
  }

  function handleClick(event) {
    if (!state || !state.recording || state.finalized || isMonitorTarget(event.target)) return;
    var label = describeTarget(event.target);
    var popupOption = Boolean(event.target instanceof Element && event.target.closest(
      '[role="menu"],[class*="portal"],[class*="dropdown"],[class*="popover"],.default-multitool-dropdown'
    ));
    var popupCountBefore = visibleKetcherPopups().length;
    state.counters.clicks += 1;
    var recorded = record('click', {
      target: label,
      canvas: isCanvasTarget(event.target),
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      popupOption: popupOption
    });
    if (recorded && !popupOption) {
      setTimeout(function () {
        var popups = visibleKetcherPopups();
        if (popups.length > popupCountBefore) {
          var popup = popups[popups.length - 1];
          var box = popup.getBoundingClientRect();
          recorded.data.opensPopup = true;
          recorded.data.popupSnapshot = {
            html: popup.outerHTML,
            rect: { left: box.left, top: box.top, width: box.width, height: box.height }
          };
        }
      }, 80);
    }
  }

  function visibleKetcherPopups() {
    return Array.from(document.querySelectorAll(
      '[role="menu"],[class*="portal"],[class*="dropdown"],[class*="popover"],.default-multitool-dropdown'
    )).filter(function (element) {
      if (element.closest('#kum-root')) return false;
      var box = element.getBoundingClientRect();
      var style = getComputedStyle(element);
      return box.width > 20 && box.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
    });
  }

  function collectionCount(collection) {
    if (!collection) return 0;
    if (typeof collection.size === 'number') return collection.size;
    if (typeof collection.count === 'function') {
      try { return collection.count(); } catch (_) {}
    }
    if (typeof collection.length === 'number') return collection.length;
    if (typeof collection.keys === 'function') {
      try { return Array.from(collection.keys()).length; } catch (_) {}
    }
    return 0;
  }

  function positionDigest(atoms) {
    var values = [];
    function append(atom, id) {
      if (!atom || values.length >= 250) return;
      var point = atom.pp || atom.position || atom.pos;
      if (point && isFinite(point.x) && isFinite(point.y)) values.push(String(id) + ':' + round(point.x, 2) + ',' + round(point.y, 2));
    }
    try {
      if (atoms && typeof atoms.forEach === 'function') atoms.forEach(function (atom, id) { append(atom, id); });
      else if (atoms && typeof atoms.each === 'function') atoms.each(function (id, atom) { append(atom, id); });
    } catch (_) {}
    return values.sort().join('|');
  }

  function chemistryDigest(struct) {
    var atoms = [];
    var bonds = [];
    function appendAtom(atom, id) {
      if (!atom) return;
      atoms.push([
        id,
        atom.label || '',
        atom.alias || '',
        atom.isotope || 0,
        atom.charge || 0,
        atom.radical || 0,
        atom.rglabel || 0,
        atom.explicitValence || 0
      ].join(':'));
    }
    function appendBond(bond, id) {
      if (!bond) return;
      bonds.push([
        id,
        bond.begin,
        bond.end,
        bond.type || bond.order || 0,
        bond.stereo || 0,
        bond.topology || 0,
        bond.reactingCenterStatus || 0
      ].join(':'));
    }
    try {
      if (struct.atoms && typeof struct.atoms.forEach === 'function') struct.atoms.forEach(function (atom, id) { appendAtom(atom, id); });
      else if (struct.atoms && typeof struct.atoms.each === 'function') struct.atoms.each(function (id, atom) { appendAtom(atom, id); });
      if (struct.bonds && typeof struct.bonds.forEach === 'function') struct.bonds.forEach(function (bond, id) { appendBond(bond, id); });
      else if (struct.bonds && typeof struct.bonds.each === 'function') struct.bonds.each(function (id, bond) { appendBond(bond, id); });
    } catch (_) {}
    return atoms.sort().join('|') + '//' + bonds.sort().join('|');
  }

  function structureSnapshot(editor) {
    try {
      var struct = editor && typeof editor.struct === 'function' ? editor.struct() : null;
      if (!struct) return null;
      return {
        atoms: collectionCount(struct.atoms),
        bonds: collectionCount(struct.bonds),
        sgroups: collectionCount(struct.sgroups),
        rxnArrows: collectionCount(struct.rxnArrows),
        positionDigest: positionDigest(struct.atoms),
        chemistryDigest: chemistryDigest(struct)
      };
    } catch (_) { return null; }
  }

  function structurePositions(editor) {
    var positions = [];
    try {
      var struct = editor && typeof editor.struct === 'function' ? editor.struct() : null;
      if (!struct || !struct.atoms) return positions;
      var order = 0;
      function append(atom, id) {
        if (!atom || !atom.pp || !isFinite(atom.pp.x) || !isFinite(atom.pp.y)) return;
        positions.push({
          id: id,
          order: order,
          label: atom.label || '',
          x: atom.pp.x,
          y: atom.pp.y
        });
        order += 1;
      }
      if (typeof struct.atoms.forEach === 'function') struct.atoms.forEach(function (atom, id) { append(atom, id); });
      else if (typeof struct.atoms.each === 'function') struct.atoms.each(function (id, atom) { append(atom, id); });
    } catch (_) {}
    return positions;
  }

  function inferStructureAction(before, after) {
    if (!before || !after) return 'structure_update';
    var atomDelta = after.atoms - before.atoms;
    var bondDelta = after.bonds - before.bonds;
    if (atomDelta > 1 || bondDelta > 2) return 'bulk_add';
    if (atomDelta > 0) return 'add_atom';
    if (bondDelta > 0) return 'add_bond';
    if (atomDelta < 0 || bondDelta < 0) return 'reduce_structure';
    if (before.positionDigest !== after.positionDigest) return 'move_structure';
    if (before.chemistryDigest !== after.chemistryDigest) return 'edit_atom_or_bond';
    return 'edit_property_or_layout';
  }

  function snapshotsDiffer(before, after) {
    return Boolean(after) && (!before || before.atoms !== after.atoms || before.bonds !== after.bonds ||
      before.sgroups !== after.sgroups || before.rxnArrows !== after.rxnArrows ||
      before.positionDigest !== after.positionDigest || before.chemistryDigest !== after.chemistryDigest);
  }

  function recentRecordedEvent(predicate, maxAgeMs) {
    if (!state) return null;
    var currentTime = nowOffset();
    for (var i = state.events.length - 1; i >= 0; i -= 1) {
      var event = state.events[i];
      if (currentTime - event.t > maxAgeMs) break;
      if (predicate(event)) return event;
    }
    return null;
  }

  function captureStructureChange(before, after, source) {
    if (!state || !state.recording || state.finalized || !snapshotsDiffer(before, after)) return;
    if (!snapshotsDiffer(lastObservedSnapshot, after)) return;
    var action = inferStructureAction(before || lastObservedSnapshot, after);
    var effectiveBefore = before || lastObservedSnapshot;
    var canvasInput = recentRecordedEvent(function (event) {
      return isCanvasInputEvent(event) || isToolInputEvent(event);
    }, CANVAS_INPUT_LINK_WINDOW_MS);
    var toolInput = recentRecordedEvent(function (event) {
      return event.type === 'click' && event.data && !event.data.canvas;
    }, TOOL_INPUT_LINK_WINDOW_MS);
    var change = {
      t: nowOffset(), action: action, source: source, before: effectiveBefore, after: after,
      inputLinked: Boolean(canvasInput),
      inputDelayMs: canvasInput ? Math.max(0, nowOffset() - canvasInput.t) : null,
      recentTool: toolInput ? toolInput.data.target : null
    };
    state.structureChanges.push(change);
    queueReplayFrame(change);
    state.counters.structureUpdates += 1;
    lastObservedSnapshot = after;
    record('structure_change', {
      action: action,
      source: source,
      atoms: after.atoms,
      bonds: after.bonds,
      atomDelta: effectiveBefore ? after.atoms - effectiveBefore.atoms : null,
      bondDelta: effectiveBefore ? after.bonds - effectiveBefore.bonds : null,
      inputLinked: change.inputLinked,
      recentTool: change.recentTool
    });
  }

  function readMolfile() {
    if (!window.ketcher || typeof window.ketcher.getMolfile !== 'function') return Promise.resolve(null);
    return Promise.resolve(window.ketcher.getMolfile()).catch(function () { return null; });
  }

  function queueReplayFrame(change) {
    var targetState = state;
    if (!targetState || !targetState.recording || targetState.finalized) return replayCaptureChain;
    var molfilePromise = readMolfile();
    var positions = structurePositions(hookedEditor);
    var zoom = hookedEditor && typeof hookedEditor.zoom === 'function' ? hookedEditor.zoom() : null;
    replayCaptureChain = Promise.all([replayCaptureChain, molfilePromise]).then(function (results) {
      if (!targetState || targetState.finalized) return;
      var molfile = results[1];
      if (typeof molfile !== 'string') return;
      var previous = targetState.replayFrames[targetState.replayFrames.length - 1];
      if (previous && previous.molfile === molfile) return;
      targetState.replayFrames.push({
        t: change.t,
        action: change.action,
        atoms: change.after ? change.after.atoms : null,
        bonds: change.after ? change.after.bonds : null,
        recentTool: change.recentTool,
        atomPositions: positions,
        zoom: zoom,
        molfile: molfile
      });
    });
    return replayCaptureChain;
  }

  async function captureFinalReplayFrame(targetState) {
    await replayCaptureChain;
    if (!targetState) return;
    var molfile = await readMolfile();
    var positions = structurePositions(hookedEditor);
    var zoom = hookedEditor && typeof hookedEditor.zoom === 'function' ? hookedEditor.zoom() : null;
    if (typeof molfile !== 'string') return;
    var finalTime = Math.max(0, Math.round((targetState.endedPerformance || performance.now()) - targetState.performanceStart));
    var previous = targetState.replayFrames[targetState.replayFrames.length - 1];
    if (!previous || previous.molfile !== molfile) {
      targetState.replayFrames.push({
        t: finalTime,
        action: 'final_structure',
        atoms: targetState.finalStructure && targetState.finalStructure.counts ? targetState.finalStructure.counts.atoms : null,
        bonds: targetState.finalStructure && targetState.finalStructure.counts ? targetState.finalStructure.counts.bonds : null,
        recentTool: null,
        atomPositions: positions,
        zoom: zoom,
        molfile: molfile
      });
    }
  }

  function startStructurePolling(editor) {
    if (structureTimer) clearInterval(structureTimer);
    lastObservedSnapshot = structureSnapshot(editor);
    structureTimer = setInterval(function () {
      if (!state || !state.recording || state.finalized) return;
      if (hasTransientStructure(editor)) return;
      var current = structureSnapshot(editor);
      if (snapshotsDiffer(lastObservedSnapshot, current)) captureStructureChange(lastObservedSnapshot, current, 'poll');
    }, STRUCTURE_POLL_INTERVAL_MS);
  }

  function notifyHostEditorReady() {
    if (editorReadyNotified || !window.parent || window.parent === window) return;
    editorReadyNotified = true;
    window.parent.postMessage({ eventType: 'ketcher-editor-ready' }, window.location.origin);
  }

  function hookEditor() {
    if (!state || !window.ketcher || !window.ketcher.editor) return false;
    var editor = window.ketcher.editor;
    if (editor === hookedEditor) {
      notifyHostEditorReady();
      return true;
    }
    if (hookedEditor && editorChangeHandler) hookedEditor.event.change.remove(editorChangeHandler);
    hookedEditor = editor;
    // Ketcher emits change only for committed edits and undo/redo, never hover previews.
    editorChangeHandler = function () {
      captureStructureChange(lastObservedSnapshot, structureSnapshot(editor), 'editor_change');
    };
    editor.event.change.add(editorChangeHandler);
    lastObservedSnapshot = structureSnapshot(editor);
    startStructurePolling(editor);
    if (state.recording) record('monitor_ready', { ketcherVersion: document.title });
    notifyHostEditorReady();
    return true;
  }

  function waitForEditor() {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (hookEditor() || attempts > 300) clearInterval(timer);
    }, EDITOR_READY_CHECK_INTERVAL_MS);
  }

  function coefficientOfVariation(values) {
    if (!values || values.length < 2) return null;
    var mean = values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
    if (!mean) return 0;
    var variance = values.reduce(function (sum, value) { return sum + Math.pow(value - mean, 2); }, 0) / values.length;
    return Math.sqrt(variance) / mean;
  }

  function median(values) {
    if (!values || !values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function repeatedIntervalRatio(values) {
    if (!values || !values.length) return null;
    var bins = {};
    var largest = 0;
    values.forEach(function (value) {
      var key = String(Math.round(value / 50) * 50);
      bins[key] = (bins[key] || 0) + 1;
      largest = Math.max(largest, bins[key]);
    });
    return round(largest / values.length, 3);
  }

  function shannonEntropy(values, binCount) {
    if (!values || !values.length || !binCount) return null;
    var counts = new Array(binCount).fill(0);
    values.forEach(function (value) {
      if (typeof value === 'number' && value >= 0 && value < binCount) counts[value] += 1;
    });
    var total = counts.reduce(function (sum, value) { return sum + value; }, 0);
    if (!total) return null;
    var entropy = 0;
    counts.forEach(function (count) {
      if (!count) return;
      var p = count / total;
      entropy -= p * Math.log(p) / Math.log(2);
    });
    return entropy;
  }

  function speedBin(speed) {
    if (speed < 50) return 0;
    if (speed < 120) return 1;
    if (speed < 250) return 2;
    if (speed < 500) return 3;
    if (speed < 900) return 4;
    return 5;
  }

  function trailPointList(session, canvasOnly) {
    var trail = (session.pointerTrail || []).filter(function (point) {
      return point && isFinite(point.x) && isFinite(point.y) && isFinite(point.t) && (!canvasOnly || point.canvas);
    });
    if (trail.length >= 3) return trail;
    var points = [];
    (session.strokes || []).forEach(function (stroke) {
      if (canvasOnly && !stroke.canvas) return;
      (stroke.points || []).forEach(function (point) {
        if (!point || !isFinite(point.x) || !isFinite(point.y)) return;
        points.push({
          t: (stroke.startedAt || 0) + (point.dt || 0),
          x: point.x,
          y: point.y,
          canvas: stroke.canvas,
          pointerType: stroke.pointerType
        });
      });
    });
    return points.sort(function (a, b) { return a.t - b.t; });
  }

  function pathChordRatioForStroke(stroke) {
    if (!stroke || !stroke.points || stroke.points.length < 2 || !stroke.displacementPx) return null;
    if (stroke.displacementPx < 2) return null;
    return stroke.pathPx / stroke.displacementPx;
  }

  function mouseEntropyMetrics(session, canvasStrokes) {
    var allPoints = trailPointList(session, false);
    var canvasPoints = trailPointList(session, true);
    var analysisPoints = canvasPoints.length >= 8 ? canvasPoints : allPoints;
    var directionBins = [];
    var speedBins = [];
    var speeds = [];
    var pauses = 0;
    var path = 0;
    var chord = analysisPoints.length >= 2 ? distance(analysisPoints[0], analysisPoints[analysisPoints.length - 1]) : 0;
    for (var i = 1; i < analysisPoints.length; i += 1) {
      var previous = analysisPoints[i - 1];
      var current = analysisPoints[i];
      var dt = Math.max(1, current.t - previous.t);
      var dist = distance(previous, current);
      if (dt > 2000) continue;
      path += dist;
      var speed = dist / dt * 1000;
      speeds.push(speed);
      if (dist < 3 || speed < 50) {
        directionBins.push(0);
        pauses += dt >= 50 ? 1 : 0;
      } else {
        var angle = Math.atan2(current.y - previous.y, current.x - previous.x);
        if (angle < 0) angle += Math.PI * 2;
        directionBins.push(1 + Math.floor((angle + Math.PI / 8) / (Math.PI / 4)) % 8);
      }
      speedBins.push(speedBin(speed));
    }

    var gridBins = [];
    var viewport = session.viewport || {};
    var gridColumns = 8;
    var gridRows = 6;
    var width = Math.max(1, viewport.width || window.innerWidth || 1);
    var height = Math.max(1, viewport.height || window.innerHeight || 1);
    analysisPoints.forEach(function (point) {
      var gx = clamp(Math.floor(point.x / width * gridColumns), 0, gridColumns - 1);
      var gy = clamp(Math.floor(point.y / height * gridRows), 0, gridRows - 1);
      gridBins.push(gy * gridColumns + gx);
    });

    var directionEntropy = shannonEntropy(directionBins, 9);
    var speedEntropy = shannonEntropy(speedBins, 6);
    var gridEntropy = shannonEntropy(gridBins, gridColumns * gridRows);
    var pathRatios = (canvasStrokes || []).map(pathChordRatioForStroke).filter(function (value) { return value !== null && isFinite(value); });
    var meanPathChordRatio = pathRatios.length
      ? pathRatios.reduce(function (sum, value) { return sum + value; }, 0) / pathRatios.length
      : (chord >= 2 ? path / chord : null);
    var directionNorm = directionEntropy === null ? null : directionEntropy / (Math.log(9) / Math.log(2));
    var speedNorm = speedEntropy === null ? null : speedEntropy / (Math.log(6) / Math.log(2));
    var gridNorm = gridEntropy === null ? null : gridEntropy / (Math.log(gridColumns * gridRows) / Math.log(2));
    var pathScore = meanPathChordRatio === null ? null : clamp((meanPathChordRatio - 1) / 2, 0, 1);
    var pauseRatio = directionBins.length ? pauses / directionBins.length : null;
    var pauseScore = pauseRatio === null ? null : clamp(pauseRatio * 4, 0, 1);
    var components = [directionNorm, speedNorm, gridNorm, pathScore, pauseScore]
      .filter(function (value) { return value !== null && isFinite(value); });
    var entropyScore = components.length
      ? components.reduce(function (sum, value) { return sum + value; }, 0) / components.length * 5
      : null;
    return {
      mouseEntropyScore: entropyScore === null ? null : round(entropyScore, 3),
      mouseDirectionEntropy: directionEntropy === null ? null : round(directionEntropy, 3),
      mouseDirectionEntropyNorm: directionNorm === null ? null : round(directionNorm, 3),
      mouseSpeedEntropy: speedEntropy === null ? null : round(speedEntropy, 3),
      mouseSpeedEntropyNorm: speedNorm === null ? null : round(speedNorm, 3),
      mouseGridEntropy: gridEntropy === null ? null : round(gridEntropy, 3),
      mouseGridEntropyNorm: gridNorm === null ? null : round(gridNorm, 3),
      mousePathChordRatio: meanPathChordRatio === null ? null : round(meanPathChordRatio, 3),
      mousePauseCount: pauses,
      mousePauseRatio: pauseRatio === null ? null : round(pauseRatio, 3),
      mouseEntropySegments: directionBins.length,
      mouseEntropySamplePoints: analysisPoints.length,
      mouseEntropySource: canvasPoints.length >= 8 ? 'canvas_pointer_trail' : allPoints.length >= 3 ? 'pointer_trail' : 'strokes'
    };
  }

  function isCorrectionLabel(label) {
    return /(^|\b)(delete|erase|undo|redo)(\b|$)|删除|擦除|撤销|重做/i.test(String(label || '')) &&
      !/clear canvas|清空画板/i.test(String(label || ''));
  }

  function isStructuralToolLabel(label) {
    return /template|bond|atom|button|period|table|chain|ring|aromat|dearomat|layout|clean|stereo|enhanced|erase|delete|undo|redo|h-button|c-button|n-button|o-button|s-button|p-button|f-button|cl-button|br-button|i-button|苯|环|键|原子|模板|删除|撤销|重做/i
      .test(String(label || ''));
  }

  function isCanvasInputEvent(event) {
    return Boolean(event && (
      (event.type === 'pointer_down' && event.data && event.data.canvas) ||
      (event.type === 'click' && event.data && event.data.canvas && !isStructuralToolLabel(event.data.target))
    ));
  }

  function isToolInputEvent(event) {
    return Boolean(event && event.type === 'click' && event.data &&
      (event.data.popupOption || event.data.opensPopup || isStructuralToolLabel(event.data.target) || !event.data.canvas));
  }

  function isCorrectionEvent(event) {
    return Boolean(event && (
      (event.type === 'key_action' && event.data && (event.data.action === 'undo' || event.data.action === 'redo' || event.data.action === 'delete')) ||
      (event.type === 'click' && event.data && isCorrectionLabel(event.data.target))
    ));
  }

  function recentEventBefore(events, t, predicate, maxAgeMs) {
    for (var i = events.length - 1; i >= 0; i -= 1) {
      var event = events[i];
      if (event.t > t) continue;
      if (t - event.t > maxAgeMs) break;
      if (predicate(event)) return event;
    }
    return null;
  }

  function attributeStructureChanges(session) {
    var changes = session.structureChanges || [];
    var events = session.events || [];
    var previousAttributed = null;
    var counts = {
      manualLinked: 0,
      toolGenerated: 0,
      correctionLinked: 0,
      autoLayout: 0,
      unattributed: 0,
      meaningful: 0
    };
    var transactions = [];
    changes.forEach(function (change) {
      var correction = recentEventBefore(events, change.t, isCorrectionEvent, CORRECTION_LINK_WINDOW_MS);
      var canvasInput = recentEventBefore(events, change.t, isCanvasInputEvent, CANVAS_INPUT_LINK_WINDOW_MS);
      var toolInput = recentEventBefore(events, change.t, isToolInputEvent, TOOL_INPUT_LINK_WINDOW_MS);
      var attribution = 'unattributed';
      var sourceEvent = null;
      var sourceLabel = null;
      var sourceDelayMs = null;
      var autoLayout = change.action === 'move_structure' && previousAttributed &&
        previousAttributed.attribution !== 'unattributed' &&
        change.t - previousAttributed.change.t <= 1800;

      if (autoLayout) {
        attribution = 'auto_layout';
        sourceEvent = previousAttributed.sourceEvent;
        sourceLabel = 'Ketcher 自动布局/坐标刷新';
        sourceDelayMs = change.t - previousAttributed.change.t;
      } else if (correction) {
        attribution = 'correction_linked';
        sourceEvent = correction;
      } else if (canvasInput) {
        attribution = 'manual_linked';
        sourceEvent = canvasInput;
      } else if (toolInput) {
        attribution = 'tool_generated';
        sourceEvent = toolInput;
      }

      if (sourceEvent && !sourceLabel) {
        sourceLabel = sourceEvent.type === 'key_action'
          ? sourceEvent.data.action
          : (sourceEvent.data && sourceEvent.data.target) || sourceEvent.type;
        sourceDelayMs = Math.max(0, change.t - sourceEvent.t);
      }

      change.attribution = attribution;
      change.attributionLabel = sourceLabel;
      change.attributionDelayMs = sourceDelayMs;
      change.inputLinked = attribution !== 'unattributed' && attribution !== 'auto_layout';

      if (attribution === 'manual_linked') counts.manualLinked += 1;
      else if (attribution === 'tool_generated') counts.toolGenerated += 1;
      else if (attribution === 'correction_linked') counts.correctionLinked += 1;
      else if (attribution === 'auto_layout') counts.autoLayout += 1;
      else counts.unattributed += 1;

      if (attribution !== 'auto_layout') counts.meaningful += 1;
      if (attribution !== 'unattributed') {
        previousAttributed = { change: change, attribution: attribution, sourceEvent: sourceEvent };
      }

      if (sourceEvent && attribution !== 'auto_layout') {
        var last = transactions[transactions.length - 1];
        if (!last || last.sourceT !== sourceEvent.t || change.t - last.lastChangeT > EDIT_TRANSACTION_GAP_MS) {
          transactions.push({
            sourceT: sourceEvent.t,
            sourceType: sourceEvent.type,
            sourceLabel: sourceLabel,
            firstChangeT: change.t,
            lastChangeT: change.t,
            changes: 1,
            actions: [change.action],
            attribution: attribution
          });
        } else {
          last.lastChangeT = change.t;
          last.changes += 1;
          if (last.actions.indexOf(change.action) < 0) last.actions.push(change.action);
        }
      }
    });
    counts.attributed = counts.manualLinked + counts.toolGenerated + counts.correctionLinked;
    counts.attributionRatio = counts.meaningful ? round(counts.attributed / counts.meaningful, 3) : null;
    counts.unattributedRatio = counts.meaningful ? round(counts.unattributed / counts.meaningful, 3) : null;
    counts.transactions = transactions.length;
    return { counts: counts, transactions: transactions };
  }

  function buildFeatures(session) {
    var durationMs = session.performanceStart === null ? 0 : Math.max(0, (session.endedPerformance || performance.now()) - session.performanceStart);
    var changes = session.structureChanges;
    var intervals = [];
    for (var i = 1; i < changes.length; i += 1) intervals.push(changes[i].t - changes[i - 1].t);
    var structureReductions = changes.filter(function (item) { return item.action === 'reduce_structure'; }).length;
    var correctionIntents = session.events.filter(function (item) {
      return (item.type === 'key_action' && (item.data.action === 'undo' || item.data.action === 'redo' || item.data.action === 'delete')) ||
        (item.type === 'click' && !item.data.canvas && isCorrectionLabel(item.data.target));
    });
    var corrections = correctionIntents.filter(function (intent) {
      return changes.some(function (change) { return change.t >= intent.t && change.t - intent.t <= CORRECTION_LINK_WINDOW_MS; });
    }).length;
    var canvasStrokes = session.strokes.filter(function (stroke) { return stroke.canvas; });
    var dragStrokes = canvasStrokes.filter(function (stroke) { return stroke.pathPx >= 18 && stroke.durationMs >= 100 && stroke.points.length >= 4; });
    var curvedStrokes = dragStrokes.filter(function (stroke) { return stroke.straightness < 0.94 || stroke.directionChanges >= 2; });
    var straightDragStrokes = dragStrokes.filter(function (stroke) { return stroke.straightness >= 0.985 && stroke.directionChanges === 0; });
    var dragSpeeds = dragStrokes.map(function (stroke) { return stroke.meanSpeedPxPerSec; }).filter(function (speed) { return speed > 0; });
    var canvasInputs = session.events.filter(function (event) { return event.type === 'pointer_down' && event.data && event.data.canvas; });
    var pointerIntervals = [];
    for (var p = 1; p < canvasInputs.length; p += 1) pointerIntervals.push(canvasInputs[p].t - canvasInputs[p - 1].t);
    var clickLabels = session.events.filter(function (event) { return event.type === 'click' && !event.data.canvas; })
      .map(function (event) { return event.data.target; });
    var uniqueTools = Array.from(new Set(clickLabels)).length;
    var finalChange = changes.length ? changes[changes.length - 1].after : { atoms: 0, bonds: 0 };
    var idleGaps = intervals.filter(function (interval) { return interval >= 2000; }).length;
    var firstAction = session.events.find(function (event) {
      return event.type === 'pointer_down' || event.type === 'click' || event.type === 'key_action' || event.type === 'structure_change';
    });
    var attribution = attributeStructureChanges(session);
    var linkedChanges = changes.filter(function (change) { return change.inputLinked; });
    var templateBulkChanges = changes.filter(function (change) { return change.action === 'bulk_add' && change.attribution !== 'unattributed'; });
    var importEvents = session.events.filter(function (event) { return event.type === 'import_blocked'; });
    var mouseEntropy = mouseEntropyMetrics(session, canvasStrokes);
    return Object.assign({
      durationMs: Math.round(durationMs),
      durationSec: round(durationMs / 1000, 1),
      eventCount: session.events.length,
      structureChanges: changes.length,
      finalAtoms: finalChange.atoms || 0,
      finalBonds: finalChange.bonds || 0,
      corrections: corrections,
      correctionIntents: correctionIntents.length,
      structureReductions: structureReductions,
      canvasStrokes: canvasStrokes.length,
      manualCanvasActions: canvasInputs.length,
      dragStrokes: dragStrokes.length,
      curvedStrokes: curvedStrokes.length,
      straightDragRatio: dragStrokes.length ? round(straightDragStrokes.length / dragStrokes.length, 3) : null,
      dragSpeedCv: dragSpeeds.length >= 2 ? round(coefficientOfVariation(dragSpeeds), 3) : null,
      trajectoryPoints: canvasStrokes.reduce(function (sum, stroke) { return sum + stroke.points.length; }, 0),
      pathPx: round(canvasStrokes.reduce(function (sum, stroke) { return sum + stroke.pathPx; }, 0), 1),
      uniqueTools: uniqueTools,
      intervalCv: intervals.length ? round(coefficientOfVariation(intervals), 3) : null,
      medianIntervalMs: median(intervals),
      pointerIntervalCv: pointerIntervals.length >= 2 ? round(coefficientOfVariation(pointerIntervals), 3) : null,
      pointerMedianIntervalMs: median(pointerIntervals),
      pointerRepeatRatio: repeatedIntervalRatio(pointerIntervals),
      pointerIntervals: pointerIntervals.length,
      idleGaps: idleGaps,
      startDelayMs: firstAction ? firstAction.t : durationMs,
      linkedStructureChanges: linkedChanges.length,
      unlinkedStructureChanges: changes.length - linkedChanges.length,
      linkedChangeRatio: changes.length ? round(linkedChanges.length / changes.length, 3) : null,
      templateBulkChanges: templateBulkChanges.length,
      editTransactions: attribution.counts.transactions,
      transactionAttribution: attribution.counts,
      transactionSummaries: attribution.transactions.slice(-20),
      blockedPaste: session.counters.blockedPaste,
      blockedImport: session.counters.blockedImport || 0,
      importAttempts: importEvents.length,
      importKinds: Array.from(new Set(importEvents.map(function (event) { return event.data.kind; })))
    }, mouseEntropy);
  }

  

  

  

  function appendLiveEvent(event) {
    var kind = liveEventKind(event);
    var list = document.querySelector('#kum-live-list');
    if (!kind || !list) return;
    var empty = list.querySelector('.kum-live-empty');
    if (empty) empty.remove();
    var shouldFollow = list.scrollHeight - list.scrollTop - list.clientHeight < 70;
    var row = document.createElement('div');
    row.className = 'kum-live-row kum-live-' + event.type.replace(/_/g, '-');
    row.innerHTML = '<time>+' + (event.t / 1000).toFixed(2) + 's</time><b>' + escapeHtml(kind) + '</b><span>' + escapeHtml(compactEventLabel(event)) + '</span>';
    list.appendChild(row);
    while (list.children.length > 250) list.removeChild(list.firstChild);
    if (shouldFollow) list.scrollTop = list.scrollHeight;
  }

  

  function updateLiveSummary() {
    var structure = document.querySelector('#kum-live-structure');
    var corrections = document.querySelector('#kum-live-corrections');
    var tracks = document.querySelector('#kum-live-tracks');
    if (!state || !structure || !corrections || !tracks) return;
    var features = buildFeatures(state);
    structure.textContent = features.structureChanges;
    corrections.textContent = features.corrections;
    tracks.textContent = features.dragStrokes;
  }

  

  async function uploadReport(report) {
    if (!CONFIG.autoUpload || !/^https?:$/.test(window.location.protocol)) return;
    try {
      var response = await fetch(CONFIG.reportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
        credentials: 'same-origin'
      });
      var result = await response.json();
      if (!response.ok || !result.ok || !result.classification || result.classification.source !== 'server') {
        throw verificationError(result, response.status);
      }
      report.accepted = result.accepted === true;
      report.attentionVerification = result.attentionVerification;
      report.timeVerification = result.timeVerification;
      if (result && result.classification) {
        report.clientClassification = report.classification;
        report.classification = result.classification;
      }
      if (result && result.challengeVerification) report.challengeVerification = result.challengeVerification;
      report.delivery = { ok: true, uploadedAt: isoNow(), reportUrl: result.reportUrl || null };
    } catch (error) {
      markUnverified(report, error && error.message || error);
    }
  }

  async function readFinalStructure() {
    if (!window.ketcher) return null;
    hideTemplatePreview();
    var result = {};
    try { if (typeof window.ketcher.getSmiles === 'function') result.smiles = await window.ketcher.getSmiles(); } catch (_) {}
    try { result.counts = structureSnapshot(window.ketcher.editor); } catch (_) {}
    return result;
  }

  async function finalize(reason, show) {
    if (finalizePending) return finalizePending;
    if (!state || (!state.recording && !state.finalized)) return null;
    if (state.finalized) { if (show !== false) showReport(lastReport); return lastReport; }
    var targetState = state;
    finalizePending = (async function () {
      // Record the Finish receipt before any attention-check wait or upload delay.
      try { await recordDrawingCompletion(targetState); }
      catch (error) { targetState.telemetryError = String(error && error.message || error); }
      if (state !== targetState) return null;
      // Keep committing evidence while the one-per-question check is pending.
      // Finishing early cannot skip or shorten the challenge.
      if (attention) await attention.wait();
      if (state !== targetState) return null;
      stopCheckpoints();
      if (CONFIG.autoUpload && targetState.structureChanges.length && !targetState.committedStructureChanges && !targetState.telemetryError) {
        // Drain any initial/periodic request before sending an early drawing checkpoint.
        try {
          await targetState.checkpointChain;
          await waitMs(300);
          await queueCheckpoint(targetState, false);
        } catch (_) { /* Marked unverified below; never fall back to local success. */ }
      }
      // Capture the final pending poll before stopping the observation clock.
      if (hookedEditor) {
        var snapshot = structureSnapshot(hookedEditor);
        if (snapshotsDiffer(lastObservedSnapshot, snapshot)) captureStructureChange(lastObservedSnapshot, snapshot, 'final');
      }
      targetState.endedAt = isoNow();
      targetState.endedPerformance = performance.now();
      targetState.endReason = reason || 'completed';
      targetState.recording = false;
      targetState.finalStructure = await readFinalStructure();
      await captureFinalReplayFrame(targetState);
      targetState.finalized = true;
      var report = buildReport(targetState);
      try {
        await queueCheckpoint(targetState, true);
        if (targetState.serverSession) report.security.checkpoint = {
          sequence: targetState.serverSession.checkpointSequence,
          nonce: targetState.serverSession.checkpointNonce
        };
        await uploadReport(report);
        if (!report.delivery || !report.delivery.ok) markUnverified(report, (report.delivery || {}).error || 'No server verification');
      } catch (error) {
        // A server timing rejection is conclusive even if drawing evidence is incomplete.
        if (targetState.timeVerification && !targetState.timeVerification.passed) await uploadReport(report);
        else markUnverified(report, error && error.message || error);
      }
      if (state !== targetState) return report;
      lastReport = report;
      try { localStorage.removeItem(STORAGE_DRAFT); } catch (_) {}
      updateDock();
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ eventType: 'ketcher-usage-report', report: report }, window.location.origin);
      }
      if (show !== false) showReport(report);
      return report;
    })();
    try { return await finalizePending; } finally { finalizePending = null; }
  }

  function finalizeSyncOnExit() {
    if (attention) attention.stop();
    // Closing a tab cannot complete the verified protocol. Do not send a
    // partial report or persist reusable bearer credentials in localStorage.
    stopCheckpoints();
    if (state) state.recording = false;
    try { localStorage.removeItem(STORAGE_DRAFT); } catch (_) {}
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  

  function showReport(report) {
    if (!report) return;
    lastReport = report;
    var modal = document.querySelector('#kum-report');
    var backdrop = document.querySelector('#kum-backdrop');
    if (!modal || !backdrop) return;
    modal.innerHTML = reportHtml(report);
    backdrop.classList.remove('kum-hidden');
  }

  function closeReport() {
    var backdrop = document.querySelector('#kum-backdrop');
    if (backdrop) backdrop.classList.add('kum-hidden');
  }

  

  

  

  async function beginSession() {
    if (beginPending || finalizePending || (state && state.recording)) return;
    beginPending = true;
    if (attention) attention.stop();
    stopCheckpoints();
    stopReplay(false);
    closeReport();
    var button = document.querySelector('[data-kum-action="start"]');
    if (button) button.disabled = true;
    try {
      // A molecule drawn before Start must not be claimed as an empty initial frame.
      await clearCanvas();
      var serverSession = await requestServerSession();
      if (CONFIG.autoUpload && (!serverSession || !serverSession.ok || serverSession.protocolVersion !== 3 || !serverSession.attentionRequired || serverSession.attentionVersion !== 3 || !attention)) {
        throw new Error('无法建立安全检测会话，请换一题重新检测。 / Unable to start a verified session.');
      }
      window.dispatchEvent(new Event('ketcher-detection-reset'));
      state = createSession(true, serverSession);
      state.replayFrames.push({t: 0, action: 'initial', atoms: 0, bonds: 0,
        recentTool: null, atomPositions: [], zoom: null, molfile: ''});
      replayCaptureChain = Promise.resolve();
      lastPointerTrailPoint = null;
      lastPointerTrailTarget = null;
      lastReport = null;
      activeStroke = null;
      lastObservedSnapshot = hookedEditor ? structureSnapshot(hookedEditor) : null;
      record('session_started', {});
      if (hookedEditor) record('monitor_ready', {ketcherVersion: document.title});
      state.recording = false;
      await queueCheckpoint(state, false);
      state.recording = true;
      if (attention) attention.start({endpoint: CONFIG.sessionEndpoint || 'api/sessions',
        sessionId:serverSession.sessionId, token:serverSession.token, record:record});
      if (hookedEditor) startStructurePolling(hookedEditor);
      waitForEditor();
      if (CONFIG.autoUpload) checkpointTimer = setInterval(function () {
        if (state && state.recording && !state.finalized) queueCheckpoint(state, false).catch(function () {});
      }, serverSession.checkpointIntervalMs || 1500);
      updateDock();
      renderLiveEvents();
    } catch (error) {
      if (state) state.recording = false;
      updateDock();
      window.alert(String(error && error.message || error));
    } finally {
      beginPending = false;
      if (button) button.disabled = false;
    }
  }

  async function clearCanvas() {
    var clearButton = document.querySelector('button[title^="Clear Canvas"],button[aria-label^="Clear Canvas"],[data-testid*="clear-canvas"]');
    if (clearButton && !clearButton.disabled) clearButton.click();
    else if (window.ketcher && typeof window.ketcher.setMolecule === 'function') {
      try { await window.ketcher.setMolecule(''); } catch (_) {}
    }
    await new Promise(function (resolve) { setTimeout(resolve, 250); });
    var remaining = hookedEditor ? structureSnapshot(hookedEditor) : null;
    if (remaining && (remaining.atoms > 0 || remaining.bonds > 0) && window.ketcher && typeof window.ketcher.setMolecule === 'function') {
      try { await window.ketcher.setMolecule(''); } catch (_) {}
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
  }

  async function resetDetection() {
    window.dispatchEvent(new Event('ketcher-detection-reset'));
    if (attention) attention.stop();
    stopCheckpoints();
    stopReplay(false);
    closeReport();
    state = createSession(false);
    lastReport = null;
    activeStroke = null;
    await clearCanvas();
    lastObservedSnapshot = hookedEditor ? structureSnapshot(hookedEditor) : null;
    if (hookedEditor) startStructurePolling(hookedEditor);
    waitForEditor();
    renderLiveEvents();
    updateDock();
  }

  

  function waitMs(duration) {
    return new Promise(function (resolve) { setTimeout(resolve, duration); });
  }

  function mainKetcherCanvas() {
    var candidates = Array.from(document.querySelectorAll('#root svg')).filter(function (svg) {
      var box = svg.getBoundingClientRect();
      return box.width > 300 && box.height > 300;
    });
    return candidates.sort(function (a, b) {
      var boxA = a.getBoundingClientRect();
      var boxB = b.getBoundingClientRect();
      return boxB.width * boxB.height - boxA.width * boxA.height;
    })[0] || null;
  }

  function beginReplayFrameTransition() {
    var canvas = mainKetcherCanvas();
    if (!canvas) return null;
    var box = canvas.getBoundingClientRect();
    var clone = canvas.cloneNode(true);
    clone.classList.add('kum-replay-canvas-snapshot');
    clone.style.left = Math.round(box.left) + 'px';
    clone.style.top = Math.round(box.top) + 'px';
    clone.style.width = Math.round(box.width) + 'px';
    clone.style.height = Math.round(box.height) + 'px';
    document.body.appendChild(clone);
    replayCanvasTransitionCount += 1;
    canvas.style.visibility = 'hidden';
    return { canvas: canvas, clone: clone };
  }

  function endReplayFrameTransition(transition) {
    if (!transition) return;
    replayCanvasTransitionCount = Math.max(0, replayCanvasTransitionCount - 1);
    if (transition.canvas && replayCanvasTransitionCount === 0) transition.canvas.style.visibility = '';
    if (transition.clone) transition.clone.remove();
  }

  function replayFramePositions(frame, report) {
    if (frame.atomPositions && frame.atomPositions.length) {
      var positions = frame.atomPositions.slice();
      var hasOrder = positions.some(function (position) { return typeof position.order === 'number'; });
      if (!hasOrder) return positions;
      return positions.sort(function (a, b) {
        var orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
        var orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return String(a.id).localeCompare(String(b.id));
      });
    }
    var changes = report && report.structureChanges || [];
    var matched = null;
    for (var i = 0; i < changes.length; i += 1) {
      if (changes[i].t > frame.t) break;
      matched = changes[i];
    }
    var digest = matched && matched.after && matched.after.positionDigest;
    if (!digest) return [];
    return digest.split('|').map(function (item) {
      var parts = item.split(':');
      var coordinates = (parts[1] || '').split(',');
      return {
        id: parts[0],
        x: Number(coordinates[0]),
        y: Number(coordinates[1])
      };
    }).filter(function (position) {
      return position.id !== '' && isFinite(position.x) && isFinite(position.y);
    });
  }

  function currentReplayAtoms(editor) {
    var atoms = [];
    try {
      var struct = editor && typeof editor.struct === 'function' ? editor.struct() : null;
      if (!struct || !struct.atoms) return atoms;
      function append(atom, id) {
        if (!atom || !atom.pp) return;
        atoms.push({ atom: atom, id: id, label: atom.label || '' });
      }
      if (typeof struct.atoms.forEach === 'function') struct.atoms.forEach(function (atom, id) { append(atom, id); });
      else if (typeof struct.atoms.each === 'function') struct.atoms.each(function (id, atom) { append(atom, id); });
    } catch (_) {}
    return atoms;
  }

  function labelsCompatible(positions, atoms) {
    for (var i = 0; i < positions.length; i += 1) {
      if (!positions[i].label) continue;
      if (String(positions[i].label) !== String(atoms[i].label || '')) return false;
    }
    return true;
  }

  function restoreReplayFrameView(frame, report) {
    if (!hookedEditor) return;
    var positions = replayFramePositions(frame, report);
    var atoms = currentReplayAtoms(hookedEditor);
    if (positions.length && positions.length === atoms.length && labelsCompatible(positions, atoms)) {
      positions.forEach(function (position, index) {
        var atom = atoms[index] && atoms[index].atom;
        if (!atom || !atom.pp || !isFinite(position.x) || !isFinite(position.y)) return;
        atom.pp.x = position.x;
        atom.pp.y = position.y;
      });
    }
    if (typeof frame.zoom === 'number' && typeof hookedEditor.zoom === 'function') hookedEditor.zoom(frame.zoom);
    if (hookedEditor.render && typeof hookedEditor.render.update === 'function') hookedEditor.render.update(true);
  }

  

  function processReplayFrameQueue(player) {
    if (!player || player !== replayPlayer || player.applyingFrame) return;
    if (player.requestedFrameIndex < 0 || player.requestedFrameIndex === player.frameIndex) return;
    var frameIndex = player.requestedFrameIndex;
    player.applyingFrame = true;
    applyReplayFrameNow(player, frameIndex).catch(function () {}).finally(function () {
      if (player !== replayPlayer) return;
      player.applyingFrame = false;
      if (player.requestedFrameIndex !== player.frameIndex) processReplayFrameQueue(player);
    });
  }

  function requestReplayFrame(frameIndex) {
    if (!replayPlayer || frameIndex < 0) return;
    replayPlayer.requestedFrameIndex = frameIndex;
    processReplayFrameQueue(replayPlayer);
  }

  function replayFrameAt(timeMs) {
    if (!replayPlayer) return -1;
    var frames = replayPlayer.report.replay.frames || [];
    var result = -1;
    for (var i = 0; i < frames.length; i += 1) {
      if (frames[i].t > timeMs) break;
      result = i;
    }
    return result;
  }

  function replayPointAt(timeMs) {
    if (!replayPlayer) return null;
    var trail = replayPlayer.report.replay.pointerTrail || [];
    if (trail.length) {
      if (timeMs <= trail[0].t) return trail[0];
      var low = 0;
      var high = trail.length - 1;
      while (low <= high) {
        var middle = Math.floor((low + high) / 2);
        if (trail[middle].t <= timeMs) low = middle + 1;
        else high = middle - 1;
      }
      return trail[Math.max(0, high)];
    }
    var strokes = replayPlayer.report.replay.strokes || [];
    var lastPoint = null;
    for (var i = 0; i < strokes.length; i += 1) {
      var stroke = strokes[i];
      if (!stroke.canvas || !stroke.points || !stroke.points.length) continue;
      if (!lastPoint) lastPoint = stroke.points[0];
      if (timeMs < stroke.startedAt) break;
      if (timeMs > stroke.startedAt + stroke.durationMs) {
        lastPoint = stroke.points[stroke.points.length - 1];
        continue;
      }
      var elapsed = timeMs - stroke.startedAt;
      lastPoint = stroke.points[0];
      for (var p = 1; p < stroke.points.length; p += 1) {
        if (stroke.points[p].dt > elapsed) break;
        lastPoint = stroke.points[p];
      }
      break;
    }
    return lastPoint;
  }

  function updateReplayCursor(timeMs) {
    var cursor = document.querySelector('#kum-replay-cursor');
    if (!cursor || !replayPlayer) return;
    var point = replayPointAt(timeMs);
    if (!point) {
      cursor.classList.add('kum-hidden');
      return;
    }
    var viewport = replayPlayer.report.replay.viewport || replayPlayer.report.session.viewport || {};
    var scaleX = window.innerWidth / Math.max(1, viewport.width || window.innerWidth);
    var scaleY = window.innerHeight / Math.max(1, viewport.height || window.innerHeight);
    cursor.style.left = Math.round(point.x * scaleX) + 'px';
    cursor.style.top = Math.round(point.y * scaleY) + 'px';
    cursor.classList.remove('kum-hidden');
  }

  function clearReplayHighlight() {
    document.querySelectorAll('.kum-replay-highlight').forEach(function (element) {
      element.classList.remove('kum-replay-highlight');
    });
  }

  function findReplayControl(label) {
    var value = String(label || '').trim();
    if (!value) return null;
    var escaped = window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
    var direct = document.querySelector('[data-testid="' + escaped + '"],[title="' + escaped + '"],[aria-label="' + escaped + '"]');
    if (direct) return direct.closest('button,[role="button"],[role="menuitem"]') || direct;
    var controls = document.querySelectorAll('button,[role="button"],[role="menuitem"],[data-testid],[title],[aria-label]');
    for (var i = 0; i < controls.length; i += 1) {
      var control = controls[i];
      if (control.closest('#kum-root')) continue;
      var values = [
        control.getAttribute('data-testid'),
        control.getAttribute('title'),
        control.getAttribute('aria-label'),
        (control.textContent || '').replace(/\s+/g, ' ').trim()
      ].filter(Boolean);
      if (values.some(function (item) { return item === value || item.indexOf(value) === 0 || value.indexOf(item) === 0; })) {
        return control.closest('button,[role="button"],[role="menuitem"]') || control;
      }
    }
    return null;
  }

  function replayCuesAt(timeMs) {
    if (!replayPlayer) return [];
    var events = replayPlayer.report.timeline || [];
    var recent = [];
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i];
      if (event.t > timeMs) break;
      if (event.type === 'key_action' || (event.type === 'click' && event.data && !event.data.canvas)) {
        if (timeMs - event.t <= 2600) recent.push(event);
      }
    }
    return recent.slice(-3);
  }

  

  function closeReplayKetcherPopups() {
    var snapshot = document.querySelector('#kum-replay-popup-snapshot');
    if (snapshot) snapshot.remove();
    if (replayPlayer && replayPlayer.popupCloseTimer) {
      clearTimeout(replayPlayer.popupCloseTimer);
      replayPlayer.popupCloseTimer = null;
    }
    if (!visibleKetcherPopups().length) return;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
  }

  function sanitizedPopupElement(html) {
    var template = document.createElement('template');
    template.innerHTML = String(html || '').trim();
    var element = template.content.firstElementChild;
    if (!element) return null;
    element.querySelectorAll('script,iframe,object,embed,input,textarea').forEach(function (node) { node.remove(); });
    [element].concat(Array.from(element.querySelectorAll('*'))).forEach(function (node) {
      Array.from(node.attributes || []).forEach(function (attribute) {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      });
    });
    return element;
  }

  function showReplayPopupSnapshot(snapshot) {
    closeReplayKetcherPopups();
    if (!snapshot || !snapshot.html || !snapshot.rect || !replayPlayer) return false;
    var element = sanitizedPopupElement(snapshot.html);
    if (!element) return false;
    var viewport = replayPlayer.report.replay.viewport || replayPlayer.report.session.viewport || {};
    var scaleX = window.innerWidth / Math.max(1, viewport.width || window.innerWidth);
    var scaleY = window.innerHeight / Math.max(1, viewport.height || window.innerHeight);
    element.id = 'kum-replay-popup-snapshot';
    element.classList.add('kum-replay-popup-snapshot');
    element.style.position = 'fixed';
    element.style.left = Math.round(snapshot.rect.left * scaleX) + 'px';
    element.style.top = Math.round(snapshot.rect.top * scaleY) + 'px';
    element.style.width = Math.round(snapshot.rect.width * scaleX) + 'px';
    element.style.height = Math.round(snapshot.rect.height * scaleY) + 'px';
    document.body.appendChild(element);
    return true;
  }

  function selectReplayPopupOption(data) {
    var popup = document.querySelector('#kum-replay-popup-snapshot');
    if (!popup || !replayPlayer) return;
    var targetName = String(data.target || '');
    var option = Array.from(popup.querySelectorAll('button,[data-testid],[title]')).find(function (element) {
      return element.getAttribute('data-testid') === targetName ||
        element.getAttribute('title') === targetName;
    });
    if (option) option.classList.add('kum-replay-popup-option-selected');
    replayPlayer.popupCloseTimer = setTimeout(function () {
      var current = document.querySelector('#kum-replay-popup-snapshot');
      if (current) current.remove();
      if (replayPlayer) replayPlayer.popupCloseTimer = null;
    }, 260);
  }

  function dispatchReplayPopupClick(event) {
    var data = event.data || {};
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
    var viewport = replayPlayer.report.replay.viewport || replayPlayer.report.session.viewport || {};
    var x = Math.round(data.x * window.innerWidth / Math.max(1, viewport.width || window.innerWidth));
    var y = Math.round(data.y * window.innerHeight / Math.max(1, viewport.height || window.innerHeight));
    var target = document.elementFromPoint(x, y);
    if (!target || target.closest('#kum-root')) return;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      var EventClass = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventClass(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type.indexOf('down') >= 0 ? 1 : 0,
        pointerType: 'mouse',
        isPrimary: true
      }));
    });
  }

  function updateReplayPopupInteractions(timeMs) {
    if (!replayPlayer) return;
    var events = replayPlayer.report.timeline || [];
    if (timeMs < replayPlayer.lastInteractionTime) {
      closeReplayKetcherPopups();
      replayPlayer.interactionIndex = -1;
    }
    while (replayPlayer.interactionIndex + 1 < events.length &&
      events[replayPlayer.interactionIndex + 1].t <= timeMs) {
      replayPlayer.interactionIndex += 1;
      var event = events[replayPlayer.interactionIndex];
      if (event.type === 'click' && event.data && event.data.opensPopup) {
        if (!showReplayPopupSnapshot(event.data.popupSnapshot)) dispatchReplayPopupClick(event);
      } else if (event.type === 'click' && event.data && event.data.popupOption) {
        if (document.querySelector('#kum-replay-popup-snapshot')) selectReplayPopupOption(event.data);
        else if (visibleKetcherPopups().length) dispatchReplayPopupClick(event);
      }
    }
    replayPlayer.lastInteractionTime = timeMs;
  }

  function setReplayTime(timeMs, forceFrame) {
    if (!replayPlayer) return;
    var duration = replayPlayer.durationMs;
    replayPlayer.currentMs = clamp(Math.round(timeMs), 0, duration);
    var progress = document.querySelector('#kum-replay-progress');
    var time = document.querySelector('#kum-replay-time');
    if (progress) progress.value = replayPlayer.currentMs;
    if (time) time.textContent = (replayPlayer.currentMs / 1000).toFixed(1) + ' / ' + (duration / 1000).toFixed(1) + 's';
    var frameIndex = replayFrameAt(replayPlayer.currentMs);
    if (frameIndex >= 0 && (forceFrame || frameIndex !== replayPlayer.requestedFrameIndex)) requestReplayFrame(frameIndex);
    updateReplayCursor(replayPlayer.currentMs);
    updateReplayCue(replayPlayer.currentMs);
    updateReplayPopupInteractions(replayPlayer.currentMs);
  }

  

  

  

  function stopReplay(restoreFinal) {
    if (!replayPlayer) return;
    if (replayPlayer.raf) cancelAnimationFrame(replayPlayer.raf);
    var report = replayPlayer.report;
    replayPlayer = null;
    var panel = document.querySelector('#kum-replay');
    if (panel) panel.remove();
    clearReplayHighlight();
    closeReplayKetcherPopups();
    if (restoreFinal && report && report.replay && report.replay.frames.length) {
      var finalFrame = report.replay.frames[report.replay.frames.length - 1];
      if (window.ketcherManualOnlyGuard) {
        var transition = beginReplayFrameTransition();
        replayWriter(finalFrame.molfile).then(function () {
          return waitMs(180);
        }).then(function () {
          restoreReplayFrameView(finalFrame, report);
          return waitMs(50);
        }).catch(function () {}).finally(function () {
          endReplayFrameTransition(transition);
        });
      }
    }
  }

  

  

  function bindEvents() {
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', function (event) { handlePointerUp(event, false); }, true);
    document.addEventListener('pointercancel', function (event) { handlePointerUp(event, true); }, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('paste', function (event) {
      if (!state || !state.recording || state.finalized || isMonitorTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest('.cliparea')) {
        state.counters.blockedPaste += 1;
        record('paste_attempt', { target: 'canvas' });
      }
    }, true);
    window.addEventListener('ketcher-manual-only-violation', function (event) {
      if (!state || !state.recording || state.finalized) return;
      var detail = event.detail || {};
      var kind = String(detail.kind || 'unknown').slice(0, 40);
      state.counters.blockedImport += 1;
      if (kind === 'paste') state.counters.blockedPaste += 1;
      record('import_blocked', {
        kind: kind,
        method: detail.method ? String(detail.method).slice(0, 60) : null,
        inputType: detail.inputType ? String(detail.inputType).slice(0, 40) : null
      });
    });
    window.addEventListener('resize', function () { record('viewport_change', { width: window.innerWidth, height: window.innerHeight }); });
    window.addEventListener('pagehide', finalizeSyncOnExit);
  }

  var KUM_LANG_KEY = 'ketcher-usage-monitor:lang';
  var KUM_LANG = (function () {
    var query = new URLSearchParams(window.location.search).get('lang');
    var stored = null;
    try { stored = localStorage.getItem(KUM_LANG_KEY); } catch (_) {}
    var value = query || stored || 'en';
    value = value === 'zh' ? 'zh' : 'en';
    try { localStorage.setItem(KUM_LANG_KEY, value); } catch (_) {}
    return value;
  }());

  var KUM_TEXT = {
    en: {
      liveLog: 'Live operation log',
      collapse: 'Collapse log',
      expand: 'Operation log >',
      waiting: 'Waiting to start',
      recording: 'Recording ',
      completed: 'Recording complete',
      start: 'Start detection',
      finish: 'Finish and analyze',
      viewReport: 'View report',
      exportJson: 'Export JSON',
      exportSummaryImage: 'Export summary image',
      exportTimelineImage: 'Export timeline image',
      reset: 'New detection',
      structureChanges: 'Structure changes',
      corrections: 'Corrections',
      dragStrokes: 'Drag strokes',
      waitingCanvas: 'Waiting for drawing actions...',
      completedRecord: 'This recording is complete',
      startHint: 'Click "Start detection" to record actions',
      reportTitle: 'Drawing Behavior Analysis Report',
      session: 'Session',
      confidence: 'confidence',
      oldPolicy: 'Manual rule status was not recorded by this legacy report',
      duration: 'Session duration',
      dimensionTitle: 'Four-dimensional risk score',
      evidence: 'Evidence',
      timeline: 'Operation timeline (latest ',
      timelineSuffix: ' items)',
      noActions: 'No actions yet',
      note: 'This score is a tunable heuristic risk indicator and should not be used as the sole basis for blocking. Raw trajectories and the full timeline are included in the JSON report.',
      copy: 'Copy summary',
      closeReport: 'Close report',
      replay: 'Replay drawing process',
      construction: 'Construction process',
      trajectory: 'Pointer trajectory',
      rhythm: 'Operation rhythm',
      integrity: 'Manual integrity',
      editTransactions: 'Edit transactions',
      manualLinked: 'Canvas attribution',
      toolGenerated: 'Tool/menu attribution',
      unattributed: 'Unattributed',
      noEvidence: 'No effective evidence yet.',
      verdict: 'Verdict',
      risk_score: 'risk score',
      likelyBot: 'Likely bot',
      likelyHuman: 'Likely human',
      uncertain: 'Insufficient evidence',
      policyViolation: 'Blocked prohibited import',
      policyOk: 'Manual drawing only detected',
      notice: 'This result is a heuristic risk judgment and should not be used as the sole basis for blocking.',
      summaryTitle: 'Ketcher drawing behavior report',
      reason: 'Reasons:',
      manualRule: 'Manual drawing rule',
      riskDims: 'Risk dimensions',
      seconds: 'seconds',
      structure: 'Structure',
      keyboard: 'Keyboard',
      violation: 'Violation',
      canvas: 'Canvas',
      tool: 'Tool',
      stroke: 'Stroke',
      system: 'System',
      atoms: 'atoms',
      bonds: 'bonds',
      current: 'current',
      clickCanvas: 'Canvas click',
      selectTool: 'Select tool: ',
      keyAction: 'Keyboard action: ',
      uiPointer: 'Interface pointer action',
      canvasDrag: 'Canvas drag',
      ready: 'Ketcher is ready',
      sessionStarted: 'Started recording this drawing session',
      blocked: 'Blocked: ',
      pasteAttempt: 'Blocked canvas paste attempt',
      viewportChange: 'Browser viewport changed',
      replayTitle: 'Drawing process replay',
      replayProgress: 'Replay progress',
      replaySpeed: 'Replay speed',
      play: 'Play',
      pause: 'Pause',
      resume: 'Resume',
      replayAgain: 'Replay again',
      close: 'Close',
      waitingReplay: 'Waiting to start',
      keyboardOperation: 'Keyboard operation',
      toolButton: 'Tool button',
      unknownButton: 'Unknown button',
      noKey: 'Key',
      replayChannelMissing: 'Replay write channel is unavailable.'
    },
    zh: {
      liveLog: '实时操作日志',
      collapse: '收起日志',
      expand: '操作日志 >',
      waiting: '等待开始',
      recording: '记录中 ',
      completed: '记录已完成',
      start: '开始检测',
      finish: '完成并分析',
      viewReport: '查看报告',
      exportJson: '导出 JSON',
      exportSummaryImage: '导出汇总图片',
      exportTimelineImage: '导出时间线图片',
      reset: '重新检测',
      structureChanges: '结构变化',
      corrections: '明确纠错',
      dragStrokes: '拖动轨迹',
      waitingCanvas: '等待画板操作...',
      completedRecord: '本次记录已完成',
      startHint: '点击“开始检测”后记录操作',
      reportTitle: '绘图行为分析报告',
      session: '会话',
      confidence: '置信度',
      oldPolicy: '旧版报告未记录手工规则状态',
      duration: '会话时长',
      dimensionTitle: '四维风险分',
      evidence: '判定依据',
      timeline: '操作时间线（最近 ',
      timelineSuffix: ' 条）',
      noActions: '暂无操作',
      note: '该分数是可调节的启发式风险指标，不应单独作为封禁依据。原始轨迹与完整时间线包含在 JSON 报告中。',
      copy: '复制摘要',
      closeReport: '关闭报告',
      replay: '复刻绘制过程',
      construction: '构建过程',
      trajectory: '指针轨迹',
      rhythm: '操作节奏',
      integrity: '手工完整性',
      editTransactions: '编辑事务',
      manualLinked: '画板归因',
      toolGenerated: '工具/菜单归因',
      unattributed: '无法归因',
      noEvidence: '尚无有效证据。',
      verdict: '结论',
      risk_score: '风险分',
      likelyBot: '疑似机器人',
      likelyHuman: '更像人类',
      uncertain: '证据不足',
      policyViolation: '已拦截违规导入',
      policyOk: '仅检测到手工绘图',
      notice: '该结果是启发式风险判断，不应作为唯一的封禁依据。',
      summaryTitle: 'Ketcher 绘图行为报告',
      reason: '原因：',
      manualRule: '手工绘图规则',
      riskDims: '四维风险',
      seconds: '秒',
      structure: '结构',
      keyboard: '键盘',
      violation: '违规',
      canvas: '画板',
      tool: '工具',
      stroke: '轨迹',
      system: '系统',
      atoms: '原子',
      bonds: '键',
      current: '当前',
      clickCanvas: '点击画板',
      selectTool: '选择工具：',
      keyAction: '键盘操作：',
      uiPointer: '界面指针操作',
      canvasDrag: '画板拖动',
      ready: 'Ketcher 已就绪',
      sessionStarted: '开始记录本次绘图会话',
      blocked: '已拦截：',
      pasteAttempt: '拦截画板粘贴尝试',
      viewportChange: '浏览器窗口尺寸改变',
      replayTitle: '绘制过程复刻',
      replayProgress: '回放进度',
      replaySpeed: '回放速度',
      play: '播放',
      pause: '暂停',
      resume: '继续',
      replayAgain: '重新播放',
      close: '关闭',
      waitingReplay: '等待开始',
      keyboardOperation: '键盘操作',
      toolButton: '工具按钮',
      unknownButton: '未知按钮',
      noKey: '按键',
      replayChannelMissing: '回放写入通道不可用。'
    }
  };

  function ui(key) { return (KUM_TEXT[KUM_LANG] && KUM_TEXT[KUM_LANG][key]) || KUM_TEXT.en[key] || key; }
  function localizePair(en, zh) { return KUM_LANG === 'zh' ? zh : en; }
  function localizeReportText(value, fallback) {
    if (value == null || value === '') return fallback || '';
    var text = String(value);
    var map = {
      '疑似机器人': ui('likelyBot'),
      '更像人类': ui('likelyHuman'),
      '证据不足': ui('uncertain'),
      '已拦截违规导入': ui('policyViolation'),
      '仅检测到手工绘图': ui('policyOk')
    };
    return map[text] || text;
  }
  function classify(session) {
    var f = buildFeatures(session);
    var dimensions = { construction: 5, trajectory: 5, rhythm: 5, integrity: 3 };
    var limits = { construction: 30, trajectory: 25, rhythm: 25, integrity: 20 };
    var reasons = [];
    function evidence(dimension, weight, code, enMessage, zhMessage) {
      var before = dimensions[dimension];
      dimensions[dimension] = clamp(before + weight, 0, limits[dimension]);
      var applied = dimensions[dimension] - before;
      if (applied !== 0) reasons.push({
        code: code,
        dimension: dimension,
        weight: applied,
        direction: applied > 0 ? 'bot' : 'human',
        message: enMessage,
        messageZh: zhMessage
      });
    }

    var attribution = f.transactionAttribution || {};
    if (attribution.unattributed >= 3 && attribution.unattributedRatio !== null && attribution.unattributedRatio >= 0.45) {
      evidence('construction', 14, 'unattributed_edit_transactions',
        attribution.unattributed + ' meaningful structure changes could not be attributed to canvas, tool, menu, or correction transactions.',
        '有 ' + attribution.unattributed + ' 次有意义结构变化无法归因到画板、工具、菜单或纠错事务。');
    } else if (attribution.unattributed >= 1 && attribution.unattributedRatio !== null && attribution.unattributedRatio >= 0.25) {
      evidence('construction', 6, 'partly_unattributed_edits',
        'A small number of structure changes lack clear manual editing attribution.',
        '少量结构变化缺少明确的人工编辑事务归因。');
    }
    if (f.finalAtoms >= 10 && f.durationSec < 5 && f.manualCanvasActions < 4 && f.templateBulkChanges === 0) {
      evidence('construction', 8, 'implausibly_fast_construction',
        'A complex structure was completed very quickly with very few manual operations.',
        '复杂结构在极少手工操作下快速完成。');
    }
    if (attribution.meaningful >= 3 && attribution.attributionRatio !== null && attribution.attributionRatio >= 0.8) {
      evidence('construction', -4, 'transaction_linked_construction',
        'Most meaningful structure changes can be attributed to manual editing transactions.',
        '大部分有意义结构变化都能归因到人工编辑事务。');
    }
    if (attribution.toolGenerated >= 1 || attribution.autoLayout >= 1) {
      evidence('construction', -2, 'tool_and_layout_explained',
        'Templates, tools, or Ketcher auto-layout explain part of the consecutive structure changes.',
        '模板、工具或 Ketcher 自动布局解释了部分连续结构变化。');
    }
    if (f.structureChanges >= 3 && f.canvasStrokes === 0) {
      evidence('trajectory', 20, 'no_pointer_trajectory',
        'There were multiple structure changes, but no usable canvas pointer trajectory.',
        '存在多次结构变化，但没有可用的画板指针轨迹。');
    }
    if (f.dragStrokes >= 4 && f.straightDragRatio >= 0.8 && f.dragSpeedCv !== null && f.dragSpeedCv < 0.1) {
      evidence('trajectory', 8, 'mechanical_drag_pattern',
        'Multiple drag paths and speeds are highly consistent, suggesting a mechanical trajectory.',
        '多次拖动的路径和速度高度一致，呈现机械轨迹。');
    } else if (f.curvedStrokes >= 1 && f.dragSpeedCv !== null && f.dragSpeedCv > 0.2) {
      evidence('trajectory', -3, 'natural_drag_variation',
        'Drag trajectories contain natural direction and speed variation.',
        '拖动轨迹存在方向与速度变化。');
    }
    if (f.pointerIntervals >= 5 && f.pointerIntervalCv !== null) {
      if (f.pointerIntervalCv < 0.1) evidence('rhythm', 15, 'highly_regular_pointer_timing',
        'Consecutive canvas operations are highly regular (CV ' + f.pointerIntervalCv + ').',
        '连续画板操作间隔高度规律（变异系数 ' + f.pointerIntervalCv + '）。');
      else if (f.pointerIntervalCv < 0.2) evidence('rhythm', 8, 'regular_pointer_timing',
        'Consecutive canvas operations have a regular rhythm (CV ' + f.pointerIntervalCv + ').',
        '连续画板操作节奏偏规律（变异系数 ' + f.pointerIntervalCv + '）。');
      else if (f.pointerIntervalCv > 0.35) evidence('rhythm', -3, 'variable_pointer_timing',
        'Canvas operation rhythm has natural variation (CV ' + f.pointerIntervalCv + ').',
        '画板操作节奏具有自然波动（变异系数 ' + f.pointerIntervalCv + '）。');
      if (f.pointerRepeatRatio >= 0.6) evidence('rhythm', 5, 'repeated_pointer_intervals',
        'Many canvas operations fall on repeated time intervals.',
        '大量画板操作落在相同的时间间隔。');
      if (f.pointerMedianIntervalMs !== null && f.pointerMedianIntervalMs < 180) evidence('rhythm', 4, 'very_high_action_rate',
        'The median interval between consecutive manual actions is only ' + Math.round(f.pointerMedianIntervalMs) + ' ms.',
        '连续手工操作的中位间隔仅 ' + Math.round(f.pointerMedianIntervalMs) + ' 毫秒。');
    }
    if (f.idleGaps >= 1) evidence('rhythm', -2, 'thinking_pauses',
      'There were ' + f.idleGaps + ' pauses longer than 2 seconds between structure edits.',
      '结构编辑之间出现 ' + f.idleGaps + ' 次超过 2 秒的停顿。');
    if (f.importAttempts > 0) {
      evidence('integrity', f.importAttempts >= 2 ? 15 : 9, 'manual_only_violation',
        'Blocked ' + f.importAttempts + ' import, paste, drop, or API injection attempt(s).',
        '拦截到 ' + f.importAttempts + ' 次导入、粘贴、拖放或 API 注入尝试。');
    }
    if (f.corrections >= 1) {
      evidence('integrity', -Math.min(4, f.corrections * 2), 'verified_correction_behavior',
        'Confirmed ' + f.corrections + ' correction operation(s), followed by actual structure changes.',
        '确认 ' + f.corrections + ' 次纠错操作，并且随后确实发生结构变化。');
    }

    var rawScore = dimensions.construction + dimensions.trajectory + dimensions.rhythm + dimensions.integrity;
    var insufficient = f.finalAtoms === 0 || f.structureChanges < 2 || f.manualCanvasActions < 3 || f.durationSec < 2;
    if (insufficient) reasons.push({
      code: 'insufficient_behavior',
      dimension: 'coverage',
      weight: 0,
      direction: 'neutral',
      message: 'The drawing steps or duration are insufficient, so this sample cannot reliably distinguish a human from automation.',
      messageZh: '有效绘图步骤或持续时间不足，当前样本不能可靠区分人类与机器人。'
    });
    var score = insufficient ? (f.importAttempts > 0 ? Math.max(50, rawScore) : 50) : Math.round(clamp(rawScore, 0, 100));
    var verdict = insufficient ? 'uncertain' : score >= 60 ? 'likely_bot' : score >= 30 ? 'uncertain' : 'likely_human';
    var coverage = clamp((f.structureChanges / 8) * 0.45 + (f.manualCanvasActions / 10) * 0.35 + (f.durationSec / 20) * 0.2, 0, 1);
    var confidence = insufficient ? (f.importAttempts > 0 ? 20 : 0) : Math.round(clamp(35 + Math.abs(score - 45) + coverage * 30, 0, 95));
    return {
      score: score,
      verdict: verdict,
      label: verdict === 'likely_bot' ? 'Likely bot' : verdict === 'likely_human' ? 'Likely human' : 'Insufficient evidence',
      labelZh: verdict === 'likely_bot' ? '疑似机器人' : verdict === 'likely_human' ? '更像人类' : '证据不足',
      confidence: confidence,
      policyStatus: f.importAttempts > 0 ? 'violation_blocked' : 'manual_only_ok',
      policyLabel: f.importAttempts > 0 ? 'Blocked prohibited import' : 'Manual drawing only detected',
      policyLabelZh: f.importAttempts > 0 ? '已拦截违规导入' : '仅检测到手工绘图',
      dimensions: dimensions,
      reasons: reasons,
      features: f
    };
  }

  function compactEventLabel(event) {
    var data = event.data || {};
    var structureLabels = {
      bulk_add: localizePair('Bulk structure add', '批量加入结构'),
      add_atom: localizePair('Add atom', '加入原子'),
      add_bond: localizePair('Add bond', '加入化学键'),
      reduce_structure: localizePair('Reduce structure', '结构数量减少'),
      move_structure: localizePair('Move structure', '移动结构'),
      edit_atom_or_bond: localizePair('Edit atom or bond', '修改原子或化学键'),
      edit_property_or_layout: localizePair('Edit property or layout', '修改属性或布局'),
      structure_update: localizePair('Update structure', '更新结构')
    };
    var keyLabels = {
      delete: localizePair('Delete', '删除'),
      undo: localizePair('Undo', '撤销'),
      redo: localizePair('Redo', '重做'),
      paste: localizePair('Paste attempt', '粘贴尝试'),
      escape: localizePair('Cancel/exit', '取消/退出')
    };
    if (event.type === 'structure_change') {
      var delta = [];
      if (typeof data.atomDelta === 'number' && data.atomDelta !== 0) delta.push(ui('atoms') + (data.atomDelta > 0 ? '+' : '') + data.atomDelta);
      if (typeof data.bondDelta === 'number' && data.bondDelta !== 0) delta.push(ui('bonds') + (data.bondDelta > 0 ? '+' : '') + data.bondDelta);
      return (structureLabels[data.action] || data.action) + (delta.length ? ' (' + delta.join(', ') + ')' : '') + ' · ' + ui('current') + ' ' + data.atoms + ' ' + ui('atoms') + ' / ' + data.bonds + ' ' + ui('bonds');
    }
    if (event.type === 'click') return data.canvas ? ui('clickCanvas') : ui('selectTool') + data.target;
    if (event.type === 'key_action') return ui('keyAction') + (keyLabels[data.action] || data.action);
    if (event.type === 'pointer_up') {
      if (!data.canvas) return ui('uiPointer');
      if (data.pathPx >= 18 && data.durationMs >= 100) return ui('canvasDrag') + ' · ' + data.pathPx + 'px / ' + data.durationMs + 'ms';
      return ui('clickCanvas') + ' · ' + data.durationMs + 'ms';
    }
    if (event.type === 'monitor_ready') return ui('ready');
    if (event.type === 'session_started') return ui('sessionStarted');
    if (event.type === 'import_blocked') {
      var importLabels = {
        paste: localizePair('Paste', '粘贴'),
        drop: localizePair('File/content drop', '文件或内容拖放'),
        file_open: localizePair('Open file', '打开文件'),
        ui_import: localizePair('Import entry', '导入入口'),
        api_import: localizePair('API structure injection', 'API 结构注入')
      };
      return ui('blocked') + (importLabels[data.kind] || data.kind || localizePair('structure import', '结构导入'));
    }
    if (event.type === 'paste_attempt') return ui('pasteAttempt');
    if (event.type === 'viewport_change') return ui('viewportChange');
    return JSON.stringify(data).slice(0, 100);
  }

  function liveEventKind(event) {
    if (event.type === 'structure_change') return ui('structure');
    if (event.type === 'key_action' || event.type === 'paste_attempt') return ui('keyboard');
    if (event.type === 'import_blocked') return ui('violation');
    if (event.type === 'click') return event.data && event.data.canvas ? ui('canvas') : ui('tool');
    if (event.type === 'pointer_up') return event.data && event.data.canvas ? ui('stroke') : null;
    if (event.type === 'monitor_ready' || event.type === 'session_started') return ui('system');
    return null;
  }

  function renderLiveEvents() {
    var list = document.querySelector('#kum-live-list');
    if (!list || !state) return;
    var emptyText = state.recording ? ui('waitingCanvas') : state.finalized ? ui('completedRecord') : ui('startHint');
    list.innerHTML = '<div class="kum-live-empty">' + escapeHtml(emptyText) + '</div>';
    state.events.forEach(appendLiveEvent);
    list.scrollTop = list.scrollHeight;
  }

  function displayReason(reason) {
    if (KUM_LANG === 'zh' && reason.messageZh) return reason.messageZh;
    return localizeReportText(reason.message);
  }

  function structureVerificationLabel(verification) {
    if (verification.status === 'not_checked' || verification.status === 'verification_failed') return KUM_LANG === 'zh' ? '未校验结构' : 'Structure not checked';
    return verification.matched ? (KUM_LANG === 'zh' ? '绘制正确' : 'Matched') : (KUM_LANG === 'zh' ? '绘制不一致' : 'Not matched');
  }

  function reportHtml(report) {
    var c = report.classification;
    var f = c.features || {};
    var verification = report.challengeVerification || null;
    var timing = report.timeVerification;
    var timingFailure = report.delivery && report.delivery.ok && report.accepted === false && timing && !timing.passed;
    var timingReason = timingFailure ? (KUM_LANG === 'zh' ? (timing.reasonZh || timing.messageZh) : (timing.reason || timing.message)) : '';
    var dimensionValues = c.dimensions || { construction: '-', trajectory: '-', rhythm: '-', integrity: '-' };
    var riskClass = c.score >= 60 ? 'kum-risk-high' : c.score >= 30 ? 'kum-risk-medium' : 'kum-risk-low';
    var label = KUM_LANG === 'zh' ? (c.labelZh || localizeReportText(c.label)) : localizeReportText(c.label);
    var policy = KUM_LANG === 'zh' ? (c.policyLabelZh || localizeReportText(c.policyLabel, ui('oldPolicy'))) : localizeReportText(c.policyLabel, ui('oldPolicy'));
    var reasons = c.reasons && c.reasons.length ? c.reasons.map(function (reason) {
      var cls = reason.direction === 'bot' ? 'negative' : reason.direction === 'human' ? 'positive' : 'neutral';
      var prefix = reason.weight > 0 ? '+' + reason.weight : reason.weight < 0 ? String(reason.weight) : '-';
      return '<li class="' + cls + '"><b>' + prefix + '</b> ' + escapeHtml(displayReason(reason)) + '</li>';
    }).join('') : '<li class="neutral">' + escapeHtml(ui('noEvidence')) + '</li>';
    var usefulEvents = (report.timeline || []).filter(function (event) { return event.type !== 'pointer_down'; }).slice(-120);
    var dimensionNames = { construction: ui('construction'), trajectory: ui('trajectory'), rhythm: ui('rhythm'), integrity: ui('integrity') };
    var dimensionLimits = { construction: 30, trajectory: 25, rhythm: 25, integrity: 20 };
    var dimensionCards = Object.keys(dimensionNames).map(function (key) {
      return '<div class="kum-card"><b>' + dimensionValues[key] + '/' + dimensionLimits[key] + '</b><span>' + escapeHtml(dimensionNames[key]) + '</span></div>';
    }).join('');
    var tx = f.transactionAttribution || {};
    dimensionCards += '<div class="kum-card"><b>' + (f.editTransactions || 0) + '</b><span>' + ui('editTransactions') + '</span></div>' +
      '<div class="kum-card"><b>' + (tx.manualLinked || 0) + '</b><span>' + ui('manualLinked') + '</span></div>' +
      '<div class="kum-card"><b>' + (tx.toolGenerated || 0) + '</b><span>' + ui('toolGenerated') + '</span></div>' +
      '<div class="kum-card"><b>' + (tx.unattributed || 0) + '</b><span>' + ui('unattributed') + '</span></div>';
    var rows = usefulEvents.map(function (event) {
      return '<div class="kum-row"><time>+' + (event.t / 1000).toFixed(2) + 's</time><small>' + escapeHtml(event.type) + '</small><span>' + escapeHtml(compactEventLabel(event)) + '</span></div>';
    }).join('');
    return '<div class="kum-header"><div><h2>' + ui('reportTitle') + '</h2><p>' + ui('session') + ' ' + escapeHtml(String(report.session.id || '').slice(0, 12)) + ' · ' + ui('confidence') + ' ' + c.confidence + '% · ' + escapeHtml(policy || ui('oldPolicy')) + '</p></div>' +
      '<div class="kum-score ' + riskClass + '"><strong>' + c.score + '</strong><span>' + escapeHtml(label) + '</span></div></div>' +
      '<div class="kum-body">' +
      (timingFailure ? '<div class="kum-verification-failure" role="status"><strong>' +
        (KUM_LANG === 'zh' ? '未通过验证' : 'Verification failed') + '</strong><p>' + escapeHtml(timingReason) + '</p></div>' : '') +
      '<div class="kum-grid">' +
      '<div class="kum-card"><b>' + (f.durationSec || 0) + 's</b><span>' + ui('duration') + '</span></div>' +
      '<div class="kum-card"><b>' + (f.structureChanges || 0) + '</b><span>' + ui('structureChanges') + '</span></div>' +
      '<div class="kum-card"><b>' + (f.corrections || 0) + '</b><span>' + ui('corrections') + '</span></div>' +
      '<div class="kum-card"><b>' + (f.dragStrokes || 0) + '</b><span>' + ui('dragStrokes') + '</span></div>' +
      '</div><div class="kum-section"><h3>' + ui('dimensionTitle') + '</h3><div class="kum-grid">' + dimensionCards + '</div></div>' +
      (verification ? '<div class="kum-section"><h3>' + (KUM_LANG === 'zh' ? '结构测试' : 'Structure test') + '</h3><div class="kum-card"><b>' +
        escapeHtml(structureVerificationLabel(verification)) +
        '</b><span>' + escapeHtml(KUM_LANG === 'zh' ? (verification.messageZh || verification.message) : verification.message) + '</span></div></div>' : '') +
      (report.attentionVerification ? '<div class="kum-section"><h3>' + (KUM_LANG === 'zh' ? '限时点击验证' : 'Timed click check') + '</h3><div class="kum-card"><b>' +
        escapeHtml(KUM_LANG === 'zh' ? report.attentionVerification.messageZh : report.attentionVerification.message) + '</b><span>' +
        (KUM_LANG === 'zh' ? '图片点击' : 'Image click') + ' · ' + (report.attentionVerification.delayMs / 1000).toFixed(2) + ' s</span></div></div>' : '') +
      '<div class="kum-section"><h3>' + ui('evidence') + '</h3><ul class="kum-reasons">' + reasons + '</ul></div>' +
      '<div class="kum-section"><h3>' + ui('timeline') + usefulEvents.length + ui('timelineSuffix') + '</h3><div class="kum-timeline">' + (rows || '<div class="kum-row"><span>' + ui('noActions') + '</span></div>') + '</div></div>' +
      '<p class="kum-note">' + ui('note') + '</p></div>' +
      '<div class="kum-actions">' +
      '<button class="kum-btn kum-btn-primary" data-kum-action="export-summary-image">' + ui('exportSummaryImage') + '</button>' +
      '<button class="kum-btn kum-btn-primary" data-kum-action="export-timeline-image">' + ui('exportTimelineImage') + '</button>' +
      (report.replay && report.replay.frames && report.replay.frames.length ? '<button class="kum-btn kum-btn-primary" data-kum-action="replay">' + ui('replay') + '</button>' : '') +
      '<button class="kum-btn" data-kum-action="close">' + ui('closeReport') + '</button><button class="kum-btn" data-kum-action="new">' + ui('reset') + '</button></div>';
  }

  

  function exportImageFileName(report, part) {
    var sessionId = String(report && report.session && report.session.id || 'report')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 24);
    return 'ketcher-' + part + '-' + (sessionId || 'report') + '.png';
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fillRoundedRect(ctx, x, y, width, height, radius, fill, stroke) {
    roundedRectPath(ctx, x, y, width, height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function wrapCanvasText(ctx, value, maxWidth) {
    var text = String(value == null ? '' : value);
    if (!text) return [''];
    var lines = [];
    text.split(/\r?\n/).forEach(function (paragraph) {
      if (!paragraph) {
        lines.push('');
        return;
      }
      var line = '';
      Array.from(paragraph).forEach(function (character) {
        var candidate = line + character;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line.trimEnd());
          line = character.trimStart();
        } else {
          line = candidate;
        }
      });
      if (line || !lines.length) lines.push(line.trimEnd());
    });
    return lines;
  }

  function drawCanvasLines(ctx, lines, x, y, lineHeight, color) {
    ctx.fillStyle = color;
    lines.forEach(function (line, index) {
      ctx.fillText(line, x, y + index * lineHeight);
    });
    return lines.length * lineHeight;
  }

  function createExportCanvas(width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f6f3fb';
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = 'top';
    return { canvas: canvas, ctx: ctx };
  }

  function downloadCanvasImage(canvas, fileName) {
    function download(blobUrl) {
      var anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        download(url);
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }, 'image/png');
    } else {
      download(canvas.toDataURL('image/png'));
    }
  }

  function drawExportTitle(ctx, report, title, subtitle, score, label) {
    fillRoundedRect(ctx, 56, 48, 1488, 142, 22, '#ffffff', '#ded7eb');
    ctx.fillStyle = '#7c3aed';
    ctx.font = '700 18px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText('MOLECULE DRAWING TEST', 88, 78);
    ctx.fillStyle = '#202637';
    ctx.font = '700 36px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(title, 88, 106);
    ctx.fillStyle = '#697084';
    ctx.font = '20px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(subtitle, 88, 154);
    if (score != null) {
      var riskFill = score >= 60 ? '#fee2e2' : score >= 30 ? '#fff4d6' : '#dcfce7';
      var riskText = score >= 60 ? '#b42318' : score >= 30 ? '#9a6700' : '#087f5b';
      fillRoundedRect(ctx, 1284, 76, 220, 86, 18, riskFill);
      ctx.fillStyle = riskText;
      ctx.font = '700 36px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(String(score), 1312, 90);
      ctx.font = '700 18px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(String(label || ''), 1378, 103);
    }
  }

  function drawMetricCard(ctx, x, y, width, height, value, label) {
    fillRoundedRect(ctx, x, y, width, height, 16, '#ffffff', '#ded7eb');
    ctx.fillStyle = '#202637';
    ctx.font = '700 29px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(String(value), x + 22, y + 19);
    ctx.fillStyle = '#697084';
    ctx.font = '19px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(String(label), x + 22, y + 60);
  }

  function exportSummaryImage(report) {
    if (!report || !report.classification) return;
    var c = report.classification;
    var f = c.features || {};
    var dimensions = c.dimensions || {};
    var tx = f.transactionAttribution || {};
    var verification = report.challengeVerification || null;
    var reasons = c.reasons && c.reasons.length ? c.reasons : [];
    var measure = document.createElement('canvas').getContext('2d');
    measure.font = '21px "Segoe UI", "Microsoft YaHei", sans-serif';
    var reasonLines = reasons.length ? reasons.map(function (reason) {
      var prefix = reason.weight > 0 ? '+' + reason.weight : reason.weight < 0 ? String(reason.weight) : '-';
      return wrapCanvasText(measure, prefix + '  ' + displayReason(reason), 1400);
    }) : [[ui('noEvidence')]];
    var evidenceHeight = 60 + reasonLines.reduce(function (sum, lines) {
      return sum + Math.max(38, lines.length * 28 + 10);
    }, 0);
    var verificationHeight = verification ? 150 : 0;
    var height = 48 + 142 + 46 + 110 + 64 + 216 + verificationHeight + 62 + evidenceHeight + 72;
    var output = createExportCanvas(1600, height);
    var ctx = output.ctx;
    var label = KUM_LANG === 'zh' ? (c.labelZh || localizeReportText(c.label)) : localizeReportText(c.label);
    var sessionId = String(report.session && report.session.id || '').slice(0, 12);
    drawExportTitle(
      ctx,
      report,
      ui('reportTitle'),
      ui('session') + ' ' + sessionId + ' · ' + ui('confidence') + ' ' + c.confidence + '%',
      c.score,
      label
    );

    var margin = 56;
    var gap = 18;
    var cardWidth = (1488 - gap * 3) / 4;
    var y = 226;
    var metrics = [
      [(f.durationSec || 0) + 's', ui('duration')],
      [f.structureChanges || 0, ui('structureChanges')],
      [f.corrections || 0, ui('corrections')],
      [f.dragStrokes || 0, ui('dragStrokes')]
    ];
    metrics.forEach(function (metric, index) {
      drawMetricCard(ctx, margin + index * (cardWidth + gap), y, cardWidth, 110, metric[0], metric[1]);
    });

    y += 154;
    ctx.fillStyle = '#202637';
    ctx.font = '700 24px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(ui('dimensionTitle'), margin, y);
    y += 42;
    var dimensionCards = [
      [(dimensions.construction == null ? '-' : dimensions.construction) + '/30', ui('construction')],
      [(dimensions.trajectory == null ? '-' : dimensions.trajectory) + '/25', ui('trajectory')],
      [(dimensions.rhythm == null ? '-' : dimensions.rhythm) + '/25', ui('rhythm')],
      [(dimensions.integrity == null ? '-' : dimensions.integrity) + '/20', ui('integrity')],
      [f.editTransactions || 0, ui('editTransactions')],
      [tx.manualLinked || 0, ui('manualLinked')],
      [tx.toolGenerated || 0, ui('toolGenerated')],
      [tx.unattributed || 0, ui('unattributed')]
    ];
    dimensionCards.forEach(function (metric, index) {
      var row = Math.floor(index / 4);
      var column = index % 4;
      drawMetricCard(ctx, margin + column * (cardWidth + gap), y + row * 108, cardWidth, 92, metric[0], metric[1]);
    });
    y += 232;

    if (verification) {
      ctx.fillStyle = '#202637';
      ctx.font = '700 24px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(KUM_LANG === 'zh' ? '结构测试' : 'Structure test', margin, y);
      y += 42;
      fillRoundedRect(ctx, margin, y, 1488, 88, 16, '#ffffff', '#ded7eb');
      ctx.fillStyle = verification.matched ? '#087f5b' : '#b42318';
      ctx.font = '700 27px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(
        structureVerificationLabel(verification),
        margin + 22,
        y + 17
      );
      ctx.fillStyle = '#697084';
      ctx.font = '18px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(KUM_LANG === 'zh' ? (verification.messageZh || verification.message) : verification.message, margin + 22, y + 55);
      y += 126;
    }

    ctx.fillStyle = '#202637';
    ctx.font = '700 24px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(ui('evidence'), margin, y);
    y += 42;
    fillRoundedRect(ctx, margin, y, 1488, evidenceHeight, 16, '#ffffff', '#ded7eb');
    var reasonY = y + 22;
    reasonLines.forEach(function (lines, index) {
      var reason = reasons[index];
      var color = !reason ? '#697084' : reason.direction === 'bot' ? '#b42318' : reason.direction === 'human' ? '#087f5b' : '#697084';
      ctx.font = '21px "Segoe UI", "Microsoft YaHei", sans-serif';
      drawCanvasLines(ctx, lines, margin + 24, reasonY, 28, color);
      reasonY += Math.max(38, lines.length * 28 + 10);
    });
    ctx.fillStyle = '#8a8298';
    ctx.font = '16px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(ui('note'), margin, height - 42);
    downloadCanvasImage(output.canvas, exportImageFileName(report, 'summary'));
  }

  function exportTimelineImage(report) {
    if (!report) return;
    var events = (report.timeline || []).filter(function (event) {
      return event.type !== 'pointer_down';
    }).slice(-120);
    var width = 1600;
    var margin = 56;
    var gap = 22;
    var columnWidth = (width - margin * 2 - gap) / 2;
    var measure = document.createElement('canvas').getContext('2d');
    measure.font = '19px "Segoe UI", "Microsoft YaHei", sans-serif';
    var entries = events.map(function (event) {
      var details = wrapCanvasText(measure, compactEventLabel(event), columnWidth - 40);
      return {
        time: '+' + (event.t / 1000).toFixed(2) + 's',
        type: event.type,
        details: details,
        height: Math.max(100, 67 + details.length * 26)
      };
    });
    if (!entries.length) {
      entries.push({ time: '-', type: ui('noActions'), details: [''], height: 100 });
    }
    var rows = [];
    for (var index = 0; index < entries.length; index += 2) {
      rows.push(Math.max(entries[index].height, entries[index + 1] ? entries[index + 1].height : 0));
    }
    var height = 232 + rows.reduce(function (sum, rowHeight) { return sum + rowHeight + 18; }, 0) + 50;
    var output = createExportCanvas(width, height);
    var ctx = output.ctx;
    var sessionId = String(report.session && report.session.id || '').slice(0, 12);
    drawExportTitle(
      ctx,
      report,
      KUM_LANG === 'zh' ? '操作时间线' : 'Operation timeline',
      ui('session') + ' ' + sessionId + ' · ' + events.length + (KUM_LANG === 'zh' ? ' 条有效操作 · 双列展示' : ' actions · two-column layout')
    );
    var y = 222;
    entries.forEach(function (entry, entryIndex) {
      var row = Math.floor(entryIndex / 2);
      var column = entryIndex % 2;
      var rowY = y;
      for (var rowIndex = 0; rowIndex < row; rowIndex += 1) rowY += rows[rowIndex] + 18;
      var x = margin + column * (columnWidth + gap);
      fillRoundedRect(ctx, x, rowY, columnWidth, rows[row], 15, '#ffffff', '#ded7eb');
      ctx.fillStyle = '#7c3aed';
      ctx.font = '700 21px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(entry.time, x + 20, rowY + 18);
      ctx.fillStyle = '#697084';
      ctx.font = '16px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(entry.type, x + 150, rowY + 22);
      ctx.fillStyle = '#202637';
      ctx.font = '19px "Segoe UI", "Microsoft YaHei", sans-serif';
      drawCanvasLines(ctx, entry.details, x + 20, rowY + 58, 26, '#202637');
    });
    downloadCanvasImage(output.canvas, exportImageFileName(report, 'timeline'));
  }

  function buildReport(session) {
    var classification = classify(session);
    return {
      schemaVersion: 3,
      generatedAt: isoNow(),
      language: KUM_LANG,
      session: {
        id: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        endReason: session.endReason,
        durationMs: Math.round(classification.features.durationMs),
        viewport: session.viewport
      },
      security: session.serverSession ? {
        sessionId: session.serverSession.sessionId,
        token: session.serverSession.token,
        startedAt: session.serverSession.startedAt,
        expiresAt: session.serverSession.expiresAt
      } : null,
      classification: classification,
      finalStructure: session.finalStructure,
      counters: session.counters,
      structureChanges: session.structureChanges,
      strokes: session.strokes,
      timeline: session.events,
      replay: {
        version: 1,
        durationMs: Math.round(classification.features.durationMs),
        viewport: session.viewport,
        frames: session.replayFrames || [],
        strokes: session.strokes,
        pointerTrail: session.pointerTrail || []
      },
      notice: KUM_TEXT.en.notice,
      noticeZh: KUM_TEXT.zh.notice
    };
  }

  function replayActionLabel(frame) {
    if (!frame) return ui('waitingReplay');
    var labels = {
      bulk_add: localizePair('Bulk structure add', '批量加入结构'),
      initial: localizePair('Blank canvas', '空白画板'),
      add_atom: localizePair('Add atom', '加入原子'),
      add_bond: localizePair('Add bond', '加入化学键'),
      reduce_structure: localizePair('Reduce structure', '减少结构'),
      move_structure: localizePair('Move structure', '移动结构'),
      edit_atom_or_bond: localizePair('Edit atom or bond', '修改原子或化学键'),
      edit_property_or_layout: localizePair('Edit property or layout', '修改属性或布局'),
      structure_update: localizePair('Update structure', '更新结构'),
      final_structure: localizePair('Final structure', '最终结构')
    };
    var detail = [];
    if (typeof frame.atoms === 'number') detail.push(frame.atoms + ' ' + ui('atoms'));
    if (typeof frame.bonds === 'number') detail.push(frame.bonds + ' ' + ui('bonds'));
    return (labels[frame.action] || frame.action || localizePair('Structure change', '结构变化')) + (detail.length ? ' · ' + detail.join(' / ') : '');
  }

  async function applyReplayFrameNow(player, frameIndex) {
    if (!player || player !== replayPlayer || !player.report) return;
    var frames = player.report.replay.frames || [];
    var frame = frames[frameIndex];
    if (!frame) return;
    var transition = beginReplayFrameTransition();
    var label = document.querySelector('#kum-replay-action');
    if (label) label.textContent = replayActionLabel(frame);
    if (typeof replayWriter !== 'function') {
      endReplayFrameTransition(transition);
      throw new Error(ui('replayChannelMissing'));
    }
    try {
      await replayWriter(frame.molfile);
      await waitMs(180);
      if (player !== replayPlayer) return;
      restoreReplayFrameView(frame, player.report);
      await waitMs(50);
      if (player !== replayPlayer) return;
      player.frameIndex = frameIndex;
    } finally {
      endReplayFrameTransition(transition);
    }
  }

  function updateReplayCue(timeMs) {
    var cue = document.querySelector('#kum-replay-event');
    if (!cue) return;
    var events = replayCuesAt(timeMs);
    clearReplayHighlight();
    if (!events.length) {
      cue.classList.add('kum-hidden');
      return;
    }
    cue.innerHTML = events.map(function (event) {
      var data = event.data || {};
      if (event.type === 'key_action') {
        var keyNames = { delete: localizePair('Delete', '删除'), undo: localizePair('Undo', '撤销'), redo: localizePair('Redo', '重做'), paste: localizePair('Paste attempt', '粘贴尝试'), escape: localizePair('Cancel/exit', '取消/退出') };
        return '<div><b>' + ui('keyboardOperation') + '</b><span>' + escapeHtml(keyNames[data.action] || data.action || ui('noKey')) +
          (data.shortcut ? ' · ' + escapeHtml(data.shortcut) : '') + '</span></div>';
      }
      return '<div><b>' + ui('toolButton') + '</b><span>' + escapeHtml(data.target || ui('unknownButton')) + '</span></div>';
    }).join('');
    var latestClick = events.slice().reverse().find(function (event) { return event.type === 'click'; });
    if (latestClick) {
      var control = findReplayControl(latestClick.data && latestClick.data.target);
      if (control) control.classList.add('kum-replay-highlight');
    }
    cue.classList.remove('kum-hidden');
  }

  function replayTick(timestamp) {
    if (!replayPlayer || !replayPlayer.playing) return;
    if (replayPlayer.lastTimestamp === null) replayPlayer.lastTimestamp = timestamp;
    var delta = (timestamp - replayPlayer.lastTimestamp) * replayPlayer.speed;
    replayPlayer.lastTimestamp = timestamp;
    setReplayTime(replayPlayer.currentMs + delta, false);
    if (replayPlayer.currentMs >= replayPlayer.durationMs) {
      replayPlayer.playing = false;
      var button = document.querySelector('[data-kum-action="replay-toggle"]');
      if (button) button.textContent = ui('replayAgain');
      return;
    }
    replayPlayer.raf = requestAnimationFrame(replayTick);
  }

  function toggleReplay() {
    if (!replayPlayer) return;
    var button = document.querySelector('[data-kum-action="replay-toggle"]');
    if (replayPlayer.playing) {
      replayPlayer.playing = false;
      if (replayPlayer.raf) cancelAnimationFrame(replayPlayer.raf);
      if (button) button.textContent = ui('resume');
      return;
    }
    if (replayPlayer.currentMs >= replayPlayer.durationMs) setReplayTime(0, true);
    replayPlayer.playing = true;
    replayPlayer.lastTimestamp = null;
    if (button) button.textContent = ui('pause');
    replayPlayer.raf = requestAnimationFrame(replayTick);
  }

  function startReplay(report) {
    if (!report || !report.replay || !report.replay.frames || !report.replay.frames.length) return;
    stopReplay(false);
    closeReport();
    replayPlayer = {
      report: report,
      durationMs: Math.max(1, report.replay.durationMs || report.session.durationMs || 1),
      currentMs: 0,
      frameIndex: -1,
      requestedFrameIndex: -1,
      applyingFrame: false,
      interactionIndex: -1,
      lastInteractionTime: 0,
      popupCloseTimer: null,
      speed: 1,
      playing: false,
      lastTimestamp: null,
      raf: null
    };
    var root = document.querySelector('#kum-root');
    var panel = document.createElement('div');
    panel.id = 'kum-replay';
    panel.className = 'kum-replay';
    panel.innerHTML = '<div class="kum-replay-head"><div><b>' + ui('replayTitle') + '</b><span id="kum-replay-action">' + ui('waitingReplay') + '</span></div><button class="kum-btn" data-kum-action="replay-close">' + ui('close') + '</button></div>' +
      '<div class="kum-replay-controls"><button class="kum-btn kum-btn-primary" data-kum-action="replay-toggle">' + ui('play') + '</button>' +
      '<input id="kum-replay-progress" type="range" min="0" max="' + replayPlayer.durationMs + '" value="0" step="10" aria-label="' + ui('replayProgress') + '">' +
      '<span id="kum-replay-time">0.0 / ' + (replayPlayer.durationMs / 1000).toFixed(1) + 's</span>' +
      '<select id="kum-replay-speed" aria-label="' + ui('replaySpeed') + '"><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option><option value="4">4x</option></select></div>' +
      '<div id="kum-replay-event" class="kum-replay-event kum-hidden"></div>' +
      '<div id="kum-replay-cursor" class="kum-replay-cursor kum-hidden"></div>';
    root.appendChild(panel);
    closeReplayKetcherPopups();
    setReplayTime(0, true);
    toggleReplay();
  }

  function updateDock() {
    var root = document.querySelector('#kum-root');
    var status = document.querySelector('#kum-status-text');
    var finishButton = document.querySelector('[data-kum-action="finish"]');
    var startButton = document.querySelector('[data-kum-action="start"]');
    var resetButton = document.querySelector('[data-kum-action="reset"]');
    if (!root || !status || !state) return;
    if (state.finalized) {
      root.querySelector('.kum-sidebar').classList.remove('kum-idle');
      root.querySelector('.kum-sidebar').classList.add('kum-stopped');
      status.textContent = ui('completed');
      finishButton.textContent = ui('viewReport');
      startButton.classList.add('kum-hidden');
      finishButton.classList.remove('kum-hidden');
      resetButton.classList.remove('kum-hidden');
    } else if (state.recording) {
      root.querySelector('.kum-sidebar').classList.remove('kum-idle');
      root.querySelector('.kum-sidebar').classList.remove('kum-stopped');
      status.textContent = ui('recording') + Math.floor(nowOffset() / 60000).toString().padStart(2, '0') + ':' + Math.floor(nowOffset() / 1000 % 60).toString().padStart(2, '0');
      finishButton.textContent = ui('finish');
      startButton.classList.add('kum-hidden');
      finishButton.classList.remove('kum-hidden');
      resetButton.classList.add('kum-hidden');
    } else {
      root.querySelector('.kum-sidebar').classList.remove('kum-stopped');
      root.querySelector('.kum-sidebar').classList.add('kum-idle');
      status.textContent = ui('waiting');
      startButton.classList.remove('kum-hidden');
      finishButton.classList.add('kum-hidden');
      resetButton.classList.add('kum-hidden');
    }
    updateLiveSummary();
  }

  function mountUi() {
    var root = document.createElement('div');
    root.id = 'kum-root';
    root.innerHTML = '<aside class="kum-sidebar kum-idle" aria-label="' + ui('liveLog') + '"><header class="kum-sidebar-header"><div class="kum-sidebar-title"><h2>' + ui('liveLog') + '</h2><div class="kum-status"><span class="kum-dot"></span><span id="kum-status-text">' + ui('waiting') + '</span></div></div><div class="kum-header-actions"><button class="kum-collapse" data-kum-action="collapse" title="' + ui('collapse') + '">›</button></div></header>' +
      '<div class="kum-live-summary"><div><b id="kum-live-structure">0</b><span>' + ui('structureChanges') + '</span></div><div><b id="kum-live-corrections">0</b><span>' + ui('corrections') + '</span></div><div><b id="kum-live-tracks">0</b><span>' + ui('dragStrokes') + '</span></div></div>' +
      '<div id="kum-live-list" class="kum-live-list" aria-live="polite"><div class="kum-live-empty">' + ui('startHint') + '</div></div>' +
      '<footer class="kum-sidebar-actions">' +
      '<button class="kum-btn kum-btn-primary" data-kum-action="start">' + ui('start') + '</button><button class="kum-btn kum-btn-primary kum-hidden" data-kum-action="finish">' + ui('finish') + '</button><button class="kum-btn kum-btn-reset kum-hidden" data-kum-action="reset">' + ui('reset') + '</button></footer></aside>' +
      '<button class="kum-expand kum-hidden" data-kum-action="expand">' + ui('expand') + '</button>' +
      '<div id="kum-backdrop" class="kum-backdrop kum-hidden"><div id="kum-report" class="kum-modal" role="dialog" aria-modal="true" aria-label="' + ui('reportTitle') + '"></div></div>';
    document.body.appendChild(root);
    document.body.classList.add('kum-monitor-mounted');
    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-kum-action]');
      if (!button) return;
      var action = button.getAttribute('data-kum-action');
      if (action === 'start') beginSession();
      else if (action === 'finish') state.finalized ? showReport(lastReport) : finalize('user_completed', true);
      else if (action === 'close') closeReport();
      else if (action === 'export-summary-image' && lastReport) exportSummaryImage(lastReport);
      else if (action === 'export-timeline-image' && lastReport) exportTimelineImage(lastReport);
      else if (action === 'replay' && lastReport) startReplay(lastReport);
      else if (action === 'replay-toggle') toggleReplay();
      else if (action === 'replay-close') stopReplay(true);
      else if (action === 'new' || action === 'reset') {
        if (window.parent && window.parent !== window) window.parent.postMessage({ eventType: 'ketcher-request-new-challenge' }, '*');
        else resetDetection();
      }
      else if (action === 'collapse') {
        document.body.classList.add('kum-monitor-collapsed');
        root.querySelector('.kum-sidebar').classList.add('kum-hidden');
        root.querySelector('.kum-expand').classList.remove('kum-hidden');
      } else if (action === 'expand') {
        document.body.classList.remove('kum-monitor-collapsed');
        root.querySelector('.kum-sidebar').classList.remove('kum-hidden');
        root.querySelector('.kum-expand').classList.add('kum-hidden');
      }
    });
    document.querySelector('#kum-backdrop').addEventListener('click', function (event) {
      if (event.target.id === 'kum-backdrop') closeReport();
    });
    root.addEventListener('input', function (event) {
      if (event.target.id === 'kum-replay-progress') {
        if (replayPlayer) {
          replayPlayer.playing = false;
          if (replayPlayer.raf) cancelAnimationFrame(replayPlayer.raf);
          var button = document.querySelector('[data-kum-action="replay-toggle"]');
          if (button) button.textContent = ui('resume');
          setReplayTime(Number(event.target.value), true);
        }
      }
    });
    root.addEventListener('change', function (event) {
      if (event.target.id === 'kum-replay-speed' && replayPlayer) replayPlayer.speed = Number(event.target.value) || 1;
    });
    dockTimer = setInterval(updateDock, DOCK_REFRESH_INTERVAL_MS);
    renderLiveEvents();
  }

  function activateChallenge(challengeId, replyOrigin) {
    if (!/^[A-Za-z0-9_-]{6,100}$/.test(challengeId || '')) return;
    challengeActivationChain = challengeActivationChain.then(async function () {
      activeChallengeId = challengeId;
      var url = new URL(window.location.href);
      url.searchParams.set('challenge', challengeId);
      window.history.replaceState(null, '', url.toString());
      await resetDetection();
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          eventType: 'ketcher-challenge-ready',
          challengeId: challengeId
        }, replyOrigin || window.location.origin);
      }
    }).catch(function () {});
  }

  function bindHostMessages() {
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin || event.source !== window.parent || !event.data) return;
      if (event.data.eventType === 'ketcher-set-challenge') {
        activateChallenge(String(event.data.challengeId || ''), event.origin);
      }
    });
  }

  function init() {
    state = createSession(false);
    lastReport = null;
    bindEvents();
    bindHostMessages();
    mountUi();
    waitForEditor();
    updateDock();
  }

  window.ketcherUsageMonitor = {
    version: VERSION,
    config: CONFIG,
    finish: function () { return finalize('api_completed', true); },
    getSession: function () {
      if (!state) return null;
      return {recording: state.recording, finalized: state.finalized, sessionId: state.sessionId};
    },
    getReport: function () {
      // Return a detached diagnostic snapshot, never the mutable live state/token.
      var report = lastReport || (state ? buildReport(state) : null);
      if (!report) return null;
      var copy = JSON.parse(JSON.stringify(report));
      copy.security = null;
      return copy;
    },
    start: beginSession,
    startNewSession: beginSession,
    resetDetection: resetDetection
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
