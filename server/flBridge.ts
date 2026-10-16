// Dev-server endpoints that let the browser app reach FL Studio on this PC:
// install the controller script, start loopMIDI, and save MIDI takes into FL's browser.

import type { Connect, Plugin } from 'vite';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_NAME = 'device_SoundWave.py';
const LOOPMIDI_CANDIDATES = [
  'C:\\Program Files (x86)\\Tobias Erichsen\\loopMIDI\\loopMIDI.exe',
  'C:\\Program Files\\Tobias Erichsen\\loopMIDI\\loopMIDI.exe',
];

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function regValues(key: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (process.platform !== 'win32') return out;
  for (const line of (await run('reg', ['query', key])).split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{2,}REG_\w+\s{2,}(.*)$/.exec(line);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

async function isRunning(image: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const out = await run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']);
  return out.toLowerCase().includes(image.toLowerCase());
}

interface FlPaths {
  exe: string | null;
  userData: string;
  scriptDir: string;
  captures: string;
}

async function flPaths(): Promise<FlPaths> {
  const reg = await regValues('HKCU\\SOFTWARE\\Image-Line\\Shared\\Paths');
  const shared = reg['Shared data'] || path.join(os.homedir(), 'Documents', 'Image-Line');
  const userData = path.join(shared, 'FL Studio');
  const exe = reg['FL Studio'] && existsSync(reg['FL Studio']) ? reg['FL Studio'] : null;
  return {
    exe,
    userData,
    scriptDir: path.join(userData, 'Settings', 'Hardware', 'SoundWave'),
    // "Recorded" is one of FL's default browser folders, so takes show up there.
    captures: path.join(userData, 'Audio', 'Recorded', 'SoundWave'),
  };
}

function loopMidiExe(): string | null {
  return LOOPMIDI_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Only the SoundWave page itself may call these endpoints. */
function trusted(req: IncomingMessage): boolean {
  if (req.headers['x-soundwave'] !== '1') return false;
  const origin = req.headers.origin;
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeName(name: string): string {
  const base = name.replace(/\.mid$/i, '').replace(/[^\p{L}\p{N} _.-]+/gu, '_').trim().slice(0, 80) || 'soundwave';
  return `${base}.mid`;
}

async function scriptState(p: FlPaths, source: string): Promise<'missing' | 'outdated' | 'installed'> {
  try {
    const installed = await fs.readFile(path.join(p.scriptDir, SCRIPT_NAME), 'utf8');
    const bundled = await fs.readFile(source, 'utf8');
    return installed.replace(/\r\n/g, '\n') === bundled.replace(/\r\n/g, '\n') ? 'installed' : 'outdated';
  } catch {
    return 'missing';
  }
}

export function flBridge(): Plugin {
  const source = path.resolve(process.cwd(), 'fl', SCRIPT_NAME);

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    if (!trusted(req)) return json(res, 403, { error: 'forbidden' });

    void (async () => {
      try {
        const p = await flPaths();
        if (req.method === 'GET' && url.pathname === '/api/fl/status') {
          const loop = loopMidiExe();
          return json(res, 200, {
            platform: process.platform,
            flInstalled: p.exe !== null || existsSync(p.userData),
            flRunning: await isRunning('FL64.exe'),
            script: await scriptState(p, source),
            scriptDir: p.scriptDir,
            captures: p.captures,
            loopMidiInstalled: loop !== null,
            loopMidiRunning: await isRunning('loopMIDI.exe'),
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/fl/install-script') {
          await fs.mkdir(p.scriptDir, { recursive: true });
          await fs.copyFile(source, path.join(p.scriptDir, SCRIPT_NAME));
          return json(res, 200, { ok: true, path: path.join(p.scriptDir, SCRIPT_NAME) });
        }
        if (req.method === 'POST' && url.pathname === '/api/fl/start-loopmidi') {
          const exe = loopMidiExe();
          if (!exe) return json(res, 404, { error: 'loopMIDI не установлен' });
          if (!(await isRunning('loopMIDI.exe'))) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/fl/open') {
          if (!p.exe) return json(res, 404, { error: 'FL Studio не найден' });
          if (!(await isRunning('FL64.exe'))) spawn(p.exe, [], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/fl/save-midi') {
          const body = await readBody(req, 10 * 1024 * 1024);
          if (body.length < 14 || body.subarray(0, 4).toString('latin1') !== 'MThd') return json(res, 400, { error: 'not a MIDI file' });
          await fs.mkdir(p.captures, { recursive: true });
          const file = path.join(p.captures, safeName(url.searchParams.get('name') ?? 'soundwave'));
          await fs.writeFile(file, body);
          return json(res, 200, { ok: true, path: file });
        }
        if (req.method === 'POST' && url.pathname === '/api/fl/reveal') {
          await fs.mkdir(p.captures, { recursive: true });
          spawn('explorer.exe', [p.captures], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'unknown endpoint' });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
  };

  return {
    name: 'soundwave-fl-bridge',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
