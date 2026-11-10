# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["pymupdf>=1.24", "rapidocr-onnxruntime>=1.3", "numpy>=1.26"]
# ///
"""离线 OCR 支线：把已下载 PDF 逐页识别成文本，写回索引预留的 textRef / ocrStatus。

用法（在仓库根目录）:
    # 整批：扫下载目录里还没识别的本地 PDF
    uv run tools/ocr/ocr.py --dir "C:/Users/<你>/Downloads/方志检索" [--limit 20]

    # 单本：指定 PDF，可限页数先冒烟
    uv run tools/ocr/ocr.py --pdf "C:/.../嘉靖赣州府志.pdf" [--max-pages 3] [--lang chs] [--vertical off]

    # 重跑已识别过的页（改算法后复测用）
    uv run tools/ocr/ocr.py --dir "..." --limit 10 --max-pages 6 --force

产物：data/ocr/<fid>.jsonl，每行一页（按页存是硬要求——阅读器要跳页、要高亮）：

    {"p":1,"dpi":200,"w":1240,"h":1754,"dir":"v","text":"嘉靖十五年……",
     "lines":[{"t":"嘉靖十五年","b":[123,456,789,480],"s":0.94}, ...]}

- `p` 从 1 开始；`b` 是 [x0,y0,x1,y1]，坐标基于该页按 `dpi` 渲染后的像素；
- `text` 是 `lines` 按识别顺序拼起来的整页文本，供检索用；
- 空页也写一行（text 为空），这样续跑时不重复识别。

索引里只记相对引用（`ocr/<fid>.jsonl`），索引体积不涨。重跑安全：
已写进 jsonl 的页会跳过；只有整本页都识别完才把 ocrStatus 标成 done。
"""

import argparse
import json
import re
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import pymupdf as fitz  # 新名字；旧 import fitz 已弃用并会在未来移除
from rapidocr_onnxruntime import RapidOCR

REPO = Path(__file__).resolve().parents[2]
SANITIZE = re.compile(r'[\\/:*?"<>|]')
CHT_MODEL = Path(__file__).resolve().parent / 'models' / 'chinese_cht_PP-OCRv3_rec_mobile.onnx'
CHT_URL = ('https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/'
           'onnx/PP-OCRv4/rec/chinese_cht_PP-OCRv3_rec_mobile.onnx')
# 每页平均字符数超过这个值就认为 PDF 自带字层，直接抄文本、不跑模型
TEXT_LAYER_MIN = 30


def local_name(name: str) -> str:
    """和桌面端 main/download.ts 的 sanitize 保持同一条落盘命名规则。"""
    return SANITIZE.sub('_', name).strip() or 'download'


def page_image(page: fitz.Page, dpi: int) -> np.ndarray:
    pix = page.get_pixmap(dpi=dpi)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        img = img[:, :, :3]
    elif pix.n == 1:
        img = np.repeat(img, 3, axis=2)
    # PyMuPDF 给的是 RGB，RapidOCR（cv2 约定）要 BGR
    return np.ascontiguousarray(img[:, :, ::-1])


def ensure_cht_model() -> Path:
    """繁体识别模型（chinese_cht）。放仓库外太大，首次使用时从 ModelScope 下到 tools/ocr/models。"""
    if CHT_MODEL.is_file() and CHT_MODEL.stat().st_size > 1_000_000:
        return CHT_MODEL
    CHT_MODEL.parent.mkdir(parents=True, exist_ok=True)
    print(f'下载繁体模型 -> {CHT_MODEL}（约 11MB，只需一次）', flush=True)
    tmp = CHT_MODEL.with_suffix('.part')
    with urllib.request.urlopen(CHT_URL, timeout=180) as resp, tmp.open('wb') as fh:
        shutil.copyfileobj(resp, fh)
    tmp.replace(CHT_MODEL)
    return CHT_MODEL


