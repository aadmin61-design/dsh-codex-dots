// 只读协议联调：列出项目页并读取指定测试对话，不启动任何模型轮次。
import { CodexClient } from '../lib/codex.mjs';
const client = new CodexClient();
try {
  await client.open();
  const page = await client.listThreads({ cwd: process.cwd(), limit: 5 });
  console.log(JSON.stringify({ page, quota: await client.quota() }));
  if (process.argv[2]) console.log(JSON.stringify({ thread: await client.readThread(process.argv[2], { limit: 2 }) }));
} finally { await client.close(); }
