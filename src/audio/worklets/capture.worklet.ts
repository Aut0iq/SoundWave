// Forwards microphone audio to the main thread in fixed-size chunks, tagged with the
// context frame of their first sample so recordings can be aligned with playback.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const currentFrame: number;

const CHUNK = 512;

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(CHUNK);
  private fill = 0;
  private startFrame = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const ch0 = channels[0];
    const n = ch0.length;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.startFrame = currentFrame + i;
      // Mix all input channels to mono.
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c][i];
      this.buf[this.fill++] = s / channels.length;
      if (this.fill === CHUNK) {
        this.port.postMessage({ frame: this.startFrame, samples: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(CHUNK);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('sw-capture', CaptureProcessor);
