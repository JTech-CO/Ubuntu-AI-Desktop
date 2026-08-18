/**
 * js/apps/calculator/engine.js — expression engine for GNOME Calculator.
 *
 * A hand-written tokenizer feeding a precedence-climbing parser and a tree
 * walking evaluator. There is deliberately no `eval` and no `new Function`
 * anywhere in this file: everything the calculator computes goes through the
 * AST below, so a malformed expression produces a diagnostic instead of
 * executing arbitrary script.
 *
 * Grammar (precedence climbing, lowest binding first):
 *
 *   expression := unary ( binop expression )*
 *   binop      := '+' | '-'            prec 1, left
 *               | '*' | '/' | 'mod'    prec 2, left
 *               | '^'                  prec 4, right
 *   unary      := ('-' | '+') expression(3) | postfix
 *   postfix    := primary ( '!' | '%' )*
 *   primary    := number | constant | ident '(' args ')' | ident unary
 *               | '(' expression(0) ')'
 *
 * Juxtaposition is implicit multiplication at precedence 2, so `2(3+4)`,
 * `2π` and `3sin(30)` all parse the way a calculator user expects.
 */

/** Thrown for every tokenizer, parser and evaluation failure. */
export class CalcError extends Error {
  /**
   * @param {string} message human-readable, shown under the display
   * @param {number} [position] index into the source expression
   */
  constructor(message, position = -1) {
    super(message);
    this.name = 'CalcError';
    this.position = position;
  }
}

/* ------------------------------------------------------------------ *
 * tokenizer
 * ------------------------------------------------------------------ */

/** Unicode operator glyphs the buttons emit, mapped to their ASCII form. */
const OPERATOR_ALIASES = new Map([
  ['×', '*'],
  ['·', '*'],
  ['÷', '/'],
  ['−', '-'],
  ['–', '-'],
  ['—', '-'],
  ['＋', '+'],
]);

const CONSTANTS = new Map([
  ['pi', Math.PI],
  ['π', Math.PI],
  ['e', Math.E],
  ['tau', Math.PI * 2],
  ['τ', Math.PI * 2],
  ['phi', (1 + Math.sqrt(5)) / 2],
  ['φ', (1 + Math.sqrt(5)) / 2],
]);

/** Function arity: every entry takes exactly one argument unless listed. */
const FUNCTION_ARITY = new Map([
  ['log', 1],
  ['root', 2],
  ['min', 2],
  ['max', 2],
]);

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'ln', 'log', 'log2', 'exp',
  'sqrt', 'cbrt', 'root', 'abs', 'sign', 'sgn',
  'round', 'floor', 'ceil', 'trunc', 'frac',
  'min', 'max',
]);

const IDENT_START = /[A-Za-zπτφ√∛]/;
const IDENT_PART = /[A-Za-z0-9πτφ]/;

/**
 * Split an expression into tokens.
 * @param {string} input
 * @returns {{type:string, value:any, position:number}[]}
 */
export function tokenize(input) {
  const source = String(input);
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '_') {
      // Thousands separators and whitespace are ignored between tokens, but a
      // comma inside a function call is a real separator.
      if (ch === ',') tokens.push({ type: 'comma', value: ',', position: i });
      i += 1;
      continue;
    }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i])) i += 1;
      if (source[i] === '.') {
        i += 1;
        while (i < source.length && /[0-9]/.test(source[i])) i += 1;
      }
      if ((source[i] === 'e' || source[i] === 'E') && /[0-9+-]/.test(source[i + 1] || '')) {
        const mark = i;
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        if (/[0-9]/.test(source[i] || '')) {
          while (i < source.length && /[0-9]/.test(source[i])) i += 1;
        } else {
          i = mark;
        }
      }
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new CalcError(`Malformed number “${text}”`, start);
      tokens.push({ type: 'number', value, position: start });
      continue;
    }

    if (ch === '√' || ch === '∛') {
      tokens.push({ type: 'ident', value: ch === '√' ? 'sqrt' : 'cbrt', position: i });
      i += 1;
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < source.length && IDENT_PART.test(source[i])) i += 1;
      const raw = source.slice(start, i);
      const lower = raw.toLowerCase();
      if (lower === 'mod') tokens.push({ type: 'operator', value: 'mod', position: start });
      else tokens.push({ type: 'ident', value: lower, position: start });
      continue;
    }

    const mapped = OPERATOR_ALIASES.get(ch) || ch;

    if (mapped === '*' && source[i + 1] === '*') {
      tokens.push({ type: 'operator', value: '^', position: i });
      i += 2;
      continue;
    }

    if ('+-*/^'.includes(mapped)) {
      tokens.push({ type: 'operator', value: mapped, position: i });
      i += 1;
      continue;
    }

    if (mapped === '(' || mapped === ')') {
      tokens.push({ type: mapped === '(' ? 'lparen' : 'rparen', value: mapped, position: i });
      i += 1;
      continue;
    }

    if (mapped === '!' || mapped === '%') {
      tokens.push({ type: 'postfix', value: mapped, position: i });
      i += 1;
      continue;
    }

    throw new CalcError(`Unexpected character “${ch}”`, i);
  }

  tokens.push({ type: 'eof', value: null, position: source.length });
  return tokens;
}

