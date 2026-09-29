import type { QuartzComponent, QuartzComponentProps } from "@quartz-community/types";
import { classNames } from "../util/lang";
import { i18n } from "../i18n";
import style from "./styles/backlinks.scss";
import { resolveRelative, simplifySlug } from "../util/path";

export interface SortConfig {
  type: "date" | "numeric" | "natural" | "lexical";
  order?: "asc" | "desc";
  /** natural/lexical 默认 "title"；date 取 frontmatter 日期；numeric 取 frontmatter 数值 */
  field?: string;
}

export interface BacklinksOptions {
  hideWhenEmpty: boolean;
  sort?: SortConfig;
}

type QuartzComponentConstructor<Options extends object | undefined = undefined> = (
  opts: Options,
) => QuartzComponent;

const defaultOptions: BacklinksOptions = {
  hideWhenEmpty: true,
};

export interface BacklinkCandidate {
  unlisted?: boolean;
  links?: string[];
  slug?: string;
  frontmatter?: { title?: string };
}

export function selectBacklinkSources<T extends BacklinkCandidate>(
  allFiles: T[],
  currentSlug: string,
): T[] {
  return allFiles.filter((file) => file.unlisted !== true && file.links?.includes(currentSlug));
}

// ===== 运行时排序代码生成（序列化为自包含 JS 函数，结构与 v4 一致） =====

function generateBacklinksSortFnCode(config: SortConfig): string {
  const order = config.order ?? "asc";
  const multiplier = order === "asc" ? "1" : "-1";
  const { type, field = "title" } = config;

  const getStringVal = (v: string) => {
    if (field === "title") return v + ".title";
    if (field === "slug") return v + ".slug";
    return `(((${v}.frontmatter && ${v}.frontmatter["${field}"]) !== undefined && ${v}.frontmatter["${field}"] !== null) ? String(${v}.frontmatter["${field}"]) : "")`;
  };

  const getDateVal = (v: string) => `(function(item) {
    var fm = item.frontmatter;
    var df = fm && fm["${field}"];
    if (df !== undefined && df !== null) {
      var dt = new Date(df);
      if (!isNaN(dt.getTime())) return dt;
    }
    return null;
  })(${v})`;

  const getNumVal = (v: string) => `(function(item) {
    var fm = item.frontmatter;
    var raw = fm && fm["${field}"];
    if (raw !== undefined && raw !== null) {
      var n = Number(raw);
      if (!isNaN(n)) return n;
    }
    return 0;
  })(${v})`;

  const tieBreaker = 'a.title.localeCompare(b.title, undefined, {numeric: true, sensitivity: "base"})';

  let compareCode = "";
  switch (type) {
    case "date": {
      const da = getDateVal("a"),
        db = getDateVal("b");
      compareCode = `
        var da = ${da}, db = ${db};
        if (da === null && db === null) return ${tieBreaker};
        if (da === null) return 1;
        if (db === null) return -1;
        var r = (da.getTime() - db.getTime()) * ${multiplier};
        if (r !== 0) return r;
        return ${tieBreaker};`;
      break;
    }
    case "numeric": {
      const na = getNumVal("a"),
        nb = getNumVal("b");
      compareCode = `
        var na = ${na}, nb = ${nb};
        var r = (na - nb) * ${multiplier};
        if (r !== 0) return r;
        return ${tieBreaker};`;
      break;
    }
    case "natural":
      compareCode = `var r = ${getStringVal("a")}.localeCompare(${getStringVal("b")}, undefined, {numeric: true, sensitivity: "base"}) * ${multiplier}; if (r !== 0) return r; return ${tieBreaker};`;
      break;
    case "lexical":
      compareCode = `return ${getStringVal("a")}.localeCompare(${getStringVal("b")}) * ${multiplier};`;
      break;
  }

  return `(function(a, b) { ${compareCode} })`;
}

// ===== 运行时反链分组脚本 =====
//
// 数据链路（与 v4 反向链接优化同思路，数据源换成 v5 协议）：
// 1. 反链页面列表：优先读 graph-pro 预计算的局部图谱 JSON（节点自带 frontmatter），
//    缺失时回退 static/contentIndex.json 全量扫描 links。
// 2. 分组规则：运行时 fetch static/aggregation.json（aggregation-pro 产物，继承已解析），
//    反链页面按「所在目录各自的 resolved 字段链」逐级分组，语义与 graph/explorer 一致
//    （minGroupSize、未分类键、folder 首层）。站点未配 aggregation 时退化为平铺列表。
// 脚本失败时保留构建期渲染的静态列表，不会白屏。

