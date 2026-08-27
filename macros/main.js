import xapi from "xapi";

/*
 * Meeting ending macro for Cisco RoomOS.
 *
 * Watches the booking that is currently running on the device and displays an
 * on-screen alert shortly before it ends, so the room is handed over on time.
 *
 * Everything between the CONFIG markers is generated - use the configuration
 * wizard, or edit project.config.json and run `npm run apply-config`, rather
 * than editing the block by hand:
 *
 *   MACRO_NAME              Name this macro logs under.
 *   WARNING_MINUTES         Minutes before the end of the booking to alert.
 *   ALERT_DURATION_SECONDS  Seconds the alert stays up; 0 keeps it on screen.
 *   ALERT_TITLE             Heading shown on the alert.
 */

// CONFIG:start
const MACRO_NAME = "meeting-ending-macro";
const WARNING_MINUTES = 5;
const ALERT_DURATION_SECONDS = 30;
const ALERT_TITLE = "Meeting ending soon";
// CONFIG:end

const MINUTE_MS = 60000;

let warningTimer = null;
// Identifies the deadline already alerted on, so a booking that is refreshed or
// extended alerts once per end time rather than once per refresh.
let alertedDeadline = null;

/**
 * Milliseconds to wait before alerting about a booking that ends at endTimeMs,
 * or null when the booking needs no alert because it has already ended.
 */
function warningDelayMs(
  endTimeMs,
  nowMs = Date.now(),
  warningMinutes = WARNING_MINUTES,
) {
  if (!Number.isFinite(endTimeMs) || endTimeMs <= nowMs) return null;
  return Math.max(0, endTimeMs - warningMinutes * MINUTE_MS - nowMs);
}

function cancelWarning() {
  if (warningTimer !== null) {
    clearTimeout(warningTimer);
    warningTimer = null;
  }
}

/**
 * Read the booking end time as epoch milliseconds, or null when the booking
 * carries no usable end time.
 */
function endTimeOf(booking) {
  const endTime = booking?.Time?.EndTime;
  if (typeof endTime !== "string") return null;
  const parsed = Date.parse(endTime);
  return Number.isNaN(parsed) ? null : parsed;
}

function minutesLeftText(endTimeMs) {
  const minutes = Math.max(1, Math.round((endTimeMs - Date.now()) / MINUTE_MS));
  const unit = minutes === 1 ? "minute" : "minutes";
  return `This meeting ends in ${minutes} ${unit}.`;
}

async function displayAlert(endTimeMs) {
  await xapi.Command.UserInterface.Message.Alert.Display({
    Title: ALERT_TITLE,
    Text: minutesLeftText(endTimeMs),
    Duration: ALERT_DURATION_SECONDS,
  });
}

function scheduleWarning(bookingId, endTimeMs) {
  cancelWarning();

  const delay = warningDelayMs(endTimeMs);
  if (delay === null) return;

  const deadline = `${bookingId}@${endTimeMs}`;
  if (deadline === alertedDeadline) return;

  warningTimer = setTimeout(() => {
    warningTimer = null;
    alertedDeadline = deadline;
    displayAlert(endTimeMs).catch((error) =>
      console.error(`${MACRO_NAME}: failed to display the alert`, error),
    );
  }, delay);
}

/**
 * Look up the booking that is running now and (re)arm the alert for it.
 */
async function refreshCurrentBooking() {
  let bookingId;
  try {
    bookingId = await xapi.Status.Bookings.Current.Id.get();
  } catch {
    // RoomOS leaves the status unset when no booking is running.
    bookingId = "";
  }

  const id = typeof bookingId === "string" ? bookingId.trim() : "";
  if (!id) {
    cancelWarning();
    return;
  }

  let booking;
  try {
    const result = await xapi.Command.Bookings.Get({ Id: id });
    booking = result?.Booking ?? result;
  } catch (error) {
    console.error(`${MACRO_NAME}: failed to read booking ${id}`, error);
    return;
  }

  const endTimeMs = endTimeOf(booking);
  if (endTimeMs === null) {
    console.warn(`${MACRO_NAME}: booking ${id} has no usable end time`);
    cancelWarning();
    return;
  }

  scheduleWarning(id, endTimeMs);
}

function onBookingsChanged() {
  refreshCurrentBooking().catch((error) =>
    console.error(`${MACRO_NAME}: failed to track the current booking`, error),
  );
}

function onBookingEnd() {
  cancelWarning();
}

async function init() {
  xapi.Status.Bookings.Current.Id.on(onBookingsChanged);
  xapi.Event.Bookings.Updated.on(onBookingsChanged);
  xapi.Event.Bookings.End.on(onBookingEnd);

  await refreshCurrentBooking();

  console.log(
    `${MACRO_NAME}: started, alerting ${WARNING_MINUTES} minutes before a booking ends`,
  );
}

init();

export {
  ALERT_DURATION_SECONDS,
  ALERT_TITLE,
  WARNING_MINUTES,
  endTimeOf,
  warningDelayMs,
};
