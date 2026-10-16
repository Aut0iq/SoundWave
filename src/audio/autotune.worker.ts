// Offline autotune rendering off the main thread.

import { renderAutotune, type AutotuneParams } from '../dsp/autotune';

interface Job {
  id: number;
  data: Float32Array;
  sampleRate: number;
  params: Partial<AutotuneParams>;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, data, sampleRate, params } = e.data;
  const out = renderAutotune(data, sampleRate, params).slice();
  (self as unknown as Worker).postMessage({ id, out }, [out.buffer]);
};
