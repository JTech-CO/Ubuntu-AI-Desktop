/**
 * js/apps/codeoss/highlight.js — a real tokenizer for Code-OSS.
 *
 * This is deliberately NOT a chain of regex replacements over an HTML string.
 * The source is scanned character by character into a token stream, so a
 * keyword that happens to sit inside a string or a comment keeps the string /
 * comment colour, and a string containing quotes or backslash escapes is
 * consumed as a single token.
 *
 * Public API (ARCHITECTURE §18):
 *   tokenize(code, lang)      -> [{ type, value }, ...]  (values concatenate
 *                                back to the exact input)
 *   highlight(code, lang)     -> DocumentFragment of <span> whose text is set
 *                                with textContent
 *   tokenizeLines(code, lang) -> Token[][], one array per line, newlines removed
 *   renderTokens(tokens)      -> DocumentFragment
 */

/** Every token type this module can emit. Each maps to a `.tok-<type>` class. */
export const TOKEN_TYPES = Object.freeze([
  'whitespace', 'plain', 'comment', 'string', 'template', 'number', 'keyword',
  'identifier', 'operator', 'punctuation', 'type', 'builtin', 'function',
  'property', 'variable', 'regexp', 'tag', 'attribute', 'decorator', 'constant',
  'heading', 'link', 'emphasis', 'strong', 'quote', 'list', 'selector', 'value',
]);

const T = {
  WS: 'whitespace', PLAIN: 'plain', COMMENT: 'comment', STRING: 'string',
  TEMPLATE: 'template', NUMBER: 'number', KEYWORD: 'keyword', IDENT: 'identifier',
  OPERATOR: 'operator', PUNCT: 'punctuation', TYPE: 'type', BUILTIN: 'builtin',
  FUNCTION: 'function', PROPERTY: 'property', VARIABLE: 'variable',
  REGEXP: 'regexp', TAG: 'tag', ATTRIBUTE: 'attribute', DECORATOR: 'decorator',
  CONSTANT: 'constant', HEADING: 'heading', LINK: 'link', EMPHASIS: 'emphasis',
  STRONG: 'strong', QUOTE: 'quote', LIST: 'list', SELECTOR: 'selector',
  VALUE: 'value',
};

/* ------------------------------------------------------------------ *
 * language identity
 * ------------------------------------------------------------------ */

const ALIASES = {
  py: 'python', python3: 'python', python: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  javascript: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', typescript: 'typescript',
  json: 'json', jsonc: 'json', map: 'json',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', ksh: 'shell', profile: 'shell',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  java: 'java',
  txt: 'text', text: 'text', log: 'text', plain: 'text', '': 'text',
};

const LABELS = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
  json: 'JSON', html: 'HTML', css: 'CSS', markdown: 'Markdown', shell: 'Shell Script',
  c: 'C', cpp: 'C++', java: 'Java', text: 'Plain Text',
};

const LINE_COMMENTS = {
  python: '#', shell: '#', javascript: '//', typescript: '//', c: '//', cpp: '//',
  java: '//', css: null, json: null, html: null, markdown: null, text: null,
};

const FILENAME_MAP = {
  makefile: 'shell', dockerfile: 'shell', '.bashrc': 'shell', '.profile': 'shell',
  '.bash_history': 'shell', '.bash_logout': 'shell', '.zshrc': 'shell',
  'package.json': 'json', 'tsconfig.json': 'json', '.gitignore': 'text',
  'requirements.txt': 'text', license: 'text', 'os-release': 'shell',
};

/**
 * @param {string} lang free-form language name or extension
 * @returns {string} canonical language id
 */
export function normalizeLanguage(lang) {
  const key = String(lang == null ? '' : lang).trim().toLowerCase().replace(/^\./, '');
  return ALIASES[key] || (LABELS[key] ? key : 'text');
}

/**
 * @param {string} filename a name or a full path
 * @returns {string} canonical language id
 */
export function detectLanguage(filename) {
  const name = String(filename == null ? '' : filename).split('/').pop() || '';
  const lower = name.toLowerCase();
  if (FILENAME_MAP[lower]) return FILENAME_MAP[lower];
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return lower.startsWith('.') ? normalizeLanguage(lower.slice(1)) : 'text';
  return normalizeLanguage(lower.slice(dot + 1));
}

/** @param {string} lang @returns {string} human label for the status bar */
export function languageLabel(lang) {
  return LABELS[normalizeLanguage(lang)] || 'Plain Text';
}

/** @param {string} lang @returns {string|null} line-comment prefix, if any */
export function lineComment(lang) {
  const id = normalizeLanguage(lang);
  return Object.prototype.hasOwnProperty.call(LINE_COMMENTS, id) ? LINE_COMMENTS[id] : null;
}

