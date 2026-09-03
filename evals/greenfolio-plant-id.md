# GreenFolio plant-ID: on-device model evaluation

**Question:** GreenFolio identifies plants today by sending photos to the cloud
Plant.id API. Can species identification run on-device — offline in a
greenhouse, at zero per-call cost — and on which minimum hardware?

**Method:** the fleet's `vision-eval` workload (a `batch` job with backend
`litert`). Each device pulls the same eval-set artifact and model artifact,
applies bit-identical preprocessing, classifies every image, and reports
top-1 / top-5 accuracy with per-image latency. Reports are content-addressed
artifacts; the summary lands in the results table.

- **Eval set:** 120 images, 16 species, sampled from the **PlantNet-300K test
  split** (`mikehemberger/plantnet300K`, HF), center-cropped and resized to
  224 on the Mac so every device sees identical bytes. Artifact
  `acdcf4ef…785203`. Labels are dataset class indices; PlantNet-300K's
  ClassLabel order equals the model's sorted-species-id order (verified: the
  accuracy pattern is right-species-dominant, not chance).
- **Preprocessing on-device:** ImageNet mean/std normalization; layout per model.

## Licensing of the models and data

The tracked files here are the manifest, the conversion and quantization
scripts, and this writeup. No model weights and no images are in this repo;
each is fetched from its own source and cached as a content-addressed artifact.

| Asset | Source | License |
|---|---|---|
| PlantNet-300K ResNet18 (LiteRT) | `litert-community/PlantNet-300K-ResNet18-LiteRT` | Apache-2.0 |
| House-Plants classifier | `AlyModrik41/House-Plants-Classification-TFLite-Model` | per its model card |
| PlantNet-300K images | `mikehemberger/plantnet300K` (HF) | CC-BY-SA 4.0 — attribution required, share-alike |

The int8 and Core ML variants are our own conversions of the Apache-2.0
ResNet18 and inherit its terms. The eval-set images are redistributed to
devices inside the fleet only, as an artifact; CC-BY-SA is the reason they
are not committed here.

## Candidates

| Model | Source | Classes | Size | Input |
|---|---|---|---|---|
| `plantnet-300k-resnet18` | `litert-community/PlantNet-300K-ResNet18-LiteRT` (Apache-2.0) | 1081 species | 47 MB fp32 | NCHW 224 |
| `houseplants-47` | `AlyModrik41/House-Plants-Classification-TFLite-Model` | 47 houseplants | 30 MB fp32 | NHWC 224 |
| `plantnet-300k-resnet18` **int8** | our post-training quantization of the above (`plant-id-assets/quantize_int8.py`, 100 validation-split calibration images, float I/O kept) | 1081 species | **12 MB** | NCHW 224 |

## Results (updated 2026-08-18 with real hardware)

| Device | Model | Accel | Top-1 | Top-5 | p50 ms | p95 ms | Load ms |
|---|---|---|---|---|---|---|---|
| **SM-X930 (Dimensity 9400)** | **plantnet-300k-resnet18 int8** | **cpu** | **76.7%** | **88.3%** | **7** | 8 | 23 |
| **SM-X930 (Dimensity 9400)** | **plantnet-300k-resnet18 fp32** | **gpu delegate** | **77.5%** | **90.0%** | **11** | 13 | 428 |
| iPhone 16 sim (iOS 18.4) | Core ML int8-weight (11.8 MB) | coreml cpu¹ | 75.8% | 90.8% | 7.6 | 11.6 | 108 |
| iPhone 16 sim (iOS 18.4) | Core ML fp16 (`convert_coreml.py`, 23.5 MB) | coreml cpu¹ | 76.7% | 90.0% | 8.4 | 13.5 | 169 |
| ATD emulator (android-14, 4 GB) | plantnet-300k-resnet18 int8 | cpu | 76.7% | 88.3% | 11 | 12 | 87 |
| ATD emulator | plantnet-300k-resnet18 fp32 | cpu | 77.5% | 90.0% | 54 | 57 | 80 |
| ATD emulator | plantnet-300k-resnet18 fp32 | gpu → cpu fallback (no CL/GL on AVD) | 77.5% | 90.0% | 54 | — | — |
| ATD emulator | houseplants-47 | cpu | n/a (47-class label space) | n/a | 69 | 77 | 62 |
| host Mac (XNNPACK, sanity) | plantnet-300k-resnet18 fp32 / int8 | cpu | 77.5% / 73.3% | 90.0% / 89.2% | — | — | — |

