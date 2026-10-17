// 使用宿主真实的 profile 解析器检查已安装插件；不启动模型、不改 profile。
const { createRequire, registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
async function main() {
  const anchor = path.join(process.argv[2], 'package.json');
  const hooks = registerHooks({ resolve(s, c, next) {
    return next(s, s.startsWith('@deepseek-ai/') ? { ...c, parentURL: pathToFileURL(anchor).href } : c);
  } });
  const { Context } = await import('@deepseek-ai/cordis');
  const { loadProfile, createRuntimeResolution, PluginPackages } = await import('@deepseek-ai/dsh-app-boot');
  hooks.deregister();
  const profile = loadProfile('dsh', 'desktop', anchor);
  const resolution = await createRuntimeResolution({ installAnchor: anchor, profile });
  const ctx = new Context();
  try {
    await ctx.plugin(PluginPackages, { resolution });
    const entry = createRequire(path.join(profile.dir, 'package.json')).resolve('@local/dsh-codex-dots');
    const plugin = await import(pathToFileURL(entry));
    console.log(JSON.stringify({ ok: true, entry, name: plugin.name }));
  } finally { await ctx.fiber.dispose(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
