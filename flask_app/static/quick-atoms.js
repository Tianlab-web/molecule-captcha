(function () {
  'use strict';

  var surpriseConfig = window.KETCHER_ATOM_SURPRISE_CONFIG;

  var nativeAtoms = [
    { symbol: 'H', name: 'Hydrogen / 氢' },
    { symbol: 'C', name: 'Carbon / 碳' },
    { symbol: 'N', name: 'Nitrogen / 氮' },
    { symbol: 'O', name: 'Oxygen / 氧' },
    { symbol: 'S', name: 'Sulfur / 硫' },
    { symbol: 'P', name: 'Phosphorus / 磷' },
    { symbol: 'F', name: 'Fluorine / 氟' },
    { symbol: 'Cl', name: 'Chlorine / 氯' },
    { symbol: 'Br', name: 'Bromine / 溴' },
    { symbol: 'I', name: 'Iodine / 碘' }
  ];
  var extendedAtoms = [
    { symbol: 'B', name: 'Boron / 硼' },
    { symbol: 'Si', name: 'Silicon / 硅' },
    { symbol: 'Se', name: 'Selenium / 硒' },
    { symbol: 'Li', name: 'Lithium / 锂' },
    { symbol: 'Na', name: 'Sodium / 钠' },
    { symbol: 'Mg', name: 'Magnesium / 镁' },
    { symbol: 'Fe', name: 'Iron / 铁' },
    { symbol: 'Zn', name: 'Zinc / 锌' }
  ];
  var allAtoms = nativeAtoms.concat(extendedAtoms);
  var syncingNativeSelection = false;
  var primaryNativeSymbols = ['H', 'C', 'N', 'O', 'S'];
  var secondaryNativeSymbols = ['P', 'F', 'Cl', 'Br', 'I'];
  var surpriseState = {
    hasTriggered: false,
    cooldown: 0,
    misses: 0,
    bag: [],
    lastResult: null,
    pointerStart: null,
    pendingRestore: null,
    selectedSymbol: null
  };

  function randomUint32(limit) {
    if (limit <= 1) return 0;
    var range = 0x100000000;
    var ceiling = range - (range % limit);
    var value = ceiling;
    var buffer = new Uint32Array(1);
    while (value >= ceiling) {
      window.crypto.getRandomValues(buffer);
      value = buffer[0];
    }
    return value % limit;
  }

  function randomFraction() {
    var buffer = new Uint32Array(1);
    window.crypto.getRandomValues(buffer);
    return buffer[0] / 0x100000000;
  }

  function shuffled(items) {
    var result = items.slice();
    for (var index = result.length - 1; index > 0; index -= 1) {
      var swapIndex = randomUint32(index + 1);
      var temporary = result[index];
      result[index] = result[swapIndex];
      result[swapIndex] = temporary;
    }
    return result;
  }

  function normalizedText(element) {
    return String(element && element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function exactButton(root, text) {
    return Array.from((root || document).querySelectorAll('button')).find(function (button) {
      return normalizedText(button) === text;
    });
  }

  function periodicButton() {
    return document.querySelector('[data-testid="period-table"],button[title^="Periodic Table"],button[aria-label^="Periodic Table"]');
  }

  function closestCommonAncestor(first, second) {
    var current = first;
    while (current && !current.contains(second)) current = current.parentElement;
    return current;
  }

  function directChildOf(element, ancestor) {
    var child = element;
    while (child && child.parentElement !== ancestor) child = child.parentElement;
    return child;
  }

  function nativeButton(symbol) {
    return document.querySelector('[data-kqa-native-atom="' + symbol + '"]');
  }

  function hideOriginalNativeAtoms(host) {
    var symbols = primaryNativeSymbols.concat(secondaryNativeSymbols);
    var directChildren = symbols.map(function (symbol) {
      var button = document.querySelector('[data-testid="' + symbol + '-button"]');
      return button && directChildOf(button, host);
    }).filter(Boolean);
    var uniqueChildren = directChildren.filter(function (child, index) {
      return directChildren.indexOf(child) === index;
    });
    var hostChildren = Array.from(host.children);
    var indexes = uniqueChildren.map(function (child) { return hostChildren.indexOf(child); });
    var firstIndex = Math.min.apply(Math, indexes);
    var lastIndex = Math.max.apply(Math, indexes);

    uniqueChildren.forEach(function (child) {
      child.setAttribute('data-kqa-native-hidden', 'true');
    });
    hostChildren.slice(firstIndex, lastIndex + 1).forEach(function (child) {
      if (child.tagName === 'HR') child.setAttribute('data-kqa-native-hidden', 'true');
    });
  }

  function atomButtons(group) {
    return Array.from(group.querySelectorAll('[data-kqa-atom]'));
  }

  function markExtendedSelected(symbol) {
    document.querySelectorAll('#kqa-inline [data-kqa-atom]').forEach(function (button) {
      button.classList.toggle('kqa-active', button.getAttribute('data-kqa-atom') === symbol);
    });
  }

  function clearNativeSelected() {
    primaryNativeSymbols.concat(secondaryNativeSymbols).forEach(function (symbol) {
      var button = nativeButton(symbol);
      if (button) button.classList.remove('selected');
    });
  }

  function clearExtendedSelected() {
    document.querySelectorAll('#kqa-inline .kqa-active').forEach(function (button) {
      button.classList.remove('kqa-active');
    });
  }

  function markError(button) {
    button.classList.add('kqa-error');
    setTimeout(function () { button.classList.remove('kqa-error'); }, 900);
  }

  function shuffleGroup(group) {
    shuffled(atomButtons(group)).forEach(function (button) { group.appendChild(button); });
  }

  function shuffleNativeGroup(group) {
    if (!group) return;
    shuffled(Array.from(group.querySelectorAll('[data-kqa-native-atom]'))).forEach(function (button) {
      group.appendChild(button);
    });
  }

  function shuffleToolbars() {
    var extendedGroup = document.getElementById('kqa-inline');
    shuffleNativeGroup(document.getElementById('kqa-native-primary'));
    shuffleNativeGroup(document.getElementById('kqa-native-secondary'));
    if (extendedGroup) shuffleGroup(extendedGroup);
  }

  function activateAtomMode(symbol) {
    var editor = window.ketcher && window.ketcher.editor;
    if (!editor || typeof editor.tool !== 'function') return null;
    var isNative = primaryNativeSymbols.concat(secondaryNativeSymbols).indexOf(symbol) >= 0;
    var syncSymbol = isNative ? symbol : 'C';
    var originalButton = document.querySelector('[data-testid="' + syncSymbol + '-button"]');

    /* 先经过 Ketcher 的 React 按钮，清除左侧选择/画键工具的可见选中态。 */
    if (originalButton) {
      syncingNativeSelection = true;
      try { originalButton.click(); }
      finally { syncingNativeSelection = false; }
    }
    editor.tool('atom', { label: symbol });
    surpriseState.selectedSymbol = symbol;
    return editor;
  }

  function selectAtom(symbol, button) {
    try {
      if (!activateAtomMode(symbol)) {
        markError(button);
        return;
      }
      clearNativeSelected();
      markExtendedSelected(symbol);
      setTimeout(shuffleToolbars, 0);
    } catch (_) {
      markError(button);
    }
  }

  function createGroup(id, label, atoms) {
    var group = document.createElement('div');
    group.id = id;
    group.className = 'kqa-atom-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    group.innerHTML = atoms.map(function (atom) {
      return '<button type="button" data-kqa-atom="' + atom.symbol + '" title="' + atom.name + '">' + atom.symbol + '</button>';
    }).join('');
    group.addEventListener('click', function (event) {
      var button = event.target.closest('[data-kqa-atom]');
      if (button) selectAtom(button.getAttribute('data-kqa-atom'), button);
    });
    return group;
  }

  function createNativeGroup(id, label, symbols) {
    var group = document.createElement('div');
    group.id = id;
    group.className = 'kqa-native-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    symbols.forEach(function (symbol) {
      var original = document.querySelector('[data-testid="' + symbol + '-button"]');
      if (!original) return;
      var button = original.cloneNode(true);
      button.removeAttribute('data-testid');
      button.classList.remove('selected');
      button.setAttribute('data-kqa-native-atom', symbol);
      group.appendChild(button);
    });
    return group;
  }

  function createNativeSeparator() {
    var sulfur = document.querySelector('[data-testid="S-button"]');
    var sulfurSection = sulfur && sulfur.parentElement;
    var separator = sulfurSection && sulfurSection.nextElementSibling;
    if (separator && separator.tagName === 'HR') {
      var clone = separator.cloneNode(false);
      clone.id = 'kqa-native-separator';
      return clone;
    }
    var fallback = document.createElement('hr');
    fallback.id = 'kqa-native-separator';
    return fallback;
  }

  function installNativeSelectionHandler() {
    if (document.documentElement.hasAttribute('data-kqa-native-handler-ready')) return;
    document.documentElement.setAttribute('data-kqa-native-handler-ready', 'true');
    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-kqa-native-atom]');
      if (!button) {
        if (event.target.closest('[data-testid="period-table"]')) {
          surpriseState.selectedSymbol = null;
          clearNativeSelected();
          clearExtendedSelected();
        }
        return;
      }
      var symbol = button.getAttribute('data-kqa-native-atom');
      if (!activateAtomMode(symbol)) return;
      clearExtendedSelected();
      clearNativeSelected();
      button.classList.add('selected');
      setTimeout(shuffleToolbars, 0);
    }, true);
  }

  function installToolSelectionSync() {
    if (document.documentElement.hasAttribute('data-kqa-tool-sync-ready')) return;
    document.documentElement.setAttribute('data-kqa-tool-sync-ready', 'true');
    document.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      // Internal React synchronization must not clear the user's selected atom.
      if (syncingNativeSelection || !button || button.closest('#kqa-inline,.kqa-native-group')) return;
      if (String(button.className).indexOf('ActionButton-module_button') < 0) return;
      surpriseState.selectedSymbol = null;
      setTimeout(function () {
        clearNativeSelected();
        clearExtendedSelected();
      }, 0);
    }, true);
  }

  function currentAtomTool(editor) {
    var tool = editor && editor._tool;
    var label = tool && tool.atomProps && tool.atomProps.label;
    var selectedSymbol = surpriseState.selectedSymbol;
    if (!label || !selectedSymbol || selectedSymbol === 'C') return null;
    if (label !== selectedSymbol) {
      var pending = surpriseState.pendingRestore;
      if (!pending || pending.tool !== tool || pending.randomSymbol !== label ||
          pending.selectedSymbol !== selectedSymbol) return null;
    }
    return { tool: tool, label: selectedSymbol };
  }

  function itemAtEvent(editor, event, maps) {
    try {
      return editor.findItem(event, maps) || null;
    } catch (_) {
      return null;
    }
  }

  function atomAtEvent(editor, event) {
    var item = itemAtEvent(editor, event, ['atoms']);
    if (!item || item.map !== 'atoms') return null;
    var atom = editor.struct().atoms.get(item.id);
    return atom ? { id: item.id, label: atom.label } : null;
  }

  function planSurprise() {
    if (surpriseState.cooldown > 0) return { trigger: false, usesCooldown: true };
    if (!surpriseConfig) return { trigger: false, usesCooldown: false };
    if (surpriseConfig.firstForceAt > 0 && !surpriseState.hasTriggered && surpriseState.misses >= surpriseConfig.firstForceAt - 1) {
      return { trigger: true, usesCooldown: false };
    }
    var base = surpriseState.hasTriggered ? surpriseConfig.repeatProbability : surpriseConfig.initialProbability;
    var probability = Math.min(base + surpriseState.misses * surpriseConfig.increment, surpriseConfig.maxProbability);
    return { trigger: randomFraction() < probability, usesCooldown: false };
  }

  function commitSurprise(decision) {
    if (decision.committed) return;
    decision.committed = true;
    if (decision.usesCooldown) {
      surpriseState.cooldown -= 1;
    } else if (decision.trigger) {
      surpriseState.hasTriggered = true;
      surpriseState.cooldown = surpriseConfig.cooldownSteps;
      surpriseState.misses = 0;
    } else {
      surpriseState.misses += 1;
    }
  }

  function shouldSurprise() {
    var decision = planSurprise();
    commitSurprise(decision);
    return decision.trigger;
  }

  function refillCandidateBag() {
    surpriseState.bag = shuffled(allAtoms.map(function (atom) { return atom.symbol; }).filter(function (symbol) {
      return symbol !== 'C';
    }));
  }

  function takeCandidate(selectedSymbol) {
    if (!surpriseState.bag.length) refillCandidateBag();
    var attempts = surpriseState.bag.length;
    while (attempts > 0) {
      attempts -= 1;
      var candidate = surpriseState.bag.pop();
      if (candidate !== selectedSymbol && candidate !== surpriseState.lastResult) {
        surpriseState.lastResult = candidate;
        return candidate;
      }
      surpriseState.bag.unshift(candidate);
    }

    var fallback = shuffled(allAtoms.map(function (atom) { return atom.symbol; }).filter(function (symbol) {
      return symbol !== 'C' && symbol !== selectedSymbol && symbol !== surpriseState.lastResult;
    }))[0];
    surpriseState.lastResult = fallback;
    return fallback;
  }

  function restoreSelectedTool() {
    var pending = surpriseState.pendingRestore;
    if (!pending) return;
    surpriseState.pendingRestore = null;
    if (pending.tool.atomProps && pending.tool.atomProps.label === pending.randomSymbol) {
      pending.tool.atomProps = pending.originalProps;
      if (pending.editor.hoverIcon) {
        pending.editor.hoverIcon.label = pending.selectedSymbol;
        pending.editor.hoverIcon.updatePosition();
      }
    }
  }

  function applyTemporaryRandomSymbol(editor, selected, randomSymbol, scheduleFallback) {
    var originalProps = selected.tool.atomProps;
    selected.tool.atomProps = Object.assign({}, originalProps, { label: randomSymbol });
    surpriseState.pendingRestore = {
      editor: editor,
      tool: selected.tool,
      originalProps: originalProps,
      randomSymbol: randomSymbol,
      selectedSymbol: selected.label
    };
    if (scheduleFallback) setTimeout(restoreSelectedTool, 0);
  }

  function prepareDragDecision(editor, selected) {
    var decision = planSurprise();
    if (!decision.trigger) return decision;
    decision.bagSnapshot = surpriseState.bag.slice();
    decision.lastResultSnapshot = surpriseState.lastResult;
    decision.randomSymbol = takeCandidate(selected.label);
    applyTemporaryRandomSymbol(editor, selected, decision.randomSymbol, false);
    return decision;
  }

  function discardDragDecision(decision) {
    if (decision && decision.trigger) {
      surpriseState.bag = decision.bagSnapshot;
      surpriseState.lastResult = decision.lastResultSnapshot;
    }
    restoreSelectedTool();
  }

  function installCarbonInteractionRandomizer() {
    if (document.documentElement.hasAttribute('data-kqa-randomizer-ready')) return;
    document.documentElement.setAttribute('data-kqa-randomizer-ready', 'true');

    document.addEventListener('mousedown', function (event) {
      var editor = window.ketcher && window.ketcher.editor;
      var selected = currentAtomTool(editor);
      var target = selected && atomAtEvent(editor, event);
      surpriseState.pointerStart = target && target.label === 'C' ? {
        atomId: target.id,
        selectedSymbol: selected.label,
        tool: selected.tool,
        dragDecision: null
      } : null;
    }, true);

    document.addEventListener('mousemove', function (event) {
      var start = surpriseState.pointerStart;
      if (!start || start.dragDecision) return;
      var editor = window.ketcher && window.ketcher.editor;
      var selected = currentAtomTool(editor);
      if (!selected || selected.tool !== start.tool || selected.label !== start.selectedSymbol) return;
      var target = atomAtEvent(editor, event);
      if (target && target.id === start.atomId) return;
      start.dragDecision = prepareDragDecision(editor, selected);
    }, true);

    document.addEventListener('mouseup', function (event) {
      var start = surpriseState.pointerStart;
      surpriseState.pointerStart = null;
      if (!start) return;

      var editor = window.ketcher && window.ketcher.editor;
      var selected = currentAtomTool(editor);
      var target = selected && atomAtEvent(editor, event);

      if (start.dragDecision) {
        var dragContext = selected && selected.tool.dragCtx;
        var validAddition = selected && selected.tool === start.tool &&
          selected.label === start.selectedSymbol && dragContext && dragContext.action;
        if (validAddition) {
          commitSurprise(start.dragDecision);
          if (start.dragDecision.trigger) setTimeout(restoreSelectedTool, 0);
        } else {
          discardDragDecision(start.dragDecision);
        }
        return;
      }

      if (!target || target.id !== start.atomId || target.label !== 'C' ||
          selected.tool !== start.tool || selected.label !== start.selectedSymbol || !shouldSurprise()) return;

      var randomSymbol = takeCandidate(start.selectedSymbol);
      applyTemporaryRandomSymbol(editor, selected, randomSymbol, true);
    }, true);

    /* Ketcher 的 document mouseup 监听器先注册；冒泡到此处时编辑动作已进入撤销栈。 */
    document.addEventListener('mouseup', restoreSelectedTool, false);

    function cancelPendingInteraction() {
      var start = surpriseState.pointerStart;
      surpriseState.pointerStart = null;
      if (start && start.dragDecision) discardDragDecision(start.dragDecision);
      else restoreSelectedTool();
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') cancelPendingInteraction();
    }, true);
    window.addEventListener('blur', cancelPendingInteraction);
  }

  window.addEventListener('ketcher-detection-reset', function () {
    restoreSelectedTool();
    surpriseState.hasTriggered = false;
    surpriseState.cooldown = 0;
    surpriseState.misses = 0;
    surpriseState.bag = [];
    surpriseState.lastResult = null;
    surpriseState.pointerStart = null;
    surpriseState.selectedSymbol = null;
  });

  function mount() {
    if (document.getElementById('kqa-inline')) return true;
    var periodic = periodicButton();
    var iodine = exactButton(document, 'I');
    if (!periodic || !iodine || !window.ketcher || !window.ketcher.editor) return false;

    var host = closestCommonAncestor(periodic, iodine);
    if (!host) return false;
    var anchor = directChildOf(periodic, host);
    if (!anchor) return false;

    var primaryGroup = createNativeGroup('kqa-native-primary', '原生原子 H C N O S', primaryNativeSymbols);
    var separator = createNativeSeparator();
    var secondaryGroup = createNativeGroup('kqa-native-secondary', '原生原子 P F Cl Br I', secondaryNativeSymbols);
    if (primaryGroup.children.length !== primaryNativeSymbols.length ||
        secondaryGroup.children.length !== secondaryNativeSymbols.length) return false;
    hideOriginalNativeAtoms(host);
    host.insertBefore(primaryGroup, anchor);
    host.insertBefore(separator, anchor);
    host.insertBefore(secondaryGroup, anchor);
    host.insertBefore(createGroup('kqa-inline', '常用扩展原子', extendedAtoms), anchor);
    installNativeSelectionHandler();
    installToolSelectionSync();
    installCarbonInteractionRandomizer();
    return true;
  }

  function init() {
    if (mount()) return;
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      if (mount() || attempts > 300) clearInterval(timer);
    }, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
