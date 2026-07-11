/* Check-in view (spec 6.3) — the primary at-the-distro flow and the
 * reference implementation every other view copies.
 *
 * Flow: enter a phone -> look up the household -> see their open goods and
 * social-service requests -> "Check in" (resets missed count) and/or mark
 * selected requests delivered. Results are re-fetched and re-rendered. */

(function () {
  "use strict";

  const { h, clear, toast, api, fmtDate } = window.BAM;

  // Map a request status to its badge class.
  function statusBadge(status) {
    const cls =
      status === "Delivered"
        ? "badge-delivered"
        : status === "Timeout"
        ? "badge-timeout"
        : "badge-open";
    return h("span", { class: `badge ${cls}` }, status);
  }

  // "baby_diapers" -> "Baby diapers"; full labels/free text pass through.
  function prettyType(value) {
    if (/^[a-z0-9_]+$/.test(value)) {
      const s = value.replace(/_/g, " ");
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    return value;
  }

  // Appointment status -> badge (booked/checked-in/missed), or nothing.
  function appointmentBadge(status) {
    if (!status) return null;
    const cls =
      status === "Checked-in"
        ? "badge-delivered"
        : status === "Missed"
        ? "badge-timeout"
        : "badge-open";
    return h("span", { class: `badge ${cls}` }, status);
  }

  function render(container, params) {
    // ---- view state ------------------------------------------------------
    const state = {
      view: null, // last CheckinView from the API
      loading: false,
    };
    // Track which request rows are checked, across re-renders keyed by id.
    const selectedRequests = new Set();
    const selectedServices = new Set();

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Check-in"),
      h(
        "p",
        { class: "muted" },
        "Look up a household by phone number or name (spec: check in via phone number/name)."
      )
    );

    // ---- lookup form -----------------------------------------------------
    const phoneInput = h("input", {
      class: "input",
      id: "checkin-phone",
      name: "phone",
      type: "tel",
      inputmode: "tel",
      autocomplete: "off",
      placeholder: "(718) 555-0142",
      "aria-label": "Phone number",
    });
    const nameInput = h("input", {
      class: "input",
      id: "checkin-name",
      name: "name",
      type: "text",
      autocomplete: "off",
      placeholder: "e.g. Maria",
      "aria-label": "Name",
    });

    const lookupBtn = h(
      "button",
      { class: "btn btn-primary", type: "submit" },
      "Look up"
    );

    const form = h(
      "form",
      {
        class: "card stack",
        onsubmit: (e) => {
          e.preventDefault();
          doLookup();
        },
      },
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "checkin-phone" }, "Phone number (or last 4 digits)"),
        phoneInput
      ),
      h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: "checkin-name" }, "…or name or email (if they arrived without their phone)"),
        nameInput
      ),
      lookupBtn
    );

    // Result region, replaced on each lookup.
    const result = h("div", { id: "checkin-result" });

    clear(container);
    container.append(heading, form, result);

    // Deep-link support: #checkin?id=... (from the browse views) loads a
    // household directly; #checkin?phone=... auto-runs a phone lookup.
    if (params && params.id) {
      loadHousehold(params.id).catch((err) => {
        if (err instanceof api.ApiError && err.status === 404) {
          renderNotFound(`household ${params.id}`);
        } else {
          showError(err);
          toast(err.detail || "Could not load that household.", "error");
        }
      });
    } else if (params && params.phone) {
      phoneInput.value = params.phone;
      doLookup();
    } else {
      // Autofocus the phone input on mobile-first arrival.
      setTimeout(() => phoneInput.focus(), 0);
    }

    // ---- actions ---------------------------------------------------------

    async function doLookup() {
      const phone = phoneInput.value.trim();
      const name = nameInput.value.trim();
      if (!phone && !name) {
        toast("Enter a phone number or a name to look up.", "info");
        phoneInput.focus();
        return;
      }
      setBusy(true);
      showLoading("Looking up household…");
      selectedRequests.clear();
      selectedServices.clear();
      try {
        if (phone) {
          const digits = phone.replace(/\D/g, "");
          if (digits && digits.length <= 4) {
            // Last-4-digits search (volunteer-checkin guide Step 2).
            await routeMatches(await api.searchByPhone(digits), phone);
          } else {
            state.view = await api.lookup(phone);
            renderResult();
          }
        } else if (name.includes("@")) {
          // Email-fragment search — the households the phone pipeline misses.
          await routeMatches(await api.searchByEmail(name), name);
        } else {
          await routeMatches(await api.searchByName(name), name);
        }
      } catch (err) {
        state.view = null;
        if (err instanceof api.ApiError && err.status === 404) {
          renderNotFound(phone || name);
        } else {
          showError(err);
          toast(err.detail || "Lookup failed.", "error");
        }
      } finally {
        setBusy(false);
      }
    }

    // Route 0/1/N search hits (shared by name + last-4 search).
    async function routeMatches(matches, label) {
      if (!matches.length) {
        state.view = null;
        renderNotFound(label);
      } else if (matches.length === 1) {
        await loadHousehold(matches[0].id);
      } else {
        state.view = null;
        renderMatches(matches);
      }
    }

    // Load a CheckinView by id (second half of a name-search check-in).
    async function loadHousehold(id) {
      state.view = await api.householdView(id);
      selectedRequests.clear();
      selectedServices.clear();
      renderResult();
    }

    // Several name-search hits: let the volunteer pick the right household.
    function renderMatches(matches) {
      clear(result);
      result.append(
        h(
          "div",
          { class: "card stack" },
          h("h2", { class: "card__title" }, `${matches.length} matches`),
          h(
            "ul",
            { class: "list" },
            matches.map((m) =>
              h(
                "li",
                { class: "list-item" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-ghost grow",
                    style: { justifyContent: "flex-start", textAlign: "left" },
                    onclick: () => {
                      setBusy(true);
                      showLoading("Loading household…");
                      loadHousehold(m.id)
                        .catch((err) => {
                          showError(err);
                          toast(err.detail || "Could not load household.", "error");
                        })
                        .finally(() => setBusy(false));
                    },
                  },
                  h("div", { class: "stack", style: { gap: "2px" } },
                    h("div", { class: "list-item__label" }, m.name || `Household #${m.id}`),
                    h(
                      "div",
                      { class: "list-item__meta" },
                      [m.phone_number, (m.languages || []).join(", ")].filter(Boolean).join(" · ") || "no phone on file"
                    ))
                )
              )
            )
          )
        )
      );
    }

    async function doCheckIn() {
      if (!state.view) return;
      const id = state.view.household.id;
      setBusy(true);
      try {
        await api.checkIn(id);
        toast("Checked in.", "success");
        await refresh();
      } catch (err) {
        toast(err.detail || "Check-in failed.", "error");
        setBusy(false);
      }
    }

    async function doFulfill() {
      if (!state.view) return;
      const request_ids = [...selectedRequests];
      const social_service_request_ids = [...selectedServices];
      if (!request_ids.length && !social_service_request_ids.length) {
        toast("Select at least one request to mark delivered.", "info");
        return;
      }
      setBusy(true);
      try {
        const out = await api.fulfill({ request_ids, social_service_request_ids });
        const n =
          (out.requests || []).length + (out.social_service_requests || []).length;
        toast(`Marked ${n} delivered.`, "success");
        selectedRequests.clear();
        selectedServices.clear();
        await refresh();
      } catch (err) {
        toast(err.detail || "Could not mark delivered.", "error");
        setBusy(false);
      }
    }

    // Recipient declines an in-stock item (guide Step 4): time it out.
    async function doTimeout() {
      if (!state.view) return;
      const request_ids = [...selectedRequests];
      const social_service_request_ids = [...selectedServices];
      if (!request_ids.length && !social_service_request_ids.length) {
        toast("Select at least one request to time out.", "info");
        return;
      }
      setBusy(true);
      try {
        const out = await api.timeout({ request_ids, social_service_request_ids });
        const n =
          (out.requests || []).length + (out.social_service_requests || []).length;
        toast(`Marked ${n} timed out.`, "success");
        selectedRequests.clear();
        selectedServices.clear();
        await refresh();
      } catch (err) {
        toast(err.detail || "Could not time out.", "error");
        setBusy(false);
      }
    }

    // Re-fetch the household after a mutation so the UI reflects server
    // truth. Fetches by id so phoneless households (name-search path,
    // wrong-number outcomes) refresh too.
    async function refresh() {
      try {
        state.view = await api.householdView(state.view.household.id);
        renderResult();
      } catch (err) {
        toast(err.detail || "Could not refresh.", "error");
      } finally {
        setBusy(false);
      }
    }

    // ---- rendering helpers ----------------------------------------------

    function setBusy(busy) {
      state.loading = busy;
      lookupBtn.disabled = busy;
      lookupBtn.textContent = busy ? "Working…" : "Look up";
    }

    function showLoading(msg) {
      clear(result);
      result.append(
        h("div", { class: "loading" }, h("span", { class: "spinner", role: "status", "aria-label": "Loading" }), msg)
      );
    }

    function showError(err) {
      clear(result);
      result.append(
        h(
          "div",
          { class: "card empty-state" },
          h("div", { class: "empty-state__icon" }, "⚠️"),
          h("div", {}, (err && err.detail) || "Something went wrong."),
          h("button", { class: "btn", onclick: doLookup }, "Try again")
        )
      );
    }

    function renderNotFound(phone) {
      clear(result);
      result.append(
        h(
          "div",
          { class: "card empty-state" },
          h("div", { class: "empty-state__icon" }, "🔍"),
          h("div", {}, `No household found for ${phone}.`),
          h(
            "p",
            { class: "muted" },
            "Double-check the number, or send them to intake to sign up."
          ),
          h(
            "button",
            { class: "btn btn-ghost", onclick: () => window.BAM.navigate("intake") },
            "Go to intake →"
          )
        )
      );
    }

    // Build one selectable request row with a big checkbox.
    function requestRow(req, selectedSet) {
      const checkbox = h("input", {
        type: "checkbox",
        id: `req-${selectedSet === selectedRequests ? "g" : "s"}-${req.id}`,
        checked: selectedSet.has(req.id),
        // Delivered/Timeout rows aren't shown here, but guard anyway.
        disabled: req.status !== "Open",
        onchange: (e) => {
          if (e.target.checked) selectedSet.add(req.id);
          else selectedSet.delete(req.id);
        },
      });
      const today = new Date().toLocaleDateString("en-CA");
      const paced = req.paced_until && req.paced_until > today;
      const label = h(
        "label",
        { class: "list-item__body", for: checkbox.id },
        h("div", { class: "list-item__label" }, req.label || req.type),
        req.request_opened_at
          ? h("div", { class: "list-item__meta" }, `Opened ${fmtDate(req.request_opened_at)}`)
          : null,
        paced
          ? h(
              "div",
              { class: "list-item__meta" },
              `⏸ Paced until ${fmtDate(req.paced_until)} — delivered to them recently (item cooldown).`
            )
          : null
      );
      const badges = h(
        "span",
        { class: "row", style: { gap: "4px" } },
        req.partner_org ? h("span", { class: "badge", title: "Fulfilling partner org" }, `→ ${req.partner_org}`) : null,
        statusBadge(req.status)
      );
      return h("li", { class: "list-item list-item--selectable" }, checkbox, label, badges);
    }

    function requestList(items, selectedSet, emptyMsg) {
      if (!items || !items.length) {
        return h("div", { class: "empty-state" }, h("span", { class: "muted" }, emptyMsg));
      }
      return h(
        "ul",
        { class: "list" },
        items.map((req) => requestRow(req, selectedSet))
      );
    }

    // ---- new-feature actions ---------------------------------------------

    async function doSetAside() {
      const hh = state.view && state.view.household;
      if (!hh) return;
      if (hh.set_aside) {
        if (!confirm("Clear the set-aside note?")) return;
        await api.setSetAside(hh.id, { note: null });
        toast("Set-aside cleared.", "success");
      } else {
        const note = prompt("What should the crew bag for after-hours pickup?\n(e.g. 2 packs diapers size 4 — handoff via Colectiva)");
        if (!note || !note.trim()) return;
        await api.setSetAside(hh.id, { note: note.trim() });
        toast("Set aside for pickup.", "success");
      }
      await refresh();
    }

    async function doToggleDelivery() {
      const hh = state.view && state.view.household;
      if (!hh) return;
      await api.setNeedsDelivery(hh.id, { on: !hh.needs_delivery });
      toast(hh.needs_delivery ? "Delivery flag removed." : "Flagged for doorstep delivery.", "success");
      await refresh();
    }

    // Contact-fix editor (admins + devices with the contact-fix grant): the
    // safe way to correct a typo'd phone without full database access.
    function contactFixPanel(hh) {
      const phoneEdit = h("input", {
        class: "input",
        type: "tel",
        value: hh.phone_number || "",
        placeholder: "(718) 555-0142",
        "aria-label": "Corrected phone number",
      });
      const emailEdit = h("input", {
        class: "input",
        type: "email",
        value: hh.email || "",
        placeholder: "name@example.com",
        "aria-label": "Corrected email",
      });
      const saveBtn = h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            const body = {};
            const newPhone = phoneEdit.value.trim();
            const newEmail = emailEdit.value.trim();
            if (newPhone && newPhone !== (hh.phone_number || "")) body.phone_number = newPhone;
            if (newEmail && newEmail !== (hh.email || "")) body.email = newEmail;
            if (!Object.keys(body).length) {
              toast("Nothing changed.", "info");
              return;
            }
            saveBtn.disabled = true;
            try {
              await api.updateContact(hh.id, body);
              toast("Contact info updated (change is audited).", "success");
              await refresh();
            } catch (err) {
              toast((err && err.detail) || "Could not update contact info.", "error");
              saveBtn.disabled = false;
            }
          },
        },
        "Save contact fix"
      );
      return h(
        "details",
        {},
        h("summary", { class: "muted" }, "✏️ Edit contact info"),
        h(
          "div",
          { class: "stack", style: { marginTop: "var(--s2)" } },
          phoneEdit,
          emailEdit,
          saveBtn,
          h(
            "span",
            { class: "muted", style: { fontSize: "12px" } },
            "Fixes are logged to the household notes (masked — last 4 digits only)."
          )
        )
      );
    }

    // Referral cues ("invite them to scan the English-classes QR") that match
    // this household's open request types. Cached per view render.
    async function referralCues(v) {
      let refs;
      try {
        refs = (await api.referrals()).referrals || [];
      } catch (_e) {
        return null;
      }
      if (!refs.length) return null;
      const openTypes = new Set(
        (v.open_requests || []).concat(v.open_social_service_requests || []).map((r) => r.type)
      );
      const hits = refs.filter(
        (r) => !(r.show_for_types || []).length || r.show_for_types.some((t) => openTypes.has(t))
      );
      if (!hits.length) return null;
      return h(
        "div",
        {
          class: "card stack",
          style: { borderColor: "var(--brand)", borderWidth: "2px" },
        },
        h("h2", { class: "card__title" }, "💡 While they're here"),
        ...hits.map((r) =>
          h(
            "div",
            { class: "row row--between" },
            h("span", {}, r.label),
            r.url
              ? h("a", { class: "btn btn-ghost", href: r.url, target: "_blank", rel: "noopener" }, "Open link")
              : null
          )
        )
      );
    }

    function renderResult() {
      const v = state.view;
      clear(result);
      if (!v) return;

      const hh = v.household;
      const goods = v.open_requests || [];
      const services = v.open_social_service_requests || [];

      // Household summary card.
      const phoneBits = [];
      if (hh.phone_number) phoneBits.push(h("span", { class: "mono" }, hh.phone_number));
      if (hh.invalid_phone_number) phoneBits.push(h("span", { class: "badge badge-timeout" }, "invalid number"));
      if (hh.intl_phone_number) phoneBits.push(h("span", { class: "badge" }, "international"));

      const summary = h(
        "div",
        { class: "card stack" },
        h(
          "div",
          { class: "row row--between" },
          h("div", { class: "grow" }, h("h2", { class: "card__title", style: { margin: "0" } }, hh.name || "Unnamed household")),
          appointmentBadge(hh.appointment_status)
        ),
        // Their booked distro was cancelled — flag it where the volunteer looks.
        hh.needs_rebooking
          ? h(
              "div",
              { class: "row", style: { alignItems: "flex-start" } },
              h("span", { class: "badge badge-timeout" }, "🔁"),
              h(
                "span",
                {},
                `Their ${hh.rebook_from ? fmtDate(hh.rebook_from) + " " : ""}distro was cancelled — they need a new appointment (see Outreach → Needs rebooking).`
              )
            )
          : null,
        phoneBits.length ? h("div", { class: "row" }, phoneBits) : null,
        h(
          "div",
          { class: "row" },
          hh.appointment_date
            ? h(
                "span",
                { class: "pill" },
                `Appt ${fmtDate(hh.appointment_date)}${hh.appointment_time ? " · " + hh.appointment_time : ""}`
              )
            : null,
          hh.missed_appointment_count
            ? h("span", { class: "pill" }, `${hh.missed_appointment_count} missed`)
            : null,
          hh.languages && hh.languages.length
            ? h("span", { class: "pill" }, hh.languages.join(", "))
            : null,
          hh.preferred_language
            ? h("span", { class: "pill", title: "Preferred language" }, `★ ${window.BAM.langShort(hh.preferred_language)}`)
            : null,
          hh.needs_delivery ? h("span", { class: "badge", title: "Needs doorstep delivery" }, "🚚 delivery") : null,
          hh.set_aside
            ? h(
                "span",
                { class: "badge", title: `By ${hh.set_aside.by} · ${fmtDate(hh.set_aside.at)}` },
                `📦 ${hh.set_aside.note}`
              )
            : null
        ),
        // Delivered Request Types lookup (spec 4): what they already received.
        v.delivered_request_types && v.delivered_request_types.length
          ? h(
              "div",
              { class: "list-item__meta" },
              "Already received: " +
                v.delivered_request_types.map(prettyType).join(", ")
            )
          : null,
        // Household notes — operational context for the volunteer.
        hh.notes
          ? h(
              "details",
              {},
              h("summary", { class: "muted" }, "Notes"),
              h("div", { class: "list-item__meta", style: { whiteSpace: "pre-wrap" } }, hh.notes)
            )
          : null,
        // Primary check-in action.
        h(
          "button",
          {
            class: "btn btn-primary btn-block",
            onclick: doCheckIn,
            disabled: state.loading,
          },
          hh.appointment_status === "Checked-in" ? "Check in again" : "Check in"
        ),
        // Secondary flags: set-aside bagging + doorstep delivery.
        h(
          "div",
          { class: "row" },
          h(
            "button",
            { class: "btn btn-ghost", type: "button", onclick: doSetAside, disabled: state.loading },
            hh.set_aside ? "Clear set-aside" : "📦 Set aside for pickup"
          ),
          h(
            "button",
            { class: "btn btn-ghost", type: "button", onclick: doToggleDelivery, disabled: state.loading },
            hh.needs_delivery ? "Remove delivery flag" : "🚚 Needs delivery"
          )
        )
      );

      // Contact-fix editor, only for devices holding the grant.
      Promise.resolve(api.canFixContacts()).then((can) => {
        if (can) summary.append(contactFixPanel(hh));
      });
      // Referral cues load async and slot in between summary and requests.
      const cueSlot = h("div", {});
      referralCues(v).then((cueCard) => {
        if (cueCard) cueSlot.append(cueCard);
      });

      // Requests card with the two grouped lists + fulfill action.
      const totalOpen = goods.length + services.length;
      const requestsCard = h(
        "div",
        { class: "card stack" },
        h("h2", { class: "card__title" }, "Open requests"),
        totalOpen === 0
          ? h(
              "div",
              { class: "empty-state" },
              h("div", { class: "empty-state__icon" }, "✅"),
              h("div", {}, "No open requests — everything delivered.")
            )
          : [
              h("div", { class: "section-title" }, `Goods (${goods.length})`),
              requestList(goods, selectedRequests, "No open goods requests."),
              h("div", { class: "section-title" }, `Social services (${services.length})`),
              requestList(services, selectedServices, "No open social service requests."),
              h(
                "button",
                {
                  class: "btn btn-primary btn-block",
                  onclick: doFulfill,
                  disabled: state.loading,
                },
                "Mark selected delivered"
              ),
              // Guide Step 4: recipient no longer needs a selected item.
              h(
                "button",
                {
                  class: "btn btn-ghost btn-block",
                  onclick: doTimeout,
                  disabled: state.loading,
                },
                "Mark selected timed out (no longer needed)"
              ),
            ]
      );

      result.append(summary, cueSlot, requestsCard);
    }
  }

  window.BAM.registerView("checkin", {
    title: "Check-in",
    icon: "✅",
    render,
  });
})();
