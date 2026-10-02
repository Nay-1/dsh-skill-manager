/**
 * dsh-skill-manager — Client half.
 *
 * 往设置面板的左侧导航注册一个「Skill 管理」分区
 * （`settings.section`，order 30 —— 排在「Agent 预设」(20) 之后）。
 *
 * 页面自己做三件事：列清单、按项目/来源筛、对单个 skill 执行
 * 启用 / 禁用 / 删除 / 定位 / 预览。数据与动作全部走 host 半的
 * `/skill-manager/api`，客户端不直接碰文件系统。
 *
 * 布局约定：
 *   - 清单按「位置」分组：项目级按**具体项目**分组（同一个项目的 .dsh 与 .agents
 *     合成一组），用户级与内置、运行时按来源分组；
 *   - 卡片高度统一：描述固定两行（`-webkit-line-clamp`），没有 description 也占满，
 *     所以一屏里的卡片块块对齐；
 *   - 一屏只留一个"实体按钮"（启用/禁用），定位、预览、删除都做成轻量文字动作。
 *
 * 删除是不可逆的磁盘操作，所以给了一次**内联**确认（按钮就地变成
 * 「确认删除？」，可能的话再加一句后果说明），不用原生 confirm 弹窗。
 *
 * 打包形态：DSH 的 Module Loader 包（factory(require)），无构建步骤；
 * 样式随组件注入一个 <style> 标签，沿用内置页面的 --dsw-* 设计变量。
 */
