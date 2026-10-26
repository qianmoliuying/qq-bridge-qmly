// 记忆/好感/性格系统回归测试：memory-core（权重/标签/索引/格式化）、
// affinity（规则增减/AI补判/配额）、personality（统计/初判/倾向）、
// memory-store（SQLite 建表/写库/归档/检索）。
// 用法：node --test scripts/test-memory-system.mjs
import assert from 'node:assert/strict';
import {
  computeWeight, classifyTags, estimateImportance, tokenizeMemory, buildMemoryIndex,
  hitLookup, selectTopK, formatCompact, formatMemoryBlock, entriesFromState,
  isImportant, WEIGHT_PARAMS
} from '../src/memory-core.js';
import {
  levelOf, quotaOf, sessionAffinity, detectSentiment, applyRuleDelta,
  needsAiJudgement, applyAiJudgement, createAffinityState
} from '../src/affinity.js';
import {
  createPersonalityStats, updatePersonalityStats, hasEnoughSample, inferFromStats,
  needsAiPersona, applyAiPersona, tendencyHint, formatPersonaLine
} from '../src/personality.js';
import MemoryStore from '../src/memory-store.js';

let passed = 0;
function ok(name) { passed += 1; console.log(`  ✓ ${name}`); }

console.log('memory-core:');
{
  const now = Date.now();
  const fresh = { type: 'activeTopic', text: '讨论 el psy kongroo', importance: 4, lastMentionAt: now, createdAt: now };
  const old = { type: 'activeTopic', text: '旧话题', importance: 4, lastMentionAt: now - 7 * 86400000, createdAt: now - 7 * 86400000 };
  const wFresh = computeWeight(fresh, now, 80);
  const wOld = computeWeight(old, now, 80);
  assert(wFresh > 0.5, 'fresh 权重应较高');
  assert(wOld < 0.02, '7天前话题权重应近零');
  ok(`computeWeight: fresh=${wFresh.toFixed(3)} old=${wOld.toFixed(4)}`);

  const tags = classifyTags({ type: 'activeTopic', text: '谢谢你的帮助，超棒', participants: ['张三'] }, now);
  assert(tags.includes('positive') && tags.includes('affinity-up') && tags.includes('today') && tags.includes('@张三'), '标签应含情绪/时间/参与者');
  ok(`classifyTags: ${tags.join(',')}`);

  assert(estimateImportance('我很喜欢你帮的忙，一定记得这件事') >= 4, '重要内容重要性应偏高');
  ok('estimateImportance');

  const entries = [
    { id: 'a', type: 'activeTopic', text: '一起打游戏 el psy kongroo', importance: 5, lastMentionAt: now },
    { id: 'b', type: 'activeTopic', text: '聊天气好热', importance: 1, lastMentionAt: now }
  ];
  const idx = buildMemoryIndex(entries);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const hits = hitLookup(idx, byId, '游戏', 3, now);
  assert(hits.length === 1 && hits[0].entry.id === 'a', '命中查询应找到游戏条目');
  ok(`hitLookup: "${hits[0]?.entry?.text}"`);

  const top = selectTopK(entries, 2, now);
  assert(top[0].entry.id === 'a', 'Top-K 应优先高权重');
  ok(`selectTopK: ${top.map((t) => t.entry.id).join(',')}`);

  const compact = formatCompact(entries[0], now);
  assert(compact.startsWith('- 话题|'), '紧凑格式应以类型开头');
  ok(`formatCompact: ${compact}`);

  const block = formatMemoryBlock(entries, { quota: 2, nowMs: now });
  assert(block.startsWith('【记忆】'), '记忆块应有标题');
  ok('formatMemoryBlock');

  const st = { activeTopics: [{ text: 'x', lastMentionAt: now }], pendingThoughts: [], memberImpressions: { 张三: { traits: ['靠谱'], lastSeenAt: now } } };
  assert(entriesFromState(st).length === 2, '状态归一化应为 2 条');
  ok('entriesFromState');

  assert(isImportant({ importance: 4 }, 0) === true, 'importance>=4 应视为重要');
  assert(isImportant({ importance: 1 }, 0.4) === true, 'weight>=0.35 应视为重要');
  ok('isImportant');
}

console.log('affinity:');
{
  assert(levelOf(10).level === 0 && levelOf(25).level === 1 && levelOf(50).level === 2 && levelOf(90).level === 3, '等级分界正确');
  assert(quotaOf(90) === 12 && quotaOf(5) === 3, '配额随等级变化');
  assert(sessionAffinity([30, 70]) === 50, '会话好感=均值');
  ok('levelOf/quotaOf/sessionAffinity');

  assert(detectSentiment('谢谢 好棒') === 2 && detectSentiment('垃圾 烦') === -2, '情绪检测');
  const m = createAffinityState();
  const r1 = applyRuleDelta(m, { interaction: true, mentioned: true, sentiment: 1, now: Date.now() });
  assert(r1.total === 2.5 && m.affinity === 52.5, '规则增减应累加');
  const m2 = createAffinityState();
  const r2 = applyRuleDelta(m2, { sentiment: -2, now: Date.now() });
  assert(r2.total === -2 && m2.affinity === 48, '负面情绪扣分');
  ok(`applyRuleDelta: ${m.affinity}`);

  const m3 = createAffinityState();
  m3.lastAiJudgeAt = Date.now() - 1000;
  assert(needsAiJudgement(m3, { sentiment: 3, now: Date.now() }) === false, '节流期内不触发');
  const m4 = createAffinityState();
  m4.lastAiJudgeAt = Date.now() - 3600 * 1000;
  assert(needsAiJudgement(m4, { sentiment: 3, now: Date.now() }) === true, '超节流+强情绪触发');
  const m5 = createAffinityState();
  const ai = applyAiJudgement(m5, 4, '长对话修复关系', { now: Date.now() });
  assert(ai.delta === 4 && m5.affinity === 54, 'AI 补判写入');
  ok('needsAiJudgement/applyAiJudgement');
}

