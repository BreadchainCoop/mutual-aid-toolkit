/* Outreach view (spec 6.2 + 6.4 A4–A6) — the pre-distro outreach console.
 *
 * Two panels:
 *  (A) Build list: filters (request types, languages, recency exclusions,
 *      limit) -> POST /outreach/list -> selectable candidate rows.
 *  (B) Send blast: a templated text (supports [FIRST_NAME] / [REQUEST_URL])
 *      -> POST /outreach/blast for the checked household_ids -> report counts.
 *
 * Each candidate also gets an inline action row to book an appointment
 * (POST /households/{id}/appointment) or record a phone-outreach outcome
 * (POST /households/{id}/outreach-outcome, A4–A6).
 *
 * Mirrors views/checkin.js for structure, loading/empty/error states, and use
 * of BAM.h / BAM.api / the shared component classes. */

(function () {
  "use strict";

  const { h, clear, toast, api, fmtDate, fmtDateTime } = window.BAM;

  // Shared language vocabulary (BAM.LANGUAGES, app.js): the exact strings
  // intake writes, so exact-string filtering (spec 6.2 step 1) matches.
  const COMMON_LANGUAGES = window.BAM.LANGUAGES;

  const DEFAULT_TEMPLATE =
    "Hola [FIRST_NAME]! BAM tiene una distribución próximamente. " +
    "Responde para reservar tu cita. Actualiza tus pedidos aquí: [REQUEST_URL]";

  const OUTCOME_OPTIONS = [
    { value: "no_response_timeout", label: "No response (times out requests)" },
    { value: "wrong_number", label: "Wrong number (marks invalid + times out)" },
    { value: "no_longer_needed", label: "No longer needs goods (times out)" },
    { value: "emailed", label: "Emailed them (stamps last emailed)" },
  ];

  function render(container) {
    // ---- view state ------------------------------------------------------
    const state = {
      candidates: null, // last [OutreachCandidate] from the API (null = not run)
      listLoading: false,
      blasting: false,
      channel: "sms", // "sms" | "email" — email reaches the phone-unreachable
      interpreterOnly: false, // client-side filter: unsupported-language rows
    };
    // Selected household ids, preserved across candidate re-renders.
    const selected = new Set();
    // Custom (free-text-added) request types the operator added.
    const customRequestTypes = new Set();

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Outreach"),
      h(
        "p",
        { class: "muted" },
        "Build a filtered list of households with open requests, then text a blast, book appointments, or record call outcomes."
      )
    );

    // ---------------------------------------------------------------- Panel A
    // Request types: free-text add -> pills.
    const requestTypeInput = h("input", {
      class: "input",
      id: "out-req-type",
      type: "text",
      autocomplete: "off",
      placeholder: "e.g. pots_pans, soap, or a full label",
      "aria-label": "Add a request type filter",
      onkeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addRequestType();
        }
      },
    });
    const requestTypePills = h("div", { class: "row", id: "out-req-pills" });

    // Language filter — compact chip-toggle picker (see BAM.langPicker).
    const langPick = BAM.langPicker({});

    const excludeTextedInput = h("input", {
      class: "input",
      id: "out-excl-texted",
      type: "number",
      min: "0",
      inputmode: "numeric",
      value: "0",
      "aria-label": "Exclude texted within days",
    });
    const excludeAttendedInput = h("input", {
      class: "input",
      id: "out-excl-attended",
      type: "number",
      min: "0",
      inputmode: "numeric",
      value: "0",
      "aria-label": "Exclude attended within days",
    });
    const limitInput = h("input", {
      class: "input",
      id: "out-limit",
      type: "number",
      min: "1",
      inputmode: "numeric",
      placeholder: "No limit",
      "aria-label": "Limit",
    });

    const buildBtn = h(
      "button",
      { class: "btn btn-primary btn-block", type: "submit" },
      "Build list"
    );

    // Channel toggle: SMS (default) or Email — the email list is exactly the
    // households the 3-texts-3-calls rule can never reach (no usable phone,
    // but a working email on file).
    const channelWrap = h("div", { class: "row", id: "out-channel" });
    function renderChannelToggle() {
      clear(channelWrap);
      [["sms", "💬 Text (SMS)"], ["email", "✉️ Email"]].forEach(([value, label]) => {
        const on = state.channel === value;
        channelWrap.append(
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
                state.channel = value;
                renderChannelToggle();
                syncChannelUi();
              },
            },
            (on ? "✓ " : "") + label
          )
        );
      });
    }

    // Rebooking-only: households whose booked distro was cancelled.
    const rebookingBox = h("input", { type: "checkbox", id: "out-rebooking" });
    const rebookingRow = h(
      "label",
      { class: "row", for: "out-rebooking", style: { gap: "var(--s2)", cursor: "pointer" } },
      rebookingBox,
      h("span", {}, "🔁 Needs rebooking only (cancelled-distro queue)")
    );

    const filtersForm = h(
      "form",
      {
        class: "card stack",
        onsubmit: (e) => {
          e.preventDefault();
          doBuildList();
        },
      },
      h("h2", { class: "card__title" }, "1 · Build outreach list"),
      // Channel
      h(
        "div",
        { class: "field" },
        h("span", { class: "label" }, "Channel"),
        channelWrap,
        h(
          "div",
          { class: "list-item__meta" },
          "Email reaches households with no working phone — the people texts and calls can never book."
        )
      ),
      rebookingRow,
      // Request types
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "out-req-type" }, "Request types (optional)"),
        h(
          "div",
          { class: "row" },
          h("div", { class: "grow" }, requestTypeInput),
          h(
            "button",
            { class: "btn", type: "button", onclick: addRequestType },
            "Add"
          )
        ),
        h(
          "div",
          { class: "list-item__meta" },
          "Match households with an open request of any listed type. Leave empty for all types."
        ),
        requestTypePills
      ),
      // Languages
      h(
        "div",
        { class: "field" },
        h("span", { class: "label" }, "Languages (optional)"),
        langPick.el
      ),
      // Recency + limit
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "field grow" },
          h("label", { class: "label", for: "out-excl-texted" }, "Exclude texted within (days)"),
          excludeTextedInput
        ),
        h(
          "div",
          { class: "field grow" },
          h("label", { class: "label", for: "out-excl-attended" }, "Exclude attended within (days)"),
          excludeAttendedInput
        )
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "out-limit" }, "Limit (optional)"),
        limitInput
      ),
      buildBtn
    );

    // Candidate results region, replaced on each build.
    const listResult = h("div", { id: "out-list-result" });

    // ---------------------------------------------------------------- Panel B
    const templateInput = h("textarea", {
      class: "input",
      id: "out-template",
      rows: "4",
      "aria-label": "Blast message template",
    });
    templateInput.value = DEFAULT_TEMPLATE;

    // Optional per-language messages. When any is filled, they override the
    // single template above and each household is routed to its language
    // (Quechua→Spanish, Mandarin→Cantonese, English only if sole; otherwise
    // Spanish+Cantonese+English concatenated). Server-side resolve_send_language.
    const langTemplateInputs = {};
    for (const lang of ["Spanish", "Cantonese", "English"]) {
      langTemplateInputs[lang] = h("textarea", {
        class: "input",
        rows: "2",
        "aria-label": `${lang} message`,
        placeholder: `${lang} message (optional)`,
      });
    }

    const maxMessagesInput = h("input", {
      class: "input",
      id: "out-max-msgs",
      type: "number",
      min: "1",
      inputmode: "numeric",
      placeholder: "Server default",
      "aria-label": "Max messages",
    });

    // Subject line — email blasts only; hidden in SMS mode.
    const subjectInput = h("input", {
      class: "input",
      id: "out-subject",
      type: "text",
      autocomplete: "off",
      placeholder: "e.g. BAM: book your distro appointment",
      "aria-label": "Email subject",
    });
    const subjectField = h(
      "div",
      { class: "field", style: { display: "none" } },
      h("label", { class: "label", for: "out-subject" }, "Email subject"),
      subjectInput
    );

    function syncChannelUi() {
      const email = state.channel === "email";
      subjectField.style.display = email ? "" : "none";
      sendBtn.textContent = `Send ${email ? "emails" : "to selected"} (${selected.size})`;
    }

    const sendBtn = h(
      "button",
      { class: "btn btn-primary btn-block", type: "button", onclick: doBlast },
      "Send to selected (0)"
    );

    const blastResult = h("div", { id: "out-blast-result" });

    const blastCard = h(
      "form",
      {
        class: "card stack",
        onsubmit: (e) => {
          e.preventDefault();
          doBlast();
        },
      },
      h("h2", { class: "card__title" }, "2 · Send text blast"),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "out-template" }, "Message template"),
        templateInput,
        h(
          "div",
          { class: "list-item__meta" },
          "Placeholders: [FIRST_NAME] and [REQUEST_URL] are filled per household by the server."
        )
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label" }, "Per-language messages (optional — override the template above)"),
        h(
          "div",
          { class: "list-item__meta" },
          "Routing: Quechua→Spanish, Mandarin→Cantonese, English only if it's the sole language, otherwise all three concatenated."
        ),
        ...["Spanish", "Cantonese", "English"].map((lang) =>
          h(
            "div",
            { class: "field" },
            h("label", { class: "label" }, lang),
            langTemplateInputs[lang]
          )
        )
      ),
      subjectField,
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "out-max-msgs" }, "Max messages (optional)"),
        maxMessagesInput
      ),
      // Provider note — sends go through the server-configured provider.
      h(
        "div",
        {
          class: "list-item",
          style: { background: "var(--brand-soft)", borderColor: "var(--brand)" },
        },
        h("span", { "aria-hidden": "true" }, "📣"),
        h(
          "div",
          { class: "list-item__body" },
          h("div", { class: "list-item__label" }, "Sends use the server-configured SMS provider"),
          h(
            "div",
            { class: "list-item__meta" },
            "By default this is the console (dry) provider — messages are logged, not delivered. Twilio must be enabled server-side to actually text recipients."
          )
        )
      ),
      sendBtn,
      blastResult
    );

    // ---- mount -----------------------------------------------------------
    clear(container);
    container.append(heading, filtersForm, listResult, blastCard);

    renderRequestTypePills();
    renderChannelToggle();
    renderListPlaceholder();
    updateSendButton();
    syncChannelUi();

    // ---- Panel A: filter editing ----------------------------------------

    function addRequestType() {
      const raw = requestTypeInput.value.trim();
      if (!raw) return;
      customRequestTypes.add(raw);
      requestTypeInput.value = "";
      renderRequestTypePills();
      requestTypeInput.focus();
    }

    function renderRequestTypePills() {
      clear(requestTypePills);
      if (!customRequestTypes.size) {
        requestTypePills.append(
          h("span", { class: "muted", style: { fontSize: "13px" } }, "All request types")
        );
        return;
      }
      customRequestTypes.forEach((t) => {
        requestTypePills.append(
          h(
            "button",
            {
              type: "button",
              class: "pill",
              style: { cursor: "pointer" },
              title: "Remove filter",
              "aria-label": `Remove request type ${t}`,
              onclick: () => {
                customRequestTypes.delete(t);
                renderRequestTypePills();
              },
            },
            `${t} ✕`
          )
        );
      });
    }

    // ---- Panel A: build the list ----------------------------------------

    function readFilters() {
      const filters = {
        exclude_texted_within_days: toNonNegInt(excludeTextedInput.value, 0),
        exclude_attended_within_days: toNonNegInt(excludeAttendedInput.value, 0),
      };
      if (state.channel === "email") filters.channel = "email";
      if (rebookingBox.checked) filters.rebooking_only = true;
      if (customRequestTypes.size) filters.request_types = [...customRequestTypes];
      const langs = langPick.getSelected();
      if (langs.length) filters.languages = langs;
      const limit = parseInt(limitInput.value, 10);
      if (Number.isFinite(limit) && limit > 0) filters.limit = limit;
      return filters;
    }

    // Disable the Build button while a list is loading (prevents double-submit).
    function setListBusy(busy) {
      buildBtn.disabled = !!busy;
      buildBtn.textContent = busy ? "Building…" : "Build list";
    }

    async function doBuildList() {
      setListBusy(true);
      renderListLoading();
      try {
        const rows = await api.outreachList(readFilters());
        state.candidates = Array.isArray(rows) ? rows : [];
        // Drop selections for candidates no longer in the list.
        const ids = new Set(state.candidates.map((c) => c.household_id));
        [...selected].forEach((id) => {
          if (!ids.has(id)) selected.delete(id);
        });
        renderCandidates();
        updateSendButton();
      } catch (err) {
        state.candidates = null;
        renderListError(err);
        toast((err && err.detail) || "Could not build the list.", "error");
      } finally {
        setListBusy(false);
      }
    }

    // ---- Panel A: rendering ---------------------------------------------

    function renderListPlaceholder() {
      clear(listResult);
      listResult.append(
        h(
          "div",
          { class: "card empty-state" },
          h("div", { class: "empty-state__icon" }, "📋"),
          h("div", {}, "Set filters above and build a list to see candidates.")
        )
      );
    }

    function renderListLoading() {
      clear(listResult);
      listResult.append(
        h(
          "div",
          { class: "card" },
          h(
            "div",
            { class: "loading" },
            h("span", { class: "spinner", role: "status", "aria-label": "Loading" }),
            "Building list…"
          )
        )
      );
    }

    function renderListError(err) {
      clear(listResult);
      listResult.append(
        h(
          "div",
          { class: "card empty-state" },
          h("div", { class: "empty-state__icon" }, "⚠️"),
          h("div", {}, (err && err.detail) || "Something went wrong."),
          h("button", { class: "btn", onclick: doBuildList }, "Try again")
        )
      );
    }

    function renderCandidates() {
      clear(listResult);
      const rows = state.candidates || [];

      if (!rows.length) {
        listResult.append(
          h(
            "div",
            { class: "card empty-state" },
            h("div", { class: "empty-state__icon" }, "🔍"),
            h("div", {}, "No households match these filters."),
            h("p", { class: "muted" }, "Loosen the filters or clear the recency exclusions.")
          )
        );
        return;
      }

      // Header with count + select-all control.
      const selectAll = h("input", {
        type: "checkbox",
        id: "out-select-all",
        checked: rows.length > 0 && rows.every((c) => selected.has(c.household_id)),
        onchange: (e) => {
          if (e.target.checked) rows.forEach((c) => selected.add(c.household_id));
          else rows.forEach((c) => selected.delete(c.household_id));
          renderCandidates();
          updateSendButton();
        },
      });

      const shown = state.interpreterOnly ? rows.filter((c) => c.unsupported_language) : rows;

      const interpreterBox = h("input", {
        type: "checkbox",
        id: "out-interp-only",
        checked: state.interpreterOnly,
        onchange: (e) => {
          state.interpreterOnly = e.target.checked;
          renderCandidates();
        },
      });

      const header = h(
        "div",
        { class: "row row--between", style: { flexWrap: "wrap", gap: "var(--s2)" } },
        h(
          "h2",
          { class: "card__title", style: { margin: "0" } },
          `${shown.length} candidate${shown.length === 1 ? "" : "s"}${state.interpreterOnly ? ` (of ${rows.length})` : ""}`
        ),
        h(
          "span",
          { class: "row", style: { gap: "var(--s3)", flexWrap: "wrap" } },
          h(
            "label",
            { class: "row", for: "out-interp-only", style: { gap: "var(--s2)", cursor: "pointer" } },
            interpreterBox,
            h("span", { class: "label" }, "🌐 Interpreter needed only")
          ),
          h(
            "label",
            { class: "row", for: "out-select-all", style: { gap: "var(--s2)", cursor: "pointer" } },
            selectAll,
            h("span", { class: "label" }, "Select all")
          )
        )
      );

      // Cancelled-distro fallout is easy to lose in a big list — surface it.
      const rebookCount = rows.filter((c) => c.needs_rebooking).length;
      const rebookBanner =
        rebookCount && !rebookingBox.checked
          ? h(
              "div",
              { class: "list-item", style: { background: "var(--warn-soft)", borderColor: "var(--warn)" } },
              h("span", { "aria-hidden": "true" }, "🔁"),
              h(
                "span",
                { class: "list-item__body" },
                `${rebookCount} ${rebookCount === 1 ? "family" : "families"} in this list had a distro cancelled and need new appointments.`
              )
            )
          : null;

      const list = h(
        "ul",
        { class: "list" },
        shown.map((c) => candidateRow(c))
      );

      listResult.append(h("div", { class: "card stack" }, header, rebookBanner, list));
    }

    function candidateRow(c) {
      const checkbox = h("input", {
        type: "checkbox",
        id: `out-cand-${c.household_id}`,
        checked: selected.has(c.household_id),
        "aria-label": `Select ${c.name || "household " + c.household_id}`,
        onchange: (e) => {
          if (e.target.checked) selected.add(c.household_id);
          else selected.delete(c.household_id);
          updateSendButton();
          syncSelectAll();
        },
      });

      // Open request types as pills.
      const typePills = (c.open_request_types || []).length
        ? h(
            "div",
            { class: "row", style: { marginTop: "var(--s1)" } },
            (c.open_request_types || []).map((t) => h("span", { class: "pill" }, t))
          )
        : null;

      const metaBits = [];
      if (state.channel === "email") {
        if (c.email) metaBits.push(h("span", { class: "mono" }, c.email));
        else metaBits.push(h("span", { class: "badge badge-timeout" }, "no email"));
      } else if (c.phone_number) {
        metaBits.push(h("span", { class: "mono" }, c.phone_number));
      } else {
        metaBits.push(h("span", { class: "badge badge-timeout" }, "no phone"));
      }
      if (c.oldest_open_request_at) {
        metaBits.push(h("span", {}, `oldest ${fmtDate(c.oldest_open_request_at)}`));
      }
      if (c.last_texted) metaBits.push(h("span", {}, `texted ${fmtDate(c.last_texted)}`));

      const flagBits = [];
      if (c.preferred_language) {
        flagBits.push(
          h(
            "span",
            { class: "pill", title: "Preferred language" },
            `★ ${window.BAM.langShort ? window.BAM.langShort(c.preferred_language) : c.preferred_language}`
          )
        );
      }
      if (c.unsupported_language) {
        flagBits.push(
          h(
            "span",
            { class: "badge badge-timeout", title: "No catalog-supported language — route to an interpreter" },
            "🌐 interpreter"
          )
        );
      }
      if (c.needs_rebooking) {
        flagBits.push(
          h("span", { class: "badge badge-timeout", title: "Their distro was cancelled" }, "🔁 rebooking")
        );
      }

      const body = h(
        "label",
        { class: "list-item__body", for: checkbox.id },
        h("div", { class: "list-item__label" }, c.name || `Household #${c.household_id}`),
        c.languages && c.languages.length
          ? h("div", { class: "list-item__meta" }, c.languages.join(", "))
          : null,
        h(
          "div",
          { class: "list-item__meta row", style: { gap: "var(--s2)" } },
          metaBits
        ),
        flagBits.length ? h("div", { class: "row", style: { marginTop: "var(--s1)" } }, flagBits) : null,
        typePills
      );

      // Per-candidate action region (book appointment / record outcome),
      // toggled open by the "Actions" button so rows stay compact.
      const actionRegion = h("div", { style: { display: "none", width: "100%" } });
      const actionsBtn = h(
        "button",
        {
          type: "button",
          class: "btn btn-ghost",
          "aria-expanded": "false",
          onclick: () => {
            const open = actionRegion.style.display !== "none";
            actionRegion.style.display = open ? "none" : "block";
            actionsBtn.setAttribute("aria-expanded", String(!open));
            if (!open && !actionRegion.firstChild) {
              actionRegion.append(candidateActions(c));
            }
          },
        },
        "Actions"
      );

      const top = h(
        "div",
        { class: "row", style: { width: "100%", alignItems: "flex-start" } },
        checkbox,
        body,
        actionsBtn
      );

      return h(
        "li",
        { class: "list-item", style: { flexDirection: "column", alignItems: "stretch" } },
        top,
        actionRegion
      );
    }

    // Book-appointment + record-outcome controls for one candidate.
    function candidateActions(c) {
      const wrap = h("div", { class: "stack", style: { marginTop: "var(--s3)" } });

      // -- Book appointment
      const apptDate = h("input", {
        class: "input",
        type: "date",
        id: `out-appt-date-${c.household_id}`,
        "aria-label": "Appointment date",
      });
      const apptTime = h("input", {
        class: "input",
        type: "time",
        id: `out-appt-time-${c.household_id}`,
        "aria-label": "Appointment time",
      });
      const bookBtn = h(
        "button",
        { type: "button", class: "btn btn-primary" },
        "Book appointment"
      );
      // Live booking-pressure hint: when a date is picked, show that day's
      // slot cap and busiest times so schedulers stop double-booking blind.
      const slotHint = h("div", { class: "list-item__meta" });
      apptDate.addEventListener("change", async () => {
        slotHint.textContent = "";
        if (!apptDate.value) return;
        try {
          const usage = await api.slotUsage(apptDate.value);
          const entries = Object.entries(usage.usage || {}).sort((a, b) => b[1] - a[1]);
          const bits = [];
          if (usage.slot_capacity != null) bits.push(`cap ${usage.slot_capacity}/slot`);
          if (entries.length) {
            bits.push(`busiest: ${entries.slice(0, 3).map(([t, n]) => `${t || "no time"} (${n})`).join(", ")}`);
          } else {
            bits.push("no bookings yet");
          }
          slotHint.textContent = bits.join(" · ");
        } catch (_e) {
          /* hint only */
        }
      });

      bookBtn.addEventListener("click", async () => {
        const date = apptDate.value;
        const time = apptTime.value;
        if (!date || !time) {
          toast("Pick a date and time to book.", "info");
          return;
        }
        bookBtn.disabled = true;
        bookBtn.textContent = "Booking…";
        const book = async (force) =>
          api.bookAppointment(c.household_id, {
            appointment_date: date,
            appointment_time: time,
            ...(force ? { force: true } : {}),
          });
        try {
          let hh;
          try {
            hh = await book(false);
          } catch (err) {
            // Slot at capacity: offer an explicit override instead of failing.
            if (err && err.status === 409) {
              if (!confirm(`${err.detail || "That slot is full."}\n\nBook anyway?`)) {
                throw err;
              }
              hh = await book(true);
            } else {
              throw err;
            }
          }
          toast(`Appointment booked for ${hh.name || "household"} on ${fmtDate(hh.appointment_date)}.`, "success");
          markOutcome(wrap, `✅ Booked ${fmtDate(hh.appointment_date)}${hh.appointment_time ? " · " + hh.appointment_time : ""}`);
        } catch (err) {
          toast((err && err.detail) || "Could not book appointment.", "error");
          bookBtn.disabled = false;
          bookBtn.textContent = "Book appointment";
        }
      });

      const bookGroup = h(
        "div",
        { class: "stack" },
        h("div", { class: "section-title", style: { margin: "0" } }, "Book appointment"),
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "field grow" },
            h("label", { class: "label", for: apptDate.id }, "Date"),
            apptDate
          ),
          h(
            "div",
            { class: "field grow" },
            h("label", { class: "label", for: apptTime.id }, "Time"),
            apptTime
          )
        ),
        slotHint,
        bookBtn
      );

      // -- Record outcome
      const outcomeSelect = h(
        "select",
        { class: "input", id: `out-outcome-${c.household_id}`, "aria-label": "Outreach outcome" },
        OUTCOME_OPTIONS.map((o) => h("option", { value: o.value }, o.label))
      );
      const outcomeNote = h("input", {
        class: "input",
        type: "text",
        id: `out-outcome-note-${c.household_id}`,
        autocomplete: "off",
        placeholder: "Optional note",
        "aria-label": "Outcome note",
      });
      const outcomeBtn = h(
        "button",
        { type: "button", class: "btn btn-danger" },
        "Record outcome"
      );
      outcomeBtn.addEventListener("click", async () => {
        outcomeBtn.disabled = true;
        outcomeBtn.textContent = "Recording…";
        try {
          const hh = await api.recordOutcome(c.household_id, {
            outcome: outcomeSelect.value,
            note: outcomeNote.value.trim() || undefined,
          });
          const chosen = OUTCOME_OPTIONS.find((o) => o.value === outcomeSelect.value);
          toast(`Recorded: ${chosen ? chosen.label : outcomeSelect.value}.`, "success");
          // A5 (wrong number) drops the phone / flags invalid — reflect it.
          const detail =
            hh && hh.invalid_phone_number
              ? "⚠️ Marked invalid number — requests timed out"
              : `✅ Outcome recorded (${outcomeSelect.value})`;
          markOutcome(wrap, detail);
          // Remove from the current selection; they're out of the queue now.
          selected.delete(c.household_id);
          updateSendButton();
        } catch (err) {
          toast((err && err.detail) || "Could not record outcome.", "error");
          outcomeBtn.disabled = false;
          outcomeBtn.textContent = "Record outcome";
        }
      });

      const outcomeGroup = h(
        "div",
        { class: "stack" },
        h("div", { class: "section-title", style: { margin: "0" } }, "Record call outcome (A4–A6)"),
        h(
          "div",
          { class: "field" },
          h("label", { class: "label", for: outcomeSelect.id }, "Outcome"),
          outcomeSelect
        ),
        h(
          "div",
          { class: "field" },
          h("label", { class: "label", for: outcomeNote.id }, "Note (optional)"),
          outcomeNote
        ),
        outcomeBtn
      );

      wrap.append(bookGroup, h("hr", { class: "divider" }), outcomeGroup);
      return wrap;
    }

    // Append a small confirmation banner inside an action region.
    function markOutcome(wrap, text) {
      const banner = h(
        "div",
        {
          class: "list-item",
          style: { background: "var(--ok-soft)", borderColor: "var(--ok)" },
        },
        h("span", { class: "list-item__body", style: { color: "var(--ok)", fontWeight: "600" } }, text)
      );
      wrap.append(banner);
    }

    function syncSelectAll() {
      const all = document.getElementById("out-select-all");
      if (!all || !state.candidates) return;
      const rows = state.candidates;
      all.checked = rows.length > 0 && rows.every((c) => selected.has(c.household_id));
    }

    // ---- Panel B: blast --------------------------------------------------

    function updateSendButton() {
      const n = selected.size;
      sendBtn.textContent = `Send ${state.channel === "email" ? "emails" : "to selected"} (${n})`;
      sendBtn.disabled = state.blasting || n === 0;
    }

    async function doBlast() {
      const household_ids = [...selected];
      if (!household_ids.length) {
        toast("Select at least one candidate to text.", "info");
        return;
      }
      const templates = {};
      for (const [lang, input] of Object.entries(langTemplateInputs)) {
        const value = input.value.trim();
        if (value) templates[lang] = value;
      }
      const useTemplates = Object.keys(templates).length > 0;
      const template = templateInput.value.trim();
      if (!useTemplates && !template) {
        toast("Enter a message template (single or per-language).", "info");
        templateInput.focus();
        return;
      }
      const payload = { household_ids };
      if (useTemplates) payload.templates = templates;
      else payload.template = template;
      if (state.channel === "email") {
        payload.channel = "email";
        const subject = subjectInput.value.trim();
        if (subject) payload.subject = subject;
      }
      const max = parseInt(maxMessagesInput.value, 10);
      if (Number.isFinite(max) && max > 0) payload.max_messages = max;

      state.blasting = true;
      updateSendButton();
      sendBtn.textContent = "Sending…";
      renderBlastLoading();
      try {
        const report = await api.blast(payload);
        renderBlastReport(report);
        toast(
          `Blast complete — ${report.sent} sent, ${report.failed} failed.`,
          report.failed ? "error" : "success"
        );
      } catch (err) {
        renderBlastError(err);
        toast((err && err.detail) || "Blast failed.", "error");
      } finally {
        state.blasting = false;
        updateSendButton();
      }
    }

    function renderBlastLoading() {
      clear(blastResult);
      blastResult.append(
        h(
          "div",
          { class: "loading" },
          h("span", { class: "spinner", role: "status", "aria-label": "Sending" }),
          "Sending blast…"
        )
      );
    }

    function renderBlastError(err) {
      clear(blastResult);
      blastResult.append(
        h(
          "div",
          { class: "empty-state" },
          h("div", { class: "empty-state__icon" }, "⚠️"),
          h("div", {}, (err && err.detail) || "The blast failed.")
        )
      );
    }

    function renderBlastReport(report) {
      clear(blastResult);
      const stat = (label, value, cls) =>
        h(
          "span",
          { class: `pill${cls ? " " + cls : ""}` },
          `${label}: ${value}`
        );

      const counts = h(
        "div",
        { class: "row", style: { marginTop: "var(--s2)" } },
        stat("Sent", report.sent || 0),
        stat("Failed", report.failed || 0),
        stat("Skipped invalid", report.skipped_invalid || 0),
        stat("Skipped no phone", report.skipped_no_phone || 0),
        stat("Skipped no email", report.skipped_no_email || 0),
        stat("Over limit", report.not_sent_over_limit || 0)
      );

      const parts = [
        h("div", { class: "section-title", style: { margin: "var(--s3) 0 var(--s2)" } }, "Blast report"),
        counts,
      ];

      if ((report.unknown_household_ids || []).length) {
        parts.push(
          h(
            "div",
            { class: "list-item", style: { background: "var(--warn-soft)", borderColor: "var(--warn)" } },
            h(
              "span",
              { class: "list-item__body", style: { color: "var(--warn)" } },
              `Unknown household ids (skipped): ${report.unknown_household_ids.join(", ")}`
            )
          )
        );
      }

      // Per-message outcomes (dry-run console shows the rendered body here).
      const msgs = report.messages || [];
      if (msgs.length) {
        parts.push(
          h(
            "details",
            {},
            h("summary", { style: { cursor: "pointer", fontWeight: "600", margin: "var(--s2) 0" } }, `Messages (${msgs.length})`),
            h(
              "ul",
              { class: "list" },
              msgs.map((m) =>
                h(
                  "li",
                  { class: "list-item", style: { flexDirection: "column", alignItems: "stretch" } },
                  h(
                    "div",
                    { class: "row row--between" },
                    h("span", { class: "mono" }, m.to || "—"),
                    m.ok
                      ? h("span", { class: "badge badge-delivered" }, "ok")
                      : h("span", { class: "badge badge-timeout" }, m.error || "failed")
                  ),
                  m.body ? h("div", { class: "list-item__meta", style: { whiteSpace: "pre-wrap" } }, m.body) : null
                )
              )
            )
          )
        );
      }

      blastResult.append(...parts);
    }
  }

  // Coerce an input string to a non-negative integer, falling back on bad input.
  function toNonNegInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  window.BAM.registerView("outreach", {
    title: "Outreach",
    icon: "📣",
    render,
  });
})();
