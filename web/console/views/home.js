/* Home — the guided landing view.
 *
 * Instead of dropping people into a form with a dozen nav tabs, Home asks
 * "what do you need to do?" and offers big task cards in plain words, with
 * live context (today's appointments, shift gaps, the rebooking queue).
 * Admins on a fresh org get a get-set-up checklist instead of empty screens. */

(function () {
  "use strict";

  const { h, clear, api, navigate } = window.BAM;

  function todayLocal() {
    return new Date().toLocaleDateString("en-CA");
  }

  function taskCard(opts) {
    const hint = h("div", { class: "taskcard__hint" });
    const card = h(
      "a",
      { class: "taskcard", href: `#${opts.view}`, "aria-label": opts.title },
      h("span", { class: "taskcard__icon", "aria-hidden": "true" }, opts.icon),
      h(
        "div",
        { class: "grow" },
        h("p", { class: "taskcard__title" }, opts.title),
        h("p", { class: "taskcard__desc" }, opts.desc),
        hint
      )
    );
    return { card, hint };
  }

  function render(container) {
    clear(container);

    const orgName =
      (window.BAM.config && window.BAM.config.org && window.BAM.config.org.name) || "your community";
    const isAdmin = !!(window.BAM.access && window.BAM.access.isAdmin && window.BAM.access.isAdmin());

    const heading = h(
      "div",
      { class: "view-heading" },
      h("h1", {}, "What do you need to do?"),
      h("p", { class: "muted" }, `Everything for ${orgName}, one tap away.`)
    );

    // ---- the four everyday tasks ------------------------------------------
    const checkin = taskCard({
      view: "checkin",
      icon: "✅",
      title: "Check someone in",
      desc: "They're here at the distro — look them up and hand things over.",
    });
    const intake = taskCard({
      view: "intake",
      icon: "📝",
      title: "Take a request",
      desc: "A neighbor needs something — record it in a minute.",
    });
    const outreach = taskCard({
      view: "outreach",
      icon: "📣",
      title: "Reach out",
      desc: "Text, email, or call families to book appointments.",
    });
    const shifts = taskCard({
      view: "shifts",
      icon: "🗓️",
      title: "Cover a shift",
      desc: "See which distro roles still need someone.",
    });

    const grid = h(
      "div",
      { class: "taskgrid" },
      checkin.card,
      intake.card,
      outreach.card,
      shifts.card
    );

    // ---- quieter links ------------------------------------------------------
    const quick = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Everything else"),
      h(
        "div",
        { class: "quicklinks" },
        [
          ["lookup", "🔎 Find a household"],
          ["appointments", "📅 Today's appointments"],
          ["distros", "📦 Distros"],
          ["dashboard", "📊 Dashboard"],
        ].map(([view, label]) =>
          h("a", { class: "btn btn-ghost", href: `#${view}` }, label)
        ),
        isAdmin
          ? [
              ["admin", "⚙️ Admin & settings"],
              ["roster", "🤝 Volunteers"],
            ].map(([view, label]) =>
              h("a", { class: "btn btn-ghost", href: `#${view}` }, label)
            )
          : null
      )
    );

    // ---- fresh-org setup checklist (admins) --------------------------------
    const setupSlot = h("div", {});

    container.append(heading, grid, quick, setupSlot);

    // ---- live context, loaded quietly after paint ---------------------------
    void (async () => {
      // Today's appointments → check-in card.
      try {
        const appts = await api.appointments(todayLocal());
        if (appts.length) {
          checkin.hint.append(
            h("span", { class: "badge badge-open" }, `${appts.length} booked today`)
          );
        }
      } catch (_e) {
        /* hint only */
      }
      // Shift gaps + open deliveries → shifts card.
      try {
        const slots = await api.listShifts({});
        const gap = slots.reduce((sum, s) => sum + (s.gap || 0), 0);
        if (gap > 0) {
          shifts.hint.append(
            h("span", { class: "badge badge-timeout" }, `${gap} role${gap === 1 ? "" : "s"} need cover`)
          );
        } else if (slots.length) {
          shifts.hint.append(h("span", { class: "badge badge-delivered" }, "all covered ✓"));
        }
      } catch (_e) {
        /* device may not hold the distros domain — the card still links */
      }
      try {
        const deliveries = await api.listDeliveries();
        const open = deliveries.filter((t) => t.status === "Open").length;
        if (open > 0) {
          shifts.hint.append(
            h("span", { class: "badge badge-timeout" }, `🚚 ${open} deliver${open === 1 ? "y" : "ies"} need a driver`)
          );
        }
      } catch (_e) {
        /* hint only */
      }
      // Rebooking queue → outreach card.
      try {
        const rebooking = await api.outreachList({ rebooking_only: true });
        if (rebooking.length) {
          outreach.hint.append(
            h(
              "span",
              { class: "badge badge-timeout" },
              `${rebooking.length} need${rebooking.length === 1 ? "s" : ""} rebooking`
            )
          );
        }
      } catch (_e) {
        /* hint only */
      }
      // Fresh org? Guide the admin through setup instead of empty screens.
      if (isAdmin) {
        try {
          const page = await api.browseHouseholds({ limit: 1 });
          if ((page.total || 0) === 0) {
            const step = (n, view, label, desc) =>
              h(
                "li",
                { class: "list-item list-item--selectable", onclick: () => navigate(view) },
                h("span", { class: "badge badge-open" }, String(n)),
                h(
                  "div",
                  { class: "list-item__body" },
                  h("div", { class: "list-item__label" }, label),
                  h("div", { class: "list-item__meta" }, desc)
                )
              );
            setupSlot.append(
              h(
                "div",
                { class: "card stack" },
                h("h2", { class: "card__title" }, "Get set up"),
                h(
                  "p",
                  { class: "muted", style: { margin: "0" } },
                  "A few steps and your org is running. Tap one to start."
                ),
                h(
                  "ul",
                  { class: "list" },
                  step(1, "admin", "Make it yours", "Name, colors, logo, and which tools you use — under Org settings."),
                  step(2, "roster", "Invite your team", "QR invites enroll volunteer devices in seconds."),
                  step(3, "distros", "Schedule a distro", "Date, place, and appointments per time slot."),
                  step(4, "intake", "Take your first request", "Only a phone number is required.")
                )
              )
            );
          }
        } catch (_e) {
          /* checklist is optional */
        }
      }
    })();
  }

  window.BAM.registerView("home", {
    title: "Home",
    icon: "🏠",
    render,
  });
})();
