"""Build the SureQ logo kit masters from one set of geometry.

Usage: python3 -I build_logo.py <Outfit.ttf> <out-dir>

The symbol is a Q: a ring (the bowl) whose tail is a check mark. The check is drawn as two capsules
(a round-capped stroke expanded to filled outlines), so the masters contain no strokes.
"""
import math
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

EMERALD = '#059669'      # emerald-600: 3.8:1 on white, enough for a graphic
EMERALD_DARK = '#34d399' # emerald-400, for dark backgrounds
INK = '#18181b'          # zinc-900, the docs site's text colour


def f(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.')


def ring(cx, cy, R, r):
    return (f'M{f(cx)} {f(cy - R)}a{f(R)} {f(R)} 0 1 0 0 {f(2 * R)}a{f(R)} {f(R)} 0 1 0 0 {f(-2 * R)}z'
            f'M{f(cx)} {f(cy - r)}a{f(r)} {f(r)} 0 1 1 0 {f(2 * r)}a{f(r)} {f(r)} 0 1 1 0 {f(-2 * r)}z')


def capsule(p, q, w):
    """A round-capped segment from p to q, half-width w, as one closed path."""
    dx, dy = q[0] - p[0], q[1] - p[1]
    n = math.hypot(dx, dy)
    nx, ny = -dy / n * w, dx / n * w
    a = (p[0] + nx, p[1] + ny)
    b = (q[0] + nx, q[1] + ny)
    c = (q[0] - nx, q[1] - ny)
    d = (p[0] - nx, p[1] - ny)
    return (f'M{f(a[0])} {f(a[1])}L{f(b[0])} {f(b[1])}A{f(w)} {f(w)} 0 0 0 {f(c[0])} {f(c[1])}'
            f'L{f(d[0])} {f(d[1])}A{f(w)} {f(w)} 0 0 0 {f(a[0])} {f(a[1])}z')


def symbol_paths(small=False):
    """Return (ring_d, check_d) in a 256 box, optically centred.

    small=True is the 16-32 px cut: heavier ring and check, wider gap between the check's long arm and the ring.
    """
    if small:
        cx, cy, R, r, w = 108, 112, 92, 54, 19
        mid = (R + r) / 2
        a = math.radians(62)
        start = (cx + mid * math.cos(a), cy + mid * math.sin(a))
        vertex = (start[0] + 32, start[1] + 32)
        end = (vertex[0] + 52, vertex[1] - 64)
    else:
        cx, cy, R, r, w = 112, 112, 90, 60, 15
        mid = (R + r) / 2
        a = math.radians(60)
        start = (cx + mid * math.cos(a), cy + mid * math.sin(a))
        vertex = (start[0] + 30, start[1] + 30)
        end = (vertex[0] + 56.5, vertex[1] - 67)
    # optical centring: put the whole mark's box centre just above the canvas centre
    xs = [cx - R, cx + R, start[0] - w, vertex[0] + w, end[0] + w]
    ys = [cy - R, cy + R, vertex[1] + w, end[1] - w]
    ox = 128 - (min(xs) + max(xs)) / 2
    oy = 126 - (min(ys) + max(ys)) / 2
    sh = lambda pt: (pt[0] + ox, pt[1] + oy)
    ring_d = ring(cx + ox, cy + oy, R, r)
    check_d = capsule(sh(start), sh(vertex), w) + capsule(sh(vertex), sh(end), w)
    return ring_d, check_d


def svg(view, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}">\n'
            f'  <title>{title}</title>\n{body}\n</svg>\n')


def symbol_svg(ring_col, check_col, small=False, title='SureQ'):
    ring_d, check_d = symbol_paths(small)
    body = (f'  <path fill="{ring_col}" fill-rule="evenodd" d="{ring_d}"/>\n'
            f'  <path fill="{check_col}" d="{check_d}"/>')
    return svg('0 0 256 256', body, title)


def wordmark(font_path, text, weight):
    """Outline `text` at `weight`; return (path_d, advance_width, cap_height) in font units, y flipped."""
    font = TTFont(font_path)
    font = instantiateVariableFont(font, {'wght': weight})
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font['hmtx']
    cap = font['OS/2'].sCapHeight
    ascent = font['hhea'].ascent
    d = []
    x = 0
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, ascent)))
        d.append(pen.getCommands())
        x += hmtx[name][0]
    return ''.join(d), x, cap, ascent


def main():
    font_path, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    # symbol masters
    (out / 'sureq-symbol-black.svg').write_text(symbol_svg('#000', '#000'))
    # one colour only: where the check grows out of the ring, two colours would show the overlap
    (out / 'sureq-symbol.svg').write_text(symbol_svg(EMERALD, EMERALD))
    (out / 'sureq-symbol-reversed.svg').write_text(symbol_svg(EMERALD_DARK, EMERALD_DARK))
    (out / 'sureq-symbol-small.svg').write_text(symbol_svg('#000', '#000', small=True, title='SureQ (small sizes)'))

    # horizontal lockup: "Sure" outlined + the symbol as the Q, cap height = the ring's height
    d, adv, cap, ascent = wordmark(font_path, 'Sure', 600)
    ring_d, check_d = symbol_paths()
    sym_h = 180.0                       # ring outer diameter in symbol units
    scale = sym_h / cap                 # font units -> symbol units, so caps match the ring
    gap = 14                            # space between "e" and the Q ring, in symbol units
    # the ring's left edge in symbol coords
    ring_left = 128 - 0  # recomputed below from the path box
    # place the symbol so its ring's left edge sits `gap` after the word
    word_w = adv * scale
    # symbol ring box: find from geometry (same maths as symbol_paths)
    cx, R = 112, 90
    xs = [cx - R, cx + R]
    # baseline alignment: caps sit on the ring's bottom
    def lockup(word_col, ring_col, check_col, name):
        ring_box_left = None
        # compute symbol offset used in symbol_paths
        import re
        m = re.match(r'M([\d.]+) ([\d.]+)', ring_d)
        top_x, top_y = float(m.group(1)), float(m.group(2))
        ring_cx, ring_top = top_x, top_y
        ring_box_left = ring_cx - R
        ring_bottom = ring_top + 2 * R
        tx = word_w + gap - ring_box_left
        # text: baseline at ring bottom; font y flipped with ascent at 0
        text_ty = ring_bottom - ascent * scale
        width = tx + 256
        body = (f'  <path fill="{word_col}" transform="translate(0 {f(text_ty)}) scale({f(scale)})" d="{d}"/>\n'
                f'  <g transform="translate({f(tx)} 0)">\n'
                f'    <path fill="{ring_col}" fill-rule="evenodd" d="{ring_d}"/>\n'
                f'    <path fill="{check_col}" d="{check_d}"/>\n  </g>')
        (out / name).write_text(svg(f'0 0 {f(width)} 256', body, 'SureQ'))

    lockup(INK, EMERALD, EMERALD, 'sureq-horizontal.svg')
    lockup('#000', '#000', '#000', 'sureq-horizontal-black.svg')
    lockup('#fff', EMERALD_DARK, EMERALD_DARK, 'sureq-horizontal-reversed.svg')
    print('wrote', ', '.join(sorted(p.name for p in out.glob('*.svg'))))


if __name__ == '__main__':
    main()
