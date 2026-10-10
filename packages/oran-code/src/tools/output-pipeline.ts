/**
 * shell 输出的确定性后处理管线。
 *
 * 目标是让模型读到**信息**而不是终端噪音:ANSI 颜色、重复刷屏行、尾随空行
 * 都不携带信息,却会实打实占用上下文预算。
 * 刻意保持保守:只做无歧义的清洗,不做"猜测式"摘要(例如把测试结果折叠成结论),
 * 因为这类启发式一旦猜错就是静默丢信息。
 */

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * 连续重复行折叠:同一行重复 3 次及以上时压成一行并标注次数。
 * 典型来源是进度条、逐行日志、重复的警告——保留一条即可表达全部信息。
 */
export function collapseRepeatedLines(text: string, minRepeat = 3): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    let repeat = 1;
    while (index + repeat < lines.length && lines[index + repeat] === line) repeat += 1;
    if (repeat >= minRepeat && line.trim().length > 0) {
      output.push(line, `[... line repeated ${repeat} times ...]`);
    } else {
      for (let extra = 0; extra < repeat; extra += 1) output.push(line);
    }
    index += repeat;
  }
  return output.join("\n");
}

/** run_command 的默认后处理:清洗 ANSI → 折叠重复行 → 去掉尾部空行。 */
export function compactShellOutput(text: string): string {
  if (!text) return text;
  return collapseRepeatedLines(stripAnsi(text)).replace(/\n+$/, "");
}
