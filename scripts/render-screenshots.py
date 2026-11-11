#!/usr/bin/env python3
"""Draws docs/screenshots/*.png from what tests/screenshots.test.tsx prints.

    claude plugin test . | python3 scripts/render-screenshots.py

The words are exactly what the mod drew in the test. The frame, colours and font are drawn
by this script in a terminal style: they are not a capture of Claude Code's own screen.
Needs Pillow and the DejaVu Sans Mono font.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
SCALE = 2
SIZE = 14 * SCALE
PAD = 18 * SCALE
LINE = int(SIZE * 1.45)

BG = (24, 24, 28)
FG = (225, 225, 230)
DIM = (140, 140, 150)
ACCENT = (215, 119, 87)
BORDER = (90, 90, 100)
NOTE = (160, 160, 170)

font = ImageFont.truetype(FONT, SIZE)
bold = ImageFont.truetype(BOLD, SIZE)
small = ImageFont.truetype(FONT, int(SIZE * 0.8))


def text_width(s, f=font):
    return int(f.getlength(s))


def draw_box(lines, title, footer, path):
    """lines: list of (text, style) with style in fg, bold, dim, accent."""
    width = max(text_width(t) for t, _ in lines) + 4 * PAD
    width = max(width, text_width(footer, small) + 2 * PAD)
    height = 2 * PAD + LINE * (len(lines) + 1) + PAD + LINE
    img = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(img)
    top = PAD + LINE // 2
    d.rounded_rectangle([PAD, top, width - PAD, top + LINE * (len(lines) + 1)], radius=8 * SCALE, outline=BORDER, width=SCALE)
    if title:
        tw = text_width(f' {title} ', bold)
        d.rectangle([2 * PAD, top - LINE // 2, 2 * PAD + tw, top + LINE // 2], fill=BG)
        d.text((2 * PAD, top - SIZE // 2 - SCALE), f' {title} ', font=bold, fill=ACCENT)
    y = top + LINE // 2
    for text, style in lines:
        f = bold if style == 'bold' else font
        color = {'dim': DIM, 'accent': ACCENT}.get(style, FG)
        d.text((2 * PAD, y), text, font=f, fill=color)
        y += LINE
    d.text((PAD, height - PAD - LINE // 2), footer, font=small, fill=NOTE)
    img.save(path)
    print('wrote', path)


def draw_status(status, footer, path):
    """The prompt box, with the mod's status line under it."""
    width = max(text_width(status), text_width(footer, small)) + 4 * PAD
    height = PAD + 2 * LINE + LINE + PAD + LINE + LINE // 2
    img = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([PAD, PAD, width - PAD, PAD + 2 * LINE], radius=8 * SCALE, outline=BORDER, width=SCALE)
    d.text((2 * PAD, PAD + LINE // 2), '> ', font=font, fill=FG)
    d.text((2 * PAD, PAD + 2 * LINE + LINE // 3), status, font=font, fill=DIM)
    d.text((PAD, height - PAD - LINE // 2), footer, font=small, fill=NOTE)
    img.save(path)
    print('wrote', path)


def main():
    out = os.path.join(os.path.dirname(__file__), '..', 'docs', 'screenshots')
    os.makedirs(out, exist_ok=True)
    shots = [json.loads(line[5:]) for line in sys.stdin if line.startswith('SHOT ')]
    footer = 'Drawn from an automated test (claude plugin test, Claude Code 2.1.322) with test data. Not a real session.'
    done = set()
    for shot in shots:
        name = shot['scenario']
        if name in done:
            continue
        done.add(name)
        texts = shot['texts']
        lines = []
        for i, t in enumerate(texts):
            style = 'bold' if i == 0 else 'dim' if t.startswith('live =') else 'fg'
            lines.append((t.rstrip() or ' ', style))
        for label in shot['buttons']:
            lines.append((f'[ {label} ]', 'accent'))
        draw_box(lines, 'Token savings  (/defer-savings)', footer, os.path.join(out, f'pane-{name}.png'))
        if shot.get('status'):
            draw_status(shot['status'], footer, os.path.join(out, f'status-line-{name}.png'))
    surfaces = sorted({s['surface'] for s in shots})
    print('surfaces in the test (same words on each):', ', '.join(surfaces))


if __name__ == '__main__':
    main()
