// personality.js — 对话者性格分析（规则统计初判 + AI 补判精修）。
//
// 需求：为每个对话者打性格标签 → 入库；写上下文时携带「好感度 + 性格判断」，
// 让 AI 对聊天者做出合理倾向（语气/深度/分寸）。
//
// 成本控制（与「最少 token」一致）：
//   · 规则初判零成本：从发言统计（条数/长度/表情/提问/时段/情绪词）提取粗标签；
//   · AI 补判节流：每成员每 24h 至多 1 次，且样本不足时不触发；
//   · 上下文只携带一行紧凑格式（名字 + 好感 + 性格标签 + 倾向提示）。
//
// 纯引擎：输入 member 状态对象（含 stats 统计字段），输出标签/倾向；不直接碰 IO。

import { POSITIVE_WORDS, NEGATIVE_WORDS } from './memory-core.js';

// ── 性格标签词表（可枚举；AI 补判从此表选，也可补充自定义词）────────────────
export const PERSONALITY_GROUPS = Object.freeze({
  活跃度: ['话痨', '活跃', '普通', '沉默寡言', '潜水'],
  情绪风格: ['乐观', '幽默', '温和', '毒舌', '易怒', '悲观', '冷静'],
  社交倾向: ['主动', '被动', '独来独往', '乐于助人'],
  表达习惯: ['直接', '委婉', '爱用表情包', '爱开玩笑', '爱提问', '爱分享'],
  风格: ['严谨', '随和', '认真', '随意']
});

export const PERSONALITY_PARAMS = Object.freeze({
  minMessagesForJudge: 10,        // 少于 10 条消息视为样本不足
  aiJudgeCooldownMs: 24 * 60 * 60 * 1000, // AI 补判节流 24h/人
  maxTags: 5,                      // 单人生理标签上限
  summaryMaxChars: 80,
  trendBuckets: 24,                // 时段统计桶数
  // 倾向映射（规则）：好感分区间 × 性格关键字 → 提示
});

// ── 统计字段初始化与增量维护 ────────────────────────────────────────────────

/** 新成员统计状态（挂在 member.stats 上，随好感状态持久化）。 */
export function createPersonalityStats() {
  return {
    messageCount: 0,
    totalLen: 0,
    emojiCount: 0,
    stickerCount: 0,
    questionCount: 0,
    mentionAiCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    hourBuckets: Array(PERSONALITY_PARAMS.trendBuckets).fill(0),
    lastActiveAt: 0
  };
}

/**
 * 一次发言后增量更新统计（规则层，零成本）。
 * @param {object} stats  member.stats
 * @param {object} opts {text, hasSticker, hasEmoji, isQuestion, mentionAi, now}
 */
export function updatePersonalityStats(stats, opts = {}) {
  if (!stats || typeof stats !== 'object') return;
  const text = String(opts.text || '');
  stats.messageCount = (stats.messageCount || 0) + 1;
  stats.totalLen = (stats.totalLen || 0) + text.length;
  if (opts.hasSticker) stats.stickerCount = (stats.stickerCount || 0) + 1;
  if (opts.hasEmoji) stats.emojiCount = (stats.emojiCount || 0) + 1;
  if (opts.isQuestion) stats.questionCount = (stats.questionCount || 0) + 1;
  if (opts.mentionAi) stats.mentionAiCount = (stats.mentionAiCount || 0) + 1;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) stats.positiveCount = (stats.positiveCount || 0) + 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) stats.negativeCount = (stats.negativeCount || 0) + 1;
  const hour = new Date(Number(opts.now) || Date.now()).getHours();
  if (Array.isArray(stats.hourBuckets) && stats.hourBuckets.length === PERSONALITY_PARAMS.trendBuckets) {
    stats.hourBuckets[hour] = (stats.hourBuckets[hour] || 0) + 1;
  }
  stats.lastActiveAt = Number(opts.now) || Date.now();
}

/** 样本充分性：消息数是否达到初判门槛。 */
export function hasEnoughSample(member) {
  return (Number(member?.stats?.messageCount) || 0) >= PERSONALITY_PARAMS.minMessagesForJudge;
}

// ── 规则初判（零 token）─────────────────────────────────────────────────────

/**
 * 从统计提取粗性格标签（确定性规则，最多 maxTags 个）。
 * @param {object} member
 * @returns {string[]}
 */
export function inferFromStats(member) {
  const stats = member?.stats || {};
  const n = Number(stats.messageCount) || 0;
  if (n < PERSONALITY_PARAMS.minMessagesForJudge) return [];
  const tags = [];
  const avgLen = (Number(stats.totalLen) || 0) / n;
  const emojiRate = (Number(stats.emojiCount) || 0) / n;
  const stickerRate = (Number(stats.stickerCount) || 0) / n;
  const questionRate = (Number(stats.questionCount) || 0) / n;
  const mentionRate = (Number(stats.mentionAiCount) || 0) / n;
  const posRate = (Number(stats.positiveCount) || 0) / n;
  const negRate = (Number(stats.negativeCount) || 0) / n;

  // 活跃度
  if (n >= 50) tags.push('话痨');
  else if (n >= 20) tags.push('活跃');
  else tags.push('普通');
  // 表达长度
  if (avgLen >= 40) tags.push('爱分享');
  else if (avgLen < 6 && n >= 20) tags.push('简洁');
  // 表情/表情包
  if (emojiRate >= 0.3 || stickerRate >= 0.2) tags.push('爱用表情包');
  // 提问
  if (questionRate >= 0.25) tags.push('爱提问');
  // 情绪风格
  if (negRate >= 0.2) tags.push('毒舌');
  else if (posRate >= 0.2) tags.push('乐观');
  else if (posRate >= 0.1) tags.push('温和');
  // 对 AI 的兴趣
  if (mentionRate >= 0.3) tags.push('主动');
  // 时段：夜间占比（22-6 时）
  const hourBuckets = Array.isArray(stats.hourBuckets) ? stats.hourBuckets : [];
  if (hourBuckets.length === PERSONALITY_PARAMS.trendBuckets) {
    let night = 0;
    for (let h = 0; h < 24; h += 1) {
      if (h >= 22 || h < 6) night += Number(hourBuckets[h]) || 0;
    }
    if (n > 0 && night / n >= 0.4) tags.push('夜猫子');
  }
  // 去重并截断
  return [...new Set(tags)].slice(0, PERSONALITY_PARAMS.maxTags);
}

