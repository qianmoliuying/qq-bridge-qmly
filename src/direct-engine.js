// direct-engine.js —— 直连 LLM 会话引擎（双模式中的 direct 后端）
//
// 参考 astrbot 的 Provider + FunctionTool 设计：
// - 模型提供商（baseUrl/apiKey/model）由 bridge 注入的 getProvider() 实时读取；
// - 工具与 DSH 的 MCP 共用同一份定义（src/mcp-snowluma-safe.js 的 getToolDefs()），
//   直连模式以 OpenAI function calling 承载，执行仍走原 handler（环回桥接校验）。
// - 每轮动态上下文（记忆/好感/状态/时间）由 bridge 放进 user 内容块
//   （buildWakePromptV2 输出），稳定人格/规则放 system —— 参考 astrbot 文档建议，
//   动态内容不进 system_prompt，避免破坏模型服务端的提示词缓存、多烧 token。
//
// 本模块无 QQ/DSH 依赖，纯逻辑可独立测试（scripts/test-direct-engine.mjs）。
import { chatCompletions, parseToolArguments } from './llm-client.js';

const MAX_TOOL_ROUNDS_DEFAULT = 8;
const RETRY_CODES = new Set(['NETWORK', 'TIMEOUT', 'SERVER', 'RATE']);

function retryDelayMs(attempt) {
  // 指数退避：500ms / 1500ms / 4000ms
  return Math.min(500 * Math.pow(3, attempt - 1), 4000);
}

