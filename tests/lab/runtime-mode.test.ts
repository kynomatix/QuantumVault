import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLabProductionBundle } from "../../server/lab/runtime-mode";

afterEach(() => vi.unstubAllGlobals());

describe("Lab production bundle selection", () => {
  it("uses the actual esbuild define without setting a globalThis flag", async () => {
    vi.stubGlobal("__ESBUILD_CJS_BUNDLE__", undefined);
    const source = await readFile(new URL("../../server/lab/runtime-mode.ts", import.meta.url), "utf8");
    const { code } = await transform(source, {
      loader: "ts", format: "cjs", define: { __ESBUILD_CJS_BUNDLE__: "true" },
    });
    const output = { exports: {} as { isLabProductionBundle(): boolean } };
    new Function("module", "exports", code)(output, output.exports);
    expect(output.exports.isLabProductionBundle()).toBe(true);
    expect((globalThis as any).__ESBUILD_CJS_BUNDLE__).toBeUndefined();
  });

  it("keeps development source mode and an explicit false flag out of bundle mode", () => {
    vi.stubGlobal("__ESBUILD_CJS_BUNDLE__", undefined);
    expect(isLabProductionBundle()).toBe(false);
    vi.stubGlobal("__ESBUILD_CJS_BUNDLE__", false);
    expect(isLabProductionBundle()).toBe(false);
  });
});
