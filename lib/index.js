/**
 * dsh-skill-manager — Host half.
 *
 * 给「设置 → Skill 管理」页提供数据与动作。skill 是**文件系统上的资源**，
 * 所以这里做两件事：
 *
 *   1. 列清单：把 DSH 实际认得的 skill（`ctx.skills` 注册表，含随包内置的
 *      运行时 provider）与磁盘上的 skill 根目录扫描结果**对起来**。注册表给出
 *      "谁在生效"，扫描给出"文件在哪、能不能动"，缺一不可 —— 被禁用的 skill
 *      只存在于磁盘上，而 bundled / 运行时 provider 的 skill 只存在于注册表里。
 *
 *   2. 管文件：启用 / 禁用（把 `SKILL.md` 改名成 `SKILL.md.disabled`，可逆）、
 *      删除目录、在资源管理器里定位、读取 SKILL.md 正文。
 *
 * 扫描规则对齐 `@deepseek-ai/dsh-skill-filesystem` 的三类根目录（下面的 rank 只是本插件
 * 自己排显示顺序用的权重 —— 公共的 `SkillSummary` 并不带 rank，注册表也不往外给）：
 *
 *   | root                    | source         | rank |
 *   |-------------------------|----------------|------|
 *   | <project>/.dsh/skills   | project-dsh    | 100  |
 *   | <project>/.agents/skills| project-agents | 200  |
 *   | $DSH_HOME/skills        | user-dsh       | 400  |
 *   | $DSH_AGENTS_HOME/skills | user-agents    | 500  |
 *   | $DSH_BUNDLED_SKILL_DIR  | bundled        | 600  |
 *
 * 每个根下认两种形态：目录包 `<name>/SKILL.md`，平铺文件 `<name>.md`；
 * 以 `.` 开头的条目（含 `.system`）一律跳过，与 provider 的 skipSystem 一致。
 *
 * 安全边界：
 *   - 任何文件动作的目标都必须落在上面这些根之内的**一层** skill 条目上；
 *     越界、根目录自身、bundled 根一律拒绝。
 *   - skill 名单不从请求体里信任：删除 / 启停都以"重新扫描出的路径"为准。
 *   - 注册表 `resourceBase` 报出来的目录（bundled provider 就是这种）另开一条**只读**通道：
 *     read / reveal 放行，启停与删除照旧 403；而且只认注册表当次报出来的那一份路径。
 *   - 只删得掉自带的文件，不动任何用户数据目录之外的东西。
 */
