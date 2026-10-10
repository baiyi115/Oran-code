/**
 * Terminal theme: muted citrus for focus, warm neutrals for dense content.
 *
 * To stay compatible with as many terminal environments as possible, the module picks one of
 * three modes from the environment at load time:
 * - mono: NO_COLOR is set (https://no-color.org); keeps non-color styles such as weight/italic;
 * - light: light background (detected via COLORFGBG or set explicitly with ORAN_THEME), using
 *   deeper shades of the same hues;
 * - dark: the default dark palette.
 * Explicit override precedence: NO_COLOR > ORAN_THEME > COLORFGBG > dark.
 */

export type ColorMode = "dark" | "light" | "mono";

export function resolveColorMode(env: Record<string, string | undefined> = process.env): ColorMode {
  if (env.NO_COLOR !== undefined) return "mono";
  const explicit = env.ORAN_THEME?.trim().toLowerCase();
  if (explicit === "light" || explicit === "dark" || explicit === "mono") return explicit;
  // COLORFGBG is "fg;bg": 16-color backgrounds 0-7 are dark, 8-15 light; unset or unknown is dark.
  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const bg = Number.parseInt(colorfgbg.split(";").pop() ?? "", 10);
    if (Number.isFinite(bg) && bg >= 8 && bg <= 15) return "light";
  }
  return "dark";
}

/** Semantic palette used by ink components. Fields may be undefined (inherit the terminal fg). */
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

/** Light background: same hues darkened so they stay readable on white. */
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

/** Mono: everything uses the terminal default foreground; hierarchy comes from font weight. */
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

/** Pre-rendered escape codes (Static / live text blobs). */
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
  // mono keeps the weight styles and blanks the color codes.
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
    // into a rainbow. Dark uses mid-bright tones; light switches to deeper 256-color hues.
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
