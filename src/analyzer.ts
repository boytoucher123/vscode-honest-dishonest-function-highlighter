/**
 * Honesty analysis over a set of parsed 12dPL files.
 *
 * A function is honest when everything it touches comes in through its parameters:
 *   - it reads/writes no global variables,
 *   - every builtin it calls is honest,
 *   - every user function it calls is honest (transitively; recursion is fine).
 * Dishonesty propagates up the call graph until nothing changes.
 */
import { Builtins, Verdict } from './builtins';
import { CallSite, FunctionDef, MacroDef, ParsedFile } from './parser';

const NUMERIC = new Set(['Integer', 'Integer64', 'Real']);

export type UnknownPolicy = 'unknown' | 'dishonest' | 'honest';

export interface AnalyzeOptions {
  /** How to treat calls to functions that can't be found anywhere. */
  unknownFunctions: UnknownPolicy;
}

export interface SourceFile {
  path: string;
  parsed: ParsedFile;
  /** Lower = preferred when several files define the same function (entry/includes before workspace). */
  priority: number;
}

export interface FunctionResult {
  file: string;
  def: FunctionDef;
  verdict: Verdict;
  /** Human-readable explanation; for propagated dishonesty this is the whole chain. */
  reason: string;
  /** When the dishonesty comes (directly or through calls) from a global variable, its name. */
  global?: string;
}

export interface Highlight {
  offset: number;
  length: number;
  verdict: Verdict;
  kind: 'definition' | 'call';
  name: string;
  /** Markdown explanation for hovers. */
  reason: string;
  /** Global variable at the root of the dishonesty, if any (so the hover can offer to ignore it). */
  global?: string;
}

export interface AnalysisResult {
  functions: FunctionResult[];
  /** Highlights for the requested file only. */
  highlights: Highlight[];
}

type Target =
  | { kind: 'user'; fns: FunctionResult[] }
  | { kind: 'builtin'; verdict: Verdict; reason: string; signature?: string }
  | { kind: 'macro'; verdict: Verdict; reason: string }
  | { kind: 'unknown' };

