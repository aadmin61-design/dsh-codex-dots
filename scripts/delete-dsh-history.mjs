import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 仅处理已双重确认的清单；不递归扫描项目，不触碰项目代码目录。
export async function eraseDshHistory(job) {
  const root = await fs.realpath(job.root), removed = [], errors = [];
  for (const target of job.targets) {
    try {
      let dir;
      try { dir = await fs.realpath(target.dir); }
      catch (e) { if (e.code !== 'ENOENT') throw e; dir = path.resolve(target.dir); }
      const relative = path.relative(root, dir), parts = relative.split(path.sep);
      if (path.isAbsolute(relative) || parts.length !== 2 || parts.includes('..') || path.basename(dir) !== target.id || /[\\/]/.test(target.id)) throw Error('拒绝删除会话存储之外的路径');
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(path.join(job.project, '.dsh-codex-dots', 'history', target.id + '.json'), { force: true });
      removed.push(target.id);
    } catch (e) { errors.push(target.id + '：' + e.message); }
  }
  // 清理宿主派生的全文检索记录，避免日志删除后仍能搜索到旧正文。
  if (job.searchIndex && job.searchIndex !== ':memory:' && removed.length) {
    try {
      await fs.access(job.searchIndex);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(job.searchIndex);
      try {
        db.exec('PRAGMA busy_timeout = 5000; BEGIN');
        for (const id of removed) {
          db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id);
          db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id);
        }
        db.exec('COMMIT');
      } finally { db.close(); }
    } catch (e) { if (e.code !== 'ENOENT') errors.push('清理检索缓存：' + e.message); }
  }
  return { status: errors.length ? 'error' : 'completed', removed, errors, finishedAt: Date.now() };
}

export async function runDeletion(file) {
  const job = JSON.parse(await fs.readFile(file, 'utf8'));
  const alive = () => { try { process.kill(job.parentPid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
  // 不抢占运行中的 DSH 日志句柄；完全退出后再清理，用户随后重新启动。
  while (alive()) await new Promise(resolve => setTimeout(resolve, 500));
  const result = await eraseDshHistory(job);
  await fs.writeFile(file, JSON.stringify({ ...job, ...result }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDeletion(process.argv[2]).catch(async error => {
    const file = process.argv[2];
    const job = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...job, status: 'error', errors: [error.message] }, null, 2));
    process.exitCode = 1;
  });
}
