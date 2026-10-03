"""Render a banner HTML file to a print PDF + preview PNG and verify its QR codes.

    python3 build.py banner.html            -> banner-print.pdf, banner-preview.png
Trim 850 x 2000 mm + 5 mm bleed = 860 x 2010 mm. Needs Google Chrome and zbarimg (brew install zbar).
"""
import os, subprocess, sys
from PIL import Image
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
src = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'banner.html')
base = os.path.splitext(src)[0]
common = [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--virtual-time-budget=5000']
pdf, png, small = base + '-print.pdf', base + '-preview.png', base + '-preview-small.png'
subprocess.run(common + ['--no-pdf-header-footer', f'--print-to-pdf={pdf}', 'file://' + src], check=True, capture_output=True)
subprocess.run(common + ['--force-device-scale-factor=0.3', '--window-size=3251,7597', f'--screenshot={png}', 'file://' + src], check=True, capture_output=True)
im = Image.open(png); im.resize((round(im.width * 1600 / im.height), 1600), Image.LANCZOS).save(small)
qr = subprocess.run(['zbarimg', '-q', png], capture_output=True, text=True).stdout.strip()
print('PDF  ', pdf, os.path.getsize(pdf) // 1024, 'KB')
print('PNG  ', png, '| small:', small)
print('QR   ', qr.replace('\n', ' | ') or 'NO QR CODES DECODED')
