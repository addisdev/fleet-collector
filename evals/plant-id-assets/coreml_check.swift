import CoreML
import Foundation
import AppKit

let modelURL = URL(fileURLWithPath: CommandLine.arguments[1])
let imgPath = CommandLine.arguments[2]
let cfg = MLModelConfiguration(); cfg.computeUnits = .cpuOnly
let m = try MLModel(contentsOf: modelURL, configuration: cfg)
print("inputs:", m.modelDescription.inputDescriptionsByName.map { "\($0.key): \($0.value.type) \($0.value.imageConstraint.map { "\($0.pixelsWide)x\($0.pixelsHigh) fmt=\($0.pixelFormatType)" } ?? "")" })
print("outputs:", m.modelDescription.outputDescriptionsByName.map { "\($0.key): \($0.value.type)" })

guard let ns = NSImage(contentsOfFile: imgPath), let cg = ns.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("no image") }
func buffer(_ cg: CGImage, size: Int, fmt: OSType) -> CVPixelBuffer {
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, size, size, fmt, [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &pb)
    let b = pb!
    CVPixelBufferLockBaseAddress(b, [])
    let info: UInt32 = fmt == kCVPixelFormatType_32ARGB ? CGImageAlphaInfo.noneSkipFirst.rawValue : (CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(b), width: size, height: size, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(b), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info)!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))
    CVPixelBufferUnlockBaseAddress(b, [])
    return b
}
for (name, fmt) in [("32ARGB", kCVPixelFormatType_32ARGB), ("32BGRA", kCVPixelFormatType_32BGRA)] {
    let pb = buffer(cg, size: 224, fmt: fmt)
    let inName = m.modelDescription.inputDescriptionsByName.keys.first!
    let out = try m.prediction(from: try MLDictionaryFeatureProvider(dictionary: [inName: MLFeatureValue(pixelBuffer: pb)]))
    let arr = out.featureValue(for: out.featureNames.first!)!.multiArrayValue!
    var best = 0; var bestV: Float = -.infinity
    var nan = 0
    for i in 0..<arr.count { let v = arr[i].floatValue; if v.isNaN { nan += 1 }; if v > bestV { bestV = v; best = i } }
    print("\(name): shape \(arr.shape) dtype \(arr.dataType.rawValue) top1=\(best) score=\(bestV) nan=\(nan) first3=\(arr[0].floatValue),\(arr[1].floatValue),\(arr[2].floatValue)")
}
