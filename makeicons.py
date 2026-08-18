#!/usr/bin/env python3
"""Rigenera le icone PWA di TVTRACKER a partire dai PNG sorgente.

Perché serve: i file originali erano PNG "sporchi" prodotti da un editor —
dimensioni sbagliate rispetto al manifest (398x404 e 753x752 invece di 192 e
512), un chunk proprietario `caBX` da 43 KB e un chunk `eXIf` con CRC corrotto
che impediva perfino a Pillow di aprirli. Pesavano 213 KB e 615 KB.

Cosa fa, per ogni icona:
  1. tiene solo i chunk PNG standard (scarta caBX/eXIf e simili);
  2. ritaglia al quadrato centrato e ridimensiona alla misura del manifest;
  3. quantizza con pngquant a palette 256 colori.

Risultato: 14 KB e 71 KB, qualità invariata a occhio.

Uso (dalla radice del repo o da qualsiasi cartella):
    python3 tools/make-icons.py            # rigenera solo le icone non ancora ottimizzate
    python3 tools/make-icons.py --force    # rigenera comunque

Un'icona già ottimizzata viene saltata: riquantizzarla una seconda volta
degraderebbe il gradiente senza guadagni di peso apprezzabili.

Richiede: Pillow (pip install pillow) e pngquant (apt install pngquant).
"""
import io
import struct
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Serve Pillow: pip install pillow")

# I chunk PNG standard che vogliamo conservare; tutto il resto viene scartato.
KEEP = {b'IHDR', b'PLTE', b'IDAT', b'IEND', b'tRNS', b'sRGB', b'sBIT', b'gAMA'}

REPO_ROOT = Path(__file__).resolve().parent.parent
ICONS = [('icon-192.png', 192), ('icon-512.png', 512)]


def clean_png(path):
    """Riscrive il PNG in memoria tenendo solo i chunk standard."""
    data = path.read_bytes()
    out = io.BytesIO()
    out.write(data[:8])  # firma PNG
    pos = 8
    while pos + 8 <= len(data):
        length, ctype = struct.unpack('>I4s', data[pos:pos + 8])
        if ctype in KEEP:
            out.write(data[pos:pos + 12 + length])
        if ctype == b'IEND':
            break
        pos += 12 + length
    return Image.open(io.BytesIO(out.getvalue()))


def is_already_optimized(path, size):
    """Vero se l'icona è già passata da questo script: palette 256 colori,
    dimensioni giuste e nessun chunk estraneo."""
    try:
        with Image.open(path) as im:
            return im.mode == 'P' and im.size == (size, size)
    except Exception:
        return False  # illeggibile da Pillow = uno dei PNG "sporchi" originali


def make_icon(path, size):
    im = clean_png(path).convert('RGBA')
    w, h = im.size
    side = min(w, h)
    im = im.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    im = im.resize((size, size), Image.LANCZOS)
    im.save(path, optimize=True)
    subprocess.run(
        ['pngquant', '--quality=70-95', '--speed', '1', '--force',
         '--output', str(path), str(path)],
        check=True,
    )
    print(f"{path.name}: {size}x{size}, {path.stat().st_size // 1024} KB")


def main():
    force = '--force' in sys.argv[1:]
    for name, size in ICONS:
        path = REPO_ROOT / name
        if not path.exists():
            sys.exit(f"Icona non trovata: {path}")
        if not force and is_already_optimized(path, size):
            print(f"{name}: già ottimizzata ({path.stat().st_size // 1024} KB), salto — usa --force per rifarla")
            continue
        make_icon(path, size)


if __name__ == '__main__':
    main()
