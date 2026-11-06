# 安装与运维（SETUP）

本文面向一个已经在用 DeepSeek Harness 的人，把 SuperAgent 装到**独立 profile** 里长期运行。按顺序做完“账号 → 安装 → 配置 → 验证”，再打开看门狗。

- 目标环境：macOS，DeepSeek Harness 0.2.2-rc.1（`engines.dsh` 限定 `>=0.2.2-rc.1 <0.3.0`），Node 22.19+ / 24+。
- 所有命令都在本仓库根目录执行。不要编辑 `~/.dsh/profiles/<profile>/` 里除 `cordis.patch.yml` 之外的任何文件。
- 密钥**只**放环境变量或 `~/.config/superagent/*` 的 600 文件里。不要贴进聊天、Issue、日志或本仓库。

## 0. 前置条件

| 项 | 要求 | 检查 |
| --- | --- | --- |
| DeepSeek Harness | 0.2.2-rc.1（桌面版或 CLI） | 菜单/关于里看版本 |
| Node.js | 22.19+ 或 24+ | `node --version` |
| pnpm | 由仓库脚本提供（DSH 自带） | `./scripts/pnpmw --version` |
| git | 2.32+（Worker 目录默认用 worktree/clone） | `git --version` |
| Telegram 账号 | 用于建 bot、收 `/status` | — |
| GitHub 账号 | 建 fine-grained PAT，至少对目标仓库有写权限 | — |
| 一个独立的 DSH profile | 建议叫 `superagent`，不要装在日常 profile 里 | 见 §2 |

> 为什么用独立 profile：SuperAgent 会常驻、重启、并给 Worker Session 注入自己的 preset。放在日常 profile 里会让每次重启都影响你手头的工作。

## 1. 准备账号和密钥

### 1.1 Telegram bot（@BotFather）

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示取名字。
2. BotFather 返回的 token 形如 `123456789:AA...`。**只复制一次**，直接进入下一步，不要发到任何聊天窗口。
3. 拿到后立刻保存为本地文件：

```sh
mkdir -p ~/.config/superagent && chmod 700 ~/.config/superagent
printf '%s' '<token>' > ~/.config/superagent/telegram-token
chmod 600 ~/.config/superagent/telegram-token
```

