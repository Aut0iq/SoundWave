// Live autotune: wraps AutotuneEngine for the audio thread.

import { AutotuneEngine, type AutotuneParams } from '../../dsp/autotune';

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

class AutotuneProcessor extends AudioWorkletProcessor {
  private engine = new AutotuneEngine(sampleRate);
  private mono = new Float32Array(128);
  private blocks = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Partial<AutotuneParams>>) => this.engine.setParams(e.data);
    this.port.postMessage({ type: 'latency', samples: this.engine.latency });
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const n = output[0].length;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    this.mono.fill(0);
    if (input && input.length) {
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < n; i++) this.mono[i] += ch[i] / input.length;
      }
    }
    this.engine.process(this.mono, output[0]);
    for (let c = 1; c < output.length; c++) output[c].set(output[0]);

    if (++this.blocks % 8 === 0) this.port.postMessage({ type: 'status', ...this.engine.status });
    return true;
  }
}

registerProcessor('sw-autotune', AutotuneProcessor);
