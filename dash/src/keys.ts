// Keyboard shortcuts, in the "g then j" style that gmail and github trained
// everyone on. The dashboard is a thing you leave open and glance at, so
// getting between screens should not need the mouse.
import { useEffect, useState } from "preact/hooks";
import { navigate } from "./router.js";

const GOTO: Record<string, [string, string]> = {
  o: ["/", "Overview"],
  d: ["/devices", "Devices"],
  j: ["/jobs", "Jobs"],
  n: ["/jobs/new", "New job"],
  r: ["/results", "Results"],
  s: ["/schedules", "Schedules"],
  a: ["/artifacts", "Artifacts"],
  e: ["/events", "Events"],
  x: ["/alerts", "Alerts"],
  y: ["/system", "System"],
};

export const SHORTCUTS = [
  ...Object.entries(GOTO).map(([k, [, label]]) => ({ keys: `g ${k}`, does: label })),
  { keys: "/", does: "Focus the search box on this screen" },
  { keys: "?", does: "Show this help" },
  { keys: "Esc", does: "Close help, or leave the search box" },
];

/** True while a keystroke would go into a form field rather than the page. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export function useKeyboard(): { help: boolean; setHelp: (v: boolean) => void } {
  const [help, setHelp] = useState(false);

  useEffect(() => {
    // The 'g' prefix expires, so a stray g does not silently arm a jump
    // minutes later.
    let pending = false;
    let timer: number | undefined;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        if (typing(e.target)) (e.target as HTMLElement).blur();
        setHelp(false);
        return;
      }
      // Never steal a keystroke that was meant for a field.
      if (typing(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (e.key === "/") {
        const box = document.querySelector<HTMLInputElement>('input[type="search"]');
        if (box) {
          e.preventDefault();
          box.focus();
          box.select();
        }
        return;
      }
      if (pending) {
        pending = false;
        clearTimeout(timer);
        const target = GOTO[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          setHelp(false);
          navigate(target[0]);
        }
        return;
      }
      if (e.key === "g") {
        pending = true;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = false), 1500) as unknown as number;
      }
    };

    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, []);

  return { help, setHelp };
}
