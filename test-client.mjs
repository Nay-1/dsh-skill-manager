/**
 * dsh-skill-manager — Client 半自测。
 *
 * 用 mock 的 Module Loader / React 运行时 / primitives / fetch / document
 * 把客户端插件真的跑起来：注册契约、渲染结果、点击后的请求都检查一遍。
 *
 * 运行：node test-client.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

/* ---- 迷你 React 运行时 -------------------------------------------------- */
let hooks = [];
let cursor = 0;
let dirty = false;
let pendingEffects = [];

const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true);
    return { __el: true, type, props: { ...(props ?? {}), children: flat } };
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
    const set = (value) => {
      hooks[index] = typeof value === "function" ? value(hooks[index]) : value;
      dirty = true;
    };
    return [hooks[index], set];
  },
  useCallback(fn, deps) {
    const index = cursor++;
    const previous = hooks[index];
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn;
    hooks[index] = { fn, deps };
    return fn;
  },
  useEffect(fn, deps) {
    const index = cursor++;
    const previous = hooks[index];
    if (previous === undefined || !sameDeps(previous.deps, deps)) pendingEffects.push(fn);
    hooks[index] = { deps };
  },
  useId: () => "dsm-test-id",
  useRef: (value) => ({ current: value })
};
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);

const MockButton = (props) => React.createElement("DSHButton", props, props.children);
const primitives = {
  Button: MockButton,
  IconTrashOutlineRegular: function Icon() { return null; }
};

/* ---- mock document / window -------------------------------------------- */
const styleTags = [];
globalThis.document = {
  querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: (element) => styleTags.push(element) }
};
let loadedDefinition;
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { loadedDefinition = definition; } },
  alert: () => {}
};

/* ---- mock fetch --------------------------------------------------------- */
const fixture = {
  ok: true,
  result: {
    registryAvailable: true,
    projects: ["C:/work"],
    home: { dsh: "C:/Users/x/.dsh", agents: "C:/Users/x/.agents" },
    bundledDir: "C:/dsh/office-skills",
    roots: [
      { path: "C:/work/.agents/skills", source: "project-agents", rank: 200, kind: "project", exists: true, count: 0 },
      { path: "C:/Users/x/.agents/skills", source: "user-agents", rank: 500, kind: "user", exists: true, count: 2 },
      { path: "C:/dsh/office-skills", source: "bundled", rank: 600, kind: "bundled", exists: true, count: 1 }
    ],
    skills: [
      {
        name: "find-skills",
        description: "Discover skills.",
        whenToUse: "",
        source: "project-agents",
        // 故意不给 project：验证客户端能从路径反推出项目根（旧版 host 就长这样）
        provider: "filesystem",
        rank: 200,
        inRegistry: false,
        managed: true,
        disabled: false,
        shape: "directory",
        target: "C:/Users/x/Desktop/proj/.agents/skills/find-skills",
        skillFile: "C:/Users/x/Desktop/proj/.agents/skills/find-skills/SKILL.md"
      },
      {
        name: "proj-dsh",
        description: "Project scoped DSH skill.",
        source: "project-dsh",
        project: "C:/Users/x/Desktop/proj",
        provider: "filesystem",
        rank: 100,
        inRegistry: false,
        managed: true,
        disabled: false,
        shape: "directory",
        target: "C:/Users/x/Desktop/proj/.dsh/skills/proj-dsh",
        skillFile: "C:/Users/x/Desktop/proj/.dsh/skills/proj-dsh/SKILL.md"
      },
      {
        name: "legacy-tool",
        description: "Disabled on purpose.",
        source: "user-agents",
        rank: 500,
        inRegistry: false,
        managed: true,
        disabled: true,
        shape: "directory",
        target: "C:/Users/x/.agents/skills/legacy-tool",
        skillFile: "C:/Users/x/.agents/skills/legacy-tool/SKILL.md.disabled"
      },
      {
        name: "office-docx",
        description: "Word documents.",
        source: "bundled",
        rank: 600,
        inRegistry: true,
        managed: false,
        disabled: false,
        shape: "directory",
        target: "C:/dsh/office-skills/office-docx",
        skillFile: "C:/dsh/office-skills/office-docx/SKILL.md"
      },
      {
        name: "acl-doctor",
        description: "Runtime provided.",
        source: "runtime",
        rank: 600,
        inRegistry: true,
        managed: false,
        disabled: false,
        target: undefined,
        skillFile: undefined
      }
    ]
  }
};

