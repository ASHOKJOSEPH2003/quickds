"""Draws the app icons (a white summary sheet on ink blue) with the standard library only."""
import pathlib
import struct
import zlib

BLUE = (23, 64, 109)
WHITE = (255, 255, 255)
LINE = (143, 189, 240)


def pixel(x, y):
    in_sheet = 0.28 <= x <= 0.72 and 0.18 <= y <= 0.82
    if not in_sheet:
        return BLUE
    for top in (0.32, 0.44, 0.56, 0.68):
        if top <= y <= top + 0.04 and 0.35 <= x <= (0.65 if top < 0.6 else 0.54):
            return LINE
    return WHITE


def write_png(path, size):
    rows = bytearray()
    for row in range(size):
        rows.append(0)
        for col in range(size):
            rows.extend(pixel((col + 0.5) / size, (row + 0.5) / size))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    header = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')
    path.write_bytes(png)


out = pathlib.Path(__file__).resolve().parent.parent / 'icons'
out.mkdir(exist_ok=True)
for size in (180, 192, 512):
    write_png(out / f'icon-{size}.png', size)
