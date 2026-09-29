import { useEffect, useState } from "react";

/**
 * The command under the pointer or the focus ring, for the status bar to say.
 *
 * Every action here names its command, and that is the product. It used to live
 * only in `title`, which a keyboard user never sees and a returning user never
 * thinks to wait for. The titles already carry it in one shape, the command on
 * the first line and "Shift-click to type it" further down, so this reads that
 * rather than asking each of two dozen buttons for a second copy: one delegated
 * listener, and a button that grows a title is covered without being touched.
 *
 * `typing` follows the Shift key while a command is showing, so the bar says
 * what the next click will do rather than what it usually does.
 */
export interface CommandHint {
  command: string;
  typing: boolean;
}

const SELECTOR = '[title*="Shift-click"]';

function commandOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(SELECTOR);
  const title = el?.getAttribute("title");
  if (!title) return null;
  // The first line is the command. A title that opens with a sentence instead
  // is a button whose command varies, and a sentence is not what goes here.
  const first = title.split("\n")[0].trim();
  return first.length > 0 && first.length <= 140 ? first : null;
}

export function useCommandHint(): CommandHint | null {
  const [command, setCommand] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const enter = (event: Event) => setCommand(commandOf(event.target));
    // Moving between two children of one button fires out and then over, so the
    // element being entered is checked before the bar is cleared.
    const leave = (event: Event) =>
      setCommand(commandOf((event as PointerEvent | FocusEvent).relatedTarget));
    const shift = (event: KeyboardEvent) => setTyping(event.shiftKey);
    document.addEventListener("pointerover", enter);
    document.addEventListener("focusin", enter);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusout", leave);
    document.addEventListener("keydown", shift);
    document.addEventListener("keyup", shift);
    const clearAll = () => setCommand(null);
    window.addEventListener("blur", clearAll);
    return () => {
      document.removeEventListener("pointerover", enter);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("keydown", shift);
      document.removeEventListener("keyup", shift);
      window.removeEventListener("blur", clearAll);
    };
  }, []);

  return command ? { command, typing } : null;
}
