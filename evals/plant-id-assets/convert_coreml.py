"""PlantNet-300K ResNet18 -> Core ML (fp16 weights natively, plus int8-weight variant).

Needs Python <= 3.12 (coremltools' native BlobWriter has no 3.14 wheel):
  /opt/homebrew/bin/python3.12 -m venv venv312
  venv312/bin/pip install coremltools torch torchvision Pillow numpy
  venv312/bin/python convert_coreml.py plantnet_resnet18.pth
Then compile + zip for the fleet:
  xcrun coremlcompiler compile PlantNet300K.mlpackage . && ditto -c -k --keepParent PlantNet300K.mlmodelc PlantNet300K.mlmodelc.zip
ImageNet normalization is folded into the model as ImageType scale/bias, so
the app hands over raw RGB pixels — identical preprocessing to the tflite path.
"""
import sys, torch, torchvision, coremltools as ct
import coremltools.optimize.coreml as cto

sd = torch.load(sys.argv[1], map_location="cpu", weights_only=False)
for k in ("model", "state_dict"):
    if isinstance(sd, dict) and k in sd: sd = sd[k]
sd = {k.replace("module.", ""): v for k, v in sd.items()}
m = torchvision.models.resnet18(num_classes=1081); m.load_state_dict(sd); m.eval()
traced = torch.jit.trace(m, torch.rand(1, 3, 224, 224))
scale = 1 / (255.0 * 0.226)
bias = [-0.485 / 0.226, -0.456 / 0.226, -0.406 / 0.226]
mlm = ct.convert(traced,
    inputs=[ct.ImageType(name="image", shape=(1, 3, 224, 224), scale=scale, bias=bias, color_layout=ct.colorlayout.RGB)],
    outputs=[ct.TensorType(name="logits")], minimum_deployment_target=ct.target.iOS17, compute_units=ct.ComputeUnit.ALL)
mlm.short_description = "PlantNet-300K ResNet18, 1081 species. 224x224 RGB in (ImageNet norm folded), logits[1081] out."
mlm.save("PlantNet300K.mlpackage")
cfg = cto.OptimizationConfig(global_config=cto.OpLinearQuantizerConfig(mode="linear_symmetric", dtype="int8", weight_threshold=512))
cto.linear_quantize_weights(mlm, cfg).save("PlantNet300K-int8.mlpackage")
print("wrote PlantNet300K.mlpackage and PlantNet300K-int8.mlpackage")
