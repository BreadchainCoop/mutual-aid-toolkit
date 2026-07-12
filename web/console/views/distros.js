/* Distros view (spec 4 Distros table + 6.3 end-of-distro no-show pass).
 *
 * Two parts:
 *  (A) List existing distribution events and a "New distribution" form
 *      (POST /distros, then refresh the list).
 *  (B) End-of-distro no-show pass: pick a date, confirm, then
 *      POST /distros/no-shows to mark booked no-shows Missed and time out
 *      anyone hitting their 2nd miss. Because it mutates state it uses an
 *      in-UI two-click confirm (no blocking browser dialogs).
 *
 * Mirrors views/checkin.js for structure, loading/empty/error states, and use
 * of BAM.h / BAM.api / the shared component classes. */

(function () {
  "use strict";

  const { h, clear, toast, api, fmtDateTime, fmtDate } = window.BAM;

  // datetime-local value ("YYYY-MM-DDTHH:MM", interpreted as local wall time)
  // -> ISO 8601 UTC string the API expects. Returns null for empty/invalid.
  function localInputToIso(value) {
    if (!value) return null;
    const d = new Date(value); // browser reads datetime-local as local time
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function render(container) {
    // ---- view state ------------------------------------------------------
    const state = {
      distros: null, // last GET /distros result (array) or null before load
      loading: false, // list is loading
      creating: false, // create form submitting
      confirmingNoShow: false, // no-show pass awaiting second click
      runningNoShow: false, // no-show pass in flight
    };

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Distros"),
      h(
        "p",
        { class: "muted" },
        "Schedule distribution events and run the end-of-distro no-show pass."
      )
    );

    // Region holders, re-rendered independently.
    const listRegion = h("div", { id: "distros-list" });
    const noShowRegion = h("div", { id: "distros-noshow" });

    clear(container);

    // Data-access gate: distros live in their own grantable doc; a denied
    // device gets a clear explanation instead of empty/erroring cards.
    Promise.resolve(api.distrosAccess()).then((access) => {
      if (access === "denied") {
        clear(container);
        container.append(
          heading,
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
      container.append(
        nextRegion,
        h(
          "details",
          { class: "advanced" },
          h("summary", {}, "➕ Schedule a distribution"),
          renderCreateForm()
        ),
        listRegion,
        renderInventoryCard(),
        renderSlotUsageCard(),
        renderNoShowCard()
      );
      // Kick off the initial list load.
      loadDistros();
    });

    // "Next distro" hero: the distro lifecycle as a checklist with live
    // numbers — schedule → fill shifts → book citas → check in → wrap up —
    // so running a distro is a sequence you can see, not tribal knowledge.
    const nextRegion = h("div", {});

    async function renderNextDistro() {
      clear(nextRegion);
      const today = todayLocalIso();
      const next = (state.distros || [])
        .filter((d) => d.status !== "Cancelled" && String(d.date_time).slice(0, 10) >= today)
        .sort((a, b) => String(a.date_time).localeCompare(String(b.date_time)))[0];
      if (!next) {
        nextRegion.append(
          h(
            "div",
            { class: "card empty-state" },
            h("div", { class: "empty-state__icon" }, "📦"),
            h("div", {}, "No upcoming distribution."),
            h("p", { class: "muted" }, "Schedule one below — then fill shifts and book families.")
          )
        );
        return;
      }
      const date = String(next.date_time).slice(0, 10);

      // Live numbers (each optional — the checklist renders without them).
      let shiftsTotal = 0;
      let shiftsGap = 0;
      try {
        const slots = await api.listShifts({ from: date, to: date, include_past: true });
        shiftsTotal = slots.reduce((sum, s) => sum + (s.needed || 0), 0);
        shiftsGap = slots.reduce((sum, s) => sum + (s.gap || 0), 0);
      } catch (_e) { /* shifts may be unavailable */ }
      let booked = 0;
      let checkedIn = 0;
      try {
        const rows = await api.appointments(date);
        booked = rows.length;
        checkedIn = rows.filter((r) => r.appointment_status === "Checked-in").length;
      } catch (_e) { /* fine */ }

      const isToday = date === today;
      const stepRow = (done, icon, label, meta, view) =>
        h(
          "li",
          {
            class: "list-item" + (view ? " list-item--selectable" : ""),
            style: view ? { cursor: "pointer" } : null,
            onclick: view ? () => window.BAM.navigate(view) : null,
          },
          h("span", { class: `badge ${done ? "badge-delivered" : "badge-open"}` }, done ? "✓" : icon),
          h(
            "div",
            { class: "list-item__body" },
            h("div", { class: "list-item__label" }, label),
            meta ? h("div", { class: "list-item__meta" }, meta) : null
          ),
          view ? h("span", { class: "muted", "aria-hidden": "true" }, "→") : null
        );

      nextRegion.append(
        h(
          "div",
          { class: "card stack", style: { borderColor: "var(--brand)", borderWidth: "2px" } },
          h(
            "div",
            { class: "row row--between" },
            h("h2", { class: "card__title", style: { margin: "0" } }, isToday ? "Today's distro" : "Next distro"),
            h("span", { class: "pill" }, `${fmtDateTime(next.date_time)}${next.location ? " · " + next.location : ""}`)
          ),
          h(
            "ul",
            { class: "list" },
            stepRow(true, "1", "Scheduled", next.slot_capacity != null ? `Cap ${next.slot_capacity} per 30-min slot` : "No slot cap set"),
            stepRow(
              shiftsTotal > 0 && shiftsGap === 0,
              "2",
              "Fill the shifts",
              shiftsTotal === 0
                ? "No shift slots posted yet"
                : shiftsGap > 0
                  ? `${shiftsGap} of ${shiftsTotal} role${shiftsTotal === 1 ? "" : "s"} still need cover`
                  : "All roles covered",
              "shifts"
            ),
            stepRow(
              booked > 0,
              "3",
              "Book families in",
              booked > 0 ? `${booked} cita${booked === 1 ? "" : "s"} booked` : "No citas yet — build a list in Outreach",
              "outreach"
            ),
            stepRow(
              isToday && checkedIn > 0,
              "4",
              "Day of: check people in",
              isToday
                ? `${checkedIn} of ${booked} checked in`
                : "On the day, use Check-in as families arrive",
              isToday ? "appointments" : null
            ),
            stepRow(false, "5", "After: run the no-show pass", "Marks who didn't come and clears their citas — bottom of this page")
          )
        )
      );
    }

    container.append(heading);

    // ---- (A) create form -------------------------------------------------

    function renderCreateForm() {
      const dateTimeInput = h("input", {
        class: "input",
        id: "distro-datetime",
        name: "date_time",
        type: "datetime-local",
        required: true,
        "aria-label": "Date and time",
      });
      const locationInput = h("input", {
        class: "input",
        id: "distro-location",
        name: "location",
        type: "text",
        autocomplete: "off",
        placeholder: "e.g. Maria Hernandez Park",
        "aria-label": "Location",
      });
      const durationInput = h("input", {
        class: "input",
        id: "distro-duration",
        name: "duration_minutes",
        type: "number",
        inputmode: "numeric",
        min: "0",
        step: "15",
        placeholder: "e.g. 120",
        "aria-label": "Duration in minutes",
      });
      const appointmentsInput = h("input", {
        class: "input",
        id: "distro-appointments",
        name: "appointments",
        type: "text",
        autocomplete: "off",
        placeholder: "e.g. 60 booked",
        "aria-label": "Appointments",
      });
      const notesInput = h("textarea", {
        class: "input",
        id: "distro-notes",
        name: "notes",
        rows: "2",
        placeholder: "Anything volunteers should know",
        "aria-label": "Notes",
      });
      const slotCapInput = h("input", {
        class: "input",
        id: "distro-slot-cap",
        name: "slot_capacity",
        type: "number",
        inputmode: "numeric",
        min: "1",
        placeholder: "e.g. 15 — leave blank for no cap",
        "aria-label": "Appointments per 30-minute slot",
      });

      const submitBtn = h(
        "button",
        { class: "btn btn-primary btn-block", type: "submit" },
        "Schedule distribution"
      );

      const form = h(
        "form",
        {
          class: "card stack",
          onsubmit: (e) => {
            e.preventDefault();
            doCreate({
              dateTimeInput,
              locationInput,
              durationInput,
              slotCapInput,
              appointmentsInput,
              notesInput,
              submitBtn,
            });
          },
        },
        h("h2", { class: "card__title" }, "New distribution"),
        field("distro-datetime", "Date & time", dateTimeInput),
        field("distro-location", "Location", locationInput),
        field("distro-duration", "Duration (minutes)", durationInput),
        field("distro-slot-cap", "Appointments per 30-min slot", slotCapInput),
        field("distro-appointments", "Appointments", appointmentsInput),
        field("distro-notes", "Notes", notesInput),
        submitBtn
      );
      return form;
    }

    async function doCreate(els) {
      const iso = localInputToIso(els.dateTimeInput.value);
      if (!iso) {
        toast("Pick a date and time for the distribution.", "info");
        els.dateTimeInput.focus();
        return;
      }

      // Build the payload, omitting empty optional fields.
      const payload = { date_time: iso };
      const loc = els.locationInput.value.trim();
      if (loc) payload.location = loc;
      const appts = els.appointmentsInput.value.trim();
      if (appts) payload.appointments = appts;
      const notes = els.notesInput.value.trim();
      if (notes) payload.notes = notes;
      const durRaw = els.durationInput.value.trim();
      if (durRaw !== "") {
        const dur = Number(durRaw);
        if (!Number.isFinite(dur) || dur < 0) {
          toast("Duration must be a non-negative number of minutes.", "info");
          els.durationInput.focus();
          return;
        }
        payload.duration_minutes = Math.round(dur);
      }
      const capRaw = els.slotCapInput.value.trim();
      if (capRaw !== "") {
        const cap = Number(capRaw);
        if (!Number.isFinite(cap) || cap < 1) {
          toast("Slot capacity must be a positive number.", "info");
          els.slotCapInput.focus();
          return;
        }
        payload.slot_capacity = Math.round(cap);
      }

      setCreating(true, els.submitBtn);
      try {
        await api.createDistro(payload);
        toast("Distribution scheduled.", "success");
        // Reset the form for the next entry.
        els.dateTimeInput.value = "";
        els.locationInput.value = "";
        els.durationInput.value = "";
        els.slotCapInput.value = "";
        els.appointmentsInput.value = "";
        els.notesInput.value = "";
        await loadDistros();
      } catch (err) {
        toast(err.detail || "Could not schedule the distribution.", "error");
      } finally {
        setCreating(false, els.submitBtn);
      }
    }

    function setCreating(busy, submitBtn) {
      state.creating = busy;
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? "Scheduling…" : "Schedule distribution";
    }

    // ---- (A) list --------------------------------------------------------

    async function loadDistros() {
      state.loading = true;
      renderList();
      try {
        state.distros = await api.listDistros();
      } catch (err) {
        state.distros = null;
        renderListError(err);
        toast(err.detail || "Could not load distributions.", "error");
        return;
      } finally {
        state.loading = false;
      }
      renderList();
      void renderNextDistro();
    }

    function renderList() {
      clear(listRegion);

      if (state.loading) {
        listRegion.append(
          h(
            "div",
            { class: "loading" },
            h("span", {
              class: "spinner",
              role: "status",
              "aria-label": "Loading",
            }),
            "Loading distributions…"
          )
        );
        return;
      }

      const distros = state.distros || [];
      const wrap = h("div", { class: "stack" });
      wrap.append(
        h(
          "div",
          { class: "row row--between" },
          h("h2", { class: "card__title", style: { margin: "0" } }, "Scheduled distributions"),
          h("span", { class: "muted" }, `${distros.length} total`)
        )
      );

      if (!distros.length) {
        wrap.append(
          h(
            "div",
            { class: "card empty-state" },
            h("div", { class: "empty-state__icon" }, "📦"),
            h("div", {}, "No distributions scheduled yet."),
            h(
              "p",
              { class: "muted" },
              "Use the form above to schedule your first distribution event."
            )
          )
        );
      } else {
        // Newest first for the operator (list endpoint returns oldest-first).
        const sorted = distros
          .slice()
          .sort((a, b) => String(b.date_time).localeCompare(String(a.date_time)));
        wrap.append(
          h("ul", { class: "list" }, sorted.map(distroCard))
        );
      }

      listRegion.append(wrap);
    }

    function distroCard(d) {
      const cancelled = d.status === "Cancelled";
      const meta = [];
      if (d.location) meta.push(h("span", { class: "pill" }, `📍 ${d.location}`));
      if (d.duration_minutes != null)
        meta.push(h("span", { class: "pill" }, `${d.duration_minutes} min`));
      if (d.slot_capacity != null)
        meta.push(h("span", { class: "pill", title: "Max appointments per 30-minute slot" }, `cap ${d.slot_capacity}/slot`));
      if (d.appointments)
        meta.push(h("span", { class: "pill" }, `Appts: ${d.appointments}`));

      return h(
        "li",
        {
          class: "list-item",
          style: cancelled
            ? { alignItems: "flex-start", opacity: "0.6" }
            : { alignItems: "flex-start" },
        },
        h(
          "div",
          { class: "list-item__body stack" },
          h(
            "div",
            { class: "row" },
            h("div", { class: "list-item__label" }, fmtDateTime(d.date_time) || "Date TBD"),
            cancelled ? h("span", { class: "badge badge-timeout" }, "Cancelled") : null
          ),
          meta.length ? h("div", { class: "row" }, meta) : null,
          cancelled && d.cancel_reason
            ? h("div", { class: "list-item__meta" }, `Reason: ${d.cancel_reason}`)
            : null,
          d.notes ? h("div", { class: "list-item__meta" }, d.notes) : null
        ),
        cancelled
          ? null
          : h(
              "button",
              {
                class: "btn btn-ghost",
                type: "button",
                title: "Cancel this distro and move booked families to the rebooking queue",
                onclick: () => doCancel(d),
              },
              "Cancel"
            )
      );
    }

    // Cancel a distro: booked families are moved to the rebooking queue so
    // nobody shows up outside a closed venue claiming a cita.
    async function doCancel(d) {
      const when = fmtDateTime(d.date_time) || d.date_time;
      if (
        !confirm(
          `Cancel the ${when} distro?\n\nEvery booked family is moved to the rebooking queue (Outreach → Needs rebooking) so they can be given a new appointment.`
        )
      ) {
        return;
      }
      const reason = prompt("Reason (optional — shown on the distro):") || "";
      try {
        const out = await api.cancelDistro(d.id, reason.trim() ? { reason: reason.trim() } : {});
        const n = (out.rebooked_household_ids || []).length;
        toast(
          n
            ? `Cancelled — ${n} ${n === 1 ? "family" : "families"} moved to the rebooking queue (see Outreach).`
            : "Cancelled — nobody was booked yet.",
          "success"
        );
        await loadDistros();
      } catch (err) {
        toast(err.detail || "Could not cancel the distro.", "error");
      }
    }

    // ---- post-distro inventory count ----------------------------------------
    // The structured version of the "POST DISTRO INVENTORY" message the crew
    // used to type into chat: count what's left, and the stock levels feed
    // outreach ("in-stock only") and the waitlist board automatically.
    function renderInventoryCard() {
      const wrap = h(
        "details",
        { class: "advanced" },
        h("summary", {}, "📦 Post-distro inventory count")
      );
      const body = h("div", { class: "card stack", style: { marginTop: "var(--s3)" } });
      wrap.append(body);
      let loaded = false;

      wrap.addEventListener("toggle", () => {
        if (wrap.open && !loaded) {
          loaded = true;
          void loadInventory();
        }
      });

      async function loadInventory() {
        clear(body).append(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading stock…"));
        try {
          const inv = await api.inventory();
          drawForm(inv);
        } catch (err) {
          clear(body).append(h("div", { class: "empty-state" }, (err && err.detail) || "Could not load inventory."));
        }
      }

      function shortLabel(label, key) {
        const parts = String(label || "").split("/").map((s) => s.trim()).filter(Boolean);
        return parts[1] || parts[0] || key;
      }

      function drawForm(inv) {
        clear(body);
        const inputs = new Map();
        const rows = (inv.items || []).map((it) => {
          const input = h("input", {
            class: "input",
            type: "number",
            min: "0",
            value: it.on_hand != null ? String(it.on_hand) : "",
            placeholder: "—",
            "aria-label": `${shortLabel(it.label, it.type)} on hand`,
            style: { width: "84px" },
          });
          inputs.set(it.type, input);
          return h(
            "li",
            { class: "list-item" },
            h(
              "div",
              { class: "list-item__body" },
              h("div", { class: "list-item__label" }, shortLabel(it.label, it.type)),
              it.on_hand === 0
                ? h("div", { class: "list-item__meta", style: { color: "var(--danger)" } }, "OUT — outreach skips this when “in stock only” is on")
                : it.updated_at
                  ? h("div", { class: "list-item__meta" }, `updated ${fmtDate(it.updated_at)} by ${it.updated_by || "—"}`)
                  : h("div", { class: "list-item__meta" }, "not tracked yet — leave blank to keep it that way"),
            ),
            input
          );
        });

        const dateInput = h("input", { class: "input", type: "date", value: todayLocalIso(), "aria-label": "Count date" });
        const notesInput = h("input", {
          class: "input",
          type: "text",
          placeholder: "e.g. buyer: Alicia · counted by Sam (optional)",
          "aria-label": "Count notes",
        });
        const saveBtn = h(
          "button",
          {
            class: "btn btn-primary btn-block",
            type: "button",
            onclick: async () => {
              const counts = {};
              for (const [type, input] of inputs) {
                if (input.value.trim() !== "") counts[type] = Number(input.value);
              }
              if (!Object.keys(counts).length) {
                toast("Enter at least one count — blank items stay untracked.", "info");
                return;
              }
              saveBtn.disabled = true;
              try {
                const out = await api.recordInventory({
                  date: dateInput.value,
                  counts,
                  notes: notesInput.value.trim() || undefined,
                });
                toast(`Inventory saved — ${out.counted} items counted. Stock levels updated everywhere.`, "success");
                await loadInventory();
              } catch (err) {
                toast((err && err.detail) || "Could not save the count.", "error");
              } finally {
                saveBtn.disabled = false;
              }
            },
          },
          "Save count"
        );

        body.append(
          h(
            "p",
            { class: "muted", style: { margin: "0" } },
            "Count what's on the shelves after the distro. Deliveries at check-in subtract automatically between counts; an item at 0 is skipped by “in stock only” outreach."
          ),
          h("div", { class: "row" }, h("div", { class: "field grow" }, h("span", { class: "label" }, "Count date"), dateInput)),
          h("ul", { class: "list" }, rows),
          h("div", { class: "field" }, h("span", { class: "label" }, "Notes"), notesInput),
          saveBtn,
          (inv.history || []).length
            ? h(
                "div",
                { class: "stack", style: { gap: "var(--s1)" } },
                h("div", { class: "section-title" }, "Past counts"),
                ...(inv.history || []).slice(0, 5).map((c) =>
                  h(
                    "div",
                    { class: "list-item__meta" },
                    `${fmtDate(c.date)} by ${c.by}: ${Object.keys(c.counts).length} items${c.notes ? ` — ${c.notes}` : ""}`
                  )
                )
              )
            : null
        );
      }

      return wrap;
    }

    // ---- slot usage check --------------------------------------------------

    function renderSlotUsageCard() {
      const dateInput = h("input", {
        class: "input",
        id: "slot-usage-date",
        type: "date",
        value: todayLocalIso(),
        "aria-label": "Date to check",
      });
      const out = h("div", {});
      const checkBtn = h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            checkBtn.disabled = true;
            try {
              const usage = await api.slotUsage(dateInput.value);
              clear(out);
              const entries = Object.entries(usage.usage || {}).sort((a, b) =>
                a[0].localeCompare(b[0])
              );
              const cap = usage.slot_capacity;
              out.append(
                h(
                  "div",
                  { class: "list-item__meta", style: { marginTop: "var(--s2)" } },
                  cap != null ? `Cap: ${cap} per 30-min slot.` : "No slot cap set for this date."
                ),
                entries.length
                  ? h(
                      "ul",
                      { class: "list" },
                      entries.map(([time, n]) =>
                        h(
                          "li",
                          { class: "list-item" },
                          h("span", { class: "list-item__label" }, time || "No time set"),
                          h(
                            "span",
                            {
                              class: `badge ${cap != null && n >= cap ? "badge-timeout" : "badge-open"} mono`,
                              title: cap != null && n >= cap ? "At or over capacity" : "",
                            },
                            cap != null ? `${n} / ${cap}` : String(n)
                          )
                        )
                      )
                    )
                  : h("div", { class: "list-item__meta" }, "No bookings for this date yet.")
              );
            } catch (err) {
              toast(err.detail || "Could not check slot usage.", "error");
            } finally {
              checkBtn.disabled = false;
            }
          },
        },
        "Check"
      );
      return h(
        "div",
        { class: "card stack" },
        h("h2", { class: "card__title" }, "Booking load by slot"),
        h(
          "p",
          { class: "muted", style: { margin: "0" } },
          "See how full each 30-minute slot is for a day before texting another round."
        ),
        h("div", { class: "row" }, h("div", { class: "grow" }, dateInput), checkBtn),
        out
      );
    }

    function renderListError(err) {
      clear(listRegion);
      listRegion.append(
        h(
          "div",
          { class: "card empty-state" },
          h("div", { class: "empty-state__icon" }, "⚠️"),
          h("div", {}, (err && err.detail) || "Could not load distributions."),
          h("button", { class: "btn", onclick: loadDistros }, "Try again")
        )
      );
    }

    // ---- (B) no-show pass ------------------------------------------------

    function renderNoShowCard() {
      renderNoShowInner();
      return noShowRegion;
    }

    function renderNoShowInner() {
      clear(noShowRegion);

      // Default the date input to today for convenience.
      const dateInput = h("input", {
        class: "input",
        id: "noshow-date",
        name: "distro_date",
        type: "date",
        value: todayLocalIso(),
        "aria-label": "Distribution date",
      });

      const runBtn = h(
        "button",
        {
          class: state.confirmingNoShow ? "btn btn-danger btn-block" : "btn btn-block",
          type: "button",
          disabled: state.runningNoShow,
          "aria-describedby": "noshow-help",
          onclick: () => onRunNoShow(dateInput),
        },
        state.runningNoShow
          ? "Running…"
          : state.confirmingNoShow
          ? "Confirm — mark no-shows missed"
          : "Run no-show pass"
      );

      // Second element of the confirm state: a way to back out.
      const cancelBtn = state.confirmingNoShow
        ? h(
            "button",
            {
              class: "btn btn-ghost btn-block",
              type: "button",
              disabled: state.runningNoShow,
              onclick: () => {
                state.confirmingNoShow = false;
                renderNoShowInner();
              },
            },
            "Cancel"
          )
        : null;

      const card = h(
        "div",
        { class: "card stack" },
        h("h2", { class: "card__title" }, "End-of-distro no-show pass"),
        h(
          "p",
          { class: "muted", id: "noshow-help" },
          "Marks booked households that didn't attend as Missed and clears their appointment. Anyone hitting their 2nd miss has their open requests timed out. This changes household records — pick the distribution's date, then confirm."
        ),
        field("noshow-date", "Distribution date", dateInput),
        state.confirmingNoShow
          ? h(
              "p",
              { class: "muted", role: "alert" },
              "This will update every booked household on that date. Confirm to proceed."
            )
          : null,
        runBtn,
        cancelBtn
      );

      noShowRegion.append(card);
    }

    function onRunNoShow(dateInput) {
      const date = (dateInput.value || "").trim();
      if (!date) {
        toast("Pick the distribution date first.", "info");
        dateInput.focus();
        return;
      }
      // First click arms the confirm; second click actually runs it.
      if (!state.confirmingNoShow) {
        state.confirmingNoShow = true;
        renderNoShowInner();
        return;
      }
      doNoShow(date);
    }

    async function doNoShow(date) {
      state.runningNoShow = true;
      renderNoShowInner();
      try {
        const report = await api.noShows({ distro_date: date });
        state.confirmingNoShow = false;
        state.runningNoShow = false;
        renderNoShowInner();
        renderNoShowReport(date, report);
        const missed = (report.missed_household_ids || []).length;
        toast(
          missed
            ? `No-show pass complete — ${missed} marked missed.`
            : "No-show pass complete — no missed households.",
          "success"
        );
      } catch (err) {
        state.runningNoShow = false;
        renderNoShowInner();
        toast(err.detail || "No-show pass failed.", "error");
      }
    }

    // Append/replace the report summary below the no-show card.
    function renderNoShowReport(date, report) {
      const existing = document.getElementById("noshow-report");
      if (existing) existing.remove();

      const missed = report.missed_household_ids || [];
      const timedOut = report.timed_out_household_ids || [];

      const card = h(
        "div",
        { id: "noshow-report", class: "card stack" },
        h(
          "div",
          { class: "row row--between" },
          h("h2", { class: "card__title", style: { margin: "0" } }, "No-show report"),
          h("span", { class: "pill" }, fmtDate(date))
        ),
        h(
          "ul",
          { class: "list" },
          h(
            "li",
            { class: "list-item" },
            h("span", { class: `badge badge-timeout` }, missed.length),
            h(
              "div",
              { class: "list-item__body" },
              h("div", { class: "list-item__label" }, "Marked missed"),
              h(
                "div",
                { class: "list-item__meta" },
                missed.length
                  ? `Households: ${missed.join(", ")}`
                  : "No booked households missed this distribution."
              )
            )
          ),
          h(
            "li",
            { class: "list-item" },
            h("span", { class: `badge badge-timeout` }, timedOut.length),
            h(
              "div",
              { class: "list-item__body" },
              h(
                "div",
                { class: "list-item__label" },
                "Timed out at 2nd miss"
              ),
              h(
                "div",
                { class: "list-item__meta" },
                timedOut.length
                  ? `Open requests timed out for households: ${timedOut.join(", ")}`
                  : "No households reached their 2nd missed appointment."
              )
            )
          )
        )
      );

      noShowRegion.append(card);
    }

    // ---- small helpers ---------------------------------------------------

    // A labeled form field wrapping any input/control.
    function field(id, labelText, control) {
      return h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: id }, labelText),
        control
      );
    }

    // "YYYY-MM-DD" for today in the operator's local timezone.
    function todayLocalIso() {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }

  window.BAM.registerView("distros", {
    title: "Distros",
    icon: "📦",
    render,
  });
})();
