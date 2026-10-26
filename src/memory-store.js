// memory-store.js — 记忆 SQLite 持久化层（better-sqlite3）。
//
// 职责（对应确认方案：SQLite + 即时写库）：
//   · 重要记忆 append 即写库（upsert，事务批量）；
//   · 冷数据归档（archiveEntries）与低权超龄删除（deleteExpired）；
//   · 查询兜底（search LIKE）与好感度历史快照；
//   · 全部 SQL 使用参数化占位符，杜绝注入；建表建索引幂等。
//
// 线程模型：桥接单进程，better-sqlite3 同步 API 在事件循环内调用，数据量小，
// 无需 worker。每次写操作自包含（无长事务），崩溃安全。

import Database from 'better-sqlite3';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  conv_key TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  participants TEXT NOT NULL DEFAULT '[]',
  target TEXT NOT NULL DEFAULT '',
  affinity_delta INTEGER NOT NULL DEFAULT 0,
  importance INTEGER NOT NULL DEFAULT 3,
  weight REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_mention_at INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'rule',
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mem_conv ON memories(conv_key, weight DESC);
CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_mem_archived ON memories(archived, created_at);

CREATE TABLE IF NOT EXISTS affinity_history (
  conv_key TEXT NOT NULL,
  member TEXT NOT NULL,
  score INTEGER NOT NULL,
  level INTEGER NOT NULL,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  mentioned_count INTEGER NOT NULL DEFAULT 0,
  snapshot_at INTEGER NOT NULL,
  PRIMARY KEY (conv_key, member, snapshot_at)
);

