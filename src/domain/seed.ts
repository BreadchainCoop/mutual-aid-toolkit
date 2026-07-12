/**
 * Demo data seeder — fills the CURRENT org with rich, obviously-fictional
 * sample data so every feature has something to show: households in many
 * languages (including a couple with no supported language, for the
 * interpreter flag), requests across the catalog with a realistic age
 * spread, paced re-requests, delivered history for the impact report,
 * appointments against a slot-capped distro, a cancelled distro feeding the
 * rebooking queue, a staffed-and-gappy shift board, partner attributions,
 * item policies, referral cues, and a few queued outbox messages.
 *
 * All people are fictional; every phone is a 555 number and every email is
 * @example.com. Seeding goes through the real domain functions wherever an
 * invariant matters (intake, fulfill, booking, cancellation, partner sync),
 * then backdates timestamps directly — the one thing the domain layer
 * rightly refuses to do.
 */

import type { BamStore } from "../store.ts";
import type { BamDoc } from "../schema.ts";
import { fulfilledCountKey, localDate, nowIso } from "../schema.ts";
import { submitIntake } from "./intake.ts";
import { fulfill } from "./checkin.ts";
import { confirmAppointment, queueBlast } from "./outreach.ts";
import { cancelDistro, createDistro } from "./distros.ts";
import { claimShiftSlot, createShiftSlot } from "./shifts.ts";
import { setItemPolicy } from "./cooldowns.ts";
import { partnerSyncByPhone } from "./partners.ts";
import { recordInventoryCount } from "./inventory.ts";
import { claimDelivery, createDelivery } from "./deliveries.ts";

const EN = "Inglés / English / 英文";
const ES = "Español / Spanish / 西班牙语";
const MAND = "Chino Mandarín / Mandarin / 普通话";
const CANT = "Chino Cantonés / Cantonese / 广东话";
const AR = "Árabe / Arabic / 阿拉伯語";
const FR = "Francés / French / 法語";
const HC = "Criollo Haitiano / Haitian Creole / 法屬歸融語";

interface SeedPerson {
  name: string;
  languages: string[];
  preferred?: string;
  goods?: string[];
  services?: string[];
  /** Days ago the oldest request opened (spread the age buckets). */
  ageDays?: number;
  email?: string;
  emailOnly?: boolean;
  notes?: string;
}

