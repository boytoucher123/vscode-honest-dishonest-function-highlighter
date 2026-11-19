/**
 * Extracts what the honesty analysis needs from one 12dPL source file:
 * includes, #defines, global variables, function definitions, and — per function —
 * the calls it makes and the globals it touches.
 */
import { Token, tokenize } from './tokenizer';

export interface Param {
  name: string;
  type: string;
  ref: boolean;
  array: boolean;
}

export interface CallSite {
  name: string;
  offset: number;
  argCount: number;
  /** Best-effort static type of each argument, or null when unknown. */
  argTypes: (string | null)[];
}

/** An identifier read/written in a body that is not a local, parameter or call. */
export interface FreeRef {
  name: string;
  offset: number;
}

export interface FunctionDef {
  name: string;
  returnType: string;
  params: Param[];
  /** Offset of the function name in the file. */
  nameOffset: number;
  /** Body range (offset of '{' to offset after '}'). Undefined for prototypes. */
  body?: { start: number; end: number };
  calls: CallSite[];
  /** Identifiers not declared locally — resolved against globals by the analyzer. */
  freeRefs: FreeRef[];
  isPrototype: boolean;
}

export interface MacroDef {
  name: string;
  params?: string[];
  value: string;
  offset: number;
  /** Calls appearing in the macro body. */
  calls: CallSite[];
}

export interface GlobalVar {
  name: string;
  type: string;
  offset: number;
}

export interface ParsedFile {
  includes: { path: string; offset: number }[];
  macros: MacroDef[];
  globals: GlobalVar[];
  functions: FunctionDef[];
}

export const KEYWORDS = new Set([
  'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'sizeof',
  'void', 'const', 'static', 'extern', 'struct', 'typedef', 'unsigned', 'signed',
]);

/** Primitive / core types that always exist even if the documentation doesn't list them. */
export const CORE_TYPES = ['void', 'Integer', 'Integer64', 'Real', 'Text', 'Element', 'Uid', 'Guid'];

