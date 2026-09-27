import { describe, it, expect } from "vitest";
import { parseNotice } from "../src/parser.js";
import { ParsedNoticeSchema } from "../src/schemas.js";

describe("parseNotice — valid English notices", () => {
  it("parses a realistic Rajdhani delay notice", () => {
    const result = parseNotice(
      "Train 12951 Mumbai Rajdhani delayed at NDLS by 45 minutes, expected 17:10 due to signal failure",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      trainNumber: "12951",
      stationCode: "NDLS",
      expectedTime: "17:10",
      reason: "signal failure",
    });
  });

  it("parses 'Train No.' with 'hrs' suffix and sentence-bounded reason", () => {
    const result = parseNotice(
      "Train No. 22691 expected arrival 14:30 hrs at PUNE. Delay due to waterlogging.",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      trainNumber: "22691",
      stationCode: "PUNE",
      expectedTime: "14:30",
      reason: "waterlogging",
    });
  });

  it("parses a stn-code notice with ETA and 'because of' reason", () => {
    const result = parseNotice(
      "12002 BCT stn code, running 3 hrs late, ETA 22:15 because of late running of feeder train",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      trainNumber: "12002",
      stationCode: "BCT",
      expectedTime: "22:15",
      reason: "late running of feeder train",
    });
  });

  it("parses the #<train-number> reference form", () => {
    const result = parseNotice("#12951 delayed, now 16:45 at CSMT");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      trainNumber: "12951",
      stationCode: "CSMT",
      expectedTime: "16:45",
    });
  });

  it("converts 12-hour times: 4:45 PM -> 16:45, 12:05 am -> 00:05, 12:30 pm -> 12:30", () => {
    const pm = parseNotice("Train 12951 delayed 4:45 PM at CSMT");
    const am = parseNotice("Train 12951 delayed 12:05 am at CSMT");
    const noon = parseNotice("Train 12951 delayed 12:30 pm at CSMT");
    expect(pm.ok && pm.data.expectedTime).toBe("16:45");
    expect(am.ok && am.data.expectedTime).toBe("00:05");
    expect(noon.ok && noon.data.expectedTime).toBe("12:30");
  });

  it("accepts a messy 24-hour time with a stray meridiem (16:45 pm)", () => {
    const result = parseNotice("Train 12951 heavy rain near LTT, expected 16:45 pm");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.expectedTime).toBe("16:45");
    expect(result.data.stationCode).toBe("LTT");
  });

  it("is deterministic: the same notice parses to the same output", () => {
    const notice =
      "Train 12951 Mumbai Rajdhani delayed at NDLS by 45 minutes, expected 17:10 due to signal failure";
    const first = parseNotice(notice);
    const second = parseNotice(notice);
    expect(second).toEqual(first);
  });
});

describe("parseNotice — Hindi notices", () => {
  it("parses गाड़ी संख्या + CSMT स्टेशन पर + अपेक्षित समय", () => {
    const result = parseNotice(
      "गाड़ी संख्या 12951 CSMT स्टेशन पर 45 मिनट देर से पहुँचेगी, अपेक्षित समय 17:10 बजे",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      trainNumber: "12951",
      stationCode: "CSMT",
      expectedTime: "17:10",
    });
  });

  it("extracts a Hindi reason after के कारण", () => {
    const result = parseNotice(
      "सिग्नल खराबी के कारण गाड़ी 12951 CSMT स्टेशन पर 17:10 बजे पहुँचेगी",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.trainNumber).toBe("12951");
    expect(result.data.stationCode).toBe("CSMT");
    expect(result.data.expectedTime).toBe("17:10");
    expect(result.data.reason).toBe("सिग्नल खराबी");
  });
});

describe("parseNotice — Marathi notices", () => {
  it("parses ट्रेन क्रमांक + PUNE स्थानकी + पोहोचेल time", () => {
    const result = parseNotice(
      "ट्रेन क्रमांक 22691 उशीर होऊन 18:15 बजे PUNE स्थानकी पोहोचेल",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      trainNumber: "22691",
      stationCode: "PUNE",
      expectedTime: "18:15",
    });
  });

  it("extracts a Marathi reason before मुळे and handles glued स्थानकजवळ", () => {
    const result = parseNotice(
      "रेल्वेच्या दोषामुळे ट्रेन 22691 PUNE स्थानकजवळ 18:15 बजे पोहोचेल",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.trainNumber).toBe("22691");
    expect(result.data.stationCode).toBe("PUNE");
    expect(result.data.expectedTime).toBe("18:15");
    expect(result.data.reason).toBe("रेल्वेच्या दोषा");
  });
});

describe("parseNotice — controlled failures", () => {
  it("fails when the train number is missing", () => {
    const result = parseNotice("expected 16:45 at CSMT due to signal failure");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("trainNumber");
  });

  it("fails when the station code is missing", () => {
    const result = parseNotice("Train 12951 delayed at 16:45 due to signal failure");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("stationCode");
  });

  it("fails when the expected time is missing", () => {
    const result = parseNotice("Train 12951 delayed at CSMT due to signal failure");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("expectedTime");
  });

  it("fails on a malformed notice with no railway data at all", () => {
    const result = parseNotice(" NOTE: platform 3 closed ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(
      expect.arrayContaining(["trainNumber", "stationCode", "expectedTime"]),
    );
  });

  it("fails when no station code or time can be read", () => {
    const result = parseNotice("no station code here, just random text 12345");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("stationCode");
    expect(result.missing).toContain("expectedTime");
  });

  it("fails on an invalid 24-hour time (25:00)", () => {
    const result = parseNotice("Train 12951 delayed at CSMT until 25:00");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("expectedTime");
  });

  it("rejects an all-zero train number", () => {
    const result = parseNotice("Train 00000 delayed at CSMT at 16:45");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain("trainNumber");
  });

  it("fails on an empty notice", () => {
    const result = parseNotice("   ");
    expect(result.ok).toBe(false);
  });
});

describe("parseNotice — schema integration", () => {
  it("every successful parse validates against the runtime ParsedNoticeSchema", () => {
    const notices = [
      "Train 12951 Mumbai Rajdhani delayed at NDLS by 45 minutes, expected 17:10 due to signal failure",
      "ट्रेन क्रमांक 22691 उशीर होऊन 18:15 बजे PUNE स्थानकी पोहोचेल",
      "#12951 delayed, now 16:45 at CSMT",
      "सिग्नल खराबी के कारण गाड़ी 12951 CSMT स्टेशन पर 17:10 बजे पहुँचेगी",
    ];
    for (const notice of notices) {
      const result = parseNotice(notice);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(ParsedNoticeSchema.safeParse(result.data).success).toBe(true);
    }
  });
});
