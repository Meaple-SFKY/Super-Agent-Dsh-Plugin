# SuperAgent（个人版）

一个常驻在线、事件驱动的个人 SuperAgent，作为 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的 bundle 插件运行。

- **两个来源**：Telegram（日常对话与下指令）、GitHub（Issue/PR 评论、review、CI；可提交分支与 PR）。
- **双层架构**：Router 层（常驻主 Session，负责记忆、判断、调度、对外说话）+ Worker 层（每个 Ticket 一个隔离 Session 执行具体任务）。
- **安静**：默认不确认、不刷进度；只在需要你决策、验收或失败时打扰。
- **自愈**：持久 effect 队列、重启续跑、停滞检测、macOS LaunchAgent 看门狗。
- **失败隔离**：插件加载被 guardian 包住；版本不兼容或初始化失败只会降级提示，不影响 DSH 本体启动。

设计文档见 [docs/000-architecture.md](docs/000-architecture.md)。安装步骤将随 M5 一起提供（SETUP.md）。

## 开发

依赖安装与检查：

```sh
./scripts/pnpmw install        # 使用 DSH 自带的 pnpm（找不到时回退到 PATH 上的 pnpm）
./scripts/pnpmw check          # typecheck + test + build
```

- Node 22.19+ / 24+，DSH 0.2.2-rc.1（`engines.dsh` 锁定 `>=0.2.2-rc.1 <0.3.0`）。
- 状态目录与密钥都不进仓库；密钥只用环境变量/本地文件/钥匙串。

## 目录

```
src/index.ts        guardian：零依赖、永不抛错的插件入口
src/engine.ts       真正的引擎装配（由 guardian 动态加载）
src/core/           领域模型、端口、引擎
src/app/            runtime、SQLite 存储、effect 队列、会话与执行器、HTTP API
src/sources/        Telegram、GitHub
src/tools/          Router / Worker 工具
src/prompts/        角色提示词
src/client/         可选状态面板
scripts/            开发脚本与看门狗
docs/               架构与运维文档
tests/              单元、适配器、集成、恢复测试
```

## 状态

M0（脚手架与契约）进行中。后续按 docs/000-architecture.md §12 的里程碑推进，每个里程碑提交并推送。

## License

MIT
