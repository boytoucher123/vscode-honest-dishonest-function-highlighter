'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Builtins, mergeOverrides } = require('../out/builtins');
const { CORE_TYPES, parse12dpl } = require('../out/parser');
const { ParseCache, collectClosure } = require('../out/project');
const { analyze } = require('../out/analyzer');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/builtins.json'), 'utf8'));
const main = path.join(__dirname, 'fixtures/main.4dm');

function run(overrides, unknownFunctions = 'unknown') {
  const builtins = new Builtins(data, mergeOverrides(overrides));
  const types = new Set([...builtins.typeNames(), ...CORE_TYPES]);
  const cache = new ParseCache((n) => types.has(n));
  const { files, unresolvedIncludes } = collectClosure(main, fs.readFileSync(main, 'utf8'), cache, []);
  assert.deepStrictEqual(unresolvedIncludes, []);
  const res = analyze(files, main, builtins, { unknownFunctions });
  const verdicts = Object.fromEntries(res.functions.map((f) => [f.def.name, f.verdict]));
  return { res, verdicts };
}

test('user functions are classified transitively', () => {
  const { verdicts, res } = run();
  assert.deepStrictEqual(verdicts, {
    is_even: 'honest',
    is_odd: 'honest',
    describe: 'honest',
    bump: 'dishonest',
    name_of: 'honest',
    stamp: 'dishonest',
    outer: 'dishonest',
    mystery: 'unknown',
    main: 'dishonest',
    hypot2: 'honest',
    log_value: 'dishonest',
  });
  const outer = res.functions.find((f) => f.def.name === 'outer');
  assert.match(outer.reason, /stamp/);
  assert.match(outer.reason, /Get_time/);
});

test('global variable access is dishonest (globals from includes too)', () => {
  const { res } = run();
  assert.match(res.functions.find((f) => f.def.name === 'bump').reason, /g_counter/);
  assert.match(res.functions.find((f) => f.def.name === 'main').reason, /g_name|log_value|Print|outer/);
});

test('macros are expanded for honesty: LOG -> Print is dishonest, SQUARE is honest', () => {
  const { res } = run();
  assert.match(res.functions.find((f) => f.def.name === 'log_value').reason, /LOG/);
});

test('highlights cover definitions and calls in the entry file', () => {
  const { res } = run();
  const text = fs.readFileSync(main, 'utf8');
  const at = (name, kind) => res.highlights.filter((h) => h.name === name && h.kind === kind);
  assert.strictEqual(at('Print', 'call')[0].verdict, 'dishonest');
  assert.strictEqual(at('To_text', 'call')[0].verdict, 'honest');
  assert.strictEqual(at('Get_name', 'call')[0].verdict, 'honest'); // Element overload resolved via local types
  assert.strictEqual(at('describe', 'definition')[0].verdict, 'honest');
  assert.strictEqual(at('Not_a_real_function', 'call')[0].verdict, 'unknown');
  for (const h of res.highlights) assert.strictEqual(text.substr(h.offset, h.length), h.name);
  // nothing highlighted in lib.h from main's result
  assert.ok(!res.highlights.some((h) => h.name === 'hypot2' && h.kind === 'definition'));
});

test('unknown policy can force dishonest', () => {
  const { verdicts } = run(undefined, 'dishonest');
  assert.strictEqual(verdicts.mystery, 'dishonest');
});

test('overrides: by name, by signature, by category, and on user functions', () => {
  assert.strictEqual(run({ functions: { Get_time: 'honest' } }).verdicts.stamp, 'honest');
  assert.strictEqual(run({ functions: { 'Get_time(Integer &)': 'honest' } }).verdicts.stamp, 'honest');
  assert.strictEqual(run({ categories: { time: 'honest' } }).verdicts.stamp, 'honest');
  assert.strictEqual(run({ categories: { element: 'dishonest' } }).verdicts.name_of, 'dishonest');
  const v = run({ functions: { stamp: 'honest' } }).verdicts;
  assert.strictEqual(v.stamp, 'honest');
  assert.strictEqual(v.outer, 'honest');
});

test('parser: comments, strings and #if 0 are ignored', () => {
  const p = parse12dpl(
    ['#if 0', 'void hidden() { Print("x"); }', '#endif', 'void f() { Text s = "Print(1)"; // Print(2)', '/* Print(3) */ }'].join('\n'),
    (n) => ['void', 'Text'].includes(n),
  );
  assert.deepStrictEqual(p.functions.map((f) => f.name), ['f']);
  assert.deepStrictEqual(p.functions[0].calls, []);
});

test('builtin data sanity', () => {
  const b = new Builtins(data);
  const v = (name, n, types = []) => b.resolve(name, n, types).verdict;
  assert.strictEqual(v('Print', 1, ['Text']), 'dishonest');
  assert.strictEqual(v('Get_time', 0), 'dishonest');
  assert.strictEqual(v('To_text', 1, ['Integer']), 'honest');
  assert.strictEqual(v('Text_length', 1), 'honest');
  assert.strictEqual(v('Get_random_number', 0), 'dishonest');
  assert.strictEqual(v('File_open', 3), 'dishonest');
  assert.strictEqual(v('Get_project_name', 1), 'dishonest');
  assert.strictEqual(v('Sqrt', 1), 'honest');
});

test('user overloads are resolved by argument types', () => {
  const builtins = new Builtins(data);
  const types = new Set([...builtins.typeNames(), ...CORE_TYPES]);
  const src = [
    'void show(Text t) { Print(t); }',
    'void show(Integer n) { Integer m = n + 1; }',
    'void a() { Integer x = 1; show(x); }',
    'void b() { Text s = "hi"; show(s); }',
  ].join('\n');
  const parsed = parse12dpl(src, (n) => types.has(n));
  const res = analyze([{ path: 'x.4dm', parsed, priority: 0 }], 'x.4dm', builtins, { unknownFunctions: 'unknown' });
  const v = Object.fromEntries(res.functions.filter((f) => f.def.name.length === 1).map((f) => [f.def.name, f.verdict]));
  assert.deepStrictEqual(v, { a: 'honest', b: 'dishonest' });
});