export function analyze(
  files: SourceFile[],
  entryPath: string,
  builtins: Builtins,
  options: AnalyzeOptions,
): AnalysisResult {
  const sorted = [...files].sort((a, b) => a.priority - b.priority);

  // --- Symbol tables -----------------------------------------------------
  const fnsByName = new Map<string, FunctionResult[]>();
  const results: FunctionResult[] = [];
  const globals = new Map<string, string>(); // name -> file
  const macros = new Map<string, MacroDef>();
  const bestPriority = new Map<string, number>();

  for (const f of sorted) {
    for (const g of f.parsed.globals) if (!globals.has(g.name)) globals.set(g.name, f.path);
    for (const m of f.parsed.macros) if (!macros.has(m.name)) macros.set(m.name, m);
    for (const def of f.parsed.functions) {
      if (def.isPrototype) continue;
      // Only keep definitions from the best-priority file for each name (e.g. includes over workspace fallbacks).
      const best = bestPriority.get(def.name);
      if (best !== undefined && best < f.priority) continue;
      bestPriority.set(def.name, f.priority);
      const r: FunctionResult = { file: f.path, def, verdict: 'honest', reason: 'Only accesses its parameters.' };
      results.push(r);
      const list = fnsByName.get(def.name) ?? [];
      fnsByName.set(def.name, list);
      list.push(r);
    }
  }

  // --- Call resolution ---------------------------------------------------
  const macroCache = new Map<string, { verdict: Verdict; reason: string }>();

  const resolve = (call: CallSite, depth = 0): Target => {
    const user = fnsByName.get(call.name);
    if (user?.length) {
      const arity = user.filter((r) => r.def.params.length === call.argCount);
      if (arity.length) {
        const matches = (r: FunctionResult, loose: boolean) =>
          call.argTypes.every((t, i) => !t || !r.def.params[i] || t === r.def.params[i].type || (loose && NUMERIC.has(t) && NUMERIC.has(r.def.params[i].type)));
        const exact = arity.filter((r) => matches(r, false));
        const loose = arity.filter((r) => matches(r, true));
        return { kind: 'user', fns: exact.length ? exact : loose.length ? loose : arity };
      }
      if (!builtins.has(call.name)) return { kind: 'user', fns: user };
    }
    const macro = macros.get(call.name);
    if (macro && macro.params !== undefined && depth < 8) {
      return { kind: 'macro', ...macroVerdict(macro, depth) };
    }
    if (builtins.has(call.name)) {
      const res = builtins.resolve(call.name, call.argCount, call.argTypes)!;
      const sig = res.candidates.length === 1 ? res.candidates[0].overload.signature : undefined;
      return { kind: 'builtin', verdict: res.verdict, reason: res.reason, signature: sig };
    }
    return { kind: 'unknown' };
  };

  // Macros are evaluated against the *final* user-function verdicts, so they're computed lazily
  // after propagation (cache cleared each round).
  const macroVerdict = (macro: MacroDef, depth: number): { verdict: Verdict; reason: string } => {
    const cached = macroCache.get(macro.name);
    if (cached) return cached;
    macroCache.set(macro.name, { verdict: 'honest', reason: 'Macro (being evaluated).' }); // recursion guard
    let out: { verdict: Verdict; reason: string } = { verdict: 'honest', reason: `Macro \`${macro.name}\` only uses honest calls.` };
    for (const c of macro.calls) {
      const v = targetVerdict(resolve(c, depth + 1), c.name);
      if (v.verdict === 'dishonest') {
        out = { verdict: 'dishonest', reason: `Macro \`${macro.name}\` calls ${v.reason}` };
        break;
      }
      if (v.verdict === 'unknown') out = { verdict: 'unknown', reason: `Macro \`${macro.name}\` calls ${v.reason}` };
    }
    macroCache.set(macro.name, out);
    return out;
  };

  const targetVerdict = (t: Target, name: string): { verdict: Verdict; reason: string } => {
    switch (t.kind) {
      case 'builtin':
        return { verdict: t.verdict, reason: `\`${t.signature ?? name}\` — ${t.reason}` };
      case 'macro':
        return { verdict: t.verdict, reason: t.reason };
      case 'unknown':
        if (options.unknownFunctions === 'unknown') return { verdict: 'unknown', reason: `\`${name}\`, which could not be found.` };
        return { verdict: options.unknownFunctions, reason: `\`${name}\`, which could not be found (treated as ${options.unknownFunctions}).` };
      case 'user': {
        const d = t.fns.find((f) => f.verdict === 'dishonest');
        if (d) return { verdict: 'dishonest', reason: `\`${name}\` → ${d.reason}` };
        const u = t.fns.find((f) => f.verdict === 'unknown');
        if (u) return { verdict: 'unknown', reason: `\`${name}\` → ${u.reason}` };
        return { verdict: 'honest', reason: `\`${name}\` (honest)` };
      }
    }
  };

  // --- Direct verdicts ---------------------------------------------------
  const overridden = new Set<FunctionResult>();
  const resolvedCalls = new Map<FunctionResult, { call: CallSite; target: Target }[]>();
  for (const r of results) {
    const ov = builtins.nameOverride(r.def.name);
    if (ov) {
      r.verdict = ov;
      r.reason = `Overridden to ${ov} by user.`;
      overridden.add(r);
    }
    resolvedCalls.set(r, r.def.calls.map((call) => ({ call, target: resolve(call) })));
    if (overridden.has(r)) continue;

    const g = r.def.freeRefs.find((ref) => globals.has(ref.name) && !macros.has(ref.name) && !builtins.isIgnoredGlobal(ref.name));
    if (g) {
      r.verdict = 'dishonest';
      r.reason = `uses global variable \`${g.name}\`.`;
      r.global = g.name;
      continue;
    }
    for (const { call, target } of resolvedCalls.get(r)!) {
      if (target.kind === 'user') continue; // handled by propagation
      const v = targetVerdict(target, call.name);
      if (v.verdict === 'dishonest') {
        r.verdict = 'dishonest';
        r.reason = `calls ${v.reason}`;
        break;
      }
      if (v.verdict === 'unknown' && r.verdict === 'honest') {
        r.verdict = 'unknown';
        r.reason = `calls ${v.reason}`;
      }
    }
  }

  // --- Propagation -------------------------------------------------------
  // 1. dishonesty, to a fixpoint; 2. unknown-ness, to a fixpoint (it can't create dishonesty).
  const propagate = (to: Verdict, from: Verdict[]) => {
    let changed = true;
    while (changed) {
      changed = false;
      macroCache.clear();
      for (const r of results) {
        if (overridden.has(r) || r.verdict === 'dishonest' || r.verdict === to) continue;
        for (const { call, target } of resolvedCalls.get(r)!) {
          if (target.kind !== 'user' && target.kind !== 'macro') continue;
          const t = target.kind === 'macro' ? resolve(call) : target;
          const v = targetVerdict(t, call.name);
          if (v.verdict === to && from.includes(r.verdict)) {
            r.verdict = to;
            r.reason = `calls ${v.reason}`;
            r.global = t.kind === 'user' ? t.fns.find((f) => f.verdict === to)?.global : undefined;
            changed = true;
            break;
          }
        }
      }
    }
  };
  propagate('dishonest', ['honest', 'unknown']);
  propagate('unknown', ['honest']);
  macroCache.clear();

  // --- Highlights for the entry file ---------------------------------------
  const highlights: Highlight[] = [];
  const entry = files.find((f) => f.path === entryPath);
  if (entry) {
    for (const def of entry.parsed.functions) {
      // Prototypes take the verdict of their definition.
      const r = def.isPrototype
        ? (fnsByName.get(def.name) ?? []).find((x) => x.def.params.length === def.params.length) ?? fnsByName.get(def.name)?.[0]
        : results.find((x) => x.def === def);
      if (r) {
        highlights.push({
          offset: def.nameOffset,
          length: def.name.length,
          verdict: r.verdict,
          kind: 'definition',
          name: def.name,
          reason: explain(def.name, r.verdict, r.reason),
          global: r.verdict === 'dishonest' ? r.global : undefined,
        });
      }
      for (const call of def.calls) {
        const t = resolve(call);
        const v = targetVerdict(t, call.name);
        let reason: string;
        let global: string | undefined;
        if (t.kind === 'user') {
          const f = t.fns.find((x) => x.verdict === v.verdict) ?? t.fns[0];
          reason = explain(call.name, v.verdict, f.reason);
          if (v.verdict === 'dishonest') global = f.global;
        } else if (t.kind === 'builtin') {
          reason = explain(t.signature ?? call.name, v.verdict, t.reason) + '\n\n_Built-in 12dPL call._';
        } else if (t.kind === 'unknown') {
          reason = explain(call.name, v.verdict, v.reason.replace(/^`[^`]*`, which/, 'This function'));
        } else {
          reason = explain(call.name, v.verdict, v.reason);
        }
        highlights.push({ offset: call.offset, length: call.name.length, verdict: v.verdict, kind: 'call', name: call.name, reason, global });
      }
    }
  }
  macroCache.clear();

  return { functions: results, highlights };
}

function explain(name: string, verdict: Verdict, reason: string): string {
  const label = verdict === 'honest' ? '✅ **Honest**' : verdict === 'dishonest' ? '❌ **Dishonest**' : '❔ **Unknown**';
  const r = reason.charAt(0).toUpperCase() + reason.slice(1);
  return `${label} — \`${name}\`\n\n${r}`;
}