/* ------------------------------------------------------------------ *
 * parser
 * ------------------------------------------------------------------ */

const BINARY = new Map([
  ['+', { precedence: 1, right: false }],
  ['-', { precedence: 1, right: false }],
  ['*', { precedence: 2, right: false }],
  ['/', { precedence: 2, right: false }],
  ['mod', { precedence: 2, right: false }],
  ['^', { precedence: 4, right: true }],
]);

/** Precedence of an implied multiplication between juxtaposed operands. */
const IMPLICIT_PRECEDENCE = 2;

/**
 * Parse a token stream into an AST.
 * @param {{type:string, value:any, position:number}[]} tokens
 * @returns {object} AST root
 */
export function parse(tokens) {
  let index = 0;

  const peek = () => tokens[index];
  const next = () => tokens[index++];

  function expect(type, what) {
    const token = peek();
    if (token.type !== type) {
      throw new CalcError(`Expected ${what}`, token.position);
    }
    return next();
  }

  /** True when the next token could start a fresh operand. */
  function startsOperand() {
    const token = peek();
    return token.type === 'number' || token.type === 'ident' || token.type === 'lparen';
  }

  function parsePrimary() {
    const token = peek();

    if (token.type === 'number') {
      next();
      return { type: 'number', value: token.value };
    }

    if (token.type === 'lparen') {
      next();
      const inner = parseExpression(0);
      expect('rparen', 'a closing parenthesis');
      return inner;
    }

    if (token.type === 'ident') {
      next();
      const name = token.value;
      if (CONSTANTS.has(name)) return { type: 'constant', name, value: CONSTANTS.get(name) };
      if (!FUNCTIONS.has(name)) throw new CalcError(`Unknown function or constant “${name}”`, token.position);

      const arity = FUNCTION_ARITY.get(name) || 1;
      if (peek().type === 'lparen') {
        next();
        const args = [];
        if (peek().type !== 'rparen') {
          args.push(parseExpression(0));
          while (peek().type === 'comma') {
            next();
            args.push(parseExpression(0));
          }
        }
        expect('rparen', 'a closing parenthesis');
        if (args.length === 0) throw new CalcError(`${name}() needs an argument`, token.position);
        if (name === 'log' && args.length > 2) throw new CalcError('log() takes at most two arguments', token.position);
        if (name !== 'log' && args.length !== arity) {
          throw new CalcError(`${name}() takes ${arity} argument${arity === 1 ? '' : 's'}`, token.position);
        }
        return { type: 'call', name, args, position: token.position };
      }

      if (arity > 1) throw new CalcError(`${name}() needs parentheses`, token.position);
      // `sin 30`, `√2` — a bare function binds tighter than * and /.
      const argument = parseExpression(3);
      return { type: 'call', name, args: [argument], position: token.position };
    }

    if (token.type === 'operator' || token.type === 'postfix') {
      throw new CalcError(`Misplaced operator “${token.value}”`, token.position);
    }

    throw new CalcError('Incomplete expression', token.position);
  }

  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      const token = peek();
      if (token.type !== 'postfix') break;
      next();
      node = { type: 'postfix', op: token.value, argument: node, position: token.position };
    }
    return node;
  }

  function parseUnary() {
    const token = peek();
    if (token.type === 'operator' && (token.value === '-' || token.value === '+')) {
      next();
      // Precedence 3 sits below `^`, so `-2^2` is -(2^2), as on real hardware.
      const argument = parseExpression(3);
      return token.value === '-' ? { type: 'negate', argument } : argument;
    }
    return parsePostfix();
  }

  function parseExpression(minPrecedence) {
    let left = parseUnary();

    for (;;) {
      const token = peek();
      let op = null;
      let info = null;
      let implicit = false;

      if (token.type === 'operator' && BINARY.has(token.value)) {
        op = token.value;
        info = BINARY.get(op);
      } else if (startsOperand()) {
        op = '*';
        info = { precedence: IMPLICIT_PRECEDENCE, right: false };
        implicit = true;
      } else {
        break;
      }

      if (info.precedence < minPrecedence) break;
      if (!implicit) next();

      const nextMin = info.right ? info.precedence : info.precedence + 1;
      const right = parseExpression(nextMin);
      left = { type: 'binary', op, left, right, position: token.position };
    }

    return left;
  }

  const ast = parseExpression(0);
  const trailing = peek();
  if (trailing.type !== 'eof') {
    throw new CalcError(`Unexpected “${trailing.value}”`, trailing.position);
  }
  return ast;
}

