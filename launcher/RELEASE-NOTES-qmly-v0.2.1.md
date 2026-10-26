# v0.2.1-qmly.1 —— 记忆 / 好感度 / 性格系统 + 一键版启动器

> 本发布是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（上游 `v0.2.1-r1`）的 **fork 分支构建**，
> 遵循上游 **MIT License**（`LICENSE` 保留原版权声明）。原分支全部功能与文档完整保留。

## 本版新增（相对上游 v0.2.1-r1）

### 1. 记忆系统（权重化 + 持久化）
- 记忆权重 = 重要性 × 指数半衰衰减 × 好感系数；最近/高权记忆长驻上下文，冷数据分级降冷
- 自动标签分类（类型 / 情绪 / 好感方向 / 时间 / @参与者）；不重要记忆归档 30 天后删除（留痕）
- SQLite 持久化（`state/memory.db`，better-sqlite3，WAL）；重要记忆 append 即写库；每日 3:00 冷数据归档 + 启动补跑
- 中文 2-gram 倒排索引：对话提起旧记忆时秒级命中，上下文只注入命中的 1~3 条（最少 token 引用）

### 2. 好感度系统
- 规则增减（互动/被@/情绪词/7 天未互动衰减）+ AI 补判接口（30 分钟节流）
- 好感等级（冷淡/普通/友好/亲密）→ 记忆注入配额（3/5/8/12 条）：**好感越高，上下文记忆越多**
- 好感历史快照每日入库（`affinity_history`）

### 3. 性格系统
- 对话者性格规则初判（话痨/活跃/乐观/毒舌/爱提问/夜猫子等，样本 ≥10 条）+ AI 精修接口（24 小时节流）
- 性格标签入库（`personality` 表）；上下文携带「印象|名字|性格标签|好感分(等级)|倾向:建议语气」

### 4. 一键版启动器（本 Release 附件）
- 附件 `qq-bridge-qmly-oneclick-v0.2.1-win-x64.zip`（下载：https://github.com/qianmoliuying/qq-bridge-qmly/releases/download/v0.2.1-qmly.1/qq-bridge-qmly-oneclick-v0.2.1-win-x64.zip）：便携目录 + `一键启动.exe`（Node SEA 单文件）
- 编排 DSH（探测 3080）→ SnowLuma（探测+引导）→ 桥接；汉化菜单、统一日志、`--check` 自检
- 目标机器无需安装 Node（自带便携运行时）；首次在菜单 `[3]` 配置 SnowLuma 启动器路径即可一键启动

### 5. 配套
- 新 MCP 工具 `qq_affinity_query` / `qq_memory_search`（开关组 `memory`）
- 控制台新增好感度/记忆检索/归档 API；回归测试 `test-memory-system.mjs`（21 断言）并入 `npm run test:audit`
- 代码导读更新：`docs/guides/PROJECT_STRUCTURE_GUIDE.md` §3.8

## 与原分支的区别
完整说明见仓库 README 顶部「本分支（qq-bridge-qmly）说明」——本分支在保留上游全部能力的前提下，
新增记忆/好感/性格三层社交系统与一键部署形态；可独立运行，也可随时合回上游。

## 合规声明
- 遵循上游 **MIT License**，版权归原分支作者及贡献者
- **不打包、不自动部署 SnowLuma 本体**（EULA §5.4）：一键版启动器只探测 + 引导用户自行安装的 SnowLuma
- `config.json`（含 QQ token）、`state/`（记忆库/会话映射）等本地敏感数据不入库、不进 Release

## 安装与使用
1. 下载附件 `qq-bridge-qmly-oneclick-v0.2.1-win-x64.zip` 解压，双击 `一键启动.exe`，按 README-一键启动.txt 首次配置
2. 或按上游 README 原流程：`git clone` → `npm install` → 复制配置 → `npm start`