let fetchCalls = [];
let listPayload = fixture;
let postOk = true;

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  const method = options?.method ?? "GET";
  const path = String(url).replace("/skill-manager/api", "");
  if (method === "GET" && path === "/list") return { status: 200, json: async () => listPayload };
  if (postOk !== true) return { status: 500, json: async () => ({ ok: false, error: "boom" }) };
  if (path === "/read") return { status: 200, json: async () => ({ ok: true, result: { skillFile: "x", content: "# hello skill" } }) };
  return { status: 200, json: async () => ({ ok: true, result: { disabled: true } }) };
};

/* ---- mock require / ctx ------------------------------------------------- */
const requireShim = (specifier) => {
  if (specifier === "react") return React;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`unexpected require: ${specifier}`);
};

const registrations = [];
const dictionaries = [];
const ctx = {
  effect: (fn) => { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
  locale: {
    bind: () => (key, params) => {
      const template = dictionaries.at(-1)?.zh?.[key] ?? key;
      if (params === undefined) return template;
      return Object.keys(params).reduce((text, name) => text.split(`{${name}}`).join(String(params[name])), template);
    },
    register: (ns, bundle) => { dictionaries.push({ ns, ...bundle }); return () => {}; },
    getSnapshot: () => ({ revision: 0 }),
    subscribe: () => () => {}
  },
  slots: {
    inject: (name, callback) => callback(),
    register: (options, component) => { registrations.push({ options, component }); return () => {}; }
  }
};

/* ---- 加载客户端半 ------------------------------------------------------- */
const source = readFileSync(join(import.meta.dirname, "lib", "client.js"), "utf8");
// 客户端半是给浏览器准备的 Module Loader 包，这里在 Node 里补上全局后直接执行。
new Function("window", "document", "fetch", source)(globalThis.window, globalThis.document, globalThis.fetch);

check("Module Loader id", loadedDefinition?.id === "dsh-skill-manager", loadedDefinition?.id);
const clientModule = loadedDefinition.factory(requireShim);
check("导出 apply", typeof clientModule.apply === "function");
check("inject 含 slots/locale", Array.isArray(clientModule.inject)
  && clientModule.inject.includes("slots") && clientModule.inject.includes("locale"), JSON.stringify(clientModule.inject));

clientModule.apply(ctx);

/* ---- 注册契约 ----------------------------------------------------------- */
console.log("\n注册契约");
check("注册了一项 settings.section", registrations.length === 1, registrations.length);
const entry = registrations[0];
check("slot 名正确", entry.options.name === "settings.section", entry.options.name);
check("id 正确", entry.options.id === "skill-manager", entry.options.id);
check("order=30（Agent 预设 20 之后）", entry.options.order === 30, entry.options.order);
check("locale 命名空间正确", entry.options.locale === "skill-manager", entry.options.locale);
check("label() 返回中文名", entry.options.label() === "Skill 管理", entry.options.label());
check("注册了中英文字典", dictionaries.length === 1 && dictionaries[0].ns === "skill-manager" && dictionaries[0].en.nav === "Skills");
check("注入了样式标签", styleTags.length === 1 && styleTags[0].dataset.plugin === "dsh-skill-manager");
check("样式里带了设计变量", styleTags[0].textContent.includes("--dsw-alias-settings-card-fill"));

/* ---- 渲染 --------------------------------------------------------------- */
console.log("\n渲染");
/**
 * 真 React 会要求每次渲染的 hooks 数量一致，少了/多了都会抛
 * "Rendered more hooks than during the previous render" 并把 UI 变空白。
 * 迷你运行时默认不做这个检查，于是"hook 写在提前 return 之后"这种错
 * 会悄悄溜过去 —— 所以这里补上同样的校验。
 */
let lastHookCount;
const render = () => {
  cursor = 0;
  const element = entry.component({});
  if (lastHookCount !== undefined && cursor !== lastHookCount) {
    throw new Error(
      `hooks 数量不一致：上一次 ${lastHookCount} 个，这一次 ${cursor} 个`
      + "（真 React 会抛 Rendered more hooks than during the previous render）"
    );
  }
  lastHookCount = cursor;
  return element;
};
const flushEffects = () => { const queue = pendingEffects; pendingEffects = []; for (const effect of queue) effect(); };
const settle = async (rounds = 8) => {
  let tree = render();
  for (let index = 0; index < rounds; index += 1) {
    flushEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dirty) { dirty = false; tree = render(); }
  }
  return tree;
};
const walk = (node, visit) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (typeof node !== "object" || node.__el !== true) return;
  visit(node);
  walk(node.props.children, visit);
};
const textOf = (node) => {
  const parts = [];
  walk(node, (element) => { for (const child of element.props.children) if (typeof child === "string") parts.push(child); });
  return parts.join(" ");
};
const byClass = (node, className) => {
  const hits = [];
  walk(node, (element) => {
    const value = element.props.className;
    if (typeof value === "string" && value.split(/\s+/).includes(className)) hits.push(element);
  });
  return hits;
};
const isButton = (type) => type === MockButton || (typeof type === "string" && type === "button");
const buttonByText = (node, label) => {
  const hits = [];
  walk(node, (element) => { if (isButton(element.type) && textOf(element).includes(label)) hits.push(element); });
  return hits[0];
};

