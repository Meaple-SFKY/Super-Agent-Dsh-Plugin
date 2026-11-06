# 006 · 核心 / 存储 / 效果队列 架构与性能审查

- 审查对象：`src/core/{model,gate,engine,stores,ports}.ts`、`src/app/{store,effects,outbox}.ts`、`tests/core-*`、`tests/store-*`、`tests/effects-*`、`tests/outbox-*`；为解释 tick/poll 语境少量引用 `src/app/runtime.ts`（不属于本次改动范围）。
- 基线：工作区 commit `ff8a17c`（`build: make the packed bundle self-resolving for URL installs`），`./scripts/pnpmw test` 为 25 files / 471 tests 全绿；Node `v26.13.0`，`node:sqlite` 内置 SQLite `3.54.0`，macOS/APFS。
- 方法：**代码静态审查 + 一次临时插桩测量**。测量脚本未提交（放在 `/tmp`，用 Vite SSR 加载 `src/**/*.ts`，并通过 monkey-patch `DatabaseSync#prepare`、`StatementSync#{run,get,all}`、`DatabaseSync#exec` 计数），数据库为 WAL 模式的真实 SQLite 文件；所有数字是"本机、纯 DB（不含模型/网络/worker 启动）"的数字，绝对值请只作数量级参考，**相对缩放（O()）才是有意义的结论**。
- 约束：本任务只产出本文件，**没有改任何代码**；文中给出的修复均为建议/伪代码。

---

## 1. 执行摘要

系统在"单用户、每天几十条事件"的量级下 **DB 不是瓶颈**（每条消息的 DB 时间 0.1–1 ms，空闲轮询 13 µs / 2 s），当前架构的安全边界（单写事务、effect 持久化、at-least-once、WAL）是合理的。真正的风险集中在 **三处 O(历史/宽度) 的生长 + 两处轮询积压**：

| 优先级 | 问题 | 证据（实测） | 影响 |
|---|---|---|---|
| **P0** | **resume 爆炸**：同一个 DM Thread 上每张 ended Ticket 都保留 Subscription，一条新人消息会 resume **全部** ended Ticket | 20 张 ended Ticket → 1 条消息 = **20 次 resume、20 个新 Assignment/launch**（DB 344 条语句 / 44 个事务） | 错（一次消息触发 20 个 worker）+ 费用/噪音；随历史 Ticket 数线性恶化 |
| **P1** | **Thread 历史读取 O(H)**：`threadTriggers` 先取全量行再在 JS 里 `slice`，且 `ORDER BY t.at` 走临时 B-tree | 10k–20k 条历史：**15.5–33 ms/次**（每次 candidate / Thread 页都调用；20k 实测 28.8 ms）；改成 `ORDER BY tt.at DESC LIMIT 50` 后 **0.020 ms（20k 条）** | 长寿命 DM Thread 上每次评估/翻页线性变慢，20k 时约 30 ms + 约 5 MB JSON 解析 |
| **P2** | **预编译语句未缓存 + 写放大**：每次 repo 调用都 `db.prepare`，ticket/thread 整行 JSON 重写 | prepare 13.1 µs vs 复用执行 1.7 µs（**约 87% 的 DB 时间是编译**）；单 Ticket 生命周期 **104 条语句 / 13 个事务**；ticket 1000 inputs=84 KB、thread 500 decisions=7.9 KB 每次整行重写 | 核心 DB 时间可降 4–5×；热 Thread 上 WAL 写放大明显（同 Thread 500 条 25 MB vs 唯一 Thread 1.7 MB） |
| **P3** | **轮询/积压**：2 s pass + 2 s effects + 单并发；`effects.all()` 每轮全量解析；outbox 每条消息扫全部 reply 行 | 评估→候选最多 **+4 s**、accept→launch / report→send 各最多 **+2 s**；effects 100 行 concurrency=1：7.2 ms/101 次全表解析，concurrency=4：2.5 ms/26 次；outbox 积压 50→400 时 **0.113→0.563 ms/msg**（≈O(n²)） | 用户感知延迟与积压吞吐；平时无感，突发/重启后放大 |
| **P4** | **重复决策/重试无幂等**、恢复期竞态 | `decide()` 无 `disposition.decisionId` 守卫（重复 decide 可建第二张 Ticket）；`retryTicket` 可叠加 pending Assignment | 低频但会重复烧 token/打扰，属正确性残留风险 |

> 结论：**先修 P0（正确性），再修 P1/P2（容量与热路径），最后做 P3（延迟/积压）**。P4 与 P0 同一轮处理成本最低。

