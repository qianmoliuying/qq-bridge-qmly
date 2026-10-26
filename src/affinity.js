// affinity.js — 好感度引擎（规则为主 + AI 补判）。
//
// 决策（已与用户确认）：规则为主 + AI 补判；个人优先 + 会话兜底。
//
// 设计：
//   · 好感度是 per-member 分数（0~100，默认 50 中性），挂在二代会话状态的
//     memberImpressions[name] 扩展字段上（随 social-v2.json 持久化），SQLite
//     归档时做历史快照。
//   · 规则增减（零额外 token）：互动 / 被 @ / 引用 / 情绪词 / 长时间未互动衰减。
//   · AI 补判（节流）：重大事件（强情绪、长对话、冲突词）才触发一次模型判定，
//     每会话每 30 分钟最多 1 次，避免与「最少 token」目标冲突。
//   · 等级 → 上下文记忆配额：Lv0=3 / Lv1=5 / Lv2=8 / Lv3=12 条。
//   · 会话好感 = 成员好感平均（作为配额总预算的兜底）。
//
// 纯引擎：输入 member 状态对象，输出增量变化；不直接碰 IO/状态文件。

import { POSITIVE_WORDS, NEGATIVE_WORDS } from './memory-core.js';

// ── 等级与配额 ──────────────────────────────────────────────────────────────
export const AFFINITY_LEVELS = Object.freeze([
  { min: 0,  max: 19, level: 0, label: '冷淡', quota: 3 },
  { min: 20, max: 39, level: 1, label: '普通', quota: 5 },
  { min: 40, max: 69, level: 2, label: '友好', quota: 8 },
  { min: 70, max: 100, level: 3, label: '亲密', quota: 12 }
]);

export const AFFINITY_DEFAULT = 50;

/** 分数 → 等级对象（含配额）。 */
export function levelOf(score) {
  const s = Math.max(0, Math.min(100, Number(score) || AFFINITY_DEFAULT));
  for (const lv of AFFINITY_LEVELS) {
    if (s >= lv.min && s <= lv.max) return { ...lv };
  }
  return { ...AFFINITY_LEVELS[0] };
}

/** 分数 → 上下文记忆配额（条数）。 */
export function quotaOf(score) {
  return levelOf(score).quota;
}

/** 会话好感（成员平均）：多个成员分聚合，作为会话级预算兜底。 */
export function sessionAffinity(scores) {
  const list = (scores || []).filter((v) => Number.isFinite(Number(v)));
  if (!list.length) return AFFINITY_DEFAULT;
  return Math.round(list.reduce((a, b) => a + Number(b), 0) / list.length);
}

// ── 情绪检测 ────────────────────────────────────────────────────────────────
/**
 * 文本情绪分：正面词 +1 / 负面词 -1，取和。|得分|>=2 视为强情绪。
 * 词表复用 memory-core.js（单一实现）。
 */
export function detectSentiment(text) {
  const s = String(text || '');
  let score = 0;
  for (const w of POSITIVE_WORDS) if (s.includes(w)) score += 1;
  for (const w of NEGATIVE_WORDS) if (s.includes(w)) score -= 1;
  return score;
}

// ── 规则增减 ────────────────────────────────────────────────────────────────
export const RULE_PARAMS = Object.freeze({
  perInteraction: 0.5,     // 一次互动
  perMention: 1,           // 被 @ / 被引用
  sentimentCap: 2,         // 单次情绪增减上限
  decayAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 天未互动开始衰减
  decayPerDay: 1,          // 每天 -1，上限 -10
  maxReasons: 10,          // 保留最近原因条数
  aiJudgeCooldownMs: 30 * 60 * 1000, // AI 补判节流
  aiJudgeStrongSentiment: 3 // 触发 AI 补判的强情绪阈值
});