// ── AI 补判（节流）──────────────────────────────────────────────────────────

/**
 * 是否触发一次 AI 性格精修。
 * 条件：样本充分 + 距上次 AI 判定超过 24h + 可选的强制标记。
 */
export function needsAiPersona(member, opts = {}) {
  if (!member) return false;
  if (!hasEnoughSample(member)) return false;
  if (opts.force === true) return true;
  const now = Number(opts.now) || Date.now();
  const last = Number(member.lastPersonaJudgeAt) || 0;
  return now - last >= PERSONALITY_PARAMS.aiJudgeCooldownMs;
}

/**
 * AI 精修结果写入（tags 从词表选或自定义，summary 一句话）。
 * 调用方负责节流判定与落盘。
 */
export function applyAiPersona(member, tags, summary, opts = {}) {
  if (!member) return null;
  const now = Number(opts.now) || Date.now();
  const cleanTags = [...new Set(
    (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean)
  )].slice(0, PERSONALITY_PARAMS.maxTags);
  member.personality = {
    tags: cleanTags,
    summary: String(summary || '').slice(0, PERSONALITY_PARAMS.summaryMaxChars),
    source: 'ai',
    updatedAt: now
  };
  member.lastPersonaJudgeAt = now;
  return member.personality;
}

// ── 倾向建议（好感 × 性格 → 回复倾向）──────────────────────────────────────

/**
 * 从好感分与性格标签给出 AI 的倾向提示（一句话，≤40 字）。
 * 这是"做出合理倾向"的规则实现：高好感→轻松亲密；低好感→谨慎避冲突。
 */
export function tendencyHint(affinityScore, personalityTags = [], opts = {}) {
  const score = Number(affinityScore) || 50;
  const tags = new Set((personalityTags || []).map((t) => String(t)));
  const parts = [];
  if (score >= 70) parts.push('可轻松调侃、亲密');
  else if (score >= 40) parts.push('正常友好交流');
  else if (score >= 20) parts.push('保持礼貌谨慎，避免冲突');
  else parts.push('尽量简短客气，不主动纠缠');

  if (tags.has('毒舌') || tags.has('易怒')) parts.push('对方易带情绪，别硬刚、适时转移话题');
  if (tags.has('幽默') || tags.has('爱开玩笑')) parts.push('可接梗逗趣');
  if (tags.has('爱提问')) parts.push('多解释、多给依据');
  if (tags.has('严谨') || tags.has('认真')) parts.push('回应要靠谱、别信口开河');
  if (tags.has('沉默寡言') || tags.has('潜水')) parts.push('对方话少，回应从简，别追问');
  if (tags.has('夜猫子') && opts.lateNight) parts.push('深夜时段，语气放轻');
  return parts.join('；');
}

// ── 格式化（上下文携带，token 最少）────────────────────────────────────────

/**
 * 单个成员一行：`印象|张三|直爽,幽默|好感72(友好)|倾向:可轻松调侃、亲密`
 * 供 formatMemoryBlock 的成员印象部分使用。
 */
export function formatPersonaLine(member, affinityScore, opts = {}) {
  if (!member) return '';
  const name = String(member.name || member.target || '');
  if (!name) return '';
  const persona = member.personality && Array.isArray(member.personality.tags)
    ? member.personality.tags : (Array.isArray(member.tags) ? member.tags : []);
  const ruleTags = (opts.includeRuleTags !== false && !persona.length)
    ? inferFromStats(member) : [];
  const tags = [...new Set([...persona, ...ruleTags])].slice(0, PERSONALITY_PARAMS.maxTags);
  const score = Number(affinityScore) ?? 50;
  const lv = opts.levelLabel || '';
  const hint = tendencyHint(score, tags, opts);
  const parts = ['印象', name];
  if (tags.length) parts.push(tags.join(','));
  parts.push(`好感${Math.round(score)}${lv ? `(${lv})` : ''}`);
  if (hint) parts.push(`倾向:${hint}`);
  return `- ${parts.join('|')}`;
}

/**
 * 成员的会话内整块（用于上下文里"对本会话成员"的概览）：
 * 名字 + 好感 + 性格，供 AI 对在场的人做出倾向。
 */
export function formatMembersBlock(members, opts = {}) {
  const rows = (members || [])
    .map((m) => formatPersonaLine(m.member, m.affinityScore, { ...opts, levelLabel: m.levelLabel }))
    .filter(Boolean);
  if (!rows.length) return '';
  return ['【在场群友】', ...rows].join('\n');
}
