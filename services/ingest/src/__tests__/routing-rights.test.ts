import { describe, expect, it } from "vitest";
import { routingRightsOf } from "../pipeline/publish.js";
import { repoFeed } from "./helpers/catalog.js";

describe("routingRightsOf on the repo catalogue", () => {
  // Routing consumers reject a record whose rights were never reviewed, so a
  // feed whose grant was reviewed must carry the review date on its records.
  it.each([
    ["nl-ndw-events", "https://www.ndw.nu/service/copyright", "2026-09-12T00:00:00.000Z"],
    [
      "fi-digitraffic-events",
      "https://www.digitraffic.fi/en/terms-of-service/",
      "2026-09-12T00:00:00.000Z",
    ],
    [
      "fr-dir-events",
      "https://www.data.gouv.fr/pages/legal/licences/etalab-2.0",
      "2026-09-11T00:00:00.000Z",
    ],
    [
      "lu-cita-events",
      "https://creativecommons.org/publicdomain/zero/1.0/",
      "2026-09-11T00:00:00.000Z",
    ],
  ])("%s carries its reviewed terms", (id, origin, reviewedAt) => {
    const rights = routingRightsOf(repoFeed(id));
    expect(rights.reviewed_at).toBe(reviewedAt);
    expect(rights.evidence_origin).toBe(origin);
    expect(rights.source_redistribution).toBe("yes");
  });
});
