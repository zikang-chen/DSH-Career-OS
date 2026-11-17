"""简历文本提取：分层策略，谁可用用谁，绝不挂死。

为什么分层而不是写死一个库：
  - PDF 里最麻烦的是中文（CID 字体要查 ToUnicode CMap）。只有专业解析库能稳定还原，
    stdlib 手写解析在真实 PDF 上既不可靠、又容易因为畸形 stream 而卡死。
  - 所以优先用 pdfminer.six（纯 Python，中文还原最好），其次 pypdf，最后才是
    加固过的 stdlib 兜底。三者都失败时明确报错，让用户改粘贴，而不是编造内容。

依赖装在项目自带的隔离 venv（runtime/venv），不污染用户自己的 Python 环境。
"""
import json
import os
import re
import sys
import zipfile
import zlib

# 项目自带的隔离依赖目录（pip --target 装的 PDF 库）。放在这里而不是用户环境里，
# 避免动 Anaconda / 系统 Python 的包版本（早期试过全局装 pymupdf，顺带升级 protobuf
# 把 streamlit 弄坏了，这里是修正后的做法）。
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PYLIB = os.path.join(_PROJECT_ROOT, "runtime", "pylib")
if os.path.isdir(_PYLIB) and _PYLIB not in sys.path:
    sys.path.insert(0, _PYLIB)

# Windows 下 stdout 被管道接走时默认用 ANSI 代码页（简体中文系统是 GBK），
# 简历里的 • / – 这类字符会直接让 print 抛 UnicodeEncodeError。强制 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                   # noqa: BLE001
        pass


def emit(payload):
    """打印 JSON；万一编码仍然失败，退回 \\uXXXX 转义（JSON 语义不变）。"""
    try:
        print(json.dumps(payload, ensure_ascii=False))
    except UnicodeEncodeError:
        print(json.dumps(payload, ensure_ascii=True))

MAX_RAW_BYTES = 60 * 1024 * 1024       # 拒绝超大文件
MAX_STREAMS = 800                       # stdlib 兜底时最多处理多少个 stream
MAX_STREAM_BYTES = 4 * 1024 * 1024      # 单个 stream 解压上限
MAX_TEXT_CHARS = 200_000


def clean(text):
    text = (text or "").replace("\u0000", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [ln.strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln)[:MAX_TEXT_CHARS]


def text_quality(text):
    """粗略判断提取结果是否可用（中文/英文正文占比 + 长度）。"""
    if not text:
        return {"cjk": 0.0, "ascii": 0.0, "printable": 0.0, "ok": False}
    n = max(len(text), 1)
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text)) / n
    ascii_words = len(re.findall(r"[A-Za-z]{2,}", text)) / n
    printable = len(re.findall(r"[\w\u4e00-\u9fff\s\.,;:!?%&/\-+()（）·、]", text)) / n
    ok = printable > 0.72 and (cjk > 0.04 or ascii_words > 0.12) and len(text) > 80
    return {"cjk": round(cjk, 4), "ascii": round(ascii_words, 4), "printable": round(printable, 4), "ok": ok}


# ─── DOCX（zip + XML，stdlib 就够）────────────────────────────────────────────
def from_docx(path):
    with zipfile.ZipFile(path) as zf:
        parts = [n for n in zf.namelist()
                 if re.match(r"word/(document|header\d*|footer\d*|footnotes)\.xml$", n)]
        chunks = []
        for name in parts:
            xml = zf.read(name).decode("utf-8", "ignore")
            xml = re.sub(r"</w:p>", "\n", xml)
            xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
            xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
            chunks.append(re.sub(r"<[^>]+>", "", xml))
    return clean("\n".join(chunks))


# ─── Tier 1: pdfminer.six ────────────────────────────────────────────────────
def from_pdfminer(path):
    from pdfminer.high_level import extract_text
    from pdfminer.layout import LAParams
    return clean(extract_text(path, laparams=LAParams(line_margin=0.3)))