---

## 2. 运行模型与热路径复杂度

```
Source.poll ──receive()──► Trigger+Disposition+Thread (+fan-out)   [同步, 1 txn]
      │
      ├─ ≤2s: Runtime pass  ─► Engine.evaluateDue() ─► startEval() ─► assessment effect
      ├─ ≤2s: Effects pump  ─► assessment handler ─► candidate() ─► Router turn（LLM）
      │        Router decide() ─► Ticket+Mandate+Assignment ─► launch effect
      ├─ ≤2s: Effects pump  ─► launch handler ─► Executor.launch()（worker 启动，LLM）
      │        worker report() ─► Outbox.queue()（Receipt + reply effect）
      └─ ≤2s: Effects pump  ─► reply handler ─► Source.send()
```

所有跨模块推进都是**轮询**：Runtime pass 2 s（`runtime.ts:1145-1148`）、Effects pump 2 s（`effects.ts:93,186`）、Outbox reply 单并发（`outbox.ts` 构造处 5 s→300 s 退避）。Source 侧轮询（GitHub 60 s 等）不在本审查范围，但它决定了上游触发频率。

### 2.1 每条路径的复杂度与实测

| 路径 | 代码 | 复杂度 | 实测单次 | 备注 |
|---|---|---|---|---|
| `receive`（新 Thread，无订阅） | `engine.ts:327` | O(1) 语句 | 9 statements / 1 txn / **0.09 ms** | 1 trigger + 1 thread + 1 disposition |
| `receive` 重复 | `engine.ts:327` | O(1) | 1 stmt / 1 txn / 0.003 ms | 事务内 `triggers.has()` |
| `receive` 扇出 | `engine.ts:1322` `fanOut` | **O(S)**，S=Thread 上 live 订阅 Ticket 数 | ≈ `4S+8` 条语句、1 txn；S=1/5/20/50 → 12/28/88/208 stmt，0.12/0.18/0.51/1.01 ms | 每个 Ticket 一次 save + 一条 delivery effect（合并） |
| `receive` 到 ended Ticket | `fanOut`→`tryResume` `engine.ts:1363` | **O(E)**，E=ended 订阅数 | 见 P0；20 E → 88 stmt/44 txn/20 launch | 当前是"全部 resume" |
| `evaluateDue` 空闲 | `engine.ts:301-314` | O(A) 活动 Thread（JSON parse）×2 + 1 次 kv 前缀扫描 | 3 statements / 0 txn / **8 µs** | A=0 时也扫 `threads.active()` 两次 + `kv.keys('pause.resume:')` |
| `evaluateDue` 活动 Thread | 同上 | O(A) | A=10→0.03 ms，A=100→0.17 ms | `threads.active` 返回整行 JSON |
| `candidate`（评估上下文） | `engine.ts:438` | **O(H)**（threadTriggers 全量）+ O(T) related | 200 历史+11 Ticket：0.33 ms/次；10k 历史时 threadSnapshot 单项即 15–33 ms | 每次评估都重建 |
| `candidateDelivered` | `engine.ts:467` | O(A)（扫 active 找 eval） | A=100 约 0.17 ms | 可改为按 evalId 索引/kv |
| `report` | `engine.ts:871` | O(1) + 1 个 result 消息 + relay + notice | ready 增量 32 stmt / 4 txn / ≈0.3 ms | 不含发送 |
| Effects pump 空闲 | `effects.ts:264` | O(1) | 1 statement / **5 µs** | `effects.all()` |
| Effects pump 100 due（concurrency=1） | `effects.ts:269-271` | O(n²) 行解析（每轮 all()） | 301 stmt / 101 all() / 100 txn / **7.2 ms** | runtime 当前未传 concurrency，默认 1 |
| Effects pump 100 due（concurrency=4） | 同上 | O(n²/concurrency) | 226 stmt / 26 all() / **2.5 ms** | 只需配置项 |
| Outbox 单条发送 | `outbox.ts` | O(1)+O(pending replys) | 8 stmt / 1 txn / 0.26 ms | `earlierWaiting` 见 P3 |
| 面板 `buildState` | `runtime.ts:1727` | O(open tickets) JSON | 100→0.14 ms，500→0.66 ms | 每次面板轮询 |
| Watchdog scan | `watchdog.ts` | O(open tickets) + O(running) | 同 `tickets.open()` 量级 | 60 s 一次 |

