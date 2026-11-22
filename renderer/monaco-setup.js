(function () {
  'use strict';

  const R_KEYWORDS = [
    'if', 'else', 'repeat', 'while', 'function', 'for', 'in', 'next', 'break',
    'return', 'library', 'require', 'source', 'local'
  ];

  const R_CONSTANTS = [
    'TRUE', 'FALSE', 'NULL', 'NA', 'NA_integer_', 'NA_real_', 'NA_complex_',
    'NA_character_', 'NaN', 'Inf', 'T', 'F', 'pi', 'LETTERS', 'letters'
  ];

  function registerRmdLanguage(monaco) {
    monaco.languages.register({
      id: 'rmd',
      extensions: ['.Rmd', '.rmd', '.qmd'],
      aliases: ['R Markdown', 'rmd', 'Quarto']
    });

    monaco.languages.setLanguageConfiguration('rmd', {
      comments: { lineComment: '#' },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
        { open: '`', close: '`' }
      ]
    });

    // Custom Monarch tokenizer: YAML frontmatter + Markdown prose + fenced ```{r ...}``` blocks with full R highlighting
    monaco.languages.setMonarchTokensProvider('rmd', {
      defaultToken: '',
      tokenPostfix: '.rmd',
      rKeywords: R_KEYWORDS,
      rConstants: R_CONSTANTS,
      rOperators: ['<-', '<<-', '->', '->>', '|>', '%>%', '%in%', ':::', '::', '==', '!=', '<=', '>=', '&&', '||', '~', '$', '@', '^', '+', '-', '*', '/', '=', '<', '>', '&', '|', '!'],

      tokenizer: {
        root: [
          [/^---\s*$/, { token: 'meta.frontmatter', next: '@frontmatter' }],
          { include: '@markdown' }
        ],

        frontmatter: [
          [/^(?:---|\.\.\.)\s*$/, { token: 'meta.frontmatter', next: '@markdown' }],
          [/#.*$/, 'comment'],
          [/^([A-Za-z0-9_.-]+)(\s*:)/, ['attribute.name', 'delimiter']],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/\b(?:true|false|null|yes|no)\b/i, 'constant'],
          [/\b\d+(?:\.\d+)?\b/, 'number']
        ],

        markdown: [
          [/^(\s*```+\s*)(\{[ \t]*[rR]\b[^}]*\})(\s*)$/, ['keyword.fence', 'tag.chunk', ''], '@rchunk'],
          [/^(\s*```+\s*)([A-Za-z0-9_{}.=-]*)\s*$/, ['keyword.fence', 'tag.chunk'], '@codeblock'],
          [/^\s*#{1,6}\s.*$/, 'keyword.heading'],
          [/^\s*(?:[-*_]\s*){3,}$/, 'meta.separator'],
          [/^\s*>+.*$/, 'comment.quote'],
          [/^\s*(?:[*+-]|\d+\.)\s+/, 'keyword.list'],
          [/\$\$[\s\S]*?\$\$/, 'string.math'],
          [/\$[^$\n]+\$/, 'string.math'],
          [/`r\s+[^`]+`/, 'variable.predefined'],
          [/`[^`]+`/, 'string.code'],
          [/!?\[[^\]]+\]\([^)]+\)/, 'string.link'],
          [/\*\*[^*]+\*\*/, 'strong'],
          [/__[^_]+__/, 'strong'],
          [/\*[^*\n]+\*/, 'emphasis'],
          [/_[^_\n]+_/, 'emphasis']
        ],

        codeblock: [
          [/^\s*```+\s*$/, 'keyword.fence', '@pop'],
          [/.*$/, 'string.code']
        ],

        rchunk: [
          [/^\s*```+\s*$/, 'keyword.fence', '@pop'],
          [/#.*$/, 'comment'],
          [/[rR]"-*\([^)]*\)-*"/, 'string'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/`[^`]+`/, 'variable'],
          [/\b0[xX][0-9a-fA-F]+L?\b/, 'number.hex'],
          [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[iL]?\b/, 'number'],
          [/%[^%\s]+%/, 'operator.special'],
          [/<<-|<-|->>|->|\|>|:::|::|==|!=|<=|>=|&&|\|\|/, 'operator'],
          [/([A-Za-z.][A-Za-z0-9._]*)(?=\s*\()/, {
            cases: {
              '@rKeywords': 'keyword',
              '@default': 'entity.name.function'
            }
          }],
          [/[A-Za-z.][A-Za-z0-9._]*/, {
            cases: {
              '@rKeywords': 'keyword',
              '@rConstants': 'constant',
              '@default': 'identifier'
            }
          }],
          [/[{}()[\]]/, '@brackets'],
          [/[~=$@^+\-*/<>!&|,;:]/, 'operator']
        ]
      }
    });
  }

  function defineStudioThemes(monaco) {
    // Exact VS Code Dracula Theme (from dracula-theme.theme-dracula dracula.json)
    monaco.editor.defineTheme('dracula', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '', foreground: 'F8F8F2', background: '282A36' },
        { token: 'comment', foreground: '6272A4', fontStyle: 'italic' },
        { token: 'comment.quote', foreground: '6272A4', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'FF79C6' },
        { token: 'keyword.heading', foreground: 'BD93F9', fontStyle: 'bold' },
        { token: 'keyword.fence', foreground: '6272A4' },
        { token: 'keyword.list', foreground: '8BE9FD' },
        { token: 'tag', foreground: 'FF79C6' },
        { token: 'tag.chunk', foreground: '50FA7B' },
        { token: 'meta.frontmatter', foreground: 'BD93F9' },
        { token: 'attribute.name', foreground: '50FA7B' },
        { token: 'entity.name.function', foreground: '50FA7B' },
        { token: 'identifier', foreground: 'F8F8F2' },
        { token: 'type', foreground: '8BE9FD', fontStyle: 'italic' },
        { token: 'constant', foreground: 'BD93F9' },
        { token: 'number', foreground: 'BD93F9' },
        { token: 'number.hex', foreground: 'BD93F9' },
        { token: 'string', foreground: 'F1FA8C' },
        { token: 'string.code', foreground: '50FA7B' },
        { token: 'string.link', foreground: '8BE9FD', fontStyle: 'underline' },
        { token: 'string.math', foreground: 'FFB86C' },
        { token: 'variable', foreground: 'F8F8F2' },
        { token: 'variable.predefined', foreground: 'FFB86C', fontStyle: 'italic' },
        { token: 'operator', foreground: 'FF79C6' },
        { token: 'operator.special', foreground: 'FF79C6' },
        { token: 'delimiter', foreground: 'F8F8F2' },
        { token: 'strong', foreground: 'FFB86C', fontStyle: 'bold' },
        { token: 'emphasis', foreground: 'F1FA8C', fontStyle: 'italic' }
      ],
      colors: {
        'editor.background': '#282A36',
        'editor.foreground': '#F8F8F2',
        'editorLineNumber.foreground': '#6272A4',
        'editorLineNumber.activeForeground': '#F8F8F2',
        'editor.lineHighlightBackground': '#44475A55',
        'editor.lineHighlightBorder': '#44475A',
        'editor.selectionBackground': '#44475A',
        'editor.selectionHighlightBackground': '#424450',
        'editorCursor.foreground': '#F8F8F2',
        'editorWidget.background': '#21222C',
        'editorWidget.border': '#44475A',
        'editorSuggestWidget.background': '#21222C',
        'editorSuggestWidget.foreground': '#F8F8F2',
        'editorSuggestWidget.selectedBackground': '#44475A',
        'editorHoverWidget.background': '#282A36',
        'editorHoverWidget.border': '#6272A4',
        'editorGutter.background': '#282A36',
        'editorIndentGuide.background1': '#FFFFFF1A',
        'editorIndentGuide.activeBackground1': '#FFFFFF45',
        'editorError.foreground': '#FF5555',
        'editorWarning.foreground': '#FFB86C'
      }
    });

    // Clean VS Code Light+ Theme
    monaco.editor.defineTheme('vscode-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '008000', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'AF00DB' },
        { token: 'keyword.heading', foreground: '0000FF', fontStyle: 'bold' },
        { token: 'tag.chunk', foreground: '267F99', fontStyle: 'bold' },
        { token: 'entity.name.function', foreground: '795E26' },
        { token: 'constant', foreground: '0000FF' },
        { token: 'number', foreground: '098658' },
        { token: 'string', foreground: 'A31515' },
        { token: 'operator', foreground: '000000' }
      ],
      colors: {
        'editor.background': '#FFFFFF',
        'editor.foreground': '#1E1E1E',
        'editorLineNumber.foreground': '#6E7681',
        'editorLineNumber.activeForeground': '#0B216F',
        'editor.lineHighlightBackground': '#F3F3F3',
        'editor.selectionBackground': '#ADD6FF',
        'editorCursor.foreground': '#000000',
        'editorWidget.background': '#F3F3F3',
        'editorWidget.border': '#C8C8C8',
        'editorError.foreground': '#E51400',
        'editorWarning.foreground': '#BF8803'
      }
    });
  }

  function parseCallAtPosition(model, position) {
    const lineText = model.getLineContent(position.lineNumber);
    const before = lineText.slice(0, position.column - 1);
    let depth = 0;
    let commas = 0;
    let openIdx = -1;
    for (let i = before.length - 1; i >= 0; i--) {
      const ch = before[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) {
          openIdx = i;
          break;
        }
        depth--;
      } else if (ch === ',' && depth === 0) {
        commas++;
      }
    }
    if (openIdx <= 0) return null;
    const prefix = before.slice(0, openIdx).trimEnd();
    const m = prefix.match(/(?:([A-Za-z][A-Za-z0-9.]*):::?)?([A-Za-z.][A-Za-z0-9._]*)$/);
    if (!m) return null;
    return { pkg: m[1] || '', fn: m[2], activeParameter: commas };
  }

  function wireLspProviders(monaco, getUriForModel, callbacks = {}) {
    // Register clickable commands usable inside trusted Monaco hover MarkdownStrings
    monaco.editor.registerCommand('studio.openRcmdr', (_accessor, id) => {
      if (id && callbacks.onOpenRcmdr) callbacks.onOpenRcmdr(id);
    });
    monaco.editor.registerCommand('studio.openRDocs', (_accessor, topic) => {
      if (topic && callbacks.onOpenRDocs) callbacks.onOpenRDocs(topic);
    });

    for (const lang of ['r', 'rmd']) {
      monaco.languages.registerHoverProvider(lang, {
        async provideHover(model, position) {
          const uri = getUriForModel(model);
          const contents = [];

          const lineText = model.getLineContent(position.lineNumber);
          const word = model.getWordAtPosition(position);
          let fnName = '';
          let pkgName = '';

          if (word) {
            const beforeWord = lineText.slice(0, word.startColumn - 1);
            const pkgMatch = beforeWord.match(/([A-Za-z][A-Za-z0-9.]*):::?$/);
            if (pkgMatch) pkgName = pkgMatch[1];
            fnName = word.word;
          }

          const afterWord = word ? lineText.slice(word.endColumn - 1) : '';
          const isCall = Boolean(word && /^\s*\(/.test(afterWord));
          const t = window.StudioI18n?.t || ((k) => k);

          // 1. R Commander MenuHover (clickable menu paths -> opens dialog!)
          if (isCall && fnName && window.studio?.rcmdrMenuHover) {
            try {
              const uiLang = window.StudioI18n?.getLang() || 'es';
              const menuInfo = await window.studio.rcmdrMenuHover({ fnName, lang: uiLang });
              if (menuInfo && menuInfo.entries?.length) {
                const lines = [t('hoverRcmdrHeader', menuInfo.fn), ''];
                for (const e of menuInfo.entries) {
                  const args = encodeURIComponent(JSON.stringify([e.id]));
                  lines.push(`- [${e.path}](command:studio.openRcmdr?${args})`);
                }
                if (menuInfo.total > menuInfo.entries.length) {
                  lines.push('', t('hoverMore', menuInfo.total - menuInfo.entries.length));
                }
                contents.push({ value: lines.join('\n'), isTrusted: true });
              }
            } catch {
              // ignore
            }
          }

          // 2. Built-in R Function Usage & Documentation Hover (always works, fast cached)
          let hadStructuredHelp = false;
          if (fnName && window.studio?.rFnHelp && (isCall || pkgName)) {
            try {
              const help = await window.studio.rFnHelp({ fnName, pkg: pkgName });
              if (help && help.ok) {
                hadStructuredHelp = true;
                const topic = help.package ? `${help.package}::${help.fn}` : help.fn;
                const docArgs = encodeURIComponent(JSON.stringify([topic]));
                const parts = [];
                if (help.title) {
                  parts.push(`**${help.fn}** ${help.package ? `(\`${help.package}\`)` : ''} — ${help.title}`);
                }
                if (help.usage) {
                  const shortUsage = help.usage.split('\n').slice(0, 6).join('\n');
                  parts.push('```r\n' + shortUsage + '\n```');
                }
                if (help.description) {
                  const shortDesc = help.description.length > 360 ? help.description.slice(0, 360) + '...' : help.description;
                  parts.push(shortDesc);
                }
                if (help.arguments) {
                  const shortArgs = help.arguments.split('\n').slice(0, 6).join('\n');
                  parts.push('**Arguments:**\n' + shortArgs);
                }
                if (help.examples) {
                  parts.push('**Examples:**\n```r\n' + help.examples + '\n```');
                }
                parts.push(`[${t('hoverOpenDocs', topic)}](command:studio.openRDocs?${docArgs})`);
                contents.push({ value: parts.join('\n\n'), isTrusted: true });
              }
            } catch {
              // ignore
            }
          }

          // 3. R languageserver LSP hover (if available and not redundant)
          if (!hadStructuredHelp && uri && window.studio?.lspHover) {
            const res = await window.studio.lspHover({
              uri,
              line: position.lineNumber,
              character: position.column
            });
            if (res && res.markdown) {
              const topic = pkgName ? `${pkgName}::${fnName}` : fnName;
              const docArgs = encodeURIComponent(JSON.stringify([topic]));
              const link = fnName ? `\n\n[${t('hoverOpenDocs', topic)}](command:studio.openRDocs?${docArgs})` : '';
              contents.push({ value: res.markdown + link, isTrusted: true });
            }
          }

          if (!contents.length) return null;
          return { contents };
        }
      });

      // Signature Help on '(' and ','
      monaco.languages.registerSignatureHelpProvider(lang, {
        signatureHelpTriggerCharacters: ['(', ','],
        async provideSignatureHelp(model, position) {
          const call = parseCallAtPosition(model, position);
          if (!call || !window.studio?.rFnHelp) return null;
          const help = await window.studio.rFnHelp({ fnName: call.fn, pkg: call.pkg });
          if (!help || !help.ok || !help.usage) return null;
          const sigLabel = help.usage.split('\n')[0];
          const params = (help.params || []).map((p) => ({ label: p }));
          return {
            value: {
              signatures: [
                {
                  label: sigLabel,
                  documentation: help.description ? help.description.slice(0, 260) : help.title || '',
                  parameters: params
                }
              ],
              activeSignature: 0,
              activeParameter: Math.min(call.activeParameter, Math.max(0, params.length - 1))
            },
            dispose() {}
          };
        }
      });

      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: ['.', '$', ':', '(', '@'],
        async provideCompletionItems(model, position) {
          const uri = getUriForModel(model);
          if (!uri || !window.studio?.lspCompletion) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          };
          const items = await window.studio.lspCompletion({
            uri,
            line: position.lineNumber,
            character: position.column
          });
          return {
            suggestions: (items || []).map((item) => ({
              label: item.label,
              kind: item.kind || monaco.languages.CompletionItemKind.Function,
              detail: item.detail || '',
              documentation: item.documentation ? { value: item.documentation } : undefined,
              insertText: item.insertText || item.label,
              range
            }))
          };
        }
      });
    }
  }

  function loadMonaco(monacoVsUrl, getUriForModel, callbacks = {}) {
    return new Promise((resolve, reject) => {
      const vsPath = monacoVsUrl || '../node_modules/monaco-editor/min/vs';
      window.MonacoEnvironment = {
        getWorkerUrl() {
          const base = vsPath.replace(/\/$/, '');
          const script = `self.MonacoEnvironment = { baseUrl: ${JSON.stringify(base + '/')} }; importScripts(${JSON.stringify(base + '/base/worker/workerMain.js')});`;
          return `data:text/javascript;charset=utf-8,${encodeURIComponent(script)}`;
        }
      };
      window.require.config({ paths: { vs: vsPath } });
      window.require(
        ['vs/editor/editor.main'],
        (monaco) => {
          registerRmdLanguage(monaco);
          defineStudioThemes(monaco);
          wireLspProviders(monaco, getUriForModel, callbacks);
          resolve(monaco);
        },
        reject
      );
    });
  }

  window.StudioMonaco = { loadMonaco };
})();