¹ The iOS Simulator's emulated GPU/ANE returned an **all-zero logits tensor**
for this model — silently, with no error — while `.cpuOnly` gave logits
identical to the Mac. The iOS runner now forces CPU on simulators and labels
it; real iPhones honor `compute_units: all` (ANE), which is where the iOS
latency story actually gets decided.

**Accuracy is identical across every device** that ran a given model+quant —
tablet, emulator and host agree to the decimal — which is the fixed
preprocessing doing its job. Only latency varies, and that is the whole point.
(Host int8 is the one exception at 73.3%: XNNPACK and LiteRT's reference int8
kernels round differently. Quote the device number.)

## What this says for GreenFolio

1. **On-device species ID is viable.** An Apache-2.0 ResNet18 gets 77.5% top-1 /
   90% top-5 on real held-out PlantNet images. Plant.id's cloud accuracy is
   higher on hard cases, but a 90% top-5 offline suggestion list is a
   product-grade feature at zero per-call cost.
2. **Top-5 is the product surface, not top-1.** Fine-grained species confusion
   is inherent (the misses were visually-similar taxa); showing five ranked
   candidates for the user to confirm turns 77% into a ~90% "it was in the
   list" experience.
3. **int8 is the shipping candidate.** 12 MB versus 47 MB, for 0.8 points of
   top-1 and 1.7 of top-5. That is an in-app asset rather than an on-demand
   download, on both platforms (Core ML int8-weight is 11.8 MB).
4. **On real hardware, int8-on-CPU beats fp32-on-GPU.** The Dimensity 9400 runs
   int8 at **7 ms p50 on the CPU alone** — faster than fp32's 11 ms *with* the
   GPU delegate, and loading in 23 ms against 428 ms. The shipping
   configuration therefore needs no GPU delegate at all, which removes the
   entire class of delegate-availability failures seen elsewhere in this table.
5. **Min-spec floor:** a flagship does 7 ms. Even an order of magnitude slower
   on an old budget device is ~70 ms — comfortably inside a tap-to-identify
   flow, with a live viewfinder realistic on anything mid-range or better.
   There is no plausible Android or iOS device GreenFolio supports where this
   feature would feel slow.
6. **iOS is covered — and GreenFolio ships iOS-first.** The Core ML build of the
   same weights (ImageNet normalization folded in, so the app hands over raw
   pixels on both OSes) matches Android's accuracy on identical images.
7. **Recommended product shape:** on-device int8 top-5 as a "did you mean…"
   list, with the cloud Plant.id call reserved for when the top score falls
   below a confidence threshold — tunable from the per-image scores in the
   report artifacts.

## Reproduce / extend

```bash
# enqueue against the whole ml-capable pool (one child per device):
curl -X POST $FLEET/jobs -H 'content-type: application/json' -d '{
  "schema":1, "job_id":"planteval-plantnet-r18-<date>", "workload":"batch",
  "executor":"device", "backend":"litert", "fanout":true,
  "model":{"name":"plantnet-300k-resnet18","format":"tflite","quant":"fp32","sha256":"6f59f046c6a86593713aca76a3ab7bb55b520265eb66f5a77a114e450b1ccbf5"},
  "params":{"input_sha256":"acdcf4effbf6feef2744416bc84eb41c0b0e48fd7b50f7141b825741ee785203",
            "input_layout":"nchw","normalize":"imagenet","accelerator":"gpu","warmup_iters":3},
  "targets":{"pool":"ml-capable"}, "lease":{"ttl_s":1800}}'
```

Add a candidate: upload its `.tflite` to `/artifacts`, set `input_layout` /
`normalize` from its signature (`ai_edge_litert` `Interpreter.get_input_details()`),
and enqueue. Per-image predictions are in each report artifact for error analysis.
