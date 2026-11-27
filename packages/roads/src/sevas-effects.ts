import type { Effect, Issue, Schedule, VehicleSelector } from "@openconditions/model";

const BOOLEAN_FLAGS = [
  "1010_51",
  "1010_57",
  "1010_60",
  "1020_12",
  "1020_30",
  "1024_12",
  "1024_13",
  "1024_14",
  "1026_31",
  "1026_32",
  "1026_33",
  "1026_34",
  "1026_35",
  "1026_36",
  "1026_37",
  "1026_38",
  "1026_39",
  "1026_62",
  "1048_14",
  "1048_15",
  "1049_13",
  "1053_36",
  "1053_37",
].map((s) => `vz_${s}`);
const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const decimal = (s: string | undefined) =>
  s !== undefined && /^\d+(?:[.,]\d+)?$/.test(s) && Number(s.replace(",", ".")) > 0
    ? Number(s.replace(",", "."))
    : undefined;
const minutes = (s: string) =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : undefined;

/** Translate only source predicates expressible in the canonical vehicle/effect vocabulary. */
export function sevasEffects(p: Readonly<Record<string, string>>, recordId: string): Effect[] {
  const issues: Issue[] = [];
  const issue = (code: Issue["code"], key: string, text?: string) =>
    issues.push({
      code,
      sourcePath: `properties.${key}`,
      ...(text ? { sourceText: text.slice(0, 1000) } : {}),
    });
  const except: VehicleSelector[] = [];
  if (p["vz_1020_30"] === "true") except.push({ usage: "local_access" });
  if (p["vz_1026_35"] === "true") except.push({ usage: "delivery" });
  for (const flag of BOOLEAN_FLAGS) {
    if (p[flag] !== "false" && p[flag] !== "true") issue("invalid_value", flag, p[flag]);
    else if (p[flag] === "true" && flag !== "vz_1020_30" && flag !== "vz_1026_35")
      issue("compound_condition", flag, p[flag]);
  }
  for (const [key, value] of Object.entries(p)) {
    if (
      key.startsWith("vz_") &&
      key !== "vz_1053_33" &&
      !BOOLEAN_FLAGS.includes(key) &&
      value !== "false" &&
      value !== ""
    )
      issue("unsupported_type", key, value);
  }
  const direction = {
    basis: "geometry" as const,
    value:
      p["fahrtri"] === "0"
        ? ("both" as const)
        : p["fahrtri"] === "1"
          ? ("positive" as const)
          : p["fahrtri"] === "2"
            ? ("negative" as const)
            : ("unknown" as const),
  };
  if (direction.value === "unknown") issue("conflicting_direction", "fahrtri", p["fahrtri"]);
  const periods = schedules(p, () =>
    issue(
      "unsupported_schedule",
      "tage_einzl",
      JSON.stringify({
        tage_einzl: p["tage_einzl"],
        tage_grppe: p["tage_grppe"],
        zeit1_von: p["zeit1_von"],
        zeit1_bis: p["zeit1_bis"],
        zeit2_von: p["zeit2_von"],
        zeit2_bis: p["zeit2_bis"],
      }),
    ),
  );
  let applicability: Effect["applicability"] = {
    kind: "all",
    ...(except.length ? { except } : {}),
  };
  let fields: Record<string, unknown>;
  const override = p["vz_1053_33"];
  if (p["typ"] === "253") {
    // StVO 253 covers combinations and tractors as well as heavy trucks. Keep the
    // known truck predicate, but do not certify its narrower class as complete.
    issue(
      "compound_condition",
      "typ",
      "253 includes vehicle-combination and tractor rules not fully represented",
    );
    const parsed = override === "" ? 3500 : decimal(override);
    const threshold = parsed !== undefined && Number.isFinite(parsed * 1000) ? parsed : undefined;
    if (override !== "" && threshold === undefined) issue("invalid_value", "vz_1053_33", override);
    applicability =
      threshold === undefined
        ? { kind: "unknown", ...(except.length ? { except } : {}) }
        : {
            kind: "classes",
            include: [
              {
                class: "truck",
                when: [
                  {
                    dimension: "gross_weight",
                    operator: "gt",
                    value: { value: override === "" ? threshold : threshold * 1000, unit: "kg" },
                  },
                ],
              },
            ],
            ...(except.length ? { except } : {}),
          };
    fields =
      threshold === undefined ? { kind: "unsupported" } : { kind: "access", mode: "prohibited" };
  } else if (p["typ"] === "262" || p["typ"] === "265") {
    const limit = decimal(p["wert"]);
    if (limit === undefined || !Number.isFinite(limit * (p["typ"] === "262" ? 1000 : 1))) {
      issue("invalid_value", "wert", p["wert"]);
      fields = { kind: "unsupported" };
    } else {
      fields = {
        kind: "dimension_limit",
        dimension: p["typ"] === "262" ? "laden_weight" : "height",
        value: {
          value: limit * (p["typ"] === "262" ? 1000 : 1),
          unit: p["typ"] === "262" ? "kg" : "m",
        },
        operator: "lte",
        meaning: "maximum_permitted",
      };
      if (p["typ"] === "262")
        issue(
          "compound_condition",
          "typ",
          "262 applies separately to vehicles in a combination; aggregate mass is not a substitute",
        );
    }
    if (override !== undefined && override !== "")
      issue("compound_condition", "vz_1053_33", override);
  } else {
    issue("unsupported_type", "typ", p["typ"]);
    fields = { kind: "unsupported" };
    applicability = { kind: "unknown" };
  }
  const kind = String(fields["kind"]);
  return [
    {
      id: `${recordId}/${kind}`,
      v: 1,
      ...fields,
      applicability,
      direction,
      validity: { status: "active", ...(periods?.length ? { periods } : {}) },
      compliance: "mandatory",
      normalization:
        kind === "unsupported" ? "unsupported" : issues.length ? "partial" : "complete",
      ...(issues.length ? { issues } : {}),
      source: { path: "restriktionen_segmente", tokens: { ...p } },
    } as Effect,
  ];
}

function schedules(
  p: Readonly<Record<string, string>>,
  unsupported: () => void,
): Schedule[] | undefined {
  const bits = p["tage_einzl"];
  const group = p["tage_grppe"];
  if (
    !bits ||
    !/^[01]{7}$/.test(bits) ||
    !["0", "1"].includes(group ?? "") ||
    (bits !== "0000000" && group !== "0")
  ) {
    unsupported();
    return;
  }
  const byDay = bits === "0000000" ? undefined : DAYS.filter((_d, i) => bits[i] === "1");
  const windows: Schedule[] = [];
  for (const n of [1, 2]) {
    const start = p[`zeit${n}_von`];
    const end = p[`zeit${n}_bis`];
    if (start === "" && end === "") continue;
    const from = minutes(start ?? "");
    const to = minutes(end ?? "");
    // Berlin changes clocks around 02:00. Fixed elapsed durations cannot
    // faithfully express overnight or transition-overlapping wall-clock ranges.
    if (from === undefined || to === undefined || to <= from || (from < 180 && to >= 120)) {
      unsupported();
      return;
    }
    windows.push({
      repeatFrequency: byDay ? "P1W" : "P1D",
      scheduleTimezone: "Europe/Berlin",
      ...(byDay ? { byDay } : {}),
      startTime: start,
      duration: `PT${to - from}M`,
      endTime: end,
    });
  }
  if (windows.length) return windows;
  return byDay ? [{ repeatFrequency: "P1W", byDay, scheduleTimezone: "Europe/Berlin" }] : undefined;
}
