# 12dPL Honest/Dishonest Function Highlighter

A VS Code extension for **12dPL** (the 12d Model macro language, `.4dm`) that colours every
function name by whether the function is **honest** or **dishonest**:

- 🟢 **Honest** — everything the function touches comes in through its parameters.
  `To_text(Integer)`, `Text_length`, `Sqrt`, and your own pure helpers.
- 🔴 **Dishonest** — the function reaches outside its parameters: the console (`Print`), the clock
  (`Get_time`), files, panels/widgets, the 12d project (models, tins, views, settings), random
  numbers, global variables…

Dishonesty spreads: **a function that calls a dishonest function is dishonest**, however deep the
chain goes (recursion is handled). A function that reads or writes a **global variable** is
dishonest too.

Function names are highlighted where they are defined and where they are called. Hover over one to
see why it got its colour. For propagated dishonesty you get the whole chain, e.g.
`calls stamp → calls Get_time(Integer &) — Depends on the system clock.`

## Turning it on and off

| How | |
|---|---|
| Keybind | **Ctrl+Alt+H** (Command Palette: *12dPL Honesty: Toggle Honest/Dishonest Highlighting*) |
| Status bar | Click the **👁 Honesty** item (shown for 12dPL files) |
| Editor title | The eye icon at the top right of a `.4dm` editor |
| Task | *Terminal → Run Task… → 12dpl-honesty → Toggle honesty highlighting* |

The on/off state is remembered between sessions. To run the toggle from `tasks.json` (for example to
put your own keybinding on the task):

```jsonc
// .vscode/tasks.json
{
  "version": "2.0.0",
  "tasks": [{ "type": "12dpl-honesty", "action": "toggle", "label": "Toggle honesty" }]
}
```

`action` can be `toggle`, `enable` or `disable`.

### Beating other extensions' colours

