/* Look up view — parity with the Airtable "EG Check-In / Look up" interface.
 *
 * Browse/search every household (name or phone), paginated, each row
 * deep-linking into the check-in detail (#checkin?id=). Empty search browses
 * all households alphabetically.
 *
 * Mirrors views/checkin.js for structure, loading/empty/error handling, and
 * use of BAM.h / BAM.api / the shared component classes. */

(function () {
  "use strict";

  const { h, clear, toast, api, navigate } = window.BAM;
  const PAGE_SIZE = 25;

  function render(container) {
    const state = { query: "", offset: 0, page: null, loading: false };

    const searchInput = h("input", {
      class: "input",
      type: "search",
      id: "lookup-q",
      placeholder: "Search by name or phone…",
      autocomplete: "off",
      "aria-label": "Search households",
    });

    let debounce;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.query = searchInput.value.trim();
        state.offset = 0;
        load();
      }, 250);
    });

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Look up"),
      h("p", { class: "muted" }, "Find any household by name or phone.")
    );

    const searchCard = h(
      "form",
      { class: "card", onsubmit: (e) => e.preventDefault() },
      h("div", { class: "field" }, h("label", { class: "label", for: "lookup-q" }, "Search"), searchInput)
    );

    const result = h("div", { id: "lookup-result" });

    clear(container);
    container.append(heading, searchCard, result);
    setTimeout(() => searchInput.focus(), 0);
    load();

    async function load() {
      if (state.loading) return;
      state.loading = true;
      clear(result).append(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading households…"));
      try {
        state.page = await api.browseHouseholds({
          query: state.query || undefined,
          limit: PAGE_SIZE,
          offset: state.offset,
        });
        renderResult();
      } catch (err) {
        clear(result).append(h("div", { class: "empty-state" }, "Could not load households."));
        toast(err.detail || "Failed to load households.", "error");
      } finally {
        state.loading = false;
      }
    }

    function renderResult() {
      clear(result);
      const page = state.page;
      if (!page || !page.items.length) {
        result.append(
          h("div", { class: "empty-state" }, h("div", { class: "empty-state__icon" }, "🔎"), state.query ? `No households match “${state.query}”.` : "No households yet.")
        );
        return;
      }
      const from = page.offset + 1;
      const to = page.offset + page.items.length;
      result.append(h("p", { class: "muted" }, `${from}–${to} of ${page.total}`));
      result.append(
        h(
          "ul",
          { class: "list" },
          page.items.map((hh) => householdRow(hh))
        )
      );
      result.append(pager(page));
    }

    function householdRow(hh) {
      const langs = (hh.languages || []).map((l) => h("span", { class: "pill" }, l));
      return h(
        "li",
        { class: "list-item list-item--selectable", onclick: () => navigate("checkin", { id: hh.id }) },
        h(
          "div",
          { class: "list-item__body" },
          h("div", { class: "list-item__label" }, hh.name || "(no name)"),
          h(
            "div",
            { class: "list-item__meta" },
            h("span", { class: "mono" }, hh.phone_number || "—"),
            hh.open_request_count ? ` · ${hh.open_request_count} open` : "",
            langs.length ? h("div", { class: "row" }, langs) : null
          )
        ),
        hh.appointment_date ? h("span", { class: "badge badge-open" }, "Appt") : null
      );
    }

    function pager(page) {
      const hasPrev = page.offset > 0;
      const hasNext = page.offset + page.items.length < page.total;
      return h(
        "div",
        { class: "row row--between" },
        h(
          "button",
          { class: "btn btn-ghost", disabled: !hasPrev, onclick: () => { state.offset = Math.max(0, page.offset - PAGE_SIZE); load(); } },
          "← Prev"
        ),
        h(
          "button",
          { class: "btn btn-ghost", disabled: !hasNext, onclick: () => { state.offset = page.offset + PAGE_SIZE; load(); } },
          "Next →"
        )
      );
    }
  }

  window.BAM.registerView("lookup", { title: "Look up", icon: "🔎", render });
})();
