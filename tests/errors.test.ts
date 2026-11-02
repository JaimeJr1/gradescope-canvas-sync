import { describe, it, expect } from "vitest";
import { SessionExpired, LayoutChanged } from "../src/errors";

describe("errors", () => {
  it("SessionExpired carries the site", () => {
    const e = new SessionExpired("canvas");
    expect(e.site).toBe("canvas");
    expect(e.name).toBe("SessionExpired");
    expect(e).toBeInstanceOf(Error);
  });
  it("LayoutChanged includes detail", () => {
    expect(new LayoutChanged("x").message).toContain("x");
  });
});
