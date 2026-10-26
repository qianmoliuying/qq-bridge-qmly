# qq-bridge 代码导读（项目结构 + 详细代码介绍）

> 本文档为阅读 `qq-bridge` 源码的导览：先讲清项目是什么、数据怎么流，再逐目录逐模块拆解代码职责，最后给出主程序 `bridge.js` 内部的功能分区行号表，方便按需跳读。
> 核对基线：v0.2.1-r1（适配 DSH 0.2.1-rc.2），2026-10-26。

---

## 1. 项目定位（一句话）

把 **QQ 消息**接入 **DeepSeek Harness（DSH）agent** 的桥接进程：

- QQ 好友/群发来的消息 → 变成 DSH 会话里的用户消息；
- DSH agent 的回复（含提问、工具审批）→ 发回 QQ。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

**组件角色**：

| 组件 | 角色 | 说明 |
| --- | --- | --- |
| QQ 客户端 | 消息源头/出口 | 由 SnowLuma 注入挂载（**本桥接不碰**） |
| SnowLuma | QQ 网关 | 提供 OneBot v11 WebSocket/HTTP API；桥接**只探测、不部署/不启停**（合规：SnowLuma EULA §5.4） |
| qq-bridge（本仓库） | 桥接内核 | 收 OneBot 事件 → 铸造 Cookie 调 DSH RPC → 把 agent 回复发回 QQ；附带本地 Web 控制台 |
| DSH Web API | agent 引擎 | 会话管理、模型推理、MCP 工具调用、事件流 |

**协议要点**（DSH 侧）：离线铸造会话 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流；会话队列读 `value.projections[<id>].values.inbox`（一元 RPC `session/projections` 为主路径）。

---

## 2. 目录结构总览

```
qq-bridge/
├── src/                      # ★ 桥接内核（唯一生产代码，纯 .js/.mjs）
│   ├── bridge.js             #   主程序（约 12000 行，单文件承载全部业务）
│   ├── core/session-router.mjs  # 会话路由/权限模块（拆分计划中的独立模块，尚未接入主程序）
│   ├── dsh-client.js         #   DSH API 客户端（NodeApiClient 类 + Cookie 铸造 + 事件解析）
│   ├── snowluma-conn.js      #   SnowLuma 连接自发现（token/端点）
│   ├── mcp-snowluma-safe.js  #   MCP server：QQ 动作安全子集（发给 DSH 的 AI 用）
│   ├── mcp-host-server.js    #   MCP server：只读探活 snowluma_status
│   ├── mcp-web-search-safe.js#   MCP server：安全 web_search / web_fetch
│   ├── web-search.js         #   搜索后端：DeepSeek 优先、Bing 兜底
│   ├── safe-fetch.js         #   SSRF 防护的抓取/下载（媒体、网页共用）
│   ├── token-ledger.js       #   token 账本（逐轮明细折叠、幂等）
│   ├── model-prices.js       #   DeepSeek 价目表 + 高峰/空闲分时计价
│   ├── md-to-plain.js        #   Markdown → QQ 纯文本（分句/截断）
│   ├── media-normalize.js    #   图片归一化（多模态入模前处理）
│   ├── slang-learner.js      #   黑话学习（提取/研究/注入上下文）
│   ├── sticker-lib.js        #   表情包库（收藏/查找/注入提示词）
│   ├── voice-core.js         #   语音共享内核（独立 voice-tool 也用它）
│   ├── send-voice-lib.js     #   语音库薄封装（转发 voice-core）
│   ├── qq-model-view.js      #   模型视图/会话模型信息
│   ├── preset-prompt.js      #   preset 提示词校验/渲染
│   ├── role-card.js          #   人格卡解析（角色扮演）
│   ├── forward.js            #   合并转发消息（群聊引用解析）
│   ├── v2-wait.js            #   二代仿真“回合未结束”判断
│   ├── sensitive.js          #   敏感词正则（日志脱敏）
│   ├── state-acl.mjs         #   state/ 目录 ACL 加固
│   └── self-test.js          #   DSH 链路自测入口
├── scripts/                  # 测试/探针/运维脚本（87 个，命名约定见 §8）
├── dsh/agent-presets/        # DSH agent preset 权威源（qq-chat / qq-chat-v2 的 agent.cordis.yml）
├── plugins/
│   ├── qq-agent-presets/     # preset patch bundle（生成 + 唯一工具限制实现 qq-tool-restrict.mjs）
│   └── qq-mode-console/      # DSH 插件：qq-mode 设置命名空间（host 半）
├── public/console.html       # 本地控制台前端（127.0.0.1:3100，单文件 245KB）
├── roles/                    # 人格卡（小鲸鱼.md / 傲娇助手.md；控制台可编辑，保存即生效）
├── docs/                     # 全部文档（guides/ 公开；audits/design/research/legacy 本机可见）
├── assets/                   # 仓库资源（deepseek娘.png）
├── audio/                    # 语音库（用户数据，AI 语音工具只能发这里的文件）
├── state/                    # 运行时数据（会话映射/日志/锁/令牌；不入库，用户数据）
├── config.example.json       # 配置模板（真实 config.json 不入库）
├── package.json              # Node ≥ 22.13，type: module
├── start.bat / restart.bat   # Windows 守护启动 / 一键重启
└── RULES.md / README.md      # 安全承诺与使用说明
```

