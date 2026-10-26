// test-direct-engine.mjs —— 直连模式（llm-client + direct-engine）回归测试
// 离线：用本地 mock LLM 端点（OpenAI 兼容 chat/completions），不发任何真实请求。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { chatCompletions, parseToolArguments } = await import(new URL('../src/llm-client.js', import.meta.url));
const { createDirectEngine } = await import(new URL('../src/direct-engine.js', import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error?.message ?? error}`);
  }
}

// ── mock OpenAI 兼容端点 ────────────────────────────────────────────────
// responses: 数组，元素为 { status?, body(或按请求序生成函数) }
function startMockServer(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(bodyText); } catch {}
    calls.push({ path: req.url, body });
    const respond = await handler(calls.length - 1, body);
    if (respond.status && respond.status >= 400) {
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: respond.error || 'mock error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respond.body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        calls,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function textBody(text) {
  return {
    body: {
      id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  };
}
function toolBody(name, argsText, content = '') {
  return {
    body: {
      id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: argsText } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    }
  };
}

const provider = () => ({ baseUrl: '', apiKey: 'sk-test', model: 'mock-model', temperature: 0.8, maxTokens: 2048, timeoutMs: 5000, historyTurns: 6, maxToolRounds: 8 });

// ── 1. llm-client 基础 ──────────────────────────────────────────────────
{
  const mock = await startMockServer(() => textBody('你好'));
  try {
    const r = await chatCompletions({ baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'sk-test', model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    check('llm-client: 解析文本响应', () => {
      assert.equal(r.text, '你好');
      assert.equal(r.toolCalls.length, 0);
      assert.equal(r.usage.total_tokens, 15);
    });
    check('llm-client: 请求体形状正确', () => {
      const b = mock.calls[0].body;
      assert.equal(b.model, 'm');
      assert.equal(b.messages.length, 1);
      assert.equal(b.stream, false);
      assert.equal(typeof b.tools, 'undefined'); // 未传 tools 时不带
    });
  } finally { await mock.close(); }
}

{
  const mock = await startMockServer(() => toolBody('qq_memory_search', '{"key":"group:1","q":"生日"}'));
  try {
    const r = await chatCompletions({ baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'sk', model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'qq_memory_search', description: '', parameters: {} } }] });
    check('llm-client: 解析 tool_calls', () => {
      assert.equal(r.toolCalls.length, 1);
      assert.equal(r.toolCalls[0].name, 'qq_memory_search');
      assert.equal(r.toolCalls[0].id, 'call_1');
      assert.ok(r.toolCalls[0].arguments.includes('生日'));
    });
  } finally { await mock.close(); }
}

{
  const mock = await startMockServer(() => ({ status: 401, error: 'Invalid API key' }));
  try {
    await checkAsync('llm-client: 401 分类为 AUTH', async () => {
      try { await chatCompletions({ baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'bad', model: 'm', messages: [{ role: 'user', content: 'x' }] }); assert.fail('应当抛错'); }
      catch (e) { assert.equal(e.code, 'AUTH'); }
    });
  } finally { await mock.close(); }
}

{
  const mock = await startMockServer(() => ({ status: 429, error: 'rate limited' }));
  try {
    await checkAsync('llm-client: 429 分类为 RATE', async () => {
      try { await chatCompletions({ baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] }); assert.fail('应当抛错'); }
      catch (e) { assert.equal(e.code, 'RATE'); }
    });
  } finally { await mock.close(); }
}

{
  const mock = await startMockServer(() => ({ status: 500, error: 'boom' }));
  try {
    await checkAsync('llm-client: 500 分类为 SERVER', async () => {
      try { await chatCompletions({ baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] }); assert.fail('应当抛错'); }
      catch (e) { assert.equal(e.code, 'SERVER'); }
    });
  } finally { await mock.close(); }
}

{
  const mock = await startMockServer(() => ({ status: 200, body: 'not-json-at-all' }));
  try {
    await checkAsync('llm-client: 非 JSON 响应分类为 PARSE', async () => {
      try { await chatCompletions({ baseUrl: `http://127.0.0.1:${mock.port}`, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] }); assert.fail('应当抛错'); }
      catch (e) { assert.equal(e.code, 'PARSE'); }
    });
  } finally { await mock.close(); }
}

check('llm-client: parseToolArguments 容错', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments('```json\n{"a":2}\n```'), { a: 2 });
  assert.equal(parseToolArguments('not json {{{'), null);
  assert.deepEqual(parseToolArguments(''), {});
});

