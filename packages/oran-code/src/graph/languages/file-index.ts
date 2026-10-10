/**
 * Lookups over one build's file set.
 *
 * A resolver is called once per import specifier, and the direct way to answer "which files live
 * in this directory / under this prefix / with this suffix" is to filter the whole file set every
 * time — O(specifiers × files), which is what the language resolvers used to do. The index is
 * built once per build instead: the file set *is* the identity of a build, so it is the cache key,
 * and the same set is passed to every resolver of that build.
 *
 * Every lookup returns files in sorted order, the order the resolvers used to produce with a
 * `filter(...).sort()` — the file set is sorted once and each bucket keeps that order.
 */

export interface FileIndex {
  /** Files directly inside one directory, optionally narrowed to one extension. */
  containedIn(directory: string, extension?: string): readonly string[];
  /** Files under a path prefix, optionally narrowed to one extension. */
  withPrefix(prefix: string, extension?: string): readonly string[];
  /** Files equal to `<suffix>` or ending in `/<suffix>`. */
  withSuffix(suffix: string): readonly string[];
  /** Whether any file starts with `prefix`. */
  hasPrefix(prefix: string): boolean;
}

/** Keyed by the build's file set, so the index is built once and released with the build. */
const indexes = new WeakMap<ReadonlySet<string>, FileIndex>();

export function fileIndexFor(fileSet: ReadonlySet<string>): FileIndex {
  const cached = indexes.get(fileSet);
  if (cached) return cached;
  const index = buildIndex(fileSet);
  indexes.set(fileSet, index);
  return index;
}

function buildIndex(fileSet: ReadonlySet<string>): FileIndex {
  const all = [...fileSet].sort();
  const byDirectory = new Map<string, string[]>();
  const byExtension = new Map<string, string[]>();
  const byBasename = new Map<string, string[]>();
  for (const file of all) {
    append(byDirectory, directoryOf(file), file);
    append(byExtension, extensionOf(file), file);
    append(byBasename, basenameOf(file), file);
  }

  const withExtension = (bucket: readonly string[] | undefined, extension?: string): readonly string[] => {
    if (extension === undefined) return bucket ?? [];
    // Extensions are compared as written, not case-folded: a scan for `.go` never matched `X.GO`
    // and must keep not matching it.
    return (bucket ?? []).filter((file) => extensionOf(file) === extension);
  };

  return {
    containedIn: (directory, extension) => withExtension(byDirectory.get(directory), extension),
    withPrefix: (prefix, extension) => {
      const source = extension === undefined ? all : (byExtension.get(extension) ?? []);
      const matches: string[] = [];
      for (let index = lowerBound(source, prefix); index < source.length; index += 1) {
        const file = source[index] as string;
        if (!file.startsWith(prefix)) break;
        matches.push(file);
      }
      return matches;
    },
    withSuffix: (suffix) => {
      const candidates = byBasename.get(basenameOf(suffix)) ?? [];
      return candidates.filter((file) => file === suffix || file.endsWith(`/${suffix}`));
    },
    hasPrefix: (prefix) => {
      const index = lowerBound(all, prefix);
      return index < all.length && (all[index] as string).startsWith(prefix);
    },
  };
}

function append(bucket: Map<string, string[]>, key: string, file: string): void {
  const existing = bucket.get(key);
  if (existing) existing.push(file);
  else bucket.set(key, [file]);
}

/** First index whose value is not less than `value`; the list must be sorted. */
function lowerBound(list: readonly string[], value: string): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((list[middle] as string) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "." : path.slice(0, cut);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Empty for a file with no extension; the resolvers pass the extension they scan for. */
function extensionOf(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}
