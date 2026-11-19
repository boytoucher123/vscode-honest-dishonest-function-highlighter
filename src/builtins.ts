/**
 * Built-in 12dPL library calls: default classification (data/builtins.json) plus user overrides.
 */

export type Honesty = 'honest' | 'dishonest';
export type Verdict = Honesty | 'unknown';

export interface BuiltinOverload {
  id: number;
  signature: string;
  returnType: string;
  params: { name: string; type: string; ref: boolean }[];
  category: string;
  honesty: Honesty;
  reason: string;
}

export interface BuiltinData {
  functions: Record<string, BuiltinOverload[]>;
}

/**
 * User overrides. Keys in `functions` are either a bare name (`Print`, `My_function`) which
 * applies to every overload, or a signature (`Get_name(Element, Text &)`) for one overload.
 * `categories` re-classifies every builtin of a category (e.g. `"element": "dishonest"`).
 */
export interface Overrides {
  functions: Record<string, Honesty>;
  categories: Record<string, Honesty>;
}

export const emptyOverrides = (): Overrides => ({ functions: {}, categories: {} });

export function mergeOverrides(...list: (Partial<Overrides> | undefined)[]): Overrides {
  const out = emptyOverrides();
  for (const o of list) {
    if (!o) continue;
    for (const [k, v] of Object.entries(o.functions ?? {})) if (isHonesty(v)) out.functions[normalizeKey(k)] = v;
    for (const [k, v] of Object.entries(o.categories ?? {})) if (isHonesty(v)) out.categories[k] = v;
  }
  return out;
}

function isHonesty(v: unknown): v is Honesty {
  return v === 'honest' || v === 'dishonest';
}

/** Normalises an override key: drops whitespace and `&` so `Foo(Text &)` == `Foo(Text&)` == `Foo(Text)`. */
export function normalizeKey(key: string): string {
  return key.replace(/[\s&]/g, '');
}

export interface ResolvedBuiltin {
  verdict: Honesty;
  /** The overloads considered after arity / type filtering. */
  candidates: { overload: BuiltinOverload; honesty: Honesty; reason: string }[];
  reason: string;
}

const NUMERIC = new Set(['Integer', 'Integer64', 'Real']);

function compatible(argType: string, paramType: string): boolean {
  if (argType === paramType) return true;
  if (NUMERIC.has(argType) && NUMERIC.has(paramType)) return true;
  return false;
}

export class Builtins {
  private readonly types: Set<string>;

  constructor(private readonly data: BuiltinData, private overrides: Overrides = emptyOverrides()) {
    this.types = new Set();
    for (const list of Object.values(data.functions)) {
      for (const o of list) {
        this.types.add(o.returnType);
        for (const p of o.params) this.types.add(p.type);
      }
    }
  }

  setOverrides(o: Overrides) {
    this.overrides = o;
  }

  getOverrides(): Overrides {
    return this.overrides;
  }

  /** All type names that appear in the library documentation. */
  typeNames(): Set<string> {
    return this.types;
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.functions, name);
  }

  entries(): [string, BuiltinOverload[]][] {
    return Object.entries(this.data.functions);
  }

  overloads(name: string): BuiltinOverload[] {
    return this.has(name) ? this.data.functions[name] : [];
  }

  categories(): string[] {
    const s = new Set<string>();
    for (const list of Object.values(this.data.functions)) for (const o of list) s.add(o.category);
    return [...s].sort();
  }

  /** Effective honesty of one overload after overrides. */
  classify(o: BuiltinOverload, name: string): { honesty: Honesty; reason: string } {
    const sig = this.overrides.functions[normalizeKey(o.signature)];
    if (sig) return { honesty: sig, reason: `Overridden for ${o.signature}.` };
    const byName = this.overrides.functions[name];
    if (byName) return { honesty: byName, reason: `Overridden for ${name}.` };
    const cat = this.overrides.categories[o.category];
    if (cat) return { honesty: cat, reason: `Category "${o.category}" overridden to ${cat}.` };
    return { honesty: o.honesty, reason: o.reason };
  }

  /** Name-level override (applies to user-defined functions too). */
  nameOverride(name: string): Honesty | undefined {
    return this.overrides.functions[name];
  }

  /**
   * Resolves a call to a builtin by name, argument count and (where known) argument types.
   * If the remaining overloads disagree, the call is treated as dishonest.
   */
  resolve(name: string, argCount: number, argTypes: (string | null)[]): ResolvedBuiltin | undefined {
    const all = this.overloads(name);
    if (!all.length) return undefined;
    let cands = all.filter((o) => o.params.length === argCount);
    if (!cands.length) cands = all;
    // Prefer overloads whose known argument types match exactly, then ones that match after
    // numeric conversion (Integer -> Real etc).
    const exact = cands.filter((o) => argTypes.every((t, i) => !t || !o.params[i] || t === o.params[i].type));
    const loose = cands.filter((o) => argTypes.every((t, i) => !t || !o.params[i] || compatible(t, o.params[i].type)));
    if (exact.length) cands = exact;
    else if (loose.length) cands = loose;

    const classified = cands.map((overload) => ({ overload, ...this.classify(overload, name) }));
    const dishonest = classified.filter((c) => c.honesty === 'dishonest');
    if (!dishonest.length) {
      return { verdict: 'honest', candidates: classified, reason: classified[0].reason };
    }
    if (dishonest.length === classified.length) {
      return { verdict: 'dishonest', candidates: classified, reason: dishonest[0].reason };
    }
    return {
      verdict: 'dishonest',
      candidates: classified,
      reason: `Could not tell which overload is called; ${dishonest[0].overload.signature} is dishonest (${dishonest[0].reason})`,
    };
  }
}
