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
        # The terminal draws a primary Button in the accent colour, a dim one dim.
        is_primary = props.get('variant') == 'primary'
        fg = ACCENT if is_primary else DIM if props.get('dimColor') else FG
        return [[(c, fg, None, is_primary) for c in f"[ {props.get('label', '')} ]"]]
    if kind == 'Select':
        current = next((o for o in props.get('options', []) if o.get('value') == props.get('value')), {})
        cells = [(c, FG, None, False) for c in props.get('label', '')]
        cells += [(c, ACCENT, None, True) for c in f"< {current.get('label', props.get('value', ''))} >"]
        return [cells]
    # Box, and anything else that holds children.
    parts = [layout(k, style) for k in children_of(node)]
    parts = [p for p in parts if p]
    lines = box_lines(parts, props)
    # A Box's width and margin, in cells.
    margin = int(props.get('marginLeft') or 0)
    width = props.get('width')
    if margin or isinstance(width, int):
        out = []
        for line in lines:
            if isinstance(width, int):
                gap = max(0, width - len(line))
                line = ([(' ', FG, None, False)] * gap + line) if props.get('justifyContent') == 'flex-end' else line + [(' ', FG, None, False)] * gap
            out.append([(' ', FG, None, False)] * margin + line)
        lines = out
    return lines


def box_lines(parts, props):
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


def wrap(lines, columns):
    """Wraps lines wider than the pane at a space, as the terminal does."""
    out = []
    for line in lines:
        while len(line) > columns:
            cut = max((i for i in range(columns) if line[i][0] == ' '), default=columns)
            cut = cut or columns
            out.append(line[:cut])
            line = line[cut + 1 :] if line[cut : cut + 1] and line[cut][0] == ' ' else line[cut:]
        out.append(line)
    return out


def terminal_image(lines, title, columns=100):
    wrapped = wrap(lines, columns)
    rows = len(wrapped)
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
    for r, line in enumerate(wrapped):
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
# Desktop settings view: the same element tree, drawn the way a desktop app draws Box, Text,
# Button and Select (proportional font, native-looking buttons). Colours from the mod's palette.

D_BG = (26, 26, 25)
D_FG = (232, 231, 226)
D_DIM = (150, 149, 143)
D_BLUE = (57, 135, 229)
D_BORDER = (74, 74, 70)
D_SCALE = 2
INTER = '/usr/share/fonts/opentype/inter/Inter-Regular.otf'
INTER_SEMI = '/usr/share/fonts/opentype/inter/Inter-SemiBold.otf'
d_font = ImageFont.truetype(INTER, 13 * D_SCALE)
d_bold = ImageFont.truetype(INTER_SEMI, 13 * D_SCALE)
d_small = ImageFont.truetype(INTER, 11 * D_SCALE)
CH = 6.8 * D_SCALE  # one Box width unit, about one character
LINE_H = 22 * D_SCALE
ROW_H = 30 * D_SCALE


def runs_of(node, style):
    """A Text's styled runs: (text, colour, bold)."""
    props = node.get('props') or {}
    fg = style['fg']
    if props.get('color'):
        fg = rgb(props['color'], fg)
    if props.get('dimColor'):
        fg = D_DIM
    st = {'fg': fg, 'bold': style['bold'] or bool(props.get('bold'))}
    out = []
    for k in children_of(node):
        if isinstance(k, (str, int, float)):
            out.append((str(k), st['fg'], st['bold']))
        elif isinstance(k, dict):
            out += runs_of(k, st)
    return out


