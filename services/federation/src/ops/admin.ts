/**
 * The operator's commands for the federation, run against `DATABASE_URL` as
 * `node dist/admin.js <command>` in the image (`pnpm --filter
 * @openconditions/federation-api federation-admin <command>` in a checkout):
 *
 *  - `block <instanceId> [--reason <text>]`, `unblock <instanceId>` and
 *    `blocked`: the block list, a transport control that refuses a peer's
 *    requests from then on and leaves what it delivered as it is;
 *  - `erase <class> <recordId>`: erases a record held here (a GDPR request,
 *    a takedown), tombstoning it `rights_revoked` and journalling the
 *    erasure for the peers; prints `erased`, `already erased` or `not found`,
 *    the last exiting non-zero;
 *  - `reconcile <instanceId>`: makes a comparison of this instance's copies
 *    of that peer's records with its present state due.
 *
 * Each prints one line saying what it did; bad usage or a failure exits
 * non-zero. Nothing secret is read or printed.
 */
import { pathToFileURL } from "node:url";
import { eraseRecord } from "@openconditions/contributions-api/federation/tombstone";
import { type RevisionedClass, resolveInstanceId } from "@openconditions/core/server";
import { blockPeer, listBlockedPeers, unblockPeer } from "@openconditions/federation";
import { requireCredential } from "@openconditions/ingest-framework";
import type { Registry } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import postgres from "postgres";
import { requestReconcile } from "../reconcile.js";

const USAGE = `usage: federation-admin block <instanceId> [--reason <text>]
       federation-admin unblock <instanceId>
       federation-admin blocked
       federation-admin erase <situation|feature|offer> <recordId>
       federation-admin reconcile <instanceId>`;

const ERASABLE: readonly RevisionedClass[] = ["situation", "feature", "offer"];

/** What the commands need. */
export interface AdminDeps {
  sql: postgres.Sql;
  registry: Registry;
  /** This instance's id, as the service resolves it. */
  instanceId: string;
  /** Who a block is recorded as made by. */
  operator: string;
  now: () => string;
  out: (line: string) => void;
}

/** Runs one command; returns the process exit code (2 for bad usage). */
export async function runAdminCommand(args: readonly string[], deps: AdminDeps): Promise<number> {
  const [command, ...rest] = args;
  const usage = () => {
    deps.out(USAGE);
    return 2;
  };

  if (command === "block") {
    const [peerId, flag, reason, ...extra] = rest;
    if (!peerId || peerId.startsWith("-") || extra.length > 0) return usage();
    if (flag !== undefined && (flag !== "--reason" || !reason)) return usage();
    await blockPeer(deps.sql, {
      peerId,
      reason: reason ?? null,
      createdBy: deps.operator,
      now: deps.now(),
    });
    deps.out(`blocked ${peerId}${reason ? `: ${reason}` : ""}`);
    return 0;
  }

  if (command === "unblock") {
    const [peerId, ...extra] = rest;
    if (!peerId || extra.length > 0) return usage();
    const blocked = (await listBlockedPeers(deps.sql)).some((peer) => peer.peerId === peerId);
    await unblockPeer(deps.sql, peerId);
    deps.out(blocked ? `unblocked ${peerId}` : `${peerId} was not blocked`);
    return 0;
  }

  if (command === "blocked") {
    if (rest.length > 0) return usage();
    const peers = await listBlockedPeers(deps.sql);
    deps.out(
      peers.length === 0
        ? "no peer is blocked"
        : `blocked: ${peers
            .map(
              (peer) =>
                `${peer.peerId} (since ${peer.createdAt.toISOString()} by ${peer.createdBy}` +
                `${peer.reason ? `: ${peer.reason}` : ""})`,
            )
            .join(", ")}`,
    );
    return 0;
  }

  if (command === "erase") {
    const [cls, recordId, ...extra] = rest;
    if (!cls || !recordId || extra.length > 0) return usage();
    if (!(ERASABLE as readonly string[]).includes(cls)) return usage();
    const outcome = await eraseRecord(
      deps.sql,
      deps.registry,
      { class: cls as RevisionedClass, id: recordId },
      deps.now(),
      deps.instanceId,
    );
    deps.out(outcome);
    return outcome === "not found" ? 1 : 0;
  }

  if (command === "reconcile") {
    const [peerId, ...extra] = rest;
    if (!peerId || extra.length > 0) return usage();
    if (await requestReconcile(deps.sql, peerId, deps.now())) {
      deps.out(`reconcile of ${peerId} due: it runs once the pull reached the peer's live tail`);
      return 0;
    }
    deps.out(`${peerId} has never been pulled here: there are no copies to compare`);
    return 1;
  }

  return usage();
}

async function main(): Promise<void> {
  const sql = postgres(requireCredential(process.env, "DATABASE_URL"), {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "openconditions-federation-admin" },
  });
  try {
    process.exitCode = await runAdminCommand(process.argv.slice(2), {
      sql,
      registry: productionRegistry(),
      instanceId: resolveInstanceId(process.env),
      operator: process.env["USER"] || "federation-admin",
      now: () => new Date().toISOString(),
      out: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    await sql.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
