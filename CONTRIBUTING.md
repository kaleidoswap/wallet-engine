# Contributing to wallet-engine

Thanks for your interest! Contributions — bug reports, fixes, new protocol
adapters, docs — are welcome.

## Development

```bash
npm install
npm run build      # tsc type-check + emit
npm test           # vitest
npm run test:watch # watch mode
```

CI runs the build, the test suite (Node 20 & 22), and a production-dependency
audit on every PR. Please make sure all three pass locally before opening a PR.

## Workflow

We use [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow):

1. Fork and branch from `main`.
2. Add tests for any behavior you add or change. Pure modules (router,
   disclosure, receive, capabilities) must stay fully covered.
3. Keep `tsc` clean — no new `any` at module boundaries that carry money.
4. Update docs/JSDoc when you change a public API.
5. Open the PR with a clear description of the change and its rationale.

## Architectural rules (please respect these)

This package's whole value is keeping protocol differences out of app code. Two
rules keep it that way:

1. **Differences are data, not branches.** When you're tempted to add a method
   to `IProtocolAdapter` for one protocol, add a capability flag to the manifest
   (`src/capabilities/`) instead. The router and UI read the manifest; they must
   never special-case a protocol by name.
2. **No SDK types cross the contract.** Adapters translate their backing SDK's
   shapes into the domain types in `src/types/`. SDK/WDK objects may be read as
   `any` inside an adapter, but only domain types leave it.

See the "Extending: add a protocol" section of the README and the example in
[`examples/minimal-adapter`](examples/minimal-adapter) for the adapter pattern.

The WDK Spark/Arkade adapters track the `rate-extension` reference behavior;
[`docs/wdk-parity.md`](docs/wdk-parity.md) records what matches and the
intentional WDK-vs-extension differences (history status/direction, offboard).

## Security

This engine moves real funds. Never weaken the destination classifier's
fail-closed behavior, the escape-hatch allowlists, or the money-coercion guards
without tests demonstrating the new behavior is safe. For vulnerabilities, see
[SECURITY.md](SECURITY.md) — do not open a public issue.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
