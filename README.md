# 错峰模式 · dsh-off-peak

DeepSeek 的错峰优惠让空闲时段的价格只有高峰时段的一半。这个 DSH 插件让工作区自行
按这个价格表运行：**空闲时段自动开始，高峰时段自动停止**。

## 时段定义

按北京时间（`Asia/Shanghai`，与机器本地时区无关）：

| 时段 | 规则 |
| --- | --- |
| 高峰（全价） | 周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00 |
| 空闲（半价） | 其余全部时间：12:00–14:00、18:00–次日 09:00、周末全天、法定节假日全天 |

法定节假日按内置的 2025–2026 年中国大陆节假日表判定。国务院通常在上一年年底公布
下一年的安排，因此新一年公布后需要在 `lib/index.js` 的 `HOLIDAYS` 中补上该年份。

## 设置页

DSH 设置的侧边栏会出现单独一栏 **错峰模式**：

- **错峰模式总开关** —— 关闭后不再自动停止、也不再自动继续任何项目；
- **空闲时段自动继续** —— 高峰停止的执行在进入空闲时段后自动接着跑（暂停期间排队
  的用户消息会一并补上，不会丢失）；
- **空闲时段自动开始** —— 项目里没有任何会话在运行时，空闲时段自动唤醒该项目最近
  使用的会话；
- **检查周期** —— 兜底检查间隔；窗口交替的瞬间由哨兵精确触发；
- **项目列表** —— 列出所有工作区，逐个勾选是否开启错峰模式，另有「全部开启 /
  全部关闭 / 立即停止全部 / 立即继续全部」按钮；
- **读取项目** —— 打开本页就自动扫描，不需要先填路径：插件以「DSH 已知工作区的父
  目录 + 用户主目录」为扫描范围（最多 6 个根、总耗时上限 2.5 秒、每个根最多访问
  500 个目录），找出带项目标记（`package.json`、`.git`、`pyproject.toml`、`go.mod`、
  `Cargo.toml` 等）的目录，默认向下 3 层，跳过 `node_modules`、`dist`、`.git` 等，
  找到一个项目就不再往下钻（它的子目录是它自己的包）。扫描是异步的：卡片先显示
  「正在扫描…」再填结果，失败或超限都会把原因显示出来，不会卡住界面。
  勾选后一次性注册为工作区并同时开启错峰模式；已注册的目录标成「已添加」并自动去
  重（按路径复用已有工作区，不会重复建）。找不到的项目仍可用下面的「手动选择目录」
  逐层点进去添加。

项目列表存在 `$DSH_HOME/storages/offPeak/projects.json`，四个开关存在
`$DSH_HOME/storages/offPeak/config.json`；同样的四个开关也声明为插件的
`Config`（`volatile`），因此也可以在 profile 的 `cordis.patch.yml` 或原生配置编辑器
里写，profile 里的显式值优先级最高。

设置页和自己的 Host 半之间走一条插件自带的 HTTP 小桥，不用框架的 Remote：

- Host 半在 `ctx.inject(['webServer'], …)` 里注册 `POST /plugins/offPeak/rpc`，
  请求体是 `{ method, request }`，应答是 `{ ok: true, … }` / `{ ok: false, error }`；
  非 POST 回 405、未知接口或坏 JSON 回 400，插件卸载时路由随之删除；
- Client 半用同源的 `fetch(RPC_URL, { method: 'POST', credentials: 'same-origin' })`
  调用它，`RPC_URL = /plugins/offPeak/rpc`（`offPeak` 就是上面那一行的 id）。

这样写的原因值得记一笔：DSH 的 `ctx.remote.<namespace>` 由**构建期生成**的
descriptor 贡献决定（`@deepseek-ai/dsh-api-remotes` 的 `lib/client.js` 里是写死的
字面量），普通运行时插件没有注册入口，所以纯 JS 插件拿不到自己的 remote 命名空间
——直接调 `ctx.remote.offPeak` 会永远得到 `undefined`，表现就是设置页报「Host 端
插件未激活」。HTTP 桥只依赖已有的 `webServer` 服务，不碰框架内部结构。

## 执行方式

- 15 秒兜底 tick + 窗口交替哨兵（哨兵每秒检查一次切换点，误差不超过 1 秒）；
- 高峰到来时，属于已启用工作区的会话会被停止（等同于用户自己点停止），排队中的
  用户消息被暂存到插件内存队列，空闲时段自动补发；
- `agent/pre-step` 瀑布钩子在高峰时段拒绝启动新的模型步骤，双保险；
- 附带工具 `offPeak_status`，让模型自己也能查询当前处于哪个时段。

## 从 dsh-sparetime 改名

本插件原名 `dsh-sparetime`（命名空间 `sparetime`），现已整体改名为 **dsh-off-peak**
（命名空间 `offPeak`）。升级时注意：

| 旧 | 新 |
| --- | --- |
| 目录 / 包名 `dsh-sparetime` | `dsh-off-peak` |
| 设置命名空间、路由 `sparetime` | `offPeak`（`POST /plugins/offPeak/rpc`） |
| 工具 `sparetime_status` | `offPeak_status` |
| `$DSH_HOME/storages/sparetime/` | `$DSH_HOME/storages/offPeak/` |

首次启动新版时，`offPeak` 目录不存在而旧目录存在的话，插件会**只读地**接管旧目录里的
项目列表与开关（在旧文件上不会写任何东西），之后一切写入都落到新目录。旧目录可以留着
不管，确认新目录工作正常后自行删除即可。

## 安装

