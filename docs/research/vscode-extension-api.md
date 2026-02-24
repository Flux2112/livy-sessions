# Research: VSCode Extension API

Sources:
- https://code.visualstudio.com/api
- https://code.visualstudio.com/api/extension-capabilities/overview
- https://code.visualstudio.com/api/extension-guides/tree-view
- https://code.visualstudio.com/api/extension-guides/webview
- https://code.visualstudio.com/api/references/contribution-points

---

## Extension Anatomy

A VSCode extension consists of:

- **`package.json`** – the extension manifest. Declares contribution points (commands, views, configuration, menus, keybindings, …).
- **Entry point** (`main` field) – a TypeScript/JavaScript module exporting `activate(context)` and optionally `deactivate()`.
- **`ExtensionContext`** – provided to `activate()`. Carries `subscriptions` (for cleanup), `workspaceState`, `globalState`, `extensionUri`, and storage paths.

All code runs in the **Extension Host** process – a Node.js process separate from the renderer. Extensions cannot access the DOM of the VS Code UI.

---

## Key APIs for This Extension

### Commands (`vscode.commands`)

```ts
// Register
context.subscriptions.push(
  vscode.commands.registerCommand('livy.createSession', async () => { ... })
);

// Execute programmatically
await vscode.commands.executeCommand('livy.createSession');
```

Commands appear in the **Command Palette** automatically when contributed via `package.json`.

---

### Output Channel

Used to display Livy output and logs to the user without a Webview.

```ts
const output = vscode.window.createOutputChannel('Livy Session');
output.appendLine('Session started');
output.show(); // Bring the output panel into focus
```

Dispose via `context.subscriptions.push(output)`.

---

### Status Bar Items

Good for showing current session state at a glance.

```ts
const item = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Left, 100
);
item.text = '$(zap) Livy: idle';
item.command = 'livy.showSessionInfo';
item.show();
context.subscriptions.push(item);
```

---

### Tree View API

Used to render session/statement lists in the Sidebar.

**1. Contribute a view container and view in `package.json`:**

```json
"contributes": {
  "viewsContainers": {
    "activitybar": [{
      "id": "livy-explorer",
      "title": "Livy Sessions",
      "icon": "media/livy.svg"
    }]
  },
  "views": {
    "livy-explorer": [{
      "id": "livySessions",
      "name": "Sessions"
    }]
  }
}
```

**2. Implement `TreeDataProvider<T>`:**

```ts
class LivySessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: SessionItem): vscode.TreeItem { return element; }

  async getChildren(element?: SessionItem): Promise<SessionItem[]> {
    if (!element) return this.fetchSessions();
    return this.fetchStatements(element.sessionId);
  }

  refresh() { this._onDidChangeTreeData.fire(); }
}
```

**3. Register:**

```ts
vscode.window.registerTreeDataProvider('livySessions', provider);
```

**Tree item actions** (buttons on tree items / title bar) are declared in `package.json` under `menus` → `view/title` and `view/item/context`.

---

### Webview Panel

Useful for rendering rich output (HTML tables, formatted errors, progress).

```ts
const panel = vscode.window.createWebviewPanel(
  'livyOutput',
  'Livy Output',
  vscode.ViewColumn.Two,
  { enableScripts: true }
);
panel.webview.html = buildHtml(result);

// Two-way messaging
panel.webview.postMessage({ type: 'result', data: output });
panel.webview.onDidReceiveMessage(msg => { ... });
```

Security requirements:
- Always set a strict `Content-Security-Policy` meta tag.
- Use `webview.asWebviewUri()` for all local resource references.
- Prefer `getState()`/`setState()` for webview state persistence.

---

### Editor Integration

#### Get selected text

```ts
const editor = vscode.window.activeTextEditor;
if (editor) {
  const selection = editor.selection;
  const code = editor.document.getText(
    selection.isEmpty ? undefined : selection
  );
  // If selection is empty, code === full document text
}
```

#### Register an editor context menu command

In `package.json`:

```json
"menus": {
  "editor/context": [{
    "command": "livy.runSelection",
    "when": "editorHasSelection",
    "group": "livy@1"
  }]
}
```

#### Keyboard shortcut

```json
"keybindings": [{
  "command": "livy.runSelection",
  "key": "shift+enter",
  "when": "editorTextFocus"
}]
```

#### CodeLens (optional enhancement)

Add inline "Run" buttons above code blocks:

