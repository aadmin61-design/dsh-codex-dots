#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""只读抓取 Codex 当前终端状态栏；--show-limits 仅为本次进程显示额度项。
持久显示请在自己的 Codex 终端输入 /statusline 并勾选 rate limits。
主插件以 app-server 的结构化额度为准，不从旧终端滚屏推断余额。
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default=os.getcwd())
    parser.add_argument('--timeout', type=float, default=20)
    parser.add_argument('--show-limits', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    if args.timeout <= 0 or args.timeout > 120:
        parser.error('--timeout 必须在 (0,120] 秒之间')
    try:
        import pyte
        from winpty import PtyProcess
    except ImportError as error:
        print(json.dumps({'ok': False, 'error': str(error), 'requirements': 'requirements.txt（可选探针依赖，未自动安装）'}, ensure_ascii=False))
        return 2
    # 共用 Node 的发现逻辑，不写个人目录和固定 Codex 版本。
    node = shutil.which('node')
    if not node:
        raise RuntimeError('未找到现有 Node.js；不会自动安装')
    module = (pathlib.Path(__file__).resolve().parents[1] / 'lib' / 'codex.mjs').as_uri()
    code = 'import {resolveCodex} from ' + json.dumps(module) + '; console.log(resolveCodex());'
    binary = subprocess.check_output([node, '--input-type=module', '-e', code], text=True).strip()
    argv = [binary, '--no-daemon']
    if args.show_limits:
        argv += ['-c', 'tui.status_line=["five-hour-limit","weekly-limit"]']
    screen = pyte.Screen(160, 45)
    stream = pyte.Stream(screen)
    lock = threading.Lock()
    proc = None
    stop = threading.Event()
    try:
        proc = PtyProcess.spawn(subprocess.list2cmdline(argv), cwd=args.dir,
                                env={**os.environ, 'TERM': 'xterm-256color'}, dimensions=(45, 160))
        def read():
            # 真实 VT 解析保留当前屏幕，避免把旧的 90% 误当成最新额度。
            while not stop.is_set():
                try:
                    data = proc.read(8192)
                    with lock:
                        stream.feed(data)
                except Exception:
                    break
        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        deadline = time.monotonic() + args.timeout
        last = ''
        while time.monotonic() < deadline:
            with lock:
                last = '\n'.join(screen.display[-8:])
            if re.search(r'\b\d{1,3}%\s*left', last, re.I):
                break
            time.sleep(0.2)
        def percent(pattern):
            match = re.search(pattern, last, re.I)
            return int(match.group(1)) if match else None
        result = {'ok': bool(re.search(r'\b\d{1,3}%\s*left', last, re.I)),
                  'weekly_left_percent': percent(r'weekly\s*(\d{1,3})%\s*left'),
                  'five_hour_left_percent': percent(r'(?:5h|five.hour)\s*(\d{1,3})%\s*left'),
                  'status_bar': last.strip(), 'persisted_config_changed': False}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result['ok'] else 1
    finally:
        stop.set()
        if proc is not None:
            proc.terminate(force=True)
        if 'thread' in locals():
            thread.join(timeout=2)


if __name__ == '__main__':
    raise SystemExit(main())
