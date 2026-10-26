// memory-core.js — 记忆核心：权重计算、紧凑格式化、内存倒排索引、Top-K 选择、命中查询。
//
// 设计目标（对应需求）：
//   1. 最少 token 理解更多记忆：只注入按权重排序的 Top-K 压缩条目，命中查询时单条注入；
//   2. 权重机制：weight = importance × 时间衰减 × (1 + 好感系数)，只让最近/高权重的记忆
//      长时间留在上下文中；
//   3. 标签机制：类型 / 情绪 / 好感方向 / 时间归类，供分类、筛选与检索；
//   4. 快速查找：内存倒排索引（2-gram + 标签 + 参与者 + 关键词），对话提及时可秒级命中。
//
// 纯函数模块：不持有状态、不碰 IO，便于单元测试与复用。

// ── 情绪词表（用于自动打标签与好感方向初判；affinity.js 复用同一份）─────────
export const POSITIVE_WORDS = new Set([
  '谢谢', '感谢', '好棒', '厉害', '喜欢', '爱了', '赞', '牛', '优秀', '靠谱', '聪明',
  '可爱', '有趣', '好玩', '好耶', 'nice', 'good', 'great', 'awesome', 'cool', '赞爆',
  '辛苦', '加油', '支持', '认同', '同意', '帮忙', '帮了大忙', '靠谱', '好人'
]);

export const NEGATIVE_WORDS = new Set([
  '讨厌', '垃圾', '废物', '烦', '恶心', '差劲', '糟糕', '烂', '白痴', '蠢', '有病',
  '滚', '闭嘴', '别烦', '没用', '坑', '骗', '失望', '生气', '气死', 'bad', 'stupid',
  '垃圾话', '别来', '拉黑', '举报'
]);

const TYPE_TAGS = {
  activeTopic: 'topic',
  pendingThought: 'thought',
  memberImpression: 'impression',
  event: 'event'
};

// ── 权重参数（可整体调，保持单点）──────────────────────────────────────────
export const WEIGHT_PARAMS = Object.freeze({
  // 时间衰减：半衰期（毫秒）。条目越旧权重越低，24h 半衰 + 7 天几乎归零。
  topicHalfLifeMs: 12 * 60 * 60 * 1000,      // 话题：12h 半衰
  thoughtHalfLifeMs: 6 * 60 * 60 * 1000,     // 想法：6h 半衰（默认 2h 过期）
  impressionHalfLifeMs: 48 * 60 * 60 * 1000, // 印象：48h 半衰（人物印象比话题持久）
  eventHalfLifeMs: 24 * 60 * 60 * 1000,      // 事件：24h 半衰
  // 好感系数上限：affinityScore 0~100 → factor 0~0.5（高好感让相关记忆权重最多 +50%）
  affinityFactorMax: 0.5,
  // 重要记忆即时写库阈值：importance ≥ 4 或 weight ≥ 0.35 即认为重要
  storeThresholdImportance: 4,
  storeThresholdWeight: 0.35,
  // 冷数据判定：weight 低于此值且超过此年龄 → 移出上下文，仅留库中
  coldWeight: 0.05,
  coldAgeMs: 7 * 24 * 60 * 60 * 1000,        // 7 天
  // 归档删除：已归档且超龄 → 真正删除
  deleteArchivedAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 天
  // 上下文配额（条数，好感等级由 affinity.js 提供）
  defaultContextQuota: 8
});

// 单条记忆的半衰期（按类型）
function halfLifeOf(type) {
  switch (type) {
    case 'activeTopic': return WEIGHT_PARAMS.topicHalfLifeMs;
    case 'pendingThought': return WEIGHT_PARAMS.thoughtHalfLifeMs;
    case 'memberImpression': return WEIGHT_PARAMS.impressionHalfLifeMs;
    default: return WEIGHT_PARAMS.eventHalfLifeMs;
  }
}

/**
 * 时间衰减因子：指数半衰 exp(-ln2 * age / halfLife)，age<=0 时为 1。
 * 全部用毫秒时间戳。
 */
