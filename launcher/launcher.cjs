// ════════════════════════════════════════════════════════════════════════
//  大肥鱼 QQ↔DSH 一键启动器（launcher.cjs）
//  单文件自包含（SEA 硬约束：打包后 exe 只运行本文件，不能 require 兄弟模块）
//  职责：探测/引导 DSH Web API 与 SnowLuma → 启动 qq-bridge → 统一日志 → 汉化菜单
//  合规边界（用户已拍板）：SnowLuma 只探测+引导（不打包、不复制本体；
//  仅在用户配置了启动器路径后由本程序拉起）；DSH 只探测 3080，未运行则引导手动开启。
//  构建：launcher/build.mjs 用 Node SEA 打包成 exe。
//  注意：Node 22 的 SEA 加载器走 CJS（embedderRunCjs），入口必须用 .cjs。
// ════════════════════════════════════════════════════════════════════════

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

// ── 常量区 ─────────────────────────────────────────────────────────────
const EXE_DIR = path.dirname(process.execPath);            // exe 所在目录 = 便携根
const BRIDGE_DIR = resolveBridgeDir();
const RUNTIME_NODE = process.env.QQ_BRIDGE_NODE || path.join(EXE_DIR, 'runtime', 'node.exe');
const LOG_DIR = path.join(EXE_DIR, 'logs');
const CFG_FILE = path.join(EXE_DIR, 'launcher-config.json');
const DSH_STATUS_URL = 'http://127.0.0.1:3080/api/status'; // DSH Web API 探活端点
const DSH_WS_PORT = 3001;                                   // SnowLuma OneBot WS 端口（默认）
const DSH_HTTP_PORT = 3000;                                 // SnowLuma OneBot HTTP 端口（默认）
const APP_TITLE = '大肥鱼 QQ↔DSH 一键启动器';
const VERSION = '1.0.0';

// 子进程句柄
let bridgeProc = null;

function resolveBridgeDir() {
  const near = path.join(EXE_DIR, 'bridge');
  if (fs.existsSync(path.join(near, 'package.json'))) return near;
  if (fs.existsSync(path.join(EXE_DIR, 'package.json'))) return EXE_DIR; // exe 直接放项目根时
  return near; // 不存在也没关系，启动时给明确报错
}

