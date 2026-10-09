import { describe, expect, test } from "vitest";
import { currentMessages } from "../cap/messages.js";
import type { CapAlert } from "../cap/types.js";
import { readCapXml } from "../cap/xml.js";
import { fixture } from "./helpers/hazards-feed.js";

const cap = (name: string) => readCapXml(fixture(name));

/** The three messages of one ECCC warning the Datamart held on 2026-10-08, each updating the ones before. */
const ECCC = {
  first: "eccc-datamart/T_WHCN13_C_CWTO_202610081811_2451493062.cap",
  second: "eccc-datamart/T_WHCN13_C_CWTO_202610081936_2688257323.cap",
  third: "eccc-datamart/T_WHCN13_C_CWTO_202610081959_1129882422.cap",
};
const ROOT = "urn:oid:2.49.0.1.124.3058508579.2026";
const id = (n: number) => `urn:oid:2.49.0.1.124.${n}.2026`;

describe("currentMessages", () => {
  test("an update referencing a message of the parse supersedes it, along the whole chain", () => {
    const alerts = [cap(ECCC.first), cap(ECCC.second), cap(ECCC.third)];
    const { current, superseded, groupOf } = currentMessages(alerts);
    expect(current.map((a) => a.identifier)).toEqual([id(1129882422)]);
    expect(superseded).toBe(2);
    // The chain's root in the parse is the first message, whose earliest reference names the warning.
    for (const a of alerts) expect(groupOf(a.identifier)).toBe(ROOT);
  });

  test("order does not matter, and a message alone keeps its earliest reference as its group", () => {
    const { current } = currentMessages([cap(ECCC.third), cap(ECCC.first)]);
    expect(current.map((a) => a.identifier)).toEqual([id(1129882422)]);
    const alone = currentMessages([cap(ECCC.second)]);
    expect(alone.current).toHaveLength(1);
    expect(alone.superseded).toBe(0);
    expect(alone.groupOf(id(2688257323))).toBe(ROOT);
  });

  test("the root of the chain within the parse decides the group, not the stored predecessor", () => {
    const surge = cap("eccc-storm-surge.xml");
    const ended = cap("eccc-storm-surge-ended.xml");
    const { current, superseded, groupOf } = currentMessages([surge, ended]);
    expect(current).toEqual([ended]);
    expect(superseded).toBe(1);
    expect(groupOf(ended.identifier)).toBe(id(1565919500));
    expect(groupOf(surge.identifier)).toBe(id(1565919500));
  });

  test("a message without references is its own group; an unknown id is itself", () => {
    const storm = cap("dwd-thunderstorm.xml");
    const { current, groupOf } = currentMessages([storm]);
    expect(current).toEqual([storm]);
    expect(groupOf(storm.identifier)).toBe(storm.identifier);
    expect(groupOf("elsewhere")).toBe("elsewhere");
  });

  // Constructed from a real message by one change each.
  test("an acknowledgement or an error report supersedes nothing", () => {
    const storm = cap("dwd-thunderstorm.xml");
    const reference = `${storm.sender},${storm.identifier},${storm.sent}`;
    for (const msgType of ["Ack", "Error"]) {
      const reply: CapAlert = {
        ...storm,
        identifier: `${storm.identifier}.reply`,
        msgType,
        references: reference,
      };
      const { current, superseded, groupOf } = currentMessages([storm, reply]);
      expect(current).toHaveLength(2);
      expect(superseded).toBe(0);
      expect(groupOf(reply.identifier)).toBe(storm.identifier);
    }
  });

  test("a cancel supersedes the message it cancels", () => {
    const storm = cap("dwd-thunderstorm.xml");
    const cancel: CapAlert = {
      ...storm,
      identifier: `${storm.identifier}.cancel`,
      msgType: "Cancel",
      references: `${storm.sender},${storm.identifier},${storm.sent}`,
    };
    const { current, superseded } = currentMessages([storm, cancel]);
    expect(current).toEqual([cancel]);
    expect(superseded).toBe(1);
  });

  test("a reference cycle ends", () => {
    const storm = cap("dwd-thunderstorm.xml");
    const update = (identifier: string, of: string): CapAlert => ({
      ...storm,
      identifier,
      msgType: "Update",
      references: `x,${of},${storm.sent}`,
    });
    const a = update("a", "b");
    const b = update("b", "a");
    const { current, superseded, groupOf } = currentMessages([a, b]);
    expect(current).toEqual([]);
    expect(superseded).toBe(2);
    expect(["a", "b"]).toContain(groupOf("a"));
  });
});
