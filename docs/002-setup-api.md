# 002 · 配置与一键设置（Setup Wizard）

目标：插件不绑定任何具体账号；任意用户都在 DeepSeek Harness 的面板里完成配置，不再手改 YAML。
所有接口只接受 loopback 且要求 `x-superagent-request: 1`；token 只出现在 POST body，写盘 0600，永不回显、永不写日志。

## 1. 配置归 DSH 原生配置（单一来源）

- 插件行配置（profile 的 `cordis.patch.yml`，由 DSH `configEditor` 写入）保存：`enabled`、`stateDir`、`language`、`router`、`sources.*`、`policy`、`executor`、`quiet`。
- 密钥只落本地文件：默认 `<stateDir>/secrets/telegram-token`、`<stateDir>/secrets/github-token`、`<stateDir>/secrets/github-operator-token`（目录 0700、文件 0600）；配置里只出现路径（`tokenFile` / `operatorTokenFile`），不出现内容。
- `src/index.ts` 导出 schemastery `Config`，让 DSH 设置页与 `configEditor` 都能校验/编辑；非法配置只会让插件降级，不影响宿主。`tests/guardian-isolation.spec.ts` 的 contract 用例逐字段比对 `Config` 与 `src/sources/*` 的接口，防止再次漂移。
- 保存配置通过 `ctx.get('configEditor').edit(ctx.fiber.entry, current => next)`；非 volatile 字段会让插件自动重启，向导轮询到重新 ready。

### 1.1 配置字段（与 source 对齐）

| 组 | 字段 |
| --- | --- |
| Telegram | `enabled`、`tokenEnv`/`tokenFile`、`allowedUserIds`、`chats`、`pollTimeoutSeconds`、`pollSeconds`（空轮询后 idle 等待，默认 1 s）、`observeCallbacks`、`observeAllChatMessages`、`replyToMessages`、`mentionPattern`、`processBacklog`、`richText`、`files`、`keyboards`、`maxDownloadBytes` |
| GitHub | `enabled`、`tokenEnv`/`tokenFile`、`repositories`、`login`、`allowSelf`、`allowedLogins`、`botLogins`、`collaborators`、`operatorTokenFile`、`acceptInvitations`（`off`/`allowlist`/`all`，默认 `allowlist`）、`observeIssues`/`observePulls`/`observeComments`/`observeCi`、`notifications`（`auto`/`off`/`on`，默认 `auto`）、`maxTextChars`（默认 16000，1k–64k）、`adaptivePolling`（默认 `true`）、`pollSeconds` |
| Router/Worker | `router.{provider,model,reasoningEffort}`、`executor.{provider,model,reasoningEffort,maxWorkers,prepare,cloneUrl,clone,defaultRepo,prepareTimeoutMs,gitTimeoutMs,gitSshKeyFile,gitName,gitEmail}` |
| 其他 | `policy.mode`/`policy.rules`、`quiet.maxChars`/`quiet.minChars`、`watchdog.*`、`acknowledgeOnAccept`、`passIntervalMs`、`heartbeatIntervalMs` |

> `quiet.quietHours` 已从 Config 移除（engine 不消费，属于“配了不生效”）；静默只有 `quiet.maxChars` 的截断。

## 2. Setup API（`src/app/api.ts` 扩展）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/superagent/api/setup/state` | — | `{ ok, stateDir, language, git, models, watchdog, plugin:{status,detail}, accounts:{telegram:{configured,enabled,botUsername?}, github:{configured,enabled,login?,repositories,count,allowSelf,collaborators,operatorTokenConfigured,operatorTokenFile?}}, permissions:[...], restartRequired }` |
| POST | `/superagent/api/setup/telegram` | `{ token, tokenFile? }` | 校验 `getMe`，写 0600 文件，`{ ok, botUsername, botId, tokenFile }`；错误只含 Telegram 的 description |
| POST | `/superagent/api/setup/github` | `{ token, tokenFile? }` | 校验 `/user`，列出可访问仓库（最多 200），写 0600 文件，`{ ok, login, repositories:[{fullName,private,pushedAt}], tokenFile }` |
| POST | `/superagent/api/setup/github/operator` | `{ personalToken?, token? (alias), repositories?, botLogin?, tokenFile? }` | 个人 PAT 引导：校验 `/user` → 把 bot 加为 push collaborator → bot 接受匹配的邀请 → 写 0600 `operatorTokenFile`；返回 `{ ok, operator, login, operatorTokenConfigured:true, operatorTokenFile, invited:[{repo,login,status}], accepted:[{repo,status,invitationId?}], warnings?, restarting }`。per-repo 失败只进 `warnings[]`；`restarting:false` 时面板自行 `PUT config` 写入 `operatorTokenFile` |
| POST | `/superagent/api/setup/github/ssh-key` | `{}`/`{ tokenFile? }` | 生成/复用专用 bot SSH key（0600），返回 `{ ok, created, publicKey, keyFile, restarting }`；失败 409/501 带可读 description |
| GET | `/superagent/api/setup/models` | — | `{ ok, providers:[{id,name,models:[{id,name,description,inputModalities}]}], errors?, router, worker, default }` |
| GET | `/superagent/api/setup/watchdog` | — | `{ ok, installed, running, label, plistPath, stateDir, detail? }`；`GET setup/state` 里也有同一份 watchdog 状态 |
| POST | `/superagent/api/setup/watchdog` | `{ enabled: boolean }` | 运行安装/卸载脚本，返回 `{ ok, enabled, installed, running, detail? }`；脚本缺失 501 |
| PUT | `/superagent/api/setup/config` | `{ config: { sources?, policy?, router?, executor?, quiet?, language? } }` | 合并进插件配置并持久化，`{ ok, restarting: true }`（先响应再重启）；失败 400 `invalid_config`/`invalid_model`，缺 configEditor 501 |
| GET | `/superagent/api/setup/permissions` | — | 静态权限说明（不需要 macOS 高权限；看门狗可选；需重启的项标注） |

