import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const npmLockPath = path.join(root, "package-lock.json");
const pnpmLockPath = path.join(root, "pnpm-lock.yaml");

const regeneration = [
  "Regenerate package-lock.json (pnpm-lock.yaml is authoritative):",
  "  npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
].join("\n");

function fail(message) {
  console.error(
    `Lockfile consistency check failed:\n${message}\n\n${regeneration}`,
  );
  process.exit(1);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function addVersion(versions, name, version) {
  const values = versions.get(name) ?? new Set();
  values.add(version);
  versions.set(name, values);
}

function pnpmVersions(source) {
  const versions = new Map();
  let inPackages = false;

  for (const line of source.split(/\r?\n/)) {
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages && line === "snapshots:") break;
    if (!inPackages) continue;

    const match = line.match(/^  (?:'([^']+)'|"([^"]+)"|([^\s'"][^:]*)):\s*$/);
    if (!match) continue;

    const locator = match[1] ?? match[2] ?? match[3];
    const separator = locator.lastIndexOf("@");
    if (separator <= 0) fail(`Cannot parse pnpm package locator: ${locator}`);
    addVersion(
      versions,
      locator.slice(0, separator),
      locator.slice(separator + 1),
    );
  }

  if (!inPackages || versions.size === 0) {
    fail("Cannot find package resolutions in pnpm-lock.yaml.");
  }
  return versions;
}

/**
 * Which edge types lead into each node of the npm tree: prod, dev, optional,
 * peer. Derived from the dependency fields npm records per node, resolved
 * the way Node does (nearest `node_modules/<name>` walking up), because the
 * `peer` flag npm writes is not usable for this. arborist sets it on any node
 * it first reached through a peer edge and clears it only along peer edges
 * (calc-dep-flags.js), so the flag flips with traversal order: a package
 * straight out of `dependencies` gains it when a transitive dependency starts
 * declaring it as a peer, and a genuine peer-only node loses it. Both happened
 * in the same bump.
 */
