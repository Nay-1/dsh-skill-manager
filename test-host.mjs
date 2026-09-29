/**
 * dsh-skill-manager — Host 半自测。
 *
 * 在临时目录里造一套真实的 skill 根目录（目录包 / 平铺文件 / 已禁用 /
 * 隐藏项 / bundled），用 mock ctx 把插件挂起来，然后像 HTTP 客户端那样
 * 逐个打 API，检查行为与安全边界。
 *
 * 运行：node test-host.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API_PREFIX = "/skill-manager/api";

let pass = 0;
let failed = 0;
const check = (label, condition, extra) => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${extra === undefined ? "" : ` -> ${extra}`}`);
  }
};

const root = await mkdtemp(join(tmpdir(), "dsh-skill-manager-test-"));
const dshHome = join(root, ".dsh");
const agentsHome = join(root, ".agents");
const project = join(root, "project");
const bundled = join(root, "bundled");

const skillFile = (dir, name = "SKILL.md") => join(dir, name);
const writeSkill = async (path, frontmatter, body = "# body\n") => {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await mkdir(path.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  await writeFile(path, `---\n${frontmatter}\n---\n\n${body}`, "utf8");
};

// ---- 夹具 ---------------------------------------------------------------
const userAgents = join(agentsHome, "skills");
const userDsh = join(dshHome, "skills");

await writeSkill(skillFile(join(userAgents, "find-skills")),
  "name: find-skills\ndescription: Helps users discover and install agent skills when they ask how do I do X.");
await writeSkill(skillFile(join(userAgents, "multi-line")),
  "name: multi-line\ndescription: >-\n  Folded line one\n  and line two.\nwhenToUse: When testing folded YAML.");
await writeFile(join(userAgents, "flat-skill.md"), "---\nname: flat-skill\ndescription: A flat markdown skill.\n---\n\nbody\n", "utf8");

await writeSkill(skillFile(join(userDsh, "dsh-add-model")), "name: dsh-add-model\ndescription: 给 DSH 加模型。");
await writeSkill(join(userDsh, "legacy-tool", "SKILL.md.disabled"), "name: legacy-tool\ndescription: Disabled on purpose.");

// 应被跳过的：隐藏目录 / .system / 没有 SKILL.md 的目录
await writeSkill(skillFile(join(userAgents, ".hidden")), "name: .hidden\ndescription: nope");
await writeSkill(skillFile(join(userDsh, ".system", "internal")), "name: internal\ndescription: nope");
await mkdir(join(userAgents, "empty-dir"), { recursive: true });

// bundled：只读
await writeSkill(skillFile(join(bundled, "office-docx")), "name: office-docx\ndescription: Word documents.");

// 项目根下的 skill
await writeSkill(skillFile(join(project, ".agents", "skills", "proj-skill")), "name: proj-skill\ndescription: Project scoped.");

// ---- 环境与 mock ctx -----------------------------------------------------
process.env.DSH_HOME = dshHome;
process.env.DSH_AGENTS_HOME = agentsHome;
process.env.DSH_BUNDLED_SKILL_DIR = bundled;
process.chdir(project);

const registryRows = [
  { name: "acl-doctor", description: "Runtime provided skill.", provider: "win32-acl", source: "runtime", rank: 600, invocation: { modelInvocable: true, userInvocable: true } }
];

const services = {
  skills: { list: async () => registryRows },
  workspaceRegistry: { list: () => [{ path: project }] }
};

const registered = [];
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  effect: (fn) => { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
  get: (key) => services[key],
  webServer: { register: (options) => { registered.push(options); return () => {}; } }
};

const mod = await import(pathToFileURL(join(import.meta.dirname, "lib", "index.js")).href);
check("导出 name", mod.name === "dsh-skill-manager", mod.name);
check("inject 只硬依赖 webServer", Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === "webServer", JSON.stringify(mod.inject));

mod.apply(ctx);
check("注册了一个 prefix 路由", registered.length === 1 && registered[0].kind === "prefix" && registered[0].path === API_PREFIX);
const handler = registered[0].handler;

const call = async (method, path, body) => {
  const req = {
    method,
    url: `${API_PREFIX}${path}`,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
    }
  };
  let status = 0;
  let payload;
  const res = {
    writeHead: (code) => { status = code; },
    end: (text) => { try { payload = JSON.parse(text); } catch { payload = text; } }
  };
  await handler(req, res);
  return { status, payload };
};

// ---- /health -------------------------------------------------------------
console.log("\n/health");
{
  const { status, payload } = await call("GET", "/health");
  check("200", status === 200);
  check("ok", payload?.ok === true);
  check("报告 registry 可用", payload?.result?.registry === true);
  check("报告 bundledDir", payload?.result?.bundledDir === bundled, payload?.result?.bundledDir);
}

// ---- /list ---------------------------------------------------------------
console.log("\n/list");
let listed;
{
  const { status, payload } = await call("GET", "/list");
  check("200", status === 200);
  listed = payload.result;
  const names = listed.skills.map((skill) => skill.name);
  check("包含 find-skills", names.includes("find-skills"), names.join(","));
  check("包含多行 description 的 skill", names.includes("multi-line"));
  check("包含平铺 skill", names.includes("flat-skill"));
  check("包含 user-dsh 的 skill", names.includes("dsh-add-model"));
  check("包含被禁用的 skill", names.includes("legacy-tool"));
  check("包含 bundled skill", names.includes("office-docx"));
  check("包含项目 skill", names.includes("proj-skill"));
  check("包含运行时注册表 skill", names.includes("acl-doctor"));
  check("跳过了隐藏目录", !names.includes(".hidden"));
  check("跳过了 .system", !names.includes("internal"));
  check("跳过了没有 SKILL.md 的目录", !names.includes("empty-dir"));

  const legacy = listed.skills.find((skill) => skill.name === "legacy-tool");
  check("legacy-tool 标记为已禁用", legacy?.disabled === true, JSON.stringify(legacy));
  check("legacy-tool 指向 SKILL.md.disabled", legacy?.skillFile?.endsWith("SKILL.md.disabled") === true, legacy?.skillFile);
  check("legacy-tool 可管理", legacy?.managed === true);

  const office = listed.skills.find((skill) => skill.name === "office-docx");
  check("bundled skill 不可管理", office?.managed === false, JSON.stringify(office));
  check("bundled skill 来源正确", office?.source === "bundled");

  const acl = listed.skills.find((skill) => skill.name === "acl-doctor");
  check("运行时 skill 不可管理", acl?.managed === false);
  check("运行时 skill 无 target", acl?.target === undefined);

  const multi = listed.skills.find((skill) => skill.name === "multi-line");
  check("折叠 description 被展开", multi?.description === "Folded line one and line two.", multi?.description);
  check("whenToUse 被解析", multi?.whenToUse === "When testing folded YAML.", multi?.whenToUse);

  check("禁用的排在最后", listed.skills[listed.skills.length - 1].name === "legacy-tool", listed.skills.map((s) => s.name).join(","));
  check("registryAvailable=true", listed.registryAvailable === true);
  check("根目录里有 bundled", listed.roots.some((r) => r.kind === "bundled" && r.exists === true));
  check("根目录里有项目 .agents", listed.roots.some((r) => r.source === "project-agents" && r.exists === true));
  check("项目 .dsh 根不存在但仍在列表里", listed.roots.some((r) => r.source === "project-dsh" && r.exists === false));

  const projectSkill = listed.skills.find((skill) => skill.name === "proj-skill");
  check("项目级 skill 带 project 字段", projectSkill?.project === project, projectSkill?.project);
  check("项目级 skill 的 source 正确", projectSkill?.source === "project-agents", projectSkill?.source);
  check("用户级 skill 没有 project 字段", listed.skills.find((skill) => skill.name === "find-skills")?.project === undefined);
  check("bundled skill 没有 project 字段", listed.skills.find((skill) => skill.name === "office-docx")?.project === undefined);
}

// ---- /toggle -------------------------------------------------------------
console.log("\n/toggle");
{
  const target = join(userAgents, "find-skills");
  const { status, payload } = await call("POST", "/toggle", { target });
  check("200", status === 200);
  check("返回 disabled=true", payload?.result?.disabled === true, JSON.stringify(payload));
  check("SKILL.md 已改名", !existsSync(skillFile(target)) && existsSync(skillFile(target, "SKILL.md.disabled")));

  const after = (await call("GET", "/list")).payload.result.skills.find((skill) => skill.name === "find-skills");
  check("列表里仍在，且标记为禁用", after?.disabled === true && after?.inRegistry === false, JSON.stringify(after));

  const back = await call("POST", "/toggle", { target });
  check("再切回启用", back.payload?.result?.disabled === false);
  check("SKILL.md 回来了", existsSync(skillFile(target)) && !existsSync(skillFile(target, "SKILL.md.disabled")));
}

{
  const target = join(userAgents, "flat-skill.md");
  await call("POST", "/toggle", { target });
  check("平铺文件被禁用", existsSync(`${target}.disabled`));
  const after = (await call("GET", "/list")).payload.result.skills.find((skill) => skill.name === "flat-skill");
  check("平铺禁用后名字仍正确", after?.name === "flat-skill" && after?.disabled === true, JSON.stringify(after));
  await call("POST", "/toggle", { target: `${target}.disabled` });
  check("平铺文件被重新启用", existsSync(target) && !existsSync(`${target}.disabled`));
}

// ---- /read ---------------------------------------------------------------
console.log("\n/read");
{
  const { status, payload } = await call("POST", "/read", { target: join(userAgents, "find-skills") });
  check("200", status === 200);
  check("返回 SKILL.md 正文", typeof payload?.result?.content === "string" && payload.result.content.includes("find-skills"));
  const bundledRead = await call("POST", "/read", { target: join(bundled, "office-docx") });
  check("bundled 可读", bundledRead.status === 200 && bundledRead.payload.ok === true);
}

// ---- 安全边界 -----------------------------------------------------------
console.log("\n安全边界");
{
  const outside = await call("POST", "/delete", { target: join(root, "..", "not-a-skill") });
  check("越界路径 403", outside.status === 403, JSON.stringify(outside.payload));

  const rootItself = await call("POST", "/delete", { target: userAgents });
  check("根目录本身 403", rootItself.status === 403, JSON.stringify(rootItself.payload));

  const bundledDelete = await call("POST", "/delete", { target: join(bundled, "office-docx") });
  check("bundled 删除 403", bundledDelete.status === 403, JSON.stringify(bundledDelete.payload));
  check("bundled 目录还在", existsSync(join(bundled, "office-docx", "SKILL.md")));

  const bundledToggle = await call("POST", "/toggle", { target: join(bundled, "office-docx") });
  check("bundled 启停 403", bundledToggle.status === 403);

  const empty = await call("POST", "/delete", {});
  check("缺目标 400", empty.status === 400);

  const missing = await call("POST", "/delete", { target: join(userAgents, "empty-dir") });
  check("非 skill 条目 404", missing.status === 404, JSON.stringify(missing.payload));

  const badJson = await (async () => {
    const req = { method: "POST", url: `${API_PREFIX}/delete`, async *[Symbol.asyncIterator]() { yield Buffer.from("{not json"); } };
    let status = 0; let payload;
    await handler(req, { writeHead: (c) => { status = c; }, end: (t) => { payload = JSON.parse(t); } });
    return { status, payload };
  })();
  check("坏 JSON 400", badJson.status === 400);

  const notFound = await call("GET", "/nope");
  check("未知路由 404", notFound.status === 404);

  const revealOutside = await call("POST", "/reveal", { target: join(root, "..", "elsewhere") });
  check("reveal 越界 403（不会拉起资源管理器）", revealOutside.status === 403);
}

// ---- /delete -------------------------------------------------------------
console.log("\n/delete");
{
  const dir = join(userDsh, "legacy-tool");
  const { status, payload } = await call("POST", "/delete", { target: dir });
  check("200", status === 200);
  check("报告已删除", payload?.result?.removed === true && payload?.result?.shape === "directory");
  check("目录真的没了", !existsSync(dir));
  const names = (await call("GET", "/list")).payload.result.skills.map((skill) => skill.name);
  check("列表里也不再有它", !names.includes("legacy-tool"));
}

// ---- registry 缺席时的降级 ----------------------------------------------
console.log("\n降级：registry 不可用");
{
  const saved = services.skills;
  services.skills = undefined;
  const { payload } = await call("GET", "/list");
  check("registryAvailable=false", payload.result.registryAvailable === false);
  check("磁盘上的 skill 仍然列得出来", payload.result.skills.some((skill) => skill.name === "find-skills"));
  check("运行时 skill 消失（本来也不在磁盘上）", !payload.result.skills.some((skill) => skill.name === "acl-doctor"));
  services.skills = saved;
}

// ---- 清理 ---------------------------------------------------------------
process.chdir(tmpdir()); // Windows 不允许删掉当前工作目录
await rm(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
