// ════════════════════════════════════════════════════════════════════════
//  一键版构建脚本（build.mjs）
//  产出：dist/一键版/ 便携目录
//    ├─ 一键启动.exe   ← Node SEA 打包的启动器（本机 node.exe 作模板注入）
//    ├─ runtime/       ← 便携 Node 运行时（node.exe 单文件即可跑 bridge）
//    ├─ bridge/        ← qq-bridge 完整源码 + node_modules + state + docs
//    ├─ logs/          ← 运行日志
//    └─ launcher-config.json ← 启动器配置（SnowLuma 路径等）
//  用法：node launcher/build.mjs [--skip-bridge-copy]
//  说明：复制 node_modules 体积较大，属一次性成本。
// ════════════════════════════════════════════════════════════════════════

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_DIR = path.join(ROOT, 'launcher');
const LAUNCHER = path.join(LAUNCHER_DIR, 'launcher.cjs');
const OUT_ROOT = path.join(ROOT, 'dist', '一键版');
const OUT_BRIDGE = path.join(OUT_ROOT, 'bridge');
const OUT_RUNTIME = path.join(OUT_ROOT, 'runtime');
const OUT_EXE = path.join(OUT_ROOT, '一键启动.exe');
const SEA_CFG = path.join(ROOT, 'launcher', 'sea-config.json');
const SEA_BLOB = path.join(ROOT, 'launcher', 'sea-prep.blob');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) { console.log(`\n[构建] ${msg}`); }
function checkOk(r, what) {
  if (r.status !== 0) { console.error(`[构建] 失败：${what}`); console.error(r.stderr?.toString?.() || r.error?.message || ''); process.exit(1); }
}

// 1. 前置检查
step('检查输入文件');
for (const f of [LAUNCHER, path.join(ROOT, 'package.json')]) {
  if (!fs.existsSync(f)) { console.error(`[构建] 缺少 ${f}`); process.exit(1); }
}
const nodeVer = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`  构建用 Node：${process.execPath} (${nodeVer})`);

// 2. 清空并组装便携目录
step('组装便携目录');
fs.rmSync(OUT_ROOT, { recursive: true, force: true });
fs.mkdirSync(OUT_RUNTIME, { recursive: true });
fs.mkdirSync(path.join(OUT_ROOT, 'logs'), { recursive: true });

// runtime/：复制本机 node.exe（与构建同版本 → SEA blob 可注入）
const nodeSrc = process.execPath;
fs.copyFileSync(nodeSrc, path.join(OUT_RUNTIME, 'node.exe'));
console.log(`  runtime/node.exe ← ${nodeSrc}`);

// bridge/：robocopy 整树复制（排除 .git / logs / dist / launcher / 运行数据之外的体积项）
// 注：不能用 fs.cpSync —— Node 拒绝把目录复制进自身子目录（目标 dist 在源内部）。
step('复制 bridge 整树（含 node_modules，体积较大）');
fs.mkdirSync(OUT_BRIDGE, { recursive: true });
const robocopy = spawnSync('robocopy', [
  ROOT, OUT_BRIDGE, '/E',
  '/XD', path.join(ROOT, '.git'), path.join(ROOT, 'logs'), path.join(ROOT, 'dist'), path.join(ROOT, 'launcher'),
  '/NFL', '/NDL', '/NJH', '/NJS',
], { encoding: 'utf8', timeout: 600000 });
// robocopy 退出码：0=无变更 1=成功复制 2=有额外文件 3=1+2 ... <8 均为成功；≥8 才是错误
if (robocopy.status >= 8 || robocopy.error) {
  console.error(`[构建] bridge 复制失败（robocopy exit ${robocopy.status}）：${robocopy.stderr?.slice(0, 500)}`);
  process.exit(1);
}
// 验证关键文件到位
const missing = [];
for (const rel of ['src/bridge.js', 'package.json']) {
  if (!fs.existsSync(path.join(OUT_BRIDGE, rel))) missing.push(rel);
}
// better-sqlite3 v13 原生库在 prebuilds/ 下（.node），递归找任一即可
const bs3 = path.join(OUT_BRIDGE, 'node_modules', 'better-sqlite3');
const bs3Native = fs.existsSync(bs3)
  ? fs.readdirSync(path.join(bs3, 'prebuilds'), { recursive: true }).find((f) => f.toString().endsWith('.node'))
  : null;
if (!bs3Native) missing.push('node_modules/better-sqlite3/prebuilds/*.node');
if (missing.length) { console.error(`[构建] bridge 关键文件缺失：${missing.join(', ')}`); process.exit(1); }
console.log('  bridge 整树复制完成');

// 3. 生成启动器配置模板
step('生成 launcher-config.json 模板');
const cfgPath = path.join(OUT_ROOT, 'launcher-config.json');
if (!fs.existsSync(cfgPath)) {
  fs.writeFileSync(cfgPath, JSON.stringify({ snowluma: { path: '', wsPort: 3001 } }, null, 2), 'utf8');
}

// 4. SEA 打包
step('SEA 打包启动器');
fs.writeFileSync(SEA_CFG, JSON.stringify({
  main: LAUNCHER,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
}, null, 2), 'utf8');
let r = spawnSync(process.execPath, ['--experimental-sea-config', SEA_CFG], { cwd: ROOT, encoding: 'utf8' });
checkOk(r, '生成 sea blob');
fs.copyFileSync(path.join(OUT_RUNTIME, 'node.exe'), OUT_EXE);
// Windows 下 npm/npx 是 .cmd 包装，spawnSync 不经 shell 时找不到 → shell:true
r = spawnSync('npx', ['--yes', 'postject', OUT_EXE, 'NODE_SEA_BLOB', SEA_BLOB, '--sentinel-fuse', FUSE],
  { cwd: ROOT, encoding: 'utf8', timeout: 120000, shell: true });
checkOk(r, 'postject 注入 blob');

// 5. 冒烟：--check
step('冒烟验证 exe --check');
r = spawnSync(OUT_EXE, ['--check'], { cwd: OUT_ROOT, encoding: 'utf8', timeout: 60000 });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
if (r.status !== 0) { console.error('[构建] --check 自检未通过'); process.exit(1); }

// 5.5 复制使用文档
step('复制使用文档');
fs.copyFileSync(path.join(LAUNCHER_DIR, 'README-一键启动.txt'), path.join(OUT_ROOT, 'README-一键启动.txt'));

// 6. 收尾
fs.rmSync(SEA_CFG, { force: true });
fs.rmSync(SEA_BLOB, { force: true });
console.log('\n[构建] 完成 ✓');
console.log(`  输出目录：${OUT_ROOT}`);
console.log(`  一键启动.exe：${OUT_EXE}`);
console.log('  使用：双击 一键启动.exe → 菜单 [1] 一键启动全部');
