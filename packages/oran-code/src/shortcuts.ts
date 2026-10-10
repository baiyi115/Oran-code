/**
 * The master table of user-visible keyboard shortcuts.
 *
 * `/help` and the cli startup help share this data (ZCode-style discoverability: users
 * should not have to memorise keybindings, they can look them up). Update this table
 * whenever a binding changes, otherwise the hints drift away from the implementation
 * once more — that has already happened several times (see the Tab section in the README).
 */

export interface ShortcutGroup {
  readonly topic: string;
  readonly lines: readonly [key: string, description: string][];
}

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    topic: "Editing the prompt",
    lines: [
      ["Enter", "提交输入(要写多行就整段粘贴:折叠成占位符,提交时按原文发出)"],
      ["Ctrl+Z / Ctrl+Y", "撤销 / 重做;光标位置与折叠的粘贴内容一并恢复"],
      ["Ctrl+W", "向前删除一个词"],
      ["Ctrl/Alt + ←/→", "按词移动光标;Home/End 到 当前行 首尾"],
      ["Ctrl+Q", "查看并取消排队中的 follow-up"],
      ["@", '补全文件路径(@"带空格的路径" 也支持)'],
      // Idle-only: while a task runs both callbacks refuse and the TUI says to finish
      // or cancel first, so this cannot live under "While a task is running".
      ["Tab / Shift+Tab", "切换工作模式(plan/auto)/切换思考强度(空闲时;任务运行中会提示先结束当前任务)"],
    ],
  },
  {
    topic: "Reading the transcript",
    lines: [
      // Only the live region scrolls: everything already committed is in the
      // terminal's own scrollback, so paging here cannot reach it.
      ["PageUp / PageDown", "翻页(活动区;更早的输出已进入终端自身的回滚缓冲,用终端的滚动)"],
      ["Ctrl+↑ / Ctrl+↓", "滚 3 行"],
      ["滚轮", "滚动活动区(详情覆盖层同样适用;选中文字改用 Shift+拖选)"],
      ["Ctrl+T", "打开“最近活动”详情(只展开最近一段;可滚动,再按关闭)"],
      ["Esc(空闲)", "清空 composer(文本、光标与粘贴内容都可用 Ctrl+Z 恢复)"],
    ],
  },
  {
    topic: "While a task is running",
    lines: [
      ["Esc ×2", "在 1.2s 内连按两次取消当前任务"],
      ["直接输入", "作为 steering 指导注入正在运行的任务"],
    ],
  },
  {
    topic: "Dialogs & approvals",
    lines: [
      ["y / n", "审批快捷回答:允许一次 / 拒绝(“总是允许”用 ↑↓ 选中后回车)"],
      ["Esc", "关闭当前弹层;删除类确认默认落在 Cancel,只有 Enter 落在 Delete 才生效"],
    ],
  },
];

/** Renders the table as the paragraph body used by help text, for commandHelp and the cli
 * help to concatenate directly. */
export function shortcutsHelp(): string {
  return SHORTCUTS.map((group) =>
    [`${group.topic}:`, ...group.lines.map(([key, description]) => `  ${key.padEnd(18)}${description}`)].join("\n"),
  ).join("\n\n");
}