**结论**：常态路径的语句数很小；复杂度的坏味道全部来自"把历史/宽度装进单行 JSON 再整行读写"。

---

## 3. 每消息 / 每生命周期 DB 量化

### 3.1 单 Ticket 全生命周期（消息 → 候选 → accept → worker ready → 回复）

测量方法：真实 `SqliteStore` + 真实 `Effects`/`Outbox`，assessment/launch/delivery handler 用同步 fake executor（不启动真实 worker），每步后 `await effects.pump()`，累计计数：

| 阶段 | Δprepared | Δexecuted | Δtxn | 累计 DB 时间（上限） |
|---|---|---|---|---|
| `receive` | 9 | 9 | 1 | 0.09 ms |
| pass + assessment（candidate + delivered + effect） | 26 | 26 | 3 | ≈0.6 ms |
| accept + launch pump（Ticket/Mandate/Assignment/ack/launch） | 37 | 37 | 5 | ≈0.4 ms + worker 启动 |
| report ready + reply pump（result + relay + notice + send） | 32 | 32 | 4 | ≈0.3 ms + 网络 |
| **合计** | **104** | **104** | **13** | **≈1.2 ms（纯 DB）** |

> 也就是说：**一条消息走完一个完整 Ticket 生命周期 ≈ 100 条 SQL、13 个写事务、1–2 ms DB 时间**。相对模型调用（秒级）可以忽略；但 13 个 `BEGIN IMMEDIATE`/COMMIT、104 次 prepare 在批量恢复/积压时会被放大（见 P2）。

### 3.2 常见微流程

| 流程 | prepared | executed | txn | 时间 |
|---|---|---|---|---|
| `receive`（新 Thread） | 9 | 9 | 1 | 0.09 ms |
| `receive`（重复） | 1 | 1 | 1 | 0.003 ms |
| 独立 accept（receive+eval+decide，无 pump） | 39 | 39 | 3 | 0.394 ms |
| live Ticket 收到 follow-up（receive+delivery pump） | 24 | 24 | 3 | 0.14 ms |
| 单条 Outbox 发送 | 8 | 8 | 1 | 0.26 ms |
| Effect 失败一次（退避状态写入） | 4 | 4 | 1 | ≈0.04 ms |
| 空闲 2 s（engine tick + effects pump） | 4 | 4 | 0 | **13 µs** |

### 3.3 语句/事务本身的开销（`node:sqlite`，WAL，`synchronous=NORMAL`）

| 操作 | 实测 |
|---|---|
| `db.prepare(sql)` + `run`（每次编译） | **13.1 µs** |
| 复用预编译语句 `stmt.run` | **1.7 µs**（≈ 1/8） |
| `BEGIN IMMEDIATE` + 1 次 upsert + `COMMIT` | **10 µs** |
| 同样 1 次 upsert（autocommit） | 10.1 µs |
| 同一事务内 100 次 upsert | **0.082 ms**（0.82 µs/次）vs 100 次 autocommit 1.01 ms（**12×**） |

**推论**：单 Ticket 生命周期 104 条语句中约 **1.36 ms 花在 SQL 编译**（104×13.1 µs），事务 13×10 µs≈0.13 ms；缓存 prepare 后理论 DB 时间降到 **≈0.3–0.4 ms（4–5×）**，批量写再叠加。

### 3.4 每消息写入字节（设计估算）

每张 Ticket 稳态行（含索引）：trigger 271 B、ticket 基线 1010 B、thread 269 B/decision 243 B、receipt ~200 B、disposition ~300 B、effect payload ~200–500 B。500 个独立 Thread 的完整生命周期实测主库 **1.7 MB（≈3.4 KB/Ticket，含索引）**，WAL 峰值 4.2 MB（自动 checkpoint 1000 页）。写入路径的物理 WAL 页数通常大于逻辑字节数 3–6×（整行 JSON 每次重写）。

---

## 4. SQLite 存储审查

### 4.1 表/索引用得如何（`EXPLAIN QUERY PLAN` 实测）

