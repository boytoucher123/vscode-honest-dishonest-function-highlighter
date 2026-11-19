/**
 * Builds the set of files an analysis needs: the document, its #include closure, and
 * (optionally) other workspace files as a low-priority fallback for unresolved calls.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SourceFile } from './analyzer';
import { ParsedFile, parse12dpl } from './parser';

export interface FileReader {
  /** Returns the text of an open (possibly unsaved) document, if any. */
  openText(fsPath: string): string | undefined;
}

/** Parses files and caches the result by path + content. */
export class ParseCache {
  private cache = new Map<string, { text: string; parsed: ParsedFile }>();
  private diskCache = new Map<string, { mtime: number; size: number; parsed: ParsedFile }>();
  constructor(private isType: (name: string) => boolean) {}

  parse(fsPath: string, text: string): ParsedFile {
    const key = canonical(fsPath);
    const hit = this.cache.get(key);
    if (hit && hit.text === text) return hit.parsed;
    const parsed = parse12dpl(text, this.isType);
    this.cache.set(key, { text, parsed });
    return parsed;
  }

  /** Parses an open document's text if available, else the file on disk (cached by mtime/size). */
  read(fsPath: string, reader?: FileReader): ParsedFile | undefined {
    const open = reader?.openText(fsPath);
    if (open !== undefined) return this.parse(fsPath, open);
    const key = canonical(fsPath);
    let st: fs.Stats;
    try {
      st = fs.statSync(fsPath);
    } catch {
      return undefined;
    }
    const hit = this.diskCache.get(key);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.parsed;
    const text = readFileSafe(fsPath);
    if (text === undefined) return undefined;
    const parsed = parse12dpl(text, this.isType);
    this.diskCache.set(key, { mtime: st.mtimeMs, size: st.size, parsed });
    return parsed;
  }

  invalidate(fsPath: string) {
    this.cache.delete(canonical(fsPath));
    this.diskCache.delete(canonical(fsPath));
  }

  clear() {
    this.cache.clear();
    this.diskCache.clear();
  }
}

export function canonical(p: string): string {
  const r = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function readFileSafe(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

export function resolveInclude(fromFile: string, inc: string, includeDirs: string[]): string | undefined {
  const candidates = path.isAbsolute(inc)
    ? [inc]
    : [path.join(path.dirname(fromFile), inc), ...includeDirs.map((d) => path.join(path.isAbsolute(d) ? d : path.resolve(path.dirname(fromFile), d), inc))];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not found */
    }
  }
  return undefined;
}

export interface ClosureResult {
  files: SourceFile[];
  unresolvedIncludes: { from: string; include: string }[];
}

/** The entry document plus everything it #includes (recursively). */
export function collectClosure(
  entryPath: string,
  entryText: string,
  cache: ParseCache,
  includeDirs: string[],
  reader?: FileReader,
  maxFiles = 500,
): ClosureResult {
  const files: SourceFile[] = [];
  const unresolvedIncludes: ClosureResult['unresolvedIncludes'] = [];
  const seen = new Set<string>([canonical(entryPath)]);
  const entryDir = path.dirname(entryPath);
  const queue: { path: string; parsed: ParsedFile; depth: number }[] = [
    { path: entryPath, parsed: cache.parse(entryPath, entryText), depth: 0 },
  ];
  while (queue.length && files.length < maxFiles) {
    const cur = queue.shift()!;
    files.push({ path: cur.path, parsed: cur.parsed, priority: cur.depth });
    for (const inc of cur.parsed.includes) {
      const resolved = resolveInclude(cur.path, inc.path, [entryDir, ...includeDirs]);
      if (!resolved) {
        unresolvedIncludes.push({ from: cur.path, include: inc.path });
        continue;
      }
      const key = canonical(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      const parsed = cache.read(resolved, reader);
      if (parsed) queue.push({ path: resolved, parsed, depth: cur.depth + 1 });
    }
  }
  return { files, unresolvedIncludes };
}
