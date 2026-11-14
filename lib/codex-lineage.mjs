import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { createInterface } from 'node:readline';

// 只解析 rollout 第一行 session_meta；不读取正文来猜测直接父节点。
export async function readRolloutMetadata(file) {
  const raw = fs.createReadStream(file, { highWaterMark: 4096 });
  const input = /\.(zst|zstd)$/.test(file) ? raw.pipe(zlib.createZstdDecompress()) : raw;
  const forwardError = e => input.destroy(e);
  if (input !== raw) raw.on('error', forwardError);
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const row = JSON.parse(line);
      return row.type === 'session_meta' ? row.payload : null;
    }
    return null;
  } finally { raw.destroy(); input.destroy(); }
}

export class CodexLineageReader {
  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) { this.home = home; this.cache = new Map(); }
  async inventory() {
    if (this.inventoryTask) return this.inventoryTask;
    if (this.files && Date.now() - this.listedAt <= 60000) return this.files;
    this.inventoryTask = (async () => {
      const files = [];
      for (const name of ['sessions', 'archived_sessions']) {
        const root = path.join(this.home, name);
        try { files.push(...(await fsp.readdir(root, { recursive: true })).filter(f => /\.jsonl(?:\.zst|\.zstd)?$/.test(f)).map(f => path.join(root, f))); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      this.files = files; this.listedAt = Date.now(); return files;
    })().finally(() => { this.inventoryTask = null; });
    return this.inventoryTask;
  }
  async read(id, preferredPath) {
    const read = async file => {
      let stat;
      try { stat = await fsp.stat(file); } catch(e) { if (e.code === 'ENOENT') return null; throw e; }
      const stamp = `${stat.size}:${stat.mtimeMs}`, old = this.cache.get(file);
      let meta = old?.stamp === stamp ? old.meta : await readRolloutMetadata(file);
      this.cache.set(file, { stamp, meta });
      // 文件名可能同时含父、子 ID，必须核对首行真正的会话 ID。
      return meta?.id === id ? meta : null;
    };
    if (preferredPath) for (const file of [preferredPath, preferredPath + '.zst', preferredPath + '.zstd']) {
      const meta = await read(file); if (meta) return meta;
    }
    for (const file of (await this.inventory()).filter(f => path.basename(f).includes(id))) {
      const meta = await read(file); if (meta) return meta;
    }
    return null;
  }
}
