/**
 * Org settings — edit your org's identity, look, and which tools it uses,
 * after creation. The config lives in the CRDT base doc (OrgConfig), so an
 * admin's changes sync to every device on the team with no rebuild.
 *
 * Not a nav view of its own: it renders as the "Org settings" section of the
 * Admin screen (admin.js calls window.BAM.renderOrgSettings), so org
 * configuration lives in ONE place instead of two near-identical menu items.
 */

import type { BamStore } from "./store.ts";
import { isAdmin } from "./roster.ts";
import type { OrgConfig } from "./schema.ts";

interface BamNamespace {
  h: (tag: string, attrs?: unknown, ...children: unknown[]) => HTMLElement;
  clear: (el: HTMLElement) => void;
  toast: (msg: string, kind?: string) => void;
  registerView: (
    name: string,
    def: { title: string; icon?: string; render: (c: HTMLElement) => void }
  ) => void;
  refreshChrome?: () => Promise<void>;
}

/** Optional views an org can turn off. Core views (check-in, intake, look up,
 *  roster, settings) are always on and not listed here. */
const OPTIONAL_VIEWS: { name: string; label: string; hint: string }[] = [
  { name: "appointments", label: "Appointments", hint: "Today's booked appointments." },
  { name: "outreach", label: "Outreach", hint: "Build call lists and text people." },
  { name: "furniture", label: "Furniture", hint: "Large-item / delivery requests." },
  { name: "services", label: "Social services", hint: "Legal aid, interpretation, and more." },
  { name: "distros", label: "Distros & no-shows", hint: "Schedule events; run the no-show pass." },
  { name: "dashboard", label: "Dashboard", hint: "The community's needs at a glance." },
];

const DEFAULT_BRAND = "#ea5817";
const DEFAULT_ACCENT = "#286b63";
/** Logo values the picker can represent; anything else (a raw inline <svg>) is
 *  preserved on save rather than overwritten. */
const KNOWN_LOGOS = new Set(["loaf", "hands", "initials", "none"]);

