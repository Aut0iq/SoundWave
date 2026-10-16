// Audio graph: microphone capture, live autotune monitoring, instrument and master buses.

import captureUrl from './worklets/capture.worklet.ts?worker&url';
import autotuneUrl from './worklets/autotune.worklet.ts?worker&url';
import type { AutotuneParams, AutotuneStatus } from '../dsp/autotune';

export interface InputDevice {
  id: string;
  label: string;
}

export class AudioIO {
  readonly ctx: AudioContext;
  /** Everything audible goes through here. */
  readonly master: GainNode;
  /** Live instrument voices (voice -> instrument). */
  readonly liveBus: GainNode;
  /** Drum triggers. */
  readonly drumBus: GainNode;
  /** Studio playback. */
  readonly playBus: GainNode;
  readonly analyser: AnalyserNode;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private autotune: AudioWorkletNode | null = null;
  private monitor: GainNode;
  private workletsReady: Promise<void> | null = null;
  autotuneStatus: AutotuneStatus = { freq: 0, target: 0, shift: 0 };
  autotuneLatency = 0;
  onChunk: (frame: number, samples: Float32Array) => void = () => {};

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(limiter).connect(this.ctx.destination);
    this.liveBus = this.bus(0.8);
    this.drumBus = this.bus(0.9);
    this.playBus = this.bus(0.9);
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0;
    this.monitor.connect(this.master);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
  }

  private bus(gain: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.master);
    return g;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get running(): boolean {
    return this.stream !== null;
  }

  /** Total delay from scheduling a sound to hearing it, plus a typical input delay. */
  estimatedRoundTrip(): number {
    const out = (this.ctx.baseLatency || 0) + ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0);
    return out + 0.012;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  private loadWorklets(): Promise<void> {
    if (!this.workletsReady) {
      this.workletsReady = Promise.all([
        this.ctx.audioWorklet.addModule(captureUrl),
        this.ctx.audioWorklet.addModule(autotuneUrl),
      ]).then(() => undefined);
    }
    return this.workletsReady;
  }

  static async listInputs(): Promise<InputDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Микрофон ${i + 1}` }));
  }

  async startInput(deviceId?: string): Promise<void> {
    await this.resume();
    await this.loadWorklets();
    this.stopInput();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Music needs the raw signal: browser voice processing would mangle pitch and dynamics.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.ctx, 'sw-capture', { numberOfOutputs: 0 });
    this.capture.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => {
      this.onChunk(e.data.frame, e.data.samples);
    };
    this.source.connect(this.capture);
    this.source.connect(this.analyser);

    this.autotune = new AudioWorkletNode(this.ctx, 'sw-autotune', { outputChannelCount: [1] });
    this.autotune.port.onmessage = (e: MessageEvent<{ type: string } & AutotuneStatus & { samples: number }>) => {
      if (e.data.type === 'status') this.autotuneStatus = e.data;
      else if (e.data.type === 'latency') this.autotuneLatency = e.data.samples / this.sampleRate;
    };
    this.source.connect(this.autotune);
    this.autotune.connect(this.monitor);
  }

  stopInput(): void {
    this.source?.disconnect();
    this.capture?.disconnect();
    this.autotune?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.capture = null;
    this.autotune = null;
  }

  setAutotune(params: Partial<AutotuneParams>): void {
    this.autotune?.port.postMessage(params);
  }

  /** Hear yourself through the live autotune (use headphones to avoid feedback). */
  setMonitor(on: boolean, level = 1): void {
    this.monitor.gain.setTargetAtTime(on ? level : 0, this.ctx.currentTime, 0.02);
  }

  get deviceLabel(): string {
    return this.stream?.getAudioTracks()[0]?.label ?? '';
  }
}
