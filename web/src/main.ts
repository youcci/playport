import { AudioEngine } from './audio';
import { InputController } from './input';
import { TextEntry } from './text-entry';
import { MicrophoneUplink } from './mic';
import type { ServerMessage, WireMessage } from './protocol';
import { VideoPlayer } from './video';
import { Connection, type ConnectionState } from './ws';

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} element`);
  return element as T;
}

function resolveToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem('playport-token', fromUrl);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.toString());
    return fromUrl;
  }
  return localStorage.getItem('playport-token') ?? '';
}

const canvas = requiredElement<HTMLCanvasElement>('screen');
const surface = requiredElement<HTMLDivElement>('surface');
const statusDot = requiredElement<HTMLSpanElement>('status-dot');
const statusText = requiredElement<HTMLSpanElement>('status-text');
const overlay = requiredElement<HTMLDivElement>('overlay');
const overlayText = requiredElement<HTMLParagraphElement>('overlay-text');
const errorBanner = requiredElement<HTMLDivElement>('error-banner');
const streamInfo = requiredElement<HTMLSpanElement>('stream-info');
const micStatus = requiredElement<HTMLSpanElement>('mic-status');
const muteButton = requiredElement<HTMLButtonElement>('btn-mute');
const app = requiredElement<HTMLDivElement>('app');
const screenContainer = requiredElement<HTMLDivElement>('screen-container');
const viewerState = requiredElement<HTMLSpanElement>('viewer-state');
const overlayTitle = requiredElement<HTMLHeadingElement>('overlay-title');
const overlayEyebrow = requiredElement<HTMLParagraphElement>('overlay-eyebrow');
const audioMaster = requiredElement<HTMLInputElement>('audio-master');
const quickVolume = requiredElement<HTMLInputElement>('volume-quick');
let sessionActive = false;
let muted = false;

function fitScreen(): void {
  const scale = Math.min(screenContainer.clientWidth / canvas.width, screenContainer.clientHeight / canvas.height);
  surface.style.width = `${canvas.width * scale}px`;
  surface.style.height = `${canvas.height * scale}px`;
}

new ResizeObserver(fitScreen).observe(screenContainer);

let audioUnlocked = false;
let framesPainted = 0;
let framesReceived = 0;
let bytesReceived = 0;
let lastFrameArrival = 0;
let latencySampleMs = 0;
let streamWidth = 0;
let streamHeight = 0;

const video = new VideoPlayer(
  canvas,
  (message) => showError(message),
  () => {
    if (!video.isConfigured || !sessionActive) return;
    framesPainted += 1;
    const now = performance.now();
    if (lastFrameArrival > 0) latencySampleMs = Math.max(0, now - lastFrameArrival);
    overlay.classList.add('hidden');
    app.dataset.session = 'live';
    viewerState.textContent = 'LIVE';
  },
  () => connection.send({ type: 'keyframe' }),
  (width, height) => {
    streamWidth = width;
    streamHeight = height;
    fitScreen();
  },
);

const microphone = new MicrophoneUplink(
  (payload, opus) => {
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = opus ? 0x11 : 0x10;
    frame.set(payload, 1);
    connection.sendBinary(frame);
  },
  (message) => {
    micStatus.textContent = message;
  },
);

const audio = new AudioEngine((message) => showError(message));

const token = resolveToken();
const connection = new Connection(token, {
  onWire: (message: WireMessage) => {
    switch (message.kind) {
      case 'video-config':
        video.configure(message);
        break;
      case 'video-frame':
        framesReceived += 1;
        lastFrameArrival = performance.now();
        video.pushFrame(message);
        break;
      case 'audio-config':
        audio.handleConfig(message);
        break;
      case 'audio-packet':
        audio.handlePacket(message);
        break;
      case 'audio-stopped':
        audio.stopStream(message.streamType);
        break;
      case 'screen-active':
        break;
    }
  },
  onServer: (message: ServerMessage) => applyServerState(message),
  onState: (state: ConnectionState) => applyConnectionState(state),
  onBytes: (count) => {
    bytesReceived += count;
  },
});

const input = new InputController(canvas, (message) => connection.send(message));
input.attach();
const textEntry = new TextEntry(
  {
    panel: requiredElement('text-entry'),
    input: requiredElement<HTMLInputElement>('text-entry-input'),
    note: requiredElement('text-entry-note'),
    toggle: requiredElement('btn-keyboard'),
    surface: canvas,
  },
  (message) => connection.send(message),
);
textEntry.attach();

function resetSession(): void {
  sessionActive = false;
  app.dataset.session = 'idle';
  textEntry.close();
  canvas.inert = true;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-remote]')) button.disabled = true;
  video.close();
  audio.stopAll();
  void microphone.stop();
  micStatus.textContent = '';
  streamWidth = streamHeight = framesReceived = framesPainted = bytesReceived = lastFrameArrival = latencySampleMs = 0;
  streamInfo.textContent = 'Waiting for a video stream';
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  overlay.classList.remove('hidden');
}

function applyServerState(message: ServerMessage): void {
  switch (message.type) {
    case 'mic': {
      if (message.micActive === true) {
        void microphone.start({
          sampleRate: message.micRate ?? 16_000,
          channels: message.micChannels ?? 1,
          codec: message.micCodec ?? 'lpcm',
          samplesPerPacket: message.micSamplesPerPacket ?? 320,
          bitrate: message.micBitrate ?? null,
        });
      } else {
        void microphone.stop();
        micStatus.textContent = '';
      }
      break;
    }
    case 'hello':
    case 'session': {
      const device = message.deviceName ?? 'PlayPort';
      const phone = message.message ?? null;
      const active = message.sessionActive === true;
      setStatus(active ? 'live' : 'idle', active ? `${phone ?? 'iPhone'} connected` : `${device} ready`);
      requiredElement('device-name').textContent = active ? (phone ?? 'iPhone') : device;
      if (!active) {
        resetSession();
        viewerState.textContent = 'STANDBY';
        setOverlay('Your next drive starts here.', 'Connect your iPhone to PlayPort to bring CarPlay to this screen.');
      } else {
        if (!sessionActive) {
          viewerState.textContent = 'STARTING';
          app.dataset.session = 'connected';
          setOverlay('You’re connected.', 'Getting the first picture from your iPhone. CarPlay will appear in a moment.', 'ALMOST THERE');
        }
        sessionActive = true;
        canvas.inert = false;
        for (const button of document.querySelectorAll<HTMLButtonElement>('[data-remote]')) button.disabled = false;
      }
      break;
    }
    default:
      break;
  }
}

function applyConnectionState(state: ConnectionState): void {
  switch (state) {
    case 'connecting':
      setStatus('idle', 'Connecting…');
      viewerState.textContent = 'CONNECTING';
      setOverlay('Finding your PlayPort.', 'Connecting to the server. Your screen will be ready in a moment.', 'CONNECTING');
      break;
    case 'open':
      setStatus('idle', 'Server connected');
      break;
    case 'closed':
      resetSession();
      setStatus('idle', 'Reconnecting…');
      viewerState.textContent = 'RECONNECTING';
      setOverlay('Let’s get you back.', 'The server connection was interrupted. We’ll reconnect automatically.', 'RECONNECTING');
      break;
  }
}

function setStatus(kind: 'live' | 'idle', text: string): void {
  statusDot.dataset.state = kind;
  statusText.textContent = text;
}

function setOverlay(title: string, text: string, eyebrow = 'READY WHEN YOU ARE'): void {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  overlayEyebrow.textContent = eyebrow;
}

function showError(message: string): void {
  if (!message) {
    errorBanner.classList.add('hidden');
    requiredElement('error-text').textContent = '';
    return;
  }
  requiredElement('error-text').textContent = message;
  errorBanner.classList.remove('hidden');
}

function sendMedia(index: number): void {
  connection.send({ type: 'media', media: index });
}

function clickButton(id: string, handler: () => void): void {
  requiredElement<HTMLButtonElement>(id).addEventListener('click', (event) => {
    event.preventDefault();
    handler();
  });
}

clickButton('btn-home', () => connection.send({ type: 'knob', knob: { select: false, home: true, back: false, x: 0, y: 0, wheel: 0 } }));
clickButton('btn-back', () => connection.send({ type: 'knob', knob: { select: false, home: false, back: true, x: 0, y: 0, wheel: 0 } }));
clickButton('btn-select', () => connection.send({ type: 'knob', knob: { select: true, home: false, back: false, x: 0, y: 0, wheel: 0 } }));
clickButton('btn-siri', () => connection.send({ type: 'siri' }));
clickButton('btn-prev', () => sendMedia(5));
clickButton('btn-play', () => sendMedia(3));
clickButton('btn-next', () => sendMedia(4));
clickButton('btn-keyframe', () => {
  connection.send({ type: 'keyframe' });
  toast('Requested a fresh video frame');
});
clickButton('btn-fullscreen', () => void toggleFullscreen());

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('Fullscreen is unavailable in this browser. Try focus mode.');
  } catch {
    toast('Could not enter fullscreen. Try focus mode.');
  }
}

document.addEventListener('fullscreenchange', () => {
  requiredElement('btn-fullscreen').setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen');
});

let toastTimer = 0;
function toast(message: string): void {
  const element = requiredElement('toast');
  element.textContent = message;
  element.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { element.hidden = true; }, 2800);
}

function toggleFocus(): void {
  const focused = app.classList.toggle('focus-mode');
  requiredElement('btn-focus').setAttribute('aria-pressed', String(focused));
  requiredElement('btn-exit-focus').hidden = !focused;
  requiredElement<HTMLButtonElement>(focused ? 'btn-exit-focus' : 'btn-focus').focus();
}
clickButton('btn-focus', toggleFocus);
clickButton('btn-exit-focus', toggleFocus);
clickButton('btn-error-close', () => showError(''));
clickButton('btn-viewer', () => canvas.focus());

muteButton.addEventListener('click', () => {
  muted = !muted;
  updateMasterVolume();
});

async function unlockAudio(): Promise<void> {
  if (audioUnlocked) return;
  try {
    await audio.unlock();
    audioUnlocked = true;
    requiredElement('audio-unlock-hint').hidden = true;
  } catch {
    // The next gesture retries.
  }
}

window.addEventListener('pointerdown', () => void unlockAudio(), { once: false });
window.addEventListener('keydown', () => void unlockAudio(), { once: false });

if (!token) {
  setStatus('idle', 'Access link needed');
  viewerState.textContent = 'SETUP';
  setOverlay('Your personal link is the key.', 'Open the viewer link printed by the PlayPort server. It includes the access token needed to connect.', 'ONE MORE STEP');
}

if (typeof VideoDecoder === 'undefined') {
  showError(
    'Video decoding needs WebCodecs, which browsers only expose in a secure context. ' +
      'Open the https:// URL printed by the server (accept the self-signed certificate warning once), ' +
      'not the plain http:// LAN address.',
  );
}

if (token) connection.connect();

// --- Display panel: resolution, orientation and CarPlay UI size ---

interface DisplayPreset {
  label: string;
  width: number;
  height: number;
  orientation: string;
}

interface DisplayInfo {
  width: number;
  height: number;
  fps: number;
  uiScale: number;
  hevc: boolean;
  orientation: string;
  presets: DisplayPreset[];
}

const displayPanel = requiredElement<HTMLDialogElement>('display-panel');
const displayPresets = requiredElement<HTMLDivElement>('display-presets');
const displayWidthInput = requiredElement<HTMLInputElement>('display-width');
const displayHeightInput = requiredElement<HTMLInputElement>('display-height');
const displayUiScale = requiredElement<HTMLSelectElement>('display-uiscale');
const displayCodec = requiredElement<HTMLSelectElement>('display-codec');
const displayFps = requiredElement<HTMLSelectElement>('display-fps');
const displayStatus = requiredElement<HTMLParagraphElement>('display-status');
const displayApply = requiredElement<HTMLButtonElement>('btn-display-apply');
const displayForm = requiredElement<HTMLFormElement>('display-form');
const displayFields = requiredElement<HTMLFieldSetElement>('display-fields');

let hevcSupported = false;

async function probeHevcSupport(): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined') return false;
  const probes = ['hvc1.1.6.L120.B0', 'hvc1.1.6.L93.B0', 'hvc1.1.6.L120.90', 'hvc1.2.4.L120.B0'];
  for (const codec of probes) {
    try {
      const support = await VideoDecoder.isConfigSupported({ codec });
      if (support.supported) return true;
    } catch {
      // Try the next probe.
    }
  }
  return false;
}

function renderPresets(presets: DisplayPreset[]): void {
  displayPresets.replaceChildren();
  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.width = String(preset.width);
    button.dataset.height = String(preset.height);
    button.setAttribute('aria-pressed', 'false');
    const shape = document.createElement('span');
    shape.className = `preset-screen ${preset.height > preset.width ? 'portrait' : preset.width / preset.height > 2 ? 'ultrawide' : ''}`;
    shape.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'preset-copy';
    copy.textContent = `${preset.width} × ${preset.height}`;
    const orientation = document.createElement('small');
    orientation.textContent = preset.height > preset.width ? 'Portrait' : preset.width / preset.height > 2 ? 'Ultrawide' : 'Landscape';
    copy.append(orientation);
    button.append(shape, copy);
    button.addEventListener('click', () => {
      displayWidthInput.value = String(preset.width);
      displayHeightInput.value = String(preset.height);
      selectMatchingPreset();
    });
    displayPresets.append(button);
  }
}

function selectMatchingPreset(): void {
  for (const button of displayPresets.querySelectorAll('button')) {
    const selected = button.dataset.width === displayWidthInput.value && button.dataset.height === displayHeightInput.value;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}
displayWidthInput.addEventListener('input', selectMatchingPreset);
displayHeightInput.addEventListener('input', selectMatchingPreset);

async function refreshDisplayInfo(): Promise<void> {
  displayFields.disabled = true;
  displayApply.disabled = true;
  displayStatus.dataset.error = 'false';
  displayStatus.textContent = 'Loading your display settings…';
  try {
    const response = await fetch('/api/display');
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const info = (await response.json()) as DisplayInfo;
    renderPresets(info.presets);
    displayUiScale.value = String(info.uiScale);
    displayWidthInput.value = String(info.width);
    displayHeightInput.value = String(info.height);
    displayFps.value = String(info.fps);
    displayCodec.value = info.hevc ? 'h265' : 'h264';
    selectMatchingPreset();
    hevcSupported = await probeHevcSupport();
    const hevcOption = displayCodec.querySelector('option[value="h265"]') as HTMLOptionElement | null;
    if (hevcOption) {
      hevcOption.disabled = !hevcSupported;
      hevcOption.textContent = hevcSupported
        ? 'H.265 / HEVC (sharper)'
        : 'H.265 / HEVC (unavailable in this browser)';
    }
    if (!hevcSupported && info.hevc) displayCodec.value = 'h264';
    displayFields.disabled = false;
    displayApply.disabled = !token;
    displayStatus.textContent =
      `Current: ${info.width}×${info.height} @ ${info.fps} fps (${info.orientation}), ` +
      `${info.hevc ? 'HEVC' : 'H.264'}, UI size ${info.uiScale}%`;
  } catch {
    displayStatus.dataset.error = 'true';
    displayStatus.textContent = 'Could not load settings. Check the server connection, then reopen Display.';
  }
}

async function applyDisplay(): Promise<void> {
  const width = Number(displayWidthInput.value);
  const height = Number(displayHeightInput.value);
  const uiScale = Number(displayUiScale.value);
  const fps = Number(displayFps.value);
  const hevc = displayCodec.value === 'h265';
  if (!token || displayApply.disabled || !displayForm.reportValidity()) return;
  displayApply.disabled = true;
  displayFields.disabled = true;
  displayStatus.dataset.error = 'false';
  displayStatus.textContent = 'Applying…';
  try {
    const response = await fetch(`/api/display?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height, fps, uiScale, hevc }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    displayStatus.dataset.error = String(!response.ok || !body.ok);
    displayStatus.textContent =
      response.ok && body.ok
        ? 'Applied. CarPlay is restarting — video returns in a few seconds.'
        : (body.error ?? `Request failed (${response.status})`);
  } catch (error) {
    displayStatus.dataset.error = 'true';
    displayStatus.textContent = `Request failed: ${String(error)}`;
  } finally {
    displayApply.disabled = false;
    displayFields.disabled = false;
  }
}

