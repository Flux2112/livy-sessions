// Minimal vscode mock for Jest unit tests
const vscode = {
  window: {
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
      dispose: jest.fn(),
    })),
    createStatusBarItem: jest.fn(() => ({
      text: '',
      tooltip: '',
      command: '',
      show: jest.fn(),
      dispose: jest.fn(),
    })),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showQuickPick: jest.fn(),
    showInputBox: jest.fn(),
    withProgress: jest.fn(async (_opts: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => {
      const progress = { report: jest.fn() }
      const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() }
      return task(progress, token)
    }),
    activeTextEditor: undefined,
    createTreeView: jest.fn(() => ({ dispose: jest.fn() })),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key: string, defaultVal: unknown) => defaultVal),
    })),
    onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
  },
  commands: {
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    executeCommand: jest.fn(),
  },
  EventEmitter: jest.fn().mockImplementation(() => ({
    event: jest.fn(),
    fire: jest.fn(),
    dispose: jest.fn(),
  })),
  CancellationTokenSource: jest.fn().mockImplementation(() => ({
    token: {
      isCancellationRequested: false,
      onCancellationRequested: jest.fn(),
    },
    cancel: jest.fn(),
    dispose: jest.fn(),
  })),
  TreeItem: class {
    label: string
    collapsibleState: number
    contextValue?: string
    description?: string
    tooltip?: unknown
    iconPath?: unknown

    constructor(label: string, collapsibleState: number) {
      this.label = label
      this.collapsibleState = collapsibleState
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ProgressLocation: {
    Notification: 15,
    Window: 10,
    SourceControl: 1,
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ThemeIcon: jest.fn().mockImplementation((id: string) => ({ id })),
  ThemeColor: jest.fn().mockImplementation((id: string) => ({ id })),
  MarkdownString: jest.fn().mockImplementation((value: string) => ({ value })),
  Uri: {
    file: jest.fn((path: string) => ({ fsPath: path })),
    parse: jest.fn((path: string) => ({ toString: () => path })),
  },
}

module.exports = vscode
