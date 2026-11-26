/**
 * The Pine subset the converter understands, as a syntax tree.
 *
 * Small on purpose: only the shapes a v2–v5 study needs. Anything outside it — loops,
 * `switch`, user types — is kept as an `unsupported` statement carrying the reason, so the
 * converter can name every construct it refused instead of stopping at the first one.
 */

export interface Position {
  /** 1-based line of the Pine source. */
  line: number;
}

/** One parameter of a user-defined function, with its default when Pine gave one. */
export interface FunctionParam {
  name: string;
  defaultValue: Expr | null;
}

export interface CallArgument {
  /** Pine's named argument (`minval=2`), or null for a positional one. */
  name: string | null;
  expr: Expr;
}

export type Expr =
  | { kind: 'number'; value: number } & Position
  | { kind: 'string'; value: string } & Position
  | { kind: 'ident'; name: string } & Position
  | { kind: 'member'; object: Expr; name: string } & Position
  | { kind: 'call'; callee: Expr; args: CallArgument[] } & Position
  | { kind: 'index'; base: Expr; offset: Expr } & Position
  | { kind: 'binary'; op: string; left: Expr; right: Expr } & Position
  | { kind: 'unary'; op: string; operand: Expr } & Position
  | { kind: 'ternary'; condition: Expr; whenTrue: Expr; whenFalse: Expr } & Position
  | { kind: 'tuple'; items: Expr[] } & Position;

export type Stmt =
  /** `name = expr`, `name := expr`, and `var name = expr`; also `[a, b] = expr`. */
  | ({ kind: 'assign'; target: Expr; declared: boolean; variable: boolean; expr: Expr } & Position)
  | ({ kind: 'expression'; expr: Expr } & Position)
  | ({ kind: 'if'; condition: Expr; body: Stmt[]; otherwise: Stmt[] | null } & Position)
  | ({ kind: 'function'; name: string; params: FunctionParam[]; body: Stmt[]; returns: Expr | null } & Position)
  | ({ kind: 'unsupported'; reason: string; text: string } & Position);

export function lineOf(node: Expr | Stmt): number {
  return node.line;
}

/** Walks an expression, innermost first, so a converter can look for constructs it refuses. */
export function eachNode(node: Expr, visit: (node: Expr) => void): void {
  visit(node);
  switch (node.kind) {
    case 'member':
      eachNode(node.object, visit);
      return;
    case 'call':
      eachNode(node.callee, visit);
      for (const arg of node.args) eachNode(arg.expr, visit);
      return;
    case 'index':
      eachNode(node.base, visit);
      eachNode(node.offset, visit);
      return;
    case 'binary':
      eachNode(node.left, visit);
      eachNode(node.right, visit);
      return;
    case 'unary':
      eachNode(node.operand, visit);
      return;
    case 'ternary':
      eachNode(node.condition, visit);
      eachNode(node.whenTrue, visit);
      eachNode(node.whenFalse, visit);
      return;
    case 'tuple':
      for (const item of node.items) eachNode(item, visit);
      return;
    default:
      return;
  }
}

/** Every name an expression reads, in the order it reads them. */
export function namesIn(node: Expr, into: string[] = []): string[] {
  eachNode(node, (child) => {
    if (child.kind === 'ident') into.push(child.name);
  });
  return into;
}
