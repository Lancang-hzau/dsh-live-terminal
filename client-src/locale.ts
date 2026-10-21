/**
 * Localized copy for the terminal panel (`dshTerminalPanel` namespace).
 *
 * Chinese is the primary language; English mirrors every key. Dynamic values
 * use the `{name}` placeholder convention understood by the DSH locale service.
 *
 * 1.2.1 adds the compact chrome, search/history/context-menu, dialog,
 * sandbox/read-only and welcome copy. Placeholders used by this table:
 * `{seconds}`, `{code}`, `{current}`, `{total}`, `{count}`, `{title}`.
 */

export type LocaleTable = Record<string, string>

export const zh: LocaleTable = {
  title: '终端面板',
  description: '在侧栏中运行一个可见终端，实时显示命令输出',
  guideDescription: '打开可见终端面板',
  newTerminal: '新建终端',
  newTerminalShort: '新建',
  creating: '正在启动…',
  refresh: '刷新会话列表',
  reconnect: '重新连接',
  reconnecting: '正在重连…',
  screenshot: '截图',
  copyScreen: '复制屏幕到剪贴板',
  copySelection: '复制选区',
  paste: '粘贴',
  selectAll: '全选',
  clearScreen: '清屏',
  close: '关闭终端',
  closeSession: '关闭此终端',
  retry: '重试',
  loading: '正在连接终端服务…',
  empty: '暂无终端会话',
  emptyHint:
    '点击“新建终端”打开一个可见终端；agent 执行的命令会自动出现在这里，过短的命令可在历史中回看。',
  noTerminal: '未选择终端',
  listError: '无法连接终端服务',
  listErrorHint: '请检查网络后重试；若持续失败，请确认插件已正确加载。',
  hostNotReady: '终端服务尚未就绪，请稍后重试。',
  disconnected: '终端连接已断开',
  connecting: '正在连接…',
  connectingShort: '连接中',
  connectingShell: '正在连接 Shell…',
  connected: '实时连接',
  connectionLostScreenKept: '连接已断开，屏幕内容已保留。',
  copied: '已复制屏幕内容',
  copyFailed: '复制失败：当前屏幕为空',
  createFailed: '新建终端失败',
  closeFailed: '关闭终端失败',
  inputFailed: '输入发送失败',
  autoClosedFailed: '命令失败（退出码 {code}），终端已自动关闭：{title}',
  autoClosedSucceeded: '终端已自动关闭：{title}',
  running: '运行中',
  runningShort: '运行中',
  exited: '已退出',
  exitedWithCode: '已退出（{code}）',
  exitedShort: '已退出（{code}）',
  failed: '启动失败',
  paused: '已暂停自动关闭',
  commandSession: '命令',
  interactiveSession: '终端',
  sessionCount: '共 {count} 个终端',
  sessionCountShort: '{count} 个会话',

  /* ---- 1.2.1 chrome / tabs ---------------------------------------- */
  more: '更多操作',
  followLatest: '跟随最新输出',
  following: '正在跟随最新输出',
  pin: '保留此终端',
  unpin: '取消保留',
  pinned: '已保留',
  rename: '重命名',
  renamePrompt: '输入新的终端名称',
  unread: '未读',
  noSelection: '未选择会话',

  /* ---- 1.2.1 search / context menu -------------------------------- */
  search: '搜索',
  searchPlaceholder: '在终端中查找',
  searchNoResult: '无匹配结果',
  searchResult: '第 {current} / {total} 个匹配',

  /* ---- 1.2.1 history ---------------------------------------------- */
  history: '历史记录',
  historyEmpty: '暂无历史记录',
  historyHint: '关闭的命令会保留最近的输出，方便回看。',
  reopen: '重新打开',
  viewHistory: '查看历史',
  exportText: '导出文本',

  /* ---- 1.2.1 auto-close / keep ------------------------------------ */
  autoCloseIn: '将在 {seconds} 秒后自动关闭',
  autoCloseNow: '立即关闭',
  keepOpen: '保留',
  keepOpenHint: '保留此终端，不自动关闭',

  /* ---- 1.2.1 sandbox / read-only ---------------------------------- */
  sandboxBadge: '未沙箱',
  sandboxHint: '该终端以当前系统用户权限运行，不套用 DSH 文件沙箱。',
  readonlyBadge: '只读',
  takeControl: '接管输入',
  takeControlHint: '另一页正在输入，点击接管后才可继续输入。',
  notSandboxedTitle: '未套沙箱',
  notSandboxedBody: '终端命令以当前系统用户权限运行，不受 DSH 文件沙箱约束。',

  /* ---- 1.2.1 status / config -------------------------------------- */
  hostNotReadyShort: '终端服务未就绪',
  config: '配置',
  configTitle: '生效配置',
  configCopy: '复制配置',
  configCopied: '已复制配置',
  configHint: '以下为当前生效的只读配置。',
  shellLabel: 'Shell',
  sizeLabel: '尺寸',
  cwdLabel: '工作目录',
  maximize: '最大化',

  /* ---- 1.2.1 shortcuts / welcome ---------------------------------- */
  shortcuts: '快捷键',
  shortcutHelp: '终端快捷键',
  nextTab: '下一个终端',
  prevTab: '上一个终端',
  welcomeTitle: '终端面板已启用',
  welcomeBody:
    'agent 执行的命令会自动显示在这里；短于约 1.5 秒的命令默认隐藏，可在历史中回看。终端以当前系统用户权限运行，不套用 DSH 文件沙箱。',
  welcomeDontShow: '不再提示',
  welcomeOpen: '打开终端',

  /* ---- 1.2.1 global notice ---------------------------------------- */
  failedCommand: '命令失败（退出码 {code}）',
  viewTerminal: '查看终端',
  dismiss: '关闭',
  closeAllExited: '关闭全部已退出',
  closeOthers: '关闭其他',
}

