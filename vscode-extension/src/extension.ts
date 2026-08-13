import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const VIEW_ID = 'torchcode.dashboard';
const WELCOME_FILE = '00_welcome.ipynb';
const PROGRESS_RELATIVE_PATH = path.join('templates', 'data', 'progress.json');

type Difficulty = 'Easy' | 'Medium' | 'Hard' | 'Unknown';
type TaskStatus = 'solved' | 'attempted' | 'todo';

interface ProgressEntry {
  status?: TaskStatus;
  attempts?: number;
  best_time?: number;
  solved_at?: string;
}

interface Task {
  id: string;
  fileName: string;
  title: string;
  difficulty: Difficulty;
  group: string;
  description: string;
  order: number;
  uri: vscode.Uri;
}

interface WelcomeTaskInfo {
  group: string;
  rank: number;
}

interface TaskState extends Task {
  progress: ProgressEntry;
  status: TaskStatus;
}

interface JudgeTest {
  name: string;
  passed: boolean;
  time_ms: number;
  error_msg?: string | null;
  error_traceback?: string | null;
  stdout?: string;
  stderr?: string;
}

interface JudgeResult {
  success: boolean;
  passed: number;
  total: number;
  total_time_ms?: number;
  tests: JudgeTest[];
  error?: string;
  traceback?: string;
  stdout?: string;
  stderr?: string;
}

interface RunnerReply {
  ok: boolean;
  hint?: string;
  result?: JudgeResult;
  error?: string;
}

interface DashboardState {
  workspaceReady: boolean;
  workspaceName: string;
  tasks: TaskState[];
  selectedTaskId?: string;
  activeTaskId?: string;
  description?: string;
  result?: JudgeResult;
  resultTaskId?: string;
  hint?: string;
  hintTaskId?: string;
  error?: string;
}

interface IpynbCell {
  cell_type?: string;
  source?: string | string[];
}

interface IpynbFile {
  cells?: IpynbCell[];
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TorchCodeDashboardProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('torchcode.openDashboard', () => provider.show()),
    vscode.commands.registerCommand('torchcode.openWelcome', () => provider.openWelcome()),
    vscode.commands.registerCommand('torchcode.runTests', () => provider.runTestsForCurrentTask()),
    vscode.commands.registerCommand('torchcode.showHint', () => provider.showHintForCurrentTask()),
    vscode.window.onDidChangeActiveNotebookEditor(() => provider.refresh()),
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (provider.isTorchCodeNotebook(event.notebook.uri)) {
        provider.refresh(true);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('torchcode')) {
        provider.invalidateWorkspace();
        provider.refresh();
      }
    })
  );

  provider.installWatchers(context);
}

export function deactivate(): void {
  // All disposables are registered with the extension context.
}

class TorchCodeDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private root?: vscode.Uri;
  private tasks: Task[] = [];
  private selectedTaskId?: string;
  private lastResult?: { taskId: string; result: JudgeResult };
  private lastHint?: { taskId: string; hint: string };
  private lastError?: string;
  private running = false;
  private webviewReady = false;
  private refreshTimer?: NodeJS.Timeout;
  private readonly watchers: vscode.FileSystemWatcher[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.webviewReady = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };
    webviewView.webview.onDidReceiveMessage((message: { type?: string; taskId?: string }) => {
      void this.handleMessage(message);
    }, undefined, this.context.subscriptions);
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
    }, undefined, this.context.subscriptions);
  }

  installWatchers(context: vscode.ExtensionContext): void {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const notebookWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, 'templates/*.ipynb')
      );
      const progressWatchers = ['templates/data/progress.json', 'data/progress.json'].map((relativePath) =>
        vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, relativePath))
      );

      for (const watcher of progressWatchers) {
        watcher.onDidChange(() => this.refresh());
        watcher.onDidCreate(() => this.refresh());
        watcher.onDidDelete(() => this.refresh());
        this.watchers.push(watcher);
        context.subscriptions.push(watcher);
      }

      notebookWatcher.onDidChange(() => {
        this.tasks = [];
        void this.refresh();
      });
      notebookWatcher.onDidCreate(() => {
        this.tasks = [];
        void this.refresh();
      });
      notebookWatcher.onDidDelete(() => {
        this.tasks = [];
        void this.refresh();
      });
      this.watchers.push(notebookWatcher);
      context.subscriptions.push(notebookWatcher);
    }
  }

  invalidateWorkspace(): void {
    this.root = undefined;
    this.tasks = [];
    this.selectedTaskId = undefined;
    this.lastResult = undefined;
    this.lastHint = undefined;
    this.lastError = undefined;
  }

  isTorchCodeNotebook(uri: vscode.Uri): boolean {
    return Boolean(this.root && uri.fsPath.startsWith(path.join(this.root.fsPath, 'templates') + path.sep));
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.torchcode');
    this.view?.show(true);
    await this.refresh();
  }

  async openWelcome(): Promise<void> {
    const root = await this.ensureWorkspace();
    if (!root) {
      return;
    }
    await this.openNotebook(vscode.Uri.joinPath(root, 'templates', WELCOME_FILE));
  }

  async runTestsForCurrentTask(): Promise<void> {
    const task = await this.getCurrentTask();
    if (!task) {
      this.lastError = '请先从题目列表中打开一道练习题。';
      await this.refresh();
      return;
    }
    await this.runTests(task);
  }

  async showHintForCurrentTask(): Promise<void> {
    const task = await this.getCurrentTask();
    if (!task) {
      this.lastError = '请先从题目列表中打开一道练习题。';
      await this.refresh();
      return;
    }
    await this.showHint(task);
  }

  async refresh(fromNotebookEdit = false): Promise<void> {
    if (fromNotebookEdit) {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        void this.refresh();
      }, 120);
      return;
    }

    const root = await this.ensureWorkspace();
    if (!root) {
      this.postState({
        workspaceReady: false,
        workspaceName: '',
        tasks: [],
        error: '打开 TorchCode 仓库后，这里会显示练习进度和题目目录。'
      });
      return;
    }

    try {
      if (this.tasks.length === 0) {
        this.tasks = await loadTasks(root);
      }
      const progress = await loadProgress(root);
      const activeTask = this.getActiveTask();
      if (activeTask) {
        this.selectedTaskId = activeTask.id;
      }
      const selectedTask = this.tasks.find((task) => task.id === this.selectedTaskId) ?? this.tasks[0];
      if (selectedTask && !this.selectedTaskId) {
        this.selectedTaskId = selectedTask.id;
      }

      const description = activeTask?.id === selectedTask?.id
        ? getNotebookDescription(vscode.window.activeNotebookEditor?.notebook) ?? activeTask.description
        : selectedTask?.description;
      const taskStates = this.tasks.map((task) => {
        const entry = progress[task.id] ?? {};
        return {
          ...task,
          progress: entry,
          status: normalizeStatus(entry.status)
        };
      });

      this.postState({
        workspaceReady: true,
        workspaceName: path.basename(root.fsPath),
        tasks: taskStates,
        selectedTaskId: selectedTask?.id,
        activeTaskId: activeTask?.id,
        description,
        result: this.lastResult?.taskId === selectedTask?.id ? this.lastResult.result : undefined,
        resultTaskId: this.lastResult?.taskId,
        hint: this.lastHint?.taskId === selectedTask?.id ? this.lastHint.hint : undefined,
        hintTaskId: this.lastHint?.taskId,
        error: this.lastError
      });
    } catch (error) {
      this.postState({
        workspaceReady: false,
        workspaceName: '',
        tasks: [],
        error: errorMessage(error)
      });
    }
  }

  private async handleMessage(message: { type?: string; taskId?: string }): Promise<void> {
    const task = message.taskId ? this.tasks.find((candidate) => candidate.id === message.taskId) : undefined;
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        await this.refresh();
        return;
      case 'refresh':
        this.lastError = undefined;
        await this.refresh();
        return;
      case 'openWelcome':
        await this.openWelcome();
        return;
      case 'selectTask':
        if (task) {
          this.selectedTaskId = task.id;
          this.lastError = undefined;
          await this.openNotebook(task.uri);
          await this.refresh();
        }
        return;
      case 'openTask':
        if (task) {
          this.selectedTaskId = task.id;
          await this.openNotebook(task.uri);
          await this.refresh();
        }
        return;
      case 'runTests':
        if (task) {
          this.selectedTaskId = task.id;
          await this.runTests(task);
        }
        return;
      case 'showHint':
        if (task) {
          this.selectedTaskId = task.id;
          await this.showHint(task);
        }
        return;
      default:
        return;
    }
  }

  private async ensureWorkspace(): Promise<vscode.Uri | undefined> {
    if (this.root) {
      return this.root;
    }

    const configuredRoot = vscode.workspace.getConfiguration('torchcode').get<string>('workspaceRoot')?.trim();
    const candidates: vscode.Uri[] = [];
    if (configuredRoot) {
      const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const rootPath = path.isAbsolute(configuredRoot)
        ? configuredRoot
        : path.resolve(firstFolder ?? process.cwd(), configuredRoot);
      candidates.push(vscode.Uri.file(rootPath));
    }
    candidates.push(...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri));

    for (const candidate of candidates) {
      if (existsSync(path.join(candidate.fsPath, 'templates', WELCOME_FILE)) &&
          existsSync(path.join(candidate.fsPath, 'torch_judge'))) {
        this.root = candidate;
        return candidate;
      }
    }
    return undefined;
  }

  private getActiveTask(): Task | undefined {
    const active = vscode.window.activeNotebookEditor?.notebook;
    if (!active) {
      return undefined;
    }
    return this.tasks.find((task) => task.uri.toString() === active.uri.toString());
  }

  private async getCurrentTask(): Promise<Task | undefined> {
    await this.ensureWorkspace();
    if (this.tasks.length === 0 && this.root) {
      this.tasks = await loadTasks(this.root);
    }
    return this.getActiveTask() ?? this.tasks.find((task) => task.id === this.selectedTaskId);
  }

  private async openNotebook(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'jupyter-notebook');
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  private async runTests(task: Task): Promise<void> {
    if (this.running) {
      return;
    }
    const root = await this.ensureWorkspace();
    if (!root) {
      return;
    }

    this.running = true;
    this.lastError = undefined;
    this.lastHint = undefined;
    this.postLoading('正在运行测试...');
    try {
      const code = await getTaskCode(task);
      const reply = await runJudge(root, { action: 'test', task_id: task.id, user_code: code });
      if (!reply.ok || !reply.result) {
        throw new Error(reply.error ?? '无法运行测试。');
      }
      this.lastResult = { taskId: task.id, result: reply.result };
    } catch (error) {
      this.lastError = `测试未能启动：${errorMessage(error)}`;
    } finally {
      this.running = false;
      await this.refresh();
    }
  }

  private async showHint(task: Task): Promise<void> {
    const root = await this.ensureWorkspace();
    if (!root) {
      return;
    }
    this.lastError = undefined;
    this.postLoading('正在获取提示...');
    try {
      const reply = await runJudge(root, { action: 'hint', task_id: task.id });
      if (!reply.ok || !reply.hint) {
        throw new Error(reply.error ?? '未找到提示。');
      }
      this.lastHint = { taskId: task.id, hint: reply.hint };
    } catch (error) {
      this.lastError = `提示未能加载：${errorMessage(error)}`;
    } finally {
      await this.refresh();
    }
  }

  private postLoading(label: string): void {
    if (this.webviewReady) {
      void this.view?.webview.postMessage({ type: 'loading', label });
    }
  }

  private postState(state: DashboardState): void {
    if (this.webviewReady) {
      void this.view?.webview.postMessage({ type: 'state', state });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const mediaUri = (fileName: string): string => webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'vendor', fileName)
    ).toString();
    const markdownItUri = mediaUri('markdown-it.min.js');
    const katexUri = mediaUri('katex.min.js');
    const autoRenderUri = mediaUri('auto-render.min.js');
    const katexCssUri = mediaUri('katex.min.css');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;">
  <link nonce="${nonce}" rel="stylesheet" href="${katexCssUri}">
  <style nonce="${nonce}">
    :root { color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-size: 13px; }
    button, input { font: inherit; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 5px; cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .app { min-height: 100vh; }
    .topbar { padding: 14px 14px 10px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .title-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { margin: 0; font-size: 15px; font-weight: 650; }
    h2 { margin: 0; font-size: 13px; font-weight: 650; }
    .muted { color: var(--vscode-descriptionForeground); }
    .summary { margin-top: 10px; }
    .summary-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .count { font-weight: 650; color: var(--vscode-charts-green); }
    .progress-track { height: 5px; margin-top: 7px; overflow: hidden; background: var(--vscode-input-background); border-radius: 3px; }
    .progress-value { height: 100%; background: var(--vscode-charts-green); }
    .toolbar { display: flex; gap: 6px; margin-top: 12px; }
    .secondary { padding: 5px 8px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .content { display: grid; grid-template-rows: minmax(230px, 42vh) minmax(0, 1fr); min-height: calc(100vh - 123px); }
    .catalog { overflow: auto; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .catalog-tools { position: sticky; top: 0; z-index: 1; padding: 10px 12px 8px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .search { width: 100%; padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
    .filters { display: flex; gap: 4px; margin-top: 7px; }
    .filter { flex: 1; padding: 4px 2px; color: var(--vscode-foreground); background: transparent; border-color: transparent; font-size: 11px; }
    .filter.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .group { padding: 8px 0 2px; }
    .group-title { padding: 0 12px 5px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 650; }
    .task { width: 100%; display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 7px; align-items: center; padding: 7px 12px; color: inherit; text-align: left; background: transparent; border: 0; border-radius: 0; }
    .task:hover { background: var(--vscode-list-hoverBackground); }
    .task.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .task-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-number { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .status { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .status.solved { background: var(--vscode-charts-green); }
    .status.attempted { background: var(--vscode-charts-yellow); }
    .difficulty { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .detail { min-height: 0; overflow: auto; padding: 12px; }
    .detail-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
    .tag { padding: 2px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 12px; }
    .primary { padding: 7px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .outline { padding: 7px 8px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .outline:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .wide { grid-column: 1 / -1; }
    .description { padding: 10px; overflow-wrap: anywhere; color: var(--vscode-editor-foreground); background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-charts-blue); }
    .result, .hint, .error { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); }
    .result-summary { margin-top: 6px; font-weight: 650; }
    .result-summary.passed { color: var(--vscode-testing-iconPassed); }
    .result-summary.failed { color: var(--vscode-testing-iconFailed); }
    .test { margin-top: 7px; padding: 7px 8px; background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-testing-iconPassed); }
    .test.failed { border-left-color: var(--vscode-testing-iconFailed); }
    .test-name { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
    .test-time { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; white-space: nowrap; }
    .test-error, .traceback { margin: 5px 0 0; overflow: auto; color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; }
    .hint-copy { margin-top: 6px; }
    .markdown { line-height: 1.55; }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 14px 0 7px; font-size: 13px; font-weight: 650; line-height: 1.35; }
    .markdown h1 { font-size: 15px; }
    .markdown p { margin: 7px 0; }
    .markdown ul, .markdown ol { margin: 7px 0; padding-left: 22px; }
    .markdown li + li { margin-top: 3px; }
    .markdown code { padding: 1px 3px; color: var(--vscode-textPreformat-foreground); background: var(--vscode-textCodeBlock-background); border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: .92em; }
    .markdown pre { margin: 8px 0; padding: 8px; overflow: auto; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
    .markdown pre code { padding: 0; background: transparent; }
    .markdown blockquote { margin: 8px 0; padding-left: 9px; color: var(--vscode-descriptionForeground); border-left: 2px solid var(--vscode-charts-blue); }
    .markdown table { width: 100%; margin: 8px 0; border-collapse: collapse; font-size: 12px; }
    .markdown th, .markdown td { padding: 5px; text-align: left; border: 1px solid var(--vscode-panel-border); }
    .markdown a { color: var(--vscode-textLink-foreground); }
    .markdown .katex-display { margin: 9px 0; overflow-x: auto; overflow-y: hidden; }
    .empty { padding: 18px 12px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
    .loading { display: none; position: fixed; inset: 0; z-index: 3; align-items: center; justify-content: center; padding: 16px; color: var(--vscode-editor-foreground); background: color-mix(in srgb, var(--vscode-sideBar-background) 86%, transparent); text-align: center; }
    .loading.visible { display: flex; }
    @media (max-width: 260px) { .actions { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
  </style>
</head>
<body>
  <main class="app" id="app"><div class="topbar"><h1>TorchCode</h1></div><div class="empty">正在加载练习进度...</div></main>
  <div class="loading" id="loading"></div>
  <script nonce="${nonce}" src="${markdownItUri}"></script>
  <script nonce="${nonce}" src="${katexUri}"></script>
  <script nonce="${nonce}" src="${autoRenderUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const loading = document.getElementById('loading');
    let state;
    let filter = 'all';
    let query = '';
    let renderedSelectedTaskId;
    let catalogScrollTop = 0;
    let detailScrollTop = 0;

    function esc(value) {
      return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
    }
    function statusLabel(status) {
      return status === 'solved' ? '已完成' : status === 'attempted' ? '进行中' : '未开始';
    }
    function taskMatches(task) {
      const text = (task.title + ' ' + task.id + ' ' + task.group).toLowerCase();
      return (filter === 'all' || task.status === filter) && text.includes(query.toLowerCase());
    }
    function renderMarkdown(markdown) {
      const source = String(markdown ?? '');
      if (typeof window.markdownit !== 'function') {
        return '<p>' + esc(source).replace(/\\n/g, '<br>') + '</p>';
      }
      return window.markdownit({ html: false, linkify: true, typographer: false }).render(source);
    }
    function renderMath(container) {
      if (!container || typeof window.renderMathInElement !== 'function') return;
      try {
        const slash = String.fromCharCode(92);
        window.renderMathInElement(container, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: slash + '[', right: slash + ']', display: true },
            { left: '$', right: '$', display: false },
            { left: slash + '(', right: slash + ')', display: false }
          ],
          throwOnError: false,
          strict: 'ignore',
          ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
        });
      } catch (error) {
        console.error('TorchCode math rendering failed', error);
      }
    }
    function renderResult(result) {
      if (!result) return '';
      const success = result.success === true;
      const header = result.error
        ? '<div class="result-summary failed">' + esc(result.error) + '</div>'
        : '<div class="result-summary ' + (success ? 'passed' : 'failed') + '">' +
          (success ? '全部测试通过' : '还有测试未通过') + ' · ' + esc(result.passed) + ' / ' + esc(result.total) + '</div>';
      const tests = (result.tests || []).map((test) => {
        const details = [test.error_msg, test.error_traceback, test.stdout, test.stderr].filter(Boolean).join('\\n');
        return '<div class="test ' + (test.passed ? '' : 'failed') + '">' +
          '<div class="test-name"><span>' + (test.passed ? '通过' : '未通过') + ' · ' + esc(test.name) + '</span>' +
          '<span class="test-time">' + Number(test.time_ms || 0).toFixed(1) + ' ms</span></div>' +
          (details ? '<pre class="test-error">' + esc(details) + '</pre>' : '') + '</div>';
      }).join('');
      const trace = result.traceback ? '<pre class="traceback">' + esc(result.traceback) + '</pre>' : '';
      return '<section class="result"><h2>测试结果</h2>' + header + trace + tests + '</section>';
    }
    function renderDetail(task) {
      if (!task) return '<div class="empty">从上方选择一道题目开始练习。</div>';
      const title = esc(task.title);
      const difficulty = esc(task.difficulty);
      const description = renderMarkdown(state.description || task.description || '题目说明暂不可用。');
      const hint = state.hint && state.hintTaskId === task.id
        ? '<section class="hint"><h2>提示</h2><div class="hint-copy markdown">' + renderMarkdown(state.hint) + '</div></section>' : '';
      const result = state.resultTaskId === task.id ? renderResult(state.result) : '';
      return '<div class="detail-header"><div><h2>' + title + '</h2><div class="muted">第 ' + esc(task.order) + ' 题 · ' + statusLabel(task.status) + '</div></div><span class="tag">' + difficulty + '</span></div>' +
        '<div class="actions"><button class="outline wide" data-action="openTask" data-task="' + esc(task.id) + '">打开 Notebook</button>' +
        '<button class="primary" data-action="runTests" data-task="' + esc(task.id) + '">运行测试</button>' +
        '<button class="outline" data-action="showHint" data-task="' + esc(task.id) + '">查看提示</button></div>' +
        '<section><h2>题目说明</h2><div class="description markdown">' + description + '</div></section>' + hint + result;
    }
    function render() {
      if (!state || !state.workspaceReady) {
        app.innerHTML = '<div class="topbar"><h1>TorchCode</h1></div><div class="empty">' + esc(state?.error || '正在读取工作区...') + '</div>';
        return;
      }
      const tasks = state.tasks || [];
      const solved = tasks.filter((task) => task.status === 'solved').length;
      const percent = tasks.length ? Math.round(solved / tasks.length * 100) : 0;
      const selected = tasks.find((task) => task.id === state.selectedTaskId) || tasks[0];
      const previousCatalog = app.querySelector('.catalog');
      const previousDetail = app.querySelector('.detail');
      if (previousCatalog) catalogScrollTop = previousCatalog.scrollTop;
      if (previousDetail) detailScrollTop = previousDetail.scrollTop;
      const selectionChanged = Boolean(renderedSelectedTaskId && renderedSelectedTaskId !== selected?.id);
      if (selectionChanged) detailScrollTop = 0;
      const visible = tasks.filter(taskMatches);
      const groups = new Map();
      visible.forEach((task) => { const list = groups.get(task.group) || []; list.push(task); groups.set(task.group, list); });
      const items = [...groups.entries()].map(([group, groupTasks]) => '<section class="group"><div class="group-title">' + esc(group) + '</div>' + groupTasks.map((task) =>
        '<button class="task ' + (task.id === selected?.id ? 'selected' : '') + '" data-action="selectTask" data-task="' + esc(task.id) + '" title="打开 ' + esc(task.title) + '">' +
          '<span class="status ' + esc(task.status) + '"></span><span class="task-title"><span class="task-number">' + String(task.order).padStart(2, '0') + '</span> ' + esc(task.title) + '</span><span class="difficulty">' + esc(task.difficulty) + '</span></button>'
      ).join('') + '</section>').join('') || '<div class="empty">没有匹配的题目。</div>';
      app.innerHTML = '<header class="topbar"><div class="title-line"><h1>TorchCode</h1><span class="muted">' + esc(state.workspaceName) + '</span></div>' +
        '<div class="summary"><div class="summary-line"><span>练习进度</span><span class="count">' + solved + ' / ' + tasks.length + '</span></div><div class="progress-track"><div class="progress-value" style="width:' + percent + '%"></div></div></div>' +
        '<div class="toolbar"><button class="secondary" data-action="openWelcome">打开题目总览</button><button class="secondary" data-action="refresh">刷新</button></div></header>' +
        '<div class="content"><section class="catalog"><div class="catalog-tools"><input class="search" id="search" value="' + esc(query) + '" placeholder="搜索题目" aria-label="搜索题目"><div class="filters">' +
          [['all', '全部'], ['todo', '未开始'], ['attempted', '进行中'], ['solved', '已完成']].map(([value, label]) => '<button class="filter ' + (filter === value ? 'active' : '') + '" data-filter="' + value + '">' + label + '</button>').join('') +
          '</div></div>' + items + '</section><section class="detail">' + renderDetail(selected) + (state.error ? '<section class="error"><h2>无法完成操作</h2><div class="hint-copy">' + esc(state.error) + '</div></section>' : '') + '</section></div>';
      renderedSelectedTaskId = selected?.id;
      const catalog = app.querySelector('.catalog');
      const detail = app.querySelector('.detail');
      if (catalog) {
        catalog.scrollTop = catalogScrollTop;
        catalog.addEventListener('scroll', () => { catalogScrollTop = catalog.scrollTop; }, { passive: true });
      }
      if (detail) {
        detail.scrollTop = detailScrollTop;
        detail.addEventListener('scroll', () => { detailScrollTop = detail.scrollTop; }, { passive: true });
      }
      app.querySelectorAll('.markdown').forEach(renderMath);
      document.getElementById('search')?.addEventListener('input', (event) => { query = event.target.value; render(); });
      app.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; render(); }));
      app.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.action, taskId: button.dataset.task })));
    }
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'loading') { loading.textContent = message.label; loading.classList.add('visible'); return; }
      if (message.type === 'state') { loading.classList.remove('visible'); state = message.state; render(); }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

async function loadTasks(root: vscode.Uri): Promise<Task[]> {
  const templatesPath = path.join(root.fsPath, 'templates');
  const entries = await fs.readdir(templatesPath, { withFileTypes: true });
  const welcomeTasks = await loadWelcomeTasks(path.join(templatesPath, WELCOME_FILE));
  const notebooks = entries
    .filter((entry) => entry.isFile() && /^\d+_.+\.ipynb$/i.test(entry.name) && entry.name !== WELCOME_FILE)
    .sort((left, right) => notebookOrder(left.name) - notebookOrder(right.name));

  const tasks = await Promise.all(notebooks.map(async (entry) => {
    const fileName = entry.name;
    const notebook = await readNotebook(path.join(templatesPath, fileName));
    const cells = notebook.cells ?? [];
    const markdown = cells.find((cell) => cell.cell_type === 'markdown');
    const description = removeColabBadge(cellSource(markdown));
    const code = cells.filter((cell) => cell.cell_type === 'code').map(cellSource).join('\n');
    const taskId = code.match(/\bcheck\s*\(\s*["']([^"']+)["']/)?.[1] ?? fileName.replace(/^\d+_/, '').replace(/\.ipynb$/i, '');
    const difficulty = (description.match(/\b(Easy|Medium|Hard)\b/i)?.[1] ?? 'Unknown') as Difficulty;
    const heading = description.split(/\r?\n/).find((line) => /^#\s+/.test(line)) ?? fileName;
    const title = cleanTitle(heading, difficulty);
    return {
      id: taskId,
      fileName,
      title,
      difficulty,
      group: welcomeTasks.get(fileName)?.group ?? '练习题目',
      description,
      order: notebookOrder(fileName),
      uri: vscode.Uri.file(path.join(templatesPath, fileName))
    };
  }));
  return tasks.sort((left, right) => {
    const leftRank = welcomeTasks.get(left.fileName)?.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = welcomeTasks.get(right.fileName)?.rank ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.order - right.order;
  });
}

async function loadWelcomeTasks(welcomePath: string): Promise<Map<string, WelcomeTaskInfo>> {
  const tasks = new Map<string, WelcomeTaskInfo>();
  try {
    const notebook = await readNotebook(welcomePath);
    let group = '练习题目';
    let rank = 0;
    for (const cell of notebook.cells ?? []) {
      if (cell.cell_type !== 'markdown') {
        continue;
      }
      for (const line of cellSource(cell).split(/\r?\n/)) {
        const heading = line.match(/^###\s+(.+)/);
        if (heading) {
          group = stripMarkdown(heading[1]);
        }
        for (const match of line.matchAll(/\]\((?:[^)]*\/)?(\d+_[^)]+\.ipynb)\)/g)) {
          const fileName = match[1];
          if (!fileName.includes('_solution')) {
            tasks.set(fileName, { group, rank: rank++ });
          }
        }
      }
    }
  } catch {
    // The task list remains usable when the welcome notebook has been removed or edited.
  }
  return tasks;
}

async function loadProgress(root: vscode.Uri): Promise<Record<string, ProgressEntry>> {
  const progressPaths = [
    path.join(root.fsPath, PROGRESS_RELATIVE_PATH),
    path.join(root.fsPath, 'data', 'progress.json')
  ];
  const merged: Record<string, ProgressEntry> = {};
  for (const progressPath of progressPaths) {
    try {
      const data = JSON.parse(await fs.readFile(progressPath, 'utf8')) as Record<string, ProgressEntry>;
      for (const [taskId, entry] of Object.entries(data)) {
        merged[taskId] = mergeProgress(merged[taskId], entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return merged;
}

function mergeProgress(current: ProgressEntry | undefined, incoming: ProgressEntry): ProgressEntry {
  if (!current) {
    return incoming;
  }
  const currentSolved = current.status === 'solved';
  const incomingSolved = incoming.status === 'solved';
  if (incomingSolved && !currentSolved) {
    return incoming;
  }
  if (currentSolved && !incomingSolved) {
    return current;
  }
  const currentTime = current.best_time ?? Number.POSITIVE_INFINITY;
  const incomingTime = incoming.best_time ?? Number.POSITIVE_INFINITY;
  return incomingTime < currentTime ? incoming : current;
}

async function getTaskCode(task: Task): Promise<string> {
  const openNotebook = vscode.workspace.notebookDocuments.find((document) => document.uri.toString() === task.uri.toString());
  if (openNotebook) {
    return extractUserCode(openNotebook.getCells().map((cell) => ({
      cell_type: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
      source: cell.document.getText()
    })));
  }
  return extractUserCode((await readNotebook(task.uri.fsPath)).cells ?? []);
}

function extractUserCode(cells: IpynbCell[]): string {
  const submissionIndex = cells.findIndex((cell) => {
    const source = cellSource(cell);
    return /from\s+torch_judge\s+import[^\n]*(?:\bcheck\b)|\bcheck\s*\(\s*["']/.test(source);
  });
  const candidateCells = (submissionIndex >= 0 ? cells.slice(0, submissionIndex) : cells)
    .filter((cell) => cell.cell_type === 'code')
    .map(cellSource)
    .filter((source) => !isJudgeOrDebugCell(source));
  return candidateCells.join('\n\n');
}

function isJudgeOrDebugCell(source: string): boolean {
  const firstLine = source.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  return /from\s+torch_judge\s+import/.test(source) ||
    /\b(?:check|hint|status)\s*\(/.test(source) ||
    /^\s*#\s*(?:[^\w\s]+\s*)?(?:test|debug|submit)\b/i.test(firstLine);
}

function getNotebookDescription(notebook: vscode.NotebookDocument | undefined): string | undefined {
  if (!notebook) {
    return undefined;
  }
  const firstMarkdown = notebook.getCells().find((cell) => cell.kind === vscode.NotebookCellKind.Markup);
  return firstMarkdown ? removeColabBadge(firstMarkdown.document.getText()) : undefined;
}

async function readNotebook(filePath: string): Promise<IpynbFile> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as IpynbFile;
}

function cellSource(cell: IpynbCell | undefined): string {
  if (!cell?.source) {
    return '';
  }
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

function removeColabBadge(markdown: string): string {
  return markdown.replace(/^\s*\[!\[Open In Colab\][^\n]*\]\([^\n]*\)\s*\r?\n*/i, '').trim();
}

function cleanTitle(heading: string, difficulty: Difficulty): string {
  const withoutHeading = heading.replace(/^#\s+/, '').trim();
  const withoutIcon = withoutHeading.replace(/^[^\p{L}\p{N}]+/u, '');
  const withoutDifficulty = difficulty === 'Unknown'
    ? withoutIcon
    : withoutIcon.replace(new RegExp(`^${difficulty}:\\s*`, 'i'), '');
  return stripMarkdown(withoutDifficulty).trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(/[*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function notebookOrder(fileName: string): number {
  return Number(fileName.match(/^(\d+)_/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function normalizeStatus(status: TaskStatus | undefined): TaskStatus {
  return status === 'solved' || status === 'attempted' ? status : 'todo';
}

async function runJudge(root: vscode.Uri, payload: Record<string, string>): Promise<RunnerReply> {
  const python = resolvePython(root);
  const progressPath = path.join(root.fsPath, PROGRESS_RELATIVE_PATH);
  return new Promise<RunnerReply>((resolve, reject) => {
    const child = spawn(python, ['-m', 'torch_judge.vscode_runner'], {
      cwd: root.fsPath,
      env: {
        ...process.env,
        PROGRESS_PATH: progressPath,
        PYTHONIOENCODING: 'utf-8'
      },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('判题超过 120 秒仍未结束。'));
    }, 120_000);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      try {
        const reply = JSON.parse(stdout) as RunnerReply;
        if (code !== 0 && reply.ok) {
          reject(new Error(stderr || `Python 以退出码 ${code} 结束。`));
          return;
        }
        resolve(reply);
      } catch {
        reject(new Error(stderr || stdout || `Python 以退出码 ${code} 结束。`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function resolvePython(root: vscode.Uri): string {
  const configured = vscode.workspace.getConfiguration('torchcode').get<string>('pythonPath')?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(root.fsPath, configured);
  }
  const candidates = process.platform === 'win32'
    ? [path.join(root.fsPath, '.venv', 'Scripts', 'python.exe'), path.join(root.fsPath, 'venv', 'Scripts', 'python.exe')]
    : [path.join(root.fsPath, '.venv', 'bin', 'python'), path.join(root.fsPath, 'venv', 'bin', 'python')];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'python';
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