While the mode is on, the highlighting is drawn as editor decorations. These are layered on top of
TextMate and semantic-token colours from any other extension, including the
[12dPL Language](https://github.com/ben-nightworks/12dpl-lang-server) extension. The colour is
also applied with `!important`, so another extension's decorations can't paint over it. Turn the
mode off and everything goes back to normal.

## Changing the classifications

The extension ships with a default verdict for **7,211 built-in overloads** (2,703 names). Every
overload has a category and a reason. You can change any of them:

- **Right-click a function name → Mark Function as Honest / Dishonest / Reset**, or use the links
  in the hover. For a built-in with several overloads you can pick *all overloads* or just one
  signature.
- **12dPL Honesty: Re-classify a Built-in Category…** flips a whole category at once.
- **12dPL Honesty: Open Classification Overrides File** to edit the file by hand.
- **12dPL Honesty: Show All Built-in Classifications** lists every built-in with its current verdict
  (your overrides included).

Overrides are saved to `.vscode/12dpl-honesty.json` in your workspace. Commit the file to share
your classifications with your team:

```jsonc
{
  "functions": {
    "Print": "honest",                      // every overload of Print (and any user function named Print)
    "Get_name(Element, Text &)": "honest",  // just one overload
    "My_logging_helper": "honest"           // force one of your own functions
  },
  "categories": {
    "element": "dishonest"                  // treat every Element-handle call as dishonest
  }
}
```

For personal tweaks that aren't shared, use the `12dplHonesty.functionOverrides` and
`12dplHonesty.categoryOverrides` settings. These take precedence over the file.

When several rules apply, the most specific one wins: signature, then name, then category, then
the default.

### Categories

| Category | Default | What's in it |
|---|---|---|
| `math` | honest | `Sqrt`, `Sin`, `Absolute`, `Pi`, angle conversions, `Xeqy`… |
| `text` | honest | `To_text`, `Text_length`, `Get_subtext`, `Find_text`, `Text_upper`… |
| `geometry` | honest | `Point`/`Line`/`Arc`/`Segment`/`Vector`/`Matrix` maths |
| `container` | honest | `Dynamic_*`, Maps/Sets |
| `xml` | honest | in-memory `XML_Document`/`XML_Node` manipulation |
| `element` | honest | calls that only work on `Element`/`Attributes`/`Uid` handles you pass in (see below) |
| `console` | dishonest | `Print`, `Exit`, `Set_message_text`, `*_dump`, `*_debug`… |
| `ui` | dishonest | panels, widgets, `*_prompt`, drawing, highlighting |
| `project` | dishonest | models, tins, views, project attributes/settings, colours, styles, drainage settings… |
| `file` | dishonest | `File_*`, `Read_*`, `Write_*`, folders |
| `database` | dishonest | SQL connections and queries |
| `system` | dishonest | `Getenv`, `System`, clipboard, processes, command-line arguments, licences, versions |
| `time` | dishonest | `Get_time`, `Date`, `Sleep`, timers |
| `random` | dishonest | random numbers, `GUID_Gen` |

**The `element` judgement call.** In 12d an `Element` is a handle that can point into the project
database. By default, a call that only uses the element you pass in (`Get_name(Element, Text &)`,
`Get_points`, `Set_colour`, …) counts as honest, because it touches nothing but its parameters.
Once the element lives in a model, though, reading it depends on project state. If you take the
stricter view, set `"categories": { "element": "dishonest" }`. Calls that reach the project
*through* an element (for example `Get_model(Element, Model &)`) are always dishonest, because they
involve a `Model`.

## How it finds your functions

For the active file, the extension reads:

1. the file itself, including unsaved edits;
2. everything it `#include`s, recursively. Includes are resolved relative to the including file,
   then against `12dplHonesty.includePaths`, then against the 12dPL Language extension's
   `12dpl.compiler.includePaths`;
3. as a fallback, if a called function still can't be found, any `.4dm`/`.h` file in the workspace
   that defines it (`12dplHonesty.searchWorkspace`).

Calls to `#define` function-like macros are judged by what the macro expands to. For example,
`#define LOG(m) Print(m)` makes `LOG(...)` dishonest. Overloads are matched by argument count and,
where the types are known (declared variables and literals), by argument types.

A call that can't be resolved at all is **unknown**. By default it is left uncoloured, and so is any
function that depends on it but is otherwise honest. Set `12dplHonesty.unknownFunctions` to
`dishonest` or `honest` to treat unknowns one way or the other. To colour them, set
`12dplHonesty.colors.unknown`.

## Settings

| Setting | Default | |
|---|---|---|
| `12dplHonesty.colors` | `{ honest: #3fb950, dishonest: #f85149, unknown: "" }` | Highlight colours |
| `12dplHonesty.style` | `{ background: true, bold: false, underline: false }` | How names are drawn |
| `12dplHonesty.highlightDefinitions` / `highlightCalls` | `true` | What gets coloured |
| `12dplHonesty.unknownFunctions` | `unknown` | `unknown` / `dishonest` / `honest` |
| `12dplHonesty.includePaths` | `[]` | Extra `#include` folders (`${workspaceFolder}` supported) |
| `12dplHonesty.searchWorkspace` | `true` | Workspace fallback for unresolved calls |
| `12dplHonesty.overridesFile` | `.vscode/12dpl-honesty.json` | Shared overrides file |
| `12dplHonesty.functionOverrides` / `categoryOverrides` | `{}` | Personal overrides |
| `12dplHonesty.enabledByDefault` | `false` | Initial state on first run |

## Install

Download the `.vsix` and run **Extensions: Install from VSIX…**, or build it yourself:

```bash
npm install
```

```bash
npx vsce package
```

## Development

```bash
npm test
```

`npm test` compiles the extension and runs the analyzer tests. The built-in classifications in
`data/builtins.json` are generated, so don't edit them by hand. To change the default rules, edit
`scripts/classify-builtins.js` and run:

```bash
npm run classify
```

The generator merges two sources:

- `data/source/12dpl_functions_documentation.json`, the 12dPL library documentation. It's the
  primary source, and its descriptions feed the rules.
- `data/source/functions.compiler.json`, the complete compiler prototype list from
  [ben-nightworks/12dpl-lang-server](https://github.com/ben-nightworks/12dpl-lang-server)
  (MIT, © Ben Olsen and contributors). It fills in calls the documentation doesn't cover, such as
  `Sqrt`, `Sin` and the map/set containers. Undocumented overloads are classified from their name
  and parameter types alone, and their reason says so.

Thanks to ben-nightworks/12dpl-lang-server for the include-resolution approach and the prototype data.
