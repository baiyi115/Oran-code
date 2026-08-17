export const KEYBINDINGS = {
  cancel: "C-c",
  closeOverlay: "escape",
  submit: "enter",
  moveUp: "up",
  moveDown: "down",
  moveLeft: "left",
  moveRight: "right",
  moveToStart: "home",
  moveToEnd: "end",
  deleteBackward: "backspace",
  deleteForward: "delete",
  switchOverlaySelectionForward: "tab",
  followUpQueue: "C-q",
  deleteSession: "C-d",
  insertNewline: ["S-enter", "C-j"],
  toggleTool: "C-t",
  switchPermissionMode: "tab",
  switchWorkMode: "tab",
  switchReasoningEffort: "S-tab",
} as const;

export interface KeyBindingEvent {
  name?: string;
  full?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export function matchesKey(key: KeyBindingEvent, binding: string): boolean {
  const [modifier, value] = binding.includes("-") ? binding.split(/-(.+)/, 2) : ["", binding];
  const name = key.name ?? "";
  const full = key.full ?? "";
  if (binding === full || binding === name) return true;
  if (modifier === "C") return Boolean(key.ctrl) && (name === value || full === binding);
  if (modifier === "S") return Boolean(key.shift) && (name === value || full === binding);
  if (modifier === "M") return Boolean(key.meta) && (name === value || full === binding);
  return false;
}

export function matchesAnyKey(key: KeyBindingEvent, bindings: readonly string[]): boolean {
  return bindings.some((binding) => matchesKey(key, binding));
}
