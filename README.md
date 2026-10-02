# dsh-skill-manager

在 DeepSeek Harness 的**设置面板**里加一个「Skill 管理」分区（左栏导航，排在「Agent 预设」下方），
用来查看和打理本机的 agent skill。

## 界面

```
设置
├── 通用设置
├── 模型
├── 内置插件
├── Agent 预设
└── Skill 管理   ← 本插件，order 30
```

页面本身：

- 顶部是搜索框 + 刷新按钮；
- 汇总行告诉你一共几个 skill、其中几个被禁用、扫了几个根目录；
- 卡片**按"位置"分组**，样式对齐内置「内置插件」页：一行一个分组，左侧箭头、
  主标题是位置、副标题说明这是什么 + 几个，组与组之间一条细线；**默认全部收起**，
  点整行展开/收起；
  - **项目级按具体项目分组**（一个项目的 `.dsh/skills` 与 `.agents/skills` 合成一组），
    标题用缩短后的项目路径（`~\Desktop\agent-test`）——两个同名项目也能分辨；
  - 用户级、随包内置、运行时按来源分组：用户 `.dsh` → 用户 `.agents` → 随包内置 → 运行时；
  - 一搜索就自动把所有组摊开（既然是在找东西，就不该再点一遍箭头）；
- 卡片高度统一：描述固定**两行**（超出截断，鼠标悬停看全文），没有 description 的也占满两行，
  所以一屏里的卡片块块对齐；
- 卡片内容：名字、来源标签、描述、缩短后的 `SKILL.md` 路径（主目录显示成 `~`，悬停看全路径），
  以及按可得性出现的操作按钮。

| 按钮 | 出现条件 | 干什么 |
|---|---|---|
| 启用 / 禁用 | 文件系统上可写的 skill | `SKILL.md` ⇄ `SKILL.md.disabled` 改名（可逆） |
| 打开目录 | 有路径的 skill（磁盘上的，或注册表 `resourceBase` 报出目录的） | 资源管理器定位到它（平铺文件用 `/select,` 选中，不是打开） |
| 查看 / 收起 | 有路径的 skill | 就地预览 `SKILL.md` 正文 |
| 删除 | 文件系统上可写的 skill | 删掉整个 skill（**内联二次确认**，不可恢复） |

一屏只留一个"实体按钮"（启用/禁用，描边），定位、预览、删除都做成轻量文字动作。

随包内置的（bundled）与运行时 provider 提供的 skill 是**只读**的：能定位、能预览，
但没有启用/禁用与删除按钮（宿主侧也照样 403）。

## 它怎么认 skill

DSH 的 skill 是文件系统资源，插件的扫描规则与 `@deepseek-ai/dsh-skill-filesystem` 对齐：

