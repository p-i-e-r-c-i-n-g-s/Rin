import "../../test/setup";
import { describe, expect, it } from "bun:test";
import { applyThemeColor } from "../theme-color";

const inline = () => document.documentElement.style.getPropertyValue("--theme-rgb");

describe("applyThemeColor", () => {
  it("writes the configured colour inline", () => {
    applyThemeColor("#d7a35f");
    expect(inline()).toBe("215 163 95");
  });

  it("clears the inline colour when none is configured, so the stylesheet's accent applies", () => {
    applyThemeColor("#d7a35f");
    applyThemeColor(undefined);
    expect(inline()).toBe("");
  });

  it("treats an invalid value as unset rather than falling back to pink", () => {
    applyThemeColor("not-a-colour");
    expect(inline()).toBe("");
  });
});
