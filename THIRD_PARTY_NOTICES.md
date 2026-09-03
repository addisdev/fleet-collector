# Third-party notices

The collector's npm dependencies are all MIT, ISC, or Apache-2.0 and are
declared in `package.json` and `dash/package.json`; `npm ls` will show you
their terms. This file is for the things `npm` does not know about.

## Models and datasets used by the plant-ID eval

Nothing here is committed. Weights and images are fetched from their sources
and cached in the artifact store by content hash. The eval writeup is
[`evals/greenfolio-plant-id.md`](evals/greenfolio-plant-id.md).

| Asset | Source | License |
|---|---|---|
| PlantNet-300K ResNet18 (LiteRT) | `litert-community/PlantNet-300K-ResNet18-LiteRT` on Hugging Face | Apache-2.0 |
| House-Plants classifier | `AlyModrik41/House-Plants-Classification-TFLite-Model` on Hugging Face | per its model card |
| PlantNet-300K images | `mikehemberger/plantnet300K` on Hugging Face (Pl@ntNet) | CC-BY-SA 4.0 — attribution required, share-alike |

The int8 and Core ML variants are our own conversions of the Apache-2.0
ResNet18 (`evals/plant-id-assets/`) and inherit its terms. The eval images
are CC-BY-SA, which is the reason they are distributed to devices as an
artifact inside the fleet rather than committed to this repository.

## Tools the host executor drives

[Maestro](https://maestro.mobile.dev), [Playwright](https://playwright.dev),
`adb`, and Xcode's `simctl`/`devicectl`/`xcodebuild` are invoked as external
programs and are installed separately; none of their code is redistributed
here.