| 根目录 | source | 显示权重 |
|---|---|---|
| `<项目>/.dsh/skills` | `project-dsh` | 100 |
| `<项目>/.agents/skills` | `project-agents` | 200 |
| `$DSH_HOME/skills`（默认 `~/.dsh/skills`） | `user-dsh` | 400 |
| `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） | `user-agents` | 500 |
| `$DSH_BUNDLED_SKILL_DIR` | `bundled` | 600 |

> 这几个数字只是**本插件排显示顺序**用的权重。公共契约里的 `SkillSummary` 并不带 rank
> （rank / locator 只属于 provider 层的 `SkillCandidate`，注册表不往外给），所以它跟
> provider 内部的名次没有可比性。

项目根取 DSH 进程的工作目录，外加工作区账本（`ctx.workspaceRegistry`）里登记过的每个路径。

每个根下认两种形态：目录包 `<name>/SKILL.md`，以及平铺文件 `<name>.md`。
以 `.` 开头的条目（含 `.system`）一律跳过。

清单来自**两处合并**：

1. `ctx.skills.list()` —— DSH 实际认得的 skill，含随包内置与运行时 provider 注册的；
2. 磁盘扫描 —— 文件到底在哪、能不能动。

两者缺一不可：被禁用的 skill 只存在于磁盘上（注册表看不到它），而运行时 provider 的 skill
只存在于注册表里（没有文件）。页面会标出每个条目的来源；注册表整个不可用时，页面会明确提示
"现在只有磁盘扫描结果"。

合并**只按路径**认领：注册表条目要么带顶层 `path`，要么带
`resourceBase: { kind: 'directory', path }`（bundled provider 实测就是后者）。
认领不到就各自成条 —— 以前还按"条目名"兜底，那会把"注册表里活着的 `foo`"错挂到
"磁盘上已禁用的 `foo`"：页面显示已禁用，按钮却去改另一个文件。宁可多一条只读条目，
也不张冠李戴。

注册表报出来的目录（bundled 等）不在任何扫描根里，所以另开一条**只读通道**：
`read` / `reveal` 放行，`toggle` / `delete` 依旧 403，而且只认注册表**当次**报出来的路径。

> **实测结论（0.2.0-rc.2）**：宿主插件上下文里的 `ctx.skills.list()` **只返回随包内置与运行时
> provider 的 skill**，看不到 `skill-filesystem` 提供的那批 —— DSH 的 skill 注册表可以由 agent
> preset 或 host composition 挂载，而文件系统 provider 挂在前者。所以页面上的文件系统 skill
> 一律来自磁盘扫描，这不是降级。`GET /skill-manager/api/registry` 能把各 cwd 的原始返回摊开看。

## 启用 / 禁用的机制

DSH 本身没有 skill 开关。这里用**改名**实现，且是双向可逆的：

```
<root>/<name>/SKILL.md          ⇄  <root>/<name>/SKILL.md.disabled
<root>/<name>.md                ⇄  <root>/<name>.md.disabled
```

`.disabled` 后缀不匹配 provider 的发现规则（目录包只认 `SKILL.md`，平铺只认 `*.md`），
所以改完名下一条扫描就看不到它了；文件一个字节都没动，随时能改回来。

## 安全边界

所有文件动作的目标都不是从请求体里信任的，而是**重新扫描后**核对过的：

- 目标必须落在已知 skill 根目录**之内**；
- 必须是根下**一层**的 skill 条目（目录包或平铺文件），根目录自身不行；
- `bundled` 根下的一律拒绝（403）；
- 客户端传的路径先 `resolve()` 规范化，`..` 穿越会被前缀检查挡掉；
- 注册表目录那条只读通道只认注册表当次报出来的路径，且只放行 `read` / `reveal`；
- 路径比较的大小写敏感性跟平台走（Windows / macOS 不敏感，Linux 敏感），
  不会出现"去重按小写、前缀检查按原样"的两套标准。

写接口另有一道**跨站防线**：`content-type` 不是 `application/json`、且 `Origin` 又对不上
`Host` 的请求直接 403。浏览器发起的跨站"简单请求"只能带 `text/plain` 这类 content-type，
正好被挡住；带 JSON 的跨站请求会先触发预检，而本服务没有 CORS 应答，浏览器自己就挡了。
本页面永远发 JSON，本机脚本通常不带 `Origin`，都不受影响。

## HTTP API

全部挂在 `/skill-manager/api`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 自检：home、agentsHome、bundledDir、注册表是否可用 |
| GET | `/list` | 完整清单：`projects` / `roots` / `skills` / `registryAvailable` |
| GET | `/registry` | 诊断：把 `ctx.skills.list()` 的原始返回按 cwd 逐个摊开 |
| POST | `/toggle` | `{ target }` → 改名启停 |
| POST | `/delete` | `{ target }` → 删除 |
| POST | `/read` | `{ target }` → 返回 `SKILL.md` 正文（>512 KB 拒绝） |
| POST | `/reveal` | `{ target }` → 资源管理器定位（仅 Windows） |

`/list` 里每个 cwd 的注册表查询是**并发**发起的，整体共用一个 8 秒 deadline：
provider 卡住也不会把一次 `/list` 挂成分钟级（以前是串行 N × 8 秒）。

## 安装

先克隆到本地（路径里别带空格），再用 `dsh plugin` 以 `file:` 依赖把它装进 profile：

```powershell
git clone https://github.com/Nay-1/dsh-skill-manager.git C:/dsh-plugins/dsh-skill-manager
dsh plugin --profile desktop add "file:C:/dsh-plugins/dsh-skill-manager"
```

`desktop` 是 profile 名，按你自己的改。装完确认 profile 的 `package.json` 里
`dsh.profile.bundles` 有 `dsh-skill-manager` —— **只有进了 bundles，`cordis.patch.yml`
那行插入才会生效**（`dsh plugin add` 通常会自动加，加不上就手动补一行）。

### 改了源码之后

pnpm 的 `file:` 依赖是**拷贝**而不是软链，而且它只看 lockfile：直接再 `add` 一次只会得到
`Already up to date`，磁盘上的拷贝**不会更新**。必须**先 remove 再 add**：

```powershell
dsh plugin --profile desktop remove dsh-skill-manager
dsh plugin --profile desktop add "file:C:/dsh-plugins/dsh-skill-manager"
```

另外 host 半和 client 半都**只在 DSH 启动时加载一次**（没有热重载），改完必须重启桌面端。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-skill-manager
```

