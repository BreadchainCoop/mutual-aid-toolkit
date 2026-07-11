/* Shifts & coverage board — self-serve staffing for distros and events.
 *
 * Role slots (check-in · Spanish required, lift, interpreter · Arabic,
 * driver…) that volunteers claim from their phone. Gaps are visible instead
 * of negotiated in chat; releasing a slot is one tap (the 11pm-sick flow),
 * so call-outs don't need to wake anyone. Admins create/remove slots and can
 * release other people's claims. Data lives in the grantable distros doc. */

(function () {
  "use strict";

  const { h, clear, toast, api, fmtDate } = window.BAM;

  function render(container) {
    const state = { slots: null, includePast: false, loading: false };
    const isAdmin = !!(window.BAM.access && window.BAM.access.isAdmin && window.BAM.access.isAdmin());

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Shifts"),
      h(
        "p",
        { class: "muted" },
        "Who's covering what — claim a role, or hand one back if you can't make it."
      )
    );

    const summary = h("div", {});
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
      container.append(summary, listRegion);
      if (isAdmin) container.append(renderCreateCard());
      container.append(renderPastToggle());
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
        state.slots = await api.listShifts({ include_past: state.includePast });
        renderList();
      } catch (err) {
        clear(listRegion).append(
          h("div", { class: "card empty-state" }, (err && err.detail) || "Could not load shifts.")
        );
      } finally {
        state.loading = false;
      }
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

    // ---- rendering ----------------------------------------------------------

    function renderList() {
      clear(summary);
      clear(listRegion);
      const slots = state.slots || [];

      const totalGap = slots.reduce((sum, s) => sum + (s.gap || 0), 0);
      if (totalGap > 0) {
        summary.append(
          h(
            "div",
            { class: "card row", style: { alignItems: "center" } },
            h("span", { class: "badge badge-timeout" }, String(totalGap)),
            h("span", {}, `role${totalGap === 1 ? "" : "s"} still need${totalGap === 1 ? "s" : ""} cover — take one below if you can.`)
          )
        );
      }

      if (!slots.length) {
        listRegion.append(
          h(
            "div",
            { class: "card empty-state" },
            h("div", { class: "empty-state__icon" }, "🗓️"),
            h("div", {}, "No upcoming shift slots."),
            isAdmin
              ? h("p", { class: "muted" }, "Create the first slots for your next distro below.")
              : h("p", { class: "muted" }, "When the team posts shifts, they'll show up here.")
          )
        );
        return;
      }

      // Group by date.
      const byDate = new Map();
      for (const s of slots) {
        if (!byDate.has(s.date)) byDate.set(s.date, []);
        byDate.get(s.date).push(s);
      }
      for (const [date, daySlots] of byDate) {
        listRegion.append(h("div", { class: "section-title" }, fmtDate(date)));
        listRegion.append(h("ul", { class: "list" }, daySlots.map(slotRow)));
      }
    }

    function slotRow(s) {
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
        { class: "list-item", style: { alignItems: "flex-start" } },
        h(
          "div",
          { class: "list-item__body stack", style: { gap: "var(--s1)" } },
          h(
            "div",
            { class: "row" },
            h("span", { class: "list-item__label" }, `${s.event_label} — ${s.role}`),
            s.language_required
              ? h("span", { class: "pill", title: "Language required" }, `🗣 ${window.BAM.langShort ? window.BAM.langShort(s.language_required) : s.language_required}`)
              : null
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

    function renderPastToggle() {
      const btn = h(
        "button",
        {
          class: "btn btn-ghost btn-block",
          type: "button",
          onclick: () => {
            state.includePast = !state.includePast;
            btn.textContent = state.includePast ? "Hide past shifts" : "Show past shifts";
            load();
          },
        },
        "Show past shifts"
      );
      return btn;
    }

    // Admin: create shift slots for a distro/event.
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
        langSelect.append(h("option", { value: label }, window.BAM.langShort ? window.BAM.langShort(label) : label));
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
        "form",
        {
          class: "card stack",
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
        h("h2", { class: "card__title" }, "New shift slot"),
        fieldRow("shift-date", "Date", dateInput),
        fieldRow("shift-event", "Event", eventInput),
        fieldRow("shift-role", "Role", roleInput),
        fieldRow("shift-lang", "Language required", langSelect),
        fieldRow("shift-needed", "People needed", neededInput),
        fieldRow("shift-notes", "Notes", notesInput),
        createBtn
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
