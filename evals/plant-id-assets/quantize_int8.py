"""Post-training int8 quantization of the PlantNet-300K ResNet18 LiteRT model.

Float I/O is preserved so app-side preprocessing stays identical to fp32.
Calibrate on ~100 images DISJOINT from the eval set (we used the validation
split; the eval set is from the test split).

  python -m venv venv && venv/bin/pip install ai-edge-litert Pillow numpy
  venv/bin/python quantize_int8.py plantnet-resnet18.tflite calib/ out-int8.tflite
"""
import glob, sys
import numpy as np
from PIL import Image
from ai_edge_litert import _pywrap_tensorflow_lite_calibration_wrapper as cw

src, calib_dir, dst = sys.argv[1:4]
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)

def prep(path):  # center-cropped 224 RGB -> NCHW ImageNet-normalized
    a = (np.asarray(Image.open(path).convert("RGB"), np.float32) / 255.0 - MEAN) / STD
    return np.ascontiguousarray(a.transpose(2, 0, 1)[None]).astype(np.float32)

w = cw.CalibrationWrapper(open(src, "rb").read(), [], [])
w.Prepare()
files = sorted(glob.glob(f"{calib_dir}/*.jpg"))
for f in files:
    w.FeedTensor([prep(f)])
F, I8, I32 = np.dtype(np.float32).num, np.dtype(np.int8).num, np.dtype(np.int32).num
# (input, output, allow_float, activations, bias, disable_per_channel, disable_per_channel_dense)
open(dst, "wb").write(w.QuantizeModel(F, F, False, I8, I32, False, False))
print(f"calibrated on {len(files)} images -> {dst}")