function npmIncomingEdges(packages) {
  const incoming = new Map();
  const resolveFrom = (fromPath, name) => {
    let base = fromPath;
    for (;;) {
      const candidate = base
        ? `${base}/node_modules/${name}`
        : `node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const marker = base.lastIndexOf("/node_modules/");
      base = marker === -1 ? "" : base.slice(0, marker);
    }
  };
  const fields = [
    ["dependencies", "prod"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
    ["devDependencies", "dev"],
  ];
  for (const [packagePath, metadata] of Object.entries(packages)) {
    for (const [field, type] of fields) {
      for (const name of Object.keys(metadata[field] ?? {})) {
        const to = resolveFrom(packagePath, name);
        if (!to) continue;
        if (!incoming.has(to)) incoming.set(to, []);
        incoming.get(to).push({ type, from: packagePath });
      }
    }
  }
  return incoming;
}

/**
 * Nodes that exist only to satisfy peer ranges: every path from the root to
 * them crosses a peer edge. That includes the regular dependencies of such a
 * node — npm installs them, pnpm never resolved the peer, so neither side has
 * anything to compare. A node with no incoming edge at all is kept; whatever
 * left it there, it is not a peer artefact.
 */
function npmPeerOnlyNodes(packages, incoming) {
  const peerOnly = new Set();
  for (;;) {
    let changed = false;
    for (const packagePath of Object.keys(packages)) {
      if (!packagePath || peerOnly.has(packagePath)) continue;
      const edges = incoming.get(packagePath) ?? [];
      const isPeerOnly =
        edges.length > 0 &&
        edges.every(({ type, from }) => type === "peer" || peerOnly.has(from));
      if (isPeerOnly) {
        peerOnly.add(packagePath);
        changed = true;
      }
    }
    if (!changed) return peerOnly;
  }
}

function npmVersions(packages) {
  const peerOnlyNodes = npmPeerOnlyNodes(packages, npmIncomingEdges(packages));
  const versions = new Map();
  const peerOnly = new Map();

  for (const [packagePath, metadata] of Object.entries(packages)) {
    if (!packagePath || !metadata.version) continue;
    const marker = packagePath.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const name = packagePath.slice(marker + "node_modules/".length);
    const key = `${name}@${metadata.version}`;
    peerOnly.set(
      key,
      (peerOnly.get(key) ?? true) && peerOnlyNodes.has(packagePath),
    );
    addVersion(versions, name, metadata.version);
  }

  // npm materializes optional peer-only nodes that have no pnpm graph entry.
  for (const [name, resolved] of versions) {
    for (const version of resolved) {
      if (peerOnly.get(`${name}@${version}`)) resolved.delete(version);
    }
    if (resolved.size === 0) versions.delete(name);
  }

  return versions;
}

const packageJson = readJson(packageJsonPath, "package.json");
const npmLock = readJson(npmLockPath, "package-lock.json");
const npmRoot = npmLock.packages?.[""];

if (!npmRoot) fail("package-lock.json has no root package entry.");

const rootFields = [
  "name",
  "version",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
];
const rootDrift = rootFields.filter(
  (field) => !equal(packageJson[field] ?? {}, npmRoot[field] ?? {}),
);
if (rootDrift.length > 0) {
  fail(
    `package-lock.json is out of sync with package.json: ${rootDrift.join(", ")}`,
  );
}

let pnpmSource;
try {
  pnpmSource = fs.readFileSync(pnpmLockPath, "utf8");
} catch (error) {
  fail(`Cannot read pnpm-lock.yaml: ${error.message}`);
}

const pnpm = pnpmVersions(pnpmSource);
const npm = npmVersions(npmLock.packages);
const sharedNames = [...pnpm.keys()].filter((name) => npm.has(name)).sort();
const drift = sharedNames.flatMap((name) => {
  const pnpmResolved = [...pnpm.get(name)].sort();
  const npmResolved = [...npm.get(name)].sort();
  return equal(pnpmResolved, npmResolved)
    ? []
    : [
        `${name}: pnpm-lock.yaml=${pnpmResolved.join(", ")}; package-lock.json=${npmResolved.join(", ")}`,
      ];
});

if (drift.length > 0) fail(`Resolved version drift:\n- ${drift.join("\n- ")}`);

// --- Overrides: declared in two places, and actually applied ----------------
//
// A pin has to be declared once per package manager. npm reads the top-level
// `overrides` in package.json and ignores everything else; pnpm reads
// `overrides` from pnpm-workspace.yaml, ignores npm's top-level field, and
// ignores package.json's `pnpm.overrides` from v11. Both install paths are in
// CI (`pnpm install --frozen-lockfile` in ci/publish, `npm ci` in
// integration), so a pin declared in only one place holds for only one of
// them — silently, because the other resolves something valid and carries on.
//
// That is #61: the override was declared where neither CI install could read
// it. Declaring it twice is the fix; checking it is what keeps it fixed, so
// this asserts the two declarations agree AND that each lockfile resolved
// every overridden package to exactly the pinned version. A pin that is
// declared and not applied is worth no more than no pin at all.
const declaredNpm = packageJson.overrides ?? {};

let workspaceSource = "";
try {
  workspaceSource = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
} catch (error) {
  // A missing file is a real state — no pnpm overrides declared — and the
  // comparison below reports it. Anything else (a permission error, a typo in
  // this path) must not be swallowed into "declares nothing", which reads as a
  // passing check with the override silently unenforced.
  if (error.code !== "ENOENT") {
    fail(`Cannot read pnpm-workspace.yaml: ${error.message}`);
  }
}
// The file is ours and tiny: a flat `overrides:` block of `name: version`.
const declaredPnpm = {};
const overridesBlock = workspaceSource.match(/^overrides:\n((?:[ \t]+.*\n?)*)/m);
if (overridesBlock) {
  for (const line of overridesBlock[1].split("\n")) {
    const entry = line.match(/^\s+'?([^':\s]+)'?:\s*'?([^'\s]+)'?\s*$/);
    if (entry) declaredPnpm[entry[1]] = entry[2];
  }
}

if (!equal(declaredNpm, declaredPnpm)) {
  fail(
    "Override declarations disagree — npm reads package.json `overrides`, " +
      "pnpm reads pnpm-workspace.yaml `overrides`, and both run in CI.\n" +
      `  package.json:        ${JSON.stringify(declaredNpm)}\n` +
      `  pnpm-workspace.yaml: ${JSON.stringify(declaredPnpm)}`,
  );
}

const unapplied = Object.entries(declaredNpm).flatMap(([name, version]) => {
  const problems = [];
  for (const [label, resolved] of [
    ["pnpm-lock.yaml", pnpm.get(name)],
    ["package-lock.json", npm.get(name)],
  ]) {
    if (!resolved) continue; // not in that tree at all
    const versions = [...resolved].sort();
    if (versions.length !== 1 || versions[0] !== version) {
      problems.push(`${name}: ${label} has ${versions.join(", ")}, override pins ${version}`);
    }
  }
  return problems;
});

if (unapplied.length > 0) {
  fail(
    `Overrides declared but not applied:\n- ${unapplied.join("\n- ")}\n\n` +
      "Regenerate both lockfiles:\n" +
      "  pnpm install --lockfile-only --no-frozen-lockfile\n" +
      "  npm install --package-lock-only --ignore-scripts --no-audit --no-fund",
  );
}

const overrideCount = Object.keys(declaredNpm).length;
console.log(
  `Lockfiles agree on ${sharedNames.length} shared packages; package-lock.json matches package.json; ` +
    `${overrideCount} override${overrideCount === 1 ? "" : "s"} applied in both.`,
);
