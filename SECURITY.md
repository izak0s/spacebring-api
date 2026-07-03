# Security Policy

## Supported versions

Only the latest published version of `@izak0s/spacebring-api` receives security fixes. The package tracks Spacebring's API spec automatically, so staying current is expected usage.

| Version | Supported |
| --- | --- |
| latest | ✅ |
| older | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/izak0s/spacebring-api/security/advisories/new). You should receive an initial response within a few days. Please include a description of the issue, steps to reproduce, and the affected version.

Once a fix is released, the vulnerability will be disclosed in a GitHub security advisory. Credit is given to reporters unless anonymity is requested.

## Scope

In scope (this client library):

- Credential handling — the client holds your Spacebring client ID/secret and sends them as a Basic `Authorization` header; any path that could leak them (logs, error messages, unintended hosts) is a vulnerability
- Request forgery or header/parameter injection through client inputs
- Code generation issues where a malicious or malformed OpenAPI spec could inject code into the generated client
- Supply-chain integrity of the published package

Out of scope:

- The Spacebring API service itself — report server-side issues to [api@spacebring.com](mailto:api@spacebring.com)
- Vulnerabilities requiring a compromised machine or already-leaked credentials

## Hardening notes for users

- Keep credentials in environment variables or a secrets manager, never in code
- The package has zero runtime dependencies, which minimizes its supply-chain surface
- Releases are published from CI via npm trusted publishing (OIDC) with provenance — verify with `npm audit signatures`
