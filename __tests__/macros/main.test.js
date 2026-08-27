import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const MINUTE_MS = 60000;
const BOOKING_ID = "booking-1";
const NOW = Date.parse("2026-08-26T10:00:00Z");
const END_TIME = "2026-08-26T10:30:00Z";

/** Let the macro's awaited xAPI reads settle without advancing fake timers. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function booking(endTime, id = BOOKING_ID) {
  return {
    Booking: {
      Id: id,
      Title: "Design review",
      Time: { StartTime: "2026-08-26T10:00:00Z", EndTime: endTime },
    },
  };
}

/**
 * Seed the mock device with a current booking, then load the macro. Returns the
 * mock and the macro's exports.
 */
async function startMacro({ bookingId = BOOKING_ID, endTime, now = NOW } = {}) {
  const { default: xapi } = await import("xapi");
  jest.setSystemTime(now);

  if (endTime !== undefined) {
    xapi.Command.Bookings.Get.mockResolvedValue(booking(endTime, bookingId));
  }
  if (bookingId) {
    xapi.Status.Bookings.Current.Id.set(bookingId);
  }

  const macro = await import("../../macros/main.js");
  await flush();

  return { xapi, macro };
}

/** Advance fake time and let any resulting xAPI work settle. */
async function advance(ms) {
  jest.advanceTimersByTime(ms);
  await flush();
}

