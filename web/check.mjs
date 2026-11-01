import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real controllers with just the DOM surface they use; no browser or phone needed.
const load = async (path) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const { InputController } = await load('./src/input.ts');
const { TextEntry, textToKeys, MAX_PASTE_CHARS } = await load('./src/text-entry.ts');
const listeners = new Map();
const frames = [];
const messages = [];
let modalOpen = false;
let rect = { left: 100, top: 50, width: 400, height: 225 };
class Element {
  constructor(tag = 'canvas') { this.tag = tag; }
  closest(selector) { return selector.split(',').map((s) => s.trim()).includes(this.tag) ? this : null; }
}
globalThis.Element = Element;
globalThis.document = { querySelector: () => modalOpen ? {} : null };
globalThis.window = {
  addEventListener: (name, handler) => listeners.set(name, handler),
  removeEventListener: (name) => listeners.delete(name),
  requestAnimationFrame: (handler) => { frames.push(handler); return frames.length; },
};
const surface = Object.assign(new Element(), {
  inert: false, style: {}, focus() {}, setPointerCapture() {},
  addEventListener: window.addEventListener, removeEventListener: window.removeEventListener,
  getBoundingClientRect: () => rect,
});
const controller = new InputController(surface, (message) => messages.push(message));
controller.attach();
const key = (value, target = surface, extra = {}) => listeners.get('keydown')({ key: value, target, preventDefault() {}, ...extra });
const flush = () => { for (const frame of frames.splice(0)) frame(); };

key('ArrowRight');
assert.equal(messages.pop().knob.x, 127);
key('Enter');
assert.equal(messages.pop().knob.select, true);
key(' ');
assert.deepEqual(messages.pop(), { type: 'media', media: 3 });
surface.inert = true;
key('s');
surface.inert = false;
modalOpen = true;
key('Escape');
modalOpen = false;
for (const tag of ['input', 'select', 'textarea', '[contenteditable="true"]']) key('ArrowUp', new Element(tag));
key('Enter', new Element('button'));
key(' ', new Element('a'));
key('s', surface, { ctrlKey: true });
key('s', surface, { defaultPrevented: true });
assert.equal(messages.length, 0, 'Settings, native controls, browser shortcuts, and disconnected screens must not send CarPlay commands');
key('ArrowLeft', new Element('button'));
assert.equal(messages.pop().knob.x, -127, 'Navigation still works after clicking a toolbar button');

const pointer = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, preventDefault() {} });
const idle = { x: 0, y: 0, down: false };
listeners.get('pointerdown')(pointer(1, 300, 162.5));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: true }, { id: 1, ...idle }]);
listeners.get('pointerup')(pointer(1, 0, 0));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: false }, { id: 1, ...idle }], 'A lifted finger releases at its last position, not at the event position');
listeners.get('pointerdown')(pointer(1, 300, 162.5));
rect = { left: 100, top: 50, width: 225, height: 400 };
listeners.get('pointermove')(pointer(1, 212.5, 250));
listeners.get('pointerdown')(pointer(2, 500, 0));
listeners.get('pointerdown')(pointer(3, 200, 100));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: true }, { id: 1, x: 1, y: 0, down: true }], 'A third finger is ignored');
listeners.get('pointerup')(pointer(1, 0, 0));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: false }, { id: 1, x: 1, y: 0, down: true }], 'Lifting the first finger keeps the second in its slot');
listeners.get('pointercancel')(pointer(2, 0, 0));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: .5, y: .5, down: false }, { id: 1, x: 1, y: 0, down: false }], 'A cancelled touch releases like a lift');
listeners.get('pointerdown')(pointer(4, 100, 50));
flush();
assert.deepEqual(messages.pop().contacts, [{ id: 0, x: 0, y: 0, down: true }, { id: 1, x: 1, y: 0, down: false }], 'A reused slot starts at its new finger');
listeners.get('pointerup')(pointer(4, 300, 300));
flush();
messages.length = 0;
controller.detach();
assert.equal(listeners.size, 0);

const keysFor = (text) => textToKeys(text).keys;
assert.deepEqual(textToKeys('ab1 0'), { keys: [0x04, 0x05, 0x1e, 0x2c, 0x27], skipped: [] }, 'Letters, digits and space map to plain key codes');
assert.deepEqual(keysFor('z9'), [0x1d, 0x26]);
assert.deepEqual(keysFor('São PRAÇA é'), keysFor('sao praca e'), 'Capitals become lowercase and accents are removed');
assert.deepEqual(keysFor("-=[]\\;'`,./"), [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38], 'Every unshifted punctuation key is typed');
assert.deepEqual(keysFor('a\r\nb\tc\nd\re'), keysFor('a b c d e'), 'Line breaks and tabs become one space, so a paste cannot submit itself');
assert.deepEqual(textToKeys('a@b!@😀ß'), { keys: [0x04, 0x05], skipped: ['@', '!', '😀', 'ß'] }, 'Anything else is skipped, once each and in order');
assert.deepEqual(textToKeys('a‍́️b'), { keys: [0x04, 0x05], skipped: [] }, 'Invisible characters are dropped without a report');
assert.deepEqual(keysFor('a  b'), keysFor('a b'), 'Spaces collapse, because iOS turns a double space into a period');
assert.deepEqual(keysFor('a\n\nb'), keysFor('a b'));
assert.deepEqual(keysFor('a @ b'), keysFor('a b'), 'A skipped character must not leave a double space behind');