let tree = render();
check("首屏显示读取中", textOf(tree).includes("读取中"), textOf(tree).slice(0, 80));

tree = await settle();
const body = textOf(tree);
check("已发 /list 请求（GET）", fetchCalls.some((call) => String(call.url).endsWith("/skill-manager/api/list") && (call.options?.method ?? "GET") === "GET"));
check("标题渲染", body.includes("Skill 管理"));
check("说明渲染", body.includes("本机可用的 agent skill"));
check("汇总行渲染", body.includes("共 5 个") && body.includes("已禁用 1 个"), body.match(/共[^|]*/)?.[0] ?? body.slice(0, 120));
check("默认全部收起：一张 skill 卡片都不展开", byClass(tree, "dsm-card").length === 0, byClass(tree, "dsm-card").length);
check("收起时分组标题仍在", byClass(tree, "dsm-groupHead").length === 4);
check("显示搜索框", byClass(tree, "dsm-search").length === 1);
// 守卫自证：cursor 确实在数 hooks，而不是恒为 0（否则上面的数量校验等于没开）
check("hooks 计数守卫在工作", typeof lastHookCount === "number" && lastHookCount >= 10, lastHookCount);

/* ---- 分组 --------------------------------------------------------------- */
console.log("\n分组");
{
  check("分成 4 组", byClass(tree, "dsm-group").length === 4, byClass(tree, "dsm-group").length);
  const labels = byClass(tree, "dsm-groupHead").map((head) => textOf(head));
  check("项目级按具体项目分组，标题是缩短后的项目路径",
    labels[0].includes("~/Desktop/proj"), labels.join(" / "));
  check("项目组副标题说明是项目级 + 数量",
    labels[0].includes("项目级 skill · 2 个"), labels[0]);
  check("组顺序：项目 → 用户 → 内置 → 运行时",
    labels[0].includes("~/Desktop/proj") && labels[1].includes("用户 .agents")
    && labels[2].includes("随包内置") && labels[3].includes("运行时提供"),
    labels.join(" / "));
  check("用户组副标题带根目录与数量",
    labels[1].includes("~/.agents/skills") && labels[1].includes("1"), labels[1]);
  check("内置组副标题用根目录（fixture 里给得出路径）",
    labels[2].includes("C:/dsh/office-skills") && labels[2].includes("1"), labels[2]);
  check("运行时组没有根目录，副标题退回说明文案",
    labels[3].includes("由插件在运行时注册"), labels[3]);

  // 展开第一组
  byClass(tree, "dsm-groupHead")[0].props.onClick();
  tree = await settle(2);
  check("点标题展开该组", byClass(tree, "dsm-card").length === 2, byClass(tree, "dsm-card").length);
  check("展开后 aria-expanded=true", byClass(tree, "dsm-groupHead")[0].props["aria-expanded"] === true);
  check("其它组保持收起", byClass(tree, "dsm-groupHead").slice(1).every((head) => head.props["aria-expanded"] === false));

  // 展开余下的组，供后面用
  for (const head of byClass(tree, "dsm-groupHead")) {
    if (head.props["aria-expanded"] === false) head.props.onClick();
  }
  tree = await settle(4);
  check("四组全展开后有 5 张卡片", byClass(tree, "dsm-card").length === 5, byClass(tree, "dsm-card").length);
}

