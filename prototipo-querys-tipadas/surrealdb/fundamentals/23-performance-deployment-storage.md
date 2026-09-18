# Deployment &amp; storage layer considerations

So far, throughout this course, we have been talking about data.

- Why data models matter

- How to manipulate data

- How to connect data

- How to index data

We'll still talk about data in this last lesson about storage layer and deployment considerations. The difference is we'll be talking about it from the perspective of a database manager rather than a database user.

We'll briefly cover:

- Why the separation of storage and compute matters

- The different ways of running SurrealDB and the supported key-value storage engines

## Why the separation of storage and compute matters

The separation of storage and compute has been a trend that first became popular with analytical databases (OLAP) and which has since made its way into operational databases (OLTP).

The key reason for separating storage and compute is so that you can scale your resources separately.

This has several benefits such as:

- Less wasted capacity as scale is optimised for each workload

- Greater cost efficiency

- Greater flexibility

- Better fault tolerance

This has also allowed us to offer various key-value storage engines you can choose from, depending on your needs.

## The different ways of running SurrealDB and the supported key-value storage engines

There are three ways of running SurrealDB:

- Directly in the browser

- As a single-node server or in embedded devices

- As a multi-node cluster in the cloud

There are also a number of storage engines to choose from. Each engine supports a transaction-based approach, with the ability to support the reading and writing of individual keys and key ranges within each transaction.

Let's go through each of these.

### Running SurrealDB directly in the browser

Running SurrealDB directly in the browser is the way you have been interacting with SurrealDB throughout the course. The embedded SurrealDB Studio interface runs SurrealDB in WebAssembly (WASM), so you can execute SurrealQL without installing anything.

For this course, each lesson starts with a fresh in-memory database. When you load a dataset or run a query, the data lives only for that session in the browser tab - which keeps the examples predictable and fast.

If you build your own browser apps with the [JavaScript SDK](/docs/languages/javascript/concepts/embedded-engines), you can also persist data with [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) via the `indxdb://` connection string. That storage lives inside your browser in a sandboxed environment, with keys and values serialised as binary data.

### Running SurrealDB on a single-node server or in embedded devices

SurrealDB is easy to install and run, whether you are running everything on your laptop, on an IoT device or as a single-node server in the cloud.

You'll find [installation](/docs/self-hosted/installation) and [running](/docs/self-hosted/file-backed) instructions for Linux, macOS, Windows and Docker in our documentation, where you can install and run SurrealDB with one command each.

The storage engines you can choose between are RocksDB (the default for single-node production) and SurrealKV.

**RocksDB**

- Was originally a fork of Google's LevelDB but was then developed and maintained by Meta (Facebook) entirely in C++.

- It's optimised for fast, low-latency storage such as flash drives and high-speed disk drives using the log-structured merge-tree data structure (LSM).

- LSM data structures are highly efficient for write-heavy workloads as they minimise the number of disk writes and require less space than B-Trees, as they don't require constant reorganisation of data.

**SurrealKV**

[SurrealKV](https://github.com/surrealdb/surrealkv) is SurrealDB's own embedded storage engine, written in Rust. It is also LSM-based, with optional [versioned / time-travel reads](/docs/reference/query-language/statements/select#the-version-clause) when versioning is enabled at startup - useful for temporal queries and audit-style workloads.

SurrealKV is still under active development. RocksDB remains the recommended default for critical production workloads on a single node, but SurrealKV is worth experimenting with for local-first and embedded use cases.

### Running SurrealDB on a multi-node cluster in the cloud

Highly available, horizontally scalable deployments need **shared distributed storage** - a backend that every query node can reach with transactional consistency. A single RocksDB directory on one machine is still a [single-node deployment](/docs/running/file-backed), not a cluster.

[SurrealDB Enterprise](/docs/manage/observability/enterprise-observability) is run on SurrealDB's own distributed storage layer for multi-node deployments. It is available on [SurrealDB Cloud](/cloud) Scale tiers and for Enterprise self-hosted installations on Kubernetes. We won't go into how it works here - that is operator-level detail - but it is the path to geo-replicated, highly available clusters when you outgrow a single node.

In these architectures, the distributed storage layer is the stateful part of the system. SurrealDB query nodes stay comparatively stateless: coordination and durability live in the storage tier, which is what lets you scale compute and storage independently.

## Summary

We've covered quite a lot, and as we've seen, SurrealDB was designed from the start to have unparalleled deployment flexibility, ranging from embedded devices to distributed multi-node clusters and even embedded directly in your website using WebAssembly (WASM).

If you want the power and flexibility of SurrealDB without the pain of managing infrastructure, sign up for [SurrealDB Cloud](/cloud) for a fully managed solution where you can focus on building your application, and we'll take care of the rest.