// ── 2. direct-engine 对话 ───────────────────────────────────────────────
{
  // 无工具单轮
  const mock = await startMockServer((i) => textBody('你好，我在'));
  const calls = [];
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => null,
    executeTool: async (name, args) => { calls.push([name, args]); return { text: 'ok' }; }
  });
  try {
    const out = await engine.chat('group:1', { system: '你是小鲸鱼', userContent: '在吗', opts: { fresh: true } });
    check('direct-engine: 无工具单轮返回文本', () => assert.equal(out.text, '你好，我在'));
    check('direct-engine: system 进第一条消息', () => {
      const m = mock.calls[0].body.messages;
      assert.equal(m[0].role, 'system');
      assert.equal(m[0].content, '你是小鲸鱼');
      assert.equal(m[1].role, 'user');
    });
    check('direct-engine: 工具未执行', () => assert.equal(calls.length, 0));
    check('direct-engine: 历史记录 user+assistant', () => {
      const h = engine.historyOf('group:1');
      assert.equal(h.length, 2);
      assert.equal(h[0].role, 'user');
      assert.equal(h[1].role, 'assistant');
    });
  } finally { await mock.close(); }
}

{
  // 工具循环：第 1 次 tool_calls → 执行 → 第 2 次最终文本
  let n = 0;
  const mock = await startMockServer(() => {
    n += 1;
    if (n === 1) return toolBody('qq_memory_search', '{"key":"group:1","q":"生日"}', '');
    return textBody('我记得他生日是 3 月。');
  });
  const executed = [];
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => [{ name: 'qq_memory_search', description: '搜记忆', parameters: { type: 'object', properties: { key: { type: 'string' }, q: { type: 'string' } } }, execute: async () => {} }],
    executeTool: async (name, args) => { executed.push([name, args]); return { text: '命中：[3月12日 生日]', isError: false }; }
  });
  try {
    const out = await engine.chat('group:2', { userContent: '记得我生日吗', opts: { fresh: true } });
    check('direct-engine: tool loop 返回最终文本', () => assert.equal(out.text, '我记得他生日是 3 月。'));
    check('direct-engine: toolRounds=1', () => assert.equal(out.toolRounds, 1));
    check('direct-engine: 工具被正确执行', () => {
      assert.equal(executed.length, 1);
      assert.equal(executed[0][0], 'qq_memory_search');
      assert.equal(executed[0][1].q, '生日');
    });
    check('direct-engine: tool 结果回填在请求里', () => {
      const second = mock.calls[1].body.messages;
      const toolMsg = second.find((m) => m.role === 'tool');
      assert.ok(toolMsg, '存在 tool 角色消息');
      assert.ok(toolMsg.content.includes('3月12日'));
      const assistantWithCalls = second.find((m) => m.role === 'assistant' && m.tool_calls);
      assert.ok(assistantWithCalls, '存在带 tool_calls 的 assistant 消息');
    });
    check('direct-engine: 历史只记最终轮', () => {
      const h = engine.historyOf('group:2');
      assert.equal(h.length, 2);
      assert.equal(h[1].content, '我记得他生日是 3 月。');
    });
  } finally { await mock.close(); }
}

{
  // executeTool 抛错 → 错误文本回填，仍能继续
  let n = 0;
  const mock = await startMockServer(() => {
    n += 1;
    if (n === 1) return toolBody('qq_status', '{}', '');
    return textBody('查询失败也没关系。');
  });
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => [{ name: 'qq_status', description: '状态', parameters: {} , execute: async () => {} }],
    executeTool: async () => { throw new Error('桥接拒绝'); }
  });
  try {
    const out = await engine.chat('group:3', { userContent: '查状态', opts: { fresh: true } });
    check('direct-engine: 工具抛错仍返回最终文本', () => assert.equal(out.text, '查询失败也没关系。'));
    check('direct-engine: 工具错误文本回填', () => {
      const m = mock.calls[1].body.messages.find((x) => x.role === 'tool');
      assert.ok(m.content.includes('桥接拒绝'));
    });
  } finally { await mock.close(); }
}

{
  // arguments 坏 JSON → 参数解析失败消息
  const mock = await startMockServer((i) => i === 0 ? toolBody('qq_memory_search', 'not-json{{{') : textBody('好'));
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => [{ name: 'qq_memory_search', description: '', parameters: {}, execute: async () => {} }],
    executeTool: async () => { throw new Error('不应被调用'); }
  });
  try {
    const out = await engine.chat('group:4', { userContent: 'x', opts: { fresh: true } });
    check('direct-engine: 坏参数不调工具、回填解析失败', () => {
      const m = mock.calls[1].body.messages.find((x) => x.role === 'tool');
      assert.ok(m.content.includes('参数解析失败'));
    });
    check('direct-engine: 坏参数仍收敛到最终文本', () => assert.equal(out.text, '好'));
  } finally { await mock.close(); }
}

