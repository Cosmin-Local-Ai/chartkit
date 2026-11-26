/**
 * Statement and expression parser for the Pine subset.
 *
 * Statements come one per line, and a block is the run of lines indented past its header,
 * which is what lets an `if` body be read without braces. Constructs outside the subset —
 * loops, `switch`, user types — are read as a header line plus whatever it indents, and
 * kept as an `unsupported` statement: the converter then reports all of them at once, each
 * with its own line, rather than failing on the first.
 */

import type { PineLine, Token } from './lexer';
import { PineSyntaxError } from './lexer';
import type { CallArgument, Expr, FunctionParam, Stmt } from './ast';

/** Words Pine reserves; a script cannot use them as variable names. */
const RESERVED = new Set(['if', 'else', 'var', 'for', 'while', 'switch', 'function', 'type', 'method', 'enum', 'namespace', 'import', 'export', 'break', 'continue', 'try', 'catch', 'throw', 'and', 'or', 'not', 'to', 'by', 'const']);

/** Statement headers outside the subset, with the reason the converter gives for each. */
const BLOCK_CONSTRUCTS: Record<string, string> = {
  for: 'a for loop',
  while: 'a while loop',
  switch: 'a switch statement',
  type: 'a user-defined type',
  method: 'a user-defined method',
  enum: 'an enum',
  namespace: 'a namespace',
  matrix: 'a matrix',
  import: 'an import',
  export: 'an export',
  const: 'a const declaration',
  try: 'a try/catch block',
  throw: 'a throw statement',
  delete: 'a delete statement',
};

/** Types that may follow `var`, and are part of the declaration rather than the name. */
const TYPE_WORDS = new Set(['int', 'float', 'bool', 'string', 'color', 'time', 'session', 'source', 'simple', 'input', 'series', 'const', 'matrix', 'array', 'map', 'void', 'number']);

export function parse(lines: readonly PineLine[]): Stmt[] {
  return new Parser(lines).program();
}

class Parser {
  private index = 0;

  constructor(private readonly lines: readonly PineLine[]) {}

  program(): Stmt[] {
    const out: Stmt[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (!line) break;
      if (line.indent !== 0) throw new PineSyntaxError('unexpected indentation at the top level', line.line);
      out.push(this.statement());
    }
    return out;
  }