/* ------------------------------------------------------------------ *
 * language configuration
 * ------------------------------------------------------------------ */

function words(str) {
  return new Set(String(str).split(/\s+/).filter(Boolean));
}

const OPS_C = [
  '>>>=', '<<=', '>>=', '...', '<=>', '===', '!==', '**=', '&&=', '||=', '??=',
  '>>>', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>', '->', '::',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?',
];

const OPS_SHELL = ['&&', '||', '>>', '<<', '=~', '==', '!=', '<=', '>=', '+=', '-=', '|', '>', '<', '&', '=', '!', '*', '+', '-', '%', '/'];

function numberRegex(suffix) {
  return new RegExp(
    '0[xX][0-9a-fA-F][0-9a-fA-F_]*' + suffix +
    '|0[bB][01][01_]*' + suffix +
    '|0[oO][0-7][0-7_]*' + suffix +
    '|(?:\\d[\\d_]*)?\\.\\d[\\d_]*(?:[eE][+-]?\\d+)?' + suffix +
    '|\\d[\\d_]*(?:[eE][+-]?\\d+)?\\.?' + suffix,
    'y',
  );
}

const JS_KEYWORDS =
  'break case catch class const continue debugger default delete do else export extends ' +
  'finally for function if import in instanceof let new return super switch this throw try ' +
  'typeof var void while with yield async await static get set of from as';

const TS_EXTRA =
  'interface type enum namespace declare abstract implements public private protected ' +
  'readonly override satisfies keyof infer asserts is module require global unique';

const JS_BUILTINS =
  'console window document globalThis Math JSON Object Array String Number Boolean ' +
  'Promise Symbol Map Set WeakMap WeakSet Date RegExp Error TypeError RangeError ' +
  'SyntaxError Proxy Reflect Intl BigInt ArrayBuffer Uint8Array Float64Array ' +
  'setTimeout setInterval clearTimeout clearInterval queueMicrotask requestAnimationFrame ' +
  'fetch localStorage sessionStorage process module exports __dirname __filename';

const TS_TYPES = 'any unknown never void string number boolean object symbol bigint undefined null Array Record Partial Readonly Pick Omit Promise';

const PY_KEYWORDS =
  'and as assert async await break class continue def del elif else except finally for ' +
  'from global if import in is lambda nonlocal not or pass raise return try while with yield match case';

const PY_BUILTINS =
  'abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr ' +
  'classmethod compile complex delattr dict dir divmod enumerate eval exec filter float ' +
  'format frozenset getattr globals hasattr hash help hex id input int isinstance ' +
  'issubclass iter len list locals map max memoryview min next object oct open ord pow ' +
  'print property range repr reversed round set setattr slice sorted staticmethod str ' +
  'sum super tuple type vars zip __import__ Exception BaseException ValueError TypeError ' +
  'KeyError IndexError RuntimeError StopIteration OSError FileNotFoundError ImportError ' +
  'AttributeError ZeroDivisionError NotImplementedError';

const C_KEYWORDS =
  'auto break case char const continue default do double else enum extern float for goto ' +
  'if inline int long register restrict return short signed sizeof static struct switch ' +
  'typedef union unsigned void volatile while _Bool _Complex _Atomic _Static_assert';

const CPP_KEYWORDS = C_KEYWORDS + ' ' +
  'alignas alignof and and_eq asm bitand bitor catch class compl concept consteval ' +
  'constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast ' +
  'explicit export false friend mutable namespace new noexcept not not_eq nullptr operator ' +
  'or or_eq private protected public reinterpret_cast requires static_assert static_cast ' +
  'template this thread_local throw true try typeid typename using virtual wchar_t xor xor_eq';

const CPP_TYPES =
  'std string wstring vector map unordered_map unordered_set set list deque array pair ' +
  'tuple queue stack size_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t ' +
  'uint32_t uint64_t ostream istream stringstream ostringstream istringstream shared_ptr ' +
  'unique_ptr weak_ptr optional variant function initializer_list';

const JAVA_KEYWORDS =
  'abstract assert boolean break byte case catch char class const continue default do ' +
  'double else enum extends final finally float for goto if implements import instanceof ' +
  'int interface long native new package private protected public return short static ' +
  'strictfp super switch synchronized this throw throws transient try var void volatile ' +
  'while record sealed permits yield';

const JAVA_TYPES =
  'String Integer Double Float Long Short Byte Character Boolean Object System Math ' +
  'List ArrayList LinkedList Map HashMap TreeMap Set HashSet TreeSet Collection Collections ' +
  'Arrays Optional Stream Thread Runnable Exception RuntimeException IOException ' +
  'StringBuilder Scanner Comparable Iterable Number';

