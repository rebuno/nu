import {
  getSelectListTheme,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type EditorTheme,
  KeybindingsManager,
  Loader,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// biome-ignore format: one row of the mark per line
const MARK = [
  "▄██▌    ▐██",
  " ▝██▖   ▝█▌",
  "  ▝█▙   ▟▛",
  "   ▜█▌ ▟▛",
  "    ██▄▘",
  "    ▝█▘",
];

// pi keeps its active theme on globalThis so every module loader shares it.
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

export const theme = () =>
  (globalThis as Record<symbol, unknown>)[THEME_KEY] as Theme;

export function setupUi() {
  initTheme("dark", false);
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.interrupt": {
        defaultKeys: "escape",
        description: "Stop the running turn",
      },
      "app.clear": { defaultKeys: "ctrl+c", description: "Detach" },
      "app.exit": { defaultKeys: "ctrl+d", description: "Detach" },
      "app.tools.expand": {
        defaultKeys: "ctrl+o",
        description: "Expand tool output",
      },
    }),
  );
}

export function editorTheme(): EditorTheme {
  return {
    borderColor: (text) => theme().fg("borderMuted", text),
    selectList: getSelectListTheme(),
  };
}

export function besideMark(lines: string[]) {
  const width = Math.max(...MARK.map(visibleWidth)) + 4;
  const top = Math.floor((MARK.length - lines.length) / 2);
  return MARK.map((mark, row) => {
    const text = lines[row - top];
    return text === undefined
      ? mark
      : `${mark}${" ".repeat(width - visibleWidth(mark))}${text}`;
  }).join("\n");
}

export class SplitLine implements Component {
  left = "";
  right = "";

  invalidate() {}

  render(width: number) {
    const right = truncateToWidth(this.right, Math.max(0, width - 2), "");
    const left = truncateToWidth(
      this.left,
      Math.max(0, width - visibleWidth(right) - 3),
    );
    const gap = Math.max(
      1,
      width - 2 - visibleWidth(left) - visibleWidth(right),
    );
    return [` ${left}${" ".repeat(gap)}${right} `];
  }
}

export class WorkingIndicator extends Loader {
  constructor(ui: TUI, message: string) {
    super(
      ui,
      (text) => theme().fg("accent", text),
      (text) => theme().fg("muted", text),
      message,
    );
  }

  renderInBorder(width: number) {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(
      line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(),
      width,
      "",
    );
  }

  renderSpinnerInBorder(width: number) {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }

  dispose() {
    this.stop();
  }
}