  /** Every line indented past `indent`, which is one block. */
  private block(indent: number): Stmt[] {
    const out: Stmt[] = [];
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (!line || line.indent <= indent) break;
      out.push(this.statement());
    }
    return out;
  }

  private statement(): Stmt {
    const line = this.lines[this.index];
    if (!line) throw new PineSyntaxError('unexpected end of script', this.lines[this.lines.length - 1]?.line ?? 1);
    const [first] = line.tokens;

    if (first?.kind === 'ident' && first.text === 'if') return this.ifStatement();
    if (first?.kind === 'ident' && first.text === 'else') {
      // Reached only when an `else` has no matching `if` above it.
      this.index += 1;
      return { kind: 'unsupported', reason: 'an else with no matching if', text: textOf(line.tokens), line: line.line };
    }
    const construct = first?.kind === 'ident' ? BLOCK_CONSTRUCTS[first.text] : undefined;
    if (construct) {
      this.index += 1;
      const body = this.block(line.indent);
      void body;
      return { kind: 'unsupported', reason: construct, text: textOf(line.tokens), line: line.line };
    }
    if (first?.kind === 'ident' && (first.text === 'break' || first.text === 'continue')) {
      this.index += 1;
      return { kind: 'unsupported', reason: `loops (${first.text})`, text: textOf(line.tokens), line: line.line };
    }
    if (first?.kind === 'ident' && first.text === 'function') return this.functionStatement();
    if (first?.kind === 'ident' && first.text === 'var') return this.assignment();
    if (isLineFunctionDeclaration(line.tokens)) return this.functionStatement();
    if (first?.kind === 'operator' && first.text === '=>') {
      this.index += 1;
      return { kind: 'unsupported', reason: 'a return outside a function', text: textOf(line.tokens), line: line.line };
    }
    return this.assignmentOrExpression();
  }

  private ifStatement(): Stmt {
    const line = this.lines[this.index];
    if (!line) throw new PineSyntaxError('unexpected end of script', 0);
    this.index += 1;
    let condition = parseTokens(line.tokens.slice(1), line.line, 'if condition');
    let body: Stmt[];
    let otherwise: Stmt[] | null = null;

    const short = splitShortIf(line.tokens.slice(1));
    if (short) {
      // `if cond => x := 1`, the one-line form Pine also accepts.
      condition = parseTokens(short.before, line.line, 'if condition');
      body = parseStatementList(short.after, line.line, line.indent + 1);
    } else {
      body = this.block(line.indent);
    }

    const next = this.lines[this.index];
    if (next && next.indent === line.indent && next.tokens[0]?.kind === 'ident' && next.tokens[0].text === 'else') {
      this.index += 1;
      const elseLine = this.lines[this.index - 1];
      const elseTokens = elseLine?.tokens.slice(1) ?? [];
      const elseShort = splitShortIf(elseTokens);
      if (elseTokens[0]?.kind === 'ident' && elseTokens[0].text === 'if') {
        otherwise = [this.ifStatement()];
      } else if (elseShort) {
        otherwise = parseStatementList(elseShort.after, elseLine?.line ?? line.line, line.indent + 1);
      } else {
        otherwise = this.block(line.indent);
      }
    }

    return { kind: 'if', condition, body, otherwise, line: line.line };
  }

  /** `function name(a, b) => expr`, or the same with an indented body. */
  private functionStatement(): Stmt {
    const line = this.lines[this.index];
    if (!line) throw new PineSyntaxError('unexpected end of script', 0);
    const tokens = [...line.tokens];
    if (tokens[0]?.kind === 'ident' && tokens[0].text === 'function') tokens.shift();
    const name = tokens.shift();
    if (!name || name.kind !== 'ident') throw new PineSyntaxError('a function needs a name', line.line);
    const params = readFormalParameters(tokens, line.line);
    const arrow = tokens.shift();
    if (!arrow || (arrow.text !== '=>' && arrow.text !== '=')) {
      this.index += 1;
      return { kind: 'unsupported', reason: 'a function declaration without a `=>` body', text: textOf(line.tokens), line: line.line };
    }
    this.index += 1;
    if (tokens.length > 0) {
      return { kind: 'function', name: name.text, params, body: [], returns: parseTokens(tokens, line.line, 'function body'), line: line.line };
    }
    const body = this.block(line.indent);
    const last = body[body.length - 1];
    if (last && last.kind === 'expression') {
      body.pop();
      return { kind: 'function', name: name.text, params, body, returns: last.expr, line: line.line };
    }
    return { kind: 'unsupported', reason: 'a function whose body does not end with a value', text: textOf(line.tokens), line: line.line };
  }

  private assignment(): Stmt {
    const line = this.lines[this.index];
    if (!line) throw new PineSyntaxError('unexpected end of script', 0);
    this.index += 1;
    const tokens = [...line.tokens];
    let declared = false;
    let variable = false;
    if (tokens[0]?.kind === 'ident' && tokens[0].text === 'var') {
      tokens.shift();
      variable = true;
      declared = true;
      while (tokens[0]?.kind === 'ident' && TYPE_WORDS.has(tokens[0].text) && tokens[1]?.kind === 'ident') tokens.shift();
    }
    const target = readTarget(tokens, line.line);
    const op = tokens.shift();
    if (!op || (op.text !== '=' && op.text !== ':=')) {
      throw new PineSyntaxError(`line ${line.line}: expected \`=\` or \`:=\``, line.line);
    }
    const expr = parseTokens(tokens, line.line, 'assignment');
    return { kind: 'assign', target, declared: declared || op.text === '=', variable, expr, line: line.line };
  }

  private assignmentOrExpression(): Stmt {
    const line = this.lines[this.index];
    if (!line) throw new PineSyntaxError('unexpected end of script', 0);
    const split = findAssignmentOperator(line.tokens);
    if (split >= 0) return this.assignment();
    this.index += 1;
    return { kind: 'expression', expr: parseTokens(line.tokens, line.line, 'statement'), line: line.line };
  }
}

/** True for `name(a, b) => …`, the v4/v5 way to declare a function. */
function isLineFunctionDeclaration(tokens: readonly Token[]): boolean {
  return tokens[0]?.kind === 'ident' && tokens[1]?.text === '(' && !RESERVED.has(tokens[0].text) && operatorIndex(tokens, '=>') > 0;
}

