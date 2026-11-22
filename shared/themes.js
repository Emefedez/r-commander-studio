(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.StudioThemes = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const THEME_TOKEN_KEYS = [
    { key: 'bgEditor', css: '--bg-editor', labelEn: 'Editor Background', labelEs: 'Fondo del editor' },
    { key: 'bgSidebar', css: '--bg-sidebar', labelEn: 'Sidebar Background', labelEs: 'Fondo de barra lateral' },
    { key: 'bgChrome', css: '--bg-chrome', labelEn: 'Title / Status Bar', labelEs: 'Barra superior / estado' },
    { key: 'bgActivity', css: '--bg-activity', labelEn: 'Activity Bar', labelEs: 'Barra de actividad' },
    { key: 'fg', css: '--fg', labelEn: 'Primary Text', labelEs: 'Texto principal' },
    { key: 'fgMuted', css: '--fg-muted', labelEn: 'Muted Text', labelEs: 'Texto secundario' },
    { key: 'accent', css: '--accent-purple', labelEn: 'Accent', labelEs: 'Acento' },
    { key: 'border', css: '--border-field', labelEn: 'Border', labelEs: 'Borde' },
    { key: 'selection', css: '--bg-selection', labelEn: 'Selection', labelEs: 'Selección' },
    { key: 'tabHighlight', css: '--accent-pink', labelEn: 'Active Tab Highlight', labelEs: 'Resaltado de pestaña activa' }
  ];

  const PRESETS = {
    dracula: {
      id: 'dracula',
      name: 'Dracula',
      isLight: false,
      tokens: {
        bgEditor: '#282A36',
        bgSidebar: '#21222C',
        bgChrome: '#191A21',
        bgActivity: '#343746',
        fg: '#F8F8F2',
        fgMuted: '#6272A4',
        accent: '#BD93F9',
        border: '#44475A',
        selection: '#44475A',
        tabHighlight: '#FF79C6'
      },
      syntax: {
        comment: '6272A4',
        keyword: 'FF79C6',
        fn: '50FA7B',
        string: 'F1FA8C',
        number: 'BD93F9',
        type: '8BE9FD',
        operator: 'FF79C6',
        error: '#FF5555',
        warn: '#FFB86C'
      }
    },
    'vscode-dark': {
      id: 'vscode-dark',
      name: 'VS Code Dark+',
      isLight: false,
      tokens: {
        bgEditor: '#1E1E1E',
        bgSidebar: '#252526',
        bgChrome: '#181818',
        bgActivity: '#333333',
        fg: '#D4D4D4',
        fgMuted: '#858585',
        accent: '#007ACC',
        border: '#3C3C3C',
        selection: '#264F78',
        tabHighlight: '#007ACC'
      },
      syntax: {
        comment: '6A9955',
        keyword: '569CD6',
        fn: 'DCDCAA',
        string: 'CE9178',
        number: 'B5CEA8',
        type: '4EC9B0',
        operator: 'D4D4D4',
        error: '#F14C4C',
        warn: '#CCA700'
      }
    },
    'one-dark': {
      id: 'one-dark',
      name: 'One Dark Pro',
      isLight: false,
      tokens: {
        bgEditor: '#282C34',
        bgSidebar: '#21252B',
        bgChrome: '#181A1F',
        bgActivity: '#2C313A',
        fg: '#ABB2BF',
        fgMuted: '#5C6370',
        accent: '#61AFEF',
        border: '#3E4451',
        selection: '#3E4451',
        tabHighlight: '#528BFF'
      },
      syntax: {
        comment: '5C6370',
        keyword: 'C678DD',
        fn: '61AFEF',
        string: '98C379',
        number: 'D19A66',
        type: 'E5C07B',
        operator: '56B6C2',
        error: '#E06C75',
        warn: '#E5C07B'
      }
    },
    nord: {
      id: 'nord',
      name: 'Nord',
      isLight: false,
      tokens: {
        bgEditor: '#2E3440',
        bgSidebar: '#272C36',
        bgChrome: '#222630',
        bgActivity: '#3B4252',
        fg: '#D8DEE9',
        fgMuted: '#616E88',
        accent: '#88C0D0',
        border: '#434C5E',
        selection: '#434C5E',
        tabHighlight: '#88C0D0'
      },
      syntax: {
        comment: '616E88',
        keyword: '81A1C1',
        fn: '88C0D0',
        string: 'A3BE8C',
        number: 'B48EAD',
        type: '8FBCBB',
        operator: '81A1C1',
        error: '#BF616A',
        warn: '#EBCB8B'
      }
    },
    'tokyo-night': {
      id: 'tokyo-night',
      name: 'Tokyo Night',
      isLight: false,
      tokens: {
        bgEditor: '#1A1B26',
        bgSidebar: '#16161E',
        bgChrome: '#13131A',
        bgActivity: '#24283B',
        fg: '#C0CAF5',
        fgMuted: '#565F89',
        accent: '#7AA2F7',
        border: '#2F3549',
        selection: '#33467C',
        tabHighlight: '#BB9AF7'
      },
      syntax: {
        comment: '565F89',
        keyword: 'BB9AF7',
        fn: '7AA2F7',
        string: '9ECE6A',
        number: 'FF9E64',
        type: '2AC3DE',
        operator: '89DDFF',
        error: '#F7768E',
        warn: '#E0AF68'
      }
    },
    'vscode-light': {
      id: 'vscode-light',
      name: 'VS Code Light+',
      isLight: true,
      tokens: {
        bgEditor: '#FFFFFF',
        bgSidebar: '#F3F3F3',
        bgChrome: '#E8E8E8',
        bgActivity: '#E0E0E0',
        fg: '#1E1E1E',
        fgMuted: '#6E7681',
        accent: '#007ACC',
        border: '#CCCCCC',
        selection: '#ADD6FF',
        tabHighlight: '#007ACC'
      },
      syntax: {
        comment: '008000',
        keyword: 'AF00DB',
        fn: '795E26',
        string: 'A31515',
        number: '098658',
        type: '267F99',
        operator: '000000',
        error: '#E51400',
        warn: '#BF8803'
      }
    },
    'notecomplete-light': {
      id: 'notecomplete-light',
      name: 'NoteComplete Light',
      isLight: true,
      tokens: {
        bgEditor: '#FFFFFF',
        bgSidebar: '#F7F8FA',
        bgChrome: '#EEF0F3',
        bgActivity: '#E9ECF0',
        fg: '#242830',
        fgMuted: '#626B76',
        accent: '#245DC4',
        border: '#DCE0E5',
        selection: '#DBE5F8',
        tabHighlight: '#245DC4'
      },
      syntax: {
        comment: '626B76',
        keyword: '245DC4',
        fn: '1D5B9C',
        string: 'B83228',
        number: '1D7A4A',
        type: '7A42C4',
        operator: '9A6200',
        error: '#B83228',
        warn: '#9A6200'
      }
    },
    'solarized-light': {
      id: 'solarized-light',
      name: 'Solarized Light',
      isLight: true,
      tokens: {
        bgEditor: '#FDF6E3',
        bgSidebar: '#EEE8D5',
        bgChrome: '#E4DEC9',
        bgActivity: '#DDD6C1',
        fg: '#586E75',
        fgMuted: '#93A1A1',
        accent: '#268BD2',
        border: '#D3CCB6',
        selection: '#D5E2EA',
        tabHighlight: '#268BD2'
      },
      syntax: {
        comment: '93A1A1',
        keyword: '859900',
        fn: '268BD2',
        string: '2AA198',
        number: 'D33682',
        type: 'B58900',
        operator: 'CB4B16',
        error: '#DC322F',
        warn: '#B58900'
      }
    }
  };

  function getPreset(id) {
    return PRESETS[id] || PRESETS.dracula;
  }

  function listPresets() {
    return Object.values(PRESETS);
  }

  function resolveTheme(presetId, overrides = {}) {
    const base = getPreset(presetId);
    const tokens = { ...base.tokens };
    if (overrides && typeof overrides === 'object') {
      for (const def of THEME_TOKEN_KEYS) {
        if (typeof overrides[def.key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(overrides[def.key])) {
          tokens[def.key] = overrides[def.key];
        }
      }
    }
    return {
      ...base,
      tokens
    };
  }

  return { THEME_TOKEN_KEYS, PRESETS, getPreset, listPresets, resolveTheme };
});
