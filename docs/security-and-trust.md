# Security & trust

Mutual aid work involves real people's names, phone numbers and addresses. This
page is an honest account of what the toolkit protects, and what it doesn't yet
— so you can decide how to run it.

## What you get

- **Your data lives on your devices.** There's no company server holding your
  community's information. Each device on your team keeps its own full copy;
  they reconcile changes when they can reach each other.
- **Device identity.** Every device has its own cryptographic key
  (Ed25519). In the browser the private key is stored non-extractably; the
  command line keeps it in a `0600` file. You are your device's key.
- **A roster gates access.** Only devices an admin has put on the roster can
  sync your org's data. Everyone else is turned away automatically, on every
  device — this is deny-by-default, not a setting you have to switch on.
- **Invites are revocable keys.** A QR/link invite lets a device self-enroll as
  a *volunteer* until it expires or you revoke it. It never grants admin.
- **Works offline.** No network is required to use the app; sync catches up
  later. Less data in flight is less data to intercept.

## What it does *not* do yet

Be clear-eyed about these, especially for sensitive data:

- **Updates are not end-to-end encrypted** beyond the normal `wss://` TLS to the
  relay. A relay you don't control could, in principle, observe traffic it
  forwards. This is why the shared community relay is fine for demos but **not**
  the right home for real household PII — [run your own
  relay](self-host-relay.md).
- **In a local-first app, every enrolled device holds the whole dataset.** The
  admin/volunteer split hides destructive actions from volunteers, but it's a
  guard against accidents, not a hard security boundary between people already
  on your team. Only enroll devices you trust.
- **Revoking a device stops future sync**, but a device that already synced has
  a copy of what it saw. Treat revocation as "no more updates," not "unsee."

## Practical guidance

- **Run your own relay for real PII.** See [Run your own
  relay](self-host-relay.md). Keep the shared relay for trying things out.
- **Keep invites short-lived** and revoke ones you're done with.
- **Only add devices and admins you'd trust with the whole list**, because in a
  local-first tool, that's what they get.
- **Collect the minimum.** The less you record about people, the less there is
  to protect.

This is deliberately not a "military-grade encryption" pitch. It's a tool that
keeps your community's data on your community's devices, with honest edges. If
your threat model needs more, self-host the relay and keep your team small and
trusted.

---

Back to the [README](../README.md) · [Run your own relay](self-host-relay.md)