const SH_KEYWORDS =
  'if then else elif fi for while until do done case esac function select in time coproc ' +
  'return break continue local export readonly declare typeset shift set unset trap exit ' +
  'source eval exec alias unalias';

const SH_BUILTINS =
  'echo printf read cd pwd ls cat grep egrep fgrep sed awk cut sort uniq head tail wc ' +
  'find xargs chmod chown mkdir rmdir rm cp mv touch ln tar gzip gunzip zip unzip curl ' +
  'wget git sudo apt apt-get dpkg snap systemctl service kill pkill killall ps top df du ' +
  'which whereis whoami id date sleep test true false env printenv basename dirname tee ' +
  'mktemp diff tr rev nl seq man clear history uname hostname ping ip ifconfig';

/**
 * Build a scanner configuration.
 * @param {object} spec
 * @returns {object}
 */
function config(spec) {
  return {
    lineComments: spec.lineComments || [],
    blockComments: spec.blockComments || [],
    quotes: spec.quotes === undefined ? '"\'' : spec.quotes,
    rawQuotes: spec.rawQuotes || '',
    multilineStrings: spec.multilineStrings === true,
    tripleQuotes: spec.tripleQuotes === true,
    stringPrefixes: spec.stringPrefixes || null,
    template: spec.template === true,
    escape: spec.escape !== false,
    regex: spec.regex === true,
    decorator: spec.decorator === true,
    dollarVars: spec.dollarVars === true,
    preprocessor: spec.preprocessor === true,
    caseHeuristics: spec.caseHeuristics !== false,
    keywords: words(spec.keywords || ''),
    literals: words(spec.literals || ''),
    types: words(spec.types || ''),
    builtins: words(spec.builtins || ''),
    declarators: words(spec.declarators || 'class def function struct interface enum namespace union typedef record'),
    identStart: spec.identStart || /[A-Za-z_$]/,
    identPart: spec.identPart || /[A-Za-z0-9_$]/,
    operators: (spec.operators || OPS_C).slice().sort((a, b) => b.length - a.length),
    punctuation: spec.punctuation === undefined ? '(){}[];,.:' : spec.punctuation,
    numberRe: spec.numberRe || numberRegex(''),
  };
}

const CONFIGS = {
  javascript: config({
    lineComments: ['//'], blockComments: [['/*', '*/']], template: true, regex: true,
    decorator: true, keywords: JS_KEYWORDS, literals: 'true false null undefined NaN Infinity',
    builtins: JS_BUILTINS, numberRe: numberRegex('n?'),
  }),
  typescript: config({
    lineComments: ['//'], blockComments: [['/*', '*/']], template: true, regex: true,
    decorator: true, keywords: JS_KEYWORDS + ' ' + TS_EXTRA,
    literals: 'true false null undefined NaN Infinity', types: TS_TYPES,
    builtins: JS_BUILTINS, numberRe: numberRegex('n?'),
  }),
  python: config({
    lineComments: ['#'], tripleQuotes: true, decorator: true,
    stringPrefixes: /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/,
    keywords: PY_KEYWORDS, literals: 'True False None NotImplemented Ellipsis',
    builtins: PY_BUILTINS, identStart: /[A-Za-z_]/, identPart: /[A-Za-z0-9_]/,
    numberRe: numberRegex('[jJ]?'),
    operators: ['**=', '//=', '>>=', '<<=', '==', '!=', '<=', '>=', '**', '//', '->', ':=',
      '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '+', '-', '*', '/', '%', '=',
      '<', '>', '&', '|', '^', '~'],
  }),
  json: config({
    lineComments: ['//'], blockComments: [['/*', '*/']], quotes: '"',
    keywords: '', literals: 'true false null', caseHeuristics: false,
    operators: ['-', '+'], punctuation: '{}[],:',
  }),
  c: config({
    lineComments: ['//'], blockComments: [['/*', '*/']], preprocessor: true,
    keywords: C_KEYWORDS, literals: 'NULL true false',
    types: 'size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE va_list bool',
    identStart: /[A-Za-z_]/, identPart: /[A-Za-z0-9_]/, numberRe: numberRegex('(?:[uUlLfF]|ll|LL)*'),
  }),
  cpp: config({
    lineComments: ['//'], blockComments: [['/*', '*/']], preprocessor: true,
    keywords: CPP_KEYWORDS, literals: 'NULL nullptr true false', types: CPP_TYPES,
    identStart: /[A-Za-z_]/, identPart: /[A-Za-z0-9_]/, numberRe: numberRegex('(?:[uUlLfF]|ll|LL)*'),
  }),
  java: config({
    lineComments: ['//'], blockComments: [['/*', '*/']], decorator: true,
    keywords: JAVA_KEYWORDS, literals: 'true false null', types: JAVA_TYPES,
    identStart: /[A-Za-z_$]/, identPart: /[A-Za-z0-9_$]/, numberRe: numberRegex('[lLfFdD]?'),
  }),
  shell: config({
    lineComments: ['#'], dollarVars: true, multilineStrings: true, rawQuotes: "'",
    keywords: SH_KEYWORDS, literals: 'true false', builtins: SH_BUILTINS,
    caseHeuristics: false, identStart: /[A-Za-z_]/, identPart: /[A-Za-z0-9_-]/,
    operators: OPS_SHELL, punctuation: '(){}[];,', numberRe: numberRegex(''),
  }),
  text: config({ lineComments: [], quotes: '', keywords: '', caseHeuristics: false, operators: [], punctuation: '' }),
};

