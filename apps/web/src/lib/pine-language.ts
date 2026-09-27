import type * as monacoNs from 'monaco-editor';

/**
 * Pine Script v5/v6 support for Monaco: a Monarch tokenizer, a dark theme matching the app's
 * palette, and completions for the built-ins you actually reach for.
 *
 * A Monarch tokenizer, not a full grammar. Monaco only needs to colour text and match brackets;
 * the real parse happens server-side in `POST /pine/compile`, whose diagnostics become the inline
 * markers. Trying to reimplement Pine's semantics here would duplicate PineTS badly.
 */

export const PINE_LANGUAGE_ID = 'pine';

/** Namespaces that get their own colour, so `ta.` reads differently from a local variable. */
const NAMESPACES = [
  'ta',
  'math',
  'strategy',
  'input',
  'request',
  'str',
  'array',
  'matrix',
  'map',
  'color',
  'plot',
  'label',
  'line',
  'box',
  'table',
  'syminfo',
  'timeframe',
  'barstate',
  'session',
  'dayofweek',
  'time',
  'ticker',
  'runtime',
  'chart',
  'currency',
  'alert',
  'shape',
  'location',
  'size',
  'display',
  'extend',
  'xloc',
  'yloc',
  'scale',
  'format',
  'position',
  'hline',
  'order',
  'adjustment',
  'backadjustment',
  'barmerge',
  'earnings',
  'dividends',
  'splits',
  'settlement_as_close',
] as const;

const KEYWORDS = [
  'if',
  'else',
  'for',
  'to',
  'by',
  'while',
  'switch',
  'var',
  'varip',
  'and',
  'or',
  'not',
  'true',
  'false',
  'na',
  'series',
  'simple',
  'const',
  'input',
  'int',
  'float',
  'bool',
  'string',
  'color',
  'line',
  'label',
  'box',
  'table',
  'array',
  'matrix',
  'map',
  'type',
  'method',
  'enum',
  'import',
  'export',
  'as',
  'continue',
  'break',
  'return',
  'indicator',
  'strategy',
  'library',
] as const;

/** Series the tokenizer highlights as built-in values rather than identifiers. */
const BUILTIN_VARS = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
  'time',
  'time_close',
  'bar_index',
  'last_bar_index',
  'last_bar_time',
  'timenow',
  'dayofmonth',
  'dayofweek',
  'hour',
  'minute',
  'month',
  'second',
  'weekofyear',
  'year',
] as const;

