/** Anthropic 与 OpenAI 兼容两条转换路径共享的收尾逻辑。 */

/**
 * 运行时提醒统一合并到对话末尾的 user 消息上,避免逐轮变化的提醒文本
 * 就地改写历史消息而击穿稳定前缀缓存。没有 user 消息时追加一条。
 */
export function appendTailReminder(
  conversation: Array<Record<string, unknown>>,
  reminderText: string,
): void {
  if (!reminderText) return;
  const last = conversation[conversation.length - 1];
  if (last && last.role === "user") {
    if (typeof last.content === "string") {
      last.content = `${last.content}\n\n${reminderText}`;
    } else if (Array.isArray(last.content)) {
      last.content.push({ type: "text", text: reminderText });
    } else {
      conversation.push({ role: "user", content: reminderText });
    }
    return;
  }
  conversation.push({ role: "user", content: reminderText });
}