console.log('personality:');
{
  const stats = createPersonalityStats();
  for (let i = 0; i < 20; i += 1) {
    updatePersonalityStats(stats, { text: '今天好棒谢谢', now: Date.now() - i * 1000, mentionAi: i % 3 === 0, isQuestion: i % 2 === 0 });
  }
  assert(hasEnoughSample({ stats }) === true, '20 条消息样本充分');
  const tags = inferFromStats({ stats });
  assert(tags.length > 0, '应提取出性格标签');
  ok(`inferFromStats: ${tags.join(',')}`);

  const p = createAffinityState();
  p.stats = stats;
  assert(needsAiPersona(p, { now: Date.now() }) === true, '样本充分且未判定过应触发');
  applyAiPersona(p, ['幽默', '乐观'], '爱开玩笑的开心果', { now: Date.now() });
  assert(p.personality.tags.length === 2, 'AI 标签写入');
  ok('needsAiPersona/applyAiPersona');

  const hint = tendencyHint(90, ['幽默', '爱开玩笑']);
  assert(hint.includes('调侃') && hint.includes('接梗'), '高好感+幽默→可调侃');
  const hint2 = tendencyHint(10, ['毒舌']);
  assert(hint2.includes('客气') && hint2.includes('别硬刚'), '低好感+毒舌→谨慎避冲突');
  ok(`tendencyHint: ${hint}`);

  const line = formatPersonaLine({ name: '张三', personality: { tags: ['直爽'] } }, 72, { levelLabel: '友好' });
  assert(line.includes('张三') && line.includes('好感72') && line.includes('倾向:'), '格式化含好感/性格/倾向');
  ok(`formatPersonaLine: ${line}`);
}

console.log('memory-store (SQLite):');
{
  const store = new MemoryStore(':memory:');
  const now = Date.now();
  store.upsertMemory({ id: 'm1', convKey: 'group:1', type: 'activeTopic', text: '一起打游戏', tags: ['topic'], participants: ['张三'], importance: 4, createdAt: now, lastMentionAt: now, lastSeenAt: now }, 0.8);
  store.upsertMemory({ id: 'm2', convKey: 'group:1', type: 'event', text: '张三大喜事', tags: ['event'], importance: 5, createdAt: now, lastMentionAt: now, lastSeenAt: now }, 0.9);
  store.upsertMemory({ id: 'm3', convKey: 'group:1', type: 'event', text: '旧事', tags: ['event'], importance: 2, createdAt: now - 400 * 86400000, lastMentionAt: now - 400 * 86400000, lastSeenAt: now - 400 * 86400000 }, 0.01);

  const rows = store.queryByConv('group:1', { limit: 10 });
  assert(rows.length === 3, '查询应返回 3 条');
  assert(rows[0].weight === 0.9, '应按权重降序');
  ok(`queryByConv: ${rows.length} 条，首条 weight=${rows[0].weight}`);

  const s = store.search('group:1', '游戏');
  assert(s.length === 1 && s[0].id === 'm1', 'LIKE 兜底查询');
  ok(`search: ${s.map((x) => x.id).join(',')}`);

  store.archiveEntries('group:1', ['m3'], now - 400 * 86400000); // m3 归档于 400 天前
  const archived = store.queryByConv('group:1', { limit: 10, archived: 1 });
  assert(archived.length === 1 && archived[0].id === 'm3', '归档标记');
  store.archiveEntries('group:1', ['m1', 'm2'], now);
  // m3 已归档 400 天：deleteExpired 应删掉（但 m1/m2 刚归档不删）
  const del = store.deleteExpired(now + 86400000, 30 * 86400000);
  assert(del === 1, '删除超龄归档');
  ok(`archive/deleteExpired: 删除 ${del} 条`);

  store.upsertPersonality('group:1', '张三', { tags: ['直爽', '幽默'], summary: '爱开玩笑', source: 'ai', stats: { messageCount: 20 } }, now);
  const p = store.getPersonality('group:1', '张三');
  assert(p.tags.length === 2 && p.member === '张三', '性格入库');
  const plist = store.listPersonality('group:1');
  assert(plist.length === 1, '列出性格');
  ok('personality 表读写');

  store.snapshotAffinity('group:1', [{ name: '张三', score: 72, level: 2, interactionCount: 10, mentionedCount: 3 }], now);
  const hist = store.getAffinityHistory('group:1', '张三');
  assert(hist.length === 1 && hist[0].score === 72, '好感历史快照');
  ok('affinity_history 快照');

  store.close();
}

console.log(`\n全部通过：${passed} 项断言`);