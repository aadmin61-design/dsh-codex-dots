import { ConversationTree, nodeKey } from '../lib/conversation-tree.mjs';

// Codex 与 DSH 共用的无依赖入口；JSON 从文件或 stdin 输入，避免 shell 引号破坏中文与路径。
const [action = 'list', project = process.cwd()] = process.argv.slice(2);
const tree = new ConversationTree(project);
let input = '';
if (action !== 'list') { for await (const part of process.stdin) input += part; }
const args = input ? JSON.parse(input) : {};
let result;
if (action === 'list') result = await tree.read();
else if (action === 'register') {
  if (!['codex', 'dsh'].includes(args.source) || !args.id) throw Error('register 需要 source=codex|dsh 和真实对话 id');
  result = await tree.sync([{ source: args.source, id: args.id, title: args.title || args.id }]);
  if (args.parentKey) result = await tree.link(nodeKey(args.source, args.id), args.parentKey, args.intent);
} else if (action === 'link') result = await tree.link(args.key, args.parentKey, args.intent);
else throw Error('用法：node conversation-tree.mjs list|register|link <项目目录>；写操作从 stdin 读取 JSON');
console.log(JSON.stringify(result, null, 2));