/* ---- 渲染（全展开后）---------------------------------------------------- */
console.log("\n渲染");
{
  const text = textOf(tree);
  check("显示 skill 名称", text.includes("find-skills") && text.includes("office-docx") && text.includes("acl-doctor"));
  check("显示描述", text.includes("Discover skills."));
  check("显示来源标签", text.includes("项目 .agents") && text.includes("随包内置") && text.includes("运行时提供"));
  check("禁用项带「已禁用」徽章", byClass(tree, "dsm-badgeOff").length === 1);
  check("主目录在路径里缩成 ~", text.includes("~/.agents/skills/legacy-tool"), text.match(/~[^ ]*/)?.[0] ?? text.slice(0, 160));
  check("显示 SKILL.md 路径", text.includes("find-skills/SKILL.md"));
  check("描述固定两行（截断样式）", byClass(tree, "dsm-desc").length === 5);
  check("只读 skill 带「只读」徽章",
    textOf(byClass(tree, "dsm-card").find((card) => textOf(card).includes("office-docx"))).includes("只读"));
  check("普通 skill 有禁用/删除按钮", buttonByText(tree, "禁用") !== undefined && buttonByText(tree, "删除") !== undefined);

  const cards = byClass(tree, "dsm-card");
  const bundledCard = cards.find((card) => textOf(card).includes("office-docx"));
  check("内置 skill 卡片没有删除按钮", buttonByText(bundledCard, "删除") === undefined);
  check("内置 skill 卡片没有禁用按钮", buttonByText(bundledCard, "禁用") === undefined);
  check("内置 skill 卡片可以打开目录", buttonByText(bundledCard, "打开目录") !== undefined);
  const runtimeCard = cards.find((card) => textOf(card).includes("acl-doctor"));
  check("运行时 skill 没有任何操作按钮", buttonByText(runtimeCard, "打开目录") === undefined && buttonByText(runtimeCard, "查看") === undefined);
  const disabledCard = cards.find((card) => textOf(card).includes("legacy-tool"));
  check("禁用项显示「启用」按钮", buttonByText(disabledCard, "启用") !== undefined);

  // 收起再展开一次，确认可逆
  byClass(tree, "dsm-groupHead")[0].props.onClick();
  tree = await settle(2);
  check("再点一次可收起该组", byClass(tree, "dsm-card").length === 3, byClass(tree, "dsm-card").length);
  byClass(tree, "dsm-groupHead")[0].props.onClick();
  tree = await settle(2);
  check("第三次点击又展开", byClass(tree, "dsm-card").length === 5);
}

/* ---- 交互 --------------------------------------------------------------- */
console.log("\n交互");
{
  fetchCalls = [];
  const cards = byClass(tree, "dsm-card");
  const card = cards.find((element) => textOf(element).includes("find-skills"));
  buttonByText(card, "禁用").props.onClick();
  await settle();
  const toggleCall = fetchCalls.find((call) => String(call.url).endsWith("/toggle"));
  check("点了禁用 -> POST /toggle", toggleCall !== undefined && toggleCall.options.method === "POST");
  check("请求体带 target", JSON.parse(toggleCall.options.body).target === "C:/Users/x/Desktop/proj/.agents/skills/find-skills");
  check("操作后重新拉列表", fetchCalls.some((call) => (call.options?.method ?? "GET") === "GET" && String(call.url).endsWith("/list")));
}

