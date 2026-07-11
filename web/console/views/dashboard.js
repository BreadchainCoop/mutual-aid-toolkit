/* Dashboard view (spec section 5 / metrics) — the landing overview.
 *
 * On render: GET /metrics/open-requests and show a headline total of open
 * requests plus a ranked bar-style list of the top request types (trilingual
 * label + count, proportional bar). A "Refresh" button re-fetches, and a
 * "Publish website JSON" button POSTs /jobs/website-data (the hourly
 * UpdateWebsiteRequestData cron job). Mirrors views/checkin.js in structure,
 * loading/empty/error handling, and use of BAM.h / BAM.api / classes. */

(function () {
  "use strict";

  const { h, clear, toast, api, fmtDateTime } = window.BAM;

  // Show at most this many types as bars; the rest fold into a summary line.
  const TOP_N = 12;

  function render(container) {
    const state = {
      metrics: null, // last {generated_at, counts:[...]} from the API
      loading: false,
      publishing: false,
    };

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "Dashboard"),
      h(
        "p",
        { class: "muted" },
        "Open requests across the community, ranked by type."
      )
    );

    // Result region, replaced on each load.
    const result = h("div", { id: "dashboard-result" });

    clear(container);
    container.append(heading, result);

    load();

    // ---- actions ---------------------------------------------------------

    async function load() {
      setLoading(true);
      showLoading("Loading metrics…");
      try {
        state.metrics = await api.openRequests();
        // Fulfilled counts (spec 2: track fulfilled vs outstanding) for the
        // last 30 days; non-fatal if it fails.
        try {
          const start = new Date(Date.now() - 30 * 24 * 3600 * 1000)
            .toISOString()
            .slice(0, 10);
          state.fulfilled = await api.fulfilled({ start });
        } catch (_e) {
          state.fulfilled = null;
        }
        // Waitlist board + catalog labels (both non-fatal).
        try {
          state.waitlist = await api.waitlist();
        } catch (_e) {
          state.waitlist = null;
        }
        try {
          const cat = await api.catalog();
          state.labels = {};
          (cat.goods || []).concat(cat.social_services || []).forEach((t) => {
            state.labels[t.key] = t.label;
          });
        } catch (_e) {
          state.labels = {};
        }
        renderResult();
      } catch (err) {
        state.metrics = null;
        showError(err);
        toast(err.detail || "Could not load metrics.", "error");
      } finally {
        setLoading(false);
      }
    }

    async function doPublish() {
      if (state.publishing) return;
      state.publishing = true;
      renderResult(); // reflect disabled/"Publishing…" state
      try {
        const out = await api.websiteData();
        const when = out && out.generated_at ? fmtDateTime(out.generated_at) : "";
        toast(
          when ? `Website JSON published (${when}).` : "Website JSON published.",
          "success"
        );
      } catch (err) {
        toast(err.detail || "Could not publish website JSON.", "error");
      } finally {
        state.publishing = false;
        renderResult();
      }
    }

    // ---- state helpers ---------------------------------------------------

    function setLoading(loading) {
      state.loading = loading;
    }

    function showLoading(msg) {
      clear(result);
      result.append(
        h(
          "div",
          { class: "loading" },
          h("span", { class: "spinner", role: "status", "aria-label": "Loading" }),
          msg
        )
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
          h("button", { class: "btn", onclick: load }, "Try again")
        )
      );
    }

    // ---- rendering -------------------------------------------------------

    // Toolbar shared by both the data and empty states: Refresh + Publish.
    function toolbar() {
      const refreshBtn = h(
        "button",
        {
          class: "btn",
          onclick: load,
          disabled: state.loading || state.publishing,
        },
        "Refresh"
      );
      const publishBtn = h(
        "button",
        {
          class: "btn btn-primary",
          onclick: doPublish,
          disabled: state.loading || state.publishing,
          title: "Regenerate the public website's open-request counts (UpdateWebsiteRequestData)",
        },
        state.publishing ? "Publishing…" : "Publish website JSON"
      );
      return h("div", { class: "row" }, refreshBtn, publishBtn);
    }

    // One ranked bar row: label + count, with a proportional fill.
    function barRow(item, max) {
      const pct = max > 0 ? Math.max(2, Math.round((item.count / max) * 100)) : 0;
      const bar = h("div", {
        class: "dash-bar__fill",
        style: {
          width: `${pct}%`,
          height: "10px",
          background: "var(--brand)",
          borderRadius: "999px",
        },
        "aria-hidden": "true",
      });
      const track = h(
        "div",
        {
          class: "dash-bar__track",
          style: {
            width: "100%",
            height: "10px",
            background: "var(--surface-2)",
            borderRadius: "999px",
            overflow: "hidden",
          },
        },
        bar
      );
      return h(
        "li",
        {
          class: "list-item",
          style: { flexDirection: "column", alignItems: "stretch", gap: "var(--s2)" },
        },
        h(
          "div",
          { class: "row row--between", style: { gap: "var(--s3)" } },
          h(
            "span",
            { class: "list-item__label", style: { flex: "1 1 auto", minWidth: "0" } },
            item.label || item.type
          ),
          h("span", { class: "badge badge-open mono" }, String(item.count))
        ),
        track
      );
    }

    function renderResult() {
      clear(result);
      const m = state.metrics;
      if (!m) return;

      const counts = Array.isArray(m.counts) ? m.counts : [];
      const total = counts.reduce((sum, c) => sum + (c.count || 0), 0);

      // Headline card: total open + generated_at + toolbar.
      const headline = h(
        "div",
        { class: "card stack" },
        h(
          "div",
          { class: "row row--between" },
          h(
            "div",
            { class: "grow" },
            h(
              "div",
              { class: "mono", style: { fontSize: "40px", fontWeight: "800", lineHeight: "1" } },
              String(total)
            ),
            h("div", { class: "muted" }, total === 1 ? "open request" : "open requests")
          )
        ),
        m.generated_at
          ? h(
              "div",
              { class: "muted", style: { fontSize: "13px" } },
              `Updated ${fmtDateTime(m.generated_at)}`
            )
          : null,
        toolbar()
      );

      result.append(headline);

      // Ranked bars card, or an empty state when nothing is open.
      if (!counts.length) {
        result.append(
          h(
            "div",
            { class: "card" },
            h(
              "div",
              { class: "empty-state" },
              h("div", { class: "empty-state__icon" }, "✅"),
              h("div", {}, "No open requests right now."),
              h(
                "p",
                { class: "muted" },
                "Everything's been delivered or timed out."
              )
            )
          )
        );
        return;
      }

      // counts already arrive sorted by count desc from the API.
      const max = counts.reduce((mx, c) => Math.max(mx, c.count || 0), 0);
      const shown = counts.slice(0, TOP_N);
      const remaining = counts.slice(TOP_N);
      const remainingTotal = remaining.reduce((sum, c) => sum + (c.count || 0), 0);

      const barsCard = h(
        "div",
        { class: "card stack" },
        h("h2", { class: "card__title" }, "Top request types"),
        h(
          "ul",
          { class: "list" },
          shown.map((c) => barRow(c, max))
        ),
        remaining.length
          ? h(
              "p",
              { class: "muted", style: { fontSize: "13px", margin: "0" } },
              `+ ${remaining.length} more type${remaining.length === 1 ? "" : "s"} (${remainingTotal} open)`
            )
          : null
      );

      result.append(barsCard);
      renderFulfilled();
      renderWaitlist();
      renderImpact();
    }

    // English middle token of a trilingual label ("Español / Spanish / 西班牙语").
    function shortLabel(label) {
      const parts = String(label || "").split(" / ");
      return parts[1] || parts[0] || label;
    }

    // The waitlist board: per item — open/paced counts, age buckets, language
    // split, and the interpreter-gap signal. The report Maria compiles by hand.
    function renderWaitlist() {
      const rows = state.waitlist;
      if (!rows || !rows.length) return;

      const items = rows.map((r) => {
        const langs = Object.entries(r.by_language || {})
          .sort((a, b) => b[1] - a[1])
          .map(([lang, n]) => `${shortLabel(lang)} ${n}`)
          .join(" · ");
        const age = r.age || {};
        const meta = [
          `≤30d: ${age.d30 || 0}`,
          `≤90d: ${age.d90 || 0}`,
          `≤180d: ${age.d180 || 0}`,
          `older: ${age.older || 0}`,
        ].join(" · ");
        return h(
          "li",
          {
            class: "list-item",
            style: { flexDirection: "column", alignItems: "stretch", gap: "var(--s1)" },
          },
          h(
            "div",
            { class: "row row--between", style: { gap: "var(--s3)" } },
            h("span", { class: "list-item__label" }, r.label || r.type),
            h(
              "span",
              { class: "row", style: { gap: "6px" } },
              r.paced > 0
                ? h("span", { class: "badge", title: "Accepted but paced by an item cooldown" }, `⏸ ${r.paced} paced`)
                : null,
              r.unsupported_language > 0
                ? h(
                    "span",
                    {
                      class: "badge badge-timeout",
                      title: "Households with no catalog-supported language — needs an interpreter or translated outreach",
                    },
                    `🌐 ${r.unsupported_language} need an interpreter`
                  )
                : null,
              h("span", { class: "badge badge-open mono" }, String(r.open))
            )
          ),
          h("div", { class: "list-item__meta" }, meta),
          r.oldest_open_at
            ? h(
                "div",
                { class: "list-item__meta" },
                `Oldest: ${window.BAM.fmtDate(r.oldest_open_at)}${langs ? ` — ${langs}` : ""}`
              )
            : langs
              ? h("div", { class: "list-item__meta" }, langs)
              : null
        );
      });

      result.append(
        h(
          "div",
          { class: "card stack" },
          h("h2", { class: "card__title" }, "Waitlist by item"),
          h(
            "p",
            { class: "muted", style: { margin: "0", fontSize: "13px" } },
            "Every open request by item — how old, in which language, and where the interpreter gaps are."
          ),
          h("ul", { class: "list" }, items)
        )
      );
    }

    // Impact report: deliveries over a date range + a PII-free copy button —
    // the org's shareable "work completed" story.
    function renderImpact() {
      const startInput = h("input", { class: "input", type: "date" });
      const endInput = h("input", { class: "input", type: "date" });
      const report = h("div", {});
      let lastImpact = null;

      const genBtn = h(
        "button",
        {
          class: "btn btn-primary",
          onclick: async () => {
            genBtn.disabled = true;
            genBtn.textContent = "Generating…";
            try {
              const range = {};
              if (startInput.value) range.start = startInput.value;
              if (endInput.value) range.end = endInput.value;
              lastImpact = await api.impact(range);
              drawReport();
            } catch (err) {
              toast(err.detail || "Could not generate the report.", "error");
            } finally {
              genBtn.disabled = false;
              genBtn.textContent = "Generate";
            }
          },
        },
        "Generate"
      );

      function rangeText() {
        if (!lastImpact) return "";
        if (lastImpact.start && lastImpact.end) return `${lastImpact.start} → ${lastImpact.end}`;
        if (lastImpact.start) return `since ${lastImpact.start}`;
        if (lastImpact.end) return `through ${lastImpact.end}`;
        return "all time";
      }

      function reportMarkdown() {
        const lines = Object.entries(lastImpact.delivered || {})
          .sort((a, b) => b[1] - a[1])
          .filter(([, n]) => n > 0)
          .map(([type, n]) => `- ${shortLabel(state.labels[type] || type)}: ${n}`);
        return [
          `# ${rangeText()} impact — ${lastImpact.total_delivered} requests fulfilled`,
          ...lines,
          "",
          "Counts only — no personal data.",
        ].join("\n");
      }

      function copyReport() {
        const text = reportMarkdown();
        const done = () => toast("Impact report copied — counts only, no personal data.", "success");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => {
            fallbackCopy(text);
            done();
          });
        } else {
          fallbackCopy(text);
          done();
        }
      }

      function fallbackCopy(text) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch (_e) {
          /* nothing else to try */
        }
        document.body.removeChild(ta);
      }

      function drawReport() {
        clear(report);
        if (!lastImpact) return;
        const entries = Object.entries(lastImpact.delivered || {})
          .sort((a, b) => b[1] - a[1])
          .filter(([, n]) => n > 0);
        report.append(
          h(
            "div",
            { class: "stack", style: { marginTop: "var(--s3)" } },
            h(
              "div",
              { class: "mono", style: { fontSize: "32px", fontWeight: "800", lineHeight: "1" } },
              String(lastImpact.total_delivered)
            ),
            h("div", { class: "muted" }, `requests fulfilled (${rangeText()})`),
            entries.length
              ? h(
                  "ul",
                  { class: "list" },
                  entries.map(([type, n]) =>
                    h(
                      "li",
                      { class: "list-item" },
                      h("span", { class: "list-item__label" }, shortLabel(state.labels[type] || type)),
                      h("span", { class: "badge badge-open mono" }, String(n))
                    )
                  )
                )
              : h("p", { class: "muted" }, "Nothing delivered in this range."),
            h("button", { class: "btn", onclick: copyReport }, "📋 Copy report")
          )
        );
      }

      result.append(
        h(
          "div",
          { class: "card stack" },
          h("h2", { class: "card__title" }, "Impact report"),
          h(
            "p",
            { class: "muted", style: { margin: "0", fontSize: "13px" } },
            "What got delivered over a period — counts only, safe to share with donors and the community."
          ),
          h(
            "div",
            { class: "row", style: { gap: "var(--s3)", flexWrap: "wrap" } },
            startInput,
            endInput,
            genBtn
          ),
          report
        )
      );
    }

    // Fulfilled deliveries over the last 30 days, grouped per day
    // (spec 2 goal: track fulfilled vs outstanding requests).
    function renderFulfilled() {
      const rows = state.fulfilled;
      if (!rows || !rows.length) return;
      const byDate = new Map();
      rows.forEach((r) => {
        if (!byDate.has(r.date)) byDate.set(r.date, []);
        byDate.get(r.date).push(r);
      });
      const days = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
      const total = rows.reduce((sum, r) => sum + (r.count || 0), 0);
      result.append(
        h(
          "div",
          { class: "card stack" },
          h("h2", { class: "card__title" }, `Fulfilled — last 30 days (${total})`),
          h(
            "ul",
            { class: "list" },
            days.map(([date, items]) =>
              h(
                "li",
                { class: "list-item" },
                h(
                  "div",
                  { class: "list-item__body" },
                  h("div", { class: "list-item__label" }, window.BAM.fmtDate(date)),
                  h(
                    "div",
                    { class: "list-item__meta" },
                    items.map((i) => `${i.label.split(" / ")[1] || i.label} ×${i.count}`).join(", ")
                  )
                )
              )
            )
          )
        )
      );
    }
  }

  window.BAM.registerView("dashboard", {
    title: "Dashboard",
    icon: "📊",
    render,
  });
})();
