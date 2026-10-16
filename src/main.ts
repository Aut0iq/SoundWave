import './style.css';
import { AudioIO } from './audio/audioIO';
import { Listener, Performer, Triggers, type LiveFrame } from './audio/live';
import { encodeWav, Player, Recorder, renderMix, TunedCache } from './audio/studio';
import { getInstrument, INSTRUMENTS, playableInstrument } from './audio/instruments';
import { DRUM_SOUNDS, playDrum } from './audio/instruments/drums';
import { MidiOut } from './midi/midiOut';
import { writeMidiFile, type MidiFileTrack } from './midi/midiFile';
import { CHORD_TYPES, detectKey, VOICINGS } from './dsp/harmony';
import { freqToMidi, NOTE_NAMES, NOTE_NAMES_RU, noteName, noteNameRu, SCALES } from './dsp/music';
import { newNoteId } from './dsp/noteTracker';
import type { AutotuneParams } from './dsp/autotune';
import { currentMask, loadSettings, saveSettings, type Settings } from './state/settings';
import {
  cleanupNotes,
  newTrack,
  PLAY_MODES,
  QUANTIZE_GRIDS,
  quantizeNotes,
  snapNotesToScale,
  transposeNotes,
  type PlayMode,
  type Project,
  type Track,
} from './state/project';
import { loadProject, saveProject } from './state/storage';
import { NoteCapture } from './state/capture';
import { bridge, FL_CC, FL_CHANNEL, FlSync } from './fl/flLink';
import { Keyboard } from './ui/keyboard';
import { PitchGraph } from './ui/pitchGraph';
import { PianoRoll } from './ui/pianoRoll';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  for (const c of children) el.append(c);
  return el;
}