**一句话规则**：`src/` 是运行时唯一代码；`scripts/` 是开发/测试工具；`dsh/ + plugins/` 是装进 DSH 的东西；`public/roles/audio/state/docs/` 都是内容或数据；`config.json` 是唯一配置。

---

## 3. 核心源码模块详解（src/）

### 3.1 主程序 `bridge.js`（约 12000 行）

单文件承载全部业务，内部结构见 §4。它做的事情：

- 加载/校验 `config.json`，原子写 JSON、上限日志、单实例锁、ACL 加固；
- 连接 SnowLuma（WS 自动重连 + **token/端点自愈**：HTTP token 与 WS token 是两个值，启动首次 1006 是正常现象）；
- 铸造 DSH 会话 Cookie（用 `~/.dsh` 持久化签名密钥离线铸造，不依赖进程期 token）；
- 每 5 秒探活 DSH，断线期间 QQ 消息在内存队列排队（最多 50 条/会话）；
- 每 30 秒读 SnowLuma 心跳 `status.good` 判断上游是否“连上了但收不到”（[Hook] 退化）；
- 内嵌 **Web 控制台**（HTTP server，约 4000 行，十个管理页面）；
- 事件流泵 `pumpMux()` 消费 DSH 的 `remote.mux` 事件 → 转 QQ；
- 处理 QQ 入站消息 → 建/复用 DSH 会话 → 投递 prompt → 收集 agent 回复 → 发回 QQ。

### 3.2 DSH 客户端 `dsh-client.js`（~1000 行）

| 导出 | 职责 |
| --- | --- |
| `resolveDshHome()` | 定位 `~/.dsh` |
| `discoverDshLaunchToken()` | 旧式 launch token 发现（DSH 0.1.7 起仅内存，已死路） |
| `readBrowserSessionSecret()` / `mintBrowserSessionCookie()` | 用持久化签名密钥**离线铸造会话 Cookie**（主鉴权路径） |
| `discoverDshSessionCookie()` | 组合发现 + 铸造 + 缓存，1 小时生命周期、5 分钟余量刷新 |
| `NodeApiClient`（类） | 继承 `AbstractApiClient`：`session/prompt`、`session/selectModel`、`session/cancel`、`session/retire`、`session/projections`、`settings/describe|update`、`remote.mux` 事件流等 |
| `unwrap()` / `createTurnCollector()` / `blocksToText()` | 响应解包、回合收集器（usage 折叠）、内容块转文本 |
| `inboxItemsOfProjections()` / `controlBaselineInboxItems()` | 会话待处理队列解析（读 `value.projections[<id>].values.inbox`） |