export function registerSettingsView(store: BamStore): void {
  const BAM = (window as unknown as { BAM: BamNamespace }).BAM;
  const { h, clear, toast } = BAM;

  function render(container: HTMLElement): void {
    const admin = isAdmin(store.roster.doc(), store.peerId);
    const base = store.base.doc()!;
    const cfg: OrgConfig = base.config ?? { name: base.meta.org };
    const b = cfg.branding ?? {};
    const features = cfg.features ?? {};

    clear(container);

    // ---- Identity ---------------------------------------------------------
    const nameInput = h("input", {
      class: "input",
      value: cfg.name ?? base.meta.org,
      placeholder: "e.g. Anytown Mutual Aid",
    }) as HTMLInputElement;
    const shortInput = h("input", {
      class: "input",
      value: cfg.shortName ?? "",
      placeholder: "e.g. AMA",
    }) as HTMLInputElement;

    // ---- Look -------------------------------------------------------------
    const brandInput = h("input", {
      class: "input",
      type: "color",
      value: b.primaryColor ?? DEFAULT_BRAND,
      "aria-label": "Brand color",
    }) as HTMLInputElement;
    const accentInput = h("input", {
      class: "input",
      type: "color",
      value: b.accentColor ?? DEFAULT_ACCENT,
      "aria-label": "Accent color",
    }) as HTMLInputElement;
    const logoSelect = h("select", { class: "input" }) as HTMLSelectElement;
    // A raw-SVG (or the "hands" alias) logo can't be represented by this
    // picker; show it as the default mark and don't clobber it on save.
    const currentLogo = b.logo === "hands" ? "loaf" : b.logo ?? "loaf";
    for (const [val, label] of [
      ["loaf", "Bread mark"],
      ["initials", "Initials chip"],
      ["none", "No logo"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (currentLogo === val) opt.selected = true;
      logoSelect.append(opt);
    }

    // ---- Feature toggles --------------------------------------------------
    const toggles = new Map<string, HTMLInputElement>();
    const toggleRows = OPTIONAL_VIEWS.map((v) => {
      const cb = h("input", { type: "checkbox", id: `feat-${v.name}` }) as HTMLInputElement;
      cb.checked = features[v.name] !== false; // missing = enabled
      cb.disabled = !admin;
      toggles.set(v.name, cb);
      return h(
        "li",
        { class: "list-item" },
        cb,
        h(
          "div",
          { class: "list-item__body" },
          h("label", { class: "list-item__label", for: `feat-${v.name}` }, v.label),
          h("div", { class: "list-item__meta" }, v.hint)
        )
      );
    });

    let fieldId = 0;
    const field = (label: string, control: HTMLElement, hint?: string): HTMLElement => {
      if (!control.id) control.id = `set-f${++fieldId}`;
      const f = h(
        "div",
        { class: "field" },
        h("label", { class: "label", for: control.id }, label),
        control
      );
      if (hint) f.append(h("div", { class: "list-item__meta" }, hint));
      return f;
    };

    const disableAll = (): void => {
      for (const el of [nameInput, shortInput, brandInput, accentInput, logoSelect]) el.disabled = true;
    };
    if (!admin) disableAll();

    const setOrDelete = (obj: Record<string, unknown>, key: string, val: string): void => {
      const v = val.trim();
      if (v) obj[key] = v;
      else if (key in obj) delete obj[key]; // Automerge rejects undefined
    };

    const save = (): void => {
      const name = nameInput.value.trim() || base.meta.org;
      try {
        store.base.change((d) => {
          if (!d.config) d.config = { name };
          d.config.name = name;
          d.meta.org = name; // keep the doc's canonical name (CLI `stats`) in step
          setOrDelete(d.config as unknown as Record<string, unknown>, "shortName", shortInput.value);
          if (!d.config.branding) d.config.branding = {};
          d.config.branding.primaryColor = brandInput.value;
          d.config.branding.themeColor = brandInput.value;
          d.config.branding.accentColor = accentInput.value;
          d.config.branding.title = name;
          // Only write the logo when the current one is representable by the
          // picker — never overwrite a raw-SVG/"hands" logo with "loaf".
          if (KNOWN_LOGOS.has(b.logo ?? "loaf")) d.config.branding.logo = logoSelect.value;
          if (!d.config.features) d.config.features = {};
          for (const v of OPTIONAL_VIEWS) {
            d.config.features[v.name] = !!toggles.get(v.name)?.checked;
          }
        });
        // Keep the roster's org label in step (headings, invite payload).
        if (name !== store.roster.doc()?.org) {
          store.roster.change((r) => {
            r.org = name;
          });
        }
        toast("Settings saved — synced to your team.", "success");
        // refreshChrome re-themes, rebuilds the nav, and re-renders the current
        // (Settings) view — so no separate render() call is needed.
        if (BAM.refreshChrome) void BAM.refreshChrome();
        else render(container);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "error");
      }
    };

    const identityCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Identity"),
      field("Community name", nameInput, "Shows in the top bar and the browser tab."),
      field("Short name / initials", shortInput, "Used for the initials logo, e.g. AMA.")
    );

    const brandRow = h("div", { class: "row" }, brandInput, accentInput);
    const lookCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Look"),
      field("Brand & accent color", brandRow, "The top bar, buttons and highlights."),
      field("Logo", logoSelect, "The mark in the top bar.")
    );

    const featuresCard = h(
      "div",
      { class: "card stack" },
      h("h2", { class: "card__title" }, "Tools your org uses"),
      h(
        "p",
        { class: "muted", style: { margin: "0" } },
        "Turn off what you don't need — hidden tools disappear from the menu for everyone. Check-in, Intake, Look up and your team stay on."
      ),
      h("ul", { class: "list" }, toggleRows)
    );

    const saveBar = admin
      ? h("button", { class: "btn btn-primary btn-block", onclick: save }, "Save settings")
      : h(
          "div",
          { class: "card" },
          h(
            "div",
            { class: "empty-state" },
            h("div", {}, "Only admins can change settings. Ask a team admin to make changes.")
          )
        );

    container.append(identityCard, lookCard, featuresCard, saveBar);
  }

  // Exposed for the Admin view's "Org settings" section (admin.js).
  (BAM as unknown as { renderOrgSettings?: (c: HTMLElement) => void }).renderOrgSettings = render;
}