// Fictional neighbors of RonTown. Nobody real; all 555 numbers.
const PEOPLE: SeedPerson[] = [
  { name: "Rosa M.", languages: [ES], preferred: ES, goods: ["baby_diapers", "soap"], ageDays: 5 },
  { name: "Miguel A.", languages: [ES, EN], preferred: ES, goods: ["plates", "cups"], ageDays: 45 },
  { name: "Fatima H.", languages: [AR], preferred: AR, goods: ["clothing", "pads"], ageDays: 210, notes: "Sunday appointments only." },
  { name: "Wei L.", languages: [MAND], preferred: MAND, goods: ["pots_pans"], ageDays: 400 },
  { name: "Marie-Claire D.", languages: [HC, FR], preferred: HC, goods: ["baby_diapers", "clothing"], ageDays: 90 },
  { name: "Ahmed S.", languages: [AR, EN], preferred: AR, goods: ["school_supplies"], ageDays: 320 },
  { name: "Yolanda P.", languages: [ES], preferred: ES, goods: ["adult_diapers"], ageDays: 20, notes: "Daughter picks up — works weekdays." },
  { name: "Jean B.", languages: [HC], preferred: HC, services: ["english_classes"], ageDays: 150 },
  { name: "Xiomara R.", languages: [ES, EN], preferred: ES, goods: ["crib"], services: ["tutoring"], ageDays: 30 },
  { name: "Chen Y.", languages: [CANT], preferred: CANT, goods: ["soap", "pads"], ageDays: 75 },
  { name: "Dolores F.", languages: [ES], preferred: ES, goods: ["queen_mattress"], ageDays: 240 },
  { name: "Samir K.", languages: [AR], preferred: AR, services: ["internet"], ageDays: 60 },
  { name: "Ana Sofia T.", languages: [ES], preferred: ES, goods: ["stroller", "baby_diapers"], ageDays: 12 },
  { name: "Patrick O.", languages: [EN], goods: ["microwave"], ageDays: 500 },
  { name: "Lucía V.", languages: [ES], preferred: ES, goods: ["plates", "pots_pans"], ageDays: 700 },
  { name: "Amadou D.", languages: ["Wolof"], goods: ["clothing"], ageDays: 130, notes: "Speaks Wolof — needs an interpreter." },
  { name: "Elena G.", languages: [ES, EN], preferred: EN, services: ["housing"], ageDays: 95 },
  { name: "Hassan M.", languages: [AR], preferred: AR, goods: ["sofa"], ageDays: 180 },
  { name: "Priya N.", languages: [EN], goods: ["cups", "utensils"], ageDays: 55 },
  { name: "Marisol C.", languages: [ES], preferred: ES, services: ["food_benefits"], ageDays: 15 },
  { name: "Kofi A.", languages: [EN, FR], preferred: FR, goods: ["clothing"], ageDays: 25 },
  { name: "Ingrid B.", languages: [EN], emailOnly: true, email: "ingrid@example.com", goods: ["soap"], ageDays: 40 },
  { name: "Tomás E.", languages: [ES], preferred: ES, emailOnly: true, email: "tomas@example.com", goods: ["baby_diapers"], ageDays: 65 },
  { name: "Nadia R.", languages: [AR, EN], preferred: AR, goods: ["pads", "soap"], ageDays: 8 },
  { name: "Li Juan", languages: [MAND, CANT], preferred: MAND, services: ["english_classes"], ageDays: 110 },
  { name: "Oumar S.", languages: ["K'iche'"], goods: ["pots_pans"], ageDays: 260, notes: "K'iche' speaker — bring the language line." },
  { name: "Beatriz L.", languages: [ES], preferred: ES, goods: ["refrigerator"], ageDays: 350 },
  { name: "Yusuf I.", languages: [AR], preferred: AR, services: ["tenant_legal"], ageDays: 85 },
  { name: "Carmen Q.", languages: [ES, EN], preferred: ES, goods: ["school_supplies", "clothing"], ageDays: 300 },
  { name: "Viktor P.", languages: [EN], goods: ["desk"], ageDays: 170 },
  { name: "Aisha W.", languages: [EN], services: ["transportation"], ageDays: 35 },
  { name: "Diego H.", languages: [ES], preferred: ES, goods: ["plates"], ageDays: 420 },
  { name: "Mei F.", languages: [CANT], preferred: CANT, goods: ["baby_diapers", "pads"], ageDays: 50 },
  { name: "Solange T.", languages: [HC, FR], preferred: HC, services: ["internet"], ageDays: 140 },
  { name: "Rafael N.", languages: [ES], preferred: ES, goods: ["cups", "plates", "pots_pans"], ageDays: 600 },
  { name: "Zahra A.", languages: [AR], preferred: AR, goods: ["clothing"], ageDays: 100 },
  { name: "Guadalupe M.", languages: [ES], preferred: ES, goods: ["adult_diapers", "soap"], ageDays: 28 },
  { name: "Henri L.", languages: [FR, HC], preferred: FR, services: ["tutoring"], ageDays: 190 },
  { name: "Svetlana K.", languages: [EN], goods: ["coffee_maker"], ageDays: 80 },
  { name: "Mateo J.", languages: [ES, EN], preferred: EN, goods: ["twin_mattress"], ageDays: 22 },
];

function daysAgoIso(n: number, from = Date.now()): string {
  return new Date(from - n * 86_400_000).toISOString();
}

function daysAheadDate(n: number): string {
  return localDate(new Date(Date.now() + n * 86_400_000).toISOString());
}

export interface SeedReport {
  households: number;
  goodsRequests: number;
  socialServiceRequests: number;
  delivered: number;
  distros: number;
  shiftSlots: number;
  queuedMessages: number;
  rebookingQueue: number;
}