{
  fetchCalls = [];
  let cards = byClass(tree, "dsm-card");
  let card = cards.find((element) => textOf(element).includes("find-skills"));
  buttonByText(card, "删除").props.onClick();
  tree = await settle(2);
  check("删除需要内联确认", textOf(tree).includes("确认删除"));
  check("确认前没有发删除请求", fetchCalls.every((call) => !String(call.url).endsWith("/delete")));

  cards = byClass(tree, "dsm-card");
  card = cards.find((element) => textOf(element).includes("find-skills"));
  buttonByText(card, "确认删除").props.onClick();
  await settle();
  const deleteCall = fetchCalls.find((call) => String(call.url).endsWith("/delete"));
  check("确认后 POST /delete", deleteCall !== undefined && JSON.parse(deleteCall.options.body).target === "C:/Users/x/Desktop/proj/.agents/skills/find-skills");
}

{
  fetchCalls = [];
  const cards = byClass(tree, "dsm-card");
  const card = cards.find((element) => textOf(element).includes("find-skills"));
  buttonByText(card, "查看").props.onClick();
  tree = await settle();
  check("查看 -> POST /read", fetchCalls.some((call) => String(call.url).endsWith("/read")));
  check("正文渲染在 pre 里", byClass(tree, "dsm-preview")[0] !== undefined && textOf(byClass(tree, "dsm-preview")[0]).includes("# hello skill"));
}

{
  const searchInput = () => { let found; walk(tree, (element) => { if (element.type === "input") found = element; }); return found; };

  // 先把所有组收起来，验证"一搜索就自动摊开"
  for (const head of byClass(tree, "dsm-groupHead")) {
    if (head.props["aria-expanded"] === true) head.props.onClick();
  }
  tree = await settle(3);
  check("全部收起后一张卡片都没有", byClass(tree, "dsm-card").length === 0, byClass(tree, "dsm-card").length);

  searchInput().props.onChange({ target: { value: "office" } });
  tree = await settle(4);
  check("搜索自动展开分组", byClass(tree, "dsm-card").length === 1 && textOf(tree).includes("office-docx"),
    `${byClass(tree, "dsm-card").length} 张卡片`);

  searchInput().props.onChange({ target: { value: "" } });
  tree = await settle(2);
  check("清空搜索后，搜索过的组保持展开",
    byClass(tree, "dsm-card").length === 1 && textOf(tree).includes("office-docx"),
    byClass(tree, "dsm-card").length);

  // 给后面的用例留一个全展开的界面
  for (const head of byClass(tree, "dsm-groupHead")) {
    if (head.props["aria-expanded"] === false) head.props.onClick();
  }
  tree = await settle(4);
  check("手动展开所有组", byClass(tree, "dsm-card").length === 5, byClass(tree, "dsm-card").length);
}

/* ---- 失败路径 ----------------------------------------------------------- */
console.log("\n失败路径");
{
  listPayload = { ok: false, error: "注册表炸了" };
  buttonByText(tree, "刷新").props.onClick();
  tree = await settle();
  check("列表失败时显示错误", textOf(tree).includes("注册表炸了"), textOf(tree).slice(-120));
  listPayload = fixture;
  buttonByText(tree, "刷新").props.onClick();
  tree = await settle();
  check("恢复后错误消失", byClass(tree, "dsm-error").length === 0 && byClass(tree, "dsm-card").length === 5);

  postOk = false;
  const cards = byClass(tree, "dsm-card");
  const card = cards.find((element) => textOf(element).includes("find-skills"));
  buttonByText(card, "禁用").props.onClick();
  tree = await settle();
  check("动作失败时显示错误", textOf(tree).includes("boom"), textOf(tree).slice(-120));
  postOk = true;
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
