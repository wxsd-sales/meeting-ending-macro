import { describe, expect, test } from "@jest/globals";
import {
  ALERT_DURATION_SECONDS_MAX,
  ALERT_TITLE_MAX_LENGTH,
  DEFAULTS,
  WARNING_MINUTES_MAX,
  buildSnippet,
  injectConfig,
  normaliseValues,
} from "../../wizard/snippet.js";

const VALUES = {
  name: "my-macro",
  warningMinutes: 10,
  alertDurationSeconds: 45,
  alertTitle: "Wrap up",
};

describe("buildSnippet", () => {
  test("emits CONFIG markers with JSON-encoded values", () => {
    expect(buildSnippet(VALUES)).toBe(
      [
        "// CONFIG:start",
        'const MACRO_NAME = "my-macro";',
        "const WARNING_MINUTES = 10;",
        "const ALERT_DURATION_SECONDS = 45;",
        'const ALERT_TITLE = "Wrap up";',
        "// CONFIG:end",
      ].join("\n"),
    );
  });

  test("emits numeric settings as numbers, not strings", () => {
    // The wizard hands over raw text from its number inputs.
    const snippet = buildSnippet({
      ...VALUES,
      warningMinutes: "10",
      alertDurationSeconds: "45",
    });

    expect(snippet).toContain("const WARNING_MINUTES = 10;");
    expect(snippet).toContain("const ALERT_DURATION_SECONDS = 45;");
  });

  test("safely encodes quotes in values", () => {
    const snippet = buildSnippet({ name: 'a"b', alertTitle: 'c"d' });

    expect(snippet).toContain('const MACRO_NAME = "a\\"b";');
    expect(snippet).toContain('const ALERT_TITLE = "c\\"d";');
  });

  test("falls back to the defaults when values are missing", () => {
    const snippet = buildSnippet();

    expect(snippet).toContain('const MACRO_NAME = "";');
    expect(snippet).toContain(
      `const WARNING_MINUTES = ${DEFAULTS.warningMinutes};`,
    );
    expect(snippet).toContain(
      `const ALERT_TITLE = ${JSON.stringify(DEFAULTS.alertTitle)};`,
    );
  });
});

describe("normaliseValues", () => {
  test("keeps whole numbers inside the RoomOS limits", () => {
    expect(normaliseValues({ warningMinutes: 0 }).warningMinutes).toBe(0);
    expect(normaliseValues({ warningMinutes: -5 }).warningMinutes).toBe(0);
    expect(normaliseValues({ warningMinutes: 99999 }).warningMinutes).toBe(
      WARNING_MINUTES_MAX,
    );
    expect(
      normaliseValues({ alertDurationSeconds: 99999 }).alertDurationSeconds,
    ).toBe(ALERT_DURATION_SECONDS_MAX);
  });

  test("rounds fractional minutes", () => {
    expect(normaliseValues({ warningMinutes: 4.6 }).warningMinutes).toBe(5);
  });

  test("falls back to the default when a number cannot be parsed", () => {
    expect(normaliseValues({ warningMinutes: "" }).warningMinutes).toBe(
      DEFAULTS.warningMinutes,
    );
    expect(normaliseValues({ warningMinutes: "soon" }).warningMinutes).toBe(
      DEFAULTS.warningMinutes,
    );
  });

  test("truncates a title RoomOS would reject", () => {
    const title = "x".repeat(ALERT_TITLE_MAX_LENGTH + 50);

    expect(normaliseValues({ alertTitle: title }).alertTitle).toHaveLength(
      ALERT_TITLE_MAX_LENGTH,
    );
  });
});

describe("injectConfig", () => {
  const macro = [
    'import xapi from "xapi";',
    "// CONFIG:start",
    'const MACRO_NAME = "old";',
    "const WARNING_MINUTES = 1;",
    "const ALERT_DURATION_SECONDS = 1;",
    'const ALERT_TITLE = "old";',
    "// CONFIG:end",
    "init();",
    "",
  ].join("\n");

  test("replaces the block and preserves surrounding code", () => {
    const next = injectConfig(macro, VALUES);

    expect(next).toContain('const MACRO_NAME = "my-macro";');
    expect(next).toContain("const WARNING_MINUTES = 10;");
    expect(next.startsWith('import xapi from "xapi";')).toBe(true);
    expect(next.trimEnd().endsWith("init();")).toBe(true);
  });

  test("is idempotent", () => {
    const once = injectConfig(macro, VALUES);

    expect(injectConfig(once, VALUES)).toBe(once);
  });

  test("throws when the markers are missing", () => {
    expect(() => injectConfig("no markers here", VALUES)).toThrow();
  });
});