/** `[a, b]` or `name`, the left side of an assignment. */
function readTarget(tokens: Token[], line: number): Expr {
  if (tokens[0]?.text === '[') {
    tokens.shift();
    const close = scanClose(tokens, '[', ']');
    if (close < 0) throw new PineSyntaxError('a tuple assignment never closes its `[`', line);
    const inner = tokens.splice(0, close);
    tokens.shift();
    const items: Expr[] = [];
    for (const piece of splitTopLevel(inner, ',')) {
      const expr = parseTokens(piece, line, 'tuple name');
      if (expr.kind !== 'ident') throw new PineSyntaxError('a tuple slot must be a plain name', line);
      items.push(expr);
    }
    if (items.length === 0) throw new PineSyntaxError('a tuple assignment needs names', line);
    return { kind: 'tuple', items, line };
  }
  const name = tokens.shift();
  if (!name || name.kind !== 'ident') throw new PineSyntaxError('only a name may be assigned to', line);
  if (RESERVED.has(name.text)) throw new PineSyntaxError(`\`${name.text}\` is a Pine keyword`, line);
  return { kind: 'ident', name: name.text, line };
}

/** Index of the bracket closing a run whose opening bracket sits just before `tokens`. */
function scanClose(tokens: readonly Token[], open: string, close: string): number {
  let depth = 1;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.kind !== 'operator') continue;
    if (token.text === open) depth += 1;
    else if (token.text === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `=` or `:=` that separates a target from a value, or -1 for none. */
function findAssignmentOperator(tokens: readonly Token[]): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.kind === 'operator') {
      if (token.text === '(' || token.text === '[' || token.text === '{') depth += 1;
      else if (token.text === ')' || token.text === ']' || token.text === '}') depth -= 1;
      else if (depth === 0 && token.text === ':=') return i;
      else if (depth === 0 && token.text === '=') {
        // `a = b` assigns; `a == b` and a named argument inside brackets do not.
        if (tokens[i + 1]?.text === '=') continue;
        return i;
      }
    }
  }
  return -1;
}

function operatorIndex(tokens: readonly Token[], text: string): number {
  return tokens.findIndex((token) => token.kind === 'operator' && token.text === text);
}

/** `cond => body`: the two halves of a one-line `if`. */
function splitShortIf(tokens: readonly Token[]): { before: Token[]; after: Token[] } | null {
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.kind !== 'operator') continue;
    if (token.text === '(' || token.text === '[' || token.text === '{') depth += 1;
    else if (token.text === ')' || token.text === ']' || token.text === '}') depth -= 1;
    else if (depth === 0 && token.text === '=>') return { before: tokens.slice(0, i), after: tokens.slice(i + 1) };
  }
  return null;
}

/** `(a, b=2)` of a function declaration, with any type word dropped. */
function readFormalParameters(tokens: Token[], line: number): FunctionParam[] {
  const open = tokens.shift();
  if (!open || open.text !== '(') throw new PineSyntaxError('a function needs a parameter list', line);
  // The opening bracket is already off the list, so the depth starts as if it were still there.
  const closeIndex = matchingBracket(tokens, 0, 1);
  if (closeIndex < 0) throw new PineSyntaxError('a function parameter list is never closed', line);
  const inner = tokens.splice(0, closeIndex);
  tokens.shift();
  const out: FunctionParam[] = [];
  for (const piece of splitTopLevel(inner, ',')) {
    let rest = [...piece];
    while (rest.length > 1 && rest[0]?.kind === 'ident' && TYPE_WORDS.has(rest[0].text) && rest[1]?.kind === 'ident') rest.shift();
    const name = rest[0];
    if (!name || name.kind !== 'ident') throw new PineSyntaxError('a function parameter must be a plain name', line);
    const defaultValue = rest[1]?.text === '=' ? parseTokens(rest.slice(2), line, 'a parameter default') : null;
    out.push({ name: name.text, defaultValue });
  }
  return out;
}