clickButton('btn-display', () => {
  displayPanel.showModal();
  void refreshDisplayInfo();
});
clickButton('btn-display-close', () => displayPanel.close());
clickButton('btn-display-match', () => {
  const ratio = window.devicePixelRatio || 1;
  const even = (value: number) => Math.max(480, Math.min(3840, Math.round((value * ratio) / 2) * 2));
  displayWidthInput.value = String(even(window.innerWidth));
  displayHeightInput.value = String(even(window.innerHeight));
  displayStatus.textContent =
    `Window physical pixels: ${displayWidthInput.value}×${displayHeightInput.value} (devicePixelRatio ${ratio}). ` +
    'Put the browser in fullscreen first for a 1:1 mapping.';
  selectMatchingPreset();
});
displayForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void applyDisplay();
});

// --- Stream statistics HUD ---

let statsTick = performance.now();

function updateStats(): void {
  const now = performance.now();
  const elapsedSeconds = Math.max(0.001, (now - statsTick) / 1000);
  statsTick = now;
  const fps = framesPainted / elapsedSeconds;
  const mbps = (bytesReceived * 8) / 1_000_000 / elapsedSeconds;
  const dropped = Math.max(0, framesReceived - framesPainted);
  const queue = video.decodeQueueSize;
  const latency = latencySampleMs;
  framesPainted = 0;
  framesReceived = 0;
  bytesReceived = 0;
  if (streamWidth === 0) {
    streamInfo.textContent = 'Waiting for a video stream';
    return;
  }
  const parts = [`${streamWidth} × ${streamHeight}`];
  parts.push(`${fps.toFixed(0)} fps`);
  parts.push(`${mbps.toFixed(1)} Mbps`);
  if (dropped > 0) parts.push(`${dropped} dropped`);
  if (queue > 2) parts.push(`queue ${queue}`);
  if (latency > 0 && latency < 1000) parts.push(`decode ~${latency.toFixed(0)} ms`);
  streamInfo.textContent = parts.join(' · ');
}