export function decayFactor(type, ageMs) {
  const hl = halfLifeOf(type);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return Math.exp((-Math.LN2 * ageMs) / hl);
}

/** 好感系数：0~100 分 → 0~affinityFactorMax 的加成。 */
export function affinityFactor(affinityScore) {
  const s = Number(affinityScore) || 0;
  if (s <= 0) return 0;
  const clamped = Math.min(100, Math.max(0, s));
  return (clamped / 100) * WEIGHT_PARAMS.affinityFactorMax;
}

/**
 * 计算条目权重。
 * @param {object} entry  {type, importance, lastMentionAt, createdAt, ...}
 * @param {number} nowMs  当前时间戳
 * @param {number} affinityScore 相关人好感分（0~100），无则 0
 * @returns {number} 0~1 区间
 */
export function computeWeight(entry, nowMs, affinityScore = 0) {
  if (!entry) return 0;
  const lastTs = Number(entry.lastMentionAt) || Number(entry.createdAt) || 0;
  const ageMs = nowMs - lastTs;
  const decay = decayFactor(entry.type || 'event', ageMs);
  // 过期想法直接判 0（不注入）
  if ((entry.type === 'pendingThought' || entry.type === 'thought')
      && entry.expiresAt && nowMs > Number(entry.expiresAt)) {
    return 0;
  }
  const importance = Math.max(0.1, Math.min(5, Number(entry.importance) || 3));
  const base = (importance / 5) * decay;
  const boost = 1 + affinityFactor(affinityScore);
  return Math.max(0, Math.min(1, base * boost));
}

// ── 标签机制 ──────────────────────────────────────────────────────────────

/** 从内容与类型自动归类标签：类型 / 情绪 / 好感方向 / 时间。 */
export function classifyTags(entry, nowMs = Date.now()) {
  const tags = new Set();
  const typeTag = TYPE_TAGS[entry?.type];
  if (typeTag) tags.add(typeTag);

  const text = String(entry?.text || '');
  let sentiment = 0; // +1 正面 / -1 负面 / 0 中性
  for (const w of POSITIVE_WORDS) if (text.includes(w)) sentiment += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) sentiment -= 1;
  if (sentiment > 0) tags.add('positive');
  else if (sentiment < 0) tags.add('negative');
  else tags.add('neutral');
  tags.add(sentiment >= 0 ? 'affinity-up' : 'affinity-down');

  // 时间归类（按 lastMentionAt / createdAt）
  const ts = Number(entry?.lastMentionAt) || Number(entry?.createdAt) || nowMs;
  const dayMs = 24 * 60 * 60 * 1000;
  const ageMs = nowMs - ts;
  if (ageMs < dayMs) tags.add('today');
  else if (ageMs < 3 * dayMs) tags.add('recent');
  else if (ageMs < 7 * dayMs) tags.add('this-week');
  else tags.add('old');

  // 参与者名也作为标签（便于按人检索）
  for (const p of entry?.participants || []) {
    if (p) tags.add(`@${p}`);
  }
  // 印象条目：目标人名
  if (entry?.target) tags.add(`@${entry.target}`);

  return [...tags];
}

/** 重要性初判（1~5）：情绪强度 + 内容长度 + 是否提及 AI 自身。 */
export function estimateImportance(text, opts = {}) {
  const s = String(text || '');
  let score = 3;
  for (const w of POSITIVE_WORDS) if (s.includes(w)) score += 0.5;
  for (const w of NEGATIVE_WORDS) if (s.includes(w)) score += 0.5;
  if (s.length >= 30) score += 0.5;
  if (s.length >= 60) score += 0.5;
  // 提及 AI 自身 / 请求 / 承诺 → 提高
  if (/我|你|机器人|小鲸鱼|deepseek|帮忙|答应|一定|记得/.test(s)) score += 0.5;
  if (opts.aiJudged === true) score += 0.5;
  return Math.max(1, Math.min(5, Math.round(score)));
}

// ── 分词与倒排索引 ─────────────────────────────────────────────────────────

