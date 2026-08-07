import type { Widgets } from "blessed";
import { transparentStyle } from "./interaction.js";

/** Terminal theme: muted citrus for focus, warm neutrals for dense content. */
export const COLORS = {
  accent: "#D08A52",
  accentDim: "#9E6842",
  activity: "#C8834E",
  muted: "#77716C",
  success: "#7F9D7A",
  warning: "#B9955B",
  danger: "#BC706B",
  text: "default",
  user: "#D08A52",
  assistant: "default",
  thought: "#A58B6B",
  tool: "#7895A1",
  system: "#77716C",
} as const;

/** ANSI for pre-rendered transcript strings (Static / live text blobs). */
export const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  italic: "\u001b[3m",
  underline: "\u001b[4m",
  strike: "\u001b[9m",
  // Muted xterm-256 colors preserve hierarchy without turning the transcript into a rainbow.
  orange: "\u001b[38;5;172m",
  orangeBold: "\u001b[1m\u001b[38;5;172m",
  amber: "\u001b[38;5;179m",
  amberBold: "\u001b[1m\u001b[38;5;179m",
  gray: "\u001b[38;5;244m",
  tool: "\u001b[38;5;109m",
  toolBold: "\u001b[1m\u001b[38;5;109m",
  green: "\u001b[38;5;108m",
  greenBold: "\u001b[1m\u001b[38;5;108m",
  red: "\u001b[38;5;167m",
  redBold: "\u001b[1m\u001b[38;5;167m",
  yellow: "\u001b[38;5;179m",
} as const;

export function textStyle(fg: string = COLORS.text, extra: Pick<Widgets.Types.TStyle, "bold"> = {}): Widgets.Types.TStyle {
  return { ...transparentStyle(fg), ...extra } as Widgets.Types.TStyle;
}

export function lineStyle(fg = COLORS.muted): Widgets.Types.TStyle {
  return transparentStyle(fg) as Widgets.Types.TStyle;
}

export function horizontalRule(width: number, char = "─"): string {
  return char.repeat(Math.max(1, width));
}

export function borderStyle(fg = COLORS.muted): Widgets.Types.TStyle {
  return { ...transparentStyle(fg), border: { fg } } as Widgets.Types.TStyle;
}
