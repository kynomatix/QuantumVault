export const enum TT {
  Num, Str, Id,
  If, Else, For, While, Switch, Var, To, By,
  Not, And, Or,
  True, False, Na,
  Plus, Minus, Star, Slash, Pct,
  Eq, Neq, Gt, Lt, Gte, Lte,
  Assign, Reassign,
  Question, Colon, Arrow,
  PlusEq, MinusEq, StarEq, SlashEq,
  LParen, RParen, LBrack, RBrack,
  Comma, Dot,
  Newline, Indent, Dedent,
  Eof, Break, Continue,
}

export interface Token {
  t: TT;
  v: string;
  line: number;
}

const KW: Record<string, TT> = {
  if: TT.If, else: TT.Else, for: TT.For, while: TT.While,
  switch: TT.Switch, var: TT.Var, to: TT.To, by: TT.By,
  not: TT.Not, and: TT.And, or: TT.Or,
  true: TT.True, false: TT.False, na: TT.Na,
  break: TT.Break, continue: TT.Continue,
};

function isAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isAlnum(c: string): boolean {
  return isAlpha(c) || isDigit(c);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split('\n');
  const indentStack = [0];
  let parenDepth = 0;

  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    const commentIdx = findComment(raw);
    const line = (commentIdx >= 0 ? raw.substring(0, commentIdx) : raw).trimEnd();

    const firstNonSpace = line.search(/\S/);
    if (firstNonSpace < 0) continue;

    const indent = firstNonSpace;

    const lastTok = tokens.length > 0 ? tokens[tokens.length - 1].t : TT.Eof;
    const firstChar = line[firstNonSpace];
    const startsWithContinuation = firstChar === ':' || firstChar === '?';
    const isContinuation = parenDepth > 0 || startsWithContinuation
      || lastTok === TT.Question || lastTok === TT.Colon
      || lastTok === TT.Plus || lastTok === TT.Minus || lastTok === TT.Star || lastTok === TT.Slash
      || lastTok === TT.And || lastTok === TT.Or || lastTok === TT.Comma
      || lastTok === TT.Assign || lastTok === TT.Reassign
      || lastTok === TT.Eq || lastTok === TT.Neq || lastTok === TT.Gt || lastTok === TT.Lt
      || lastTok === TT.Gte || lastTok === TT.Lte || lastTok === TT.Pct;

    if (!isContinuation) {
      const prevIndent = indentStack[indentStack.length - 1];
      if (indent > prevIndent) {
        indentStack.push(indent);
        tokens.push({ t: TT.Indent, v: '', line: ln });
      } else if (indent < prevIndent) {
        while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
          indentStack.pop();
          tokens.push({ t: TT.Dedent, v: '', line: ln });
        }
      }
      if (indent <= prevIndent && tokens.length > 0) {
        const last = tokens[tokens.length - 1].t;
        if (last !== TT.Indent && last !== TT.Dedent && last !== TT.Newline) {
          tokens.push({ t: TT.Newline, v: '', line: ln });
        }
      }
    }

    let i = firstNonSpace;
    while (i < line.length) {
      const c = line[i];

      if (c === ' ' || c === '\t') { i++; continue; }

      if (isDigit(c) || (c === '.' && i + 1 < line.length && isDigit(line[i + 1]))) {
        let num = '';
        while (i < line.length && (isDigit(line[i]) || line[i] === '.')) {
          num += line[i++];
        }
        if (i < line.length && (line[i] === 'e' || line[i] === 'E')) {
          num += line[i++];
          if (i < line.length && (line[i] === '+' || line[i] === '-')) num += line[i++];
          while (i < line.length && isDigit(line[i])) num += line[i++];
        }
        tokens.push({ t: TT.Num, v: num, line: ln });
        continue;
      }

      if (c === '"' || c === "'") {
        const q = c;
        let s = '';
        i++;
        while (i < line.length && line[i] !== q) {
          if (line[i] === '\\' && i + 1 < line.length) { s += line[++i]; }
          else s += line[i];
          i++;
        }
        if (i < line.length) i++;
        tokens.push({ t: TT.Str, v: s, line: ln });
        continue;
      }

      if (c === '#') {
        let col = '#';
        i++;
        while (i < line.length && isAlnum(line[i])) col += line[i++];
        tokens.push({ t: TT.Str, v: col, line: ln });
        continue;
      }

      if (isAlpha(c)) {
        let id = '';
        while (i < line.length && isAlnum(line[i])) id += line[i++];
        const kw = KW[id];
        tokens.push({ t: kw !== undefined ? kw : TT.Id, v: id, line: ln });
        continue;
      }

      switch (c) {
        case '(':
          parenDepth++;
          tokens.push({ t: TT.LParen, v: '(', line: ln }); i++;
          break;
        case ')':
          parenDepth = Math.max(0, parenDepth - 1);
          tokens.push({ t: TT.RParen, v: ')', line: ln }); i++;
          break;
        case '[':
          parenDepth++;
          tokens.push({ t: TT.LBrack, v: '[', line: ln }); i++;
          break;
        case ']':
          parenDepth = Math.max(0, parenDepth - 1);
          tokens.push({ t: TT.RBrack, v: ']', line: ln }); i++;
          break;
        case ',':
          tokens.push({ t: TT.Comma, v: ',', line: ln }); i++;
          break;
        case '.':
          tokens.push({ t: TT.Dot, v: '.', line: ln }); i++;
          break;
        case '?':
          tokens.push({ t: TT.Question, v: '?', line: ln }); i++;
          break;
        case '+':
          if (line[i + 1] === '=') { tokens.push({ t: TT.PlusEq, v: '+=', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Plus, v: '+', line: ln }); i++; }
          break;
        case '-':
          if (line[i + 1] === '=') { tokens.push({ t: TT.MinusEq, v: '-=', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Minus, v: '-', line: ln }); i++; }
          break;
        case '*':
          if (line[i + 1] === '=') { tokens.push({ t: TT.StarEq, v: '*=', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Star, v: '*', line: ln }); i++; }
          break;
        case '/':
          if (line[i + 1] === '=') { tokens.push({ t: TT.SlashEq, v: '/=', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Slash, v: '/', line: ln }); i++; }
          break;
        case '%':
          tokens.push({ t: TT.Pct, v: '%', line: ln }); i++;
          break;
        case '=':
          if (line[i + 1] === '=') { tokens.push({ t: TT.Eq, v: '==', line: ln }); i += 2; }
          else if (line[i + 1] === '>') { tokens.push({ t: TT.Arrow, v: '=>', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Assign, v: '=', line: ln }); i++; }
          break;
        case ':':
          if (line[i + 1] === '=') { tokens.push({ t: TT.Reassign, v: ':=', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Colon, v: ':', line: ln }); i++; }
          break;
        case '!':
          if (line[i + 1] === '=') { tokens.push({ t: TT.Neq, v: '!=', line: ln }); i += 2; }
          else { i++; }
          break;
        case '>':
          if (line[i + 1] === '=') { tokens.push({ t: TT.Gte, v: '>=', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Gt, v: '>', line: ln }); i++; }
          break;
        case '<':
          if (line[i + 1] === '=') { tokens.push({ t: TT.Lte, v: '<=', line: ln }); i += 2; }
          else { tokens.push({ t: TT.Lt, v: '<', line: ln }); i++; }
          break;
        default:
          i++;
          break;
      }
    }
  }

  while (indentStack.length > 1) {
    indentStack.pop();
    tokens.push({ t: TT.Dedent, v: '', line: lines.length });
  }
  tokens.push({ t: TT.Eof, v: '', line: lines.length });
  return tokens;
}

function findComment(line: string): number {
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === strCh && line[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}
