/**
 * 用户可见的键盘快捷键总表。
 *
 * `/help` 与 cli 启动帮助共用这份数据(ZCode 风格的可发现性:用户不需要
 * 背键位,查一下就知道能按什么)。修改键位绑定时同步更新这张表,否则提示
 * 会与实现再次漂移——这个问题过去已经发生过几次(见 README 的 Tab 段)。
 */

export interface ShortcutGroup {
  readonly topic: string;
  readonly lines: readonly [key: string, description: string][];
}

export const SHORTCUTS: readonly ShortcutGroup[] = [
  {
    topic: "Editing the prompt",
    lines: [
      ["Enter", "提交输入(Shift+Enter 或 Ctrl+J 插入换行)"],
      ["Ctrl+Z / Ctrl+Y", "撤销 / 重做;误清空草稿也能 ctrl+z 救回"],
      ["Ctrl+W", "向前删除一个词"],
      ["Ctrl/Alt + ←/→", "按词移动光标;Home/End 到 当前行 首尾"],
      ["Ctrl+Q", "查看并取消排队中的 follow-up"],
      ["@", "补全文件路径(@\"带空格的路径\" 也支持)"],
    ],
  },
  {
    topic: "Reading the transcript",
    lines: [
      ["PageUp / PageDown", "翻页(transcript 与 details 覆盖层都支持)"],
      ["Ctrl+↑ / Ctrl+↓", "滚 3 行"],
      ["Ctrl+T", "打开“最近活动”详情(可滚动;再按关闭)"],
      ["Esc(空闲)", "清空 composer(草稿可用 Ctrl+Z 恢复)"],
    ],
  },
  {
    topic: "While a task is running",
    lines: [
      ["Esc ×2", "在 1.2s 内连按两次取消当前任务"],
      ["直接输入", "作为 steering 指导注入正在运行的任务"],
      ["Tab / Shift+Tab", "切换工作模式(plan/auto)/切换思考强度"],
    ],
  },
  {
    topic: "Dialogs & approvals",
    lines: [
      ["y / a / n", "审批快捷回答:允许一次 / 总是允许 / 拒绝"],
      ["Esc", "关闭当前弹层;删除类确认默认落在 Cancel,只有 Enter 落在 Delete 才生效"],
    ],
  },
];

/** 排版成 help 文本使用的段落体,供 commandHelp 与 cli 帮助直接拼接。 */
export function shortcutsHelp(): string {
  return SHORTCUTS.map(
    (group) => [`${group.topic}:`, ...group.lines.map(([key, description]) => `  ${key.padEnd(18)}${description}`)].join("\n"),
  ).join("\n\n");
}
