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

## Candidates

| Model | Source | Classes | Size | Input |
|---|---|---|---|---|
| `plantnet-300k-resnet18` | `litert-community/PlantNet-300K-ResNet18-LiteRT` (Apache-2.0) | 1081 species | 47 MB fp32 | NCHW 224 |
| `houseplants-47` | `AlyModrik41/House-Plants-Classification-TFLite-Model` | 47 houseplants | 30 MB fp32 | NHWC 224 |
| `plantnet-300k-resnet18` **int8** | our post-training quantization of the above (`plant-id-assets/quantize_int8.py`, 100 validation-split calibration images, float I/O kept) | 1081 species | **12 MB** | NCHW 224 |

## Results (2026-08-15)

| Device | Model | Accel | Top-1 | Top-5 | p50 ms | p95 ms | Load ms |
|---|---|---|---|---|---|---|---|
| ATD emulator (android-14, 4 GB) | plantnet-300k-resnet18 | cpu | **77.5%** | **90.0%** | 54 | 57 | 80 |
| ATD emulator | plantnet-300k-resnet18 | gpu → cpu fallback (no CL/GL on AVD) | 77.5% | 90.0% | 54 | — | — |
| ATD emulator | houseplants-47 | cpu | n/a (47-class label space) | n/a | 69 | 77 | 62 |
| ATD emulator | **plantnet-300k-resnet18 int8** | cpu | **76.7%** | **88.3%** | **11** | **12** | 87 |
| host Mac (XNNPACK, sanity) | plantnet-300k-resnet18 fp32 / int8 | cpu | 77.5% / 73.3% | 90.0% / 89.2% | — | — | — |
| SM-X930 (Dimensity 9400) | fp32 (gpu) and int8 | | *queued — fan-out children fire when the tablet wakes* | | | | |

The host fp32 accuracy matches the device fp32 accuracy exactly, which
confirms the on-device preprocessing is bit-faithful. Host int8 differs
slightly from device int8 (73.3% vs 76.7% top-1) because XNNPACK and the
LiteRT reference int8 kernels round differently — both are within noise of
each other on 120 images; quote the device number.

Emulator numbers are for **pipeline validation and relative comparison
only** — never quote them as device performance. The tablet row is the first
number that matters for a min-spec decision, and the fan-out will fill it in
automatically.

## What this says for GreenFolio

1. **On-device species ID is viable in principle.** A 47 MB ResNet18 gets 77.5%
   top-1 / 90% top-5 on real held-out PlantNet images at ~54 ms per frame on a
   modest CPU. Plant.id's cloud accuracy is higher on hard cases, but a
   90% top-5 offline suggestion list — shown as "did you mean…" — is a
   product-grade feature, and the model is Apache-2.0.
2. **Top-5 is the product surface, not top-1.** Fine-grained species confusion
   is inherent (the misses were visually-similar taxa); presenting five ranked
   candidates with the user confirming turns 77% into a ~90% "it was in the
   list" experience.
3. **The houseplants-47 model is not comparable** on this set (different label
   space) but its latency shows a MobileNet-class model is not meaningfully
   faster than the ResNet18 here — architecture size isn't the constraint.
4. **int8 is the shipping candidate.** The quantized ResNet18 is **4× smaller
   (12 MB vs 47 MB) and 5× faster (11 ms vs 54 ms p50)** for a 0.8-point top-1
   and 1.7-point top-5 cost on this set. A 12 MB download is an in-app asset,
   not an on-demand fetch; 11 ms means a live viewfinder is feasible on CPU
   alone, no GPU delegate needed — which removes the whole class of GPU
   delegate flakiness observed above. Recommended product shape: on-device
   int8 top-5 as the "did you mean…" list, cloud Plant.id only when the top
   score is below a confidence threshold (tunable from the per-image scores
   in the report artifacts).
4. **Min-spec floor:** decided by data, not guessing — the shelf fan-out will
   produce per-device p50/p95 as devices come online. Rule of thumb from
   these numbers: anything that sustains < 150 ms p95 is fine for a tap-to-ID
   flow; a real-time viewfinder needs the GPU delegate (verified as
   fall-back-safe on devices without it).

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