class FakeElement extends Element {
  constructor(tag) { super(tag); this.handlers = new Map(); this.hidden = true; this.value = ''; this.textContent = ''; this.attributes = new Map(); this.focused = 0; }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  removeEventListener(name) { this.handlers.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.focused += 1; }
  fire(name, event = {}) { const full = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event }; this.handlers.get(name)(full); return full; }
}
const panel = new FakeElement('div');
const box = new FakeElement('input');
const note = new FakeElement('span');
const toggle = new FakeElement('button');
const screen = new FakeElement('canvas');
screen.inert = false;
const sent = [];
const entry = new TextEntry({ panel, input: box, note, toggle, surface: screen }, (message) => sent.push(message));
entry.attach();
const windowHandlers = listeners;
const typeInto = (text, event = {}) => { box.value = text; return box.fire('input', { isComposing: false, ...event }); };
const paste = (text, target = screen) => { const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, clipboardData: { getData: () => text } }; windowHandlers.get('paste')(event); return event; };

assert.equal(panel.hidden, true, 'The text box starts closed');
toggle.fire('click');
assert.equal(panel.hidden, false);
assert.equal(box.focused, 1, 'Opening the box focuses it');
assert.equal(toggle.attributes.get('aria-pressed'), 'true');

typeInto('é');
assert.deepEqual(sent.pop(), { type: 'keys', keys: [0x08] }, 'Typed text goes straight to CarPlay');
assert.equal(box.value, '', 'The box empties after sending');
typeInto('´', { isComposing: true });
assert.equal(sent.length, 0, 'A dead key waits for its composed character');
assert.equal(box.value, '´');
box.value = 'ã';
box.fire('compositionend');
assert.deepEqual(sent.pop(), { type: 'keys', keys: [0x04] }, 'The composed character is sent when composition ends');
assert.equal(box.value, '');

assert.equal(box.fire('keydown', { key: 'Backspace' }).defaultPrevented, true);
assert.deepEqual(sent.pop(), { type: 'keys', keys: [0x2a] });
assert.equal(box.fire('keydown', { key: 'Enter' }).defaultPrevented, true);
assert.deepEqual(sent.pop(), { type: 'keys', keys: [0x28] });
assert.equal(box.fire('keydown', { key: 'Backspace', isComposing: true }).defaultPrevented, false, 'Keys that belong to a composition stay in the box');
assert.equal(box.fire('keydown', { key: 'a' }).defaultPrevented, false, 'Ordinary keys arrive through the input event');
assert.equal(sent.length, 0);

typeInto('@');
assert.equal(sent.length, 0, 'Text with nothing typeable sends nothing');
assert.equal(note.textContent, 'Not typed: @');
assert.equal(note.hidden, false);
typeInto('a');
sent.pop();
assert.equal(note.hidden, true, 'The note clears once typing works again');

assert.equal(paste('Rua A, 1 @').defaultPrevented, true, 'Paste works anywhere in the viewer');
assert.deepEqual(sent.pop().keys, keysFor('rua a, 1 '));
assert.equal(note.textContent, 'Not typed: @');
assert.equal(paste('b', box).defaultPrevented, true, 'Paste works in the text box too');
assert.deepEqual(sent.pop().keys, keysFor('b'));
assert.equal(paste('c', new FakeElement('input')).defaultPrevented, false, 'Pasting into another field is left alone');
assert.equal(paste('c', new FakeElement('textarea')).defaultPrevented, false);
modalOpen = true;
assert.equal(paste('c').defaultPrevented, false, 'Pasting is ignored while a dialog is open');
modalOpen = false;
assert.equal(sent.length, 0);

paste('a'.repeat(MAX_PASTE_CHARS + 5));
assert.equal(sent.pop().keys.length, MAX_PASTE_CHARS, 'Long pastes are cut to the limit');
assert.match(note.textContent, /first 1,000 characters/);
paste('b');
sent.pop();

screen.inert = true;
assert.equal(paste('c').defaultPrevented, false, 'Nothing is sent with no live screen');
typeInto('c');
box.fire('keydown', { key: 'Enter' });
assert.equal(sent.length, 0);
assert.equal(box.value, '', 'Text typed with no live screen is discarded');
screen.inert = false;

const focusedBefore = screen.focused;
assert.equal(box.fire('keydown', { key: 'Escape' }).defaultPrevented, true);
assert.equal(panel.hidden, true, 'Esc closes the box');
assert.equal(screen.focused, focusedBefore + 1, 'Closing returns focus to the screen, so shortcuts work again');
assert.equal(toggle.attributes.get('aria-pressed'), 'false');
assert.equal(sent.length, 0);
toggle.fire('click');
toggle.fire('click');
assert.equal(panel.hidden, true, 'The button closes the box too');
const focusedWhenClosed = screen.focused;
entry.close();
assert.equal(screen.focused, focusedWhenClosed, 'Closing a closed box leaves focus alone, so a dropped session cannot pull focus from a panel');
paste('b');
assert.deepEqual(sent.pop().keys, keysFor('b'), 'Paste works with the box closed');
assert.equal(panel.hidden, true, 'A clean paste leaves the box closed');
paste('a@');
sent.pop();
assert.equal(panel.hidden, false, 'A paste that skipped something opens the box, so the note can be seen');
assert.equal(note.textContent, 'Not typed: @');
assert.equal(toggle.attributes.get('aria-pressed'), 'true');
entry.close();
entry.detach();
assert.equal(windowHandlers.has('paste'), false);
console.log('Viewer input check passed: keyboard isolation, native controls, portrait/landscape coordinates, multi-touch, release, text conversion, typing and paste.');
