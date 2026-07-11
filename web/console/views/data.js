/* Data view — the spreadsheet grid, made to feel like a spreadsheet.
 *
 * Local-first means the whole table is already on this device, so there's no
 * fake pagination: each table loads fully, search filters every column as you
 * type, sorting applies to the entire table, and status chips show live
 * counts. Tap a row to expand the full record in place (nothing truncated),
 * with a button through to check-in. CSV export = exactly what you see. */

(function () {
  "use strict";

  const { h, clear, toast, api, navigate, fmtDate } = window.BAM;

  const RENDER_CHUNK = 100; // rows rendered per "Show more" (keeps DOM snappy)
  const FETCH_PAGE = 200; // browse endpoints' max page size

  function short(label) {
    return window.BAM.langShort ? window.BAM.langShort(label) : label;
  }

  function statusBadge(status) {
    const cls =
      status === "Delivered"
        ? "badge-delivered"
        : status === "Timeout"
          ? "badge-timeout"
          : "badge-open";
    return h("span", { class: `badge ${cls}` }, status);
  }

  function itemPill(r) {
    return h("span", { class: "pill" }, short(r.label || r.type));
  }

  /* Table definitions. Columns: { key, label, get(row)→node/text,
   * csv(row)→string (also the search/sort text when present), mono/num/wide }. */
  const TABLES = {
    households: {
      label: "Households",
      hasStatus: false,
      fetchPage: (params) => api.browseHouseholds(params),
      columns: [
        { key: "name", label: "Name", get: (r) => r.name || "—", csv: (r) => r.name || "" },
        { key: "phone", label: "Phone", mono: true, get: (r) => r.phone_number || "—", csv: (r) => r.phone_number || "" },
        {
          key: "languages",
          label: "Languages",
          get: (r) => (r.languages || []).map(short).join(", ") || "—",
          csv: (r) => (r.languages || []).map(short).join(", "),
        },
        {
          key: "appt",
          label: "Appointment",
          get: (r) =>
            r.appointment_date
              ? `${fmtDate(r.appointment_date)}${r.appointment_time ? " " + r.appointment_time : ""}${r.appointment_status ? " · " + r.appointment_status : ""}`
              : "—",
          csv: (r) =>
            r.appointment_date
              ? `${r.appointment_date} ${r.appointment_time || ""} ${r.appointment_status || ""}`.trim()
              : "",
        },
        { key: "open", label: "Open reqs", num: true, get: (r) => String(r.open_request_count ?? 0), csv: (r) => String(r.open_request_count ?? 0) },
      ],
      rowId: (r) => r.id,
    },
    requests: {
      label: "Requests",
      hasStatus: true,
      fetchPage: (params) => api.browseRequests(params),
      columns: [
        { key: "label", label: "Item", get: itemPill, csv: (r) => short(r.label || r.type) },
        { key: "status", label: "Status", get: (r) => statusBadge(r.status), csv: (r) => r.status },
        { key: "opened", label: "Opened", get: (r) => fmtDate(r.request_opened_at), csv: (r) => r.request_opened_at || "" },
        { key: "household", label: "Household", get: (r) => r.household_name || "—", csv: (r) => r.household_name || "" },
        { key: "phone", label: "Phone", mono: true, get: (r) => r.household_phone || "—", csv: (r) => r.household_phone || "" },
        { key: "address", label: "Address", get: (r) => r.address || "—", csv: (r) => r.address || "" },
        { key: "notes", label: "Notes", wide: true, get: (r) => r.notes || "", csv: (r) => r.notes || "" },
      ],
      rowId: (r) => r.household_id,
    },
    furniture: {
      label: "Furniture",
      hasStatus: true,
      fetchPage: (params) => api.browseRequests({ ...params, category: "furniture" }),
      columns: [
        { key: "label", label: "Item", get: itemPill, csv: (r) => short(r.label || r.type) },
        { key: "status", label: "Status", get: (r) => statusBadge(r.status), csv: (r) => r.status },
        { key: "household", label: "Household", get: (r) => r.household_name || "—", csv: (r) => r.household_name || "" },
        { key: "phone", label: "Phone", mono: true, get: (r) => r.household_phone || "—", csv: (r) => r.household_phone || "" },
        { key: "address", label: "Delivery address", get: (r) => r.address || "—", csv: (r) => r.address || "" },
        { key: "bin", label: "BIN", mono: true, get: (r) => r.bin || "—", csv: (r) => r.bin || "" },
        { key: "opened", label: "Opened", get: (r) => fmtDate(r.request_opened_at), csv: (r) => r.request_opened_at || "" },
        { key: "notes", label: "Notes", wide: true, get: (r) => r.notes || "", csv: (r) => r.notes || "" },
      ],
      rowId: (r) => r.household_id,
    },
    services: {
      label: "Social services",
      hasStatus: true,
      fetchPage: (params) => api.browseServices(params),
      columns: [
        { key: "label", label: "Service", get: itemPill, csv: (r) => short(r.label || r.type) },
        { key: "status", label: "Status", get: (r) => statusBadge(r.status), csv: (r) => r.status },
        { key: "partner", label: "Partner org", get: (r) => r.partner_org || "—", csv: (r) => r.partner_org || "" },
        { key: "mesh", label: "Mesh status", get: (r) => r.mesh_status || "—", csv: (r) => r.mesh_status || "" },
        { key: "opened", label: "Opened", get: (r) => fmtDate(r.request_opened_at), csv: (r) => r.request_opened_at || "" },
        { key: "household", label: "Household", get: (r) => r.household_name || "—", csv: (r) => r.household_name || "" },
        { key: "phone", label: "Phone", mono: true, get: (r) => r.household_phone || "—", csv: (r) => r.household_phone || "" },
        { key: "notes", label: "Notes", wide: true, get: (r) => r.notes || "", csv: (r) => r.notes || "" },
      ],
      rowId: (r) => r.household_id,
    },
    fulfilled: {
      label: "Fulfilled counts",
      hasStatus: false,
      fetchPage: null, // fetched in one call below
      fetchAll: async () => {
        const rows = (await api.fulfilled({})) || [];
        rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        return rows;
      },
      columns: [
        { key: "date", label: "Date", get: (r) => fmtDate(r.date), csv: (r) => r.date || "" },
        { key: "label", label: "Item", get: itemPill, csv: (r) => short(r.label || r.type) },
        { key: "count", label: "Delivered", num: true, get: (r) => String(r.count ?? 0), csv: (r) => String(r.count ?? 0) },
      ],
      rowId: () => null,
    },
  };

  function render(container) {
    const state = {
      table: "households",
      allRows: [], // the WHOLE table, fetched once per table switch
      status: "Open",
      query: "",
      sortKey: null,
      sortDir: 1,
      shown: RENDER_CHUNK,
      expandedId: null, // row identity (index in filtered list) currently expanded
      loading: false,
    };

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Data"),
      h(
        "p",
        { class: "muted" },
        "The raw tables. Type to search everything, click a column to sort, tap a row to see the whole record."
      )
    );

    const pickerRow = h("div", { class: "row", style: { flexWrap: "wrap" } });
    const statusRow = h("div", { class: "row", style: { flexWrap: "wrap" } });
    const searchInput = h("input", {
      class: "input",
      type: "search",
      placeholder: "Search anything — name, phone, item, notes…",
      "aria-label": "Search this table",
      oninput: (e) => {
        state.query = e.target.value;
        state.shown = RENDER_CHUNK;
        state.expandedId = null;
        renderStatusChips();
        renderGrid();
      },
    });
    const exportBtn = h(
      "button",
      { class: "btn btn-ghost", type: "button", onclick: exportCsv },
      "⬇︎ Export what I see (CSV)"
    );
    const gridRegion = h("div", {});

    clear(container);
    container.append(
      heading,
      h(
        "div",
        { class: "card stack" },
        pickerRow,
        h("div", { class: "row" }, h("div", { class: "grow" }, searchInput), exportBtn),
        statusRow
      ),
      gridRegion
    );

    renderPicker();
    load();

    function def() {
      return TABLES[state.table];
    }

    /* ---- data: fetch the WHOLE table once ---------------------------------
     * The doc is local — "pagination" was just ceremony. Loop the browse
     * endpoint's pages into memory, then search/sort/filter instantly. */
    async function fetchAll() {
      if (def().fetchAll) return def().fetchAll();
      const rows = [];
      for (let offset = 0; offset < 50_000; offset += FETCH_PAGE) {
        const page = await def().fetchPage({ limit: FETCH_PAGE, offset });
        rows.push(...(page.items || []));
        if (offset + FETCH_PAGE >= (page.total || 0)) break;
      }
      return rows;
    }

    async function load() {
      if (state.loading) return;
      state.loading = true;
      clear(gridRegion).append(
        h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading…")
      );
      try {
        state.allRows = await fetchAll();
        // Pre-compute each row's search haystack once.
        const cols = def().columns;
        for (const r of state.allRows) {
          r.__hay = cols.map((c) => c.csv(r)).join(" ").toLowerCase();
        }
        renderStatusChips();
        renderGrid();
      } catch (err) {
        clear(gridRegion).append(
          h("div", { class: "card empty-state" }, (err && err.detail) || "Could not load the table.")
        );
      } finally {
        state.loading = false;
      }
    }

    /* ---- chrome ------------------------------------------------------------ */

    function renderPicker() {
      clear(pickerRow);
      Object.entries(TABLES).forEach(([key, t]) => {
        const on = state.table === key;
        pickerRow.append(
          h(
            "button",
            {
              type: "button",
              class: on ? "pill pill--on" : "pill",
              "aria-pressed": String(on),
              style: on
                ? { background: "var(--brand)", color: "var(--brand-ink)", borderColor: "var(--brand)" }
                : null,
              onclick: () => {
                state.table = key;
                state.status = "Open";
                state.query = "";
                searchInput.value = "";
                state.sortKey = null;
                state.shown = RENDER_CHUNK;
                state.expandedId = null;
                renderPicker();
                load();
              },
            },
            (on ? "✓ " : "") + t.label
          )
        );
      });
    }

    // Status chips with live counts ("Open 42 · Delivered 7…"), so filtering
    // is one tap and you can see what you'd get before you tap it.
    function renderStatusChips() {
      clear(statusRow);
      if (!def().hasStatus) return;
      const matchesQuery = queryFilter();
      const counts = { Open: 0, Delivered: 0, Timeout: 0 };
      let total = 0;
      for (const r of state.allRows) {
        if (!matchesQuery(r)) continue;
        total += 1;
        if (counts[r.status] != null) counts[r.status] += 1;
      }
      ["Open", "Delivered", "Timeout", "All"].forEach((s) => {
        const on = state.status === s;
        const n = s === "All" ? total : counts[s];
        statusRow.append(
          h(
            "button",
            {
              type: "button",
              class: on ? "pill pill--on" : "pill",
              "aria-pressed": String(on),
              style: on
                ? { background: "var(--brand)", color: "var(--brand-ink)", borderColor: "var(--brand)" }
                : null,
              onclick: () => {
                state.status = s;
                state.shown = RENDER_CHUNK;
                state.expandedId = null;
                renderStatusChips();
                renderGrid();
              },
            },
            `${s} ${n}`
          )
        );
      });
    }

    /* ---- filtering + sorting ------------------------------------------------ */

    function queryFilter() {
      const q = state.query.trim().toLowerCase();
      if (!q) return () => true;
      const words = q.split(/\s+/);
      return (r) => words.every((w) => r.__hay.includes(w));
    }

    function visibleRows() {
      const matchesQuery = queryFilter();
      let rows = state.allRows.filter(
        (r) => matchesQuery(r) && (!def().hasStatus || state.status === "All" || r.status === state.status)
      );
      if (state.sortKey) {
        const col = def().columns.find((c) => c.key === state.sortKey);
        if (col) {
          const numeric = !!col.num;
          rows = [...rows].sort((a, b) => {
            const va = numeric ? Number(col.csv(a)) || 0 : col.csv(a).toLowerCase();
            const vb = numeric ? Number(col.csv(b)) || 0 : col.csv(b).toLowerCase();
            if (va < vb) return -state.sortDir;
            if (va > vb) return state.sortDir;
            return 0;
          });
        }
      }
      return rows;
    }

    /* ---- grid --------------------------------------------------------------- */

    function renderGrid() {
      clear(gridRegion);
      const rows = visibleRows();
      const cols = def().columns;

      const summaryBits = [`${rows.length} row${rows.length === 1 ? "" : "s"}`];
      if (state.query.trim()) summaryBits.push(`matching “${state.query.trim()}”`);
      if (state.sortKey) {
        const col = cols.find((c) => c.key === state.sortKey);
        if (col) summaryBits.push(`sorted by ${col.label} ${state.sortDir === 1 ? "A→Z" : "Z→A"}`);
      }
      gridRegion.append(h("p", { class: "muted", style: { margin: "0 0 var(--s2)" } }, summaryBits.join(" · ")));

      if (!rows.length) {
        gridRegion.append(
          h(
            "div",
            { class: "card empty-state" },
            h("div", { class: "empty-state__icon" }, "🗒️"),
            h("div", {}, state.query.trim() ? "Nothing matches that search." : "No rows here."),
            h(
              "p",
              { class: "muted" },
              state.query.trim() ? "Try fewer words, or another status chip." : "Try another status chip, or load sample data from Admin."
            )
          )
        );
        return;
      }

      const headCells = [h("th", { class: "grid__rownum" }, "#")].concat(
        cols.map((c) =>
          h(
            "th",
            {
              class: c.num ? "grid__num" : null,
              "aria-sort":
                state.sortKey === c.key ? (state.sortDir === 1 ? "ascending" : "descending") : "none",
            },
            h(
              "button",
              {
                type: "button",
                class: "grid__sort",
                title: "Sort by " + c.label,
                onclick: () => {
                  if (state.sortKey === c.key) state.sortDir = -state.sortDir;
                  else {
                    state.sortKey = c.key;
                    state.sortDir = 1;
                  }
                  renderGrid();
                },
              },
              c.label,
              h(
                "span",
                { class: "grid__sorticon", "aria-hidden": "true" },
                state.sortKey === c.key ? (state.sortDir === 1 ? " ↑" : " ↓") : " ↕"
              )
            )
          )
        )
      );

      const shownRows = rows.slice(0, state.shown);
      const bodyRows = [];
      shownRows.forEach((r, i) => {
        const expanded = state.expandedId === i;
        bodyRows.push(
          h(
            "tr",
            {
              class: "grid__row--link" + (expanded ? " grid__row--expanded" : ""),
              title: expanded ? "Tap to close" : "Tap to see the whole record",
              onclick: () => {
                state.expandedId = expanded ? null : i;
                renderGrid();
              },
            },
            h("td", { class: "grid__rownum mono" }, expanded ? "▾" : String(i + 1)),
            cols.map((c) =>
              h(
                "td",
                {
                  class:
                    [c.mono ? "mono" : "", c.num ? "grid__num" : "", c.wide ? "grid__wide" : ""]
                      .join(" ")
                      .trim() || null,
                },
                c.get(r)
              )
            )
          )
        );
        if (expanded) {
          const id = def().rowId(r);
          bodyRows.push(
            h(
              "tr",
              { class: "grid__detail" },
              h(
                "td",
                { colspan: String(cols.length + 1) },
                h(
                  "div",
                  { class: "grid__detail-body" },
                  cols.map((c) => {
                    const value = c.csv(r);
                    if (!value) return null;
                    return h(
                      "div",
                      { class: "grid__detail-field" },
                      h("span", { class: "label", style: { margin: "0" } }, c.label),
                      h("span", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, value)
                    );
                  }),
                  id
                    ? h(
                        "button",
                        {
                          class: "btn btn-primary",
                          type: "button",
                          onclick: (e) => {
                            e.stopPropagation();
                            navigate("checkin", { id });
                          },
                        },
                        "Open in check-in →"
                      )
                    : null
                )
              )
            )
          );
        }
      });

      gridRegion.append(
        h(
          "div",
          { class: "grid-wrap card", style: { padding: "0" } },
          h(
            "table",
            { class: "grid" },
            h("thead", {}, h("tr", {}, headCells)),
            h("tbody", {}, bodyRows)
          )
        )
      );

      if (rows.length > state.shown) {
        gridRegion.append(
          h(
            "button",
            {
              class: "btn btn-ghost btn-block",
              type: "button",
              style: { marginTop: "var(--s2)" },
              onclick: () => {
                state.shown += RENDER_CHUNK;
                renderGrid();
              },
            },
            `Show ${Math.min(RENDER_CHUNK, rows.length - state.shown)} more (${rows.length - state.shown} left)`
          )
        );
      }
    }

    /* ---- CSV export: exactly the filtered, sorted rows on screen ----------- */

    function exportCsv() {
      const cols = def().columns;
      const rows = visibleRows();
      const esc = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [cols.map((c) => esc(c.label)).join(",")];
      for (const r of rows) lines.push(cols.map((c) => esc(c.csv(r))).join(","));
      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.table}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Exported ${rows.length} rows — exactly what's on screen.`, "success");
    }
  }

  window.BAM.registerView("data", {
    title: "Data",
    icon: "🗂️",
    render,
  });
})();
