(function () {
  'use strict';

  var TEXT = {
    zh: {
      pageTitle: '分子绘图行为测试',
      mainTitle: '分子结构绘图测试',
      description: '观察目标图，在 Ketcher 中手工复现结构。系统将分别校验结构正确性与绘图行为。',
      observe: '观察结构',
      draw: '手工绘制',
      finish: '完成分析',
      target: '目标结构',
      targetHint: '请勿使用导入或粘贴',
      generating: '正在生成随机结构…',
      generatingLibrary: '正在从分子库抽取结构…',
      generatingAutomatic: '正在自动生成分子结构…',
      sourceTitle: '案例来源',
      sourceLibrary: '分子库案例',
      sourceGenerated: '自动生成分子案例',
      ready: '准备测试',
      generated: '图像已生成，请在右侧手工绘制',
      failed: '生成失败，请重试',
      newTest: '换一题',
      result: '检测结果',
      trusted: '服务端可信判定',
      structure: '结构校验',
      behavior: '行为判定',
      correct: '绘制正确',
      invalid: '结构无效',
      mismatch: '绘制不一致',
      human: '更像人类',
      bot: '疑似机器人',
      uncertain: '证据不足',
      risk: '行为风险分',
      confidence: '置信度',
      completed: '本次测试已完成，可换一题重新检测',
      language: 'English',
      imageAlt: '待复现的分子结构测试图',
      editorLoading: 'Ketcher 画板正在加载，首次访问需要下载编辑器资源…'
    },
    en: {
      pageTitle: 'Molecular Drawing Behavior Test',
      mainTitle: 'Molecular Structure Drawing Test',
      description: 'Study the target image and manually reproduce the structure in Ketcher. Structure accuracy and drawing behavior are evaluated separately.',
      observe: 'Study structure',
      draw: 'Draw manually',
      finish: 'Finish analysis',
      target: 'Target structure',
      targetHint: 'Import and paste are disabled',
      generating: 'Generating a random structure…',
      generatingLibrary: 'Selecting a structure from the molecule library…',
      generatingAutomatic: 'Generating a molecule automatically…',
      sourceTitle: 'Test source',
      sourceLibrary: 'Molecule library',
      sourceGenerated: 'Auto-generated molecule',
      ready: 'Preparing test',
      generated: 'Image ready. Reproduce it manually on the right.',
      failed: 'Generation failed. Please retry.',
      newTest: 'New test',
      result: 'Test result',
      trusted: 'Server-verified result',
      structure: 'Structure check',
      behavior: 'Behavior verdict',
      correct: 'Correct structure',
      invalid: 'Invalid structure',
      mismatch: 'Structure mismatch',
      human: 'Likely human',
      bot: 'Likely bot',
      uncertain: 'Insufficient evidence',
      risk: 'Behavior risk',
      confidence: 'Confidence',
      completed: 'Test complete. Start a new test to try again.',
      language: '中文',
      imageAlt: 'Molecular structure test image to reproduce',
      editorLoading: 'Loading Ketcher. The first visit downloads the editor resources…'
    }
  };

  var image = document.getElementById('challenge-image');
  var loading = document.getElementById('loading');
  var state = document.getElementById('challenge-state');
  var editor = document.getElementById('editor');
  var newButton = document.getElementById('new-challenge');
  var languageButton = document.getElementById('language-switch');
  var editorLoading = document.getElementById('editor-loading');
  var sourceInputs = Array.prototype.slice.call(
    document.querySelectorAll('input[name="challenge-source"]')
  );
  var result = document.getElementById('result');
  var structureResult = document.getElementById('structure-result');
  var behaviorResult = document.getElementById('behavior-result');
  var resultDetail = document.getElementById('result-detail');
  var currentLanguage = new URLSearchParams(window.location.search).get('lang') === 'zh' ? 'zh' : 'en';
  var editorReady = false;
  var pendingChallengeId = null;

  function t(key) {
    return TEXT[currentLanguage][key];
  }

  function setText(id, key) {
    var element = document.getElementById(id);
    if (element) element.textContent = t(key);
  }

  function applyLanguage() {
    document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
    document.title = t('pageTitle');
    setText('page-title', 'pageTitle');
    setText('main-title', 'mainTitle');
    setText('main-description', 'description');
    setText('step-observe', 'observe');
    setText('step-draw', 'draw');
    setText('step-finish', 'finish');
    setText('target-title', 'target');
    setText('target-hint', 'targetHint');
    setText('source-title', 'sourceTitle');
    setText('source-library', 'sourceLibrary');
    setText('source-generated', 'sourceGenerated');
    setText('new-test-label', 'newTest');
    setText('result-title', 'result');
    setText('trusted-label', 'trusted');
    setText('structure-label', 'structure');
    setText('behavior-label', 'behavior');
    languageButton.textContent = t('language');
    image.alt = t('imageAlt');
    editorLoading.textContent = t('editorLoading');
    editor.title = currentLanguage === 'zh' ? 'Ketcher 分子结构画板' : 'Ketcher molecular structure editor';
    document.querySelector('.steps').setAttribute('aria-label', currentLanguage === 'zh' ? '操作步骤' : 'Test steps');
    document.querySelector('.reference-card').setAttribute('aria-label', t('target'));
    window.dispatchEvent(new CustomEvent('challenge-language-change', {detail: currentLanguage}));
  }

  function setClass(element, name) {
    element.classList.remove('ok', 'bad', 'warn');
    if (name) element.classList.add(name);
  }

  function selectedSource() {
    var selected = sourceInputs.find(function (input) {
      return input.checked;
    });
    return selected ? selected.value : 'library';
  }

  function setSourceDisabled(disabled) {
    sourceInputs.forEach(function (input) {
      input.disabled = disabled;
    });
  }

  function setEditorLoading(loading) {
    editorLoading.hidden = !loading;
  }

  function loadEditor(force) {
    if (!force && editor.getAttribute('src')) return;
    editorReady = false;
    setEditorLoading(true);
    editor.src = 'editor?lang=' + currentLanguage;
  }

  function sendChallengeToEditor() {
    if (!editorReady || !pendingChallengeId || !editor.contentWindow) return;
    editor.contentWindow.postMessage({
      eventType: 'ketcher-set-challenge',
      challengeId: pendingChallengeId
    }, window.location.origin);
  }

  async function createChallenge() {
    var sourceType = selectedSource();
    newButton.disabled = true;
    setSourceDisabled(true);
    result.hidden = true;
    image.hidden = true;
    loading.hidden = false;
    loading.textContent = sourceType === 'generated'
      ? t('generatingAutomatic')
      : t('generatingLibrary');
    state.textContent = t('ready');

    try {
      var response = await fetch('api/challenges', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ source: sourceType, language: currentLanguage }),
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      var data = await response.json();
      image.onload = function () {
        loading.hidden = true;
        image.hidden = false;
      };
      image.src = data.imageUrl + '?v=' + Date.now();
      state.textContent = t('generated');
      pendingChallengeId = data.challengeId;
      sendChallengeToEditor();
    } catch (error) {
      loading.textContent = t('failed');
      state.textContent = String(error && error.message || error);
    } finally {
      newButton.disabled = false;
      setSourceDisabled(false);
    }
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin || event.source !== editor.contentWindow || !event.data) return;
    if (event.data.eventType === 'ketcher-editor-ready') {
      editorReady = true;
      setEditorLoading(false);
      sendChallengeToEditor();
      return;
    }
    if (event.data.eventType === 'ketcher-challenge-ready') return;
    if (event.data.eventType === 'ketcher-request-new-challenge') {
      createChallenge();
      return;
    }
    if (event.data.eventType !== 'ketcher-usage-report') return;

    var report = event.data.report || {};
    var verified = Boolean(report.delivery && report.delivery.ok && report.classification && report.classification.source === 'server');
    document.getElementById('trusted-label').textContent = verified ? t('trusted') : (currentLanguage === 'zh' ? '服务端未验证' : 'Not server verified');
    var verification = verified ? (report.challengeVerification || {}) : {};
    var classification = verified ? (report.classification || {}) : {verdict: 'uncertain', confidence: 0};
    result.hidden = false;
    structureResult.textContent = !verified || verification.status === 'verification_failed'
      ? (currentLanguage === 'zh' ? '未校验结构' : 'Structure not checked')
      : verification.matched
      ? t('correct')
      : verification.status === 'not_checked'
        ? (currentLanguage === 'zh' ? '未校验结构' : 'Structure not checked')
      : verification.status === 'empty_or_invalid'
        ? t('invalid')
        : t('mismatch');
    setClass(structureResult, !verified ? 'warn' : verification.matched ? 'ok' : 'bad');

    var verdict = classification.verdict;
    behaviorResult.textContent = verdict === 'likely_human'
      ? t('human')
      : verdict === 'likely_bot'
        ? t('bot')
        : t('uncertain');
    setClass(
      behaviorResult,
      verdict === 'likely_human' ? 'ok' : verdict === 'likely_bot' ? 'bad' : 'warn'
    );
    resultDetail.textContent = t('risk') + ' ' +
      (classification.score == null ? '—' : classification.score + '/100') + ' · ' +
      t('confidence') + ' ' +
      (classification.confidence == null ? '—' : classification.confidence + '%');
    if (!verified && report.delivery && report.delivery.error) resultDetail.textContent += ' · ' + report.delivery.error;
    if (verified && report.attentionVerification) resultDetail.textContent += ' · ' + (currentLanguage === 'zh' ? report.attentionVerification.messageZh : report.attentionVerification.message);
    if (verified && report.timeVerification && !report.timeVerification.passed) {
      var timingMessage = currentLanguage === 'zh' ? report.timeVerification.messageZh : report.timeVerification.message;
      resultDetail.textContent = timingMessage + ' · ' + resultDetail.textContent;
      state.textContent = timingMessage;
      return;
    }
    state.textContent = verified ? (report.accepted === true ? t('completed') : (currentLanguage === 'zh' ? '本次未通过验证，可换一题重新检测' : 'Verification not passed. Start a new test.')) : (currentLanguage === 'zh' ? '校验失败，请换一题重新检测' : 'Verification failed. Start a new test.');
  });

  languageButton.addEventListener('click', function () {
    currentLanguage = currentLanguage === 'zh' ? 'en' : 'zh';
    var url = new URL(window.location.href);
    url.searchParams.set('lang', currentLanguage);
    window.history.replaceState(null, '', url.toString());
    applyLanguage();
    loadEditor(true);
    createChallenge();
  });

  newButton.addEventListener('click', createChallenge);
  sourceInputs.forEach(function (input) {
    input.addEventListener('change', function () {
      if (input.checked) createChallenge();
    });
  });
  applyLanguage();
  loadEditor(false);
  createChallenge();
}());
