/**
 * `better-schemic/driver` — the engine surface: the SurrealDB `Driver` implementation, the
 * SurrealQL DDL emitters, and the `registerDriver` SIDE-EFFECT (registers `surrealDriver` with
 * the engine registry on import). CLI/engine-only — kept OUT of the side-effect-free authoring
 * index (`better-schemic`) so `s.*` never drags the emit/diff engine into an app bundle.
 */
export * from "./surreal/driver";