window.setInterval(updateStats, 500);

// --- Call / night controls ---

clickButton('btn-answer', () => connection.send({ type: 'telephony', telephony: 1 }));
clickButton('btn-call-mute', () => connection.send({ type: 'telephony', telephony: 2 }));

let nightMode = false;
clickButton('btn-night', () => {
  nightMode = !nightMode;
  connection.send({ type: 'night', night: nightMode });
  requiredElement<HTMLButtonElement>('btn-night').dataset.active = nightMode ? 'true' : 'false';
  requiredElement('btn-night').setAttribute('aria-pressed', String(nightMode));
  toast(`CarPlay ${nightMode ? 'night' : 'day'} mode requested`);
});

// --- Audio mixer ---

const audioPanel = requiredElement<HTMLDialogElement>('audio-panel');
const audioStreams = requiredElement<HTMLDivElement>('audio-streams');
const audioStatus = requiredElement<HTMLParagraphElement>('audio-status');

const savedMaster = Number(localStorage.getItem('playport-master') ?? '100');
audioMaster.value = String(Number.isFinite(savedMaster) ? savedMaster : 100);
updateMasterVolume();

function updateMasterVolume(): void {
  audio.setVolume(muted ? 0 : Number(audioMaster.value) / 100);
  quickVolume.value = audioMaster.value;
  requiredElement('volume-value').textContent = muted ? 'Muted' : `${audioMaster.value}%`;
  requiredElement('audio-master-value').textContent = muted ? `${audioMaster.value}% · Muted` : `${audioMaster.value}%`;
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButton.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
  muteButton.title = muted ? 'Unmute audio' : 'Mute audio';
  document.getElementById('mute-icon')?.setAttribute('href', muted ? '#i-mute' : '#i-audio');
}

