import { describe, expect, it } from "vitest";
import { camelCase, firstWord, pascalCase, singular, words } from "../codegen/naming.js";

describe("naming", () => {
  it("splits snake_case and kebab-case literals", () => {
    expect(words("credit_notes")).toEqual(["credit", "notes"]);
    expect(words("day-passes")).toEqual(["day", "passes"]);
    expect(words("upcoming")).toEqual(["upcoming"]);
  });

  it("splits known compound words", () => {
    expect(words("checkin")).toEqual(["check", "in"]);
    expect(words("checkout")).toEqual(["check", "out"]);
  });

  it("camelCases path literals", () => {
    expect(camelCase("credit_notes")).toBe("creditNotes");
    expect(camelCase("alt_currencies")).toBe("altCurrencies");
    expect(camelCase("checkin")).toBe("checkIn");
    expect(camelCase("cancel_payment")).toBe("cancelPayment");
    expect(camelCase("plans")).toBe("plans");
  });

  it("PascalCases path literals", () => {
    expect(pascalCase("credit_notes")).toBe("CreditNotes");
    expect(pascalCase("resources")).toBe("Resources");
  });

  it("singularizes plural nouns without touching non-plurals", () => {
    expect(singular("items")).toBe("item");
    expect(singular("likes")).toBe("like");
    expect(singular("address")).toBe("address"); // -ss guard
    expect(singular("categories")).toBe("category"); // -ies plurals
    expect(singular("passes")).toBe("pass"); // -sses plurals
    expect(singular("upcoming")).toBe("upcoming");
  });

  it("extracts the leading verb of an operationId", () => {
    expect(firstWord("cancelInvoicePayment")).toBe("cancel");
    expect(firstWord("checkInVisit")).toBe("check");
    expect(firstWord("payInvoice")).toBe("pay");
    expect(firstWord("URLThing")).toBe("");
  });
});
