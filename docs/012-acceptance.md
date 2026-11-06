# 012 · 三批优化验收总结

状态：**已完成**（2026-11-07，commit `0bbdcb7`，版本 `0.2.0`）。
全量验证：`./scripts/pnpmw check` = **32 files / 600 tests 全绿**；QA 独立对抗验证见 [011-p0-verification.md](011-p0-verification.md)。

## P0 正确性 / 安全

| 项目 | 结果 |
| --- | --- |
| resume 爆炸 | 同一 Thread 20 张 ended Ticket + 1 条消息 → 仅 1 次 resume/launch；显式 `meta.ticketId` 优先；open owner 时不 resume ended |
| accept / decide / retry 幂等 | 重复 accept 返回既有 Decision/Ticket；retry 不叠加；reevaluate 仍可二次决策 |
| 管理 API | 11 条路由统一 connection/Host/Origin + header fence；stop 全部 dispose；重启不重复注册 |
| 崩溃锁 | pid 记录；死 pid/同 pid/无 pid ≥30s 自动恢复；活外部 pid 明确失败 |
| GitHub 写权限 | 配置-only collaborators；仅 `created` 时邀请；repo allowlist；既有仓库 0 邀请 |
| 邀请白名单 | `acceptInvitations` off/allowlist/all，默认 allowlist；可信 inviter/owner |
| 附件安全 | 出站 realpath + 拒绝 symlink/越界；入站按 chat 唯一命名；命令/callback 持久去重 |
| 卸载护栏 | stateDir marker + 黑名单 + `--force`/`--dry-run`；`$HOME`/`$DSH_HOME` 拒绝 |
| 看门狗 | 当前 Node 绝对路径、日志轮转、状态文件、安装自检/回滚 |

## P1 性能

| 指标 | 之前 | 之后 |
| --- | --- | --- |
| Thread 10k 历史查询 | 14.9 ms | 0.059 ms（252×） |
| Thread 20k 历史查询 | 28.3 ms | 0.052 ms（545×） |
| 单 Ticket DB 生命周期 | 0.68 ms / 104 prepare | 0.32 ms / 0 prepare |
| 框架附加延迟 | 2–8 s | 事件驱动 wake + next-due timer，显著降低 |
| effect 并发 | launch/reply 全局 1 | launch 2 / assessment 2 / reply 按 ticket+会话分区 |
| worker 生命周期 | 无 TTL / 软上限 | 硬准入 + 15 min 空闲 TTL + ticket 结束释放 |
| GitHub 16 仓库 | 5.8k–15.4k req/hr | 2.9k–3.8k（全活跃）；全 quiet 128/hr |
| outbox 积压 | O(n²) | 分区并发、顺序保持 |

## P2 打包 / 客户端 / 契约 / 面板

- tarball：512KB → **235KB** packed；1.97MB → **845KB** unpacked；无 sourcemap/内部 docs；
- client：175KB → **130KB**，gzip 40KB → 35.7KB；空闲轮询 29 → **13 req/min**；内容相等不重渲染；
- Config/source 契约测试；补 Telegram/GitHub 字段；删除 `quietHours`；修正 `pollSeconds`；
- Ticket/决策只读详情 + 8 阶段；`SafeView` 渲染隔离；
- schema v1 → v2 自动迁移（回滚前备份 stateDir）。

## 个人 PAT 自动化

- 向导保存前邀请 bot 为 push collaborator、让 bot 接受邀请；
- PAT 存 `<stateDir>/secrets/github-operator-token` 0600，不写入配置；
- `create_repository` 自动邀请并接受 operator 邀请；支持 `remove:true` 清除。

## 残余风险 / 后续

- 未做真实干净 profile 的 tarball 在线安装、真实 Telegram/GitHub 网络、真实 launchctl、浏览器 Profiler/axe；
- 真实 SIGKILL 重放窗口用 offset 重放模拟；
- worker 仍有 shell 权限，可把文件复制到允许目录（附件护栏是边界不是沙箱）；
- agent-team/workflow/plan mode 未默认启用。
