/* Shifts & coverage board — calendar-first, built for "where can I help?"
 *
 * A month calendar shows at a glance which days need people (red count) and
 * which are covered (green check). Tap a day to see just its slots; tap
 * "I'll take it" to claim one. Your volunteer profile (languages, vehicle)
 * highlights the slots that fit you. Admins post slots and can release
 * claims. Data lives in the grantable distros doc. */

(function () {
  "use strict";

  const { h, clear, toast, api, fmtDate } = window.BAM;

  const MONTH_FMT = { month: "long", year: "numeric" };

  function todayLocal() {
    return new Date().toLocaleDateString("en-CA");
  }

  function ymd(d) {
    return d.toLocaleDateString("en-CA");
  }

  function langShort(label) {
    return window.BAM.langShort ? window.BAM.langShort(label) : label;
  }

  // Does a slot fit this device's volunteer profile?
  function matchesProfile(slot, profile) {
    if (!profile) return false;
    if (
      slot.language_required &&
      (profile.languages || []).includes(slot.language_required)
    ) {
      return true;
    }
    if (/driver|delivery|transport/i.test(slot.role) && ["car", "van"].includes(profile.vehicle || "")) {
      return true;
    }
    if (/lift|setup|load/i.test(slot.role) && /lift/i.test(profile.skills || "")) return true;
    return false;
  }

  function render(container) {
    const state = {
      slots: [], // every slot, past included (calendar needs the month)
      month: (() => {
        const d = new Date();
        d.setDate(1);
        return d;
      })(),
      selectedDate: null, // YYYY-MM-DD or null = all upcoming
      loading: false,
    };
    const isAdmin = !!(window.BAM.access && window.BAM.access.isAdmin && window.BAM.access.isAdmin());
    const profile =
      (window.BAM.access && window.BAM.access.myProfile && window.BAM.access.myProfile()) || null;

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Shifts"),
      h("p", { class: "muted" }, "Pick a day, see what's needed, tap to take it.")
    );

    const summary = h("div", {});
    const calRegion = h("div", {});
    const listRegion = h("div", {});

    clear(container);
    container.append(heading);

    Promise.resolve(api.distrosAccess()).then((access) => {
      if (access === "denied") {
        container.append(
          h(
            "div",
            { class: "card empty-state" },
            h("div", { class: "empty-state__icon" }, "🔒"),
            h("div", {}, "An admin hasn't granted this device access to Distros & shifts."),
            h(
              "p",
              { class: "muted" },
              "The rest of the app still works. Ask an admin to grant this device the Distros domain (Admin → Data access)."
            )
          )
        );
        return;
      }
      container.append(summary, calRegion, listRegion);
      if (isAdmin) container.append(renderCreateCard());
      load();
    });

    // ---- data ---------------------------------------------------------------

    async function load() {
      if (state.loading) return;
      state.loading = true;
      clear(listRegion).append(
        h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading shifts…")
      );
      try {
        state.slots = await api.listShifts({ include_past: true });
        renderAll();
      } catch (err) {
        clear(listRegion).append(
          h("div", { class: "card empty-state" }, (err && err.detail) || "Could not load shifts.")
        );
      } finally {
        state.loading = false;
      }
    }

    function renderAll() {
      renderSummary();
      renderCalendar();
      renderList();
    }

    // ---- actions ------------------------------------------------------------

    async function doClaim(slot) {
      try {
        await api.claimShift(slot.id);
        toast(`You're covering ${slot.role} on ${fmtDate(slot.date)}. Thank you!`, "success");
        await load();
      } catch (err) {
        toast((err && err.detail) || "Could not claim that slot.", "error");
      }
    }

    async function doRelease(slot, peerId) {
      try {
        await api.releaseShift(slot.id, peerId ? { peer_id: peerId } : {});
        toast(peerId ? "Claim released." : "Slot handed back — we'll find cover.", "success");
        await load();
      } catch (err) {
        toast((err && err.detail) || "Could not release the slot.", "error");
      }
    }

    async function doRemove(slot) {
      if (!confirm(`Remove the ${slot.role} slot on ${fmtDate(slot.date)}?`)) return;
      try {
        await api.removeShift(slot.id);
        toast("Slot removed.", "success");
        await load();
      } catch (err) {
        toast((err && err.detail) || "Could not remove the slot.", "error");
      }
    }

    // ---- summary line -------------------------------------------------------

    function renderSummary() {
      clear(summary);
      const today = todayLocal();
      const upcoming = state.slots.filter((s) => s.date >= today);
      const totalGap = upcoming.reduce((sum, s) => sum + (s.gap || 0), 0);
      const matches = upcoming.filter((s) => s.gap > 0 && matchesProfile(s, profile));

      if (matches.length) {
        const first = matches[0];
        summary.append(
          h(
            "div",
            { class: "card row", style: { alignItems: "center", borderColor: "var(--brand)", borderWidth: "2px" } },
            h("span", { style: { fontSize: "22px" } }, "✨"),
            h(
              "div",
              { class: "list-item__body" },
              h("div", { class: "list-item__label" }, `${matches.length === 1 ? "A shift fits" : matches.length + " shifts fit"} you`),
              h(
                "div",
                { class: "list-item__meta" },
                `Like ${first.role} on ${fmtDate(first.date)}${first.language_required ? ` (${langShort(first.language_required)})` : ""} — based on your profile.`
              )
            ),
            h(
              "button",
              {
                class: "btn btn-primary",
                type: "button",
                onclick: () => {
                  state.selectedDate = first.date;
                  state.month = new Date(first.date + "T12:00:00");
                  state.month.setDate(1);
                  renderAll();
                },
              },
              "Show me"
            )
          )
        );
      } else if (totalGap > 0) {
        summary.append(
          h(
            "div",
            { class: "card row", style: { alignItems: "center" } },
            h("span", { class: "badge badge-timeout" }, String(totalGap)),
            h("span", {}, `role${totalGap === 1 ? "" : "s"} still need${totalGap === 1 ? "s" : ""} cover — red days on the calendar.`)
          )
        );
      }
    }

    // ---- calendar -----------------------------------------------------------

    function renderCalendar() {
      clear(calRegion);
      const year = state.month.getFullYear();
      const month = state.month.getMonth();
      const today = todayLocal();

      // Per-day rollup: {gap, total}.
      const byDay = new Map();
      for (const s of state.slots) {
        const entry = byDay.get(s.date) || { gap: 0, total: 0 };
        entry.gap += s.gap || 0;
        entry.total += 1;
        byDay.set(s.date, entry);
      }

      const monthLabel = state.month.toLocaleDateString(undefined, MONTH_FMT);
      const nav = h(
        "div",
        { class: "row row--between", style: { alignItems: "center" } },
        h(
          "button",
          {
            class: "btn btn-ghost",
            type: "button",
            "aria-label": "Previous month",
            onclick: () => {
              state.month.setMonth(state.month.getMonth() - 1);
              renderCalendar();
            },
          },
          "‹"
        ),
        h("h2", { class: "card__title", style: { margin: "0" } }, monthLabel),
        h(
          "button",
          {
            class: "btn btn-ghost",
            type: "button",
            "aria-label": "Next month",
            onclick: () => {
              state.month.setMonth(state.month.getMonth() + 1);
              renderCalendar();
            },
          },
          "›"
        )
      );

      const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) =>
        h("div", { class: "cal__dow" }, d)
      );

      const first = new Date(year, month, 1);
      const cells = [];
      for (let i = 0; i < first.getDay(); i++) cells.push(h("div", { class: "cal__day cal__day--pad" }));
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const date = ymd(new Date(year, month, day));
        const info = byDay.get(date);
        const marker = !info
          ? null
          : info.gap > 0
            ? h("span", { class: "cal__mark cal__mark--gap" }, String(info.gap))
            : h("span", { class: "cal__mark cal__mark--ok" }, "✓");
        cells.push(
          h(
            "button",
            {
              type: "button",
              class:
                "cal__day" +
                (date === today ? " cal__day--today" : "") +
                (date === state.selectedDate ? " cal__day--selected" : "") +
                (info ? " cal__day--has" : ""),
              "aria-label": `${fmtDate(date)}${info ? `: ${info.gap} needed of ${info.total} slots` : ""}`,
              onclick: () => {
                state.selectedDate = state.selectedDate === date ? null : date;
                renderCalendar();
                renderList();
              },
            },
            h("span", { class: "cal__num" }, String(day)),
            marker
          )
        );
      }

      calRegion.append(
        h(
          "div",
          { class: "card stack" },
          nav,
          h("div", { class: "cal" }, dow, cells),
          h(
            "div",
            { class: "list-item__meta" },
            h("span", { class: "cal__mark cal__mark--gap", style: { position: "static", marginRight: "4px" } }, "2"),
            " = people still needed · ",
            h("span", { class: "cal__mark cal__mark--ok", style: { position: "static", margin: "0 4px" } }, "✓"),
            " = fully covered · tap a day to see its shifts"
          )
        )
      );
    }

    // ---- slot list ----------------------------------------------------------

    function renderList() {
      clear(listRegion);
      const today = todayLocal();
      let slots;
      let title;
      if (state.selectedDate) {
        slots = state.slots.filter((s) => s.date === state.selectedDate);
        title = h(
          "div",
          { class: "row row--between", style: { alignItems: "center" } },
          h("h2", { class: "card__title", style: { margin: "0" } }, fmtDate(state.selectedDate)),
          h(
            "button",
            {
              class: "btn btn-ghost",
              type: "button",
              onclick: () => {
                state.selectedDate = null;
                renderCalendar();
                renderList();
              },
            },
            "Show all upcoming"
          )
        );
      } else {
        slots = state.slots.filter((s) => s.date >= today);
        title = h("h2", { class: "card__title", style: { margin: "0" } }, "All upcoming shifts");
      }

      if (!slots.length) {
        listRegion.append(
          h(
            "div",
            { class: "card stack" },
            title,
            h(
              "div",
              { class: "empty-state" },
              h("div", { class: "empty-state__icon" }, "🗓️"),
              h(
                "div",
                {},
                state.selectedDate ? "No shifts posted for this day." : "No upcoming shift slots."
              ),
              isAdmin
                ? h("p", { class: "muted" }, "Post slots for your next distro below.")
                : h("p", { class: "muted" }, "When the team posts shifts, they'll show up here.")
            )
          )
        );
        return;
      }

      // Group by date (a single group when a day is selected).
      const byDate = new Map();
      for (const s of slots) {
        if (!byDate.has(s.date)) byDate.set(s.date, []);
        byDate.get(s.date).push(s);
      }
      const wrap = h("div", { class: "card stack" }, title);
      for (const [date, daySlots] of byDate) {
        if (!state.selectedDate) wrap.append(h("div", { class: "section-title" }, fmtDate(date)));
        wrap.append(h("ul", { class: "list" }, daySlots.map(slotRow)));
      }
      listRegion.append(wrap);
    }

    function slotRow(s) {
      const fits = s.gap > 0 && matchesProfile(s, profile);
      const claimants = (s.claimants || []).map((c) =>
        h(
          "span",
          { class: "pill" },
          c.name,
          isAdmin && c.peer_id !== window.BAM.access.myPeerId
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn-ghost",
                  style: { minHeight: "auto", minWidth: "auto", padding: "0 4px", marginLeft: "4px" },
                  title: `Release ${c.name}'s claim`,
                  onclick: () => doRelease(s, c.peer_id),
                },
                "×"
              )
            : null
        )
      );

      const coverage =
        s.gap > 0
          ? h("span", { class: "badge badge-timeout" }, `NEEDS ${s.gap}`)
          : h("span", { class: "badge badge-delivered" }, "covered ✓");

      const action = s.mine
        ? h(
            "button",
            { class: "btn btn-ghost", type: "button", onclick: () => doRelease(s) },
            "Can't make it"
          )
        : s.gap > 0
          ? h(
              "button",
              { class: "btn btn-primary", type: "button", onclick: () => doClaim(s) },
              "I'll take it"
            )
          : null;

      return h(
        "li",
        {
          class: "list-item",
          style: fits
            ? { alignItems: "flex-start", borderColor: "var(--brand)", borderWidth: "2px" }
            : { alignItems: "flex-start" },
        },
        h(
          "div",
          { class: "list-item__body stack", style: { gap: "var(--s1)" } },
          h(
            "div",
            { class: "row" },
            h("span", { class: "list-item__label" }, `${s.event_label} — ${s.role}`),
            s.language_required
              ? h("span", { class: "pill", title: "Language required" }, `🗣 ${langShort(s.language_required)}`)
              : null,
            fits ? h("span", { class: "badge badge-open" }, "✨ fits you") : null,
            s.mine ? h("span", { class: "badge badge-delivered" }, "yours") : null
          ),
          h(
            "div",
            { class: "list-item__meta" },
            `${s.claimed_count}/${s.needed} covered${s.notes ? ` — ${s.notes}` : ""}`
          ),
          claimants.length ? h("div", { class: "row", style: { flexWrap: "wrap" } }, claimants) : null
        ),
        h(
          "span",
          { class: "row", style: { gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" } },
          coverage,
          action,
          isAdmin
            ? h(
                "button",
                {
                  class: "btn btn-ghost",
                  type: "button",
                  title: "Remove this slot",
                  onclick: () => doRemove(s),
                },
                "✕"
              )
            : null
        )
      );
    }

    // ---- admin: create slots ------------------------------------------------

    function renderCreateCard() {
      const dateInput = h("input", { class: "input", id: "shift-date", type: "date" });
      const eventInput = h("input", {
        class: "input",
        id: "shift-event",
        type: "text",
        value: "Distro",
        "aria-label": "Event label",
      });
      const roleInput = h("input", {
        class: "input",
        id: "shift-role",
        type: "text",
        placeholder: "e.g. Check-in, Lift, Interpreter, Driver",
        "aria-label": "Role",
      });
      const langSelect = h("select", { class: "input", id: "shift-lang", "aria-label": "Language required" });
      langSelect.append(h("option", { value: "" }, "No language requirement"));
      (window.BAM.LANGUAGES || []).forEach((label) => {
        langSelect.append(h("option", { value: label }, langShort(label)));
      });
      const neededInput = h("input", {
        class: "input",
        id: "shift-needed",
        type: "number",
        min: "1",
        value: "1",
        "aria-label": "People needed",
      });
      const notesInput = h("input", {
        class: "input",
        id: "shift-notes",
        type: "text",
        placeholder: "e.g. 12:30–4:30, heavy lifting",
        "aria-label": "Notes",
      });
      const createBtn = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "Post shift slot");

      return h(
        "details",
        { class: "advanced", style: { marginTop: "var(--s3)" } },
        h("summary", {}, "➕ Post shift slots (admin)"),
        h(
          "form",
          {
            class: "card stack",
            style: { marginTop: "var(--s3)" },
            onsubmit: async (e) => {
              e.preventDefault();
              if (!dateInput.value) {
                toast("Pick a date for the shift.", "info");
                dateInput.focus();
                return;
              }
              if (!roleInput.value.trim()) {
                toast("Name the role (Check-in, Lift, Driver…).", "info");
                roleInput.focus();
                return;
              }
              createBtn.disabled = true;
              try {
                const body = {
                  date: dateInput.value,
                  event_label: eventInput.value.trim() || "Distro",
                  role: roleInput.value.trim(),
                  needed: Number(neededInput.value) || 1,
                };
                if (langSelect.value) body.language_required = langSelect.value;
                if (notesInput.value.trim()) body.notes = notesInput.value.trim();
                await api.createShift(body);
                toast("Shift slot posted.", "success");
                roleInput.value = "";
                await load();
              } catch (err) {
                toast((err && err.detail) || "Could not post the slot.", "error");
              } finally {
                createBtn.disabled = false;
              }
            },
          },
          fieldRow("shift-date", "Date", dateInput),
          fieldRow("shift-event", "Event", eventInput),
          fieldRow("shift-role", "Role", roleInput),
          fieldRow("shift-lang", "Language required", langSelect),
          fieldRow("shift-needed", "People needed", neededInput),
          fieldRow("shift-notes", "Notes", notesInput),
          createBtn
        )
      );
    }

    function fieldRow(id, labelText, control) {
      return h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: id }, labelText),
        control
      );
    }
  }

  window.BAM.registerView("shifts", {
    title: "Shifts",
    icon: "🗓️",
    render,
  });
})();
