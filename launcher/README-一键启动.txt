# 大肥鱼 QQ↔DSH 一键版 使用说明

把 DeepSeek Harness（DSH）与 QQ 桥接（qq-bridge）集成成便携目录，双击 exe 即可编排启动。
SnowLuma 按合规边界**不打包在本目录内**，由启动器探测并引导（首次使用时配置一次路径即可一键拉起）。

## 目录结构

```
一键版/
├─ 一键启动.exe       ← 启动器（Node SEA 单文件，含进程编排/菜单/日志）
├─ runtime/node.exe   ← 便携 Node 运行时（目标机器无需安装 Node）
├─ bridge/            ← qq-bridge 完整工程（源码/依赖/状态/文档）
│   ├─ src/  scripts/  state/  node_modules/  config.example.json
│   └─ config.json    ← 首次启动自动从 config.example.json 生成
├─ launcher-config.json ← 启动器配置（SnowLuma 路径/端口）
└─ logs/              ← launcher.log（启动器日志）、bridge.log（桥接日志）
```

## 快速开始（首次）

1. 双击 `一键启动.exe`，进入菜单。
2. 菜单 `[3] 配置 SnowLuma 启动器路径`：输入你已安装的 SnowLuma 启动器 exe 完整路径（例如 `D:\SnowLuma\SnowLuma.exe`），回车保存。
3. 先手动打开 DeepSeek Harness 桌面版（让 DSH Web API 运行在 127.0.0.1:3080）。
4. 菜单 `[1] 一键启动全部`：启动器自动等待 DSH 就绪 → 拉起 SnowLuma（若已在运行则跳过）→ 启动桥接。
5. 检查 `bridge/config.json`：首次会自动从示例生成，请确认 QQ 号/DSH 地址等关键项（参考原工程 `docs/guides/DSH_SETUP.md`）。

## 日常使用

| 操作 | 方法 |
| --- | --- |
| 一键启动全部 | 双击 exe → `[1]` |
| 仅重启桥接 | exe → `[2]`（DSH/SnowLuma 已运行时） |
| 停止桥接 | exe → `[5]`（SnowLuma 需自行退出，本启动器不强制停它） |
| 看日志 | exe → `[4]` 打开 logs 目录；或直接看 `logs/bridge.log` |
| 换 SnowLuma 路径 | exe → `[3]` |

## 合规与依赖边界（重要）

- 本一键版**不包含、不复制、不打包 SnowLuma 本体**（SnowLuma EULA §5.4：专有组件并入第三方安装包/自动化部署需书面授权）。启动器仅在用户配置路径后将其拉起，未配置时仅提示。
- DSH Web API 由 DeepSeek Harness 桌面版提供（3080 端口）；启动器只探测，不代启桌面版。
- 桥接进程由启动器管理：退出菜单 `[0]` 或 `[5]` 会停止桥接；SnowLuma 保持独立生命周期。
- 若目标机器已有系统 Node ≥22，`runtime/node.exe` 缺失时启动器会自动回退使用系统 node。

## 重新构建

源码级改动后重新打包（需本机有 Node ≥22 与网络，`npx postject` 需联网）：

```
node launcher/build.mjs
```

产物输出到 `dist/一键版/`。构建脚本会：组装便携目录 → SEA 生成 `一键启动.exe` → 自动跑 `--check` 自检。

## 冒烟自检

```
一键启动.exe --check
```

打印各环境项（桥接目录/便携 node/DSH 状态/SnowLuma 状态）并给出通过/缺口结论，不启动任何服务。
