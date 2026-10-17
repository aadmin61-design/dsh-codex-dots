#!/usr/bin/env node
// 命令行仅提供诊断与增量日志读取；任务执行必须走 DSH 的双重用户确认。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexClient } from '../lib/codex.mjs';
const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const root = option('root', path.join(os.homedir(), '.dsh/codex-dots/v2'));
const command = args[0];
try {
  if (['quota', 'models', 'probe'].includes(command)) {
    const c = new CodexClient();
    try {
      await c.open();
      console.log(JSON.stringify(command === 'quota' ? await c.quota() : command === 'models' ? await c.models() : { quota: await c.quota(), models: await c.models() }, null, 2));
    } finally { await c.close(); }
  } else if (command === 'list') {
    console.log(JSON.stringify(fs.existsSync(root) ? fs.readdirSync(root).filter(f => /^run-.*\.json$/.test(f)).map(f => {
      const r = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
      return { id: r.id, owner: r.owner, goal: r.goal, status: r.status };
    }) : [], null, 2));
  } else if (['status', 'watch'].includes(command)) {
    const id = option('id');
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('需要 --id <任务 UUID>');
    const file = path.join(root, `run-${id}.${command === 'status' ? 'json' : 'jsonl'}`);
    if (command === 'status') console.log(fs.readFileSync(file, 'utf8'));
    else {
      let offset = 0, pending = Buffer.alloc(0);
      const tick = () => {
        if (!fs.existsSync(file)) return;
        const size = fs.statSync(file).size;
        if (size < offset) { offset = 0; pending = Buffer.alloc(0); }
        if (size === offset) return;
        const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
        let read; try { read = fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
        offset += read; pending = Buffer.concat([pending, buffer.subarray(0, read)]);
        const end = pending.lastIndexOf(10);
        if (end >= 0) { process.stdout.write(pending.subarray(0, end + 1)); pending = pending.subarray(end + 1); }
      };
      tick(); if (args.includes('--follow')) setInterval(tick, 1000);
    }
  } else throw new Error('用法：codexctl.mjs probe|quota|models|list|status --id UUID|watch --id UUID [--follow] [--root DIR]。执行/调参请在 DSH 使用 dots_* 工具。');
} catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