### 3.3 SnowLuma 连接 `snowluma-conn.js`（~200 行）

- `snowLumaHomeCandidates()`：候选安装目录；
- `readOneBotTokens()` / `readOneBotHttpTokens()`：从 SnowLuma `config/onebot_<QQ号>.json` 读 HTTP/WS token；
- `discoverSnowLumaConnection()`：自发现（探测 HTTP → WS 探活 → 拿账号/端点），是“换 QQ 账号自动恢复”的核心；
- `persistToken()` / `persistSnowLumaEndpoint()`：把确认可用的 token/端点写回 `config.json`（受 `followDiscoveredEndpoint` 开关约束）。

### 3.4 三个 MCP server（DSH 的 AI 通过这些工具操作 QQ / 上网）

| 文件 | server 名 | 暴露工具 | 安全边界 |
| --- | --- | --- | --- |
| `mcp-snowluma-safe.js` | `snowluma-safe` | `qq_*` 系列（查状态/群/消息、发消息、引用回复、表情、语音等 30 余个） | 发送强制白名单（`allow/deny` + `allowAllWhenEmpty`）；发送类工具分模式注册（closed-agent 才全量）；bootBridgeMode 控制 |
| `mcp-host-server.js` | `snowluma-host` | `snowluma_status`（只读 `get_login_info`） | 只读；**无启停工具**（EULA 合规，勿加回） |
| `mcp-web-search-safe.js` | `web-search-safe` | `web_search`、`web_fetch` | 查询清洗（去 CQ 码/控制字符/截断）；fetch 禁内网、禁凭据、逐跳校验、限量读取 |

### 3.5 媒体与搜索工具链

- **`safe-fetch.js`**：SSRF 防护统一入口——DNS 解析全部结果、禁私有/环回/链路本地/CGNAT、手动跟随重定向逐跳校验、IPv4 优先（修“DNS 先返回 IPv6 → 白等 20 秒”根因）、字节限量；`safeFetchBuffer()` 供图片/媒体下载。
- **`media-normalize.js`**：图片入模前处理——嗅探格式、尺寸/体积收敛（默认单张 ≤64MP、≤8MB、长边 ≤1280）、GIF 抽帧拼接（`gifFrames: 6`）、超时兜底；`describeImage()` 生成图像说明。
- **`web-search.js`**：搜索后端——优先 DeepSeek 联网搜索（与 DSH 同源，凭据按 config → env → DSH `.credentials.yaml` 解析），不可用回退 Bing RSS/HTML；结果缓存与清洗。
- **`sticker-lib.js` / 表情链路**：`mcp-snowluma-safe.js` 中表情优先走 QQ CDN 直链，`get_image` 失败用 `emoji_id` 推出 CDN 地址兜底；`sticker-lib.js` 管收藏/查找/提示词注入。

### 3.6 业务库（黑话 / 语音 / 账本 / 角色 / 提示词）

| 文件 | 职责要点 |
| --- | --- |
| `slang-learner.js` | 群聊黑话提取（窗口滑动 + 冷却 + 阈值推理）、研究（自动联网查证）、上下文注入（`injectMax` 条）；状态机 `SLANG_STATUS` |
| `token-ledger.js` | token 账本：逐轮 `assistant/message.usage` 折叠、幂等（同轮重试去重）、按时间桶聚合，供控制台看板 |
| `model-prices.js` | DeepSeek 官方价目表 + 中国法定节假日高峰/空闲分时（高峰单价为空闲 2 倍），`priceUsage()` 折算金额 |
| `role-card.js` | 人格卡解析：`parseRoleSections()` 把 `roles/*.md` 拆成区段，按模式选注入文本，字数统计/报告 |
| `preset-prompt.js` | preset 提示词安全校验：必含标记、阻断子串（防越权指令）、字节上限、YAML 渲染 |
| `qq-model-view.js` | 会话模型信息（model 描述/年龄），控制台模型视图用 |
| `forward.js` | 合并转发消息提取（`extractForwardIds`）、ID 清洗、响应格式化 |
| `v2-wait.js` | 二代仿真回合是否结束的判断（`looksLikeUnfinished`：思考痕迹/未闭合输出） |
| `md-to-plain.js` | Markdown → 纯文本（保留 `文字 (url)`）、按句读/URL 边界分条（`splitForQQ`）、截断 |
| `sensitive.js` | `SENSITIVE_RE` 敏感词正则，日志/工具参数脱敏 |
| `state-acl.mjs` | Windows ACL 加固（`hardenDir`/`hardenFile`）：切断继承、只留当前用户，防 DSH 沙箱写 state/ |