/** 中文 2-gram + 英文/数字单词 + 标签 + 参与者。不引第三方分词库。 */
export function tokenizeMemory(text, extra = []) {
  const tokens = new Set();
  const s = String(text || '').toLowerCase();
  for (const w of (extra || [])) {
    if (w) tokens.add(String(w).toLowerCase());
  }
  // 英文/数字单词
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_.-]{1,}/g)) tokens.add(m[0]);
  // 中文 2-gram（连续 CJK 片段内滑动）
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, ' ').replace(/\s+/g, ' ');
  for (const seg of cjk.split(' ')) {
    if (seg.length < 2) continue;
    for (let i = 0; i <= seg.length - 2; i += 1) tokens.add(seg.slice(i, i + 2));
  }
  return [...tokens];
}

/** 由条目列表构建倒排索引：token → Set<entryId>。 */
export function buildMemoryIndex(entries) {
  const index = new Map();
  for (const e of entries || []) {
    if (!e?.id) continue;
    const tokens = tokenizeMemory(e.text, [...(e.tags || []), ...(e.participants || []), e.target]);
    for (const t of tokens) {
      let set = index.get(t);
      if (!set) { set = new Set(); index.set(t, set); }
      set.add(e.id);
    }
  }
  return index;
}

/**
 * 命中查询：把 query 分词，命中条数按权重排序取 top-k。
 * 返回 [{entry, score}]；score = 命中 token 数 / 查询 token 数（0~1+）。
 */
export function hitLookup(index, entriesById, query, k = 3, nowMs = Date.now(), affinityOf = null) {
  if (!index || !entriesById) return [];
  const qTokens = tokenizeMemory(query);
  if (!qTokens.length) return [];
  const hits = new Map(); // id → 命中次数
  for (const t of qTokens) {
    const set = index.get(t);
    if (!set) continue;
    for (const id of set) hits.set(id, (hits.get(id) || 0) + 1);
  }
  if (!hits.size) return [];
  const now = Number(nowMs) || Date.now();
  const scored = [...hits.entries()].map(([id, hitCount]) => {
    const entry = entriesById.get(id);
    if (!entry) return null;
    const affinity = affinityOf ? affinityOf(entry) : 0;
    const weight = computeWeight(entry, now, affinity);
    const relevance = hitCount / qTokens.length;
    // 权重 × 相关度（相关度是主信号，权重是次信号）
    const score = relevance * (0.6 + 0.4 * weight);
    return { entry, score, relevance, weight };
  }).filter(Boolean);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Number(k) || 3));
}

// ── Top-K 选择（上下文注入用）──────────────────────────────────────────────

