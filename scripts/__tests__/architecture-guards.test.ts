import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importBoundaryViolations } from "../check-import-boundaries.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function violations(source: string, filePath: string): Promise<number> {
  return importBoundaryViolations(source, filePath).length;
}

/** The kernel depends on nothing, a domain model only on the kernel, the assembly only on model packages. */
function modelMayDependOn(name: string, dependency: string): boolean {
  if (name === "@openconditions/model") return false;
  if (name === "@openconditions/model-registry") {
    return /^@openconditions\/model(?:-[a-z0-9-]+)?$/.test(dependency);
  }
  return dependency === "@openconditions/model";
}

describe("AST architecture boundaries", () => {
  const landing = "services/contributions-api/src/landing/insert.ts";

  it.each(["testcontainers", "@testcontainers/postgresql"])(
    "reserves Docker dependencies for named integration tests and helpers: %s",
    async (specifier) => {
      const source = `import * as containers from "${specifier}";`;
      expect(await violations(source, "services/ingest/src/__tests__/example.test.ts")).toBe(1);
      expect(
        await violations(source, "services/ingest/src/__tests__/example.integration.test.ts"),
      ).toBe(0);
      expect(await violations(source, "scripts/helpers/postgres.integration.ts")).toBe(0);
      expect(
        await violations(`await import("${specifier}");`, "scripts/__tests__/example.test.ts"),
      ).toBe(1);
    },
  );

  it.each([
    'import { getPeerHealth as readHealth } from "@openconditions/federation";',
    'import {\n getPeerHealth\n} from "@openconditions/federation";',
    'export { getPeerHealth } from "@openconditions/federation";',
    'export * from "@openconditions/federation";',
    'const transport = await import("@openconditions/federation");',
    'const transport = require("@openconditions/federation");',
    'export type Health = import("@openconditions/federation").PeerHealthRow;',
    'import transport = require("@openconditions/federation");',
    'import { getPeerHealth } from "../../../../packages/federation/src/peer-health.js";',
  ])("rejects transport dependencies in truth paths: %s", async (source) => {
    expect(await violations(source, landing)).toBe(1);
  });

  it("lets truth paths admit peer records through the transport-free admission entry", async () => {
    const source = 'import { admitFederatedRecord } from "@openconditions/federation/admit";';
    expect(await violations(source, landing)).toBe(0);
    expect(
      await violations('import { x } from "@openconditions/federation/admitted";', landing),
    ).toBe(1);
  });

  it.each(["packages/model/src/kernel/location.ts", "packages/model/src/__tests__/kernel.test.ts"])(
    "keeps the model package free of other OpenConditions packages: %s",
    async (path) => {
      expect(await violations('import { toIsoTimestamp } from "@openconditions/core";', path)).toBe(
        1,
      );
      expect(await violations('import { z } from "zod";', path)).toBe(0);
    },
  );

  it("keeps domain model packages on the kernel alone", async () => {
    const path = "packages/model-roads/src/index.ts";
    expect(await violations('import { kernelModule } from "@openconditions/model";', path)).toBe(0);
    expect(await violations('import { toIsoTimestamp } from "@openconditions/core";', path)).toBe(
      1,
    );
    expect(await violations('import { x } from "@openconditions/model-parking";', path)).toBe(1);
  });

  it("lets the production registry assemble model packages only", async () => {
    const path = "packages/model-registry/src/index.ts";
    expect(await violations('import { kernelModule } from "@openconditions/model";', path)).toBe(0);
    expect(
      await violations('import { roadsModule } from "@openconditions/model-roads";', path),
    ).toBe(0);
    expect(await violations('import { EVENT_PARSERS } from "@openconditions/roads";', path)).toBe(
      1,
    );
  });

  it.each([
    "packages/core/src/db/schema.ts",
    "packages/roads/src/__tests__/restriction-effects.test.ts",
  ])("keeps the assembled registry out of storage and domain packages: %s", async (path) => {
    expect(
      await violations(
        'import { productionRegistry } from "@openconditions/model-registry";',
        path,
      ),
    ).toBe(1);
    expect(await violations('import { kernelModule } from "@openconditions/model";', path)).toBe(0);
  });

  it("allows explanatory comments and ordinary strings containing forbidden module names", async () => {
    const source = `
      // import { getPeerHealth } from "@openconditions/federation";
      /* export * from "@openconditions/ingest/pipeline/normalize"; */
      export const note = 'import("@openconditions/probe-spike")';
    `;
    expect(await violations(source, landing)).toBe(0);
  });

  it.each([
    "@openconditions/ingest/pipeline/normalize",
    "@openconditions/ingest/pipeline/publish",
    "../../ingest/src/pipeline/publish.js",
  ])("rejects the removed ingest-service dependency: %s", async (specifier) => {
    // Relative paths resolving to the sibling service are rejected as well.
    const source = `import { stampAttribution } from "${specifier}";`;
    expect(await violations(source, "services/contributions-api/src/server.ts")).toBe(1);
  });

  it.each(["@openconditions/probe-spike", "@divviup/prio3"])(
    "keeps experimental dependencies out of production: %s",
    async (specifier) => {
      expect(
        await violations(`import * as probe from "${specifier}";`, "services/ingest/src/main.ts"),
      ).toBe(1);
      expect(
        await violations(
          `import * as probe from "${specifier}";`,
          "packages/probe-spike/src/index.ts",
        ),
      ).toBe(0);
    },
  );

  it("allows supported packages, local admission rates and test-only imports", async () => {
    expect(
      await violations(
        `
      import { resolveInstanceId } from "@openconditions/core/server";
      import { writeSnapshot } from "@openconditions/storage";
      import { checkReportRate } from "../abuse/rate.js";
    `,
        landing,
      ),
    ).toBe(0);
    expect(
      await violations(
        'import * as probe from "@openconditions/probe-spike";',
        "services/contributions-api/src/__tests__/example.test.ts",
      ),
    ).toBe(0);
  });
});

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe("workspace dependency declarations", () => {
  it("isolates draft probe dependencies and removes the contributions-to-ingest edge", () => {
    const offenders: string[] = [];
    for (const root of ["packages", "services"]) {
      for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let manifest: Manifest;
        try {
          manifest = JSON.parse(readFileSync(join(ROOT, root, entry.name, "package.json"), "utf8"));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        if (manifest.name === "@openconditions/probe-spike") continue;
        const runtime = {
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        };
        for (const dependency of Object.keys(runtime)) {
          if (dependency === "@openconditions/probe-spike" || dependency.startsWith("@divviup/")) {
            offenders.push(`${manifest.name} -> ${dependency}`);
          }
          if (
            manifest.name === "@openconditions/contributions-api" &&
            dependency === "@openconditions/ingest"
          ) {
            offenders.push(`${manifest.name} -> ${dependency}`);
          }
          if (
            /^@openconditions\/model(?:-|$)/.test(manifest.name) &&
            dependency.startsWith("@openconditions/") &&
            !modelMayDependOn(manifest.name, dependency)
          ) {
            offenders.push(`${manifest.name} -> ${dependency}`);
          }
          if (
            (manifest.name === "@openconditions/core" ||
              manifest.name === "@openconditions/roads") &&
            dependency === "@openconditions/model-registry"
          ) {
            offenders.push(`${manifest.name} -> ${dependency}`);
          }
        }
        for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
          if (dependency.startsWith("@divviup/"))
            offenders.push(`${manifest.name} -> ${dependency}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