### 3.7 待接入模块 `src/core/session-router.mjs`（~470 行）

- `SessionRouter` 类：会话策略路由——模式归一（`chat/reserved/reserved2/simulation/closed-agent`）、每会话权限（mode/preset/owner）、状态校验（含 `updatedBy` 审计字段）、状态快照迁移；
- **目前只有自测引用**（`session-router.test.mjs`），主程序 `bridge.js` 尚未 import 它——属 QSH 拆分计划的先头模块，可独立运行测试：`node src/core/session-router.test.mjs`。

### 3.8 记忆 / 好感度 / 性格系统（新增，v0.3 方向）

| 文件 | 职责 |
| --- | --- |
| `memory-core.js` | 权重计算（importance × 时间衰减 × 好感系数）、紧凑格式化（单条 ≤60 字）、中文 2-gram 倒排索引、Top-K 选择、命中查询、自动标签（类型/情绪/好感方向/时间） |
| `affinity.js` | 好感度引擎：规则增减（互动 0.5 / 被@ 1 / 情绪词 ±2，7 天未互动衰减）+ AI 补判接口（30 分钟节流）、好感等级（冷淡/普通/友好/亲密）→ 记忆配额（3/5/8/12 条）、会话好感聚合 |
| `personality.js` | 性格分析：规则统计初判（话痨/活跃/乐观/毒舌/爱提问/夜猫子等，样本 ≥10 条）、AI 精修接口（24h 节流）、「好感 × 性格 → 倾向建议」映射、成员块格式化 |
| `memory-store.js` | SQLite 层（better-sqlite3）：`memories`（即时写库/归档/删除）、`affinity_history`（每日好感快照）、`personality`（性格入库）；WAL、参数化 SQL、事务批量 |

**bridge.js 接线**（均以 `cfg.memory.*` 配置段控制，默认开启）：
- `handleIncoming` 对每条有效消息跑 `touchAffinityAndPersona`（好感+性格统计，零额外 token）；
- `appendMemoryV2` 的条目带 `id/tags/importance/affinityDelta`，重要记忆（importance≥4 或 weight≥0.35）即时写库；
- `formatMemoryV2` 从"全量 30 条"改为**按权重 Top-K 注入**（配额随好感等级变化）+ 在场群友「好感/性格/倾向」块；
- `buildWakePromptV2` 额外做**命中注入**：最近消息分词 → 倒排索引 → 相关记忆 1~3 条单条引用（token 最省）；
- 每日 `archiveHour`（默认 3:00）`archiveColdMemories`：冷数据（weight<0.05 且 7 天以上）出内存落库、好感快照、性格入库、删除 30 天前已归档条目；启动补跑错过的归档；
- 控制台新增 `/api/socialV2/affinity`、`affinity-set`、`memory-search`、`archive-now`；
- MCP 新增 `qq_affinity_query` / `qq_memory_search`（开关组 `memory`）。



---

## 4. `bridge.js` 主程序内部结构（功能分区行号表）

> 行号基于当前版本实际文件。结构：第 1–1384 行为顶层工具函数，`main()` 自 1385 行起，进程信号处理在 12040 行后。

