import type { PinnedSet } from "../pinned.js";

/**
 * DGT (Spain) RTTI SituationPublication profile 3.7_1.0: the level-C schemas
 * of DATEX II v3.7 the Dirección General de Tráfico publishes for its national
 * access point feed, in its own `http://levelC/schema/3/...` namespaces with
 * Spanish extensions. Listed at
 * https://nap.dgt.es/datex2/v3/dgt/SituationPublication/xsd/3.7_1.0/ and named
 * by the feed's own `xsi:schemaLocation`; the profile is described in
 * https://nap.dgt.es/datex2/v3/dgt/SituationPublication/ ("DATEX2 - DGT (Spain)
 * RTTI SituationPublication Profile.pdf"). Retrieved 2026-10-17. The schemas
 * are published in a directory listing without any licence or redistribution
 * terms, so they are fetched, not vendored.
 *
 * A level-C profile renames every DATEX namespace, so a DGT document cannot be
 * validated against the DATEX II v3.7 schemas themselves.
 */
const BASE = "https://nap.dgt.es/datex2/v3/dgt/SituationPublication/xsd/3.7_1.0/";

const file = (name: string, sha256: string) => ({ name, url: `${BASE}${name}`, sha256 });

export const DATEX2_DGT_ES: PinnedSet = {
  id: "datex2-dgt-es-3.7_1.0",
  files: [
    file("LevelC_3_Common.xsd", "37db0935da66a49fc2b02c4328e62ee16a31d113228df5b2609e9cff90b1c162"),
    file(
      "LevelC_3_CommonExtension.xsd",
      "0d15de53aac2697d317e31bacd4ac159e2bbd49a3398d4ab68782c514c0706d7",
    ),
    file(
      "LevelC_3_CommonSpanishExtension.xsd",
      "0ed7a93a90249402312de7e3504829b34984d94be7a0f70fa218de9c67ced2a6",
    ),
    file(
      "LevelC_3_D2Payload.xsd",
      "ba650b75f3ad48682444188818f78f8b1bda9f6d7b250a3049c54ffacf8e3cf9",
    ),
    file(
      "LevelC_3_LocationExtension.xsd",
      "b7da4ab08ae96967d6278f0f057f131b34d36cb8f419bdd9ec5278c3a30fa23e",
    ),
    file(
      "LevelC_3_LocationReferencing.xsd",
      "a1b114ad61c471eb6914e8592815d6acabb27cbfc42861c8873c3026888a429e",
    ),
    file(
      "LevelC_3_LocationReferencingSpanishExtension.xsd",
      "b0bcdb28e69dce25fc52746853d2496a3f85054cadc819644cec6cab142eecdf",
    ),
    file(
      "LevelC_3_Situation.xsd",
      "85628909e2915562560ed0dc6d6ff12bacae07bfe20371f00a4e587b83c64b7b",
    ),
    file(
      "LevelC_3_SituationSpanishExtension.xsd",
      "5358e56ac77dfdbefeaf95e3f38f60eefcfb58f3d178e6654367fb4e59e0ad48",
    ),
  ],
};

/** The root schema of a DGT `payload` document. */
export const DGT_PAYLOAD_SCHEMA = "LevelC_3_D2Payload.xsd";
