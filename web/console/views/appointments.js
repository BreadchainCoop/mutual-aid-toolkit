/* Appointments view — parity with the Airtable "EG Check-In / Today's
 * Appointments" and "Overview" interfaces.
 *
 * Pick a date (defaults to today) -> GET /appointments -> the check-in queue
 * for that day, grouped by appointment time, colored by appointment status.
 * Each row deep-links into the check-in detail (#checkin?id=).
 *
 * Mirrors views/checkin.js for structure, loading/empty/error handling, and
 * use of BAM.h / BAM.api / the shared component classes. */

(function () {
  "use strict";

  const { h, clear, toast, api, navigate } = window.BAM;

  // Local (not UTC) YYYY-MM-DD so "today" matches the operator's day.
  function todayLocal() {
    return new Date().toLocaleDateString("en-CA");
  }

  function apptBadge(status) {
    if (!status) return h("span", { class: "badge badge-open" }, "Booked");
    const cls =
      status === "Checked-in"
        ? "badge-delivered"
        : status === "Missed"
        ? "badge-timeout"
        : "badge-open";
    return h("span", { class: `badge ${cls}` }, status);
  }

  function render(container) {
    const state = { rows: null, loading: false, date: todayLocal() };

    const dateInput = h("input", {
      class: "input",
      type: "date",
      id: "appt-date",
      value: state.date,
      "aria-label": "Appointment date",
      onchange: (e) => {
        state.date = e.target.value || todayLocal();
        load();
      },
    });

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Appointments"),
      h("p", { class: "muted" }, "The check-in queue for a day, grouped by time.")
    );

    const controls = h(
      "div",
      { class: "card row row--between" },
      h("div", { class: "field grow" }, h("label", { class: "label", for: "appt-date" }, "Date"), dateInput),
      h("button", { class: "btn btn-ghost", onclick: () => load() }, "Refresh")
    );

    const result = h("div", { id: "appt-result" });

    clear(container);
    container.append(heading, controls, result);
    load();

    async function load() {
      if (state.loading) return;
      state.loading = true;
      clear(result).append(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading appointments…"));
      try {
        state.rows = await api.appointments(state.date);
        renderResult();
      } catch (err) {
        clear(result).append(h("div", { class: "empty-state" }, "Could not load appointments."));
        toast(err.detail || "Failed to load appointments.", "error");
      } finally {
        state.loading = false;
      }
    }

    function renderResult() {
      clear(result);
      const rows = state.rows || [];
      if (!rows.length) {
        result.append(
          h("div", { class: "empty-state" }, h("div", { class: "empty-state__icon" }, "📅"), `No families booked for ${state.date}.`)
        );
        return;
      }
      result.append(h("p", { class: "muted" }, `${rows.length} ${rows.length === 1 ? "family" : "families"} booked`));

      // Group by appointment time ("–" bucket for unset).
      const groups = new Map();
      for (const r of rows) {
        const key = r.appointment_time || "No time set";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      for (const [time, families] of groups) {
        result.append(h("div", { class: "section-title" }, time));
        result.append(
          h(
            "ul",
            { class: "list" },
            families.map((r) => familyRow(r))
          )
        );
      }
    }

    function familyRow(r) {
      const langs = (r.languages || []).map((l) => h("span", { class: "pill" }, l));
      return h(
        "li",
        { class: "list-item list-item--selectable", onclick: () => navigate("checkin", { id: r.household_id }) },
        h(
          "div",
          { class: "list-item__body" },
          h("div", { class: "list-item__label" }, r.name || "(no name)"),
          h(
            "div",
            { class: "list-item__meta" },
            h("span", { class: "mono" }, r.phone_number || "—"),
            " · ",
            `${r.open_request_count} open ${r.open_request_count === 1 ? "request" : "requests"}`,
            langs.length ? h("div", { class: "row" }, langs) : null
          )
        ),
        apptBadge(r.appointment_status)
      );
    }
  }

  window.BAM.registerView("appointments", { title: "Appointments", icon: "📅", render });
})();
