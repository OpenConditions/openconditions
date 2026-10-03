import { DigestTee, type StreamTee } from "@openconditions/ingest-framework";
import type { CaptureMeta, RawArchive } from "./archive.js";

/** Makes a tee for a stream from its (credential-redacted) URL. */
export type StreamTeeFactory = (url: string) => Promise<StreamTee>;

/** Digests only, archiving nothing. */
export const digestOnlyTee: StreamTeeFactory = async (url) => ({
  tee: new DigestTee(url),
  finish: async () => {},
});

/** Digests and archives the stream as one raw payload of the poll. */
export function archivingTee(
  archive: RawArchive,
  meta: Omit<CaptureMeta, "url">,
): StreamTeeFactory {
  return async (url) => {
    const full = { ...meta, url };
    const writer = await archive.writer(full);
    const tee = new DigestTee(url, writer);
    return {
      tee,
      finish: async (ok) => {
        if (writer) await archive.finish(full, writer, ok ? tee.digest() : undefined);
      },
    };
  };
}
