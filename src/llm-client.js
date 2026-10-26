// llm-client.js —— OpenAI 兼容 Chat Completions 客户端（直连模式专用，零依赖）
//
// 参考 astrbot 的 Provider 抽象：baseUrl + apiKey + model 三项即可接入任意
// OpenAI 兼容端点（DeepSeek 官方 / 硅基流动 / Ollama / vLLM / 中转站……）。
// 只做「一次请求」的收发与错误分类；对话循环（工具调用）在 direct-engine.js。
//
// 错误分类（error.code）供上层决定重试/提示：
//   AUTH     401/403 —— 凭据问题，不重试
//   RATE     429 —— 限流，可退避重试
//   SERVER   5xx —— 服务端错误，可重试
//   BAD     400/其他 —— 请求本身有问题，不重试
//   NETWORK 网络层失败（连接被拒/中断）—— 可重试
//   TIMEOUT 超时 —— 可重试
//   PARSE   响应体不是合法 JSON —— 可重试
import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function classifyHttp(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'BAD';
  return null;
}

/**
 * 发一次 chat/completions 请求（非流式）。
 * @param {object} opts
 * @param {string} opts.baseUrl       如 https://api.deepseek.com/v1（尾斜杠可带可不带）
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.messages      [{role, content, ...}]
 * @param {Array}  [opts.tools]       OpenAI function tools（[{type:'function',function:{name,description,parameters}}]）
 * @param {number} [opts.temperature] 默认 0.8
 * @param {number} [opts.maxTokens]   默认 2048
 * @param {number} [opts.timeoutMs]   默认 120000
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text:string|null, toolCalls:Array, usage:object|null, stopReason:string|null, raw:object}>}
 */
export function chatCompletions(opts) {
  const {
    baseUrl = '',
    apiKey = '',
    model = '',
    messages = [],
    tools = null,
    temperature = 0.8,
    maxTokens = 2048,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null
  } = opts;

  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('未配置 llm.provider.baseUrl'), { code: 'CONFIG' });
  if (!apiKey) throw Object.assign(new Error('未配置 llm.provider.apiKey'), { code: 'CONFIG' });
  if (!model) throw Object.assign(new Error('未配置 llm.provider.model'), { code: 'CONFIG' });
  if (!Array.isArray(messages) || messages.length === 0) throw Object.assign(new Error('messages 不能为空'), { code: 'BAD' });

  const url = new URL(`${base}/chat/completions`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error(`不支持的协议：${url.protocol}`), { code: 'CONFIG' });
  }
  const transport = url.protocol === 'https:' ? https : http;

  const body = JSON.stringify({
    model,
    messages,
    ...(Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
    temperature,
    max_tokens: maxTokens,
    stream: false
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const error = Object.assign(new Error('请求已中止'), { code: 'ABORTED' });
      req?.destroy(error);
      finish(error);
    };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`), { code: 'TIMEOUT' });
      req?.destroy(error);
      res?.destroy();
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${apiKey}`,
          ...(apiKey.toLowerCase().startsWith('sk-') ? {} : {}),
          'user-agent': 'qq-bridge/direct'
        },
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            finish(Object.assign(new Error('响应体过大，已中止'), { code: 'PARSE' }));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(Object.assign(error, { code: 'NETWORK' })));
        response.on('aborted', () => finish(Object.assign(new Error('响应中断'), { code: 'NETWORK' })));
        response.on('close', () => { if (!response.complete) finish(Object.assign(new Error('响应中断'), { code: 'NETWORK' })); });
        response.on('end', () => {
          if (settled) return;
          const status = response.statusCode || 0;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const kind = classifyHttp(status);
          if (kind) {
            const detail = parsed?.error?.message || parsed?.message || '';
            const message = `LLM API HTTP ${status}${detail ? `：${detail}` : ''}`;
            finish(Object.assign(new Error(message), { code: kind, status, detail }));
            return;
          }
          if (parsed && typeof parsed === 'object') {
            const choice = parsed.choices?.[0];
            const msg = choice?.message;
            const toolCalls = Array.isArray(msg?.tool_calls)
              ? msg.tool_calls.map((tc) => ({
                  id: String(tc.id || ''),
                  name: String(tc.function?.name || ''),
                  arguments: String(tc.function?.arguments || '{}')
                }))
              : [];
            resolve({
              text: typeof msg?.content === 'string' && msg.content ? msg.content : null,
              toolCalls,
              usage: parsed.usage ?? null,
              stopReason: choice?.finish_reason ?? null,
              raw: parsed
            });
            return;
          }
          finish(Object.assign(new Error('响应不是合法 JSON 结构'), { code: 'PARSE' }));
        });
      });
      req.on('error', (error) => finish(Object.assign(error, { code: 'NETWORK' })));
      req.end(body);
    } catch (error) {
      finish(Object.assign(error, { code: 'NETWORK' }));
    }
  });
}

/**
 * 解析模型返回的 tool_call arguments（容错：模型偶尔输出非严格 JSON）。
 * @returns {object|null}
 */
export function parseToolArguments(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch {}
  // 去掉 ```json 围栏后重试
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  return null;
}
