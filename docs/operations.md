# Day-to-day operations

The features in this page came straight out of a year of real mutual-aid
coordination chats: cooldowns so budgets stretch, a coverage board so nobody
scrambles at 11pm, partner sync so nobody re-keys phone lists, and reporting
that finally says what got *done*.

## Per-item cooldowns & seasons

Some items are consumable (diapers, soap — request any time). Some are
durable (dishware, pots & pans — one delivery should last a while). **Admin →
Cooldowns & seasons** sets, per item:

- **Cooldown days** — after a *delivery*, that household's re-request of the
  same item waits this many days before re-entering outreach. A **first
  request is never delayed**, and the request is accepted, not dropped: the
  intake form tells the person "you can request this again after ⟨date⟩", and
  check-in shows the same note.
- **Season window (MM-DD → MM-DD)** — outside it the item disappears from
  intake (think school supplies: `08-01 → 10-31`). Windows may wrap the year.
- **Paused** — hides the item entirely until you flip it back.

## Appointments with slot capacity

Give a distro an **appointments-per-30-min-slot cap** when you schedule it.
Booking into a full slot is refused (with an explicit "book anyway" override),
so schedulers can't double-book blind. **Distros → Booking load by slot**
shows how full a day is; the same hint appears inline when booking from
Outreach.

**Cancelling a distro** moves every booked household into the **rebooking
queue** — they keep their place, outreach sees a "Needs rebooking" filter, and
check-in flags them. Nobody shows up outside a closed venue claiming a cita.

## Shifts — the coverage board

**Shifts** lists role slots per date: *check-in (Spanish required)*, *lift*,
*interpreter — Arabic*, *driver*. Volunteers tap **"I'll take it"**;
"Can't make it" hands it back with zero ceremony. Gaps are loud ("NEEDS 2"),
covered slots are quiet. Admins post slots and can release claims.

## Partner fulfillment sync

Partners fulfill things (English classes, mesh installs, furniture) and
report back phone lists. **Admin → Partner fulfillment sync**: paste the
numbers, pick *Delivered* or *Timeout*, **dry-run to preview** exactly what
would close, then apply. Closed rows carry an audit note
(`[MMeC sync 2026-07-11: Delivered]`), social-service rows record the partner
org, and deliveries stamp the item cooldowns.

Devices need the **partner-sync grant** (Roster → member chips) unless they're
admins.

## Outreach: email channel, language routing, rebooking

- **Email channel** — households with no working phone but a good email used
  to be closed as "unresponsive" without ever being reachable. Switch the
  channel toggle to *Email*, and the list becomes exactly those households;
  blasts queue as email with a subject line.
- **Preferred language** — intake now records the language to *lead with*,
  separate from "also speaks". Routing uses it first.
- **🌐 interpreter** — households with no catalog-supported language are
  flagged (and filterable) instead of silently never contacted.
- Templates use `{name}`-style placeholders; substituted values are wrapped in
  Unicode bidi isolates so **RTL templates (Arabic) can't scramble** names or
  addresses.

## Check-in extras

- Search by **email fragment** as well as name / phone last-4.
- **Referral cues** (Admin → Check-in referral cues) remind volunteers, in the
  moment, to offer partner programs — "invite them to scan the English-classes
  QR" — optionally only for households with matching open requests.
- **📦 Set aside** bags items for after-hours pickup; **🚚 needs delivery**
  flags homebound households.
- Devices with the **contact-fix grant** can correct a typo'd phone/email;
  every fix appends a masked audit line (last-4 only) to the household notes.

## Reporting

- **Dashboard → Waitlist by item** — open counts with age buckets, language
  split, paced counts, and a "needs an interpreter" signal per item.
- **Dashboard → Impact report** — deliveries over any date range with a
  one-tap copy. Counts only, no personal data: safe for donors and socials.

---

Back to the [README](README.md) · [Control who sees which data](data-access.md)
