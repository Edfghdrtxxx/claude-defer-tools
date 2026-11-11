#!/usr/bin/env python3
"""Draws docs/screenshots/ from what tests/screenshots.test.tsx prints.

    claude plugin test . | python3 scripts/render-screenshots.py

Every picture is drawn from an automated test with test data, not taken from a real session:

- Terminal: the element tree the mod returned for each animation frame (Box, Text, Raster
  cells, Button), laid out here as a character grid. The cells and words are the mod's; the
  font, the window frame and the default colours are this script's.
- Desktop, VS Code, mobile: the SVG the mod returned, rasterized with CairoSVG. The animated
  SVG itself is also saved, and plays in a browser.
- Status line: the texts the mod passed to $.ui.status, in order.

Needs Pillow, CairoSVG and the DejaVu Sans Mono font.
"""
import base64
import json
import os
import struct
import sys

import cairosvg
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'screenshots')
CAPTION = 'Drawn from an automated test (claude plugin test, Claude Code 2.1.322) with test data. Not a real session.'

MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
MONO_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

# Terminal look: a dark theme close to the mod's own palette.
BG = (26, 26, 25)
FG = (230, 229, 224)
DIM = (140, 139, 133)
ACCENT = (215, 119, 87)
BORDER = (80, 80, 76)
DEFAULT = 0x01000000

SCALE = 2
FONT_PX = 13 * SCALE
CELL_W = None  # set from the font
CELL_H = int(FONT_PX * 1.3)
PAD = 14 * SCALE

font = ImageFont.truetype(MONO, FONT_PX)
bold = ImageFont.truetype(MONO_BOLD, FONT_PX)
caption_font = ImageFont.truetype(SANS, 11 * SCALE)
CELL_W = int(round(font.getlength('M')))


def rgb(value, fallback):
    if value is None or value == DEFAULT:
        return fallback
    if isinstance(value, str):
        value = int(value.lstrip('#'), 16)
    return ((value >> 16) & 255, (value >> 8) & 255, value & 255)


# ------------------------------------------------------------------------------------------
# Terminal: lay out the element tree as lines of styled cells


def children_of(node):
    ch = node.get('children')
    if ch is None:
        ch = (node.get('props') or {}).get('children')
    if ch is None:
        return []
    return ch if isinstance(ch, list) else [ch]


def text_cells(node, style):
    """A Text and its nested Text, as one line of (char, fg, bg, bold)."""
    props = node.get('props') or {}
    fg = style['fg']
    if props.get('color'):
        fg = rgb(props['color'], fg)
    if props.get('dimColor'):
        fg = DIM
    st = {'fg': fg, 'bold': style['bold'] or bool(props.get('bold'))}
    cells = []
    kids = children_of(node)
    if not kids and node.get('text'):
        kids = [node['text']]
    for k in kids:
        if isinstance(k, str):
            cells += [(c, st['fg'], None, st['bold']) for c in k]
        elif isinstance(k, (int, float)):
            cells += [(c, st['fg'], None, st['bold']) for c in str(k)]
        elif isinstance(k, dict):
            cells += text_cells(k, st)
    return cells


def raster_lines(node):
    props = node['props']
    raw = base64.b64decode(props['cells'])
    cols, rows = props['columns'], props['rows']
    lines = []
    for r in range(rows):
        line = []
        for c in range(cols):
            i = (r * cols + c) * 12
            cp, fg, bg = struct.unpack_from('<III', raw, i)
            line.append((chr(cp), rgb(fg, FG), None if bg == DEFAULT else rgb(bg, BG), False))
        lines.append(line)
    return lines


