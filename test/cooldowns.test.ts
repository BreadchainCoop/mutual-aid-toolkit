import { beforeAll, describe, expect, it } from "vitest";
import { initSubduction } from "@automerge/automerge-repo";
import {
  cooldownUntil,
  isDisabled,
  isInSeason,
  itemPolicyFor,
  setItemPolicy,
} from "../src/domain/cooldowns.ts";
import { fulfill } from "../src/domain/checkin.ts";
import { submitIntake } from "../src/domain/intake.ts";
import { FIXED_NOW, TODAY, freshStore, makeHousehold, makeRequest } from "./helpers.ts";

beforeAll(async () => {
  await initSubduction();
});

describe("item policies: seasons", () => {
  it("season window is inclusive on both ends", () => {
    const policy = { seasonFrom: "06-01", seasonUntil: "08-31" };
    expect(isInSeason(policy, "2026-06-01")).toBe(true);
    expect(isInSeason(policy, "2026-07-15")).toBe(true);
    expect(isInSeason(policy, "2026-08-31")).toBe(true);
    expect(isInSeason(policy, "2026-05-31")).toBe(false);
    expect(isInSeason(policy, "2026-09-01")).toBe(false);
  });

  it("season window wraps the year boundary when from > until", () => {
    const winter = { seasonFrom: "12-01", seasonUntil: "02-28" };
    expect(isInSeason(winter, "2026-12-01")).toBe(true);
    expect(isInSeason(winter, "2026-12-25")).toBe(true);
    expect(isInSeason(winter, "2027-01-15")).toBe(true);
    expect(isInSeason(winter, "2027-02-28")).toBe(true);
    expect(isInSeason(winter, "2026-11-30")).toBe(false);
    expect(isInSeason(winter, "2027-03-01")).toBe(false);
  });

  it("a missing boundary or policy means always in season", () => {
    expect(isInSeason(undefined, TODAY)).toBe(true);
    expect(isInSeason({}, TODAY)).toBe(true);
    expect(isInSeason({ seasonFrom: "12-01" }, TODAY)).toBe(true);
    expect(isInSeason({ seasonUntil: "02-28" }, TODAY)).toBe(true);
  });

  it("isDisabled only flags an explicit true", () => {
    expect(isDisabled(undefined)).toBe(false);
    expect(isDisabled({})).toBe(false);
    expect(isDisabled({ disabled: true })).toBe(true);
  });
});

describe("item policies: setItemPolicy", () => {
  it("merges patches, deletes null keys, drops empty entries", async () => {
    const store = await freshStore();
    setItemPolicy(store.base, "soap", { cooldownDays: 30, seasonFrom: "12-01" });
    setItemPolicy(store.base, "soap", { seasonUntil: "02-28" });
    expect(itemPolicyFor(store.base.doc(), "soap")).toEqual({
      cooldownDays: 30,
      seasonFrom: "12-01",
      seasonUntil: "02-28",
    });

    setItemPolicy(store.base, "soap", { seasonFrom: null, seasonUntil: null });
    expect(itemPolicyFor(store.base.doc(), "soap")).toEqual({ cooldownDays: 30 });

    setItemPolicy(store.base, "soap", { cooldownDays: null });
    expect(itemPolicyFor(store.base.doc(), "soap")).toBeUndefined();
    expect(itemPolicyFor(store.base.doc(), "pads")).toBeUndefined();
  });
});

describe("item policies: cooldownUntil", () => {
  it("never paces without a delivery on record or a cooldown policy", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    // No policy at all.
    expect(cooldownUntil(store.base.doc(), h.id, "soap", TODAY)).toBeNull();
    // Policy but no delivery on record: a FIRST request is never paced.
    setItemPolicy(store.base, "soap", { cooldownDays: 30 });
    expect(cooldownUntil(store.base.doc(), h.id, "soap", TODAY)).toBeNull();
  });

  it("paces inside the window and releases once it elapses", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    setItemPolicy(store.base, "soap", { cooldownDays: 30 });
    store.base.change((d) => {
      d.households[h.id]!.lastDeliveredByType = { soap: "2026-06-25" };
    });
    expect(cooldownUntil(store.base.doc(), h.id, "soap", TODAY)).toBe("2026-07-25");

    // Delivered exactly cooldownDays ago: the until-date IS today, not paced.
    store.base.change((d) => {
      d.households[h.id]!.lastDeliveredByType!.soap = "2026-06-01";
    });
    expect(cooldownUntil(store.base.doc(), h.id, "soap", TODAY)).toBeNull();
  });
});

