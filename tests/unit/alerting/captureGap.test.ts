import { describe, expect, it } from "vitest";
import { detectCaptureGap } from "../../../packages/alerting/src/index";

const now = new Date("2031-01-01T12:00:00Z");
describe("capture-gap detector", () => {
  it("returns null while capture is recent", () => expect(detectCaptureGap(new Date("2031-01-01T11:30:00Z"), now, 3600)).toBeNull());
  it("reports age and window once the threshold is exceeded", () => expect(detectCaptureGap(new Date("2031-01-01T09:00:00Z"), now, 3600)).toEqual({ ageSeconds: 10800, windowSeconds: 3600 }));
  it("treats never-captured as a gap and rejects a bad threshold", () => {
    expect(detectCaptureGap(null, now, 60)).not.toBeNull();
    expect(() => detectCaptureGap(now, now, 0)).toThrow();
  });
});
