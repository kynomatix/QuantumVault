import { labStorage } from "../storage";
import { parsePine } from "./parser";
import { compilePineHotLoop, type CompilerContext } from "./compiler";

async function main() {
  const strategy = await labStorage.getStrategy(6);
  if (!strategy) { console.log("Strategy not found"); process.exit(1); }
  
  const ast = parsePine(strategy.pineScript);
  
  // Collect hotStmts from AST
  const hotStmts = ast.stmts.filter((s: any) => 
    s.k !== "strategy_decl" && s.k !== "func_def" && s.k !== "import"
  );
  
  const userFunctions: Record<string, { params: string[]; body: any[] }> = {};
  for (const s of ast.stmts) {
    if (s.k === "func_def") {
      userFunctions[s.name] = { params: s.params, body: s.body };
    }
  }

  const varIsVarSet = new Set<string>();
  for (const s of hotStmts) {
    if (s.k === "decl" && s.isVar) varIsVarSet.add(s.name);
  }
  
  const ctx: CompilerContext = {
    precomputedNames: new Set(),
    inputDefaultNames: new Set(),
    builtinSeriesNames: new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]),
    paramNames: new Set(),
    varIsVarNames: varIsVarSet,
    userFunctionNames: new Set(Object.keys(userFunctions)),
  };
  
  const result = compilePineHotLoop(hotStmts, userFunctions, ctx);
  if (!result) {
    console.log("Compilation failed/returned null");
  } else {
    console.log("Compilation succeeded");
    // The function source
    console.log(result.toString().slice(0, 3000));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