describe("item policies at intake", () => {
  it("first request is never paced; the re-request after a delivery is", async () => {
    const store = await freshStore();
    setItemPolicy(store.base, "soap", { cooldownDays: 30 });

    const first = await submitIntake(store.base, {
      phoneNumber: "+17185550300",
      requestTypes: ["soap"],
    }, FIXED_NOW);
    expect(first.pacedTypes).toEqual([]);
    expect(first.outOfSeasonTypes).toEqual([]);
    const firstRow = store.base.doc().requests[first.createdRequestIds[0]!]!;
    expect(firstRow.pacedUntil).toBeUndefined();

    fulfill(store.base, { requestIds: [firstRow.id] }, FIXED_NOW);

    const second = await submitIntake(store.base, {
      phoneNumber: "+17185550300",
      requestTypes: ["soap"],
    }, FIXED_NOW);
    expect(second.pacedTypes).toEqual([{ type: "soap", until: "2026-07-31" }]);
    const secondRow = store.base.doc().requests[second.createdRequestIds[0]!]!;
    expect(secondRow.status).toBe("Open"); // accepted, just paced
    expect(secondRow.pacedUntil).toBe("2026-07-31");
  });

  it("skips disabled and out-of-season types, reporting them", async () => {
    const store = await freshStore();
    setItemPolicy(store.base, "pads", { disabled: true });
    // TODAY is 07-01, so a December→February window is out of season.
    setItemPolicy(store.base, "clothing", { seasonFrom: "12-01", seasonUntil: "02-28" });
    setItemPolicy(store.base, "housing", { disabled: true });

    const res = await submitIntake(store.base, {
      phoneNumber: "+17185550301",
      requestTypes: ["pads", "clothing", "soap"],
      socialServiceRequests: ["housing"],
    }, FIXED_NOW);

    expect(res.outOfSeasonTypes.sort()).toEqual(["clothing", "housing", "pads"]);
    expect(res.createdSocialServiceRequestIds).toEqual([]);
    const types = res.createdRequestIds.map((id) => store.base.doc().requests[id]!.type);
    expect(types).toEqual(["soap"]);
  });

  it("duplicate-skip takes precedence over policy checks", async () => {
    const store = await freshStore();
    await submitIntake(store.base, {
      phoneNumber: "+17185550302",
      requestTypes: ["soap"],
    }, FIXED_NOW);
    setItemPolicy(store.base, "soap", { disabled: true });

    const res = await submitIntake(store.base, {
      phoneNumber: "+17185550302",
      requestTypes: ["soap"],
    }, FIXED_NOW);
    expect(res.skippedDuplicateTypes).toEqual(["soap"]);
    expect(res.outOfSeasonTypes).toEqual([]);
  });
});

describe("fulfillment feeds the cooldown", () => {
  it("stamps lastDeliveredByType and clears pacedUntil", async () => {
    const store = await freshStore();
    const h = makeHousehold(store.base);
    const req = makeRequest(store.base, h.id, { type: "pads", pacedUntil: "2026-07-20" });

    fulfill(store.base, { requestIds: [req.id] }, FIXED_NOW);

    const doc = store.base.doc();
    expect(doc.requests[req.id]!.status).toBe("Delivered");
    expect(doc.requests[req.id]!.pacedUntil).toBeUndefined();
    expect(doc.households[h.id]!.lastDeliveredByType).toEqual({ pads: TODAY });
  });
});