def _to_lines(result) -> list[dict]:
    lines = []
    for item in result or []:
        box, text, score = item[0], item[1], float(item[2])
        xs = [pt[0] for pt in box]
        ys = [pt[1] for pt in box]
        lines.append({
            't': str(text),
            'b': [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
            's': round(score, 3),
        })
    return lines


def text_layer_ratio(doc: fitz.Document, sample: int = 6) -> float:
    """抽样几页，返回每页平均的去空白字符数。大于阈值说明 PDF 本身带字层，
    直接抄比 OCR 准得多（数字重排本 CER 从 20%+ 直接归零），也不用等模型。"""
    n = min(sample, doc.page_count)
    if n <= 1:
        return len(re.sub(r'\s', '', doc[0].get_text() or '')) if doc.page_count else 0.0
    idx = sorted({int(round(i * (doc.page_count - 1) / (n - 1))) for i in range(n)})
    return sum(len(re.sub(r'\s', '', doc[i].get_text() or '')) for i in idx) / len(idx)


def text_page(page: fitz.Page, dpi: int) -> dict:
    """按行抄字层。坐标换算成 dpi 渲染后的像素，和 OCR 产物保持同一套约定。"""
    scale = dpi / 72.0
    lines: list[dict] = []
    for blk in page.get_text('dict').get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk.get('lines', []):
            t = ''.join(s.get('text', '') for s in ln.get('spans', [])).strip()
            if not t:
                continue
            x0, y0, x1, y1 = ln['bbox']
            lines.append({
                't': t,
                'b': [round(x0 * scale), round(y0 * scale), round(x1 * scale), round(y1 * scale)],
                's': 1.0,
            })
    return {
        'dpi': dpi,
        'w': round(page.rect.width * scale),
        'h': round(page.rect.height * scale),
        'dir': 'h',
        'src': 'text',
        'text': '\n'.join(l['t'] for l in lines),
        'lines': lines,
    }


def _is_vertical(lines: list[dict]) -> bool:
    """竖排页面检测出来的是一个个人高的窄框；横排则是宽条。看「高框」占比而不是中位数，
    因为古籍书名叶常常是「横排大字 + 若干竖列」混排。"""
    if len(lines) < 4:
        return False
    tall = sum(1 for l in lines if (l['b'][3] - l['b'][1]) / max(1, l['b'][2] - l['b'][0]) >= 1.4)
    return tall >= 4 and tall >= len(lines) * 0.5


def _is_tall(box: list[int]) -> bool:
    return (box[3] - box[1]) / max(1, box[2] - box[0]) >= 1.4


def _split_chars(img: np.ndarray, b: list[int]) -> list[np.ndarray]:
    """一列竖排字按字数等分切块；边界在等分点附近吸附到墨迹最少的行。

    不能按「字内空白行」下刀：上下结构的字（寰、壽、暑）中间本来就有空白，
    会被劈成两个假字，识别出来就是 1-2 个错字（实测「寰」→「齒衣」）。
    """
    x0, y0, x1, y1 = b
    crop = img[y0:y1, x0:x1]
    if crop.size == 0:
        return []
    h, w = crop.shape[:2]
    # 竖排单字近方形，列宽可以当字高用；这比数字数更稳，也不依赖字间是否粘连
    n = max(1, min(60, int(round(h / max(1, w)))))
    step = h / n
    if n == 1:
        return [crop]
    ink = (crop.mean(axis=2) < 160).sum(axis=1).astype(np.float32)
    cuts = [0]
    for k in range(1, n):
        target = int(k * step)
        lo = max(1, int(target - step * 0.3))
        hi = min(h - 1, int(target + step * 0.3))
        cuts.append(lo + int(np.argmin(ink[lo:hi])) if hi > lo else target)
    cuts.append(h)
    return [crop[a:b] for a, b in zip(cuts, cuts[1:]) if b - a >= 3]


def _y_bands(lines: list[dict]) -> list[list[dict]]:
    """上下双叶扫描：上下两叶的竖列 x 范围是重叠的，直接按 x 聚列会把两叶的字
    拼进同一条识别带，整页变成乱码（宁古塔志就是这样废掉的）。先按 y 断开。"""
    if len(lines) < 6:
        return [lines]
    ordered = sorted(lines, key=lambda l: l['b'][1])
    bands: list[list[dict]] = []
    cur: list[dict] = []
    bottom = -1
    for ln in ordered:
        if cur and ln['b'][1] > bottom + 6:
            bands.append(cur)
            cur = []
            bottom = -1
        cur.append(ln)
        bottom = max(bottom, ln['b'][3])
    if cur:
        bands.append(cur)
    # 切得太碎说明本来就不是双叶（比如短列的书名叶），退回原样
    if len(bands) < 2 or any(len(b) < 3 for b in bands):
        return [lines]
    return bands


def _vertical_columns(img: np.ndarray, lines: list[dict]) -> list[dict]:
    """竖排重排：字块按 x 重叠聚成列，列内按 y 排序，横向拼成一条供识别。"""
    groups: list[dict] = []
    for ln in sorted(lines, key=lambda l: l['b'][0]):
        x0, _, x1, _ = ln['b']
        for g in groups:
            gx0, gx1 = g['x']
            overlap = min(x1, gx1) - max(x0, gx0)
            if overlap > 0.5 * min(x1 - x0, gx1 - gx0):
                g['lines'].append(ln)
                g['x'] = (min(x0, gx0), max(x1, gx1))
                break
        else:
            groups.append({'x': (x0, x1), 'lines': [ln]})

    strips = []
    for g in groups:
        g['lines'].sort(key=lambda l: l['b'][1])
        pieces: list[np.ndarray] = []
        for ln in g['lines']:
            pieces.extend(_split_chars(img, ln['b']))
        if not pieces:
            continue
        height = max(p.shape[0] for p in pieces)
        # 不插空白间隔：cth 模型会把空白识别成杂字（「興」），字块本来就是按空白切的
        row: list[np.ndarray] = []
        for p in pieces:
            if p.shape[0] < height:
                pad = np.full((height - p.shape[0], p.shape[1], 3), 255, np.uint8)
                p = np.vstack([p, pad])
            row.append(p)
        xs = [l['b'][0] for l in g['lines']] + [l['b'][2] for l in g['lines']]
        ys = [l['b'][1] for l in g['lines']] + [l['b'][3] for l in g['lines']]
        strips.append({
            'img': np.hstack(row),
            'center': sum(g['x']) / 2,
            'box': [min(xs), min(ys), max(xs), max(ys)],
        })
    # 竖排从右往左读
    strips.sort(key=lambda s: s['center'], reverse=True)
    return strips


def ocr_page(engine: RapidOCR, page: fitz.Page, dpi: int, vertical: str = 'auto') -> dict:
    img = page_image(page, dpi)
    h, w = img.shape[:2]
    result, _ = engine(img)
    lines = _to_lines(result)
    direction = 'h'

    if vertical != 'off' and (vertical == 'always' or _is_vertical(lines)):
        if vertical == 'always':
            tall, other = lines, []
        else:
            tall = [l for l in lines if _is_tall(l['b'])]
            other = [l for l in lines if not _is_tall(l['b'])]
        # 每个 y 带单独聚列：上下双叶的两叶必须分开排，否则会互相穿插
        strips: list[dict] = []
        for band in _y_bands(tall):
            strips.extend(_vertical_columns(img, band))
        if strips:
            recs, _ = engine.text_rec([s['img'] for s in strips])
            cols = [
                {'t': str(text), 'b': s['box'], 's': round(float(score), 3)}
                for s, (text, score) in zip(strips, recs)
            ]
            # 书名叶上的横排大字：比正文列更靠上的放前面，更靠下的（页码等）放后面
            top = min(l['b'][1] for l in cols)
            bottom = max(l['b'][3] for l in cols)
            head = sorted([l for l in other if l['b'][3] <= top], key=lambda l: l['b'][1])
            tail = sorted([l for l in other if l['b'][1] >= bottom], key=lambda l: l['b'][1])
            lines = head + cols + tail
            direction = 'v'

    return {
        'dpi': dpi,
        'w': w,
        'h': h,
        'dir': direction,
        'text': '\n'.join(l['t'] for l in lines),
        'lines': lines,
    }


def weighted_score(rec: dict) -> float:
    """按字数加权的置信度。短行（页码、单字）不该和整列正文同权。"""
    total = sum(len(l['t']) for l in rec['lines'])
    if not total:
        return 0.0
    return sum(len(l['t']) * l['s'] for l in rec['lines']) / total


def pick_lang(engines: dict[str, RapidOCR], doc: fitz.Document, dpi: int, vertical: str) -> str:
    """自动挑识别模型：取正文页分别用简/繁各识别一次，按字数加权置信度取高者。

    简体铅印/重排本喂给繁体模型时，字会被替换成形近的繁体字（县→具、为→力），
    置信度会明显掉下来，这个差异足够大（实测 26.9% vs 1.7% 的错字率）。
    """
    probe = min(4, doc.page_count) - 1
    best, best_score = 'cht', -1.0
    for lang, eng in engines.items():
        score = weighted_score(ocr_page(eng, doc[probe], dpi, vertical))
        print(f'  试 {lang}: 加权置信度 {score:.3f}', flush=True)
        if score > best_score:
            best, best_score = lang, score
    return best


def read_done_pages(path: Path) -> set[int]:
    """已落盘的页码。末行可能是 Ctrl-C 截断的半截 JSON，直接丢弃。"""
    done: set[int] = set()
    if not path.is_file():
        return done
    with path.open('r', encoding='utf-8') as fh:
        for raw in fh:
            try:
                done.add(int(json.loads(raw)['p']))
            except (ValueError, KeyError, json.JSONDecodeError):
                continue
    return done


def ocr_file(engine: RapidOCR, pdf: Path, out_path: Path, dpi: int, max_pages: int, vertical: str,
             force: bool = False) -> tuple[int, int]:
    """识别一本，返回 (本次识别页数, 总页数)。"""
    doc = fitz.open(pdf)
    try:
        total = doc.page_count
        limit = min(total, max_pages) if max_pages > 0 else total
        if force and out_path.is_file():
            out_path.unlink()
        done = read_done_pages(out_path)
        pages = 0
        # 续跑：追加到已有 jsonl 后面，跳过多余的页
        with out_path.open('a', encoding='utf-8') as fh:
            for n in range(limit):
                p = n + 1
                if p in done:
                    continue
                rec = {'p': p, **ocr_page(engine, doc[n], dpi, vertical)}
                fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
                fh.flush()
                pages += 1
                print(f'  page {p}/{limit} · {rec["dir"]} · {len(rec["lines"])} 行', flush=True)
        return pages, total
    finally:
        doc.close()


def text_file(doc: fitz.Document, out_path: Path, dpi: int, max_pages: int, force: bool = False) -> int:
    """带字层的 PDF 直接抄文本，不走模型。返回本次写入页数。"""
    if force and out_path.is_file():
        out_path.unlink()
    limit = min(doc.page_count, max_pages) if max_pages > 0 else doc.page_count
    done = read_done_pages(out_path)
    pages = 0
    with out_path.open('a', encoding='utf-8') as fh:
        for n in range(limit):
            p = n + 1
            if p in done:
                continue
            rec = {'p': p, **text_page(doc[n], dpi)}
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n')
            fh.flush()
            pages += 1
            print(f'  page {p}/{limit} · text · {len(rec["lines"])} 行', flush=True)
    return pages


def save_index(index_path: Path, idx: dict) -> None:
    # encoding 必须显式 utf-8：Windows 上默认走 gbk，ensure_ascii=False 的中文会写坏，
    # 下次 read_text('utf-8') 直接解码失败，等于毁了整个索引。
    tmp = tempfile.NamedTemporaryFile('w', dir=index_path.parent, delete=False, suffix='.json', encoding='utf-8')
    tmp.write(json.dumps(idx, ensure_ascii=False))
    tmp.close()
    Path(tmp.name).replace(index_path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--index', default=str(REPO / 'data' / 'index.full.json'))
    ap.add_argument('--dir', help='桌面端下载保存目录，批量识别其中的本地 PDF')
    ap.add_argument('--pdf', help='只识别这一个 PDF（按文件名对上索引里的记录）')
    ap.add_argument('--fid', help='配合 --pdf 用，手动指定 fid（同名文件才需要）')
    ap.add_argument('--limit', type=int, default=20, help='批量模式下最多识别几本')
    ap.add_argument('--max-pages', type=int, default=0, help='每本最多识别几页，0 = 全部（冒烟用 3）')
    ap.add_argument('--dpi', type=int, default=200, help='渲染 DPI，古籍建议 200 起')
    ap.add_argument('--lang', choices=['auto', 'cht', 'chs'], default='auto',
                    help='识别模型：auto 每本按置信度自动挑（默认）/ cht 繁体 / chs 简体')
    ap.add_argument('--vertical', choices=['auto', 'off', 'always'], default='auto',
                    help='竖排处理：auto 按页面自动判断，off 关闭，always 强制整本竖排')
    ap.add_argument('--force', action='store_true', help='忽略已识别的页，整本重跑（改算法后复测用）')
    args = ap.parse_args()

    if not args.dir and not args.pdf:
        ap.error('--dir 和 --pdf 至少给一个')

    index_path = Path(args.index)
    idx = json.loads(index_path.read_text('utf-8'))
    ocr_dir = index_path.parent / 'ocr'
    ocr_dir.mkdir(parents=True, exist_ok=True)
    by_fid = {f['fid']: f for f in idx['files']}
    book_by_id = {b['id']: b for b in idx['books']}

    todo: list[tuple[dict, Path]] = []
    if args.pdf:
        p = Path(args.pdf)
        rec = by_fid.get(args.fid) if args.fid else None
        if rec is None:
            name = local_name(p.name)
            rec = next((f for f in idx['files'] if local_name(f['name']) == name), None)
        if rec is None:
            print(f'索引里找不到 {p.name}，无法回填 textRef。可先用 --dir 模式或补 --fid。')
            return 1
        todo.append((rec, p))
    if args.dir:
        dl = Path(args.dir)
        for f in idx['files']:
            if len(todo) >= args.limit:
                break
            if f.get('ext') != 'pdf':
                continue
            if not args.force and f.get('ocrStatus') == 'done':
                continue
            p = dl / local_name(f['name'])
            if p.is_file() and all(t[0]['fid'] != f['fid'] for t in todo):
                todo.append((f, p))

    if not todo:
        print(f'没有待识别的本地 PDF（下载目录 {args.dir}）。先用桌面端下载几本再跑。')
        return 0

    made: dict[str, RapidOCR] = {}

    def engine_for(lang: str) -> RapidOCR:
        # 两个模型都建起来约 200MB，按需延迟创建
        if lang not in made:
            made[lang] = RapidOCR(rec_model_path=str(ensure_cht_model())) if lang == 'cht' else RapidOCR()
        return made[lang]

    print(f'识别模型 {args.lang}，竖排 {args.vertical}', flush=True)

    for i, (f, p) in enumerate(todo, 1):
        ref = f'ocr/{f["fid"]}.jsonl'
        out_path = index_path.parent / ref
        print(f'[{i}/{len(todo)}] {f["name"]} ({p.stat().st_size // 1024} KB)')
        lang = args.lang
        try:
            doc = fitz.open(p)
            try:
                ratio = text_layer_ratio(doc)
                if ratio >= TEXT_LAYER_MIN:
                    print(f'  自带文本层（抽样 {ratio:.0f} 字/页），直接抄，不走模型', flush=True)
                    lang = 'text'
                    pages = text_file(doc, out_path, args.dpi, args.max_pages, args.force)
                    total = doc.page_count
                else:
                    if args.lang == 'auto':
                        lang = pick_lang({l: engine_for(l) for l in ('chs', 'cht')},
                                         doc, args.dpi, args.vertical)
                        print(f'  自动选模型：{lang}', flush=True)
                    pages, total = ocr_file(engine_for(lang), p, out_path, args.dpi,
                                            args.max_pages, args.vertical, args.force)
            finally:
                doc.close()
        except Exception as e:  # 单个文件坏了不该中断整批
            print(f'  跳过：{e}')
            continue

        if pages == 0 and not out_path.is_file():
            print('  没有识别出内容，索引不动')
            continue

        was_done = f.get('ocrStatus') == 'done'
        complete = total > 0 and len(read_done_pages(out_path)) >= total
        f['textRef'] = ref
        f['ocrStatus'] = 'done' if complete else 'pending'
        if complete and not was_done:
            book = book_by_id.get(f['bookId'])
            if book:
                book['ocrDone'] = book.get('ocrDone', 0) + 1
        save_index(index_path, idx)  # 每本落盘：OCR 很慢，中途 Ctrl-C 不该丢已做的
        print(f'  -> {ref}（{lang}，本次 {pages} 页，全本 {total} 页，状态 {f["ocrStatus"]}）')

    print('索引已更新；小程序要用全文需重新导出 lean 索引。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
