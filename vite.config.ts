import { defineConfig } from 'vite';
import { flBridge } from './server/flBridge';

export default defineConfig({
  server: { port: 5173 },
  worker: { format: 'es' },
  plugins: [flBridge()],
});
