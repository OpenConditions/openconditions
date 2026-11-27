import { SaxesParser } from "saxes";
import { DiscoveryError, type Distribution } from "./model.js";
import { baseDistribution, countries } from "./normalize.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  DCAT = "http://www.w3.org/ns/dcat#",
  DCT = "http://purl.org/dc/terms/";
const XML = "http://www.w3.org/XML/1998/namespace",
  XMLNS = "http://www.w3.org/2000/xmlns/";
const MOB = "http://w3id.org/mobilitydcat-ap#",
  SKOS = "http://www.w3.org/2004/02/skos/core#",
  FOAF = "http://xmlns.com/foaf/0.1/";
interface Value {
  ref?: string;
  text?: string;
  lang?: string;
}
interface Node {
  id: string;
  properties: Map<string, Value[]>;
}
interface Frame {
  kind: "root" | "node" | "property";
  node?: Node;
  subject?: Node;
  predicate?: string;
  value?: Value;
  text: string;
  lang?: string;
  children: number;
}
function reject(): never {
  throw new DiscoveryError("xml_rejected");
}
function absolute(value: string): string {
  try {
    new URL(value);
    return value;
  } catch {
    return reject();
  }
}
/** A finite, namespace-aware subset. No dereferencing, DTDs, xml:base or RDF collections. */
export function parseRdf(xml: string): {
  datasets: string[];
  distributions: Distribution[];
  missingDataset: boolean;
} {
  const graph = new Map<string, Node>(),
    stack: Frame[] = [];
  let anonymous = 0,
    triples = 0,
    elements = 0,
    root = false;
  const node = (id: string): Node => {
    let found = graph.get(id);
    if (!found) {
      if (graph.size >= 20000) reject();
      found = { id, properties: new Map() };
      graph.set(id, found);
    }
    return found;
  };
  const add = (subject: Node, key: string, value: Value) => {
    if (++triples > 100000) reject();
    const values = subject.properties.get(key) ?? [];
    values.push(value);
    subject.properties.set(key, values);
  };
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", reject);
  parser.on("xmldecl", (decl) => {
    if (decl.encoding && !/^utf-8$/i.test(decl.encoding)) reject();
  });
  parser.on("error", reject);
  parser.on("opentag", (tag) => {
    if (++elements > 100000 || stack.length >= 48) reject();
    const key = tag.uri + tag.local;
    const parent = stack.at(-1);
    const kind: Frame["kind"] = !parent
      ? "root"
      : parent.kind === "root" || parent.kind === "property"
        ? "node"
        : "property";
    let about: string | undefined,
      nodeId: string | undefined,
      resource: string | undefined,
      datatype: string | undefined,
      lang = parent?.lang;
    for (const attr of Object.values(tag.attributes)) {
      if (attr.value.length > 16384) reject();
      if (attr.uri === XMLNS) continue;
      if (attr.uri === XML && attr.local === "lang") {
        lang = attr.value;
        continue;
      }
      if (attr.uri !== RDF) reject();
      if (attr.local === "about" && kind === "node") about = absolute(attr.value);
      else if (attr.local === "nodeID" && kind !== "root") {
        if (!/^[A-Za-z_][\w.-]*$/.test(attr.value)) reject();
        nodeId = `_:named:${attr.value}`;
      } else if (attr.local === "resource" && kind === "property") resource = absolute(attr.value);
      else if (attr.local === "datatype" && kind === "property") datatype = absolute(attr.value);
      else reject();
    }
    if (tag.uri === RDF && /^(?:Bag|Seq|Alt|List|li|_\d+)$/.test(tag.local)) reject();
    const frame: Frame = { kind, text: "", lang, children: 0 };
    if (kind === "root") {
      if (root || key !== `${RDF}RDF`) reject();
      root = true;
    } else if (kind === "node") {
      if (about && nodeId) reject();
      if (parent?.kind === "property" && (parent.value || parent.children || parent.text.trim()))
        reject();
      frame.node = node(about ?? nodeId ?? `_:auto:${++anonymous}`);
      if (key !== `${RDF}Description`) add(frame.node, `${RDF}type`, { ref: key });
      if (parent?.kind === "property") parent.value = { ref: frame.node.id };
    } else {
      if (!parent?.node || (resource && nodeId) || (datatype && (resource || nodeId))) reject();
      frame.subject = parent.node;
      frame.predicate = key;
      if (resource || nodeId) frame.value = { ref: resource ?? nodeId };
    }
    if (parent) parent.children++;
    stack.push(frame);
  });
  const text = (value: string) => {
    const current = stack.at(-1);
    if (!current) {
      if (value.trim()) reject();
      return;
    }
    // Indentation between RDF child nodes is structure, not a literal value.
    if (current.kind !== "property") {
      if (value.trim()) reject();
      return;
    }
    current.text += value;
    if (current.text.length > 16384) reject();
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    const frame = stack.pop();
    if (!frame) reject();
    if (frame.kind === "property") {
      if (frame.value && frame.text.trim()) reject();
      if (!frame.subject || !frame.predicate) reject();
      add(
        frame.subject,
        frame.predicate,
        frame.value ?? { text: frame.text.trim(), lang: frame.lang },
      );
    } else if (frame.text.trim()) reject();
  });
  try {
    parser.write(xml).close();
  } catch {
    reject();
  }
  const typed = (n: Node, type: string) =>
    n.properties.get(`${RDF}type`)?.some((v) => v.ref === type) ?? false;
  const datasetNodes = [...graph.values()].filter((n) => typed(n, `${DCAT}Dataset`));
  const catalogs = [...graph.values()].filter((n) => typed(n, `${DCAT}Catalog`));
  if (!root || (!datasetNodes.length && !catalogs.length)) reject();
  const vals = (n: Node, key: string) => n.properties.get(key) ?? [];
  const values = (n: Node, key: string) =>
    [
      ...new Set(
        vals(n, key)
          .map((v) => v.ref ?? v.text ?? "")
          .filter(Boolean),
      ),
    ].sort();
  const literals = (n: Node, key: string) =>
    [...vals(n, key)]
      .filter((v) => v.text)
      .sort((a, b) => {
        const rank = (v: Value) => (v.lang?.startsWith("en") ? 0 : v.lang ? 2 : 1);
        return rank(a) - rank(b) || (a.text ?? "").localeCompare(b.text ?? "");
      })[0]?.text ?? "";
  // Flatten only simple named objects; never infer licence rights from labels.
  const evidence = (n: Node, key: string): string[] =>
    [
      ...new Set(
        vals(n, key).flatMap((v) => {
          if (!v.ref) return v.text ? [v.text] : ["unresolved:blank-node"];
          const target = graph.get(v.ref);
          const own = v.ref.startsWith("_:") ? [] : [v.ref];
          const resolved = target
            ? [...own, ...values(target, `${DCT}type`), ...values(target, `${DCT}identifier`)]
            : own;
          // A declaration is not absence: never replace unreadable rights with dataset grants.
          return resolved.length ? resolved : ["unresolved:blank-node"];
        }),
      ),
    ].sort();
  const mobile = (n: Node, key: string) =>
    [
      ...new Set([...values(n, MOB + key), ...values(n, MOB.replace("http:", "https:") + key)]),
    ].sort();
  const distributions: Distribution[] = [];
  for (const data of datasetNodes) {
    if (data.id.startsWith("_:")) reject();
    for (const value of vals(data, `${DCAT}distribution`)) {
      const resource = value.ref ? graph.get(value.ref) : undefined;
      if (!resource || !typed(resource, `${DCAT}Distribution`)) reject();
      const d = baseDistribution("latvia", data.id);
      d.datasetIdentifierHint = literals(data, `${DCT}identifier`);
      if (!resource.id.startsWith("_:")) d.distributionId = resource.id;
      d.metadataUrl = "https://transportdata.gov.lv/api/v1/subscriber/metadata_dcat";
      d.title = literals(data, `${DCT}title`);
      d.description = literals(data, `${DCT}description`);
      d.accessUrls = values(resource, `${DCAT}accessURL`);
      d.downloadUrls = values(resource, `${DCAT}downloadURL`);
      d.sampleUrls = values(resource, "http://www.w3.org/ns/adms#sample");
      d.formats = values(resource, `${DCT}format`);
      d.standards = mobile(resource, "mobilityDataStandard");
      d.protocols = mobile(resource, "applicationLayerProtocol");
      d.communication = mobile(resource, "communicationMethod");
      const licenses = evidence(resource, `${DCT}license`);
      d.licenses = licenses.length
        ? { origin: "distribution", declarations: licenses }
        : { origin: "dataset", declarations: evidence(data, `${DCT}license`) };
      for (const [field, own, fallback] of [
        ["rights", evidence(resource, `${DCT}rights`), evidence(data, `${DCT}rights`)],
        [
          "accessConditions",
          mobile(resource, "conditionsForAccess"),
          mobile(data, "conditionsForAccess"),
        ],
        [
          "usageConditions",
          mobile(resource, "conditionsForUsage"),
          mobile(data, "conditionsForUsage"),
        ],
      ] as const) {
        d[field] = own.length ? own : fallback;
        d.evidenceOrigins[field] = own.length
          ? "distribution"
          : fallback.length
            ? "dataset"
            : "absent";
      }
      d.themes = [...mobile(data, "mobilityTheme"), ...values(data, `${DCAT}theme`)];
      d.spatial = evidence(data, `${DCT}spatial`);
      d.countries = countries(d.spatial, "LV");
      const publisher = vals(data, `${DCT}publisher`)[0]?.ref;
      const publisherNode = publisher ? graph.get(publisher) : undefined;
      d.publisher = publisherNode
        ? literals(publisherNode, `${FOAF}name`) || literals(publisherNode, `${SKOS}prefLabel`)
        : "";
      d.frequency = values(data, `${DCT}accrualPeriodicity`);
      d.modified = literals(data, `${DCT}modified`);
      distributions.push(d);
    }
  }
  const ids = datasetNodes.map((n) => n.id);
  const missingDataset = catalogs.some(
    (c) =>
      vals(c, `${DCAT}dataset`).some((v) => !v.ref || !ids.includes(v.ref)) ||
      vals(c, `${DCAT}record`).some((v) => {
        const record = v.ref ? graph.get(v.ref) : undefined;
        return (
          !record ||
          !vals(record, `${FOAF}primaryTopic`).length ||
          vals(record, `${FOAF}primaryTopic`).some(
            (topic) => !topic.ref || !ids.includes(topic.ref),
          )
        );
      }),
  );
  return { datasets: ids, distributions, missingDataset };
}
