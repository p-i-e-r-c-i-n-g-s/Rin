import "../../test/setup";
import { describe, expect, it } from "bun:test";
import { applyThemeColor, currentAccentHex } from "../theme-color";

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

describe("currentAccentHex", () => {
  it("reads the accent the stylesheet is showing", () => {
    document.documentElement.style.setProperty("--accent", " #8A5A1C");
    expect(currentAccentHex()).toBe("#8a5a1c");
    document.documentElement.style.removeProperty("--accent");
  });

  it("falls back to the amber default, never pink, when no accent is set", () => {
    document.documentElement.style.removeProperty("--accent");
    expect(currentAccentHex()).toBe("#d7a35f");
  });
});