### 4.1 顶层（1–1384）：通用工具

| 区间 | 内容 |
| --- | --- |
| 1–57 | import（node 内置 + 全部自研模块 + SDK） |
| 59–98 | 常量：ROOT/STATE_DIR、各 state 文件路径、模式别名表 `MODE_INPUT_ALIASES`（`simulation`→`reserved2` 收敛） |
| 101–239 | `normalizeModeInput`、`settingFromDshNamespace`（user 层优先）、`readJsonSafe`/`readConfigObject`、`renameWithRetry`/`atomicWriteJson`/`atomicWriteText`、`loadOrCreateConsoleToken`、`hardenStateDirAcl` |
| 266–400 | 角色卡：`listRoles`/`validateRoleName`/`readRoleContent`/`writeRoleContent`（Windows 保留名防护、字节上限、角色名上限） |
| 401–497 | preset 管理：`presetSourceYaml`/`installedPresetYaml`/`readPresetPromptText`/`backupPresetFile`/`listPresetBackups`/`presetStatus` |
| 498–618 | `SILENT_MARKER`、发送工具名识别（`isSendToolName`）、agent token 记忆（脱敏用）、`normalizeReasoningEffort`、`redactSensitiveText`、`escapeCqText` |
| 620–1013 | 活动日志、角色状态读写、`loadConfig()`（~360 行：全字段校验与收敛） |
| 1014–1200 | `loadState`/`saveState`（会话映射）、单实例锁（`acquireLock`/`releaseLock`）、上限日志器 `createCappedLogger`、`log` |
| 1225–1384 | `withTimeout`、`segmentsToText`（QQ 消息段 → 文本）、媒体摘要清洗、`extractMediaFromSegments`、`allowed`（白/黑名单判定）、`canonicalV2Key`、审批词表 |

### 4.2 `main()` 内部（1385–12037）