/* ------------------------------------------------------------------ *
 * generic scanner
 * ------------------------------------------------------------------ */

const WS_CHARS = ' \t\n\r\f\v';

function isWs(ch) {
  return ch !== undefined && WS_CHARS.indexOf(ch) >= 0;
}

/** Positions after which a `/` starts a regular expression rather than a division. */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === T.OPERATOR) return true;
  if (prev.type === T.KEYWORD) return REGEX_KEYWORDS.has(prev.value);
  if (prev.type === T.PUNCT) return ')]}'.indexOf(prev.value) < 0;
  return false;
}

/**
 * Consume a JavaScript regular-expression literal.
 * @returns {number} index just past the literal, or -1 when it is not one
 */
function scanRegex(code, start) {
  const n = code.length;
  let i = start + 1;
  let inClass = false;
  while (i < n) {
    const c = code[i];
    if (c === '\n') return -1;
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i += 1;
      while (i < n && /[a-z]/.test(code[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Find the `}` that closes a `${` interpolation, skipping nested strings. */
function findExprEnd(code, start) {
  const n = code.length;
  let i = start;
  let depth = 0;
  while (i < n) {
    const c = code[i];
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { if (depth === 0) return i; depth -= 1; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '/' && code[i + 1] === '/') { const j = code.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && code[i + 1] === '*') { const j = code.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    i += 1;
  }
  return n;
}

/** Consume a plain quoted string starting at `start`. */
function readQuoted(code, start, quote, escape, multiline) {
  const n = code.length;
  let i = start + 1;
  while (i < n) {
    const c = code[i];
    if (escape && c === '\\') { i += 2; continue; }
    if (c === quote) { i += 1; break; }
    if (c === '\n' && !multiline) break;
    i += 1;
  }
  return Math.min(i, n);
}

/**
 * Try to read a string (with optional prefix, triple quotes or template).
 * @returns {{type?:string, value?:string, tokens?:object[], end:number}|null}
 */
function readString(code, start, cfg) {
  let i = start;
  let prefix = '';
  if (cfg.stringPrefixes) {
    const pre = /[A-Za-z_]{1,3}(?=['"])/y;
    pre.lastIndex = i;
    const m = pre.exec(code);
    if (m && cfg.stringPrefixes.test(m[0])) { prefix = m[0]; i += m[0].length; }
  }

  const ch = code[i];
  if (ch === undefined) return null;

  if (cfg.template && ch === '`' && prefix === '') return scanTemplate(code, i, cfg);

  if (cfg.tripleQuotes && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
    const q = code.slice(i, i + 3);
    const n = code.length;
    let j = i + 3;
    while (j < n) {
      if (code[j] === '\\') { j += 2; continue; }
      if (code.startsWith(q, j)) { j += 3; break; }
      j += 1;
    }
    const end = Math.min(j, n);
    return { type: T.STRING, value: code.slice(start, end), end };
  }

  if (!cfg.quotes || cfg.quotes.indexOf(ch) < 0) return null;
  const escape = cfg.escape && cfg.rawQuotes.indexOf(ch) < 0;
  const end = readQuoted(code, i, ch, escape, cfg.multilineStrings);
  return { type: T.STRING, value: code.slice(start, end), end };
}

/** Scan a template literal, tokenizing each `${…}` expression with `cfg`. */
function scanTemplate(code, start, cfg) {
  const n = code.length;
  const tokens = [];
  let i = start + 1;
  let chunk = '`';
  while (i < n) {
    const c = code[i];
    if (c === '\\') { chunk += code.slice(i, i + 2); i += 2; continue; }
    if (c === '`') { chunk += c; i += 1; break; }
    if (c === '$' && code[i + 1] === '{') {
      tokens.push({ type: T.TEMPLATE, value: chunk + '${' });
      chunk = '';
      i += 2;
      const end = findExprEnd(code, i);
      const inner = code.slice(i, end);
      if (inner) for (const t of scanGeneric(inner, cfg)) tokens.push(t);
      i = end;
      if (code[i] === '}') { chunk = '}'; i += 1; }
      continue;
    }
    chunk += c;
    i += 1;
  }
  if (chunk) tokens.push({ type: T.TEMPLATE, value: chunk });
  return { tokens, end: i };
}

/** Decide what an identifier means in context. */
function classifyWord(word, code, after, cfg, prev) {
  if (cfg.literals.has(word)) return T.CONSTANT;
  if (cfg.keywords.has(word)) return T.KEYWORD;
  if (cfg.types.has(word)) return T.TYPE;
  if (cfg.builtins.has(word)) return T.BUILTIN;

  if (prev && prev.type === T.KEYWORD && cfg.declarators.has(prev.value)) return T.TYPE;

  let k = after;
  while (k < code.length && (code[k] === ' ' || code[k] === '\t')) k += 1;
  if (code[k] === '(' || (code[k] === '<' && code[k + 1] !== '=' && cfg.types.size > 0 && /^[A-Z]/.test(word) === false)) {
    if (code[k] === '(') return T.FUNCTION;
  }
  if (prev && prev.type === T.PUNCT && prev.value === '.') return T.PROPERTY;
  if (!cfg.caseHeuristics) return T.IDENT;
  if (word.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(word)) return T.CONSTANT;
  if (/^[A-Z]/.test(word)) return T.TYPE;
  return T.IDENT;
}

function matchOperator(code, i, ops) {
  for (const op of ops) if (code.startsWith(op, i)) return op;
  return '';
}

/**
 * The C-family / Python / shell scanner.
 * @param {string} code
 * @param {object} cfg
 * @returns {{type:string, value:string}[]}
 */
function scanGeneric(code, cfg) {
  const out = [];
  const n = code.length;
  let i = 0;
  let prev = null;
  let lineStart = true;

  const push = (type, value) => {
    if (!value) return;
    const token = { type, value };
    out.push(token);
    if (type !== T.WS && type !== T.COMMENT) prev = token;
    if (value.indexOf('\n') >= 0) lineStart = true;
    else if (type !== T.WS) lineStart = false;
  };

  while (i < n) {
    const ch = code[i];

    if (isWs(ch)) {
      let j = i + 1;
      while (j < n && isWs(code[j])) j += 1;
      push(T.WS, code.slice(i, j));
      i = j;
      continue;
    }

    if (cfg.preprocessor && ch === '#' && lineStart) {
      const pp = /#[ \t]*[A-Za-z_]\w*/y;
      pp.lastIndex = i;
      const m = pp.exec(code);
      if (m) {
        push(T.KEYWORD, m[0]);
        i = pp.lastIndex;
        if (/#[ \t]*include/.test(m[0])) {
          let k = i;
          while (k < n && (code[k] === ' ' || code[k] === '\t')) k += 1;
          if (code[k] === '<') {
            const close = code.indexOf('>', k);
            const end = close < 0 ? n : close + 1;
            push(T.WS, code.slice(i, k));
            push(T.STRING, code.slice(k, end));
            i = end;
          }
        }
        continue;
      }
    }

    let consumed = false;
    for (const p of cfg.lineComments) {
      if (code.startsWith(p, i)) {
        let j = code.indexOf('\n', i);
        if (j < 0) j = n;
        push(T.COMMENT, code.slice(i, j));
        i = j;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    for (const pair of cfg.blockComments) {
      if (code.startsWith(pair[0], i)) {
        let j = code.indexOf(pair[1], i + pair[0].length);
        j = j < 0 ? n : j + pair[1].length;
        push(T.COMMENT, code.slice(i, j));
        i = j;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    const str = readString(code, i, cfg);
    if (str) {
      if (str.tokens) for (const t of str.tokens) push(t.type, t.value);
      else push(str.type, str.value);
      i = str.end;
      continue;
    }

    if (cfg.decorator && ch === '@') {
      const dec = /@[A-Za-z_$][\w$.]*/y;
      dec.lastIndex = i;
      const m = dec.exec(code);
      if (m) { push(T.DECORATOR, m[0]); i = dec.lastIndex; continue; }
    }

    if (cfg.dollarVars && ch === '$') {
      const v = /\$(?:\{[^}\n]*\}|\([^)\n]*\)|[A-Za-z_]\w*|[0-9*@#?$!_-])/y;
      v.lastIndex = i;
      const m = v.exec(code);
      if (m) { push(T.VARIABLE, m[0]); i = v.lastIndex; continue; }
    }

    if (cfg.regex && ch === '/' && regexAllowed(prev)) {
      const end = scanRegex(code, i);
      if (end > 0) { push(T.REGEXP, code.slice(i, end)); i = end; continue; }
    }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      cfg.numberRe.lastIndex = i;
      const m = cfg.numberRe.exec(code);
      if (m && m[0]) { push(T.NUMBER, m[0]); i = cfg.numberRe.lastIndex; continue; }
    }

    if (cfg.identStart.test(ch)) {
      let j = i + 1;
      while (j < n && cfg.identPart.test(code[j])) j += 1;
      const word = code.slice(i, j);
      push(classifyWord(word, code, j, cfg, prev), word);
      i = j;
      continue;
    }

    const op = matchOperator(code, i, cfg.operators);
    if (op) { push(T.OPERATOR, op); i += op.length; continue; }

    if (cfg.punctuation.indexOf(ch) >= 0) { push(T.PUNCT, ch); i += 1; continue; }

    push(T.PLAIN, ch);
    i += 1;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * JSON — reuse the generic scanner, then mark object keys
 * ------------------------------------------------------------------ */

function scanJson(code) {
  const tokens = scanGeneric(code, CONFIGS.json);
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== T.STRING) continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].type === T.WS) j += 1;
    if (j < tokens.length && tokens[j].type === T.PUNCT && tokens[j].value === ':') {
      tokens[i] = { type: T.PROPERTY, value: tokens[i].value };
    }
  }
  return tokens;
}

/* ------------------------------------------------------------------ *
 * CSS
 * ------------------------------------------------------------------ */

const CSS_NUMBER = /-?(?:\d*\.\d+|\d+)(?:%|[a-zA-Z]{1,4})?/y;
const CSS_IDENT = /-{0,2}[A-Za-z_][-\w]*/y;

function scanCss(code) {
  const out = [];
  const n = code.length;
  let i = 0;
  let inBlock = false;
  let inValue = false;

  const push = (type, value) => { if (value) out.push({ type, value }); };

  while (i < n) {
    const ch = code[i];

    if (isWs(ch)) {
      let j = i + 1;
      while (j < n && isWs(code[j])) j += 1;
      push(T.WS, code.slice(i, j));
      i = j;
      continue;
    }

    if (code.startsWith('/*', i)) {
      let j = code.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      push(T.COMMENT, code.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = readQuoted(code, i, ch, true, false);
      push(T.STRING, code.slice(i, end));
      i = end;
      continue;
    }

    if (ch === '@') {
      const at = /@[-\w]+/y;
      at.lastIndex = i;
      const m = at.exec(code);
      if (m) { push(T.KEYWORD, m[0]); i = at.lastIndex; continue; }
    }

    if (ch === '!') {
      const bang = /![ \t]*[a-z]+/y;
      bang.lastIndex = i;
      const m = bang.exec(code);
      if (m) { push(T.KEYWORD, m[0]); i = bang.lastIndex; continue; }
    }

    if (ch === '#') {
      const hex = /#[0-9a-fA-F]{3,8}(?![-\w])/y;
      hex.lastIndex = i;
      const m = inValue ? hex.exec(code) : null;
      if (m) { push(T.NUMBER, m[0]); i = hex.lastIndex; continue; }
      const id = /#[-\w]+/y;
      id.lastIndex = i;
      const m2 = id.exec(code);
      if (m2) { push(T.SELECTOR, m2[0]); i = id.lastIndex; continue; }
    }

    if (ch === '.' && /[A-Za-z_-]/.test(code[i + 1] || '')) {
      const cls = /\.[-\w]+/y;
      cls.lastIndex = i;
      const m = cls.exec(code);
      if (m) { push(T.SELECTOR, m[0]); i = cls.lastIndex; continue; }
    }

    if (ch === ':' && !inValue && !inBlock) {
      const pseudo = /::?[-\w]+/y;
      pseudo.lastIndex = i;
      const m = pseudo.exec(code);
      if (m) { push(T.SELECTOR, m[0]); i = pseudo.lastIndex; continue; }
    }

    if (ch === '{') { inBlock = true; inValue = false; push(T.PUNCT, ch); i += 1; continue; }
    if (ch === '}') { inBlock = false; inValue = false; push(T.PUNCT, ch); i += 1; continue; }
    if (ch === ':') { if (inBlock) inValue = true; push(T.PUNCT, ch); i += 1; continue; }
    if (ch === ';') { inValue = false; push(T.PUNCT, ch); i += 1; continue; }

    if ((ch >= '0' && ch <= '9') || (ch === '-' && /\d/.test(code[i + 1] || '')) || (ch === '.' && /\d/.test(code[i + 1] || ''))) {
      CSS_NUMBER.lastIndex = i;
      const m = CSS_NUMBER.exec(code);
      if (m && m[0]) { push(T.NUMBER, m[0]); i = CSS_NUMBER.lastIndex; continue; }
    }

    if (/[A-Za-z_-]/.test(ch)) {
      CSS_IDENT.lastIndex = i;
      const m = CSS_IDENT.exec(code);
      if (m && m[0]) {
        const word = m[0];
        let k = CSS_IDENT.lastIndex;
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k += 1;
        let type;
        if (code[k] === '(') type = T.FUNCTION;
        else if (word.startsWith('--')) type = T.VARIABLE;
        else if (!inBlock) type = T.TAG;
        else if (!inValue) type = T.PROPERTY;
        else type = T.VALUE;
        push(type, word);
        i = CSS_IDENT.lastIndex;
        continue;
      }
    }

    if ('(){}[],'.indexOf(ch) >= 0) { push(T.PUNCT, ch); i += 1; continue; }
    if ('>+~*=|^$/'.indexOf(ch) >= 0) { push(T.OPERATOR, ch); i += 1; continue; }
    push(T.PLAIN, ch);
    i += 1;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * HTML / XML
 * ------------------------------------------------------------------ */

function scanHtml(code) {
  const out = [];
  const lower = code.toLowerCase();
  const n = code.length;
  let i = 0;
  const push = (type, value) => { if (value) out.push({ type, value }); };

  while (i < n) {
    if (code.startsWith('<!--', i)) {
      let j = code.indexOf('-->', i + 4);
      j = j < 0 ? n : j + 3;
      push(T.COMMENT, code.slice(i, j));
      i = j;
      continue;
    }

    if (code.startsWith('<!', i) || code.startsWith('<?', i)) {
      let j = code.indexOf('>', i);
      j = j < 0 ? n : j + 1;
      push(T.KEYWORD, code.slice(i, j));
      i = j;
      continue;
    }

    if (code[i] === '<') {
      const open = /<\/?[A-Za-z][-\w:.]*/y;
      open.lastIndex = i;
      const m = open.exec(code);
      if (m) {
        const closing = m[0][1] === '/';
        const name = closing ? m[0].slice(2) : m[0].slice(1);
        push(T.PUNCT, closing ? '</' : '<');
        push(T.TAG, name);
        i = open.lastIndex;

        while (i < n && code[i] !== '>' && !code.startsWith('/>', i)) {
          const c = code[i];
          if (isWs(c)) {
            let j = i + 1;
            while (j < n && isWs(code[j])) j += 1;
            push(T.WS, code.slice(i, j));
            i = j;
            continue;
          }
          if (c === '=') { push(T.OPERATOR, '='); i += 1; continue; }
          if (c === '"' || c === "'") {
            const end = readQuoted(code, i, c, false, true);
            push(T.STRING, code.slice(i, end));
            i = end;
            continue;
          }
          const attr = /[^\s=>/]+/y;
          attr.lastIndex = i;
          const a = attr.exec(code);
          if (a && a[0]) { push(T.ATTRIBUTE, a[0]); i = attr.lastIndex; continue; }
          push(T.PLAIN, c);
          i += 1;
        }

        if (code.startsWith('/>', i)) { push(T.PUNCT, '/>'); i += 2; } else if (code[i] === '>') { push(T.PUNCT, '>'); i += 1; }

        const tag = name.toLowerCase();
        if (!closing && (tag === 'script' || tag === 'style')) {
          let end = lower.indexOf('</' + tag, i);
          if (end < 0) end = n;
          const inner = code.slice(i, end);
          if (inner) {
            const sub = tag === 'script' ? scanGeneric(inner, CONFIGS.javascript) : scanCss(inner);
            for (const t of sub) out.push(t);
          }
          i = end;
        }
        continue;
      }
    }

    if (code[i] === '&') {
      const ent = /&#?[0-9A-Za-z]+;/y;
      ent.lastIndex = i;
      const m = ent.exec(code);
      if (m) { push(T.CONSTANT, m[0]); i = ent.lastIndex; continue; }
    }

    let j = i + 1;
    while (j < n && code[j] !== '<' && code[j] !== '&') j += 1;
    push(T.PLAIN, code.slice(i, j));
    i = j;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

const MD_FENCE = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const MD_HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const MD_RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/;
const MD_QUOTE = /^(\s*>+\s?)/;

function scanMarkdownInline(line, out) {
  const push = (type, value) => { if (value) out.push({ type, value }); };
  const n = line.length;
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { push(T.PLAIN, plain); plain = ''; } };

  while (i < n) {
    const rest = line.slice(i);

    const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest) || /^(`+)\1?/.exec(rest);
    if (rest[0] === '`' && code && code[0].length > 1) {
      flush();
      push(T.STRING, code[0]);
      i += code[0].length;
      continue;
    }

    const link = /^(!?\[)([^\]]*)(\]\()([^)\s]*)((?:\s+"[^"]*")?)(\))/.exec(rest);
    if (link) {
      flush();
      push(T.PUNCT, link[1]);
      push(T.LINK, link[2]);
      push(T.PUNCT, link[3]);
      push(T.STRING, link[4] + link[5]);
      push(T.PUNCT, link[6]);
      i += link[0].length;
      continue;
    }

    const auto = /^<(?:https?|mailto):[^>\s]+>/.exec(rest);
    if (auto) { flush(); push(T.LINK, auto[0]); i += auto[0].length; continue; }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) { flush(); push(T.STRONG, strong[0]); i += strong[0].length; continue; }

    const em = /^([*_])(?=\S)([^*_]*?\S)\1/.exec(rest);
    if (em) { flush(); push(T.EMPHASIS, em[0]); i += em[0].length; continue; }

    plain += line[i];
    i += 1;
  }
  flush();
}

function scanMarkdown(code) {
  const out = [];
  const push = (type, value) => { if (value) out.push({ type, value }); };
  const lines = code.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fence = MD_FENCE.exec(line);

    if (fence) {
      push(T.PUNCT, line);
      i += 1;
      if (i < lines.length) push(T.WS, '\n');

      const marker = fence[2][0];
      const body = [];
      let closer = null;
      while (i < lines.length) {
        const candidate = lines[i];
        if (candidate.trimStart().startsWith(marker.repeat(3)) && candidate.trim().replace(new RegExp('^\\' + marker + '+'), '') === '') {
          closer = candidate;
          i += 1;
          break;
        }
        body.push(candidate);
        i += 1;
      }

      const inner = body.length ? body.join('\n') + '\n' : '';
      if (inner) {
        const lang = normalizeLanguage(fence[3] || 'text');
        for (const t of tokenize(inner, lang)) out.push(t);
      }
      if (closer !== null) {
        push(T.PUNCT, closer);
        if (i < lines.length) push(T.WS, '\n');
      }
      continue;
    }

    if (MD_HEADING.test(line)) {
      push(T.HEADING, line);
    } else if (MD_RULE.test(line) && line.trim() !== '') {
      push(T.PUNCT, line);
    } else {
      let rest = line;
      const quote = MD_QUOTE.exec(rest);
      if (quote) { push(T.QUOTE, quote[1]); rest = rest.slice(quote[1].length); }
      const list = MD_LIST.exec(rest);
      if (list) {
        push(T.WS, list[1]);
        push(T.LIST, list[2]);
        push(T.WS, list[3]);
        rest = rest.slice(list[0].length);
      }
      scanMarkdownInline(rest, out);
    }

    i += 1;
    if (i < lines.length) push(T.WS, '\n');
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

/**
 * Scan source into a token stream. Concatenating every `value` reproduces
 * `code` exactly.
 *
 * @param {string} code
 * @param {string} lang language id, alias or extension
 * @returns {{type:string, value:string}[]}
 */
export function tokenize(code, lang) {
  const text = code == null ? '' : String(code);
  if (text === '') return [];
  const id = normalizeLanguage(lang);

  if (id === 'html') return scanHtml(text);
  if (id === 'css') return scanCss(text);
  if (id === 'markdown') return scanMarkdown(text);
  if (id === 'json') return scanJson(text);

  const cfg = CONFIGS[id] || CONFIGS.text;
  return scanGeneric(text, cfg);
}

/**
 * Split a token stream by line. Newline characters are dropped; every line is
 * an array of tokens whose values join back to that line's text.
 *
 * @param {string} code
 * @param {string} lang
 * @returns {{type:string, value:string}[][]}
 */
export function tokenizeLines(code, lang) {
  const lines = [[]];
  for (const token of tokenize(code, lang)) {
    if (token.value.indexOf('\n') < 0) {
      lines[lines.length - 1].push(token);
      continue;
    }
    const parts = token.value.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push([]);
      if (parts[i]) lines[lines.length - 1].push({ type: token.type, value: parts[i] });
    }
  }
  return lines;
}

/**
 * Build DOM for a token array. Every span receives its text through
 * `textContent`, so no source text is ever parsed as markup.
 *
 * @param {{type:string, value:string}[]} tokens
 * @returns {DocumentFragment}
 */
export function renderTokens(tokens) {
  const fragment = document.createDocumentFragment();
  if (!Array.isArray(tokens)) return fragment;
  for (const token of tokens) {
    if (!token || !token.value) continue;
    if (token.type === T.WS || token.type === T.PLAIN) {
      fragment.appendChild(document.createTextNode(token.value));
      continue;
    }
    const span = document.createElement('span');
    span.className = `tok tok-${token.type}`;
    span.textContent = token.value;
    fragment.appendChild(span);
  }
  return fragment;
}

/**
 * @param {string} code
 * @param {string} lang
 * @returns {DocumentFragment}
 */
export function highlight(code, lang) {
  return renderTokens(tokenize(code, lang));
}
