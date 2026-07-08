# Run your own relay

A **relay** is a small connector that passes updates between your team's
devices. It's how a phone and a laptop — or two volunteers across town — see the
same org. Everything is still local-first: the relay just shuttles messages;
each device holds the whole dataset.

## The default: the community relay

Out of the box, new orgs use the **maintainers' community relay**
(`wss://subduction.sync.inkandswitch.com`, an [Ink & Switch
Subduction](https://www.inkandswitch.com/) sync server). That's why you can
create an org and invite people immediately with nothing to configure.

**What the relay can and can't do.** A relay only forwards updates between
devices already on your roster — it can't add itself to your team, and it isn't
meant to read or change your data. But it is shared infrastructure you don't
control, and today updates are **not** end-to-end encrypted in transit beyond
the normal `wss://` TLS. So:

> For anything sensitive — real names, phone numbers, addresses — **run your own
> relay** rather than the shared one. Your community, your infrastructure.

## Point your org at your own relay

You don't need to change any code. Wherever a relay is set, use your own
`wss://…` address instead of the default:

- **Creating an org:** open **Advanced: sync relay** on the create screen and
  put in your relay address (or clear it to keep the org on one device).
- **Joining an org:** open **Advanced: sync relay** on the join screen and use
  the same relay the org's admin uses.
- **Command line:** pass `--endpoint wss://your-relay` to `org join` and `sync`
  (see [`src/cli.ts`](../src/cli.ts)). A newly created org is offline-only until
  you first attach a relay this way.

Everyone on a team must point at the **same** relay to sync with each other.

## Pinning the relay's key

Each device trusts a relay by its key. The first time you connect to a new
relay, the app **trusts it on first use** and pins its key, so later sessions
verify they're talking to the same relay.

When **joining** an org, if you already know the relay's key you can set it in
the **Relay key** field on the Join screen's Advanced panel (or `--relay-peer
<hex>` on `org join` / `sync`) to skip the trust-on-first-use step. When you
**create** a new org there's no Relay key field — the app pins the relay's key
automatically on first connect.

## Running the relay itself

The relay is a Subduction sync server. Running your own is an
Ink & Switch project rather than part of this toolkit — see
[inkandswitch.com](https://www.inkandswitch.com/) for the Subduction work. Once
it's running at some `wss://…` address, point your org at it as above.

If you'd rather not run any relay, an org works fully **offline on a single
device** — just leave the relay blank. You can add sync later without losing
anything.

---

Back to the [README](../README.md) · [Configure your org](configure-your-org.md)
· [Security & trust](security-and-trust.md)