| 区间（行号） | 功能分区 | 关键函数 |
| --- | --- | --- |
| 1385–1544 | 表情包 | `syncStickerLibrary`、`getStickerImageData`、`stickerEnabled` |
| 1555–2067 | 语音 | `voiceCfg`/`voiceLibrary`/`resolveVoicePathForOperator`（路径白名单）、`voiceBudgetCheck`（频控）、`verifyVoiceMessageSent` |
| 2068–2384 | 黑话学习 | `saveSlangStore`、`runSlangExtraction`/`runSlangResearch`、`feedSlangWindow`、`maybeQueueSlangExtraction`、`withSlangContext` |
| 2385–2558 | 模型目录 + 令牌账本 | `fetchModelCatalog`、`rememberModel`、`recordSessionUsage`/`recordSessionSnapshot`/`rebuildInFlightCollector`、唤醒租约 `armPendingWakeLease` |
| 2599–2822 | 模式与策略 | `refreshMode`（读 DSH 设置，5 秒轮询）、`modeAllowed`、`resolvePresetName`、`sessionPolicy`、`retireSession`（退役清队列）、`reconcileSessionPolicies`（策略变更即重建会话） |
| 2823–3004 | DSH 看护 | `flushQueue`（断线排队补投）、`checkDsh`（5 秒探活）、`startDshWatch` |
| 3005–3118 | SnowLuma 健康 | `noteReceiveHealth`/`snowlumaHealthSnapshot`/`reportSnowlumaHealth`、`pollSnowlumaStatus`（心跳 `status.good` + `get_status` 兜底）、`startSnowlumaWatch` |
| **3119–7209** | **Web 控制台** | `startConsoleServer`（约 4090 行）：十个页面 API（总览/会话审批/人格角色/二代仿真/一代仿真/黑话/令牌花费/访问安全/调试运维/工具参考），`/api/*` 路由、令牌鉴权、token 看板下钻、角色 CRUD、模式切换写 DSH + 本地兜底 |
| 7210–7623 | 发送管线 | `redactKnownTokensOnly`、`sendToQQ`、`singleLineForQQ`、`splitLongSegment`（按句读/URL 分条）、`planSocialTimeline`/`sendBurstToQQ`（连发节奏）、`onebotSend` |
| 7624–8027 | 媒体处理 | `toModelMedia`、`emojiCdnCandidates`/`emojiIdFromFileName`、`fetchOneBotImage`/`fetchFaceMedia`/`resolveMediaList`/`fetchMediaData`、`mediaHintFor` |
| 8028–8075 | 审计发送 | `captureSendGuard`（AI 已用工具发过则跳过自动转发）、`auditAndSend` |
| 8076–8620 | 会话管理 | `ensureChatModel`（每会话 `session.selectModel` 固定模型）、`ensureSession`（建/复用 DSH 会话，拒绝无 preset 的会话） |
| 8621–8906 | 会话初始提示词 | `loadInitialPrompts`/`setInitialPrompt`（操作者预写、仅首次唤醒注入） |
| 8907–9590 | 一代仿真（reserved） | `socialState` 状态机（观望/活跃/试探/退场）、`isDirectAddress`/`isMustReplyText`、`buildBatchPrompt`、`scheduleSocialReply`、`socialLoopTick`/`startSocialLoop`、`[SILENT]` 潜水、空格分句 |
| 9591–9938 | 群成员/引用解析 | `assertGroupMember`、`resolveGroupMemberName`、`resolveReplyInfo`（引用 → “被引用人+原文”）、`isQuoteTargetSelf`（引用自己=必回） |
| 9939–10144 | 反馈 + 工具日志 | `appendFeedbackEntry`、`appendToolLog`（tool-calls.jsonl）、`redactSensitive`/`sanitizeToolArgs` |
| 10145–10816 | 时间感知 + 队列排水 | `timeSenseCfg`/`buildTimeSenseLine`（把“现在是几点、距上次说话多久”注入上下文）、`wakeReasonSeq`、`drainPromptQueue` |
| 10817–11340 | 入站事件处理 | `handleIncoming`（QQ 消息 → 模式分发 → 会话/仿真）、`handlePendingAnswer`（审批/提问回复）、`handlePokeNotice`（戳一戳）、`registerPending` |
| 11341–11915 | **事件流泵** | `pumpMux()`（约 570 行）：消费 DSH `remote.mux` 事件，`trackTurnEvent` 按回合收集消息/usage/工具审批，超时/结束发送 |
| 11916–12037 | token 自愈 + bot 生命周期 | `applyHealedTokens`/`syncTokenToFile`/`healTokenIfStale`（10 秒节流）、`bot.on('close'/'error')` → 自愈重连、`bot.connect()` |

### 4.3 进程生命周期（12040–12075）

- `SIGINT`/`SIGTERM`：`saveState()` + `releaseLock()` 干净退出；
- `unhandledRejection`：打堆栈（区分“偶发”与“坏六小时”）；
- `uncaughtException`：兜底保存状态、释放锁、退出码 1（防守护窗口 EPIPE 空转崩溃循环）；
- `exit`：兜底释放锁。

---

## 5. 消息处理流程（读懂链路的关键）

### 5.1 入站（QQ → DSH）

```
QQ 消息 → SnowLuma WS 事件 → bridge.js 的 bot 事件回调
  → handleIncoming(kind, id, event, cfg)      # 按模式分发
      ├─ chat / closed-agent：ensureSession → ensureChatModel → session.prompt
      ├─ reserved（一代仿真）：socialState 状态机决定是否接话 → buildBatchPrompt → 投递
      └─ reserved2（二代仿真）：不自动投递，AI 靠工具自行看消息（qq_get_unread_messages 等）
```

### 5.2 出站（DSH → QQ）

