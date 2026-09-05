/**
 * Terminal theme: muted citrus for focus, warm neutrals for dense content.
 *
 * 为尽可能兼容各类终端环境,模块加载时按环境做一次三选一:
 * - mono:NO_COLOR 已设置(https://no-color.org),只保留字重/斜体等非颜色样式;
 * - light:浅色背景(COLORFGBG 探测或 ORAN_THEME 显式指定),用更深的同系色调;
 * - dark:默认深色调色板。
 * 显式覆盖优先级:NO_COLOR > ORAN_THEME > COLORFGBG > dark。
 */

export type ColorMode = "dark" | "light" | "mono";

export function resolveColorMode(env: Record<string, string | undefined> = process.env): ColorMode {
  if (env.NO_COLOR !== undefined) return "mono";
  const explicit = env.ORAN_THEME?.trim().toLowerCase();
  if (explicit === "light" || explicit === "dark" || explicit === "mono") return explicit;
  // COLORFGBG 为 "fg;bg":16 色背景 0-7 深、8-15 浅;未设置或不认识的值一律按深色。
  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const bg = Number.parseInt(colorfgbg.split(";").pop() ?? "", 10);
    if (Number.isFinite(bg) && bg >= 8 && bg <= 15) return "light";
  }
  return "dark";
}

/** 语义层配色:ink 组件用。字段可为 undefined(继承终端默认前景色)。 */
export interface ThemePalette {
  accent: string | undefined;
  accentDim: string | undefined;
  activity: string | undefined;
  muted: string | undefined;
  success: string | undefined;
  warning: string | undefined;
  danger: string | undefined;
  text: string | undefined;
  user: string | undefined;
  assistant: string | undefined;
  thought: string | undefined;
  tool: string | undefined;
  system: string | undefined;
  surface: string | undefined;
}

const DARK_PALETTE: ThemePalette = {
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
  surface: undefined,
};

/** 浅色背景:同色相加深,保证白底可读。 */
const LIGHT_PALETTE: ThemePalette = {
  accent: "#A35B22",
  accentDim: "#7C4519",
  activity: "#9A5B26",
  muted: "#6A645E",
  success: "#4E7A48",
  warning: "#8A6A25",
  danger: "#A34B45",
  text: "default",
  user: "#A35B22",
  assistant: "default",
  thought: "#75604A",
  tool: "#3E6D82",
  system: "#6A645E",
  surface: undefined,
};

/** 单色:全部交给终端默认前景色,层级靠字重维持。 */
const MONO_PALETTE: ThemePalette = {
  accent: undefined,
  accentDim: undefined,
  activity: undefined,
  muted: undefined,
  success: undefined,
  warning: undefined,
  danger: undefined,
  text: "default",
  user: undefined,
  assistant: "default",
  thought: undefined,
  tool: undefined,
  system: undefined,
  surface: undefined,
};

/** 预渲染转义码(Static / live text blobs)。 */
export interface AnsiPalette {
  reset: string;
  bold: string;
  dim: string;
  italic: string;
  underline: string;
  strike: string;
  orange: string;
  orangeBold: string;
  amber: string;
  amberBold: string;
  gray: string;
  tool: string;
  toolBold: string;
  green: string;
  greenBold: string;
  red: string;
  redBold: string;
  yellow: string;
}

function ansiPalette(code: (n: number) => string, mode: ColorMode): AnsiPalette {
  // mono 保留字重样式,颜色码置空。
  if (mode === "mono") {
    return {
      reset: "\u001b[0m",
      bold: "\u001b[1m",
      dim: "\u001b[2m",
      italic: "\u001b[3m",
      underline: "\u001b[4m",
      strike: "\u001b[9m",
      orange: "",
      orangeBold: "\u001b[1m",
      amber: "",
      amberBold: "\u001b[1m",
      gray: "",
      tool: "",
      toolBold: "\u001b[1m",
      green: "",
      greenBold: "\u001b[1m",
      red: "",
      redBold: "\u001b[1m",
      yellow: "",
    };
  }
  const dark = mode === "dark";
  return {
    reset: "\u001b[0m",
    bold: "\u001b[1m",
    dim: "\u001b[2m",
    italic: "\u001b[3m",
    underline: "\u001b[4m",
    strike: "\u001b[9m",
    // Muted xterm-256 colors preserve hierarchy without turning the transcript
    // into a rainbow. 深色用中亮调,浅色切到同色相的深色 256 色。
    orange: code(dark ? 172 : 130),
    orangeBold: `\u001b[1m${code(dark ? 172 : 130)}`,
    amber: code(dark ? 179 : 136),
    amberBold: `\u001b[1m${code(dark ? 179 : 136)}`,
    gray: code(dark ? 244 : 240),
    tool: code(dark ? 109 : 66),
    toolBold: `\u001b[1m${code(dark ? 109 : 66)}`,
    green: code(dark ? 108 : 71),
    greenBold: `\u001b[1m${code(dark ? 108 : 71)}`,
    red: code(dark ? 167 : 131),
    redBold: `\u001b[1m${code(dark ? 167 : 131)}`,
    yellow: code(dark ? 179 : 136),
  };
}

const mode = resolveColorMode();

export const COLOR_MODE: ColorMode = mode;
export const COLORS: ThemePalette = mode === "light" ? LIGHT_PALETTE : mode === "mono" ? MONO_PALETTE : DARK_PALETTE;
export const ANSI: AnsiPalette = ansiPalette((n) => `\u001b[38;5;${n}m`, mode);

export function horizontalRule(width: number, char = "─"): string {
  return char.repeat(Math.max(1, width));
}

/** A dimmed horizontal rule for low-emphasis separators (overlay titles, etc.). */
export function dimHorizontalRule(width: number, char = "─"): string {
  return `${ANSI.dim}${horizontalRule(width, char)}${ANSI.reset}`;
}
