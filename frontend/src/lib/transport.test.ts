import { describe, expect, it } from "vitest";
import { AIRPORT_CODES, classifyTransportMode } from "./transport";
import type { Block } from "./types";

const block = (over: Partial<Block>): Block => ({ id: "b", kind: "transport", ...over });

describe("classifyTransportMode", () => {
  describe("explicit mode wins", () => {
    it("returns the mode verbatim — train and ferry included", () => {
      expect(classifyTransportMode(block({ mode: "flight" }))).toBe("flight");
      expect(classifyTransportMode(block({ mode: "drive" }))).toBe("drive");
      expect(classifyTransportMode(block({ mode: "train" }))).toBe("train");
      expect(classifyTransportMode(block({ mode: "ferry" }))).toBe("ferry");
    });

    it("beats drive evidence", () => {
      expect(
        classifyTransportMode(block({ mode: "flight", distance: "850 km", duration: "9 h" })),
      ).toBe("flight");
    });

    it("beats flight evidence — a drive with a booking code stays a drive", () => {
      expect(
        classifyTransportMode(
          block({ mode: "drive", bookingCode: "9GMOL3", title: "Depart Calgary" }),
        ),
      ).toBe("drive");
    });
  });

  describe("drive evidence (no mode) → drive", () => {
    it("from any of distance / duration / route / via", () => {
      expect(classifyTransportMode(block({ distance: "850 km" }))).toBe("drive");
      expect(classifyTransportMode(block({ duration: "9 h" }))).toBe("drive");
      expect(classifyTransportMode(block({ route: "Trans-Canada 1" }))).toBe("drive");
      expect(classifyTransportMode(block({ via: "Banff" }))).toBe("drive");
    });

    it("airport codes in the text do not override drive evidence", () => {
      expect(classifyTransportMode(block({ title: "YYC transfer", distance: "140 km" }))).toBe("drive");
    });
  });

  describe("flight evidence (no mode, no drive info) → flight", () => {
    it("classifies the canada-2027 day-1 flight from its airport codes", () => {
      expect(
        classifyTransportMode(
          block({
            title: "BRU 10:30 → YYC 16:20 via Frankfurt",
            bookingCode: "9GMOL3",
            status: "booked",
          }),
        ),
      ).toBe("flight");
    });

    it("from a booking code alone", () => {
      expect(classifyTransportMode(block({ bookingCode: "9GMOL3" }))).toBe("flight");
    });

    it("from airport codes in the description", () => {
      expect(
        classifyTransportMode(block({ title: "Overnight transfer", description: "Arrive FRA, connect to BRU" })),
      ).toBe("flight");
    });

    it("from flight words in the title, case-insensitively", () => {
      expect(classifyTransportMode(block({ title: "Depart Vancouver" }))).toBe("flight");
      expect(classifyTransportMode(block({ title: "Arrival in Sapporo" }))).toBe("flight");
      expect(classifyTransportMode(block({ title: "Flight CTS → BRU" }))).toBe("flight");
    });
  });

  describe("no evidence → undefined (caller keeps its default)", () => {
    it("is undefined for a bare transfer", () => {
      expect(classifyTransportMode(block({ title: "Transfer to hotel" }))).toBeUndefined();
    });

    it("is undefined for an empty block", () => {
      expect(classifyTransportMode(block({}))).toBeUndefined();
    });
  });

  describe("AIRPORT_CODES", () => {
    it("matches whole codes only — not substrings of longer words", () => {
      expect(AIRPORT_CODES.test("BRU → YYC")).toBe(true);
      expect(AIRPORT_CODES.test("Brussels by train")).toBe(false);
    });
  });
});