export function pineMonarchLanguage(): monacoNs.languages.IMonarchLanguage {
  return {
    defaultToken: '',
    ignoreCase: false,
    keywords: [...KEYWORDS],
    namespaces: [...NAMESPACES],
    builtinVars: [...BUILTIN_VARS],
    operators: [
      '=',
      ':=',
      '==',
      '!=',
      '<',
      '<=',
      '>',
      '>=',
      '+',
      '-',
      '*',
      '/',
      '%',
      '?',
      ':',
      '=>',
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,

    tokenizer: {
      root: [
        // The version pragma first: it is a comment to Pine but the single most important line in
        // the file, so it gets its own token rather than fading into the comment colour.
        //
        // `[@]` rather than a bare `@`: inside a Monarch regex, `@name` is an ATTRIBUTE
        // REFERENCE that Monarch expands before compiling. A literal `@version` therefore made
        // it look for a language-definition attribute called `version`, which threw
        // "language definition does not contain attribute 'version'" and took the whole editor
        // down. A character class breaks the `@`-followed-by-word-character pattern.
        [/^\s*\/\/\s*[@]version\s*=\s*\d+/, 'metatag'],
        [
          /^\s*\/\/\s*[@](description|strategy|indicator|param|returns|function|type|field|enum|variable)\b/,
          'metatag',
        ],

        [/\/\/.*$/, 'comment'],

        // `ta.sma(...)` — namespace, dot, member. Matched as one rule so the namespace keeps its
        // colour even when the member is not a known built-in.
        [
          /\b([a-z_][\w]*)(\.)([a-zA-Z_]\w*)/,
          [
            { cases: { '@namespaces': 'namespace', '@default': 'identifier' } },
            'delimiter',
            'member',
          ],
        ],

        [
          /\b[a-zA-Z_]\w*\b/,
          {
            cases: {
              '@keywords': 'keyword',
              '@builtinVars': 'variable.predefined',
              '@namespaces': 'namespace',
              '@default': 'identifier',
            },
          },
        ],

        // Colour literals, which Pine writes as #RRGGBB or #RRGGBBAA.
        [/#[0-9a-fA-F]{6,8}\b/, 'number.hex'],

        [/\d+\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/\d+([eE][-+]?\d+)?/, 'number'],

        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/'([^'\\]|\\.)*$/, 'string.invalid'],
        [/"/, 'string', '@stringDouble'],
        [/'/, 'string', '@stringSingle'],

        [/[{}()[\]]/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        [/[,;]/, 'delimiter'],
      ],

      stringDouble: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],

      stringSingle: [
        [/[^\\']+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, 'string', '@pop'],
      ],
    },
  } as monacoNs.languages.IMonarchLanguage;
}

export function pineLanguageConfiguration(): monacoNs.languages.LanguageConfiguration {
  return {
    comments: { lineComment: '//' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    // Pine blocks are introduced by a trailing `=>` or a control keyword; indenting after them
    // saves the most common keystroke. D1 requires 4 spaces, which the editor options enforce.
    indentationRules: {
      increaseIndentPattern: /^\s*(if|else|for|while|switch)\b.*$|=>\s*$/,
      decreaseIndentPattern: /^\s*else\b.*$/,
    },
  };
}

/**
 * Completion items.
 *
 * Deliberately a curated list, not an exhaustive dump of Pine's ~1,500 built-ins: a completion
 * popup that lists everything is one you stop reading. These are the functions that appear in
 * real strategies, with signatures, so the popup answers "what are the arguments" too.
 */
interface CompletionSeed {
  readonly label: string;
  readonly insert: string;
  readonly detail: string;
  readonly doc?: string;
  readonly kind: 'function' | 'variable' | 'constant' | 'keyword';
}

const COMPLETIONS: readonly CompletionSeed[] = [
  /* declarations */
  {
    label: 'strategy',
    insert:
      'strategy("${1:My Strategy}", overlay=${2:true}, initial_capital=${3:10000}, default_qty_type=strategy.${4|fixed,percent_of_equity,cash|}, default_qty_value=${5:1})',
    detail: 'strategy(title, …)',
    doc: 'Declares a strategy. Must be the first statement after //@version.',
    kind: 'function',
  },
  {
    label: 'indicator',
    insert: 'indicator("${1:My Indicator}", overlay=${2:true})',
    detail: 'indicator(title, …)',
    kind: 'function',
  },

  /* strategy namespace */
  {
    label: 'strategy.entry',
    insert: 'strategy.entry("${1:id}", strategy.${2|long,short|})',
    detail: 'strategy.entry(id, direction, qty, limit, stop, …)',
    doc: 'Places an entry order. A market order fills at the NEXT bar’s open.',
    kind: 'function',
  },
  {
    label: 'strategy.exit',
    insert: 'strategy.exit("${1:id}", from_entry="${2:entry}", loss=${3:100}, profit=${4:200})',
    detail: 'strategy.exit(id, from_entry, profit, loss, …)',
    doc: '`profit` and `loss` are in TICKS, so they scale with the symbol’s mintick.',
    kind: 'function',
  },
  {
    label: 'strategy.close',
    insert: 'strategy.close("${1:id}")',
    detail: 'strategy.close(id, when, comment, qty, …)',
    kind: 'function',
  },
  {
    label: 'strategy.close_all',
    insert: 'strategy.close_all()',
    detail: 'strategy.close_all(comment, …)',
    kind: 'function',
  },
  {
    label: 'strategy.cancel',
    insert: 'strategy.cancel("${1:id}")',
    detail: 'strategy.cancel(id, when)',
    kind: 'function',
  },
  {
    label: 'strategy.position_size',
    insert: 'strategy.position_size',
    detail: 'series float',
    doc: 'Signed: positive long, negative short, 0 flat.',
    kind: 'variable',
  },

  /* ta */
  {
    label: 'ta.sma',
    insert: 'ta.sma(${1:close}, ${2:20})',
    detail: 'ta.sma(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.ema',
    insert: 'ta.ema(${1:close}, ${2:20})',
    detail: 'ta.ema(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.rma',
    insert: 'ta.rma(${1:close}, ${2:14})',
    detail: 'ta.rma(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.wma',
    insert: 'ta.wma(${1:close}, ${2:20})',
    detail: 'ta.wma(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.vwma',
    insert: 'ta.vwma(${1:close}, ${2:20})',
    detail: 'ta.vwma(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.rsi',
    insert: 'ta.rsi(${1:close}, ${2:14})',
    detail: 'ta.rsi(source, length)',
    kind: 'function',
  },
  { label: 'ta.atr', insert: 'ta.atr(${1:14})', detail: 'ta.atr(length)', kind: 'function' },
  {
    label: 'ta.macd',
    insert:
      '[${1:macdLine}, ${2:signalLine}, ${3:histLine}] = ta.macd(${4:close}, ${5:12}, ${6:26}, ${7:9})',
    detail: 'ta.macd(source, fast, slow, signal) → [macd, signal, hist]',
    kind: 'function',
  },
  {
    label: 'ta.bb',
    insert: '[${1:middle}, ${2:upper}, ${3:lower}] = ta.bb(${4:close}, ${5:20}, ${6:2})',
    detail: 'ta.bb(source, length, mult) → [middle, upper, lower]',
    kind: 'function',
  },
  {
    label: 'ta.stdev',
    insert: 'ta.stdev(${1:close}, ${2:20})',
    detail: 'ta.stdev(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.highest',
    insert: 'ta.highest(${1:high}, ${2:20})',
    detail: 'ta.highest(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.lowest',
    insert: 'ta.lowest(${1:low}, ${2:20})',
    detail: 'ta.lowest(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.crossover',
    insert: 'ta.crossover(${1:fast}, ${2:slow})',
    detail: 'ta.crossover(source1, source2) → series bool',
    kind: 'function',
  },
  {
    label: 'ta.crossunder',
    insert: 'ta.crossunder(${1:fast}, ${2:slow})',
    detail: 'ta.crossunder(source1, source2) → series bool',
    kind: 'function',
  },
  { label: 'ta.adx', insert: 'ta.adx(${1:14})', detail: 'ta.adx(dilen, adxlen)', kind: 'function' },
  {
    label: 'ta.change',
    insert: 'ta.change(${1:close})',
    detail: 'ta.change(source, length)',
    kind: 'function',
  },
  {
    label: 'ta.barssince',
    insert: 'ta.barssince(${1:condition})',
    detail: 'ta.barssince(condition)',
    kind: 'function',
  },

  /* input */
  {
    label: 'input.int',
    insert:
      'input.int(${1:20}, "${2:Length}", minval=${3:1}, maxval=${4:200}, group="${5:Settings}")',
    detail: 'input.int(defval, title, minval, maxval, step, …)',
    doc: 'min/max/step drive the generated Inputs form in Studio.',
    kind: 'function',
  },
  {
    label: 'input.float',
    insert: 'input.float(${1:2.0}, "${2:Multiplier}", minval=${3:0.1}, step=${4:0.1})',
    detail: 'input.float(defval, title, minval, maxval, step, …)',
    kind: 'function',
  },
  {
    label: 'input.bool',
    insert: 'input.bool(${1:true}, "${2:Enabled}")',
    detail: 'input.bool(defval, title, …)',
    kind: 'function',
  },
  {
    label: 'input.string',
    insert: 'input.string("${1:A}", "${2:Mode}", options=["${3:A}", "${4:B}"])',
    detail: 'input.string(defval, title, options, …)',
    kind: 'function',
  },
  {
    label: 'input.source',
    insert: 'input.source(${1:close}, "${2:Source}")',
    detail: 'input.source(defval, title, …)',
    kind: 'function',
  },
  {
    label: 'input.timeframe',
    insert: 'input.timeframe("${1:240}", "${2:Higher timeframe}")',
    detail: 'input.timeframe(defval, title, …)',
    kind: 'function',
  },

  /* request */
  {
    label: 'request.security',
    insert:
      'request.security(syminfo.tickerid, "${1:240}", ${2:close}[1], lookahead=barmerge.lookahead_off)',
    detail: 'request.security(symbol, timeframe, expression, …)',
    doc: 'Non-repainting form: index the expression with [1] AND keep lookahead_off.',
    kind: 'function',
  },

  /* plotting */
  {
    label: 'plot',
    insert: 'plot(${1:close}, title="${2:Close}", color=color.${3:blue})',
    detail: 'plot(series, title, color, …)',
    kind: 'function',
  },
  {
    label: 'plotshape',
    insert:
      'plotshape(${1:condition}, style=shape.${2:triangleup}, location=location.${3:belowbar})',
    detail: 'plotshape(series, …)',
    kind: 'function',
  },
  {
    label: 'hline',
    insert: 'hline(${1:0}, "${2:Zero}", color=color.${3:gray})',
    detail: 'hline(price, title, color, …)',
    kind: 'function',
  },
  {
    label: 'bgcolor',
    insert: 'bgcolor(${1:condition} ? color.new(color.${2:green}, 90) : na)',
    detail: 'bgcolor(color, …)',
    kind: 'function',
  },

  /* math */
  {
    label: 'math.max',
    insert: 'math.max(${1:a}, ${2:b})',
    detail: 'math.max(…)',
    kind: 'function',
  },
  {
    label: 'math.min',
    insert: 'math.min(${1:a}, ${2:b})',
    detail: 'math.min(…)',
    kind: 'function',
  },
  { label: 'math.abs', insert: 'math.abs(${1:x})', detail: 'math.abs(number)', kind: 'function' },
  {
    label: 'math.round',
    insert: 'math.round(${1:x})',
    detail: 'math.round(number, precision)',
    kind: 'function',
  },

  /* syminfo */
  {
    label: 'syminfo.tickerid',
    insert: 'syminfo.tickerid',
    detail: 'simple string',
    kind: 'variable',
  },
  { label: 'syminfo.mintick', insert: 'syminfo.mintick', detail: 'simple float', kind: 'variable' },
  {
    label: 'syminfo.pointvalue',
    insert: 'syminfo.pointvalue',
    detail: 'simple float',
    kind: 'variable',
  },
];

/**
 * Register Pine with a Monaco instance. Idempotent — `@monaco-editor/react` can re-run `onMount`
 * across hot reloads, and registering a language twice throws.
 */
export function registerPineLanguage(monaco: typeof monacoNs): void {
  if (monaco.languages.getLanguages().some((l) => l.id === PINE_LANGUAGE_ID)) return;

  monaco.languages.register({
    id: PINE_LANGUAGE_ID,
    extensions: ['.pine'],
    aliases: ['Pine', 'pine'],
  });
  monaco.languages.setMonarchTokensProvider(PINE_LANGUAGE_ID, pineMonarchLanguage());
  monaco.languages.setLanguageConfiguration(PINE_LANGUAGE_ID, pineLanguageConfiguration());

  monaco.languages.registerCompletionItemProvider(PINE_LANGUAGE_ID, {
    triggerCharacters: ['.'],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      return {
        suggestions: COMPLETIONS.map((c) => ({
          label: c.label,
          kind: monacoKind(monaco, c.kind),
          insertText: c.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: c.detail,
          ...(c.doc === undefined ? {} : { documentation: { value: c.doc } }),
          range,
        })),
      };
    },
  });

  // Theme colours come from the app's own palette so the editor does not look pasted in.
  monaco.editor.defineTheme('edgelab-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5c6b82', fontStyle: 'italic' },
      { token: 'metatag', foreground: 'c792ea', fontStyle: 'bold' },
      { token: 'keyword', foreground: '82aaff' },
      { token: 'namespace', foreground: '4ec9b0' },
      { token: 'member', foreground: 'dcdcaa' },
      { token: 'variable.predefined', foreground: 'f78c6c' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'number.float', foreground: 'b5cea8' },
      { token: 'number.hex', foreground: 'ce9178' },
      { token: 'string', foreground: 'ce9178' },
      { token: 'string.escape', foreground: 'd7ba7d' },
      { token: 'operator', foreground: '89ddff' },
      { token: 'identifier', foreground: 'd6deeb' },
    ],
    colors: {
      'editor.background': '#0d1421',
      'editor.foreground': '#d6deeb',
      'editorLineNumber.foreground': '#3b4a63',
      'editorLineNumber.activeForeground': '#8aa0c0',
      'editor.selectionBackground': '#1f3a5f',
      'editor.lineHighlightBackground': '#131c2d',
      'editorIndentGuide.background1': '#1c2536',
      'editorGutter.background': '#0d1421',
    },
  });

  monaco.editor.defineTheme('edgelab-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8b98ab', fontStyle: 'italic' },
      { token: 'metatag', foreground: '7c3aed', fontStyle: 'bold' },
      { token: 'keyword', foreground: '1d4ed8' },
      { token: 'namespace', foreground: '0f766e' },
      { token: 'member', foreground: '92400e' },
      { token: 'variable.predefined', foreground: 'b45309' },
      { token: 'string', foreground: 'a3324a' },
    ],
    colors: { 'editor.background': '#ffffff' },
  });
}

function monacoKind(
  monaco: typeof monacoNs,
  kind: CompletionSeed['kind'],
): monacoNs.languages.CompletionItemKind {
  switch (kind) {
    case 'function':
      return monaco.languages.CompletionItemKind.Function;
    case 'variable':
      return monaco.languages.CompletionItemKind.Variable;
    case 'constant':
      return monaco.languages.CompletionItemKind.Constant;
    case 'keyword':
      return monaco.languages.CompletionItemKind.Keyword;
  }
}
