# Contributors

Commerce Agent Bench is built by the Accio team at Alibaba International and by
people who contribute mock environments, tasks, and fixes to it.

**If your pull request adds a mock environment, add yourself here in the same
pull request.**

## Core contributors

The Accio team at Alibaba International — the harness, the mock services, and
the v1 task suite. Every service registered in
[`registry.py`](bench_core/mock_services/registry.py) as of v1.3.1 is
core-team work. Listed in author order, matching
[`CITATION.cff`](CITATION.cff), which is the source of record for it.

**Yukun Lian** · **Lei Wei** · **Sicong Xie** · **Guannan Zhang** ·
**Kesu Wang** · **Hongyu Li** · **Chenhao Jiang** · **Lanbo Lin** ·
**Tianyuan Yang** · **Xiaoyu Guo** · **Li Cai** · **Jialong Zhu**

## Mock environments

One row per merged replica service, named by its service directory and sorted
by that name. Credit lands when the service is merged into
[`mock_services/contrib/`](bench_core/mock_services/contrib/README.md),
not when it is later promoted into the shipped set — the row is written once and
its **Status** is what changes.

- `staged` — merged, published, and credited; queued for promotion while real
  workflow cases are built out against it, and not yet in the runtime image.
- `shipped` — promoted, registered in `MOCK_SERVICE_REGISTRY`, and baked into
  the image the benchmark runs.

| Mock service | Contributor | Affiliation | Status |
|---|---|---|---|
| `zendesk_support` | Yuxuan Zhang ([@reacher-z](https://github.com/reacher-z)) | Independent | staged |
<!-- | `acme_crm` | Jane Doe ([@janedoe](https://github.com/janedoe)) | Independent | staged | -->

_Opens with the first community mock. Be the first._

## Other contributions

Tasks, graders, harness work, documentation, and privately reported integrity
or security issues.

<!-- - [@janedoe](https://github.com/janedoe) — Jane Doe, Independent — three fulfilment tasks against `acme_crm` -->

---

Credit here is not paper authorship; [`CITATION.cff`](CITATION.cff) stays with
the core contributors, and the maintainers may invite formal authorship where a
contribution warrants it. Your handle should be an account that authored the
pull request. You can change or remove your own entry at any time, with no
reason given.