export const en: LocaleTable = {
  title: 'Terminal Panel',
  description: 'A visible terminal in the sidebar that streams command output live',
  guideDescription: 'Open the visible terminal panel',
  newTerminal: 'New terminal',
  newTerminalShort: 'New',
  creating: 'Starting…',
  refresh: 'Refresh sessions',
  reconnect: 'Reconnect',
  reconnecting: 'Reconnecting…',
  screenshot: 'Screenshot',
  copyScreen: 'Copy screen to clipboard',
  copySelection: 'Copy selection',
  paste: 'Paste',
  selectAll: 'Select all',
  clearScreen: 'Clear screen',
  close: 'Close terminal',
  closeSession: 'Close this terminal',
  retry: 'Retry',
  loading: 'Connecting to the terminal service…',
  empty: 'No terminal sessions yet',
  emptyHint:
    'Click “New terminal” to open a visible terminal; agent commands show up here automatically. Very short commands are kept in history.',
  noTerminal: 'No terminal selected',
  listError: 'Could not reach the terminal service',
  listErrorHint: 'Check your connection and try again. If it keeps failing, make sure the plugin is loaded.',
  hostNotReady: 'The terminal service is not ready yet. Try again shortly.',
  disconnected: 'Terminal connection lost',
  connecting: 'Connecting…',
  connectingShort: 'Connecting',
  connectingShell: 'Connecting to the shell…',
  connected: 'Live',
  connectionLostScreenKept: 'Connection lost; the screen content is preserved.',
  copied: 'Screen copied to clipboard',
  copyFailed: 'Copy failed: the screen is empty',
  createFailed: 'Could not create a terminal',
  closeFailed: 'Could not close the terminal',
  inputFailed: 'Could not send input',
  autoClosedFailed: 'Command failed (exit {code}); terminal auto-closed: {title}',
  autoClosedSucceeded: 'Terminal auto-closed: {title}',
  running: 'Running',
  runningShort: 'Running',
  exited: 'Exited',
  exitedWithCode: 'Exited ({code})',
  exitedShort: 'Exited ({code})',
  failed: 'Failed to start',
  paused: 'Auto-close paused',
  commandSession: 'Command',
  interactiveSession: 'Terminal',
  sessionCount: '{count} terminals',
  sessionCountShort: '{count} sessions',

  /* ---- 1.2.1 chrome / tabs ---------------------------------------- */
  more: 'More actions',
  followLatest: 'Follow latest output',
  following: 'Following latest output',
  pin: 'Keep terminal',
  unpin: 'Stop keeping',
  pinned: 'Kept',
  rename: 'Rename',
  renamePrompt: 'Enter a new terminal name',
  unread: 'Unread',
  noSelection: 'No session selected',

  /* ---- 1.2.1 search / context menu -------------------------------- */
  search: 'Search',
  searchPlaceholder: 'Find in terminal',
  searchNoResult: 'No matches',
  searchResult: '{current} of {total} matches',

  /* ---- 1.2.1 history ---------------------------------------------- */
  history: 'History',
  historyEmpty: 'No history yet',
  historyHint: 'Recently closed commands keep their output here for review.',
  reopen: 'Reopen',
  viewHistory: 'View history',
  exportText: 'Export text',

  /* ---- 1.2.1 auto-close / keep ------------------------------------ */
  autoCloseIn: 'Closes in {seconds}s',
  autoCloseNow: 'Close now',
  keepOpen: 'Keep',
  keepOpenHint: 'Keep this terminal open instead of auto-closing it',

  /* ---- 1.2.1 sandbox / read-only ---------------------------------- */
  sandboxBadge: 'Unsandboxed',
  sandboxHint: 'Runs with your system user permissions, outside the DSH file sandbox.',
  readonlyBadge: 'Read-only',
  takeControl: 'Take control',
  takeControlHint: 'Another page owns input. Take control to type here.',
  notSandboxedTitle: 'Not sandboxed',
  notSandboxedBody:
    'Terminal commands run with your system user permissions and are not constrained by the DSH file sandbox.',

  /* ---- 1.2.1 status / config -------------------------------------- */
  hostNotReadyShort: 'Terminal service not ready',
  config: 'Configuration',
  configTitle: 'Effective configuration',
  configCopy: 'Copy configuration',
  configCopied: 'Configuration copied',
  configHint: 'Read-only view of the currently effective settings.',
  shellLabel: 'Shell',
  sizeLabel: 'Size',
  cwdLabel: 'Working directory',
  maximize: 'Maximize',

  /* ---- 1.2.1 shortcuts / welcome ---------------------------------- */
  shortcuts: 'Shortcuts',
  shortcutHelp: 'Terminal shortcuts',
  nextTab: 'Next terminal',
  prevTab: 'Previous terminal',
  welcomeTitle: 'Terminal panel is ready',
  welcomeBody:
    'Agent commands appear here automatically; commands shorter than about 1.5s are hidden by default and remain available in history. Terminals run with your system user permissions, outside the DSH file sandbox.',
  welcomeDontShow: "Don't show again",
  welcomeOpen: 'Open terminal',

  /* ---- 1.2.1 global notice ---------------------------------------- */
  failedCommand: 'Command failed (exit {code})',
  viewTerminal: 'View terminal',
  dismiss: 'Dismiss',
  closeAllExited: 'Close all exited',
  closeOthers: 'Close others',
}
