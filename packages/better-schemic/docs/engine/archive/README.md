# Archived — historical design docs

These documents describe the **multi-driver** architecture better-schemic used to have (a
`@better-schemic/<driver>` package per database, loaded dynamically by the CLI).

The project is **SurrealDB-only** now: the driver is built into the single `better-schemic`
package and there is no pluggable-driver boundary. These docs are kept for HISTORY (they explain
why the code looks the way it does) and are **not** a guide to extending the project.

| Doc | What it was |
| --- | --- |
| `DRIVER-ONBOARDING.md` | how to write a new driver package |
| `DRIVER-COVERAGE.md` | the template each driver copied for its `docs/COVERAGE.md` |
| `AUTHORING-SPLIT.md` | the extraction that made `s.*` driver-parametric |

For the CURRENT surface see [`../README.md`](../README.md) (the engine) and the package README
(authoring + CLI).
