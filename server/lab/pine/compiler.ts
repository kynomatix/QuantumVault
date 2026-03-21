import type { Expr, Stmt } from "./parser";

const SAFE_ID = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function safeId(name: string): string {
  if (SAFE_ID.test(name)) return `v_${name}`;
  return `v_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;
}

function safeStr(s: string): string {
  return JSON.stringify(s);
}

export interface CompilerContext {
  precomputedNames: Set<string>;
  builtinSeriesNames: Set<string>;
  inputDefaultNames: Set<string>;
  varIsVarNames: Set<string>;
  userFunctionNames: Set<string>;
  paramNames: Set<string>;
  localVarNames?: Set<string>;
  inlinedLoop?: boolean;
}

const INLINE_HISTORY_TA = new Set(["crossover", "crossunder", "cross", "change", "rising", "falling"]);

function findHistoryAccessed(stmts: Stmt[]): Set<string> {
  const accessed = new Set<string>();
  function markArgs(args: Expr[]) {
    for (const a of args) {
      if (a.k === "id") accessed.add(a.name);
    }
  }
  function walkExpr(e: Expr) {
    if (!e || typeof e !== "object") return;
    if (e.k === "sub" && e.obj.k === "id") {
      accessed.add(e.obj.name);
    }
    if (e.k === "call") {
      if (e.fn.k === "mem" && e.fn.obj.k === "id" && e.fn.obj.name === "ta") {
        markArgs(e.args);
      }
      if (e.fn.k === "id" && (INLINE_HISTORY_TA.has(e.fn.name) || ["sma","ema","wma","linreg","rma","vwma","swma","hma","dema","tema","alma","rsi","cci","mfi","roc","dev","median","percentrank","cum","stoch","macd","bb","kc","atr","tr","adx","supertrend","dmi","highest","lowest","barssince","valuewhen","pivothigh","pivotlow","percentile_nearest_rank","percentile_linear_interpolation"].includes(e.fn.name))) {
        markArgs(e.args);
      }
    }
    for (const k of Object.keys(e) as (keyof typeof e)[]) {
      const v = (e as any)[k];
      if (Array.isArray(v)) v.forEach((x: any) => { if (typeof x === "object" && x !== null) walkExpr(x); });
      else if (typeof v === "object" && v !== null) walkExpr(v as any);
    }
  }
  function walkStmt(s: Stmt) {
    if ("e" in s && s.e) walkExpr(s.e as Expr);
    if ("c" in s && s.c) walkExpr(s.c as Expr);
    if ("target" in s && s.target) walkExpr(s.target as Expr);
    if ("start" in s && s.start) walkExpr(s.start as Expr);
    if ("end" in s && s.end) walkExpr(s.end as Expr);
    if ("step" in s && s.step) walkExpr(s.step as Expr);
    if ("body" in s && s.body) (s.body as Stmt[]).forEach(walkStmt);
    if ("el" in s && s.el) (s.el as Stmt[]).forEach(walkStmt);
    if ("elifs" in s && s.elifs) (s.elifs as any[]).forEach((ei: any) => {
      if (ei.c) walkExpr(ei.c);
      if (ei.body) (ei.body as Stmt[]).forEach(walkStmt);
    });
    if ("cases" in s && s.cases) (s.cases as any[]).forEach((c: any) => {
      if (c.vals) (c.vals as any[]).forEach((v: any) => { if (v) walkExpr(v); });
      if (c.body) (c.body as Stmt[]).forEach(walkStmt);
    });
  }
  stmts.forEach(walkStmt);
  for (const [, fdef] of Object.entries({})) { /* user funcs handled separately */ }
  return accessed;
}

function collectReferencedIds(node: any): Set<string> {
  const ids = new Set<string>();
  if (!node || typeof node !== "object") return ids;
  if (node.k === "id") { ids.add(node.name); return ids; }
  for (const k of Object.keys(node)) {
    if (k === "k") continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        for (const id of collectReferencedIds(item)) ids.add(id);
      }
    } else if (v && typeof v === "object") {
      for (const id of collectReferencedIds(v)) ids.add(id);
    }
  }
  return ids;
}

function hasStrategyCall(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.k === "expr" && s.e.k === "call" && s.e.fn?.k === "mem" &&
        s.e.fn.obj?.k === "id" && s.e.fn.obj.name === "strategy") return true;
    if (s.k === "if") {
      if (hasStrategyCall(s.body)) return true;
      if (s.el && hasStrategyCall(s.el)) return true;
      if (s.elifs) for (const ei of s.elifs) { if (hasStrategyCall(ei.body)) return true; }
    }
    if (s.k === "for" && hasStrategyCall(s.body)) return true;
    if (s.k === "while" && hasStrategyCall(s.body)) return true;
  }
  return false;
}

function hasSideEffect(stmts: Stmt[]): boolean {
  for (const s of stmts) {
    if (s.k === "reassign" || s.k === "aug") return true;
    if (s.k === "expr" && s.e.k === "call" && s.e.fn?.k === "mem" &&
        s.e.fn.obj?.k === "id" && s.e.fn.obj.name === "strategy") return true;
    if (s.k === "if") {
      if (hasSideEffect(s.body)) return true;
      if (s.el && hasSideEffect(s.el)) return true;
      if (s.elifs) for (const ei of s.elifs) { if (hasSideEffect(ei.body)) return true; }
    }
    if (s.k === "for" && hasSideEffect(s.body)) return true;
    if (s.k === "while" && hasSideEffect(s.body)) return true;
  }
  return false;
}

function eliminateDeadCode(
  hotStmts: Stmt[],
  userFunctions: Record<string, { params: string[]; body: Stmt[] }>
): Stmt[] {
  const stmtDefines = new Map<number, string[]>();
  const stmtRefs = new Map<number, Set<string>>();
  const essential = new Set<number>();

  for (let i = 0; i < hotStmts.length; i++) {
    const s = hotStmts[i];
    stmtRefs.set(i, collectReferencedIds(s));

    if (s.k === "decl") {
      stmtDefines.set(i, [s.name]);
      if (s.isVar) essential.add(i);
    } else if (s.k === "multi_decl" && (s as any).names) {
      stmtDefines.set(i, (s as any).names);
    } else if (s.k === "reassign" && s.target.k === "id") {
      stmtDefines.set(i, [s.target.name]);
    } else if (s.k === "aug" && s.target.k === "id") {
      stmtDefines.set(i, [s.target.name]);
    }

    if (s.k === "if" && hasSideEffect(s.body)) essential.add(i);
    if (s.k === "if" && s.el && hasSideEffect(s.el)) essential.add(i);
    if (s.k === "if" && s.elifs && s.elifs.some((ei: any) => hasSideEffect(ei.body))) essential.add(i);
    if (s.k === "expr" && s.e.k === "call" && s.e.fn?.k === "mem" &&
        s.e.fn.obj?.k === "id" && s.e.fn.obj.name === "strategy") essential.add(i);
    if (s.k === "for" || s.k === "while") essential.add(i);
    if (s.k === "reassign" || s.k === "aug") essential.add(i);
  }

  const needed = new Set<string>();
  for (const i of essential) {
    for (const id of stmtRefs.get(i)!) needed.add(id);
  }
  for (const [, fdef] of Object.entries(userFunctions)) {
    for (const bs of fdef.body) {
      for (const id of collectReferencedIds(bs)) needed.add(id);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < hotStmts.length; i++) {
      if (essential.has(i)) continue;
      const defNames = stmtDefines.get(i);
      if (defNames && defNames.some(n => needed.has(n))) {
        essential.add(i);
        for (const id of stmtRefs.get(i)!) {
          if (!needed.has(id)) { needed.add(id); changed = true; }
        }
      }
    }
  }

  const result = hotStmts.filter((_, i) => essential.has(i));
  return result;
}

export function compilePineHotLoop(
  hotStmts: Stmt[],
  userFunctions: Record<string, { params: string[]; body: Stmt[] }>,
  ctx: CompilerContext,
): Function | null {
  try {
    _taSlotCounter = 0;
    const liveStmts = eliminateDeadCode(hotStmts, userFunctions);
    const allStmts = [...liveStmts, ...Object.values(userFunctions).flatMap(f => f.body)];
    const historyAccessed = findHistoryAccessed(allStmts);

    const localVarNames = new Set<string>();
    const reassignedNames = new Set<string>();
    function collectReassigned(stmts: Stmt[]) {
      for (const s of stmts) {
        if (s.k === "reassign" && s.target.k === "id") reassignedNames.add(s.target.name);
        if (s.k === "aug" && s.target.k === "id") reassignedNames.add(s.target.name);
        if (s.k === "if") {
          collectReassigned(s.body);
          if (s.el) collectReassigned(s.el);
          if (s.elifs) for (const ei of s.elifs) collectReassigned(ei.body);
        }
        if (s.k === "for" || s.k === "while") collectReassigned(s.body);
      }
    }
    collectReassigned(liveStmts);
    for (const s of liveStmts) {
      if (s.k === "decl" && !s.isVar &&
          !ctx.precomputedNames.has(s.name) &&
          !ctx.inputDefaultNames.has(s.name) &&
          !ctx.builtinSeriesNames.has(s.name) &&
          !historyAccessed.has(s.name)) {
        localVarNames.add(s.name);
      }
    }
    ctx.localVarNames = localVarNames;

    ctx.inlinedLoop = true;

    const bodyLines: string[] = [];

    const ufLines: string[] = [];
    for (const [fname, fdef] of Object.entries(userFunctions)) {
      const indent = "  ";
      ufLines.push(`${safeId(fname)}: function(${fdef.params.map(p => safeId(p)).join(", ")}) {`);
      for (const p of fdef.params) {
        const si = safeId(p);
        const sn = safeStr(p);
        ufLines.push(`${indent}var _pArr_${si} = _vars[${sn}]; var _saved_${si};`);
        ufLines.push(`${indent}if (!_pArr_${si}) { ctx.setVar(${sn}, ${si}); _pArr_${si} = _vars[${sn}]; }`);
        ufLines.push(`${indent}else { _saved_${si} = _pArr_${si}[_bar]; _pArr_${si}[_bar] = ${si}; }`);
      }
      const bodyLen = fdef.body.length;
      for (let i = 0; i < bodyLen - 1; i++) {
        ufLines.push(...compileStmt(fdef.body[i], indent, ctx));
      }
      if (bodyLen > 0) {
        ufLines.push(...compileStmtForValue(fdef.body[bodyLen - 1], indent, ctx, "_fn_result"));
      } else {
        ufLines.push(`${indent}var _fn_result = null;`);
      }
      for (const p of fdef.params) {
        ufLines.push(`${indent}_pArr_${safeId(p)}[_bar] = _saved_${safeId(p)};`);
      }
      ufLines.push(`${indent}return _fn_result;`);
      ufLines.push(`},`);
    }
    if (ufLines.length > 0) {
      bodyLines.push(`var _uf = {`);
      bodyLines.push(...ufLines);
      bodyLines.push(`};`);
    }

    for (const stmt of liveStmts) {
      bodyLines.push(...compileStmt(stmt, "  ", ctx));
    }

    const bodyCode = bodyLines.join("\n");

    const builtinNames = ["close", "open", "high", "low", "volume", "hl2", "hlc3", "ohlc4"];
    const builtinArrDecls = builtinNames.map(n => `var _${n}Arr = ctx.builtinSeries["${n}"];`).join("\n");

    const loopCode = [
      `"use strict";`,
      `var _or, _nz, _dr, _bl, _br, _t, _rt, _ca, _cb, _cap, _cbp, _md;`,
      `var _N = ctx._N;`,
      `var _add = ctx._add;`,
      `var _toNum = ctx.toNum;`,
      `var _poc = ctx._processOrdersOnClose;`,
      `var _broker = ctx.broker;`,
      `var _openArr = ctx._openArr, _highArr = ctx._highArr, _lowArr = ctx._lowArr, _closeArr = ctx._closeArr, _candles = ctx._candles;`,
      builtinArrDecls,
      `var _equityValues = ctx._equityValues;`,
      `var _vars = ctx.vars;`,
      `var _pc = ctx.pc;`,
      `var _n = ctx.n;`,
      `for (var _bar = 0; _bar < _n; _bar++) {`,
      `  ctx.bar = _bar;`,
      `  if (!_poc && _bar > 0) {`,
      `    _broker.fillPendingCloses(_openArr[_bar], _bar, _candles[_bar].time);`,
      `    _broker.fillPendingEntries(_openArr[_bar], _bar, _candles[_bar].time);`,
      `    _broker.evaluateExits(_bar, _openArr[_bar], _highArr[_bar], _lowArr[_bar], _closeArr[_bar], _candles[_bar].time);`,
      `  }`,
      `  _broker.snapshotPositionSize(_bar);`,
      bodyCode,
      `  if (_poc) {`,
      `    _broker.fillPendingCloses(_closeArr[_bar], _bar, _candles[_bar].time);`,
      `    _broker.fillPendingEntries(_closeArr[_bar], _bar, _candles[_bar].time);`,
      `    _broker.evaluateExits(_bar, _openArr[_bar], _highArr[_bar], _lowArr[_bar], _closeArr[_bar], _candles[_bar].time);`,
      `  }`,
      `  _equityValues[_bar] = _broker.getEquityWithUnrealized(_closeArr[_bar]);`,
      `}`,
    ].join("\n");
    const loopFn = new Function("ctx", loopCode);

    const _N = (v: any) => v == null ? NaN : typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : +v;
    const _add = (a: any, b: any) => (typeof a === 'string' || typeof b === 'string') ? String(a) + String(b) : _N(a) + _N(b);

    const result = function compiledPineLoop(rctx: any) {
      rctx._N = _N;
      rctx._add = _add;
      loopFn(rctx);
    };
    return result;
  } catch (e: any) {
    if (process.env.NODE_ENV !== "production") console.log("[Pine compiler] compilation error:", e.message?.substring(0, 300));
    return null;
  }
}

function isNumericExpr(e: string): boolean {
  if (/^-?\d+(\.\d+)?$/.test(e)) return true;
  if (/^ctx\.(builtinSeries|pc)\[/.test(e)) return true;
  if (/^ctx\.bar$/.test(e)) return true;
  if (/^NaN$/.test(e)) return true;
  return false;
}

function toN(e: string): string {
  if (isNumericExpr(e) || e === "NaN") return `(+(${e}))`;
  return `(+${e} || 0)`;
}

function compileBinOp(op: string, l: string, r: string): string {
  switch (op) {
    case "+": return `_add(${l}, ${r})`;
    case "-": return `(_N(${l}) - _N(${r}))`;
    case "*": return `(_N(${l}) * _N(${r}))`;
    case "/": return `((_dr = _N(${r})), _dr === 0 ? NaN : _N(${l}) / _dr)`;
    case "%": return `((_dr = _N(${r})), _dr === 0 ? NaN : _N(${l}) % _dr)`;
    case "==": return `((_bl = ${l}), (_br = ${r}), _bl === _br || (_bl == null && _br == null))`;
    case "!=": return `((_bl = ${l}), (_br = ${r}), _bl !== _br && !(_bl == null && _br == null))`;
    case ">": return `(_N(${l}) > _N(${r}))`;
    case "<": return `(_N(${l}) < _N(${r}))`;
    case ">=": return `(_N(${l}) >= _N(${r}))`;
    case "<=": return `(_N(${l}) <= _N(${r}))`;
    default: return "NaN";
  }
}

function compileExpr(e: Expr, ctx: CompilerContext): string {
  switch (e.k) {
    case "num":
      return isNaN(e.v) ? "NaN" : String(e.v);
    case "str":
      return safeStr(e.v);
    case "bool":
      return e.v ? "true" : "false";
    case "na":
      return "null";
    case "id":
      return compileIdExpr(e.name, ctx);
    case "bin": {
      const l = compileExpr(e.l, ctx);
      const r = compileExpr(e.r, ctx);
      if (e.op === "and") return `(${l} ? (${r}) : false)`;
      if (e.op === "or") return `(((_or = ${l}) ? _or : (${r})))`;
      return compileBinOp(e.op, l, r);
    }
    case "un":
      if (e.op === "not") return `(!${compileExpr(e.e, ctx)})`;
      if (e.op === "-") return `(-_toNum(${compileExpr(e.e, ctx)}))`;
      return compileExpr(e.e, ctx);
    case "tern":
      return `(${compileExpr(e.c, ctx)} ? ${compileExpr(e.t, ctx)} : ${compileExpr(e.f, ctx)})`;
    case "call":
      return compileCall(e, ctx);
    case "sub": {
      if (e.obj.k === "id") {
        const name = e.obj.name;
        const offset = compileExpr(e.idx, ctx);
        if (ctx.precomputedNames.has(name)) {
          return `((_t = _bar - Math.round(_toNum(${offset}))), _t >= 0 ? ((_t = _pc[${safeStr(name)}][_t]), (typeof _t === 'number' && _t !== _t) ? null : _t) : null)`;
        }
        if (ctx.builtinSeriesNames.has(name)) {
          const arrName = ctx.inlinedLoop ? _builtinArrMap[name] : null;
          if (arrName) return `((_t = _bar - Math.round(_toNum(${offset}))), _t >= 0 ? ${arrName}[_t] : null)`;
          return `((_t = _bar - Math.round(_toNum(${offset}))), _t >= 0 ? ctx.builtinSeries[${safeStr(name)}][_t] : null)`;
        }
        if (ctx.varIsVarNames.has(name)) {
          return `((_t = _vars[${safeStr(name)}]), _t ? ((_t = _t[_bar - Math.round(_toNum(${offset}))]), _t === undefined ? null : _t) : null)`;
        }
        return `ctx.getVar(${safeStr(name)}, Math.round(_toNum(${offset})))`;
      }
      if (e.obj.k === "mem" && e.obj.obj.k === "id" && e.obj.obj.name === "strategy") {
        const prop = e.obj.prop;
        const offset = compileExpr(e.idx, ctx);
        if (prop === "position_size") {
          return `ctx.broker.getPositionSizeHistory(Math.round(_toNum(${offset})), _bar)`;
        }
      }
      return "null";
    }
    case "mem":
      return compileMember(e, ctx);
    case "switch_expr": {
      const parts: string[] = [];
      if (e.e) {
        parts.push(`(function() { const _sw = ${compileExpr(e.e, ctx)};`);
        for (const c of e.cases) {
          if (c.val === null) {
            parts.push(`return ${compileExpr(c.result, ctx)};`);
          } else {
            parts.push(`if (_sw === ${compileExpr(c.val, ctx)}) return ${compileExpr(c.result, ctx)};`);
          }
        }
      } else {
        parts.push(`(function() {`);
        for (const c of e.cases) {
          if (c.val === null) {
            parts.push(`return ${compileExpr(c.result, ctx)};`);
          } else {
            parts.push(`if (${compileExpr(c.val, ctx)}) return ${compileExpr(c.result, ctx)};`);
          }
        }
      }
      parts.push(`return null; })()`);
      return parts.join(" ");
    }
  }
  return "null";
}

const _builtinArrMap: Record<string, string> = {
  close: "_closeArr", open: "_openArr", high: "_highArr", low: "_lowArr",
  volume: "_volumeArr", hl2: "_hl2Arr", hlc3: "_hlc3Arr", ohlc4: "_ohlc4Arr",
};

function compileIdExpr(name: string, ctx: CompilerContext): string {
  if (ctx.localVarNames?.has(name))
    return safeId(name);
  if (ctx.builtinSeriesNames.has(name)) {
    if (ctx.inlinedLoop && _builtinArrMap[name])
      return `${_builtinArrMap[name]}[_bar]`;
    return `ctx.builtinSeries[${safeStr(name)}][ctx.bar]`;
  }
  if (ctx.precomputedNames.has(name)) {
    return `((_t = _pc[${safeStr(name)}][_bar]), (typeof _t === 'number' && _t !== _t) ? null : _t)`;
  }
  if (ctx.paramNames.has(name))
    return `ctx.params[${safeStr(name)}]`;
  if (ctx.inputDefaultNames.has(name))
    return `((_t = ctx.inputDefaults[${safeStr(name)}]), typeof _t === 'string' && ctx.builtinSeries[_t] ? ctx.builtinSeries[_t][_bar] : _t)`;

  switch (name) {
    case "bar_index": return "_bar";
    case "time": return "ctx.time()";
    case "timenow": return "Date.now()";
    case "na": return "null";
    case "true": return "true";
    case "false": return "false";
    default:
      if (ctx.varIsVarNames.has(name)) {
        return `((_t = _vars[${safeStr(name)}]), _t ? ((_t = _t[_bar]), _t === undefined ? null : _t) : null)`;
      }
      return `ctx.getVar(${safeStr(name)}, 0)`;
  }
}

function compileMember(e: { k: "mem"; obj: Expr; prop: string }, ctx: CompilerContext): string {
  if (e.obj.k === "id") {
    const obj = e.obj.name;
    const prop = e.prop;
    if (obj === "strategy") {
      switch (prop) {
        case "long": return safeStr("long");
        case "short": return safeStr("short");
        case "position_size": return "ctx.broker.positionSize";
        case "position_avg_price": return "ctx.broker.positionAvgPrice";
        case "equity": return "ctx.broker.getEquityWithUnrealized(ctx.close())";
        case "cash": return safeStr("cash");
        case "percent_of_equity": return safeStr("percent_of_equity");
        case "fixed": return safeStr("fixed");
      }
    }
    if (obj === "barstate") {
      switch (prop) {
        case "isconfirmed": return "true";
        case "isfirst": return "(_bar === 0)";
        case "islast": return "(_bar === ctx.n - 1)";
        case "isnew": return "true";
        case "isrealtime": return "false";
        case "ishistory": return "true";
      }
    }
    if (obj === "math") return `({__ns:"math",fn:${safeStr(prop)}})`;
    if (obj === "ta") return `({__ns:"ta",fn:${safeStr(prop)}})`;
    if (obj === "str") return `({__ns:"str",fn:${safeStr(prop)}})`;
    if (obj === "color") return `"#000000"`;
    if (obj === "currency") return safeStr(prop);
    if (obj === "dayofweek") {
      if (prop === "monday") return "2";
      if (prop === "sunday") return "1";
      return "0";
    }
    if (obj === "syminfo") {
      if (prop === "mintick") return "0.01";
      if (prop === "ticker") return "ctx.ticker";
      return "null";
    }
    if (obj === "location" || obj === "shape" || obj === "size" || obj === "plot" || obj === "display")
      return safeStr(prop);
    if (obj === "line" || obj === "label")
      return `({__ns:${safeStr(obj)},fn:${safeStr(prop)}})`;

    return `ctx.getMemberVar(${safeStr(obj)}, ${safeStr(prop)})`;
  }

  if (e.obj.k === "mem") {
    return `ctx.evalMember(${compileMember(e.obj as any, ctx)}, ${safeStr(e.prop)})`;
  }

  return `ctx.getMemberDynamic(${compileExpr(e.obj, ctx)}, ${safeStr(e.prop)})`;
}

function compileCall(e: { k: "call"; fn: Expr; args: Expr[]; kw: [string, Expr][] }, ctx: CompilerContext): string {
  if (e.fn.k === "mem" && e.fn.obj.k === "id") {
    const obj = e.fn.obj.name;
    const prop = e.fn.prop;

    if (obj === "input") return `ctx.evalInputCall(${safeStr(prop)}, [${e.args.map(a => compileExpr(a, ctx)).join(",")}], [${e.kw.map(([k, v]) => `[${safeStr(k)},${compileExpr(v, ctx)}]`).join(",")}])`;
    if (obj === "strategy") return compileStrategyCall(prop, e.args, e.kw, ctx);
    if (obj === "color" || obj === "line" || obj === "label" || obj === "box" || obj === "table") return "null";

    if (obj === "math") return compileMathCall(prop, e.args, ctx);
    if (obj === "ta") return compileTaCall(prop, e.args, e.kw, ctx);
    if (obj === "str") return compileStrCall(prop, e.args, ctx);
  }

  if (e.fn.k === "id") {
    const name = e.fn.name;
    if (name === "na") {
      if (e.args.length === 0) return "null";
      return `ctx.isNa(${compileExpr(e.args[0], ctx)})`;
    }
    if (name === "nz") {
      const v = compileExpr(e.args[0], ctx);
      const rep = e.args.length > 1 ? compileExpr(e.args[1], ctx) : "0";
      return `(ctx.isNa(_nz = ${v}) ? ${rep} : _nz)`;
    }
    if (name === "fixnan") return `ctx.fixnan(${compileExpr(e.args[0], ctx)}, ${e.args[0].k === "id" ? safeStr(e.args[0].name) : "null"})`;
    if (name === "float" || name === "int" || name === "bool" || name === "string")
      return e.args.length > 0 ? compileExpr(e.args[0], ctx) : "null";
    if (name === "timestamp") return `ctx.timestamp([${e.args.map(a => compileExpr(a, ctx)).join(",")}])`;
    if (name === "alert" || name === "alertcondition" || name === "runtime") return "null";
    if (name === "__array_literal") return `[${e.args.map(a => compileExpr(a, ctx)).join(",")}]`;

    if (ctx.userFunctionNames.has(name)) {
      const argStrs = e.args.map(a => compileExpr(a, ctx));
      return `_uf.${safeId(name)}(${argStrs.join(", ")})`;
    }
  }

  if (e.fn.k === "na") {
    if (!e.args || e.args.length === 0) return "null";
    return `ctx.isNa(${compileExpr(e.args[0], ctx)})`;
  }

  return `ctx.evalCallFallback(${JSON.stringify(e.fn)}, [${e.args.map(a => compileExpr(a, ctx)).join(",")}], [${e.kw.map(([k, v]) => `[${safeStr(k)},${compileExpr(v, ctx)}]`).join(",")}])`;
}

function compileMathCall(fn: string, args: Expr[], ctx: CompilerContext): string {
  const a = args.map(a => compileExpr(a, ctx));
  switch (fn) {
    case "abs": return `Math.abs(_toNum(${a[0]}))`;
    case "max":
      if (args.length === 1) return `Math.max(...(Array.isArray(_t=${a[0]}) ? _t.map(_toNum) : [_toNum(_t)]))`;
      return `Math.max(${a.map(v => `_toNum(${v})`).join(",")})`;
    case "min":
      if (args.length === 1) return `Math.min(...(Array.isArray(_t=${a[0]}) ? _t.map(_toNum) : [_toNum(_t)]))`;
      return `Math.min(${a.map(v => `_toNum(${v})`).join(",")})`;
    case "sqrt": return `Math.sqrt(_toNum(${a[0]}))`;
    case "round": return `Math.round(_toNum(${a[0]}))`;
    case "floor": return `Math.floor(_toNum(${a[0]}))`;
    case "ceil": return `Math.ceil(_toNum(${a[0]}))`;
    case "log": return `Math.log(_toNum(${a[0]}))`;
    case "log10": return `Math.log10(_toNum(${a[0]}))`;
    case "pow": return `Math.pow(_toNum(${a[0]}),_toNum(${a[1]}))`;
    case "sign": return `Math.sign(_toNum(${a[0]}))`;
    case "avg": return `ctx.mathAvg([${a.join(",")}])`;
    case "sum": return `ctx.mathSum([${a.join(",")}])`;
    case "round_to_mintick": return `((_rt=_toNum(${a[0]})),isNaN(_rt)?null:Math.round(_rt*100)/100)`;
    default: return "NaN";
  }
}

let _taSlotCounter = 0;

function compileTaCall(fn: string, args: Expr[], kw: [string, Expr][], ctx: CompilerContext): string {
  const a = (i: number) => i < args.length ? compileExpr(args[i], ctx) : "null";

  switch (fn) {
    case "crossover": {
      const av = a(0), bv = a(1);
      const ap = compileHistExpr(args[0], 1, ctx);
      const bp = compileHistExpr(args[1], 1, ctx);
      return `(_bar < 1 ? false : ((_ca=${av}),(_cb=${bv}),(_cap=${ap}),(_cbp=${bp}), _toNum(_ca) > _toNum(_cb) && _toNum(_cap) <= _toNum(_cbp)))`;
    }
    case "crossunder": {
      const av = a(0), bv = a(1);
      const ap = compileHistExpr(args[0], 1, ctx);
      const bp = compileHistExpr(args[1], 1, ctx);
      return `(_bar < 1 ? false : ((_ca=${av}),(_cb=${bv}),(_cap=${ap}),(_cbp=${bp}), _toNum(_ca) < _toNum(_cb) && _toNum(_cap) >= _toNum(_cbp)))`;
    }
    case "cross": {
      const av = a(0), bv = a(1);
      const ap = compileHistExpr(args[0], 1, ctx);
      const bp = compileHistExpr(args[1], 1, ctx);
      return `(_bar < 1 ? false : ((_ca=${av}),(_cb=${bv}),(_cap=${ap}),(_cbp=${bp}), (_toNum(_ca) > _toNum(_cb) && _toNum(_cap) <= _toNum(_cbp)) || (_toNum(_ca) < _toNum(_cb) && _toNum(_cap) >= _toNum(_cbp))))`;
    }
    case "change": {
      const v = a(0);
      const len = args.length > 1 ? a(1) : "1";
      const prev = args.length > 1
        ? `ctx.getHistValue(${JSON.stringify(args[0])}, ${a(1)})`
        : compileHistExpr(args[0], 1, ctx);
      return `(_toNum(${v}) - _toNum(${prev}))`;
    }
    default: {
      const slot = _taSlotCounter++;
      const builtins = new Set(["close", "open", "high", "low", "volume", "hl2", "hlc3", "ohlc4"]);
      const srcArg = args[0];
      const srcIsStatic = !srcArg || (srcArg.k === "id" && builtins.has(srcArg.name)) || srcArg.k === "num";
      const srcIsDyn = srcArg && !srcIsStatic && srcArg.k !== "mem" && srcArg.k !== "str";
      const dynFns2: Record<string, string> = { rma: "taDynRma", ema: "taDynEma", sma: "taDynSma", wma: "taDynWma", highest: "taDynHighest", lowest: "taDynLowest", stdev: "taDynStdev", percentrank: "taDynPercentrank", linreg: "taDynLinreg" };
      if (srcIsDyn && args.length >= 2 && dynFns2[fn]) {
        const srcExpr = compileExpr(srcArg, ctx);
        const lenExpr = compileExpr(args[1], ctx);
        return `ctx.${dynFns2[fn]}(${slot}, _toNum(${srcExpr}), ${lenExpr})`;
      }
      if (fn === "barssince" && srcIsDyn && args.length >= 1) {
        const srcExpr = compileExpr(srcArg, ctx);
        return `ctx.taDynBarssince(${slot}, ${srcExpr})`;
      }
      return `ctx.taSlotRead(${slot}, ${safeStr(fn)}, ${JSON.stringify(args)}, ${JSON.stringify(kw)})`;
    }
  }
}

function compileHistExpr(e: Expr, offset: number, ctx: CompilerContext): string {
  if (e.k === "id") return `ctx.getVar(${safeStr(e.name)}, ${offset})`;
  return `ctx.getHistValue(${JSON.stringify(e)}, ${offset})`;
}

function compileStrCall(fn: string, args: Expr[], ctx: CompilerContext): string {
  const a = args.map(a => compileExpr(a, ctx));
  if (fn === "tostring") return `String(${a[0]} ?? "")`;
  if (fn === "format") return `ctx.strFormat(${a.join(",")})`;
  return `""`;
}

function compileStrategyCall(fn: string, args: Expr[], kw: [string, Expr][], ctx: CompilerContext): string {
  const getKw = (name: string, defaultVal: string = "null"): string => {
    const found = kw.find(k => k[0] === name);
    return found ? compileExpr(found[1], ctx) : defaultVal;
  };
  const getArg = (i: number, defaultVal: string = "null"): string => {
    return i < args.length ? compileExpr(args[i], ctx) : defaultVal;
  };

  switch (fn) {
    case "entry": {
      const id = getArg(0);
      const direction = getArg(1);
      const when = getKw("when", "true");
      return `(${when} ? ctx.broker.queueEntry(${id}, ${direction}, _bar, ctx.time()) : null)`;
    }
    case "close": {
      const id = getArg(0);
      const when = getKw("when", "true");
      const qtyPct = getKw("qty_percent", "100");
      const comment = getKw("comment", '""');
      return `(${when} ? ctx.broker.queueClose(${id}, ${qtyPct}, ${comment}, false) : null)`;
    }
    case "close_all": {
      const when = getKw("when", "true");
      const comment = getKw("comment", '""');
      return `(${when} ? ctx.broker.queueClose("", 100, ${comment}, true) : null)`;
    }
    case "exit": {
      const id = getArg(0);
      const fromEntry = getKw("from_entry", getArg(1, '""'));
      const stop = getKw("stop", "null");
      const limit = getKw("limit", "null");
      const trailPrice = getKw("trail_price", "null");
      const trailOffset = getKw("trail_offset", "null");
      const qtyPct = getKw("qty_percent", "100");
      return `ctx.broker.addExit(${id}, ${fromEntry}, ctx.toNumOrNull(${stop}), ctx.toNumOrNull(${limit}), ctx.toNumOrNull(${trailPrice}), ctx.toNumOrNull(${trailOffset}), ctx.toNum(${qtyPct}))`;
    }
    default:
      return "null";
  }
}

function compileStmt(stmt: Stmt, indent: string, ctx: CompilerContext): string[] {
  const lines: string[] = [];
  const i = indent;
  const i2 = indent + "  ";

  switch (stmt.k) {
    case "decl": {
      const name = stmt.name;
      const expr = compileExpr(stmt.e, ctx);
      if (stmt.isVar) {
        lines.push(`${i}{ const _va = _vars[${safeStr(name)}] || (_vars[${safeStr(name)}] = new Array(ctx.n)); ctx.markVar(${safeStr(name)});`);
        lines.push(`${i}  if (_bar === 0) { _va[0] = ${expr}; }`);
        lines.push(`${i}  else { _va[_bar] = _bar > 0 ? (_va[_bar - 1] !== undefined ? _va[_bar - 1] : null) : null; } }`);
      } else {
        if (ctx.precomputedNames.has(name) || ctx.inputDefaultNames.has(name) || ctx.builtinSeriesNames.has(name)) {
          break;
        }
        if (ctx.localVarNames?.has(name)) {
          lines.push(`${i}var ${safeId(name)} = ${expr};`);
        } else {
          lines.push(`${i}ctx.setVar(${safeStr(name)}, ${expr});`);
        }
      }
      break;
    }
    case "multi_decl": {
      const expr = compileExpr(stmt.e, ctx);
      lines.push(`${i}{ const _md = ${expr};`);
      for (let j = 0; j < stmt.names.length; j++) {
        lines.push(`${i}  ctx.setVar(${safeStr(stmt.names[j])}, Array.isArray(_md) ? _md[${j}] : null);`);
      }
      lines.push(`${i}}`);
      break;
    }
    case "reassign": {
      if (stmt.target.k === "id") {
        const name = stmt.target.name;
        const expr = compileExpr(stmt.e, ctx);
        if (ctx.localVarNames?.has(name)) {
          lines.push(`${i}${safeId(name)} = ${expr};`);
        } else if (ctx.varIsVarNames.has(name)) {
          lines.push(`${i}{ const _va = _vars[${safeStr(name)}]; if (_va) _va[_bar] = ${expr}; }`);
        } else {
          lines.push(`${i}ctx.setVar(${safeStr(name)}, ${expr});`);
        }
      } else if (stmt.target.k === "mem" && stmt.target.obj.k === "id") {
        lines.push(`${i}ctx.setMemberVar(${safeStr(stmt.target.obj.name)}, ${safeStr(stmt.target.prop)}, ${compileExpr(stmt.e, ctx)});`);
      }
      break;
    }
    case "aug": {
      if (stmt.target.k === "id") {
        const name = stmt.target.name;
        const val = compileExpr(stmt.e, ctx);
        if (ctx.localVarNames?.has(name)) {
          lines.push(`${i}${safeId(name)} = ctx.binOp(${safeStr(stmt.op.replace("=", ""))}, ${safeId(name)}, ${val});`);
        } else if (ctx.varIsVarNames.has(name)) {
          const readExpr = `((_t = _vars[${safeStr(name)}]), _t ? ((_t = _t[_bar]), _t === undefined ? null : _t) : null)`;
          lines.push(`${i}{ const _va = _vars[${safeStr(name)}]; if (_va) _va[_bar] = ctx.binOp(${safeStr(stmt.op.replace("=", ""))}, ${readExpr}, ${val}); }`);
        } else {
          lines.push(`${i}ctx.setVar(${safeStr(name)}, ctx.binOp(${safeStr(stmt.op.replace("=", ""))}, ctx.getVar(${safeStr(name)}, 0), ${val}));`);
        }
      }
      break;
    }
    case "if": {
      lines.push(`${i}if (${compileExpr(stmt.c, ctx)}) {`);
      for (const s of stmt.body) lines.push(...compileStmt(s, i2, ctx));
      lines.push(`${i}}`);
      if (stmt.elifs) {
        for (const elif of stmt.elifs) {
          lines.push(`${i}else if (${compileExpr(elif.c, ctx)}) {`);
          for (const s of elif.body) lines.push(...compileStmt(s, i2, ctx));
          lines.push(`${i}}`);
        }
      }
      if (stmt.el) {
        lines.push(`${i}else {`);
        for (const s of stmt.el) lines.push(...compileStmt(s, i2, ctx));
        lines.push(`${i}}`);
      }
      break;
    }
    case "for": {
      const start = compileExpr(stmt.start, ctx);
      const end = compileExpr(stmt.end, ctx);
      const step = stmt.step ? compileExpr(stmt.step, ctx) : "1";
      const v = safeId(stmt.v);
      lines.push(`${i}{ var _start = Math.round(_N(${start})), _end = Math.round(_N(${end})), _step = Math.round(_N(${step}));`);
      lines.push(`${i}  if (_step !== 0) {`);
      lines.push(`${i}    var _fc = 0;`);
      lines.push(`${i}    for (let ${v} = _start; _step > 0 ? ${v} <= _end : ${v} >= _end; ${v} += _step) {`);
      lines.push(`${i}      if (++_fc > 10000) break;`);
      lines.push(`${i}      ctx.setVar(${safeStr(stmt.v)}, ${v});`);
      for (const s of stmt.body) lines.push(...compileStmt(s, i + "      ", ctx));
      lines.push(`${i}    }`);
      lines.push(`${i}  }`);
      lines.push(`${i}}`);
      break;
    }
    case "while": {
      lines.push(`${i}{ let _wc = 0;`);
      lines.push(`${i}  while (${compileExpr(stmt.c, ctx)} && ++_wc < 10000) {`);
      for (const s of stmt.body) lines.push(...compileStmt(s, i + "    ", ctx));
      lines.push(`${i}  }`);
      lines.push(`${i}}`);
      break;
    }
    case "switch": {
      if (stmt.e) {
        lines.push(`${i}{ const _sw = ${compileExpr(stmt.e, ctx)};`);
        let first = true;
        for (const c of stmt.cases) {
          const isDefault = c.vals.length === 1 && c.vals[0] === null;
          if (isDefault) {
            lines.push(`${i}${first ? "" : "else "}  {`);
          } else {
            const conds = c.vals.map(v => v === null ? "true" : `_sw === ${compileExpr(v, ctx)}`).join(" || ");
            lines.push(`${i}${first ? "" : "else "}  if (${conds}) {`);
          }
          for (const s of c.body) lines.push(...compileStmt(s, i + "    ", ctx));
          lines.push(`${i}  }`);
          first = false;
        }
        lines.push(`${i}}`);
      } else {
        let first = true;
        for (const c of stmt.cases) {
          const isDefault = c.vals.length === 1 && c.vals[0] === null;
          if (isDefault) {
            lines.push(`${i}${first ? "" : "else "}{`);
          } else {
            const conds = c.vals.map(v => v === null ? "true" : compileExpr(v, ctx)).join(" || ");
            lines.push(`${i}${first ? "" : "else "}if (${conds}) {`);
          }
          for (const s of c.body) lines.push(...compileStmt(s, i + "  ", ctx));
          lines.push(`${i}}`);
          first = false;
        }
      }
      break;
    }
    case "func_decl":
      break;
    case "expr":
      lines.push(`${i}${compileExpr(stmt.e, ctx)};`);
      break;
    case "break":
      lines.push(`${i}break;`);
      break;
    case "continue":
      lines.push(`${i}continue;`);
      break;
  }

  return lines;
}

function compileStmtForValue(stmt: Stmt, indent: string, ctx: CompilerContext, resultVar: string): string[] {
  const lines: string[] = [];
  const i = indent;
  const i2 = indent + "  ";

  if (stmt.k === "expr") {
    lines.push(`${i}let ${resultVar} = ${compileExpr(stmt.e, ctx)};`);
    return lines;
  }

  if (stmt.k === "if") {
    lines.push(`${i}let ${resultVar} = null;`);
    lines.push(`${i}if (${compileExpr(stmt.c, ctx)}) {`);
    const bodyLen = stmt.body.length;
    for (let j = 0; j < bodyLen - 1; j++) lines.push(...compileStmt(stmt.body[j], i2, ctx));
    if (bodyLen > 0) lines.push(`${i2}${resultVar} = ${compileExpr(stmt.body[bodyLen - 1].k === "expr" ? stmt.body[bodyLen - 1].e : { k: "na" } as Expr, ctx)};`);
    lines.push(`${i}}`);
    if (stmt.elifs) {
      for (const elif of stmt.elifs) {
        lines.push(`${i}else if (${compileExpr(elif.c, ctx)}) {`);
        const eLen = elif.body.length;
        for (let j = 0; j < eLen - 1; j++) lines.push(...compileStmt(elif.body[j], i2, ctx));
        if (eLen > 0) lines.push(`${i2}${resultVar} = ${compileExpr(elif.body[eLen - 1].k === "expr" ? elif.body[eLen - 1].e : { k: "na" } as Expr, ctx)};`);
        lines.push(`${i}}`);
      }
    }
    if (stmt.el) {
      lines.push(`${i}else {`);
      const elLen = stmt.el.length;
      for (let j = 0; j < elLen - 1; j++) lines.push(...compileStmt(stmt.el[j], i2, ctx));
      if (elLen > 0) lines.push(`${i2}${resultVar} = ${compileExpr(stmt.el[elLen - 1].k === "expr" ? stmt.el[elLen - 1].e : { k: "na" } as Expr, ctx)};`);
      lines.push(`${i}}`);
    }
    return lines;
  }

  if (stmt.k === "switch") {
    lines.push(`${i}let ${resultVar} = null;`);
    if (stmt.e) {
      lines.push(`${i}{ const _sw = ${compileExpr(stmt.e, ctx)};`);
    }
    let first = true;
    for (const c of stmt.cases) {
      const isDefault = c.vals.length === 1 && c.vals[0] === null;
      if (stmt.e) {
        if (isDefault) {
          lines.push(`${i}${first ? "" : "else "}{`);
        } else {
          const conds = c.vals.map(v => v === null ? "true" : `_sw === ${compileExpr(v, ctx)}`).join(" || ");
          lines.push(`${i}${first ? "" : "else "}if (${conds}) {`);
        }
      } else {
        if (isDefault) {
          lines.push(`${i}${first ? "" : "else "}{`);
        } else {
          const conds = c.vals.map(v => v === null ? "true" : compileExpr(v, ctx)).join(" || ");
          lines.push(`${i}${first ? "" : "else "}if (${conds}) {`);
        }
      }
      const bLen = c.body.length;
      for (let j = 0; j < bLen - 1; j++) lines.push(...compileStmt(c.body[j], i2, ctx));
      if (bLen > 0) {
        const last = c.body[bLen - 1];
        lines.push(`${i2}${resultVar} = ${compileExpr(last.k === "expr" ? last.e : { k: "na" } as Expr, ctx)};`);
      }
      lines.push(`${i}}`);
      first = false;
    }
    if (stmt.e) lines.push(`${i}}`);
    return lines;
  }

  lines.push(...compileStmt(stmt, indent, ctx));
  lines.push(`${i}let ${resultVar} = null;`);
  return lines;
}
