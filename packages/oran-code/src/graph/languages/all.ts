import { registerTypeScriptFamily } from "./typescript.js";
import { registerPython } from "./python.js";
import { registerGo } from "./go.js";
import { registerRust } from "./rust.js";
import { registerCFamily } from "./c.js";
import { registerJava } from "./java.js";
import { registerCSharp } from "./csharp.js";
import { registerKotlin } from "./kotlin.js";
import { registerScala } from "./scala.js";
import { registerPhp } from "./php.js";
import { registerRuby } from "./ruby.js";
import { registerSwift } from "./swift.js";
import { registerLua } from "./lua.js";
import { registerBash } from "./bash.js";
import { registerDart } from "./dart.js";
import { registerVue } from "./vue.js";

let registered = false;

/** Idempotent registration of every supported language. */
export function registerAllLanguages(): void {
  if (registered) return;
  registerTypeScriptFamily();
  registerPython();
  registerGo();
  registerRust();
  registerCFamily();
  registerJava();
  registerCSharp();
  registerKotlin();
  registerScala();
  registerPhp();
  registerRuby();
  registerSwift();
  registerLua();
  registerBash();
  registerDart();
  registerVue();
  registered = true;
}
