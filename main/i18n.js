'use strict';

const dict = require('../shared/i18n-dict');

let currentLang = 'es';

function setLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'es';
  return currentLang;
}

function getLang() {
  return currentLang;
}

function t(key, ...args) {
  const table = dict[currentLang] || dict.en;
  const raw = table[key] ?? dict.en[key] ?? key;
  return String(raw).replace(/\{(\d+)\}/g, (match, i) => (args[i] !== undefined ? String(args[i]) : match));
}

module.exports = { dict, setLang, getLang, t };
