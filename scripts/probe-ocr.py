# Read-only local OCR capability discovery, no installation/network.
import importlib.util,json
mods=['paddleocr','rapidocr_onnxruntime','rapidocr','easyocr','pytesseract','PIL','cv2','onnxruntime']
print(json.dumps({m:importlib.util.find_spec(m) is not None for m in mods}))
