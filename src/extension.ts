import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisResult, Highlight, SourceFile, UnknownPolicy, analyze } from './analyzer';
import { BuiltinData, Builtins, Honesty, Overrides, mergeOverrides, normalizeKey } from './builtins';
import { CORE_TYPES, ParsedFile } from './parser';
import { ParseCache, canonical, collectClosure } from './project';

const CFG = '12dplHonesty';
const STATE_KEY = '12dplHonesty.enabled';
const WORKSPACE_FALLBACK_PRIORITY = 1_000_000;

let builtins: Builtins;
let cache: ParseCache;
let enabled = false;
let decorations: Record<'honest' | 'dishonest' | 'unknown', vscode.TextEditorDecorationType> | undefined;
let statusItem: vscode.StatusBarItem;
let fileOverrides: Partial<Overrides> | undefined;
const lastResults = new Map<string, AnalysisResult>();
const workspaceFiles = new Map<string, ParsedFile>(); // canonical path -> parsed (fallback index)
const workspacePaths = new Map<string, string>(); // canonical path -> real fs path
let workspaceIndexed = false;
let debounce: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  const data = JSON.parse(fs.readFileSync(context.asAbsolutePath('data/builtins.json'), 'utf8')) as BuiltinData;
  builtins = new Builtins(data);
  const types = new Set([...builtins.typeNames(), ...CORE_TYPES]);
  cache = new ParseCache((n) => types.has(n) || /^Dynamic_/.test(n));

  enabled = context.globalState.get<boolean>(STATE_KEY) ?? config().get<boolean>('enabledByDefault', false);
  void vscode.commands.executeCommand('setContext', STATE_KEY, enabled);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = `${CFG}.toggle`;
  context.subscriptions.push(statusItem);

  loadOverrides();
  createDecorations();
  updateStatus();

  const setEnabled = async (value: boolean) => {
    enabled = value;
    await context.globalState.update(STATE_KEY, enabled);
    await vscode.commands.executeCommand('setContext', STATE_KEY, enabled);
    updateStatus();
    refreshAll();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(`${CFG}.toggle`, () => setEnabled(!enabled)),
    vscode.commands.registerCommand(`${CFG}.enable`, () => setEnabled(true)),
    vscode.commands.registerCommand(`${CFG}.disable`, () => setEnabled(false)),
    vscode.commands.registerCommand(`${CFG}.refresh`, () => {
      cache.clear();
      workspaceIndexed = false;
      loadOverrides();
      refreshAll();
    }),
    vscode.commands.registerCommand(`${CFG}.markHonest`, (name?: unknown) => markFunction('honest', name)),
    vscode.commands.registerCommand(`${CFG}.markDishonest`, (name?: unknown) => markFunction('dishonest', name)),
    vscode.commands.registerCommand(`${CFG}.clearOverride`, (name?: unknown) => markFunction(undefined, name)),
    vscode.commands.registerCommand(`${CFG}.setCategory`, setCategory),
    vscode.commands.registerCommand(`${CFG}.openOverrides`, openOverridesFile),
    vscode.commands.registerCommand(`${CFG}.showBuiltins`, showBuiltins),

    vscode.window.onDidChangeActiveTextEditor(() => schedule(0)),
    vscode.window.onDidChangeVisibleTextEditors(() => schedule(0)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (is12dpl(e.document)) schedule(300);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (is12dpl(doc) || isOverridesFile(doc.uri)) {
        if (isOverridesFile(doc.uri)) loadOverrides();
        updateWorkspaceFile(doc.uri);
        schedule(0);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CFG) && !e.affectsConfiguration('12dpl.compiler.includePaths')) return;
      if (e.affectsConfiguration(`${CFG}.colors`) || e.affectsConfiguration(`${CFG}.style`)) createDecorations();
      if (e.affectsConfiguration(`${CFG}.searchWorkspace`)) workspaceIndexed = false;
      loadOverrides();
      refreshAll();
    }),
    vscode.languages.registerHoverProvider([{ language: '12dpl' }, { pattern: '**/*.4dm' }], { provideHover }),
    vscode.tasks.registerTaskProvider('12dpl-honesty', taskProvider(setEnabled)),
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{4dm,h,4dh}');
  const onFs = (uri: vscode.Uri) => {
    updateWorkspaceFile(uri);
    schedule(200);
  };
  watcher.onDidChange(onFs);
  watcher.onDidCreate(onFs);
  watcher.onDidDelete((uri) => {
    cache.invalidate(uri.fsPath);
    workspaceFiles.delete(canonical(uri.fsPath));
    workspacePaths.delete(canonical(uri.fsPath));
    schedule(200);
  });
  const ovWatcher = vscode.workspace.createFileSystemWatcher('**/12dpl-honesty.json');
  const onOv = () => {
    loadOverrides();
    schedule(0);
  };
  ovWatcher.onDidChange(onOv);
  ovWatcher.onDidCreate(onOv);
  ovWatcher.onDidDelete(onOv);
  context.subscriptions.push(watcher, ovWatcher, { dispose: () => disposeDecorations() });

  refreshAll();
}

