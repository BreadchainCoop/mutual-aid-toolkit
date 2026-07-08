/* Social Services view — parity with the Airtable "English Classes" and
 * "Social Services / MESH requests" interfaces.
 *
 * Social-service requests filtered by type (from the catalog, e.g. English
 * Classes) and status. When the type is the mesh install pipeline
 * (mesh_internet), each row surfaces mesh status / BIN / address accuracy /
 * internet access. Rows deep-link into the household's check-in detail.
 *
 * Mirrors views/checkin.js for structure, loading/empty/error handling, and
 * use of BAM.h / BAM.api / the shared component classes. */

(function () {
  "use strict";

  const { h, clear, toast, api, navigate } = window.BAM;
  const PAGE_SIZE = 25;
  const STATUSES = ["Open", "Delivered", "Timeout", "All"];

  function statusBadge(status) {
    const cls =
      status === "Delivered" ? "badge-delivered" : status === "Timeout" ? "badge-timeout" : "badge-open";
    return h("span", { class: `badge ${cls}` }, status);
  }

  function render(container) {
    const state = { type: "", status: "Open", offset: 0, page: null, loading: false, types: [] };

    const typeSelect = h("select", {
      class: "input",
      id: "svc-type",
      "aria-label": "Type",
      onchange: (e) => { state.type = e.target.value; state.offset = 0; load(); },
    });
    const statusSelect = h(
      "select",
      { class: "input", id: "svc-status", "aria-label": "Status", onchange: (e) => { state.status = e.target.value; state.offset = 0; load(); } },
      STATUSES.map((s) => h("option", { value: s, selected: s === state.status }, s))
    );

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Social Services"),
      h("p", { class: "muted" }, "Social-service & mesh-internet requests by type.")
    );

    const controls = h(
      "div",
      { class: "card row row--between" },
      h("div", { class: "field grow" }, h("label", { class: "label", for: "svc-type" }, "Type"), typeSelect),
      h("div", { class: "field" }, h("label", { class: "label", for: "svc-status" }, "Status"), statusSelect)
    );

    const result = h("div", { id: "svc-result" });

    clear(container);
    container.append(heading, controls, result);
    init();

    async function init() {
      try {
        const cat = await api.catalog();
        state.types = cat.social_services || [];
      } catch (_e) {
        state.types = [];
      }
      clear(typeSelect);
      typeSelect.append(h("option", { value: "" }, "All social services"));
      for (const t of state.types) {
        typeSelect.append(h("option", { value: t.key, selected: t.key === state.type }, t.label));
      }
      load();
    }

    async function load() {
      if (state.loading) return;
      state.loading = true;
      clear(result).append(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading requests…"));
      try {
        state.page = await api.browseServices({
          type: state.type || undefined,
          status: state.status === "All" ? undefined : state.status,
          limit: PAGE_SIZE,
          offset: state.offset,
        });
        renderResult();
      } catch (err) {
        clear(result).append(h("div", { class: "empty-state" }, "Could not load requests."));
        toast(err.detail || "Failed to load requests.", "error");
      } finally {
        state.loading = false;
      }
    }

    function renderResult() {
      clear(result);
      const page = state.page;
      if (!page || !page.items.length) {
        result.append(h("div", { class: "empty-state" }, h("div", { class: "empty-state__icon" }, "🤝"), "No matching requests."));
        return;
      }
      const to = page.offset + page.items.length;
      result.append(h("p", { class: "muted" }, `${page.offset + 1}–${to} of ${page.total}`));
      result.append(h("ul", { class: "list" }, page.items.map((r) => serviceRow(r))));
      result.append(pager(page));
    }

    function serviceRow(r) {
      const meshLine =
        r.type === "mesh_internet"
          ? h(
              "div",
              { class: "list-item__meta" },
              r.mesh_status ? h("span", { class: "pill" }, r.mesh_status) : null,
              r.bin ? ` BIN ${r.bin}` : "",
              r.address_accuracy ? ` · ${r.address_accuracy}` : ""
            )
          : null;
      const internet = (r.internet_access || []).length
        ? h("div", { class: "list-item__meta muted" }, r.internet_access.join(", "))
        : null;
      return h(
        "li",
        { class: "list-item list-item--selectable", onclick: () => navigate("checkin", { id: r.household_id }) },
        h(
          "div",
          { class: "list-item__body" },
          h("div", { class: "list-item__label" }, r.label || r.type),
          h(
            "div",
            { class: "list-item__meta" },
            r.household_name || "(no name)",
            " · ",
            h("span", { class: "mono" }, r.household_phone || "—")
          ),
          meshLine,
          internet
        ),
        statusBadge(r.status)
      );
    }

    function pager(page) {
      const hasPrev = page.offset > 0;
      const hasNext = page.offset + page.items.length < page.total;
      return h(
        "div",
        { class: "row row--between" },
        h("button", { class: "btn btn-ghost", disabled: !hasPrev, onclick: () => { state.offset = Math.max(0, page.offset - PAGE_SIZE); load(); } }, "← Prev"),
        h("button", { class: "btn btn-ghost", disabled: !hasNext, onclick: () => { state.offset = page.offset + PAGE_SIZE; load(); } }, "Next →")
      );
    }
  }

  window.BAM.registerView("services", { title: "Social Services", icon: "🤝", render });
})();