然后从 `dsh.profile.bundles` 里删掉同名条目。

> 改源码后必须重装一次再重启 DSH：pnpm 的 `file:` 依赖是**拷贝**而不是软链。

## 结构

```
dsh-skill-manager/
├── package.json          插件清单；dsh.bundle.patch 指到 cordis.patch.yml
├── cordis.patch.yml      bundle 层：插入本插件
├── lib/index.js          host 半：扫描 + HTTP API + 文件动作
├── lib/client.js         client 半：settings.section 页面
├── test-host.mjs         host 半自测（90 项）
└── test-client.mjs       client 半自测（67 项）
```

```powershell
node test-host.mjs      # 临时目录里造真实 skill 树，打 API
node test-client.mjs    # mock Module Loader / React / fetch，真渲染一遍页面
```

## 已知限制

- **项目根靠猜**：DSH 的 host 插件拿不到"当前会话的工作目录"，只能拿进程 cwd 和
  工作区账本。项目级 skill 因此可能比你预期多列或少列几个。
- **不改 provider**：禁用是磁盘改名，不是给 skill 系统加开关；正在跑的会话里已经加载过的
  skill 不受影响。
- **删除就是删除**：`rm -rf` 掉 skill 目录，没有回收站。
- 预览只显示 `SKILL.md` 原文（不渲染 Markdown），够用来核对内容。
- 非 Windows 平台没有"打开目录"，接口会返回 `revealed: false`。
- **符号链接不跟随**：`readdir` 的 `Dirent` 对 symlink / junction 既不报目录也不报文件，
  所以链接形式的 skill 条目会被跳过（provider 是否跟随未验证，故不擅自扩大范围）。
- 扫描规则（平铺 `<name>.md`、`.system` 跳过、rank 数值）是与
  `@deepseek-ai/dsh-skill-filesystem` **对齐的约定**，但该 provider 不在公共契约里，
  升级 DSH 后值得重新核对一次。

## 修复记录

### 1.1.0

- **修**：CRLF 的 `SKILL.md` 会丢掉 frontmatter **最后一行**的字段。切出来的 body 末尾留着
  一个 `\r`，而 JS 正则的 `.` 不匹配 `\r`，`(.*)$` 于是整行匹配失败 —— `description`
  约定俗成就写在最后一行，所以受伤的几乎总是它（实测本机 5 个用户 skill 里 3 个描述为空）。
  顺带兼容带 BOM 的文件（`startsWith("---")` 曾经直接失败）。解析前统一归一化行尾。
- **修**：合并注册表与磁盘时不再按"条目名"兜底，只认路径（`path` 或 `resourceBase`）。
  以前同名条目会被错挂：注册表里活着的 `foo` 显示成"已禁用"，按钮却指向磁盘上另一个 `foo`。
- **改**：认 `resourceBase: { kind: 'directory', path }`（bundled provider 实测用这个，
  顶层 `path` 反而没有），于是随包内置的 skill 在页面上有了路径，可以**定位与预览**；
  启停 / 删除仍然 403（新增一条只读通道，只认注册表当次报出来的路径）。
- **改**：`/list` 的注册表查询改成并发 + 单一 8 秒 deadline（原来串行 N × 8 秒）。
- **删**：按 `rank` 挑同名注册表条目的死代码 —— `SkillSummary` 根本没有 rank，那行比较恒为假。
- **修**：`explorer.exe` 定位平铺技能时改用 `/select,<路径>`（原来会把 `.md` 直接打开），
  并且等到真的 spawn 成功才报 `revealed: true`。
- **加**：写接口的跨站防线（`content-type` + `Origin`）。
- **修**：客户端 `load` 不再依赖 `t` 的身份 —— 宿主若每次渲染换一个新的 `t`，
  原来会"拉列表 → setState → 重渲染 → 再拉列表"死循环（测试里已能复现：2 → 6 次）。
- **改**：预览缓存随刷新清理孤儿键；样式标签改成随插件卸载移除。
- **修**：路径比较的大小写一致性；平铺技能的启停日志不再打印根目录名。
- 测试从 62 + 43 项扩到 **90 + 67** 项，新增 CRLF / BOM / 同名冲突 / `resourceBase` /
  只读通道 / 跨站请求 / 单 cwd 失败降级 / `t` 身份稳定性 / 预览清理等用例。
