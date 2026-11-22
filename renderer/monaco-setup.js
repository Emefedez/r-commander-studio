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
          // YAML frontmatter at start of document
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
          // Fenced R code chunk: ```{r ...}
          [/^(\s*```+\s*)(\{[ \t]*[rR]\b[^}]*\})(\s*)$/, ['keyword.fence', 'tag.chunk', '', ], '@rchunk'],
          // Generic fenced code block
          [/^(\s*```+\s*)([A-Za-z0-9_{}.=-]*)\s*$/, ['keyword.fence', 'tag.chunk'], '@codeblock'],

          // Headings
          [/^\s*#{1,6}\s.*$/, 'keyword.heading'],

          // Horizontal rules
          [/^\s*(?:[-*_]\s*){3,}$/, 'meta.separator'],

          // Blockquotes
          [/^\s*>+.*$/, 'comment.quote'],

          // List markers
          [/^\s*(?:[*+-]|\d+\.)\s+/, 'keyword.list'],

          // Display & inline math
          [/\$\$[\s\S]*?\$\$/, 'string.math'],
          [/\$[^$\n]+\$/, 'string.math'],

          // Inline R expression `r ...`
          [/`r\s+[^`]+`/, 'variable.predefined'],
          // Inline code
          [/`[^`]+`/, 'string.code'],

          // Markdown links & images
          [/!?\[[^\]]+\]\([^)]+\)/, 'string.link'],

          // Bold / Italic
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
          // R comments
          [/#.*$/, 'comment'],
          // Raw R strings r"(...)"
          [/[rR]"-*\([^)]*\)-*"/, 'string'],
          // Double & single quoted strings
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          // Backtick-quoted identifiers
          [/`[^`]+`/, 'variable'],
          // Numbers (hex, float, scientific, integer suffix L)
          [/\b0[xX][0-9a-fA-F]+L?\b/, 'number.hex'],
          [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[iL]?\b/, 'number'],
          // Special infix operators %...%
          [/%[^%\s]+%/, 'operator.special'],
          // Multi-char R operators
          [/<<-|<-|->>|->|\|>|:::|::|==|!=|<=|>=|&&|\|\|/, 'operator'],
          // Function calls: foo(
          [/([A-Za-z.][A-Za-z0-9._]*)(?=\s*\()/, {
            cases: {
              '@rKeywords': 'keyword',
              '@default': 'entity.name.function'
            }
          }],
          // Identifiers, keywords, constants
          [/[A-Za-z.][A-Za-z0-9._]*/, {
            cases: {
              '@rKeywords': 'keyword',
              '@rConstants': 'constant',
              '@default': 'identifier'
            }
          }],
          // Delimiters & single-char operators
          [/[{}()[\]]/, '@brackets'],
          [/[~=$@^+\-*/<>!&|,;:]/, 'operator']
        ]
      }
    });
  }

  function defineNoteCompleteThemes(monaco) {
    monaco.editor.defineTheme('notecomplete-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '626b76', fontStyle: 'italic' },
        { token: 'comment.quote', foreground: '626b76', fontStyle: 'italic' },
        { token: 'keyword', foreground: '245dc4', fontStyle: 'bold' },
        { token: 'keyword.heading', foreground: '245dc4', fontStyle: 'bold' },
        { token: 'keyword.fence', foreground: '626b76', fontStyle: 'bold' },
        { token: 'keyword.list', foreground: '245dc4' },
        { token: 'tag.chunk', foreground: '1d7a4a', fontStyle: 'bold' },
        { token: 'meta.frontmatter', foreground: '7a42c4', fontStyle: 'bold' },
        { token: 'attribute.name', foreground: '245dc4' },
        { token: 'entity.name.function', foreground: '1d5b9c' },
        { token: 'constant', foreground: '9a6200', fontStyle: 'bold' },
        { token: 'number', foreground: '1d7a4a' },
        { token: 'string', foreground: 'b83228' },
        { token: 'string.code', foreground: '7a42c4' },
        { token: 'string.link', foreground: '245dc4', fontStyle: 'underline' },
        { token: 'operator', foreground: '9a6200' },
        { token: 'operator.special', foreground: '7a42c4', fontStyle: 'bold' },
        { token: 'strong', fontStyle: 'bold' },
        { token: 'emphasis', fontStyle: 'italic' }
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#242830',
        'editorLineNumber.foreground': '#949ca8',
        'editorLineNumber.activeForeground': '#245dc4',
        'editor.lineHighlightBackground': '#f7f8fa',
        'editor.selectionBackground': '#dbe5f8',
        'editorCursor.foreground': '#245dc4',
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#dce0e5',
        'editorGutter.background': '#fafbfc',
        'editorError.foreground': '#b83228',
        'editorWarning.foreground': '#9a6200'
      }
    });

    monaco.editor.defineTheme('notecomplete-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8b94a3', fontStyle: 'italic' },
        { token: 'comment.quote', foreground: 'a6aeb9', fontStyle: 'italic' },
        { token: 'keyword', foreground: '91b4ff', fontStyle: 'bold' },
        { token: 'keyword.heading', foreground: '91b4ff', fontStyle: 'bold' },
        { token: 'keyword.fence', foreground: 'a6aeb9', fontStyle: 'bold' },
        { token: 'keyword.list', foreground: '91b4ff' },
        { token: 'tag.chunk', foreground: '7fd6a3', fontStyle: 'bold' },
        { token: 'meta.frontmatter', foreground: 'c39bff', fontStyle: 'bold' },
        { token: 'attribute.name', foreground: '91b4ff' },
        { token: 'entity.name.function', foreground: '7ec3ff' },
        { token: 'constant', foreground: 'f0c060', fontStyle: 'bold' },
        { token: 'number', foreground: '7fd6a3' },
        { token: 'string', foreground: 'ffaaa3' },
        { token: 'string.code', foreground: 'c39bff' },
        { token: 'string.link', foreground: '91b4ff', fontStyle: 'underline' },
        { token: 'operator', foreground: 'f0c060' },
        { token: 'operator.special', foreground: 'c39bff', fontStyle: 'bold' },
        { token: 'strong', fontStyle: 'bold' },
        { token: 'emphasis', fontStyle: 'italic' }
      ],
      colors: {
        'editor.background': '#24272c',
        'editor.foreground': '#e5e8ed',
        'editorLineNumber.foreground': '#6e7681',
        'editorLineNumber.activeForeground': '#91b4ff',
        'editor.lineHighlightBackground': '#2b2f36',
        'editor.selectionBackground': '#303e57',
        'editorCursor.foreground': '#91b4ff',
        'editorWidget.background': '#292d33',
        'editorWidget.border': '#3b4048',
        'editorGutter.background': '#202328',
        'editorError.foreground': '#ffaaa3',
        'editorWarning.foreground': '#f0c060'
      }
    });
  }

  function wireLspProviders(monaco, getUriForModel) {
    for (const lang of ['r', 'rmd']) {
      monaco.languages.registerHoverProvider(lang, {
        async provideHover(model, position) {
          const uri = getUriForModel(model);
          if (!uri || !window.studio?.lspHover) return null;
          const res = await window.studio.lspHover({
            uri,
            line: position.lineNumber,
            character: position.column
          });
          if (!res || !res.markdown) return null;
          return {
            contents: [{ value: res.markdown }]
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

  function loadMonaco(monacoVsUrl, getUriForModel) {
    return new Promise((resolve, reject) => {
      const vsPath = monacoVsUrl || '../node_modules/monaco-editor/min/vs';
      window.MonacoEnvironment = {
        getWorkerUrl(_moduleId, label) {
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
          defineNoteCompleteThemes(monaco);
          wireLspProviders(monaco, getUriForModel);
          resolve(monaco);
        },
        reject
      );
    });
  }

  window.StudioMonaco = { loadMonaco };
})();
