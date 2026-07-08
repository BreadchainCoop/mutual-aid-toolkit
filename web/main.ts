/**
 * Browser entry: device identity, org create/join, then boot the operator
 * console (copied verbatim from bam/web) on the CRDT-backed api adapter.
 *
 * Boot order matters: the console's app.js and views are classic IIFE
 * scripts expecting window.BAM; we set BAM.api (the adapter) and
 * BAM.LANGUAGES first, inject the scripts in order, register the extra
 * Roster view, then call BAM.start().
 */

import { WebCryptoSigner } from "@automerge/automerge-subduction";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { learnedRelayPeers, openStore, type BamStore } from "../src/store.ts";
import { isAdmin, parseInviteUrl, type InvitePayload } from "../src/roster.ts";
import { makeWebApi } from "../src/webapi.ts";
import { registerRosterView } from "../src/roster-view.ts";
import { LANGUAGES } from "../src/domain/catalog.ts";

// Console assets inlined at build time (?raw) so the app is one bundle.
import consoleFonts from "./console/fonts.css?raw";
import consoleStyles from "./console/styles.css?raw";
import consoleApp from "./console/app.js?raw";
import viewCheckin from "./console/views/checkin.js?raw";
import viewAppointments from "./console/views/appointments.js?raw";
import viewLookup from "./console/views/lookup.js?raw";
import viewDashboard from "./console/views/dashboard.js?raw";
import viewIntake from "./console/views/intake.js?raw";
import viewOutreach from "./console/views/outreach.js?raw";
import viewFurniture from "./console/views/furniture.js?raw";
import viewServices from "./console/views/services.js?raw";
import viewDistros from "./console/views/distros.js?raw";
import viewAdmin from "./console/views/admin.js?raw";

// Apply the console fonts + stylesheet (index.html no longer links them).
{
  const fonts = document.createElement("style");
  fonts.textContent = consoleFonts;
  document.head.append(fonts);
  const style = document.createElement("style");
  style.textContent = consoleStyles;
  document.head.append(style);
}

interface AppConfig {
  mode: "create" | "join";
  orgName?: string;
  rosterUrl?: string;
  endpoint?: string;
  relayPeer?: string;
  /** This device's display name on the roster (the founding admin, at create). */
  deviceName?: string;
  /** White-label config captured at org creation, baked into the CRDT doc. */
  orgConfig?: {
    name: string;
    shortName?: string;
    branding?: { primaryColor?: string; themeColor?: string; title?: string; logo?: string };
  };
}

const CONFIG_KEY = "bam-local-first-config";

function loadConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as AppConfig) : null;
  } catch {
    return null;
  }
}

