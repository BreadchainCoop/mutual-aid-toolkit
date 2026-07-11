/* Data view — the Airtable-style spreadsheet grid.
 *
 * The guided views are for doing the work; this one is for SEEING the data:
 * dense rows, sticky column headers, sortable columns, status filters, and a
 * CSV export — one grid per table (Households / Requests / Social services),
 * like the production base's Data tab. Rows deep-link into check-in. */

(function () {
  "use strict";

  const { h, clear, toast, api, navigate, fmtDate } = window.BAM;

  const PAGE_SIZE = 50;

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

  /* Table definitions: columns + fetcher per table. Each column:
   * { key, label, get(row) -> text/node, csv(row) -> string, sort(row) -> comparable } */
  const TABLES = {
    households: {
      label: "Households",
      statuses: null,
      fetch: (params) => api.browseHouseholds(params),
      searchable: true,
      columns: [
        { key: "name", label: "Name", get: (r) => r.name || "—", sort: (r) => (r.name || "").toLowerCase() },
        { key: "phone", label: "Phone", mono: true, get: (r) => r.phone_number || "—", sort: (r) => r.phone_number || "" },
        {
          key: "languages",
          label: "Languages",
          get: (r) => (r.languages || []).map(short).join(", ") || "—",
          sort: (r) => (r.languages || []).map(short).join(","),
        },
        {
          key: "appt",
          label: "Appointment",
          get: (r) =>
            r.appointment_date
              ? `${fmtDate(r.appointment_date)}${r.appointment_time ? " " + r.appointment_time : ""}${r.appointment_status ? " · " + r.appointment_status : ""}`
              : "—",
          sort: (r) => r.appointment_date || "",
        },
        {
          key: "open",
          label: "Open reqs",
          num: true,
          get: (r) => String(r.open_request_count ?? 0),
          sort: (r) => r.open_request_count ?? 0,
        },
      ],
      rowId: (r) => r.id,
    },
    requests: {
      label: "Requests",
      statuses: ["Open", "Delivered", "Timeout"],
      fetch: (params) => api.browseRequests(params),
      columns: [
        { key: "label", label: "Item", get: (r) => short(r.label || r.type), sort: (r) => short(r.label || r.type).toLowerCase() },
        { key: "status", label: "Status", get: (r) => statusBadge(r.status), csv: (r) => r.status, sort: (r) => r.status },
        { key: "opened", label: "Opened", get: (r) => fmtDate(r.request_opened_at), csv: (r) => r.request_opened_at || "", sort: (r) => r.request_opened_at || "" },
        { key: "household", label: "Household", get: (r) => r.household_name || "—", sort: (r) => (r.household_name || "").toLowerCase() },
        { key: "phone", label: "Phone", mono: true, get: (r) => r.household_phone || "—", sort: (r) => r.household_phone || "" },
        { key: "address", label: "Address", get: (r) => r.address || "—", sort: (r) => r.address || "" },
        { key: "notes", label: "Notes", wide: true, get: (r) => r.notes || "", sort: (r) => r.notes || "" },
      ],
      rowId: (r) => r.household_id,
    },
    services: {
      label: "Social services",
      statuses: ["Open", "Delivered", "Timeout"],
      fetch: (params) => api.browseServices(params),
      columns: [
        { key: "label", label: "Service", get: (r) => short(r.label || r.type), sort: (r) => short(r.label || r.type).toLowerCase() },
        { key: "status", label: "Status", get: (r) => statusBadge(r.status), csv: (r) => r.status, sort: (r) => r.status },
        { key: "partner", label: "Partner org", get: (r) => r.partner_org || "—", sort: (r) => r.partner_org || "" },
        { key: "mesh", label: "Mesh status", get: (r) => r.mesh_status || "—", sort: (r) => r.mesh_status || "" },
        { key: "opened", label: "Opened", get: (r) => fmtDate(r.request_opened_at), csv: (r) => r.request_opened_at || "", sort: (r) => r.request_opened_at || "" },
        { key: "household", label: "Household", get: (r) => r.household_name || "—", sort: (r) => (r.household_name || "").toLowerCase() },
        { key: "phone", label: "Phone", mono: true, get: (r) => r.household_phone || "—", sort: (r) => r.household_phone || "" },
        { key: "notes", label: "Notes", wide: true, get: (r) => r.notes || "", sort: (r) => r.notes || "" },
      ],
      rowId: (r) => r.household_id,
    },
  };

  function render(container) {
    const state = {
      table: "households",
      status: "Open", // requests/services default filter
      query: "",
      offset: 0,
      total: 0,
      items: [],
      sortKey: null,
      sortDir: 1,
      loading: false,
    };

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Data"),
      h("p", { class: "muted" }, "The raw tables, spreadsheet-style — sort, filter, export.")
    );

    const pickerRow = h("div", { class: "row", style: { flexWrap: "wrap" } });
    const controlsRow = h("div", { class: "row", style: { flexWrap: "wrap", gap: "var(--s2)" } });
    const gridRegion = h("div", {});
    const pagerRow = h("div", { class: "row row--between", style: { alignItems: "center" } });

    clear(container);
    container.append(
      heading,
      h("div", { class: "card stack" }, pickerRow, controlsRow),
      gridRegion,
      pagerRow
    );

    renderPicker();
    renderControls();
    load();

    function def() {
      return TABLES[state.table];
    }

    // ---- data ---------------------------------------------------------------

    function buildParams(offset, limit) {
      const params = { limit, offset };
      if (def().statuses && state.status !== "All") params.status = state.status;
      if (def().searchable && state.query.trim()) params.query = state.query.trim();
      return params;
    }

    async function load() {
      if (state.loading) return;
      state.loading = true;
      clear(gridRegion).append(
        h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading…")
      );
      try {
        const page = await def().fetch(buildParams(state.offset, PAGE_SIZE));
        state.items = page.items || [];
        state.total = page.total || 0;
        renderGrid();
        renderPager();
      } catch (err) {
        clear(gridRegion).append(
          h("div", { class: "card empty-state" }, (err && err.detail) || "Could not load the table.")
        );
      } finally {
        state.loading = false;
      }
    }

    // ---- chrome -------------------------------------------------------------

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
                state.offset = 0;
                state.sortKey = null;
                renderPicker();
                renderControls();
                load();
              },
            },
            (on ? "✓ " : "") + t.label
          )
        );
      });
    }

    function renderControls() {
      clear(controlsRow);
      if (def().statuses) {
        const sel = h(
          "select",
          {
            class: "input",
            style: { maxWidth: "160px" },
            "aria-label": "Status filter",
            onchange: (e) => {
              state.status = e.target.value;
              state.offset = 0;
              load();
            },
          },
          def().statuses.concat("All").map((s) => h("option", { value: s, selected: s === state.status }, s))
        );
        controlsRow.append(sel);
      }
      if (def().searchable) {
        const search = h("input", {
          class: "input",
          type: "search",
          placeholder: "Search name or phone…",
          value: state.query,
          style: { maxWidth: "260px" },
          "aria-label": "Search",
          onkeydown: (e) => {
            if (e.key === "Enter") {
              state.query = e.target.value;
              state.offset = 0;
              load();
            }
          },
        });
        controlsRow.append(search);
      }
      controlsRow.append(
        h(
          "button",
          { class: "btn btn-ghost", type: "button", onclick: exportCsv },
          "⬇︎ Export CSV"
        )
      );
    }

    // ---- grid ---------------------------------------------------------------

    function sortedItems() {
      if (!state.sortKey) return state.items;
      const col = def().columns.find((c) => c.key === state.sortKey);
      if (!col) return state.items;
      return [...state.items].sort((a, b) => {
        const va = col.sort(a);
        const vb = col.sort(b);
        if (va < vb) return -state.sortDir;
        if (va > vb) return state.sortDir;
        return 0;
      });
    }

    function renderGrid() {
      clear(gridRegion);
      if (!state.items.length) {
        gridRegion.append(
          h(
            "div",
            { class: "card empty-state" },
            h("div", { class: "empty-state__icon" }, "🗒️"),
            h("div", {}, "No rows match."),
            h("p", { class: "muted" }, "Try another status filter, or load sample data from Admin.")
          )
        );
        return;
      }
      const cols = def().columns;
      const headCells = cols.map((c) =>
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
            state.sortKey === c.key ? (state.sortDir === 1 ? " ↑" : " ↓") : ""
          )
        )
      );
      const bodyRows = sortedItems().map((r) => {
        const id = def().rowId(r);
        return h(
          "tr",
          {
            class: id ? "grid__row--link" : null,
            title: id ? "Open in check-in" : null,
            onclick: id ? () => navigate("checkin", { id }) : null,
          },
          cols.map((c) =>
            h(
              "td",
              { class: [c.mono ? "mono" : "", c.num ? "grid__num" : "", c.wide ? "grid__wide" : ""].join(" ").trim() || null },
              c.get(r)
            )
          )
        );
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
        ),
        h(
          "p",
          { class: "muted", style: { fontSize: "12.5px", margin: "var(--s2) 0 0" } },
          "Sorting applies to this page. Tap a row to open the household in check-in."
        )
      );
    }

    function renderPager() {
      clear(pagerRow);
      const from = state.total === 0 ? 0 : state.offset + 1;
      const to = Math.min(state.offset + PAGE_SIZE, state.total);
      pagerRow.append(
        h("span", { class: "muted" }, `${from}–${to} of ${state.total}`),
        h(
          "span",
          { class: "row" },
          h(
            "button",
            {
              class: "btn btn-ghost",
              type: "button",
              disabled: state.offset === 0,
              onclick: () => {
                state.offset = Math.max(0, state.offset - PAGE_SIZE);
                load();
              },
            },
            "‹ Prev"
          ),
          h(
            "button",
            {
              class: "btn btn-ghost",
              type: "button",
              disabled: state.offset + PAGE_SIZE >= state.total,
              onclick: () => {
                state.offset += PAGE_SIZE;
                load();
              },
            },
            "Next ›"
          )
        )
      );
    }

    // ---- CSV export (all pages of the current filter) -----------------------

    async function exportCsv() {
      const cols = def().columns;
      const esc = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      try {
        toast("Exporting…", "info");
        const rows = [];
        const limit = 200; // endpoint max page size
        for (let offset = 0; offset < 10_000; offset += limit) {
          const page = await def().fetch(buildParams(offset, limit));
          rows.push(...(page.items || []));
          if (offset + limit >= (page.total || 0)) break;
        }
        const lines = [cols.map((c) => esc(c.label)).join(",")];
        for (const r of rows) {
          lines.push(cols.map((c) => esc(c.csv ? c.csv(r) : textOf(c.get(r)))).join(","));
        }
        const blob = new Blob([lines.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${state.table}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast(`Exported ${rows.length} rows.`, "success");
      } catch (err) {
        toast((err && err.detail) || "Export failed.", "error");
      }
    }

    function textOf(v) {
      return v instanceof Node ? v.textContent : String(v ?? "");
    }
  }

  window.BAM.registerView("data", {
    title: "Data",
    icon: "🗂️",
    render,
  });
})();