/** 按权重取 top-k 条（已按权重排序），k 由好感等级配额决定。 */
export function selectTopK(entries, k, nowMs = Date.now(), affinityOf = null) {
  const now = Number(nowMs) || Date.now();
  const scored = (entries || [])
    .map((e) => ({ e, w: computeWeight(e, now, affinityOf ? affinityOf(e) : 0) }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w);
  return scored.slice(0, Math.max(1, Number(k) || 1)).map((x) => ({ entry: x.e, weight: x.w }));
}

// ── 紧凑格式化（token 最少）────────────────────────────────────────────────

/** 人类可读时间差：刚刚 / N分钟前 / N小时前 / N天前。 */
export function agoText(ts, nowMs = Date.now()) {
  if (!ts) return '';
  const diff = Math.max(0, Number(nowMs) - Number(ts));
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

/**
 * 单条紧凑格式，目标 ≤ 60 字：
 *   `- 话题|el psy kongroo|张三,李四|2h前`
 *   `- 印象|张三|靠谱,可爱|互动12次`
 * 规则：type 前缀 + text（≤40 字）+ 参与者/目标 + 时间。
 */
export function formatCompact(entry, nowMs = Date.now()) {
  if (!entry) return '';
  const typeLabel = {
    activeTopic: '话题', pendingThought: '想法', memberImpression: '印象', event: '事件'
  }[entry.type] || '记忆';
  const text = String(entry.text || '').replace(/\n/g, ' ').trim();
  const clipped = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  const who = entry.type === 'memberImpression'
    ? (entry.target || '')
    : (entry.participants || []).join(',');
  const time = agoText(entry.lastMentionAt || entry.createdAt, nowMs);
  const parts = [typeLabel, clipped];
  if (who) parts.push(who);
  if (time) parts.push(time);
  return `- ${parts.join('|')}`;
}

/**
 * 记忆上下文块：按权重 Top-K 输出，配额由好感等级决定。
 * @returns {string} 空则返回 ''
 */
export function formatMemoryBlock(entries, { quota = WEIGHT_PARAMS.defaultContextQuota, nowMs = Date.now(), affinityOf = null } = {}) {
  const now = Number(nowMs) || Date.now();
  const top = selectTopK(entries, quota, now, affinityOf);
  if (!top.length) return '';
  const lines = ['【记忆】'];
  for (const { entry } of top) lines.push(formatCompact(entry, now));
  return lines.join('\n');
}

/** 把内存三类字段归一化成统一 entry 列表（兼容现有 social-v2 结构）。 */
export function entriesFromState(st) {
  const out = [];
  const now = Date.now();
  for (const t of (Array.isArray(st?.activeTopics) ? st.activeTopics : [])) {
    if (!t?.text) continue;
    out.push({
      id: t.id || `mem_active_${t.text}`.slice(0, 64),
      type: 'activeTopic',
      text: t.text,
      tags: Array.isArray(t.tags) ? t.tags : [],
      participants: Array.isArray(t.participants) ? t.participants : [],
      importance: Number(t.importance) || 3,
      lastMentionAt: Number(t.lastMentionAt) || now,
      createdAt: Number(t.createdAt) || now,
      expiresAt: null,
      affinityDelta: Number(t.affinityDelta) || 0,
      source: t.source || 'rule',
      lastSeenAt: Number(t.lastSeenAt) || 0,
      archived: t.archived ? 1 : 0,
      archivedAt: Number(t.archivedAt) || 0
    });
  }
  for (const t of (Array.isArray(st?.pendingThoughts) ? st.pendingThoughts : [])) {
    if (!t?.text) continue;
    out.push({
      id: t.id || `mem_thought_${t.text}`.slice(0, 64),
      type: 'pendingThought',
      text: t.text,
      tags: Array.isArray(t.tags) ? t.tags : [],
      participants: [],
      importance: Number(t.importance) || 3,
      lastMentionAt: Number(t.createdAt) || now,
      createdAt: Number(t.createdAt) || now,
      expiresAt: Number(t.expiresAt) || 0,
      affinityDelta: Number(t.affinityDelta) || 0,
      source: t.source || 'rule',
      lastSeenAt: Number(t.lastSeenAt) || 0,
      archived: t.archived ? 1 : 0,
      archivedAt: Number(t.archivedAt) || 0
    });
  }
  const imps = (st?.memberImpressions && typeof st.memberImpressions === 'object') ? st.memberImpressions : {};
  for (const [name, im] of Object.entries(imps)) {
    if (!im) continue;
    const traits = Array.isArray(im.traits) ? im.traits : [];
    out.push({
      id: im.id || `mem_imp_${name}`.slice(0, 64),
      type: 'memberImpression',
      text: traits.length ? traits.join('、') : name,
      tags: Array.isArray(im.tags) ? im.tags : [],
      participants: [],
      target: name,
      importance: Number(im.importance) || 3,
      lastMentionAt: Number(im.lastSeenAt) || now,
      createdAt: Number(im.firstSeenAt) || now,
      expiresAt: null,
      affinityDelta: Number(im.affinityDelta) || 0,
      source: im.source || 'rule',
      lastSeenAt: Number(im.lastSeenAt) || 0,
      archived: im.archived ? 1 : 0,
      archivedAt: Number(im.archivedAt) || 0
    });
  }
  return out;
}

/** 判断一条记忆是否"重要"（达到即时写库阈值）。 */
export function isImportant(entry, weight) {
  return (Number(entry?.importance) || 0) >= WEIGHT_PARAMS.storeThresholdImportance
    || (Number(weight) || 0) >= WEIGHT_PARAMS.storeThresholdWeight;
}