{
  // fresh 语义：fresh=true 清历史；fresh=false 续上下文
  let n = 0;
  const mock = await startMockServer(() => { n += 1; return textBody('第' + n + '轮回复'); });
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => null,
    executeTool: async () => ({ text: 'ok' })
  });
  try {
    await engine.chat('group:5', { userContent: '第一句', opts: { fresh: true } });
    const firstCall = mock.calls[0].body.messages.map((m) => m.role).join(',');
    await engine.chat('group:5', { userContent: '第二句', opts: {} });
    const secondCall = mock.calls[1].body.messages;
    check('direct-engine: 第二轮携带历史', () => {
      assert.ok(secondCall.some((m) => m.content === '第一句'));
      assert.ok(secondCall.some((m) => m.content === '第1轮回复'));
      assert.equal(secondCall[secondCall.length - 1].content, '第二句');
    });
    await engine.chat('group:5', { userContent: '重新开始', opts: { fresh: true } });
    const thirdCall = mock.calls[2].body.messages;
    check('direct-engine: fresh=true 清空历史', () => {
      assert.ok(!thirdCall.some((m) => m.content === '第一句'));
      assert.equal(thirdCall[thirdCall.length - 1].content, '重新开始');
    });
    check('direct-engine: 第一轮请求无历史', () => assert.equal(firstCall, 'user'));
  } finally { await mock.close(); }
}

{
  // 会话隔离
  const mock = await startMockServer(() => textBody('ok'));
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => null,
    executeTool: async () => ({ text: 'ok' })
  });
  try {
    await engine.chat('group:a', { userContent: 'A 的话', opts: { fresh: true } });
    await engine.chat('group:b', { userContent: 'B 的话', opts: { fresh: true } });
    const bCall = mock.calls[1].body.messages;
    check('direct-engine: 会话历史互不影响', () => {
      assert.ok(!bCall.some((m) => m.content === 'A 的话'));
      assert.equal(bCall.length, 1);
    });
  } finally { await mock.close(); }
}

{
  // maxToolRounds 触顶：一直 tool_calls，直到触顶后给出直接回答机会
  const total = 9; // round1..8 全是 tool_calls，第 9 次（触顶提示后）返回文本
  let n = 0;
  const mock = await startMockServer(() => {
    n += 1;
    if (n < total) return toolBody('qq_status', '{}', '');
    return textBody('我不再调工具了。');
  });
  let executed = 0;
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => [{ name: 'qq_status', description: '', parameters: {}, execute: async () => {} }],
    executeTool: async () => { executed += 1; return { text: 'ok' }; }
  });
  try {
    const out = await engine.chat('group:6', { userContent: '开始', opts: { fresh: true } });
    check('direct-engine: 工具轮触顶收敛', () => {
      assert.equal(out.text, '我不再调工具了。');
      assert.equal(out.toolRounds, 8);      // 触顶=8 轮工具调用
      assert.equal(executed, 7);            // 第 8 轮被触顶拦截，未执行
    });
    check('direct-engine: 触顶时给了直接回答提示', () => {
      const m = mock.calls[total - 1].body.messages.find((x) => x.role === 'user' && typeof x.content === 'string' && x.content.includes('工具调用次数已达上限'));
      assert.ok(m, '触顶提示 user 消息存在');
    });
  } finally { await mock.close(); }
}

{
  // 重试：第一次 500 → 第二次成功（引擎内自动重试）
  let n = 0;
  const mock = await startMockServer(() => {
    n += 1;
    if (n === 1) return { status: 500, error: 'temporary' };
    return textBody('重试成功');
  });
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => null,
    executeTool: async () => ({ text: 'ok' })
  });
  try {
    const out = await engine.chat('group:7', { userContent: 'x', opts: { fresh: true } });
    check('direct-engine: 500 自动重试后成功', () => assert.equal(out.text, '重试成功'));
  } finally { await mock.close(); }
}

{
  // AUTH 错误不重试、直接抛
  let n = 0;
  const mock = await startMockServer(() => { n += 1; return { status: 401, error: 'bad key' }; });
  const engine = createDirectEngine({
    getProvider: () => ({ ...provider(), baseUrl: `http://127.0.0.1:${mock.port}` }),
    getTools: () => null,
    executeTool: async () => ({ text: 'ok' })
  });
  try {
    await checkAsync('direct-engine: AUTH 不重试直接抛', async () => {
      try { await engine.chat('group:8', { userContent: 'x', opts: { fresh: true } }); assert.fail('应当抛错'); }
      catch (e) { assert.equal(e.code, 'AUTH'); }
    });
    check('direct-engine: AUTH 只请求一次', () => assert.equal(n, 1));
  } finally { await mock.close(); }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const logPath = path.join(os.tmpdir(), 'test-direct-engine-result.txt');
fs.writeFileSync(logPath, JSON.stringify({ passed, failed, failures }, null, 2), 'utf8');
console.log(`direct-engine: passed=${passed} failed=${failed}`);
if (failed > 0) console.log(failures.join('\n'));
process.exit(failed > 0 ? 1 : 0);
