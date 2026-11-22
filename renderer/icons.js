(function () {
  'use strict';

  const S = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

  const PATHS = {
    // --- All 13 Codicons used in vendor/rcmdr/data/tree.json ---
    database: `<ellipse cx="8" cy="3.5" rx="5" ry="1.8" ${S}/><path d="M3 3.5v9c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-9" ${S}/><path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" ${S}/>`,
    edit: `<path d="M11.5 2.5l2 2L5.5 12.5 2.5 13.5l1-3z" ${S}/><path d="M9.8 4.2l2 2" ${S}/>`,
    eye: `<path d="M1.5 8s2.5-4.2 6.5-4.2S14.5 8 14.5 8s-2.5 4.2-6.5 4.2S1.5 8 1.5 8z" ${S}/><circle cx="8" cy="8" r="2" ${S}/>`,
    beaker: `<path d="M6 2h4M6.8 2v4L3 12.8c-.4.7.1 1.7.9 1.7h8.2c.8 0 1.3-1 .9-1.7L9.2 6V2" ${S}/><path d="M5 10.2h6" ${S}/>`,
    file: `<path d="M4 1.8h5.2L12.5 5v9.2H4z" ${S}/><path d="M9 1.8V5h3.5" ${S}/>`,
    'circle-filled': `<circle cx="8" cy="8" r="2.8" fill="currentColor"/>`,
    folder: `<path d="M1.8 3.5h4.2l1.4 1.5h6.8v7.8H1.8z" ${S}/>`,
    graph: `<path d="M2 13.5h12M3.5 13.5V8.5h2v5M7 13.5V4.5h2v9M10.5 13.5V6.5h2v7" ${S}/>`,
    'graph-line': `<path d="M2 2.5v11h12" ${S}/><path d="M3.5 11l3-3.5 2.5 2 4-5.5" ${S}/>`,
    pulse: `<path d="M1.5 8.5h2.8l1.6-4.5 2.4 8 1.9-5 1.3 1.5h3" ${S}/>`,
    book: `<path d="M2.5 2.8h4.2c.8 0 1.3.5 1.3 1.3v9.4c0-.6-.5-1-1.2-1H2.5zM13.5 2.8H9.3c-.8 0-1.3.5-1.3 1.3v9.4c0-.6.5-1 1.2-1h4.3z" ${S}/>`,
    tools: `<path d="M10.3 2.7a3 3 0 0 0-3.6 3.9L2.5 10.8a1.4 1.4 0 0 0 2 2l4.2-4.2a3 3 0 0 0 3.9-3.6l-1.7 1.7-1.7-1.7z" ${S}/>`,
    question: `<circle cx="8" cy="8" r="6" ${S}/><path d="M6.3 6.3a1.8 1.8 0 0 1 3.4.7c0 1.2-1.7 1.5-1.7 2.6" ${S}/><circle cx="8" cy="11.8" r="0.6" fill="currentColor"/>`,

    // --- IDE Activity Bar, Toolbar, Sidebar, Panel & Table Icons ---
    'r-logo': `<path d="M3.5 2.5h5c2.2 0 3.6 1.1 3.6 3 0 1.5-.9 2.5-2.3 2.9L12.5 13.5h-2.1L8 9H5.5v4.5h-2zm2 1.8v3h2.6c1.1 0 1.8-.6 1.8-1.5s-.7-1.5-1.8-1.5z" fill="currentColor"/>`,
    files: `<path d="M3 4.5h6.5v9.5H3z" ${S}/><path d="M5.5 4.5V2.2H12l1.5 1.5v8.1H9.5" ${S}/>`,
    play: `<polygon points="4.5,2.8 13,8 4.5,13.2" fill="currentColor"/>`,
    'play-all': `<polygon points="2.5,3.2 8.5,8 2.5,12.8" fill="currentColor"/><polygon points="8.5,3.2 14.5,8 8.5,12.8" fill="currentColor"/>`,
    stop: `<rect x="3.5" y="3.5" width="9" height="9" fill="currentColor"/>`,
    restart: `<path d="M13 8a5 5 0 1 1-1.5-3.5" ${S}/><polyline points="11.5,2 11.5,5 8.5,5" ${S}/>`,
    refresh: `<path d="M13 7.5a5 5 0 0 0-8.8-2.8M3 8.5a5 5 0 0 0 8.8 2.8" ${S}/><polyline points="13,3.5 13,6.8 9.8,6.8" ${S}/><polyline points="3,12.5 3,9.2 6.2,9.2" ${S}/>`,
    clear: `<path d="M2.5 4h11M4.5 4v8.5h7V4M6.2 2.2h3.6M6.5 6.8v3.8M9.5 6.8v3.8" ${S}/>`,
    search: `<circle cx="7" cy="7" r="4.5" ${S}/><path d="M10.4 10.4L14 14" ${S}/>`,
    'collapse-all': `<rect x="2.5" y="4.5" width="9" height="9" ${S}/><path d="M5 9h4M5.5 2.5h8v8" ${S}/>`,
    split: `<rect x="2" y="2.5" width="12" height="11" ${S}/><path d="M8 2.5v11" ${S}/>`,
    preview: `<path d="M1.5 8s2.5-4.2 6.5-4.2S14.5 8 14.5 8s-2.5 4.2-6.5 4.2S1.5 8 1.5 8z" ${S}/><circle cx="8" cy="8" r="2" ${S}/>`,
    knit: `<path d="M9.8 2.2l4 4-1.8 1.8-1.4-1.4-6.3 6.3a1.2 1.2 0 0 1-1.7-1.7l6.3-6.3-1.4-1.4z" ${S}/><path d="M6.2 3.2l2.4 2.4" ${S}/>`,
    hammer: `<path d="M9.8 2.2l4 4-1.8 1.8-1.4-1.4-6.3 6.3a1.2 1.2 0 0 1-1.7-1.7l6.3-6.3-1.4-1.4z" ${S}/><path d="M6.2 3.2l2.4 2.4" ${S}/>`,
    sidebar: `<rect x="2" y="2.5" width="12" height="11" ${S}/><rect x="2" y="2.5" width="4" height="11" fill="currentColor" fill-opacity="0.35"/>`,
    'sidebar-right': `<rect x="2" y="2.5" width="12" height="11" ${S}/><rect x="10" y="2.5" width="4" height="11" fill="currentColor" fill-opacity="0.35"/>`,
    'dock-left': `<rect x="2" y="2.5" width="12" height="11" ${S}/><path d="M6 2.5v11M11.5 8H8.2m1.5-1.8L7.9 8l1.8 1.8" ${S}/>`,
    'dock-right': `<rect x="2" y="2.5" width="12" height="11" ${S}/><path d="M10 2.5v11M4.5 8h3.3M6.3 6.2L8.1 8 6.3 9.8" ${S}/>`,
    'orient-h': `<rect x="2" y="2.5" width="12" height="11" ${S}/><path d="M2 6h12" ${S}/>`,
    'orient-v': `<rect x="2" y="2.5" width="12" height="11" ${S}/><path d="M6 2.5v11" ${S}/>`,
    terminal: `<rect x="2" y="2.5" width="12" height="11" ${S}/><polyline points="4.5,6.2 7,8.2 4.5,10.2" ${S}/><path d="M8.5 10.2h3" ${S}/>`,
    'list-summary': `<path d="M3 4h10M3 8h7M3 12h9" ${S}/>`,
    history: `<circle cx="8" cy="8" r="5.5" ${S}/><polyline points="8,4.8 8,8 10.5,9.6" ${S}/>`,
    'word-wrap': `<path d="M2.5 4h11M2.5 8h8.5a2 2 0 0 1 0 4H7.5M2.5 12h2.5" ${S}/><polyline points="9,10.5 7.2,12 9,13.5" ${S}/>`,
    truncate: `<path d="M2.5 4h11M2.5 7.5h7M2.5 11h11" ${S}/><circle cx="11.5" cy="7.5" r="0.8" fill="currentColor"/><circle cx="13.5" cy="7.5" r="0.8" fill="currentColor"/>`,
    'panel-bottom': `<rect x="2" y="2.5" width="12" height="11" ${S}/><rect x="2" y="9.5" width="12" height="4" fill="currentColor" fill-opacity="0.35"/>`,
    'panel-right': `<rect x="2" y="2.5" width="12" height="11" ${S}/><rect x="10" y="2.5" width="4" height="11" fill="currentColor" fill-opacity="0.35"/>`,
    settings: `<circle cx="8" cy="8" r="2.4" ${S}/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" ${S}/>`,
    close: `<path d="M4 4l8 8M12 4l-8 8" ${S}/>`,
    plus: `<path d="M8 3v10M3 8h10" ${S}/>`,
    'chevron-right': `<polyline points="6,3.5 10.5,8 6,12.5" ${S}/>`,
    'chevron-down': `<polyline points="3.5,6 8,10.5 12.5,6" ${S}/>`,
    'chevron-left': `<polyline points="10,3.5 5.5,8 10,12.5" ${S}/>`,
    'chevrons-left': `<polyline points="8.5,4 4.5,8 8.5,12" ${S}/><polyline points="12.5,4 8.5,8 12.5,12" ${S}/>`,
    'chevrons-right': `<polyline points="3.5,4 7.5,8 3.5,12" ${S}/><polyline points="7.5,4 11.5,8 7.5,12" ${S}/>`,
    'folder-open': `<path d="M1.8 4h4l1.3 1.4h6.4v1.8H3.8l-2 5.6z" ${S}/><path d="M3.8 7.2h10.4l-1.7 5.6H2z" ${S}/>`,
    'new-file': `<path d="M4 2h5l3 3v9H4z" ${S}/><path d="M8 7v4M6 9h4" ${S}/>`,
    'new-folder': `<path d="M1.8 3.5h4.2l1.4 1.5h6.8v7.8H1.8z" ${S}/><path d="M8 7.2v3.6M6.2 9h3.6" ${S}/>`,
    save: `<path d="M3 2.5h8.2L13 4.3V13.5H3z" ${S}/><rect x="5" y="2.5" width="5" height="3.5" ${S}/><rect x="5" y="9" width="6" height="4.5" ${S}/>`,
    table: `<rect x="2" y="2.5" width="12" height="11" ${S}/><path d="M2 6h12M2 9.5h12M6.2 6v7.5M10.2 6v7.5" ${S}/>`,
    copy: `<rect x="5.5" y="5" width="8" height="9" ${S}/><path d="M10.5 5V2.5h-8v9H5.5" ${S}/>`,
    download: `<path d="M8 2.5v7.8M5 7.5l3 3 3-3M2.5 13h11" ${S}/>`,
    upload: `<path d="M8 10.5V2.7M5 5.5l3-3 3 3M2.5 13h11" ${S}/>`,
    'zoom-in': `<circle cx="7" cy="7" r="4.5" ${S}/><path d="M10.4 10.4L14 14M7 5v4M5 7h4" ${S}/>`,
    'zoom-out': `<circle cx="7" cy="7" r="4.5" ${S}/><path d="M10.4 10.4L14 14M5 7h4" ${S}/>`,
    'zoom-reset': `<rect x="2.5" y="2.5" width="11" height="11" ${S}/><path d="M5.5 8h5" ${S}/>`,
    error: `<circle cx="8" cy="8" r="6" ${S}/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" ${S}/>`,
    warning: `<path d="M8 2.2L14 13H2z" ${S}/><path d="M8 6.2v3.3" ${S}/><circle cx="8" cy="11.3" r="0.6" fill="currentColor"/>`,
    check: `<polyline points="3,8.2 6.5,11.8 13.2,4.5" ${S}/>`,
    sigma: `<path d="M12 3H4.2l4.6 5-4.6 5H12" ${S}/>`,
    'add-row': `<rect x="2" y="2.5" width="12" height="7" ${S}/><path d="M2 6h12M8 11v3.5M6.2 12.8h3.6" ${S}/>`,
    'add-col': `<rect x="2" y="2.5" width="7" height="11" ${S}/><path d="M5.5 2.5v11M12.5 6.2v3.6M10.7 8h3.6" ${S}/>`,
    group: `<rect x="2" y="2.5" width="5" height="4.5" ${S}/><rect x="9" y="2.5" width="5" height="4.5" ${S}/><rect x="2" y="9" width="12" height="4.5" ${S}/>`,
    'prompt-arrow': `<polyline points="5,3.5 11,8 5,12.5" ${S}/>`,
    sun: `<circle cx="8" cy="8" r="3" ${S}/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" ${S}/>`,
    moon: `<path d="M12.5 9.8A5.2 5.2 0 0 1 6.2 3.5a5.5 5.5 0 1 0 6.3 6.3z" ${S}/>`,
    markdown: `<rect x="1.8" y="3.5" width="12.4" height="9" ${S}/><path d="M4 10.2V5.8l2 2.2 2-2.2v4.4M11 5.8v4.2m-1.5-1.6l1.5 1.7 1.5-1.7" ${S}/>`
  };

  function svg(name, { size = 16, cls = '', color = '' } = {}) {
    const inner = PATHS[name] || PATHS['circle-filled'];
    const style = color ? ` style="color:${color}"` : '';
    return `<svg class="codicon${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"${style}>${inner}</svg>`;
  }

  // Exact VS Code Dracula chart/ANSI color mapping for data/tree.json
  function rcmdrColor(token = '') {
    switch (token) {
      case 'charts.green':
      case 'terminal.ansiGreen':
        return 'var(--chart-green)';
      case 'charts.red':
      case 'terminal.ansiRed':
        return 'var(--chart-red)';
      case 'charts.blue':
      case 'terminal.ansiBlue':
        return 'var(--chart-blue)';
      case 'charts.yellow':
      case 'terminal.ansiYellow':
        return 'var(--chart-yellow)';
      case 'charts.purple':
      case 'terminal.ansiMagenta':
        return 'var(--chart-purple)';
      case 'charts.orange':
        return 'var(--chart-orange)';
      case 'terminal.ansiCyan':
        return 'var(--chart-cyan)';
      default:
        return 'var(--fg-muted)';
    }
  }

  window.StudioIcons = { svg, rcmdrColor, PATHS };
})();
