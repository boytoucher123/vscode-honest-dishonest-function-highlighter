/**
 * A small tokenizer for 12dPL (C-like). It drops comments and tracks preprocessor
 * directives separately, which is all the honesty analysis needs.
 */

export type TokenKind = 'ident' | 'number' | 'string' | 'char' | 'punct';

export interface Token {
  kind: TokenKind;
  value: string;
  /** Offset of the first character in the source text. */
  offset: number;
}

export interface Directive {
  /** Directive name without '#', e.g. 'include', 'define'. */
  name: string;
  /** Text after the directive name (line continuations joined). */
  body: string;
  offset: number;
  /** Offset where `body` starts in the source. */
  bodyOffset: number;
}

export interface TokenizeResult {
  tokens: Token[];
  directives: Directive[];
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const TWO_CHAR_PUNCT = new Set(['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '->', '<<', '>>', '::']);

export function tokenize(text: string): TokenizeResult {
  const tokens: Token[] = [];
  const directives: Directive[] = [];
  const n = text.length;
  let i = 0;
  let atLineStart = true;
  // Stack of #if states: true = currently skipping (inside `#if 0`).
  const ifStack: boolean[] = [];
  const skipping = () => ifStack.some((s) => s);

  while (i < n) {
    const c = text[i];

    if (c === '\n') {
      atLineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    // Comments
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // Preprocessor directive
    if (c === '#' && atLineStart) {
      const start = i;
      i++;
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      const nameStart = i;
      while (i < n && IDENT_PART.test(text[i])) i++;
      const name = text.slice(nameStart, i);
      const bodyOffset = i;
      let body = '';
      // Read to end of line, honouring backslash continuations and dropping comments.
      while (i < n && text[i] !== '\n') {
        if (text[i] === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
          i += text[i + 1] === '\r' ? 3 : 2;
          body += ' ';
          continue;
        }
        if (text[i] === '/' && text[i + 1] === '/') {
          while (i < n && text[i] !== '\n') i++;
          break;
        }
        if (text[i] === '/' && text[i + 1] === '*') {
          const end = text.indexOf('*/', i + 2);
          i = end < 0 ? n : end + 2;
          body += ' ';
          continue;
        }
        body += text[i];
        i++;
      }
      if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
        ifStack.push(name === 'if' && /^\s*0\s*$/.test(body));
      } else if (name === 'else' || name === 'elif') {
        // `#if 0 ... #else` — the else branch is live.
        if (ifStack.length) ifStack[ifStack.length - 1] = false;
      } else if (name === 'endif') {
        ifStack.pop();
      } else if (!skipping()) {
        directives.push({ name, body, offset: start, bodyOffset });
      }
      continue;
    }

    atLineStart = false;

    if (skipping()) {
      // Still need to respect strings so a quote doesn't swallow #endif; good enough to skip chars.
      i++;
      continue;
    }

    // Strings
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      tokens.push({ kind: c === '"' ? 'string' : 'char', value: text.slice(start, Math.min(i, n)), offset: start });
      continue;
    }
    // Identifiers
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_PART.test(text[i])) i++;
      tokens.push({ kind: 'ident', value: text.slice(start, i), offset: start });
      continue;
    }
    // Numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const start = i;
      if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(text[i])) i++;
      } else {
        while (i < n && /[0-9.]/.test(text[i])) i++;
        if (text[i] === 'e' || text[i] === 'E') {
          i++;
          if (text[i] === '+' || text[i] === '-') i++;
          while (i < n && /[0-9]/.test(text[i])) i++;
        }
      }
      while (i < n && /[A-Za-z]/.test(text[i])) i++; // suffixes
      tokens.push({ kind: 'number', value: text.slice(start, i), offset: start });
      continue;
    }
    // Punctuation
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_PUNCT.has(two)) {
      tokens.push({ kind: 'punct', value: two, offset: i });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punct', value: c, offset: i });
    i++;
  }

  return { tokens, directives };
}
