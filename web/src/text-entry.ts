import type { ClientMessage } from './protocol';

export const MAX_PASTE_CHARS = 1000;

const KEY_ENTER = 0x28;
const KEY_BACKSPACE = 0x2a;
const KEY_SPACE = 0x2c;
const PUNCTUATION_KEYS: Readonly<Record<string, number>> = {
  '-': 0x2d,
  '=': 0x2e,
  '[': 0x2f,
  ']': 0x30,
  '\\': 0x31,
  ';': 0x33,
  "'": 0x34,
  '`': 0x35,
  ',': 0x36,
  '.': 0x37,
  '/': 0x38,
};

export interface TextKeys {
  keys: number[];
  skipped: string[];
}

export interface TextEntryElements {
  panel: HTMLElement;
  input: HTMLInputElement;
  note: HTMLElement;
  toggle: HTMLElement;
  surface: HTMLElement;
}

function keyFor(char: string): number | undefined {
  if (char >= 'a' && char <= 'z') return 0x04 + char.charCodeAt(0) - 'a'.charCodeAt(0);
  if (char >= '1' && char <= '9') return 0x1e + char.charCodeAt(0) - '1'.charCodeAt(0);
  if (char === '0') return 0x27;
  if (char === ' ') return KEY_SPACE;
  return PUNCTUATION_KEYS[char];
}

/**
 * Converts text to plain key codes. iOS keeps Shift and Option held after their release, so capitals
 * become lowercase, accents are removed and anything else that needs a modifier is skipped.
 */
export function textToKeys(text: string): TextKeys {
  const keys: number[] = [];
  const skipped = new Set<string>();
  for (const char of text.replace(/\r\n?|\n|\t/g, ' ')) {
    const plain = char.normalize('NFD').replace(/\p{M}|\p{Cf}|\p{Cc}/gu, '').toLowerCase();
    const mapped = Array.from(plain, keyFor);
    if (mapped.every((key) => key !== undefined)) keys.push(...(mapped as number[]));
    else skipped.add(char);
  }
  return { keys, skipped: Array.from(skipped) };
}

/** The text box under the screen, plus paste anywhere in the viewer. */
export class TextEntry {
  constructor(
    private readonly elements: TextEntryElements,
    private readonly send: (message: ClientMessage) => void,
  ) {}

  attach(): void {
    const { input, toggle } = this.elements;
    toggle.addEventListener('click', this.onToggle);
    input.addEventListener('input', this.onInput);
    input.addEventListener('compositionend', this.flushBox);
    input.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('paste', this.onPaste);
  }

  detach(): void {
    const { input, toggle } = this.elements;
    toggle.removeEventListener('click', this.onToggle);
    input.removeEventListener('input', this.onInput);
    input.removeEventListener('compositionend', this.flushBox);
    input.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('paste', this.onPaste);
  }

  close(): void {
    const { panel, input, toggle, surface } = this.elements;
    if (panel.hidden) return;
    panel.hidden = true;
    input.value = '';
    toggle.setAttribute('aria-pressed', 'false');
    surface.focus({ preventScroll: true });
  }

  private open(): void {
    const { panel, input, toggle } = this.elements;
    panel.hidden = false;
    toggle.setAttribute('aria-pressed', 'true');
    input.focus();
  }

  private readonly onToggle = (): void => {
    if (this.elements.panel.hidden) this.open();
    else this.close();
  };

  private readonly onInput = (event: Event): void => {
    if (!(event as InputEvent).isComposing) this.flushBox();
  };

  private readonly flushBox = (): void => {
    const { input } = this.elements;
    const text = input.value;
    input.value = '';
    if (text) this.typeText(text);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    switch (event.key) {
      case 'Backspace':
        event.preventDefault();
        this.sendKeys([KEY_BACKSPACE]);
        break;
      case 'Enter':
        event.preventDefault();
        this.sendKeys([KEY_ENTER]);
        break;
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      default:
        break;
    }
  };

  private readonly onPaste = (event: ClipboardEvent): void => {
    const { input, surface } = this.elements;
    if (surface.inert || document.querySelector('dialog[open]')) return;
    const target = event.target;
    if (target !== input && target instanceof Element && target.closest('input, select, textarea, [contenteditable="true"]')) return;
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text) return;
    event.preventDefault();
    const chars = Array.from(text);
    this.typeText(chars.slice(0, MAX_PASTE_CHARS).join(''), chars.length > MAX_PASTE_CHARS);
  };

  private typeText(text: string, cut = false): void {
    const { keys, skipped } = textToKeys(text);
    this.sendKeys(keys);
    const parts: string[] = [];
    if (cut) parts.push(`Only the first ${MAX_PASTE_CHARS.toLocaleString('en-US')} characters were typed.`);
    if (skipped.length > 0) parts.push(`Not typed: ${skipped.join(' ')}`);
    const { note } = this.elements;
    note.textContent = parts.join(' ');
    note.hidden = parts.length === 0;
  }

  private sendKeys(keys: number[]): void {
    if (keys.length > 0 && !this.elements.surface.inert) this.send({ type: 'keys', keys });
  }
}