window.__ModuleLoader__.load({
  id: "dsh-skill-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const NS = "skill-manager";
    const API = "/skill-manager/api";

    /* ------------------------------------------------------------------ *
     * 样式：沿用内置设置页的 --dsw-* 变量，几何与「内置插件」页对齐。
     * ------------------------------------------------------------------ */
    const css = `
/* 内容撑满设置面板的可用宽度：卡片贴左侧、占满右侧，不留一截空档 */
.dsm-section{width:100%;color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;display:flex}
.dsm-heading{margin:0;font-size:18px;font-weight:600}
.dsm-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.dsm-toolbar{align-items:center;gap:8px;display:flex}
.dsm-search{flex:1 1 auto;align-items:center;display:flex;position:relative;min-width:0}
.dsm-search input{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;outline:none;padding:0 12px;font-size:13px;box-sizing:border-box}
.dsm-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsm-search input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%, transparent)}
.dsm-summary{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.dsm-notice{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);margin:0;padding:8px 12px;font-size:12px;line-height:18px}
.dsm-error{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-error-primary);margin:0;padding:8px 12px;font-size:12px;line-height:18px;word-break:break-word}

/* 分组：样式对齐内置「内置插件」页 —— 整行可点，标题 + 副标题两行，组间一条细线 */
.dsm-groups{flex-direction:column;display:flex}
.dsm-group{flex-direction:column;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsm-group:last-child{border-bottom:0}
.dsm-groupHead{align-items:flex-start;gap:10px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border:0;padding:13px 0;display:flex;width:100%;text-align:left}
.dsm-groupHead:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)}
.dsm-groupHead:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsm-groupArrow{color:var(--dsw-alias-label-tertiary);flex:0 0 auto;width:14px;font-size:15px;line-height:22px;text-align:center;transition:transform .12s ease}
.dsm-groupArrow[data-open=true]{transform:rotate(90deg)}
.dsm-groupText{flex:1 1 auto;flex-direction:column;gap:2px;min-width:0;display:flex}
.dsm-groupLabel{font-size:14px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-groupSub{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion: reduce){.dsm-groupArrow{transition:none}}

/* 卡片 */
/* 卡片与分组标题左对齐，并一起撑满整行 —— 不额外缩进，避免右边空一截 */
.dsm-cards{flex-direction:column;gap:8px;margin:0;padding:2px 0 16px;list-style:none;display:flex}
.dsm-card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);flex-direction:column;gap:5px;min-width:0;padding:11px 14px 12px;display:flex;transition:border-color .12s ease}
.dsm-card:hover{border-color:var(--dsw-alias-border-l3)}
.dsm-card[data-off=true]{opacity:.58}
@media (prefers-reduced-motion: reduce){.dsm-card{transition:none}}
.dsm-cardHead{align-items:center;gap:12px;display:flex;justify-content:space-between;min-width:0}
.dsm-title{align-items:center;gap:8px;display:flex;min-width:0;flex:1 1 auto}
.dsm-name{font-size:13.5px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-badge{flex:0 0 auto;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);border-radius:999px;color:var(--dsw-alias-label-tertiary);padding:0 8px;font-size:11px;line-height:16px;white-space:nowrap}
/* 主题契约里的名字是 state-warn-primary；两种拼写都用链式 fallback 兜住，最后才落到固定色 */
.dsm-badgeOff{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#c08a2e));background:color-mix(in srgb, var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,#c08a2e)) 14%, transparent)}
.dsm-actions{align-items:center;gap:2px;flex:0 0 auto;display:flex}

/* 按钮三档：quiet（默认）/ primary（描边）/ danger（红字） */
.dsm-btn{font:inherit;cursor:pointer;border:0;border-radius:var(--dsw-radius-sm);background:0 0;padding:3px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsm-btn:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-primary)}
.dsm-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsm-btn:disabled{cursor:default;opacity:.45}
.dsm-btn.dsm-btnPrimary{color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);padding:3px 10px}
.dsm-btn.dsm-btnPrimary:hover:not(:disabled){border-color:var(--dsw-alias-border-l4);background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)}
.dsm-btn.dsm-btnDanger{color:var(--dsw-alias-state-error-primary)}
.dsm-btn.dsm-btnDanger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}

/* 描述固定两行：等高是刻意的，块块对齐比塞满文字重要 */
.dsm-desc{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12.5px;line-height:19px;min-height:38px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsm-path{color:var(--dsw-alias-label-tertiary);opacity:.72;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-confirm{align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:2px}
.dsm-preview{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));margin:4px 0 0;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:17px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word}
`;

    const CSS_TAG_ID = "dsh-skill-manager/SkillManagerSection.module.css";
    /**
     * 注入一次样式，返回的 disposer 在插件卸载时把标签摘掉。
     * （宿主还给动态客户端半提供了 `styles.insert`，但那要先确认 Module Loader 的取用方式；
     * 这里走 document 这条确定能走通的路径，只是补上生命周期。）
     */
    const insertStyles = () => {
      if (typeof document === "undefined" || document.head === undefined) return () => {};
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-skill-manager";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
      return () => {
        try {
          if (typeof tag.remove === "function") tag.remove();
          else if (typeof document.head.removeChild === "function") document.head.removeChild(tag);
        } catch {
          /* ignore */
        }
      };
    };

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    const zh = {
      nav: "Skill 管理",
      title: "Skill 管理",
      intro: "本机可用的 agent skill：来自哪里、是否生效，可直接启用、禁用、定位或删除。",
      search: "搜索名称、描述或来源",
      refresh: "刷新",
      loading: "读取中…",
      empty: "没有找到任何 skill。",
      emptyFiltered: "没有匹配的 skill。",
      summary: "共 {total} 个 · 已禁用 {off} 个 · {roots} 个根目录（存在 {exists} 个）",
      enable: "启用",
      disable: "禁用",
      reveal: "打开目录",
      view: "查看",
      hide: "收起",
      remove: "删除",
      confirmRemove: "确认删除",
      cancel: "取消",
      removeHint: "将从磁盘删除，不可恢复。",
      disabledTag: "已禁用",
      readOnlyTag: "只读",
      runtimeTag: "运行时",
      projectTag: "项目",
      subProject: "项目级 skill · {count} 个",
      subBundled: "随 DSH 一起提供，只读 · {count} 个",
      subRuntime: "由插件在运行时注册 · {count} 个",
      noDescription: "SKILL.md 里没有 description",
      noRegistry: "skill 注册表在宿主侧不可用，这里是磁盘扫描结果。",
      error: "操作失败：{message}",
      errorNoApi: "接口没有响应，host 半可能未加载",
      sourceProjectDsh: "项目 .dsh",
      sourceProjectAgents: "项目 .agents",
      sourceUserDsh: "用户 .dsh",
      sourceUserAgents: "用户 .agents",
      sourceBundled: "随包内置",
      sourceRuntime: "运行时提供"
    };
    const en = {
      nav: "Skills",
      title: "Skills",
      intro: "Agent skills on this machine: where each one comes from, whether it is live, and enable, disable, reveal, or delete it.",
      search: "Search name, description, or source",
      refresh: "Refresh",
      loading: "Loading…",
      empty: "No skills found.",
      emptyFiltered: "No matching skills.",
      summary: "{total} skills · {off} disabled · {roots} roots ({exists} present)",
      enable: "Enable",
      disable: "Disable",
      reveal: "Reveal",
      view: "View",
      hide: "Hide",
      remove: "Delete",
      confirmRemove: "Delete",
      cancel: "Cancel",
      removeHint: "Removes the files from disk; cannot be undone.",
      disabledTag: "Disabled",
      readOnlyTag: "Read-only",
      runtimeTag: "Runtime",
      projectTag: "Project",
      subProject: "Project-scoped skills · {count}",
      subBundled: "Ships with DSH, read-only · {count}",
      subRuntime: "Registered at runtime by plugins · {count}",
      noDescription: "no description in SKILL.md",
      noRegistry: "The skill registry is unavailable on the host; this is the filesystem scan.",
      error: "Failed: {message}",
      errorNoApi: "The endpoint did not respond; the host half may not be loaded",
      sourceProjectDsh: "Project .dsh",
      sourceProjectAgents: "Project .agents",
      sourceUserDsh: "User .dsh",
      sourceUserAgents: "User .agents",
      sourceBundled: "Bundled",
      sourceRuntime: "Runtime provider"
    };

    const h = React.createElement;

    function apply(ctx) {
      const slots = ctx.slots;
      if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") return;

      const translate = (key, params) => {
        try {
          const bound = ctx.locale?.bind?.(NS);
          if (typeof bound === "function") return bound(key, params);
        } catch {
          /* 回落到内置中文 */
        }
        const template = zh[key] ?? key;
        if (params === undefined) return template;
        return Object.keys(params).reduce(
          (text, name) => text.split(`{${name}}`).join(String(params[name])),
          template
        );
      };

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "skill-manager: dictionaries");
      ctx.effect(insertStyles, "skill-manager: styles");

      const SOURCE_KEYS = {
        "project-dsh": "sourceProjectDsh",
        "project-agents": "sourceProjectAgents",
        "user-dsh": "sourceUserDsh",
        "user-agents": "sourceUserAgents",
        bundled: "sourceBundled",
        runtime: "sourceRuntime"
      };
      /** 非项目组的先后：用户 → 内置 → 运行时。 */
      const SOURCE_ORDER = ["user-dsh", "user-agents", "bundled", "runtime"];

      const request = async (path, body) => {
        const response = await fetch(`${API}${path}`, body === undefined
          ? { method: "GET" }
          : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
        const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (data === null || typeof data !== "object" || data.ok !== true) {
          throw new Error((data && data.error) || translate("errorNoApi"));
        }
        return data.result;
      };

      /** 一个 skill 的稳定键：优先磁盘路径，运行时 skill 退回名字。 */
      const keyOf = (skill) => String(skill.target ?? skill.skillFile ?? skill.name);

      /**
       * 项目归属。优先用 host 给的 `project`，取不到就从路径反推：
       * `<项目根>/.agents/skills/<名字>/SKILL.md` 的 `<项目根>` 就是项目。
       * 这样即使 host 半是旧版本（没有 project 字段），分组依然按具体项目走，
       * 而且同一个项目的 `.dsh` 与 `.agents` 会自然归到一组。
       */
      const projectOf = (skill) => {
        if (typeof skill.project === "string" && skill.project !== "") return skill.project;
        if (typeof skill.source !== "string" || !skill.source.startsWith("project-")) return undefined;
        const full = typeof skill.skillFile === "string" ? skill.skillFile : skill.target;
        if (typeof full !== "string") return undefined;
        const match = /^(.*)[\\/]\.(?:agents|dsh)[\\/]skills(?:[\\/]|$)/i.exec(full);
        if (match === null || match[1] === "") return undefined;
        return match[1];
      };

      function SkillManagerSection(props) {
        const t = typeof props?.t === "function" ? props.t : translate;
        const [data, setData] = React.useState(undefined);
        const [error, setError] = React.useState("");
        const [query, setQuery] = React.useState("");
        const [busy, setBusy] = React.useState("");
        const [confirming, setConfirming] = React.useState("");
        const [preview, setPreview] = React.useState({});
        /** 展开的组。默认全收起 —— 跟内置「内置插件」页一样，先看分类再决定看哪个。 */
        const [expanded, setExpanded] = React.useState(() => new Set());
        /** 渲染时把当前所有组键记下来，供"一搜索就全展开"用。 */
        const groupKeys = React.useRef([]);

        /**
         * 最新的 t 放进 ref：错误文案要用当前语言，但**不能**让 t 的身份进依赖 ——
         * 宿主若每次渲染都给一个新的 t，`load` 就会换身份、effect 跟着重跑，
         * 于是"拉列表 → setState → 重渲染 → 再拉列表"死循环。
         */
        const tRef = React.useRef(t);
        tRef.current = t;

        /** 刷新后把已经不在清单里的预览丢掉，别留着过期的键。 */
        const prunePreview = React.useCallback((result) => {
          const rows = Array.isArray(result?.skills) ? result.skills : [];
          const live = new Set(rows.map((skill) => keyOf(skill)));
          setPreview((previous) => {
            const keys = Object.keys(previous);
            if (keys.every((key) => live.has(key))) return previous;
            const next = {};
            for (const key of keys) if (live.has(key)) next[key] = previous[key];
            return next;
          });
        }, []);

        const load = React.useCallback(() => {
          setError("");
          request("/list")
            .then((result) => {
              setData(result);
              prunePreview(result);
            })
            .catch((cause) => setError(tRef.current("error", { message: (cause && cause.message) || String(cause) })));
        }, [prunePreview]);

        React.useEffect(() => {
          load();
        }, [load]);

        /**
         * 搜索时先把所有组摊开：既然是在找东西，就不该再点一遍箭头。
         *
         * ⚠️ 这个 hook 必须待在下面那个 `data === undefined` 提前 return **之前** ——
         * hooks 的调用数量每次渲染都得一样，挪到后面会让首屏（少一个）和加载完成
         * （多一个）对不上，React 直接抛 "Rendered more hooks than during the
         * previous render"，整块 UI 变空白。
         */
        const trimmedQuery = query.trim();
        React.useEffect(() => {
          if (trimmedQuery === "") return;
          setExpanded((previous) => {
            const next = new Set(previous);
            for (const key of groupKeys.current) next.add(key);
            return next;
          });
        }, [trimmedQuery]);

        const act = React.useCallback((path, body, label) => {
          setError("");
          setBusy(label);
          request(path, body)
            .then(() => {
              setConfirming("");
              load();
            })
            .catch((cause) => setError(tRef.current("error", { message: (cause && cause.message) || String(cause) })))
            .finally(() => setBusy(""));
        }, [load]);

        const togglePreview = React.useCallback((skill) => {
          const key = keyOf(skill);
          if (preview[key] !== undefined) {
            setPreview((previous) => {
              const next = { ...previous };
              delete next[key];
              return next;
            });
            return;
          }
          request("/read", { target: skill.target ?? skill.skillFile })
            .then((result) => setPreview((previous) => ({ ...previous, [key]: result.content })))
            .catch((cause) => setError(tRef.current("error", { message: (cause && cause.message) || String(cause) })));
        }, [preview]);

        /** 主目录在界面上缩成 `~`：路径是次要信息，不该抢标题的注意力。 */
        const shorten = (value) => {
          if (typeof value !== "string" || value === "") return "";
          const dshHome = data?.home?.dsh;
          if (typeof dshHome !== "string") return value;
          const homeRoot = dshHome.replace(/[\\/][^\\/]+$/, "");
          if (homeRoot !== "" && value.toLowerCase().startsWith(homeRoot.toLowerCase())) {
            return `~${value.slice(homeRoot.length)}`;
          }
          return value;
        };

        const button = (option) => h("button", {
          key: option.key,
          type: "button",
          className: option.className === undefined ? "dsm-btn" : `dsm-btn ${option.className}`,
          disabled: option.disabled === true,
          title: option.title,
          onClick: option.onClick
        }, option.label);

        if (data === undefined) {
          return h("div", { className: "dsm-section" },
            h("h2", { className: "dsm-heading" }, t("title")),
            h("p", { className: "dsm-summary" }, error === "" ? t("loading") : ""),
            error === "" ? null : h("p", { className: "dsm-error" }, error));
        }

        const skills = Array.isArray(data.skills) ? data.skills : [];
        const needle = query.trim().toLowerCase();
        const visible = needle === ""
          ? skills
          : skills.filter((skill) => {
            const source = t(SOURCE_KEYS[skill.source] ?? "") ?? "";
            const haystack = `${skill.name} ${skill.description ?? ""} ${skill.whenToUse ?? ""} ${skill.source ?? ""} ${skill.project ?? ""} ${source}`.toLowerCase();
            return haystack.includes(needle);
          });
        const offCount = skills.filter((skill) => skill.disabled === true).length;
        const roots = Array.isArray(data.roots) ? data.roots : [];
        const existsCount = roots.filter((root) => root.exists === true).length;

        const sourceLabel = (skill) => {
          const key = SOURCE_KEYS[skill.source];
          if (key !== undefined) return t(key);
          return skill.source ?? t("runtimeTag");
        };

        /* 分组：项目级按项目合并（.dsh 与 .agents 同属一个项目），其余按来源。 */
        const groups = [];
        const groupIndex = new Map();
        for (const skill of visible) {
          const project = projectOf(skill);
          const source = typeof skill.source === "string" && skill.source !== "" ? skill.source : "runtime";
          const groupKey = project === undefined ? `source\u0000${source}` : `project\u0000${project}`;
          if (!groupIndex.has(groupKey)) {
            groupIndex.set(groupKey, groups.length);
            groups.push({ key: groupKey, project, source, rows: [] });
          }
          groups[groupIndex.get(groupKey)].rows.push(skill);
        }
        const groupRank = (group) => {
          if (group.project !== undefined) return 0;
          const index = SOURCE_ORDER.indexOf(group.source);
          return 1 + (index === -1 ? SOURCE_ORDER.length : index);
        };
        groups.sort((a, b) => {
          const delta = groupRank(a) - groupRank(b);
          if (delta !== 0) return delta;
          if (a.project !== undefined && b.project !== undefined) return a.project.localeCompare(b.project);
          return 0;
        });

        const toggleGroup = (key) => setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });

        const renderCard = (skill) => {
          const key = keyOf(skill);
          const managed = skill.managed === true;
          const hasTarget = typeof (skill.target ?? skill.skillFile) === "string";
          const isConfirming = confirming === key;

          const badges = [h("span", { className: "dsm-badge", key: "source" }, sourceLabel(skill))];
          if (skill.disabled === true) badges.push(h("span", { className: "dsm-badge dsm-badgeOff", key: "off" }, t("disabledTag")));
          else if (managed !== true) badges.push(h("span", { className: "dsm-badge", key: "ro" }, t("readOnlyTag")));

          const actions = [];
          if (managed) {
            actions.push(button({
              key: "toggle",
              className: "dsm-btnPrimary",
              label: skill.disabled === true ? t("enable") : t("disable"),
              disabled: busy !== "",
              onClick: () => act("/toggle", { target: skill.target }, key)
            }));
          }
          if (hasTarget) {
            actions.push(button({
              key: "reveal",
              label: t("reveal"),
              disabled: busy !== "",
              onClick: () => act("/reveal", { target: skill.target ?? skill.skillFile }, key)
            }));
            actions.push(button({
              key: "view",
              label: preview[key] === undefined ? t("view") : t("hide"),
              disabled: busy !== "",
              onClick: () => togglePreview(skill)
            }));
          }
          if (managed) {
            actions.push(button({
              key: "remove",
              className: "dsm-btnDanger",
              label: t("remove"),
              disabled: busy !== "",
              onClick: () => setConfirming(isConfirming ? "" : key)
            }));
          }

          const description = typeof skill.description === "string" && skill.description !== ""
            ? skill.description
            : t("noDescription");
          const path = shorten(skill.skillFile);

          const body = [
            h("div", { className: "dsm-cardHead", key: "head" }, [
              h("div", { className: "dsm-title", key: "title" }, [
                h("span", { className: "dsm-name", key: "n", title: skill.name }, skill.name),
                ...badges
              ]),
              actions.length === 0 ? null : h("div", { className: "dsm-actions", key: "actions" }, actions)
            ]),
            // title 里给全文：卡片只露两行，但鼠标停一下就能读完。
            h("p", { className: "dsm-desc", key: "desc", title: description }, description)
          ];
          if (path !== "") body.push(h("span", { className: "dsm-path", key: "path", title: skill.skillFile }, path));
          if (isConfirming) {
            body.push(h("div", { className: "dsm-confirm", key: "confirm" }, [
              h("span", { key: "hint" }, t("removeHint")),
              button({
                key: "yes",
                className: "dsm-btnDanger",
                label: t("confirmRemove"),
                disabled: busy !== "",
                onClick: () => act("/delete", { target: skill.target }, key)
              }),
              button({
                key: "no",
                label: t("cancel"),
                disabled: busy !== "",
                onClick: () => setConfirming("")
              })
            ]));
          }
          if (preview[key] !== undefined) {
            body.push(h("pre", { className: "dsm-preview", key: "preview" }, preview[key]));
          }
          return h("li", { className: "dsm-card", key, "data-off": skill.disabled === true ? "true" : undefined }, body);
        };

        /** 副标题：这个组是什么、在哪、几个 —— 学内置「内置插件」页的「由 … 组成 · N 个」。 */
        const groupSubtitle = (group) => {
          const count = group.rows.length;
          if (group.project !== undefined) return t("subProject", { count });
          const root = roots.find((row) => row.source === group.source && row.kind !== "project");
          if (root !== undefined && typeof root.path === "string") return `${shorten(root.path)} · ${count}`;
          if (group.source === "bundled") return t("subBundled", { count });
          return t("subRuntime", { count });
        };

        groupKeys.current = groups.map((group) => group.key);

        const renderGroup = (group) => {
          const open = expanded.has(group.key);
          // 项目名可能重名（两个 agent-test），所以标题用**缩短后的项目路径**，
          // 完整路径挂在 title 上。
          const label = group.project === undefined
            ? (SOURCE_KEYS[group.source] === undefined ? group.source : t(SOURCE_KEYS[group.source]))
            : shorten(group.project);
          return h("section", { className: "dsm-group", key: group.key }, [
            h("button", {
              type: "button",
              className: "dsm-groupHead",
              key: "head",
              "aria-expanded": open,
              title: group.project ?? label,
              onClick: () => toggleGroup(group.key)
            }, [
              h("span", { className: "dsm-groupArrow", key: "arrow", "data-open": open ? "true" : undefined }, "›"),
              h("span", { className: "dsm-groupText", key: "text" }, [
                h("span", { className: "dsm-groupLabel", key: "label" }, label),
                h("span", { className: "dsm-groupSub", key: "sub" }, groupSubtitle(group))
              ])
            ]),
            open ? h("ul", { className: "dsm-cards", key: "list" }, group.rows.map(renderCard)) : null
          ]);
        };

        return h("div", { className: "dsm-section" }, [
          h("h2", { className: "dsm-heading", key: "h" }, t("title")),
          h("p", { className: "dsm-intro", key: "i" }, t("intro")),
          h("div", { className: "dsm-toolbar", key: "toolbar" }, [
            h("div", { className: "dsm-search", key: "search" },
              h("input", {
                type: "search",
                value: query,
                placeholder: t("search"),
                onChange: (event) => setQuery(event.target.value)
              })),
            button({
              key: "refresh",
              className: "dsm-btnPrimary",
              label: t("refresh"),
              disabled: busy !== "",
              onClick: () => load()
            })
          ]),
          h("p", { className: "dsm-summary", key: "summary" },
            t("summary", { total: skills.length, off: offCount, roots: roots.length, exists: existsCount })),
          data.registryAvailable === false
            ? h("p", { className: "dsm-notice", key: "notice" }, t("noRegistry"))
            : null,
          error === "" ? null : h("p", { className: "dsm-error", key: "err" }, error),
          visible.length === 0
            ? h("p", { className: "dsm-summary", key: "empty" }, skills.length === 0 ? t("empty") : t("emptyFiltered"))
            : h("div", { className: "dsm-groups", key: "list" }, groups.map(renderGroup))
        ]);
      }

      slots.inject("settings.section", () => slots.register({
        name: "settings.section",
        id: "skill-manager",
        // 内置分区的 order：account=-10 / general=0 / plugins=15 / agent-presets=20，
        // 30 落在「Agent 预设」下方。
        order: 30,
        label: () => translate("nav"),
        locale: NS,
        inject: () => ({})
      }, SkillManagerSection));
    }

    const inject = ["slots", "locale"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
