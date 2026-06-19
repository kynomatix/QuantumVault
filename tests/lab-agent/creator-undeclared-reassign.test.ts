// AI Creator compile-repair gate: our Pine engine is lenient about `:=` to a
// never-declared variable, but TradingView rejects it (CE10272 / CE10194). These lock
// findUndeclaredReassignments — the check wired into the Creator's tryCompile — so a
// generated strategy is valid Pine on BOTH engines, while real declaration forms (and
// block-local / loop / param / multi-assign decls) never produce a false positive.

import { describe, it, expect } from "vitest";
import { compilePine } from "../../server/lab/pine/index";
import { findUndeclaredReassignments } from "../../server/lab/pine/compiler";

function check(src: string): string[] {
  return findUndeclaredReassignments(compilePine(src).ast, src);
}

const HEAD = '//@version=6\nstrategy("t", overlay=true)\n';

describe("findUndeclaredReassignments", () => {
  it("flags `:=` on a variable never declared anywhere (the reported bug)", () => {
    const src = HEAD + "atr = ta.atr(14)\nif close > open\n    stopDist := atr * 2.0\nplot(close)\n";
    const errs = check(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('"stopDist"');
  });

  it("passes when the variable is declared at the top with var", () => {
    const src = HEAD + "atr = ta.atr(14)\nvar float stopDist = na\nif close > open\n    stopDist := atr * 2.0\nplot(stopDist)\n";
    expect(check(src)).toEqual([]);
  });

  it("passes when declared with `=` inside the same block (block-local)", () => {
    const src = HEAD + "if close > open\n    x = 1\n    x := x + 1\nplot(close)\n";
    expect(check(src)).toEqual([]);
  });

  it("passes for augmented assignment on a declared var", () => {
    const src = HEAD + "var int n = 0\nif close > open\n    n += 1\nplot(close)\n";
    expect(check(src)).toEqual([]);
  });

  it("flags augmented assignment on an undeclared var", () => {
    const src = HEAD + "if close > open\n    n += 1\nplot(close)\n";
    const errs = check(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('"n"');
  });

  it("treats loop vars, function params and multi-assign names as declared", () => {
    const src =
      HEAD +
      "f(a, b) =>\n    a := a + b\n    a\n" +
      "[hi, lo] = ta.macd(close, 12, 26, 9)\n" +
      "total = 0.0\n" +
      "for i = 0 to 5\n    total := total + i\n" +
      "plot(f(hi, lo) + total)\n";
    expect(check(src)).toEqual([]);
  });

  it("flags reassignment of a read-only built-in", () => {
    const src = HEAD + "if close > open\n    close := open\nplot(close)\n";
    const errs = check(src);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('"close"');
  });

  it("does NOT flag a global var that is only reassigned (declared globally)", () => {
    const src = HEAD + "var float entryPrice = na\nif close > open\n    entryPrice := close\nelse\n    entryPrice := na\nplot(entryPrice)\n";
    expect(check(src)).toEqual([]);
  });
});