const runtimeScript = `
;(function () {
  var UNCLASSIFIED = "\\u672a\\u5206\\u7c7b" // 与 aggregation-pro / graph-pro 一致

  // ---- Promise 缓存：脚本在 SPA 导航后常驻，缓存跨页面复用 ----
  var localGraphCache = new Map()
  var aggregationPromise = null
  var contentIndexPromise = null

  // 纯 JS 实现的 djb2 哈希，与 graph-pro 构建端/运行时逐字符一致（路径协议勿改）
  function djb2Hash(message) {
    var hash = 5381
    for (var i = 0; i < message.length; i++) {
      hash = (hash << 5) + hash + message.charCodeAt(i)
      hash = hash & 0xffffffff
    }
    return (hash >>> 0).toString(16).padStart(8, "0")
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  }

  function resolveRelativeHref(current, target) {
    var depth = current.split("/").length - 1
    return "../".repeat(depth) + target + ".html"
  }

  function firstValue(value) {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (value[i] !== undefined && value[i] !== null && value[i] !== "") return value[i]
      }
      return undefined
    }
    return value !== undefined && value !== null && value !== "" ? value : undefined
  }

  // 把 [[target]] / [[target|display]] 剥离为纯文本（与 graph-pro sharedAggregation 一致）
  function stripWikilink(value) {
    var m = String(value).match(/^\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|([^\\]]*))?\\]\\]$/)
    if (!m) return value
    var display = m[2] ? m[2].trim() : ""
    return display || m[1].trim()
  }

  function isFolderIndexSlug(slug) {
    return slug === "" || slug === "/" || slug === "index" || /\\/$/.test(slug) || /\\/index$/.test(slug)
  }

  function withBase(basePath, path) {
    return (basePath ? "/" + basePath : "") + path
  }

  // ---- 数据加载 ----

  function fetchLocalGraph(slug, basePath) {
    if (localGraphCache.has(slug)) return localGraphCache.get(slug)
    var p = (async function () {
      try {
        var h = djb2Hash(slug).slice(0, 4)
        var url = withBase(basePath, "/graph/local/" + h.slice(0, 2) + "/" + h.slice(2, 4) + "/" + encodeURIComponent(slug) + ".json")
        var resp = await fetch(url)
        if (!resp.ok) return null
        return await resp.json()
      } catch (e) {
        return null
      }
    })()
    localGraphCache.set(slug, p)
    return p
  }

  function fetchAggregation(basePath) {
    if (aggregationPromise) return aggregationPromise
    aggregationPromise = (async function () {
      try {
        var resp = await fetch(withBase(basePath, "/static/aggregation.json"))
        if (!resp.ok) return null
        var data = await resp.json()
        if (!data || data.version !== 1 || !data.root || data.root.type !== "folder" || !data.resolved || typeof data.resolved !== "object") return null
        return data
      } catch (e) {
        return null
      }
    })()
    return aggregationPromise
  }

  function fetchContentIndex(basePath) {
    if (contentIndexPromise) return contentIndexPromise
    contentIndexPromise = (async function () {
      try {
        var resp = await fetch(withBase(basePath, "/static/contentIndex.json"))
        if (!resp.ok) return null
        return await resp.json()
      } catch (e) {
        return null
      }
    })()
    return contentIndexPromise
  }

  // ---- 反链提取 ----

  function fromLocalGraph(graph, currentSlug) {
    if (!graph || !graph.edges || !graph.nodes) return null
    var out = []
    for (var i = 0; i < graph.edges.length; i++) {
      var edge = graph.edges[i]
      if (!edge || edge.target !== currentSlug) continue
      var node = graph.nodes[edge.source]
      if (!node) continue
      out.push({
        slug: node.slug || edge.source,
        title: node.title || node.slug || edge.source,
        frontmatter: node.frontmatter || {},
      })
    }
    return out
  }

  function fromContentIndex(index, currentSlug) {
    if (!index || typeof index !== "object") return null
    var out = []
    for (var key in index) {
      var item = index[key]
      if (!item || !item.links || item.links.indexOf(currentSlug) === -1) continue
      var slug = item.slug ? String(item.slug).replace(/^\\/+|\\/+$/g, "") : key.replace(/^\\/+|\\/+$/g, "")
      out.push({ slug: slug, title: item.title || slug, frontmatter: item.frontmatter || {} })
    }
    return out
  }

  // ---- 分组（读 aggregation.json 产物；不重算继承，与 graph/explorer 语义一致） ----

  function contextOf(slug, depth) {
    var parts = slug.split("/")
    if (parts.length <= 1) return "/"
    return parts.slice(0, -1).slice(0, depth).join("/") || "/"
  }

  function keyFor(item, rule) {
    if (rule.type === "folder") {
      if (isFolderIndexSlug(item.slug)) return null
      return contextOf(item.slug, rule.depth || 1)
    }
    if (rule.type !== "field") return null
    var raw = firstValue(item.frontmatter ? item.frontmatter[rule.field || ""] : undefined)
    if (raw === undefined || raw === null) return null
    return stripWikilink(String(raw))
  }

  // 在 node 上应用一条规则链；分不出有意义的组时把 items 留在本层
  function applyChain(node, items, rules, artifact) {
    if (!rules || rules.length === 0) {
      node.items = items
      return
    }
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i]
      var keys = items.map(function (it) { return keyFor(it, rule) })
      var hasValid = keys.some(function (k) { return k !== null })
      if (!hasValid) continue
      var buckets = new Map()
      var leftover = []
      items.forEach(function (it, idx) {
        var k = keys[idx]
        if (k === null) {
          if (rule.type === "folder") { leftover.push(it); return }
          k = UNCLASSIFIED
        }
        if (!buckets.has(k)) buckets.set(k, [])
        buckets.get(k).push(it)
      })
      if (rule.type === "folder" && buckets.size <= 1) continue
      var anyLarge = false
      buckets.forEach(function (members) { if (members.length >= artifact.minGroupSize) anyLarge = true })
      if (!anyLarge) continue
      buckets.forEach(function (members, key) {
        var child = { key: key, rule: rule, items: [], children: [] }
        applyChain(child, members, rules.slice(i + 1), artifact)
        node.children.push(child)
      })
      node.items = leftover
      sortChildren(node)
      return
    }
    node.items = items
  }

  function sortChildren(node) {
    node.children.sort(function (a, b) {
      if (a.key === UNCLASSIFIED) return 1
      if (b.key === UNCLASSIFIED) return -1
      return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" })
    })
  }

  function buildTree(items, artifact) {
    var root = { key: "/", rule: null, items: [], children: [] }
    if (!artifact) {
      root.items = items
      return root
    }
    var contexts = new Map()
    items.forEach(function (it) {
      var c = contextOf(it.slug, artifact.root.depth || 1)
      if (!contexts.has(c)) contexts.set(c, [])
      contexts.get(c).push(it)
    })
    if (contexts.size === 1) {
      // 反链集中在单一目录：不再多加一层文件夹组，直接应用该目录的链
      var only = contexts.keys().next().value
      applyChain(root, items, artifact.resolved[only] || [], artifact)
      return root
    }
    contexts.forEach(function (members, ctx) {
      var chain = artifact.resolved[ctx]
      if (chain && members.length >= artifact.minGroupSize) {
        var child = { key: ctx, rule: artifact.root, items: [], children: [] }
        applyChain(child, members, chain, artifact)
        root.children.push(child)
      } else {
        for (var i = 0; i < members.length; i++) root.items.push(members[i])
      }
    })
    sortChildren(root)
    return root
  }

  // ---- 渲染（分组树，组可折叠；结构与 v4 相同） ----

  function getTotal(node) {
    var total = node.items.length
    for (var i = 0; i < node.children.length; i++) total += getTotal(node.children[i])
    return total
  }

  function renderTree(container, node, currentSlug, level) {
    var paddingLeft = (0.35 + level * 0.5) + "rem"

    for (var i = 0; i < node.items.length; i++) {
      var item = node.items[i]
      var li = document.createElement("li")
      li.className = level === 0 ? "backlink-root-item" : "backlink-child-item"
      li.innerHTML = '<a href="' + resolveRelativeHref(currentSlug, item.slug) + '" class="internal">' + escapeHtml(item.title) + "</a>"
      container.appendChild(li)
    }

    for (var j = 0; j < node.children.length; j++) {
      var child = node.children[j]
      var totalCount = getTotal(child)
      var segKey = child.rule && child.rule.type === "field" && child.rule.field
        ? child.rule.field + ": " + child.key
        : child.key

      var gli = document.createElement("li")
      gli.className = "backlink-group" + (level > 0 ? " nested" : "")
      gli.innerHTML =
        '<button type="button" class="group-header" style="padding-left: ' + paddingLeft + '">' +
          '<span class="group-arrow"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span>' +
          '<span class="group-title">' + escapeHtml(segKey) + "</span>" +
          '<span class="group-count">(' + totalCount + ")</span>" +
        "</button>" +
        '<div class="group-content"><ul class="group-list"></ul></div>'
      container.appendChild(gli)
      renderTree(gli.querySelector(".group-list"), child, currentSlug, level + 1)
    }
  }

  // 折叠交互（事件委托，一份绑定覆盖 SPA 导航后的新 DOM）
  document.addEventListener("click", function (e) {
    var header = e.target && e.target.closest ? e.target.closest(".backlinks-list .group-header") : null
    if (!header) return
    header.classList.toggle("open")
    var content = header.nextElementSibling
    if (content && content.classList && content.classList.contains("group-content")) {
      content.classList.toggle("open")
    }
  })

  async function initRuntimeBacklinks() {
    var list = document.querySelector(".backlinks-list[data-current-slug]")
    if (!list || list.dataset.enhanced === "true") return

    var currentSlug = list.dataset.currentSlug
    var basePath = list.dataset.basepath || ""
    var hideWhenEmpty = list.dataset.hideEmpty !== "false"
    var sortFn = null
    try {
      sortFn = list.dataset.sortFn ? new Function("return " + list.dataset.sortFn)() : null
    } catch (e) {
      sortFn = null
    }

    try {
      var graph = await fetchLocalGraph(currentSlug, basePath)
      var backlinks = fromLocalGraph(graph, currentSlug)
      if (backlinks === null) {
        var index = await fetchContentIndex(basePath)
        backlinks = fromContentIndex(index, currentSlug) || []
      }

      // 去重（同一页面可能经多条边引用）并排除自身
      var seen = new Set()
      backlinks = backlinks.filter(function (it) {
        if (!it.slug || it.slug === currentSlug || seen.has(it.slug)) return false
        seen.add(it.slug)
        return true
      })

      var container = list.closest(".backlinks")
      if (backlinks.length === 0) {
        if (hideWhenEmpty) {
          if (container) container.style.display = "none"
        } else {
          list.innerHTML = '<li class="backlinks-empty">\\u6682\\u65e0\\u53cd\\u5411\\u94fe\\u63a5</li>'
        }
        list.dataset.enhanced = "true"
        return
      }
      if (container) container.style.display = ""

      if (sortFn) backlinks.sort(sortFn)

      var artifact = await fetchAggregation(basePath)
      var root = buildTree(backlinks, artifact)
      list.innerHTML = ""
      renderTree(list, root, currentSlug, 0)
      list.dataset.enhanced = "true"
    } catch (err) {
      // 增强失败：保留构建期静态列表，不破坏页面
      console.error("[Backlinks] runtime enhancement failed:", err)
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(initRuntimeBacklinks, 100) })
  } else {
    setTimeout(initRuntimeBacklinks, 100)
  }
  // SPA 导航：与 graph-pro 一致监听 nav 事件
  document.addEventListener("nav", function () { setTimeout(initRuntimeBacklinks, 100) })
})()
`;