```
DSH remote.mux 事件流 → pumpMux() 按回合收集
  → 回复文本 → auditAndSend（AI 已用发送工具则跳过重复转发）
  → sendToQQ / sendBurstToQQ → onebotSend → SnowLuma HTTP API → QQ
  ├─ 提问（ask_user_question）→ QQ 转发 → 回复自动应答
  ├─ 工具审批请求 → QQ 转发 → “通过/拒绝”即可决策
  └─ 一代仿真：只输出 [SILENT] → 静默不发送
```

### 5.3 会话映射

- 每个 QQ 会话（私聊/群）对应一个独立 DSH 会话，统一归组「QQ 聊天」工作区；
- 映射持久化在 `state/sessions.json`；模式/preset 变化自动重建会话（保留旧历史在 DSH 中）。

---

## 6. 运行模式

| 模式 | 规范名 | 面向 | preset | 行为 |
| --- | --- | --- | --- | --- |
| `chat` | chat | 白名单群 + 白名单私聊 | `qq-chat` | 安全聊天，无本地工具 |
| `closed-agent` | closed-agent | 仅私聊 owner | DSH 默认（standard，可改） | 完整工具，可在 QQ 上操控 DSH |
| `reserved` | 一代仿真 | 仿真群友 | `qq-chat` | 观望/活跃/试探/退场状态机、空格分句、`[SILENT]` 潜水 |
| `reserved2` | 二代仿真（`simulation` 别名收敛到它） | 仿真群友 | `qq-chat-v2` | 文本不自动转发，AI 用 `qq_get_unread_messages`/`qq_send_message` 等工具自主收发、唤醒/潜水 |

> 模式切换：控制台顶部按钮 → 同时写 DSH 设置（`settings/update`，user 层）与本地 `state/mode.json` 兜底；5 秒轮询读回（`settingFromDshNamespace` 的 user 层优先是修“改不生效”的关键）。

---

## 7. Agent preset 与安全设计

### 7.1 preset 双层结构

- **权威源**：`dsh/agent-presets/qq-chat/`、`qq-chat-v2/` 的 `agent.cordis.yml`（改这里）；
- **安装形态**：`scripts/build-agent-preset-patches.mjs` 生成 bundle patch → `plugins/qq-agent-presets/presets/*.patch.yml` → `setup-dsh.mjs` 插入 DSH profile（`@deepseek-ai/dsh-agent-preset` 行，**重启 DSH 生效**）；
- **两层提示词**：仿真提示词（preset 内置，管行为与协议）+ 人格提示词（`roles/*.md`，管人设语气，保存即生效，由 `state/current-role.json` 注入，群友无法更改）。

### 7.2 安全不变量（RULES.md / qq-tool-restrict）

1. **QQ 侧无本地工具**：`qq-chat`/`qq-chat-v2` 都不挂 bash/文件工具——群友物理上无法让 AI 操作本机；
2. **工具限制三重防线**：`qq-tool-restrict.mjs`（plugins）把开发/管理工具从工具清单**隐藏** + 注册期 `tools.restrict` 拒绝 + schema 隐藏；失败会写 `state/tool-restrict.log` 诊断；
3. **发送强制白名单**：`mcp-snowluma-safe.js` 按 `allow/deny` + `allowAllWhenEmpty` 判定，fail-closed 默认（空白名单 + false = 不响应任何消息）；
4. **会话 fail-closed**：群聊会话拿不到 `qq-chat` preset 时**拒绝建会话**，绝不回退到带本地工具的默认 preset；
5. **SSRF 防护**：媒体下载、web_fetch 全部走 `safe-fetch.js`（禁内网、逐跳校验）；
6. **敏感信息**：日志/工具参数经 `SENSITIVE_RE` 脱敏，agent token 只留上一代+当前代。

---

## 8. `scripts/` 命名约定（87 个文件）

