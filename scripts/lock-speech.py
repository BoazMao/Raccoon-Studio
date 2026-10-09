"""Developer tool: reproduce the tested Windows/Python 3.12 speech profiles."""
import hashlib
from pathlib import Path
import re
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / '.tools' / 'runtime-builder'
BUILD.mkdir(parents=True, exist_ok=True)
UV_URL = 'https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-pc-windows-msvc.zip'
UV_HASH = '5d223efa0bf00208c3853246af09420419dfbd352536aa6bb8163d6170e23890'
archive = BUILD / 'uv.zip'
if not archive.exists():
    urllib.request.urlretrieve(UV_URL, archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == UV_HASH
with zipfile.ZipFile(archive) as z:
    z.extractall(BUILD / 'uv')
uv = next((BUILD / 'uv').rglob('uv.exe'))
constraints = BUILD / 'constraints.txt'
seed = ROOT / 'scripts/speech-runtime/cpu.txt'
constraints.write_text('\n'.join(re.findall(r'^([a-zA-Z0-9_.-]+==[^ \\\n]+)', seed.read_text(), re.MULTILINE)), encoding='utf-8')
output = ROOT / 'scripts' / 'speech-runtime'
output.mkdir(exist_ok=True)
for profile, suffix in [('cpu', 'cpu'), ('cuda', 'cu128')]:
    wheels = []
    for name, version, abi in [('torch', '2.8.0', 'cp312'), ('torchaudio', '2.8.0', 'cp312'), ('torchvision', '0.23.0', 'cp312')]:
        index = f'https://download.pytorch.org/whl/{suffix}/{name}/'
        listing = urllib.request.urlopen(index).read().decode()
        links = re.findall(r'href="([^"]+)"', listing)
        link = next(link for link in links if f'{name}-{version}%2B{suffix}-{abi}-{abi}-win_amd64.whl' in link)
        wheels.append(f'{name} @ {link}')
    source = BUILD / f'{profile}.in'
    source.write_text('whisperx==3.8.6\ntransformers==4.57.6\n' + '\n'.join(wheels) + '\n', encoding='utf-8')
    subprocess.run([str(uv), 'pip', 'compile', str(source), '--constraint', str(constraints),
        '--python-version', '3.12', '--python-platform', 'x86_64-pc-windows-msvc',
        '--generate-hashes', '--no-header', '--output-file', str(output / f'{profile}.txt')], check=True, stdout=subprocess.DEVNULL)
    # Preserve the locally built, source-verified wheel in the reproducible lock.
    wheel = next((output / 'wheels').glob('antlr*.whl'))
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    lock = output / f'{profile}.txt'
    text = lock.read_text()
    text = text.replace('antlr4-python3-runtime==4.9.3 \\\n', f'antlr4-python3-runtime==4.9.3 \\\n    --hash=sha256:{digest} \\\n')
    lock.write_text(text)
