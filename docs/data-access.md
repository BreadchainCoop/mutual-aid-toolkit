# Control who sees which data

Being on the team doesn't have to mean seeing everything. An admin can decide,
person by person, which kinds of data each device on your team can see — so a
volunteer who only needs to help with one thing isn't also holding the rest of
your community's records.

This lives on the **Admin** screen, in the new **Data access** card.

## Data, split into domains

Your org's information is kept in separate pieces — one per **domain**. Think of
each domain as a folder your team shares:

- **Distros** — the distributions and no-shows data. *(This is the first domain
  you can control today.)*
- More domains — people & appointments, requests, outreach — are on the way, and
  will show up in the same card as they land.

Because these are separate, an admin can share one without sharing the others.

## Grant or deny a domain to a person

On the **Data access** card, you'll see each device on your team alongside the
domains you can control. For any person, an admin can:

1. Open the **Data access** card on the **Admin** screen.
2. Find the person in the list.
3. Toggle a domain — for example, **Distros** — **on** to grant it, or **off**
   to deny it.

That's it. The change syncs to the whole team like the rest of the roster, so
every device works from the same picture of who can see what.

Only admins can change data access. Volunteers can't.

## What "denied" actually means

This isn't just hiding a screen. Denying a domain works at the **sync** level:

- **The data never arrives.** If a device is denied the Distros domain, the
  Distros document is simply never sent to it. It's not tucked away behind a
  UI toggle — that device stops receiving the data.
- **It stops future updates.** From the moment you deny a domain, that device
  won't get any new changes to it.
- **It can't un-share the past.** A device that already synced a domain still
  has the copy it saw. Denying it afterward means "no more of this data," not
  "forget what you already have." If that matters for your situation, decide
  access before you share sensitive records, and keep your team small.

## The honest part: how this is enforced

We want to be straight with you about what this guarantee is and isn't.

Data access is **policy-enforced**. Every device that plays by the rules — and
the community relay, when it enforces the policy on its side — honors your
choices and won't pass a denied domain along. In practice, that's the whole
picture: your team's real devices and a relay you trust.

What it is **not** is a lock on the data itself. The information isn't scrambled
so that only the right device can read it. A relay that flat-out ignored the
rules could, in principle, still see what it forwards. That's exactly why, for
real household details, you should [run your own relay](self-host-relay.md)
rather than lean on a shared one you don't control.

So: this is a genuine, sync-level boundary that every honest device and a
well-behaved relay will respect — not a mathematical guarantee against a
misbehaving server. Honest edges, same as the rest of the toolkit.

## More is coming

Distros is the first domain you can control, not the last. As people &
appointments, requests, and outreach become their own domains, they'll appear in
the same **Data access** card — same admin-only controls, same team-wide sync.
Your community, your data, shared exactly as far as you choose.

---

Back to the [README](README.md) · [Security & trust](security-and-trust.md) ·
[Run your own relay](self-host-relay.md)
