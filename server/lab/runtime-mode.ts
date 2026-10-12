// Match script/build.ts's esbuild identifier define, not a globalThis property.
declare const __ESBUILD_CJS_BUNDLE__: boolean | undefined;

export function isLabProductionBundle(): boolean {
  return typeof __ESBUILD_CJS_BUNDLE__ !== "undefined" && __ESBUILD_CJS_BUNDLE__ === true;
}
