import { TT, type Token } from "./tokenizer";

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "na" }
  | { k: "id"; name: string }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "un"; op: string; e: Expr }
  | { k: "tern"; c: Expr; t: Expr; f: Expr }
  | { k: "call"; fn: Expr; args: Expr[]; kw: [string, Expr][] }
  | { k: "sub"; obj: Expr; idx: Expr }
  | { k: "mem"; obj: Expr; prop: string }
  | { k: "switch_expr"; e: Expr | null; cases: { val: Expr | null; result: Expr }[] }

export type Stmt =
  | { k: "decl"; isVar: boolean; ty: string | null; name: string; e: Expr }
  | { k: "multi_decl"; names: string[]; e: Expr }
  | { k: "reassign"; target: Expr; e: Expr }
  | { k: "aug"; target: Expr; op: string; e: Expr }
  | { k: "if"; c: Expr; body: Stmt[]; elifs: { c: Expr; body: Stmt[] }[]; el: Stmt[] | null }
  | { k: "for"; v: string; start: Expr; end: Expr; step: Expr | null; body: Stmt[] }
  | { k: "while"; c: Expr; body: Stmt[] }
  | { k: "switch"; e: Expr | null; cases: { vals: (Expr | null)[]; body: Stmt[] }[] }
  | { k: "func_decl"; name: string; params: string[]; body: Stmt[] }
  | { k: "expr"; e: Expr }
  | { k: "break" }
  | { k: "continue" }

const TYPE_KEYWORDS = new Set(["int", "float", "bool", "string", "color", "series", "simple", "varip", "matrix", "array", "map", "label", "line", "box", "table"]);

