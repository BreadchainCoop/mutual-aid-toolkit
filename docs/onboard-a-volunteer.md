# Onboard a volunteer with a QR code

The fast way to add someone to your team: you show a QR code, they scan it, type
their name, and they're in — as a volunteer, ready to work. No accounts, no
passwords, and you never need any of their technical details.

![Inviting a volunteer with a QR code](gifs/invite-qr.gif)

This guide has two halves: what the **admin** does, and what the **volunteer**
does. It takes under a minute.

---

## Admin — create and hand out the invite

You need to be an **admin** (the person who created the org is the first one).

1. Open **your team** (the 🔑 *Roster* screen) from the menu.
2. Find the **QR invite — scan to onboard** card.
3. Fill it in:
   - **Invite name** — for your own reference, e.g. *"July distro volunteers."*
   - **Expires (days)** — how long the code stays valid (default **7**).
   - **Max uses** — how many devices can join with it (default **20**).
4. Tap **Create QR invite**. A QR code appears, along with a **Copy invite
   link** button.
5. Get it to your volunteers:
   - **In person:** show the QR code on your screen; they scan it with their
     phone camera.
   - **Remotely:** tap **Copy invite link** and send it however you like
     (text, chat, email).

That's it. As people join, the invite's line in the list shows how many have
used it.

> **One code, a whole shift.** Set the max uses to cover everyone you expect and
> show the same QR to the whole group at the start of a distribution — each
> person scans it and names themselves.

### Revoking an invite

An invite is like a key: anyone who has it can join as a volunteer while it's
valid. On the invite in the list, tap **Revoke**. People who already joined
**stay on the team**; no new device can use that code again. Keep invites
short-lived and revoke ones you're done with.

### Making someone an admin

Invites **only ever add volunteers** — never admins. To give someone admin
rights, do it yourself on purpose: find them in the **Members** list and tap
**Make admin**. (See [Invite people & manage your team](invite-and-manage.md).)

---

## Volunteer — join in three taps

You just need the QR code or the link the admin gave you, and a phone.

1. **Open it.** Scan the QR with your phone's camera, or tap the link. It opens
   the toolkit in your browser.
2. **Name yourself.** You'll see *"You're invited to \<org\> 🎉."* Type a name
   your team will recognize — e.g. *Rosa — personal phone* — so they know whose
   device this is.
3. **Tap “Join as a volunteer.”** You're in. The app opens with your team's
   tools, ready to take intake or run check-in.

That's the whole thing — no sign-up, no password.

> Already used this device for a different org? Joining an invite **switches
> this device** to the new org as a volunteer (the app tells you before you
> commit).

---

## If it doesn't work

- **"The invite link doesn't do anything / can't find the org."** The org needs
  a **sync relay** so the two devices can reach each other. New orgs use the
  community relay by default, so this usually just works — but if the admin
  created the org offline (relay cleared), no one can join until they add one.
  See [Run your own relay](self-host-relay.md).
- **"It says the invite is expired or used up."** Ask the admin to create a
  fresh one (or raise the expiry / max uses).
- **"I joined but I can't change the team / settings."** That's expected —
  invites add **volunteers**. Ask an admin to promote you.
- **On the same Wi-Fi but still not syncing?** Both devices reach each other
  through the relay, not directly — give it a moment after joining; it catches
  up.

---

Next: [Invite people & manage your team →](invite-and-manage.md) ·
[Run a distribution →](run-a-distribution.md)