| 前缀/形态 | 含义 | 备注 |
| --- | --- | --- |
| `test-*.mjs` | 自动化测试 | 被 `test-audit.mjs` 收进 `npm run test:audit` 的离线回归可放心跑 |
| `test-dsh-*.mjs` | 需要活 DSH 的测试 | `test-dsh-auth` / `test-dsh-inbox-projection` / `test-dsh-session-retire` / `test-dsh-v2-wait` |
| `test-audit-*.mjs` | test-audit 子模块 | `-bridge` / `-protocol` / `-security` / `-setup` |
| `test-console-ui.mjs` | 控制台离线浏览器回归 | 配 `console-ui-*.json` 基线 + `fixtures/` |
| `setup-*.mjs` | 安装/初始化 | `setup-dsh.mjs` 幂等装 preset + MCP |
| `verify-*.mjs` | 一致性校验 | `verify-dsh-021-adaptation.mjs`（`npm run verify:adaptation`） |
| `probe-*.mjs` | 探针：问 DSH/SnowLuma 实际支持什么 | 鉴权统一走 `probe-auth.mjs` |
| `scan-*` / `dsh-tool-names.mjs` | 工具名对账 | 升级 DSH 后跑，防新工具漏隐藏 |
| `patch-*.mjs` | 补丁 | **`patch-snowluma-sdk.mjs` 是 postinstall 依赖，不能删** |
| `cleanup-*`/`fix-*`/`diag-*`/`debug-*` | 一次性运维脚本 | 疑似过期，待确认，不影响回归 |

**常用命令**：`npm start`（守护用 `start.bat`）、`npm run test:audit`（离线全回归）、`npm run self-test`（DSH 链路自测）、`npm run verify:adaptation`（DSH 版本适配核对）、`npm run probe:heartbeat`（上游健康）。

---

## 9. 配置文件 `config.json`（模板 `config.example.json`）

| 段 | 关键字段 |
| --- | --- |
| `dsh` | `baseUrl`(默认 3080) / `provider` / `model` / `reasoningEffort` / `authToken`(通常留空=离线铸造 Cookie) |
| `snowluma` | `wsUrl`(WS 端口) / `httpUrl`(HTTP 端口，勿填 WS 端口) / `accessToken` / `followDiscoveredEndpoint`(端点自愈开关) / `launcherPath` / `homeDir` |
| `ownerQQ` / `agentPreset` | 管理员 QQ；默认 preset `qq-chat` |
| `allow` / `deny` / `allowAllWhenEmpty` | 白/黑名单（默认 fail-closed） |
| `social` | 一代仿真全部参数（触发概率/状态机时长/连发节奏） |
| `socialV2` | 二代仿真：`tools` 开关矩阵（30 余个工具逐个可关）、`wake`(唤醒/潜水策略)、`send`(连发节奏)、`sticker`、`voice`、`media`(8MB/64MP/5 张) |
| `slang` | 黑话学习（开关/冷却/阈值/自动研究） |
| `webSearch` | `provider`(auto/deepseek/bing) / API key 解析链 |
| `consolePort` / `consoleToken` | 控制台端口 3100 / 令牌（留空自动生成） |

---

## 10. 推荐阅读顺序

1. **本文档 §1–2**：先懂链路与目录；
2. **README.md**：使用视角全貌；
3. **`src/bridge.js` 的 main() 骨架**（§4.2 行号表跳读）：`ensureSession`(8103) → `handleIncoming`(10817) → `pumpMux`(11341) → `auditAndSend`(8054) → `sendToQQ`(7223)，这一条就是核心往返；
4. **`dsh-client.js`**：DSH 协议层（Cookie 铸造 + NodeApiClient + 事件流）；
5. **`mcp-snowluma-safe.js` + `plugins/qq-agent-presets/qq-tool-restrict.mjs`**：AI 的工具面与安全边界；
6. **`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`**：二代仿真的行为定义（读它=读懂“AI 怎么在群里活着”）；
7. 其余模块按需查 §3 表格。

---

*本文档由代码梳理生成，行号对应 2026-10-26 版本（v0.2.1-r1）；如需更新请对照 `src/bridge.js` 实际内容。*