export function deactivate() {
  disposeDecorations();
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function config() {
  return vscode.workspace.getConfiguration(CFG);
}

function is12dpl(doc: vscode.TextDocument): boolean {
  return doc.languageId === '12dpl' || /\.4dm$/i.test(doc.fileName);
}

function overridesFilePaths(): string[] {
  const rel = config().get<string>('overridesFile', '.vscode/12dpl-honesty.json');
  if (path.isAbsolute(rel)) return [rel];
  return (vscode.workspace.workspaceFolders ?? []).map((f) => path.join(f.uri.fsPath, rel));
}

function isOverridesFile(uri: vscode.Uri): boolean {
  return overridesFilePaths().some((p) => canonical(p) === canonical(uri.fsPath));
}

function loadOverrides() {
  const parts: Partial<Overrides>[] = [];
  for (const p of overridesFilePaths()) {
    try {
      const raw = JSON.parse(stripJsonComments(fs.readFileSync(p, 'utf8')));
      parts.push({ functions: raw.functions ?? {}, categories: raw.categories ?? {} });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        void vscode.window.showWarningMessage(`12dPL honesty: could not read ${p}: ${(e as Error).message}`);
      }
    }
  }
  fileOverrides = mergeOverrides(...parts);
  const cfg = config();
  // Settings win over the file: settings are personal, the file is shared with the team.
  builtins.setOverrides(
    mergeOverrides(fileOverrides, {
      functions: cfg.get<Record<string, Honesty>>('functionOverrides', {}),
      categories: cfg.get<Record<string, Honesty>>('categoryOverrides', {}),
    }),
  );
}

function stripJsonComments(s: string): string {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
}