/* ------------------------------------------------------------------ *
 * evaluator
 * ------------------------------------------------------------------ */

const DEG = Math.PI / 180;
const GRAD = Math.PI / 200;

function toRadians(value, unit) {
  if (unit === 'deg') return value * DEG;
  if (unit === 'grad') return value * GRAD;
  return value;
}

function fromRadians(value, unit) {
  if (unit === 'deg') return value / DEG;
  if (unit === 'grad') return value / GRAD;
  return value;
}

function factorial(n) {
  if (!Number.isFinite(n)) throw new CalcError('Factorial is only defined for whole numbers');
  if (Math.abs(n - Math.round(n)) > 1e-9) throw new CalcError('Factorial is only defined for whole numbers');
  const value = Math.round(n);
  if (value < 0) throw new CalcError('Factorial is only defined for non-negative numbers');
  if (value > 170) throw new CalcError('Overflow: the result is too large to display');
  let out = 1;
  for (let i = 2; i <= value; i += 1) out *= i;
  return out;
}

function guard(value, message) {
  if (Number.isNaN(value)) throw new CalcError(message);
  if (!Number.isFinite(value)) throw new CalcError('Overflow: the result is too large to display');
  return value;
}

/**
 * Walk an AST.
 * @param {object} node
 * @param {{angleUnit?:'deg'|'rad'|'grad'}} [opts]
 * @returns {number}
 */
