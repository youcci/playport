import type { ClientMessage } from './protocol';

export const MAX_PASTE_CHARS = 1000;

const MAX_NOTED_CHARS = 20;
const OTHER_FIELDS = 'input, select, textarea, [contenteditable="true"]';
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
  for (const char of text.replace(/\r\n|[\r\n\t\v\f\u0085\p{Z}]/gu, ' ')) {
    const plain = char.normalize('NFKD').replace(/\p{M}|\p{Cf}|\p{Cc}/gu, '').toLowerCase();
    const mapped = Array.from(plain, keyFor);
    if (mapped.some((key) => key === undefined) || (char !== ' ' && plain.includes(' '))) {
      skipped.add(char);
      continue;
    }
    for (const key of mapped as number[]) {
      // iOS turns a double space into a period.
      if (key !== KEY_SPACE || keys[keys.length - 1] !== KEY_SPACE) keys.push(key);
    }
  }
  return { keys, skipped: Array.from(skipped) };
}

/** The text box under the screen, plus paste anywhere in the viewer. */
export class TextEntry {
  private lastKey = 0;

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
    window.addEventListener('pointerup', this.onPointerUp);
  }

  detach(): void {
    const { input, toggle } = this.elements;
    toggle.removeEventListener('click', this.onToggle);
    input.removeEventListener('input', this.onInput);
    input.removeEventListener('compositionend', this.flushBox);
    input.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('paste', this.onPaste);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  close(): void {
    const { panel, input, note, toggle, surface } = this.elements;
    if (panel.hidden) return;
    panel.hidden = true;
    input.value = '';
    note.textContent = '';
    note.hidden = true;
    toggle.setAttribute('aria-pressed', 'false');
    surface.focus({ preventScroll: true });
    this.send({ type: 'keysCancel' });
  }

  private open(): void {
    const { panel, input, toggle } = this.elements;
    panel.hidden = false;
    toggle.setAttribute('aria-pressed', 'true');
    input.focus();
  }

  /** With a mouse, keeps typing in the box after a click; otherwise keys would fire CarPlay shortcuts. */
  private readonly onPointerUp = (event: PointerEvent): void => {
    const { panel, input } = this.elements;
    if (panel.hidden || event.pointerType === 'touch') return;
    if (document.querySelector('dialog[open]') || this.isOtherField(event.target)) return;
    input.focus({ preventScroll: true });
  };

  private isOtherField(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const field = target.closest(OTHER_FIELDS);
    return field !== null && field !== this.elements.input && (field as HTMLInputElement).type !== 'range';
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
    if (event.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case 'Backspace':
        event.preventDefault();
        this.sendKeys([KEY_BACKSPACE]);
        break;
      case 'Enter':
        event.preventDefault();
        if (!event.repeat) this.sendKeys([KEY_ENTER]);
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
    if (this.elements.surface.inert || document.querySelector('dialog[open]') || this.isOtherField(event.target)) return;
    const text = event.clipboardData?.getData('text') ?? '';
    if (!text) return;
    event.preventDefault();
    this.open();
    this.typeText(text);
  };

  private typeText(text: string): void {
    const chars = Array.from(text);
    const { keys, skipped } = textToKeys(chars.slice(0, MAX_PASTE_CHARS).join(''));
    this.sendKeys(keys);
    const parts: string[] = [];
    if (chars.length > MAX_PASTE_CHARS) parts.push(`Only the first ${MAX_PASTE_CHARS.toLocaleString('en-US')} characters were typed.`);
    if (skipped.length > 0) {
      const more = skipped.length - MAX_NOTED_CHARS;
      parts.push(`Not typed: ${skipped.slice(0, MAX_NOTED_CHARS).join(' ')}${more > 0 ? ` and ${more} more` : ''}`);
    }
    const { note } = this.elements;
    note.textContent = parts.join(' ');
    note.hidden = parts.length === 0;
  }

  private sendKeys(keys: number[]): void {
    if (this.elements.surface.inert) return;
    // iOS turns a double space into a period, and these keys may follow an earlier send.
    const fresh = keys[0] === KEY_SPACE && this.lastKey === KEY_SPACE ? keys.slice(1) : keys;
    if (fresh.length === 0) return;
    this.lastKey = fresh[fresh.length - 1];
    this.send({ type: 'keys', keys: fresh });
  }
}