export function parse12dpl(text: string, isType: (name: string) => boolean): ParsedFile {
  const { tokens, directives } = tokenize(text);
  const result: ParsedFile = { includes: [], macros: [], globals: [], functions: [] };

  for (const d of directives) {
    if (d.name === 'include') {
      const m = /^\s*[<"]([^>"]+)[>"]/.exec(d.body);
      if (m) result.includes.push({ path: m[1], offset: d.offset });
    } else if (d.name === 'define') {
      const m = /^\s*([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/s.exec(d.body);
      if (!m) continue;
      const nameIdx = d.body.indexOf(m[1]);
      const macro: MacroDef = {
        name: m[1],
        params: m[2] !== undefined ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        value: m[4],
        offset: d.bodyOffset + nameIdx,
        calls: [],
      };
      const bodyTokens = tokenize(m[4]).tokens;
      for (let i = 0; i < bodyTokens.length - 1; i++) {
        const t = bodyTokens[i];
        if (t.kind === 'ident' && bodyTokens[i + 1].value === '(' && !KEYWORDS.has(t.value)) {
          macro.calls.push({ name: t.value, offset: -1, argCount: countArgs(bodyTokens, i + 1), argTypes: [] });
        }
      }
      result.macros.push(macro);
    }
  }

  const globalTypes = new Map<string, string>();
  const n = tokens.length;
  // Pass 0 collects globals (so argument types are known regardless of order), pass 1 does functions.
  for (const collectOnly of [true, false]) {
  let i = 0;
  while (i < n) {
    const t = tokens[i];

    // Top-level `{ ... }` block: 12dPL global variable section.
    if (t.value === '{') {
      const end = matching(tokens, i);
      if (collectOnly) {
        collectDeclarations(tokens, i + 1, end, isType, (name, type, offset) => {
          result.globals.push({ name, type, offset });
          globalTypes.set(name, type);
        });
      }
      i = end + 1;
      continue;
    }

    // Function definition / prototype: Type name ( ... ) { | ;
    if (t.kind === 'ident' && tokens[i + 1]?.kind === 'ident' && tokens[i + 2]?.value === '(' && !KEYWORDS.has(tokens[i + 1].value)) {
      const closeParen = matching(tokens, i + 2);
      const after = tokens[closeParen + 1];
      if (after && (after.value === '{' || after.value === ';')) {
        const fn: FunctionDef = {
          name: tokens[i + 1].value,
          returnType: t.value,
          params: parseParams(tokens, i + 3, closeParen),
          nameOffset: tokens[i + 1].offset,
          calls: [],
          freeRefs: [],
          isPrototype: after.value === ';',
        };
        if (after.value === '{') {
          const end = matching(tokens, closeParen + 1);
          fn.body = { start: after.offset, end: (tokens[end]?.offset ?? text.length) + 1 };
          if (!collectOnly) analyzeBody(tokens, closeParen + 1, end, fn, isType, globalTypes);
          i = end + 1;
        } else {
          i = closeParen + 2;
        }
        if (!collectOnly) result.functions.push(fn);
        continue;
      }
    }

    // Top-level declaration: Type name [= ...] [, name ...] ;
    if (t.kind === 'ident' && isType(t.value) && tokens[i + 1]?.kind === 'ident') {
      let end = i;
      while (end < n && tokens[end].value !== ';' && tokens[end].value !== '{') end++;
      if (collectOnly) {
        collectDeclarations(tokens, i, end + 1, isType, (name, type, offset) => {
          result.globals.push({ name, type, offset });
          globalTypes.set(name, type);
        });
      }
      i = end + 1;
      continue;
    }

    i++;
  }
  }

  return result;
}

/** Index of the bracket matching the one at `open` (or last token index if unbalanced). */
function matching(tokens: Token[], open: number): number {
  const o = tokens[open].value;
  const c = o === '{' ? '}' : o === '(' ? ')' : ']';
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (v === o) depth++;
    else if (v === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function countArgs(tokens: Token[], openParen: number): number {
  const close = matching(tokens, openParen);
  if (close === openParen + 1) return 0;
  let depth = 0;
  let count = 1;
  for (let i = openParen + 1; i < close; i++) {
    const v = tokens[i].value;
    if (v === '(' || v === '[' || v === '{') depth++;
    else if (v === ')' || v === ']' || v === '}') depth--;
    else if (v === ',' && depth === 0) count++;
  }
  return count;
}

function parseParams(tokens: Token[], start: number, end: number): Param[] {
  const params: Param[] = [];
  let cur: Token[] = [];
  const flush = () => {
    const idents = cur.filter((t) => t.kind === 'ident' && t.value !== 'const');
    if (idents.length >= 2) {
      params.push({
        type: idents[0].value,
        name: idents[idents.length - 1].value,
        ref: cur.some((t) => t.value === '&'),
        array: cur.some((t) => t.value === '['),
      });
    }
    cur = [];
  };
  let depth = 0;
  for (let i = start; i < end; i++) {
    const v = tokens[i].value;
    if (v === '(' || v === '[') depth++;
    if (v === ')' || v === ']') depth--;
    if (v === ',' && depth === 0) flush();
    else cur.push(tokens[i]);
  }
  flush();
  return params;
}

/**
 * Walks declarations in [start, end): `Type a, b[3], c = expr;` and reports each declared name.
 * Used for global blocks and top-level declaration statements.
 */
function collectDeclarations(
  tokens: Token[],
  start: number,
  end: number,
  isType: (name: string) => boolean,
  report: (name: string, type: string, offset: number) => void,
) {
  let i = start;
  while (i < end) {
    const t = tokens[i];
    if (t.kind === 'ident' && isType(t.value) && tokens[i + 1]?.kind === 'ident') {
      const type = t.value;
      i++;
      // name list until ';' at depth 0
      let expectName = true;
      let depth = 0;
      while (i < end && !(tokens[i].value === ';' && depth === 0)) {
        const v = tokens[i].value;
        if (v === '(' || v === '[' || v === '{') depth++;
        else if (v === ')' || v === ']' || v === '}') depth--;
        else if (depth === 0 && v === ',') expectName = true;
        else if (depth === 0 && v === '=') expectName = false;
        else if (expectName && depth === 0 && tokens[i].kind === 'ident' && v !== '&') {
          report(v, type, tokens[i].offset);
          expectName = false;
        }
        i++;
      }
    }
    i++;
  }
}

function literalType(t: Token): string | null {
  if (t.kind === 'string') return 'Text';
  if (t.kind === 'number') return /[.eE]/.test(t.value) && !/^0[xX]/.test(t.value) ? 'Real' : 'Integer';
  return null;
}

/** Collects calls, locals and global accesses inside a function body. */
function analyzeBody(
  tokens: Token[],
  open: number,
  close: number,
  fn: FunctionDef,
  isType: (name: string) => boolean,
  globalTypes: Map<string, string>,
) {
  const localTypes = new Map<string, string>();
  for (const p of fn.params) localTypes.set(p.name, p.type);

  // Pass 1: local declarations (anywhere in the body; scope approximated to the whole function).
  const declNameIdx = new Set<number>();
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident' || !isType(t.value)) continue;
    const next = tokens[i + 1];
    if (next?.kind !== 'ident' || tokens[i + 2]?.value === '(') continue;
    const prev = tokens[i - 1]?.value;
    // A declaration starts a statement (or a for-init).
    if (!(prev === '{' || prev === '}' || prev === ';' || prev === '(' || prev === 'const')) continue;
    const type = t.value;
    let j = i + 1;
    let expectName = true;
    let depth = 0;
    while (j < close) {
      const v = tokens[j].value;
      if (depth === 0 && (v === ';' || v === ')')) break;
      if (v === '(' || v === '[' || v === '{') depth++;
      else if (v === ')' || v === ']' || v === '}') depth--;
      else if (depth === 0 && v === ',') expectName = true;
      else if (depth === 0 && v === '=') expectName = false;
      else if (expectName && depth === 0 && tokens[j].kind === 'ident') {
        localTypes.set(v, type);
        declNameIdx.add(j);
        expectName = false;
      }
      j++;
    }
  }

  const typeOf = (name: string) => localTypes.get(name) ?? globalTypes.get(name) ?? null;

  // Pass 2: calls and global references.
  for (let i = open + 1; i < close; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident' || KEYWORDS.has(t.value) || declNameIdx.has(i)) continue;
    const next = tokens[i + 1];
    if (next?.value === '(') {
      if (isType(t.value)) continue; // cast / constructor-like use of a type name
      const closeParen = matching(tokens, i + 1);
      const argTypes: (string | null)[] = [];
      if (closeParen > i + 2) {
        let depth = 0;
        let argStart = i + 2;
        for (let j = i + 2; j <= closeParen; j++) {
          const v = tokens[j].value;
          if (j === closeParen || (v === ',' && depth === 0)) {
            const argToks = tokens.slice(argStart, j);
            let ty: string | null = null;
            if (argToks.length === 1) {
              ty = argToks[0].kind === 'ident' ? typeOf(argToks[0].value) : literalType(argToks[0]);
            } else if (argToks.length === 2 && argToks[0].value === '-' && argToks[1].kind === 'number') {
              ty = literalType(argToks[1]);
            }
            argTypes.push(ty);
            argStart = j + 1;
          } else if (v === '(' || v === '[' || v === '{') depth++;
          else if (v === ')' || v === ']' || v === '}') depth--;
        }
      }
      fn.calls.push({ name: t.value, offset: t.offset, argCount: argTypes.length, argTypes });
      continue;
    }
    if (!localTypes.has(t.value) && !isType(t.value) && tokens[i - 1]?.value !== '.') {
      fn.freeRefs.push({ name: t.value, offset: t.offset });
    }
  }
}