# ─── Tier 2: pypdf ──────────────────────────────────────────────────────────
def from_pypdf(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    parts = []
    for page in reader.pages[:80]:          # 简历不会有 80 页，防畸形文件
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return clean("\n".join(parts))


# ─── Tier 3: stdlib 兜底（加固：限额 + 不用灾难性正则）──────────────────────
def _inflate(blob):
    for wbits in (15, -15, 47):
        try:
            data = zlib.decompress(blob, wbits)
            if len(data) > MAX_STREAM_BYTES:
                data = data[:MAX_STREAM_BYTES]
            return data
        except Exception:
            continue
    return None


def _pdf_strings(content):
    """从内容流里抓 (…) / [ … ] / <hex> 文本片段，逐字符扫描，不用嵌套量词正则。"""
    out = []
    i, n = 0, len(content)
    depth = 0
    buf = []
    in_paren = False
    while i < n and len(out) < 40000:
        ch = content[i]
        if in_paren:
            if ch == "\\" and i + 1 < n:
                nxt = content[i + 1]
                mapping = {"n": "\n", "r": "\r", "t": "\t", "(": "(", ")": ")", "\\": "\\"}
                buf.append(mapping.get(nxt, nxt))
                i += 2
                continue
            if ch == "(":
                depth += 1
                buf.append(ch)
            elif ch == ")":
                if depth == 0:
                    out.append("".join(buf))
                    buf = []
                    in_paren = False
                else:
                    depth -= 1
                    buf.append(ch)
            else:
                buf.append(ch)
            i += 1
            continue
        if ch == "(":
            in_paren = True
            depth = 0
            buf = []
        elif ch == "<" and i + 2 < n:
            end = content.find(">", i)
            if 0 < end - i <= 4000:
                hexpart = re.sub(r"\s+", "", content[i + 1:end])
                if hexpart and re.fullmatch(r"[0-9A-Fa-f]+", hexpart or "x"):
                    try:
                        raw = bytes.fromhex(hexpart)
                        out.append(raw.decode("utf-16-be", "ignore") if len(raw) % 2 == 0 else raw.decode("latin-1", "ignore"))
                    except Exception:
                        pass
                i = end + 1
                continue
        i += 1
    return out


def from_stdlib_pdf(path):
    with open(path, "rb") as fh:
        raw = fh.read(MAX_RAW_BYTES + 1)
    if len(raw) > MAX_RAW_BYTES:
        raise ValueError(f"PDF 超过 {MAX_RAW_BYTES // 1024 // 1024}MB，已跳过兜底解析")

    pieces = []
    pos = 0
    count = 0
    while count < MAX_STREAMS:
        start = raw.find(b"stream", pos)
        if start < 0:
            break
        end = raw.find(b"endstream", start)
        if end < 0:
            break
        body_start = start + len(b"stream")
        if raw[body_start:body_start + 2] == b"\r\n":
            body_start += 2
        elif raw[body_start:body_start + 1] in (b"\n", b"\r"):
            body_start += 1
        blob = raw[body_start:end]
        pos = end + len(b"endstream")
        count += 1
        data = _inflate(blob)
        if not data:
            continue
        try:
            content = data.decode("latin-1", "ignore")
        except Exception:
            continue
        pieces.extend(_pdf_strings(content))
    return clean("".join(pieces))


def from_pdf(path):
    """按可用性依次尝试，返回 (text, engine, attempts)。

    engine 为 "partial" 表示所有引擎都没达到可用质量阈值，但保留了最长的结果，
    交给调用方决定是否提示用户改用粘贴。
    """
    attempts = []
    best_text = ""
    best_engine = "none"
    for name, fn in (("pdfminer.six", from_pdfminer), ("pypdf", from_pypdf), ("stdlib", from_stdlib_pdf)):
        try:
            text = fn(path)
        except ImportError:
            attempts.append({"engine": name, "skipped": "未安装"})
            continue
        except Exception as exc:                       # noqa: BLE001
            attempts.append({"engine": name, "error": f"{type(exc).__name__}: {exc}"[:300]})
            continue
        quality = text_quality(text)
        attempts.append({"engine": name, "chars": len(text), **quality})
        if quality["ok"]:
            return text, name, attempts
        if len(text) > len(best_text):
            best_text, best_engine = text, "partial"
    return best_text, best_engine, attempts


def main():
    if len(sys.argv) < 3:
        emit({"ok": False, "error": "usage: extract_resume.py <file> <format>"})
        return 2
    path, fmt = sys.argv[1], sys.argv[2].lower()
    notes = []
    engine = fmt
    attempts = []

    try:
        if fmt == "docx":
            text = from_docx(path)
            engine = "docx-zip"
        elif fmt == "pdf":
            text, engine, attempts = from_pdf(path)
        else:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                text = clean(fh.read())
            engine = "text"
    except Exception as exc:                            # noqa: BLE001
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:500], "attempts": attempts})
        return 0

    quality = text_quality(text)
    ok = quality["ok"]
    if not ok:
        if fmt == "pdf" and not text.strip():
            notes.append("PDF 里没有可提取的文本层——大概率是扫描件/图片型简历。")
            notes.append("需要 OCR，或直接用「粘贴文本」导入。")
        elif not ok:
            notes.append("提取出的文本可读性低：可能是扫描件，或用了嵌入字体无法映射回 Unicode。")
            notes.append("建议改用「粘贴简历文本」导入。")
    if fmt == "pdf" and engine == "stdlib":
        notes.append("当前用的是加固的兜底解析器，结果可能缺行缺字；装好 PDF 依赖后会更准。")
    if attempts:
        notes.append("解析尝试：" + "；".join(
            f"{a.get('engine')}={a.get('chars', 0) if 'chars' in a else (a.get('skipped') or a.get('error'))}" for a in attempts))

    emit({
        "ok": ok,
        "format": fmt,
        "engine": engine,
        "text": text,
        "chars": len(text),
        **quality,
        "attempts": attempts,
        "notes": notes,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