4. 获取你自己的 Telegram 数字 id（不是用户名）：给 [@userinfobot](https://t.me/userinfobot) 发任意消息，它会回复 `Id: 123456789`。这个数字填进配置的 `allowedUserIds`，只有名单里的人能让 agent 接活。
5. 私聊你的 bot，发一句 `/start`（或 `/help`），确认能收到回复。

### 1.2 GitHub token（fine-grained PAT）

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token。
2. Repository access：只选 SuperAgent 要动的仓库（最少授权）。
3. Repository permissions：
   - **Contents: Read and write**（读代码、推分支、开 PR）
   - **Issues: Read and write**（读 Issue、回评论）
   - **Pull requests: Read and write**（读 PR、发 review 评论）
   - **Metadata: Read**（必选，自动带上）
   - 需要看 CI 时再加 **Actions: Read**；需要读 check 结果时加 **Checks: Read**。
4. 生成后同样只显示一次，保存：

```sh
printf '%s' '<github_pat>' > ~/.config/superagent/github-token
chmod 600 ~/.config/superagent/github-token
```

5. 记下 token 属于哪个 GitHub 账号（`login`），填进配置的 `login`。不要用主账号的经典 token；专用账号或最小 scope 的 fine-grained PAT 更安全。

> 环境变量方式（`SUPERAGENT_TELEGRAM_TOKEN` / `SUPERAGENT_GITHUB_TOKEN`）也可用，但 macOS 桌面版从 Dock/Spotlight 启动时通常**不继承** shell 环境变量。长期运行优先用 `tokenFile`，或把变量写进启动 DSH 的 LaunchAgent。`scripts/setup.mjs` 只检查“有没有”，从不打印值。

## 2. 安装 bundle

### 2.1 构建

```sh
./scripts/pnpmw install
./scripts/pnpmw check        # typecheck + test + build；产出 lib/index.js 与 lib/client.js
```

### 2.2 选择并确认 profile

- **DeepSeek Harness 桌面版（默认场景）**：桌面应用固定加载当前 profile（本机是 `desktop`），没有可用的 `dsh` CLI 来新建 profile。SuperAgent 就装在 `desktop` 里；它只增加一个插件行和两个 agent preset，不影响你现有的会话，插件失败也会自行降级。
- **有 dsh CLI 时（推荐）**：给 SuperAgent 一个独立 profile，避免它重启时影响你手头的工作：

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
```

这会创建 `~/.dsh/profiles/superagent`。**已有该 profile 时不要重复执行**，它会覆盖 `cordis.patch.yml`。

下面用 `PROFILE` 表示你选的 profile：桌面版为 `desktop`，CLI 独立 profile 为 `superagent`。

```sh
PROFILE=desktop      # 桌面版；CLI 独立 profile 改成 superagent
```

### 2.3 装入 bundle（二选一）

**A. 命令行（有 dsh CLI 时）**

```sh
dsh plugin --profile "$PROFILE" add "link:$PWD"
```

**B. 在 DeepSeek Harness 里（桌面版用这个）**

1. 打开 **Settings → Plugins**（或 Plugin Manager）。
2. 选择 **Install bundle**（对应 `plugin_manager` 的 `install_bundle` 动作），目标填本仓库的**绝对路径**（`link:` 方式安装的是当前 checkout，改代码后重启 DSH 即生效）。
3. 装完确认插件列表里出现 `dsh-superagent-personal`，且 bundle 的 patch 行未被禁用。

### 2.4 写机器配置

复制示例并替换占位符：

```sh
cp examples/profile.cordis.patch.yml "$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
$EDITOR "$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
```

或让脚本生成最小可用配置（只写 `stateDir` + 关闭状态的 sources，之后再补）：

```sh
node scripts/setup.mjs --profile "$PROFILE" --state-dir "$HOME/.dsh/state/superagent" --write-patch
```

> 桌面版建议先在**安装 bundle 之前**写好配置行：安装动作会按当前 profile 文件重新组合插件行；先写配置可以让插件第一次挂载就拿到 `stateDir`，避免先降级再重启。若顺序反了，改完配置后重启桌面应用即可。

`setup.mjs` 会校验 stateDir 可写、检查两个 token 是否存在，并打印下一步；它**不会**安装 bundle、不会重启 DSH、不会打印密钥。

必填项：

- `stateDir`：绝对路径，默认 `~/.dsh/state/superagent`。数据库、锁、Ticket 工作目录都在这里，升级前先备份。
- `sources.telegram`：`enabled: true`、`allowedUserIds: ["<你的数字 id>"]`，token 用 `tokenEnv` 或 `tokenFile` 指过去。
- `sources.github`：`enabled: true`、`repositories: ["owner/repo"]`、`login`，同样只引用 token。
- `policy.mode`：第一次先保持 `observe`。

改完重启 DeepSeek Harness（桌面版：退出应用再打开；CLI：`dsh superagent` 或 `dsh --profile "$PROFILE" web`）。

## 3. 验证

按顺序检查，任何一步失败先看 §7。

1. **插件行状态**：Settings → Plugins 里 `dsh-superagent-personal` 不应是 error/disabled；DSH 启动日志里没有 `Superagent failed to start`。
2. **degraded 文件**：`ls "$HOME/.dsh/state/superagent/"`。正常情况下只有 `superagent-status.json`（可能还有 `superagent-heartbeat.json`）；出现 `superagent-degraded.json` 说明插件降级，`cat` 它看 `detail`（不含密钥）。
3. **Telegram**：给 bot 发 `/status`，应收到一段不超过 100 字的状态（来源健康、活跃/待决策 Ticket 数、是否 paused）。
4. **面板**：DSH 左侧栏出现 **Superagent** 入口；点开能看到来源健康、待处理、进行中的 Ticket。面板 5 秒轮询一次；显示“无法连接”通常表示引擎没起来（看 §7）。
   > 验证范围说明：面板是手写的纯 JS Client 模块（不经过 TS 构建），仓库内测试只覆盖“模块能加载、两个 slot 注册形状正确、失败时退化为无操作模块”以及 API 路径/请求头；**真实页面渲染与 slot props 尚未在浏览器里验证**，需要安装后在 DSH 页面确认入口、页面和按钮。即使面板加载失败，宿主页面与 DSH 本体也不受影响。
5. **管理 API**（可选）：

```sh
curl -s -H 'x-superagent-request: 1' http://127.0.0.1:<DSH 端口>/superagent/api/state | head
```

只接受 loopback 且必须有 `x-superagent-request: 1` 头，否则 403。

6. **observe 模式验证**：用被允许的账号给 bot 发一条明确请求（或 @agent 的 Issue），应出现“本来会接”的记录/Ticket 但不对外发消息。确认日志和面板符合预期后，再把 `policy.mode` 改成 `auto` 并重启。

## 4. 看门狗（进程级自愈）

插件自己能隔离引擎失败，但 DSH 进程本身崩溃/退出需要外部看门狗。它检查：DSH 进程是否存在、`superagent-heartbeat.json` 是否新鲜、SQLite 是否仍有写入；异常时用 `open -a "DeepSeek Harness"` 重启，指数退避（60/120/240/480/900 秒），连续失败 5 次后停止自动重启并写日志。

看门狗的判定（与 runtime 的心跳契约一致）：

- heartbeat `status:"stopped"`（正常停止时的最后一次心跳）、`paused:true` 或 `safeMode:true` → 视为有意状态，**不重启**（即使心跳已过期）。
- 守护进程（guardian）的 `superagent-status.json` 为 `degraded` → 配置/版本问题，重启修不了：记录 + 通知，退出码 3，不重启。
- heartbeat `status:"degraded"/"error"` → runtime 请求恢复：走指数退避重启。心跳刻意不带错误文本（可能含模型/存储错误串）；具体原因看 DSH 日志或 `GET /superagent/api/state` 的 `plugin.detail` / `health[].detail`。
- 心跳过期、SQLite 也过期、或 DSH 进程消失 → 走指数退避重启。


先手动确认行为：

```sh
node scripts/watchdog.mjs --state-dir "$HOME/.dsh/state/superagent" --dry-run
```

安装为 LaunchAgent（登录自启 + 每 60 秒一次）：

```sh
./scripts/install-launchd.sh --state-dir "$HOME/.dsh/state/superagent"
```

- plist：`~/Library/LaunchAgents/com.sfky.superagent.watchdog.plist`
- 日志：`$HOME/.dsh/state/superagent/watchdog.log`
- 状态/退避记录：`$HOME/.dsh/state/superagent/watchdog-state.json`
- 卸载：`./scripts/uninstall.sh`（默认保留 state；`--purge-state` 才删）

看门狗**不会**打印或读取密钥，也不会重启一个“配置降级”的插件（重启 DSH 修不了配置错误）；它只在进程消失或心跳停止时动手。

## 5. 配置项速查

完整示例见 [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml)。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 手动 kill switch；`false` 时插件不启动，DSH 正常 |
| `stateDir` | 必填 | 绝对路径；数据库、锁、worker 目录 |
| `sources.telegram.enabled` | `false` | 是否收 Telegram |
| `sources.telegram.tokenEnv` / `tokenFile` | — | 二选一，指向 token |
| `sources.telegram.allowedUserIds` | `[]` | 允许发起工作的数字 id；空 = 谁都接不了 |
| `sources.github.tokenEnv` / `tokenFile` | — | 二选一 |
| `sources.github.repositories` | `[]` | `owner/name` 列表 |
| `sources.github.login` | — | token 所属账号，用于识别 @ |
| `sources.github.observe*` | `false` | 是否也收未 @ 的 Issue/PR/评论/CI；建议 `observeComments`、`observeCi` 设为 `true`，否则已订阅线程的后续讨论/CI 结果收不到 |
| `policy.mode` | `observe` | `off` 只接明确请求；`observe` 只记录；`auto` 接推断候选 |
| `policy.rules` | `[]` | `auto` 下的主动规则（id/name/enabled/instructions） |
| `executor.maxWorkers` | 2 | 并行 Worker 数；笔记本建议 1–2 |
| `executor.prepare` | — | 新 Ticket 目录里先跑的命令（如 `git worktree add`） |
| `quiet.maxChars` | 100 | attention 消息的最大长度，超出截断 |
| `quiet.minChars` | — | `maxChars` 的旧别名，不建议使用 |

运行时环境变量：

| 变量 | 作用 |
| --- | --- |
| `SUPERAGENT_DISABLED=1` | 全局 kill switch，等价于 `enabled: false` |
| `SUPERAGENT_START_TIMEOUT_MS` | 引擎启动超时，默认 30000，允许 50–120000（排障用） |
| `SUPERAGENT_COMPAT_ASSUME_UNSUPPORTED=1` | 自检开关：模拟“DSH 版本不兼容”，用于验证降级路径 |
| `DSH_VERSION` | 版本探测覆盖值（测试/排障用） |

## 6. 升级与兼容

1. `git pull && ./scripts/pnpmw install && ./scripts/pnpmw check`。
2. 先备份 `<stateDir>/superagent.sqlite`（以及整个 stateDir）。
3. 重启 DSH，确认 `/status`、面板、看门狗日志正常。
4. DSH 本体升级：`engines.dsh` 限定 `>=0.2.2-rc.1 <0.3.0`。DSH 大版本（0.3.x）不在兼容范围时：
   - loader 会在导入前禁用/跳过本 bundle（stderr 有 `skipping profile bundle` / `disabling profile plugin`）；
   - 即使绕过该门禁，guardian 也会在 `apply()` 里探测版本，写 degraded 状态并只 warn，不抛错、不影响 DSH 启动。
   - 处理：升级本插件到声明支持新版本的 release，或临时在 profile 里 `enabled: false`。
5. 升级后首次启动若看到 `superagent-degraded.json`，按其中的 `detail` 处理；确认修复后该文件会在下次成功启动时自动删除。
6. 数据库被新版本迁移过后，旧版本无法打开；回滚必须用升级前备份。

## 7. 排障

| 现象 | 原因与处理 |
| --- | --- |
| `superagent-degraded.json` 里 `configuration.stateDir is required` | profile patch 没配 `stateDir` 或不是绝对路径；改 `cordis.patch.yml` 后重启 |
| `running DSH <ver> is outside the supported range` | DSH 版本超出 `engines.dsh`；升级插件或临时 `enabled: false` |
| 插件行 error / 启动日志有 `Superagent failed to start` | 引擎侧异常；看 `detail` 与日志。guardian 已隔离，DSH 本身不受影响 |
| 面板显示“无法连接 Superagent” | 引擎没起来（degraded/stopped）或 API 端口不同；先看 `/status` 和 status 文件 |
| Telegram `/status` 没回复 | bot token 不对/未配置；确认 `allowedUserIds` 是否包含你；看 DSH 日志里 source 启动错误 |
| GitHub 没事件 | `repositories`、`login` 不对；token 权限不足（Contents/Issues/PRs）；`observeIssues` 等开关未开 |
| 消息没人接 | `policy.mode` 是 `observe`/`off`；发送者不在 `allowedUserIds`；或当前 `paused`，发 `/resume` |
| 一直重启 DSH | 看 `watchdog.log` 和 `watchdog-state.json` 的 `lastReason`；先 `--dry-run` 看判定。heartbeat 为 `degraded/error` 时先修 runtime/配置，原因看 DSH 日志或 `/superagent/api/state` 的 `plugin.detail`；heartbeat 过期说明 DSH 卡住。若是有意停止（`stopped/paused/safeMode`）看门狗不会重启，检查是否心跳状态没写对 |
| 看门狗该重启却不重启 | 确认 `--process-pattern` 能匹配到 DSH 进程（桌面版默认 `DeepSeek Harness`；CLI 用自定义 pattern）；确认 heartbeat 的 `status` 不是 `stopped`/`paused/safeMode` |
| `watchdog.log` 里 `restart command failed` | 桌面版路径不对；用 `--restart-cmd` 指定启动命令（默认 `open -a "DeepSeek Harness"`） |
| 装完 panel 不出现 | bundle 的 `dsh.client` 需要重启 DSH 才生效；确认插件行 active；浏览器控制台看 `[superagent]` 前缀报错 |
| 面板能列出页面但按钮没反应 | 检查 `/superagent/api/action` 返回（403 = 缺 `x-superagent-request: 1`；`ok:false` 会显示在页面） |

日志位置：DSH 自身日志（Web/CLI 启动窗口或 `~/.dsh` 下对应 profile 的日志）、`<stateDir>/watchdog.log`、插件状态文件 `<stateDir>/superagent-status.json`。

## 8. 卸载

```sh
# 1) 停看门狗（保留 state）
./scripts/uninstall.sh

# 2) 从 profile 移除 bundle
dsh plugin --profile superagent remove dsh-superagent-personal

# 3) 确认后再删状态（数据库、Ticket 历史、worker 目录，不可恢复）
./scripts/uninstall.sh --purge-state --state-dir "$HOME/.dsh/state/superagent"
```

撤销 Telegram bot：@BotFather → `/deletebot`。撤销 GitHub PAT：GitHub → Settings → Developer settings → Fine-grained tokens → Revoke。密钥文件删除：`rm -rf ~/.config/superagent`。
