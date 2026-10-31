from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'dev/font-sources/VictorMono[wght].ttf'
LICENSE = (ROOT / 'dev/font-sources/OFL.txt').read_text()
OUTPUTS = [
    ROOT / 'src/assets/fonts',
    ROOT / 'public/fonts',
    ROOT / 'site/fonts',
    ROOT / 'dev/font-comparison/assets',
]
WEIGHTS = {
    400: ('Regular', 'regular'),
    500: ('Medium', 'medium'),
    600: ('SemiBold', 'semibold'),
    700: ('Bold', 'bold'),
}
PUNCTUATION = {
    'period': 1.15,
    'comma': 1.15,
    'colon': 1.15,
    'semicolon': 1.20,
    'grave': 1.10,
    'quotesingle': 1.05,
    'quotedbl': 1.05,
    'bar': 1.05,
}


def strengthen(glyf, hmtx, name, factor):
    glyph = glyf[name]
    if glyph.isComposite():
        return
    coords = glyph.coordinates
    x_min, x_max = min(p[0] for p in coords), max(p[0] for p in coords)
    center = (x_min + x_max) / 2
    for i, (x, y) in enumerate(coords):
        coords[i] = (round(center + (x - center) * factor), y)
    glyph.recalcBounds(glyf)
    center = (glyph.xMin + glyph.xMax) / 2
    shift = round(300 - center)
    for i, (x, y) in enumerate(coords):
        coords[i] = (x + shift, y)
    glyph.recalcBounds(glyf)
    advance, lsb = hmtx[name]
    hmtx[name] = (advance, lsb + shift)


def set_name(font, name_id, value):
    font['name'].setName(value, name_id, 3, 1, 0x409)
    font['name'].setName(value, name_id, 1, 0, 0)


def build(weight, subfamily, filename):
    font = TTFont(SOURCE)
    font = instantiateVariableFont(font, {'wght': weight})
    for name, factor in PUNCTUATION.items():
        strengthen(font['glyf'], font['hmtx'], name, factor)
    font['OS/2'].usWeightClass = weight
    font['head'].fontRevision = 1.0
    bold = weight == 700
    font['head'].macStyle = 1 if bold else 0
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~0x20) | (0x20 if bold else 0)
    full = f'TxUI Mono {subfamily}'
    postscript = f'TxUIMono-{subfamily}'
    unique = f'1.000;TXUI;TxMono-{subfamily}'
    values = {
        0: 'Copyright 2023 The Victor Mono Project Authors '
           '(https://github.com/rubjo/victor-mono-font). Modifications 2026 TxUI.',
        1: 'TxUI Mono',
        2: subfamily,
        3: unique,
        4: full,
        5: 'Version 1.000',
        6: postscript,
        8: 'TxUI',
        9: 'TxUI, derived from Victor Mono by the Victor Mono Project Authors',
        10: 'Victor Mono adjusted for SQL and database interfaces: default weight metadata '
            'corrected and punctuation strengthened for small-size database work.',
        11: 'https://tuxie.eu/txui/',
        13: LICENSE,
        14: 'https://scripts.sil.org/OFL',
        16: 'TxUI Mono',
        17: subfamily,
    }
    for name_id, value in values.items():
        set_name(font, name_id, value)
    font.flavor = 'woff2'
    for directory in OUTPUTS:
        directory.mkdir(parents=True, exist_ok=True)
        font.save(directory / f'txui-mono-{filename}.woff2')
    return font


for weight, (subfamily, filename) in WEIGHTS.items():
    built = build(weight, subfamily, filename)
    print(f'TxUI Mono {subfamily}: {built["OS/2"].usWeightClass}, {built["head"].fontRevision}')

license_text = (
    'TxUI Mono — licensing and modifications\n\n'
    'Copyright 2023 The Victor Mono Project Authors '
    '(https://github.com/rubjo/victor-mono-font)\n'
    'Modifications 2026 TxUI.\n\n'
    'TxUI Mono is a derivative of Victor Mono. The default metadata weight is 400, '
    'and punctuation is strengthened for SQL and database interfaces. The font remains '
    'under the SIL Open Font License 1.1, reproduced below.\n\n'
    + LICENSE
)
for directory in OUTPUTS:
    (directory / 'OFL-TxUI-Mono.txt').write_text(license_text)