audioMaster.addEventListener('input', () => {
  muted = false;
  updateMasterVolume();
  localStorage.setItem('playport-master', String(audioMaster.value));
});
quickVolume.addEventListener('input', () => {
  audioMaster.value = quickVolume.value;
  audioMaster.dispatchEvent(new Event('input'));
});

function streamGainKey(name: string): string {
  return `playport-gain-${name}`;
}

function ensureStreamSliders(): void {
  const names = audio.activeStreamNames();
  const existing = new Set(
    Array.from(audioStreams.querySelectorAll<HTMLElement>('[data-stream]'), (element) => element.dataset.stream ?? ''),
  );
  if (names.length === 0) {
    audioStatus.textContent = 'No audio playing yet. Start music, navigation, or a call on your iPhone to mix its volume here.';
  } else {
    audioStatus.textContent = '';
  }
  if (names.length === existing.size && names.every((name) => existing.has(name))) return;
  audioStreams.replaceChildren();
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'audio-stream-row';
    row.dataset.stream = name;
    const label = document.createElement('label');
    label.textContent = name;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.id = `audio-stream-${audioStreams.childElementCount}`;
    label.htmlFor = slider.id;
    const output = document.createElement('output');
    output.htmlFor = slider.id;
    const stored = Number(localStorage.getItem(streamGainKey(name)) ?? '100');
    slider.value = String(Number.isFinite(stored) ? stored : 100);
    output.textContent = `${slider.value}%`;
    audio.setStreamGain(name, Number(slider.value) / 100);
    slider.addEventListener('input', () => {
      audio.setStreamGain(name, Number(slider.value) / 100);
      localStorage.setItem(streamGainKey(name), slider.value);
      output.textContent = `${slider.value}%`;
    });
    row.append(label, output, slider);
    audioStreams.append(row);
  }
}

window.setInterval(ensureStreamSliders, 1000);

clickButton('btn-audio', () => {
  audioPanel.showModal();
  ensureStreamSliders();
});
clickButton('btn-audio-close', () => audioPanel.close());

const helpPanel = requiredElement<HTMLDialogElement>('help-panel');
clickButton('btn-help', () => helpPanel.showModal());
clickButton('btn-setup', () => helpPanel.showModal());
clickButton('btn-help-close', () => helpPanel.close());

for (const [panel, trigger] of [[displayPanel, 'btn-display'], [audioPanel, 'btn-audio'], [helpPanel, 'btn-help']] as const) {
  panel.addEventListener('click', (event) => {
    const rect = panel.getBoundingClientRect();
    if (event.target === panel && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) panel.close();
  });
  panel.addEventListener('close', () => requiredElement(trigger).classList.remove('active'));
  requiredElement(trigger).addEventListener('click', () => requiredElement(trigger).classList.add('active'));
}

if (!('mediaDevices' in navigator)) {
  micStatus.textContent = '';
}