- `accounts.*.configured` 只检查 token 文件存在且非空，不读取内容；`operatorTokenConfigured` 同理，只返回布尔与路径。
- 已配置的 token 文件路径优先保留；向导再次提交 token 时覆盖。
- GitHub 仓库列表用于向导勾选；用户确认后随 `PUT setup/config` 写入 `sources.github.repositories`。
- `language` 为机器人对用户说话/汇报的语言（默认 `zh`），与面板 UI 语言无关；`sources.github.repositories: ["*"]` 时自动发现新仓库。
- 保存后插件重启：向导用 `GET setup/state` 轮询（最多 60s），`plugin.status=ready`、accounts 匹配且 `restartRequired=false` 即完成。
- 个人 PAT 保存后可在向导高级区看到“已配置”；当前没有删除 API，移除需删除 `<operatorTokenFile>` 并清空配置字段（runtime 后续可加 DELETE/remove）。

## 3. 面板（`src/client/main.js`）

- 顶部状态区：插件状态、来源健康、待决策/进行中数量；轮询按当前 view 门控（Overview 5s `/state` + 60s `/setup/state`；Setup 5s setup + 60s models；Permissions 30s permissions/watchdog），响应内容未变化时不重渲染。
- 未配置时显示 **设置向导**（分步）：
  1. Telegram：说明 BotFather 建 bot（无法 OAuth），粘贴 token → 校验 → 显示 bot 用户名与 `https://t.me/<bot>` 的 Start 链接；提示“bot 不能主动发起会话，需你点 Start”；Telegram 能力开关（富文本/文件/内联按钮）默认开启。
  2. GitHub：粘贴 fine-grained PAT → 校验 → 显示 login 与仓库多选；提示所需权限（Contents/Issues/PR 读写；**Actions: Read** 用于 CI；Checks: Read 可选，缺省时自动回退到 Actions）；高级区有个人 PAT（邀请 bot/接受邀请，本机 0600）、`acceptInvitations`（默认 allowlist）与 SSH key 生成。
  3. 行为：accept mode（observe/auto）、允许的 Telegram user id、worker 数、Router/Worker 模型选择。
  4. 完成：先调用 personal PAT 端点（若填），展示 invited/accepted/warnings，再保存配置并等待重启；失败时显示可读原因。
- 已配置时显示 dashboard（tickets/attention/health/sources）与“设置”入口；Ticket / 待决策项可点开**只读详情抽屉**，显示 8 个阶段标签与运行时记录的问题/最近报告，不执行动作。
- 权限页：说明 SuperAgent 不需要屏幕录制/辅助功能/完全磁盘访问；看门狗（登录自启+后台保活）默认关闭，提供状态、一键开关与手动命令；需要重启 DSH 的项明确标注。
- 视图渲染抛错由 `SafeView` 隔离为一张错误卡片，不会让 DSH slot 空白；抽屉带 `role=dialog`/`aria-modal`/Esc 关闭，tab 有 `role=tab`/`aria-selected`。
- 视觉：使用 DSH 主题 token；卡片化布局、状态圆点、空状态文案、步骤条；窄屏可用。

## 4. 验收

- 无任何账号硬编码；示例/文档只有占位符。
- 全新用户：安装 bundle → 打开面板 → 向导完成 → 来源 ready → Telegram `/status` 有回复。
- 故意错误 token：向导显示原因且不影响 DSH；插件保持可用。
- personal PAT 成功时 token 不落配置、响应不回显，向导内存中的值清空；失败不阻塞配置保存。
- `./scripts/pnpmw check` 全绿；更新 docs/verification.md。
