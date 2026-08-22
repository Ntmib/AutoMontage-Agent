# Security policy

## Reporting a vulnerability

Do not publish a working exploit or secret in a public issue. Use the repository's
[private security advisory form](https://github.com/Ntmib/AutoMontage-Agent/security/advisories/new)
and include the affected command, input shape, impact, and a minimal reproduction.

## Supported release

Security fixes target the latest released version. CI blocks high and critical npm
advisories and scans Git history with Gitleaks. A lower-severity exception is allowed only
when its exact dependency path, exposure, mitigation, owner-visible deadline, and revisit
triggers are recorded below and accepted by `npm run check:release`.

## Temporary dependency exception

As of 2026-08-20, `npm audit` reports five moderate findings that all describe one
transitive advisory. The installed path is:

```text
node-vibrant@4.0.4
  -> @vibrant/image-node@4.0.4
  -> @jimp/custom@0.22.12
  -> @jimp/core@0.22.12
  -> file-type@16.5.4
```

[GHSA-5v7r-6r5c-r473 / CVE-2026-31808](https://github.com/advisories/GHSA-5v7r-6r5c-r473)
is a moderate denial of service: malformed ASF input with a zero-size sub-header can make
`file-type` loop indefinitely. Versions from 13.0.0 through 21.3.0 are affected; the fix
is in 21.3.1. The latest upstream `node-vibrant` release remains
[4.0.4](https://github.com/Vibrant-Colors/node-vibrant/releases/tag/v4.0.4), so there is no
compatible dependency update that brings this project to `file-type@21.3.1` today.

The reachable feature is optional `--autotheme`. AutoMontage passes the user video to
ffmpeg, which emits at most 20 scaled PNG frames. Jimp/Vibrant receives those locally
generated PNG files, not the raw video or an arbitrary ASF upload. This sharply reduces
exposure to the vulnerable ASF detector. The command still runs locally under the invoking
user, so a hang remains an availability risk and is not treated as fixed.

We keep `node-vibrant@4.0.4`. We do not run `npm audit fix --force`, install a major
override, or downgrade to the incompatible 3.x line. Reassess immediately on an upstream
node-vibrant/Jimp update, if severity becomes high, if direct untrusted-image input is
introduced, at the next release, or no later than 2026-09-04.

For release 1.3.0, the GitHub Security Advisory, npm registry metadata, and the installed
transitive dependency chain were reviewed again on 2026-08-20. They still match the advisory,
package path, and mitigation recorded below.

The block below is the machine-readable release-gate record. Keep the prose and JSON in
sync. The gate also derives the installed five-package chain from the candidate
`package-lock.json`, requires exactly those five entries, and accepts `reviewedAt` only when
it matches the dated section for `reviewedFor` and is not in the future.

```json security-exception
{
  "ghsa": "GHSA-5v7r-6r5c-r473",
  "cve": "CVE-2026-31808",
  "severity": "moderate",
  "package": "file-type@16.5.4",
  "fixedIn": "file-type@21.3.1",
  "chain": [
    "node-vibrant@4.0.4",
    "@vibrant/image-node@4.0.4",
    "@jimp/custom@0.22.12",
    "@jimp/core@0.22.12",
    "file-type@16.5.4"
  ],
  "exposure": "Optional --autotheme passes only ffmpeg-generated PNG frames to Jimp/Vibrant, not raw ASF input.",
  "mitigation": "Local-only CLI path, at most 20 scaled PNG frames, no direct untrusted-image upload into file-type.",
  "decision": "Keep node-vibrant@4.0.4; do not force-fix, override the major chain, or downgrade to 3.x.",
  "triggers": [
    "upstream node-vibrant/Jimp update",
    "severity becomes high",
    "direct untrusted-image input",
    "next release"
  ],
  "reviewedAt": "2026-08-22",
  "reviewedFor": "1.3.0",
  "revisitBy": "2026-09-04"
}
```