function includeDirs(doc: vscode.TextDocument): string[] {
  const own = config().get<string[]>('includePaths', []);
  const langServer = vscode.workspace.getConfiguration('12dpl.compiler', doc.uri).get<string[]>('includePaths', []);
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  return [...own, ...langServer].map((p) =>
    p
      .replace(/\$\{workspaceFolder\}/g, folder ?? '')
      .replace(/\$\{userHome\}/g, process.env.HOME ?? process.env.USERPROFILE ?? '')
      .replace(/\$\{fileDirname\}/g, path.dirname(doc.fileName)),
  );
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

function disposeDecorations() {
  if (!decorations) return;
  for (const d of Object.values(decorations)) d.dispose();
  decorations = undefined;
}

function createDecorations() {
  disposeDecorations();
  const colors = config().get<{ honest?: string; dishonest?: string; unknown?: string }>('colors', {});
  const style = config().get<{ background?: boolean; bold?: boolean; underline?: boolean }>('style', {});
  const make = (color: string | undefined) => {
    if (!color) return vscode.window.createTextEditorDecorationType({});
    // `color` alone already paints over TextMate and semantic tokens (decorations are layered last);
    // the `!important` injected through textDecoration makes sure no other extension's decoration
    // or token rule can win while the mode is on.
    const underline = style.underline ? 'underline' : 'none';
    return vscode.window.createTextEditorDecorationType({
      color,
      fontWeight: style.bold ? 'bold' : undefined,
      textDecoration: `${underline}; color: ${color} !important`,
      backgroundColor: style.background === false ? undefined : withAlpha(color, 0.16),
      borderRadius: '2px',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      overviewRulerColor: withAlpha(color, 0.6),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  };
  decorations = {
    honest: make(colors.honest ?? '#3fb950'),
    dishonest: make(colors.dishonest ?? '#f85149'),
    unknown: make(colors.unknown || undefined),
  };
}

function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function updateStatus() {
  statusItem.text = enabled ? '$(eye) Honesty' : '$(eye-closed) Honesty';
  statusItem.tooltip = `12dPL honest/dishonest highlighting is ${enabled ? 'ON' : 'OFF'} — click to toggle`;
  const ed = vscode.window.activeTextEditor;
  if (ed && is12dpl(ed.document)) statusItem.show();
  else if (config().get<boolean>('alwaysShowStatusBar', false)) statusItem.show();
  else statusItem.hide();
}

function schedule(ms: number) {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = undefined;
    refreshAll();
  }, ms);
}

function refreshAll() {
  updateStatus();
  for (const editor of vscode.window.visibleTextEditors) refreshEditor(editor);
}

function refreshEditor(editor: vscode.TextEditor) {
  if (!decorations) createDecorations();
  const doc = editor.document;
  if (!is12dpl(doc) || !enabled) {
    for (const d of Object.values(decorations!)) editor.setDecorations(d, []);
    if (!enabled) lastResults.delete(doc.uri.toString());
    return;
  }
  const result = analyzeDocument(doc);
  lastResults.set(doc.uri.toString(), result);
  const cfg = config();
  const showDefs = cfg.get<boolean>('highlightDefinitions', true);
  const showCalls = cfg.get<boolean>('highlightCalls', true);
  const buckets: Record<'honest' | 'dishonest' | 'unknown', vscode.Range[]> = { honest: [], dishonest: [], unknown: [] };
  for (const h of result.highlights) {
    if (h.kind === 'definition' && !showDefs) continue;
    if (h.kind === 'call' && !showCalls) continue;
    buckets[h.verdict].push(new vscode.Range(doc.positionAt(h.offset), doc.positionAt(h.offset + h.length)));
  }
  for (const k of ['honest', 'dishonest', 'unknown'] as const) editor.setDecorations(decorations![k], buckets[k]);
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const reader = {
  openText(fsPath: string): string | undefined {
    const key = canonical(fsPath);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && canonical(d.uri.fsPath) === key);
    return doc?.getText();
  },
};

function analyzeDocument(doc: vscode.TextDocument): AnalysisResult {
  const entryPath = doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.uri.toString();
  const closure = collectClosure(entryPath, doc.getText(), cache, includeDirs(doc), reader);
  const files: SourceFile[] = [...closure.files];
  if (config().get<boolean>('searchWorkspace', true)) {
    ensureWorkspaceIndex();
    const inClosure = new Set(files.map((f) => canonical(f.path)));
    for (const [key, parsed] of workspaceFiles) {
      if (!inClosure.has(key)) files.push({ path: workspacePaths.get(key) ?? key, parsed, priority: WORKSPACE_FALLBACK_PRIORITY });
    }
  }
  return analyze(files, entryPath, builtins, {
    unknownFunctions: config().get<UnknownPolicy>('unknownFunctions', 'unknown'),
  });
}

function ensureWorkspaceIndex() {
  if (workspaceIndexed) return;
  workspaceIndexed = true;
  workspaceFiles.clear();
  workspacePaths.clear();
  const max = config().get<number>('maxWorkspaceFiles', 3000);
  void vscode.workspace.findFiles('**/*.{4dm,h,4dh}', '**/node_modules/**', max).then((uris) => {
    for (const uri of uris) updateWorkspaceFile(uri);
    schedule(0);
  });
}

function updateWorkspaceFile(uri: vscode.Uri) {
  if (uri.scheme !== 'file' || !/\.(4dm|h|4dh)$/i.test(uri.fsPath)) return;
  cache.invalidate(uri.fsPath);
  if (!workspaceIndexed) return;
  const parsed = cache.read(uri.fsPath);
  const key = canonical(uri.fsPath);
  if (parsed) {
    workspaceFiles.set(key, parsed);
    workspacePaths.set(key, uri.fsPath);
  }
}

// ---------------------------------------------------------------------------
// Hovers
// ---------------------------------------------------------------------------

function highlightAt(doc: vscode.TextDocument, pos: vscode.Position): Highlight | undefined {
  const res = lastResults.get(doc.uri.toString());
  if (!res) return undefined;
  const off = doc.offsetAt(pos);
  return res.highlights.find((h) => off >= h.offset && off <= h.offset + h.length);
}

function provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
  if (!enabled) return undefined;
  const h = highlightAt(doc, pos);
  if (!h) return undefined;
  const md = new vscode.MarkdownString(h.reason);
  const arg = encodeURIComponent(JSON.stringify([h.name]));
  md.appendMarkdown(
    `\n\n[Mark honest](command:${CFG}.markHonest?${arg}) · [Mark dishonest](command:${CFG}.markDishonest?${arg}) · [Reset](command:${CFG}.clearOverride?${arg})`,
  );
  md.isTrusted = { enabledCommands: [`${CFG}.markHonest`, `${CFG}.markDishonest`, `${CFG}.clearOverride`] };
  return new vscode.Hover(md, new vscode.Range(doc.positionAt(h.offset), doc.positionAt(h.offset + h.length)));
}

