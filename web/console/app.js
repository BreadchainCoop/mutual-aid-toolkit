/* BAM micro-framework — the shell every view depends on.
 * Provides window.BAM: registerView, h, clear, toast, navigate, fmtDate,
 * fmtDateTime, start (hash router + nav builder).
 *
 * Namespace init is idempotent so this file and api.js may load in any order. */

(function () {
  "use strict";

  const BAM = (window.BAM = window.BAM || {});

  // Language vocabulary — the production base's Languages options verbatim
  // (server source of truth: GET /catalog). Intake writes and outreach
  // filters MUST share this list; exact-string intersection is how the
  // backend matches languages (spec 6.2 step 1).
  BAM.LANGUAGES = [
    "Inglés / English / 英文",
    "Español / Spanish / 西班牙语",
    "Chino Mandarín / Mandarin / 普通话",
    "Chino Cantonés / Cantonese / 广东话",
    "Chino Toishanés / Toishanese / 台山话",
    "Quechua el dialecto / Quechua Dialect / 克丘亞語",
    "Portugués / Portuguese / 葡萄牙語",
    "Criollo Haitiano / Haitian Creole / 法屬歸融語",
    "Tagalo/ Tagalog/ 他加禄语",
    "Árabe / Arabic / 阿拉伯語",
    "Francés / French / 法語",
    "Otro / Other / 其他語言",
  ];

  // View registry, in registration order (drives the nav).
  const views = new Map();

  /**
   * Register a view. Called by each view file at load time.
   * @param {string} name  route key (also the location.hash)
   * @param {{title:string, icon?:string, render:(container:HTMLElement, params:object)=>void}} def
   */
  BAM.registerView = function registerView(name, def) {
    views.set(name, Object.assign({ name }, def));
  };

  BAM.getViews = function getViews() {
    return Array.from(views.values());
  };

  /* DOM helper ------------------------------------------------------------ */

  const BOOLEAN_ATTRS = new Set([
    "disabled",
    "checked",
    "readonly",
    "required",
    "selected",
    "hidden",
    "autofocus",
  ]);

  function appendChild(el, child) {
    if (child === null || child === undefined || child === false || child === true) {
      return;
    }
    if (Array.isArray(child)) {
      child.forEach((c) => appendChild(el, c));
      return;
    }
    if (child instanceof Node) {
      el.appendChild(child);
      return;
    }
    el.appendChild(document.createTextNode(String(child)));
  }

  /**
   * Create an element. h("button", {class:"btn", onclick}, "Go")
   * attrs: class, id, event handlers (on*), dataset via data-*, style object,
   * boolean attrs (disabled...), everything else as an attribute.
   */
  BAM.h = function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class" || key === "className") {
          el.className = value;
        } else if (key === "style" && typeof value === "object") {
          Object.assign(el.style, value);
        } else if (key === "dataset" && typeof value === "object") {
          Object.assign(el.dataset, value);
        } else if (key === "html") {
          el.innerHTML = value; // trusted, view-controlled content only
        } else if (key.startsWith("on") && typeof value === "function") {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (BOOLEAN_ATTRS.has(key)) {
          if (value) el.setAttribute(key, "");
        } else {
          el.setAttribute(key, value);
        }
      }
    }
    children.forEach((c) => appendChild(el, c));
    return el;
  };

  /** Remove all children of an element. */
  BAM.clear = function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  };

  /* Toasts ---------------------------------------------------------------- */

  function toastHost() {
    let host = document.getElementById("toast-host");
    if (!host) {
      host = BAM.h("div", { id: "toast-host", class: "toast-host", "aria-live": "polite" });
      document.body.appendChild(host);
    }
    return host;
  }

  /** Transient notification. kind: "info" | "success" | "error". */
  BAM.toast = function toast(message, kind) {
    const k = kind || "info";
    const el = BAM.h("div", { class: `toast toast--${k}`, role: "status" }, message);
    toastHost().appendChild(el);
    const ttl = k === "error" ? 5000 : 3000;
    setTimeout(() => {
      el.style.transition = "opacity 0.2s ease";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 200);
    }, ttl);
  };

  /* Date formatting ------------------------------------------------------- */

  // Parse "YYYY-MM-DD" as a local date (avoid UTC-midnight off-by-one), or
  // any ISO datetime as-is.
  function toDate(iso) {
    if (!iso) return null;
    if (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [y, m, d] = iso.split("-").map(Number);
      return new Date(y, m - 1, d);
    }
    const dt = new Date(iso);
    return isNaN(dt.getTime()) ? null : dt;
  }

  /** Human date, e.g. "Jul 6, 2026". Empty string for null. */
  BAM.fmtDate = function fmtDate(iso) {
    const dt = toDate(iso);
    if (!dt) return "";
    return dt.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  /** Human date + time, e.g. "Jul 6, 2026, 3:15 PM". Empty string for null. */
  BAM.fmtDateTime = function fmtDateTime(iso) {
    const dt = toDate(iso);
    if (!dt) return "";
    return dt.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  /* Routing --------------------------------------------------------------- */

  const DEFAULT_VIEW = "checkin";

  function mainEl() {
    return document.getElementById("app-main");
  }

  function navEl() {
    return document.getElementById("app-nav");
  }

  // Parse "#checkin?phone=123" -> { name, params }.
  function parseHash() {
    const raw = (location.hash || "").replace(/^#/, "");
    const [name, query] = raw.split("?");
    const params = {};
    if (query) {
      for (const [k, v] of new URLSearchParams(query).entries()) params[k] = v;
    }
    return { name: name || "", params };
  }

  /** Switch to a view by name (updates the hash, triggers a render). */
  BAM.navigate = function navigate(name, params) {
    let hash = `#${name}`;
    if (params && Object.keys(params).length) {
      hash += `?${new URLSearchParams(params).toString()}`;
    }
    if (location.hash === hash) {
      renderCurrent(); // same hash: hashchange won't fire, render manually
    } else {
      location.hash = hash;
    }
  };

  function setActiveNav(name) {
    const nav = navEl();
    if (!nav) return;
    nav.querySelectorAll(".nav__item").forEach((item) => {
      if (item.dataset.view === name) {
        item.setAttribute("aria-current", "page");
      } else {
        item.removeAttribute("aria-current");
      }
    });
  }

  function setBarView(title) {
    const label = document.getElementById("app-bar-view");
    if (label) label.textContent = title || "";
  }

  function renderCurrent() {
    const main = mainEl();
    if (!main) return;
    let { name, params } = parseHash();
    let view = views.get(name);
    if (view && !isEnabled(view.name)) view = null; // feature-disabled
    if (!view) {
      view =
        (isEnabled(DEFAULT_VIEW) && views.get(DEFAULT_VIEW)) ||
        enabledViews()[0] ||
        BAM.getViews()[0];
      name = view ? view.name : "";
    }
    setActiveNav(name);
    setBarView(view ? view.title : "");

    BAM.clear(main);
    if (!view) {
      main.appendChild(BAM.h("div", { class: "empty-state" }, "No views registered."));
      return;
    }
    main.setAttribute("aria-busy", "false");
    try {
      view.render(main, params || {});
    } catch (err) {
      // A view crash must not blank the whole console.
      console.error(`View "${name}" failed to render:`, err);
      BAM.clear(main);
      main.appendChild(
        BAM.h(
          "div",
          { class: "empty-state" },
          BAM.h("div", { class: "empty-state__icon" }, "⚠️"),
          "Something went wrong rendering this view."
        )
      );
      BAM.toast("This view failed to load.", "error");
    }
  }

  /* White-label config -------------------------------------------------- */

  // The resolved instance config (GET /config) and its feature map. Views
  // whose feature flag is false are hidden from the nav.
  BAM.config = null;
  BAM.features = null;

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }
  // Mix a hex color toward white by `ratio` (0..1) — used for the soft tints.
  function towardWhite(hex, ratio) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * ratio));
    return `rgb(${r}, ${g}, ${b})`;
  }

  function applyLogo(logo, shortName) {
    const el = document.querySelector(".app-bar__logo");
    if (!el || !logo || logo === "loaf" || logo === "hands") return; // keep the default mark
    if (logo === "none") {
      el.innerHTML = "";
      el.style.display = "none";
      return;
    }
    if (logo === "initials") {
      el.innerHTML = "";
      el.textContent = (shortName || "•").slice(0, 3).toUpperCase();
      el.style.fontWeight = "800";
      el.style.color = "var(--brand)";
      el.style.fontSize = "13px";
      return;
    }
    el.innerHTML = logo; // trusted inline SVG supplied by the instance config
  }

  /**
   * Short display name for a language label. Catalog languages are compound
   * "Español / Spanish / 西班牙语" strings; show the English middle segment
   * ("Spanish") on chips while the full label stays the stored value.
   */
  BAM.langShort = function langShort(label) {
    const parts = String(label || "")
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts[1] || parts[0] || String(label || "");
  };

  /**
   * Compact chip-toggle multiselect for languages (replaces long checkbox
   * lists). Returns { el, getSelected(), setSelected(arr), reset() }.
   * getSelected() yields the FULL labels, so the data contract is unchanged.
   * opts: { languages?, selected?, onChange?, search?, allowCustom? }
   */
  BAM.langPicker = function langPicker(opts) {
    opts = opts || {};
    const h = BAM.h,
      clear = BAM.clear;
    const base = (opts.languages || window.BAM.LANGUAGES || []).slice();
    const customs = [];
    const selected = new Set(opts.selected || []);
    const onChange = opts.onChange || function () {};

    const grid = h("div", { class: "langpicker__grid" });
    const search = h("input", {
      class: "input",
      type: "search",
      placeholder: "Search languages…",
      "aria-label": "Search languages",
      oninput: render,
    });
    const addInput = h("input", {
      class: "input",
      type: "text",
      autocomplete: "off",
      placeholder: "Add another language",
      "aria-label": "Add another language",
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addCustom();
        }
      },
    });
    const addBtn = h("button", { class: "btn", type: "button", onclick: addCustom }, "Add");

    function all() {
      return base.concat(customs);
    }
    function addCustom() {
      const v = addInput.value.trim();
      if (!v) return;
      let match = all().find((l) => l.toLowerCase() === v.toLowerCase());
      if (!match) {
        customs.push(v);
        match = v;
      }
      selected.add(match);
      addInput.value = "";
      render();
      onChange(getSelected());
    }
    function toggle(label) {
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
      render();
      onChange(getSelected());
    }
    function chip(label) {
      const on = selected.has(label);
      return h(
        "button",
        {
          type: "button",
          class: "langchip" + (on ? " langchip--on" : ""),
          title: label,
          "aria-pressed": String(on),
          onclick: () => toggle(label),
        },
        on ? h("span", { class: "langchip__check", "aria-hidden": "true" }, "✓") : null,
        BAM.langShort(label)
      );
    }
    function render() {
      clear(grid);
      const q = (search.value || "").trim().toLowerCase();
      const shown = all().filter(
        (l) => !q || BAM.langShort(l).toLowerCase().indexOf(q) >= 0 || l.toLowerCase().indexOf(q) >= 0
      );
      if (!shown.length) grid.append(h("div", { class: "langpicker__empty" }, "No match — add it below."));
      else shown.forEach((l) => grid.append(chip(l)));
    }
    function getSelected() {
      return all().filter((l) => selected.has(l));
    }

    render();
    const el = h(
      "div",
      { class: "langpicker" },
      opts.search === false ? null : search,
      grid,
      opts.allowCustom === false
        ? null
        : h("div", { class: "row" }, h("div", { class: "grow" }, addInput), addBtn)
    );
    return {
      el,
      getSelected,
      setSelected(arr) {
        selected.clear();
        (arr || []).forEach((x) => selected.add(x));
        render();
      },
      reset() {
        selected.clear();
        customs.length = 0;
        if (search) search.value = "";
        render();
      },
    };
  };

  /** Theme the console from an instance config (GET /config). */
  BAM.applyConfig = function applyConfig(config) {
    BAM.config = config || {};
    const branding = BAM.config.branding || {};
    const org = BAM.config.org || {};
    BAM.features = BAM.config.features || null;

    const root = document.documentElement;
    if (branding.primary_color) {
      root.style.setProperty("--brand", branding.primary_color);
      root.style.setProperty("--brand-soft", towardWhite(branding.primary_color, 0.86));
      const rgb = hexToRgb(branding.primary_color);
      if (rgb) root.style.setProperty("--focus", `0 0 0 3px rgba(${rgb.join(",")}, 0.35)`);
    }
    if (branding.accent_color) {
      root.style.setProperty("--accent", branding.accent_color);
      root.style.setProperty("--accent-soft", towardWhite(branding.accent_color, 0.7));
    }
    if (branding.theme_color) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", branding.theme_color);
    }
    const title = branding.title || org.name;
    if (title) {
      document.title = title;
      const barTitle = document.querySelector(".app-bar__title");
      if (barTitle) barTitle.textContent = title;
    }
    applyLogo(branding.logo, org.short_name);
    const langs = BAM.config.catalog && BAM.config.catalog.languages;
    if (Array.isArray(langs) && langs.length) BAM.LANGUAGES = langs.slice();
  };

  function isEnabled(name) {
    return !BAM.features || BAM.features[name] !== false;
  }

  function enabledViews() {
    return BAM.getViews().filter((v) => isEnabled(v.name));
  }

  async function loadConfig() {
    try {
      if (window.BAM.api && typeof window.BAM.api.config === "function") {
        return await window.BAM.api.config();
      }
      const res = await fetch("/config", { headers: { Accept: "application/json" } });
      if (res.ok) return await res.json();
    } catch (err) {
      console.warn("Instance config load failed; using defaults.", err);
    }
    return null;
  }

  function buildNav() {
    const nav = navEl();
    if (!nav) return;
    BAM.clear(nav);
    enabledViews().forEach((view) => {
      const item = BAM.h(
        "a",
        {
          class: "nav__item",
          href: `#${view.name}`,
          dataset: { view: view.name },
          "aria-label": view.title,
        },
        BAM.h("span", { class: "nav__icon", "aria-hidden": "true" }, view.icon || "•"),
        BAM.h("span", { class: "nav__label" }, view.title)
      );
      nav.appendChild(item);
    });
  }

  /** Boot: theme from the instance config, build the nav, then render. */
  BAM.start = async function start() {
    BAM.applyConfig(await loadConfig());
    buildNav();
    window.addEventListener("hashchange", renderCurrent);
    renderCurrent();
  };

  /**
   * Re-read the instance config, re-theme, and rebuild the nav + current view.
   * The Settings view calls this after an admin edits org config in the CRDT
   * doc, so branding and feature toggles take effect without a reload.
   */
  BAM.refreshChrome = async function refreshChrome() {
    BAM.applyConfig(await loadConfig());
    buildNav();
    renderCurrent();
  };
})();
