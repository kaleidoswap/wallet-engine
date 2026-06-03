// Spike A: can the WDK modules load via their non-Bare `default` export in plain Node?
// This is the cheapest data point on the Bare-runtime risk before touching RN/MV3.
const results = [];
async function probe(name, path) {
  try {
    const mod = await import(path);
    const exported = Object.keys(mod);
    const def = mod.default;
    results.push({ name, loaded: true, default: typeof def, exports: exported.slice(0, 8) });
  } catch (e) {
    results.push({ name, loaded: false, error: (e && e.message ? e.message : String(e)).split('\n')[0] });
  }
}
await probe('@kaleidorg/wdk-wallet-rln', '../../wdk-wallet-rln/index.js');
await probe('@kaleidorg/wdk-wallet-liquid', '../../wdk-wallet-liquid/index.js');
await probe('@tetherto/wdk-wallet-spark', '../../wdk-wallet-spark/index.js');
console.log(JSON.stringify(results, null, 2));
