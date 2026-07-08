import { describe, expect, it } from "vitest";
import {
  GOODS,
  LANGUAGES,
  SOCIAL_SERVICES,
  expiryDaysFor,
  isSocialService,
  labelFor,
  normalizeType,
} from "../src/domain/catalog.ts";
import { hashPhone, normalizePhone } from "../src/domain/validation.ts";

describe("catalog", () => {
  it("mirrors the production catalog sizes", () => {
    expect(GOODS.length).toBe(41);
    expect(SOCIAL_SERVICES.length).toBe(13);
    expect(LANGUAGES.length).toBe(12);
  });

  it("normalizes keys, full trilingual labels, and segments", () => {
    expect(normalizeType("soap")).toBe("soap");
    expect(normalizeType("Jabón & Productos de baño / Soap & Shower Products / 肥皂和淋浴用品")).toBe("soap");
    expect(normalizeType("Ollas y Sartenes")).toBe("pots_pans");
    expect(normalizeType("ollas y sartenes")).toBe("pots_pans");
    expect(normalizeType("Mesa de centro / Coffee Table / 咖啡桌")).toBe("coffee_table");
  });

  it("resolves item and legacy aliases", () => {
    expect(normalizeType("Dresser")).toBe("clothes_dresser");
    expect(normalizeType("fridge")).toBe("refrigerator");
    expect(normalizeType("Vivienda")).toBe("housing");
    expect(normalizeType("住房")).toBe("housing");
  });

  it("returns null for unknowns", () => {
    expect(normalizeType("helicopter")).toBeNull();
    expect(normalizeType("")).toBeNull();
  });

  it("expiry tiers: 14 standard, 30 pots & pans", () => {
    expect(expiryDaysFor("soap")).toBe(14);
    expect(expiryDaysFor("pots_pans")).toBe(30);
    expect(expiryDaysFor("not-a-type")).toBe(14);
  });

  it("labelFor passes unknown keys through; isSocialService by category", () => {
    expect(labelFor("nonexistent")).toBe("nonexistent");
    expect(isSocialService("housing")).toBe(true);
    expect(isSocialService("soap")).toBe(false);
  });
});

describe("validation", () => {
  it("normalizes US phones from formatted variants", () => {
    expect(normalizePhone("(718) 555-0100").normalized).toBe("+17185550100");
    expect(normalizePhone("718-555-0100").normalized).toBe("+17185550100");
    expect(normalizePhone("17185550100").normalized).toBe("+17185550100");
  });

  it("flags international numbers", () => {
    const gb = normalizePhone("+442079460958");
    expect(gb.valid).toBe(true);
    expect(gb.international).toBe(true);
  });

  it("rejects garbage", () => {
    expect(normalizePhone("not a phone").valid).toBe(false);
    expect(normalizePhone("").valid).toBe(false);
  });

  it("hashPhone matches the Python hash_phone (migrated phoneHash stays valid)", async () => {
    // .venv/bin/python -c "from bam.validation import hash_phone; print(hash_phone('+17185550100'))"
    expect(await hashPhone("+17185550100")).toBe(
      "f9cac1eb20e53b4b0c965eb7d977bfa2f36cf2d0957a8153078270647f032a77"
    );
    expect(await hashPhone("not a phone")).toBe(
      "f107ea8edefcd3ca05da2b0c8dcf7cbfd15e1537dcc7645964676c7db52eceb5"
    );
  });
});