// ---------------------------------------------------------------------------
// Editing classifications
// ---------------------------------------------------------------------------

interface OverridesFileShape {
  $comment?: string;
  functions: Record<string, Honesty>;
  categories: Record<string, Honesty>;
}

function readOverridesFile(p: string): OverridesFileShape {
  try {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(p, 'utf8')));
    return { ...raw, functions: raw.functions ?? {}, categories: raw.categories ?? {} };
  } catch {
    return {
      $comment:
        'Overrides for the 12dPL honest/dishonest highlighter. "functions" keys are a name (all overloads, and user functions) or a signature like "Get_name(Element, Text &)". "categories" re-classifies every builtin in a category. Values: "honest" or "dishonest".',
      functions: {},
      categories: {},
    };
  }
}

async function writeOverridesFile(p: string, data: OverridesFileShape) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const sortObj = (o: Record<string, Honesty>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  fs.writeFileSync(p, JSON.stringify({ ...data, functions: sortObj(data.functions), categories: sortObj(data.categories) }, null, 2) + '\n');
  loadOverrides();
  refreshAll();
}

async function targetOverridesFile(): Promise<string | undefined> {
  const paths = overridesFilePaths();
  if (!paths.length) {
    void vscode.window.showWarningMessage('Open a folder/workspace to store 12dPL honesty overrides (or set an absolute 12dplHonesty.overridesFile).');
    return undefined;
  }
  if (paths.length === 1) return paths[0];
  const pick = await vscode.window.showQuickPick(paths, { placeHolder: 'Which overrides file?' });
  return pick;
}

