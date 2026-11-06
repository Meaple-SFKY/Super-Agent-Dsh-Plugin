# 002 · 配置与一键设置（Setup Wizard）

目标：插件不绑定任何具体账号；任意用户都在 DeepSeek Harness 的面板里完成配置，不再手改 YAML。
所有接口只接受 loopback 且要求 `x-superagent-request: 1`；token 只出现在 POST body，写盘 0600，永不回显、永不写日志。

## 1. 配置归 DSH 原生配置（单一来源）

- 插件行配置（profile 的 `cordis.patch.yml`，由 DSH `configEditor` 写入）保存：`enabled`、`stateDir`、`sources.*`（含 `tokenFile` 路径、白名单、仓库、observe 开关、pollSeconds）、`policy`、`executor`、`quiet`。
- 密钥只落本地文件：默认 `<stateDir>/secrets/telegram-token`、`<stateDir>/secrets/github-token`（目录 0700、文件 0600）；配置里只出现路径。
- `src/index.ts` 导出 schemastery `Config`，让 DSH 设置页与 `configEditor` 都能校验/编辑；非法配置只会让插件降级，不影响宿主。
- 保存配置通过 `ctx.get('configEditor').edit(ctx.fiber.entry, current => next)`；非 volatile 字段会让插件自动重启，向导轮询到重新 ready。

## 2. Setup API（`src/app/api.ts` 扩展）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/superagent/api/setup/state` | — | `{ ok, stateDir, plugin:{status,detail}, accounts:{telegram:{configured,enabled,botUsername?}, github:{configured,enabled,login?,repositories,count}}, permissions:[{id,title,state,detail,restartRequired}], restartRequired }` |
| POST | `/superagent/api/setup/telegram` | `{ token, tokenFile? }` | 校验 `getMe`，写 0600 文件，`{ ok, botUsername, botId, tokenFile }`；错误只含 Telegram 的 description |
| POST | `/superagent/api/setup/github` | `{ token, tokenFile? }` | 校验 `/user`，列出可访问仓库（最多 200），写 0600 文件，`{ ok, login, repositories:[{fullName,private,pushedAt}], tokenFile }` |
| PUT | `/superagent/api/setup/config` | `{ config: { sources?, policy?, executor?, quiet? } }` | 合并进插件配置并持久化，`{ ok, restarting: true }`（先响应再重启） |
| GET | `/superagent/api/setup/permissions` | — | 静态权限说明（不需要 macOS 高权限；看门狗可选；需重启的项标注） |

- `accounts.*.configured` 只检查 token 文件存在且非空，不读取内容。
- 已配置的 token 文件路径优先保留；向导再次提交 token 时覆盖。
- GitHub 仓库列表用于向导勾选；用户确认后随 `PUT setup/config` 写入 `sources.github.repositories`。
- `language` 为机器人对用户说话/汇报的语言（默认 `zh`），与面板 UI 语言无关；`sources.github.repositories: ["*"]` 时自动发现新仓库。
- 保存后插件重启：向导用 `GET setup/state` 轮询（最多 60s），`plugin.status=ready` 且 accounts 匹配即完成。

## 3. 面板（`src/client/main.js`）

- 顶部状态区：插件状态、来源健康、待决策/进行中数量。
- 未配置时显示 **设置向导**（分步）：
  1. Telegram：说明 BotFather 建 bot（无法 OAuth），粘贴 token → 校验 → 显示 bot 用户名与 `https://t.me/<bot>` 的 Start 链接；提示“bot 不能主动发起会话，需你点 Start”。
  2. GitHub：粘贴 fine-grained PAT → 校验 → 显示 login 与仓库多选；提示所需权限（Contents/Issues/PR 读写；**Actions: Read** 用于 CI；Checks: Read 可选，缺省时自动回退到 Actions）。
  3. 行为：accept mode（observe/auto）、允许的 Telegram user id、worker 数。
  4. 完成：保存并等待重启；失败时显示可读原因。
- 已配置时显示 dashboard + “设置”入口（可重新走向导）。
- 权限页：说明 SuperAgent 不需要屏幕录制/辅助功能/完全磁盘访问；看门狗（登录自启+后台保活）默认关闭，提供说明与手动命令；需要重启 DSH 的项明确标注。
- 视觉：使用 DSH 主题 token；卡片化布局、状态圆点、空状态文案、步骤条；窄屏可用。

## 4. 验收

- 无任何账号硬编码；示例/文档只有占位符。
- 全新用户：安装 bundle → 打开面板 → 向导三步完成 → 来源 ready → Telegram `/status` 有回复。
- 故意错误 token：向导显示原因且不影响 DSH；插件保持可用。
- `./scripts/pnpmw check` 全绿；更新 docs/verification.md。