export async function seedDemoData(store: BamStore): Promise<SeedReport> {
  const base = store.base;
  const now = nowIso();
  const today = localDate(now);

  /* Item policies first, so seeded data reflects them ---------------------- */
  setItemPolicy(base, "pots_pans", { cooldownDays: 90 });
  setItemPolicy(base, "plates", { cooldownDays: 30 });
  setItemPolicy(base, "cups", { cooldownDays: 30 });
  // Out of season mid-summer → intake shows "Not offered right now".
  setItemPolicy(base, "school_supplies", { seasonFrom: "08-01", seasonUntil: "10-31" });
  setItemPolicy(base, "air_conditioner", { disabled: true });
  // Per-type expiry: urgent items short, furniture long.
  setItemPolicy(base, "adult_diapers", { expiryDays: 7 });
  setItemPolicy(base, "queen_mattress", { expiryDays: 60 });

  /* Org lists: partners + check-in referral cues --------------------------- */
  base.change((d) => {
    if (!d.config) d.config = { name: d.meta.org };
    d.config.partnerOrgs = ["MMeC", "MESH", "Big Reuse"];
    d.config.referrals = [
      {
        label: "Invite them to scan the MMeC English-classes QR",
        url: "https://example.org/mmec-english",
        showForTypes: ["english_classes", "tutoring"],
      },
      { label: "Community fridge restock is Saturdays — spread the word" },
    ];
  });

  /* Households + requests, via real intake --------------------------------- */
  const created: Array<{ id: string; phone: string; person: SeedPerson }> = [];
  let phoneN = 100;
  for (const person of PEOPLE) {
    const phone = person.emailOnly ? "not-a-number" : `+1646555${String(phoneN++).padStart(4, "0")}`;
    if (!person.emailOnly) phoneN += 1;
    const result = await submitIntake(base, {
      phoneNumber: phone,
      name: person.name,
      email: person.email,
      languages: person.languages,
      preferredLanguage: person.preferred,
      requestTypes: person.goods ?? [],
      socialServiceRequests: person.services ?? [],
      internetAccess: person.services?.includes("internet") ? ["No internet at home"] : [],
      roofAccessible: person.services?.includes("internet") ?? false,
      notes: person.notes,
      streetAddress: person.goods?.some((g) => /mattress|sofa|crib|desk|refrigerator/.test(g))
        ? `${100 + phoneN} Rondo Ave`
        : undefined,
      cityState: "Brooklyn, NY",
      zipCode: "11237",
    });
    created.push({ id: result.householdId, phone, person });
  }

  /* Backdate request ages + flesh out per-household details ---------------- */
  base.change((d) => {
    for (const { id, person } of created) {
      const age = person.ageDays ?? 30;
      for (const row of Object.values(d.requests)) {
        if (row.householdId === id) {
          row.requestOpenedAt = daysAgoIso(age);
          row.createdAt = daysAgoIso(age);
        }
      }
      for (const row of Object.values(d.socialServiceRequests)) {
        if (row.householdId === id) {
          row.requestOpenedAt = daysAgoIso(age);
          row.createdAt = daysAgoIso(age);
        }
      }
      const h = d.households[id];
      if (!h) continue;
      if (person.emailOnly) {
        h.needsEmailOutreach = true;
        if (person.email) h.email = person.email;
      }
      // A spread of last-contact stamps so recency filters bite.
      if (age > 60) h.lastTexted = localDate(daysAgoIso(Math.min(age - 10, 45)));
      if (age > 200) h.lastCalled = localDate(daysAgoIso(30));
    }
  });

  /* Mesh details on the internet requests ---------------------------------- */
  base.change((d) => {
    const meshRows = Object.values(d.socialServiceRequests).filter(
      (r) => r.type === "internet" || r.type === "mesh_internet"
    );
    const stages = ["Install scheduled", "No line of sight", "Waiting on roof access"];
    meshRows.forEach((r, i) => {
      r.meshStatus = stages[i % stages.length]!;
      r.bin = String(3050000 + i);
      r.addressAccuracy = "Building";
    });
  });

  /* Delivered history: today's fulfillments + 8 weeks of counts ------------ */
  const rosaGoods = Object.values(base.doc().requests).filter(
    (r) => r.householdId === created[0]!.id && r.status === "Open"
  );
  if (rosaGoods[0]) {
    fulfill(base, { requestIds: [rosaGoods[0].id], socialServiceRequestIds: [] });
  }
  base.change((d) => {
    const history: Array<[string, number, number]> = [
      ["soap", 7, 4], ["baby_diapers", 7, 6], ["clothing", 10, 3],
      ["plates", 14, 8], ["cups", 14, 7], ["pads", 21, 5],
      ["soap", 28, 5], ["baby_diapers", 28, 4], ["pots_pans", 35, 2],
      ["clothing", 42, 6], ["adult_diapers", 49, 3], ["soap", 56, 4],
    ];
    for (const [type, ago, count] of history) {
      const key = fulfilledCountKey(localDate(daysAgoIso(ago)), type);
      d.fulfilledCounts[key] = (d.fulfilledCounts[key] ?? 0) + count;
    }
  });

  /* A paced re-request: plates delivered 10 days ago, asked again ---------- */
  const lucia = created.find((c) => c.person.name === "Lucía V.")!;
  base.change((d) => {
    const h = d.households[lucia.id];
    if (h) {
      if (!h.lastDeliveredByType) h.lastDeliveredByType = {};
      h.lastDeliveredByType["plates"] = localDate(daysAgoIso(10));
    }
    for (const row of Object.values(d.requests)) {
      if (row.householdId === lucia.id && row.type === "plates" && row.status === "Open") {
        row.pacedUntil = daysAheadDate(20);
      }
    }
  });

  /* Distros: today (slot-capped), upcoming, and one cancelled --------------- */
  const distros = store.distros;
  let distroCount = 0;
  let rebooked = 0;
  if (distros) {
    const todayDistro = createDistro(distros, {
      dateTime: new Date(`${today}T10:00:00`).toISOString(),
      location: "RonTown Community Center",
      durationMinutes: 150,
      slotCapacity: 4,
      notes: "Dishware + diapers focus.",
    });
    void todayDistro;
    createDistro(distros, {
      dateTime: new Date(`${daysAheadDate(5)}T10:00:00`).toISOString(),
      location: "RonTown Community Center",
      durationMinutes: 150,
      slotCapacity: 5,
    });
    const doomed = createDistro(distros, {
      dateTime: new Date(`${daysAheadDate(2)}T14:00:00`).toISOString(),
      location: "Park annex",
      durationMinutes: 120,
      slotCapacity: 6,
      notes: "Pop-up.",
    });
    distroCount = 3;

    // Today's bookings — 11:00 AM ends up AT the cap of 4.
    const bookings: Array<[number, string]> = [
      [0, "10:00 AM"], [1, "10:00 AM"], [2, "10:30 AM"],
      [4, "11:00 AM"], [6, "11:00 AM"], [9, "11:00 AM"], [12, "11:00 AM"],
      [13, "11:30 AM"],
    ];
    for (const [idx, time] of bookings) {
      confirmAppointment(base, created[idx]!.id, { date: today, time });
    }
    // Two already checked in, one habitual no-show.
    base.change((d) => {
      d.households[created[0]!.id]!.appointmentStatus = "Checked-in";
      d.households[created[1]!.id]!.appointmentStatus = "Checked-in";
      const missed = d.households[created[14]!.id]!;
      missed.missedAppointmentCount = 1;
    });

    // Book three onto the pop-up, then cancel it → the rebooking queue.
    // (Goods-holding households with phones, so the outreach list shows them.)
    for (const idx of [3, 15, 17]) {
      confirmAppointment(base, created[idx]!.id, { date: daysAheadDate(2), time: "2:00 PM" });
    }
    const cancelled = cancelDistro(distros, base, doomed.id, {
      reason: "Venue lost power",
    });
    rebooked = cancelled.rebookHouseholdIds.length;

    /* Shift board: staffed and gappy ---------------------------------------- */
    const mkSlot = (
      date: string,
      role: string,
      needed: number,
      lang?: string,
      claimants?: Array<[string, string]>
    ) => {
      const input: Parameters<typeof createShiftSlot>[1] = {
        date,
        eventLabel: "Distro",
        role,
        needed,
      };
      if (lang) input.languageRequired = lang;
      const slot = createShiftSlot(distros, input, store.peerId);
      for (const [peer, name] of claimants ?? []) {
        claimShiftSlot(distros, slot.id, { peerId: peer, name });
      }
      return slot;
    };
    const fake = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
    mkSlot(today, "Check-in", 2, ES, [[fake(1), "Marisol — phone"]]);
    mkSlot(today, "Lift & setup", 2, undefined, [[fake(2), "Diego — van"]]);
    mkSlot(today, "Interpreter", 1, AR);
    mkSlot(daysAheadDate(5), "Check-in", 2, ES);
    mkSlot(daysAheadDate(5), "Driver", 1, undefined, [[fake(3), "Priya — car"]]);
    mkSlot(daysAheadDate(5), "Cleanup", 2, undefined, [[fake(4), "Kofi"]]);
  }

  /* Flags: set-aside + doorstep delivery ------------------------------------ */
  base.change((d) => {
    const fatima = d.households[created[2]!.id]!;
    fatima.setAside = {
      note: "2 packs pads + clothing bag — Friday crew, Colectiva handoff",
      at: now,
      by: "seed demo",
    };
    d.households[created[6]!.id]!.needsDelivery = true; // Yolanda
    d.households[created[26]!.id]!.needsDelivery = true; // Beatriz
  });

  /* Partner sync: MMeC reports two English-class enrollments ---------------- */
  partnerSyncByPhone(base, {
    partner: "MMeC",
    phones: [created[7]!.phone, created[24]!.phone], // Jean B., Li Juan
    outcome: "Delivered",
    types: ["english_classes"],
    includeGoods: false,
  });

  /* Inventory: a post-distro count — clothing is OUT (shows the in-stock
   * outreach filter doing its job) --------------------------------------- */
  recordInventoryCount(
    base,
    {
      date: today,
      counts: {
        soap: 14,
        baby_diapers: 22,
        adult_diapers: 6,
        pads: 18,
        plates: 40,
        cups: 35,
        pots_pans: 3,
        clothing: 0,
      },
      notes: "Post-distro count — clothing rack is empty until the next donation run.",
    },
    { peerId: store.peerId, name: "seed demo" },
    now
  );

  /* Delivery board: one open (needs a driver), one claimed ----------------- */
  if (distros) {
    createDelivery(distros, {
      items: "2 bags of clothing + a walker",
      householdId: created[6]!.id, // Yolanda — flagged needsDelivery above
      householdName: "Yolanda P.",
      phone: created[6]!.phone,
      address: "214 Rondo Ave, Brooklyn, NY 11237",
      notes: "3rd floor, buzzer broken — call on arrival.",
    }, store.peerId, now);
    const claimed = createDelivery(distros, {
      items: "Queen mattress (curbside pickup arranged)",
      householdName: "Beatriz L.",
      address: "250 Rondo Ave, Brooklyn, NY 11237",
    }, store.peerId, now);
    claimDelivery(distros, claimed.id, {
      peerId: "0d".repeat(32),
      name: "Diego — van",
    }, now);
  }

  /* Outbox: a small SMS blast + one email ----------------------------------- */
  const smsTargets = [created[3]!.id, created[9]!.id, created[23]!.id];
  const blast = queueBlast(
    base,
    {
      householdIds: smsTargets,
      template: "",
      templates: {
        Spanish: "Hola {name}! Distro este domingo en RonTown. Responde para tu cita.",
        English: "Hi {name}! Distro this Sunday at RonTown. Reply to book a time.",
        Cantonese: "你好 {name}！本星期日RonTown有派發活動，回覆預約時間。",
      },
    },
    now,
    store.peerId
  );
  const emailTarget = created.find((c) => c.person.emailOnly)!;
  const emailBlast = queueBlast(
    base,
    {
      householdIds: [emailTarget.id],
      template: "Hi {name} — RonTown distro this Sunday. Reply to this email to book a time.",
      channel: "email",
      subject: "RonTown: book your distro appointment",
    },
    now,
    store.peerId
  );

  const doc: BamDoc = base.doc();
  return {
    households: created.length,
    goodsRequests: Object.keys(doc.requests).length,
    socialServiceRequests: Object.keys(doc.socialServiceRequests).length,
    delivered: Object.values(doc.fulfilledCounts).reduce((a, b) => a + b, 0),
    distros: distroCount,
    shiftSlots: distros ? Object.keys(distros.doc().shiftSlots).length : 0,
    queuedMessages: blast.sent + emailBlast.sent,
    rebookingQueue: rebooked,
  };
}