import { open, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export const name = "dsh-skill-manager";

/** 只硬依赖 HTTP 服务；skills / workspaceRegistry 都按可选服务动态取。 */
export const inject = ["webServer"];

const API_PREFIX = "/skill-manager/api";
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const FRONTMATTER_PROBE_BYTES = 16 * 1024;
/** 一次 /list 里注册表查询的总时限（每个 cwd 一路，共用这一个 deadline）。 */
const REGISTRY_DEADLINE_MS = 8000;
/** 注册表报出来的只读目标（bundled 等）缓存多久；/list 每次都会刷热。 */
const REGISTRY_TARGET_TTL_MS = 30 * 1000;

/** 目录包 / 平铺文件的两种名字；禁用态靠后缀区分，provider 不会把它们当 skill。 */
const SKILL_FILE = "SKILL.md";
const SKILL_FILE_DISABLED = "SKILL.md.disabled";
const FLAT_SUFFIX = ".md";
const FLAT_SUFFIX_DISABLED = ".md.disabled";

const fail = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

/**
 * Windows / macOS 的文件系统大小写不敏感：路径比较与去重都得跟上。
 * 之前去重用 toLowerCase、前缀检查却大小写敏感，两边不一致。
 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const pathKey = (value) => (CASE_INSENSITIVE_FS ? value.toLowerCase() : value);

const readEnvPath = (key) => {
  const value = process.env[key];
  return typeof value === "string" && value.trim() !== "" ? resolve(value.trim()) : undefined;
};

const resolveDshHome = () => readEnvPath("DSH_HOME") ?? join(homedir(), ".dsh");
const resolveAgentsHome = () => readEnvPath("DSH_AGENTS_HOME") ?? join(homedir(), ".agents");

const statOrUndefined = async (target) => {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
};

/**
 * 极简 YAML frontmatter 解析：只认 skill 头部实际会用到的三种写法 ——
 * `key: value`、`key: >-` 折叠块、`key: |` 字面块，外加多行缩进续行。
 * 不引 yaml 依赖，也不做完整实现：解析不出来就当没有这个字段。
 *
 * ⚠️ 先把行尾归一化成 `\n` 再切行。CRLF 文件切出来的 frontmatter 末尾会留一个
 * `\r`，而 JS 正则的 `.` **不匹配 `\r`**（它算行终止符），`(.*)$` 于是让"最后一行"
 * 整行匹配失败、字段被静默丢掉 —— description 约定俗成就写在最后一行，
 * 所以受伤的几乎总是它。
 */
const parseFrontmatter = (text) => {
  const fields = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    const isBlock = value === ">" || value === ">-" || value === "|" || value === "|-" || value === ">+" || value === "|+";
    if (isBlock) {
      const fold = value.startsWith(">");
      const collected = [];
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        collected.push(next.replace(/^\s+/, ""));
        index += 1;
      }
      value = fold
        ? collected.join(" ").replace(/\s+/g, " ").trim()
        : collected.join("\n").trim();
    } else {
      index += 1;
      // 续行（缩进的裸文本）拼回同一个值
      while (index < lines.length && /^\s+\S/.test(lines[index]) && !/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(lines[index].trim())) {
        value += ` ${lines[index].trim()}`;
        index += 1;
      }
      value = value.replace(/^["']|["']$/g, "").trim();
    }
    if (value !== "") fields[key] = value;
  }
  return fields;
};

/** 读 SKILL.md 的 frontmatter；只看头部若干字节，正文多大都不影响。 */
const readSkillFrontmatter = async (file) => {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return {};
  }
  try {
    const buffer = Buffer.alloc(FRONTMATTER_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_PROBE_BYTES, 0);
    // BOM 会让 startsWith("---") 失败，先摘掉（PowerShell 5.1 的 UTF8 写入就带 BOM）。
    const text = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    if (!text.startsWith("---")) return {};
    const end = text.indexOf("\n---", 3);
    const body = end === -1 ? text.slice(3) : text.slice(3, end);
    return parseFrontmatter(body);
  } catch {
    return {};
  } finally {
    try {
      await handle.close();
    } catch {
      /* ignore */
    }
  }
};

/** skill 名字法度：与 provider 的宽松解析保持一致即可，危险字符一律不收。 */
const isSafeSkillName = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