export function evaluate(node, opts = {}) {
  const unit = opts.angleUnit === 'rad' || opts.angleUnit === 'grad' ? opts.angleUnit : 'deg';

  switch (node.type) {
    case 'number':
    case 'constant':
      return node.value;

    case 'negate':
      return -evaluate(node.argument, opts);

    case 'postfix': {
      const value = evaluate(node.argument, opts);
      if (node.op === '!') return factorial(value);
      return value / 100;
    }

    case 'binary': {
      const left = evaluate(node.left, opts);
      const right = evaluate(node.right, opts);
      switch (node.op) {
        case '+':
          return guard(left + right, 'Undefined result');
        case '-':
          return guard(left - right, 'Undefined result');
        case '*':
          return guard(left * right, 'Undefined result');
        case '/':
          if (right === 0) throw new CalcError('Division by zero is undefined', node.position);
          return guard(left / right, 'Undefined result');
        case 'mod':
          if (right === 0) throw new CalcError('Division by zero is undefined', node.position);
          return left - right * Math.floor(left / right);
        case '^': {
          if (left < 0 && Math.abs(right - Math.round(right)) > 1e-12) {
            throw new CalcError('The power of a negative number must be a whole number', node.position);
          }
          return guard(left ** right, 'Undefined result');
        }
        default:
          throw new CalcError(`Unknown operator “${node.op}”`, node.position);
      }
    }

    case 'call': {
      const args = node.args.map((arg) => evaluate(arg, opts));
      const [a, b] = args;
      switch (node.name) {
        case 'sin':
          return Math.sin(toRadians(a, unit));
        case 'cos':
          return Math.cos(toRadians(a, unit));
        case 'tan': {
          const radians = toRadians(a, unit);
          const cosine = Math.cos(radians);
          if (Math.abs(cosine) < 1e-12) throw new CalcError('Tangent is undefined here', node.position);
          return Math.sin(radians) / cosine;
        }
        case 'asin':
          if (a < -1 || a > 1) throw new CalcError('Inverse sine needs a value between -1 and 1', node.position);
          return fromRadians(Math.asin(a), unit);
        case 'acos':
          if (a < -1 || a > 1) throw new CalcError('Inverse cosine needs a value between -1 and 1', node.position);
          return fromRadians(Math.acos(a), unit);
        case 'atan':
          return fromRadians(Math.atan(a), unit);
        case 'sinh':
          return guard(Math.sinh(a), 'Undefined result');
        case 'cosh':
          return guard(Math.cosh(a), 'Undefined result');
        case 'tanh':
          return Math.tanh(a);
        case 'asinh':
          return Math.asinh(a);
        case 'acosh':
          if (a < 1) throw new CalcError('Inverse hyperbolic cosine needs a value of 1 or more', node.position);
          return Math.acosh(a);
        case 'atanh':
          if (a <= -1 || a >= 1) throw new CalcError('Inverse hyperbolic tangent needs a value between -1 and 1', node.position);
          return Math.atanh(a);
        case 'ln':
          if (a <= 0) throw new CalcError('The logarithm of zero or a negative number is undefined', node.position);
          return Math.log(a);
        case 'log':
          if (a <= 0) throw new CalcError('The logarithm of zero or a negative number is undefined', node.position);
          if (args.length === 2) {
            if (b <= 0 || b === 1) throw new CalcError('Invalid logarithm base', node.position);
            return Math.log(a) / Math.log(b);
          }
          return Math.log10(a);
        case 'log2':
          if (a <= 0) throw new CalcError('The logarithm of zero or a negative number is undefined', node.position);
          return Math.log2(a);
        case 'exp':
          return guard(Math.exp(a), 'Undefined result');
        case 'sqrt':
          if (a < 0) throw new CalcError('The square root of a negative number is undefined', node.position);
          return Math.sqrt(a);
        case 'cbrt':
          return Math.cbrt(a);
        case 'root':
          if (b === 0) throw new CalcError('The zeroth root is undefined', node.position);
          if (a < 0 && Math.abs(b % 2) !== 1) {
            throw new CalcError('Even roots of a negative number are undefined', node.position);
          }
          return a < 0 ? -((-a) ** (1 / b)) : a ** (1 / b);
        case 'abs':
          return Math.abs(a);
        case 'sign':
        case 'sgn':
          return Math.sign(a);
        case 'round':
          return Math.round(a);
        case 'floor':
          return Math.floor(a);
        case 'ceil':
          return Math.ceil(a);
        case 'trunc':
          return Math.trunc(a);
        case 'frac':
          return a - Math.trunc(a);
        case 'min':
          return Math.min(a, b);
        case 'max':
          return Math.max(a, b);
        default:
          throw new CalcError(`Unknown function “${node.name}”`, node.position);
      }
    }

    default:
      throw new CalcError('Malformed expression');
  }
}

/**
 * Tokenize, parse and evaluate in one step.
 * @param {string} input
 * @param {{angleUnit?:'deg'|'rad'|'grad'}} [opts]
 * @returns {number}
 */
export function calculate(input, opts = {}) {
  const text = String(input).trim();
  if (text === '') throw new CalcError('Nothing to calculate');
  return evaluate(parse(tokenize(text)), opts);
}

/* ------------------------------------------------------------------ *
 * result formatting
 * ------------------------------------------------------------------ */

/** GNOME Calculator's default precision. */
const SIGNIFICANT_DIGITS = 9;

/**
 * Render a result the way GNOME Calculator does: up to nine significant
 * digits, no trailing zeros, scientific notation only at the extremes.
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : value < 0 ? '−∞' : 'undefined';
  if (value === 0) return '0';

  const magnitude = Math.abs(value);
  let text;

  if (magnitude >= 1e12 || magnitude < 1e-9) {
    text = value.toExponential(SIGNIFICANT_DIGITS - 1);
    const [mantissa, exponent] = text.split('e');
    const trimmed = mantissa.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const sign = exponent.startsWith('-') ? '−' : '';
    text = `${trimmed}×10^${sign}${exponent.replace(/^[+-]/, '')}`;
  } else {
    const decimals = Math.max(0, SIGNIFICANT_DIGITS - Math.floor(Math.log10(magnitude)) - 1);
    text = value.toFixed(Math.min(20, decimals));
    if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
    // -0 can survive the round-trip; normalise it away.
    if (text === '-0') text = '0';
  }

  return text.replace(/^-/, '−');
}

/**
 * Group the integer part with thin spaces, as the GNOME display does.
 * @param {string} formatted output of {@link formatNumber}
 * @returns {string}
 */
export function groupDigits(formatted) {
  const match = /^(−?)(\d+)(\.\d+)?(.*)$/.exec(formatted);
  if (!match) return formatted;
  const [, sign, integer, fraction = '', tail = ''] = match;
  if (integer.length <= 4) return formatted;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${grouped}${fraction}${tail}`;
}
