"""Build the source-only dependency once, with a locked build toolchain."""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

root = Path(__file__).resolve().parent.parent
builder = root / '.tools/runtime-builder'
uv = next((builder / 'uv').rglob('uv.exe'))
env = builder / 'wheel-build'
subprocess.run([str(uv), 'venv', '--python', '3.12', str(env)], check=True)
python = env / 'Scripts/python.exe'
subprocess.run([str(uv), 'pip', 'install', '--python', str(python), 'pip==25.2', 'setuptools==80.9.0', 'wheel==0.45.1', 'packaging==25.0'], check=True)
metadata = json.load(urllib.request.urlopen('https://pypi.org/pypi/antlr4-python3-runtime/4.9.3/json'))
sdist = next(f for f in metadata['urls'] if f['packagetype'] == 'sdist')
source = builder / sdist['filename']
urllib.request.urlretrieve(sdist['url'], source)
assert hashlib.sha256(source.read_bytes()).hexdigest() == sdist['digests']['sha256']
output = root / 'scripts/speech-runtime/wheels'
output.mkdir(exist_ok=True)
license_url = 'https://raw.githubusercontent.com/antlr/antlr4/4.9.3/LICENSE.txt'
license_data = urllib.request.urlopen(license_url).read()
assert hashlib.sha256(license_data).hexdigest() == 'b1b379fcaf3219593a4c433feb1b35c780bed23fafaae440b1ae2771a9521e3a'
(output / 'ANTLR-LICENSE.txt').write_bytes(license_data)
subprocess.run([str(python), '-m', 'pip', 'wheel', '--no-deps', '--no-build-isolation', '--wheel-dir', str(output), str(source)], check=True)
wheel = next(output.glob('antlr*.whl'))
digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
(output / 'PROVENANCE.json').write_text(json.dumps({'package': 'antlr4-python3-runtime', 'version': '4.9.3', 'sourceURL': sdist['url'], 'sourceSHA256': sdist['digests']['sha256'], 'wheelSHA256': digest, 'buildTools': {'python': '3.12', 'setuptools': '80.9.0', 'wheel': '0.45.1', 'packaging': '25.0'}, 'license': 'BSD-3-Clause (provided alongside the wheel in ANTLR-LICENSE.txt)', 'licenseURL': license_url}, indent=2))
for profile in ['cpu', 'cuda']:
    lock = root / f'scripts/speech-runtime/{profile}.txt'
    text = lock.read_text()
    text = text.replace('antlr4-python3-runtime==4.9.3 \\\n', f'antlr4-python3-runtime==4.9.3 \\\n    --hash=sha256:{digest} \\\n')
    lock.write_text(text)