class Desk:
    def __init__(self, width):
        self.width = width
        self.ops = []  # drawing operations, replayed once the height is known

    def measure(self, node):
        """Width of an inline node, in pixels."""
        kind = node.get('type')
        props = node.get('props') or {}
        if kind == 'Text':
            return sum((d_bold if b else d_font).getlength(t) for t, _, b in runs_of(node, {'fg': D_FG, 'bold': False}))
        if kind == 'Button':
            return d_font.getlength(props.get('label', '')) + 24 * D_SCALE
        if kind == 'Select':
            current = next((o for o in props.get('options', []) if o.get('value') == props.get('value')), {})
            return d_font.getlength(props.get('label', '')) + d_font.getlength(current.get('label', '')) + 40 * D_SCALE
        if kind == 'Box':
            w = props.get('width')
            inner = sum(self.measure(k) for k in children_of(node) if isinstance(k, dict))
            return (w * CH if isinstance(w, (int, float)) else inner) + (props.get('marginLeft') or 0) * CH
        return 0

    def inline(self, node, x, y, h):
        """Draws a node in a row at x; returns the x after it."""
        kind = node.get('type')
        props = node.get('props') or {}
        mid = y + h // 2
        if kind == 'Text':
            for t, fg, b in runs_of(node, {'fg': D_FG, 'bold': False}):
                f = d_bold if b else d_font
                self.ops.append(('text', (x, mid), t, f, fg))
                x += f.getlength(t)
            return x
        if kind == 'Button':
            label = props.get('label', '')
            w = self.measure(node)
            bh = 22 * D_SCALE
            box = [x, mid - bh // 2, x + w, mid + bh // 2]
            if props.get('variant') == 'primary':
                self.ops.append(('pill', box, D_BLUE, None))
                self.ops.append(('text', (x + 12 * D_SCALE, mid), label, d_bold, (255, 255, 255)))
            else:
                self.ops.append(('pill', box, None, D_BORDER))
                self.ops.append(('text', (x + 12 * D_SCALE, mid), label, d_font, D_DIM if props.get('dimColor') else D_FG))
            return x + w + 8 * D_SCALE
        if kind == 'Select':
            current = next((o for o in props.get('options', []) if o.get('value') == props.get('value')), {})
            lab = props.get('label', '')
            self.ops.append(('text', (x, mid), lab, d_font, D_FG))
            x += d_font.getlength(lab) + 4 * D_SCALE
            w = d_font.getlength(current.get('label', '')) + 34 * D_SCALE
            bh = 24 * D_SCALE
            self.ops.append(('pill', [x, mid - bh // 2, x + w, mid + bh // 2], (40, 40, 38), D_BORDER))
            self.ops.append(('text', (x + 10 * D_SCALE, mid), current.get('label', ''), d_font, D_FG))
            self.ops.append(('text', (x + w - 18 * D_SCALE, mid), '▾', ImageFont.truetype(SANS, 12 * D_SCALE), D_DIM))
            return x + w
        if kind == 'Box':
            x0 = x + (props.get('marginLeft') or 0) * CH
            w = props.get('width')
            kids = [k for k in children_of(node) if isinstance(k, dict)]
            if isinstance(w, (int, float)) and props.get('justifyContent') == 'flex-end':
                inner = sum(self.measure(k) for k in kids)
                xx = x0 + w * CH - inner
            else:
                xx = x0
            for k in kids:
                xx = self.inline(k, xx, y, h)
            return x0 + w * CH if isinstance(w, (int, float)) else xx
        return x

    def block(self, node, x, y):
        """Draws a column child; returns the y after it."""
        kind = node.get('type')
        props = node.get('props') or {}
        if kind == 'Box' and props.get('flexDirection', 'column') == 'column':
            for k in children_of(node):
                if isinstance(k, dict):
                    y = self.block(k, x, y)
            return y
        if kind == 'Text':
            # Wrap long text at spaces.
            runs = runs_of(node, {'fg': D_FG, 'bold': False})
            if not ''.join(t for t, _, _ in runs).strip():
                return y + LINE_H // 2
            words = []
            for t, fg, b in runs:
                for part in t.split(' '):
                    words.append((part, fg, b))
                words[-1] = words[-1]
            xx = x
            line_y = y
            for i, (wd, fg, b) in enumerate(words):
                f = d_bold if b else d_font
                piece = wd + ' '
                if xx + f.getlength(wd) > self.width - 24 * D_SCALE and xx > x:
                    line_y += LINE_H
                    xx = x
                self.ops.append(('text', (xx, line_y + LINE_H // 2), piece, f, fg))
                xx += f.getlength(piece)
            return line_y + LINE_H
        h = ROW_H if self.has_control(node) else LINE_H
        self.inline(node, x, y, h)
        return y + h

    def has_control(self, node):
        if node.get('type') in ('Button', 'Select'):
            return True
        return any(isinstance(k, dict) and self.has_control(k) for k in children_of(node))


def desktop_image(tree, caption_line):
    width = 820 * D_SCALE
    desk = Desk(width)
    pad = 20 * D_SCALE
    y = pad
    desk.ops.append(('text', (pad, y + 10 * D_SCALE), caption_line, d_small, D_BLUE))
    y += 30 * D_SCALE
    y = desk.block(tree, pad, y)
    height = int(y + pad + 24 * D_SCALE)
    img = Image.new('RGB', (width, height), D_BG)
    d = ImageDraw.Draw(img)
    for op in desk.ops:
        if op[0] == 'pill':
            _, box, fill, outline = op
            d.rounded_rectangle([int(v) for v in box], radius=6 * D_SCALE, fill=fill, outline=outline, width=D_SCALE if outline else 0)
    for op in desk.ops:
        if op[0] == 'text':
            _, (x, ymid), t, f, fg = op
            d.text((int(x), int(ymid)), t, font=f, fill=fg, anchor='lm')
    d.text((pad, height - pad), CAPTION, font=d_small, fill=D_DIM, anchor='lm')
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
    frames, statuses, svgs, stills, settings = {}, {}, {}, {}, {}
    for line in sys.stdin:
        tag, _, body = line.partition(' ')
        if tag not in ('FRAME', 'STATUS', 'SVG', 'SVGFRAME', 'SETTINGS'):
            continue
        d = json.loads(body)
        if tag == 'FRAME':
            frames.setdefault(d['scenario'], {})[d['frame']] = d['tree']
        elif tag == 'STATUS':
            statuses[d['scenario']] = d
        elif tag == 'SVG':
            svgs[d['scenario']] = d
        elif tag == 'SETTINGS':
            settings.setdefault(d['surface'], []).append(d)
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

    # The settings view, one picture per step, in the terminal and in the desktop app.
    for surface, steps in settings.items():
        steps = sorted(steps, key=lambda d: d['step'])
        images = []
        for d in steps:
            caption = f"Step {d['step'] + 1} of {len(steps)}: {d['caption']}"
            if surface == 'terminal':
                lines = [[(c, ACCENT, None, True) for c in caption], []] + layout(d['tree'])
                images.append(terminal_image(lines, 'defer-tools settings  (/defer-settings)', columns=110))
            else:
                images.append(desktop_image(d['tree'], caption))
        h = max(i.height for i in images)
        w = max(i.width for i in images)
        images = [pad_to(i, h, w) for i in images]
        save_png(images[-1], os.path.join(OUT, f'settings-{surface}.png'))
        save_gif(images, [1800] * (len(images) - 1) + [3500], os.path.join(OUT, f'settings-{surface}.gif'))


def pad_to(img, height, width=None):
    out = Image.new('RGB', (width or img.width, height), img.getpixel((0, 0)))
    out.paste(img, (0, 0))
    return out


if __name__ == '__main__':
    main()
