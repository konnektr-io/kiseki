# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's private reporting flow:

1. Go to the **Security** tab of this repository → **Report a vulnerability**
   (direct link: `/security/advisories/new`), or
2. If that is unavailable, open a minimal issue that *only* asks for a private contact channel —
   without any details of the problem.

Please include: what you found, where (URL/endpoint/commit), how to reproduce it, and what impact you
think it has. A proof of concept helps enormously.

You can expect an acknowledgement as soon as the maintainer sees the report, normally within a few
days. This is a personal, single-maintainer project — there is no bounty programme and no formal SLA.

## Supported versions

Only the tip of `main` is supported; fixes are released there. There are no maintained release
branches, and older tags do not receive security patches.

## Scope

In scope:

- `konnektr-io/kiseki` — the backend API, the frontend SPA, the container image
  `ghcr.io/konnektr-io/kiseki`, and the CI workflow in this repository.
- Access control problems: anything that lets a user read or write a trip they should not, without a
  valid invite/claim link. In particular, bypasses of the role ladder
  (`follower < viewer < editor < owner`), token/act-as confusion, or leaking `claimToken` values.
- Authentication and session handling against Auth0 (token validation, PKCE flow, JWKS handling).
- Injection, SSRF, path traversal in the media/inbox proxies, unsafe deserialisation.
- Secrets committed to the repository or leaked into a browser bundle.

Not in scope:

- The author's personal instance and its data. Attack that instance if you must, but report findings
  here privately rather than publicly — and do not exfiltrate, modify or publish trip content or the
  personal data of trip participants. That data belongs to real people.
- Denial of service, rate-limit absence, missing security headers, and findings that only reproduce
  with an unrealistic local configuration.
- Vulnerabilities in third-party services (Auth0, Google Places, HERE, GitHub) — report those to the
  vendor.

## Design notes that matter for reports

- Trip data is **not** in this repository. Trips live in the Konnektr Graph; this repo holds code.
- `claimToken` and `followToken` are per-trip secrets. They are never returned in trip responses —
  only via the owner-only join/follow-link endpoints. If you can obtain one without being the owner,
  that is a vulnerability.
- Names and e-mail addresses in crew lists are self-asserted and grant no access; identity is bound
  to the Auth0 `sub` on the crew edge.
- Browser-visible values are deliberately public: the Auth0 domain and SPA client id, and the
  PostHog ingest key. Server keys (graph token, S3 credentials, HERE, Google Places, agent key) must
  never reach the client.