```powershell
# 在 DSH 里（或通过 plugin_manager 工具）安装本目录：
plugin_manager  action: install_bundle  target: <本目录的绝对路径>
```

安装后 DSH 会把它写进 profile 的 `dsh.profile.bundles`，并在
`cordis.patch.yml` 中插入一行 `id: offPeak`。设置页里的命名空间就是这一行的 id。

## 验证与排错

四套自测（都在本目录下运行，全部通过）：

| 命令 | 覆盖内容 |
| --- | --- |
| `node tools/selftest.mjs` | 51 项：时段/节假日/周末判定、依赖零外部包、Config 投影、13 个服务方法，以及「读取项目」扫描器（标记识别、深度/数量上限、跳过 `node_modules`、按大小写不敏感比较路径） |
| `node tools/harness.mjs` | 36 项：真 Cordis 运行时里 apply、服务注册、13 个服务方法、工具注册、持久化落盘、改名前的旧存储被接管且不被改写、browse→scan→add 全流程（含已添加去重与非法路径报错），以及 `discover()` 自动扫描（免填路径、已知目录标记、结果缓存与 `force`、超限原因、坏根目录报错） |
| `node tools/enforcement.mjs` | 17 项：伪造时钟验证「高峰自动停止 → 排队消息暂存 → 空闲自动继续并补发 → 空项目冷启动」 |
| `node tools/client-smoke.mjs` | 58 项：模拟浏览器 `__ModuleLoader__` 装载设置页、注册 `settings.section`、字典完整（含英文界面不留中文标点与中文时间单位）、渲染、HTTP 桥调用形状、样式表注入（标签带 `data-plugin`、内容含侧栏度量）、每行一个可键盘操作的 switch，以及「进页面即自动扫描 → 勾选 → 加入并开启错峰模式 → 重新扫描 → 无新项目时收敛为一行提示」的交互链路 |

HTTP 桥另有一次端到端验证（真 `webServer` + 真 `fetch`，临时 profile 端口，不碰桌面版
数据）：`node _dsh_src/_verify_rpc.mjs` 覆盖 ping/status/projects/getConfig/setConfig
往返、未知接口与坏 JSON 的回 400、非 POST 回 405、`/deeper` 不被本路由吃掉（即没有
抢走 client-modules 的 `/plugins` 前缀），以及插件卸载后路由确实被删除。

真进程验证（确认插件在真实 DSH 的 profile 里能被解析并激活）：

```bash
# 1) 解析：从 profile 目录按裸包名导入，看导出形状
cd "$DSH_HOME/profiles/desktop"
node -e "import('dsh-off-peak').then(m => console.log(m.default.name, m.default.inject))"
#    -> offPeak [ 'timer', 'tools', 'agents', 'workspaceRegistry', 'sessions' ]

# 2) 激活：用真实 CLI 启动一次该 profile（第一次会在临时 DSH_HOME 里初始化 profile，
#    因此建议配合一个空的 DSH_HOME 使用；能正常启动并进入任务循环即说明激活无警告）
DSH_HOME=/tmp/offpeak-check node <解包的 DSH>/lib/bin.js --profile desktop 检查
```

`offPeak_status` 工具在运行中的 DSH 里能正常作答，就说明 Host 半已加载；设置页那边
再用浏览器看一眼「错峰模式」一栏是否出数据即可。

（`_dsh_src` 是为离线调试解包的一份 DSH，仅供本机验证使用，已在 `.gitignore` 里排除。）

排错注意事项：

- **改完代码必须重启 DSH。** Node 的 ESM 模块缓存以解析后的 URL 为键且不会失效，
  重新 disable/enable 插件依旧会复用旧模块——调试中它表现为
  `TypeError: Cannot read properties of undefined (reading 'validate')`。
  重启后如需设置页立即出现，刷新一下 DSH 的界面。HTTP 桥的路由在插件 apply 时注册，
  所以重启加载新代码的同时路由就位，不需要再单独重启一次。
- 设置页若报「无法连接错峰模式服务」，先确认 `POST /plugins/offPeak/rpc` 是否活着
  （`ping` 应返回 `{ ok: true, plugin: "offPeak" }`）：400/405 说明路由在但不认识这个
  请求，404 说明 Host 半没注册上（插件未启用或没重启），前端同源 `fetch` 失败则多半是
  页面没走 DSH 自己的 Web 界面打开。
- 原生配置编辑器里本条目状态显示 `unsupported` 属正常：那只是「非原生
  Schemastery schema」的标记，本插件用自己的设置页写入，落点与原生编辑器相同。
- 单次 `DSH_HOME` 里没有 Web 载体（纯 `headless` 模板）时，插件照常激活、时段判定与
  自动停/续都不受影响，只有设置页连不上——HTTP 桥的路由要等 `webServer` 出现才注册。
  项目发现依赖 `workspaceRegistry`，没有它的组合里项目列表为空。
- 节假日表覆盖 2025–2026 年。

## 结构

```
package.json          # dsh.bundle.patch + dsh.client 声明
cordis.patch.yml      # 插入 id: offPeak 这一行
lib/index.js          # Host 半：时钟、执行引擎、项目扫描、offPeak 服务、Config、/plugins/offPeak/rpc
lib/client.js         # Client 半：设置页（Settings → 错峰模式），经 HTTP 桥读数据
lib/schema.js         # 手写的 Schemastery 兼容 schema（toJSON + ~standard）
locale/{zh,en}.json   # 卡片标题与描述
tools/                # 四套自测 + asar 工具
_notes/               # 设计与调试笔记
icon.svg              # 插件图标
GITHUB.md             # 发到 GitHub 用的仓库简介与功能简述（运行不需要）
```