```ts
class LivyCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    // Return CodeLens for each top-level block
  }
}
vscode.languages.registerCodeLensProvider({ language: 'python' }, provider);
```

---

### Configuration (`vscode.workspace.getConfiguration`)

Declare settings in `package.json`:

```json
"contributes": {
  "configuration": {
    "title": "Livy Session",
    "properties": {
      "livy.serverUrl": {
        "type": "string",
        "default": "http://localhost:8998",
        "description": "Livy server base URL"
      },
      "livy.authMethod": {
        "type": "string",
        "enum": ["none", "kerberos", "basic"],
        "default": "none"
      }
    }
  }
}
```

Read at runtime:

```ts
const config = vscode.workspace.getConfiguration('livy');
const url = config.get<string>('serverUrl', 'http://localhost:8998');
```

---

### Persistent State

```ts
// Workspace-scoped (per-project)
context.workspaceState.update('livy.sessionId', id);
const id = context.workspaceState.get<number>('livy.sessionId');

// Global (across all workspaces)
context.globalState.update('livy.lastServer', url);
```

---

### Progress API

For long-running operations (session creation, statement polling):

```ts
await vscode.window.withProgress(
  {
    location: vscode.ProgressLocation.Notification,
    title: 'Creating Livy session…',
    cancellable: true,
  },
  async (progress, token) => {
    token.onCancellationRequested(() => { /* cancel logic */ });
    progress.report({ increment: 0, message: 'Starting…' });
    // ... poll here ...
    progress.report({ increment: 100, message: 'Ready' });
  }
);
```

---

### Quick Pick

For selecting sessions, environments, or auth methods:

```ts
const sessions = await fetchSessions();
const picked = await vscode.window.showQuickPick(
  sessions.map(s => ({ label: `#${s.id} ${s.name}`, description: s.state, s })),
  { placeHolder: 'Select a Livy session' }
);
if (picked) { attachToSession(picked.s.id); }
```

---

### Input Box

For collecting free-form input (e.g. session name):

```ts
const name = await vscode.window.showInputBox({
  prompt: 'Session name',
  value: 'my-spark-session',
});
```

---

## Contribution Points Summary (Relevant Subset)

| Point | Purpose |
|---|---|
| `commands` | Declare commands with titles and icons |
| `configuration` | Declare user-editable settings |
| `keybindings` | Bind keyboard shortcuts to commands |
| `menus` | Add commands to context menus, editor title, view title, etc. |
| `views` | Declare tree views |
| `viewsContainers` | Declare Activity Bar panel or panel container |
| `viewsWelcome` | Content shown when a tree view is empty |

---

## Activation Events

Modern VSCode (≥ 1.74) activates extensions automatically when a contributed view or command is used. No explicit `activationEvents` needed for basic commands and views. For specific language-based activation:

```json
"activationEvents": ["onLanguage:python"]
```

---

## Extension Best Practices (UX)

- **Single responsibility per command** – keep commands focused.
- **Status bar for persistent state** – show session state without requiring the user to open a panel.
- **Output Channel for log output** – do not use `vscode.window.showInformationMessage` for multi-line results; use an Output Channel.
- **Progress notifications for slow operations** – always wrap network-polling loops in `vscode.window.withProgress`.
- **Never block the extension host** – all I/O must be async (`async/await`). Never use synchronous HTTP calls.
- **Dispose all registrations** – push every disposable into `context.subscriptions`.
- **`when` clauses for menus** – hide irrelevant commands (e.g. hide "Run Selection" when no session is active).

---

## HTTP from a VSCode Extension

The Extension Host runs in Node.js, so any Node-compatible HTTP library works:

- **Built-in `node:https`** – no dependencies.
- **`axios`** – popular, easy to use, supports cancellation via `AbortController`.
- **`node-fetch`** – fetch API polyfill.

For Kerberos auth there is no native Node.js Kerberos library bundled with VSCode; options:
- `kerberos` npm package (native addon – needs compilation).
- `node-krb5` (native).
- Allow the user to provide a Bearer token or Basic credentials as an alternative.

Since Kerberos requires native binaries, the extension should support multiple auth methods with Kerberos as optional.

---

## Packaging

- Bundle with **esbuild** or **webpack** to produce a single `out/extension.js` file.
- Use `"vscode:prepublish": "npm run build"` in `package.json`.
- Publish with `vsce package` / `vsce publish`.
- Target a minimum engine version (`"engines": { "vscode": "^1.85.0" }`).