export function apply(ctx) {
  const info = (message) => ctx.logger?.info?.(`[skill-manager] ${message}`);
  const warn = (message) => ctx.logger?.warn?.(`[skill-manager] ${message}`);

  /** 动态取服务：cordis 版本差异下取不到就当作没有，绝不让插件挂起。 */
  const getService = (key) => {
    try {
      const direct = ctx[key];
      if (direct !== undefined && direct !== null) return direct;
    } catch {
      /* ignore */
    }
    try {
      return typeof ctx.get === "function" ? ctx.get(key) : undefined;
    } catch {
      return undefined;
    }
  };

  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  };

  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 32 * 1024) throw fail("请求体过大", "bad-request");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  /**
   * 写接口的跨站防线。这些写接口不带鉴权（路由不在连接鉴权门内），而浏览器发起的
   * 跨站请求一定带 Origin；"简单请求"又只能带 text/plain 这类 content-type
   * （带 application/json 会先触发预检，而本服务没有 CORS 应答，浏览器自己就挡了）。
   * 所以：content-type 不是 JSON、且 Origin 又对不上 Host 时拒绝。
   * 本页面永远发 application/json，本机脚本通常不带 Origin，都不受影响。
   */
  const admitWrite = (req) => {
    const type = String(req.headers?.["content-type"] ?? "").toLowerCase();
    if (type.includes("application/json")) return true;
    const origin = req.headers?.origin;
    if (typeof origin !== "string" || origin === "") return true;
    const host = req.headers?.host;
    if (typeof host !== "string" || host === "") return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };

  /**
   * 候选项目根：DSH 进程自身的工作目录，加上工作区账本里登记过的路径。
   * 多工作区时逐个扫，同名 skill 取 rank 小的那条。
   */
  const candidateProjects = () => {
    const found = new Set();
    const push = (value) => {
      if (typeof value !== "string" || value.trim() === "") return;
      try {
        found.add(resolve(value.trim()));
      } catch {
        /* ignore */
      }
    };
    push(process.cwd());
    const registry = getService("workspaceRegistry");
    if (registry !== undefined && typeof registry.list === "function") {
      try {
        for (const entity of registry.list()) {
          push(entity?.path ?? entity?.root ?? entity?.cwd ?? entity?.directory ?? entity?.workspacePath);
        }
      } catch (error) {
        warn(`读取工作区账本失败: ${error?.message ?? error}`);
      }
    }
    return [...found].slice(0, 32);
  };

  /** 本轮扫描用到的全部根目录（含不存在的，UI 上要显示"未创建"）。 */
  const buildRoots = (projects) => {
    const roots = [];
    for (const project of projects) {
      roots.push({ path: join(project, ".dsh", "skills"), source: "project-dsh", rank: 100, kind: "project", project });
      roots.push({ path: join(project, ".agents", "skills"), source: "project-agents", rank: 200, kind: "project", project });
    }
    roots.push({ path: join(resolveDshHome(), "skills"), source: "user-dsh", rank: 400, kind: "user" });
    roots.push({ path: join(resolveAgentsHome(), "skills"), source: "user-agents", rank: 500, kind: "user" });
    const bundled = readEnvPath("DSH_BUNDLED_SKILL_DIR");
    if (bundled !== undefined) roots.push({ path: bundled, source: "bundled", rank: 600, kind: "bundled" });

    // 去重（多个项目根可能落到同一处）；大小写敏感性跟平台走。
    const seen = new Set();
    return roots.filter((root) => {
      const key = pathKey(root.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  /** 扫一个根目录：返回磁盘上真实存在的 skill 条目（含被禁用的）。 */
  const scanRoot = async (root) => {
    const entries = await (async () => {
      try {
        return await readdir(root.path, { withFileTypes: true });
      } catch {
        return undefined;
      }
    })();
    if (entries === undefined) return [];

    const rows = [];
    for (const entry of entries) {
      const entryName = entry.name;
      if (entryName.startsWith(".")) continue; // 隐藏项与 .system 一律跳过

      if (entry.isDirectory()) {
        const dir = join(root.path, entryName);
        const active = await statOrUndefined(join(dir, SKILL_FILE));
        const disabled = active === undefined ? await statOrUndefined(join(dir, SKILL_FILE_DISABLED)) : undefined;
        const stamp = active ?? disabled;
        if (stamp === undefined) continue;
        rows.push({
          entryName,
          shape: "directory",
          dir,
          target: dir,
          skillFile: join(dir, active === undefined ? SKILL_FILE_DISABLED : SKILL_FILE),
          disabled: active === undefined,
          mtime: stamp.mtimeMs,
          size: stamp.size,
          root
        });
        continue;
      }

      if (!entry.isFile()) continue;
      const lower = entryName.toLowerCase();
      let skillName;
      let disabled;
      if (lower.endsWith(FLAT_SUFFIX_DISABLED)) {
        skillName = entryName.slice(0, -FLAT_SUFFIX_DISABLED.length);
        disabled = true;
      } else if (lower.endsWith(FLAT_SUFFIX)) {
        skillName = entryName.slice(0, -FLAT_SUFFIX.length);
        disabled = false;
      } else {
        continue;
      }
      if (skillName === "" || skillName.startsWith(".")) continue;
      const file = join(root.path, entryName);
      const stamp = await statOrUndefined(file);
      if (stamp === undefined) continue;
      rows.push({
        entryName,
        shape: "flat",
        dir: root.path,
        target: file,
        skillFile: file,
        disabled,
        mtime: stamp.mtimeMs,
        size: stamp.size,
        root
      });
    }
    return rows;
  };

  /**
   * 向 `ctx.skills` 要一份"DSH 认得的 skill"清单。取不到服务或读取失败都返回
   * undefined —— 这时页面上只剩磁盘扫描结果，功能降级但不会骗人。
   *
   * 每个 cwd 一路查询，但**并发发起**、按 cwd 顺序合并，整体只给一个 deadline：
   * provider 可能 cwd 敏感，可全局层 provider 与 cwd 无关（实测每个 cwd 返回
   * 完全相同），串行 N 次 × 8 秒能把一次 /list 挂死。
   *
   * 注意 `SkillSummary` **没有 rank**（rank / locator 只属于 provider 层的
   * `SkillCandidate`，注册表不往外给），所以同名条目只能"先到先得"，
   * 不能假装按 rank 挑——那行比较曾经恒为假，是死代码。
   */
  const collectFromRegistry = async (projects) => {
    const skills = getService("skills");
    if (skills === undefined || typeof skills.list !== "function") return undefined;

    // 带上 signal：registry 的 lookup 里它是可选参数，但 provider 可能拿它做取消/超时。
    const signal = AbortSignal.timeout(REGISTRY_DEADLINE_MS);
    const lookups = await Promise.all(projects.map(async (project) => {
      try {
        const rows = await skills.list({ cwd: project, signal });
        return Array.isArray(rows) ? rows : undefined;
      } catch (error) {
        warn(`skills.list(${project}) 失败: ${error?.message ?? error}`);
        return undefined;
      }
    }));

    const byName = new Map();
    let any = false;
    for (const rows of lookups) {
      if (rows === undefined) continue;
      any = true;
      for (const row of rows) {
        if (row === null || typeof row !== "object" || typeof row.name !== "string") continue;
        if (!byName.has(row.name)) byName.set(row.name, row);
      }
    }
    return any ? byName : undefined;
  };

  /**
   * 注册表条目的磁盘路径。`SkillSummary` 顶层只有可选 `path`；bundled / 运行时
   * provider 报的是 `resourceBase: { kind: 'directory', path }`（实测 office-* 就是这样）。
   * 两个都要认，否则这些条目在页面上既没有路径、也没法定位或预览。
   */
  const registryPaths = (row) => {
    const base = row?.resourceBase;
    const dir = base !== null && typeof base === "object" && base.kind === "directory" && typeof base.path === "string" && base.path !== ""
      ? resolve(base.path)
      : undefined;
    const path = typeof row?.path === "string" && row.path !== "" ? resolve(row.path) : undefined;
    return { dir, file: path ?? (dir === undefined ? undefined : join(dir, SKILL_FILE)) };
  };

  /**
   * 注册表报出来的技能目录：它们不在磁盘扫描的根里（bundled provider 就是这种），
   * 但路径来自宿主注册表而不是请求体，可以信。只当**只读目标**用 ——
   * 放行 read / reveal，toggle / delete 依旧按 bundled 拒绝。
   */
  let registryTargets = new Map();
  let registryTargetsAt = 0;

  const rememberRegistryTargets = (registry) => {
    const next = new Map();
    if (registry !== undefined) {
      for (const row of registry.values()) {
        const { dir, file } = registryPaths(row);
        if (dir === undefined || file === undefined) continue;
        next.set(pathKey(dir), { dir, file, source: typeof row.source === "string" ? row.source : "bundled" });
      }
    }
    registryTargets = next;
    registryTargetsAt = Date.now();
    return next;
  };

  /** `/list` 每次都会把这张表刷热；直接打 API（没先列清单）时按 TTL 兜一次。 */
  const ensureRegistryTargets = async () => {
    // 用时间戳而不是 size 判断新鲜度：注册表里一个 resourceBase 都没有时，
    // 表永远是空的，按 size 判断会让每次 toggle / delete 都白查一遍注册表。
    if (registryTargetsAt !== 0 && Date.now() - registryTargetsAt < REGISTRY_TARGET_TTL_MS) return registryTargets;
    try {
      return rememberRegistryTargets(await collectFromRegistry([process.cwd()]));
    } catch (error) {
      warn(`读取注册表目标失败: ${error?.message ?? error}`);
      registryTargetsAt = Date.now();
      return registryTargets;
    }
  };

  /** 合并注册表与磁盘：注册表说"生效中"，磁盘说"文件在哪"。 */
  const collect = async () => {
    const projects = candidateProjects();
    const roots = buildRoots(projects);

    const scanned = [];
    for (const root of roots) {
      const rows = await scanRoot(root);
      for (const row of rows) scanned.push(row);
    }

    const registry = await collectFromRegistry(projects);
    rememberRegistryTargets(registry);

    const byFile = new Map();
    const byDir = new Map();
    for (const row of scanned) {
      byFile.set(pathKey(resolve(row.skillFile)), row);
      // 目录包再按"技能目录"记一份：注册表给的路径未必是 SKILL.md，也可能就是那个目录。
      if (row.shape === "directory") byDir.set(pathKey(resolve(row.dir)), row);
    }

    const skills = [];
    const consumed = new Set();

    if (registry !== undefined) {
      for (const row of registry.values()) {
        const { dir, file } = registryPaths(row);
        // 只按**路径**认领磁盘条目：注册表条目要么带 `path`，要么带
        // `resourceBase: { kind: 'directory', path }`（bundled provider 就是后者）。
        // 以前还按"条目名"兜底，那会把"注册表里活着的 foo"错挂到"磁盘上已禁用的 foo"：
        // 页面显示已禁用、按钮却去改另一个文件，甚至点出重名。宁可多出一条只读条目，
        // 也不张冠李戴 —— 文件动作永远只认路径。
        let scannedRow;
        for (const candidate of [file, dir]) {
          if (candidate === undefined) continue;
          scannedRow = byFile.get(pathKey(candidate)) ?? byDir.get(pathKey(candidate));
          if (scannedRow !== undefined) break;
        }
        if (scannedRow !== undefined) consumed.add(scannedRow);

        // 注册表的 description 是必填字段，只有它为空时才回头读一眼文件。
        let frontmatter = {};
        if ((typeof row.description !== "string" || row.description === "") && file !== undefined) {
          frontmatter = await readSkillFrontmatter(file);
        }

        skills.push({
          name: row.name,
          description: (typeof row.description === "string" && row.description !== "" ? row.description : frontmatter.description) ?? "",
          whenToUse: row.whenToUse ?? frontmatter.whenToUse ?? frontmatter.when_to_use ?? "",
          source: row.source ?? (scannedRow === undefined ? "runtime" : scannedRow.root.source),
          // 项目归属：项目级 skill 要按**哪个项目**分组，光有 source 不够。
          project: scannedRow?.root.project,
          provider: row.provider ?? (scannedRow === undefined ? undefined : "filesystem"),
          // SkillSummary 没有 rank；排序权重只可能来自磁盘行的根。
          rank: scannedRow?.root.rank,
          inRegistry: true,
          modelInvocable: row.invocation?.modelInvocable !== false,
          userInvocable: row.invocation?.userInvocable !== false,
          shape: scannedRow?.shape ?? (dir === undefined ? undefined : "directory"),
          dir: scannedRow?.dir ?? dir,
          // 注册表报出来的目录可以定位 / 预览（read / reveal 走只读通道），
          // 但没有认领到磁盘条目时 managed 仍为 false —— 启停与删除按钮不会出现。
          target: scannedRow?.target ?? dir,
          skillFile: scannedRow?.skillFile ?? file,
          disabled: scannedRow?.disabled ?? false,
          managed: scannedRow !== undefined && scannedRow.root.kind !== "bundled",
          mtime: scannedRow?.mtime
        });
      }
    }

    for (const row of scanned) {
      if (consumed.has(row)) continue;
      // 注册表里没有：要么被禁用了，要么注册表本身不可用。
      const frontmatter = await readSkillFrontmatter(row.skillFile);
      const fallbackName = row.shape === "flat" ? row.entryName.replace(/\.md(\.disabled)?$/i, "") : row.entryName;
      skills.push({
        name: isSafeSkillName(frontmatter.name) ? frontmatter.name : fallbackName,
        description: frontmatter.description ?? "",
        whenToUse: frontmatter.whenToUse ?? frontmatter.when_to_use ?? "",
        source: row.root.source,
        project: row.root.project,
        provider: "filesystem",
        rank: row.root.rank,
        inRegistry: false,
        modelInvocable: true,
        userInvocable: true,
        shape: row.shape,
        dir: row.dir,
        target: row.target,
        skillFile: row.skillFile,
        disabled: row.disabled,
        managed: row.root.kind !== "bundled",
        mtime: row.mtime
      });
    }

    skills.sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
      const rankDelta = (a.rank ?? 9999) - (b.rank ?? 9999);
      if (rankDelta !== 0) return rankDelta;
      return a.name.localeCompare(b.name);
    });

    const rootRows = [];
    for (const root of roots) {
      const stamp = await statOrUndefined(root.path);
      rootRows.push({
        path: root.path,
        source: root.source,
        rank: root.rank,
        kind: root.kind,
        project: root.project,
        exists: stamp !== undefined,
        count: scanned.filter((row) => row.root === root).length
      });
    }

    return {
      projects,
      roots: rootRows,
      skills,
      registryAvailable: registry !== undefined,
      bundledDir: readEnvPath("DSH_BUNDLED_SKILL_DIR") ?? null,
      home: { dsh: resolveDshHome(), agents: resolveAgentsHome() }
    };
  };

  /**
   * 校验一个客户端传来的目标：必须在已知根目录之内、且正好是根下的一层
   * skill 条目（目录包或平铺文件）。返回重新扫描得到的权威记录。
   *
   * 不在任何磁盘根里、但注册表（`resourceBase`）报过同一个目录的，走只读通道：
   * bundled provider 的技能就在那儿，允许 read / reveal，启停与删除仍然 403。
   */
  const authorize = async (rawTarget, options = {}) => {
    if (typeof rawTarget !== "string" || rawTarget.trim() === "") throw fail("缺少目标路径", "bad-request");
    const target = resolve(rawTarget.trim());
    const targetKey = pathKey(target);
    const projects = candidateProjects();
    const roots = buildRoots(projects);

    const owner = roots.find((root) => {
      const rootKey = pathKey(resolve(root.path));
      return targetKey === rootKey || targetKey.startsWith(rootKey + sep);
    });

    if (owner !== undefined) {
      if (owner.kind === "bundled" && options.allowBundled !== true) throw fail("随包内置的 skill 不可修改", "forbidden");
      if (targetKey === pathKey(resolve(owner.path))) throw fail("不能把 skill 根目录本身当作目标", "forbidden");

      const rows = await scanRoot(owner);
      const row = rows.find((candidate) => pathKey(resolve(candidate.target)) === targetKey);
      if (row === undefined) throw fail("目标不是一个 skill 条目", "not-found");
      return row;
    }

    // 磁盘根里没有：只有注册表当次报出来的目录才认，绝不从请求体里取路径。
    const known = (await ensureRegistryTargets()).get(targetKey);
    if (known === undefined) throw fail("目标不在已知的 skill 根目录内", "forbidden");
    if (options.allowBundled !== true) throw fail("随包内置的 skill 不可修改", "forbidden");
    return {
      entryName: basename(known.dir),
      shape: "directory",
      dir: known.dir,
      target: known.dir,
      skillFile: known.file,
      disabled: false,
      root: { path: dirname(known.dir), source: known.source, rank: 650, kind: "bundled" }
    };
  };

  const toggleSkill = async (rawTarget) => {
    const row = await authorize(rawTarget);
    const dir = row.shape === "directory" ? row.dir : dirname(row.skillFile);
    const from = join(dir, row.shape === "directory" ? (row.disabled ? SKILL_FILE_DISABLED : SKILL_FILE) : row.entryName);
    const base = row.shape === "directory" ? undefined : row.entryName.replace(/\.disabled$/i, "");
    const to = row.shape === "directory"
      ? join(dir, row.disabled ? SKILL_FILE : SKILL_FILE_DISABLED)
      : join(dir, row.disabled ? base : `${row.entryName}.disabled`);

    try {
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    } catch (error) {
      throw fail(`改名失败: ${error?.message ?? error}`, "io-error");
    }
    const label = row.shape === "directory" ? basename(row.dir) : row.entryName;
    info(`${row.disabled ? "启用" : "禁用"} ${label} (${to})`);
    return { target: row.target, disabled: !row.disabled, skillFile: to };
  };

  const deleteSkill = async (rawTarget) => {
    const row = await authorize(rawTarget);
    const target = row.shape === "directory" ? row.dir : row.skillFile;
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      throw fail(`删除失败: ${error?.message ?? error}`, "io-error");
    }
    info(`删除 ${target}`);
    return { target, removed: true, shape: row.shape };
  };

  const readSkill = async (rawTarget) => {
    const row = await authorize(rawTarget, { allowBundled: true });
    const file = row.skillFile;
    const stamp = await statOrUndefined(file);
    if (stamp === undefined) throw fail("文件不存在", "not-found");
    if (stamp.size > MAX_SKILL_FILE_BYTES) throw fail("文件过大，未在页面中预览", "too-large");
    try {
      const { readFile } = await import("node:fs/promises");
      return { skillFile: file, content: await readFile(file, "utf8") };
    } catch (error) {
      throw fail(`读取失败: ${error?.message ?? error}`, "io-error");
    }
  };

  const revealSkill = async (rawTarget) => {
    const row = await authorize(rawTarget, { allowBundled: true });
    const isDirectory = row.shape === "directory";
    const target = isDirectory ? row.dir : row.skillFile;
    if (process.platform !== "win32") return { revealed: false, reason: "仅在 Windows 上支持定位" };
    // 目录：`explorer.exe <目录>` 直接打开；文件：必须 `/select,` 才是"定位"，
    // 否则 explorer 会拿默认程序把 SKILL.md 打开，那就不是"打开目录"了。
    const args = isDirectory ? [target] : [`/select,${target}`];
    return new Promise((settle) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        settle(value);
      };
      try {
        const child = spawn("explorer.exe", args, { detached: true, stdio: "ignore" });
        child.once("error", (error) => {
          warn(`定位失败: ${error?.message ?? error}`);
          finish({ revealed: false, reason: String(error?.message ?? error) });
        });
        // 等到真的 spawn 成功再报 revealed，别在结果未知时就宣布成功。
        child.once("spawn", () => {
          child.unref();
          finish({ revealed: true, target });
        });
      } catch (error) {
        finish({ revealed: false, reason: String(error?.message ?? error) });
      }
    });
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || "/"
          : "/";

        if (req.method === "GET" && path === "/health") {
          return send(res, 200, {
            ok: true,
            result: {
              home: resolveDshHome(),
              agentsHome: resolveAgentsHome(),
              bundledDir: readEnvPath("DSH_BUNDLED_SKILL_DIR") ?? null,
              registry: getService("skills") !== undefined
            }
          });
        }
        if (req.method === "GET" && path === "/list") {
          return send(res, 200, { ok: true, result: await collect() });
        }
        /** 诊断用：把 `ctx.skills.list()` 的原始结果按 cwd 逐个摊开。 */
        if (req.method === "GET" && path === "/registry") {
          const skills = getService("skills");
          if (skills === undefined || typeof skills.list !== "function") {
            return send(res, 200, { ok: true, result: { available: false } });
          }
          const lookups = [];
          for (const cwd of candidateProjects()) {
            try {
              const rows = await skills.list({ cwd });
              lookups.push({
                cwd,
                count: Array.isArray(rows) ? rows.length : -1,
                names: Array.isArray(rows) ? rows.map((row) => row?.name) : String(rows),
                sample: Array.isArray(rows) ? rows.slice(0, 2) : []
              });
            } catch (error) {
              lookups.push({ cwd, error: (error?.message ?? String(error)).slice(0, 400) });
            }
          }
          return send(res, 200, { ok: true, result: { available: true, lookups } });
        }

        if (req.method !== "POST") {
          return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
        }
        if (!admitWrite(req)) return send(res, 403, { ok: false, error: "拒绝跨站写请求" });

        const raw = await readBody(req);
        let body = {};
        if (raw.trim() !== "") {
          try {
            body = JSON.parse(raw);
          } catch {
            return send(res, 400, { ok: false, error: "请求体不是合法 JSON" });
          }
        }

        if (path === "/toggle") return send(res, 200, { ok: true, result: await toggleSkill(body?.target) });
        if (path === "/delete") return send(res, 200, { ok: true, result: await deleteSkill(body?.target) });
        if (path === "/read") return send(res, 200, { ok: true, result: await readSkill(body?.target) });
        if (path === "/reveal") return send(res, 200, { ok: true, result: await revealSkill(body?.target) });
        return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : undefined;
        const status = code === "bad-request" ? 400
          : code === "forbidden" ? 403
            : code === "not-found" ? 404
              : code === "too-large" ? 413
                : 500;
        warn(`api error: ${error?.message ?? error}`);
        return send(res, status, {
          ok: false,
          ...(code === undefined ? {} : { code }),
          error: error?.message ?? String(error)
        });
      }
    }
  }), "skill-manager: http api");

  info(`已挂载 ${API_PREFIX}`);
}
