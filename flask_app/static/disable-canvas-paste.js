/*
 * Ketcher 手工绘图保护。
 * 尽量拦截粘贴、导入、API 写入等结构注入入口，
 * 但保留手工绘图、编辑、清空和回放所需能力。
 */
(function () {
  'use strict';

  var guardedApi = null;
  var replayOriginalSetMolecule = null;
  var blockedMethods = [
    'setMolecule', 'addFragment', 'setMoleculeFragment', 'setRxn',
    'loadMolecule', 'importStructure', 'openStructure'
  ];
  var blockedSelector = [
    '[data-testid="open-button"]',
    '[data-testid="open-file-button"]',
    '[data-testid="paste-from-clipboard-button"]',
    '[data-testid="openStructureModal"]',
    '[title="Open..."]', '[aria-label="Open..."]',
    '[title^="Paste"]', '[aria-label^="Paste"]',
    '[title^="Import"]', '[aria-label^="Import"]',
    '[title^="Add Image"]', '[aria-label^="Add Image"]'
  ].join(',');

  function isMonitorTarget(target) {
    return target instanceof Element && Boolean(target.closest('#kum-root'));
  }

  function notify(kind, detail) {
    window.dispatchEvent(new CustomEvent('ketcher-manual-only-violation', {
      detail: Object.assign({ kind: kind, at: Date.now() }, detail || {})
    }));
  }

  function blockEvent(event, kind, detail) {
    if (isMonitorTarget(event.target)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    notify(kind, detail);
    return true;
  }

  function importControl(target) {
    if (!(target instanceof Element) || isMonitorTarget(target)) return null;
    var control = target.closest('button,[role="button"],[role="menuitem"],a,[data-testid],[title],[aria-label]');
    if (!control) return null;
    if (control.matches(blockedSelector)) return control;
    var label = String(control.getAttribute('title') || control.getAttribute('aria-label') || control.textContent || '')
      .replace(/\s+/g, ' ').trim();
    return /^(open(\.\.\.)?|open file|open structure|import|import structure|load structure|paste(?:\s*\([^)]*\))?|paste from clipboard|add image|打开|导入|粘贴)$/i.test(label) ? control : null;
  }

  function disableImportControls(root) {
    if (!(root instanceof Element || root instanceof Document)) return;
    var nodes = [];
    if (root instanceof Element) {
      if (root.matches(blockedSelector)) nodes.push(root);
      var ownControl = importControl(root);
      if (ownControl) nodes.push(ownControl);
    }
    root.querySelectorAll(blockedSelector + ',input[type="file"],button,[role="button"],[role="menuitem"]').forEach(function (node) {
      if (node.matches('input[type="file"]') || importControl(node)) nodes.push(node);
    });
    nodes.forEach(function (node) {
      node.setAttribute('aria-hidden', 'true');
      node.setAttribute('data-manual-only-blocked', 'true');
      if ('disabled' in node) node.disabled = true;
      node.style.setProperty('display', 'none', 'important');
    });
  }

  function wrapImportApi() {
    if (!window.ketcher) return;
    if (window.ketcher !== guardedApi) guardedApi = window.ketcher;
    blockedMethods.forEach(function (name) {
      var current = guardedApi[name];
      if (typeof current !== 'function' || current.__manualOnlyGuarded) return;
      var original = current;
      if (name === 'setMolecule') replayOriginalSetMolecule = original;
      var wrapped = function () {
        var first = arguments[0];
        /* 允许空 setMolecule，仅用于“重新检测”时清空画板。 */
        if (name === 'setMolecule' && (first === '' || first === null)) return original.apply(this, arguments);
        notify('api_import', { method: name });
        return Promise.reject(new Error('This editor only allows manual drawing. Structure import through the API is disabled.'));
      };
      wrapped.__manualOnlyGuarded = true;
      try { guardedApi[name] = wrapped; } catch (_) {}
    });
  }

  var replayWriterClaimed = false;
  Object.defineProperty(window, 'ketcherManualOnlyGuard', {
    configurable: false, writable: false,
    value: Object.freeze({
      claimReplayWriter: function (allowed) {
        if (replayWriterClaimed || typeof allowed !== 'function') throw new Error('Replay writer unavailable');
        replayWriterClaimed = true;
        return function (structure) {
          if (!allowed() || !guardedApi || typeof replayOriginalSetMolecule !== 'function') {
            notify('api_import', {method: 'replay'});
            return Promise.reject(new Error('Replay is allowed only after detection ends.'));
          }
          return Promise.resolve(replayOriginalSetMolecule.call(guardedApi, structure || ''));
        };
      }
    })
  });

  document.addEventListener('paste', function (event) {
    blockEvent(event, 'paste', { inputType: 'clipboard' });
  }, true);

  document.addEventListener('beforeinput', function (event) {
    if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') {
      blockEvent(event, event.inputType === 'insertFromDrop' ? 'drop' : 'paste', { inputType: event.inputType });
    }
  }, true);

  document.addEventListener('keydown', function (event) {
    if (isMonitorTarget(event.target)) return;
    var key = String(event.key || '').toLowerCase();
    var mod = event.ctrlKey || event.metaKey;
    if ((mod && key === 'v') || (event.shiftKey && key === 'insert')) {
      blockEvent(event, 'paste', { inputType: 'shortcut' });
    } else if (mod && key === 'o') {
      blockEvent(event, 'file_open', { inputType: 'shortcut' });
    }
  }, true);

  ['dragenter', 'dragover', 'drop'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      if (type !== 'drop') {
        if (!isMonitorTarget(event.target)) event.preventDefault();
        return;
      }
      blockEvent(event, 'drop', { inputType: type });
    }, true);
  });

  document.addEventListener('click', function (event) {
    var control = importControl(event.target);
    if (control) blockEvent(event, 'ui_import', { label: control.getAttribute('title') || control.textContent || 'import' });
  }, true);

  document.addEventListener('change', function (event) {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
      blockEvent(event, 'file_open', { inputType: 'file' });
      event.target.value = '';
    }
  }, true);

  var style = document.createElement('style');
  style.textContent = blockedSelector + ',input[type="file"],[data-manual-only-blocked="true"]{display:none!important;}';
  document.head.appendChild(style);

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) { if (node instanceof Element) disableImportControls(node); });
    });
  });

  function init() {
    disableImportControls(document);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    wrapImportApi();
    setInterval(function () {
      disableImportControls(document);
      wrapImportApi();
    }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
