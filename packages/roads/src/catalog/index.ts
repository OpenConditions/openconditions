import { registerCatalogResolver } from "@openconditions/ingest-framework";
import { autobahnIndexResolver } from "./autobahn.js";
import { wzdxRegistryResolver } from "./wzdx.js";

registerCatalogResolver("roads", wzdxRegistryResolver);
registerCatalogResolver("roads", autobahnIndexResolver);

export { autobahnIndexResolver, wzdxRegistryResolver };
