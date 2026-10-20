# Supplemental upstream licenses

Only packages actually retained by the bundlers use these supplements when their published package omits the full notice.

## react-remove-scroll-bar 2.3.8

`react-remove-scroll-bar@2.3.8` declares MIT and author Anton Korzunov in its npm package, but omits the full license file. Its registry `gitHead` is `b3b1287aad81def2e2ae707274b74531b61ddbaf`; that revision's LICENSE returns 404.

The preserved file is the upstream project's later-added original license at [commit 7301c160fda44cb8cf2b9fdfde61efad35736196](https://github.com/theKashey/react-remove-scroll-bar/commit/7301c160fda44cb8cf2b9fdfde61efad35736196), dated 2025-05-21. It identifies the same author and MIT terms. It is a supplemental upstream notice, not a claim that this file shipped in the 2.3.8 npm tarball. Copyright wording and year are unchanged.

- [Exact source](https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/7301c160fda44cb8cf2b9fdfde61efad35736196/LICENSE)
- Downloaded: 2026-10-19
- SHA-256: `a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84`
- npm 2.3.8 integrity: `sha512-9r+yi9+mgU33AKcj6IbT9oRCO78WriSj6t/cF8DWBZJ9aOGPOTEDvdUDz1FwKim7QXWwmHqtdHnRJfhAxEG46Q==`

The staging script checks the exact package/version/declaration and the supplemental file digest, then records the source URL. Re-review on any dependency upgrade.

## standardwebhooks 1.1.1

The npm package declares MIT but omits its full license. The preserved notice is the unchanged MIT license inherited from `libraries/LICENSE` at the published npm `gitHead`, `b4d2c14fc5b4ccff3ff271e3b087dff812254c59`: [exact source](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE). Copyright is 2023 Svix. The JavaScript package manifest at that revision identifies version 1.1.1 and MIT; the registry integrity matches the root lockfile. The repository-root Apache license is separate from this library-specific MIT notice.

## Notices supplied by installed packages

`isarray` and `lru_map` need no downloaded supplements: their installed package READMEs contain complete MIT notices. Staging collects those license sections directly, like ordinary package LICENSE files. Repository workspace code without a package-level license inherits the existing root MIT license.
