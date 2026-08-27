/*
 * Pure helpers shared by the wizard UI, scripts/apply-config.mjs, and the unit
 * tests. Keeping these free of DOM access means they can be imported directly
 * in Node for testing and in the browser as an ES module.
 *
 * This module owns the format of the macro's CONFIG block, so the wizard and
 * `npm run apply-config` cannot drift apart.
 */

export const CONFIG_START = "// CONFIG:start";
export const CONFIG_END = "// CONFIG:end";

/**
 * Upper bounds taken from the RoomOS xAPI: bookings cannot run longer than 24
 * hours, and `UserInterface Message Alert Display` rejects a Duration above
 * 3600 seconds or a Title longer than 255 characters.
 */
export const WARNING_MINUTES_MAX = 1440;
export const ALERT_DURATION_SECONDS_MAX = 3600;
export const ALERT_TITLE_MAX_LENGTH = 255;

export const DEFAULTS = {
  name: "",
  warningMinutes: 5,
  alertDurationSeconds: 30,
  alertTitle: "Meeting ending soon",
};

function toText(value, fallback, maxLength = Number.POSITIVE_INFINITY) {
  if (value === undefined || value === null) return fallback;
  return String(value).slice(0, maxLength);
}

/**
 * Coerce a form field or JSON value to a whole number inside [0, max], falling
 * back to the default when it is not a usable number.
 */
function toWholeNumber(value, fallback, max) {
  if (typeof value !== "number") {
    // Number("") is 0, so an empty or cleared field has to be caught here for
    // it to fall back to the default rather than silently meaning zero.
    const text = String(value ?? "").trim();
    if (text === "") return fallback;
    value = Number(text);
  }
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(0, Math.round(value)));
}

/**
 * Fill in defaults and clamp every value to what RoomOS accepts, so a snippet
 * built from partial or free-text input is always valid on a device.
 */
export function normaliseValues(values = {}) {
  return {
    name: toText(values.name, DEFAULTS.name),
    warningMinutes: toWholeNumber(
      values.warningMinutes,
      DEFAULTS.warningMinutes,
      WARNING_MINUTES_MAX,
    ),
    alertDurationSeconds: toWholeNumber(
      values.alertDurationSeconds,
      DEFAULTS.alertDurationSeconds,
      ALERT_DURATION_SECONDS_MAX,
    ),
    alertTitle: toText(
      values.alertTitle,
      DEFAULTS.alertTitle,
      ALERT_TITLE_MAX_LENGTH,
    ),
  };
}

/**
 * Build the CONFIG block (markers included) for the given values.
 */
export function buildSnippet(values = {}) {
  const settings = normaliseValues(values);
  return [
    CONFIG_START,
    `const MACRO_NAME = ${JSON.stringify(settings.name)};`,
    `const WARNING_MINUTES = ${settings.warningMinutes};`,
    `const ALERT_DURATION_SECONDS = ${settings.alertDurationSeconds};`,
    `const ALERT_TITLE = ${JSON.stringify(settings.alertTitle)};`,
    CONFIG_END,
  ].join("\n");
}

/**
 * Replace the CONFIG block inside an existing macro source with fresh values,
 * preserving everything around the markers. Idempotent.
 */
export function injectConfig(source, values) {
  const startIdx = source.indexOf(CONFIG_START);
  const endIdx = source.indexOf(CONFIG_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      "Could not find the CONFIG:start / CONFIG:end markers in the macro source.",
    );
  }
  const before = source.slice(0, startIdx);
  const after = source.slice(endIdx + CONFIG_END.length);
  return `${before}${buildSnippet(values)}${after}`;
}
