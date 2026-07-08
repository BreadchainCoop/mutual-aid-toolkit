/**
 * Browse adapter parity (src/webapi.ts) — the CRDT versions of the console's
 * Appointments, Look up, Furniture, and Social Services views. Mirrors the
 * server-side tests/test_browse.py assertions over the Automerge store.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import type { DocHandle } from "@automerge/automerge-repo";
import { makeWebApi } from "../src/webapi.ts";
import { newId, nowIso, localDate } from "../src/schema.ts";
import type { BamDoc, SocialServiceRequestRow } from "../src/schema.ts";
import { freshStore, makeHousehold, makeRequest } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

function makeService(
  handle: DocHandle<BamDoc>,
  householdId: string,
  overrides: Partial<SocialServiceRequestRow> = {}
): SocialServiceRequestRow {
  const id = newId();
  const now = nowIso();
  const row: SocialServiceRequestRow = {
    id,
    type: "english_classes",
    householdId,
    status: "Open",
    internetAccess: [],
    roofAccessible: false,
    requestOpenedAt: now,
    statusLastUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const merged = Object.fromEntries(
    Object.entries({ ...row, ...overrides }).filter(([, v]) => v !== undefined)
  ) as unknown as SocialServiceRequestRow;
  handle.change((d) => {
    d.socialServiceRequests[id] = merged;
  });
  return handle.doc().socialServiceRequests[id]!;
}

describe("browse adapter (parity with the Airtable Interfaces)", () => {
  it("appointments: day queue ordered chronologically by parsed time", async () => {
    const store = await freshStore();
    const day = localDate(nowIso());
    const ana = makeHousehold(store.base, { name: "Ana", appointmentDate: day, appointmentTime: "11:00 AM", appointmentStatus: "Booked" });
    makeHousehold(store.base, { name: "Bea", appointmentDate: day, appointmentTime: "9:00 AM", appointmentStatus: "Checked-in" });
    makeHousehold(store.base, { name: "Cid", appointmentDate: "2024-01-01", appointmentTime: "10:00 AM" });
    makeRequest(store.base, ana.id, { type: "soap" });
    const api = makeWebApi(store);

    const rows = await api.appointments();
    expect(rows.map((r) => r.name)).toEqual(["Bea", "Ana"]); // 9am before 11am
    expect(rows[1]!.open_request_count).toBe(1);
    expect(rows[0]!.appointment_status).toBe("Checked-in");

    const other = await api.appointments("2024-01-01");
    expect(other.map((r) => r.name)).toEqual(["Cid"]);
  });

  it("browseHouseholds: sorted, searchable, paginated", async () => {
    const store = await freshStore();
    makeHousehold(store.base, { name: "Alice", phoneNumber: "+17185550101" });
    makeHousehold(store.base, { name: "Bob", phoneNumber: "+17185550102" });
    makeHousehold(store.base, { name: "Bianca", phoneNumber: "+17185550103" });
    const api = makeWebApi(store);

    const page = await api.browseHouseholds();
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.name)).toEqual(["Alice", "Bianca", "Bob"]);

    const hits = await api.browseHouseholds({ query: "bi" });
    expect(hits.items.map((i) => i.name)).toEqual(["Bianca"]);

    const p2 = await api.browseHouseholds({ limit: 2, offset: 2 });
    expect(p2.items).toHaveLength(1);
    expect(p2.offset).toBe(2);
  });

  it("browseRequests: filter by category/type/status with delivery detail", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { name: "Rosa" });
    makeRequest(store.base, h.id, { type: "sofa", status: "Open", address: "123 Bleecker St", geocode: "87G8P2XR+00", addressAccuracy: "Building" });
    makeRequest(store.base, h.id, { type: "crib", status: "Delivered" });
    makeRequest(store.base, h.id, { type: "microwave", status: "Open" }); // kitchen
    const api = makeWebApi(store);

    const furn = await api.browseRequests({ category: "furniture" });
    expect(furn.total).toBe(2);
    expect(new Set(furn.items.map((r) => r.type))).toEqual(new Set(["sofa", "crib"]));
    expect(furn.items.every((r) => r.category === "furniture")).toBe(true);
    const sofa = furn.items.find((r) => r.type === "sofa")!;
    expect(sofa.address).toBe("123 Bleecker St");
    expect(sofa.geocode).toBe("87G8P2XR+00");
    expect(sofa.household_name).toBe("Rosa");

    const openFurn = await api.browseRequests({ category: "furniture", status: "Open" });
    expect(openFurn.items.map((r) => r.type)).toEqual(["sofa"]);

    const kitchen = await api.browseRequests({ category: "kitchen" });
    expect(kitchen.items.map((r) => r.type)).toEqual(["microwave"]);
  });

  it("browseServices: by type incl. mesh detail", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base, { name: "Luis" });
    makeService(store.base, h.id, { type: "english_classes" });
    makeService(store.base, h.id, {
      type: "mesh_internet",
      meshStatus: "Step 1 - Interested in Mesh",
      bin: "3000001",
      addressAccuracy: "Building",
      internetAccess: ["El red es caro / My internet is expensive / 我的網絡很貴"],
    });
    const api = makeWebApi(store);

    const eng = await api.browseServices({ type: "english_classes" });
    expect(eng.total).toBe(1);
    expect(eng.items[0]!.household_name).toBe("Luis");

    const mesh = await api.browseServices({ type: "mesh_internet" });
    const row = mesh.items[0]!;
    expect(row.mesh_status).toBe("Step 1 - Interested in Mesh");
    expect(row.bin).toBe("3000001");
    expect(row.internet_access).toEqual(["El red es caro / My internet is expensive / 我的網絡很貴"]);

    const both = await api.browseServices();
    expect(both.total).toBe(2);
  });
});