describe("macros/main.js", () => {
  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    jest.setSystemTime(NOW);
    jest.resetModules();

    const { default: xapi } = await import("xapi");
    xapi.reset();
    xapi.Status.SystemUnit.ProductPlatform.set("Room Bar Pro");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("warningDelayMs", () => {
    it("waits until the configured number of minutes before the end time", async () => {
      const { macro } = await startMacro({ bookingId: "" });
      const end = NOW + 30 * MINUTE_MS;

      expect(macro.warningDelayMs(end, NOW, 5)).toBe(25 * MINUTE_MS);
      expect(macro.warningDelayMs(end, NOW, 10)).toBe(20 * MINUTE_MS);
      expect(macro.warningDelayMs(end, NOW, 0)).toBe(30 * MINUTE_MS);
    });

    it("returns no delay when the end time is already inside the window", async () => {
      const { macro } = await startMacro({ bookingId: "" });

      expect(macro.warningDelayMs(NOW + 2 * MINUTE_MS, NOW, 5)).toBe(0);
    });

    it("returns null when the booking has already ended", async () => {
      const { macro } = await startMacro({ bookingId: "" });

      expect(macro.warningDelayMs(NOW - MINUTE_MS, NOW, 5)).toBeNull();
      expect(macro.warningDelayMs(NOW, NOW, 5)).toBeNull();
      expect(macro.warningDelayMs(Number.NaN, NOW, 5)).toBeNull();
    });
  });

  describe("startup", () => {
    it("looks up the booking that is currently running", async () => {
      const { xapi } = await startMacro({ endTime: END_TIME });

      expect(xapi.Command.Bookings.Get).toHaveBeenCalledWith({
        Id: BOOKING_ID,
      });
    });

    it("does not read a booking when the room is free", async () => {
      const { xapi } = await startMacro({ bookingId: "" });

      expect(xapi.Command.Bookings.Get).not.toHaveBeenCalled();
      await advance(60 * MINUTE_MS);
      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).not.toHaveBeenCalled();
    });
  });

  describe("the ending alert", () => {
    it("waits until WARNING_MINUTES before the booking ends", async () => {
      const { xapi, macro } = await startMacro({ endTime: END_TIME });
      const untilAlert =
        Date.parse(END_TIME) - macro.WARNING_MINUTES * MINUTE_MS - NOW;

      await advance(untilAlert - 1);
      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).not.toHaveBeenCalled();

      await advance(1);
      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledTimes(1);
    });

    it("reports the remaining time and honours the alert settings", async () => {
      const { xapi, macro } = await startMacro({ endTime: END_TIME });

      await advance(Date.parse(END_TIME) - NOW);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledWith({
        Title: macro.ALERT_TITLE,
        Text: `This meeting ends in ${macro.WARNING_MINUTES} minutes.`,
        Duration: macro.ALERT_DURATION_SECONDS,
      });
    });

    it("uses alert parameters RoomOS accepts", async () => {
      const { xapi } = await startMacro({ endTime: END_TIME });

      await advance(Date.parse(END_TIME) - NOW);

      const [result] =
        xapi.Command.UserInterface.Message.Alert.Display.mock.results;
      await expect(result.value).resolves.toEqual({ status: "OK" });
    });

    it("alerts straight away when the macro starts inside the window", async () => {
      const oneMinuteLeft = Date.parse(END_TIME) - MINUTE_MS;
      const { xapi } = await startMacro({
        endTime: END_TIME,
        now: oneMinuteLeft,
      });

      await advance(0);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ Text: "This meeting ends in 1 minute." }),
      );
    });

    it("stays quiet for a booking that has already ended", async () => {
      const { xapi } = await startMacro({
        endTime: END_TIME,
        now: Date.parse(END_TIME) + MINUTE_MS,
      });

      await advance(60 * MINUTE_MS);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).not.toHaveBeenCalled();
    });

    it("stays quiet for a booking without a usable end time", async () => {
      const { default: xapi } = await import("xapi");
      xapi.Command.Bookings.Get.mockResolvedValue({
        Booking: { Id: BOOKING_ID, Time: { EndTime: "not a date" } },
      });
      xapi.Status.Bookings.Current.Id.set(BOOKING_ID);

      await import("../../macros/main.js");
      await advance(60 * MINUTE_MS);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).not.toHaveBeenCalled();
    });

    it("accepts a booking payload that is not wrapped in Booking", async () => {
      const { default: xapi } = await import("xapi");
      xapi.Command.Bookings.Get.mockResolvedValue({
        Id: BOOKING_ID,
        Time: { EndTime: END_TIME },
      });
      xapi.Status.Bookings.Current.Id.set(BOOKING_ID);

      await import("../../macros/main.js");
      await advance(Date.parse(END_TIME) - NOW);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("bookings that change while the macro runs", () => {
    it("tracks a booking that starts after the macro loads", async () => {
      const { xapi } = await startMacro({ bookingId: "" });

      xapi.Command.Bookings.Get.mockResolvedValue(booking(END_TIME));
      xapi.Status.Bookings.Current.Id.set(BOOKING_ID);
      await flush();

      await advance(Date.parse(END_TIME) - NOW);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledTimes(1);
    });

    it("re-arms the alert when a booking is extended", async () => {
      const { xapi } = await startMacro({ endTime: END_TIME });
      const extendedEnd = "2026-08-26T11:00:00Z";

      await advance(Date.parse(END_TIME) - NOW);
      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledTimes(1);

      xapi.Command.Bookings.Get.mockResolvedValue(booking(extendedEnd));
      xapi.Event.Bookings.Updated.emit({ Id: BOOKING_ID });
      await flush();

      await advance(Date.parse(extendedEnd) - Date.parse(END_TIME));

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledTimes(2);
    });

    it("alerts once per end time when the booking is refreshed unchanged", async () => {
      const { xapi } = await startMacro({ endTime: END_TIME });

      await advance(Date.parse(END_TIME) - NOW);

      xapi.Event.Bookings.Updated.emit({ Id: BOOKING_ID });
      await flush();
      xapi.Event.Bookings.Updated.emit({ Id: BOOKING_ID });
      await flush();
      await advance(10 * MINUTE_MS);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).toHaveBeenCalledTimes(1);
    });

    it("drops a pending alert when the booking ends early", async () => {
      const { xapi } = await startMacro({ endTime: END_TIME });

      xapi.Event.Bookings.End.emit({ Id: BOOKING_ID });
      await advance(60 * MINUTE_MS);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).not.toHaveBeenCalled();
    });

    it("drops a pending alert when the room becomes free", async () => {
      const { xapi } = await startMacro({ endTime: END_TIME });

      xapi.Status.Bookings.Current.Id.set("");
      await flush();
      await advance(60 * MINUTE_MS);

      expect(
        xapi.Command.UserInterface.Message.Alert.Display,
      ).not.toHaveBeenCalled();
    });
  });
});