function clampScore(v) {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/**
 * 规则增减。返回本次的变更明细，调用方负责写回状态与落盘。
 * @param {object} member  好感状态对象（会原地修改）
 * @param {object} opts {interaction, mentioned, sentiment, now, source}
 * @returns {object} {deltas:[{delta, reason}], total, score}
 */
export function applyRuleDelta(member, opts = {}) {
  if (!member || typeof member !== 'object') return { deltas: [], total: 0, score: 0 };
  const now = Number(opts.now) || Date.now();
  const deltas = [];
  let score = Number(member.affinity ?? member.score ?? AFFINITY_DEFAULT);
  if (!Number.isFinite(score)) score = AFFINITY_DEFAULT;

  if (opts.interaction === true) {
    const d = RULE_PARAMS.perInteraction;
    deltas.push({ delta: d, reason: '互动' });
    member.interactionCount = (Number(member.interactionCount) || 0) + 1;
  }
  if (opts.mentioned === true) {
    const d = RULE_PARAMS.perMention;
    deltas.push({ delta: d, reason: '被提及/被引用' });
    member.mentionedCount = (Number(member.mentionedCount) || 0) + 1;
  }
  const sent = Number(opts.sentiment) || 0;
  if (sent !== 0) {
    const d = Math.max(-RULE_PARAMS.sentimentCap, Math.min(RULE_PARAMS.sentimentCap, sent));
    deltas.push({ delta: d, reason: d > 0 ? '正面情绪' : '负面情绪' });
  }

  // 长时间未互动衰减（最多 -10）
  const lastDeltaAt = Number(member.lastDeltaAt) || 0;
  if (lastDeltaAt > 0) {
    const idleDays = Math.floor((now - lastDeltaAt) / RULE_PARAMS.decayAfterMs);
    if (idleDays >= 1) {
      const decay = Math.min(10, idleDays * RULE_PARAMS.decayPerDay);
      deltas.push({ delta: -decay, reason: `${idleDays}天未互动` });
    }
  }

  for (const d of deltas) score += d.delta;
  score = clampScore(score);

  member.affinity = score;
  member.lastDeltaAt = now;
  member.lastSeenAt = now;
  if (deltas.length) {
    const reasons = Array.isArray(member.affinityReasons) ? member.affinityReasons : [];
    for (const d of deltas) {
      reasons.push({ at: now, delta: d.delta, reason: d.reason, source: opts.source || 'rule' });
    }
    member.affinityReasons = reasons.slice(-RULE_PARAMS.maxReasons);
  }
  return { deltas, total: deltas.reduce((a, d) => a + d.delta, 0), score };
}

/**
 * 是否值得触发一次 AI 补判（重大事件判定）。
 * 条件：强情绪（|sentiment| >= aiJudgeStrongSentiment）或 超长消息带情绪，
 * 且距上次 AI 判定超过节流时间。
 * @param {object} member
 * @param {object} opts {sentiment, textLen, now}
 */
export function needsAiJudgement(member, opts = {}) {
  if (!member) return false;
  const now = Number(opts.now) || Date.now();
  const last = Number(member.lastAiJudgeAt) || 0;
  if (now - last < RULE_PARAMS.aiJudgeCooldownMs) return false;
  const sent = Math.abs(Number(opts.sentiment) || 0);
  if (sent >= RULE_PARAMS.aiJudgeStrongSentiment) return true;
  if (sent > 0 && Number(opts.textLen) >= 120) return true;
  return false;
}

/** AI 补判结果写入（delta 由模型给出，reason 说明）。调用方负责节流判定与落盘。 */
export function applyAiJudgement(member, delta, reason, opts = {}) {
  if (!member) return null;
  const now = Number(opts.now) || Date.now();
  const d = Math.max(-5, Math.min(5, Number(delta) || 0));
  let score = Number(member.affinity ?? member.score ?? AFFINITY_DEFAULT);
  if (!Number.isFinite(score)) score = AFFINITY_DEFAULT;
  score = clampScore(score + d);
  member.affinity = score;
  member.lastAiJudgeAt = now;
  member.lastDeltaAt = now;
  const reasons = Array.isArray(member.affinityReasons) ? member.affinityReasons : [];
  reasons.push({ at: now, delta: d, reason: String(reason || 'AI 补判'), source: 'ai' });
  member.affinityReasons = reasons.slice(-RULE_PARAMS.maxReasons);
  return { delta: d, score };
}

/** 好感状态初始化（新群友）。 */
export function createAffinityState() {
  return {
    affinity: AFFINITY_DEFAULT,
    interactionCount: 0,
    mentionedCount: 0,
    lastSeenAt: 0,
    lastDeltaAt: 0,
    lastAiJudgeAt: 0,
    affinityReasons: []
  };
}
