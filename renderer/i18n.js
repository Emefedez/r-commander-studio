(function () {
  'use strict';

  const dict = window.STUDIO_I18N_DICT || { en: {}, es: {} };
  let currentLang = localStorage.getItem('rcs-lang') === 'en' ? 'en' : 'es';

  function getLang() {
    return currentLang;
  }

  function setLang(lang) {
    currentLang = lang === 'en' ? 'en' : 'es';
    localStorage.setItem('rcs-lang', currentLang);
    document.documentElement.lang = currentLang;
    applyToDom();
    return currentLang;
  }

  function t(key, ...args) {
    const table = dict[currentLang] || dict.en;
    const raw = table[key] ?? dict.en[key] ?? key;
    return String(raw).replace(/\{(\d+)\}/g, (match, i) => (args[i] !== undefined ? String(args[i]) : match));
  }

  function applyToDom(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.getAttribute('data-i18n'));
    }
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    }
    for (const el of root.querySelectorAll('[data-i18n-title]')) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    }
  }

  window.StudioI18n = { t, getLang, setLang, applyToDom };
})();
