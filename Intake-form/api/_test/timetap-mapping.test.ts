// Byte-exact snapshot tests for timeTapPayloadToSfFields and
// sfAppointmentToTimeTapUpdate. Mirrors the lead-fields.test.ts pattern
// (see api/_test/lead-fields.test.ts). The mapping is locked here: any
// drift requires a deliberate fixture update and matching downstream
// flow review (Update_Lead_On_Appointment in particular).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DC_SOFA_SERVICE_CLASSES,
  sfAppointmentToTimeTapUpdate,
  timeTapPayloadToSfFields,
  timeTapUpdatePayloadsEqual,
  type TimeTapAppointmentPayload,
  type SfAppointmentRecord,
} from "../_lib/timetap-mapping";

// ---------------------------------------------------------------------------
// Inbound fixtures (TimeTap webhook payload → SF Appointment__c fields)
// ---------------------------------------------------------------------------

describe("timeTapPayloadToSfFields — byte-exact SF field contract", () => {
  it("CFQ A-7 booking (auto calendar): all relevant fields populated + DC SOFA flag", () => {
    const payload: TimeTapAppointmentPayload = {
      calendarId: 987654321,
      businessId: 7711,
      status: "OPEN",
      reason: {
        reasonId: 11201,
        reasonDesc: "SOFA Advisor Meeting",
        internalName: "CFQ A-7 (auto calendar)",
        visitMinutes: 45,
        reasonType: "MEETING",
        active: true,
      },
      client: {
        clientId: 5500,
        emailAddress: "pat.tester@example.gov",
        cellPhone: "555-0100",
        fullName: "Pat Tester",
      },
      professional: {
        professionalId: 8801,
        userName: "kristal.advisor",
        email: "kristal@cjcwealth.com",
        fullName: "Kristal Advisor",
      },
      location: { locationName: "Virtual" },
      startDateTimeUTC: "2026-05-20T14:00:00Z",
      endDateTimeUTC: "2026-05-20T14:45:00Z",
      clientTimeZone: "America/New_York",
      staffTimeZone: "America/New_York",
    };

    const actual = timeTapPayloadToSfFields(payload);
    assert.deepStrictEqual(actual, {
      Name: "987654321",
      Business_Id__c: 7711,
      Status__c: "OPEN",
      Reason_Id__c: 11201,
      Reason_Desc__c: "SOFA Advisor Meeting",
      Service_Class__c: "CFQ A-7 (auto calendar)",
      Is_Created_From_DC_SOFA_Site__c: true,
      Client_Id__c: 5500,
      Client_Email__c: "pat.tester@example.gov",
      Staff_Id__c: 8801,
      Staff_Name__c: "Kristal Advisor",
      Start_Date_Time__c: "2026-05-20T14:00:00Z",
      End_Date_Time__c: "2026-05-20T14:45:00Z",
    });
  });

  it("CFQ B+ booking: no DC SOFA flag (B+ is not in the four auto-calendar values)", () => {
    const payload: TimeTapAppointmentPayload = {
      calendarId: 111222333,
      businessId: 7711,
      status: "OPEN",
      reason: {
        reasonId: 11210,
        reasonDesc: "SOFA Advisor Meeting",
        internalName: "CFQ B+",
      },
      client: {
        clientId: 5501,
        emailAddress: "bplus.lead@example.gov",
        fullName: "BPlus Lead",
      },
      professional: {
        professionalId: 8802,
        fullName: "Other Advisor",
      },
      startDateTimeUTC: "2026-06-01T18:30:00Z",
      endDateTimeUTC: "2026-06-01T19:15:00Z",
    };

    const actual = timeTapPayloadToSfFields(payload);
    assert.deepStrictEqual(actual, {
      Name: "111222333",
      Business_Id__c: 7711,
      Status__c: "OPEN",
      Reason_Id__c: 11210,
      Reason_Desc__c: "SOFA Advisor Meeting",
      Service_Class__c: "CFQ B+",
      Client_Id__c: 5501,
      Client_Email__c: "bplus.lead@example.gov",
      Staff_Id__c: 8802,
      Staff_Name__c: "Other Advisor",
      Start_Date_Time__c: "2026-06-01T18:30:00Z",
      End_Date_Time__c: "2026-06-01T19:15:00Z",
    });
    // Explicit: DC_SOFA flag must NOT appear for a B+ booking.
    assert.equal(
      Object.prototype.hasOwnProperty.call(actual, "Is_Created_From_DC_SOFA_Site__c"),
      false,
    );
  });

  it("Cancellation: Status__c flips, datetimes still pass through, cancel context dropped from fields (lives in raw_payload)", () => {
    const payload: TimeTapAppointmentPayload = {
      calendarId: 987654321,
      businessId: 7711,
      // Cancellation webhook — status changes, displayStatus matches.
      status: "CANCELLED",
      displayStatus: "CANCELLED",
      reason: {
        reasonId: 11201,
        reasonDesc: "SOFA Advisor Meeting",
        internalName: "CFQ A-7 (auto calendar)",
      },
      client: {
        clientId: 5500,
        emailAddress: "pat.tester@example.gov",
        fullName: "Pat Tester",
      },
      professional: {
        professionalId: 8801,
        fullName: "Kristal Advisor",
      },
      startDateTimeUTC: "2026-05-20T14:00:00Z",
      endDateTimeUTC: "2026-05-20T14:45:00Z",
      // Cancellation context — captured by the event log's raw_payload,
      // intentionally NOT mapped to Appointment__c fields (Workstream B).
      cancelReason: "Client conflict",
      cancelUser: "JoeSchmo",
    };

    const actual = timeTapPayloadToSfFields(payload);
    assert.deepStrictEqual(actual, {
      Name: "987654321",
      Business_Id__c: 7711,
      Status__c: "CANCELLED",
      Reason_Id__c: 11201,
      Reason_Desc__c: "SOFA Advisor Meeting",
      Service_Class__c: "CFQ A-7 (auto calendar)",
      Is_Created_From_DC_SOFA_Site__c: true,
      Client_Id__c: 5500,
      Client_Email__c: "pat.tester@example.gov",
      Staff_Id__c: 8801,
      Staff_Name__c: "Kristal Advisor",
      Start_Date_Time__c: "2026-05-20T14:00:00Z",
      End_Date_Time__c: "2026-05-20T14:45:00Z",
    });
  });

  it("Reschedule: same calendarId, new datetimes, status still OPEN", () => {
    const payload: TimeTapAppointmentPayload = {
      calendarId: 987654321,
      businessId: 7711,
      status: "OPEN",
      reason: {
        reasonId: 11201,
        reasonDesc: "SOFA Advisor Meeting",
        internalName: "CFQ A-7 (auto calendar)",
      },
      client: {
        clientId: 5500,
        emailAddress: "pat.tester@example.gov",
        fullName: "Pat Tester",
      },
      professional: {
        professionalId: 8801,
        fullName: "Kristal Advisor",
      },
      // Times shifted by 4 hours from the original A-7 fixture.
      startDateTimeUTC: "2026-05-20T18:00:00Z",
      endDateTimeUTC: "2026-05-20T18:45:00Z",
    };

    const actual = timeTapPayloadToSfFields(payload);
    assert.equal(actual?.Name, "987654321");
    assert.equal(actual?.Start_Date_Time__c, "2026-05-20T18:00:00Z");
    assert.equal(actual?.End_Date_Time__c, "2026-05-20T18:45:00Z");
    assert.equal(actual?.Status__c, "OPEN");
    assert.equal(actual?.Is_Created_From_DC_SOFA_Site__c, true);
  });

  it("Lowercase calendarid alias resolves to Name", () => {
    const payload: TimeTapAppointmentPayload = {
      calendarid: 42,
      businessId: 1,
      status: "OPEN",
    };
    const actual = timeTapPayloadToSfFields(payload);
    assert.equal(actual?.Name, "42");
  });

  it("Missing calendarId → undefined (signal to caller to log + skip)", () => {
    const payload: TimeTapAppointmentPayload = {
      businessId: 1,
      status: "OPEN",
    };
    const actual = timeTapPayloadToSfFields(payload);
    assert.equal(actual, undefined);
  });

  it("DC_SOFA_SERVICE_CLASSES contains exactly the four auto-calendar values per WebhookListener.cls:60-63", () => {
    assert.deepStrictEqual(
      [...DC_SOFA_SERVICE_CLASSES].sort(),
      [
        "CFQ A-10 (auto calendar)",
        "CFQ A-7 (auto calendar)",
        "CFQ A-8 (auto calendar)",
        "CFQ A-9 (auto calendar)",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Outbound fixtures (SF Appointment__c row → TimeTap update payload)
// ---------------------------------------------------------------------------

describe("sfAppointmentToTimeTapUpdate — outbound payload contract", () => {
  it("Full SF row → nested update payload with reason/client/professional groups", () => {
    const record: SfAppointmentRecord = {
      Id: "a0H1234567890ABCD",
      Name: "987654321",
      Client_Email__c: "pat.tester@example.gov",
      Status__c: "OPEN",
      Reason_Desc__c: "SOFA Advisor Meeting",
      Service_Class__c: "CFQ A-7 (auto calendar)",
      Staff_Name__c: "Kristal Advisor",
      Business_Id__c: 7711,
      Reason_Id__c: 11201,
      Client_Id__c: 5500,
      Staff_Id__c: 8801,
      Start_Date_Time__c: "2026-05-20T14:00:00Z",
      End_Date_Time__c: "2026-05-20T14:45:00Z",
      Is_Created_From_DC_SOFA_Site__c: true,
    };

    const actual = sfAppointmentToTimeTapUpdate(record);
    assert.deepStrictEqual(actual, {
      status: "OPEN",
      startDateTimeUTC: "2026-05-20T14:00:00Z",
      endDateTimeUTC: "2026-05-20T14:45:00Z",
      reason: {
        reasonId: 11201,
        reasonDesc: "SOFA Advisor Meeting",
        internalName: "CFQ A-7 (auto calendar)",
      },
      client: {
        clientId: 5500,
        emailAddress: "pat.tester@example.gov",
      },
      professional: {
        professionalId: 8801,
        fullName: "Kristal Advisor",
      },
    });
  });

  it("Minimal SF row → minimal outbound payload, no empty sub-objects", () => {
    const record: SfAppointmentRecord = {
      Id: "a0H0000000000XYZ",
      Name: "1",
      Status__c: "CANCELLED",
    };
    const actual = sfAppointmentToTimeTapUpdate(record);
    assert.deepStrictEqual(actual, {
      status: "CANCELLED",
    });
  });

  it("Diff helper detects key-order-independent equality", () => {
    const a = {
      status: "OPEN",
      startDateTimeUTC: "2026-05-20T14:00:00Z",
      reason: { reasonId: 1, reasonDesc: "X" },
    };
    const b = {
      reason: { reasonDesc: "X", reasonId: 1 },
      startDateTimeUTC: "2026-05-20T14:00:00Z",
      status: "OPEN",
    };
    assert.equal(timeTapUpdatePayloadsEqual(a, b), true);
  });

  it("Diff helper distinguishes status changes", () => {
    const a = { status: "OPEN" };
    const b = { status: "CANCELLED" };
    assert.equal(timeTapUpdatePayloadsEqual(a, b), false);
  });
});