| 查询 | 计划 | 评价 |
|---|---|---|
| `threads.active()` (`WHERE active=1`) | `SEARCH thread USING INDEX thread_active` | ✅ |
| `tickets.open()` (`WHERE open=1 ORDER BY created_at,id`) | 索引 + **临时 B-tree 排序** | 可接受（重复排序可省） |
| `tickets.active()` | `SEARCH ticket USING INDEX ticket_active` | ✅ |
| `ticket_thread(thread_key)` | `SEARCH ... USING INDEX ticket_thread_by_thread` | ✅（P1 会用到） |
| `effects.due` (`due_at<=? ORDER BY seq`) | `SEARCH effect USING INDEX effect_due` + **临时 B-tree 排序** | ✅/可优化排序 |
| `receipts.pending` (`status='pending' ORDER BY created_at,id`) | `SEARCH receipt USING INDEX receipt_pending` | ✅ |
| `trigger_thread JOIN trigger ... ORDER BY t.at,t.id` | 覆盖索引 + PK 查找 + **TEMP B-TREE ORDER BY** | ❌ P1 的根因（排序键错列） |
| `recentTickets()` (`ORDER BY updated_at DESC LIMIT`) | **SCAN ticket** + TEMP B-TREE | ❌ 缺 `ticket(updated_at)` 索引；1000/5000 行时 3.5 ms（当前无调用方，潜伏） |
| `kv.keys(prefix)` (`LIKE 'x%'`) | **SCAN kv（覆盖索引）** | ⚠️ 每 tick 扫 `pause.resume:`；kv 键随运行时间增长（settings/session/源游标） |
| `activeThreads()` | 取全量 active 行，在 JS 排序 | ⚠️ 无调用方；需要时加 `thread(last_trigger_at)` |

缺失/建议索引：

```sql
CREATE INDEX IF NOT EXISTS ticket_updated ON ticket (updated_at DESC, id DESC);   -- recentTickets
CREATE INDEX IF NOT EXISTS thread_recent  ON thread (active, last_trigger_at);     -- activeThreads/面板
-- effects 若要按 kind 取队首（替代 all() 全扫）：
CREATE INDEX IF NOT EXISTS effect_kind_seq ON effect (kind, seq);
```

### 4.2 事务与锁粒度

- 每个 Engine 命令一个 `BEGIN IMMEDIATE`（`store.ts:atomic`），同步执行，命令内不再 await ⇒ **不存在"事务跨 await"的锁持有问题**；单进程单连接 + JS 单线程，写操作天然串行。
- 单 Ticket 生命周期 13 个事务、单消息 1–4 个事务；每个事务 10 µs 级。**长事务不存在**，WAL 下读者不被写者阻塞（`busy_timeout=5000` 基本用不到）。
- 效果队列的每行成功/失败各用独立小事务（`effects.ts:296-330`），失败重试与 outbox 结算都是"1 行更新"级别的粒度，正确但放大事务数（见 P2 批量化）。
- 目录锁由 Runtime 的 `proper-lockfile` 提供，Store 不自己加锁；双进程互斥 OK。

### 4.3 WAL / PRAGMA