let toastTimer = 0;
function toast(msg: string, error = false): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), error ? 6000 : 3200);
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fmtTime(t: number): string {
  const neg = t < 0;
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${neg ? '−' : ''}${m}:${s.toFixed(1).padStart(4, '0')}`;
}

class App {
  s: Settings = loadSettings();
  io = new AudioIO();
  midi = new MidiOut();
  listener: Listener;
  performer: Performer;
  triggers: Triggers;
  project: Project = { bpm: this.s.bpm, tracks: [] };
  selectedId: number | null = null;
  tuned = new TunedCache();
  player: Player;
  recorder: Recorder;
  roll: PianoRoll;
  keyboard: Keyboard;
  graph: PitchGraph;
  private syncers: (() => void)[] = [];
  private history: { midi: number; start: number; end: number }[] = [];
  private lastFrame: LiveFrame | null = null;
  private lastVoicedAt = 0;
  private saveTimer = 0;
  private tab = 'live';
  private padEls: HTMLElement[] = [];
  private capture = new NoteCapture();
  private fl = new FlSync();
  private uiTick = 0;

  constructor() {
    this.listener = new Listener(this.io.sampleRate, this.s);
    this.performer = new Performer(this.io, this.midi, this.s, this.listener.frameSec);
    this.triggers = new Triggers(this.io, this.midi, this.s);
    this.recorder = new Recorder(this.io.sampleRate);
    this.player = new Player(this.io.ctx, this.io.playBus, () => this.project, this.tuned, () => this.offlineTuneParams());
    this.player.onStop = () => this.refreshTransport();

    this.keyboard = new Keyboard($('keyboard') as HTMLCanvasElement);
    this.keyboard.onPress = (m) => {
      void this.io.resume();
      this.performer.preview(m);
    };
    this.graph = new PitchGraph($('pitch-graph') as HTMLCanvasElement);
    this.roll = new PianoRoll($('roll') as HTMLCanvasElement, {
      project: () => this.project,
      selectedTrack: () => this.selected(),
      mask: () => currentMask(this.s),
      position: () => this.player.position(),
      playing: () => this.player.playing,
      live: () => (this.recorder.recording ? { notes: this.recorder.liveNotes(this.lastFrame?.t ?? 0), curve: this.recorder.liveCurve() } : null),
      snapStep: () => (this.s.quantize ? (60 / this.project.bpm) * (4 / this.s.quantize) : 0),
      seek: (t) => {
        if (!this.player.playing) this.player.seek(t);
      },
      changed: (tr) => this.trackChanged(tr),
      audition: (tr, midi) => this.audition(tr, midi),
    });

    this.wireAudio();
    this.buildControls();
    if (this.s.midiPort || this.s.midiInPort) void this.connectMidi(true);
    this.buildPads();
    this.applySettings();
    this.renderTracks();
    void this.restoreProject();
    requestAnimationFrame(() => this.frame());
  }

  // -------------------------------------------------------------------------
  // Audio wiring

  private wireAudio(): void {
    this.io.onChunk = (frame, samples) => this.listener.push(frame, samples);
    this.listener.chunkListeners.push((frame, samples) => {
      this.recorder.addChunk(frame, samples);
      this.triggers.push(frame, samples);
    });
    this.listener.frameListeners.push((f) => {
      this.lastFrame = f;
      this.performer.frame(f);
      const pitch = this.performer.pitch;
      this.graph.addPoint(f.t, pitch);
      this.recorder.addFrame(f.t, pitch);
    });
    this.performer.onNoteOn = (n) => {
      this.graph.noteOn(n.notes, n.t);
      if (!this.s.triggersEnabled) {
        this.recorder.noteOn(n.notes, n.root, n.raw, n.velocity, n.t);
        this.capture.noteOn(n.notes, n.root, n.raw, n.velocity, n.t);
      }
      this.history.push({ midi: n.root, start: n.t, end: n.t });
      if (this.history.length > 400) this.history.shift();
    };
    this.performer.onNoteOff = (_n, end, discarded) => {
      this.graph.noteOff(end);
      this.recorder.noteOff(end, discarded);
      this.capture.noteOff(end, discarded);
      const last = this.history[this.history.length - 1];
      if (last) last.end = end;
    };
    this.triggers.onHit = (hit) => {
      const el = this.padEls[hit.pad];
      if (el) {
        el.classList.add('hit');
        setTimeout(() => el.classList.remove('hit'), 120);
      }
      this.recorder.addHit(this.s.pads[hit.pad].note, hit.velocity, hit.t);
    };
    this.triggers.onTrained = () => this.refreshPads();
    this.midi.onPortsChanged = () => this.refreshMidiPorts();
    this.midi.onMessage = (data, ts) => this.fl.handle(data, ts / 1000);
    this.fl.onChange = (c) => this.flChanged(c);
  }

  autotuneParams(): Partial<AutotuneParams> {
    return { mask: currentMask(this.s), speed: this.s.tuneSpeed, amount: this.s.tuneAmount, mix: this.s.tuneMix, a4: this.s.a4 };
  }

  offlineTuneParams(): Partial<AutotuneParams> {
    return { ...this.autotuneParams(), mix: this.s.tuneMix };
  }

  set(patch: Partial<Settings>): void {
    const prev = { ...this.s };
    Object.assign(this.s, patch);
    if (patch.bpm !== undefined) this.project.bpm = this.s.bpm;
    if (prev.liveInstrument !== this.s.liveInstrument) this.loadInstrument(this.s.liveInstrument);
    if (prev.deviceId !== this.s.deviceId && this.io.running) void this.startMic();
    saveSettings(this.s);
    this.applySettings();
    if (patch.bpm !== undefined) this.scheduleSave();
  }

  private applySettings(): void {
    this.listener.configure(this.s);
    this.performer.configure(this.s, this.listener.frameSec);
    this.performer.enabled = !this.s.triggersEnabled;
    this.triggers.configure(this.s);
    this.triggers.enabled = this.s.triggersEnabled;
    this.io.setAutotune(this.autotuneParams());
    this.io.setMonitor(this.s.monitor && this.io.running, this.s.monitorLevel);
    this.player.setMetronome(this.s.metronome);
    for (const sync of this.syncers) sync();
  }

  async startMic(): Promise<boolean> {
    const btn = $('mic-btn');
    try {
      btn.textContent = 'Подключаю…';
      await this.io.startInput(this.s.deviceId || undefined);
    } catch (err) {
      btn.textContent = 'Включить микрофон';
      const name = (err as Error).name;
      toast(
        name === 'NotAllowedError'
          ? 'Нет доступа к микрофону. Разреши его в адресной строке браузера (значок замка).'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'Микрофон не найден. Проверь подключение или выбери другой.'
            : `Не удалось включить микрофон: ${(err as Error).message}`,
        true,
      );
      return false;
    }
    btn.textContent = 'Микрофон включён';
    btn.classList.add('live');
    $('note-latin').textContent = 'Спой или сыграй ноту';
    await this.refreshDevices();
    this.applySettings();
    this.loadInstrument(this.s.liveInstrument);
    return true;
  }

  stopMic(): void {
    this.io.stopInput();
    this.performer.allOff();
    const btn = $('mic-btn');
    btn.textContent = 'Включить микрофон';
    btn.classList.remove('live');
    this.applySettings();
  }

  private loadInstrument(id: string): void {
    const inst = getInstrument(id);
    if (inst.state() === 'ready' || inst.state() === 'loading') return;
    const p = inst.load(this.io.ctx);
    this.refreshInstrumentStatus();
    p.then(
      () => this.refreshInstrumentStatus(),
      () => {
        this.refreshInstrumentStatus();
        toast(`«${inst.name}» не загрузился (нет интернета?). Пока играет встроенный синтезатор.`, true);
      },
    );
  }

  private refreshInstrumentStatus(): void {
    const el = $('inst-status');
    const st = getInstrument(this.s.liveInstrument).state();
    el.className = `status ${st}`;
    el.textContent = st === 'loading' ? 'загрузка…' : st === 'error' ? `нет сети · ${playableInstrument(this.s.liveInstrument).name}` : st === 'ready' ? 'готов' : '';
  }

  // -------------------------------------------------------------------------
  // Controls

  private bind<T extends HTMLInputElement | HTMLSelectElement>(id: string, read: (el: T) => Partial<Settings> | null, write: (el: T) => void, event = 'change'): T {
    const el = $(id) as T;
    el.addEventListener(event, () => {
      const patch = read(el);
      if (patch) this.set(patch);
    });
    this.syncers.push(() => {
      if (document.activeElement !== el) write(el);
    });
    return el;
  }

  private bindCheck(id: string, key: keyof Settings): void {
    this.bind<HTMLInputElement>(id, (el) => ({ [key]: el.checked }) as Partial<Settings>, (el) => (el.checked = Boolean(this.s[key])));
  }

  private bindNumber(id: string, key: keyof Settings, min: number, max: number): void {
    this.bind<HTMLInputElement>(
      id,
      (el) => {
        const v = Number(el.value);
        return Number.isFinite(v) && el.value !== '' ? ({ [key]: Math.max(min, Math.min(max, v)) } as Partial<Settings>) : null;
      },
      (el) => (el.value = String(this.s[key])),
    );
  }

  private bindRange(id: string, key: keyof Settings, valId: string, fmt: (v: number) => string): void {
    const val = $(valId);
    this.bind<HTMLInputElement>(id, (el) => ({ [key]: Number(el.value) }) as Partial<Settings>, (el) => (el.value = String(this.s[key])), 'input');
    this.syncers.push(() => (val.textContent = fmt(this.s[key] as number)));
  }

  private bindSeg(id: string, key: keyof Settings): void {
    const el = $(id);
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    for (const b of buttons) b.addEventListener('click', () => this.set({ [key]: b.dataset.value } as Partial<Settings>));
    this.syncers.push(() => buttons.forEach((b) => b.classList.toggle('on', b.dataset.value === this.s[key])));
  }

  private fillSelect(el: HTMLSelectElement, options: { value: string; label: string }[]): void {
    el.replaceChildren(...options.map((o) => h('option', { value: o.value, textContent: o.label })));
  }

  private instrumentOptions(el: HTMLSelectElement): void {
    const groups: [string, 'sampled' | 'synth'][] = [
      ['Реалистичные (скачиваются один раз)', 'sampled'],
      ['Синтезаторы (без интернета)', 'synth'],
    ];
    el.replaceChildren(
      ...groups.map(([label, g]) => {
        const og = h('optgroup', { label });
        for (const i of INSTRUMENTS.filter((x) => x.group === g)) og.append(h('option', { value: i.id, textContent: i.name }));
        return og;
      }),
    );
  }

  private buildControls(): void {
    // Tabs.
    for (const t of document.querySelectorAll<HTMLButtonElement>('.tab')) {
      t.addEventListener('click', () => this.showTab(t.dataset.tab!));
    }

    $('mic-btn').addEventListener('click', () => (this.io.running ? this.stopMic() : void this.startMic()));

    // Input.
    this.bind<HTMLSelectElement>('device-select', (el) => ({ deviceId: el.value }), (el) => (el.value = this.s.deviceId));
    this.bindSeg('source-seg', 'source');
    this.bindSeg('latency-seg', 'latency');
    this.bindRange('gate', 'gateDb', 'gate-val', (v) => `${v} дБ`);
    this.bindNumber('a4', 'a4', 415, 466);

    // Key.
    const keySel = $('key-select') as HTMLSelectElement;
    this.fillSelect(keySel, NOTE_NAMES_RU.map((n, i) => ({ value: String(i), label: `${n} (${NOTE_NAMES[i]})` })));
    this.bind<HTMLSelectElement>('key-select', (el) => ({ key: Number(el.value), customMask: null }), (el) => (el.value = String(this.s.key)));
    const scaleSel = $('scale-select') as HTMLSelectElement;
    this.fillSelect(scaleSel, [...SCALES.map((s) => ({ value: s.id, label: s.name })), { value: 'custom', label: 'Свои ноты' }]);
    this.bind<HTMLSelectElement>(
      'scale-select',
      (el) => (el.value === 'custom' ? null : { scaleId: el.value, customMask: null }),
      (el) => (el.value = this.s.customMask !== null ? 'custom' : this.s.scaleId),
    );
    const chips = $('pc-chips');
    const chipEls = NOTE_NAMES_RU.map((name, pc) => {
      const b = h('button', { className: 'pc-chip', textContent: name, title: NOTE_NAMES[pc] });
      b.addEventListener('click', () => {
        const mask = currentMask(this.s) ^ (1 << pc);
        this.set({ customMask: mask === 0 ? null : mask });
      });
      chips.append(b);
      return b;
    });
    this.syncers.push(() => {
      const mask = currentMask(this.s);
      chipEls.forEach((b, pc) => {
        b.classList.toggle('on', Boolean(mask & (1 << pc)));
        b.classList.toggle('tonic', this.s.customMask === null && pc === this.s.key);
      });
      const scale = this.s.customMask !== null ? 'свои ноты' : `${NOTE_NAMES_RU[this.s.key]} — ${SCALES.find((x) => x.id === this.s.scaleId)?.name.toLowerCase()}`;
      $('tune-key-label').textContent = scale;
    });
    $('detect-key-btn').addEventListener('click', () => this.detectKey());

    // MIDI.
    const chans = Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
    this.fillSelect($('midi-channel') as HTMLSelectElement, chans);
    this.fillSelect($('drum-channel') as HTMLSelectElement, chans);
    this.bind<HTMLSelectElement>('midi-channel', (el) => ({ midiChannel: Number(el.value) }), (el) => (el.value = String(this.s.midiChannel)));
    this.bind<HTMLSelectElement>('drum-channel', (el) => ({ drumChannel: Number(el.value) }), (el) => (el.value = String(this.s.drumChannel)));
    this.bind<HTMLSelectElement>(
      'midi-port',
      (el) => {
        this.midi.select(el.value || null);
        this.refreshMidiPill();
        return { midiPort: el.value };
      },
      (el) => (el.value = this.midi.connected ? this.s.midiPort : ''),
    );
    this.bind<HTMLSelectElement>(
      'midi-in-port',
      (el) => {
        this.midi.selectInput(el.value || null);
        this.flHello();
        return { midiInPort: el.value };
      },
      (el) => (el.value = this.midi.inputConnected ? this.s.midiInPort : ''),
    );
    $('midi-connect-btn').addEventListener('click', () => void this.connectMidi());

    // FL Studio.
    this.bindCheck('fl-tempo', 'flTempo');
    this.bindCheck('fl-newtake', 'flNewTake');
    $('fl-rec').addEventListener('click', () => void this.flCommand(FL_CC.record));
    $('fl-play').addEventListener('click', () => void this.flCommand(FL_CC.play));
    $('fl-stop').addEventListener('click', () => void this.flCommand(FL_CC.stop));
    $('fl-setup-btn').addEventListener('click', () => void this.openFlSetup());
    $('fl-dialog-close').addEventListener('click', () => ($('fl-dialog') as HTMLDialogElement).close());
    $('fl-recheck').addEventListener('click', () => {
      this.flHello();
      setTimeout(() => void this.refreshFlSetup(), 800);
    });
    const step = (id: string, fn: () => Promise<unknown>) =>
      $(id).addEventListener('click', async () => {
        try {
          await fn();
        } catch (err) {
          toast((err as Error).message, true);
        }
        setTimeout(() => void this.refreshFlSetup(), 1200);
      });
    step('do-loop', async () => {
      if (this.bridgeLoopMissing) {
        window.open('https://www.tobias-erichsen.de/software/loopmidi.html', '_blank', 'noopener');
        return;
      }
      await bridge.startLoopMidi();
      toast('loopMIDI запущен');
    });
    step('do-script', async () => {
      const r = await bridge.installScript();
      toast(`Скрипт установлен: ${r.path}`);
    });
    step('do-midi', () => this.autoConnectFl());
    step('do-fl', async () => {
      await bridge.openFl();
      toast('FL Studio запускается…');
    });
    window.setInterval(() => this.flHello(), 4000);

    // Live capture.
    $('cap-fl').addEventListener('click', () => void this.saveTakeToFl());
    $('cap-studio').addEventListener('click', () => this.takeToStudio());
    $('cap-midi').addEventListener('click', () => {
      const t = this.takeMidi();
      if (t) download(new Blob([t.bytes as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }), `${this.takeName()}.mid`);
    });
    $('cap-drag').addEventListener('dragstart', (e) => {
      const t = this.takeMidi(false);
      if (!t || !e.dataTransfer) return e.preventDefault();
      let bin = '';
      for (const b of t.bytes) bin += String.fromCharCode(b);
      const url = `data:audio/midi;base64,${btoa(bin)}`;
      e.dataTransfer.setData('DownloadURL', `audio/midi:${this.takeName()}.mid:${url}`);
      e.dataTransfer.setData('text/uri-list', url);
    });
    $('cap-drag').addEventListener('click', (e) => e.preventDefault());
    $('cap-clear').addEventListener('click', () => {
      this.capture.clear();
      toast('Новый дубль');
    });
    $('panic-btn').addEventListener('click', () => {
      this.performer.allOff();
      this.midi.allNotesOff();
      toast('Все ноты сброшены');
    });

    // Voice -> MIDI.
    this.bindCheck('live-sound', 'liveSound');
    this.instrumentOptions($('live-instrument') as HTMLSelectElement);
    this.bind<HTMLSelectElement>('live-instrument', (el) => ({ liveInstrument: el.value }), (el) => (el.value = this.s.liveInstrument));
    this.syncers.push(() => this.refreshInstrumentStatus());
    this.bind<HTMLSelectElement>('octave', (el) => ({ octave: Number(el.value) }), (el) => (el.value = String(this.s.octave)));
    this.bindCheck('keylock', 'keyLock');
    this.syncers.push(() => {
      $('keylock-hint').hidden = !(this.s.keyLock && this.s.customMask === null && this.s.scaleId === 'chromatic');
    });
    this.fillSelect($('chord-select') as HTMLSelectElement, CHORD_TYPES.map((c) => ({ value: c.id, label: c.name })));
    this.bind<HTMLSelectElement>('chord-select', (el) => ({ chord: el.value }), (el) => (el.value = this.s.chord));
    this.fillSelect($('voicing-select') as HTMLSelectElement, VOICINGS.map((v) => ({ value: v.id, label: v.name })));
    this.bind<HTMLSelectElement>('voicing-select', (el) => ({ voicing: el.value as Settings['voicing'] }), (el) => (el.value = this.s.voicing));
    this.bindSeg('bend-seg', 'bendMode');
    this.bind<HTMLSelectElement>('bend-range', (el) => ({ bendRange: Number(el.value) }), (el) => (el.value = String(this.s.bendRange)));
    this.bind<HTMLSelectElement>('vel-mode', (el) => ({ velocityMode: el.value as Settings['velocityMode'] }), (el) => (el.value = this.s.velocityMode));
    this.bindNumber('vel-fixed', 'fixedVelocity', 1, 127);
    this.syncers.push(() => (($('vel-fixed') as HTMLInputElement).disabled = this.s.velocityMode !== 'fixed'));
    this.bindCheck('env-cc', 'envCC');
    this.bindNumber('env-cc-num', 'envCCNum', 0, 127);
    this.bindCheck('timbre-cc', 'timbreCC');
    this.bindNumber('timbre-cc-num', 'timbreCCNum', 0, 127);

    // Beatbox.
    this.bindCheck('triggers-enabled', 'triggersEnabled');
    this.bindRange('trigger-db', 'triggerDb', 'trigger-db-val', (v) => `${v} дБ`);

    // Studio.
    this.bindNumber('bpm', 'bpm', 40, 240);
    this.bindCheck('metronome', 'metronome');
    this.bindCheck('countin', 'countIn');
    this.fillSelect($('quantize') as HTMLSelectElement, QUANTIZE_GRIDS.map((q) => ({ value: String(q.value), label: q.name })));
    this.bind<HTMLSelectElement>('quantize', (el) => ({ quantize: Number(el.value) }), (el) => (el.value = String(this.s.quantize)));
    this.bind<HTMLInputElement>(
      'latency-ms',
      (el) => ({ latencyMs: el.value === '' ? null : Math.max(0, Math.min(500, Number(el.value))) }),
      (el) => {
        el.value = this.s.latencyMs === null ? '' : String(this.s.latencyMs);
        el.placeholder = `авто ${Math.round(this.io.estimatedRoundTrip() * 1000)}`;
      },
    );
    $('rec-btn').addEventListener('click', () => void this.toggleRecord());
    $('play-btn').addEventListener('click', () => void this.togglePlay());
    $('stop-btn').addEventListener('click', () => this.stop());
    $('home-btn').addEventListener('click', () => {
      if (this.player.playing) this.player.stop();
      this.player.seek(0);
      this.roll.scrollX = 0;
    });
    $('zoom-in').addEventListener('click', () => this.roll.zoom(1.3));
    $('zoom-out').addEventListener('click', () => this.roll.zoom(1 / 1.3));
    $('export-midi').addEventListener('click', () => this.exportMidi());
    $('export-wav').addEventListener('click', () => void this.exportWav());
    $('clear-project').addEventListener('click', () => {
      if (!this.project.tracks.length || !confirm('Удалить все дорожки проекта?')) return;
      this.player.stop();
      this.project.tracks = [];
      this.selectedId = null;
      this.renderTracks();
      this.scheduleSave();
    });
    const drag = $('drag-midi');
    drag.addEventListener('dragstart', (e) => {
      const bytes = this.midiBytes();
      if (!bytes || !e.dataTransfer) return e.preventDefault();
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      const url = `data:audio/midi;base64,${btoa(bin)}`;
      e.dataTransfer.setData('DownloadURL', `audio/midi:soundwave.mid:${url}`);
      e.dataTransfer.setData('text/uri-list', url);
    });
    drag.addEventListener('click', (e) => {
      e.preventDefault();
      this.exportMidi();
    });

    // Autotune.
    this.bindCheck('monitor', 'monitor');
    this.bind<HTMLInputElement>('monitor-level', (el) => ({ monitorLevel: Number(el.value) }), (el) => (el.value = String(this.s.monitorLevel)), 'input');
    this.bindRange('tune-speed', 'tuneSpeed', 'tune-speed-val', (v) => (v < 0.05 ? 'мгновенно' : `${Math.round(v * v * 400)} мс`));
    this.bindRange('tune-amount', 'tuneAmount', 'tune-amount-val', (v) => `${Math.round(v * 100)}%`);
    this.bindRange('tune-mix', 'tuneMix', 'tune-mix-val', (v) => `${Math.round(v * 100)}%`);
    $('monitor').addEventListener('change', async () => {
      if (this.s.monitor && !this.io.running) await this.startMic();
      if (this.s.monitor) toast('Мониторинг включён. Только в наушниках!');
    });

    $('live-status-btn').addEventListener('click', () => this.set({ triggersEnabled: false }));
    // Browsers may keep audio suspended until the page is interacted with.
    for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => void this.io.resume(), { capture: true });

    document.addEventListener('keydown', (e) => this.hotkey(e));
    window.addEventListener('beforeunload', () => {
      if (this.saveTimer) void saveProject(this.project);
    });
  }

  private showTab(tab: string): void {
    this.tab = tab;
    for (const t of document.querySelectorAll<HTMLElement>('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
    for (const p of document.querySelectorAll<HTMLElement>('.tab-page')) p.classList.toggle('active', p.id === `tab-${tab}`);
  }

  private hotkey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.matches('input[type=text], input[type=number], input:not([type]), select, textarea')) return;
    if (this.tab !== 'studio') return;
    if (e.code === 'Space') {
      e.preventDefault();
      void this.togglePlay();
    } else if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      void this.toggleRecord();
    } else if (e.code === 'Home') {
      this.player.seek(0);
      this.roll.scrollX = 0;
    }
  }

  private async refreshDevices(): Promise<void> {
    try {
      const devices = await AudioIO.listInputs();
      const sel = $('device-select') as HTMLSelectElement;
      this.fillSelect(sel, [{ value: '', label: 'По умолчанию' }, ...devices.filter((d) => d.id !== 'default').map((d) => ({ value: d.id, label: d.label }))]);
      sel.value = this.s.deviceId;
    } catch {
      // enumerateDevices unavailable
    }
  }

  private async connectMidi(silent = false): Promise<boolean> {
    if (!this.midi.supported) {
      if (!silent) toast('Этот браузер не умеет работать с MIDI. Открой SoundWave в Chrome или Edge.', true);
      return false;
    }
    try {
      await this.midi.init();
    } catch {
      if (!silent) toast('Доступ к MIDI запрещён. Разреши его в адресной строке браузера.', true);
      return false;
    }
    this.refreshMidiPorts();
    const ports = this.midi.ports();
    if (!silent) {
      if (!ports.length) toast('MIDI-портов нет. Запусти loopMIDI и создай в нём порт.', true);
      else toast(`Найдено MIDI-портов: ${ports.length}`);
    }
    return true;
  }

  private refreshMidiPorts(): void {
    const sel = $('midi-port') as HTMLSelectElement;
    const ports = this.midi.ports();
    this.fillSelect(sel, [{ value: '', label: ports.length ? '— не выбран —' : '— портов нет —' }, ...ports.map((p) => ({ value: p.id, label: p.name }))]);
    // Re-select only on a real change: port events fire whenever another app opens the port.
    if (this.s.midiPort && ports.some((p) => p.id === this.s.midiPort) && this.midi.outputId !== this.s.midiPort) {
      this.midi.select(this.s.midiPort);
      if (this.s.bendMode !== 'off') this.midi.bendRange(this.s.midiChannel, this.s.bendRange);
    }
    sel.value = this.midi.connected ? this.s.midiPort : '';

    const insel = $('midi-in-port') as HTMLSelectElement;
    const inputs = this.midi.inputs();
    this.fillSelect(insel, [{ value: '', label: inputs.length ? '— не выбран —' : '— портов нет —' }, ...inputs.map((p) => ({ value: p.id, label: p.name }))]);
    if (this.s.midiInPort && inputs.some((p) => p.id === this.s.midiInPort) && this.midi.inputId !== this.s.midiInPort) {
      this.midi.selectInput(this.s.midiInPort);
      this.flHello();
    }
    insel.value = this.midi.inputConnected ? this.s.midiInPort : '';
    $('midi-connect-btn').textContent = 'Обновить список портов';
    this.refreshMidiPill();
  }

  // -------------------------------------------------------------------------
  // FL Studio

  private bridgeLoopMissing = false;

  private flHello(): void {
    if (this.midi.connected) this.midi.cc(FL_CHANNEL, FL_CC.hello, 127);
  }

  private flOnline(): boolean {
    return this.fl.state(performance.now() / 1000).age < 9;
  }

  /** Points MIDI out and in at the loopMIDI port, starting loopMIDI if it isn't running. */
  private async autoConnectFl(): Promise<void> {
    if (!(await this.connectMidi(true))) throw new Error('Нет доступа к MIDI: разреши его в адресной строке браузера (Chrome или Edge).');
    const findOut = () => this.midi.ports().find((p) => /loopmidi/i.test(p.name));
    if (!findOut()) {
      try {
        await bridge.startLoopMidi();
        for (let i = 0; i < 20 && !findOut(); i++) await new Promise((r) => setTimeout(r, 250));
      } catch {
        // No bridge or loopMIDI not installed: reported below.
      }
    }
    const out = findOut();
    if (!out) throw new Error('Порт loopMIDI не найден: запусти loopMIDI и создай в нём порт.');
    const inp = this.midi.inputs().find((p) => p.name === out.name) ?? this.midi.inputs().find((p) => /loopmidi/i.test(p.name));
    this.set({ midiPort: out.id, midiInPort: inp?.id ?? '' });
    this.refreshMidiPorts();
    this.flHello();
    toast(`MIDI подключён к «${out.name}»`);
  }

  private async flCommand(cc: number): Promise<void> {
    if (!this.midi.connected) {
      try {
        await this.autoConnectFl();
      } catch {
        void this.openFlSetup();
        return;
      }
    }
    this.midi.cc(FL_CHANNEL, cc, 127);
    if (!this.flOnline()) toast('Команда отправлена, но FL пока не отвечает. Нажми «Настроить связь с FL Studio».');
  }

  private flChanged(c: { tempo?: boolean; playing?: boolean; recording?: boolean }): void {
    const tempo = Math.round(this.fl.tempo * 10) / 10;
    if (c.tempo && this.s.flTempo && tempo >= 40 && tempo <= 240 && tempo !== this.s.bpm) this.set({ bpm: tempo });
    if (c.recording && this.fl.recording && this.s.flNewTake) {
      this.capture.clear(this.lastFrame?.t ?? this.io.ctx.currentTime);
      toast('FL Studio начал запись: начат новый дубль');
    }
    this.refreshFl();
  }

  private refreshFl(): void {
    const st = this.fl.state(performance.now() / 1000);
    let cls = '';
    let msg = 'Не подключено';
    if (st.age < 9) {
      cls = st.recording ? 'rec' : 'on';
      const parts = ['FL Studio на связи'];
      if (st.tempo) parts.push(`${Math.round(st.tempo * 10) / 10} BPM`);
      if (st.recording) parts.push('● запись');
      else if (st.playing) parts.push('▶ играет');
      msg = parts.join(' · ');
    } else if (this.midi.connected) {
      cls = 'half';
      msg = 'Ноты идут в MIDI-порт, но FL не отвечает';
    }
    $('fl-status').className = `fl-status ${cls}`;
    $('fl-status-text').textContent = msg;
    $('fl-rec').classList.toggle('active', st.age < 9 && st.recording);
  }

  private async openFlSetup(): Promise<void> {
    const dlg = $('fl-dialog') as HTMLDialogElement;
    if (!dlg.open) dlg.showModal();
    this.flHello();
    await this.refreshFlSetup();
  }

  private async refreshFlSetup(): Promise<void> {
    const badge = (id: string, ok: boolean, text: string) => {
      const el = $(id);
      el.textContent = text;
      el.className = `badge ${ok ? 'ok' : 'warn'}`;
    };
    let b: Awaited<ReturnType<typeof bridge.status>> | null = null;
    try {
      b = await bridge.status();
    } catch {
      b = null;
    }
    const loopBtn = $('do-loop') as HTMLButtonElement;
    if (!b) {
      badge('st-loop', false, 'неизвестно');
      badge('st-script', false, 'неизвестно');
      loopBtn.disabled = true;
      ($('do-script') as HTMLButtonElement).disabled = true;
      ($('do-fl') as HTMLButtonElement).disabled = true;
      toast('Помощник недоступен: запусти SoundWave через start.bat (npm run dev).', true);
    } else {
      this.bridgeLoopMissing = !b.loopMidiInstalled;
      badge('st-loop', b.loopMidiRunning, !b.loopMidiInstalled ? 'не установлен' : b.loopMidiRunning ? 'запущен' : 'не запущен');
      loopBtn.textContent = b.loopMidiInstalled ? 'Запустить loopMIDI' : 'Скачать loopMIDI';
      loopBtn.disabled = b.loopMidiRunning;
      badge('st-script', b.script === 'installed', b.script === 'installed' ? 'установлен' : b.script === 'outdated' ? 'есть обновление' : 'не установлен');
      ($('do-script') as HTMLButtonElement).disabled = false;
      ($('do-script') as HTMLButtonElement).textContent = b.script === 'installed' ? 'Переустановить скрипт' : 'Установить скрипт';
      ($('do-fl') as HTMLButtonElement).disabled = b.flRunning || !b.flInstalled;
    }
    const outName = this.midi.ports().find((p) => p.id === this.midi.outputId)?.name ?? '';
    badge('st-midi', /loopmidi/i.test(outName) && this.midi.inputConnected, /loopmidi/i.test(outName) ? (this.midi.inputConnected ? 'подключено' : 'нет входа') : 'не подключено');
    const online = this.flOnline();
    badge('st-fl', online, online ? 'FL на связи' : b?.flRunning ? 'FL открыт, ответа нет' : 'FL не запущен');
    this.refreshFl();
  }

  // -------------------------------------------------------------------------
  // Live capture

  private takeName(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `SoundWave ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  }

  private takeMidi(warn = true): { bytes: Uint8Array; count: number } | null {
    const now = this.lastFrame?.t ?? this.io.ctx.currentTime;
    const notes = quantizeNotes(this.capture.take(now), this.project.bpm, this.s.quantize);
    if (!notes.length) {
      if (warn) toast('Дубль пуст: включи микрофон и спой что-нибудь.', true);
      return null;
    }
    const program = getInstrument(this.s.liveInstrument).gmProgram;
    return { bytes: writeMidiFile([{ name: 'SoundWave', channel: 1, program, notes }], this.project.bpm), count: notes.length };
  }

  private async saveTakeToFl(): Promise<void> {
    const t = this.takeMidi();
    if (!t) return;
    const name = this.takeName();
    try {
      await bridge.saveMidi(name, t.bytes);
      toast(`Сохранено в FL Studio (${t.count} нот): браузер FL → Recorded → SoundWave → ${name}.mid`);
    } catch {
      download(new Blob([t.bytes as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }), `${name}.mid`);
      toast('Помощник недоступен, поэтому файл скачан. Запусти SoundWave через start.bat, чтобы сохранять прямо в FL.', true);
    }
  }

  private takeToStudio(): void {
    const now = this.lastFrame?.t ?? this.io.ctx.currentTime;
    const notes = quantizeNotes(this.capture.take(now), this.project.bpm, this.s.quantize);
    if (!notes.length) {
      toast('Дубль пуст: включи микрофон и спой что-нибудь.', true);
      return;
    }
    const tr = newTrack(this.project, { name: `Голос → MIDI ${this.project.tracks.length + 1}`, instrumentId: this.s.liveInstrument, notes });
    this.project.tracks.push(tr);
    this.selectedId = tr.id;
    this.renderTracks();
    this.scheduleSave();
    this.roll.reveal(tr.notes);
    toast(`Добавлено в «Студию»: «${tr.name}», нот: ${notes.length}`);
  }

  private refreshMidiPill(): void {
    const pill = $('midi-pill');
    const port = this.midi.ports().find((p) => p.id === this.s.midiPort);
    pill.textContent = this.midi.connected && port ? `MIDI: ${port.name}` : 'MIDI: нет';
    pill.classList.toggle('on', this.midi.connected);
  }

  private detectKey(): void {
    const tr = this.selected();
    const now = this.lastFrame?.t ?? 0;
    let notes = this.history.filter((n) => now - n.end < 90 && n.end > n.start);
    let source = 'по тому, что ты спел';
    if (notes.length < 6 && tr && tr.kind === 'melody' && tr.notes.length >= 6) {
      notes = tr.notes;
      source = `по дорожке «${tr.name}»`;
    }
    if (notes.length < 6) {
      $('key-result').textContent = 'Мало нот: включи микрофон, спой мелодию 10–20 секунд и нажми ещё раз.';
      return;
    }
    const k = detectKey(notes);
    if (!k) return;
    this.set({ key: k.key, scaleId: k.scaleId, customMask: null });
    $('key-result').textContent = `${k.label} (${source}, уверенность ${Math.round(Math.max(0, k.confidence) * 100)}%)`;
    toast(`Тональность: ${k.label}`);
  }

  // -------------------------------------------------------------------------
  // Beatbox pads

  private buildPads(): void {
    const root = $('pads');
    this.padEls = this.s.pads.map((_, i) => {
      const name = h('input', { className: 'pad-name', type: 'text' });
      name.addEventListener('change', () => this.updatePad(i, { name: name.value }));
      const sound = h('select');
      this.fillSelect(sound, DRUM_SOUNDS.map((d) => ({ value: d.id, label: d.name })));
      sound.addEventListener('change', () => {
        const gm = DRUM_SOUNDS.find((d) => d.id === sound.value)?.gmNote ?? 38;
        this.updatePad(i, { sound: sound.value, note: gm });
        this.testPad(i);
      });
      const note = h('input', { type: 'number', min: '0', max: '127', title: 'MIDI-нота' });
      note.addEventListener('change', () => this.updatePad(i, { note: Math.max(0, Math.min(127, Number(note.value) || 0)) }));
      const train = h('button', { className: 'btn small', textContent: 'Обучить' });
      train.addEventListener('click', () => void this.toggleTraining(i));
      const test = h('button', { className: 'btn small ghost', textContent: '▶', title: 'Послушать' });
      test.addEventListener('click', () => this.testPad(i));
      const clear = h('button', { className: 'btn small ghost', textContent: 'Сбросить', title: 'Забыть примеры' });
      clear.addEventListener('click', () => {
        this.triggers.clear(i);
        this.refreshPads();
      });
      const count = h('span', { className: 'pad-count' });
      const el = h(
        'div',
        { className: 'pad' },
        h('div', { className: 'pad-top' }, h('div', { className: 'pad-num', textContent: String(i + 1) }), name),
        h('div', { className: 'pad-row' }, sound, note),
        h('div', { className: 'pad-row' }, train, test, clear),
        count,
      );
      root.append(el);
      this.syncers.push(() => {
        const p = this.s.pads[i];
        if (document.activeElement !== name) name.value = p.name;
        sound.value = p.sound;
        if (document.activeElement !== note) note.value = String(p.note);
      });
      return el;
    });
    this.refreshPads();
  }

  private updatePad(i: number, patch: Partial<Settings['pads'][number]>): void {
    const pads = this.s.pads.map((p, j) => (j === i ? { ...p, ...patch } : p));
    this.set({ pads });
  }

  private testPad(i: number): void {
    void this.io.resume();
    playDrum(this.io.ctx, this.io.drumBus, this.s.pads[i].sound, 110, this.io.ctx.currentTime);
  }

  private async toggleTraining(i: number): Promise<void> {
    if (this.triggers.training === i) {
      this.triggers.training = null;
      const n = this.triggers.classifier.count(i);
      toast(n ? `Пад ${i + 1} обучен на ${n} примерах` : 'Примеров не записано: звук был слишком тихим? Понизь «Порог срабатывания».');
      if (n && !this.s.triggersEnabled) this.set({ triggersEnabled: true });
    } else {
      if (!this.io.running && !(await this.startMic())) return;
      this.triggers.training = i;
      toast(`Делай звук для «${this.s.pads[i].name}» 5–8 раз с паузами, потом нажми «Готово»`);
    }
    this.refreshPads();
  }

  private refreshPads(): void {
    this.padEls.forEach((el, i) => {
      const training = this.triggers.training === i;
      el.classList.toggle('training', training);
      const btn = el.querySelector<HTMLButtonElement>('.pad-row:nth-of-type(3) .btn')!;
      btn.textContent = training ? 'Готово' : 'Обучить';
      btn.classList.toggle('primary', training);
      const n = this.triggers.classifier.count(i);
      const count = el.querySelector('.pad-count')!;
      count.textContent = training ? `Слушаю… примеров: ${n}` : n ? `Примеров: ${n}` : 'Не обучен';
      count.classList.toggle('zero', n === 0);
    });
  }

  // -------------------------------------------------------------------------
  // Studio

  selected(): Track | null {
    return this.project.tracks.find((t) => t.id === this.selectedId) ?? null;
  }

  private audition(tr: Track, midi: number): void {
    void this.io.resume();
    const t = this.io.ctx.currentTime;
    if (tr.kind === 'drums') {
      const sound = DRUM_SOUNDS.find((d) => d.gmNote === midi)?.id ?? 'snare';
      playDrum(this.io.ctx, this.io.playBus, sound, 100, t);
      return;
    }
    const inst = playableInstrument(tr.instrumentId);
    const bus = inst.createBus(this.io.ctx, this.io.playBus);
    inst.play(this.io.ctx, bus, midi, 95, t, 0.35);
    setTimeout(() => bus.disconnect(), 2500);
  }

  private trackChanged(tr: Track): void {
    void tr;
    this.renderTracks();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      saveProject(this.project).catch(() => toast('Не удалось сохранить проект в браузере (мало места?)', true));
    }, 800);
  }

  private async restoreProject(): Promise<void> {
    try {
      const p = await loadProject();
      if (!p || !Array.isArray(p.tracks)) return;
      for (const t of p.tracks) for (const n of t.notes) n.id = newNoteId();
      this.project = p;
      this.set({ bpm: p.bpm || this.s.bpm });
      this.selectedId = p.tracks[0]?.id ?? null;
      this.renderTracks();
      const sel = this.selected();
      if (sel) requestAnimationFrame(() => this.roll.reveal(sel.notes));
    } catch {
      // No saved project or storage unavailable.
    }
  }

  private async togglePlay(): Promise<void> {
    if (this.recorder.recording) return this.stop();
    if (this.player.playing) {
      this.player.stop();
      this.refreshTransport();
      return;
    }
    await this.io.resume();
    await this.prepareTracks();
    this.player.play({ from: this.player.position(), metronome: this.s.metronome, autoStop: true });
    this.refreshTransport();
  }

  /** Loads instruments and renders autotuned takes needed for playback. */
  private async prepareTracks(): Promise<void> {
    const params = this.offlineTuneParams();
    const jobs: Promise<unknown>[] = [];
    for (const t of this.project.tracks) {
      if (t.kind === 'melody') this.loadInstrument(t.instrumentId);
      if (t.audio && (t.playMode === 'tuned' || t.playMode === 'instrument+tuned') && !this.tuned.get(t, params)) jobs.push(this.tuned.render(t, params));
    }
    if (jobs.length) {
      toast('Применяю автотюн к записи…');
      await Promise.all(jobs);
    }
  }

  private stop(): void {
    if (this.recorder.recording) {
      this.finishRecording();
      return;
    }
    if (!this.player.playing) {
      this.player.seek(0);
      this.roll.scrollX = 0;
    }
    this.player.stop();
    this.refreshTransport();
  }

  private async toggleRecord(): Promise<void> {
    if (this.recorder.recording) {
      this.finishRecording();
      return;
    }
    if (!this.io.running && !(await this.startMic())) return;
    await this.io.resume();
    await this.prepareTracks();
    const beat = 60 / this.project.bpm;
    const countIn = this.s.countIn && this.s.metronome ? 4 : 0;
    const at = this.io.ctx.currentTime + 0.15 + countIn * beat;
    const from = this.player.position();
    this.player.play({ from, metronome: this.s.metronome, at, countIn });
    this.recorder.begin(at, from);
    this.refreshTransport();
    if (!this.s.liveSound && !this.s.triggersEnabled) toast('Идёт запись. Инструмент в колонках выключен: ноты появятся на экране.');
  }

  private finishRecording(): void {
    const latency = this.s.latencyMs !== null ? this.s.latencyMs / 1000 : this.io.estimatedRoundTrip();
    const res = this.recorder.finish(this.lastFrame?.t ?? this.io.ctx.currentTime, latency);
    this.player.stop();
    this.performer.allOff();
    let energy = 0;
    for (let i = 0; i < res.audio.length; i += 4) energy += res.audio[i] * res.audio[i];
    const rms = Math.sqrt(energy / Math.max(1, res.audio.length / 4));
    const takes = this.project.tracks.length + 1;
    let created: Track | null = null;
    if (res.notes.length || (rms > 0.003 && !res.hits.length)) {
      const notes = quantizeNotes(res.notes, this.project.bpm, this.s.quantize);
      created = newTrack(this.project, {
        name: `Запись ${takes}`,
        instrumentId: this.s.liveInstrument,
        notes,
        audio: res.audio,
        sampleRate: this.io.sampleRate,
        audioStart: res.audioStart,
        curve: res.curve,
      });
      this.project.tracks.push(created);
    }
    if (res.hits.length) {
      const drums = newTrack(this.project, {
        name: `Битбокс ${takes}`,
        kind: 'drums',
        instrumentId: 'drums',
        notes: quantizeNotes(res.hits, this.project.bpm, this.s.quantize).map((n) => ({ ...n, end: n.start + 0.1 })),
      });
      this.project.tracks.push(drums);
      created = created ?? drums;
    }
    if (!created) {
      toast('Ничего не записалось: проверь микрофон и порог тишины.', true);
    } else {
      this.selectedId = created.id;
      this.roll.reveal(created.notes);
      toast(`Готово: «${created.name}», нот: ${created.notes.length}`);
    }
    this.renderTracks();
    this.refreshTransport();
    this.scheduleSave();
  }

  private refreshTransport(): void {
    $('rec-btn').classList.toggle('on', this.recorder.recording);
    $('play-btn').classList.toggle('on', this.player.playing && !this.recorder.recording);
    $('play-btn').textContent = this.player.playing && !this.recorder.recording ? '❚❚' : '▶';
  }

  private renderTracks(): void {
    const root = $('tracks');
    if (!this.project.tracks.length) {
      root.replaceChildren(h('div', { className: 'empty', innerHTML: 'Пока нет дорожек. Нажми <b>●</b> (или клавишу R) и спой или сыграй мелодию: ноты появятся здесь.' }));
      return;
    }
    root.replaceChildren(...this.project.tracks.map((t) => this.trackRow(t)));
  }

  private trackRow(t: Track): HTMLElement {
    const row = h('div', { className: `track${t.id === this.selectedId ? ' selected' : ''}` });
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('input, select, button')) return;
      if (this.selectedId !== t.id) {
        this.selectedId = t.id;
        this.roll.selection.clear();
        this.roll.reveal(t.notes);
        this.renderTracks();
      }
    });
    const name = h('input', { className: 'track-name', type: 'text', value: t.name });
    name.addEventListener('change', () => {
      t.name = name.value || t.name;
      this.scheduleSave();
    });
    const dur = t.audio ? ` · голос ${fmtTime(t.audio.length / t.sampleRate)}` : '';
    const meta = h('div', { className: 'track-meta', textContent: `${t.notes.length} ${t.kind === 'drums' ? 'ударов' : 'нот'}${dur}` });

    let inst: HTMLElement;
    if (t.kind === 'drums') {
      inst = h('span', { className: 'hint', textContent: 'Барабаны (битбокс)' });
    } else {
      const sel = h('select');
      this.instrumentOptions(sel);
      sel.value = t.instrumentId;
      sel.addEventListener('change', () => {
        t.instrumentId = sel.value;
        this.loadInstrument(sel.value);
        this.scheduleSave();
        this.audition(t, t.notes[0]?.midi ?? 60);
      });
      inst = sel;
    }

    let mode: HTMLElement = h('span');
    if (t.kind === 'melody' && t.audio) {
      const sel = h('select');
      this.fillSelect(sel, PLAY_MODES.map((m) => ({ value: m.id, label: m.name })));
      sel.value = t.playMode;
      sel.addEventListener('change', async () => {
        t.playMode = sel.value as PlayMode;
        this.scheduleSave();
        if (t.playMode.includes('tuned') && !this.tuned.get(t, this.offlineTuneParams())) {
          toast('Применяю автотюн к записи…');
          await this.tuned.render(t, this.offlineTuneParams());
          toast('Автотюн готов: нажми ▶');
        }
      });
      mode = sel;
    }

    const vol = h('input', { type: 'range', min: '0', max: '1.2', step: '0.01', value: String(t.volume), title: 'Громкость' });
    vol.addEventListener('input', () => {
      t.volume = Number(vol.value);
      this.player.setTrackVolume(t);
    });
    vol.addEventListener('change', () => this.scheduleSave());

    const mute = h('button', { className: `btn ghost ms m${t.muted ? ' active' : ''}`, textContent: 'M', title: 'Заглушить' });
    mute.addEventListener('click', () => {
      t.muted = !t.muted;
      mute.classList.toggle('active', t.muted);
      this.player.refreshMix();
      this.scheduleSave();
    });
    const solo = h('button', { className: `btn ghost ms s${t.solo ? ' active' : ''}`, textContent: 'S', title: 'Соло' });
    solo.addEventListener('click', () => {
      t.solo = !t.solo;
      solo.classList.toggle('active', t.solo);
      this.player.refreshMix();
      this.scheduleSave();
    });

    const action = (label: string, title: string, fn: () => void) => {
      const b = h('button', { className: 'btn ghost', textContent: label, title });
      b.addEventListener('click', () => {
        fn();
        this.trackChanged(t);
      });
      return b;
    };
    const buttons = h('div', { className: 'track-btns' }, mute, solo);
    const tools = h('div', { className: 'track-btns' });
    tools.append(
      action('Квант.', 'Выровнять ноты по сетке (выбери сетку в «Квантизация»; без неё — 1/16)', () => {
        t.notes = quantizeNotes(t.notes, this.project.bpm, this.s.quantize || 16);
      }),
    );
    if (t.kind === 'melody') {
      tools.append(
        action('В тон.', 'Привязать ноты к выбранной тональности', () => (t.notes = snapNotesToScale(t.notes, currentMask(this.s)))),
        action('Чистка', 'Убрать случайные короткие ноты и склеить разрывы', () => (t.notes = cleanupNotes(t.notes))),
        action('−8ва', 'На октаву ниже', () => (t.notes = transposeNotes(t.notes, -12))),
        action('+8ва', 'На октаву выше', () => (t.notes = transposeNotes(t.notes, 12))),
      );
    }
    const del = h('button', { className: 'btn ghost danger', textContent: '✕', title: 'Удалить дорожку' });
    del.addEventListener('click', () => {
      if (!confirm(`Удалить «${t.name}»?`)) return;
      this.project.tracks = this.project.tracks.filter((x) => x !== t);
      this.tuned.drop(t.id);
      if (this.selectedId === t.id) this.selectedId = this.project.tracks[0]?.id ?? null;
      this.renderTracks();
      this.scheduleSave();
    });
    tools.append(del);

    const color = h('div', { className: 'track-color' });
    color.style.background = t.color;
    row.append(
      color,
      h('div', {}, name, meta),
      inst,
      mode,
      vol,
      buttons,
      tools,
    );
    return row;
  }

  private midiBytes(): Uint8Array | null {
    const tracks = this.project.tracks.filter((t) => t.notes.length);
    if (!tracks.length) return null;
    let ch = 1;
    const out: MidiFileTrack[] = tracks.map((t) => {
      if (t.kind === 'drums') return { name: t.name, channel: 10, program: null, notes: t.notes };
      if (ch === 10) ch++;
      const channel = Math.min(16, ch++);
      return { name: t.name, channel, program: getInstrument(t.instrumentId).gmProgram, notes: t.notes };
    });
    return writeMidiFile(out, this.project.bpm);
  }

  private exportMidi(): void {
    const bytes = this.midiBytes();
    if (!bytes) {
      toast('Нечего сохранять: сначала запиши что-нибудь.', true);
      return;
    }
    download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }), 'soundwave.mid');
  }

  private async exportWav(): Promise<void> {
    if (!this.project.tracks.length) {
      toast('Нечего сводить: сначала запиши что-нибудь.', true);
      return;
    }
    toast('Свожу трек в WAV…');
    try {
      const buf = await renderMix(this.project, this.io.sampleRate, this.tuned, this.offlineTuneParams());
      download(encodeWav(buf), 'soundwave.wav');
      toast('WAV готов');
    } catch (err) {
      toast(`Не получилось свести: ${(err as Error).message}`, true);
    }
  }

  private displayPitch = NaN;
  private displayNote = 0;
  private displayHeldAt = 0;

  /**
   * Calm tuner readout: light smoothing, a note name that only changes when the voice is
   * clearly on another note, and a short hold over breathy dropouts.
   */
  private smoothDisplayPitch(p: number): number {
    const now = performance.now();
    if (p === p) {
      this.displayPitch = this.displayPitch === this.displayPitch && Math.abs(p - this.displayPitch) < 1.5 ? this.displayPitch + (p - this.displayPitch) * 0.3 : p;
      this.displayHeldAt = now;
      if (Math.abs(this.displayPitch - this.displayNote) > 0.7) this.displayNote = Math.round(this.displayPitch);
    } else if (now - this.displayHeldAt > 250) {
      this.displayPitch = NaN;
    }
    return this.displayPitch;
  }

  /** One-line hint explaining why the live instrument may be silent. */
  private refreshLiveStatus(levelDb: number): void {
    let msg = '';
    const triggers = this.s.triggersEnabled;
    const inst = getInstrument(this.s.liveInstrument);
    if (!this.io.running) msg = 'Нажми «Включить микрофон» вверху справа.';
    else if (this.io.ctx.state !== 'running') msg = 'Браузер приостановил звук: кликни по странице.';
    else if (triggers) msg = 'Включены битбокс-триггеры, поэтому голос → ноты на паузе.';
    else if (performance.now() - this.lastVoicedAt > 1500 && levelDb > -75 && levelDb < this.s.gateDb + 3)
      msg = `Тихо: вход ${Math.round(levelDb)} дБ при пороге ${this.s.gateDb} дБ. Пой ближе к микрофону или понизь «Порог тишины» слева.`;
    else if (!this.s.liveSound) msg = 'Звук инструмента выключен: включи «Играть инструментом в колонках».';
    else if (inst.state() === 'loading') msg = `«${inst.name}» загружается, пока играет синтезатор.`;
    const el = $('live-status');
    if (el.textContent !== msg) el.textContent = msg;
    ($('live-status-btn') as HTMLButtonElement).hidden = !(this.io.running && triggers);
  }

  // -------------------------------------------------------------------------
  // Animation

  private frame(): void {
    requestAnimationFrame(() => this.frame());
    const tickNow = performance.now();
    if (tickNow - this.uiTick > 300) {
      this.uiTick = tickNow;
      this.refreshFl();
      const sum = this.capture.summary(this.lastFrame?.t ?? 0);
      $('cap-info').textContent = sum.notes
        ? `${sum.notes} нот · ${fmtTime(sum.seconds)}${this.s.quantize ? ' · при сохранении выровняется по сетке' : ''}`
        : 'Всё, что ты поёшь, записывается сюда само';
      $('cap-dot').classList.toggle('on', this.io.running && this.performer.active !== null);
    }
    const level = this.io.running ? this.listener.level : 0;
    const db = 20 * Math.log10(Math.max(level, 1e-5));
    $('level-meter').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    const mask = currentMask(this.s);

    if (this.tab === 'live') {
      const p = this.smoothDisplayPitch(this.io.running ? this.performer.pitch : NaN);
      const needle = $('cents-needle');
      if (p === p) {
        const n = this.displayNote;
        const cents = Math.max(-50, Math.min(50, Math.round((p - n) * 100)));
        $('note-big').textContent = noteNameRu(n);
        $('note-latin').textContent = noteName(n);
        $('note-hz').textContent = `${(this.s.a4 * Math.pow(2, (p - 69) / 12)).toFixed(1)} Гц`;
        needle.style.left = `${50 + cents}%`;
        needle.style.opacity = '1';
        needle.style.background = Math.abs(cents) < 10 ? '#22d3b0' : Math.abs(cents) < 25 ? '#ffb547' : '#ff5c6c';
        $('cents-val').textContent = `${cents > 0 ? '+' : ''}${cents} центов`;
      } else {
        needle.style.opacity = '0';
        $('cents-val').textContent = '';
        if (this.io.running) {
          $('note-big').textContent = '—';
          $('note-hz').textContent = '';
        }
      }
      if (this.performer.pitch === this.performer.pitch) this.lastVoicedAt = performance.now();
      this.refreshLiveStatus(db);
      const active = this.performer.active;
      $('chord-display').textContent = active ? active.notes.map((m) => noteName(m)).join(' · ') : '';
      this.keyboard.draw(active?.notes ?? [], p, mask);
      this.graph.draw(this.lastFrame?.t ?? 0, mask);
      const f = this.lastFrame;
      const envDb = f ? 20 * Math.log10(Math.max(f.rms, 1e-6)) : -100;
      ($('env-meter') as HTMLElement).style.width = `${Math.max(0, Math.min(100, ((envDb - this.s.gateDb) / (-6 - this.s.gateDb)) * 100))}%`;
      ($('timbre-meter') as HTMLElement).style.width = `${this.io.running ? this.listener.brightness * 100 : 0}%`;
    } else if (this.tab === 'studio') {
      this.roll.draw();
      $('time-display').textContent = fmtTime(this.player.position());
    } else if (this.tab === 'tune') {
      const st = this.io.autotuneStatus;
      const running = this.io.running && st.freq > 0;
      $('tune-in-note').textContent = running ? noteName(freqToMidi(st.freq, this.s.a4)) : '—';
      $('tune-out-note').textContent = running ? noteName(st.target) : '—';
      const shift = running ? st.shift : 0;
      const bar = $('tune-shift-bar');
      const w = Math.min(50, Math.abs(shift) * 50);
      bar.style.width = `${w}%`;
      bar.style.left = shift >= 0 ? '50%' : `${50 - w}%`;
      $('tune-shift-val').textContent = running ? `${shift > 0 ? '+' : ''}${Math.round(shift * 100)} центов` : this.io.running ? 'Спой ноту' : 'Включи микрофон';
    }
  }
}

// Expose for debugging in the console.
(window as unknown as { soundwave: App }).soundwave = new App();
