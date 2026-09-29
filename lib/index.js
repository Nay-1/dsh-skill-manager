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
 * 扫描规则对齐 `@deepseek-ai/dsh-skill-filesystem` 的三类根目录与 rank：
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

/** 目录包 / 平铺文件的两种名字；禁用态靠后缀区分，provider 不会把它们当 skill。 */
const SKILL_FILE = "SKILL.md";
const SKILL_FILE_DISABLED = "SKILL.md.disabled";
const FLAT_SUFFIX = ".md";
const FLAT_SUFFIX_DISABLED = ".md.disabled";

const fail = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

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
 */
const parseFrontmatter = (text) => {
  const fields = {};
  const lines = text.split(/\r?\n/);
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
    const text = buffer.subarray(0, bytesRead).toString("utf8");
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

    // 去重（多个项目根可能落到同一处）
    const seen = new Set();
    return roots.filter((root) => {
      const key = root.path.toLowerCase();
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
   */
  const collectFromRegistry = async (projects) => {
    const skills = getService("skills");
    if (skills === undefined || typeof skills.list !== "function") return undefined;
    const byName = new Map();
    let any = false;
    for (const project of projects) {
      let rows;
      try {
        // 带上 signal：registry 的 lookup 里它是可选参数，但 provider 可能拿它做取消/超时，
        // 缺了会让"这次查询算不算数"变得含糊。超时也只影响这一路，磁盘扫描照旧。
        rows = await skills.list({ cwd: project, signal: AbortSignal.timeout(8000) });
      } catch (error) {
        warn(`skills.list(${project}) 失败: ${error?.message ?? error}`);
        continue;
      }
      if (!Array.isArray(rows)) continue;
      any = true;
      for (const row of rows) {
        if (row === null || typeof row !== "object" || typeof row.name !== "string") continue;
        const previous = byName.get(row.name);
        if (previous === undefined || (row.rank ?? 0) < (previous.rank ?? 0)) byName.set(row.name, row);
      }
    }
    return any ? byName : undefined;
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
    const byFile = new Map();
    const byEntryName = new Map();
    for (const row of scanned) {
      byFile.set(resolve(row.skillFile).toLowerCase(), row);
      // 注册表条目的 locator 未必是文件系统路径（provider 可能给 URL，也可能不给），
      // 所以再按"条目名"兜一层：目录名，或去掉 .md 后缀的文件名。
      const entryName = row.shape === "flat" ? row.entryName.replace(/\.md(\.disabled)?$/i, "") : row.entryName;
      if (!byEntryName.has(entryName)) byEntryName.set(entryName, row);
    }

    const skills = [];
    const consumed = new Set();

    if (registry !== undefined) {
      for (const row of registry.values()) {
        const locator = typeof row.locator === "string" ? row.locator : (typeof row.path === "string" ? row.path : undefined);
        let scannedRow = locator === undefined ? undefined : byFile.get(resolve(locator).toLowerCase());
        if (scannedRow === undefined && typeof row.name === "string") scannedRow = byEntryName.get(row.name);
        if (scannedRow !== undefined) consumed.add(scannedRow);

        const frontmatter = locator === undefined ? {} : await readSkillFrontmatter(locator);
        skills.push({
          name: row.name,
          description: row.description ?? frontmatter.description ?? "",
          whenToUse: row.whenToUse ?? frontmatter.whenToUse ?? frontmatter.when_to_use ?? "",
          source: row.source ?? (scannedRow === undefined ? "runtime" : scannedRow.root.source),
          // 项目归属：项目级 skill 要按**哪个项目**分组，光有 source 不够。
          project: scannedRow?.root.project,
          provider: row.provider ?? (scannedRow === undefined ? undefined : "filesystem"),
          rank: row.rank ?? (scannedRow === undefined ? undefined : scannedRow.root.rank),
          inRegistry: true,
          modelInvocable: row.invocation?.modelInvocable !== false,
          userInvocable: row.invocation?.userInvocable !== false,
          shape: scannedRow?.shape,
          dir: scannedRow?.dir,
          target: scannedRow?.target,
          skillFile: scannedRow?.skillFile ?? locator,
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
   */
  const authorize = async (rawTarget, options = {}) => {
    if (typeof rawTarget !== "string" || rawTarget.trim() === "") throw fail("缺少目标路径", "bad-request");
    const target = resolve(rawTarget.trim());
    const projects = candidateProjects();
    const roots = buildRoots(projects);

    const owner = roots.find((root) => {
      const rootPath = resolve(root.path);
      return target === rootPath || target.startsWith(rootPath + sep);
    });
    if (owner === undefined) throw fail("目标不在已知的 skill 根目录内", "forbidden");
    if (owner.kind === "bundled" && options.allowBundled !== true) throw fail("随包内置的 skill 不可修改", "forbidden");
    if (target === resolve(owner.path)) throw fail("不能把 skill 根目录本身当作目标", "forbidden");

    const rows = await scanRoot(owner);
    const row = rows.find((candidate) => resolve(candidate.target).toLowerCase() === target.toLowerCase());
    if (row === undefined) throw fail("目标不是一个 skill 条目", "not-found");
    return row;
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
    info(`${row.disabled ? "启用" : "禁用"} ${basename(row.dir) || row.entryName} (${to})`);
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
    const target = row.shape === "directory" ? row.dir : row.skillFile;
    if (process.platform !== "win32") return { revealed: false, reason: "仅在 Windows 上支持定位" };
    return new Promise((settle) => {
      try {
        const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore" });
        child.on("error", (error) => {
          warn(`定位失败: ${error?.message ?? error}`);
          settle({ revealed: false, reason: String(error?.message ?? error) });
        });
        child.unref();
        settle({ revealed: true, target });
      } catch (error) {
        settle({ revealed: false, reason: String(error?.message ?? error) });
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
