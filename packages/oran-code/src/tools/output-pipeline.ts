/**
 * Deterministic post-processing pipeline for shell output.
 *
 * The goal is for the model to read **information** rather than terminal noise: ANSI colors,
 * repeatedly repainted lines, and trailing blank lines carry no information, yet they genuinely
 * eat into the context budget.
 * Deliberately conservative: only unambiguous cleanup, no "guessing" summaries (such as folding
 * test results into a verdict), because a heuristic like that silently drops information the
 * moment it guesses wrong.
 */

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Collapse consecutive repeated lines: a line repeated 3 or more times is squeezed into one line
 * annotated with the count.
 * Typical sources are progress bars, line-by-line logs, and repeated warnings — keeping a single
 * line conveys all of the information.
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

/** Default post-processing for run_command: strip ANSI → collapse repeated lines → drop trailing blank lines. */
export function compactShellOutput(text: string): string {
  if (!text) return text;
  return collapseRepeatedLines(stripAnsi(text)).replace(/\n+$/, "");
}