export function parse(tokens: Token[]): Stmt[] {
  let pos = 0;

  function cur(): Token { return tokens[pos] || { t: TT.Eof, v: '', line: -1 }; }
  function peek(offset = 0): Token { return tokens[pos + offset] || { t: TT.Eof, v: '', line: -1 }; }
  function advance(): Token { return tokens[pos++]; }
  function eat(t: TT): Token {
    if (cur().t !== t) throw new Error(`Expected token ${t}, got ${cur().t} (${cur().v}) at line ${cur().line + 1}`);
    return advance();
  }
  function match(t: TT): boolean {
    if (cur().t === t) { advance(); return true; }
    return false;
  }
  function skipNewlines() { while (cur().t === TT.Newline) advance(); }
  function atEnd(): boolean { return cur().t === TT.Eof; }
  function atBlockEnd(): boolean {
    const t = cur().t;
    return t === TT.Dedent || t === TT.Eof;
  }

  function parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    skipNewlines();
    while (!atEnd()) {
      const stmt = parseStatement();
      if (stmt) stmts.push(stmt);
      skipNewlines();
    }
    return stmts;
  }

  function parseStatement(): Stmt | null {
    skipNewlines();
    if (atEnd()) return null;

    const c = cur();

    if (c.t === TT.If) return parseIf();
    if (c.t === TT.For) return parseFor();
    if (c.t === TT.While) return parseWhile();
    if (c.t === TT.Switch) return parseSwitch();
    if (c.t === TT.Break) { advance(); return { k: "break" }; }
    if (c.t === TT.Continue) { advance(); return { k: "continue" }; }
    if (c.t === TT.Dedent) { advance(); return null; }

    if (c.t === TT.Var) return parseVarDecl();

    if (c.t === TT.LBrack && isMultiDecl()) return parseMultiDecl();

    if (c.t === TT.Id) {
      if (isFuncDecl()) return parseFuncDecl();
      if (isTypeAnnotatedDecl()) return parseTypedDecl();
      if (isPlainDecl()) return parsePlainDecl();
    }

    const expr = parseExpr();

    if (cur().t === TT.Reassign) {
      advance();
      const rhs = parseExpr();
      return { k: "reassign", target: expr, e: rhs };
    }
    if (cur().t === TT.PlusEq || cur().t === TT.MinusEq || cur().t === TT.StarEq || cur().t === TT.SlashEq) {
      const op = advance().v;
      const rhs = parseExpr();
      return { k: "aug", target: expr, op, e: rhs };
    }

    return { k: "expr", e: expr };
  }

  function isMultiDecl(): boolean {
    let d = 1;
    let j = pos + 1;
    while (j < tokens.length && d > 0) {
      if (tokens[j].t === TT.LBrack) d++;
      if (tokens[j].t === TT.RBrack) d--;
      j++;
    }
    return j < tokens.length && tokens[j].t === TT.Assign;
  }

  function parseMultiDecl(): Stmt {
    eat(TT.LBrack);
    const names: string[] = [];
    names.push(eat(TT.Id).v);
    while (match(TT.Comma)) {
      names.push(eat(TT.Id).v);
    }
    eat(TT.RBrack);
    eat(TT.Assign);
    const e = parseExpr();
    return { k: "multi_decl", names, e };
  }

  function isTypeAnnotatedDecl(): boolean {
    if (!TYPE_KEYWORDS.has(cur().v)) return false;
    let j = pos + 1;
    while (j < tokens.length && TYPE_KEYWORDS.has(tokens[j].v)) j++;
    return j < tokens.length && tokens[j].t === TT.Id &&
           j + 1 < tokens.length && tokens[j + 1].t === TT.Assign;
  }

  function isPlainDecl(): boolean {
    return cur().t === TT.Id && peek(1).t === TT.Assign;
  }

  function parseVarDecl(): Stmt {
    advance();
    let ty: string | null = null;
    if (cur().t === TT.Id && TYPE_KEYWORDS.has(cur().v)) {
      ty = advance().v;
      while (cur().t === TT.Id && TYPE_KEYWORDS.has(cur().v)) ty += ' ' + advance().v;
    }
    const name = eat(TT.Id).v;
    eat(TT.Assign);
    const e = parseExpr();
    return { k: "decl", isVar: true, ty, name, e };
  }

  function parseTypedDecl(): Stmt {
    let ty = advance().v;
    while (cur().t === TT.Id && TYPE_KEYWORDS.has(cur().v)) ty += ' ' + advance().v;
    const name = eat(TT.Id).v;
    eat(TT.Assign);
    const e = parseExpr();
    return { k: "decl", isVar: false, ty, name, e };
  }

  function parsePlainDecl(): Stmt {
    const name = advance().v;
    eat(TT.Assign);
    const e = parseExpr();
    return { k: "decl", isVar: false, ty: null, name, e };
  }

  function isFuncDecl(): boolean {
    if (cur().t !== TT.Id || peek(1).t !== TT.LParen) return false;
    let j = pos + 2;
    let depth = 1;
    while (j < tokens.length && depth > 0) {
      if (tokens[j].t === TT.LParen) depth++;
      if (tokens[j].t === TT.RParen) depth--;
      j++;
    }
    return j < tokens.length && tokens[j].t === TT.Arrow;
  }

  function parseFuncDecl(): Stmt {
    const name = eat(TT.Id).v;
    eat(TT.LParen);
    const params: string[] = [];
    if (cur().t !== TT.RParen) {
      params.push(eat(TT.Id).v);
      while (match(TT.Comma)) {
        params.push(eat(TT.Id).v);
      }
    }
    eat(TT.RParen);
    eat(TT.Arrow);
    const body = parseBlock();
    return { k: "func_decl", name, params, body };
  }

  function parseIf(): Stmt {
    eat(TT.If);
    const c = parseExpr();
    const body = parseBlock();
    const elifs: { c: Expr; body: Stmt[] }[] = [];
    let el: Stmt[] | null = null;
    while (true) {
      skipNewlines();
      if (cur().t === TT.Else) {
        advance();
        if (cur().t === TT.If) {
          advance();
          const ec = parseExpr();
          const eb = parseBlock();
          elifs.push({ c: ec, body: eb });
        } else {
          el = parseBlock();
          break;
        }
      } else break;
    }
    return { k: "if", c, body, elifs, el };
  }

  function parseFor(): Stmt {
    eat(TT.For);
    const v = eat(TT.Id).v;
    eat(TT.Assign);
    const start = parseExpr();
    eat(TT.To);
    const end = parseExpr();
    let step: Expr | null = null;
    if (cur().t === TT.By) { advance(); step = parseExpr(); }
    const body = parseBlock();
    return { k: "for", v, start, end, step, body };
  }

  function parseWhile(): Stmt {
    eat(TT.While);
    const c = parseExpr();
    const body = parseBlock();
    return { k: "while", c, body };
  }

  function parseSwitch(): Stmt {
    advance();
    let e: Expr | null = null;
    if (cur().t !== TT.Newline && cur().t !== TT.Indent) {
      e = parseExpr();
    }
    skipNewlines();
    const cases: { vals: (Expr | null)[]; body: Stmt[] }[] = [];
    if (cur().t === TT.Indent) {
      advance();
      while (!atBlockEnd() && !atEnd()) {
        skipNewlines();
        if (atBlockEnd()) break;
        if (cur().t === TT.Arrow) {
          advance();
          const body = parseBlock();
          cases.push({ vals: [null], body });
        } else {
          const val = parseExpr();
          if (cur().t === TT.Arrow) {
            advance();
            const resultExpr = parseExpr();
            cases.push({ vals: [val], body: [{ k: "expr", e: resultExpr }] });
          } else {
            const body = parseBlock();
            cases.push({ vals: [val], body });
          }
        }
        skipNewlines();
      }
      if (cur().t === TT.Dedent) advance();
    }
    return { k: "switch", e, cases };
  }

  function parseBlock(): Stmt[] {
    skipNewlines();
    if (cur().t === TT.Indent) {
      advance();
      const stmts: Stmt[] = [];
      while (!atBlockEnd() && !atEnd()) {
        const stmt = parseStatement();
        if (stmt) stmts.push(stmt);
        skipNewlines();
      }
      if (cur().t === TT.Dedent) advance();
      return stmts;
    }
    const stmt = parseStatement();
    return stmt ? [stmt] : [];
  }

  function parseExpr(): Expr {
    return parseTernary();
  }

  function parseTernary(): Expr {
    let e = parseOr();
    if (cur().t === TT.Question) {
      advance();
      const t = parseOr();
      eat(TT.Colon);
      const f = parseTernary();
      e = { k: "tern", c: e, t, f };
    }
    return e;
  }

  function parseOr(): Expr {
    let e = parseAnd();
    while (cur().t === TT.Or) { advance(); const r = parseAnd(); e = { k: "bin", op: "or", l: e, r }; }
    return e;
  }

  function parseAnd(): Expr {
    let e = parseNot();
    while (cur().t === TT.And) { advance(); const r = parseNot(); e = { k: "bin", op: "and", l: e, r }; }
    return e;
  }

  function parseNot(): Expr {
    if (cur().t === TT.Not) { advance(); return { k: "un", op: "not", e: parseNot() }; }
    return parseComparison();
  }

  function parseComparison(): Expr {
    let e = parseAddSub();
    while (cur().t === TT.Eq || cur().t === TT.Neq || cur().t === TT.Gt || cur().t === TT.Lt || cur().t === TT.Gte || cur().t === TT.Lte) {
      const op = advance().v;
      const r = parseAddSub();
      e = { k: "bin", op, l: e, r };
    }
    return e;
  }

  function parseAddSub(): Expr {
    let e = parseMulDiv();
    while (cur().t === TT.Plus || cur().t === TT.Minus) {
      const op = advance().v;
      const r = parseMulDiv();
      e = { k: "bin", op, l: e, r };
    }
    return e;
  }

  function parseMulDiv(): Expr {
    let e = parseUnary();
    while (cur().t === TT.Star || cur().t === TT.Slash || cur().t === TT.Pct) {
      const op = advance().v;
      const r = parseUnary();
      e = { k: "bin", op, l: e, r };
    }
    return e;
  }

  function parseUnary(): Expr {
    if (cur().t === TT.Minus) { advance(); return { k: "un", op: "-", e: parseUnary() }; }
    if (cur().t === TT.Plus) { advance(); return parseUnary(); }
    return parsePostfix();
  }

  function parsePostfix(): Expr {
    let e = parsePrimary();
    while (true) {
      if (cur().t === TT.Dot) {
        advance();
        const prop = eat(TT.Id).v;
        e = { k: "mem", obj: e, prop };
      } else if (cur().t === TT.LParen) {
        advance();
        const { args, kw } = parseArgList();
        eat(TT.RParen);
        e = { k: "call", fn: e, args, kw };
      } else if (cur().t === TT.LBrack) {
        advance();
        const idx = parseExpr();
        eat(TT.RBrack);
        e = { k: "sub", obj: e, idx };
      } else break;
    }
    return e;
  }

  function parseArgList(): { args: Expr[]; kw: [string, Expr][] } {
    const args: Expr[] = [];
    const kw: [string, Expr][] = [];
    if (cur().t === TT.RParen) return { args, kw };
    while (true) {
      if (cur().t === TT.Id && peek(1).t === TT.Assign) {
        const name = advance().v;
        eat(TT.Assign);
        kw.push([name, parseExpr()]);
      } else {
        args.push(parseExpr());
      }
      if (!match(TT.Comma)) break;
    }
    return { args, kw };
  }

  function parsePrimary(): Expr {
    const c = cur();
    switch (c.t) {
      case TT.Num: advance(); return { k: "num", v: parseFloat(c.v) };
      case TT.Str: advance(); return { k: "str", v: c.v };
      case TT.True: advance(); return { k: "bool", v: true };
      case TT.False: advance(); return { k: "bool", v: false };
      case TT.Na: advance(); return { k: "na" };
      case TT.Id: advance(); return { k: "id", name: c.v };
      case TT.LParen: {
        advance();
        const e = parseExpr();
        eat(TT.RParen);
        return e;
      }
      case TT.LBrack: {
        advance();
        const elements: Expr[] = [];
        while (cur().t !== TT.RBrack && !atEnd()) {
          elements.push(parseExpr());
          match(TT.Comma);
        }
        eat(TT.RBrack);
        return { k: "call", fn: { k: "id", name: "__array_literal" }, args: elements, kw: [] };
      }
      case TT.Switch: return parseSwitchExpr();
      default:
        advance();
        return { k: "na" };
    }
  }

  function parseSwitchExpr(): Expr {
    advance();
    let e: Expr | null = null;
    if (cur().t !== TT.Newline && cur().t !== TT.Indent) {
      e = parseExpr();
    }
    skipNewlines();
    const cases: { val: Expr | null; result: Expr }[] = [];
    if (cur().t === TT.Indent) {
      advance();
      while (!atBlockEnd() && !atEnd()) {
        skipNewlines();
        if (atBlockEnd()) break;
        if (cur().t === TT.Arrow) {
          advance();
          const result = parseExpr();
          cases.push({ val: null, result });
        } else {
          const val = parseExpr();
          if (cur().t === TT.Arrow) {
            advance();
            const result = parseExpr();
            cases.push({ val, result });
          } else {
            cases.push({ val: null, result: val });
          }
        }
        skipNewlines();
      }
      if (cur().t === TT.Dedent) advance();
    }
    return { k: "switch_expr", e, cases };
  }

  return parseProgram();
}