/** Re-classifies `nameArg` (from a hover link) or the identifier under the cursor. */
async function markFunction(value: Honesty | undefined, nameArg?: unknown) {
  let name: string | undefined = typeof nameArg === 'string' ? nameArg : undefined;
  const editor = vscode.window.activeTextEditor;
  if (!name && editor) {
    const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][A-Za-z0-9_]*/);
    name = range ? editor.document.getText(range) : undefined;
  }
  if (!name) {
    name = await vscode.window.showInputBox({ prompt: 'Function name (or signature) to re-classify' });
    if (!name) return;
  }
  let key = name;
  const overloads = builtins.overloads(name);
  if (overloads.length > 1 && value !== undefined) {
    const items: (vscode.QuickPickItem & { key: string })[] = [
      { label: `All overloads of ${name}`, key: name },
      ...overloads.map((o) => ({
        label: o.signature,
        description: builtins.classify(o, name!).honesty,
        detail: o.reason,
        key: o.signature,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Mark which ${name} as ${value}?` });
    if (!pick) return;
    key = pick.key;
  }
  const file = await targetOverridesFile();
  if (!file) return;
  const data = readOverridesFile(file);
  if (value === undefined) {
    const norm = normalizeKey(name);
    for (const k of Object.keys(data.functions)) {
      if (normalizeKey(k) === norm || normalizeKey(k).startsWith(norm + '(')) delete data.functions[k];
    }
  } else {
    data.functions[key] = value;
  }
  await writeOverridesFile(file, data);
  const settingsOverride = config().get<Record<string, Honesty>>('functionOverrides', {});
  if (Object.keys(settingsOverride).some((k) => normalizeKey(k).startsWith(normalizeKey(name!)))) {
    void vscode.window.showInformationMessage(`Note: "${name}" also has an override in your settings (12dplHonesty.functionOverrides), which takes precedence.`);
  }
  vscode.window.setStatusBarMessage(value ? `${key} marked ${value}` : `Overrides for ${name} cleared`, 3000);
}

async function setCategory() {
  const cats = builtins.categories();
  const current = builtins.getOverrides().categories;
  const cat = await vscode.window.showQuickPick(
    cats.map((c) => ({ label: c, description: current[c] ? `overridden: ${current[c]}` : '' })),
    { placeHolder: 'Built-in category to re-classify' },
  );
  if (!cat) return;
  const choice = await vscode.window.showQuickPick(['honest', 'dishonest', 'default (remove override)'], {
    placeHolder: `Treat every "${cat.label}" builtin as…`,
  });
  if (!choice) return;
  const file = await targetOverridesFile();
  if (!file) return;
  const data = readOverridesFile(file);
  if (choice.startsWith('default')) delete data.categories[cat.label];
  else data.categories[cat.label] = choice as Honesty;
  await writeOverridesFile(file, data);
}

async function openOverridesFile() {
  const file = await targetOverridesFile();
  if (!file) return;
  if (!fs.existsSync(file)) await writeOverridesFile(file, readOverridesFile(file));
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function showBuiltins() {
  const rows: string[] = ['| Function | Verdict | Category | Reason |', '|---|---|---|---|'];
  for (const [name, list] of builtins.entries()) {
    for (const o of list) {
      const c = builtins.classify(o, name);
      rows.push(`| \`${o.signature}\` | ${c.honesty === 'honest' ? '✅ honest' : '❌ dishonest'} | ${o.category} | ${c.reason.replace(/\|/g, '\\|')} |`);
    }
  }
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# 12dPL built-in classifications (with your overrides applied)\n\nChange any of these with **12dPL Honesty: Mark Function as Honest/Dishonest** or by editing the overrides file.\n\n${rows.join('\n')}\n`,
  });
  await vscode.window.showTextDocument(doc);
}

// ---------------------------------------------------------------------------
// Tasks: lets users toggle from the task runner (and bind keys to tasks).
// ---------------------------------------------------------------------------

function taskProvider(setEnabled: (v: boolean) => Promise<void>): vscode.TaskProvider {
  const make = (action: 'toggle' | 'enable' | 'disable', def?: vscode.TaskDefinition) => {
    const definition = def ?? { type: '12dpl-honesty', action };
    const label = { toggle: 'Toggle honesty highlighting', enable: 'Enable honesty highlighting', disable: 'Disable honesty highlighting' }[action];
    const task = new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      label,
      '12dpl-honesty',
      new vscode.CustomExecution(async () => {
        const emitter = new vscode.EventEmitter<number>();
        const write = new vscode.EventEmitter<string>();
        return {
          onDidWrite: write.event,
          onDidClose: emitter.event,
          open: async () => {
            await setEnabled(action === 'toggle' ? !enabled : action === 'enable');
            write.fire(`12dPL honesty highlighting ${enabled ? 'enabled' : 'disabled'}.\r\n`);
            emitter.fire(0);
          },
          close: () => undefined,
        };
      }),
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Never, close: true, echo: false, showReuseMessage: false };
    return task;
  };
  return {
    provideTasks: () => [make('toggle'), make('enable'), make('disable')],
    resolveTask: (task) => {
      const action = (task.definition as { action?: string }).action;
      if (action === 'toggle' || action === 'enable' || action === 'disable') return make(action, task.definition);
      return undefined;
    },
  };
}