function saveConfig(config: AppConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

/** First-run screen: create a new org or join one by roster URL. */
function firstRunScreen(root: HTMLElement, peerId: string): Promise<AppConfig> {
  return new Promise((resolve) => {
    root.innerHTML = "";
    const wrap = el("div", { class: "card stack", style: "max-width:560px;margin:40px auto;" });
    wrap.append(el("h2", { class: "card__title" }, "Your tools. Your data. Your rules."));
    const intro = el("div", { class: "list-item__meta" });
    intro.textContent =
      "This runs on your device — no company in the middle, works offline, and " +
      "your community's data stays with you. Start your own below, or join one you were invited to.";
    wrap.append(intro);
    const idNote = el("div", { class: "list-item__meta", style: "margin-top:8px" });
    idNote.textContent = "This device's key (share it with an admin to be added):";
    const idBox = el("div", { class: "mono", style: "word-break:break-all;font-size:13px" }, peerId);
    wrap.append(idNote, idBox);

    const orgName = el("input", { class: "input", placeholder: "Community name (e.g. Anytown Mutual Aid)" });
    const shortName = el("input", { class: "input", placeholder: "Short name / initials (e.g. AMA)" });
    const brandColor = el("input", { class: "input", type: "color", value: "#ea5817" }) as HTMLInputElement;
    const logoSelect = el("select", { class: "input" }) as HTMLSelectElement;
    for (const [val, label] of [["loaf", "Bread mark"], ["initials", "Initials chip"], ["none", "No logo"]]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      logoSelect.append(opt);
    }
    const deviceName = el("input", { class: "input", placeholder: "Your device name (e.g. Rosa — laptop)" });
    const createEndpoint = el("input", {
      class: "input",
      placeholder: "wss://relay… (optional — needed to sync/invite other devices)",
    });
    const createBtn = el("button", { class: "btn btn-primary btn-block" }, "Create a new org on this device");

    const rosterUrl = el("input", { class: "input", placeholder: "automerge:… roster URL" });
    const endpoint = el("input", { class: "input", placeholder: "wss://relay… (Subduction endpoint)" });
    const relayPeer = el("input", { class: "input", placeholder: "relay peer id (64 hex) — leave empty to trust & pin on first connect" });
    const joinBtn = el("button", { class: "btn btn-block" }, "Join an existing org");

    createBtn.onclick = () => {
      const name = orgName.value.trim() || "My Mutual Aid";
      resolve({
        mode: "create",
        orgName: name,
        deviceName: deviceName.value.trim() || undefined,
        // TOFU applies when an endpoint is set with no pinned relay key.
        endpoint: createEndpoint.value.trim() || undefined,
        orgConfig: {
          name,
          shortName: shortName.value.trim() || undefined,
          branding: {
            primaryColor: brandColor.value,
            themeColor: brandColor.value,
            title: name,
            logo: logoSelect.value,
          },
        },
      });
    };
    joinBtn.onclick = () => {
      if (!rosterUrl.value.trim().startsWith("automerge:")) {
        alertText("A roster URL starting with automerge: is required to join.");
        return;
      }
      resolve({
        mode: "join",
        rosterUrl: rosterUrl.value.trim(),
        endpoint: endpoint.value.trim() || undefined,
        relayPeer: relayPeer.value.trim() || undefined,
      });
    };

    const alertBox = el("div", { class: "list-item__meta", style: "color:var(--danger)" });
    function alertText(msg: string): void {
      alertBox.textContent = msg;
    }

    const brandRow = el("div", { class: "row" });
    brandRow.append(
      el("label", { class: "list-item__meta" }, "Brand color"),
      brandColor,
      el("label", { class: "list-item__meta" }, "Logo"),
      logoSelect
    );
    wrap.append(
      el("h3", { class: "card__title", style: "font-size:14px;margin-top:12px" }, "Create your org"),
      orgName,
      shortName,
      brandRow,
      deviceName,
      createEndpoint,
      createBtn,
      el("h3", { class: "card__title", style: "font-size:14px;margin-top:12px" }, "Join"),
      rosterUrl,
      endpoint,
      relayPeer,
      joinBtn,
      alertBox
    );
    root.append(wrap);
  });
}

// The operator console is copied verbatim from bam/web/ as classic IIFE
// scripts. We inline their SOURCE at build time (?raw) and run them as
// inline <script> elements after BAM.api is set — so the whole app is a
// single self-contained bundle (no runtime /console/*.js fetches), which
// is what lets StatiCrypt encrypt it as one file.
const CONSOLE_SCRIPTS: string[] = [
  consoleApp,
  viewCheckin,
  viewAppointments,
  viewLookup,
  viewIntake,
  viewOutreach,
  viewFurniture,
  viewServices,
  viewDistros,
  viewDashboard,
];

function runInlineScript(code: string): void {
  const script = document.createElement("script");
  script.textContent = code;
  document.body.append(script);
}

/** QR onboarding: `#invite=…` in the URL → one-field join screen. */
async function inviteScreen(
  root: HTMLElement,
  payload: InvitePayload,
  hadExistingOrg = false
): Promise<{ config: AppConfig; deviceName: string }> {
  return new Promise((resolve) => {
    root.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card stack";
    card.style.cssText = "max-width:480px;margin:48px auto";
    const replaceNote = hadExistingOrg
      ? `<div class="note">This device already belongs to another org — joining this invite switches it to <b>${payload.org ?? "the invited org"}</b> as a volunteer.</div>`
      : "";
    card.innerHTML = `
      <h2 class="card__title">You're invited to ${payload.org ?? "a BAM org"} 🎉</h2>
      <p class="muted" style="margin:0">This enrolls your device as a <b>volunteer</b>.
      Pick a name so the team knows whose device this is:</p>
      ${replaceNote}
      <div class="field">
        <label class="label" for="invite-device-name">Your name</label>
        <input class="input" id="invite-device-name" placeholder="e.g. Rosa — personal phone" autocomplete="off">
      </div>
      <button class="btn btn-primary btn-block" id="invite-join-btn">Join as a volunteer</button>`;
    root.append(card);
    const input = card.querySelector<HTMLInputElement>("#invite-device-name")!;
    const btn = card.querySelector<HTMLButtonElement>("#invite-join-btn")!;
    input.focus();
    const go = (): void => {
      const deviceName = input.value.trim();
      if (!deviceName) {
        input.focus();
        return;
      }
      resolve({
        config: {
          mode: "join",
          rosterUrl: payload.rosterUrl,
          endpoint: payload.endpoint,
          relayPeer: payload.relayPeer,
        },
        deviceName,
      });
    };
    btn.onclick = go;
    input.onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
  });
}

async function boot(): Promise<void> {
  const root = document.getElementById("boot-root")!;
  const signer = await WebCryptoSigner.setup();
  const peerId = signer.peerId().toString();

  // Read the hash BEFORE any stripping. An invite and a `#reset` can be
  // present together (e.g. a "run fresh" link) — parse both first, then
  // clean the URL once, so stripping never eats the invite.
  const invitePayload = parseInviteUrl(location.hash);
  const wantsReset = /[#&]reset\b/.test(location.hash);
  if (wantsReset) {
    localStorage.removeItem(CONFIG_KEY);
  }
  if (invitePayload || wantsReset) {
    // Drop the credential + flags from the address bar/history.
    history.replaceState(null, "", location.pathname + location.search);
  }

  let inviteRedemption: { inviteId: string; secret: string; deviceName: string } | undefined;

  let config = loadConfig();
  // An invite link takes PRECEDENCE over a previously-saved org — otherwise
  // a returning visitor who once created their own org would silently land
  // back in it (as its admin) and the invite would be ignored. Skip only if
  // this device is already configured for the *same* org the invite targets.
  if (invitePayload && (!config || config.rosterUrl !== invitePayload.rosterUrl)) {
    const joined = await inviteScreen(root, invitePayload, !!config);
    config = joined.config;
    inviteRedemption = {
      inviteId: invitePayload.inviteId,
      secret: invitePayload.secret,
      deviceName: joined.deviceName,
    };
  }
  if (!config) {
    config = await firstRunScreen(root, peerId);
  }

  root.innerHTML = "<div class='loading'>Opening the local store…</div>";
  const storage = new IndexedDBStorageAdapter("bam-local-first");
  // Relay-peer field left empty + an endpoint set = trust-on-first-use:
  // learn the relay's key on this connect, pin it in the saved config.
  const tofu = !!config.endpoint && !config.relayPeer;
  let store: BamStore;
  try {
    store = await openStore({
      signer,
      storage,
      invite: inviteRedemption,
      endpoints: config.endpoint ? [config.endpoint] : [],
      alwaysAllow: config.relayPeer ? [config.relayPeer] : [],
      trustDialedRelays: tofu,
      ...(config.mode === "join"
        ? { rosterUrl: config.rosterUrl }
        : {
            createOrg: config.orgName ?? "My Mutual Aid",
            deviceName: config.deviceName || "founding device",
            orgConfig: config.orgConfig,
          }),
    });
  } catch (err) {
    localStorage.removeItem(CONFIG_KEY);
    root.innerHTML = `<div class='card' style='max-width:560px;margin:40px auto'>
      <b>Could not open the org.</b>
      <div class='list-item__meta'>${err instanceof Error ? err.message : String(err)}</div>
      <div class='list-item__meta'>Config was reset — reload to try again.</div></div>`;
    return;
  }
  // Persist config only after a successful open, with the resolved roster URL
  // so subsequent loads work fully offline.
  saveConfig({ ...config, mode: "join", rosterUrl: store.roster.url });

  if (tofu) {
    // Pin the learned relay key so future sessions verify it.
    void (async () => {
      for (let i = 0; i < 20; i++) {
        if (store.repo.isSubductionConnected()) {
          const learned = await learnedRelayPeers(store);
          if (learned.length) {
            saveConfig({ ...config, mode: "join", rosterUrl: store.roster.url, relayPeer: learned[0] });
            console.info(`trust-on-first-use: pinned relay peer ${learned[0]}`);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
  }

  // Console bootstrap: adapter + languages first, then the classic scripts.
  const w = window as unknown as { BAM?: Record<string, unknown> };
  w.BAM = w.BAM || {};
  w.BAM.api = makeWebApi(store);
  w.BAM.LANGUAGES = [...LANGUAGES];

  for (const code of CONSOLE_SCRIPTS) runInlineScript(code);
  // The Admin view (expire / publish website data / scrub PII) is only
  // registered for roster admins. This is a guard against accidents, not a
  // security boundary — in a local-first app every enrolled device holds the
  // whole doc; real enforcement is the sync policy + eventual Keyhive
  // per-doc capabilities.
  const adminAtBoot = isAdmin(store.roster.doc(), store.peerId);
  if (adminAtBoot) runInlineScript(viewAdmin);
  registerRosterView(store);

  // If THIS device's role changes (promoted/demoted by an admin elsewhere),
  // reload so the nav matches the new role. Roster changes are frequent
  // (every join touches the doc) — only react when our own role flips.
  store.roster.on("change", () => {
    if (isAdmin(store.roster.doc(), store.peerId) !== adminAtBoot) {
      location.reload();
    }
  });

  root.remove();
  (w.BAM as { start: () => void }).start();
}

void boot();
