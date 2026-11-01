import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real controller with just the DOM surface it uses; no browser or phone needed.
const source = readFileSync(new URL('./src/input.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { InputController } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
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
console.log('Viewer input check passed: keyboard isolation, native controls, portrait/landscape coordinates, multi-touch, and release.');
