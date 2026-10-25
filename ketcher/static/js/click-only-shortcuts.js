/* Ketcher panel tools are mouse/touch only; keep basic editing shortcuts. */
(function () {
  'use strict';

  function editable(target) {
    if (!(target instanceof Element)) return false;
    // Ketcher focuses a hidden clipboard textarea for canvas keyboard events.
    if (target.closest('.cliparea')) return false;
    return target.isContentEditable || Boolean(target.closest(
      'textarea, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]), select'
    ));
  }

  function filterKeyboard(event) {
    var key = String(event.key || '').toLowerCase();
    var mod = event.ctrlKey || event.metaKey;
    // Ketcher's shortcut engine tracks modifier state separately.
    if (['shift', 'control', 'meta', 'alt'].includes(key)) return;
    // Keep the existing manual-only import/paste guard and its audit events.
    if ((mod && (key === 'v' || key === 'o')) || (event.shiftKey && key === 'insert')) return;
    // Escape cancels an in-progress action or closes an editor dialog.
    if (key === 'escape' && !mod && !event.altKey) return;
    if (editable(event.target)) {
      // Native text entry/editing remains available without reaching global tools.
      event.stopImmediatePropagation();
      return;
    }
    if (!event.altKey && ((mod && (key === 'z' || key === 'y')) ||
        (!mod && !event.shiftKey && (key === 'delete' || key === 'backspace')))) return;
    // Tab may move focus, but must not invoke Ketcher's Shift+Tab tool shortcut.
    if (key !== 'tab' && !['shift', 'control', 'meta', 'alt'].includes(key)) event.preventDefault();
    event.stopImmediatePropagation();
  }

  // Install before Ketcher's bundle: blocks both global hotkeys and tool-local keys.
  ['keydown', 'keypress', 'keyup'].forEach(function (type) {
    window.addEventListener(type, filterKeyboard, {capture: true, passive: false});
  });
}());
