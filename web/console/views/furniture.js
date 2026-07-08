/* Furniture view — parity with the Airtable "Furniture" interface.
 *
 * Goods requests in the furniture category (beds, mattresses, sofas, etc.),
 * which need a delivery address + geocode. GET /requests?category=furniture.
 * Filter by status; each row deep-links into the household's check-in detail.
 *
 * Mirrors views/checkin.js for structure, loading/empty/error handling, and
 * use of BAM.h / BAM.api / the shared component classes. */

(function () {
  "use strict";

  const { h, clear, toast, api, navigate, fmtDate } = window.BAM;
  const PAGE_SIZE = 25;
  const STATUSES = ["Open", "Delivered", "Timeout", "All"];

  function statusBadge(status) {
    const cls =
      status === "Delivered" ? "badge-delivered" : status === "Timeout" ? "badge-timeout" : "badge-open";
    return h("span", { class: `badge ${cls}` }, status);
  }

  function render(container) {
    const state = { status: "Open", offset: 0, page: null, loading: false };

    const statusSelect = h(
      "select",
      {
        class: "input",
        id: "furn-status",
        "aria-label": "Status",
        onchange: (e) => { state.status = e.target.value; state.offset = 0; load(); },
      },
      STATUSES.map((s) => h("option", { value: s, selected: s === state.status }, s))
    );

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Furniture"),
      h("p", { class: "muted" }, "Furniture & bed requests, with delivery address.")
    );

    const controls = h(
      "div",
      { class: "card row row--between" },
      h("div", { class: "field grow" }, h("label", { class: "label", for: "furn-status" }, "Status"), statusSelect),
      h("button", { class: "btn btn-ghost", onclick: () => load() }, "Refresh")
    );

    const result = h("div", { id: "furn-result" });

    clear(container);
    container.append(heading, controls, result);
    load();

    async function load() {
      if (state.loading) return;
      state.loading = true;
      clear(result).append(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading furniture requests…"));
      try {
        state.page = await api.browseRequests({
          category: "furniture",
          status: state.status === "All" ? undefined : state.status,
          limit: PAGE_SIZE,
          offset: state.offset,
        });
        renderResult();
      } catch (err) {
        clear(result).append(h("div", { class: "empty-state" }, "Could not load furniture requests."));
        toast(err.detail || "Failed to load furniture requests.", "error");
      } finally {
        state.loading = false;
      }
    }

    function renderResult() {
      clear(result);
      const page = state.page;
      if (!page || !page.items.length) {
        result.append(h("div", { class: "empty-state" }, h("div", { class: "empty-state__icon" }, "🛋️"), "No furniture requests."));
        return;
      }
      const to = page.offset + page.items.length;
      result.append(h("p", { class: "muted" }, `${page.offset + 1}–${to} of ${page.total}`));
      result.append(h("ul", { class: "list" }, page.items.map((r) => requestRow(r))));
      result.append(pager(page));
    }

    function requestRow(r) {
      const addr = r.address || null;
      const meta = [
        h("span", {}, r.household_name || "(no name)"),
        " · ",
        h("span", { class: "mono" }, r.household_phone || "—"),
      ];
      return h(
        "li",
        { class: "list-item list-item--selectable", onclick: () => navigate("checkin", { id: r.household_id }) },
        h(
          "div",
          { class: "list-item__body" },
          h("div", { class: "list-item__label" }, r.label || r.type),
          h("div", { class: "list-item__meta" }, meta),
          addr ? h("div", { class: "list-item__meta" }, "📍 ", addr, r.address_accuracy ? ` (${r.address_accuracy})` : "") : null,
          h("div", { class: "list-item__meta muted" }, `opened ${fmtDate(r.request_opened_at)}`)
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

  window.BAM.registerView("furniture", { title: "Furniture", icon: "🛋️", render });
})();