function toOpenAITools(defs) {
  return (defs || [])
    .filter((d) => d && typeof d.name === 'string' && d.name)
    .map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: String(d.description || ''),
        parameters: (d.parameters && typeof d.parameters === 'object') ? d.parameters : { type: 'object', properties: {} }
      }
    }));
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (!c || typeof c !== 'object') return '';
      if (c.type === 'text' || typeof c.text === 'string') return String(c.text ?? '');
      if (c.type === 'image') return '[图片]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * 创建直连会话引擎。
 * @param {object} deps
 * @param {() => {baseUrl:string, apiKey:string, model:string, temperature?:number, maxTokens?:number, timeoutMs?:number, maxToolRounds?:number}} deps.getProvider
 * @param {() => Array<{name:string, description:string, parameters:object, execute:Function>} deps.getTools  可空 → 不启用 function calling
 * @param {(name:string, args:object, ctx:{key:string}) => Promise<*>} deps.executeTool 工具执行器（bridge 注入）
 * @param {(key:string) => void} [deps.onReset] 会话重置钩子
 */
export function createDirectEngine(deps) {
  const { getProvider, getTools, executeTool, onReset } = deps || {};
  if (typeof getProvider !== 'function' || typeof executeTool !== 'function') {
    throw new Error('direct-engine: 缺少 getProvider / executeTool 依赖');
  }
  // 每会话的直连上下文（最近 N 轮）；DSH 会话上下文的本地替代。
  const histories = new Map(); // key -> [{role, content, toolCalls?}]

  function historyOf(key) {
    let h = histories.get(key);
    if (!h) {
      h = [];
      histories.set(key, h);
    }
    return h;
  }

  function clearHistory(key) {
    histories.delete(key);
    if (typeof onReset === 'function') onReset(key);
  }

  function trimHistory(key, maxTurns) {
    const h = historyOf(key);
    const limit = Math.max(2, maxTurns * 2);
    if (h.length > limit) h.splice(0, h.length - limit);
  }

  /**
   * 执行一轮直连对话。
   * @param {string} key
   * @param {object} req
   * @param {string|Array} [req.system]        稳定系统提示（角色/规则）
   * @param {string|Array} [req.userContent]   本轮用户内容（可含多模态块）
   * @param {object} [req.opts]                { fresh?:boolean 新会话（/reset）}
   * @returns {Promise<{text:string|null, toolRounds:number, usage:object|null, provider:object}>}
   */
  async function chat(key, req) {
    const provider = getProvider();
    const { system = '', userContent = '', opts = {} } = req || {};
    if (opts.fresh) clearHistory(key);
    const history = historyOf(key);
    const maxToolRounds = Math.max(1, Number(provider.maxToolRounds) || MAX_TOOL_ROUNDS_DEFAULT);
    const tools = typeof getTools === 'function' ? getTools() : null;
    const openaiTools = tools && Array.isArray(tools) && tools.length > 0 ? toOpenAITools(tools) : null;

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const m of history) messages.push({ ...m });
    messages.push({ role: 'user', content: userContent });

    let toolRounds = 0;
    let usage = null;
    let attempt = 0;
    let lastError = null;

    for (let round = 0; round <= maxToolRounds; round += 1) {
      attempt = 0;
      let response = null;
      // 每次请求做有限重试（网络/超时/5xx/429），凭据/参数类错误直接抛。
      while (true) {
        attempt += 1;
        try {
          response = await chatCompletions({
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model,
            messages,
            tools: openaiTools,
            temperature: provider.temperature,
            maxTokens: provider.maxTokens,
            timeoutMs: provider.timeoutMs
          });
          break;
        } catch (error) {
          lastError = error;
          const code = error?.code;
          if (RETRY_CODES.has(code) && attempt < 3) {
            await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
            continue;
          }
          throw error;
        }
      }
      if (response.usage) usage = response.usage;
      const calls = response.toolCalls || [];
      if (calls.length === 0) {
        // 收尾：把本轮 user/assistant 记入历史（工具轮不重复记）
        history.push({ role: 'user', content: userContent });
        history.push({ role: 'assistant', content: response.text ?? '' });
        trimHistory(key, Number(provider.historyTurns) || 6);
        return { text: response.text, toolRounds, usage, provider };
      }
      // 有工具调用：执行并回填
      toolRounds += 1;
      if (toolRounds >= maxToolRounds) {
        // 触顶：丢弃未完成回合，给模型一次「直接回答」的机会
        messages.push({ role: 'assistant', content: response.text ?? '' });
        messages.push({
          role: 'user',
          content: '工具调用次数已达上限。请忽略尚未完成的工具调用，直接基于现有信息用文字回答，不要再请求任何工具。'
        });
        continue;
      }
      const assistantMsg = { role: 'assistant', content: response.text ?? '', tool_calls: [] };
      calls.forEach((call, callIndex) => {
        assistantMsg.tool_calls.push({
          id: call.id || `call_${round}_${callIndex}`,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' }
        });
      });
      messages.push(assistantMsg);
      // 顺序执行工具（并行执行会破坏「后一个工具依赖前一个结果」的语义；多数是读操作）
      const toolResults = [];
      let callIdx = 0;
      for (const call of calls) {
        const args = parseToolArguments(call.arguments);
        let toolText;
        if (args === null) {
          toolText = `参数解析失败，原始参数：${String(call.arguments || '').slice(0, 200)}`;
        } else {
          try {
            const result = await executeTool(call.name, args, { key });
            if (result && typeof result === 'object') {
              if (typeof result.text === 'string') {
                toolText = result.text;
              } else if (Array.isArray(result.content)) {
                toolText = contentToText(result.content);
              } else {
                toolText = JSON.stringify(result);
              }
            } else {
              toolText = String(result ?? '');
            }
            if (!toolText) toolText = '（工具已执行，无返回内容）';
          } catch (error) {
            toolText = `工具执行失败：${error?.message ?? error}`;
          }
        }
        toolResults.push({
          tool_call_id: call.id || `call_${round}_${callIdx}`,
          content: toolText
        });
        callIdx += 1;
      }
      for (const tr of toolResults) {
        messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
      }
    }
    throw Object.assign(new Error('工具调用循环异常终止'), { code: 'TOOL_LOOP' });
  }

  return { chat, clearHistory, historyOf };
}
