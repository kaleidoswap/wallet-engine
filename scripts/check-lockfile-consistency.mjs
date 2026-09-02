import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageJsonPath = path.join(root, 'package.json');
const npmLockPath = path.join(root, 'package-lock.json');
const pnpmLockPath = path.join(root, 'pnpm-lock.yaml');

const regeneration = [
  'Regenerate package-lock.json (pnpm-lock.yaml is authoritative):',
  '  npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
].join('\n');

function fail(message) {
  console.error(`Lockfile consistency check failed:\n${message}\n\n${regeneration}`);
  process.exit(1);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
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
    if (line === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages && line === 'snapshots:') break;
    if (!inPackages) continue;

    const match = line.match(/^  (?:'([^']+)'|"([^"]+)"|([^\s'"][^:]*)):\s*$/);
    if (!match) continue;

    const locator = match[1] ?? match[2] ?? match[3];
    const separator = locator.lastIndexOf('@');
    if (separator <= 0) fail(`Cannot parse pnpm package locator: ${locator}`);
    addVersion(versions, locator.slice(0, separator), locator.slice(separator + 1));
  }

  if (!inPackages || versions.size === 0) {
    fail('Cannot find package resolutions in pnpm-lock.yaml.');
  }
  return versions;
}

function npmVersions(packages) {
  const versions = new Map();

  for (const [packagePath, metadata] of Object.entries(packages)) {
    // npm materializes optional peer-only nodes that have no pnpm graph entry.
    if (!packagePath || !metadata.version || metadata.peer) continue;
    const marker = packagePath.lastIndexOf('node_modules/');
    if (marker === -1) continue;
    addVersion(versions, packagePath.slice(marker + 'node_modules/'.length), metadata.version);
  }

  return versions;
}

const packageJson = readJson(packageJsonPath, 'package.json');
const npmLock = readJson(npmLockPath, 'package-lock.json');
const npmRoot = npmLock.packages?.[''];

if (!npmRoot) fail('package-lock.json has no root package entry.');

const rootFields = [
  'name',
  'version',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];
const rootDrift = rootFields.filter(
  (field) => !equal(packageJson[field] ?? {}, npmRoot[field] ?? {}),
);
if (rootDrift.length > 0) {
  fail(`package-lock.json is out of sync with package.json: ${rootDrift.join(', ')}`);
}

let pnpmSource;
try {
  pnpmSource = fs.readFileSync(pnpmLockPath, 'utf8');
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
    : [`${name}: pnpm-lock.yaml=${pnpmResolved.join(', ')}; package-lock.json=${npmResolved.join(', ')}`];
});

if (drift.length > 0) fail(`Resolved version drift:\n- ${drift.join('\n- ')}`);

console.log(
  `Lockfiles agree on ${sharedNames.length} shared packages; package-lock.json matches package.json.`,
);