CREATE TABLE IF NOT EXISTS personality (
  conv_key TEXT NOT NULL,
  member TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  stats TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'rule',
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_key, member)
);
`;

function json(v) {
  try { return JSON.stringify(v ?? []); } catch { return '[]'; }
}

export class MemoryStore {
  /**
   * @param {string} dbPath 数据库文件路径；':memory:' 供测试
   */
  constructor(dbPath) {
    this.db = new Database(dbPath || path.join(process.cwd(), 'state', 'memory.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this._upsert = this.db.prepare(`
      INSERT INTO memories (id, conv_key, type, text, tags, participants, target,
        affinity_delta, importance, weight, created_at, last_mention_at, last_seen_at,
        source, archived, archived_at)
      VALUES (@id, @conv_key, @type, @text, @tags, @participants, @target,
        @affinity_delta, @importance, @weight, @created_at, @last_mention_at, @last_seen_at,
        @source, @archived, @archived_at)
      ON CONFLICT(id) DO UPDATE SET
        text=excluded.text, tags=excluded.tags, participants=excluded.participants,
        target=excluded.target, affinity_delta=excluded.affinity_delta,
        importance=excluded.importance, weight=excluded.weight,
        last_mention_at=excluded.last_mention_at, last_seen_at=excluded.last_seen_at,
        source=excluded.source, archived=excluded.archived, archived_at=excluded.archived_at
    `);
    this._upsertPersona = this.db.prepare(`
      INSERT INTO personality (conv_key, member, tags, summary, stats, source, updated_at)
      VALUES (@key, @member, @tags, @summary, @stats, @source, @at)
      ON CONFLICT(conv_key, member) DO UPDATE SET
        tags=excluded.tags, summary=excluded.summary, stats=excluded.stats,
        source=excluded.source, updated_at=excluded.updated_at
    `);
    this._getPersona = this.db.prepare(
      'SELECT * FROM personality WHERE conv_key = @key AND member = @member'
    );
    this._listPersona = this.db.prepare(
      'SELECT * FROM personality WHERE conv_key = @key ORDER BY updated_at DESC'
    );
  }

  _row(entry, weight) {
    return {
      id: String(entry.id || ''),
      conv_key: String(entry.convKey ?? entry.conv_key ?? ''),
      type: String(entry.type || 'event'),
      text: String(entry.text || ''),
      tags: json(entry.tags),
      participants: json(entry.participants),
      target: String(entry.target || ''),
      affinity_delta: Number(entry.affinityDelta) || 0,
      importance: Number(entry.importance) || 3,
      weight: Number.isFinite(Number(weight)) ? Number(weight) : Number(entry.weight) || 0,
      created_at: Number(entry.createdAt) || Date.now(),
      last_mention_at: Number(entry.lastMentionAt) || 0,
      last_seen_at: Number(entry.lastSeenAt) || 0,
      source: String(entry.source || 'rule'),
      archived: entry.archived ? 1 : 0,
      archived_at: Number(entry.archivedAt) || 0
    };
  }

  /** 写一条（upsert）。entry 需含 convKey；weight 可显式传入。 */
  upsertMemory(entry, weight) {
    if (!entry?.id) return false;
    this._upsert.run(this._row(entry, weight));
    return true;
  }

  /** 批量写（单事务）。 */
  upsertMany(entries, weightOf = null) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const tx = this.db.transaction((rows) => {
      for (const r of rows) this._upsert.run(r);
      return rows.length;
    });
    const rows = entries
      .filter((e) => e?.id)
      .map((e) => this._row(e, weightOf ? weightOf(e) : undefined));
    return tx(rows);
  }

  /** 按会话查库（冷数据兜底 / 归档查询）。 */
  queryByConv(convKey, { limit = 50, type = null, archived = 0, minWeight = 0 } = {}) {
    const conds = ['conv_key = @key', 'archived = @archived'];
    const params = { key: String(convKey || ''), archived: archived ? 1 : 0 };
    if (type) { conds.push('type = @type'); params.type = String(type); }
    if (minWeight > 0) { conds.push('weight >= @minWeight'); params.minWeight = minWeight; }
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE ${conds.join(' AND ')}
       ORDER BY weight DESC, last_mention_at DESC LIMIT @limit`
    ).all({ ...params, limit: Math.max(1, Number(limit) || 50) });
    return rows.map((r) => this._fromRow(r));
  }

  /** LIKE 关键词兜底查询（内存索引未命中时用；数据量小，性能足够）。 */
  search(convKey, keyword, { limit = 10 } = {}) {
    const kw = `%${String(keyword || '').trim()}%`;
    if (kw === '%%') return [];
    const rows = this.db.prepare(
      `SELECT * FROM memories
       WHERE conv_key = @key AND archived = 0
         AND (text LIKE @kw OR tags LIKE @kw OR participants LIKE @kw)
       ORDER BY weight DESC, last_mention_at DESC LIMIT @limit`
    ).all({ key: String(convKey || ''), kw, limit: Math.max(1, Number(limit) || 10) });
    return rows.map((r) => this._fromRow(r));
  }

  /** 归档：把 id 列表标记 archived。 */
  archiveEntries(convKey, ids, now = Date.now()) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const stmt = this.db.prepare(
      'UPDATE memories SET archived = 1, archived_at = @now WHERE conv_key = @key AND id = @id AND archived = 0'
    );
    const tx = this.db.transaction((list) => {
      let n = 0;
      for (const id of list) n += stmt.run({ key: String(convKey || ''), id, now: Number(now) }).changes;
      return n;
    });
    return tx(ids);
  }

  /** 删除已归档且超龄条目（真正的"抛弃"）。返回删除数。 */
  deleteExpired(now = Date.now(), maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = Number(now) - maxAgeMs;
    return this.db.prepare(
      'DELETE FROM memories WHERE archived = 1 AND archived_at > 0 AND archived_at < @cutoff'
    ).run({ cutoff }).changes;
  }

  /** 好感度历史快照（每日归档用）。members: [{name, score, level, interactionCount, mentionedCount}] */
  snapshotAffinity(convKey, members, now = Date.now()) {
    if (!Array.isArray(members) || !members.length) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO affinity_history
         (conv_key, member, score, level, interaction_count, mentioned_count, snapshot_at)
       VALUES (@key, @name, @score, @level, @ic, @mc, @at)`
    );
    const tx = this.db.transaction((list) => {
      let n = 0;
      for (const m of list) n += stmt.run(m).changes;
      return n;
    });
    const rows = members.map((m) => ({
      key: String(convKey || ''),
      name: String(m.name || ''),
      score: Math.round(Number(m.score) || 0),
      level: Number(m.level) || 0,
      ic: Number(m.interactionCount) || 0,
      mc: Number(m.mentionedCount) || 0,
      at: Number(now) || Date.now()
    }));
    return tx(rows);
  }

  /** 好感度历史（控制台/回溯用）。 */
  getAffinityHistory(convKey, member, { limit = 30 } = {}) {
    return this.db.prepare(
      `SELECT conv_key, member, score, level, interaction_count, mentioned_count, snapshot_at
       FROM affinity_history WHERE conv_key = @key AND member = @member
       ORDER BY snapshot_at DESC LIMIT @limit`
    ).all({ key: String(convKey || ''), member: String(member || ''), limit: Math.max(1, Number(limit) || 30) });
  }

  /** 性格标签写库（upsert 覆盖）。persona: {tags, summary, stats, source} */
  upsertPersonality(convKey, member, persona, now = Date.now()) {
    if (!member) return false;
    this._upsertPersona.run({
      key: String(convKey || ''),
      member: String(member),
      tags: json(persona?.tags),
      summary: String(persona?.summary || ''),
      stats: typeof persona?.stats === 'object' ? JSON.stringify(persona.stats) : '{}',
      source: String(persona?.source || 'rule'),
      at: Number(now) || Date.now()
    });
    return true;
  }

  /** 读单人生理标签。 */
  getPersonality(convKey, member) {
    const r = this._getPersona.get({ key: String(convKey || ''), member: String(member || '') });
    if (!r) return null;
    return {
      convKey: r.conv_key, member: r.member,
      tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })(),
      summary: r.summary,
      stats: (() => { try { return JSON.parse(r.stats); } catch { return {}; } })(),
      source: r.source,
      updatedAt: r.updated_at
    };
  }

  /** 会话内全部成员性格（控制台/上下文兜底）。 */
  listPersonality(convKey) {
    return this._listPersona.all({ key: String(convKey || '') }).map((r) => ({
      convKey: r.conv_key, member: r.member,
      tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })(),
      summary: r.summary,
      stats: (() => { try { return JSON.parse(r.stats); } catch { return {}; } })(),
      source: r.source,
      updatedAt: r.updated_at
    }));
  }

  _fromRow(r) {
    return {
      id: r.id,
      convKey: r.conv_key,
      type: r.type,
      text: r.text,
      tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })(),
      participants: (() => { try { return JSON.parse(r.participants); } catch { return []; } })(),
      target: r.target,
      affinityDelta: r.affinity_delta,
      importance: r.importance,
      weight: r.weight,
      createdAt: r.created_at,
      lastMentionAt: r.last_mention_at,
      lastSeenAt: r.last_seen_at,
      source: r.source,
      archived: r.archived === 1,
      archivedAt: r.archived_at
    };
  }

  close() {
    try { this.db.close(); } catch {}
  }
}

export default MemoryStore;
