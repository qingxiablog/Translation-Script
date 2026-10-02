// ==UserScript==
// @name         Shift Translator / Auto-recognition Version
// @name:zh-CN   Shift Translator / 自动识别版
// @namespace    https://example.com/
// @version      1.4.2
// @description  Hover element + modifier key to toggle translation. Select text + modifier key for tooltip translation.
// @author       Link Chen
// @license      MIT
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @downloadURL https://update.greasyfork.org/scripts/591502/Shift%20Translator%20%20Shift%20new.user.js
// @updateURL https://update.greasyfork.org/scripts/591502/Shift%20Translator%20%20Shift%20new.meta.js
// ==/UserScript==

(() => {
  'use strict';

  /*
   * =========================================================
   * Debug
   * =========================================================
   */

  const DEBUG = false;

  /*
   * =========================================================
   * Config
   * =========================================================
   */

  // Chrome documents `zh` for Simplified Chinese. Keep variants as fallbacks.
  const TARGET_LANGUAGE_CANDIDATES = ['zh', 'zh-CN', 'zh-Hans'];

  const SEMANTIC_PARAGRAPH_SELECTOR = [
    'p',
    'li',
    'blockquote',
    'dd',
    'dt',
    'figcaption',
    'td',
    'th',
    // Reddit renders post titles as h1 on the post page and h2 on feeds.
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    // Some Reddit feed variants render the title as a slotted link.
    'a[slot="title"]',
    '[data-testid="post-title"]',
  ].join(',');

  const FALLBACK_TEXT_BLOCK_SELECTOR = 'div,span';

  const PARAGRAPH_SELECTOR = [
    SEMANTIC_PARAGRAPH_SELECTOR,
    FALLBACK_TEXT_BLOCK_SELECTOR,
  ].join(',');

  const NESTED_BLOCK_SELECTOR = [
    SEMANTIC_PARAGRAPH_SELECTOR,
    'article',
    'aside',
    'div',
    'main',
    'section',
    'table',
    'ul',
    'ol',
  ].join(',');

  const MAX_HOVER_TEXT_LENGTH = 6000;
  const LANGUAGE_DETECTOR_TIMEOUT_MS = 15000;

  const EXCLUDED_SELECTOR = [
    'script',
    'style',
    'noscript',
    'textarea',
    'code',
    'pre',
    'kbd',
    'samp',
    'svg',
    'canvas',
    'nav',
    'header',
    'footer',
    'button',
    'input',
    'select',
    'option',
    'img',
    '[role="navigation"]',
    '[translate="no"]',
    '[data-tm-no-translate="1"]',
  ].join(',');

  const TRANSLATED_COPY_ATTR = 'data-tm-translated-copy';
  const TRANSLATED_FROM_ATTR = 'data-tm-translated-from';
  const SOURCE_ID_ATTR = 'data-tm-source-id';
  const LOADING_ATTR = 'data-tm-translation-loading';

  const MODIFIER_STORAGE_KEY = 'tm_modifier_keys';
  const DEFAULT_MODIFIER_KEYS = ['shift'];

  const DEBUG_OUTLINE_CLASS = 'tm-debug-outline';

  /*
   * =========================================================
   * State
   * =========================================================
   */

  const translatorCache = new Map();
  let languageDetectorPromise = null;
  let languageDetectorAbortController = null;
  const translationJobs = new WeakMap();

  let modifierKeys = loadModifierKeys();

  let activeToast = null;
  let toastTimer = null;

  let hoveredParagraph = null;
  let tooltipState = null;
  let modifierModalOverlay = null;

  /*
   * =========================================================
   * Style
   * =========================================================
   */

  const style = document.createElement('style');

  style.textContent = `
    @keyframes tm-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .tm-spinner {
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: 2px solid rgba(0,0,0,.16);
      border-top-color: rgba(0,0,0,.72);
      animation: tm-spin .8s linear infinite;
      flex: 0 0 auto;
    }

    .tm-loading-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      color: rgba(0,0,0,.62);
      font: 13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }

    [${TRANSLATED_COPY_ATTR}="1"] {
      display: flow-root !important;
      opacity: 1 !important;
      box-sizing: border-box !important;
      margin-top: 8px !important;
      margin-bottom: 10px !important;
      margin-right: 12px !important;
      padding: 10px 12px !important;
      border-left: 4px solid #1677ff !important;
      border-radius: 6px !important;
      background: rgba(22,119,255,.10) !important;
      box-shadow: 0 2px 8px rgba(22,119,255,.12) !important;
      color: inherit !important;
    }

    [${TRANSLATED_COPY_ATTR}="1"]::before {
      content: "译文";
      display: block;
      margin-bottom: 4px;
      color: #0969da;
      font: 700 12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      letter-spacing: .08em;
    }

    @media (prefers-color-scheme: dark) {
      [${TRANSLATED_COPY_ATTR}="1"] {
        border-left-color: #58a6ff !important;
        background: rgba(88,166,255,.16) !important;
        box-shadow: 0 2px 10px rgba(0,0,0,.24) !important;
      }

      [${TRANSLATED_COPY_ATTR}="1"]::before {
        color: #79c0ff;
      }
    }

    .${DEBUG_OUTLINE_CLASS} {
      outline: 2px solid rgba(0,128,255,.65) !important;
      outline-offset: 2px !important;
      background: rgba(0,128,255,.04) !important;
    }
  `;

  document.documentElement.appendChild(style);

  /*
   * =========================================================
   * Utils
   * =========================================================
   */

  function uid() {
    return `tm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function isElement(value) {
    return value && value.nodeType === Node.ELEMENT_NODE;
  }

  function isEditableTarget(target) {
    if (!target) return false;

    const tag = target.tagName;

    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA'
    ) {
      return true;
    }

    if (target.isContentEditable) {
      return true;
    }

    if (
      target.closest?.(
        '[contenteditable="true"]'
      )
    ) {
      return true;
    }

    return false;
  }

  function isParagraphLike(el) {

    if (
      !isElement(el) ||
      !el.matches(PARAGRAPH_SELECTOR)
    ) {
      return false;
    }

    if (el.hasAttribute(TRANSLATED_COPY_ATTR)) {
      return false;
    }

    if (el.closest(EXCLUDED_SELECTOR)) {
      return false;
    }

    const textRoot =
      el.querySelector(`[${TRANSLATED_COPY_ATTR}="1"]`)
        ? el.cloneNode(true)
        : el;

    textRoot.querySelectorAll?.(
      `[${TRANSLATED_COPY_ATTR}="1"]`
    ).forEach(node => node.remove());

    const text =
      textRoot.innerText?.trim() || '';

    // ignore tiny texts
    if (text.length < 12) {
      return false;
    }

    // Never translate page-sized content from a hover action.
    if (text.length > MAX_HOVER_TEXT_LENGTH) {
      return false;
    }

    const isSemanticParagraph =
      el.matches(SEMANTIC_PARAGRAPH_SELECTOR);

    const nestedSemanticParagraph =
      [...el.querySelectorAll(SEMANTIC_PARAGRAPH_SELECTOR)]
        .find(child => !child.closest(`[${TRANSLATED_COPY_ATTR}="1"]`));

    if (isSemanticParagraph && nestedSemanticParagraph) {
      return false;
    }

    // A div/span is only a last-resort text leaf. If it contains any block,
    // it is a wrapper and must never win over a real paragraph below it.
    if (
      !isSemanticParagraph &&
      el.querySelector(NESTED_BLOCK_SELECTOR)
    ) {
      return false;
    }

    // ignore giant layout containers
    const rect =
      el.getBoundingClientRect();

    if (rect.height > Math.max(window.innerHeight * 1.5, 900)) {
      return false;
    }

    return true;
  }

  function normalizeModifierKeys(input) {
    if (!input) {
      return [...DEFAULT_MODIFIER_KEYS];
    }

    const allowed = ['shift', 'control', 'command'];

    const parts = input
      .toLowerCase()
      .split('+')
      .map(v => v.trim())
      .filter(Boolean);

    const unique = [...new Set(parts)];
    const valid = unique.filter(v => allowed.includes(v));

    return valid.length
      ? valid
      : [...DEFAULT_MODIFIER_KEYS];
  }

  function loadModifierKeys() {
    try {
      const raw = GM_getValue(
        MODIFIER_STORAGE_KEY,
        ''
      );

      if (!raw) {
        return [...DEFAULT_MODIFIER_KEYS];
      }

      return normalizeModifierKeys(raw);
    } catch {
      return [...DEFAULT_MODIFIER_KEYS];
    }
  }

  function saveModifierKeys(keys) {
    modifierKeys = normalizeModifierKeys(
      keys.join('+')
    );

    GM_setValue(
      MODIFIER_STORAGE_KEY,
      modifierKeys.join('+')
    );
  }

  function isModifierMatch(event) {
    const pressed = [];

    if (event.shiftKey) pressed.push('shift');
    if (event.ctrlKey) pressed.push('control');
    if (event.metaKey) pressed.push('command');

    if (pressed.length !== modifierKeys.length) {
      return false;
    }

    return modifierKeys.every(k => pressed.includes(k));
  }

  function showToast(
    message,
    ms = 1600,
    isError = false
  ) {
    if (!activeToast) {
      activeToast = document.createElement('div');

      activeToast.style.cssText = `
        position:fixed;
        left:16px;
        bottom:16px;
        z-index:2147483647;
        max-width:min(520px,calc(100vw - 32px));
        padding:10px 12px;
        border-radius:10px;
        color:#fff;
        font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        box-shadow:0 8px 30px rgba(0,0,0,.28);
        white-space:pre-wrap;
        pointer-events:none;
      `;

      document.documentElement.appendChild(
        activeToast
      );
    }

    activeToast.textContent = message;

    activeToast.style.background = isError
      ? 'rgba(176,0,32,.94)'
      : 'rgba(20,20,20,.92)';

    activeToast.style.display = 'block';

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      if (activeToast) {
        activeToast.style.display = 'none';
      }
    }, isError ? 5000 : ms);
  }

  function showErrorToast(err) {
    const message =
      err?.message ||
      String(err) ||
      'Translation failed.';

    console.error('[TM Translator]', err);

    showToast(message, 5000, true);
  }

  function createLoadingRow(
    text = 'Translating...',
    tagName = 'div'
  ) {
    const row = document.createElement(tagName);

    row.className = 'tm-loading-row';

    const spinner = document.createElement('span');
    spinner.className = 'tm-spinner';

    const label = document.createElement('span');
    label.textContent = text;

    row.appendChild(spinner);
    row.appendChild(label);

    return row;
  }

  /*
   * =========================================================
   * Translator
   * =========================================================
   */

  function getTranslatorApi() {
    const candidates = [
      globalThis,
      typeof window !== 'undefined' ? window : null,
      typeof unsafeWindow !== 'undefined' ? unsafeWindow : null,
    ];

    for (const candidate of candidates) {
      if (candidate?.Translator) {
        return candidate.Translator;
      }
    }

    return null;
  }

  function getLanguageDetectorApi() {
    const candidates = [
      globalThis,
      typeof window !== 'undefined' ? window : null,
      typeof unsafeWindow !== 'undefined' ? unsafeWindow : null,
    ];

    for (const candidate of candidates) {
      if (candidate?.LanguageDetector) {
        return candidate.LanguageDetector;
      }
    }

    return null;
  }

  function withTimeout(promise, message) {
    let timer;

    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          LANGUAGE_DETECTOR_TIMEOUT_MS
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function guessLanguage(text) {
    if (/[぀-ヿ]/u.test(text)) return 'ja';
    if (/[가-힯]/u.test(text)) return 'ko';
    if (/[؀-ۿ]/u.test(text)) return 'ar';
    if (/[Ѐ-ӿ]/u.test(text)) return 'ru';
    if (/[㐀-鿿]/u.test(text)) return 'zh';

    const sample = ` ${text.toLowerCase()} `;
    const markers = {
      es: [' el ', ' la ', ' los ', ' las ', ' que ', ' y ', ' una ', ' por ', ' para ', ' del '],
      fr: [' le ', ' les ', ' des ', ' du ', ' que ', ' et ', ' une ', ' pour ', ' dans '],
      de: [' der ', ' die ', ' das ', ' und ', ' ist ', ' ein ', ' eine ', ' nicht ', ' für '],
      it: [' il ', ' lo ', ' gli ', ' che ', ' una ', ' per ', ' non ', ' del '],
      pt: [' os ', ' as ', ' dos ', ' das ', ' que ', ' uma ', ' para ', ' não ', ' com '],
      en: [' the ', ' of ', ' and ', ' is ', ' an ', ' to ', ' in ', ' for ', ' with '],
    };

    let bestLanguage = 'en';
    let bestScore = 0;

    for (const [language, words] of Object.entries(markers)) {
      let score = words.reduce(
        (total, word) => total + sample.split(word).length - 1,
        0
      );

      if (language === 'es' && /[ñ¿¡]/u.test(text)) score += 3;
      if (language === 'pt' && /[ãõç]/u.test(text)) score += 3;
      if (language === 'de' && /[äöüß]/u.test(text)) score += 3;

      if (score > bestScore) {
        bestLanguage = language;
        bestScore = score;
      }
    }

    return bestLanguage;
  }

  async function detectLanguage(text) {
    const LanguageDetectorApi = getLanguageDetectorApi();

    if (!LanguageDetectorApi) {
      return guessLanguage(text);
    }

    let detector;

    try {
      if (!languageDetectorPromise) {
        const availability =
          await withTimeout(
            LanguageDetectorApi.availability(),
            'Language detector availability check timed out.'
          );

        if (
          availability !== 'available' &&
          availability !== 'downloadable' &&
          availability !== 'downloading'
        ) {
          return guessLanguage(text);
        }

        languageDetectorAbortController =
          new AbortController();

        languageDetectorPromise =
          LanguageDetectorApi.create({
            signal: languageDetectorAbortController.signal,
            monitor(monitor) {
              monitor.addEventListener(
                'downloadprogress',
                event => {
                  const loaded = Number(event.loaded);
                  const percent = Number.isFinite(loaded)
                    ? Math.round(Math.max(0, Math.min(1, loaded)) * 100)
                    : 0;

                  showToast(
                    `Downloading language detector: ${percent}%`,
                    3000
                  );
                }
              );
            },
          });
      }

      detector = await withTimeout(
        languageDetectorPromise,
        'Language detector timed out.'
      );

      const results = await withTimeout(
        detector.detect(
          text,
          { signal: languageDetectorAbortController?.signal }
        ),
        'Language detection timed out.'
      );

      const result = results?.find(
        item =>
          item?.detectedLanguage &&
          item.detectedLanguage !== 'und'
      );

      if (!result) {
        return guessLanguage(text);
      }

      return result.detectedLanguage
        .toLowerCase()
        .split('-')[0];
    } catch (err) {
      languageDetectorAbortController?.abort();
      languageDetectorAbortController = null;
      languageDetectorPromise = null;
      console.warn('[TM Translator] Language detection fallback:', err);
      showToast('Language detection timed out; using fallback.', 3000);
      return guessLanguage(text);
    }
  }

  async function getTranslator(text) {

    const TranslatorApi = getTranslatorApi();

    if (!TranslatorApi) {
      throw new Error(
        'Translator API is unavailable. Use Chrome 138+ on desktop.'
      );
    }

    const sourceLanguage = await detectLanguage(text);

    if (sourceLanguage === 'zh') {
      return null;
    }

    let lastError = null;

    for (const targetLanguage of TARGET_LANGUAGE_CANDIDATES) {

      const cacheKey =
        `${sourceLanguage}->${targetLanguage}`;

      if (translatorCache.has(cacheKey)) {
        return translatorCache.get(cacheKey);
      }

      let availability;

      try {

        availability =
          await TranslatorApi.availability({
            sourceLanguage,
            targetLanguage,
          });

      } catch (err) {
        lastError = err;
        continue;
      }

      if (
        availability !== 'available' &&
        availability !== 'downloadable' &&
        availability !== 'downloading'
      ) {
        continue;
      }

      const promise = TranslatorApi.create({
        sourceLanguage,
        targetLanguage,
        monitor(monitor) {
          monitor.addEventListener(
            'downloadprogress',
            event => {
              const loaded = Number(event.loaded);
              const percent = Number.isFinite(loaded)
                ? Math.round(Math.max(0, Math.min(1, loaded)) * 100)
                : 0;

              showToast(
                `Downloading translation model: ${percent}%`,
                3000
              );
            }
          );
        },
      });

      translatorCache.set(cacheKey, promise);

      try {
        return await promise;
      } catch (err) {
        lastError = err;
        translatorCache.delete(cacheKey);
      }
    }

    throw new Error(
      `No supported ${sourceLanguage}-to-Chinese translator is available.`,
      { cause: lastError }
    );
  }

  async function translateText(
    translator,
    text,
    options = undefined
  ) {
    if (
      typeof translator.measureInputUsage === 'function' &&
      Number.isFinite(translator.inputQuota)
    ) {
      const usage = await translator.measureInputUsage(text, options);

      if (usage > translator.inputQuota) {
        throw new Error(
          'The selected text is too long for one translation. Select a smaller section.'
        );
      }
    }

    return translator.translate(text, options);
  }

  async function translatePlainText(
    text,
    options = undefined
  ) {
    const translator = await getTranslator(text);

    if (!translator) {
      return text;
    }

    return translateText(translator, text, options);
  }

  /*
   * =========================================================
   * Hover Translate
   * =========================================================
   */

  function findParagraphCandidate(start) {

    const semanticParagraph =
      start.closest(SEMANTIC_PARAGRAPH_SELECTOR);

    if (semanticParagraph) {
      return isParagraphLike(semanticParagraph)
        ? semanticParagraph
        : null;
    }

    let current = start;

    while (
      isElement(current) &&
      current !== document.body &&
      current !== document.documentElement
    ) {
      if (
        current.matches(FALLBACK_TEXT_BLOCK_SELECTOR) &&
        isParagraphLike(current)
      ) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function getParagraphFromPoint(event) {

    if (typeof document.elementsFromPoint === 'function') {

      const stack =
        document.elementsFromPoint(
          event.clientX,
          event.clientY
        );

      for (const el of stack) {

        if (!isElement(el)) continue;

        if (
          el.closest(
            `[${TRANSLATED_COPY_ATTR}="1"]`
          )
        ) {
          continue;
        }

        const paragraph =
          findParagraphCandidate(el);

        if (
          paragraph &&
          isParagraphLike(paragraph)
        ) {
          return paragraph;
        }
      }
    }

    return null;
  }

  function updateDebugOutline(nextParagraph) {

    if (!DEBUG) return;

    if (
      hoveredParagraph &&
      hoveredParagraph !== nextParagraph
    ) {
      hoveredParagraph.classList.remove(
        DEBUG_OUTLINE_CLASS
      );
    }

    if (nextParagraph) {
      nextParagraph.classList.add(
        DEBUG_OUTLINE_CLASS
      );
    }
  }

  function setHoveredParagraph(nextParagraph) {

    updateDebugOutline(nextParagraph);

    hoveredParagraph =
      nextParagraph || null;
  }

  function stripDuplicateIds(root) {

    if (!root) return;

    if (root.hasAttribute?.('id')) {
      root.removeAttribute('id');
    }

    root.querySelectorAll?.('[id]')
      .forEach(el => el.removeAttribute('id'));
  }

  function collectTranslatableTextNodes(root) {

    const nodes = [];

    const walker =
      document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {

            if (!node?.nodeValue?.trim()) {
              return NodeFilter.FILTER_REJECT;
            }

            const parent =
              node.parentElement;

            if (!parent) {
              return NodeFilter.FILTER_REJECT;
            }

            if (
              parent.closest(EXCLUDED_SELECTOR)
            ) {
              return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

    let current;

    while ((current = walker.nextNode())) {
      nodes.push(current);
    }

    return nodes;
  }

  async function translateCloneTree(clone) {

    const textNodes =
      collectTranslatableTextNodes(clone);

    const sourceText =
      textNodes
        .map(node => node.nodeValue)
        .join('')
        .trim();

    const translator =
      await getTranslator(sourceText);

    if (!translator) {
      return {
        failedCount: 0,
        translatedCount: sourceText ? 1 : 0,
      };
    }

    // ponytail: one plain-text pass keeps context; restore markup mapping only if inline links must remain clickable.
    const translated =
      await translateText(translator, sourceText);

    if (!translated) {
      throw new Error('The translator returned no text.');
    }

    clone.textContent = translated;

    return {
      failedCount: 0,
      translatedCount: 1,
    };
  }

  function findExistingTranslation(original) {

    const sourceId =
      original.getAttribute(
        SOURCE_ID_ATTR
      );

    if (!sourceId) return null;

    const translation = original.querySelector(
      `[${TRANSLATED_COPY_ATTR}="1"][${TRANSLATED_FROM_ATTR}="${sourceId}"]`
    );

    if (translation) {
      return translation;
    }

    return null;
  }

  async function toggleTranslation(original) {

    if (translationJobs.has(original)) {
      showToast('Translation is already in progress.');
      return;
    }

    let sourceId =
      original.getAttribute(
        SOURCE_ID_ATTR
      );

    if (!sourceId) {

      sourceId = uid();

      original.setAttribute(
        SOURCE_ID_ATTR,
        sourceId
      );
    }

    const existing =
      findExistingTranslation(original);

    if (existing) {

      existing.remove();

      showToast(
        'Translation hidden.'
      );

      return;
    }

    const clone =
      original.cloneNode(true);

    stripDuplicateIds(clone);
    clone.removeAttribute(SOURCE_ID_ATTR);

    clone.setAttribute(
      TRANSLATED_COPY_ATTR,
      '1'
    );

    clone.setAttribute(
      TRANSLATED_FROM_ATTR,
      sourceId
    );

    const loading = createLoadingRow(
      'Translating...',
      original.matches('span') ? 'span' : 'div'
    );

    loading.setAttribute(LOADING_ATTR, '1');

    original.appendChild(loading);

    const job = { loading };
    translationJobs.set(original, job);

    try {

      const result = await translateCloneTree(clone);

      if (
        translationJobs.get(original) === job &&
        loading.isConnected &&
        original.isConnected
      ) {
        loading.replaceWith(clone);

        showToast(
          result.failedCount
            ? `Translation shown; ${result.failedCount} segment(s) kept unchanged.`
            : 'Translation shown.'
        );
      }

    } catch (err) {

      loading.remove();
      throw err;
    } finally {
      if (translationJobs.get(original) === job) {
        translationJobs.delete(original);
      }
    }
  }

  /*
   * =========================================================
   * Tooltip Translate
   * =========================================================
   */

  function getSelectedText() {

    const selection =
      window.getSelection?.();

    if (
      selection &&
      !selection.isCollapsed
    ) {

      const text =
        selection.toString();

      if (text?.trim()) {

        const range =
          selection.getRangeAt(0);

        return {
          text,
          rect:
            range.getBoundingClientRect(),
        };
      }
    }

    return null;
  }

  function closeTooltip() {

    if (!tooltipState) return;

    const {
      tooltip,
      abortController,
      onPointerDown,
      onBlur,
      onVisibilityChange,
    } = tooltipState;

    document.removeEventListener(
      'pointerdown',
      onPointerDown,
      true
    );

    window.removeEventListener(
      'blur',
      onBlur,
      true
    );

    document.removeEventListener(
      'visibilitychange',
      onVisibilityChange,
      true
    );

    abortController.abort();
    tooltip.remove();

    tooltipState = null;
  }

  async function openSelectionTooltip(
    selectionData
  ) {

    let state = null;

    try {

      if (!selectionData?.text?.trim()) {
        return;
      }

      closeTooltip();

      const tooltip =
        document.createElement('div');

      tooltip.style.cssText = `
        position:fixed;
        z-index:2147483647;
        max-width:min(520px,calc(100vw - 24px));
        min-width:280px;
        max-height:calc(100vh - 24px);
        overflow:auto;
        background:#fff;
        color:#111;
        border-radius:14px;
        box-shadow:0 16px 48px rgba(0,0,0,.22);
        border:1px solid rgba(0,0,0,.08);
        padding:14px;
        font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        word-break:break-word;
        box-sizing:border-box;
        visibility:hidden;
      `;

      const title =
        document.createElement('div');

      title.style.cssText = `
        font-size:12px;
        font-weight:700;
        text-transform:uppercase;
        letter-spacing:.04em;
        margin-bottom:10px;
        color:rgba(0,0,0,.48);
      `;

      title.textContent =
        'Translation';

      const content =
        document.createElement('div');

      content.style.whiteSpace =
        'pre-wrap';

      content.appendChild(
        createLoadingRow(
          'Translating...'
        )
      );

      tooltip.appendChild(title);
      tooltip.appendChild(content);

      document.documentElement.appendChild(
        tooltip
      );

      const margin = 12;

      const viewportW =
        window.visualViewport?.width ||
        window.innerWidth;

      const viewportH =
        window.visualViewport?.height ||
        window.innerHeight;

      const viewportLeft =
        window.visualViewport?.offsetLeft || 0;

      const viewportTop =
        window.visualViewport?.offsetTop || 0;

      function positionTooltip() {

        const rect =
          selectionData.rect;

        const tipRect =
          tooltip.getBoundingClientRect();

        const tipW = Math.min(
          tipRect.width,
          viewportW - margin * 2
        );

        const tipH = Math.min(
          tipRect.height,
          viewportH - margin * 2
        );

        const spaceBelow =
          viewportH -
          (rect.bottom - viewportTop) -
          margin;

        const spaceAbove =
          (rect.top - viewportTop) -
          margin;

        let top;

        if (
          spaceBelow >= tipH ||
          spaceBelow >= spaceAbove
        ) {

          top = Math.min(
            rect.bottom + 12,
            viewportTop +
              viewportH -
              tipH -
              margin
          );

        } else {

          top = Math.max(
            viewportTop + margin,
            rect.top - tipH - 12
          );
        }

        let left =
          rect.left - viewportLeft;

        left = Math.min(
          left,
          viewportW -
            tipW -
            margin
        );

        left = Math.max(
          margin,
          left
        );

        tooltip.style.left =
          `${left + viewportLeft}px`;

        tooltip.style.top =
          `${top}px`;

        tooltip.style.visibility =
          'visible';
      }

      requestAnimationFrame(
        positionTooltip
      );

      const onPointerDown =
        event => {
          if (
            !tooltip.contains(
              event.target
            )
          ) {
            closeTooltip();
          }
        };

      const onBlur = () => {
        closeTooltip();
      };

      const onVisibilityChange =
        () => {
          if (document.hidden) {
            closeTooltip();
          }
        };

      const abortController =
        new AbortController();

      document.addEventListener(
        'pointerdown',
        onPointerDown,
        true
      );

      window.addEventListener(
        'blur',
        onBlur,
        true
      );

      document.addEventListener(
        'visibilitychange',
        onVisibilityChange,
        true
      );

      state = {
        tooltip,
        abortController,
        onPointerDown,
        onBlur,
        onVisibilityChange,
      };

      tooltipState = state;

      const translated =
        await translatePlainText(
          selectionData.text,
          { signal: abortController.signal }
        );

      if (tooltipState !== state) return;

      if (!translated) {
        throw new Error('The translator returned no text.');
      }

      content.textContent =
        translated || '';

      requestAnimationFrame(() => {

        if (tooltipState !== state) return;

        positionTooltip();
      });

    } catch (err) {
      if (state && tooltipState !== state) {
        return;
      }

      if (state && tooltipState === state) {
        closeTooltip();
      }

      showErrorToast(err);
    }
  }

  /*
   * =========================================================
   * Settings Modal
   * =========================================================
   */

  function openModifierSettingsModal() {

    try {

      if (
        modifierModalOverlay?.isConnected
      ) {
        return;
      }

      const overlay =
        document.createElement('div');

      modifierModalOverlay =
        overlay;

      overlay.style.cssText = `
        position:fixed;
        inset:0;
        z-index:2147483647;
        background:rgba(0,0,0,.18);
        display:flex;
        align-items:center;
        justify-content:center;
      `;

      const modal =
        document.createElement('div');

      modal.style.cssText = `
        width:420px;
        background:#fff;
        border-radius:16px;
        padding:20px;
        box-shadow:0 20px 60px rgba(0,0,0,.25);
        font:14px/1.5 system-ui;
        box-sizing:border-box;
      `;

      const title =
        document.createElement('div');

      title.style.cssText = `
        font-size:18px;
        font-weight:700;
        margin-bottom:12px;
      `;

      title.textContent =
        'Modifier Key Settings';

      const desc =
        document.createElement('div');

      desc.style.cssText = `
        margin-bottom:12px;
        color:#666;
      `;

      desc.textContent =
        'Allowed: shift / control / command';

      const input =
        document.createElement('input');

      input.id =
        'tm-modifier-input';

      input.value =
        modifierKeys.join('+');

      input.style.cssText = `
        width:100%;
        padding:10px 12px;
        border-radius:10px;
        border:1px solid rgba(0,0,0,.12);
        box-sizing:border-box;
        font-size:14px;
      `;

      const actions =
        document.createElement('div');

      actions.style.cssText = `
        display:flex;
        justify-content:flex-end;
        margin-top:16px;
        gap:8px;
      `;

      const cancelBtn =
        document.createElement('button');

      cancelBtn.textContent =
        'Cancel';

      const saveBtn =
        document.createElement('button');

      saveBtn.textContent =
        'Save';

      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);

      modal.appendChild(title);
      modal.appendChild(desc);
      modal.appendChild(input);
      modal.appendChild(actions);

      overlay.appendChild(modal);

      document.documentElement.appendChild(
        overlay
      );

      const close = () => {

        modifierModalOverlay =
          null;

        overlay.remove();
      };

      overlay.addEventListener(
        'click',
        e => {
          if (e.target === overlay) {
            close();
          }
        }
      );

      cancelBtn.addEventListener(
        'click',
        close
      );

      saveBtn.addEventListener(
        'click',
        () => {

          try {

            const normalized =
              normalizeModifierKeys(
                input.value
              );

            saveModifierKeys(
              normalized
            );

            showToast(
              `Modifier updated: ${normalized.join('+')}`
            );

            close();

          } catch (err) {
            showErrorToast(err);
          }
        }
      );

    } catch (err) {
      showErrorToast(err);
    }
  }

  /*
   * =========================================================
   * Events
   * =========================================================
   */

  function handlePointerMove(event) {

    try {

      const paragraph =
        getParagraphFromPoint(event);

      setHoveredParagraph(
        paragraph &&
        isParagraphLike(paragraph)
          ? paragraph
          : null
      );

    } catch (err) {
      showErrorToast(err);
    }
  }

  async function handleKeyDown(event) {

    try {

      if (
        isEditableTarget(
          event.target
        )
      ) {
        return;
      }

      const isSettingsShortcut =
        event.code === 'Comma' &&
        (
          (
            event.ctrlKey &&
            event.shiftKey
          ) ||
          (
            event.metaKey &&
            event.shiftKey
          )
        );

      if (isSettingsShortcut) {

        event.preventDefault();
        event.stopPropagation();

        // toggle modal
        if (
          modifierModalOverlay?.isConnected
        ) {

          modifierModalOverlay.remove();
          modifierModalOverlay = null;

        } else {

          openModifierSettingsModal();
        }

        return;
      }

      if (!isModifierMatch(event)) {
        return;
      }

      if (event.repeat) {
        return;
      }

      const selectionData =
        getSelectedText();

      if (selectionData) {

        event.preventDefault();
        event.stopImmediatePropagation();

        await openSelectionTooltip(
          selectionData
        );

        return;
      }

      if (
        !hoveredParagraph ||
        !isParagraphLike(
          hoveredParagraph
        )
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      await toggleTranslation(
        hoveredParagraph
      );

    } catch (err) {
      showErrorToast(err);
    }
  }

  document.addEventListener(
    'pointermove',
    handlePointerMove,
    true
  );

  document.addEventListener(
    'keydown',
    handleKeyDown,
    true
  );

  console.log(
    `[TM Translator] Loaded. DEBUG=${DEBUG}`
  );
})();