`store.ts:512-516`：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=ON`（schema 无外键，等于无效配置）。

- 实测 WAL 自动 checkpoint 在 **≈4 MB（1000 页）** 触发（500 次写入后 WAL=4.2 MB），符合默认值；主库页面增长在 checkpoint 后可控。
- **`synchronous=NORMAL` 的语义**：进程崩溃不丢已提交事务；**断电/内核崩溃可能丢最近若干已提交事务**（DB 仍一致，不损坏）。对个人助手可接受，但应在文档中写明；若要求"每条消息落盘"，改 `FULL` 会让 13 个事务/条各自 fsync（预计 +1–10 ms/条），不建议默认开。
- 缺 `PRAGMA optimize`/`ANALYZE`（长期运行后 planner 统计缺失，可选在启动/idle 执行 `PRAGMA optimize`）；未设置 `wal_autocheckpoint`/`mmap_size`（默认值可用）。
- 迁移顺序：`migrate()` 先执行全部 `CREATE TABLE IF NOT EXISTS`，再读 `schema_version` 拒绝更高版本（`store.ts:846-950`，与 verification B4 一致）——对"更新 schema"的库会先补表再拒绝，建议先读版本再 DDL。

### 4.4 存留与增长（无 retention）

| 表 | 每 Ticket 增长 | 备注 |
|---|---|---|
| trigger / trigger_thread / disposition | 1（+follow-up） | 永不删除 |
| thread | 1 行/Thread，JSON 内 `subscriptions`/`decisions` 无限增长 | **长寿命 DM Thread 的行会一直变大** |
| ticket | 1 行，JSON 内 `inputs`/`assignments`/`follows` 无限增长 | 每收到一条 fan-out 就整行重写 |
| decision | 1–2 | 永不删除 |
| receipt | 1–2（ended/sent 保留） | 永不删除 |
| effect | 0（处理后删除） | ✅ 自清 |

实测 500 个独立 Ticket 生命周期主库 1.7 MB（3.4 KB/Ticket）⇒ 每天 20 条 ≈ **25 MB/年**（不含 WAL churn），单用户量级完全可接受；但没有 retention 时"历史 Thread"会主导查询成本（P1）。建议后续加按时间/数量的归档与 `incremental_vacuum`（当前未开 `auto_vacuum`，删除后空间留在 freelist）。

---

## 5. JSON 序列化与写放大

| 对象 | 基线 JSON | 增长因子 |
|---|---|---|
| Trigger | 271 B | — |
| Ticket | 1010 B | **每 input ≈ +80 B**：100 inputs=9 KB，1000 inputs=**84 KB**（save 0.072 ms） |
| Thread | 269 B | `decisions` ≈ +16 B/条：500 decisions=**7.9 KB**（save 0.013 ms）；`subscriptions` 每张 ended Ticket 永久增加 |
| Decision | 243 B | — |

- **读放大**：`threads.active()`/`tickets.open()`/`threadTriggers` 都返回整行 JSON 再 parse；10k 历史 ≈ 2.7 MB 字符串 + 10k 次 `JSON.parse`（20k 时 ≈5.4 MB，15–33 ms），这是 P1 的另一半成本。
- **写放大**：`recordDecision` 每次把 `thread.decisions` 推入后整行重写（`engine.ts:1687`）；`fanOut`/`deliverOrLaunch` 每次整行重写 ticket（含 `inputs`/`assignments`）。单条写本身 <0.1 ms，但 WAL 页按整行重写；实测"500 条消息落在同一 Thread（且有 N 张 open Ticket 被扇出）"主库 **25 MB + WAL 24 MB**，而"500 个独立 Thread"只有 **1.7 MB + WAL 4.2 MB（≈15×）**——其中既有 O(N) 扇出，也有 Thread/Ticket 行随历史变大。
- 建议：**append-only 数据出 JSON**（decisions 已在 decision 表；inputs 可由 trigger/disposition 重建；assignments 独立表），JSON 行只留热字段；至少对 `thread.decisions`/`thread.subscriptions` 保留"最近 N 条 + 历史表"。

---

## 6. Effects / Outbox：轮询、退避与积压

### 6.1 空闲与单轮成本

- 空闲 2 s 周期：Engine tick **3 条语句（0.008 ms）** + Effects pump **1 条语句（0.005 ms）** = 4 条语句 / 2 s（≈2 stmt/s，CPU <0.001%）。**空闲轮询不是 CPU 问题，是延迟与查询数问题**。
- 每轮 `runOnce` 用 `effects.all()` 全量取行再按 kind 过滤（`effects.ts:269-271`）；ordered kind（relay/notice）只取队首、失败会挡住后续（符合设计）。concurrency 默认 1（`effects.ts:149`），runtime 未传配置（`runtime.ts:685-688`）。

### 6.2 积压实测

| 场景 | 结果 |
|---|---|
| 100 条 due delivery，concurrency=1 | 7.2 ms；301 prepared；**101 次 `all()` 全扫**；100 txn |
| 100 条 due delivery，concurrency=4 | **2.5 ms**；226 prepared；26 次 `all()`；100 txn |
| 失败行重试一次 | 4 stmt / 1 txn，退避 `min(max, base·2^(n-1))`，health 3 连败转 error（实现正确） |
| Outbox 积压 50 / 100 / 200 / 400（同一批尚未发送） | 总耗时 5.6 / 18.3 / 63.7 / 225.2 ms；**每消息 0.113 / 0.183 / 0.319 / 0.563 ms（≈O(n²)）** |

Outbox 的 O(n²) 根因在 `outbox.ts:175-190` 的 `earlierWaiting()`：**每条消息发送前都 `effects.all()` 并逐行解析**，只为找"同 Ticket 同会话的更早 pending 消息"；积压越多，每条越慢。当前单用户下积压通常 <10，影响小；断网/重启后批量补发或面板重试时才会放大。建议：
- 用 SQL 直接查"更早且同 (ticket, conversation) 的 reply 行"（给 effect 增加 ticket/thread 列，或维护内存中的 conversation 队列）；
- `runOnce` 改为按 kind + due 的 SQL 取队首（配合 `effect_kind_seq` 索引），避免每轮全量解析；
- runtime 传入 concurrency（assessment/delivery 4，launch 按 worker 槽位；relay/notice 保持 1 且有序）。

### 6.3 延迟预算（用户可感知）

| 环节 | 最坏附加延迟 |
|---|---|
| Source 事件 → `receive` | 立即（同步） |
| `receive` → 第一次 `evaluateDue` | ≤2 s（pass timer） |
| `startEval` → assessment effect 执行 | ≤2 s（effects timer） |
| `decide` → launch effect 执行 | ≤2 s |
| `report` → reply effect 执行 → 发送 | ≤2 s |
| **合计（不含模型/网络/worker 启动）** | **≤8 s**；典型 2–4 s |

改为"receive/decide/queue 后立即触发一次 pass、effects 用 next-due 定时器"可把上述 2 s 档位降到 <50 ms，且把空闲查询降为 0。

---

## 7. 并发 / 恢复竞态

| # | 竞态/风险 | 现状与守卫 | 结论 |
|---|---|---|---|
| 1 | **ended Ticket 全量 resume**（P0） | `fanOut` 遍历 `thread.subscriptions`，对每个 ended 且非 person-stop 的 Ticket 调 `tryResume`（`engine.ts:1327-1360`）；resume 时 New Assignment + launch | ❌ 一条消息 resume 全部历史 Ticket（实测 20 张 → 20 次），应只 resume 最近一张或引入显式路由 |
| 2 | **重复 decide 建多张 Ticket** | `decide` 只按 trigger 查 eval；eval 已被消费后（`finishEval` 清空），第二次 accept 走"direct accept"分支再建 Ticket；`disposition.decisionId` 未用于幂等（`engine.ts:501+`） | ❌ 重复 route/工具重试会产生重复 Ticket；建议入口检查 `disposition.decisionId` 已存在则直接返回旧 Decision |
| 3 | retry 叠加 pending Assignment | `retryTicket` 把所有非 ended Assignment 结束后再建一个新 pending；若已有 pending（未启动），不会复用而是再加一条 | ⚠️ 面板连点/watchdog+人工重试可产生多条 launch；建议"已有 pending 则 no-op" |
| 4 | effect at-least-once | handler 成功后、删行前崩溃 → 重放。launch 有 `assignment.state` 守卫；delivery 会再投一次 Input；reply 发送后、receipt settle 前崩溃 → 重复外发（文档已接受，GitHub 有 marker 幂等） | ✅/已接受 |
| 5 | effect 处理器内重入 enqueue 同一 key | `runRow` 成功时比较 payload/updatedAt，保留更新后的行（`effects.ts:296-330`） | ✅ |
| 6 | `candidate` 过期（policyChanged 不重启进行中的 Eval） | decide 用当前 Policy 重新 gate，授权安全；但候选卡片可能按旧 Policy 展示 | ⚠️ 交互冗余，非安全问题 |
| 7 | `startEval` 内嵌套 `decide` 抛错被 guard 吞掉 | `evaluateDue` 外层事务已写入 `thread.eval`，合成 Decision 不落库 → 该 Eval 卡到超时（3 次后 unavailable） | ⚠️ 极低概率；可在 catch 中显式清 eval/requeue |
| 8 | pause 与 deadline | 暂停时长按 `pausedAt`/`deliveredAt` 重叠计算并持久化，恢复在单事务内完成 | ✅ |
| 9 | Thread close vs ready end | `endTicket` 对已 ended 直接 return，`threadClosed` 跳过 ended Ticket | ✅（task-22 回归覆盖） |
| 10 | MemoryStore.atomic 快照回滚 | 仅测试使用；快照/回滚不跨 await 安全，Engine 保持同步命令（任何未来在事务内 await 的改动都会破坏它） | ⚠️ 需在代码注释/评审中守住 |
| 11 | SQLite 迁移先 DDL 后版本检查 | 见 §4.3 | ⚠️ 低 |

---

## 8. 五个优先优化

### P0（正确性，先做）resume 爆炸与历史订阅

- **证据**：20 张 ended Ticket 同 Thread → 1 条新人消息 = 20 次 resume / 20 新 Assignment+launch；DB 344 条语句 / 44 个事务；外部成本是 20 次 worker 启动/模型调用。`fanOut` 的 subscriptions 遍历 `engine.ts:1327`，`tryResume` `engine.ts:1363`。
- **方案**：
  1. Thread 上只保留**最近一张可 resume** 的 ended Ticket（`ThreadState` 加 `lastResumableTicketId`，`endTicket` 时更新），其余 ended Ticket 从 `subscriptions` 移到"历史/上下文"（仍可按 Ticket id 查，不再收 fan-out）；
  2. 或 endTicket 时移除 Subscription、保留 `ticket.follows` 作为"该 Thread 是它的来源"的审计信息，resume 通过 Thread 指针路由；
  3. `decide` 入口用 `disposition.decisionId`/Ticket origin 做幂等（一并修 P4 的重复 accept）。
- **收益**：消息处理从 O(E) 降到 O(1)，消除"一条消息启动 N 个 worker"；Thread 行不再随 Ticket 数线性膨胀。
- **工作量/风险**：0.5–1 天 + 语义确认（Lead 已要求 ended 可 resume，需要定"谁被 resume"的规则）；现有 task-22 测试需扩展"多张 ended Ticket 时只 resume 最近一张"。

### P1（读路径）Thread 时间线 SQL 分页 + 停止全量解析

- **证据**：当前 `threadTriggers` 取全量行、JS `slice`（`store.ts:696-715`）、`ORDER BY t.at` 无法用索引顺序 → 10k–20k 行 **15.5–33 ms/次**（20k 实测 28.8 ms）；同一 SQL 改为 `ORDER BY tt.at DESC, tt.trigger_id DESC LIMIT ?` 后 **20k 行 0.020 ms**（约 1500×），计划为纯索引（无 TEMP B-TREE）。
- **方案**：
  ```sql
  SELECT t.data FROM trigger_thread tt JOIN trigger t ON t.id = tt.trigger_id
  WHERE tt.thread_key = ?
    AND (? IS NULL OR (tt.at, tt.trigger_id) < (?, ?))   -- before cursor
  ORDER BY tt.at DESC, tt.trigger_id DESC LIMIT ?
  ```
  JS 里反转后返回；`threadSnapshot` 固定 limit（如 50/100）；`candidate` 的 Thread 窗口只按需取 `before/after`；`ticketTriggers` 用一次 JOIN 替代 N 次 `triggers.get`（100 inputs 目前 102 条语句）。
- **收益**：长 Thread 上 candidate/Thread 页从 O(H) 降到 O(limit)；10k 历史时每次评估省 ≈15 ms + 5 MB 解析。
- **工作量/风险**：0.5 天；纯查询改动，需回归 store 契约测试（memory 实现同步改）。

### P2（写路径）预编译缓存 + 批量写 + JSON 拆分

- **证据**：prepare 13.1 µs vs 复用 1.7 µs（87% 时间在编译）；每生命周期 104 条语句/13 事务；同一事务 100 次写 0.082 ms vs 1.01 ms（12×）；ticket 每次 save = upsert + DELETE `ticket_thread` + N 次 INSERT（`store.ts:568-572`），1000 inputs 的 ticket JSON 84 KB 整行重写。
- **方案**：
  1. `SqliteStore` 内维护 `Map<sql, StatementSync>`，所有 repo 复用它（线程安全：单连接单线程）；
  2. `ticket_thread`/`trigger_thread` 的 DELETE+INSERT 用 `json_each(?)` 一条语句批量写；`thread.active`/`ticket.active/open` 列已有，不需额外；
  3. append-only 数组（decisions/inputs/assignments/subscriptions）拆表或"保留最近 N 条 + 历史表"；JSON 行只留热字段；
  4. 同一命令内的多条单行写（receipt + effect、ticket + thread）已同事务，可再合并语句数。
- **收益**：核心 DB 时间 104 语句 ≈1.36 ms → ≈0.3–0.4 ms（4–5×）；热 Thread 的 WAL 写放大大幅下降（同 Thread 500 条 25 MB vs 1.7 MB 中的行增长部分）。
- **工作量/风险**：1–1.5 天（拆表需 migration 与 read 查询改造）；建议先做 1+2（低风险、不动 schema），再评估 3。

### P3（延迟/积压）事件驱动 + effects 并发 + outbox 顺序索引

- **证据**：空闲 4 stmt/2 s；评估→候选 ≤4 s、launch/reply 各 ≤2 s；100 due effects concurrency 1 7.2 ms/101 次 all() vs concurrency 4 2.5 ms/26 次；outbox 积压 50→400 每消息 0.113→0.563 ms（O(n²)，`outbox.ts:175-190`）。
- **方案**：
  1. `receive`/`decide`/`report`/`enqueue` 后 `queueMicrotask`/`setImmediate` 触发一次 `evaluateDue`+`pump`（合并同一 tick 的多次请求，带 100 ms 去抖），保留 2 s 兜底定时器；
  2. Effects 定时器改为"睡到下一个 dueAt"（有行时 `setTimeout(nextDue-now)`，无行时 2 s 兜底）；
  3. runtime 给 `createEffects` 传 concurrency（assessment/delivery 4）；`runOnce` 按 kind 用 SQL 取队首（`effect_kind_seq`）替代 `all()`；
  4. Outbox 顺序：effect 行加 `ticket_id`/`conversation` 列（或内存 conversation 队列），SQL 查"更早 pending 且 failures<3"；`receipts.pending()` 只在 withdraw 时全扫；
  5. `kv.keys('pause.resume:')` 改为启动时读一次 + 内存 flag（或独立 kv 键 `pause.resume.pending`）。
- **收益**：用户可见附加延迟 2–6 s → <100 ms；effect 积压吞吐 3–10×；空闲查询 4/2 s → 0。
- **工作量/风险**：1 天（事件触发需防重入/去抖；effects 定时器需仔细处理 `Defer`/退避/暂停）。

### P4（健壮性）决策幂等与恢复期竞态

- **证据/方案**：
  1. `decide` 先查 `disposition.decisionId`，已决定则返回已有 Decision（不新建 Ticket）——同时覆盖"模型/工具重试、面板双击、attach 后重复 decide"；
  2. `retryTicket` 若已存在 pending Assignment 则 no-op（或复用该 launch）；
  3. `startEval` 内 `decide` 抛错时显式撤销 `thread.eval` 并 requeue（避免卡到 3 次超时）；
  4. `endTicket` 的 `requeueUnreadFollowUps` 与 resume 路径加"同一 Ticket 只 resume 一次"的幂等测试。
- **收益**：消除重复 Ticket/重复 worker 的低频正确性风险；工作量 0.5 天。

> 不推荐：换 `better-sqlite3`（引入原生依赖、收益与 P2 重叠）、关闭 WAL（读并发/崩溃恢复变差）、对 `tickets.open()` 做无失效缓存（面板/面板 action 会读到旧状态）。

---

## 9. 需要真机验证 / 未覆盖

1. 上述数字是**纯 DB、fake executor、单进程**；真实模型/网络/worker 启动占端到端时延的 95%+。本审查的优化目标是**容量与积压**，不是聊天首响（首响更多受 P3 轮询影响）。
2. 未做长时间 soak：真实运行 1–4 周后的 WAL/DB 体积、`thread`/`ticket` 行增长、retention 缺失的实际影响、面板轮询随 open Ticket 增长的 CPU。
3. 未在低端磁盘/网络盘测 `synchronous=NORMAL` 的 checkpoint 抖动；若部署在慢盘，建议观察 WAL checkpoint 的 p99 停顿。
4. 未做多 source 并发压力（Telegram long-poll + GitHub 60 s 同时触发 receive 的串行化程度）；JS 单线程 + 单连接下理论安全，但缺少量化。
5. 多 worker 并发时 effects concurrency 与 worker 槽位的交互（runtime 侧）未压测。

---

## 10. 复现方法（本次测量）

临时脚本（未提交）要点：

1. 用 Vite SSR 直接加载 TS 源（`createServer({root, configFile:false, plugins:[resolve .js→.ts]})` + `ssrLoadModule`），避免构建产物与源码差异：
   ```js
   const { createServer } = await import('<repo>/node_modules/.pnpm/vite@*/node_modules/vite/dist/node/index.js')
   const server = await createServer({ root, configFile: false, appType: 'custom', server: { middlewareMode: true }, plugins: [tsJsPlugin] })
   ```
2. 在加载 Store 之前 monkey-patch `node:sqlite`：
   ```js
   const orig = DatabaseSync.prototype.prepare
   DatabaseSync.prototype.prepare = function (sql) { count.prepare++; return orig.call(this, sql) }
   for (const m of ['run', 'get', 'all']) { const o = StatementSync.prototype[m]; StatementSync.prototype[m] = function (...a) { count[m]++; return o.apply(this, a) } }
   DatabaseSync.prototype.exec = function (sql) { if (/^\s*BEGIN/i.test(sql)) count.txn++; return oe.call(this, sql) }
   ```
3. 用 `new SqliteStore('/tmp/x.sqlite')`（WAL）跑 3.1 的 happy path 与 6.2 的积压场景，`reset()/snap()` 统计；用 `EXPLAIN QUERY PLAN` 核对 §4.1。
4. 重新测量时建议每个场景用**独立进程**（JIT/页缓存会污染），至少跑 3 次取中位数；本文件的数字取 20–50 次平均。