export default ((opts?: Partial<BacklinksOptions>) => {
  const options: BacklinksOptions = { ...defaultOptions, ...opts };
  const sortFnCode = options.sort ? generateBacklinksSortFnCode(options.sort) : "";

  const Backlinks: QuartzComponent = ({
    fileData,
    allFiles,
    displayClass,
    cfg,
  }: QuartzComponentProps & { displayClass?: string }) => {
    const slug = simplifySlug(fileData.slug as string);
    const locale = cfg.locale ?? "en-US";
    const backlinkFiles = selectBacklinkSources(allFiles as BacklinkCandidate[], slug);
    if (options.hideWhenEmpty && backlinkFiles.length === 0) {
      return null;
    }

    // 从 cfg.baseUrl 获取 basePath（多域前缀剥离，与 graph-pro 一致）
    const getBasePath = (baseUrl: string | undefined): string => {
      if (!baseUrl) return "";
      if (baseUrl.includes("://")) {
        try {
          const url = new URL(baseUrl);
          return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "");
        } catch {
          return "";
        }
      }
      if (baseUrl.includes("/")) {
        try {
          const url = new URL(`https://${baseUrl}`);
          return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "");
        } catch {
          // fall through
        }
      }
      return baseUrl.replace(/^\//, "").replace(/\/$/, "");
    };
    const basePath = getBasePath(cfg.baseUrl);

    return (
      <div class={classNames(displayClass, "backlinks")}>
        <h3>{i18n(locale).components.backlinks.title}</h3>
        <ul
          class="backlinks-list"
          data-current-slug={slug}
          data-basepath={basePath}
          data-hide-empty={options.hideWhenEmpty ? "true" : "false"}
          data-sort-fn={sortFnCode}
        >
          {backlinkFiles.length > 0 ? (
            backlinkFiles.map((f) => (
              <li>
                <a href={resolveRelative(fileData.slug as string, f.slug!)} class="internal">
                  {f.frontmatter?.title}
                </a>
              </li>
            ))
          ) : (
            <li>{i18n(locale).components.backlinks.noBacklinksFound}</li>
          )}
        </ul>
      </div>
    );
  };

  Backlinks.css = style;
  Backlinks.afterDOMLoaded = runtimeScript;

  return Backlinks;
}) satisfies QuartzComponentConstructor;
