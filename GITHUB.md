# GitHub 发布素材

本文件是给 GitHub 仓库主页用的文案，不是插件运行所需的内容。直接用整段，或按需拆开。

---

## 仓库简介（About 那一栏，≤ 350 字符）

> 按 DeepSeek 错峰价格表调度 DSH 工作区：空闲时段自动开始、高峰时段自动停止，暂停期间排队的消息不会丢。带独立设置页、项目自动发现与 `offPeak_status` 工具。零依赖纯 JS 插件。

## Topics 建议

```
dsh  deepseek-harness  deepseek  cordis  plugin  scheduler  cron  cost-optimization
idle-window  time-window  nodejs  windows  zh-cn
```

---

## 功能简述（README 顶部 / Release 说明可直接用）

### 错峰模式 · dsh-off-peak

**让工作区按价格表自己跑：空闲半价时段自动开始，高峰全价时段自动停止。**

DeepSeek 的错峰优惠让空闲时段只要高峰的一半价钱。这个 DSH 插件把这件事自动化：你照常
安排工作，它负责在合适的时段干活——不用再盯着表手动开始和停止。

#### 核心能力

- **时段自动判定，与机器时区无关。** 一律按北京时间（`Asia/Shanghai`）判定，高峰为
  周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00，其余全部时间算空闲：
  午休、18:00 到次日 09:00、周末全天、法定节假日全天。内置 2025–2026 年中国大陆
  节假日表。
- **高峰自动停止 + 排队消息不丢。** 高峰到来时，属于已启用工作区的会话被干净地停止；
  这期间你发出去、被排队的消息会暂存在插件里，进入空闲时段后连人带消息一起接着跑。
  另有 `agent/pre-step` 钩子在高峰拒绝启动新的模型步骤，双保险。
- **空闲自动开始。** 项目里没有任何会话在跑时，空闲时段自动唤醒该项目最近使用的会话，
  机器闲着的时间也变成可用时间。
- **逐项目开关。** 不是一刀切：每个工作区单独勾选是否参与，另有「全部开启 / 全部关闭 /
  立即停止全部 / 立即继续全部」四个一键操作。
- **打开设置页就自动发现项目。** 不需要先填路径：插件以「DSH 已知工作区的父目录 + 用户
  主目录」为范围扫描带项目标记的目录（`package.json`、`.git`、`pyproject.toml`、`go.mod`、
  `Cargo.toml` 等），跳过 `node_modules`、`dist` 等噪音目录，找到一个项目就不再往下钻。
  扫描是异步的、有耗时与层数上限，超限会把原因显示出来而不是卡住界面；勾选后一次性
  注册为工作区并同时开启错峰模式，已存在的目录自动去重。找不到的仍可手动逐层点选。
- **精确到秒的窗口切换。** 15 秒兜底 tick 加一个每秒检查切换点的哨兵，高峰不会多跑一秒。
- **模型也能查时段。** 附带 `offPeak_status` 工具，模型可以自己判断当前处于哪个时段、
  下一个切换点是什么、有哪些项目开着。

#### 设计取向：轻

- **零运行时依赖**，纯 JS，Host 半与设置页都不引入任何第三方包；
- **不碰框架内部结构。** 设置页与自己 Host 半之间走一条插件自带的同源 HTTP 小桥
  （`POST /plugins/offPeak/rpc`），只依赖 DSH 已有的 `webServer` 服务；插件卸载时路由
  随之删除，不会残留；
- **配置落在明面上。** 项目列表与四个开关分别是 `$DSH_HOME/storages/offPeak/` 下的
  `projects.json` 与 `config.json`，四个开关同时声明为插件 `Config`，所以既能用设置页点，
  也能在 profile 的 `cordis.patch.yml` 或原生配置编辑器里写；
- **可验证。** 自带四套自测共 162 项（含真 Cordis 运行时、伪造时钟的强制停/续流程、模拟
  浏览器装载设置页的交互链路），另有一次真 `webServer` + 真 `fetch` 的端到端桥验证。

#### 装法

```powershell
plugin_manager  action: install_bundle  target: <本目录的绝对路径>
```

DSH 会把它写进 profile 的 `dsh.profile.bundles` 并在 `cordis.patch.yml` 插入一行
`id: offPeak`。**改完代码需要重启 DSH**（Node 的 ESM 模块缓存不会失效），重启后刷新
界面即可看到设置页里的「错峰模式」一栏。

---

## 发布前的三件事

1. **`.gitignore` 已经写好**，把 108 MB 的解包 DSH（`_dsh_src/`）、`_asar/`、改名前的
   源码备份（`_rename-backup/`）、以及自测用的一次性 profile（`_verify*`、`_harness_home`、
   `_enforcement_home`、`_acl-recovery`）都排除掉了。首次提交前先看一眼
   `git status --short`：列出来的应该只有 `lib/`、`locale/`、`tools/`、`icon.svg`、
   `package.json`、`cordis.patch.yml`、`README.md`、`GITHUB.md`、`.gitignore`
   （`_notes/` 是设计笔记，想留就留、想干净就一起忽略）。
2. **`package.json` 里的 `"private": true`** 建议保留：这个插件是装进 DSH profile 的
   bundle，不是发到 npm 的包；如果以后想 `npm publish`，再去掉它并补上 `repository`
   与 `license` 字段。
3. **仓库还没有 git**。要发的话：

   ```bash
   git init -b main
   git add .
   git status --short          # 确认没有 _dsh_src / _asar 之类的大家伙
   git commit -m "错峰模式 · dsh-off-peak v0.1.0"
   git remote add origin <你的仓库地址>
   git push -u origin main
   ```

## 细节请见

完整说明、逐项验证清单与排错注意事项都在 [README.md](README.md)。