function matchingBracket(tokens: readonly Token[], from: number, startDepth = 0): number {
  let depth = startDepth;
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.kind !== 'operator') continue;
    if (token.text === '(' || token.text === '[' || token.text === '{') depth += 1;
    else if (token.text === ')' || token.text === ']' || token.text === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(tokens: readonly Token[], separator: string): Token[][] {
  const out: Token[][] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.kind !== 'operator') continue;
    if (token.text === '(' || token.text === '[' || token.text === '{') depth += 1;
    else if (token.text === ')' || token.text === ']' || token.text === '}') depth -= 1;
    else if (depth === 0 && token.text === separator) {
      out.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  if (tokens.length > start || out.length === 0) out.push(tokens.slice(start));
  return out.filter((piece) => piece.length > 0);
}

/** One short statement list, used by the one-line `if cond => x := 1` form. */
function parseStatementList(tokens: readonly Token[], line: number, indent: number): Stmt[] {
  const out: Stmt[] = [];
  for (const piece of splitTopLevel(tokens, ';')) {
    if (piece.length === 0) continue;
    const split = findAssignmentOperator(piece);
    if (split < 0) {
      out.push({ kind: 'expression', expr: parseTokens(piece, line, 'statement'), line });
      continue;
    }
    const target = readTarget(piece.slice(0, split), line);
    const op = piece[split];
    out.push({
      kind: 'assign',
      target,
      declared: op?.text === '=',
      variable: false,
      expr: parseTokens(piece.slice(split + 1), line, 'assignment'),
      line,
    });
  }
  void indent;
  return out;
}

/* ------------------------------------------------------------------ expressions */

/** Parses a token run into one expression, rejecting anything trailing. */
export function parseTokens(tokens: readonly Token[], line: number, what: string): Expr {
  const reader = new ExpressionReader(tokens, line);
  const expr = reader.expression();
  if (!reader.done()) throw new PineSyntaxError(`unexpected ${JSON.stringify(reader.peek()?.text ?? '')} in ${what}`, line);
  return expr;
}

const COMPARISON = new Set(['==', '!=', '<>', '>=', '<=', '>', '<']);
const ADDITIVE = new Set(['+', '-']);
const MULTIPLICATIVE = new Set(['*', '/', '%']);

class ExpressionReader {
  private at = 0;

  constructor(private readonly tokens: readonly Token[], private readonly line: number) {}

  done(): boolean {
    return this.at >= this.tokens.length;
  }

  peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private isOperator(...texts: string[]): boolean {
    const token = this.peek();
    return !!token && token.kind === 'operator' && texts.includes(token.text);
  }

  private isWord(...texts: string[]): boolean {
    const token = this.peek();
    return !!token && token.kind === 'ident' && texts.includes(token.text);
  }

  private take(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new PineSyntaxError('the statement ends too early', this.line);
    this.at += 1;
    return token;
  }

  private node(node: Expr): Expr {
    return { ...node, line: node.line ?? this.line } as Expr;
  }

  expression(): Expr {
    return this.ternary();
  }

  private ternary(): Expr {
    const condition = this.logicalOr();
    if (!this.isOperator('?')) return condition;
    this.take();
    const whenTrue = this.ternary();
    if (!this.isOperator(':')) throw new PineSyntaxError('a `?` needs a `:`', this.line);
    this.take();
    const whenFalse = this.ternary();
    return this.node({ kind: 'ternary', condition, whenTrue, whenFalse, line: this.line });
  }

  private logicalOr(): Expr {
    let left = this.logicalAnd();
    while (this.isWord('or') || this.isOperator('||')) {
      this.take();
      left = this.node({ kind: 'binary', op: 'or', left, right: this.logicalAnd(), line: this.line });
    }
    return left;
  }

  private logicalAnd(): Expr {
    let left = this.logicalNot();
    while (this.isWord('and') || this.isOperator('&&')) {
      this.take();
      left = this.node({ kind: 'binary', op: 'and', left, right: this.logicalNot(), line: this.line });
    }
    return left;
  }

  private logicalNot(): Expr {
    if (this.isWord('not') || this.isOperator('!')) {
      this.take();
      return this.node({ kind: 'unary', op: 'not', operand: this.logicalNot(), line: this.line });
    }
    return this.comparison();
  }

  private comparison(): Expr {
    let left = this.additive();
    while (this.isOperator(...Array.from(COMPARISON))) {
      const op = this.take().text;
      left = this.node({ kind: 'binary', op, left, right: this.additive(), line: this.line });
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.isOperator(...Array.from(ADDITIVE))) {
      const op = this.take().text;
      left = this.node({ kind: 'binary', op, left, right: this.multiplicative(), line: this.line });
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.isOperator(...Array.from(MULTIPLICATIVE))) {
      const op = this.take().text;
      left = this.node({ kind: 'binary', op, left, right: this.unary(), line: this.line });
    }
    return left;
  }

  private unary(): Expr {
    if (this.isOperator('-', '+', '~')) {
      const op = this.take().text;
      return this.node({ kind: 'unary', op, operand: this.unary(), line: this.line });
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.postfix();
    if (this.isOperator('^', '**')) {
      this.take();
      return this.node({ kind: 'binary', op: '^', left: base, right: this.unary(), line: this.line });
    }
    return base;
  }

  private postfix(): Expr {
    let expr = this.primary();
    for (;;) {
      if (this.isOperator('.')) {
        this.take();
        const name = this.take();
        if (name.kind !== 'ident') throw new PineSyntaxError('a `.` must be followed by a name', this.line);
        expr = this.node({ kind: 'member', object: expr, name: name.text, line: this.line });
        continue;
      }
      if (this.isOperator('(')) {
        expr = this.node({ kind: 'call', callee: expr, args: this.arguments(), line: this.line });
        continue;
      }
      if (this.isOperator('[')) {
        this.take();
        const body = this.bracketBody('[', ']');
        expr = this.node({ kind: 'index', base: expr, offset: parseTokens(body, this.line, 'a history offset'), line: this.line });
        continue;
      }
      return expr;
    }
  }

  /** Consumes the tokens up to and including the bracket that closes one already opened. */
  private bracketBody(open: string, close: string): Token[] {
    let depth = 1;
    let i = this.at;
    for (; i < this.tokens.length; i += 1) {
      const token = this.tokens[i];
      if (!token || token.kind !== 'operator') continue;
      if (token.text === open) depth += 1;
      else if (token.text === close) {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth > 0) throw new PineSyntaxError(`a \`${open}\` is never closed`, this.line);
    const body = this.tokens.slice(this.at, i);
    this.at = i + 1;
    return body;
  }

  private arguments(): CallArgument[] {
    this.take();
    const inner = this.bracketBody('(', ')');
    const out: CallArgument[] = [];
    for (const piece of splitTopLevel(inner, ',')) {
      if (piece.length === 0) continue;
      const named = piece[1]?.kind === 'operator' && piece[1].text === '=' && piece[0]?.kind === 'ident';
      if (named) {
        out.push({ name: piece[0]?.text ?? null, expr: parseTokens(piece.slice(2), this.line, 'an argument') });
      } else {
        out.push({ name: null, expr: parseTokens(piece, this.line, 'an argument') });
      }
    }
    return out;
  }

  private primary(): Expr {
    const token = this.peek();
    if (!token) throw new PineSyntaxError('a value is missing', this.line);
    if (token.kind === 'number') {
      this.take();
      const value = Number(token.text);
      if (!Number.isFinite(value)) throw new PineSyntaxError(`\`${token.text}\` is not a number`, this.line);
      return this.node({ kind: 'number', value, line: token.line });
    }
    if (token.kind === 'string') {
      this.take();
      return this.node({ kind: 'string', value: token.text, line: token.line });
    }
    if (this.isOperator('(')) {
      this.take();
      const inner = this.ternary();
      if (!this.isOperator(')')) throw new PineSyntaxError('a parenthesis is never closed', this.line);
      this.take();
      return inner;
    }
    if (this.isOperator('[')) {
      this.take();
      const items: Expr[] = [];
      for (;;) {
        items.push(this.ternary());
        if (this.isOperator(',')) {
          this.take();
          if (this.isOperator(']')) break;
          continue;
        }
        break;
      }
      if (!this.isOperator(']')) throw new PineSyntaxError('a `[` list is never closed', this.line);
      this.take();
      return this.node({ kind: 'tuple', items, line: token.line });
    }
    if (token.kind === 'ident') {
      this.take();
      if (token.text === 'true') return this.node({ kind: 'number', value: 1, line: token.line });
      if (token.text === 'false') return this.node({ kind: 'number', value: 0, line: token.line });
      if (token.text === 'na' && !this.isOperator('(')) return this.node({ kind: 'number', value: Number.NaN, line: token.line });
      if (RESERVED.has(token.text) && token.text !== 'na') throw new PineSyntaxError(`\`${token.text}\` is a Pine keyword, not a value`, token.line);
      return this.node({ kind: 'ident', name: token.text, line: token.line });
    }
    throw new PineSyntaxError(`unexpected \`${token.text}\``, token.line);
  }
}

/** Renders a token run back to something a reader recognises, for error messages. */
function textOf(tokens: readonly Token[]): string {
  return tokens.map((token) => token.text).join(' ').slice(0, 80);
}