def layout(node, style=None):
    """Returns a list of lines; each line is a list of cells."""
    style = style or {'fg': FG, 'bold': False}
    if node is None or isinstance(node, bool):
        return []
    if isinstance(node, str):
        return [[(c, style['fg'], None, False) for c in node]]
    kind = node.get('type')
    props = node.get('props') or {}
    if kind == 'Text':
        return [text_cells(node, style)]
    if kind == 'Raster':
        return raster_lines(node)
    if kind == 'Button':
        return [[(c, ACCENT, None, True) for c in f"[ {props.get('label', '')} ]"]]
    # Box, and anything else that holds children.
    parts = [layout(k, style) for k in children_of(node)]
    parts = [p for p in parts if p]
    if props.get('flexDirection', 'column') == 'row':
        height = max((len(p) for p in parts), default=0)
        bottom = props.get('alignItems') == 'flex-end'
        lines = [[] for _ in range(height)]
        for p in parts:
            width = max((len(line) for line in p), default=0)
            pad = height - len(p) if bottom else 0
            for r in range(height):
                src = r - pad
                line = p[src] if 0 <= src < len(p) else []
                lines[r] += line + [(' ', FG, None, False)] * (width - len(line))
        return lines
    out = []
    for p in parts:
        out += p
    return out


def draw_cell(d, x, y, ch, fg, bg):
    if bg is not None:
        d.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], fill=bg)
    cp = ord(ch)
    # Block elements, drawn as rectangles so bars have no gaps between cells.
    if cp == 0x2588:
        d.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], fill=fg)
    elif 0x2589 <= cp <= 0x258F:
        eighths = 0x2590 - cp  # 2589 = 7/8 ... 258F = 1/8
        d.rectangle([x, y, x + max(1, CELL_W * eighths // 8) - 1, y + CELL_H - 1], fill=fg)
    elif cp == 0x2580:
        d.rectangle([x, y, x + CELL_W - 1, y + CELL_H // 2 - 1], fill=fg)
    elif cp == 0x2584:
        d.rectangle([x, y + CELL_H // 2, x + CELL_W - 1, y + CELL_H - 1], fill=fg)
    elif cp == 0x2590:
        d.rectangle([x + CELL_W // 2, y, x + CELL_W - 1, y + CELL_H - 1], fill=fg)
    elif ch != ' ':
        return False
    return True


def draw_caption(d, width, y):
    d.text((PAD, y), CAPTION, font=caption_font, fill=DIM)


def terminal_image(lines, title, columns=100):
    rows = len(lines)
    inner_w = columns * CELL_W
    width = inner_w + 4 * PAD
    height = PAD + CELL_H + rows * CELL_H + 2 * PAD + CELL_H
    img = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(img)
    top = PAD + CELL_H // 2
    d.rounded_rectangle([PAD, top, width - PAD, top + (rows + 1) * CELL_H + PAD // 2], radius=6 * SCALE, outline=BORDER, width=SCALE)
    tw = int(bold.getlength(f' {title} '))
    d.rectangle([2 * PAD, top - CELL_H // 2, 2 * PAD + tw, top + CELL_H // 2], fill=BG)
    d.text((2 * PAD, top - FONT_PX // 2 - SCALE), f' {title} ', font=bold, fill=ACCENT)
    y0 = top + CELL_H
    for r, line in enumerate(lines):
        y = y0 + r * CELL_H
        for c, (ch, fg, bg, is_bold) in enumerate(line[:columns]):
            x = 2 * PAD + c * CELL_W
            if not draw_cell(d, x, y, ch, fg, bg):
                d.text((x, y + (CELL_H - FONT_PX) // 2), ch, font=bold if is_bold else font, fill=fg)
    draw_caption(d, width, height - PAD - 11 * SCALE)
    return img


def status_image(text, width_cols=96):
    width = width_cols * CELL_W + 4 * PAD
    height = PAD + 3 * CELL_H + CELL_H + 2 * PAD + CELL_H
    img = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([PAD, PAD, width - PAD, PAD + 2 * CELL_H], radius=6 * SCALE, outline=BORDER, width=SCALE)
    d.text((2 * PAD, PAD + CELL_H // 2), '> ', font=font, fill=FG)
    y = PAD + 2 * CELL_H + CELL_H // 2
    head, _, rest = text.partition('▼')
    x = 2 * PAD
    d.text((x, y), head, font=font, fill=DIM)
    x += font.getlength(head)
    if rest:
        d.text((x, y), '▼' + rest.split(' · ')[0], font=bold, fill=rgb('#3987e5', FG))
        x += bold.getlength('▼' + rest.split(' · ')[0])
        if ' · ' in rest:
            tail = ' · ' + rest.split(' · ', 1)[1]
            d.text((x, y), tail, font=font, fill=DIM)
    draw_caption(d, width, height - PAD - 11 * SCALE)
    return img


# ------------------------------------------------------------------------------------------
# Output


def save_gif(frames, durations, path):
    """frames: PIL images; durations: ms per frame. Loops forever."""
    pal = [f.convert('P', palette=Image.Palette.ADAPTIVE, colors=128) for f in frames]
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print('wrote', os.path.relpath(path), f'({os.path.getsize(path) // 1024} KB, {len(frames)} frames)')


def save_png(img, path):
    img.save(path, optimize=True)
    print('wrote', os.path.relpath(path))


def svg_image(svg, scale=SCALE):
    import io

    png = cairosvg.svg2png(bytestring=svg.encode(), scale=scale)
    img = Image.open(io.BytesIO(png)).convert('RGB')
    # Add the caption under the panel.
    bg = img.getpixel((2, 2))
    out = Image.new('RGB', (img.width, img.height + int(24 * scale)), bg)
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    is_dark = sum(bg) < 300
    d.text((int(16 * scale), img.height + int(4 * scale)), CAPTION, font=ImageFont.truetype(SANS, int(11 * scale)), fill=(140, 139, 133) if is_dark else (110, 109, 104))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    frames, statuses, svgs, stills = {}, {}, {}, {}
    for line in sys.stdin:
        tag, _, body = line.partition(' ')
        if tag not in ('FRAME', 'STATUS', 'SVG', 'SVGFRAME'):
            continue
        d = json.loads(body)
        if tag == 'FRAME':
            frames.setdefault(d['scenario'], {})[d['frame']] = d['tree']
        elif tag == 'STATUS':
            statuses[d['scenario']] = d
        elif tag == 'SVG':
            svgs[d['scenario']] = d
        else:
            stills.setdefault((d['scenario'], d['theme']), {})[d['frame']] = d['svg']

    # The CLI scenario is drawn in the terminal, the desktop scenario as SVG (as each app does).
    frames = {k: v for k, v in frames.items() if k == 'cli'}
    statuses = {k: v for k, v in statuses.items() if k == 'cli'}
    stills = {k: v for k, v in stills.items() if k[0] == 'desktop'}
    svgs = {k: v for k, v in svgs.items() if k == 'desktop'}

    # Terminal pane: every frame of the count-up, then the still.
    for scenario, by_frame in frames.items():
        order = sorted(by_frame)
        images = [terminal_image(layout(by_frame[f]), 'Token savings  (/defer-savings)') for f in order]
        h = max(i.height for i in images)
        images = [i if i.height == h else pad_to(i, h) for i in images]
        save_png(images[-1], os.path.join(OUT, f'pane-terminal-{scenario}.png'))
        save_gif(images, [600] + [40] * (len(images) - 2) + [3500], os.path.join(OUT, f'pane-terminal-{scenario}.gif'))

    # Status line: the texts in the order the mod set them, consecutive repeats dropped.
    for scenario, d in statuses.items():
        seq = []
        for t in d['frames']:
            if not seq or seq[-1] != t:
                seq.append(t)
        images = [status_image(t) for t in seq]
        save_png(images[-1], os.path.join(OUT, f'status-line-{scenario}.png'))
        save_gif(images, [90] * (len(images) - 1) + [3000], os.path.join(OUT, f'status-line-{scenario}.gif'))

    # SVG pane (desktop app, VS Code, mobile): the animated SVG, and stills along its animation.
    for scenario, d in svgs.items():
        path = os.path.join(OUT, f'pane-svg-{scenario}.svg')
        with open(path, 'w') as f:
            f.write(d['animated'])
        print('wrote', os.path.relpath(path))
    for (scenario, theme), by_frame in stills.items():
        order = sorted(by_frame)
        images = [svg_image(by_frame[f], scale=1.5) for f in order]
        save_png(svg_image(by_frame[order[-1]]), os.path.join(OUT, f'pane-{scenario}-{theme}.png'))
        save_gif(images, [500] + [40] * (len(images) - 2) + [3500], os.path.join(OUT, f'pane-{scenario}-{theme}.gif'))


def pad_to(img, height):
    out = Image.new('RGB', (img.width, height), BG)
    out.paste(img, (0, 0))
    return out


if __name__ == '__main__':
    main()
