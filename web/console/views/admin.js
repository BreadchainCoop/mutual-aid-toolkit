/* Admin view (spec section 5 — scheduled cron jobs + privacy).
 *
 * Three operator-runnable maintenance jobs, each in its own card with a title,
 * a one-line "what it does / when it normally runs" description, a run button,
 * and the returned report rendered as a small key/value list.
 *
 *   1. Auto-expire stale requests  -> POST /jobs/expire       (daily)
 *   2. Publish website request data -> POST /jobs/website-data (hourly)
 *   3. Scrub expired PII            -> POST /jobs/scrub-pii    (daily, DESTRUCTIVE)
 *
 * Job 3 permanently nulls PII, so it uses a non-blocking two-step confirm:
 * the first click reveals a red confirm button; only that button runs it. */

(function () {
  "use strict";

  const { h, clear, toast, api, fmtDateTime } = window.BAM;

  // Humanize a report key: "timed_out_request_ids" -> "Timed out request ids".
  function humanizeKey(key) {
    const s = key.replace(/_/g, " ").trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Render one report value: arrays show their count + (capped) contents,
  // everything else is stringified. Returns a DOM node.
  function renderValue(value) {
    if (Array.isArray(value)) {
      if (value.length === 0) return h("span", { class: "muted" }, "none");
      const preview = value.slice(0, 20).join(", ");
      const suffix = value.length > 20 ? ` …+${value.length - 20} more` : "";
      return h(
        "span",
        {},
        h("strong", {}, String(value.length)),
        " ",
        h("span", { class: "muted mono" }, `(${preview}${suffix})`)
      );
    }
    if (value === null || value === undefined || value === "") {
      return h("span", { class: "muted" }, "—");
    }
    return h("span", { class: "mono" }, String(value));
  }

  // A small definition-list rendering of an arbitrary flat report object.
  function kvList(report) {
    const entries = Object.entries(report || {});
    if (!entries.length) {
      return h("p", { class: "muted" }, "No details returned.");
    }
    const rows = entries.map(([key, value]) =>
      h(
        "div",
        { class: "row row--between admin-kv" },
        h("dt", { class: "label", style: { margin: "0" } }, humanizeKey(key)),
        h("dd", { style: { margin: "0", textAlign: "right", minWidth: "0" } }, renderValue(value))
      )
    );
    return h("dl", { class: "stack admin-report", style: { margin: "0" } }, rows);
  }

  // The website-data report has a distinct, richer shape ({generated_at,
  // counts:[{type,label,count}]}); render the counts as a readable list.
  function websiteReport(report) {
    const counts = (report && report.counts) || [];
    const summary = h(
      "div",
      { class: "row row--between admin-kv" },
      h("dt", { class: "label", style: { margin: "0" } }, "Generated at"),
      h(
        "dd",
        { style: { margin: "0", textAlign: "right" } },
        h("span", { class: "mono" }, report && report.generated_at ? fmtDateTime(report.generated_at) : "—")
      )
    );
    const totalOpen = counts.reduce((sum, c) => sum + (c.count || 0), 0);
    const totalRow = h(
      "div",
      { class: "row row--between admin-kv" },
      h("dt", { class: "label", style: { margin: "0" } }, "Open request types"),
      h(
        "dd",
        { style: { margin: "0", textAlign: "right" } },
        h("span", {}, h("strong", {}, String(counts.length)), " types · ", h("strong", {}, String(totalOpen)), " open")
      )
    );

    const body = counts.length
      ? h(
          "ul",
          { class: "list", style: { marginTop: "var(--s3)" } },
          counts.map((c) =>
            h(
              "li",
              { class: "list-item" },
              h("div", { class: "list-item__body" }, h("div", { class: "list-item__label" }, c.label || c.type)),
              h("span", { class: "badge badge-open" }, String(c.count))
            )
          )
        )
      : h("div", { class: "empty-state" }, h("span", { class: "muted" }, "No open requests to publish."));

    return h("dl", { class: "stack", style: { margin: "0" } }, summary, totalRow, body);
  }

  function render(container) {
    // Inject a few scoped rules once (aligning report rows) — everything else
    // reuses shell component classes and tokens.
    ensureStyles();

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Admin"),
      h(
        "p",
        { class: "muted" },
        "Run the scheduled maintenance jobs by hand. These normally run on a cron; use them here to catch up or verify."
      )
    );

    clear(container);
    container.append(heading);
    renderAccessCard(container);
    renderDataAccessCard(container);

    // Build each job card.
    container.append(
      jobCard({
        id: "expire",
        icon: "⏳",
        title: "Auto-expire stale requests",
        desc:
          "Times out open requests past their window (14 days, 30 for pots & pans) so the queue reflects who still needs help. Normally runs daily.",
        runLabel: "Run expiration",
        run: () => api.expire(),
        renderReport: kvList,
        emptyMsg: "No requests were stale — nothing timed out.",
        isEmpty: (r) =>
          !(r.timed_out_request_ids || []).length &&
          !(r.timed_out_social_service_request_ids || []).length,
      })
    );

    container.append(
      jobCard({
        id: "website-data",
        icon: "🌐",
        title: "Publish website request data",
        desc:
          "Regenerates the public open-request counts JSON that the BAM website reads. Normally runs hourly (UpdateWebsiteRequestData).",
        runLabel: "Publish now",
        run: () => api.websiteData(),
        renderReport: websiteReport,
        // Website data always "succeeds"; never treated as empty.
        isEmpty: () => false,
      })
    );

    container.append(
      scrubCard()
    );
  }

  /* Generic job card -------------------------------------------------------- */

  function jobCard(job) {
    const state = { busy: false };

    const runBtn = h(
      "button",
      { class: "btn btn-primary", type: "button", onclick: doRun },
      job.runLabel
    );

    // Report region, replaced on each run.
    const reportRegion = h("div", { class: "admin-result" });

    const card = h(
      "div",
      { class: "card stack" },
      h(
        "div",
        { class: "row" },
        h("span", { class: "admin-job__icon", "aria-hidden": "true" }, job.icon),
        h("h2", { class: "card__title", style: { margin: "0" } }, job.title)
      ),
      h("p", { class: "muted", style: { margin: "0" } }, job.desc),
      h("div", { class: "row" }, runBtn),
      reportRegion
    );

    async function doRun() {
      if (state.busy) return;
      setBusy(true);
      showLoading(reportRegion, "Running…");
      try {
        const report = await job.run();
        renderResult(report);
        toast(`${job.title} — done.`, "success");
      } catch (err) {
        showError(reportRegion, err, doRun);
        toast((err && err.detail) || `${job.title} failed.`, "error");
      } finally {
        setBusy(false);
      }
    }

    function renderResult(report) {
      clear(reportRegion);
      const empty = job.isEmpty ? job.isEmpty(report) : false;
      const heading = h("div", { class: "section-title", style: { margin: "var(--s2) 0" } }, "Last run");
      if (empty) {
        reportRegion.append(
          heading,
          h(
            "div",
            { class: "empty-state", style: { padding: "var(--s4)" } },
            h("div", { class: "empty-state__icon" }, "✅"),
            h("div", {}, job.emptyMsg || "Nothing to do.")
          )
        );
        return;
      }
      reportRegion.append(heading, job.renderReport(report));
    }

    function setBusy(busy) {
      state.busy = busy;
      runBtn.disabled = busy;
      runBtn.textContent = busy ? "Working…" : job.runLabel;
    }

    return card;
  }

  /* Destructive scrub card (two-step confirm) ------------------------------- */

  function scrubCard() {
    const state = { busy: false, confirming: false };

    const reportRegion = h("div", { class: "admin-result" });

    // Step-1 button reveals the confirm controls.
    const armBtn = h(
      "button",
      { class: "btn btn-danger", type: "button", onclick: arm },
      "Scrub expired PII…"
    );

    // Step-2 controls, hidden until armed.
    const confirmBtn = h(
      "button",
      { class: "btn btn-danger", type: "button", onclick: doScrub },
      "Yes, scrub PII permanently"
    );
    const cancelBtn = h(
      "button",
      { class: "btn btn-ghost", type: "button", onclick: disarm },
      "Cancel"
    );
    const confirmBox = h(
      "div",
      { class: "card stack admin-danger-box", role: "group", "aria-label": "Confirm destructive scrub", hidden: true },
      h(
        "p",
        { style: { margin: "0" } },
        h("strong", {}, "This permanently removes PII and cannot be undone. "),
        "Names, phone numbers, emails, notes and addresses are nulled on inactive households and on closed requests whose retention window has passed. Active households and open requests are untouched."
      ),
      h("div", { class: "row" }, confirmBtn, cancelBtn)
    );

    const card = h(
      "div",
      { class: "card stack" },
      h(
        "div",
        { class: "row" },
        h("span", { class: "admin-job__icon", "aria-hidden": "true" }, "🧹"),
        h("h2", { class: "card__title", style: { margin: "0" } }, "Scrub expired PII")
      ),
      h(
        "p",
        { class: "muted", style: { margin: "0" } },
        "Nulls personal data on inactive households and closed, expired requests once their retention window passes. Normally runs daily. Destructive — see the confirmation before running."
      ),
      h("div", { class: "row admin-arm-row" }, armBtn),
      confirmBox,
      reportRegion
    );

    function arm() {
      state.confirming = true;
      confirmBox.hidden = false;
      armBtn.hidden = true;
      confirmBtn.focus();
    }

    function disarm() {
      state.confirming = false;
      confirmBox.hidden = true;
      armBtn.hidden = false;
      armBtn.focus();
    }

    async function doScrub() {
      if (state.busy) return;
      setBusy(true);
      showLoading(reportRegion, "Scrubbing PII…");
      try {
        const report = await api.scrubPii();
        // Collapse the confirm UI back to its resting state after a run.
        disarm();
        renderResult(report);
        toast("PII scrubbed.", "success");
      } catch (err) {
        showError(reportRegion, err, doScrub);
        toast((err && err.detail) || "Scrub failed.", "error");
      } finally {
        setBusy(false);
      }
    }

    function renderResult(report) {
      clear(reportRegion);
      const total =
        (report.households_anonymized || 0) +
        (report.requests_scrubbed || 0) +
        (report.social_service_requests_scrubbed || 0) +
        (report.submissions_scrubbed || 0);
      const heading = h("div", { class: "section-title", style: { margin: "var(--s2) 0" } }, "Last run");
      if (total === 0) {
        reportRegion.append(
          heading,
          h(
            "div",
            { class: "empty-state", style: { padding: "var(--s4)" } },
            h("div", { class: "empty-state__icon" }, "✅"),
            h("div", {}, "Nothing was eligible — no PII scrubbed.")
          )
        );
        return;
      }
      reportRegion.append(heading, kvList(report));
    }

    function setBusy(busy) {
      state.busy = busy;
      confirmBtn.disabled = busy;
      cancelBtn.disabled = busy;
      confirmBtn.textContent = busy ? "Scrubbing…" : "Yes, scrub PII permanently";
    }

    return card;
  }

  /* Shared report-region states -------------------------------------------- */

  function showLoading(region, msg) {
    clear(region);
    region.append(
      h(
        "div",
        { class: "loading", style: { padding: "var(--s5) var(--s4)" } },
        h("span", { class: "spinner", role: "status", "aria-label": "Loading" }),
        msg
      )
    );
  }

  function showError(region, err, retry) {
    clear(region);
    region.append(
      h(
        "div",
        { class: "empty-state", style: { padding: "var(--s4)" } },
        h("div", { class: "empty-state__icon" }, "⚠️"),
        h("div", {}, (err && err.detail) || "Something went wrong."),
        h("button", { class: "btn", type: "button", onclick: retry }, "Try again")
      )
    );
  }

  /* Scoped styles (added once) --------------------------------------------- */

  function ensureStyles() {
    if (document.getElementById("admin-view-styles")) return;
    const css = `
      .admin-job__icon { font-size: 22px; line-height: 1; }
      .admin-kv { align-items: baseline; gap: var(--s3); }
      .admin-kv dd { overflow-wrap: anywhere; }
      .admin-report > .admin-kv + .admin-kv { border-top: 1px solid var(--border); padding-top: var(--s2); }
      .admin-danger-box { border-color: var(--danger); background: var(--danger-soft); }
    `;
    document.head.appendChild(
      h("style", { id: "admin-view-styles", html: css })
    );
  }

  /* Access control — revoke / reinstate a device (backed by BAM.access, set in
     main.ts from the roster). Destructive actions confirm inline. */
  function renderAccessCard(parent) {
    const access = window.BAM.access;
    if (!access || !access.isAdmin || !access.isAdmin()) return;
    const card = h("div", { class: "card stack" });
    parent.append(card);
    let confirming = null; // peerId pending a revoke confirm

    function draw() {
      clear(card);
      card.append(
        h("h2", { class: "card__title" }, "Access control"),
        h(
          "p",
          { class: "muted", style: { margin: "0" } },
          "Revoke a device's access to this org, or bring it back. Revoking stops future updates from reaching that device."
        )
      );
      const others = access.members().filter((m) => m.peerId !== access.myPeerId);
      if (!others.length) {
        card.append(
          h(
            "div",
            { class: "empty-state" },
            h("div", {}, "No other devices yet — invite one from Your team.")
          )
        );
        return;
      }
      const revoke = (m) => {
        try {
          access.revoke(m.peerId);
          toast(`Revoked ${m.name} — they'll stop getting updates.`, "success");
        } catch (e) {
          toast((e && e.message) || String(e), "error");
        }
        confirming = null;
        draw();
      };
      const reinstate = (m) => {
        try {
          access.reinstate(m.peerId);
          toast(`Reinstated ${m.name}.`, "success");
        } catch (e) {
          toast((e && e.message) || String(e), "error");
        }
        confirming = null;
        draw();
      };
      const list = h("ul", { class: "list" });
      others.forEach((m) => {
        let action;
        if (m.revoked) {
          action = h(
            "button",
            { class: "btn btn-ghost", type: "button", onclick: () => reinstate(m) },
            "Reinstate"
          );
        } else if (confirming === m.peerId) {
          action = h(
            "span",
            { class: "row", style: { gap: "6px" } },
            h("button", { class: "btn btn-danger", type: "button", onclick: () => revoke(m) }, "Confirm revoke"),
            h(
              "button",
              {
                class: "btn btn-ghost",
                type: "button",
                onclick: () => {
                  confirming = null;
                  draw();
                },
              },
              "Cancel"
            )
          );
        } else {
          action = h(
            "button",
            {
              class: "btn btn-danger",
              type: "button",
              onclick: () => {
                confirming = m.peerId;
                draw();
              },
            },
            "Revoke"
          );
        }
        list.append(
          h(
            "li",
            { class: "list-item" },
            h(
              "div",
              { class: "list-item__body" },
              h("div", { class: "list-item__label" }, m.name),
              h(
                "div",
                { class: "list-item__meta mono", style: { wordBreak: "break-all" } },
                m.peerId
              )
            ),
            h("span", { class: "badge " + (m.revoked ? "badge-timeout" : "badge-open") }, m.revoked ? "revoked" : m.role),
            action
          )
        );
      });
      card.append(list);
    }
    draw();
  }

  /* Data access — per-device, per-domain grants (backed by BAM.access). Denying
     a domain stops that data syncing to the device. Admin-only; each toggle
     re-renders the card in place. */
  function renderDataAccessCard(parent) {
    const access = window.BAM.access;
    if (!access || !access.isAdmin || !access.isAdmin()) return;
    const card = h("div", { class: "card stack" });
    parent.append(card);

    function draw() {
      clear(card);
      card.append(
        h("h2", { class: "card__title" }, "Data access"),
        h(
          "p",
          { class: "muted", style: { margin: "0" } },
          "Choose which data each device can see. Denied data stops syncing to that device (it can't un-see what it already synced)."
        )
      );

      const domains = access.domains();
      if (!domains.length) {
        card.append(
          h(
            "div",
            { class: "empty-state" },
            h("div", {}, "No restrictable data domains yet.")
          )
        );
        return;
      }

      const others = access
        .members()
        .filter((m) => m.peerId !== access.myPeerId && !m.revoked);
      if (!others.length) {
        card.append(
          h(
            "div",
            { class: "empty-state" },
            h("div", {}, "No other devices yet — invite one from Your team.")
          )
        );
        return;
      }

      const toggleGrant = (m, domain, newAllowed) => {
        try {
          access.setGrant(m.peerId, domain.key, newAllowed);
          toast(
            newAllowed
              ? `${m.name} can now see ${domain.label}`
              : `${m.name} can no longer see ${domain.label}`,
            "success"
          );
        } catch (e) {
          toast((e && e.message) || String(e), "error");
        }
        draw();
      };

      const list = h("ul", { class: "list" });
      others.forEach((m) => {
        const grants = access.grantsFor(m.peerId) || {};
        const chips = domains.map((domain) => {
          const on = grants[domain.key] !== false;
          return h(
            "button",
            {
              type: "button",
              class: "langchip" + (on ? " langchip--on" : ""),
              title: domain.hint || domain.label,
              "aria-pressed": String(on),
              onclick: () => toggleGrant(m, domain, !on),
            },
            on ? h("span", { class: "langchip__check", "aria-hidden": "true" }, "✓") : null,
            domain.label
          );
        });
        list.append(
          h(
            "li",
            { class: "list-item" },
            h(
              "div",
              { class: "list-item__body" },
              h("div", { class: "list-item__label" }, m.name),
              h(
                "div",
                { class: "list-item__meta mono", style: { wordBreak: "break-all" } },
                m.peerId
              )
            ),
            h("span", { class: "row", style: { gap: "6px", flexWrap: "wrap" } }, chips)
          )
        );
      });
      card.append(list);
    }
    draw();
  }

  window.BAM.registerView("admin", {
    title: "Admin",
    icon: "⚙️",
    render,
  });
})();
