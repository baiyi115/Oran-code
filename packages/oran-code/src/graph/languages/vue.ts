import { registerLanguage, type LanguageSupport } from "./registry.js";
import { extractVueSpecifiersRaw } from "../extract-raw.js";
import { resolveTypeScriptSpecifier } from "./typescript.js";

/**
 * Vue single-file components. The vue grammar keeps <script> contents as raw
 * text, so imports are extracted by re-parsing each script block with the
 * TypeScript grammar — still AST-based, just across two grammars. Resolution
 * reuses the ts-family relative-path model (which also matches .vue targets).
 */

export function registerVue(): void {
  const support: LanguageSupport = {
    id: "vue",
    extensions: [".vue"],
    grammar: "vue",
    importQuery: "",
    extractAsync: extractVueSpecifiersRaw,
    resolve: (fromFile, specifier, context) => resolveTypeScriptSpecifier(fromFile, specifier, context.fileSet),
  };
  registerLanguage(support);
}