// ── 基础工具 ───────────────────────────────────────────────────────────
const log = {
  _write(tag, msg) {
    const line = `[${ts()}] [${tag}] ${msg}`;
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'launcher.log'), line + '\n', 'utf8'); } catch {}
    console.log(line);
  },
  info: (m) => log._write('启动器', m),
  ok: (m) => log._write('OK', `✓ ${m}`),
  warn: (m) => log._write('注意', `⚠ ${m}`),
  err: (m) => log._write('错误', `✗ ${m}`),
};

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** TCP 端口探测：返回端口是否已监听 */
function isPortUp(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

/** HTTP 探活：DSH Web API 是否可用（GET /api/status） */
async function isDshUp() {
  try {
    const res = await fetch(DSH_STATUS_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

/** 等待某个条件成立（默认最长 60 秒，每 2 秒轮询） */
async function waitFor(desc, check, maxSec = 60) {
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ── 配置 ───────────────────────────────────────────────────────────────
function loadConfig() {
  const cfg = readJson(CFG_FILE, {});
  cfg.snowluma = cfg.snowluma ?? {};
  cfg.snowluma.path = cfg.snowluma.path ?? '';
  cfg.snowluma.wsPort = cfg.snowluma.wsPort ?? DSH_WS_PORT;
  cfg.bridge = cfg.bridge ?? {};
  return cfg;
}

function saveConfig(cfg) { writeJson(CFG_FILE, cfg); }

/** 从 bridge/config.json 回退读取 SnowLuma 线索（用户旧配置里可能有 launcherPath/homeDir） */
function readBridgeSnowLumaHints() {
  const bc = readJson(path.join(BRIDGE_DIR, 'config.json'), null);
  if (bc?.snowluma) return { path: bc.snowluma.launcherPath || '', homeDir: bc.snowluma.homeDir || '' };
  return { path: '', homeDir: '' };
}

// ── SnowLuma 探测与引导 ────────────────────────────────────────────────
function snowLumaExeCandidates(cfg) {
  const list = [];
  if (cfg.snowluma.path) list.push(cfg.snowluma.path);
  const hints = readBridgeSnowLumaHints();
  if (hints.path) list.push(hints.path);
  if (hints.homeDir) list.push(hints.homeDir);
  return list.filter(Boolean);
}

/** 解析 SnowLuma 启动目标：exe 直接可用；目录则找 SnowLuma*.exe / launcher*.exe */
function resolveSnowLumaLaunch(cfg) {
  for (const p of snowLumaExeCandidates(cfg)) {
    if (fs.existsSync(p)) {
      if (fs.statSync(p).isFile() && p.toLowerCase().endsWith('.exe')) return p;
      if (fs.statSync(p).isDirectory()) {
        const found = fs.readdirSync(p).filter((n) => /^(snowluma|launcher).*\.exe$/i.test(n));
        if (found.length === 1) return path.join(p, found[0]);
      }
    }
  }
  return null;
}

/** 判断 SnowLuma 是否已在运行（WS 端口） */
function snowLumaUp(cfg) { return isPortUp(cfg.snowluma.wsPort ?? DSH_WS_PORT); }

/** 拉起 SnowLuma（仅当用户已配置启动器路径；未配置则只提示） */
async function startSnowLuma(cfg) {
  if (await snowLumaUp(cfg)) { log.ok(`SnowLuma 已在运行（WS :${cfg.snowluma.wsPort ?? DSH_WS_PORT}）`); return true; }
  const target = resolveSnowLumaLaunch(cfg);
  if (!target) {
    log.warn('未找到 SnowLuma 启动器（本版不打包 SnowLuma，合规边界）。请手动启动它，或在菜单 [3] 配置其 exe 路径。');
    return false;
  }
  log.info(`正在拉起 SnowLuma 启动器：${target}`);
  const p = spawn(target, [], { cwd: path.dirname(target), detached: true, stdio: 'ignore' });
  p.unref();
  return waitFor('SnowLuma 端口就绪', () => snowLumaUp(cfg), 45);
}

// ── DSH 探测与引导 ─────────────────────────────────────────────────────
async function startDsh() {
  if (await isDshUp()) { log.ok('DSH Web API 已连接（127.0.0.1:3080）'); return true; }
  log.warn('DSH Web API（3080）未就绪。请先打开 DeepSeek Harness 桌面版（或运行 `dsh web`），本程序会自动等待其就绪。');
  return waitFor('DSH Web API 就绪', isDshUp, 90);
}

// ── 桥接启动/停止 ──────────────────────────────────────────────────────
let nodeResolved = null;
function findNode() {
  if (nodeResolved) return nodeResolved;
  if (fs.existsSync(RUNTIME_NODE)) { nodeResolved = RUNTIME_NODE; return nodeResolved; }
  const r = spawnSync('node', ['--version'], { encoding: 'utf8', timeout: 8000 });
  if (r.status === 0) { nodeResolved = 'node'; return nodeResolved; }
  return null;
}

function ensureBridgeConfig() {
  const cfgPath = path.join(BRIDGE_DIR, 'config.json');
  if (fs.existsSync(cfgPath)) return true;
  const example = path.join(BRIDGE_DIR, 'config.example.json');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, cfgPath);
    log.warn('bridge/config.json 不存在，已从 config.example.json 生成。首次使用前请按需修改（QQ 号/token/DSH 地址等）。');
    return true;
  }
  return false;
}

function startBridge() {
  if (bridgeProc) { log.warn('桥接已在运行'); return; }
  const node = findNode();
  if (!node) { log.err('找不到 Node 运行时（便携 runtime/node.exe 或系统 node 都没有）。请安装 Node ≥22 或保持 runtime 目录完整。'); return; }
  if (!ensureBridgeConfig()) { log.err(`找不到 ${path.join(BRIDGE_DIR, 'config.json')}，且无示例配置可生成。`); return; }
  log.info(`启动桥接：${node} src/bridge.js（工作目录 ${BRIDGE_DIR}）`);
  const p = spawn(node, ['src/bridge.js'], {
    cwd: BRIDGE_DIR,
    env: { ...process.env, QQ_BRIDGE_LAUNCHED_BY: EXE_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bridgeLog = fs.createWriteStream(path.join(LOG_DIR, 'bridge.log'), { flags: 'a' });
  p.stdout.on('data', (d) => { bridgeLog.write(d); process.stdout.write(`[bridge] ${d}`); });
  p.stderr.on('data', (d) => { bridgeLog.write(d); process.stderr.write(`[bridge] ${d}`); });
  p.on('exit', (code, sig) => {
    log.warn(`桥接已退出（code=${code} signal=${sig ?? '-'}）。可在菜单重新启动；日志见 logs/bridge.log`);
    bridgeProc = null;
  });
  bridgeProc = p;
}

function stopBridge() {
  if (!bridgeProc) { log.warn('桥接未在运行'); return; }
  log.info('正在停止桥接…');
  bridgeProc.kill(); // Windows 下为 TerminateProcess，配合 bridge 的 start.bat 守护习惯，本启动器单实例管理
  bridgeProc = null;
}

// ── 状态汇总 ───────────────────────────────────────────────────────────
async function statusLine(cfg) {
  const dsh = await isDshUp();
  const sl = await snowLumaUp(cfg);
  return {
    dsh: dsh ? '已连接 ✓' : '未就绪 ✗',
    snowLuma: sl ? `运行中 ✓（WS :${cfg.snowluma.wsPort ?? DSH_WS_PORT}）` : (resolveSnowLumaLaunch(cfg) ? '已配置但未运行' : '未配置/未运行'),
    bridge: bridgeProc ? '运行中 ✓' : '已停止',
    node: findNode() ? (findNode() === 'node' ? '系统 node ✓' : '便携 runtime ✓') : '未找到 ✗',
  };
}

// ── 交互菜单 ───────────────────────────────────────────────────────────
function ask(rl, q) { return new Promise((r) => rl.question(q, r)); }

async function configureSnowLuma(rl, cfg) {
  console.log('┌─ 配置 SnowLuma 启动器路径 ────────────────');
  console.log('│ 说明：SnowLuma 由你自行安装（本版不打包）。');
  console.log('│ 输入其启动器 exe 的完整路径，或留空返回。');
  console.log(`│ 当前：${cfg.snowluma.path || '(未配置)'}`);
  console.log('└────────────────────────────────────────────');
  const ans = (await ask(rl, '路径 > ')).trim();
  if (!ans) { log.info('保持原配置'); return; }
  if (!fs.existsSync(ans)) { log.err('路径不存在，未保存'); return; }
  cfg.snowluma.path = ans;
  saveConfig(cfg);
  log.ok(`已保存 SnowLuma 路径：${ans}`);
}

async function menu() {
  const cfg = loadConfig();
  console.log(`\n═══════ ${APP_TITLE} v${VERSION} ═══════`);
  const s = await statusLine(cfg);
  console.log(`  DSH Web API    ：${s.dsh}`);
  console.log(`  SnowLuma       ：${s.snowLuma}`);
  console.log(`  桥接进程       ：${s.bridge}`);
  console.log(`  Node 运行时    ：${s.node}`);
  console.log('──────────────────────────────────────────────');
  console.log('  [1] 一键启动全部（DSH → SnowLuma → 桥接）');
  console.log('  [2] 仅启动桥接（DSH/SnowLuma 已就绪时）');
  console.log('  [3] 配置 SnowLuma 启动器路径');
  console.log('  [4] 打开日志目录');
  console.log('  [5] 停止桥接');
  console.log('  [0] 退出');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await ask(rl, '\n请选择 > ');
  rl.close();
  switch (choice.trim()) {
    case '1': {
      await startDsh();
      await startSnowLuma(cfg);
      startBridge();
      break;
    }
    case '2': startBridge(); break;
    case '3': {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      await configureSnowLuma(rl2, cfg);
      rl2.close();
      break;
    }
    case '4': {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      spawn('explorer.exe', [LOG_DIR], { detached: true, stdio: 'ignore' }).unref();
      break;
    }
    case '5': stopBridge(); break;
    case '0': stopBridge(); console.log('再见。'); return false;
    default: log.warn('无效选择');
  }
  return true;
}

// ── 入口 ───────────────────────────────────────────────────────────────
async function main() {
  // 设置控制台 UTF-8，避免中文乱码
  try { spawnSync('chcp.com', ['65001'], { stdio: 'ignore' }); } catch {}
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const cfg = loadConfig();
    const s = await statusLine(cfg);
    console.log(`EXE 目录     ：${EXE_DIR}`);
    console.log(`桥接目录     ：${BRIDGE_DIR}（${fs.existsSync(path.join(BRIDGE_DIR, 'package.json')) ? '有效' : '缺失!'}）`);
    console.log(`便携 node    ：${fs.existsSync(RUNTIME_NODE) ? RUNTIME_NODE : '缺失(将回退系统 node)'}`);
    console.log(`启动器配置   ：${fs.existsSync(CFG_FILE) ? CFG_FILE : '(未生成)'}`);
    console.log(`DSH          ：${s.dsh}`);
    console.log(`SnowLuma     ：${s.snowLuma}`);
    console.log(`Node         ：${s.node}`);
    const allOk = fs.existsSync(path.join(BRIDGE_DIR, 'package.json')) && s.node !== '未找到 ✗';
    console.log(allOk ? '\n自检：通过 ✓' : '\n自检：存在缺口（详见上方）');
    process.exit(allOk ? 0 : 1);
  }

  console.log(`${APP_TITLE} v${VERSION}`);
  console.log(`便携根目录：${EXE_DIR}`);
  while (await menu()) {}
}

main().catch((e) => { console.error('启动器异常：', e); process.exit(1); });
