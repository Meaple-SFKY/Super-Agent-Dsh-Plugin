# 010 · 全量审查索引与结论

审查基线：`ff8a17c`（2026-11-06），`./scripts/pnpmw check` = 25 files / 471 tests 全绿。
方法：6 个并行审查（需求对齐、独立代码审查、核心/存储、Runtime、Sources、打包/面板），只读代码 + 一次临时 SQLite 插桩测量；未改业务代码。

## 文档

| 文档 | 内容 |
| --- | --- |
| [004-requirement-alignment.md](004-requirement-alignment.md) | 原型 7 篇文档 + B 站视频描述 vs 我们的实现：四态对照、偏移、10 项差距 |
| [005-code-review.md](005-code-review.md) | 独立审查：8 个 P1、14 个 P2，按 file:line 给证据与修复 |
| [006-core-review.md](006-core-review.md) | 引擎/SQLite/effect/outbox 量化：104 SQL/Ticket、resume 爆炸、读路径 1500× 优化空间 |
| [007-runtime-review.md](007-runtime-review.md) | 启动/恢复、延迟分解、并发、资源泄漏、5 个优化 |
| [008-sources-review.md](008-sources-review.md) | Telegram/GitHub 请求矩阵、配额、附件安全、5 个优化 |
| [009-packaging-review.md](009-packaging-review.md) | 打包体积、客户端轮询/重渲染、Config 漂移、安装/卸载 |

## 结论摘要

1. **模型层没有漂移**：Source/Trigger/Thread/Eval/Mandate/Ticket/Assignment/Subscription、gate、revalidate、stored work、observe、quiet 都能在 `src/core/` 逐条找到；交付层（Telegram、PAT、LaunchAgent、向导、模型选择、附件）是个人版的主动取舍，方向正确。
2. **两个真语义缺口**：后台任务/槽位调度（长任务会被 LRU 误回收）与 Worker 权限边界（无 blockedCommands / worker-bin / 执行变量；prompt 不是安全边界）。
3. **正确性最高优先级**：同一 Thread 上 ended Ticket 全部 resume（20 张 ended → 20 个 worker）；重复 accept 创建第二张 Ticket；GitHub 写权限可被模型扩大；Source 自动接受任意邀请。
4. **性能瓶颈不在 DB**：单 Ticket 全生命周期约 104 SQL / 13 事务 / 1.2 ms DB；主要延迟来自 2 s 轮询/效果泵、串行 effect（launch/reply）、GitHub 60 s 轮询、worker 启动与模型调用。16 个活跃仓库的 GitHub 配额可能超过 5,000/hr。
5. **面板与可观测性**是最大体验差距：原型 6 个标签、8 阶段、搜索、Prompt 编辑；我们 3 个页面、4 档 stage。

## 建议顺序

- **第一批（P0，0.5–1 天）**：resume 只恢复目标 Ticket；accept/decide 幂等；GitHub 写权限收紧（忽略模型给的 collaborators、仅 created 时邀请、repo 限 allowlist、邀请白名单）；管理 API 接 connection gate + 路由 dispose；uninstall purge 护栏；崩溃 stale lock 恢复。
- **第二批（P1，1–2 天）**：事件驱动 pass + next-due effect 定时器 + per-kind concurrency；Thread 时间线 SQL 分页；prepared statement 缓存；outbox SQL 排序；GitHub 配额感知自适应轮询/通知流；worker 硬上限 + 空闲 TTL + compaction。
- **第三批（P2，体验/维护）**：客户端 minify + 轮询门控 + 内容相等性；打包排除 sourcemap/内部 docs；Config/source 契约测试；面板 Eval/Trigger 只读视图 + 8 阶段；独立 profile/status 诊断。
