/**
 * Pine Script tokenizer.
 *
 * Pine reads like Python: one statement per line, blocks marked by indentation, and a
 * statement may run on while a bracket stays open. So the tokenizer stops at the shape of
 * a *line*, not just a stream of tokens: it drops comments, keeps the leading indent of
 * each statement line, and swallows the newline wherever a bracket is still open or the
 * line ends on a comma or an operator.
 *
 * Hand-written and dependency-free on purpose: the converter has to run offline inside the
 * script sandbox's bundle with nothing new installed.
 */

/** One token of a statement line. Newlines and indentation are not tokens; lines are. */
export type TokenKind = 'ident' | 'number' | 'string' | 'operator';

export interface Token {
  kind: TokenKind;
  text: string;
  /** 1-based line of the original source the token came from. */
  line: number;
  /** 1-based column, so an error can point at the token rather than the statement. */
  column: number;
}

/** One statement's worth of tokens, with the indent that introduced it. */
export interface PineLine {
  indent: number;
  line: number;
  tokens: Token[];
}

/** A tokenizer failure: always carries the line it happened on. */
export class PineSyntaxError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
    this.name = 'PineSyntaxError';
  }
}

/** Longest first, so `:=` never lexes as `:` then `=`. */
const OPERATORS: readonly string[] = [
  ':=', '=>', '==', '!=', '<>', '>=', '<=', '&&', '||', '**', '<<', '>>',
  '+', '-', '*', '/', '%', '^', '=', '<', '>', '!', '?', ':', ',', '.', ';', '(', ')', '[', ']', '{', '}', '&', '|', '~', '@',
];

/** Operators that leave a statement unfinished, so the next line continues it. */
// `=>` is deliberately absent: a line that ends on it opens an indented body, which is how
// Pine writes `f(a, b) =>` followed by the expression on the next line.
const CONTINUING: readonly string[] = [
  ':=', '==', '!=', '<>', '>=', '<=', '&&', '||', '**', '+', '-', '*', '/', '%', '^', '=', '<', '>', '?', ':', ',', '.', '&', '|',
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_BODY = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/** Turns Pine source into statement lines. Blank and comment-only lines disappear. */
export function tokenize(source: string): PineLine[] {
  const lines: PineLine[] = [];
  let tokens: Token[] = [];
  let depth = 0;
  /** Leading whitespace of the physical line being read, and the indent of the statement being built. */
  let columnIndent = 0;
  let statementIndent = 0;
  let lineOfStatement = 0;
  let index = 0;
  let lineNumber = 1;
  let column = 1;
  let atLineStart = true;

  const pushLine = () => {
    if (tokens.length > 0) lines.push({ indent: statementIndent, line: lineOfStatement, tokens });
    tokens = [];
    lineOfStatement = 0;
    atLineStart = true;
  };

  while (index < source.length) {
    const ch = source[index] ?? '';

    if (ch === '\n') {
      // A statement continues while a bracket is open or the line broke off after an
      // operator or a comma; anything else ends it.
      if (depth === 0 && !endsContinuation(tokens)) pushLine();
      lineNumber += 1;
      column = 1;
      columnIndent = 0;
      index += 1;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      // Whitespace only counts as indentation while the line has produced nothing yet.
      if (atLineStart && tokens.length === 0 && ch !== '\r') columnIndent += ch === '\t' ? 4 : 1;
      if (ch === '\r') index += 1;
      else {
        index += 1;
        column += 1;
      }
      continue;
    }

    if (atLineStart) {
      // The first real character of a line opens a statement, unless a previous line left
      // one open, in which case the original indent is what the block structure needs.
      if (tokens.length === 0) {
        statementIndent = columnIndent;
        lineOfStatement = lineNumber;
      }
      atLineStart = false;
    }

    if (ch === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let text = '';
      index += 1;
      column += 1;
      while (index < source.length) {
        const c = source[index] ?? '';
        if (c === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1] ?? '';
          text += escaped === 'n' ? '\n' : escaped;
          index += 2;
          column += 2;
          continue;
        }
        if (c === quote) break;
        if (c === '\n') throw new PineSyntaxError('unterminated string', lineNumber);
        text += c;
        index += 1;
        column += 1;
      }
      if (source[index] !== quote) throw new PineSyntaxError('unterminated string', lineNumber);
      index += 1;
      column += 1;
      tokens.push({ kind: 'string', text, line: lineNumber, column });
      continue;
    }

    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(source[index + 1] ?? ''))) {
      const start = index;
      while (index < source.length && DIGIT.test(source[index] ?? '')) index += 1;
      if (source[index] === '.') {
        index += 1;
        while (index < source.length && DIGIT.test(source[index] ?? '')) index += 1;
      }
      if (source[index] === 'e' || source[index] === 'E') {
        index += 1;
        if (source[index] === '+' || source[index] === '-') index += 1;
        while (index < source.length && DIGIT.test(source[index] ?? '')) index += 1;
      }
      const text = source.slice(start, index);
      tokens.push({ kind: 'number', text, line: lineNumber, column });
      column += text.length;
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = index;
      while (index < source.length && IDENT_BODY.test(source[index] ?? '')) index += 1;
      const text = source.slice(start, index);
      tokens.push({ kind: 'ident', text, line: lineNumber, column });
      column += text.length;
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (!operator) throw new PineSyntaxError(`unexpected character ${JSON.stringify(ch)}`, lineNumber);
    if (operator === '(' || operator === '[' || operator === '{') depth += 1;
    if (operator === ')' || operator === ']' || operator === '}') depth = Math.max(0, depth - 1);
    tokens.push({ kind: 'operator', text: operator, line: lineNumber, column });
    index += operator.length;
    column += operator.length;
  }

  if (tokens.length > 0) lines.push({ indent: statementIndent, line: lineOfStatement || lineNumber, tokens });
  if (depth > 0) {
    const last = lines[lines.length - 1];
    if (last) throw new PineSyntaxError('a bracket opened here is never closed', last.line);
  }
  return lines;
}

/** True when the line so far ends on something that must be followed by more source. */
function endsContinuation(tokens: readonly Token[]): boolean {
  const last = tokens[tokens.length - 1];
  if (!last || last.kind !== 'operator') return false;
  return CONTINUING.includes(last.text);
}
