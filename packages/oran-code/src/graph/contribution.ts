import { analyzeFile, symbolQueries } from "./extract.js";
import { isIncompleteAnalysis } from "./extract-raw.js";
import { readFileSymbols, type FileSymbols } from "./symbols.js";
import type { LanguageSupport, ResolveContext, UnresolvedImport } from "./languages/registry.js";

/**
 * One file's contribution to the index, derived from a single analysis: the
 * out-edges of its import specifiers, the specifiers that did not resolve, and
 * its L2 symbol data.
 *
 * The full build and the incremental rebuild both come through here, so a file
 * is analyzed identically whichever path re-extracted it, and the "was it
 * actually analyzed?" decision is made in exactly one place.
 */
export interface FileContribution {
  imports: string[];
  unresolved: UnresolvedImport[];
  symbols?: FileSymbols | undefined;
  /** The analysis was incomplete; the file belongs in `index.unparsed`. */
  incomplete: boolean;
}

/** Analyze one already-read source and reduce it to its index contribution. */
export async function analyzeContribution(
  support: LanguageSupport,
  path: string,
  source: string,
  resolveContext: ResolveContext,
): Promise<FileContribution> {
  const analysis = await analyzeFile(support, source, support.symbols ? symbolQueries(support) : {});
  const imports: string[] = [];
  const unresolved: UnresolvedImport[] = [];
  for (const specifier of analysis.specifiers) {
    const result = support.resolve(path, specifier, resolveContext);
    if (result.kind === "resolved") {
      for (const target of result.paths) {
        if (target !== path && !imports.includes(target)) imports.push(target);
      }
    } else if (!unresolved.some((item) => item.specifier === specifier && item.reason === result.reason)) {
      unresolved.push({ specifier, reason: result.reason });
    }
  }
  return {
    imports: imports.sort(),
    unresolved,
    ...(support.symbols ? { symbols: readFileSymbols(support, path, analysis, resolveContext) } : {}),
    incomplete: isIncompleteAnalysis(analysis),
  };
}
